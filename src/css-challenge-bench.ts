#!/usr/bin/env node
/**
 * CSS Recovery Challenge — Benchmark Runner
 *
 * 複数 seed でチャレンジを実行し、検出率・復元率を計測する。
 * multi-viewport (desktop + mobile) 対応。結果を JSONL に蓄積。
 *
 * Usage:
 *   npx tsx src/css-challenge-bench.ts [--fixture page] [--trials 20] [--start-seed 1]
 *   npx tsx src/css-challenge-bench.ts --fixture all
 *   npx tsx src/css-challenge-bench.ts --approval approval.json --suggest-approval
 *   npx tsx src/css-challenge-bench.ts --backend prescanner
 *   npx tsx src/css-challenge-bench.ts --trials 30 --no-db
 *   ANTHROPIC_API_KEY=... npx tsx src/css-challenge-bench.ts --trials 10
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import {
  collectApprovalWarnings,
  loadApprovalManifest,
  suggestApprovalRule,
  type ApprovalManifest,
  type ApprovalRule,
} from "./approval.ts";
import {
  parseCssDeclarations, removeCssProperty, removeSelectorBlock, groupBySelector, applyCssFix, normalizeValue,
  seededRandom, createBrowser, createCraterClient, capturePageState, capturePageStateCrater, analyzeVrtDiff,
  buildFixPrompt, parseLLMFix, categorizeProperty,
  extractCss, replaceCss,
  type CssDeclaration, type CapturedState, type TrialResult, type RenderBackend, type VrtAnalysis,
} from "./css-challenge-core.ts";
import { isCraterAvailable, type CraterClient } from "./crater-client.ts";
import {
  classifyDeclaration,
  classifyUndetectedReason,
  isInteractiveSelector,
  isOutOfScope,
  type ViewportDetectionResult,
} from "./detection-classify.ts";
import { appendRecords, type DetectionRecord } from "./detection-db.ts";
import { createLLMProvider } from "./llm-client.ts";
import { appendBenchHistory, buildBenchHistoryRecord } from "./bench-history.ts";
import {
  CSS_BENCH_OUTPUT_ROOT,
  getCssBenchApprovalSuggestionsPath,
  getCssBenchFixtureOutputDir,
  getCssChallengeFixturePath,
  listCssChallengeFixtureNames,
  normalizeCssChallengeFixtureSelection,
} from "./css-challenge-fixtures.ts";
import {
  buildCustomPropertyUsageIndex,
  collectComputedStyleTrackingProperties,
  findExpectedComputedStyleTargets,
  mergeComputedStyleProperties,
  type ComputedStyleTarget,
} from "./css-custom-properties.ts";
import { TRACKED_PROPERTIES } from "./computed-style-capture.ts";
import { formatPlaywrightLaunchError, isPlaywrightSandboxRestrictionError } from "./playwright-launch-error.ts";
import {
  hasAnyDetectionSignal,
  hasCraterPrescanSignal,
  resolvePrescannerTrial,
  summarizePrescannerTrials,
  type PrescannerTrialResolution,
} from "./prescanner.ts";

// ---- Config ----

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function getArgValues(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }

type BenchBackend = RenderBackend | "prescanner";
export type ChallengeMode = "property" | "selector";

export interface CssChallengeBenchCliOptions {
  trials: number;
  startSeed: number;
  saveDb: boolean;
  fixtureArgs: string[];
  backend: BenchBackend;
  approvalPath: string;
  strict: boolean;
  suggestApproval: boolean;
  outputRoot: string;
  mode: ChallengeMode;
}

export function parseCssChallengeBenchArgs(cliArgs: string[]): CssChallengeBenchCliOptions {
  function getCliArg(name: string, fallback: string): string {
    const idx = cliArgs.indexOf(`--${name}`);
    return idx >= 0 && cliArgs[idx + 1] ? cliArgs[idx + 1] : fallback;
  }
  function getCliArgValues(name: string): string[] {
    const values: string[] = [];
    for (let i = 0; i < cliArgs.length; i++) {
      if (cliArgs[i] === `--${name}` && cliArgs[i + 1]) values.push(cliArgs[i + 1]);
    }
    return values;
  }
  function hasCliFlag(name: string): boolean {
    return cliArgs.includes(`--${name}`);
  }

  return {
    trials: parseInt(getCliArg("trials", "20"), 10),
    startSeed: parseInt(getCliArg("start-seed", "1"), 10),
    saveDb: !hasCliFlag("no-db"),
    fixtureArgs: getCliArgValues("fixture"),
    backend: getCliArg("backend", "chromium") as BenchBackend,
    approvalPath: getCliArg("approval", ""),
    strict: hasCliFlag("strict"),
    suggestApproval: hasCliFlag("suggest-approval"),
    outputRoot: getCliArg("output-root", CSS_BENCH_OUTPUT_ROOT),
    mode: getCliArg("mode", "property") as ChallengeMode,
  };
}

const CLI_OPTIONS = parseCssChallengeBenchArgs(args);
const TRIALS = CLI_OPTIONS.trials;
const START_SEED = CLI_OPTIONS.startSeed;
const SAVE_DB = CLI_OPTIONS.saveDb;
const FIXTURE_ARGS = CLI_OPTIONS.fixtureArgs;
const BACKEND = CLI_OPTIONS.backend;
const APPROVAL_PATH = CLI_OPTIONS.approvalPath;
const STRICT = CLI_OPTIONS.strict;
const SUGGEST_APPROVAL = CLI_OPTIONS.suggestApproval;
const OUTPUT_ROOT = CLI_OPTIONS.outputRoot;
const MODE = CLI_OPTIONS.mode;

const VIEWPORTS = [
  { width: 1440, height: 900, label: "wide" },
  { width: 1280, height: 900, label: "desktop" },
  { width: 375, height: 812, label: "mobile" },
];

// ---- Terminal helpers ----

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function hr() { console.log(`${DIM}${"─".repeat(76)}${RESET}`); }

interface ViewportAnalysisBundle {
  viewportResults: ViewportDetectionResult[];
  primaryAnalysis: VrtAnalysis | null;
  anyVisual: boolean;
  anyA11y: boolean;
  anyComputed: boolean;
  anyHover: boolean;
  anyPaintTree: boolean;
  maxDiffRatio: number;
  maxDiffPixels: number;
  totalA11yChanges: number;
  detected: boolean;
}

async function captureStateForBackend(
  backend: RenderBackend,
  viewport: { width: number; height: number; label: string },
  html: string,
  screenshotPath: string,
  options: {
    browser: Browser | null;
    craterClient: CraterClient | null;
    captureHover: boolean;
    trackedProperties: string[];
    interactionSelectors?: string[];
  },
): Promise<CapturedState> {
  if (backend === "crater") {
    if (!options.craterClient) throw new Error("Crater client is not initialized");
    return capturePageStateCrater(options.craterClient, viewport, html, screenshotPath, {
      trackedProperties: options.trackedProperties,
    });
  }
  if (!options.browser) throw new Error("Chromium browser is not initialized");
  return capturePageState(options.browser, viewport, html, screenshotPath, {
    captureHover: options.captureHover,
    trackedProperties: options.trackedProperties,
    interactionSelectors: options.interactionSelectors,
  });
}

async function analyzeAcrossViewports(
  backend: RenderBackend,
  html: string,
  trialDir: string,
  baselines: Map<string, CapturedState>,
  options: {
    browser: Browser | null;
    craterClient: CraterClient | null;
    captureHover: boolean;
    trackedProperties: string[];
    manifest: ApprovalManifest | null;
    approvalContext: { selector: string; property: string; category: ReturnType<typeof categorizeProperty> };
    expectedComputedStyleTargets: ComputedStyleTarget[];
    strict: boolean;
  },
): Promise<ViewportAnalysisBundle> {
  const viewportResults: ViewportDetectionResult[] = [];
  let anyVisual = false;
  let anyA11y = false;
  let maxDiffRatio = 0;
  let maxDiffPixels = 0;
  let totalA11yChanges = 0;
  let primaryAnalysis: VrtAnalysis | null = null;
  let anyComputed = false;
  let anyHover = false;
  let anyPaintTree = false;

  for (const viewport of VIEWPORTS) {
    const brokenPath = join(trialDir, `${backend}-broken-${viewport.label}.png`);
    const brokenState = await captureStateForBackend(backend, viewport, html, brokenPath, {
        browser: options.browser,
        craterClient: options.craterClient,
        captureHover: options.captureHover,
        trackedProperties: options.trackedProperties,
        interactionSelectors: options.expectedComputedStyleTargets.map((target) => target.selector),
      });
    const baseline = baselines.get(viewport.label);
    if (!baseline) throw new Error(`Missing ${backend} baseline for viewport ${viewport.label}`);

    const analysis = await analyzeVrtDiff(baseline, brokenState, trialDir, {
      manifest: options.manifest,
      context: options.approvalContext,
      strict: options.strict,
      expectedComputedStyleTargets: options.expectedComputedStyleTargets,
    });

    const visualDiffDetected = (analysis.vrtDiff?.diffPixels ?? 0) > 0;
    const paintTreeDiffCount = analysis.paintTreeChanges.length;
    // In selector mode, use all computed style diffs (tracked targets filter is unreliable for multi-property deletion)
    const computedStyleDiffCount = MODE === "selector"
      ? analysis.computedStyleDiffs.length
      : (analysis.trackedComputedStyleTargets.length > 0
        ? analysis.referencedComputedStyleDiffs.length
        : analysis.computedStyleDiffs.length);

    viewportResults.push({
      width: viewport.width,
      height: viewport.height,
      visualDiffDetected,
      visualDiffRatio: analysis.vrtDiff?.diffRatio ?? 0,
      a11yDiffDetected: analysis.a11yDiff.changes.length > 0,
      a11yChangeCount: analysis.a11yDiff.changes.length,
      computedStyleDiffCount,
      hoverDiffDetected: analysis.hoverDiffDetected,
      paintTreeDiffCount,
    });

    if (visualDiffDetected) anyVisual = true;
    if (analysis.a11yDiff.changes.length > 0) anyA11y = true;
    if (computedStyleDiffCount > 0) anyComputed = true;
    if (analysis.hoverDiffDetected) anyHover = true;
    if (paintTreeDiffCount > 0) anyPaintTree = true;
    if ((analysis.vrtDiff?.diffRatio ?? 0) > maxDiffRatio) maxDiffRatio = analysis.vrtDiff?.diffRatio ?? 0;
    if ((analysis.vrtDiff?.diffPixels ?? 0) > maxDiffPixels) maxDiffPixels = analysis.vrtDiff?.diffPixels ?? 0;
    totalA11yChanges += analysis.a11yDiff.changes.length;

    if (viewport.label === "desktop") {
      primaryAnalysis = analysis;
    }
  }

  return {
    viewportResults,
    primaryAnalysis,
    anyVisual,
    anyA11y,
    anyComputed,
    anyHover,
    anyPaintTree,
    maxDiffRatio,
    maxDiffPixels,
    totalA11yChanges,
    detected: hasAnyDetectionSignal(viewportResults),
  };
}

// ---- Main ----

async function runFixtureBenchmark(fixture: string) {
  const fixturePath = getCssChallengeFixturePath(fixture);
  const tmpDir = getCssBenchFixtureOutputDir(fixture, OUTPUT_ROOT);
  await mkdir(tmpDir, { recursive: true });

  const htmlRaw = await readFile(fixturePath, "utf-8");
  const originalCss = extractCss(htmlRaw);
  if (!originalCss) { console.error("CSS not found"); process.exit(1); }

  const declarations = parseCssDeclarations(originalCss);
  const selectorBlocks = groupBySelector(declarations);
  const customPropertyUsage = buildCustomPropertyUsageIndex(declarations);
  const trackedProperties = mergeComputedStyleProperties(
    TRACKED_PROPERTIES,
    collectComputedStyleTrackingProperties(declarations),
  );
  const llm = createLLMProvider();
  const approvalManifest = APPROVAL_PATH ? await loadApprovalManifest(APPROVAL_PATH) : null;
  const approvalWarnings = approvalManifest ? collectApprovalWarnings(approvalManifest) : [];

  console.log();
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  CSS Recovery Challenge — Benchmark                                     ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  ${DIM}Fixture: ${fixture} | Mode: ${MODE} | Trials: ${TRIALS} | Declarations: ${declarations.length} | Selectors: ${selectorBlocks.length}${RESET}`);
  console.log(`  ${DIM}Backend: ${BACKEND} | Viewports: ${VIEWPORTS.map((v) => `${v.label}(${v.width}x${v.height})`).join(", ")}${RESET}`);
  console.log(`  ${DIM}LLM: ${llm ? "enabled" : "disabled"} | DB: ${SAVE_DB ? "enabled" : "disabled"}${RESET}`);
  if (approvalManifest) {
    console.log(`  ${DIM}Approval: ${APPROVAL_PATH}${STRICT ? " (strict mode: ignored)" : ""}${RESET}`);
    for (const warning of approvalWarnings) {
      console.log(`  ${YELLOW}! ${warning.message}${RESET}`);
    }
  }
  if (SUGGEST_APPROVAL) {
    console.log(`  ${DIM}Approval suggestions: enabled${RESET}`);
  }
  console.log();

  // Check crater availability
  let craterClient: CraterClient | null = null;
  if (BACKEND === "crater" || BACKEND === "prescanner") {
    if (!await isCraterAvailable()) {
      console.log(`  ${RED}Crater BiDi server not available at ws://127.0.0.1:9222${RESET}`);
      console.log(`  ${DIM}Start it: cd ~/ghq/github.com/mizchi/crater && just build-bidi && just start-bidi-with-font${RESET}`);
      process.exit(1);
    }
    craterClient = await createCraterClient();
  }

  let browser: Browser | null = null;
  const chromiumBaselines = new Map<string, CapturedState>();
  const craterBaselines = new Map<string, CapturedState>();

  async function ensureChromiumResources(): Promise<{ browser: Browser; baselines: Map<string, CapturedState> }> {
    if (!browser) {
      ({ browser } = await createBrowser());
    }
    for (const viewport of VIEWPORTS) {
      if (chromiumBaselines.has(viewport.label)) continue;
      const path = join(tmpDir, `baseline-chromium-${viewport.label}.png`);
      chromiumBaselines.set(
        viewport.label,
        await capturePageState(browser, viewport, htmlRaw, path, {
          captureHover: true,
          trackedProperties,
        }),
      );
    }
    return { browser, baselines: chromiumBaselines };
  }

  if (BACKEND === "chromium") {
    await ensureChromiumResources();
  }
  if ((BACKEND === "crater" || BACKEND === "prescanner") && craterClient) {
    for (const viewport of VIEWPORTS) {
      const path = join(tmpDir, `baseline-crater-${viewport.label}.png`);
      craterBaselines.set(
        viewport.label,
        await capturePageStateCrater(craterClient, viewport, htmlRaw, path, {
          trackedProperties,
        }),
      );
    }
  }

  const results: TrialResult[] = [];
  const dbRecords: DetectionRecord[] = [];
  const approvalSuggestions: ApprovalRule[] = [];
  const prescannerResolutions: PrescannerTrialResolution[] = [];
  const runId = new Date().toISOString();
  const startTime = Date.now();

  const shuffledProps = shuffleWithSeed(declarations, START_SEED);
  const shuffledBlocks = shuffleWithSeed(selectorBlocks, START_SEED);

  for (let i = 0; i < TRIALS; i++) {
    const seed = START_SEED + i;

    // Select what to remove based on mode
    let removed: CssDeclaration;
    let brokenCss: string;
    let trialLabel: string;

    if (MODE === "selector") {
      const block = shuffledBlocks[i % shuffledBlocks.length];
      removed = block.declarations[0]; // Use first declaration for classification
      brokenCss = removeSelectorBlock(originalCss, block);
      trialLabel = `${block.selector} { ${block.declarations.length} props }`;
    } else {
      removed = shuffledProps[i % shuffledProps.length];
      brokenCss = removeCssProperty(originalCss, removed);
      trialLabel = `${removed.selector} { ${removed.property} }`;
    }

    const trialDir = join(tmpDir, `trial-${seed}`);
    await mkdir(trialDir, { recursive: true });

    process.stdout.write(`  [${String(i + 1).padStart(3)}/${TRIALS}] seed=${seed} ${trialLabel} ... `);
    const brokenHtml = replaceCss(htmlRaw, originalCss, brokenCss);
    const classified = classifyDeclaration(removed.selector, removed.mediaCondition);
    const approvalContext = {
      selector: removed.selector,
      property: removed.property,
      category: categorizeProperty(removed.property),
    } as const;
    // In selector mode, track computed styles for ALL declarations in the block
    const removedDeclarations = MODE === "selector"
      ? (shuffledBlocks[i % shuffledBlocks.length]?.declarations ?? [removed])
      : [removed];
    const expectedComputedStyleTargets = removedDeclarations.flatMap(
      (d) => findExpectedComputedStyleTargets(d, customPropertyUsage),
    );
    const captureHover = classified.isInteractive ||
      expectedComputedStyleTargets.some((target) => isInteractiveSelector(target.selector));

    let analysisBundle: ViewportAnalysisBundle;
    let prescannerResolution: PrescannerTrialResolution | null = null;

    if (BACKEND === "prescanner") {
      const craterBundle = await analyzeAcrossViewports("crater", brokenHtml, trialDir, craterBaselines, {
        browser: null,
        craterClient,
        captureHover: false,
        trackedProperties,
        manifest: approvalManifest,
        approvalContext,
        expectedComputedStyleTargets,
        strict: STRICT,
      });

      if (hasCraterPrescanSignal(craterBundle.viewportResults)) {
        prescannerResolution = resolvePrescannerTrial(craterBundle.viewportResults, craterBundle.viewportResults);
        analysisBundle = craterBundle;
      } else {
        const chromiumResources = await ensureChromiumResources();
        const chromiumBundle = await analyzeAcrossViewports("chromium", brokenHtml, trialDir, chromiumResources.baselines, {
          browser: chromiumResources.browser,
          craterClient: null,
          captureHover,
          trackedProperties,
          manifest: approvalManifest,
          approvalContext,
          expectedComputedStyleTargets,
          strict: STRICT,
        });
        prescannerResolution = resolvePrescannerTrial(craterBundle.viewportResults, chromiumBundle.viewportResults);
        analysisBundle = chromiumBundle;
      }

      prescannerResolutions.push(prescannerResolution);
    } else {
      const activeBackend = BACKEND;
      const baselines = activeBackend === "crater" ? craterBaselines : (await ensureChromiumResources()).baselines;
      analysisBundle = await analyzeAcrossViewports(activeBackend, brokenHtml, trialDir, baselines, {
        browser,
        craterClient,
        captureHover,
        trackedProperties,
        manifest: approvalManifest,
        approvalContext,
        expectedComputedStyleTargets,
        strict: STRICT,
      });
    }

    const vpResults = analysisBundle.viewportResults;
    const primaryAnalysis = analysisBundle.primaryAnalysis;
    const anyVisual = analysisBundle.anyVisual;
    const anyA11y = analysisBundle.anyA11y;
    const anyComputed = analysisBundle.anyComputed;
    const anyHover = analysisBundle.anyHover;
    const anyPaintTree = analysisBundle.anyPaintTree;
    const maxDiffRatio = analysisBundle.maxDiffRatio;
    const maxDiffPixels = analysisBundle.maxDiffPixels;
    const totalA11yChanges = analysisBundle.totalA11yChanges;
    const detected = prescannerResolution?.finalDetected ?? analysisBundle.detected;

    const result: TrialResult = {
      seed,
      removed,
      visualDiffDetected: anyVisual,
      visualDiffRatio: maxDiffRatio,
      visualChangeTypes: primaryAnalysis?.visualSemantic?.changes.map((c) => c.type) ?? [],
      a11yDiffDetected: anyA11y,
      a11yChangeCount: totalA11yChanges,
      newA11yIssues: primaryAnalysis ? Math.max(0, primaryAnalysis.brokenIssueCount - primaryAnalysis.baselineIssueCount) : 0,
      llmAttempted: false,
      llmFixParsed: false,
      selectorMatch: false,
      propertyMatch: false,
      valueMatch: false,
      exactMatch: false,
      pixelPerfect: false,
      nearPerfect: false,
      fixedDiffRatio: -1,
      attempts: 0,
      llmMs: 0,
      fallbackUsed: prescannerResolution?.fallbackUsed ?? false,
      resolvedBy: prescannerResolution?.resolvedBy ?? (BACKEND === "chromium" ? "chromium" : "crater"),
    };

    // LLM fix attempt (desktop viewport)
    if (llm && primaryAnalysis) {
      result.llmAttempted = true;
      const prompt = buildFixPrompt(primaryAnalysis.fullReport, brokenCss);
      const llmStart = Date.now();
      try {
        const response = await llm.complete(prompt);
        result.llmMs = Date.now() - llmStart;
        const fix = parseLLMFix(response);
        result.attempts = 1;
        if (fix) {
          result.llmFixParsed = true;
          result.selectorMatch = fix.selector === removed.selector;
          result.propertyMatch = fix.property === removed.property;
          result.valueMatch = normalizeValue(fix.value) === normalizeValue(removed.value);
          result.exactMatch = result.selectorMatch && result.propertyMatch && result.valueMatch;

          const fixedCss = applyCssFix(brokenCss, fix);
          const fixedHtml = replaceCss(htmlRaw, originalCss, fixedCss);
          const fixedPath = join(trialDir, "fixed.png");
          const chromiumResources = await ensureChromiumResources();
          const desktopVp = VIEWPORTS[0];
          await capturePageState(chromiumResources.browser, desktopVp, fixedHtml, fixedPath, {
            trackedProperties,
          });
          const { compareScreenshots } = await import("./heatmap.ts");
          const fixedDiff = await compareScreenshots({
            testId: "page", testTitle: "page", projectName: "css-challenge",
            screenshotPath: fixedPath,
            baselinePath: chromiumResources.baselines.get("desktop")!.screenshotPath,
            status: "changed",
          }, { outputDir: trialDir });
          result.fixedDiffRatio = fixedDiff?.diffRatio ?? 0;
          result.pixelPerfect = result.fixedDiffRatio === 0;
          result.nearPerfect = result.fixedDiffRatio < 0.01;
        }
      } catch {
        result.llmMs = Date.now() - llmStart;
      }
    }

    results.push(result);

    if (SUGGEST_APPROVAL && primaryAnalysis) {
      approvalSuggestions.push(suggestApprovalRule({
        selector: removed.selector,
        property: removed.property,
        category: approvalContext.category,
        maxDiffPixels,
        maxDiffRatio,
        paintTreeChanges: primaryAnalysis.paintTreeChanges,
      }));
    }

    // Build detection record
    const undetectedReason = detected
      ? null
      : classifyUndetectedReason(removed.selector, removed.property, removed.value, removed.mediaCondition, vpResults);

    dbRecords.push({
      runId,
      fixture,
      backend: BACKEND,
      fallbackUsed: result.fallbackUsed,
      backendResolvedBy: result.resolvedBy,
      selector: removed.selector,
      property: removed.property,
      value: removed.value,
      category: categorizeProperty(removed.property),
      selectorType: classified.selectorType,
      isInteractive: classified.isInteractive,
      mediaCondition: removed.mediaCondition,
      viewports: vpResults,
      detected,
      undetectedReason,
    });

    // Status line
    const status: string[] = [];
    if (prescannerResolution) {
      if (prescannerResolution.resolvedBy === "crater") status.push(`${CYAN}prescan${RESET}`);
      else if (prescannerResolution.resolvedBy === "chromium") status.push(`${YELLOW}fallback${RESET}`);
      else status.push(`${YELLOW}fallback-pass${RESET}`);
    }
    for (const vr of vpResults) {
      const label = vr.width >= 1440 ? "W" : vr.width > 500 ? "D" : "M";
      if (vr.visualDiffDetected) status.push(`${label}:${(vr.visualDiffRatio * 100).toFixed(0)}%`);
      else status.push(`${label}:-`);
    }
    if (result.a11yDiffDetected) status.push(`a11y:${result.a11yChangeCount}`);
    if (anyComputed && !anyVisual) status.push(`${CYAN}css-diff${RESET}`);
    if (anyHover && !anyVisual) status.push(`${CYAN}hover${RESET}`);
    if (anyPaintTree && !anyVisual) status.push(`${CYAN}paint-tree${RESET}`);
    if (primaryAnalysis && (primaryAnalysis.approvedVisualRules.length > 0 || primaryAnalysis.approvedPaintTreeMatches.length > 0)) {
      status.push(`${CYAN}approved${RESET}`);
    }
    if (!detected) status.push(`${RED}silent${RESET}${undetectedReason ? `(${undetectedReason})` : ""}`);
    if (result.llmAttempted) {
      if (result.exactMatch) status.push(`${GREEN}exact${RESET}`);
      else if (result.pixelPerfect) status.push(`${GREEN}pixel-ok${RESET}`);
      else if (result.selectorMatch) status.push(`${YELLOW}partial${RESET}`);
      else status.push(`${RED}miss${RESET}`);
    }
    console.log(status.join(" | "));

    await rm(trialDir, { recursive: true, force: true }).catch(() => {});
  }

  if (craterClient) {
    await craterClient.close();
  }
  if (browser) {
    await browser.close();
  }
  const elapsedMs = Date.now() - startTime;
  const elapsed = (elapsedMs / 1000).toFixed(1);

  // ============================================================
  // Report
  // ============================================================
  console.log();
  hr();
  console.log();
  console.log(`  ${BOLD}${CYAN}Benchmark Results${RESET}  ${DIM}(${TRIALS} trials, ${elapsed}s, ${VIEWPORTS.length} viewports)${RESET}`);
  console.log();

  // Detection metrics
  const visualDetected = results.filter((r) => r.visualDiffDetected).length;
  const a11yDetected = results.filter((r) => r.a11yDiffDetected).length;
  const eitherDetected = dbRecords.filter((r) => r.detected).length;
  const neitherDetected = dbRecords.filter((r) => !r.detected).length;

  const computedDetected = dbRecords.filter((r) => r.viewports.some((v) => v.computedStyleDiffCount > 0)).length;
  const hoverDetected = dbRecords.filter((r) => r.viewports.some((v) => v.hoverDiffDetected)).length;
  const paintTreeDetected = dbRecords.filter((r) => r.viewports.some((v) => v.paintTreeDiffCount > 0)).length;
  const prescannerSummary = BACKEND === "prescanner"
    ? summarizePrescannerTrials(prescannerResolutions)
    : null;

  console.log(`  ${BOLD}Detection${RESET}`);
  console.log(`    Visual diff:           ${fmtRate(visualDetected, TRIALS)}`);
  console.log(`    Computed style diff:   ${fmtRate(computedDetected, TRIALS)}`);
  console.log(`    Hover diff:            ${fmtRate(hoverDetected, TRIALS)}`);
  if (paintTreeDetected > 0 || BACKEND === "crater" || BACKEND === "prescanner") {
    console.log(`    Paint tree diff:       ${fmtRate(paintTreeDetected, TRIALS)}`);
  }
  console.log(`    A11y diff:             ${fmtRate(a11yDetected, TRIALS)}`);
  console.log(`    ${BOLD}Any signal:${RESET}            ${fmtRate(eitherDetected, TRIALS)}`);
  console.log(`    Undetected (silent):   ${fmtRate(neitherDetected, TRIALS, true)}`);
  if (prescannerSummary) {
    console.log();
    console.log(`  ${BOLD}Prescanner${RESET}`);
    console.log(`    Resolved by crater:    ${fmtRate(prescannerSummary.craterResolved, prescannerSummary.total)}`);
    console.log(`    Chromium fallback:     ${fmtRate(prescannerSummary.chromiumFallbacks, prescannerSummary.total, true)}`);
    console.log(`    Fallback detected:     ${fmtRate(prescannerSummary.chromiumDetected, prescannerSummary.total)}`);
    console.log(`    Fallback pass:         ${fmtRate(prescannerSummary.passedAfterFallback, prescannerSummary.total, true)}`);
  }

  // Scoped rate (excluding animation)
  const scoped = dbRecords.filter((r) => !isOutOfScope(r.property));
  const scopedDetected = scoped.filter((r) => r.detected).length;
  const scopedUndetected = scoped.filter((r) => !r.detected).length;
  if (scoped.length < dbRecords.length) {
    const outOfScope = dbRecords.length - scoped.length;
    console.log(`    ${DIM}(excl. animation: ${fmtRate(scopedDetected, scoped.length)} | ${outOfScope} animation skipped)${RESET}`);
  }
  console.log();

  // Viewport comparison
  console.log(`  ${BOLD}Detection by Viewport${RESET}`);
  for (const vp of VIEWPORTS) {
    const vpIdx = VIEWPORTS.indexOf(vp);
    const vpDetected = dbRecords.filter((r) => r.viewports[vpIdx]?.visualDiffDetected || r.viewports[vpIdx]?.a11yDiffDetected).length;
    console.log(`    ${vp.label.padEnd(10)} ${fmtRate(vpDetected, TRIALS)}`);
  }
  const multiOnly = dbRecords.filter((r) => {
    const desktopVp = r.viewports.find((v) => v.width > 1000);
    const mobileVp = r.viewports.find((v) => v.width <= 500);
    const desktopDetected = desktopVp ? (desktopVp.visualDiffDetected || desktopVp.a11yDiffDetected) : false;
    const mobileDetected = mobileVp ? (mobileVp.visualDiffDetected || mobileVp.a11yDiffDetected) : false;
    return r.detected && (!desktopDetected || !mobileDetected);
  }).length;
  console.log(`    ${DIM}multi-viewport bonus: ${multiOnly} additional detection(s)${RESET}`);
  console.log();

  // By category
  const categories = new Map<string, typeof dbRecords>();
  for (const r of dbRecords) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category)!.push(r);
  }
  console.log(`  ${BOLD}Detection by Property Category${RESET}`);
  console.log(`    ${"Category".padEnd(14)} ${"Count".padStart(5)}  ${"Detect".padStart(8)}  ${"Silent".padStart(8)}`);
  for (const [cat, recs] of [...categories.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const det = recs.filter((r) => r.detected).length;
    const silent = recs.filter((r) => !r.detected).length;
    console.log(`    ${cat.padEnd(14)} ${String(recs.length).padStart(5)}  ${fmtRateCompact(det, recs.length).padStart(8)}  ${fmtRateCompact(silent, recs.length, true).padStart(8)}`);
  }
  console.log();

  // Undetected reasons
  const reasonCounts = new Map<string, number>();
  for (const r of dbRecords) {
    if (!r.detected && r.undetectedReason) {
      reasonCounts.set(r.undetectedReason, (reasonCounts.get(r.undetectedReason) ?? 0) + 1);
    }
  }
  if (reasonCounts.size > 0) {
    console.log(`  ${BOLD}${YELLOW}Undetected Reasons${RESET}`);
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      const examples = dbRecords.filter((r) => r.undetectedReason === reason).slice(0, 2);
      console.log(`    ${reason.padEnd(20)} ${String(count).padStart(3)}  ${DIM}${examples.map((e) => `${e.selector}{${e.property}}`).join(", ")}${RESET}`);
    }
    console.log();
  }

  // LLM recovery
  if (llm) {
    const attempted = results.filter((r) => r.llmAttempted);
    const exact = attempted.filter((r) => r.exactMatch);
    const pixelOk = attempted.filter((r) => r.pixelPerfect);
    const nearOk = attempted.filter((r) => r.nearPerfect);
    console.log(`  ${BOLD}LLM Recovery${RESET}`);
    console.log(`    Exact match:         ${fmtRate(exact.length, attempted.length)}`);
    console.log(`    Pixel-perfect fix:   ${fmtRate(pixelOk.length, attempted.length)}`);
    console.log(`    Near-perfect (<1%):  ${fmtRate(nearOk.length, attempted.length)}`);
    console.log();
  }

  // Persist to DB
  if (SAVE_DB) {
    await appendRecords(dbRecords);
    await appendBenchHistory([
      buildBenchHistoryRecord({
        runId,
        fixture,
        backend: BACKEND,
        trials: TRIALS,
        startSeed: START_SEED,
        elapsedMs,
        llmEnabled: !!llm,
        approvalPath: APPROVAL_PATH || undefined,
        strict: STRICT,
        suggestApproval: SUGGEST_APPROVAL,
        visualDetected,
        computedDetected,
        hoverDetected,
        paintTreeDetected,
        a11yDetected,
        eitherDetected,
        neitherDetected,
        prescanner: prescannerSummary,
      }),
    ]);
    console.log(`  ${DIM}DB: ${dbRecords.length} records appended${RESET}`);
    console.log(`  ${DIM}Bench history: appended${RESET}`);
  }

  if (SUGGEST_APPROVAL) {
    const suggestionPath = getCssBenchApprovalSuggestionsPath(fixture, OUTPUT_ROOT);
    await writeFile(suggestionPath, JSON.stringify({ rules: approvalSuggestions }, null, 2));
    console.log(`  ${DIM}Approval suggestions: ${suggestionPath}${RESET}`);
  }

  // JSON report
  const reportPath = join(tmpDir, "bench-report.json");
  const report = {
    meta: {
      fixture,
      trials: TRIALS,
      startSeed: START_SEED,
      elapsed,
      viewports: VIEWPORTS,
      llmEnabled: !!llm,
      totalDeclarations: declarations.length,
      approvalPath: APPROVAL_PATH || undefined,
      strict: STRICT,
      suggestApproval: SUGGEST_APPROVAL,
      approvalWarnings,
      prescanner: prescannerSummary,
    },
    detection: { visualDetected, a11yDetected, eitherDetected, neitherDetected, rate: eitherDetected / TRIALS },
    trials: dbRecords,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`  ${DIM}Report: ${reportPath}${RESET}`);
  console.log();
}

async function main() {
  const availableFixtures = await listCssChallengeFixtureNames();
  const fixtures = normalizeCssChallengeFixtureSelection(FIXTURE_ARGS, availableFixtures);

  for (const fixture of fixtures) {
    await runFixtureBenchmark(fixture);
  }
}

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  const rand = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function fmtRate(count: number, total: number, inverse = false): string {
  const pct = ((count / total) * 100).toFixed(1);
  const color = inverse
    ? (count === 0 ? GREEN : count <= total * 0.1 ? YELLOW : RED)
    : (count === total ? GREEN : count >= total * 0.9 ? YELLOW : count >= total * 0.5 ? YELLOW : RED);
  return `${color}${count}/${total}${RESET} ${DIM}(${pct}%)${RESET}`;
}

function fmtRateCompact(count: number, total: number, inverse = false): string {
  const pct = ((count / total) * 100).toFixed(0);
  const color = inverse
    ? (count === 0 ? GREEN : RED)
    : (count === total ? GREEN : count >= total * 0.5 ? YELLOW : RED);
  return `${color}${pct}%${RESET}`;
}

if (import.meta.main) {
  main().catch((error) => {
    if (isPlaywrightSandboxRestrictionError(error)) {
      console.error(formatPlaywrightLaunchError(error, { commandHint: "in your local terminal or in CI" }));
    } else {
      console.error(error);
    }
    process.exit(1);
  });
}
