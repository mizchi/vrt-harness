#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MigrationCompareReport } from "./migration-compare.ts";
import {
  convertMigrationReportToFlakerResults,
  inferFlakerScenarioIdFromReport,
  type FlakerVrtBackend,
} from "./flaker-vrt-results.ts";

export interface FlakerVrtReportAdapterArgs {
  filePath?: string;
  scenarioId?: string;
  backend: FlakerVrtBackend;
  cwd?: string;
}

export function parseFlakerVrtReportAdapterArgs(
  args: string[],
): FlakerVrtReportAdapterArgs {
  return {
    filePath: getArg(args, "file"),
    scenarioId: getArg(args, "scenario-id"),
    backend: (getArg(args, "backend") as FlakerVrtBackend | undefined) ?? "chromium",
    cwd: getArg(args, "cwd"),
  };
}

export function adaptMigrationReportToFlakerResults(input: {
  report: MigrationCompareReport;
  cwd?: string;
  scenarioId?: string;
  backend?: FlakerVrtBackend;
}): ReturnType<typeof convertMigrationReportToFlakerResults> {
  const cwd = input.cwd ?? process.cwd();
  return convertMigrationReportToFlakerResults({
    report: input.report,
    cwd,
    scenarioId: input.scenarioId ?? inferFlakerScenarioIdFromReport(input.report),
    backend: input.backend ?? "chromium",
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const args = parseFlakerVrtReportAdapterArgs(process.argv.slice(2));
  const raw = args.filePath
    ? await readFile(resolve(args.cwd ?? process.cwd(), args.filePath), "utf-8")
    : await readAllStdin();
  const report = JSON.parse(raw) as MigrationCompareReport;
  const results = adaptMigrationReportToFlakerResults({
    report,
    cwd: args.cwd,
    scenarioId: args.scenarioId,
    backend: args.backend,
  });
  console.log(JSON.stringify(results));
}

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === new URL(`file://${invokedPath}`).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
