import { relative, resolve, sep } from "node:path";
import type { FlakerVrtMigrationScenario } from "./flaker-vrt-config.ts";
import type { MigrationCompareReport, MigrationCompareResult } from "./migration-compare.ts";
import type { FlakerTestCaseResult, FlakerTestId } from "./flaker-vrt-runner.ts";
import type { FlakerVrtViewport } from "./flaker-vrt-config.ts";

export type FlakerVrtBackend = "chromium" | "crater" | "prescanner";

export function buildFlakerVrtTestId(input: {
  suite: string;
  testName: string;
  taskId?: string | null;
  filter?: string | null;
  variant?: Record<string, string> | null;
}): string {
  const taskId = input.taskId ?? input.suite;
  const filter = input.filter ?? null;
  const variant = normalizeVariant(input.variant);
  return JSON.stringify({
    taskId,
    suite: input.suite,
    testName: input.testName,
    filter,
    variant,
  });
}

export function buildFlakerVariantMetadata(
  backend: FlakerVrtBackend,
  viewport: Pick<FlakerVrtViewport, "label" | "width" | "height">,
): Record<string, string> {
  return normalizeVariant({
    backend,
    viewport: viewport.label,
    width: String(viewport.width),
    height: String(viewport.height),
  }) ?? {};
}

export function inferFlakerScenarioIdFromReport(
  report: Pick<MigrationCompareReport, "dir">,
): string {
  if (!report.dir) {
    return "migration/unknown";
  }
  const normalized = normalizePath(report.dir);
  const segments = normalized.split("/").filter(Boolean);
  const index = segments.lastIndexOf("migration");
  if (index >= 0 && segments[index + 1]) {
    return `migration/${segments[index + 1]}`;
  }
  const basename = segments.at(-1) ?? "migration-report";
  return `migration/${basename}`;
}

export function convertMigrationReportToFlakerResults(input: {
  report: MigrationCompareReport;
  cwd: string;
  scenarioId: string;
  backend: FlakerVrtBackend;
  durationMs?: number;
}): FlakerTestCaseResult[] {
  const perTestDuration = input.report.results.length > 0
    ? Math.max(1, Math.round((input.durationMs ?? 0) / input.report.results.length))
    : 0;

  return input.report.results.map((result) =>
    convertMigrationResultToFlakerResult({
      cwd: input.cwd,
      report: input.report,
      result,
      scenarioId: input.scenarioId,
      backend: input.backend,
      durationMs: perTestDuration,
    })
  );
}

export function mapMigrationReportToRequestedFlakerResults(input: {
  requestedTests: FlakerTestId[];
  scenario: FlakerVrtMigrationScenario;
  report: MigrationCompareReport;
  durationMs: number;
  cwd: string;
}): FlakerTestCaseResult[] {
  const converted = convertMigrationReportToFlakerResults({
    report: input.report,
    cwd: input.cwd,
    scenarioId: input.scenario.id,
    backend: input.scenario.backend,
    durationMs: input.durationMs,
  });
  const resultMap = new Map(
    converted.map((entry) => [`${entry.suite}\0${entry.testName}`, entry] as const),
  );

  return input.requestedTests.map((test) =>
    resultMap.get(`${normalizePath(test.suite)}\0${test.testName}`)
      ?? createFlakyResult(
        test,
        `Missing migration result for ${test.suite} @ ${test.testName}`,
      )
  );
}

export function createFlakyResult(
  test: FlakerTestId,
  message: string,
): FlakerTestCaseResult {
  return {
    ...test,
    status: "flaky",
    durationMs: 0,
    retryCount: 0,
    errorMessage: message,
  };
}

export function resolveScenarioSuite(
  cwd: string,
  dir: string,
  variantFile: string,
): string {
  const resolved = resolve(cwd, dir, variantFile);
  const rel = relative(cwd, resolved);
  return normalizePath(rel);
}

