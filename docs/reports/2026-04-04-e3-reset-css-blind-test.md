# E3: Reset CSS Blind Test

**日付**: 2026-04-04

## 実験設計

normalize.css → modern-normalize への移行をエージェントに行わせる。

- **Baseline**: `normalize.html` (normalize.css + app CSS)
- **Target**: `modern-normalize-blind.html` (modern-normalize + 同じ app CSS)
- エージェントには VRT diff 結果と fix candidates のみ提供
- normalize.css の中身を直接読んで答えを探すことは禁止

## 結果

| | 初期 diff | 修正後 |
|---|---|---|
| wide (1440) | 0.9% | **0.0%** |
| desktop (1280) | 1.0% | **0.0%** |
| mobile (375) | 2.6% | **0.0%** |

**1 ラウンド、6 tool calls (54 秒) で全 viewport 0.0% 達成。**

## エージェントの修正

```css
/* 追加した 1 行 */
*, *::before, *::after { box-sizing: content-box; }
```

### 根本原因の特定

modern-normalize は `*, ::before, ::after { box-sizing: border-box }` をグローバルに設定するが、normalize.css はこれを持たない。

box-sizing の違いにより:
- padding が width に含まれる (border-box) vs 含まれない (content-box)
- flex container の子要素の幅計算が変わる
- 特に mobile (375px) で顕著 — 狭い viewport では padding 分の差が大きい

### VRT ヒントの有用性

fix candidates の `header nav { display }` はミスリード — 実際の原因は box-sizing。
エージェントは fix candidates ではなく、**diff の spatial pattern (layout-shift) から box-sizing の差異を推測**した。

## Tailwind blind test との比較

| | Tailwind → vanilla | Reset CSS 切り替え |
|---|---|---|
| 初期 diff (desktop) | 1.7% | 1.0% |
| 初期 diff (mobile) | 36.7% | 2.6% |
| 修正ラウンド | 3 | **1** |
| Tool calls | 58 | **6** |
| 時間 | 632s | **54s** |
| 修正の複雑度 | 14 の line-height + 構造変更 | **1 行** |

Reset CSS 切り替えは Tailwind 移行より遥かに単純 (差分が小さく、根本原因が 1 つ)。

## E3 成功基準

> 3 ラウンド以内に diff < 1%

✅ **1 ラウンドで diff 0.0% — 基準を大幅に上回る。**
