import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSS_BENCH_OUTPUT_ROOT } from "./css-challenge-fixtures.ts";
import { parseCssChallengeBenchArgs } from "./css-challenge-bench.ts";

describe("parseCssChallengeBenchArgs", () => {
  it("parses explicit flags including output-root", () => {
    const options = parseCssChallengeBenchArgs([
      "--fixture", "dashboard",
      "--fixture", "page",
      "--trials", "5",
      "--start-seed", "10",
      "--backend", "prescanner",
      "--approval", "approval.json",
      "--strict",
      "--suggest-approval",
      "--output-root", "artifacts/css-bench",
      "--no-db",
    ]);

    assert.equal(options.trials, 5);
    assert.equal(options.startSeed, 10);
    assert.equal(options.saveDb, false);
    assert.deepEqual(options.fixtureArgs, ["dashboard", "page"]);
    assert.equal(options.backend, "prescanner");
    assert.equal(options.approvalPath, "approval.json");
    assert.equal(options.strict, true);
    assert.equal(options.suggestApproval, true);
    assert.equal(options.outputRoot, "artifacts/css-bench");
  });

  it("uses defaults when flags are omitted", () => {
    const options = parseCssChallengeBenchArgs([]);

    assert.equal(options.trials, 20);
    assert.equal(options.startSeed, 1);
    assert.equal(options.saveDb, true);
    assert.deepEqual(options.fixtureArgs, []);
    assert.equal(options.backend, "chromium");
    assert.equal(options.approvalPath, "");
    assert.equal(options.strict, false);
    assert.equal(options.suggestApproval, false);
    assert.equal(options.outputRoot, CSS_BENCH_OUTPUT_ROOT);
  });
});
