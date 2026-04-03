/**
 * CSS Challenge コアロジック
 *
 * css-challenge.ts と css-challenge-bench.ts の共通基盤
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import {
  applyApprovalToVrtDiff,
  filterApprovedPaintTreeChanges,
  inferApprovalChangeType,
  type ApprovalContext,
  type ApprovalManifest,
  type ApprovalRule,
  type ApprovalWarning,
  type PaintTreeApprovalMatch,
} from "./approval.ts";
import { compareScreenshots } from "./heatmap.ts";
import { classifyVisualDiff } from "./visual-semantic.ts";
import { diffA11yTrees, checkA11yTree, parsePlaywrightA11ySnapshot } from "./a11y-semantic.ts";
import { CraterClient, diffPaintTrees, type PaintNode, type PaintTreeChange } from "./crater-client.ts";
import {
  filterComputedStyleDiffsByTargets,
  type ComputedStyleTarget,
} from "./css-custom-properties.ts";
import {
  buildInteractionTargetPlans,
  captureEmulatedInteractionStyleSnapshotInDom,
  captureComputedStyleSnapshotForTargetSelectorsInDom,
  buildComputedStyleCaptureExpression,
  buildComputedStyleCaptureJsonExpression,
  captureComputedStyleSnapshotInDom,
  ESBUILD_NAME_POLYFILL,
  type ComputedStyleSnapshot,
  collectInteractionTargetPlansInDom,
  computedStyleSnapshotToMap,
  parseComputedStyleSnapshot,
  hasMeaningfulComputedStyleSnapshot,
  mergeComputedStyleSnapshots,
  selectInteractionFallbackPlans,
  TRACKED_PROPERTIES,
  type ComputedStyleSnapshot,
  type InteractionTargetPlan,
  waitForInteractionStylesInDom,
} from "./computed-style-capture.ts";
import { formatPlaywrightLaunchError, isPlaywrightSandboxRestrictionError } from "./playwright-launch-error.ts";
import type { A11yNode, VrtSnapshot, VrtDiff, VisualSemanticDiff, A11yDiff } from "./types.ts";

// ---- Types ----

export interface CssDeclaration {
  index: number;       // line index in full CSS text
  text: string;        // original line text
  property: string;    // e.g. "padding"
  value: string;       // e.g. "12px 24px"
  selector: string;    // containing selector
  mediaCondition: string | null;  // e.g. "(max-width: 768px)" or null
}

export interface CapturedState {
  a11yTree: A11yNode;
  screenshotPath: string;
  computedStyles: Map<string, Record<string, string>>;  // selector → { property: value }
  hoverComputedStyles: Map<string, Record<string, string>>;  // hover-forced computed styles
  paintTree?: PaintNode;  // crater only: internal paint tree
}

/** Computed style diff between two captures */
export interface ComputedStyleDiff {
  selector: string;
  property: string;
  before: string;
  after: string;
}

export function diffComputedStyles(
  baseline: Map<string, Record<string, string>>,
  broken: Map<string, Record<string, string>>,
): ComputedStyleDiff[] {
  const diffs: ComputedStyleDiff[] = [];
  for (const [selector, baseProps] of baseline) {
    const brokenProps = broken.get(selector);
    if (!brokenProps) continue;
    for (const [prop, baseVal] of Object.entries(baseProps)) {
      const brokenVal = brokenProps[prop];
      if (brokenVal !== undefined && brokenVal !== baseVal) {
        diffs.push({ selector, property: prop, before: baseVal, after: brokenVal });
      }
    }
  }
  return diffs;
}

export function applyApprovalsToAnalysisSignals(
  vrtDiff: VrtDiff | null,
  paintTreeChanges: PaintTreeChange[],
  options: AnalysisApprovalOptions = {},
): AppliedAnalysisApprovals {
  if (!options.manifest) {
    return {
      vrtDiff,
      paintTreeChanges,
      approvalWarnings: [],
      approvedVisualRules: [],
      approvedPaintTreeMatches: [],
    };
  }

  const context = options.context ?? {};
  const resolvedChangeType = context.changeType ?? (
    context.property ? inferApprovalChangeType(context.property, context.category) : undefined
  );

  const visualApproval = vrtDiff
    ? applyApprovalToVrtDiff(
      vrtDiff,
      options.manifest,
      { ...context, changeType: resolvedChangeType },
      { strict: options.strict },
    )
    : null;

  const paintApproval = filterApprovedPaintTreeChanges(
    paintTreeChanges,
    options.manifest,
    context,
    { strict: options.strict },
  );

  return {
    vrtDiff: visualApproval?.diff ?? vrtDiff,
    paintTreeChanges: paintApproval.remainingChanges,
    approvalWarnings: dedupeApprovalWarnings([
      ...(visualApproval?.warnings ?? []),
      ...paintApproval.warnings,
    ]),
    approvedVisualRules: visualApproval?.matchedRules ?? [],
    approvedPaintTreeMatches: paintApproval.matches,
  };
}

