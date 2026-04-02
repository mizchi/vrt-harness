import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFlakerVrtReportAdapterArgs } from "./flaker-vrt-report-adapter.ts";

describe("parseFlakerVrtReportAdapterArgs", () => {
  it("parses file path and overrides", () => {
    const args = parseFlakerVrtReportAdapterArgs([
      "--file",
      "test-results/migration/migration-report.json",
      "--scenario-id",
      "migration/reset-css",
      "--backend",
      "prescanner",
      "--cwd",
      "/repo",
    ]);

    assert.equal(args.filePath, "test-results/migration/migration-report.json");
    assert.equal(args.scenarioId, "migration/reset-css");
    assert.equal(args.backend, "prescanner");
    assert.equal(args.cwd, "/repo");
  });

  it("uses defaults when optional overrides are omitted", () => {
    const args = parseFlakerVrtReportAdapterArgs([]);

    assert.equal(args.filePath, undefined);
    assert.equal(args.scenarioId, undefined);
    assert.equal(args.backend, "chromium");
  });
});
