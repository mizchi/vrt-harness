#!/usr/bin/env node
/**
 * VLM Model Benchmark — VRT diff 画像でモデルの reasoning 品質を比較
 *
 * Usage:
 *   node --experimental-strip-types src/vlm-bench.ts --list                    # モデル一覧
 *   node --experimental-strip-types src/vlm-bench.ts --list --max-cost 0       # 無料モデルのみ
 *   node --experimental-strip-types src/vlm-bench.ts gemma-3-27b              # 特定モデルで実行
 *   node --experimental-strip-types src/vlm-bench.ts gemma-3-27b llama-3.2    # 複数モデル比較
 *   node --experimental-strip-types src/vlm-bench.ts --image heatmap.png gemma-3-27b
 *
 * Environment: OPENROUTER_API_KEY required for execution (not for --list)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listModels, resolveModel, createVlmClient, type VlmModel, type VlmResponse } from "./vlm-client.ts";

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }
const modelArgs = args.filter((a) => !a.startsWith("--") && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1]?.startsWith("--")));

const IMAGE_PATH = getArg("image", "");
const TMP = join(process.cwd(), "test-results", "vlm-bench");

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";

function formatCost(costPer1k: number): string {
  if (costPer1k === 0) return "FREE";
  if (costPer1k < 1e-6) return `$${(costPer1k * 1e6).toFixed(1)}e-6`;
  if (costPer1k < 1e-3) return `$${(costPer1k * 1e3).toFixed(2)}e-3`;
  return `$${costPer1k.toFixed(4)}`;
}

// ---- List command ----

async function runList() {
  const maxCost = getArg("max-cost", "") ? parseFloat(getArg("max-cost", "999")) : undefined;
  const limit = getArg("limit", "") ? parseInt(getArg("limit", "50"), 10) : 50;
  const models = await listModels({ maxCost, limit, includeGemini: true });

  console.log();
  console.log(`${BOLD}${CYAN}Vision-capable models${RESET}  ${DIM}(${models.length} shown, OpenRouter + Gemini direct)${RESET}`);
  console.log();
  console.log(`  ${"#".padStart(3)} ${"Model ID".padEnd(52)} ${"Prompt/1K".padStart(12)} ${"Compl/1K".padStart(12)} ${"Context".padStart(9)}`);
  console.log(`  ${"─".repeat(3)} ${"─".repeat(52)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(9)}`);

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const p = formatCost(m.promptCostPer1k);
    const c = formatCost(m.completionCostPer1k);
    const color = m.promptCostPer1k === 0 ? GREEN : m.promptCostPer1k < 1e-6 ? YELLOW : DIM;
    console.log(`  ${String(i).padStart(3)} ${color}${m.id.padEnd(52)}${RESET} ${p.padStart(12)} ${c.padStart(12)} ${String(m.contextLength).padStart(9)}`);
  }

  console.log();
  console.log(`  ${DIM}Use model ID or partial match to run: just vlm-bench gemma-3-27b${RESET}`);
  console.log(`  ${DIM}Filter: --max-cost 0 (free only), --max-cost 0.0001 (cheap), --limit 20${RESET}`);
  console.log();
}

// ---- Bench command ----

async function runBench(modelIds: string[]) {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log(`\n  ${YELLOW}OPENROUTER_API_KEY not set.${RESET}\n`);
    process.exit(1);
  }

  await mkdir(TMP, { recursive: true });

  // Resolve models
  const models: VlmModel[] = [];
  for (const id of modelIds) {
    try {
      models.push(await resolveModel(id));
    } catch (e: any) {
      console.error(`  ${RED}${e.message}${RESET}`);
    }
  }
  if (models.length === 0) {
    console.error(`  ${RED}No models resolved. Use --list to see available models.${RESET}`);
    process.exit(1);
  }

  // Generate or load test image
  let imageBase64: string;
  let imageLabel: string;
  if (IMAGE_PATH) {
    imageBase64 = (await readFile(IMAGE_PATH)).toString("base64");
    imageLabel = IMAGE_PATH;
  } else {
    console.log(`  ${DIM}Generating test heatmap...${RESET}`);
    const { compareScreenshots } = await import("./heatmap.ts");
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();

    const before = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await before.setContent('<html><body style="font-family:sans-serif;padding:24px;background:#fff"><h1 style="color:#333">Dashboard</h1><p style="color:#666;margin:8px 0">Welcome back, Alice.</p><div style="display:flex;gap:16px;margin-top:16px"><div style="padding:16px;background:#f0f0f0;border-radius:8px;flex:1;border:1px solid #ddd"><strong>Users</strong><br>12,345</div><div style="padding:16px;background:#f0f0f0;border-radius:8px;flex:1;border:1px solid #ddd"><strong>Revenue</strong><br>$48,290</div></div><table style="width:100%;margin-top:24px;border-collapse:collapse"><tr style="background:#f9f9f9"><th style="text-align:left;padding:8px;border-bottom:1px solid #eee">Name</th><th style="text-align:left;padding:8px;border-bottom:1px solid #eee">Status</th></tr><tr><td style="padding:8px;border-bottom:1px solid #eee">Alice</td><td style="padding:8px;border-bottom:1px solid #eee"><span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:12px;font-size:12px">Active</span></td></tr><tr><td style="padding:8px">Bob</td><td style="padding:8px"><span style="background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:12px;font-size:12px">Pending</span></td></tr></table></body></html>');
    const basePath = join(TMP, "baseline.png");
    await before.screenshot({ path: basePath });
    await before.close();

    const after = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await after.setContent('<html><body style="font-family:sans-serif;padding:24px;background:#fff"><h1 style="color:#111;font-size:28px">Dashboard</h1><p style="color:#888;margin:12px 0">Welcome back, Alice.</p><div style="display:flex;gap:8px;margin-top:24px"><div style="padding:12px;background:#eff6ff;border-radius:12px;flex:1;border:1px solid #bfdbfe"><strong>Users</strong><br>12,345</div><div style="padding:12px;background:#fef2f2;border-radius:12px;flex:1;border:1px solid #fecaca"><strong>Revenue</strong><br>$48,290</div></div><table style="width:100%;margin-top:24px;border-collapse:collapse"><tr style="background:#f1f5f9"><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:13px;text-transform:uppercase;color:#64748b">Name</th><th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:13px;text-transform:uppercase;color:#64748b">Status</th></tr><tr><td style="padding:10px;border-bottom:1px solid #f1f5f9">Alice</td><td style="padding:10px;border-bottom:1px solid #f1f5f9"><span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:12px;font-size:12px">Active</span></td></tr><tr><td style="padding:10px">Bob</td><td style="padding:10px"><span style="background:#fef9c3;color:#854d0e;padding:2px 8px;border-radius:12px;font-size:12px">Pending</span></td></tr></table></body></html>');
    const curPath = join(TMP, "current.png");
    await after.screenshot({ path: curPath });
    await after.close();
    await browser.close();

    const diff = await compareScreenshots({
      testId: "vlm-test", testTitle: "vlm-test", projectName: "vlm",
      screenshotPath: curPath, baselinePath: basePath, status: "changed",
    }, { outputDir: TMP });

    imageBase64 = diff?.heatmapPath
      ? (await readFile(diff.heatmapPath)).toString("base64")
      : (await readFile(curPath)).toString("base64");
    imageLabel = `generated heatmap (${((diff?.diffRatio ?? 0) * 100).toFixed(1)}% diff)`;
  }

  const prompt = `You are analyzing a VRT (Visual Regression Testing) diff heatmap between a baseline and current web page screenshot. Red/pink areas show pixel differences.

Identify each visual change:
1. What CSS property changed (color, spacing, font-size, border-radius, background, etc.)
2. Which element is affected (heading, card, table, badge, etc.)
3. Is this a regression or intentional redesign?

Be specific. One change per line. Format: "- [element] property: old → new (severity: low/medium/high)"`;

  console.log();
  console.log(`${BOLD}${CYAN}VLM Benchmark${RESET}`);
  console.log(`  ${DIM}Image: ${imageLabel}${RESET}`);
  console.log(`  ${DIM}Models: ${models.map((m) => m.id).join(", ")}${RESET}`);
  console.log();

  const results: Array<{ model: string; response: VlmResponse | null; error?: string }> = [];

  for (const model of models) {
    process.stdout.write(`  ${model.id.padEnd(50)} `);
    const client = createVlmClient(model);
    if (!client) { console.log(`${RED}no key${RESET}`); continue; }

    try {
      const resp = await client.analyzeImage(imageBase64, prompt, { maxTokens: 512 });
      const costStr = resp.costUsd === 0 ? `${GREEN}FREE${RESET}` : `$${resp.costUsd.toFixed(6)}`;
      console.log(`${GREEN}${String(resp.latencyMs).padStart(5)}ms${RESET} ${costStr.padStart(16)} ${DIM}${resp.totalTokens}tok ${resp.content.length}ch${RESET}`);
      results.push({ model: model.id, response: resp });
      await writeFile(join(TMP, `${model.id.replace(/\//g, "_")}.txt`), resp.content);
    } catch (e: any) {
      const msg = e.message?.slice(0, 80) ?? "unknown error";
      console.log(`${RED}ERROR ${msg}${RESET}`);
      results.push({ model: model.id, response: null, error: msg });
    }
  }

  // Print responses
  console.log();
  for (const r of results) {
    if (!r.response) continue;
    console.log(`${BOLD}── ${r.model} ──${RESET} ${DIM}(${r.response.latencyMs}ms, $${r.response.costUsd.toFixed(6)})${RESET}`);
    // Truncate long responses
    const lines = r.response.content.split("\n").slice(0, 15);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    if (r.response.content.split("\n").length > 15) console.log(`  ${DIM}... (truncated)${RESET}`);
    console.log();
  }

  // Save report
  const reportData = {
    date: new Date().toISOString(),
    image: imageLabel,
    results: results.map((r) => ({
      model: r.model,
      latencyMs: r.response?.latencyMs ?? -1,
      costUsd: r.response?.costUsd ?? -1,
      tokens: r.response?.totalTokens ?? 0,
      responseLength: r.response?.content.length ?? 0,
      error: r.error,
    })),
  };
  const reportPath = join(TMP, "vlm-bench-report.json");
  await writeFile(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`  ${DIM}Report: ${reportPath}${RESET}`);

  // Generate markdown table
  if (hasFlag("md") || hasFlag("markdown")) {
    const mdPath = join(TMP, "vlm-bench-report.md");
    await writeFile(mdPath, generateMarkdownReport(reportData));
    console.log(`  ${DIM}Markdown: ${mdPath}${RESET}`);
  }
  console.log();
}

function generateMarkdownReport(data: { date: string; image: string; results: any[] }): string {
  const lines: string[] = [];
  lines.push(`# VLM Model Benchmark Report`);
  lines.push(``);
  lines.push(`**Date**: ${data.date.slice(0, 10)}`);
  lines.push(`**Image**: ${data.image}`);
  lines.push(``);
  lines.push(`| Model | Latency | Cost | Tokens | Response | Quality |`);
  lines.push(`|-------|---------|------|--------|----------|---------|`);

  const successful = data.results.filter((r: any) => r.latencyMs > 0).sort((a: any, b: any) => a.latencyMs - b.latencyMs);
  for (const r of successful) {
    const cost = r.costUsd === 0 ? "FREE" : `$${r.costUsd.toFixed(6)}`;
    const quality = r.responseLength > 500 ? "⭐ detailed" : r.responseLength > 200 ? "○ adequate" : r.responseLength > 50 ? "△ brief" : "✗ minimal";
    lines.push(`| ${r.model} | ${r.latencyMs}ms | ${cost} | ${r.tokens} | ${r.responseLength}ch | ${quality} |`);
  }

  const failed = data.results.filter((r: any) => r.latencyMs < 0);
  if (failed.length > 0) {
    lines.push(``);
    lines.push(`### Failed`);
    for (const r of failed) {
      lines.push(`- ${r.model}: ${r.error ?? "unknown error"}`);
    }
  }

  lines.push(``);
  lines.push(`*Generated by \`just vlm-bench --md\`*`);
  return lines.join("\n");
}

// ---- Main ----

async function main() {
  if (hasFlag("list")) {
    await runList();
  } else if (hasFlag("help") || hasFlag("h") || modelArgs.length === 0) {
    console.log(`
${BOLD}vlm-bench${RESET} — Compare vision models on VRT diff images

${BOLD}Usage:${RESET}
  vlm-bench --list                         List available vision models
  vlm-bench --list --max-cost 0            Free models only
  vlm-bench --list --max-cost 0.0001       Cheap models
  vlm-bench <model1> [model2] ...          Run benchmark on specified models
  vlm-bench --image diff.png <model>       Use custom image

${BOLD}Model selection:${RESET}
  Full ID:    google/gemma-3-27b-it:free
  Partial:    gemma-3-27b                  (auto-matches)
  Index:      0                            (from --list output)

${BOLD}Examples:${RESET}
  vlm-bench gemma-3-27b:free llama-3.2-11b-vision qwen3-vl-8b
  vlm-bench gemini:gemini-2.5-flash-preview-05-20 qwen3-vl-8b   # Gemini direct vs OpenRouter
  vlm-bench --image test-results/migration/heatmap.png gemma-3-27b:free
  vlm-bench --list --max-cost 0.0001 --limit 10

${BOLD}Providers:${RESET}
  OpenRouter:  model ID as-is (e.g. qwen/qwen3-vl-8b-instruct)
  Gemini:      gemini:<model-id> (e.g. gemini:gemini-2.5-flash-preview-05-20)

${BOLD}Environment:${RESET}
  OPENROUTER_API_KEY    Required for OpenRouter models
  GEMINI_API_KEY        Required for Gemini direct models (or GOOGLE_AI_API_KEY)
`);
  } else {
    await runBench(modelArgs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