export interface VrtAnalysis {
  vrtDiff: VrtDiff | null;
  visualSemantic: VisualSemanticDiff | null;
  a11yDiff: A11yDiff;
  baselineIssueCount: number;
  brokenIssueCount: number;
  computedStyleDiffs: ComputedStyleDiff[];
  referencedComputedStyleDiffs: ComputedStyleDiff[];
  referencedHoverStyleDiffs: ComputedStyleDiff[];
  trackedComputedStyleTargets: ComputedStyleTarget[];
  hoverDiffDetected: boolean;
  paintTreeChanges: PaintTreeChange[];
  approvalWarnings: ApprovalWarning[];
  approvedVisualRules: ApprovalRule[];
  approvedPaintTreeMatches: PaintTreeApprovalMatch[];
  visualReport: string;
  a11yReport: string;
  fullReport: string;
}

export interface AnalysisApprovalOptions {
  manifest?: ApprovalManifest | null;
  context?: ApprovalContext;
  strict?: boolean;
  expectedComputedStyleTargets?: ComputedStyleTarget[];
}

export interface AppliedAnalysisApprovals {
  vrtDiff: VrtDiff | null;
  paintTreeChanges: PaintTreeChange[];
  approvalWarnings: ApprovalWarning[];
  approvedVisualRules: ApprovalRule[];
  approvedPaintTreeMatches: PaintTreeApprovalMatch[];
}

export interface TrialResult {
  seed: number;
  removed: CssDeclaration;
  // Detection
  visualDiffDetected: boolean;
  visualDiffRatio: number;
  visualChangeTypes: string[];
  a11yDiffDetected: boolean;
  a11yChangeCount: number;
  newA11yIssues: number;
  // LLM recovery (if attempted)
  llmAttempted: boolean;
  llmFixParsed: boolean;
  selectorMatch: boolean;
  propertyMatch: boolean;
  valueMatch: boolean;
  exactMatch: boolean;
  pixelPerfect: boolean;
  nearPerfect: boolean;
  fixedDiffRatio: number;
  attempts: number;
  llmMs: number;
  fallbackUsed?: boolean;
  resolvedBy?: "chromium" | "crater" | "none";
}

// ---- CSS Parsing ----

export function parseCssDeclarations(css: string): CssDeclaration[] {
  const lines = css.split("\n");
  const declarations: CssDeclaration[] = [];
  let currentMedia: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("/*") || trimmed.startsWith("//")) continue;

    // Track @media blocks
    const mediaMatch = trimmed.match(/^@media\s+(.+?)\s*\{$/);
    if (mediaMatch) {
      currentMedia = mediaMatch[1];
      continue;
    }
    if (trimmed === "}" && currentMedia !== null) {
      currentMedia = null;
      continue;
    }
    if (trimmed.startsWith("@") || trimmed === "}") continue;

    const oneLineMatch = trimmed.match(/^([^{]+)\{([^}]+)\}\s*$/);
    if (oneLineMatch) {
      const selector = oneLineMatch[1].trim();
      const body = oneLineMatch[2].trim();
      const props = body.split(";").filter((s) => s.trim());
      for (const prop of props) {
        const propMatch = prop.trim().match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
        if (propMatch) {
          declarations.push({
            index: i,
            text: line,
            property: propMatch[1],
            value: propMatch[2],
            selector,
            mediaCondition: currentMedia,
          });
        }
      }
    }
  }

  return declarations;
}

/** CSS セレクタブロック (同一行の宣言をグループ化) */
export interface CssSelectorBlock {
  selector: string;
  index: number;           // line index
  text: string;            // original line text
  declarations: CssDeclaration[];
  mediaCondition: string | null;
}

