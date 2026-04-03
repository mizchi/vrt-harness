#!/usr/bin/env node
/**
 * A11y-Driven Smoke Test Runner
 *
 * アクセシビリティツリーからインタラクティブ要素を列挙し、
 * サイト内に留まる範囲でランダム操作を行い、クラッシュを検出する。
 *
 * Usage:
 *   node --experimental-strip-types src/smoke-runner.ts <url-or-file>
 *   node --experimental-strip-types src/smoke-runner.ts --url https://example.com --max-actions 20
 *   node --experimental-strip-types src/smoke-runner.ts --file fixtures/css-challenge/page.html --seed 42
 */
import { readFile } from "node:fs/promises";
import { chromium, type Page, type Browser } from "playwright";
import type {
  SmokeTestRequest, SmokeTestResponse, SmokeAction, SmokeError,
  A11ySnapshot, A11yNodeCompact, SmokeTestMeta,
} from "./api-types.ts";

// ---- Config ----

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function hasFlag(name: string): boolean { return args.includes(`--${name}`); }

const URL_ARG = getArg("url", "");
const FILE_ARG = getArg("file", args[0] && !args[0].startsWith("--") ? args[0] : "");
const MAX_ACTIONS = parseInt(getArg("max-actions", "30"), 10);
const SEED = parseInt(getArg("seed", String(Date.now())), 10);
const MODE = getArg("mode", "random") as "random" | "reasoning";
const VIEWPORT = { width: 1280, height: 900 };

// ---- Terminal ----

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

// ---- Random ----

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

// ---- A11y tree → action candidates ----

interface ActionCandidate {
  role: string;
  name: string;
  selector: string;
  action: SmokeAction["action"];
  value?: string;
}

const ROLE_ACTION_MAP: Record<string, SmokeAction["action"]> = {
  button: "click",
  link: "click",
  tab: "click",
  menuitem: "click",
  checkbox: "check",
  switch: "check",
  radio: "click",
  textbox: "type",
  searchbox: "type",
  combobox: "click",
};

