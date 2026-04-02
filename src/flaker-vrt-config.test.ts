import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  DEFAULT_FLAKER_VRT_CONFIG_FILE,
  loadFlakerVrtConfig,
  parseFlakerVrtConfig,
  resolveFlakerVrtConfigPath,
} from "./flaker-vrt-config.ts";

describe("parseFlakerVrtConfig", () => {
  it("should parse a valid migration scenario and apply defaults", () => {
    const config = parseFlakerVrtConfig(JSON.stringify({
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
        },
      ],
    }));

    assert.equal(config.scenarios.length, 1);
    assert.equal(config.scenarios[0].backend, "chromium");
    assert.equal(config.scenarios[0].strict, false);
    assert.equal(config.scenarios[0].enablePaintTree, true);
  });

  it("should reject duplicate scenario ids", () => {
    assert.throws(() => parseFlakerVrtConfig(JSON.stringify({
      scenarios: [
        {
          id: "dup",
          kind: "migration",
          dir: "fixtures/a",
          baseline: "before.html",
          variants: ["after.html"],
          viewports: [{ label: "desktop", width: 1280, height: 900 }],
        },
        {
          id: "dup",
          kind: "migration",
          dir: "fixtures/b",
          baseline: "before.html",
          variants: ["after.html"],
          viewports: [{ label: "mobile", width: 375, height: 812 }],
        },
      ],
    })), /Duplicate scenario id/);
  });

  it("should reject scenarios without viewports", () => {
    assert.throws(() => parseFlakerVrtConfig(JSON.stringify({
      scenarios: [
        {
          id: "migration/reset-css",
          kind: "migration",
          dir: "fixtures/migration/reset-css",
          baseline: "normalize.html",
          variants: ["modern-normalize.html"],
          viewports: [],
        },
      ],
    })), /must define at least one viewport/);
  });
});

describe("resolveFlakerVrtConfigPath", () => {
  it("should default to flaker.vrt.json in cwd", () => {
    assert.equal(
      resolveFlakerVrtConfigPath("/repo"),
      "/repo/flaker.vrt.json",
    );
  });
});

describe("loadFlakerVrtConfig", () => {
  it("should load config from the default file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flaker-vrt-config-"));
    const path = join(dir, DEFAULT_FLAKER_VRT_CONFIG_FILE);
    await writeFile(path, JSON.stringify({
      scenarios: [
        {
          id: "migration/tailwind",
          kind: "migration",
          dir: "fixtures/migration/tailwind-to-vanilla",
          baseline: "before.html",
          variants: ["after.html"],
          viewports: [{ label: "desktop", width: 1280, height: 900 }],
        },
      ],
    }, null, 2));

    const config = await loadFlakerVrtConfig({ cwd: dir });
    assert.equal(config.scenarios[0].id, "migration/tailwind");
  });
});
