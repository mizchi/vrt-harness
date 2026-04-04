/**
 * 統合 LLM クライアント
 *
 * テキスト + 画像の両方に対応。プロバイダ優先順:
 * 1. Anthropic (ANTHROPIC_API_KEY) — テキスト + vision
 * 2. Gemini (GEMINI_API_KEY) — テキスト + vision
 * 3. OpenRouter (OPENROUTER_API_KEY) — テキスト + vision
 *
 * 既存の LLMProvider インターフェースとの後方互換性あり。
 */
import type { LLMProvider } from "./intent.ts";

// ---- Types ----

export interface LLMClientOptions {
  /** 画像対応が必要か */
  vision?: boolean;
  /** 最大トークン */
  maxTokens?: number;
  /** 特定のプロバイダを指定 */
  provider?: "anthropic" | "gemini" | "openrouter";
  /** 特定のモデルを指定 */
  model?: string;
}

export interface ImageContent {
  type: "image";
  base64: string;
  mimeType?: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MessageContent = string | Array<TextContent | ImageContent>;

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface UnifiedLLMClient {
  /** テキスト only (後方互換) */
  complete(prompt: string): Promise<string>;
  /** テキスト + 画像 */
  completeWithImages(content: MessageContent, options?: { maxTokens?: number }): Promise<LLMResponse>;
  /** VRT diff 分析特化: heatmap + テキストレポートを同時に渡す */
  analyzeDiff(options: {
    heatmapBase64?: string;
    baselineBase64?: string;
    currentBase64?: string;
    textReport: string;
    prompt?: string;
    maxTokens?: number;
  }): Promise<LLMResponse>;

  provider: string;
  model: string;
}

// ---- Anthropic ----

function createAnthropicClient(apiKey: string, model?: string): UnifiedLLMClient {
  const modelId = model ?? "claude-sonnet-4-20250514";

  async function call(content: MessageContent, maxTokens: number): Promise<LLMResponse> {
    const start = Date.now();

    // Build messages
    let messageContent: any;
    if (typeof content === "string") {
      messageContent = content;
    } else {
      messageContent = content.map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        return {
          type: "image",
          source: { type: "base64", media_type: c.mimeType ?? "image/png", data: c.base64 },
        };
      });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: messageContent }],
      }),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Anthropic API error: ${res.status} ${body}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const latencyMs = Date.now() - start;
    const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;

    return {
      content: text,
      model: modelId,
      provider: "anthropic",
      promptTokens,
      completionTokens,
      costUsd: 0, // Anthropic pricing varies, skip for now
      latencyMs,
    };
  }

  return {
    provider: "anthropic",
    model: modelId,
    async complete(prompt) { return (await call(prompt, 1024)).content; },
    async completeWithImages(content, options) { return call(content, options?.maxTokens ?? 1024); },
    async analyzeDiff(options) { return call(buildDiffContent(options), options.maxTokens ?? 1024); },
  };
}

// ---- Gemini ----

function createGeminiLLMClient(apiKey: string, model?: string): UnifiedLLMClient {
  const modelId = model ?? "gemini-2.5-flash-preview-05-20";

  async function call(content: MessageContent, maxTokens: number): Promise<LLMResponse> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({ model: modelId });
    const start = Date.now();

    let parts: any[];
    if (typeof content === "string") {
      parts = [{ text: content }];
    } else {
      parts = content.map((c) => {
        if (c.type === "text") return { text: c.text };
        return { inlineData: { mimeType: c.mimeType ?? "image/png", data: c.base64 } };
      });
    }

    const result = await genModel.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    });

    const latencyMs = Date.now() - start;
    const response = result.response;
    const usage = response.usageMetadata;

    return {
      content: response.text(),
      model: modelId,
      provider: "gemini",
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      costUsd: 0,
      latencyMs,
    };
  }

  return {
    provider: "gemini",
    model: modelId,
    async complete(prompt) { return (await call(prompt, 1024)).content; },
    async completeWithImages(content, options) { return call(content, options?.maxTokens ?? 1024); },
    async analyzeDiff(options) { return call(buildDiffContent(options), options.maxTokens ?? 1024); },
  };
}

// ---- OpenRouter ----