export function extractViewportLabel(test: FlakerTestId): string {
  if (test.testName.startsWith("viewport:")) {
    return test.testName.slice("viewport:".length);
  }
  const label = test.variant?.viewport;
  if (!label) {
    throw new Error(`Test is missing viewport metadata: ${test.testName}`);
  }
  return label;
}

export function extractVariantFileFromSuite(
  cwd: string,
  scenario: Pick<FlakerVrtMigrationScenario, "dir" | "variants" | "id">,
  suite: string,
): string {
  const normalizedSuite = normalizePath(suite);
  const resolvedSuite = resolve(cwd, normalizedSuite);

  for (const variantFile of scenario.variants) {
    const expected = resolve(cwd, scenario.dir, variantFile);
    if (resolvedSuite === expected) {
      return variantFile;
    }
  }

  throw new Error(`Suite does not belong to scenario ${scenario.id}: ${suite}`);
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeVariant(
  variant?: Record<string, string> | null,
): Record<string, string> | null {
  if (!variant) return null;
  const entries = Object.entries(variant)
    .filter(([, value]) => value != null)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function convertMigrationResultToFlakerResult(input: {
  cwd: string;
  report: MigrationCompareReport;
  result: MigrationCompareResult;
  scenarioId: string;
  backend: FlakerVrtBackend;
  durationMs: number;
}): FlakerTestCaseResult {
  const viewport = input.report.viewports.find((entry) => entry.label === input.result.viewport);
  if (!viewport) {
    throw new Error(`Unknown viewport in migration report: ${input.result.viewport}`);
  }

  const variantFile = resolveResultVariantFile(input.report, input.result);
  const suite = resolveReportSuite(
    input.cwd,
    input.report.dir,
    input.scenarioId,
    variantFile,
  );
  const testName = `viewport:${input.result.viewport}`;
  const variant = buildFlakerVariantMetadata(input.backend, viewport);
  const status = input.result.approved || input.result.diffPixels === 0
    ? "passed"
    : "failed";
  const errorMessage = status === "failed"
    ? buildFailureMessage(input.result)
    : input.result.approved
      ? input.result.approvalReasons.join("; ") || "approved"
      : undefined;

  return {
    suite,
    testName,
    taskId: input.scenarioId,
    filter: null,
    variant,
    testId: buildFlakerVrtTestId({
      suite,
      testName,
      taskId: input.scenarioId,
      variant,
    }),
    status,
    durationMs: input.durationMs,
    retryCount: 0,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function resolveReportSuite(
  cwd: string,
  reportDir: string | undefined,
  scenarioId: string,
  variantFile: string,
): string {
  if (reportDir) {
    return resolveScenarioSuite(cwd, reportDir, variantFile);
  }

  if (variantFile.includes("/") || variantFile.includes("\\")) {
    return normalizePath(variantFile);
  }

  if (scenarioId.startsWith("migration/")) {
    const migrationDir = scenarioId.slice("migration/".length);
    return normalizePath(`fixtures/migration/${migrationDir}/${variantFile}`);
  }

  return normalizePath(variantFile);
}

function resolveResultVariantFile(
  report: MigrationCompareReport,
  result: MigrationCompareResult,
): string {
  if (result.variantFile) {
    return result.variantFile;
  }

  const exactMatch = report.variants.find((variantFile) =>
    variantFile === result.variant || basenameWithoutHtml(variantFile) === result.variant
  );
  if (exactMatch) {
    return exactMatch;
  }

  return result.variant ? `${result.variant}.html` : "unknown.html";
}

function basenameWithoutHtml(path: string): string {
  const normalized = path.split(/[\\/]/).at(-1) ?? path;
  return normalized.endsWith(".html")
    ? normalized.slice(0, -".html".length)
    : normalized;
}

function buildFailureMessage(result: MigrationCompareResult): string {
  const pieces = [
    `${result.diffPixels}px diff`,
    result.dominantCategory !== "none" ? result.dominantCategory : null,
    result.categorySummary || null,
    result.paintTreeSummary || null,
  ].filter((entry): entry is string => Boolean(entry));
  return pieces.join(" | ");
}
