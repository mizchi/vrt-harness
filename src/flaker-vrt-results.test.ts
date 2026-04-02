import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MigrationCompareReport } from "./migration-compare.ts";
import {
  buildFlakerVariantMetadata,
  convertMigrationReportToFlakerResults,
  inferFlakerScenarioIdFromReport,
} from "./flaker-vrt-results.ts";

function createReport(): MigrationCompareReport {
  return {
    dir: "fixtures/migration/reset-css",
    baseline: "normalize.html",
    variants: ["modern-normalize.html", "destyle.html"],
    viewports: [
      { label: "desktop", width: 1280, height: 900, reason: "configured" },
      { label: "mobile", width: 375, height: 812, reason: "configured" },
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
        variant: "destyle",
        variantFile: "destyle.html",
        viewport: "mobile",
        diffRatio: 0.01,
        diffPixels: 2,
        totalPixels: 100,
        rawDiffRatio: 0.02,
        rawDiffPixels: 2,
        rawDominantCategory: "spacing",
        rawCategorySummary: "spacing",
        rawCategoryCounts: { "layout-shift": 0, spacing: 2, "color-change": 0, typography: 0 },
        approved: true,
        partiallyApproved: false,
        approvedPixels: 2,
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
    ],
  };
}

describe("buildFlakerVariantMetadata", () => {
  it("adds backend and viewport metadata in stable order", () => {
    assert.deepEqual(
      buildFlakerVariantMetadata("prescanner", {
        label: "desktop",
        width: 1280,
        height: 900,
      }),
      {
        backend: "prescanner",
        height: "900",
        viewport: "desktop",
        width: "1280",
      },
    );
  });
});

describe("inferFlakerScenarioIdFromReport", () => {
  it("infers migration/<dir-name> from report.dir", () => {
    assert.equal(
      inferFlakerScenarioIdFromReport(createReport()),
      "migration/reset-css",
    );
  });
});

describe("convertMigrationReportToFlakerResults", () => {
  it("converts migration report results into flaker test cases", () => {
    const results = convertMigrationReportToFlakerResults({
      report: createReport(),
      cwd: "/repo",
      backend: "chromium",
      scenarioId: "migration/reset-css",
      durationMs: 400,
    });

    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((entry) => [entry.suite, entry.testName, entry.status]),
      [
        ["fixtures/migration/reset-css/modern-normalize.html", "viewport:desktop", "passed"],
        ["fixtures/migration/reset-css/destyle.html", "viewport:mobile", "passed"],
      ],
    );
    assert.equal(results[1].errorMessage, "Known renderer gap");
    assert.equal(results[0].durationMs, 200);
    assert.equal(results[0].taskId, "migration/reset-css");
    assert.deepEqual(results[0].variant, {
      backend: "chromium",
      height: "900",
      viewport: "desktop",
      width: "1280",
    });
  });

  it("marks unresolved diffs as failed", () => {
    const report = createReport();
    report.results[1] = {
      ...report.results[1],
      approved: false,
      diffPixels: 3,
      dominantCategory: "spacing",
      categorySummary: "spacing",
    };

    const results = convertMigrationReportToFlakerResults({
      report,
      cwd: "/repo",
      backend: "chromium",
      scenarioId: "migration/reset-css",
      durationMs: 400,
    });

    assert.equal(results[1].status, "failed");
    assert.match(results[1].errorMessage ?? "", /spacing/);
  });
});
