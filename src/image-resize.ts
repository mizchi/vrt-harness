/**
 * 画像リサイズ + VLM 用最適化
 *
 * VLM に送る前に画像を縮小してトークンコストを削減。
 * 解像度が足りない場合に自動エスカレーションする機能付き。
 */
import { PNG } from "pngjs";

export type ResolutionPreset = "low" | "medium" | "high" | "full";

export const RESOLUTION_PRESETS: Record<ResolutionPreset, { maxWidth: number; maxHeight: number }> = {
  low: { maxWidth: 375, maxHeight: 320 },      // mobile viewport 幅を維持。~130 tokens
  medium: { maxWidth: 640, maxHeight: 480 },    // breakpoint 境界を維持。~200 tokens
  high: { maxWidth: 1280, maxHeight: 900 },     // desktop viewport そのまま。~500 tokens
  full: { maxWidth: 4096, maxHeight: 4096 },    // original size
};

/**
 * viewport サイズから最適な解像度プリセットを選択。
 * viewport 幅の半分以上の解像度を持つ最小のプリセットを返す。
 */
export function resolveResolutionForViewport(
  viewportWidth: number,
  maxPreset: ResolutionPreset = "high",
): ResolutionPreset {
  const order: ResolutionPreset[] = ["low", "medium", "high", "full"];
  const maxIdx = order.indexOf(maxPreset);

  for (let i = 0; i <= maxIdx; i++) {
    const preset = RESOLUTION_PRESETS[order[i]];
    // 画像幅が viewport の半分以上あれば十分
    if (preset.maxWidth >= viewportWidth / 2) return order[i];
  }

  return maxPreset;
}

export interface ResizeOptions {
  /** プリセット or カスタムサイズ */
  resolution?: ResolutionPreset | { maxWidth: number; maxHeight: number };
}

/** PNG Buffer を指定サイズ以下にリサイズ。アスペクト比維持。 */
export function resizePngBuffer(pngBuffer: Buffer, options: ResizeOptions = {}): Buffer {
  const preset = typeof options.resolution === "string"
    ? RESOLUTION_PRESETS[options.resolution]
    : options.resolution ?? RESOLUTION_PRESETS.medium;

  const src = PNG.sync.read(pngBuffer);

  if (src.width <= preset.maxWidth && src.height <= preset.maxHeight) {
    return pngBuffer; // already small enough
  }

  const scale = Math.min(preset.maxWidth / src.width, preset.maxHeight / src.height);
  const targetW = Math.round(src.width * scale);
  const targetH = Math.round(src.height * scale);

  const dst = new PNG({ width: targetW, height: targetH });
  const xRatio = src.width / targetW;
  const yRatio = src.height / targetH;

  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.min(Math.floor(x * xRatio), src.width - 1);
      const srcY = Math.min(Math.floor(y * yRatio), src.height - 1);
      const si = (srcY * src.width + srcX) * 4;
      const di = (y * targetW + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }

  return Buffer.from(PNG.sync.write(dst));
}

/** base64 PNG を指定解像度にリサイズして base64 で返す */
export function resizeBase64Png(base64: string, options: ResizeOptions = {}): string {
  const buf = Buffer.from(base64, "base64");
  const resized = resizePngBuffer(buf, options);
  return resized.toString("base64");
}

/** 画像の解像度を取得 */
export function getImageDimensions(base64: string): { width: number; height: number } {
  const buf = Buffer.from(base64, "base64");
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height };
}
