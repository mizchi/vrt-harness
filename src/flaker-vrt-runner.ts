#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadFlakerVrtConfig, toViewportSpec, type FlakerVrtConfig, type FlakerVrtMigrationScenario } from "./flaker-vrt-config.ts";
import {
  runMigrationCompare,
  type MigrationCompareOptions,
  type MigrationCompareReport,
} from "./migration-compare.ts";
import {
  buildFlakerVariantMetadata,
  buildFlakerVrtTestId,
  createFlakyResult,
  extractVariantFileFromSuite,
  extractViewportLabel,
  mapMigrationReportToRequestedFlakerResults,
  normalizePath,
  resolveScenarioSuite,
} from "./flaker-vrt-results.ts";
export { buildFlakerVrtTestId } from "./flaker-vrt-results.ts";

export interface FlakerVrtRunnerCliArgs {
  mode: "list" | "execute";
  configPath?: string;
}

export interface FlakerTestId {
  suite: string;
  testName: string;
  taskId?: string | null;
  filter?: string | null;
  variant?: Record<string, string> | null;
  testId?: string;
}

export interface FlakerTestCaseResult extends FlakerTestId {
  status: "passed" | "failed" | "skipped" | "flaky";
  durationMs: number;
  retryCount: number;
  errorMessage?: string;
}

