# VRT コスト試算 — 10,000 ページ/日

## 前提

| パラメータ | 値 |
|-----------|-----|
| ページ数 | 10,000 |
| Viewport/ページ | 7 (3 standard + 4 breakpoint boundary) |
| 合計 viewport | 70,000 |
| diff 発生率 | 30% (21,000 viewport) |
| Stage 2 (修正) 対象 | 10% のページ (1,000) |

## Stage 1 (VLM 画像分析) コスト — 21,000 calls/日

| モデル | /call | /日 | /月 | /年 |
|--------|-------|-----|-----|-----|
| **gemma-3-27b:free** | FREE | FREE | FREE | FREE |
| **amazon/nova-lite** | $0.00002 | $0.004 | **$0.12** | $1 |
| **gemini-2.0-flash-lite** | $0.00002 | $0.005 | **$0.15** | $2 |
| **qwen3-vl-8b** | $0.00003 | $0.007 | **$0.22** | $3 |
| gemini-2.0-flash | $0.00003 | $0.007 | $0.20 | $2 |
| gpt-4o-mini | $0.0001 | $0.01 | $0.30 | $4 |
| claude-3.5-haiku | $0.003 | $0.06 | $2 | $23 |
| claude-sonnet-4 | $0.01 | $0.23 | $7 | $85 |
| gpt-4o | $0.008 | $0.17 | $5 | $61 |

## Stage 1 + Stage 2 (分析 + 修正) 合計コスト

| 組み合わせ | S1/日 | S2/日 | **合計/月** |
|-----------|-------|-------|-----------|
| **gemma-3:free + same** | FREE | FREE | **FREE** |
| **qwen3-vl-8b + gemini-flash** | $0.007 | $0.001 | **$0.24** |
| **gemini-flash + same** | $0.007 | $0.001 | **$0.22** |
| qwen3-vl-8b + haiku | $0.007 | $0.006 | $0.39 |
| qwen3-vl-8b + sonnet | $0.007 | $0.02 | $0.85 |
| gemini-flash + sonnet | $0.007 | $0.02 | $0.83 |

## レンダリングコスト

| バックエンド | /viewport | 合計時間 | CI コスト (GH Actions) |
|------------|-----------|---------|---------------------|
| **Chromium** | 600ms | 11.7h | **$5.60/日** |
| **Crater (prescanner)** | 50ms | 1.0h | 自己ホスト (無料) |

## 総コスト比較

| 構成 | AI コスト/月 | CI コスト/月 | **合計/月** |
|------|------------|------------|-----------|
| **Crater + gemma:free** | $0 | $0 | **$0** |
| **Crater + qwen3-vl-8b** | $0.24 | $0 | **$0.24** |
| Chromium + gemma:free | $0 | $168 | $168 |
| Chromium + qwen3-vl-8b | $0.24 | $168 | $168 |
| Chromium + sonnet | $25 | $168 | $193 |

## 結論

- **AI コストは無視できるレベル** — 10,000 ページ/日でも月 $0.24 (qwen3-vl-8b)
- **真のコストはレンダリング** — Chromium で月 $168 vs Crater で $0
- **推奨構成**: Crater prescanner + qwen3-vl-8b → **月 $0.24**
- 修正が必要な場合のみ Claude/Gemini を Stage 2 で使う → +$0.60/月

> 再生成: `node --experimental-strip-types src/vlm-bench.ts --list` でモデル価格を確認
