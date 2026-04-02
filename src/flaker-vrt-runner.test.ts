import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MigrationCompareReport } from "./migration-compare.ts";
import type { FlakerVrtConfig } from "./flaker-vrt-config.ts";
import {
  buildFlakerVrtTestId,
  executeFlakerVrtTests,
  listFlakerVrtTests,
  parseFlakerVrtRunnerCliArgs,
} from "./flaker-vrt-runner.ts";

const CONFIG: FlakerVrtConfig = {
  scenarios: [
    {
      id: "migration/reset-css",
      kind: "migration",
      dir: "fixtures/migration/reset-css",
      baseline: "normalize.html",
      variants: ["modern-normalize.html", "destyle.html"],
      viewports: [
        { label: "desktop", width: 1280, height: 900 },
        { label: "mobile", width: 375, height: 812 },
      ],
      backend: "chromium",
      strict: false,
      enablePaintTree: true,
    },
  ],
};

function createReport(): MigrationCompareReport {
  return {
    dir: "fixtures/migration/reset-css",
    baseline: "normalize.html",
    variants: ["modern-normalize.html", "destyle.html"],
    viewports: [
      { label: "desktop", width: 1280, height: 900 },
      { label: "mobile", width: 375, height: 812 },
    ],
    strict: false,
    approvalWarnings: [],
    paintTree: { enabled: true, available: false },
    reportPath: "/tmp/report.json",
    results: [
      {
        variant: "modern-normalize",
        variantFile: "modern-normalize.html",
        viewport: "desktop",
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 100,
        rawDiffRatio: 0,
        rawDiffPixels: 0,
        rawDominantCategory: "none",
        rawCategorySummary: "",
        rawCategoryCounts: { "layout-shift": 0, spacing: 0, "color-change": 0, typography: 0 },
        approved: false,
        partiallyApproved: false,
        approvedPixels: 0,
        approvalReasons: [],
        dominantCategory: "none",
        categorySummary: "",
        categoryCounts: { "layout-shift": 0, spacing: 0, "color-change": 0, typography: 0 },
        rawPaintTreeChangeCount: 0,
        rawPaintTreeSummary: "",
        rawPaintTreeCounts: { insert: 0, remove: 0, update: 0 },
        paintTreeChangeCount: 0,
        paintTreeSummary: "",
        paintTreeCounts: { insert: 0, remove: 0, update: 0 },
        approvedPaintTreeCount: 0,
        approvedPaintTreeReasons: [],
        fixCandidates: [],
      },
      {
        variant: "modern-normalize",
        variantFile: "modern-normalize.html",
        viewport: "mobile",
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 100,
        rawDiffRatio: 0.01,
        rawDiffPixels: 1,
        rawDominantCategory: "spacing",
        rawCategorySummary: "spacing",
        rawCategoryCounts: { "layout-shift": 0, spacing: 1, "color-change": 0, typography: 0 },
        approved: true,
        partiallyApproved: false,
        approvedPixels: 1,
        approvalReasons: ["Known renderer gap"],
        dominantCategory: "none",
        categorySummary: "",
        categoryCounts: { "layout-shift": 0, spacing: 0, "color-change": 0, typography: 0 },
        rawPaintTreeChangeCount: 0,
        rawPaintTreeSummary: "",
        rawPaintTreeCounts: { insert: 0, remove: 0, update: 0 },
        paintTreeChangeCount: 0,
        paintTreeSummary: "",
        paintTreeCounts: { insert: 0, remove: 0, update: 0 },
        approvedPaintTreeCount: 0,
        approvedPaintTreeReasons: [],
        fixCandidates: [],
      },
      {
        variant: "destyle",
        variantFile: "destyle.html",
        viewport: "mobile",
        diffRatio: 0.12,
        diffPixels: 12,
        totalPixels: 100,
        rawDiffRatio: 0.12,
        rawDiffPixels: 12,
        rawDominantCategory: "typography",
        rawCategorySummary: "typography",
        rawCategoryCounts: { "layout-shift": 0, spacing: 0, "color-change": 0, typography: 12 },
        approved: false,
        partiallyApproved: false,
        approvedPixels: 0,
        approvalReasons: [],
        dominantCategory: "typography",
        categorySummary: "typography",
        categoryCounts: { "layout-shift": 0, spacing: 0, "color-change": 0, typography: 12 },
        rawPaintTreeChangeCount: 0,
        rawPaintTreeSummary: "",
        rawPaintTreeCounts: { insert: 0, remove: 0, update: 0 },
        paintTreeChangeCount: 0,
        paintTreeSummary: "",
        paintTreeCounts: { insert: 0, remove: 0, update: 0 },
        approvedPaintTreeCount: 0,
        approvedPaintTreeReasons: [],
        fixCandidates: [],
      },
    ],
  };
}

