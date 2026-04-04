/**
 * VRT Reasoning Pipeline — 2段階 VLM + LLM パイプライン
 *
 * Stage 1 (VLM, 安い): heatmap/スクリーンショット → 構造化 diff レポート
 * Stage 2 (LLM, 高い): 構造化レポート + CSS ソース → 修正コード生成
 *
 * Usage:
 *   const pipeline = createReasoningPipeline();
 *   const analysis = await pipeline.analyze(heatmapBase64, textReport);
 *   const fix = await pipeline.suggestFix(analysis, cssSource);
 */
import { createUnifiedLLMClient, type UnifiedLLMClient, type LLMResponse } from "./llm-client.ts";
import { createVlmClient, resolveModel, type VlmClient, type VlmResponse } from "./vlm-client.ts";

// ---- Types ----

export interface VisualChange {
  element: string;
  property: string;
  before: string;
  after: string;
  severity: "low" | "medium" | "high";
}

export interface StructuredDiffReport {
  changes: VisualChange[];
  summary: string;
  regression: boolean;
  raw: string;
  vlmModel: string;
  vlmLatencyMs: number;
  vlmCostUsd: number;
}

export interface CssFix {
  selector: string;
  property: string;
  value: string;
  reason: string;
}

export interface FixSuggestion {
  fixes: CssFix[];
  explanation: string;
  confidence: "high" | "medium" | "low";
  raw: string;
  llmModel: string;
  llmLatencyMs: number;
  llmCostUsd: number;
}

export interface PipelineConfig {
  /** Stage 1: VLM for image analysis (default: qwen3-vl-8b via OpenRouter) */
  vlmModel?: string;
  /** Stage 2: LLM for code generation (default: from VRT_LLM_PROVIDER) */
  llmProvider?: "gemini" | "anthropic" | "openrouter";
  llmModel?: string;
}

export interface ReasoningPipeline {
  /** Stage 1: 画像 → 構造化 diff */
  analyze(options: {
    heatmapBase64?: string;
    baselineBase64?: string;
    currentBase64?: string;
    textReport?: string;
  }): Promise<StructuredDiffReport>;

  /** Stage 2: 構造化 diff + CSS → 修正提案 */
  suggestFix(report: StructuredDiffReport, cssSource: string): Promise<FixSuggestion>;

  /** Stage 1 + 2 を連続実行 */
  analyzeAndFix(options: {
    heatmapBase64?: string;
    baselineBase64?: string;
    currentBase64?: string;
    textReport?: string;
    cssSource: string;
  }): Promise<{ analysis: StructuredDiffReport; fix: FixSuggestion }>;

  vlmModel: string;
  llmModel: string;
}

// ---- Stage 1 prompt ----

const STAGE1_PROMPT = `You are analyzing a VRT (Visual Regression Testing) diff image. The red/pink areas in the heatmap show WHERE pixels differ, NOT the actual colors of the elements.

IMPORTANT: Red in the heatmap means "this area changed" — it does NOT mean the element is red. You must infer the actual CSS values from the element context, not from the heatmap color.

For each visual change, output ONE line in this EXACT format:
CHANGE: [element] | [css-property] | [before-value] | [after-value] | [severity:low/medium/high]

Example:
CHANGE: h1 heading | color | #333333 | #111111 | low
CHANGE: .card | padding | 16px | 12px | medium
CHANGE: .card | background-color | #f0f0f0 | #eff6ff | medium
CHANGE: table header | text-transform | none | uppercase | high

Rules:
- Do NOT repeat the same element+property combination.
- Do NOT confuse heatmap red with actual CSS colors.
- Use approximate CSS values based on visual appearance.

After all changes, add:
SUMMARY: <one sentence describing the overall change>
REGRESSION: <yes/no>`;

// ---- Stage 2 prompt ----

function buildStage2Prompt(report: StructuredDiffReport, cssSource: string): string {
  const changeList = report.changes
    .map((c) => `- ${c.element}: ${c.property} changed from "${c.before}" to "${c.after}" (${c.severity})`)
    .join("\n");

  return `You are fixing CSS to match a target visual appearance. A VRT analysis found these differences:

## Visual Changes Detected
${changeList}

Summary: ${report.summary}

## Current CSS
\`\`\`css
${cssSource}
\`\`\`

## Task
Provide CSS fixes to make the current page match the baseline. For each fix, output ONE line in this format:
FIX: [selector] | [property] | [value] | [reason]

Example:
FIX: h1 | color | #333333 | Restore original heading color
FIX: .card | padding | 16px | Restore card padding from 12px to 16px

After all fixes, add:
EXPLANATION: <brief explanation of the root cause>
CONFIDENCE: <high/medium/low>

Only suggest fixes for actual differences. Be precise with CSS values.`;
}

// ---- Parser ----