/** Minimal ARIA yaml → tree parser */
function parseAriaYaml(yaml: string): any {
  if (!yaml) return null;
  const root: any = { role: "document", name: "", children: [] };
  const stack: any[] = [root];
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.search(/\S/);
    const match = line.trim().match(/^-\s+(\w+)\s*(?:"([^"]*)")?/);
    if (!match) continue;
    const [, role, name] = match;
    const node = { role, name: name ?? "", children: [] };
    const depth = Math.floor(indent / 2) + 1;
    while (stack.length > depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

const SAMPLE_INPUTS = [
  "hello", "test@example.com", "12345", "日本語テスト", "",
  "a".repeat(100), "<script>alert(1)</script>", "   ", "null", "undefined",
];

async function discoverActions(page: Page): Promise<ActionCandidate[]> {
  const candidates: ActionCandidate[] = [];

  // Get a11y snapshot
  const snapshot = await page.locator(":root").ariaSnapshot().then((yaml: string) => parseAriaYaml(yaml)).catch(() => null);
  if (!snapshot) return candidates;

  const origin = new URL(page.url()).origin;

  function walk(node: any, path: string) {
    const role = node.role ?? "";
    const name = node.name ?? "";
    const action = ROLE_ACTION_MAP[role];

    if (action) {
      // For links, only allow same-origin
      if (role === "link" && name) {
        // We'll check origin at click time via page routing
        candidates.push({
          role, name,
          selector: `[role="${role}"]`,
          action,
        });
      } else if (role === "textbox" || role === "searchbox") {
        candidates.push({
          role, name,
          selector: name ? `[aria-label="${name}"]` : `${role}`,
          action: "type",
        });
      } else if (name) {
        candidates.push({
          role, name,
          selector: `[role="${role}"]`,
          action,
        });
      }
    }

    for (const child of node.children ?? []) {
      walk(child, `${path} > ${role}`);
    }
  }

  walk(snapshot, "root");
  return candidates;
}

function buildA11ySnapshot(page: Page, step: number): Promise<A11ySnapshot | null> {
  return page.locator(":root").ariaSnapshot().then((yaml: string) => parseAriaYaml(yaml))
    .then((snap) => {
      if (!snap) return null;
      let interactiveCount = 0;
      let landmarkCount = 0;
      const INTERACTIVE = new Set(Object.keys(ROLE_ACTION_MAP));
      const LANDMARKS = new Set(["banner", "main", "navigation", "contentinfo", "complementary", "form", "region", "search"]);

      function walk(node: any): A11yNodeCompact {
        if (INTERACTIVE.has(node.role)) interactiveCount++;
        if (LANDMARKS.has(node.role)) landmarkCount++;
        return {
          role: node.role ?? "",
          name: node.name ?? "",
          children: (node.children ?? []).map(walk),
        };
      }

      const tree = walk(snap);
      return { step, tree, interactiveCount, landmarkCount, issues: [] };
    })
    .catch(() => null);
}

// ---- Runner ----

export async function runSmokeTest(
  request: SmokeTestRequest,
): Promise<SmokeTestResponse> {
  const rand = seededRandom(request.seed ?? Date.now());
  const maxActions = request.maxActions ?? 30;
  const actions: SmokeAction[] = [];
  const errors: SmokeError[] = [];
  const snapshots: A11ySnapshot[] = [];
  const startTime = Date.now();

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    return {
      status: "error",
      actions: [],
      errors: [{ step: 0, type: "crash", message: String(e) }],
      meta: { totalActions: 0, totalErrors: 1, elapsedMs: 0, seed: request.seed, mode: request.mode },
    };
  }

  const page = await browser.newPage({ viewport: VIEWPORT });

  // Block external navigation
  if (request.blockExternalNavigation !== false) {
    const origin = request.target.url
      ? new URL(request.target.url).origin
      : "null"; // data URL origin

    await page.route("**/*", (route) => {
      const url = route.request().url();
      try {
        const reqOrigin = new URL(url).origin;
        if (reqOrigin !== origin && reqOrigin !== "null" && !url.startsWith("data:")) {
          route.abort("blockedbyclient");
          return;
        }
      } catch { /* allow */ }
      route.continue();
    });
  }

  // Collect console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push({
        step: actions.length,
        type: "console-error",
        message: msg.text(),
      });
    }
  });

  page.on("pageerror", (err) => {
    errors.push({
      step: actions.length,
      type: "uncaught-exception",
      message: err.message,
      stack: err.stack,
    });
  });

  // Load page
  try {
    if (request.target.url) {
      await page.goto(request.target.url, { waitUntil: "networkidle", timeout: 30000 });
    } else if (request.target.html) {
      await page.setContent(request.target.html, { waitUntil: "networkidle" });
    }
  } catch (e) {
    errors.push({ step: 0, type: "crash", message: `Failed to load: ${e}` });
    await browser.close();
    return {
      status: "crash", actions, errors,
      meta: { totalActions: 0, totalErrors: errors.length, elapsedMs: Date.now() - startTime, seed: request.seed, mode: request.mode },
    };
  }

  // Initial snapshot
  const initialSnap = await buildA11ySnapshot(page, 0);
  if (initialSnap) snapshots.push(initialSnap);

  // LLM reasoning mode: pre-generate action plan
  let plannedActions: ActionCandidate[] | null = null;
  if (request.mode === "reasoning") {
    const { createLLMProvider } = await import("./llm-client.ts");
    const llm = createLLMProvider();
    if (llm && initialSnap) {
      try {
        const candidates = await discoverActions(page);
        const candidateList = candidates.map((c) => `- ${c.action} ${c.role}: "${c.name}"`).join("\n");
        const prompt = `You are testing a web page by interacting with it like a real user.

Available interactive elements:
${candidateList}

Generate a realistic user interaction sequence (${maxActions} steps).
Each step should be a natural user action (e.g., fill a form, navigate, toggle settings).

Respond with one action per line in this EXACT format:
ACTION: <click|type|check|uncheck> ROLE: <role> NAME: <name> VALUE: <optional value for type>

Example:
ACTION: type ROLE: textbox NAME: Email VALUE: test@example.com
ACTION: click ROLE: button NAME: Submit`;

        const response = await llm.complete(prompt);
        plannedActions = [];
        for (const line of response.split("\n")) {
          const m = line.match(/ACTION:\s*(\w+)\s+ROLE:\s*(\w+)\s+NAME:\s*(.+?)(?:\s+VALUE:\s*(.+))?$/);
          if (m) {
            plannedActions.push({
              role: m[2],
              name: m[3].trim(),
              selector: "",
              action: m[1] as SmokeAction["action"],
              value: m[4]?.trim(),
            });
          }
        }
      } catch { /* fallback to random */ }
    }
  }

  // Action loop
  for (let step = 0; step < maxActions; step++) {
    let candidate: ActionCandidate;

    if (plannedActions && step < plannedActions.length) {
      // LLM reasoning mode: follow the plan
      candidate = plannedActions[step];
    } else {
      // Random mode: discover and pick
      const candidates = await discoverActions(page);
      if (candidates.length === 0) break;
      candidate = candidates[Math.floor(rand() * candidates.length)];
    }
    const actionStart = Date.now();
    let result: SmokeAction["result"] = "ok";

    try {
      // Find element by accessible name + role
      const locator = page.getByRole(candidate.role as any, { name: candidate.name }).first();
      const isVisible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
      if (!isVisible) {
        result = "timeout";
      } else if (await locator.isDisabled({ timeout: 500 }).catch(() => false)) {
        result = "timeout"; // skip disabled elements
      } else {
        switch (candidate.action) {
          case "click":
            await locator.click({ timeout: 3000 });
            break;
          case "type": {
            const value = SAMPLE_INPUTS[Math.floor(rand() * SAMPLE_INPUTS.length)];
            candidate.value = value;
            await locator.fill(value).catch(() => locator.click());
            break;
          }
          case "check":
            await locator.check({ timeout: 2000 }).catch(() => locator.click());
            break;
          case "uncheck":
            await locator.uncheck({ timeout: 2000 }).catch(() => locator.click());
            break;
          case "hover":
            await locator.hover({ timeout: 1000 });
            break;
          default:
            await locator.click({ timeout: 3000 });
        }

        // Wait for page to settle
        await page.waitForTimeout(200);
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("navigation")) {
        result = "navigation";
      } else if (msg.includes("timeout") || msg.includes("Timeout")) {
        result = "timeout";
      } else {
        result = "error";
        errors.push({ step, type: "uncaught-exception", message: msg });
      }
    }

    actions.push({
      step,
      target: { role: candidate.role, name: candidate.name },
      action: candidate.action,
      value: candidate.value,
      result,
      elapsedMs: Date.now() - actionStart,
    });

    // Periodic a11y snapshot
    if (step % 5 === 0 || result === "error") {
      const snap = await buildA11ySnapshot(page, step + 1);
      if (snap) snapshots.push(snap);
    }

    // Check if page crashed
    try {
      await page.title();
    } catch {
      errors.push({ step, type: "crash", message: "Page became unresponsive" });
      break;
    }
  }

  // Final snapshot
  const finalSnap = await buildA11ySnapshot(page, actions.length);
  if (finalSnap) snapshots.push(finalSnap);

  await browser.close();

  const hasCrash = errors.some((e) => e.type === "crash");
  const status = hasCrash ? "crash" : errors.length > 0 ? "error" : "pass";

  return {
    status,
    actions,
    errors,
    snapshots,
    meta: {
      totalActions: actions.length,
      totalErrors: errors.length,
      elapsedMs: Date.now() - startTime,
      seed: request.seed,
      mode: request.mode,
    },
  };
}

