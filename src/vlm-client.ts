/**
 * VLM (Vision Language Model) クライアント
 *
 * OpenRouter API 経由で画像認識 + reasoning を行う。
 * モデル一覧は OpenRouter API から動的に取得。
 */
import { readFile } from "node:fs/promises";

// ---- Types ----

export interface VlmModel {
  id: string;
  name: string;
  promptCostPer1k: number;
  completionCostPer1k: number;
  contextLength: number;
  modality: string;
}

export interface VlmResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface VlmClient {
  model: VlmModel;
  analyzeImage(imageBase64: string, prompt: string, options?: { maxTokens?: number }): Promise<VlmResponse>;
  analyzeImageFile(imagePath: string, prompt: string, options?: { maxTokens?: number }): Promise<VlmResponse>;
  analyzeDiff(baselineBase64: string, currentBase64: string, prompt: string, options?: { maxTokens?: number }): Promise<VlmResponse>;
}

// ---- Model discovery from OpenRouter API ----

let _cachedModels: VlmModel[] | null = null;

export async function fetchVisionModels(): Promise<VlmModel[]> {
  if (_cachedModels) return _cachedModels;

  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);
  const data = await res.json() as { data: any[] };

  _cachedModels = data.data
    .filter((m: any) => {
      const inputMods = m.architecture?.input_modalities ?? [];
      return inputMods.includes("image");
    })
    .map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      promptCostPer1k: parseFloat(m.pricing?.prompt ?? "999"),
      completionCostPer1k: parseFloat(m.pricing?.completion ?? "999"),
      contextLength: m.context_length ?? 0,
      modality: m.architecture?.modality ?? "",
    }))
    .sort((a: VlmModel, b: VlmModel) => a.promptCostPer1k - b.promptCostPer1k);

  return _cachedModels;
}

export async function listModels(options?: { maxCost?: number; limit?: number }): Promise<VlmModel[]> {
  const models = await fetchVisionModels();
  let filtered = models;
  if (options?.maxCost !== undefined) {
    filtered = filtered.filter((m) => m.promptCostPer1k <= options.maxCost!);
  }
  if (options?.limit) {
    filtered = filtered.slice(0, options.limit);
  }
  return filtered;
}

export async function resolveModel(idOrIndex: string): Promise<VlmModel> {
  const models = await fetchVisionModels();

  // Exact ID match
  const exact = models.find((m) => m.id === idOrIndex);
  if (exact) return exact;

  // Partial match — prefer exact substring, then fuzzy
  const partial = models.filter((m) => m.id.includes(idOrIndex));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    // Prefer shortest match (most specific)
    const sorted = partial.sort((a, b) => a.id.length - b.id.length);
    // If the shortest is a clear prefix match, use it
    if (sorted[0].id.endsWith(idOrIndex) || sorted[0].id.includes(`/${idOrIndex}`)) {
      return sorted[0];
    }
    throw new Error(`Ambiguous model "${idOrIndex}". Matches: ${partial.slice(0, 5).map((m) => m.id).join(", ")}\nTip: use more specific ID, e.g. "${partial[0].id}"`);
  }

  // Numeric index
  const idx = parseInt(idOrIndex, 10);
  if (!isNaN(idx) && idx >= 0 && idx < models.length) return models[idx];

  throw new Error(`Model not found: "${idOrIndex}". Use --list to see available models.`);
}

// ---- Client ----

export function createVlmClient(
  model: VlmModel,
  apiKey?: string,
): VlmClient | null {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  async function callOpenRouter(
    messages: Array<{ role: string; content: any }>,
    maxTokens: number,
  ): Promise<VlmResponse> {
    const start = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/mizchi/vrt-harness",
        "X-Title": "vrt-harness",
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: maxTokens,
        messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const latencyMs = Date.now() - start;
    const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const costUsd = (usage.prompt_tokens / 1000) * model.promptCostPer1k +
                    (usage.completion_tokens / 1000) * model.completionCostPer1k;

    return {
      content: data.choices[0]?.message?.content ?? "",
      model: model.id,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUsd,
      latencyMs,
    };
  }

  return {
    model,

    async analyzeImage(imageBase64, prompt, options) {
      return callOpenRouter([{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: "text", text: prompt },
        ],
      }], options?.maxTokens ?? 1024);
    },

    async analyzeImageFile(imagePath, prompt, options) {
      const buf = await readFile(imagePath);
      return this.analyzeImage(buf.toString("base64"), prompt, options);
    },

    async analyzeDiff(baselineBase64, currentBase64, prompt, options) {
      return callOpenRouter([{
        role: "user",
        content: [
          { type: "text", text: "Baseline screenshot:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${baselineBase64}` } },
          { type: "text", text: "Current screenshot:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${currentBase64}` } },
          { type: "text", text: prompt },
        ],
      }], options?.maxTokens ?? 1024);
    },
  };
}
