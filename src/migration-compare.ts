#!/usr/bin/env node
/**
 * Migration VRT Compare
 *
 * 2つの HTML ファイルを複数 viewport でレンダリングし、pixel diff を取得する。
 * Reset CSS 切り替え、Tailwind → vanilla CSS 等の移行検証用。
 *
 * Usage:
 *   npx tsx src/migration-compare.ts before.html after.html
 *   npx tsx src/migration-compare.ts --dir fixtures/migration/reset-css --baseline normalize.html --variants modern-normalize.html destyle.html no-reset.html
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import {
  collectApprovalWarnings,
  filterApprovedPaintTreeChanges,
  filterApprovedVrtRegions,
  loadApprovalManifest,
} from "./approval.ts";
import {
  CraterClient,
  DEFAULT_BIDI_URL,
  diffPaintTrees,
  isCraterAvailable,
  type CraterBreakpointDiscoveryDiagnostics,
  type PaintNode,
  type PaintTreeChange,
} from "./crater-client.ts";
import { compareScreenshots } from "./heatmap.ts";
import {
  buildMigrationRegionApprovalContexts,
  classifyMigrationDiff,
  type MigrationDiffCategory,
} from "./migration-diff.ts";
import {
  capturePaintTreeForViewport,
  summarizeMigrationPaintTreeChanges,
} from "./migration-paint-tree.ts";
import {
  buildMigrationViewportFixCandidatesFromHtml,
  summarizeMigrationFixCandidates,
  type MigrationFixCandidate,
  type MigrationFixCandidateSummary,
} from "./migration-fix-candidates.ts";
import { summarizeMigrationReportConvergence, type MigrationConvergenceStatus } from "./migration-fix-loop-core.ts";
import {
  extractResponsiveBreakpointsFromHtml,
  generateViewports,
  mergeResponsiveBreakpoints,
  type ResponsiveBreakpoint,
  type ViewportSpec,
} from "./viewport-discovery.ts";
import type { VrtSnapshot } from "./types.ts";

// ---- Config ----

function getArg(args: string[], name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function getArgList(args: string[], name: string): string[] {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return [];
  const values: string[] = [];
  for (let i = idx + 1; i < args.length && !args[i].startsWith("--"); i++) {
    values.push(args[i]);
  }
  return values;
}
function hasFlag(args: string[], name: string): boolean { return args.includes(`--${name}`); }

export type BreakpointDiscoveryBackend = "auto" | "regex" | "crater";

function parseDiscoveryBackend(args: string[]): BreakpointDiscoveryBackend {
  const value = getArg(args, "discover-backend", "auto");
  if (value === "auto" || value === "regex" || value === "crater") {
    return value;
  }
  throw new Error(`invalid --discover-backend: ${value}`);
}

export interface MigrationCompareOptions {
  dir: string;
  baseline: string;
  variants: string[];
  outputDir: string;
  fixedViewports?: ViewportSpec[];
  autoDiscover: boolean;
  discoverBackend: BreakpointDiscoveryBackend;
  maxViewports: number;
  randomSamples: number;
  approvalPath: string;
  strict: boolean;
  paintTreeUrl: string;
  enablePaintTree: boolean;
}

export function parseMigrationCompareArgs(args: string[]): MigrationCompareOptions {
  const variants = getArgList(args, "variants");
  return {
    dir: getArg(args, "dir", "."),
    baseline: getArg(args, "baseline", args[0] ?? ""),
    variants: variants.length > 0 ? variants : (args[1] ? [args[1]] : []),
    outputDir: resolve(getArg(args, "output-dir", join(process.cwd(), "test-results", "migration"))),
    autoDiscover: !hasFlag(args, "no-discover"),
    discoverBackend: parseDiscoveryBackend(args),
    maxViewports: parseInt(getArg(args, "max-viewports", "15"), 10),
    randomSamples: parseInt(getArg(args, "random-samples", "1"), 10),
    approvalPath: getArg(args, "approval", ""),
    strict: hasFlag(args, "strict"),
    paintTreeUrl: getArg(args, "paint-tree-url", DEFAULT_BIDI_URL),
    enablePaintTree: !hasFlag(args, "no-paint-tree"),
  };
}

// Fallback viewports (used when --no-discover)
const STATIC_VIEWPORTS: ViewportSpec[] = [
  { width: 1440, height: 900, label: "wide", reason: "standard" },
  { width: 1280, height: 900, label: "desktop", reason: "standard" },
  { width: 375, height: 812, label: "mobile", reason: "standard" },
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

type PaintTreeChangeType = PaintTreeChange["type"];

interface PaintTreeStatus {
  enabled: boolean;
  available: boolean;
  url?: string;
  error?: string;
}

interface BreakpointDiscoveryStatus {
  requestedBackend: BreakpointDiscoveryBackend;
  backendUsed: "regex" | "crater";
  fallbackReason?: string;
  breakpoints: ResponsiveBreakpoint[];
  diagnostics?: BreakpointDiscoveryDiagnosticsSummary;
}

export interface BreakpointDiscoveryDocumentInput {
  label: string;
  html: string;
}

export interface BreakpointDiscoveryDocumentDiagnostics extends CraterBreakpointDiscoveryDiagnostics {
  label: string;
}

export interface BreakpointDiscoveryDiagnosticsSummary {
  documents: BreakpointDiscoveryDocumentDiagnostics[];
  totals: CraterBreakpointDiscoveryDiagnostics;
}

export interface BreakpointDiscoveryClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  setContent(html: string): Promise<void>;
  getResponsiveBreakpoints(options?: {
    mode?: "live-inline" | "html-inline";
    axis?: "width";
    includeDiagnostics?: boolean;
  }): Promise<{
    breakpoints: ResponsiveBreakpoint[];
    diagnostics?: CraterBreakpointDiscoveryDiagnostics;
  }>;
}

export interface MigrationCompareResult {
  variant: string;
  variantFile: string;
  viewport: string;
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  rawDiffRatio: number;
  rawDiffPixels: number;
  rawDominantCategory: MigrationDiffCategory | "none";
  rawCategorySummary: string;
  rawCategoryCounts: Record<MigrationDiffCategory, number>;
  approved: boolean;
  partiallyApproved: boolean;
  approvedPixels: number;
  approvalReasons: string[];
  dominantCategory: MigrationDiffCategory | "none";
  categorySummary: string;
  categoryCounts: Record<MigrationDiffCategory, number>;
  rawPaintTreeChangeCount: number;
  rawPaintTreeSummary: string;
  rawPaintTreeCounts: Record<PaintTreeChangeType, number>;
  paintTreeChangeCount: number;
  paintTreeSummary: string;
  paintTreeCounts: Record<PaintTreeChangeType, number>;
  approvedPaintTreeCount: number;
  approvedPaintTreeReasons: string[];
  fixCandidates: MigrationFixCandidate[];
}

export interface MigrationCompareReport {
  dir: string;
  baseline: string;
  variants: string[];
  viewports: ViewportSpec[];
  breakpointDiscovery?: BreakpointDiscoveryStatus;
  approvalPath?: string;
  strict: boolean;
  approvalWarnings: Awaited<ReturnType<typeof collectApprovalWarnings>>;
  paintTree: PaintTreeStatus;
  results: MigrationCompareResult[];
  reportPath: string;
}

// ---- Main ----

async function main(cliArgs = process.argv.slice(2)) {
  const options = parseMigrationCompareArgs(cliArgs);
  if (!options.baseline || options.variants.length === 0) {
    console.log(`Usage: npx tsx src/migration-compare.ts --dir <dir> --baseline <file> --variants <file1> <file2> ... [--output-dir path] [--approval approval.json] [--strict] [--discover-backend auto|regex|crater] [--no-paint-tree] [--paint-tree-url ws://127.0.0.1:9222]`);
    console.log(`   or: npx tsx src/migration-compare.ts <before.html> <after.html>`);
    process.exit(1);
  }
  await runMigrationCompare(options);
}

export async function runMigrationCompare(options: MigrationCompareOptions): Promise<MigrationCompareReport> {
  const {
    dir,
    baseline,
    variants,
    outputDir,
    autoDiscover,
    discoverBackend,
    maxViewports,
    randomSamples,
    approvalPath,
    strict,
    paintTreeUrl,
    enablePaintTree,
  } = options;

  await mkdir(outputDir, { recursive: true });

  const baselinePath = resolve(dir, baseline);
  const baselineHtml = await readFile(baselinePath, "utf-8");
  const baselineName = basename(baseline, ".html");
  const resolvedApprovalPath = await resolveApprovalPath(dir, approvalPath);
  const approvalManifest = resolvedApprovalPath ? await loadApprovalManifest(resolvedApprovalPath) : null;
  const approvalWarnings = approvalManifest ? collectApprovalWarnings(approvalManifest) : [];
  const baselinePaintTrees = new Map<string, PaintNode>();
  const paintTreeStatus: PaintTreeStatus = {
    enabled: enablePaintTree,
    available: false,
    url: enablePaintTree ? paintTreeUrl : undefined,
  };
  let breakpointDiscoveryStatus: BreakpointDiscoveryStatus | undefined;

  // Auto-discover breakpoints from all HTML files
  let VIEWPORTS: ViewportSpec[];
  if (options.fixedViewports && options.fixedViewports.length > 0) {
    VIEWPORTS = options.fixedViewports;
  } else if (autoDiscover) {
    const allHtmls: BreakpointDiscoveryDocumentInput[] = [
      { label: "baseline", html: baselineHtml },
    ];
    for (const v of variants) {
      allHtmls.push({
        label: `variant:${v}`,
        html: await readFile(resolve(dir, v), "utf-8"),
      });
    }
    breakpointDiscoveryStatus = await discoverResponsiveBreakpointsForHtmlDocuments(
      allHtmls,
      discoverBackend,
      paintTreeUrl,
    );
    VIEWPORTS = generateViewports(breakpointDiscoveryStatus.breakpoints, {
      maxViewports,
      randomSamples,
    });

    console.log();
    console.log(`  ${DIM}Breakpoint discovery: ${breakpointDiscoveryStatus.backendUsed}${RESET}`);
    if (breakpointDiscoveryStatus.fallbackReason) {
      console.log(`  ${YELLOW}! ${breakpointDiscoveryStatus.fallbackReason}${RESET}`);
    }
    if (breakpointDiscoveryStatus.breakpoints.length > 0) {
      console.log();
      console.log(`  ${DIM}Discovered breakpoints: ${breakpointDiscoveryStatus.breakpoints.map(formatResponsiveBreakpoint).join(", ")}${RESET}`);
    }
  } else {
    VIEWPORTS = STATIC_VIEWPORTS;
  }

  console.log();
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║  Migration VRT Compare                                                  ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  ${DIM}Baseline: ${baseline}${RESET}`);
  console.log(`  ${DIM}Variants: ${variants.join(", ")}${RESET}`);
  console.log(`  ${DIM}Viewports (${VIEWPORTS.length}): ${VIEWPORTS.map((v) => `${v.label}(${v.width})`).join(", ")}${RESET}`);
  if (resolvedApprovalPath) {
    console.log(`  ${DIM}Approval: ${resolvedApprovalPath}${strict ? " (strict mode: ignored)" : ""}${RESET}`);
    for (const warning of approvalWarnings) {
      console.log(`  ${YELLOW}! ${warning.message}${RESET}`);
    }
  }
  if (!enablePaintTree) {
    console.log(`  ${DIM}Paint tree: disabled${RESET}`);
  } else if (paintTreeStatus.error) {
    console.log(`  ${YELLOW}Paint tree: unavailable (${paintTreeStatus.error})${RESET}`);
  }
  console.log();
  let browser: Browser | null = null;
  let paintTreeClient: CraterClient | null = null;
  const disablePaintTree = async (message: string) => {
    paintTreeStatus.available = false;
    paintTreeStatus.error = message;
    baselinePaintTrees.clear();
    if (paintTreeClient) {
      await paintTreeClient.close();
      paintTreeClient = null;
    }
  };

  try {
    browser = await chromium.launch();
    const baselineScreenshots = new Map<string, string>();

    if (enablePaintTree) {
      const available = await isCraterAvailable(paintTreeUrl);
      if (!available) {
        paintTreeStatus.error = `Crater BiDi unavailable at ${paintTreeUrl}`;
      } else {
        try {
          paintTreeClient = new CraterClient(paintTreeUrl);
          await paintTreeClient.connect();
          paintTreeStatus.available = true;
        } catch (error) {
          paintTreeStatus.error = `Failed to connect to Crater BiDi: ${String(error)}`;
          paintTreeClient = null;
        }
      }
    }

    if (paintTreeStatus.available) {
      console.log(`  ${DIM}Paint tree: enabled via ${paintTreeUrl}${RESET}`);
      console.log();
    } else if (enablePaintTree && paintTreeStatus.error) {
      console.log(`  ${YELLOW}Paint tree: unavailable (${paintTreeStatus.error})${RESET}`);
      console.log();
    }

    // Capture baseline at all viewports
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.setContent(baselineHtml, { waitUntil: "networkidle" });
      const path = join(outputDir, `${baselineName}-${vp.label}.png`);
      await page.screenshot({ path, fullPage: true });
      baselineScreenshots.set(vp.label, path);
      await page.close();

      if (paintTreeClient) {
        try {
          baselinePaintTrees.set(
            vp.label,
            await capturePaintTreeForViewport(
              paintTreeClient,
              { width: vp.width, height: vp.height },
              baselineHtml,
            ),
          );
        } catch (error) {
          await disablePaintTree(`Failed to capture baseline paint tree at ${vp.label}: ${String(error)}`);
        }
      }
    }

    // Compare each variant
    const results: Array<{
      variant: string;
      variantFile: string;
      viewport: string;
      diffRatio: number;
      diffPixels: number;
      totalPixels: number;
      rawDiffRatio: number;
      rawDiffPixels: number;
      rawDominantCategory: MigrationDiffCategory | "none";
      rawCategorySummary: string;
      rawCategoryCounts: Record<MigrationDiffCategory, number>;
      approved: boolean;
      partiallyApproved: boolean;
      approvedPixels: number;
      approvalReasons: string[];
      dominantCategory: MigrationDiffCategory | "none";
      categorySummary: string;
      categoryCounts: Record<MigrationDiffCategory, number>;
      rawPaintTreeChangeCount: number;
      rawPaintTreeSummary: string;
      rawPaintTreeCounts: Record<PaintTreeChangeType, number>;
      paintTreeChangeCount: number;
      paintTreeSummary: string;
      paintTreeCounts: Record<PaintTreeChangeType, number>;
      approvedPaintTreeCount: number;
      approvedPaintTreeReasons: string[];
      fixCandidates: MigrationFixCandidate[];
    }> = [];

    for (const variantFile of variants) {
      const variantPath = resolve(dir, variantFile);
      const variantHtml = await readFile(variantPath, "utf-8");
      const variantName = basename(variantFile, ".html");

      console.log(`  ${BOLD}${variantName}${RESET} vs ${baselineName}`);

      for (const vp of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.setContent(variantHtml, { waitUntil: "networkidle" });
        const variantScreenshotPath = join(outputDir, `${variantName}-${vp.label}.png`);
        await page.screenshot({ path: variantScreenshotPath, fullPage: true });
        await page.close();

        const snap: VrtSnapshot = {
          testId: `${variantName}-${vp.label}`,
          testTitle: `${variantName} ${vp.label}`,
          projectName: "migration",
          screenshotPath: variantScreenshotPath,
          baselinePath: baselineScreenshots.get(vp.label)!,
          status: "changed",
        };
        const diff = await compareScreenshots(snap, { outputDir });
        const rawDiffRatio = diff?.diffRatio ?? 0;
        const rawDiffPixels = diff?.diffPixels ?? 0;
        const rawClassification = classifyMigrationDiff(diff);
        const approved = diff && approvalManifest
          ? filterApprovedVrtRegions(
            diff,
            approvalManifest,
            buildMigrationRegionApprovalContexts(diff),
            { strict },
          )
          : null;
        const finalDiff = approved?.diff ?? diff;
        const diffRatio = finalDiff?.diffRatio ?? 0;
        const diffPixels = finalDiff?.diffPixels ?? 0;
        const totalPixels = finalDiff?.totalPixels ?? 0;
        const classification = classifyMigrationDiff(finalDiff);
        const approvedPixels = rawDiffPixels - diffPixels;
        const approvalReasons = approved?.matchedRules.map((rule) => rule.reason) ?? [];
        const partiallyApproved = !approved?.approved && approvedPixels > 0;

        let rawPaintTreeChanges: PaintTreeChange[] = [];
        let filteredPaintTreeChanges: PaintTreeChange[] = [];
        let approvedPaintTreeCount = 0;
        let approvedPaintTreeReasons: string[] = [];
        if (paintTreeClient && baselinePaintTrees.has(vp.label)) {
          try {
            const variantPaintTree = await capturePaintTreeForViewport(
              paintTreeClient,
              { width: vp.width, height: vp.height },
              variantHtml,
            );
            rawPaintTreeChanges = diffPaintTrees(
              baselinePaintTrees.get(vp.label)!,
              variantPaintTree,
            );
            const approvedPaintTree = approvalManifest
              ? filterApprovedPaintTreeChanges(rawPaintTreeChanges, approvalManifest, {}, { strict })
              : null;
            filteredPaintTreeChanges = approvedPaintTree?.remainingChanges ?? rawPaintTreeChanges;
            approvedPaintTreeCount = approvedPaintTree?.approvedChanges.length ?? 0;
            approvedPaintTreeReasons = [...new Set(
              approvedPaintTree?.matches.map((match) => match.rule.reason) ?? [],
            )];
          } catch (error) {
            await disablePaintTree(`Failed to capture paint tree at ${vp.label}: ${String(error)}`);
          }
        }
        const rawPaintTreeSummary = summarizeMigrationPaintTreeChanges(rawPaintTreeChanges);
        const finalPaintTreeSummary = summarizeMigrationPaintTreeChanges(filteredPaintTreeChanges);
        const fixCandidates = diffRatio > 0
          ? buildMigrationViewportFixCandidatesFromHtml(variantHtml, {
            viewportWidth: vp.width,
            dominantCategory: classification.dominantCategory,
            categorySummary: classification.summary,
            paintTreeChanges: filteredPaintTreeChanges,
          })
          : [];

        results.push({
          variant: variantName,
          variantFile,
          viewport: vp.label,
          diffRatio,
          diffPixels,
          totalPixels,
          rawDiffRatio,
          rawDiffPixels,
          rawDominantCategory: rawClassification.dominantCategory,
          rawCategorySummary: rawClassification.summary,
          rawCategoryCounts: rawClassification.counts,
          approved: approved?.approved ?? false,
          partiallyApproved,
          approvedPixels,
          approvalReasons,
          dominantCategory: classification.dominantCategory,
          categorySummary: classification.summary,
          categoryCounts: classification.counts,
          rawPaintTreeChangeCount: rawPaintTreeSummary.totalChanges,
          rawPaintTreeSummary: rawPaintTreeSummary.summary,
          rawPaintTreeCounts: rawPaintTreeSummary.counts,
          paintTreeChangeCount: finalPaintTreeSummary.totalChanges,
          paintTreeSummary: finalPaintTreeSummary.summary,
          paintTreeCounts: finalPaintTreeSummary.counts,
          approvedPaintTreeCount,
          approvedPaintTreeReasons,
          fixCandidates,
        });

        const pct = (diffRatio * 100).toFixed(1);
        const icon = approved?.approved
          ? `${CYAN}=${RESET}`
          : diffRatio === 0
            ? `${GREEN}✓${RESET}`
            : diffRatio < 0.01
              ? `${YELLOW}~${RESET}`
              : `${RED}✗${RESET}`;
        process.stdout.write(`    ${icon} ${vp.label.padEnd(12)} ${pct}%`);
        if (approved?.approved) {
          process.stdout.write(` ${DIM}(approved from ${(rawDiffRatio * 100).toFixed(1)}%, ${rawDiffPixels} px)${RESET}`);
        } else if (partiallyApproved) {
          process.stdout.write(` ${DIM}(approved ${approvedPixels} px, ${diffPixels} px remain)${RESET}`);
        } else if (diffRatio > 0) {
          process.stdout.write(` ${DIM}(${diffPixels} px)${RESET}`);
        }
        if (approved?.approved && rawClassification.summary !== "no changes") {
          process.stdout.write(` ${DIM}[${rawClassification.summary}]${RESET}`);
        } else if (diffRatio > 0 && classification.summary !== "no changes") {
          process.stdout.write(` ${DIM}[${classification.summary}]${RESET}`);
        }
        if (rawPaintTreeSummary.totalChanges > 0) {
          const paintTreeDisplay = approvedPaintTreeCount > 0 && finalPaintTreeSummary.totalChanges === 0
            ? `PT approved ${approvedPaintTreeCount}`
            : finalPaintTreeSummary.summary;
          process.stdout.write(` ${DIM}{${paintTreeDisplay}}${RESET}`);
        }
        if (fixCandidates.length > 0) {
          const topCandidate = fixCandidates[0];
          process.stdout.write(` ${DIM}<${topCandidate.selector} { ${topCandidate.property} }>${RESET}`);
        }
        console.log();
      }
      console.log();
    }

    // Summary table
    hr();
    console.log();
    console.log(`  ${BOLD}Summary${RESET}`);
    console.log();

    // Matrix: variant × viewport
    const vpLabels = VIEWPORTS.map((v) => v.label);
    const columnWidth = 13;
    const header = "  " + "Variant".padEnd(20) + vpLabels.map((l) => l.padStart(columnWidth)).join("");
    console.log(header);

    const variantNames = [...new Set(results.map((r) => r.variant))];
    for (const v of variantNames) {
      let line = "  " + v.padEnd(20);
      let allZero = true;
      for (const vp of vpLabels) {
        const r = results.find((r) => r.variant === v && r.viewport === vp);
        const pct = r ? (r.diffRatio * 100).toFixed(1) + "%" : "n/a";
        const color = !r ? DIM : r.approved ? CYAN : r.diffRatio === 0 ? GREEN : r.diffRatio < 0.01 ? YELLOW : RED;
        line += `${color}${pct.padStart(columnWidth)}${RESET}`;
        if (r && r.diffRatio > 0) allZero = false;
      }
      if (allZero) line += `  ${GREEN}PASS${RESET}`;
      console.log(line);
    }
    console.log();

    console.log(`  ${BOLD}Diff Categories${RESET}`);
    for (const variant of variantNames) {
      const variantResults = results.filter((result) => result.variant === variant);
      const aggregatedCounts = aggregateMigrationCategoryCounts(variantResults);
      const categorySummary = formatMigrationCategorySummary(aggregatedCounts);
      console.log(`    ${variant.padEnd(18)} ${categorySummary}`);
    }
    console.log();

    if (enablePaintTree) {
      console.log(`  ${BOLD}Paint Tree${RESET}`);
      if (!paintTreeStatus.available) {
        console.log(`    ${DIM}${paintTreeStatus.error ?? "unavailable"}${RESET}`);
      } else {
        for (const variant of variantNames) {
          const variantResults = results.filter((result) => result.variant === variant);
          const aggregatedCounts = aggregatePaintTreeCounts(variantResults);
          const paintTreeSummary = formatPaintTreeCountSummary(aggregatedCounts);
          console.log(`    ${variant.padEnd(18)} ${paintTreeSummary}`);
        }
      }
      console.log();
    }

    console.log(`  ${BOLD}Fix Candidates${RESET}`);
    for (const variant of variantNames) {
      const variantResults = results.filter((result) => result.variant === variant);
      const candidates = summarizeMigrationFixCandidates(variantResults.map((result) => result.fixCandidates));
      if (candidates.length === 0) {
        console.log(`    ${variant.padEnd(18)} no suggestions`);
        continue;
      }
      console.log(`    ${variant.padEnd(18)} ${formatMigrationFixCandidateSummary(candidates)}`);
    }
    console.log();

    // Save JSON report
    const reportPath = join(outputDir, "migration-report.json");
    const report: MigrationCompareReport = {
      dir,
      baseline,
      variants,
      viewports: VIEWPORTS,
      breakpointDiscovery: breakpointDiscoveryStatus,
      approvalPath: resolvedApprovalPath || undefined,
      strict,
      approvalWarnings,
      paintTree: paintTreeStatus,
      results,
      reportPath,
    };
    const convergence = summarizeMigrationReportConvergence(report);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`  ${BOLD}Convergence${RESET}`);
    for (const variant of convergence.variants) {
      console.log(`    ${variant.variant.padEnd(18)} ${formatMigrationConvergenceSummary(variant.status, variant)}`);
    }
    console.log();
    console.log(`  ${DIM}Report: ${reportPath}${RESET}`);
    console.log();
    return report;
  } finally {
    await browser?.close();
    await paintTreeClient?.close();
  }
}

function aggregateMigrationCategoryCounts(
  results: Array<{ categoryCounts: Record<MigrationDiffCategory, number> }>,
): Record<MigrationDiffCategory, number> {
  const counts = createMigrationCategoryCounts();
  for (const result of results) {
    counts["layout-shift"] += result.categoryCounts["layout-shift"];
    counts["color-change"] += result.categoryCounts["color-change"];
    counts.spacing += result.categoryCounts.spacing;
    counts.typography += result.categoryCounts.typography;
    counts.other += result.categoryCounts.other;
  }
  return counts;
}

function createMigrationCategoryCounts(): Record<MigrationDiffCategory, number> {
  return {
    "layout-shift": 0,
    "color-change": 0,
    spacing: 0,
    typography: 0,
    other: 0,
  };
}

function formatMigrationCategorySummary(
  counts: Record<MigrationDiffCategory, number>,
): string {
  const entries = (Object.entries(counts) as Array<[MigrationDiffCategory, number]>)
    .filter((entry) => entry[1] > 0)
    .map(([category, count]) => `${count} ${category}`);
  return entries.join(", ") || "no changes";
}

function aggregatePaintTreeCounts(
  results: Array<{ paintTreeCounts: Record<PaintTreeChangeType, number> }>,
): Record<PaintTreeChangeType, number> {
  const counts = createPaintTreeCounts();
  for (const result of results) {
    counts.geometry += result.paintTreeCounts.geometry;
    counts.paint += result.paintTreeCounts.paint;
    counts.text += result.paintTreeCounts.text;
    counts.added += result.paintTreeCounts.added;
    counts.removed += result.paintTreeCounts.removed;
  }
  return counts;
}

function createPaintTreeCounts(): Record<PaintTreeChangeType, number> {
  return {
    geometry: 0,
    paint: 0,
    text: 0,
    added: 0,
    removed: 0,
  };
}

function formatPaintTreeCountSummary(
  counts: Record<PaintTreeChangeType, number>,
): string {
  const entries = (Object.entries(counts) as Array<[PaintTreeChangeType, number]>)
    .filter((entry) => entry[1] > 0)
    .map(([type, count]) => `${count} ${type}`);
  return entries.join(", ") || "no changes";
}

function formatMigrationFixCandidateSummary(
  candidates: MigrationFixCandidateSummary[],
): string {
  return candidates
    .slice(0, 3)
    .map((candidate) => `${candidate.occurrences}x ${candidate.selector} { ${candidate.property} }`)
    .join(", ");
}

function formatMigrationConvergenceSummary(
  status: MigrationConvergenceStatus,
  summary: {
    totalResults: number;
    cleanResults: number;
    approvedResults: number;
    remainingResults: number;
  },
): string {
  if (status === "clean") {
    return `${GREEN}clean${RESET} (${summary.cleanResults}/${summary.totalResults})`;
  }
  if (status === "approved") {
    return `${CYAN}approved${RESET} (${summary.approvedResults} approved, ${summary.cleanResults} clean)`;
  }
  return `${YELLOW}remaining${RESET} (${summary.remainingResults}/${summary.totalResults} unresolved)`;
}

async function resolveApprovalPath(dir: string, explicitPath: string): Promise<string | null> {
  if (explicitPath) return explicitPath;
  const candidate = join(dir, "approval.json");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function summarizeBreakpointDiscoveryDiagnostics(
  documents: Array<{
    label: string;
    diagnostics: CraterBreakpointDiscoveryDiagnostics | undefined;
  }>,
): BreakpointDiscoveryDiagnosticsSummary | undefined {
  const entries: BreakpointDiscoveryDocumentDiagnostics[] = documents.flatMap(({ label, diagnostics }) => (
    diagnostics ? [{ label, ...diagnostics }] : []
  ));
  if (entries.length === 0) return undefined;

  return {
    documents: entries,
    totals: {
      stylesheetCount: entries.reduce((sum, entry) => sum + entry.stylesheetCount, 0),
      ruleCount: entries.reduce((sum, entry) => sum + entry.ruleCount, 0),
      externalStylesheetLinks: uniqueStrings(
        entries.flatMap((entry) => entry.externalStylesheetLinks),
      ),
      ignoredQueries: uniqueStrings(entries.flatMap((entry) => entry.ignoredQueries)),
      unsupportedQueries: uniqueStrings(
        entries.flatMap((entry) => entry.unsupportedQueries),
      ),
    },
  };
}

export async function discoverResponsiveBreakpointsForHtmlDocuments(
  htmlDocuments: BreakpointDiscoveryDocumentInput[],
  backend: BreakpointDiscoveryBackend,
  craterUrl: string,
  createClient: (url: string) => BreakpointDiscoveryClient = (url) => new CraterClient(url),
): Promise<BreakpointDiscoveryStatus> {
  const regexBreakpoints = mergeResponsiveBreakpoints(
    ...htmlDocuments.map(({ html }) => extractResponsiveBreakpointsFromHtml(html)),
  );

  if (backend === "regex") {
    return {
      requestedBackend: backend,
      backendUsed: "regex",
      breakpoints: regexBreakpoints,
    };
  }

  try {
    const client = createClient(craterUrl);
    await client.connect();
    try {
      const craterCollections: ResponsiveBreakpoint[][] = [];
      const diagnosticsEntries: Array<{
        label: string;
        diagnostics: CraterBreakpointDiscoveryDiagnostics | undefined;
      }> = [];
      for (const { label, html } of htmlDocuments) {
        await client.setContent(html);
        const result = await client.getResponsiveBreakpoints({
          mode: "live-inline",
          axis: "width",
          includeDiagnostics: true,
        });
        craterCollections.push(result.breakpoints);
        diagnosticsEntries.push({ label, diagnostics: result.diagnostics });
      }
      return {
        requestedBackend: backend,
        backendUsed: "crater",
        breakpoints: mergeResponsiveBreakpoints(...craterCollections),
        diagnostics: summarizeBreakpointDiscoveryDiagnostics(diagnosticsEntries),
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    if (backend === "crater") {
      throw new Error(`Crater breakpoint discovery failed: ${String(error)}`);
    }
    return {
      requestedBackend: backend,
      backendUsed: "regex",
      fallbackReason: `Crater breakpoint discovery unavailable, falling back to regex: ${String(error)}`,
      breakpoints: regexBreakpoints,
    };
  }
}

function formatResponsiveBreakpoint(breakpoint: ResponsiveBreakpoint): string {
  const opLabel = {
    ge: ">=",
    gt: ">",
    le: "<=",
    lt: "<",
  }[breakpoint.op];
  return `width${opLabel}${breakpoint.valuePx}px`;
}

const isCliEntry = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isCliEntry) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
