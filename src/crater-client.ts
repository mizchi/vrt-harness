/**
 * Crater BiDi クライアント
 *
 * mizchi/crater の WebDriver BiDi サーバーに接続し、
 * HTML レンダリング + スクリーンショット取得を行う軽量クライアント。
 *
 * crater サーバー起動方法:
 *   cd ~/ghq/github.com/mizchi/crater
 *   just build-bidi && just start-bidi-with-font
 */
import WebSocket from "ws";
import { PNG } from "pngjs";
import {
  buildComputedStyleCaptureJsonExpression,
  computedStyleSnapshotToMap,
  hasMeaningfulComputedStyleSnapshot,
  parseComputedStyleSnapshot,
} from "./computed-style-capture.ts";

export const DEFAULT_BIDI_URL = "ws://127.0.0.1:9222";

export interface CraterResponsiveBreakpoint {
  axis: "width";
  op: "ge" | "gt" | "le" | "lt";
  valuePx: number;
  raw: string;
  normalized: string;
  guards: string[];
  ruleCount: number;
}

export interface CraterBreakpointDiscoveryDiagnostics {
  stylesheetCount: number;
  ruleCount: number;
  externalStylesheetLinks: string[];
  ignoredQueries: string[];
  unsupportedQueries: string[];
}

export interface CraterBreakpointDiscoveryResult {
  breakpoints: CraterResponsiveBreakpoint[];
  diagnostics?: CraterBreakpointDiscoveryDiagnostics;
}

interface BidiResponse {
  id: number;
  type: "success" | "error";
  result?: unknown;
  error?: string;
  message?: string;
}

type PendingCommand = {
  resolve: (value: BidiResponse) => void;
  reject: (error: Error) => void;
};

export class CraterClient {
  private ws: WebSocket | null = null;
  private commandId = 0;
  private pendingCommands = new Map<number, PendingCommand>();
  private contextId: string | null = null;
  private url: string;

