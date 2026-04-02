import { basename } from "node:path";
import {
  extractCss,
  parseCssDeclarations,
  replaceCss,
} from "./css-challenge-core.ts";
import type { MigrationDiffCategory } from "./migration-diff.ts";
import type { MigrationFixCandidate } from "./migration-fix-candidates.ts";
import { isPlaywrightSandboxRestrictionError } from "./playwright-launch-error.ts";
import type { ViewportSpec } from "./viewport-discovery.ts";

export interface MigrationCompareReportResult {
  variant: string;
  variantFile?: string;
  viewport: string;
  diffRatio: number;
  diffPixels: number;
  approved?: boolean;
  partiallyApproved?: boolean;
  dominantCategory: MigrationDiffCategory | "none";
  categorySummary: string;
  paintTreeSummary: string;
  paintTreeChangeCount: number;
  fixCandidates: MigrationFixCandidate[];
}

export interface MigrationCompareReport {
  dir?: string;
  baseline: string;
  variants: string[];
  viewports: ViewportSpec[];
  approvalPath?: string;
  strict?: boolean;
  paintTree?: {
    enabled: boolean;
    available: boolean;
    url?: string;
    error?: string;
  };
  results: MigrationCompareReportResult[];
}

export interface MigrationFix {
  selector: string;
  property: string;
  value: string;
  mediaCondition: string | null;
}

export interface SelectedMigrationFixTarget extends MigrationCompareReportResult {
  variantFile: string;
  viewportWidth: number;
}

export type MigrationConvergenceStatus = "clean" | "approved" | "remaining";

export interface MigrationVariantConvergence {
  variant: string;
  totalResults: number;
  cleanResults: number;
  approvedResults: number;
  remainingResults: number;
  status: MigrationConvergenceStatus;
}

export interface MigrationReportConvergence {
  totalResults: number;
  cleanResults: number;
  approvedResults: number;
  remainingResults: number;
  status: MigrationConvergenceStatus;
  variants: MigrationVariantConvergence[];
}

export function selectMigrationFixTarget(
  report: MigrationCompareReport,
  options: { variant?: string } = {},
): SelectedMigrationFixTarget | null {
  const filtered = report.results
    .filter((result) => result.diffPixels > 0)
    .filter((result) => !options.variant || result.variant === options.variant || result.variantFile === options.variant)
    .sort((left, right) => {
      if (right.diffPixels !== left.diffPixels) return right.diffPixels - left.diffPixels;
      if (right.paintTreeChangeCount !== left.paintTreeChangeCount) {
        return right.paintTreeChangeCount - left.paintTreeChangeCount;
      }
      if (right.fixCandidates.length !== left.fixCandidates.length) {
        return right.fixCandidates.length - left.fixCandidates.length;
      }
      return right.diffRatio - left.diffRatio;
    });

  const target = filtered[0];
  if (!target) return null;
  return {
    ...target,
    variantFile: resolveVariantFile(report, target),
    viewportWidth: report.viewports.find((viewport) => viewport.label === target.viewport)?.width ?? 0,
  };
}

export function summarizeMigrationReportConvergence(
  report: MigrationCompareReport,
): MigrationReportConvergence {
  const variants = [...new Set(report.results.map((result) => result.variant))]
    .map((variant) => summarizeMigrationVariantConvergence(
      variant,
      report.results.filter((result) => result.variant === variant),
    ));

  const cleanResults = variants.reduce((sum, variant) => sum + variant.cleanResults, 0);
  const approvedResults = variants.reduce((sum, variant) => sum + variant.approvedResults, 0);
  const remainingResults = variants.reduce((sum, variant) => sum + variant.remainingResults, 0);

  return {
    totalResults: report.results.length,
    cleanResults,
    approvedResults,
    remainingResults,
    status: summarizeConvergenceStatus(cleanResults, approvedResults, remainingResults),
    variants,
  };
}

export function buildMigrationFixLoopPrompt(input: {
  baselineFile: string;
  variantFile: string;
  target: SelectedMigrationFixTarget;
  currentCss: string;
}): string {
  const candidateLines = input.target.fixCandidates.length === 0
    ? ["(no heuristic candidates)"]
    : input.target.fixCandidates.slice(0, 5).map((candidate, index) => {
      const mediaSuffix = candidate.mediaCondition ? ` @media ${candidate.mediaCondition}` : "";
      return `${index + 1}. ${candidate.selector} { ${candidate.property}: ${candidate.value}; }${mediaSuffix} [score=${candidate.score}; ${candidate.reasoning}]`;
    });

  return `You are fixing a CSS migration regression.

Baseline file: ${input.baselineFile}
Current file: ${input.variantFile}
Viewport: ${input.target.viewport} (${input.target.viewportWidth}px)
Diff ratio: ${(input.target.diffRatio * 100).toFixed(2)}%
Diff pixels: ${input.target.diffPixels}
Dominant category: ${input.target.dominantCategory}
Category summary: ${input.target.categorySummary}
Paint tree summary: ${input.target.paintTreeSummary}

Top fix candidates:
${candidateLines.join("\n")}

Current CSS:
\`\`\`css
${input.currentCss}
\`\`\`

Task:
Return exactly one CSS declaration change for the current stylesheet that is most likely to reduce this regression.
Prefer one of the candidate selectors/properties when possible.
If the fix should apply only inside a media query, return the matching media condition.

Respond in this EXACT format:
SELECTOR: <css selector>
PROPERTY: <css property>
VALUE: <css value>
MEDIA: <media condition or none>`;
}