export interface FlakerExecuteResult {
  exitCode: number;
  results: FlakerTestCaseResult[];
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface FlakerExecuteInput {
  tests: FlakerTestId[];
  opts?: {
    cwd?: string;
    timeout?: number;
    retries?: number;
    env?: Record<string, string>;
    workers?: number;
  };
}

interface ExecutionGroup {
  scenario: FlakerVrtMigrationScenario;
  tests: FlakerTestId[];
  variants: string[];
  viewports: ReturnType<typeof toViewportSpec>[];
}

type RunMigrationCompareFn = (
  options: MigrationCompareOptions,
) => Promise<MigrationCompareReport>;

export function parseFlakerVrtRunnerCliArgs(
  args: string[],
): FlakerVrtRunnerCliArgs {
  const [mode, ...rest] = args;
  if (mode !== "list" && mode !== "execute") {
    throw new Error(`Unknown mode: ${mode ?? "(missing)"}`);
  }

  const configIndex = rest.indexOf("--config");
  const configPath = configIndex >= 0 ? rest[configIndex + 1] : undefined;

  return { mode, ...(configPath ? { configPath } : {}) };
}

export function listFlakerVrtTests(
  config: FlakerVrtConfig,
  cwd = process.cwd(),
): FlakerTestId[] {
  return config.scenarios.flatMap((scenario) =>
      scenario.variants.flatMap((variantFile) =>
      scenario.viewports.map((viewport) => {
        const suite = resolveScenarioSuite(cwd, scenario.dir, variantFile);
        const variant = buildFlakerVariantMetadata(scenario.backend, viewport);
        return {
          suite,
          testName: `viewport:${viewport.label}`,
          taskId: scenario.id,
          filter: null,
          variant,
          testId: buildFlakerVrtTestId({
            suite,
            testName: `viewport:${viewport.label}`,
            taskId: scenario.id,
            variant,
          }),
        } satisfies FlakerTestId;
      }),
    ),
  );
}

export async function executeFlakerVrtTests(input: {
  cwd: string;
  config: FlakerVrtConfig;
  tests: FlakerTestId[];
  runMigrationCompare?: RunMigrationCompareFn;
  now?: Date;
  ensureDir?: (path: string) => Promise<void>;
}): Promise<FlakerExecuteResult> {
  const startedAt = Date.now();
  const runCompare = input.runMigrationCompare ?? runMigrationCompare;
  const ensureDir = input.ensureDir ?? ((path: string) => mkdir(path, { recursive: true }));
  const groups = groupRequestedTests(input.config, input.tests, input.cwd);
  const results: FlakerTestCaseResult[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  for (const group of groups) {
    const timestamp = formatTimestamp(input.now ?? new Date());
    const outputDir = join(
      input.cwd,
      "test-results",
      "flaker-vrt",
      timestamp,
      sanitizeScenarioId(group.scenario.id),
    );

    try {
      await ensureDir(outputDir);
      const compareOptions: MigrationCompareOptions = {
        dir: group.scenario.dir,
        baseline: group.scenario.baseline,
        variants: group.variants,
        outputDir,
        fixedViewports: group.viewports,
        autoDiscover: false,
        maxViewports: group.viewports.length,
        randomSamples: 0,
        approvalPath: group.scenario.approval ?? "",
        strict: group.scenario.strict,
        paintTreeUrl: group.scenario.paintTreeUrl,
        enablePaintTree: group.scenario.enablePaintTree,
      };

      const groupStartedAt = Date.now();
      const report = await runCompare(compareOptions);
      const groupDurationMs = Date.now() - groupStartedAt;
      const mapped = mapMigrationReportToFlakerResults(
        group.tests,
        group.scenario,
        report,
        groupDurationMs,
        input.cwd,
      );

      results.push(...mapped);
      stdoutLines.push(
        `${group.scenario.id}: ${report.reportPath} (${mapped.length} tests)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderrLines.push(`${group.scenario.id}: ${message}`);
      results.push(...group.tests.map((test) => createFlakyResult(test, message)));
    }
  }

  return {
    exitCode: results.some((result) => result.status === "failed") ? 1 : 0,
    results,
    durationMs: Date.now() - startedAt,
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
  };
}

export function groupRequestedTests(
  config: FlakerVrtConfig,
  tests: FlakerTestId[],
  cwd = process.cwd(),
): ExecutionGroup[] {
  const testsByScenario = new Map<string, FlakerTestId[]>();
  const suiteToScenario = new Map<string, string>();

  for (const scenario of config.scenarios) {
    for (const variant of scenario.variants) {
      suiteToScenario.set(resolveScenarioSuite(cwd, scenario.dir, variant), scenario.id);
    }
  }

  for (const test of tests) {
    const scenarioId = test.taskId ?? suiteToScenario.get(normalizePath(test.suite));
    if (!scenarioId) {
      throw new Error(`Unknown VRT test scenario for suite: ${test.suite}`);
    }
    const existing = testsByScenario.get(scenarioId);
    if (existing) existing.push(test);
    else testsByScenario.set(scenarioId, [test]);
  }

  return [...testsByScenario.entries()].map(([scenarioId, scenarioTests]) => {
    const scenario = config.scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown VRT scenario: ${scenarioId}`);
    }

    const requestedVariants = new Set<string>();
    const requestedViewportLabels = new Set<string>();
    for (const test of scenarioTests) {
      requestedVariants.add(extractVariantFileFromSuite(cwd, scenario, test.suite));
      requestedViewportLabels.add(extractViewportLabel(test));
    }

    const variants = scenario.variants.filter((variant) => requestedVariants.has(variant));
    const viewports = scenario.viewports
      .filter((viewport) => requestedViewportLabels.has(viewport.label))
      .map(toViewportSpec);

    return {
      scenario,
      tests: scenarioTests,
      variants,
      viewports,
    } satisfies ExecutionGroup;
  });
}

export function mapMigrationReportToFlakerResults(
  requestedTests: FlakerTestId[],
  scenario: FlakerVrtMigrationScenario,
  report: MigrationCompareReport,
  durationMs: number,
  cwd = process.cwd(),
): FlakerTestCaseResult[] {
  return mapMigrationReportToRequestedFlakerResults({
    requestedTests,
    scenario,
    report,
    durationMs,
    cwd,
  });
}

function sanitizeScenarioId(id: string): string {
  return id.replaceAll("/", "-");
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const cliArgs = parseFlakerVrtRunnerCliArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const config = await loadFlakerVrtConfig({
    cwd,
    configPath: cliArgs.configPath,
  });

  if (cliArgs.mode === "list") {
    console.log(JSON.stringify(listFlakerVrtTests(config, cwd), null, 2));
    return;
  }

  if (cliArgs.mode === "execute") {
    const input = JSON.parse(await readAllStdin()) as FlakerExecuteInput;
    const executionCwd = input.opts?.cwd ?? cwd;
    const result = await executeFlakerVrtTests({
      cwd: executionCwd,
      config,
      tests: input.tests,
    });
    console.log(JSON.stringify(result));
    return;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === new URL(`file://${invokedPath}`).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      exitCode: 0,
      results: [],
      durationMs: 0,
      stdout: "",
      stderr: message,
    } satisfies FlakerExecuteResult));
  });
}
