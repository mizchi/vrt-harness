# E1: Dogfooding 評価レポート

**日付**: 2026-04-04

## 実施内容

vrt-harness の全ツールチェーンを自プロジェクトの fixture で実行し、実用性を検証。

## 結果

### 1. Migration Compare

| シナリオ | 状態 | 備考 |
|---------|------|------|
| **Tailwind → vanilla CSS** | ✅ clean (13/13 viewport) | 0.0% diff — pixel-perfect 達成済み |
| **Reset CSS** (normalize → 3 variant) | ⚠️ remaining (7/7 unresolved) | Fix Candidates が自動生成された |

Reset CSS の Fix Candidates 出力:
```
modern-normalize   7x header nav { display }, 4x header nav { gap }, 4x label { display }
destyle            7x header nav { display }, 4x header nav { gap }, 4x label { display }
no-reset           7x header nav { display }, 4x header nav { gap }, 4x label { display }
```
→ 具体的な修正候補が出ており、subagent に渡して修正可能。

### 2. Smoke Test

| Fixture | Actions | Errors | Result | Time |
|---------|---------|--------|--------|------|
| page | 10 | 0 | PASS | ~2.5s |
| dashboard | 10 | 0 | PASS | ~2.5s |
| form-app | 10 | 0 | PASS | ~2.5s |

全 fixture でクラッシュなし。disabled 要素スキップが効いている。

### 3. CSS Bench (selector mode)

- 10 trials, page fixture
- **検出率: 100%** (全カテゴリ)
- multi-viewport bonus: 3 件
- 0 件の false positive

### 4. CLI 操作性

| コマンド | 動作 | 備考 |
|---------|------|------|
| `vrt compare` | ✅ | breakpoint 自動発見 + convergence 判定が便利 |
| `vrt discover` | ✅ | breakpoint と viewport 候補が一覧で出る |
| `vrt smoke` | ✅ | seed ベースで再現可能 |
| `vrt bench` | ✅ | fixture/mode/backend の切り替えが柔軟 |
| `vrt report` | ✅ | 蓄積データの集計 |
| `vrt serve` | ✅ | Hono API サーバー |

### 5. 課題

| 課題 | 深刻度 | 対策 |
|------|--------|------|
| WASM ベースアプリ (luna) は JS 実行なしで空ページ → smoke test 不能 | 中 | smoke test に JS 実行待ち (networkidle) 追加、または Playwright で WASM ビルドを serve |
| crater BiDi がないと paint tree diff / prescanner が使えない | 低 | graceful fallback 実装済み |
| `vrt compare` の出力が `migration-compare.ts` 経由で冗長 | 低 | シンプルな JSON 出力モード追加 |

## 評価

| 指標 | 評価 |
|------|------|
| **実用性** | 高 — migration compare + fix candidates が実際の CSS 移行に使える |
| **false positive** | 0% — 10 trials のベンチで偽陽性なし |
| **CLI UX** | 良好 — サブコマンドが直感的 |
| **CI 適合性** | 高 — GitHub Actions workflow 付き、seed で再現可能 |
| **WASM アプリ対応** | 未対応 — 静的 HTML のみ |
