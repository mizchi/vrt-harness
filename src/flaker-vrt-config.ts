import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_BIDI_URL } from "./crater-client.ts";
import type { ViewportSpec } from "./viewport-discovery.ts";

export const DEFAULT_FLAKER_VRT_CONFIG_FILE = "flaker.vrt.json";

export interface FlakerVrtViewport {
  width: number;
  height: number;
  label: string;
  reason?: string;
}

export interface FlakerVrtMigrationScenario {
  id: string;
  kind: "migration";
  dir: string;
  baseline: string;
  variants: string[];
  approval?: string;
  backend: "chromium";
  viewports: FlakerVrtViewport[];
  strict: boolean;
  enablePaintTree: boolean;
  paintTreeUrl: string;
}

export interface FlakerVrtConfig {
  scenarios: FlakerVrtMigrationScenario[];
}

export function resolveFlakerVrtConfigPath(
  cwd: string,
  configPath = DEFAULT_FLAKER_VRT_CONFIG_FILE,
): string {
  return resolve(cwd, configPath);
}

export async function loadFlakerVrtConfig(opts: {
  cwd: string;
  configPath?: string;
}): Promise<FlakerVrtConfig> {
  const path = resolveFlakerVrtConfigPath(opts.cwd, opts.configPath);
  return parseFlakerVrtConfig(await readFile(path, "utf-8"));
}

export function parseFlakerVrtConfig(raw: string): FlakerVrtConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid flaker VRT config JSON: ${String(error)}`);
  }
  return validateFlakerVrtConfig(parsed);
}

export function validateFlakerVrtConfig(value: unknown): FlakerVrtConfig {
  const record = asRecord(value, "flaker.vrt.json must be an object");
  if (!Array.isArray(record.scenarios)) {
    throw new Error("flaker.vrt.json must have a scenarios array");
  }

  const seenScenarioIds = new Set<string>();
  const scenarios = record.scenarios.map((scenario, index) => {
    const validated = validateMigrationScenario(scenario, index);
    if (seenScenarioIds.has(validated.id)) {
      throw new Error(`Duplicate scenario id: ${validated.id}`);
    }
    seenScenarioIds.add(validated.id);
    return validated;
  });

  return { scenarios };
}

export function toViewportSpec(viewport: FlakerVrtViewport): ViewportSpec {
  return {
    width: viewport.width,
    height: viewport.height,
    label: viewport.label,
    reason: viewport.reason ?? "configured",
  };
}

function validateMigrationScenario(
  value: unknown,
  index: number,
): FlakerVrtMigrationScenario {
  const record = asRecord(value, `Scenario at index ${index} must be an object`);
  const id = requireString(record.id, `Scenario at index ${index} must have an id`);
  const kind = requireString(record.kind, `Scenario ${id} must have a kind`);
  if (kind !== "migration") {
    throw new Error(`Scenario ${id} has unsupported kind: ${kind}`);
  }

  const dir = requireString(record.dir, `Scenario ${id} must have a dir`);
  const baseline = requireString(record.baseline, `Scenario ${id} must have a baseline`);
  const variants = requireStringArray(record.variants, `Scenario ${id} must have a variants array`);
  if (variants.length === 0) {
    throw new Error(`Scenario ${id} must define at least one variant`);
  }

  const backend = record.backend == null
    ? "chromium"
    : requireString(record.backend, `Scenario ${id} has an invalid backend`);
  if (backend !== "chromium") {
    throw new Error(`Scenario ${id} has unsupported backend: ${backend}`);
  }

  const viewports = validateViewports(record.viewports, id);
  const strict = record.strict == null ? false : requireBoolean(record.strict, `Scenario ${id} has an invalid strict flag`);
  const enablePaintTree = record.enablePaintTree == null
    ? true
    : requireBoolean(record.enablePaintTree, `Scenario ${id} has an invalid enablePaintTree flag`);
  const approval = optionalString(record.approval, `Scenario ${id} has an invalid approval path`);
  const paintTreeUrl = record.paintTreeUrl == null
    ? DEFAULT_BIDI_URL
    : requireString(record.paintTreeUrl, `Scenario ${id} has an invalid paintTreeUrl`);

  return {
    id,
    kind,
    dir,
    baseline,
    variants,
    ...(approval ? { approval } : {}),
    backend,
    viewports,
    strict,
    enablePaintTree,
    paintTreeUrl,
  };
}

function validateViewports(value: unknown, scenarioId: string): FlakerVrtViewport[] {
  if (!Array.isArray(value)) {
    throw new Error(`Scenario ${scenarioId} must have a viewports array`);
  }
  if (value.length === 0) {
    throw new Error(`Scenario ${scenarioId} must define at least one viewport`);
  }

  const seenLabels = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `Scenario ${scenarioId} viewport at index ${index} must be an object`);
    const label = requireString(record.label, `Scenario ${scenarioId} viewport at index ${index} must have a label`);
    if (seenLabels.has(label)) {
      throw new Error(`Scenario ${scenarioId} has duplicate viewport label: ${label}`);
    }
    seenLabels.add(label);

    const width = requirePositiveNumber(record.width, `Scenario ${scenarioId} viewport ${label} must have a positive width`);
    const height = requirePositiveNumber(record.height, `Scenario ${scenarioId} viewport ${label} must have a positive height`);
    const reason = optionalString(record.reason, `Scenario ${scenarioId} viewport ${label} has an invalid reason`);

    return {
      width,
      height,
      label,
      ...(reason ? { reason } : {}),
    };
  });
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value == null) return undefined;
  return requireString(value, message);
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(message);
  }
  return value;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
  return value;
}

function requirePositiveNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}