/** 宣言リストからセレクタブロック単位にグループ化 */
export function groupBySelector(declarations: CssDeclaration[]): CssSelectorBlock[] {
  const map = new Map<string, CssSelectorBlock>();
  for (const d of declarations) {
    const key = `${d.index}:${d.selector}`;
    let block = map.get(key);
    if (!block) {
      block = { selector: d.selector, index: d.index, text: d.text, declarations: [], mediaCondition: d.mediaCondition };
      map.set(key, block);
    }
    block.declarations.push(d);
  }
  return [...map.values()];
}

/** セレクタブロック全体を CSS から削除 */
export function removeSelectorBlock(css: string, block: CssSelectorBlock): string {
  const lines = css.split("\n");
  lines[block.index] = "";
  return lines.join("\n");
}

export function removeCssProperty(css: string, declaration: CssDeclaration): string {
  const lines = css.split("\n");
  const line = lines[declaration.index];
  const propPattern = new RegExp(
    `\\s*${escapeRegex(declaration.property)}\\s*:\\s*${escapeRegex(declaration.value)}\\s*;?`,
  );
  lines[declaration.index] = line.replace(propPattern, "");
  return lines.join("\n");
}

export function applyCssFix(css: string, fix: { selector: string; property: string; value: string }): string {
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const oneLineMatch = trimmed.match(/^([^{]+)\{([^}]+)\}\s*$/);
    if (oneLineMatch) {
      const selector = oneLineMatch[1].trim();
      if (selector === fix.selector) {
        const body = oneLineMatch[2].trim();
        const newBody = `${body} ${fix.property}: ${fix.value};`;
        lines[i] = `${selector} { ${newBody} }`;
        return lines.join("\n");
      }
    }
  }
  return css;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeValue(v: string): string {
  return v.replace(/\s+/g, " ").replace(/;$/, "").trim();
}

// ---- Random ----

export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ---- Render backends ----

export type RenderBackend = "chromium" | "crater";

export async function createBrowser(viewport = { width: 1280, height: 900 }): Promise<{ browser: Browser; viewport: { width: number; height: number } }> {
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (isPlaywrightSandboxRestrictionError(error)) {
      throw new Error(formatPlaywrightLaunchError(error, { commandHint: "in your local terminal or in CI" }));
    }
    throw error;
  }
  return { browser, viewport };
}

export async function createCraterClient(): Promise<CraterClient> {
  const client = new CraterClient();
  await client.connect();
  return client;
}

export async function capturePageState(
  browser: Browser,
  viewport: { width: number; height: number },
  html: string,
  screenshotPath: string,
  options?: { captureHover?: boolean; trackedProperties?: string[]; interactionSelectors?: string[] },
): Promise<CapturedState> {
  const page = await browser.newPage({ viewport });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const trackedProperties = options?.trackedProperties ?? TRACKED_PROPERTIES;

  // Capture computed styles for styled elements + semantic tags
  const computedStyles = new Map<string, Record<string, string>>();
  try {
    // Use JSON-based expression to avoid __name transpilation issue in page.evaluate
    const expr = buildComputedStyleCaptureJsonExpression(trackedProperties);
    const jsonStr = await page.evaluate(expr) as string;
    const snapshot = parseComputedStyleSnapshot(JSON.parse(jsonStr));
    for (const [selector, props] of computedStyleSnapshotToMap(snapshot)) {
      computedStyles.set(selector, props);
    }
  } catch (e) {
    if (process.env.DEBUG_VRT) console.error("[capturePageState] computed style error:", e);
  }

  // Capture hover styles by temporarily activating :hover rules
  // Strategy: inject a <style> that converts :hover rules to always-active versions,
  // then capture computed styles, then remove the injected style.
  const hoverComputedStyles = new Map<string, Record<string, string>>();
  if (options?.captureHover) {
    try {
      const interactionPlansExpr = `(function(){ ${ESBUILD_NAME_POLYFILL} return (${collectInteractionTargetPlansInDom.toString()})(); })()`;
      const interactionPlans = await page.evaluate(interactionPlansExpr);
      const expectedInteractionPlans = buildInteractionTargetPlans(options.interactionSelectors ?? []);
      const hoverExpr = `(function(){ ${ESBUILD_NAME_POLYFILL} return (${captureEmulatedInteractionStyleSnapshotInDom.toString()})(${JSON.stringify(trackedProperties)}); })()`;
      const emulatedHoverStyles = await page.evaluate(hoverExpr) as ComputedStyleSnapshot;
      const fallbackPlans = dedupeInteractionPlans([
        ...expectedInteractionPlans,
        ...selectInteractionFallbackPlans(
        interactionPlans,
        hasMeaningfulComputedStyleSnapshot(emulatedHoverStyles),
        ),
      ]).slice(0, 8);
      const fallbackHoverStyles = fallbackPlans.length > 0
        ? await capturePlaywrightInteractionFallbackSnapshot(page, fallbackPlans, trackedProperties)
        : {};
      const mergedHoverStyles = mergeComputedStyleSnapshots(emulatedHoverStyles, fallbackHoverStyles);
      for (const [sel, props] of Object.entries(mergedHoverStyles)) {
        hoverComputedStyles.set(sel, props);
      }
    } catch { /* ignore */ }
  }

  // Capture a11y tree via CDP
  let a11yTree: A11yNode = { role: "document", name: "", children: [] };
  try {
    const client = await page.context().newCDPSession(page);
    const result = await client.send("Accessibility.getFullAXTree");
    a11yTree = cdpNodesToTree(result.nodes) as A11yNode;
    await client.detach();
  } catch {
    // Fallback
  }
  await page.close();

  return { a11yTree, screenshotPath, computedStyles, hoverComputedStyles };
}