describe("buildFlakerVrtTestId", () => {
  it("should build a stable test id", () => {
    const id = buildFlakerVrtTestId({
      suite: "fixtures/migration/reset-css/modern-normalize.html",
      testName: "viewport:desktop",
      taskId: "migration/reset-css",
      variant: {
        width: "1280",
        backend: "chromium",
        viewport: "desktop",
        height: "900",
      },
    });

    assert.equal(
      id,
      JSON.stringify({
        taskId: "migration/reset-css",
        suite: "fixtures/migration/reset-css/modern-normalize.html",
        testName: "viewport:desktop",
        filter: null,
        variant: {
          backend: "chromium",
          height: "900",
          viewport: "desktop",
          width: "1280",
        },
      }),
    );
  });
});

describe("parseFlakerVrtRunnerCliArgs", () => {
  it("should parse mode and config path", () => {
    const parsed = parseFlakerVrtRunnerCliArgs(["execute", "--config", "examples/flaker.vrt.json"]);

    assert.equal(parsed.mode, "execute");
    assert.equal(parsed.configPath, "examples/flaker.vrt.json");
  });

  it("should default config path when omitted", () => {
    const parsed = parseFlakerVrtRunnerCliArgs(["list"]);

    assert.equal(parsed.mode, "list");
    assert.equal(parsed.configPath, undefined);
  });
});

describe("listFlakerVrtTests", () => {
  it("should expand scenarios into variant x viewport tests", () => {
    const tests = listFlakerVrtTests(CONFIG, "/repo");

    assert.equal(tests.length, 4);
    assert.deepEqual(tests[0], {
      suite: "fixtures/migration/reset-css/modern-normalize.html",
      testName: "viewport:desktop",
      taskId: "migration/reset-css",
      filter: null,
      variant: {
        backend: "chromium",
        height: "900",
        viewport: "desktop",
        width: "1280",
      },
      testId: buildFlakerVrtTestId({
        suite: "fixtures/migration/reset-css/modern-normalize.html",
        testName: "viewport:desktop",
        taskId: "migration/reset-css",
        variant: {
          backend: "chromium",
          height: "900",
          viewport: "desktop",
          width: "1280",
        },
      }),
    });
  });
});

describe("executeFlakerVrtTests", () => {
  it("should run grouped migration scenarios and map results to flaker statuses", async () => {
    const tests = [
      listFlakerVrtTests(CONFIG, "/repo")[0],
      listFlakerVrtTests(CONFIG, "/repo")[1],
      listFlakerVrtTests(CONFIG, "/repo")[3],
    ];

    const calls: Array<{ variants: string[]; viewports: string[]; outputDir: string }> = [];
    const result = await executeFlakerVrtTests({
      cwd: "/repo",
      config: CONFIG,
      tests,
      runMigrationCompare: async (options) => {
        calls.push({
          variants: options.variants,
          viewports: options.fixedViewports?.map((viewport) => viewport.label) ?? [],
          outputDir: options.outputDir,
        });
        return createReport();
      },
      ensureDir: async () => {},
      now: new Date("2026-04-02T10:00:00Z"),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].variants, ["modern-normalize.html", "destyle.html"]);
    assert.deepEqual(calls[0].viewports, ["desktop", "mobile"]);
    assert.match(calls[0].outputDir, /test-results\/flaker-vrt\/2026-04-02T10-00-00-000Z\/migration-reset-css$/);
    assert.equal(result.exitCode, 1);
    assert.equal(result.results.length, 3);
    assert.deepEqual(
      result.results.map((entry) => [entry.testName, entry.status]),
      [
        ["viewport:desktop", "passed"],
        ["viewport:mobile", "passed"],
        ["viewport:mobile", "failed"],
      ],
    );
  });

  it("should convert execution errors into flaky results for requested tests", async () => {
    const tests = [listFlakerVrtTests(CONFIG, "/repo")[0], listFlakerVrtTests(CONFIG, "/repo")[1]];

    const result = await executeFlakerVrtTests({
      cwd: "/repo",
      config: CONFIG,
      tests,
      runMigrationCompare: async () => {
        throw new Error("browser launch failed");
      },
      ensureDir: async () => {},
      now: new Date("2026-04-02T10:00:00Z"),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((entry) => entry.status === "flaky"));
    assert.ok(result.results.every((entry) => entry.errorMessage?.includes("browser launch failed")));
  });
});