function createOpenRouterLLMClient(apiKey: string, model?: string): UnifiedLLMClient {
  const modelId = model ?? "qwen/qwen3-vl-8b-instruct";

  async function call(content: MessageContent, maxTokens: number): Promise<LLMResponse> {
    const start = Date.now();

    let messageContent: any;
    if (typeof content === "string") {
      messageContent = content;
    } else {
      messageContent = content.map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        return { type: "image_url", image_url: { url: `data:${c.mimeType ?? "image/png"};base64,${c.base64}` } };
      });
    }

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/mizchi/vrt-harness",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: messageContent }],
      }),
    });

    if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const latencyMs = Date.now() - start;
    return {
      content: data.choices[0]?.message?.content ?? "",
      model: modelId,
      provider: "openrouter",
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      costUsd: 0,
      latencyMs,
    };
  }

  return {
    provider: "openrouter",
    model: modelId,
    async complete(prompt) { return (await call(prompt, 1024)).content; },
    async completeWithImages(content, options) { return call(content, options?.maxTokens ?? 1024); },
    async analyzeDiff(options) { return call(buildDiffContent(options), options.maxTokens ?? 1024); },
  };
}

// ---- Diff content builder ----

function buildDiffContent(options: {
  heatmapBase64?: string;
  baselineBase64?: string;
  currentBase64?: string;
  textReport: string;
  prompt?: string;
}): MessageContent {
  const parts: Array<TextContent | ImageContent> = [];

  if (options.baselineBase64) {
    parts.push({ type: "text", text: "Baseline screenshot:" });
    parts.push({ type: "image", base64: options.baselineBase64 });
  }
  if (options.currentBase64) {
    parts.push({ type: "text", text: "Current screenshot:" });
    parts.push({ type: "image", base64: options.currentBase64 });
  }
  if (options.heatmapBase64) {
    parts.push({ type: "text", text: "Diff heatmap (red = changed pixels):" });
    parts.push({ type: "image", base64: options.heatmapBase64 });
  }

  parts.push({ type: "text", text: options.textReport });

  if (options.prompt) {
    parts.push({ type: "text", text: options.prompt });
  }

  return parts;
}

// ---- Factory ----

export type LLMProviderName = "gemini" | "anthropic" | "openrouter";

/**
 * 環境変数からプロバイダとキーを解決する。
 *
 * VRT_LLM_PROVIDER: gemini (default) | anthropic | openrouter
 * VRT_LLM_MODEL: モデル ID (省略時はプロバイダのデフォルト)
 */
function resolveProviderConfig(options?: LLMClientOptions): {
  provider: LLMProviderName;
  key: string;
  model?: string;
} | null {
  const provider = (options?.provider
    ?? process.env.VRT_LLM_PROVIDER
    ?? "gemini") as LLMProviderName;

  const model = options?.model ?? process.env.VRT_LLM_MODEL ?? undefined;

  const keyMap: Record<LLMProviderName, string | undefined> = {
    gemini: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };

  const key = keyMap[provider];
  if (!key) return null;

  return { provider, key, model };
}

/**
 * 統合 LLM クライアントを作成。
 *
 * プロバイダは VRT_LLM_PROVIDER 環境変数で指定 (デフォルト: gemini)。
 */
export function createUnifiedLLMClient(options?: LLMClientOptions): UnifiedLLMClient | null {
  const config = resolveProviderConfig(options);
  if (!config) return null;

  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient(config.key, config.model);
    case "gemini":
      return createGeminiLLMClient(config.key, config.model);
    case "openrouter":
      return createOpenRouterLLMClient(config.key, config.model);
  }
}

/**
 * 後方互換: 既存の LLMProvider インターフェースを返す。
 * VRT_LLM_PROVIDER で指定されたプロバイダを使う。
 * キーがない場合は他のプロバイダにフォールバック。
 */
export function createLLMProvider(): LLMProvider | null {
  // まず設定通りに試みる
  const client = createUnifiedLLMClient();
  if (client) return { complete: (prompt: string) => client.complete(prompt) };

  // フォールバック: 利用可能なキーがあれば使う
  const fallbackOrder: LLMProviderName[] = ["gemini", "anthropic", "openrouter"];
  for (const provider of fallbackOrder) {
    const fb = createUnifiedLLMClient({ provider });
    if (fb) return { complete: (prompt: string) => fb.complete(prompt) };
  }

  return null;
}
