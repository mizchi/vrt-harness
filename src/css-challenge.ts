#!/usr/bin/env node
/**
 * CSS Recovery Challenge
 *
 * 1. GitHub 風 HTML ページを Playwright で表示
 * 2. CSS の 1 行 (プロパティ宣言) をランダムに削除
 * 3. VRT パイプラインで差分を検出
 * 4. 差分情報から LLM に元の CSS を復元させる
 * 5. 復元結果を再度 VRT で検証
 *
 * Usage: npx tsx src/css-challenge.ts [--fixture <name>] [--seed <number>] [--max-attempts <number>] [--approval <path>] [--strict]
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { formatPlaywrightLaunchError, isPlaywrightSandboxRestrictionError } from "./playwright-launch-error.ts";
import { applyApprovalToVrtDiff, collectApprovalWarnings, inferApprovalChangeType, loadApprovalManifest } from "./approval.ts";
import { getCssChallengeFixturePath } from "./css-challenge-fixtures.ts";
import { categorizeProperty } from "./css-challenge-core.ts";
import { compareScreenshots, encodePng } from "./heatmap.ts";
import { classifyVisualDiff } from "./visual-semantic.ts";
import { diffA11yTrees, checkA11yTree, parsePlaywrightA11ySnapshot } from "./a11y-semantic.ts";
import { createLLMProvider } from "./llm-client.ts";
import type { A11yNode, VrtSnapshot } from "./types.ts";

// ---- Config ----

const TMP = join(import.meta.dirname!, "..", "test-results", "css-challenge");

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const SEED = parseInt(getArg("seed", String(Date.now())), 10);
const MAX_ATTEMPTS = parseInt(getArg("max-attempts", "3"), 10);
const FIXTURE = getArg("fixture", "page");
const HTML_PATH = getCssChallengeFixturePath(FIXTURE);
const APPROVAL_PATH = getArg("approval", "");
const STRICT = args.includes("--strict");
const VIEWPORT = { width: 1280, height: 900 };

// ---- Terminal helpers ----

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";

function hr() { console.log(`${DIM}${"─".repeat(72)}${RESET}`); }
function banner(text: string) { console.log(`\n${BOLD}${CYAN}▸ ${text}${RESET}\n`); }

// Kitty graphics
function kittyShow(pngBuffer: Buffer, cols = 60) {
  const b64 = pngBuffer.toString("base64");
  const chunkSize = 4096;
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    if (i === 0) {
      process.stdout.write(`\x1b_Ga=T,f=100,c=${cols},m=${isLast ? 0 : 1};${chunk}\x1b\\`);
    } else {
      process.stdout.write(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
  }
  process.stdout.write("\n");
}

const SHOW_IMAGES = !process.env.NO_IMAGES;

async function showPng(path: string, label: string) {
  console.log(`  ${DIM}${label}:${RESET}`);
  if (!SHOW_IMAGES) { console.log(`  ${DIM}(image: ${path})${RESET}`); return; }
  try { kittyShow(await readFile(path)); } catch { console.log("  (image not available)"); }
}

// ---- CSS manipulation ----

interface CssLine {
  index: number;       // line index in full CSS text
  text: string;        // original line text
  property: string;    // e.g. "padding"
  value: string;       // e.g. "12px 24px"
  selector: string;    // containing selector
}

function parseCssDeclarations(css: string): CssLine[] {
  const lines = css.split("\n");
  const declarations: CssLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments, empty lines, @media rules
    if (!trimmed || trimmed.startsWith("/*") || trimmed.startsWith("//") || trimmed.startsWith("@") || trimmed === "}") continue;

    // Handle one-line rules: `.selector { prop: val; prop: val; }`
    const oneLineMatch = trimmed.match(/^([^{]+)\{([^}]+)\}\s*$/);
    if (oneLineMatch) {
      const selector = oneLineMatch[1].trim();
      const body = oneLineMatch[2].trim();
      // Parse each property in the body
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
          });
        }
      }
    }
  }

  return declarations;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function removeCssLine(css: string, declaration: CssLine): string {
  const lines = css.split("\n");
  const line = lines[declaration.index];
  // Remove the specific property declaration from the line
  // Match "property: value;" or "property: value" (last in block)
  const propPattern = new RegExp(
    `\\s*${escapeRegex(declaration.property)}\\s*:\\s*${escapeRegex(declaration.value)}\\s*;?`,
  );
  lines[declaration.index] = line.replace(propPattern, "");
  return lines.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Playwright capture ----

async function capturePageState(html: string, screenshotPath: string): Promise<{ a11yTree: A11yNode; screenshotPath: string }> {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (isPlaywrightSandboxRestrictionError(error)) {
      throw new Error(formatPlaywrightLaunchError(error, { commandHint: "in your local terminal or in CI" }));
    }
    throw error;
  }
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Capture a11y tree via CDP
  let a11yTree: A11yNode = { role: "document", name: "", children: [] };
  try {
    const client = await page.context().newCDPSession(page);
    const result = await client.send("Accessibility.getFullAXTree");
    a11yTree = cdpNodesToTree(result.nodes) as A11yNode;
    await client.detach();
  } catch {
    // Fallback: minimal tree
  }
  await browser.close();

  return { a11yTree, screenshotPath };
}

function cdpNodesToTree(nodes: Array<{
  nodeId: string;
  parentId?: string;
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

// ---- LLM fix ----

function buildFixPrompt(
  removedFrom: { selector: string; property: string },
  vrtReport: string,
  fullCss: string,
): string {
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

function parseLLMFix(response: string): { selector: string; property: string; value: string } | null {
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

function applyCssFix(css: string, fix: { selector: string; property: string; value: string }): string {
  const lines = css.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const oneLineMatch = trimmed.match(/^([^{]+)\{([^}]+)\}\s*$/);
    if (oneLineMatch) {
      const selector = oneLineMatch[1].trim();
      if (selector === fix.selector) {
        // Insert the property before the closing brace
        const body = oneLineMatch[2].trim();
        const newBody = `${body} ${fix.property}: ${fix.value};`;
        lines[i] = `${selector} { ${newBody} }`;
        return lines.join("\n");
      }
    }
  }

  // Fallback: no matching selector found
  return css;
}

// ---- Main ----

async function main() {
  await mkdir(TMP, { recursive: true });

  const rand = seededRandom(SEED);
  const htmlRaw = await readFile(HTML_PATH, "utf-8");

  // Extract CSS from <style id="target-css">
  const cssMatch = htmlRaw.match(/<style id="target-css">([\s\S]*?)<\/style>/);
  if (!cssMatch) { console.error("Could not find <style id=\"target-css\">"); process.exit(1); }
  const originalCss = cssMatch[1];

  // Parse declarations and pick one to remove
  const declarations = parseCssDeclarations(originalCss);
  const candidateIndex = Math.floor(rand() * declarations.length);
  const removed = declarations[candidateIndex];
  const approvalManifest = APPROVAL_PATH ? await loadApprovalManifest(APPROVAL_PATH) : null;
  const approvalWarnings = approvalManifest ? collectApprovalWarnings(approvalManifest) : [];

  console.log();
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  CSS Recovery Challenge — Can AI fix a CSS regression using VRT?     ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  ${DIM}Fixture: ${FIXTURE} | Seed: ${SEED} | Max attempts: ${MAX_ATTEMPTS}${RESET}`);
  if (approvalManifest) {
    console.log(`  ${DIM}Approval: ${APPROVAL_PATH}${STRICT ? " (strict mode: ignored)" : ""}${RESET}`);
    for (const warning of approvalWarnings) {
      console.log(`  ${YELLOW}! ${warning.message}${RESET}`);
    }
  }

  // ============================================================
  // Phase 1: Capture baseline
  // ============================================================
  banner("Phase 1: Capture Baseline");

  const baselinePath = join(TMP, "baseline.png");
  const baselineState = await capturePageState(htmlRaw, baselinePath);
  await showPng(baselinePath, "Baseline");

  const baselineIssues = checkA11yTree(baselineState.a11yTree);
  console.log(`  ${DIM}A11y issues: ${baselineIssues.length}${RESET}`);

  let nodeCount = 0;
  function countNodes(node: A11yNode) { nodeCount++; for (const c of node.children ?? []) countNodes(c); }
  countNodes(baselineState.a11yTree);
  console.log(`  ${DIM}A11y tree: ${nodeCount} nodes${RESET}`);
  console.log(`  ${DIM}CSS declarations: ${declarations.length}${RESET}`);

  // ============================================================
  // Phase 2: Remove CSS line and capture broken state
  // ============================================================
  banner("Phase 2: Remove CSS Line → Regression");

  console.log(`  ${RED}Removed:${RESET} ${BOLD}${removed.selector}${RESET} { ${removed.property}: ${removed.value} }`);
  console.log(`  ${DIM}Line ${removed.index + 1}: ${removed.text.trim()}${RESET}`);

  const brokenCss = removeCssLine(originalCss, removed);
  const brokenHtml = htmlRaw.replace(originalCss, brokenCss);

  const brokenPath = join(TMP, "broken.png");
  const brokenState = await capturePageState(brokenHtml, brokenPath);
  await showPng(brokenPath, "After removing CSS line");

  // ============================================================
  // Phase 3: VRT Analysis
  // ============================================================
  banner("Phase 3: VRT Analysis");

  // Visual diff
  const vrtSnap: VrtSnapshot = {
    testId: "page", testTitle: "page", projectName: "css-challenge",
    screenshotPath: brokenPath, baselinePath: baselinePath, status: "changed",
  };
  const rawVrtDiff = await compareScreenshots(vrtSnap, { outputDir: TMP });
  const vrtApproval = rawVrtDiff && approvalManifest
    ? applyApprovalToVrtDiff(
      rawVrtDiff,
      approvalManifest,
      {
        selector: removed.selector,
        property: removed.property,
        category: categorizeProperty(removed.property),
        changeType: inferApprovalChangeType(removed.property, categorizeProperty(removed.property)),
      },
      { strict: STRICT },
    )
    : null;
  const vrtDiff = vrtApproval?.diff ?? rawVrtDiff;

  let visualReport = "";
  if (vrtDiff && vrtDiff.diffPixels > 0) {
    if (vrtDiff.heatmapPath) {
      await showPng(vrtDiff.heatmapPath, `Heatmap (${(vrtDiff.diffRatio * 100).toFixed(1)}% changed)`);
    }
    const sem = classifyVisualDiff(vrtDiff);
    console.log(`  ${BOLD}Visual:${RESET} ${sem.summary}`);
    for (const c of sem.changes) {
      console.log(`    ${YELLOW}~${RESET} [${c.type}] ${c.description} (confidence: ${(c.confidence * 100).toFixed(0)}%)`);
    }
    visualReport = `Visual diff: ${(vrtDiff.diffRatio * 100).toFixed(1)}% pixels changed\n` +
      `Regions: ${vrtDiff.regions.map((r) => `(${r.x},${r.y} ${r.width}x${r.height})`).join(", ")}\n` +
      `Semantic: ${sem.summary}\n` +
      sem.changes.map((c) => `  - [${c.type}] ${c.description}`).join("\n");
  } else if (vrtApproval?.approved) {
    console.log(`  ${CYAN}Visual diff approved by manifest${RESET}`);
    for (const rule of vrtApproval.matchedRules) {
      console.log(`    ${CYAN}=${RESET} ${rule.reason}`);
    }
    visualReport = `Visual diff approved by manifest: ${vrtApproval.matchedRules.map((rule) => rule.reason).join("; ")}`;
  } else {
    console.log(`  ${DIM}No visual diff detected (CSS line had no visible effect)${RESET}`);
    visualReport = "No visual diff detected — the removed CSS line had no visible effect at this viewport size.";
  }

  // A11y diff
  const a11yDiff = diffA11yTrees(
    parsePlaywrightA11ySnapshot("page", "page", baselineState.a11yTree as any),
    parsePlaywrightA11ySnapshot("page", "page", brokenState.a11yTree as any),
  );
  let a11yReport = "";
  if (a11yDiff.changes.length > 0) {
    console.log(`  ${BOLD}A11y:${RESET} ${a11yDiff.changes.length} change(s)`);
    for (const c of a11yDiff.changes) {
      const icon = c.severity === "error" ? `${RED}✗${RESET}` : `${YELLOW}~${RESET}`;
      console.log(`    ${icon} [${c.type}] ${c.description}`);
    }
    a11yReport = `A11y changes: ${a11yDiff.changes.length}\n` +
      a11yDiff.changes.map((c) => `  - [${c.type}] ${c.description}`).join("\n");
  } else {
    console.log(`  ${DIM}A11y: no semantic changes${RESET}`);
    a11yReport = "No a11y tree changes detected.";
  }

  const brokenIssues = checkA11yTree(brokenState.a11yTree);
  if (brokenIssues.length > baselineIssues.length) {
    const newIssues = brokenIssues.length - baselineIssues.length;
    console.log(`  ${RED}New a11y issues: ${newIssues}${RESET}`);
    a11yReport += `\nNew a11y quality issues: ${newIssues}\n` +
      brokenIssues.slice(baselineIssues.length).map((i) => `  - [${i.severity}] ${i.rule}: ${i.message}`).join("\n");
  }

  const fullVrtReport = `${visualReport}\n\n${a11yReport}`;

  // ============================================================
  // Phase 4: LLM attempts to fix
  // ============================================================
  banner("Phase 4: AI Fix Attempt");

  const llm = createLLMProvider();
  if (!llm) {
    console.log(`  ${YELLOW}ANTHROPIC_API_KEY not set — showing what the LLM would receive${RESET}\n`);
    hr();
    console.log(`  ${BOLD}VRT Report for LLM:${RESET}`);
    for (const line of fullVrtReport.split("\n")) {
      console.log(`  ${DIM}${line}${RESET}`);
    }
    hr();
    console.log(`\n  ${BOLD}Answer:${RESET}`);
    console.log(`  SELECTOR: ${removed.selector}`);
    console.log(`  PROPERTY: ${removed.property}`);
    console.log(`  VALUE: ${removed.value}`);
    console.log();
    console.log(`  ${DIM}Set ANTHROPIC_API_KEY to have the AI attempt recovery.${RESET}`);
    await cleanup();
    return;
  }

  let currentCss = brokenCss;
  let fixed = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`  ${BOLD}Attempt ${attempt}/${MAX_ATTEMPTS}${RESET}`);

    const prompt = buildFixPrompt(
      { selector: "???", property: "???" },
      fullVrtReport,
      currentCss,
    );

    const llmStart = Date.now();
    const response = await llm.complete(prompt);
    const llmMs = Date.now() - llmStart;
    console.log(`  ${DIM}LLM responded in ${llmMs}ms${RESET}`);

    const fix = parseLLMFix(response);
    if (!fix) {
      console.log(`  ${RED}Could not parse LLM response${RESET}`);
      console.log(`  ${DIM}${response.slice(0, 200)}${RESET}`);
      continue;
    }

    console.log(`  ${CYAN}Proposed fix:${RESET} ${fix.selector} { ${fix.property}: ${fix.value} }`);

    // Check exact match
    const exactMatch = fix.selector === removed.selector &&
      fix.property === removed.property &&
      normalizeValue(fix.value) === normalizeValue(removed.value);

    if (exactMatch) {
      console.log(`  ${GREEN}${BOLD}✓ EXACT MATCH${RESET}`);
    } else {
      // Partial match
      const selectorOk = fix.selector === removed.selector;
      const propertyOk = fix.property === removed.property;
      console.log(`  Selector: ${selectorOk ? GREEN + "✓" : RED + "✗"} ${RESET}(expected: ${removed.selector})`);
      console.log(`  Property: ${propertyOk ? GREEN + "✓" : RED + "✗"} ${RESET}(expected: ${removed.property})`);
      if (propertyOk) {
        console.log(`  Value:    ${normalizeValue(fix.value) === normalizeValue(removed.value) ? GREEN + "✓" : YELLOW + "~"} ${RESET}(expected: ${removed.value}, got: ${fix.value})`);
      }
    }

    // Apply fix and verify visually
    const fixedCss = applyCssFix(currentCss, fix);
    const fixedHtml = htmlRaw.replace(originalCss, fixedCss);
    const fixedPath = join(TMP, `fixed-${attempt}.png`);
    const fixedState = await capturePageState(fixedHtml, fixedPath);

    // Compare fixed vs baseline
    const fixedSnap: VrtSnapshot = {
      testId: "page", testTitle: "page", projectName: "css-challenge",
      screenshotPath: fixedPath, baselinePath: baselinePath, status: "changed",
    };
    const fixedDiff = await compareScreenshots(fixedSnap, { outputDir: TMP });
    const fixedDiffRatio = fixedDiff?.diffRatio ?? 0;

    if (fixedDiffRatio === 0) {
      console.log(`  ${BG_GREEN}${BOLD} PIXEL-PERFECT RECOVERY ${RESET}`);
      await showPng(fixedPath, "Fixed (matches baseline)");
      fixed = true;
      break;
    } else if (fixedDiffRatio < 0.01) {
      console.log(`  ${GREEN}Nearly perfect: ${(fixedDiffRatio * 100).toFixed(2)}% diff remaining${RESET}`);
      await showPng(fixedPath, "Fixed (near-match)");
      fixed = true;
      break;
    } else {
      console.log(`  ${YELLOW}Still ${(fixedDiffRatio * 100).toFixed(1)}% diff from baseline${RESET}`);
      // Update report for next attempt
      if (fixedDiff && fixedDiff.heatmapPath) {
        await showPng(fixedDiff.heatmapPath, "Remaining diff");
      }
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  hr();
  console.log();
  console.log(`  ${BOLD}CSS Recovery Challenge Results:${RESET}`);
  console.log();
  console.log(`  ${DIM}Fixture:${RESET}  ${FIXTURE}`);
  console.log(`  ${DIM}Seed:${RESET}     ${SEED}`);
  console.log(`  ${DIM}Removed:${RESET}  ${removed.selector} { ${removed.property}: ${removed.value} }`);
  console.log(`  ${DIM}Visual:${RESET}   ${vrtDiff ? (vrtDiff.diffRatio * 100).toFixed(1) + "% diff" : "no diff"}`);
  console.log(`  ${DIM}A11y:${RESET}     ${a11yDiff.changes.length} change(s)`);
  console.log(`  ${DIM}Result:${RESET}   ${fixed ? GREEN + BOLD + "RECOVERED" : RED + BOLD + "FAILED"} ${RESET}`);
  console.log();

  await cleanup();
}

function normalizeValue(v: string): string {
  return v.replace(/\s+/g, " ").replace(/;$/, "").trim();
}

async function cleanup() {
  try { await rm(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((error) => {
  if (isPlaywrightSandboxRestrictionError(error)) {
    console.error(formatPlaywrightLaunchError(error, { commandHint: "in your local terminal or in CI" }));
  } else {
    console.error(error);
  }
  process.exit(1);
});
