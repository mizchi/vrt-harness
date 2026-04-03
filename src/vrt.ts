#!/usr/bin/env node
/**
 * vrt — 統一 CLI エントリポイント
 *
 * Usage:
 *   vrt compare <before> <after> [options]
 *   vrt bench [options]
 *   vrt report
 *   vrt discover <file>
 *   vrt smoke <file-or-url> [options]
 *   vrt serve [--port 3456]
 *   vrt status [--url http://localhost:3456]
 */

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

async function main() {
  switch (command) {
    case "compare":
      process.argv = [process.argv[0], "migration-compare", ...rest];
      await import("./migration-compare.ts");
      break;
    case "bench":
      process.argv = [process.argv[0], "css-challenge-bench", ...rest];
      await import("./css-challenge-bench.ts");
      break;
    case "report":
      await import("./detection-report.ts");
      break;
    case "discover":
      await runDiscover(rest);
      break;
    case "smoke":
      process.argv = [process.argv[0], "smoke-runner", ...rest];
      await import("./smoke-runner.ts");
      break;
    case "serve":
      process.argv = [process.argv[0], "api-server", ...rest];
      await import("./api-server.ts");
      break;
    case "status":
      await runStatus(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      if (command) console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function runDiscover(args: string[]) {
  const file = args[0];
  if (!file) { console.error("Usage: vrt discover <html-file>"); process.exit(1); }

  const { readFile } = await import("node:fs/promises");
  const { discoverViewports } = await import("./viewport-discovery.ts");
  const html = await readFile(file, "utf-8");
  const result = discoverViewports(html, { randomSamples: 1, maxViewports: 15 });

  console.log();
  console.log(`\x1b[1m\x1b[36mBreakpoint Discovery\x1b[0m  \x1b[2m${file}\x1b[0m`);
  console.log();
  if (result.breakpoints.length > 0) {
    console.log(`  \x1b[1mBreakpoints:\x1b[0m`);
    for (const bp of result.breakpoints) console.log(`    ${bp.type}: ${bp.value}px  \x1b[2m${bp.raw}\x1b[0m`);
    console.log();
  }
  console.log(`  \x1b[1mViewports (${result.viewports.length}):\x1b[0m`);
  for (const vp of result.viewports) console.log(`    ${String(vp.width).padStart(5)}px  ${vp.label.padEnd(16)} \x1b[2m${vp.reason}\x1b[0m`);
  console.log();
}

async function runStatus(args: string[]) {
  const url = args.find((_, i) => args[i - 1] === "--url") ?? "http://localhost:3456";
  try {
    const res = await fetch(`${url}/api/status`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Server not available at ${url}`);
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
\x1b[1mvrt\x1b[0m — Visual Regression Testing Harness

\x1b[1mCommands:\x1b[0m
  compare <before> <after>    Compare HTML files across viewports
  bench [options]             CSS challenge benchmark
  report                      Detection pattern report
  discover <file>             Discover breakpoints from HTML/CSS
  smoke <file-or-url>         A11y-driven smoke test
  serve [--port N]            Start API server
  status [--url URL]          Check API server status

\x1b[1mExamples:\x1b[0m
  vrt compare before.html after.html
  vrt compare --dir fixtures/migration/reset-css --baseline normalize.html --variants modern.html destyle.html
  vrt bench --fixture page --trials 30
  vrt bench --mode selector --backend crater
  vrt discover page.html
  vrt smoke page.html --max-actions 20 --seed 42
  vrt smoke --url https://example.com --mode reasoning
  vrt serve --port 3456
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