export function parseMigrationFixResponse(response: string): MigrationFix | null {
  const selectorMatch = response.match(/SELECTOR:\s*(.+)/);
  const propertyMatch = response.match(/PROPERTY:\s*(.+)/);
  const valueMatch = response.match(/VALUE:\s*(.+)/);
  if (!selectorMatch || !propertyMatch || !valueMatch) return null;
  const mediaMatch = response.match(/MEDIA:\s*(.+)/);
  const mediaValue = mediaMatch?.[1]?.trim() ?? "none";
  return {
    selector: selectorMatch[1].trim(),
    property: propertyMatch[1].trim(),
    value: valueMatch[1].trim(),
    mediaCondition: mediaValue === "none" ? null : mediaValue,
  };
}

export function resolveMigrationFixFromBaselineHtml(
  baselineHtml: string,
  candidate: Pick<MigrationFixCandidate, "selector" | "property" | "mediaCondition">,
): MigrationFix | null {
  const css = extractCss(baselineHtml);
  if (!css) return null;
  const declaration = parseCssDeclarations(css).find((entry) =>
    entry.selector === candidate.selector
    && entry.property === candidate.property
    && entry.mediaCondition === candidate.mediaCondition
  );
  if (!declaration) return null;
  return {
    selector: declaration.selector,
    property: declaration.property,
    value: declaration.value,
    mediaCondition: declaration.mediaCondition,
  };
}

export function applyMigrationFixToHtml(html: string, fix: MigrationFix): string {
  const css = extractCss(html);
  if (!css) return html;
  const nextCss = applyMigrationFixToCss(css, fix);
  return nextCss === css ? html : replaceCss(html, css, nextCss);
}

export function applyMigrationFixToCss(css: string, fix: MigrationFix): string {
  const lines = css.split("\n");
  let currentMedia: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const mediaMatch = trimmed.match(/^@media\s+(.+?)\s*\{$/);
    if (mediaMatch) {
      currentMedia = mediaMatch[1];
      continue;
    }
    if (trimmed === "}" && currentMedia !== null) {
      currentMedia = null;
      continue;
    }
    const ruleMatch = trimmed.match(/^([^{]+)\{([^}]+)\}\s*$/);
    if (!ruleMatch) continue;
    if (ruleMatch[1].trim() !== fix.selector) continue;
    if ((currentMedia ?? null) !== fix.mediaCondition) continue;

    const body = upsertDeclaration(ruleMatch[2].trim(), fix.property, fix.value);
    const indent = line.match(/^\s*/)?.[0] ?? "";
    lines[index] = `${indent}${fix.selector} { ${body} }`;
    return lines.join("\n");
  }

  return css;
}

export function shouldIgnoreMigrationRerunError(error: unknown): boolean {
  return isPlaywrightSandboxRestrictionError(error);
}

function summarizeMigrationVariantConvergence(
  variant: string,
  results: MigrationCompareReportResult[],
): MigrationVariantConvergence {
  const cleanResults = results.filter((result) => result.diffPixels === 0 && !result.approved).length;
  const approvedResults = results.filter((result) => result.diffPixels === 0 && !!result.approved).length;
  const remainingResults = results.filter((result) => result.diffPixels > 0 || result.partiallyApproved).length;
  return {
    variant,
    totalResults: results.length,
    cleanResults,
    approvedResults,
    remainingResults,
    status: summarizeConvergenceStatus(cleanResults, approvedResults, remainingResults),
  };
}

function summarizeConvergenceStatus(
  cleanResults: number,
  approvedResults: number,
  remainingResults: number,
): MigrationConvergenceStatus {
  if (remainingResults > 0) return "remaining";
  if (approvedResults > 0) return "approved";
  return cleanResults > 0 ? "clean" : "remaining";
}

function resolveVariantFile(
  report: MigrationCompareReport,
  result: MigrationCompareReportResult,
): string {
  if (result.variantFile) return result.variantFile;
  return report.variants.find((variantFile) => basename(variantFile, ".html") === result.variant) ?? result.variant;
}

function upsertDeclaration(body: string, property: string, value: string): string {
  const declarations = body
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let replaced = false;
  const nextDeclarations = declarations.map((entry) => {
    const [entryProperty] = entry.split(":");
    if (entryProperty?.trim() !== property) return entry;
    replaced = true;
    return `${property}: ${value}`;
  });
  if (!replaced) {
    nextDeclarations.push(`${property}: ${value}`);
  }
  return `${nextDeclarations.join("; ")};`;
}
