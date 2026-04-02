import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatPlaywrightLaunchError,
  isPlaywrightSandboxRestrictionError,
} from "./playwright-launch-error.ts";

const SANDBOX_ERROR = `browserType.launch: Target page, context or browser has been closed
Browser logs:

[pid=15101][err] [0403/002036.899802:FATAL:base/apple/mach_port_rendezvous_mac.cc:155] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.15101: Permission denied (1100)`;

describe("isPlaywrightSandboxRestrictionError", () => {
  it("detects known macOS sandbox launch failures", () => {
    assert.equal(
      isPlaywrightSandboxRestrictionError(new Error(SANDBOX_ERROR)),
      true,
    );
  });

  it("does not classify unrelated Playwright errors as sandbox restrictions", () => {
    assert.equal(
      isPlaywrightSandboxRestrictionError(new Error("browserType.launch: Executable doesn't exist")),
      false,
    );
  });
});

describe("formatPlaywrightLaunchError", () => {
  it("formats a user-facing sandbox explanation", () => {
    const message = formatPlaywrightLaunchError(
      new Error(SANDBOX_ERROR),
      { commandHint: "rerun outside the Codex sandbox or in CI" },
    );

    assert.match(message, /Codex\/macOS sandbox restriction/i);
    assert.match(message, /Chromium itself is likely fine/i);
    assert.match(message, /rerun outside the Codex sandbox or in CI/i);
    assert.match(message, /Original error: browserType\.launch:/i);
  });

  it("returns the original message for non-sandbox failures", () => {
    assert.equal(
      formatPlaywrightLaunchError(new Error("browserType.launch: Executable doesn't exist")),
      "browserType.launch: Executable doesn't exist",
    );
  });

  it("does not wrap an already formatted sandbox explanation again", () => {
    const formatted = formatPlaywrightLaunchError(
      new Error(SANDBOX_ERROR),
      { commandHint: "in your local terminal or in CI" },
    );

    assert.equal(
      formatPlaywrightLaunchError(new Error(formatted)),
      formatted,
    );
  });
});
