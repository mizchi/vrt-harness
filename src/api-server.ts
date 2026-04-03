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

// ---- Config ----

const args = process.argv.slice(2);
const PORT = parseInt(args.find((a, i) => args[i - 1] === "--port") ?? "3456", 10);

// ---- App ----

const app = new Hono();

// ---- Routes ----

app.get("/api/status", (c) => {
  const status: StatusResponse = {
    version: "0.2.0",
    capabilities: ["compare", "smoke-test", "report"],
    backends: [
      { name: "chromium", available: true },
      { name: "crater", available: false }, // check on demand
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

      // Capture baseline
      const basePage = await browser.newPage({ viewport: { width, height } });
      await basePage.setContent(baselineHtml, { waitUntil: "networkidle" });
      const basePath = join(tmpDir, `baseline-${label}.png`);
      await basePage.screenshot({ path: basePath, fullPage: true });
      await basePage.close();

      // Capture current
      const curPage = await browser.newPage({ viewport: { width, height } });
      await curPage.setContent(currentHtml, { waitUntil: "networkidle" });
      const curPath = join(tmpDir, `current-${label}.png`);
      await curPage.screenshot({ path: curPath, fullPage: true });
      await curPage.close();

      // Compare
      const diff = await compareScreenshots({
        testId: label,
        testTitle: label,
        projectName: "api",
        screenshotPath: curPath,
        baselinePath: basePath,
        status: "changed",
      }, {
        outputDir: tmpDir,
        threshold: body.options?.threshold ?? 0.1,
      });

      const pixelDiff: PixelDiffResult = {
        diffPixels: diff?.diffPixels ?? 0,
        totalPixels: diff?.totalPixels ?? 0,
        diffRatio: diff?.diffRatio ?? 0,
        regions: diff?.regions ?? [],
      };

      viewportResults.push({
        viewport: { width, height, label },
        pixelDiff,
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