// ---- CLI ----

async function main() {
  if (!URL_ARG && !FILE_ARG) {
    console.log("Usage: node --experimental-strip-types src/smoke-runner.ts <file-or-url>");
    console.log("       node --experimental-strip-types src/smoke-runner.ts --url https://example.com --max-actions 20");
    console.log("       node --experimental-strip-types src/smoke-runner.ts --file page.html --seed 42");
    process.exit(1);
  }

  const target: SmokeTestRequest["target"] = {};
  if (URL_ARG) {
    target.url = URL_ARG;
    target.label = URL_ARG;
  } else {
    target.html = await readFile(FILE_ARG, "utf-8");
    target.label = FILE_ARG;
  }

  console.log();
  console.log(`${BOLD}${CYAN}A11y-Driven Smoke Test${RESET}`);
  console.log(`  ${DIM}Target: ${target.label}${RESET}`);
  console.log(`  ${DIM}Max actions: ${MAX_ACTIONS} | Seed: ${SEED}${RESET}`);
  console.log();

  const result = await runSmokeTest({
    target,
    mode: MODE,
    maxActions: MAX_ACTIONS,
    seed: SEED,
    blockExternalNavigation: true,
  });

  // Print actions
  for (const action of result.actions) {
    const icon = action.result === "ok" ? `${GREEN}✓${RESET}`
      : action.result === "navigation" ? `${CYAN}→${RESET}`
      : action.result === "timeout" ? `${YELLOW}⏱${RESET}`
      : `${RED}✗${RESET}`;
    const valueStr = action.value ? ` "${action.value}"` : "";
    console.log(`  ${icon} [${String(action.step + 1).padStart(2)}] ${action.action} ${action.target.role}:${action.target.name}${valueStr} ${DIM}${action.elapsedMs}ms${RESET}`);
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log();
    console.log(`  ${RED}${BOLD}Errors (${result.errors.length}):${RESET}`);
    for (const err of result.errors) {
      console.log(`    ${RED}[step ${err.step}] ${err.type}: ${err.message.slice(0, 120)}${RESET}`);
    }
  }

  // Summary
  console.log();
  console.log(`  ${BOLD}Result: ${result.status === "pass" ? GREEN : RED}${result.status.toUpperCase()}${RESET}`);
  console.log(`  ${DIM}Actions: ${result.meta.totalActions} | Errors: ${result.meta.totalErrors} | Time: ${result.meta.elapsedMs}ms${RESET}`);
  console.log();

  process.exit(result.status === "pass" ? 0 : 1);
}

// Run CLI only when executed directly
if (process.argv[1]?.endsWith("smoke-runner.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
