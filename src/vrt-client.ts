/**
 * vrt-harness TypeScript Client SDK
 *
 * API サーバーの全エンドポイントに対応する型安全なクライアント。
 * Node.js / Deno / ブラウザで動作。
 *
 * Usage:
 *   import { VrtClient } from "./vrt-client.ts";
 *   const client = new VrtClient("http://localhost:3456");
 *   const result = await client.compare({ baseline: { html: "..." }, current: { html: "..." } });
 */
import type {
  CompareRequest, CompareResponse,
  SmokeTestRequest, SmokeTestResponse,
  StatusResponse,
  HtmlSource,
  Viewport,
} from "./api-types.ts";

export class VrtClient {
  private baseUrl: string;

  constructor(baseUrl = "http://localhost:3456") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async status(): Promise<StatusResponse> {
    return this.get("/api/status");
  }

  async compare(request: CompareRequest): Promise<CompareResponse> {
    return this.post("/api/compare", request);
  }

  async compareHtml(
    baseline: string,
    current: string,
    options?: { viewports?: Viewport[]; threshold?: number; baselineLabel?: string; currentLabel?: string },
  ): Promise<CompareResponse> {
    return this.compare({
      baseline: { html: baseline, label: options?.baselineLabel },
      current: { html: current, label: options?.currentLabel },
      viewports: options?.viewports,
      options: { threshold: options?.threshold },
    });
  }

  async compareUrls(
    baseline: string,
    current: string,
    options?: { viewports?: Viewport[]; threshold?: number },
  ): Promise<CompareResponse> {
    return this.compare({
      baseline: { url: baseline, label: baseline },
      current: { url: current, label: current },
      viewports: options?.viewports,
      options: { threshold: options?.threshold },
    });
  }

  async compareRenderers(
    html: string | HtmlSource,
    options?: { viewports?: Viewport[]; threshold?: number },
  ): Promise<{ status: string; results: any[]; meta: any }> {
    const source: HtmlSource = typeof html === "string" ? { html } : html;
    return this.post("/api/compare-renderers", {
      html: source,
      viewports: options?.viewports,
      threshold: options?.threshold,
    });
  }

  async smokeTest(request: SmokeTestRequest): Promise<SmokeTestResponse> {
    return this.post("/api/smoke-test", request);
  }

  async smokeTestHtml(
    html: string,
    options?: { maxActions?: number; seed?: number },
  ): Promise<SmokeTestResponse> {
    return this.smokeTest({
      target: { html },
      mode: "random",
      maxActions: options?.maxActions ?? 20,
      seed: options?.seed,
      blockExternalNavigation: true,
    });
  }

  async smokeTestUrl(
    url: string,
    options?: { maxActions?: number; seed?: number },
  ): Promise<SmokeTestResponse> {
    return this.smokeTest({
      target: { url },
      mode: "random",
      maxActions: options?.maxActions ?? 20,
      seed: options?.seed,
      blockExternalNavigation: true,
    });
  }

  // ---- Helpers ----

  async isAvailable(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }

  async waitForServer(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isAvailable()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Server not available at ${this.baseUrl} after ${timeoutMs}ms`);
  }

  // ---- Internal ----

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  }
}
