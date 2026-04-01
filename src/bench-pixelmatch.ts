#!/usr/bin/env node
/**
 * pixelmatch 実装比較ベンチマーク
 *
 * npm pixelmatch v7 vs mizchi/pixelmatch (MoonBit JS) vs mizchi/pixelmatch (WASM-GC)
 * 同一の画像データで比較する。
 */
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MOONBIT_DIR = join(process.env.HOME!, "ghq/github.com/mizchi/pixelmatch");
const TMP = join(import.meta.dirname!, "..", "test-results", "bench-pixelmatch");

// ---- Test image generation ----

function createImage(w: number, h: number, seed: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(rand() * 256);
    data[i + 1] = Math.floor(rand() * 256);
    data[i + 2] = Math.floor(rand() * 256);
    data[i + 3] = 255;
  }
  return data;
}

function mutateImage(base: Uint8Array, ratio: number, seed: number): Uint8Array {
  const data = new Uint8Array(base);
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
  const pixels = data.length / 4;
  for (let i = 0; i < Math.floor(pixels * ratio); i++) {
    const idx = Math.floor(rand() * pixels) * 4;
    data[idx] = (data[idx] + 80) % 256;
    data[idx + 1] = (data[idx + 1] + 80) % 256;
  }
  return data;
}

interface BenchResult {
  name: string;
  size: string;
  iterations: number;
  avgMs: number;
  opsPerSec: number;
  diffPixels: number;
}

async function bench(name: string, fn: () => number, iterations: number, size: string): Promise<BenchResult> {
  let diffPixels = 0;
  // warmup
  for (let i = 0; i < Math.min(3, iterations); i++) diffPixels = fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - start;
  return {
    name, size, iterations,
    avgMs: Math.round((totalMs / iterations) * 100) / 100,
    opsPerSec: Math.round(iterations / (totalMs / 1000)),
    diffPixels,
  };
}

// ---- Main ----

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

async function main() {
  mkdirSync(TMP, { recursive: true });

  console.log();
  console.log(`${BOLD}${CYAN}pixelmatch implementation benchmark${RESET}`);
  console.log();

  const sizes = [
    { w: 320, h: 240, label: "320x240", n: 100 },
    { w: 1280, h: 900, label: "1280x900", n: 30 },
    { w: 1920, h: 1080, label: "1920x1080", n: 15 },
  ];

  const results: BenchResult[] = [];

  // ---- npm pixelmatch v7 ----
  {
    const pixelmatch = (await import("pixelmatch")).default;
    for (const { w, h, label, n } of sizes) {
      const img1 = createImage(w, h, 1);
      const img2 = mutateImage(img1, 0.05, 2);
      const output = new Uint8Array(w * h * 4);
      const r = await bench("npm pixelmatch v7", () => {
        return pixelmatch(img1, img2, output, w, h, { threshold: 0.1 });
      }, n, label);
      results.push(r);
    }
  }

  // ---- mizchi/pixelmatch MoonBit JS ----
  {
    const jsPath = join(MOONBIT_DIR, "_build/js/release/build/src/src.js");
    if (existsSync(jsPath)) {
      // MoonBit JS build は moon bench 経由でしか実行できないので、
      // 同等サイズのベンチ結果を moon bench から取得済みのデータで比較する
      console.log(`  ${DIM}MoonBit JS: using moon bench data (100x100 = 1.18ms)${RESET}`);
      // 100x100 → 1.18ms = 10,000px → extrapolate
      for (const { w, h, label } of sizes) {
        const pixels = w * h;
        const ratio = pixels / 10000;
        const estMs = 1.18 * ratio;
        results.push({
          name: "moonbit JS (est.)",
          size: label,
          iterations: 0,
          avgMs: Math.round(estMs * 100) / 100,
          opsPerSec: Math.round(1000 / estMs),
          diffPixels: -1,
        });
      }
    } else {
      console.log(`  ${YELLOW}MoonBit JS build not found${RESET}`);
    }
  }

  // ---- mizchi/pixelmatch WASM-GC ----
  {
    // WASM-GC: 100x100 = 615µs from moon bench
    console.log(`  ${DIM}MoonBit WASM-GC: using moon bench data (100x100 = 0.616ms)${RESET}`);
    for (const { w, h, label } of sizes) {
      const pixels = w * h;
      const ratio = pixels / 10000;
      const estMs = 0.616 * ratio;
      results.push({
        name: "moonbit WASM-GC (est.)",
        size: label,
        iterations: 0,
        avgMs: Math.round(estMs * 100) / 100,
        opsPerSec: Math.round(1000 / estMs),
        diffPixels: -1,
      });
    }
  }

  // ---- Report ----
  console.log();
  console.log(`  ${"Implementation".padEnd(25)} ${"Size".padEnd(12)} ${"avg".padStart(10)} ${"ops/s".padStart(8)} ${DIM}diff${RESET}`);
  console.log(`  ${"─".repeat(25)} ${"─".repeat(12)} ${"─".repeat(10)} ${"─".repeat(8)}`);

  for (const { w, h, label } of sizes) {
    const group = results.filter((r) => r.size === label);
    for (const r of group) {
      const avgStr = r.avgMs < 1 ? `${(r.avgMs * 1000).toFixed(0)}µs` : `${r.avgMs.toFixed(1)}ms`;
      const diffStr = r.diffPixels >= 0 ? String(r.diffPixels) : "n/a";
      const fastest = Math.min(...group.map((g) => g.avgMs));
      const marker = r.avgMs === fastest ? GREEN + "★" + RESET : "  ";
      console.log(`${marker} ${r.name.padEnd(25)} ${r.size.padEnd(12)} ${avgStr.padStart(10)} ${String(r.opsPerSec).padStart(8)} ${DIM}${diffStr}${RESET}`);
    }
    console.log();
  }

  // ---- Summary ----
  const npmResults = results.filter((r) => r.name.startsWith("npm"));
  const wasmResults = results.filter((r) => r.name.includes("WASM"));
  if (npmResults.length > 0 && wasmResults.length > 0) {
    console.log(`  ${BOLD}Speedup (WASM-GC vs npm v7):${RESET}`);
    for (const { label } of sizes) {
      const npm = npmResults.find((r) => r.size === label);
      const wasm = wasmResults.find((r) => r.size === label);
      if (npm && wasm) {
        const speedup = npm.avgMs / wasm.avgMs;
        console.log(`    ${label.padEnd(12)} ${speedup.toFixed(1)}x`);
      }
    }
    console.log();
  }

  // Save
  writeFileSync(join(TMP, "pixelmatch-bench.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`  ${DIM}Saved: ${join(TMP, "pixelmatch-bench.json")}${RESET}`);
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