function parseStage1Response(raw: string): { changes: VisualChange[]; summary: string; regression: boolean } {
  const changes: VisualChange[] = [];
  const seen = new Set<string>();
  let summary = "";
  let regression = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    const changeMatch = trimmed.match(/^CHANGE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(low|medium|high)/i);
    if (changeMatch) {
      const key = `${changeMatch[1].trim()}|${changeMatch[2].trim()}`;
      if (seen.has(key)) continue; // deduplicate
      seen.add(key);
      changes.push({
        element: changeMatch[1].trim(),
        property: changeMatch[2].trim(),
        before: changeMatch[3].trim(),
        after: changeMatch[4].trim(),
        severity: changeMatch[5].toLowerCase() as VisualChange["severity"],
      });
      continue;
    }

    const summaryMatch = trimmed.match(/^SUMMARY:\s*(.+)/i);
    if (summaryMatch) { summary = summaryMatch[1].trim(); continue; }

    const regressionMatch = trimmed.match(/^REGRESSION:\s*(yes|no)/i);
    if (regressionMatch) { regression = regressionMatch[1].toLowerCase() === "yes"; }
  }

  return { changes, summary, regression };
}

function parseStage2Response(raw: string): { fixes: CssFix[]; explanation: string; confidence: FixSuggestion["confidence"] } {
  const fixes: CssFix[] = [];
  let explanation = "";
  let confidence: FixSuggestion["confidence"] = "medium";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    const fixMatch = trimmed.match(/^FIX:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)/i);
    if (fixMatch) {
      fixes.push({
        selector: fixMatch[1].trim(),
        property: fixMatch[2].trim(),
        value: fixMatch[3].trim(),
        reason: fixMatch[4].trim(),
      });
      continue;
    }

    const explMatch = trimmed.match(/^EXPLANATION:\s*(.+)/i);
    if (explMatch) { explanation = explMatch[1].trim(); continue; }

    const confMatch = trimmed.match(/^CONFIDENCE:\s*(high|medium|low)/i);
    if (confMatch) { confidence = confMatch[1].toLowerCase() as FixSuggestion["confidence"]; }
  }

  return { fixes, explanation, confidence };
}

// ---- Pipeline factory ----

export function createReasoningPipeline(config?: PipelineConfig): ReasoningPipeline | null {
  // Stage 1: VLM
  let vlmClient: VlmClient | null = null;
  let vlmModelId = config?.vlmModel ?? process.env.VRT_VLM_MODEL ?? "qwen/qwen3-vl-8b-instruct";

  // Stage 2: LLM (try configured, then fallback)
  let llmClient = createUnifiedLLMClient({
    provider: config?.llmProvider,
    model: config?.llmModel,
  });
  if (!llmClient) {
    // Fallback: try each provider
    for (const provider of ["gemini", "anthropic", "openrouter"] as const) {
      llmClient = createUnifiedLLMClient({ provider });
      if (llmClient) break;
    }
  }

  // Need at least VLM or LLM
  if (!llmClient && !process.env.OPENROUTER_API_KEY) return null;

  return {
    vlmModel: vlmModelId,
    llmModel: llmClient?.model ?? "none",

    async analyze(options) {
      // Lazy init VLM client
      if (!vlmClient) {
        try {
          const model = await resolveModel(vlmModelId);
          vlmClient = createVlmClient(model);
        } catch {
          vlmClient = null;
        }
      }

      if (!vlmClient) {
        // Fallback: use LLM with text-only report
        if (!llmClient) throw new Error("No VLM or LLM available");
        const resp = await llmClient.completeWithImages(
          options.textReport ?? "No visual data available",
          { maxTokens: 1024 },
        );
        const parsed = parseStage1Response(resp.content);
        return {
          ...parsed,
          raw: resp.content,
          vlmModel: resp.model,
          vlmLatencyMs: resp.latencyMs,
          vlmCostUsd: resp.costUsd,
        };
      }

      // Build image prompt
      let imageBase64: string | null = null;
      if (options.heatmapBase64) imageBase64 = options.heatmapBase64;
      else if (options.currentBase64) imageBase64 = options.currentBase64;

      let prompt = STAGE1_PROMPT;
      if (options.textReport) {
        prompt += `\n\nAdditional context from VRT pipeline:\n${options.textReport}`;
      }

      let resp: VlmResponse;
      if (imageBase64) {
        resp = await vlmClient.analyzeImage(imageBase64, prompt, { maxTokens: 1024 });
      } else {
        // Text-only fallback for VLM
        throw new Error("No image data provided for VLM analysis");
      }

      const parsed = parseStage1Response(resp.content);
      return {
        ...parsed,
        raw: resp.content,
        vlmModel: resp.model,
        vlmLatencyMs: resp.latencyMs,
        vlmCostUsd: resp.costUsd,
      };
    },

    async suggestFix(report, cssSource) {
      if (!llmClient) throw new Error("No LLM available for Stage 2");

      const prompt = buildStage2Prompt(report, cssSource);
      const resp = await llmClient.completeWithImages(prompt, { maxTokens: 2048 });
      const parsed = parseStage2Response(resp.content);

      return {
        ...parsed,
        raw: resp.content,
        llmModel: resp.model,
        llmLatencyMs: resp.latencyMs,
        llmCostUsd: resp.costUsd,
      };
    },

    async analyzeAndFix(options) {
      const analysis = await this.analyze(options);
      const fix = await this.suggestFix(analysis, options.cssSource);
      return { analysis, fix };
    },
  };
}
