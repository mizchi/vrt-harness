/**
 * VLM (Vision Language Model) クライアント
 *
 * 複数プロバイダ対応:
 * - OpenRouter (100+ vision models)
 * - Google AI (Gemini 直接)
 *
 * モデル一覧は API から動的に取得。
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

export async function listModels(options?: { maxCost?: number; limit?: number; includeGemini?: boolean }): Promise<VlmModel[]> {
  const openRouterModels = await fetchVisionModels();
  const models = (options?.includeGemini !== false)
    ? [...GOOGLE_MODELS, ...openRouterModels]
    : openRouterModels;
  // Sort by cost
  models.sort((a, b) => a.promptCostPer1k - b.promptCostPer1k);
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
  // Check Gemini direct models first
  const geminiModel = resolveGeminiModel(idOrIndex);
  if (geminiModel) return geminiModel;

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

// ---- Google AI (Gemini direct) ----

const GOOGLE_MODELS: VlmModel[] = [
  { id: "gemini:gemini-2.5-flash-preview-05-20", name: "Gemini 2.5 Flash (direct)", promptCostPer1k: 1.5e-7, completionCostPer1k: 6e-7, contextLength: 1048576, modality: "text+image->text" },
  { id: "gemini:gemini-2.0-flash", name: "Gemini 2.0 Flash (direct)", promptCostPer1k: 1e-7, completionCostPer1k: 4e-7, contextLength: 1048576, modality: "text+image->text" },
  { id: "gemini:gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite (direct)", promptCostPer1k: 7.5e-8, completionCostPer1k: 3e-7, contextLength: 1048576, modality: "text+image->text" },
];

export function isGeminiDirectModel(id: string): boolean {
  return id.startsWith("gemini:");
}

export function resolveGeminiModel(id: string): VlmModel | undefined {
  return GOOGLE_MODELS.find((m) => m.id === id || m.id === `gemini:${id}`);
}

export function listGeminiModels(): VlmModel[] {
  return [...GOOGLE_MODELS];
}

function createGeminiClient(model: VlmModel, apiKey: string): VlmClient {
  const geminiModelId = model.id.replace("gemini:", "");

  async function callGemini(
    imageBase64: string,
    textPrompt: string,
    maxTokens: number,
  ): Promise<VlmResponse> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({ model: geminiModelId });

    const start = Date.now();
    const result = await genModel.generateContent({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: imageBase64 } },
          { text: textPrompt },
        ],
      }],
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const latencyMs = Date.now() - start;
    const response = result.response;
    const content = response.text();
    const usage = response.usageMetadata;
    const promptTokens = usage?.promptTokenCount ?? 0;
    const completionTokens = usage?.candidatesTokenCount ?? 0;
    const costUsd = (promptTokens / 1000) * model.promptCostPer1k +
                    (completionTokens / 1000) * model.completionCostPer1k;

    return {
      content,
      model: model.id,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      latencyMs,
    };
  }

  return {
    model,
    async analyzeImage(imageBase64, prompt, options) {
      return callGemini(imageBase64, prompt, options?.maxTokens ?? 1024);
    },
    async analyzeImageFile(imagePath, prompt, options) {
      const buf = await readFile(imagePath);
      return this.analyzeImage(buf.toString("base64"), prompt, options);
    },
    async analyzeDiff(baselineBase64, currentBase64, prompt, options) {
      // Gemini supports multiple images in one request
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({ model: geminiModelId });

      const start = Date.now();
      const result = await genModel.generateContent({
        contents: [{
          role: "user",
          parts: [
            { text: "Baseline screenshot:" },
            { inlineData: { mimeType: "image/png", data: baselineBase64 } },
            { text: "Current screenshot:" },
            { inlineData: { mimeType: "image/png", data: currentBase64 } },
            { text: prompt },
          ],
        }],
        generationConfig: { maxOutputTokens: options?.maxTokens ?? 1024 },
      });

      const latencyMs = Date.now() - start;
      const response = result.response;
      const usage = response.usageMetadata;
      const promptTokens = usage?.promptTokenCount ?? 0;
      const completionTokens = usage?.candidatesTokenCount ?? 0;

      return {
        content: response.text(),
        model: model.id,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd: (promptTokens / 1000) * model.promptCostPer1k +
                 (completionTokens / 1000) * model.completionCostPer1k,
        latencyMs,
      };
    },
  };
}

// ---- Client factory ----

export function createVlmClient(
  model: VlmModel,
  apiKey?: string,
): VlmClient | null {
  // Gemini direct
  if (isGeminiDirectModel(model.id)) {
    const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
    if (!key) return null;
    return createGeminiClient(model, key);
  }

  // OpenRouter
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