  constructor(url = DEFAULT_BIDI_URL) {
    this.url = url;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", async () => {
        try {
          const resp = await this.sendBidi("browsingContext.create", { type: "tab" });
          this.contextId = (resp.result as { context: string }).context;
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      this.ws.on("error", (error) => reject(error));
      this.ws.on("message", (data) => this.handleMessage(data.toString()));
    });
  }

  async close(): Promise<void> {
    if (this.contextId) {
      try {
        await this.sendBidi("browsingContext.close", { context: this.contextId });
      } catch { /* best-effort */ }
    }
    this.contextId = null;
    this.ws?.close();
    this.ws = null;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.sendBidi("browsingContext.setViewport", {
      context: this.requireContextId(),
      viewport: { width, height },
    });
  }

  async setContent(html: string): Promise<void> {
    const dataUrl = `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
    await this.sendBidi("browsingContext.navigate", {
      context: this.requireContextId(),
      url: dataUrl,
      wait: "complete",
    });
    await this.evaluate(`__loadHTML(${JSON.stringify(html)})`);
    await this.evaluate(`(async () => await __executeScripts())()`, true);
  }

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const resp = await this.sendBidi("script.evaluate", {
      expression,
      target: { context: this.requireContextId() },
      awaitPromise: awaitPromise || expression.includes("await ") || expression.includes("new Promise"),
    });
    if (resp.type === "error") {
      throw new Error(resp.message || resp.error || "script.evaluate failed");
    }
    const result = resp.result as { result?: { value?: T }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value as T;
  }

  /** PNG スクリーンショット (Buffer) */
  async captureScreenshot(): Promise<Buffer> {
    const resp = await this.sendBidi("browsingContext.captureScreenshotData", {
      context: this.requireContextId(),
      origin: "viewport",
    });
    if (resp.type === "error") {
      throw new Error(resp.message || resp.error || "captureScreenshotData failed");
    }
    return Buffer.from(String(resp.result || ""), "base64");
  }

  /** 生 RGBA データ (pixelmatch 互換) */
  async capturePaintData(): Promise<{ width: number; height: number; data: Uint8Array }> {
    const resp = await this.sendBidi("browsingContext.capturePaintData", {
      context: this.requireContextId(),
      origin: "viewport",
    }, 120_000);
    if (resp.type === "error") {
      throw new Error(resp.message || resp.error || "capturePaintData failed");
    }
    const result = resp.result as { width?: number; height?: number; data?: string };
    return {
      width: Number(result.width ?? 0),
      height: Number(result.height ?? 0),
      data: Uint8Array.from(Buffer.from(String(result.data || ""), "base64")),
    };
  }

  /** 生 RGBA → PNG Buffer 変換 */
  async capturePng(): Promise<{ png: Buffer; width: number; height: number }> {
    const { width, height, data } = await this.capturePaintData();
    const png = new PNG({ width, height });
    png.data = Buffer.from(data);
    const pngBuffer = PNG.sync.write(png);
    return { png: pngBuffer, width, height };
  }

  async captureComputedStyles(
    properties: string[],
  ): Promise<Map<string, Record<string, string>>> {
    const rawSnapshot = await this.evaluate<unknown>(
      buildComputedStyleCaptureJsonExpression(properties),
    );
    const snapshot = parseComputedStyleSnapshot(rawSnapshot);
    if (!hasMeaningfulComputedStyleSnapshot(snapshot)) {
      return new Map();
    }
    return computedStyleSnapshotToMap(snapshot);
  }

  async getResponsiveBreakpoints(
    options: {
      mode?: "live-inline" | "html-inline";
      axis?: "width";
      includeDiagnostics?: boolean;
    } = {},
  ): Promise<CraterBreakpointDiscoveryResult> {
    const resp = await this.sendBidi("browsingContext.getResponsiveBreakpoints", {
      context: this.requireContextId(),
      mode: options.mode ?? "live-inline",
      axis: options.axis ?? "width",
      includeDiagnostics: options.includeDiagnostics ?? true,
    }, 30_000);
    if (resp.type === "error") {
      throw new Error(resp.message || resp.error || "getResponsiveBreakpoints failed");
    }
    const result = resp.result as CraterBreakpointDiscoveryResult | undefined;
    return {
      breakpoints: result?.breakpoints ?? [],
      diagnostics: result?.diagnostics,
    };
  }

  // ---- Private ----

  private requireContextId(): string {
    if (!this.contextId) throw new Error("Not connected. Call connect() first.");
    return this.contextId;
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as BidiResponse;
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        this.pendingCommands.delete(msg.id);
        pending.resolve(msg);
      }
    } catch { /* ignore parse errors */ }
  }

  private sendBidi(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<BidiResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.commandId;
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`BiDi command ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(id, {
        resolve: (resp) => { clearTimeout(timer); resolve(resp); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Paint tree (描画ツリー JSON) */
  async capturePaintTree(): Promise<PaintNode> {
    const resp = await this.sendBidi("browsingContext.capturePaintTree", {
      context: this.requireContextId(),
    }, 120_000);
    if (resp.type === "error") {
      throw new Error(resp.message || resp.error || "capturePaintTree failed");
    }
    const result = resp.result as { paintTree?: string };
    return JSON.parse(result.paintTree || "{}");
  }
}

// ---- Paint tree types & diff ----

export interface PaintNode {
  id?: string;
  tag?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ox?: string;
  oy?: string;
  p?: PaintProps;
  text?: string;
  ch?: PaintNode[];
}

export interface PaintProps {
  op?: number;     // opacity
  c?: number[];    // color [r,g,b,a]
  bg?: number[];   // background [r,g,b,a]
  fs?: number;     // font-size
  ib?: boolean;    // is-bold
  vis?: string;    // visibility
  br?: number[];   // border-radius
}

export interface PaintTreeChange {
  path: string;       // e.g. "body > div > div[0]"
  type: "geometry" | "paint" | "text" | "added" | "removed";
  property?: string;
  before?: string;
  after?: string;
}

/** 2つの paint tree を比較して差分を返す */
export function diffPaintTrees(baseline: PaintNode, current: PaintNode, path = "root"): PaintTreeChange[] {
  const changes: PaintTreeChange[] = [];

  // Geometry diff
  if (baseline.x !== current.x || baseline.y !== current.y ||
      baseline.w !== current.w || baseline.h !== current.h) {
    changes.push({
      path, type: "geometry",
      property: "bounds",
      before: `${baseline.x},${baseline.y} ${baseline.w}x${baseline.h}`,
      after: `${current.x},${current.y} ${current.w}x${current.h}`,
    });
  }

  // Paint properties diff
  if (baseline.p && current.p) {
    const bp = baseline.p;
    const cp = current.p;
    if (bp.op !== cp.op) {
      changes.push({ path, type: "paint", property: "opacity", before: String(bp.op), after: String(cp.op) });
    }
    if (JSON.stringify(bp.c) !== JSON.stringify(cp.c)) {
      changes.push({ path, type: "paint", property: "color", before: JSON.stringify(bp.c), after: JSON.stringify(cp.c) });
    }
    if (JSON.stringify(bp.bg) !== JSON.stringify(cp.bg)) {
      changes.push({ path, type: "paint", property: "background", before: JSON.stringify(bp.bg), after: JSON.stringify(cp.bg) });
    }
    if (bp.fs !== cp.fs) {
      changes.push({ path, type: "paint", property: "font-size", before: String(bp.fs), after: String(cp.fs) });
    }
    if (bp.ib !== cp.ib) {
      changes.push({ path, type: "paint", property: "font-weight", before: String(bp.ib), after: String(cp.ib) });
    }
    if (JSON.stringify(bp.br) !== JSON.stringify(cp.br)) {
      changes.push({ path, type: "paint", property: "border-radius", before: JSON.stringify(bp.br), after: JSON.stringify(cp.br) });
    }
  }

  // Text diff
  if (baseline.text !== current.text) {
    changes.push({ path, type: "text", before: baseline.text, after: current.text });
  }

  // Children diff
  const bch = baseline.ch ?? [];
  const cch = current.ch ?? [];
  const maxLen = Math.max(bch.length, cch.length);
  for (let i = 0; i < maxLen; i++) {
    const childPath = `${path} > ${(cch[i] ?? bch[i])?.tag ?? "?"}[${i}]`;
    if (i >= bch.length) {
      changes.push({ path: childPath, type: "added" });
    } else if (i >= cch.length) {
      changes.push({ path: childPath, type: "removed" });
    } else {
      changes.push(...diffPaintTrees(bch[i], cch[i], childPath));
    }
  }

  return changes;
}

// ---- Utility ----

/** crater サーバーが起動しているか確認 */
export async function isCraterAvailable(url = DEFAULT_BIDI_URL): Promise<boolean> {
  try {
    const httpUrl = url.replace("ws://", "http://");
    const resp = await fetch(httpUrl, { signal: AbortSignal.timeout(2000) });
    return resp.ok || resp.status === 426; // 426 = upgrade required (WebSocket)
  } catch {
    return false;
  }
}
