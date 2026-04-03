#!/usr/bin/env node
/**
 * vrt-harness API サーバー
 *
 * Hono で構築。Node.js ローカル実行用。
 * Cloudflare Workers にもそのまま移植可能な構造。
 *
 * Usage: node --experimental-strip-types src/api-server.ts [--port 3456]
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import type {
  CompareRequest, CompareResponse, CompareOptions,
  SmokeTestRequest, SmokeTestResponse,
  StatusResponse,
  ViewportResult, PixelDiffResult,
  HtmlSource,
} from "./api-types.ts";
import { runSmokeTest } from "./smoke-runner.ts";
import { isCraterAvailable, CraterClient } from "./crater-client.ts";

// ---- Config ----

const args = process.argv.slice(2);
const PORT = parseInt(args.find((a, i) => args[i - 1] === "--port") ?? "3456", 10);

// ---- App ----

const app = new Hono();

// ---- Routes ----

app.get("/api/status", async (c) => {
  const craterAvailable = await isCraterAvailable();
  const status: StatusResponse = {
    version: "0.2.0",
    capabilities: ["compare", "compare-renderers", "smoke-test", "report"],
    backends: [
      { name: "chromium", available: true },
      { name: "crater", available: craterAvailable },
    ],
  };
  return c.json(status);
});

app.post("/api/compare", async (c) => {
  const body = await c.req.json<CompareRequest>();

  // Resolve HTML sources
  const baselineHtml = await resolveHtmlSource(body.baseline);
  const currentHtml = await resolveHtmlSource(body.current);

  if (!baselineHtml || !currentHtml) {
    return c.json({ error: "Missing baseline or current HTML" }, 400);
  }

  // Lazy import heavy modules
  const { chromium } = await import("playwright");
  const { compareScreenshots } = await import("./heatmap.ts");
  const { discoverViewports } = await import("./viewport-discovery.ts");
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const tmpDir = join(process.cwd(), "test-results", "api", Date.now().toString());
  await mkdir(tmpDir, { recursive: true });

  // Discover viewports
  const viewports = body.viewports ?? (() => {
    const combined = baselineHtml + currentHtml;
    const discovery = discoverViewports(combined, {
      maxViewports: body.discover?.maxViewports ?? 7,
      randomSamples: body.discover?.randomSamples ?? 1,
    });
    return discovery.viewports;
  })();

  const browser = await chromium.launch();
  const startTime = Date.now();
  const viewportResults: ViewportResult[] = [];

  try {
    for (const vp of viewports) {
      const width = vp.width;
      const height = vp.height ?? 900;
      const label = vp.label ?? `${width}x${height}`;

      const { capturePageState, diffComputedStyles } = await import("./css-challenge-core.ts");
      const captureOpts = {
        captureHover: body.options?.hoverEmulation ?? false,
      };

      // Capture baseline
      const baseState = await capturePageState(browser, { width, height }, baselineHtml,
        join(tmpDir, `baseline-${label}.png`), captureOpts);

      // Capture current
      const curState = await capturePageState(browser, { width, height }, currentHtml,
        join(tmpDir, `current-${label}.png`), captureOpts);

      // Pixel diff
      const diff = await compareScreenshots({
        testId: label, testTitle: label, projectName: "api",
        screenshotPath: curState.screenshotPath,
        baselinePath: baseState.screenshotPath,
        status: "changed",
      }, { outputDir: tmpDir, threshold: body.options?.threshold ?? 0.1 });

      const pixelDiff: PixelDiffResult = {
        diffPixels: diff?.diffPixels ?? 0,
        totalPixels: diff?.totalPixels ?? 0,
        diffRatio: diff?.diffRatio ?? 0,
        regions: diff?.regions ?? [],
      };

      // Computed style diff
      let computedStyleDiff: ViewportResult["computedStyleDiff"];
      if (body.options?.computedStyle !== false) {
        const csDiffs = diffComputedStyles(baseState.computedStyles, curState.computedStyles);
        if (csDiffs.length > 0) {
          computedStyleDiff = {
            changes: csDiffs.map((d) => ({
              selector: d.selector, property: d.property,
              before: d.before, after: d.after,
            })),
            count: csDiffs.length,
          };
        }
      }

      viewportResults.push({
        viewport: { width, height, label },
        pixelDiff,
        computedStyleDiff,
        status: pixelDiff.diffRatio === 0 ? "pass" : "fail",
      });
    }
  } finally {
    await browser.close();
  }

  const allPass = viewportResults.every((v) => v.status === "pass");

  const response: CompareResponse = {
    status: allPass ? "pass" : "fail",
    viewports: viewportResults,
    meta: {
      backend: body.backend ?? "chromium",
      elapsedMs: Date.now() - startTime,
      viewportCount: viewportResults.length,
      baselineLabel: body.baseline.label,
      currentLabel: body.current.label,
    },
  };

  // Cleanup
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return c.json(response);
});

// Renderer comparison: render same HTML with two backends, diff the outputs
app.post("/api/compare-renderers", async (c) => {
  const body = await c.req.json<{
    html: HtmlSource;
    viewports?: { width: number; height: number; label?: string }[];
    threshold?: number;
  }>();

  const html = await resolveHtmlSource(body.html);
  if (!html) return c.json({ error: "Missing html" }, 400);

  const craterAvailable = await isCraterAvailable();
  if (!craterAvailable) {
    return c.json({ error: "Crater BiDi server not available on ws://127.0.0.1:9222" }, 503);
  }

  const { chromium: pw } = await import("playwright");
  const { compareScreenshots } = await import("./heatmap.ts");
  const { discoverViewports } = await import("./viewport-discovery.ts");
  const { mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { PNG } = await import("pngjs");

  const tmpDir = join(process.cwd(), "test-results", "api", `renderers-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const viewports = body.viewports ?? discoverViewports(html, { maxViewports: 5, randomSamples: 0 }).viewports;
  const startTime = Date.now();
  const results: Array<{
    viewport: { width: number; height: number; label: string };
    chromiumDiffRatio: number;
    craterDiffRatio: number;
    crossDiffRatio: number;
    paintTreeChanges: number;
  }> = [];

  const browser = await pw.launch();
  const crater = new CraterClient();
  await crater.connect();

  try {
    for (const vp of viewports) {
      const w = vp.width;
      const h = vp.height ?? 900;
      const label = vp.label ?? `${w}x${h}`;

      // Chromium render
      const chromiumPage = await browser.newPage({ viewport: { width: w, height: h } });
      await chromiumPage.setContent(html, { waitUntil: "networkidle" });
      const chromiumPath = join(tmpDir, `chromium-${label}.png`);
      await chromiumPage.screenshot({ path: chromiumPath, fullPage: true });
      await chromiumPage.close();

      // Crater render
      await crater.setViewport(w, h);
      await crater.setContent(html);
      const { png: craterPng } = await crater.capturePng();
      const craterPath = join(tmpDir, `crater-${label}.png`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(craterPath, craterPng);

      // Paint tree for detailed diff
      let paintTreeChanges = 0;
      try {
        const { diffPaintTrees } = await import("./crater-client.ts");
        // Capture paint tree for both renders
        // (crater only — chromium doesn't have paint tree)
        paintTreeChanges = 0; // placeholder — would need baseline vs current
      } catch { /* ignore */ }

      // Cross-renderer diff: chromium vs crater
      const crossDiff = await compareScreenshots({
        testId: `cross-${label}`,
        testTitle: `Chromium vs Crater ${label}`,
        projectName: "renderer-compare",
        screenshotPath: craterPath,
        baselinePath: chromiumPath,
        status: "changed",
      }, { outputDir: tmpDir, threshold: body.threshold ?? 0.1 });

      results.push({
        viewport: { width: w, height: h, label },
        chromiumDiffRatio: 0, // baseline = chromium
        craterDiffRatio: crossDiff?.diffRatio ?? 0,
        crossDiffRatio: crossDiff?.diffRatio ?? 0,
        paintTreeChanges,
      });
    }
  } finally {
    await crater.close();
    await browser.close();
  }

  const response = {
    status: results.every((r) => r.crossDiffRatio === 0) ? "match" : "differs",
    results,
    meta: {
      elapsedMs: Date.now() - startTime,
      viewportCount: results.length,
      backends: ["chromium", "crater"],
    },
  };

  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  return c.json(response);
});

app.post("/api/smoke-test", async (c) => {
  const body = await c.req.json<SmokeTestRequest>();

  // Resolve HTML if file path
  if (!body.target.html && !body.target.url) {
    return c.json({ error: "Missing target.html or target.url" }, 400);
  }

  const result = await runSmokeTest(body);
  return c.json(result);
});

// ---- Helpers ----

async function resolveHtmlSource(source: HtmlSource): Promise<string | null> {
  if (source.html) return source.html;
  if (source.url) {
    try {
      if (source.url.startsWith("file://") || !source.url.includes("://")) {
        const path = source.url.replace("file://", "");
        return await readFile(path, "utf-8");
      }
      const res = await fetch(source.url);
      return await res.text();
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Server ----

console.log(`vrt-harness API server on http://localhost:${PORT}`);
serve({ fetch: app.fetch, port: PORT });
