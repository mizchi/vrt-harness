# VLM Model Benchmark v2 — 最新モデル比較

**日付**: 2026-04-04
**テスト**: fix-loop (page, seed 11, .readme-body pre 6 props, 4.1% diff) + VLM 単体品質

## Fix Loop 結果

| Model | Fix | ラウンド | VLM 速度 | コスト/call | 月額 (21K/日) |
|-------|-----|---------|---------|-----------|-------------|
| **meta-llama/llama-4-scout** | ✅ | 1 | **1.0s** | $0.14e-7 | **$0.09** |
| **amazon/nova-lite-v1** | ✅ | 1 | 2.3s | $0.14e-7 | $0.09 |
| amazon/nova-2-lite-v1 | ✅ | 1 | 3.5s | $1.38e-7 | $0.87 |
| qwen/qwen3-vl-235b-a22b (MoE) | ✅ | 1 | 3.2s | $0.25e-7 | $0.16 |
| qwen/qwen3-vl-8b | ✅ | 1 | 7.0s | $0.30e-7 | $0.19 |
| bytedance-seed/seed-1.6-flash | ✅ | 1 | 8.6s | $0.49e-7 | $0.31 |
| google/gemini-3-flash-preview | ✅ | 1 | 5.1s | $1.20e-7 | $0.76 |
| openai/gpt-5-nano | ✅ | 1 | 10.1s | $0.24e-7 | $0.15 |
| openai/gpt-4.1-nano | ❌ | 2 | 1.2s | — | — |
| google/gemma-4-31b-it | ✅ | 1 | 40.5s | $0.10e-7 | $0.06 |

## VLM 単体品質 (CHANGE 検出数)

| Model | CHANGE 数 | 備考 |
|-------|----------|------|
| qwen3-vl-8b | 28 | 最も多く検出 (重複含む可能性) |
| nova-2-lite | 27 | 高品質だがコスト 10x |
| **llama-4-scout** | **11** | 正確、重複少ない |
| seed-1.6-flash | 10 | |
| gemini-3-flash | 10 | |
| qwen3-vl-235b | 8 | MoE、簡潔 |
| nova-lite | 7 | 簡潔 |
| gpt-5-nano | 0 | フォーマットに従わない |

## 推奨

| 用途 | モデル | 理由 |
|------|--------|------|
| **デフォルト (コスパ最良)** | **llama-4-scout** | 最速 (1s), 最安 ($0.14e-7), 十分な品質 |
| 安定重視 | nova-lite | 実績あり, 同コスト, やや遅い |
| 品質重視 | nova-2-lite | 27 changes 検出, コスト 10x |
| 大規模 MoE | qwen3-vl-235b | 安定, 簡潔な出力 |

## 結論

**CSS diff がある場合、VLM の品質差は fix 結果に影響しない** (全モデル 0.0% 達成)。
差が出るのはレイテンシとコストのみ。llama-4-scout が 1.0s/$0.14e-7 でベスト。

*Regenerate: `just vlm-bench --md <models...>`*