function dedupeInteractionPlans(
  plans: InteractionTargetPlan[],
): InteractionTargetPlan[] {
  const deduped: InteractionTargetPlan[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = `${plan.interaction}\u0000${plan.normalizedSelector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(plan);
  }
  return deduped;
}

async function capturePlaywrightInteractionFallbackSnapshot(
  page: Page,
  plans: InteractionTargetPlan[],
  trackedProperties: string[],
): Promise<ComputedStyleSnapshot> {
  const snapshots: ComputedStyleSnapshot[] = [];

  for (const plan of plans) {
    let interactionApplied = false;
    try {
      const locator = page.locator(plan.normalizedSelector).first();
      if (await locator.count() === 0) continue;

      if (plan.interaction === "focus") {
        const descendant = locator.locator("input, button, select, textarea, a[href], [tabindex]").first();
        if (await descendant.count() > 0) {
          await descendant.focus();
        } else {
          await locator.evaluate((element) => {
            if (element instanceof HTMLElement && typeof element.focus === "function") {
              element.focus();
            }
          });
        }
      } else {
        await locator.hover({ force: true, timeout: 1000 });
      }
      interactionApplied = true;

      await page.evaluate(`(function(){ ${ESBUILD_NAME_POLYFILL} return (${waitForInteractionStylesInDom.toString()})(); })()`);
      const targetExpr = `(function(){ ${ESBUILD_NAME_POLYFILL} return (${captureComputedStyleSnapshotForTargetSelectorsInDom.toString()})(${JSON.stringify({ props: trackedProperties, selectors: [plan.normalizedSelector] })}); })()`;
      snapshots.push(await page.evaluate(targetExpr) as ComputedStyleSnapshot);
    } catch { /* ignore individual fallback failures */ }
    finally {
      if (!interactionApplied) continue;
      try {
        if (plan.interaction === "focus") {
          await page.evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && typeof active.blur === "function") {
              active.blur();
            }
          });
        } else {
          await page.mouse.move(0, 0);
        }
        await page.evaluate(`(function(){ ${ESBUILD_NAME_POLYFILL} return (${waitForInteractionStylesInDom.toString()})(); })()`);

      } catch { /* ignore cleanup failures */ }
    }
  }

  return mergeComputedStyleSnapshots(...snapshots);
}

/** Crater BiDi バックエンドでキャプチャ */
export async function capturePageStateCrater(
  client: CraterClient,
  viewport: { width: number; height: number },
  html: string,
  screenshotPath: string,
  options?: { trackedProperties?: string[] },
): Promise<CapturedState> {
  await client.setViewport(viewport.width, viewport.height);
  await client.setContent(html);
  const trackedProperties = options?.trackedProperties ?? TRACKED_PROPERTIES;

  // PNG スクリーンショット (capturePaintData → PNG 変換)
  const { png } = await client.capturePng();
  await writeFile(screenshotPath, png);

  // Paint tree — crater 固有の強み
  let paintTree: PaintNode | undefined;
  try {
    paintTree = await client.capturePaintTree();
  } catch { /* ignore */ }

  // a11y tree — crater は空で返す (将来的に対応)
  const a11yTree: A11yNode = { role: "document", name: "", children: [] };

  let computedStyles = new Map<string, Record<string, string>>();
  try {
    computedStyles = await client.captureComputedStyles(trackedProperties);
  } catch { /* ignore */ }
  const hoverComputedStyles = new Map<string, Record<string, string>>();

  return { a11yTree, screenshotPath, computedStyles, hoverComputedStyles, paintTree };
}

function cdpNodesToTree(nodes: Array<{
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
}>): unknown {
  if (!nodes || nodes.length === 0) return { role: "document", name: "", children: [] };

  const nodeMap = new Map<string, Record<string, unknown>>();
  const childMap = new Map<string, string[]>();

  for (const node of nodes) {
    const props: Record<string, unknown> = {};
    if (node.properties) {
      for (const p of node.properties) props[p.name] = p.value?.value;
    }
    const treeNode: Record<string, unknown> = {
      role: node.role?.value ?? "none",
      name: node.name?.value ?? "",
    };
    if (props.checked !== undefined) treeNode.checked = props.checked;
    if (props.disabled !== undefined) treeNode.disabled = props.disabled;
    if (props.expanded !== undefined) treeNode.expanded = props.expanded;
    if (props.level !== undefined) treeNode.level = props.level;
    nodeMap.set(node.nodeId, treeNode);
    if (node.childIds) childMap.set(node.nodeId, node.childIds);
  }

  function buildTree(nodeId: string): Record<string, unknown> | null {
    const node = nodeMap.get(nodeId);
    if (!node) return null;
    const childIds = childMap.get(nodeId) ?? [];
    const children = childIds.map(buildTree).filter((c): c is Record<string, unknown> => c !== null);
    if (children.length > 0) node.children = children;
    return node;
  }

  return buildTree(nodes[0].nodeId) ?? { role: "document", name: "", children: [] };
}

// ---- VRT Analysis ----

export async function analyzeVrtDiff(
  baselineState: CapturedState,
  brokenState: CapturedState,
  outputDir: string,
  approvalOptions: AnalysisApprovalOptions = {},
): Promise<VrtAnalysis> {
  const vrtSnap: VrtSnapshot = {
    testId: "page", testTitle: "page", projectName: "css-challenge",
    screenshotPath: brokenState.screenshotPath,
    baselinePath: baselineState.screenshotPath,
    status: "changed",
  };
  const rawVrtDiff = await compareScreenshots(vrtSnap, { outputDir });

  let visualSemantic: VisualSemanticDiff | null = null;
  let visualReport = "";
  const computedStyleDiffs = diffComputedStyles(baselineState.computedStyles, brokenState.computedStyles);
  const trackedComputedStyleTargets = approvalOptions.expectedComputedStyleTargets ?? [];
  const referencedComputedStyleDiffs = filterComputedStyleDiffsByTargets(
    computedStyleDiffs,
    trackedComputedStyleTargets,
  );

  // Hover diff (computed style based)
  const hoverStyleDiffs = diffComputedStyles(baselineState.hoverComputedStyles, brokenState.hoverComputedStyles);
  const referencedHoverStyleDiffs = filterComputedStyleDiffsByTargets(
    hoverStyleDiffs,
    trackedComputedStyleTargets,
  );
  const hoverDiffDetected = trackedComputedStyleTargets.length > 0
    ? referencedHoverStyleDiffs.length > 0
    : hoverStyleDiffs.length > 0;

  // Paint tree diff (crater only)
  let rawPaintTreeChanges: PaintTreeChange[] = [];
  if (baselineState.paintTree && brokenState.paintTree) {
    rawPaintTreeChanges = diffPaintTrees(baselineState.paintTree, brokenState.paintTree);
  }

  const approvals = applyApprovalsToAnalysisSignals(rawVrtDiff, rawPaintTreeChanges, approvalOptions);
  const vrtDiff = approvals.vrtDiff;
  const paintTreeChanges = approvals.paintTreeChanges;

  if (vrtDiff && vrtDiff.diffPixels > 0) {
    visualSemantic = classifyVisualDiff(vrtDiff);
    visualReport = `Visual diff: ${(vrtDiff.diffRatio * 100).toFixed(1)}% pixels changed\n` +
      `Regions: ${vrtDiff.regions.map((r) => `(${r.x},${r.y} ${r.width}x${r.height})`).join(", ")}\n` +
      `Semantic: ${visualSemantic.summary}\n` +
      visualSemantic.changes.map((c) => `  - [${c.type}] ${c.description}`).join("\n");
  } else if (approvals.approvedVisualRules.length > 0) {
    visualReport = `Visual diff approved by manifest: ${approvals.approvedVisualRules.map((rule) => rule.reason).join("; ")}`;
  } else {
    visualReport = "No visual diff detected — the removed CSS line had no visible effect at this viewport size.";
  }

  const a11yDiff = diffA11yTrees(
    parsePlaywrightA11ySnapshot("page", "page", baselineState.a11yTree as any),
    parsePlaywrightA11ySnapshot("page", "page", brokenState.a11yTree as any),
  );

  const baselineIssueCount = checkA11yTree(baselineState.a11yTree).length;
  const brokenIssueCount = checkA11yTree(brokenState.a11yTree).length;

  let a11yReport = "";
  if (a11yDiff.changes.length > 0) {
    a11yReport = `A11y changes: ${a11yDiff.changes.length}\n` +
      a11yDiff.changes.map((c) => `  - [${c.type}] ${c.description}`).join("\n");
  } else {
    a11yReport = "No a11y tree changes detected.";
  }
  if (brokenIssueCount > baselineIssueCount) {
    a11yReport += `\nNew a11y quality issues: ${brokenIssueCount - baselineIssueCount}`;
  }

  let computedReport = "";
  if (trackedComputedStyleTargets.length > 0) {
    const trackedLines = trackedComputedStyleTargets
      .slice(0, 10)
      .map((target) => `  - ${target.selector} { ${target.property} } via ${target.viaCustomProperties.join(" → ")}`)
      .join("\n");
    computedReport = `\nTracked var() targets: ${trackedComputedStyleTargets.length}\n${trackedLines}`;

    if (referencedComputedStyleDiffs.length > 0) {
      computedReport += `\nReferenced computed style changes: ${referencedComputedStyleDiffs.length}\n` +
        referencedComputedStyleDiffs
          .slice(0, 10)
          .map((d) => `  - ${d.selector} { ${d.property}: ${d.before} → ${d.after} }`)
          .join("\n");
    } else {
      computedReport += "\nReferenced computed style changes: 0";
    }

    if (referencedHoverStyleDiffs.length > 0) {
      computedReport += `\nReferenced hover style changes: ${referencedHoverStyleDiffs.length}\n` +
        referencedHoverStyleDiffs
          .slice(0, 10)
          .map((d) => `  - ${d.selector} { ${d.property}: ${d.before} → ${d.after} }`)
          .join("\n");
    }

    if (computedStyleDiffs.length > referencedComputedStyleDiffs.length) {
      computedReport += `\nTotal computed style changes: ${computedStyleDiffs.length}`;
    }
  } else if (computedStyleDiffs.length > 0) {
    computedReport = `\nComputed style changes: ${computedStyleDiffs.length}\n` +
      computedStyleDiffs.slice(0, 10).map((d) => `  - ${d.selector} { ${d.property}: ${d.before} → ${d.after} }`).join("\n");
  }

  let paintTreeReport = "";
  if (paintTreeChanges.length > 0) {
    paintTreeReport = `\nPaint tree changes: ${paintTreeChanges.length}\n` +
      paintTreeChanges.slice(0, 10).map((c) => `  - [${c.type}] ${c.path} ${c.property ?? ""}: ${c.before ?? ""} → ${c.after ?? ""}`).join("\n");
  } else if (approvals.approvedPaintTreeMatches.length > 0) {
    const reasons = [...new Set(approvals.approvedPaintTreeMatches.map((match) => match.rule.reason))];
    paintTreeReport = `\nPaint tree changes approved: ${approvals.approvedPaintTreeMatches.length}\n` +
      reasons.map((reason) => `  - ${reason}`).join("\n");
  }

  let approvalReport = "";
  if (approvals.approvalWarnings.length > 0) {
    approvalReport = `\nApproval warnings:\n` +
      approvals.approvalWarnings.map((warning) => `  - ${warning.message}`).join("\n");
  }

  const fullReport = `${visualReport}\n\n${a11yReport}${computedReport}${paintTreeReport}${approvalReport}`;

  return {
    vrtDiff,
    visualSemantic,
    a11yDiff,
    baselineIssueCount,
    brokenIssueCount,
    computedStyleDiffs,
    referencedComputedStyleDiffs,
    referencedHoverStyleDiffs,
    trackedComputedStyleTargets,
    hoverDiffDetected,
    paintTreeChanges,
    approvalWarnings: approvals.approvalWarnings,
    approvedVisualRules: approvals.approvedVisualRules,
    approvedPaintTreeMatches: approvals.approvedPaintTreeMatches,
    visualReport,
    a11yReport,
    fullReport,
  };
}

// ---- LLM ----

export function buildFixPrompt(vrtReport: string, fullCss: string): string {
  return `You are debugging a CSS regression. One CSS property declaration was removed from a stylesheet, causing a visual regression.

## VRT Diagnosis Report
${vrtReport}

## Current CSS (with the missing line)
\`\`\`css
${fullCss}
\`\`\`

## Task
Identify which CSS property declaration was removed and provide the exact fix.

Respond in this EXACT format (no other text):
SELECTOR: <the CSS selector>
PROPERTY: <the CSS property name>
VALUE: <the CSS value>

For example:
SELECTOR: .header
PROPERTY: padding
VALUE: 12px 24px`;
}

export function parseLLMFix(response: string): { selector: string; property: string; value: string } | null {
  const selectorMatch = response.match(/SELECTOR:\s*(.+)/);
  const propertyMatch = response.match(/PROPERTY:\s*(.+)/);
  const valueMatch = response.match(/VALUE:\s*(.+)/);
  if (!selectorMatch || !propertyMatch || !valueMatch) return null;
  return {
    selector: selectorMatch[1].trim(),
    property: propertyMatch[1].trim(),
    value: valueMatch[1].trim(),
  };
}

// ---- HTML helpers ----

export const HTML_PATH = join(import.meta.dirname!, "..", "fixtures", "css-challenge", "page.html");

export function extractCss(html: string): string | null {
  const m = html.match(/<style id="target-css">([\s\S]*?)<\/style>/);
  return m ? m[1] : null;
}

export function replaceCss(html: string, originalCss: string, newCss: string): string {
  return html.replace(originalCss, newCss);
}

// ---- Property categorization ----

const LAYOUT_PROPS = new Set([
  "display", "flex", "flex-direction", "flex-wrap", "flex-shrink", "flex-grow",
  "align-items", "justify-content", "gap", "grid-template-columns", "grid-template-rows",
  "position", "top", "right", "bottom", "left", "float", "clear", "overflow", "overflow-x", "overflow-y",
]);
const SPACING_PROPS = new Set([
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
]);
const SIZING_PROPS = new Set([
  "width", "height", "max-width", "max-height", "min-width", "min-height",
  "line-height",
]);
const VISUAL_PROPS = new Set([
  "background", "background-color", "background-image",
  "color", "opacity",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-radius", "border-spacing",
  "box-shadow", "text-shadow",
  "outline",
]);
const TYPO_PROPS = new Set([
  "font-family", "font-size", "font-weight", "font-style",
  "text-align", "text-decoration", "text-transform", "text-indent",
  "letter-spacing", "word-spacing", "white-space",
]);

const ANIMATION_PROPS = new Set([
  "animation", "animation-name", "animation-duration", "animation-delay",
  "animation-timing-function", "animation-iteration-count", "animation-direction",
  "animation-fill-mode", "animation-play-state",
  "transition", "transition-property", "transition-duration", "transition-delay",
  "transition-timing-function",
]);

const TRANSFORM_PROPS = new Set([
  "transform", "transform-origin", "translate", "rotate", "scale",
  "filter", "backdrop-filter", "clip-path", "mask",
]);

export type PropertyCategory = "layout" | "spacing" | "sizing" | "visual" | "typography" | "animation" | "transform" | "other";

export function categorizeProperty(property: string): PropertyCategory {
  if (LAYOUT_PROPS.has(property)) return "layout";
  if (SPACING_PROPS.has(property)) return "spacing";
  if (SIZING_PROPS.has(property)) return "sizing";
  if (VISUAL_PROPS.has(property)) return "visual";
  if (TYPO_PROPS.has(property)) return "typography";
  if (ANIMATION_PROPS.has(property)) return "animation";
  if (TRANSFORM_PROPS.has(property)) return "transform";
  return "other";
}

function dedupeApprovalWarnings(warnings: ApprovalWarning[]): ApprovalWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.message}:${warning.rule.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
