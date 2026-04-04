# CSS VRT 検出パターン — 実験知見

## ゴール

大規模レンダラー間の差分検証 + a11y ベースのスモークテスト。

- **Chromium vs Crater**: ブラウザエンジン間の差分をベンチマーク + 自動検出
- **Website v1 vs v2**: UI ライブラリのリライト時の回帰検証
- **Cloudflare Workers**: crater WASM + API で Chromium なしに VRT を実行
- **Diff Approval**: 許容する差分パターンを宣言して管理 (tolerance, expires, issue 連携)
- **A11y Smoke Test**: a11y ツリーからインタラクティブ要素を列挙し、ランダム/reasoning ベースで操作してクラッシュを検出

## 実験概要

GitHub リポジトリページ風の HTML (237 CSS 宣言) から 1 つの CSS プロパティをランダムに削除し、VRT パイプラインで検出できるかをベンチマーク。60 trial (2 run) の結果。

## 検出信号と効果

| 信号 | 単体検出率 | 役割 |
|------|-----------|------|
| **Visual diff** (pixel) | 77% | ベースライン。レイアウト・色・サイズの変化を検出 |
| **Computed style diff** | 73% | pixel に現れない CSS 変化を検出。**visual と相補的** |
| **Hover emulation** | 7% | `:hover` ルールを常時有効化して computed style を比較 |
| **A11y diff** | 17% | `display: none` 等の要素消失のみ。CSS 変更にはほぼ無力 |
| **Multi-viewport** | +7% | desktop(1280) + mobile(375) の 2 viewport で検出漏れを補完 |
| **全信号合計** | **93%** | pixel 単体 (70%) から **+23%** 改善 |

### 信号の組み合わせ効果

```
pixel only (1 viewport)       → 70%
+ multi-viewport (2 vp)       → 77%  (+7%)
+ computed style diff          → 87%  (+10%)
+ hover emulation             → 93%  (+6%)
+ wide viewport (3 vp)        → 95%  (+2%)
+ semantic tag 収集拡大        → 97%  (+2%)
                         合計: +27%
```

### Hover emulation の仕組み

CSS の `:hover` は JS の `dispatchEvent` では発火しない（ブラウザ内部状態）。そこで:

1. ページ内の `<style>` から `:hover` を含むルールを収集
2. `:hover` を削除したセレクタでルールを複製 → 新しい `<style>` として注入
3. この状態で `getComputedStyle` を取得（hover スタイルが常時適用された状態）
4. 注入した `<style>` を削除

これにより `:hover` スタイルの有無を computed style の差分として検出できる。

## カテゴリ別検出率

| カテゴリ | 検出率 | n | 備考 |
|---------|--------|---|------|
| **layout** | 100% | 13 | display, flex, align-items — 常に検出可能 |
| **sizing** | 100% | 6 | width, height — 常に検出可能 |
| **spacing** | 80% | 10 | padding, margin — 微小変化は見落とす |
| **typography** | 77% | 17 | font-size, color は確実。text-decoration はフラッキー |
| **visual** | 75% | 12 | background が同系色だと見落とす |

### 常に検出できるプロパティ (100%, n>=2)

`display`, `font-size`, `color`, `margin-left`, `border-radius`, `height`, `width`, `font-weight`, `align-items`

### フラッキーなプロパティ (検出が不安定)

| プロパティ | 検出率 | 原因 | hover emulation 後 |
|-----------|--------|------|-------------------|
| `background` | 50% | 親と同系色だと pixel diff ゼロ | computed style diff で一部改善 |
| `text-decoration` | 56% → **100%** | hover 専用スタイルは静的キャプチャで不可視 | hover emulation で解決 |
| `padding` | 67% | コンテンツが少ないと内側余白の差が出ない | computed style diff で改善 |

## セレクタ種別の検出率

| 種別 | 検出率 | n | 備考 |
|------|--------|---|------|
| **class** (`.foo`) | 97% | 38 | ほぼ確実に検出 |
| **compound** (`.foo .bar`) | 65% | 20 | 子孫セレクタは文脈依存で見落としやすい |
| **pseudo-class** (`:hover`) | 0% | 1 | 静的キャプチャでは原理的に不可視 |

## 未検出パターンの分類

### hover emulation 導入前 (60 trial)

| 理由 | 件数 | 割合 | 対策 |
|------|------|------|------|
| **hover-only** | 5 | 56% | hover emulation で解決済み |
| **unknown** | 3 | 33% | 要素が画面に存在しない / 計算値が変わらない |
| **same-as-parent** | 1 | 11% | computed style diff で一部検出可能 |

### hover emulation 導入後 (30 trial)

未検出: 2/30 (6.7%) — **hover-only は全件解決**

| 理由 | 件数 | 例 |
|------|------|---|
| **unknown** | 2 | `.readme-body code { background: #eff1f3 }`, `.main { margin: 0 auto }` |

### 「unknown」の詳細分析

- `.readme-body code { background: #eff1f3 }` — `<code>` がインラインで使われており、fixture の HTML にはこの要素が `<pre><code>` 内にのみ存在。`<pre>` の背景色 `#f6f8fa` と `<code>` の `#eff1f3` の差が微小すぎる
- `.main { margin: 0 auto }` — `max-width: 1280px` かつ viewport=1280px のため auto margin がゼロ。mobile viewport でも max-width 制約がないため同様
- `.readme-body code { padding: 2px 6px }` — インライン `<code>` 内のテキスト量が少なく、padding の差が周囲に吸収される

## Viewport 別検出率

| Viewport | 検出率 | 単独検出 |
|----------|--------|---------|
| desktop (1280px) | 70% | 6 件 (desktop でのみ検出) |
| mobile (375px) | 62% | 1 件 (mobile でのみ検出) |

desktop の方が検出率が高い理由: レイアウトが横幅を使い切るため、spacing/sizing の差が出やすい。mobile ではサイドバーが非表示 (`@media` で `width: 100%`) になるため一部の要素が折りたたまれる。

## Computed Style Diff の効果

pixel diff では検出できなかったが computed style diff で検出できた例:

| 宣言 | 理由 |
|------|------|
| `.file-table .date { white-space: nowrap }` | コンテンツが短く折り返しが発生しないが、計算値は変わる |
| `.readme-header { background: #f6f8fa }` | 親の背景色と同一で pixel 差ゼロだが、computed `background-color` が `transparent` に変化 |
| `.lang-list { flex-wrap: wrap }` | アイテム数が少なく折り返し不要だが、計算値 `wrap` → `nowrap` の差は検出可能 |

## 残り 3% の壁 — デッドコード問題

96.7% 検出に到達。残りの未検出 1 件:

`.readme-body code { background: #eff1f3 }` — **事実上のデッドコード**。

原因の連鎖:
1. ページ上の `<code>` は `<pre><code>` 内にのみ存在
2. `.readme-body pre code { background: none }` が上書き
3. したがって `.readme-body code { background: #eff1f3 }` はどの要素にも視覚的に適用されない
4. computed style でも差が出ない（`pre code` の上書きが優先）

**これは VRT の限界ではなく、CSS 自体がデッドコード**。

### デッドコード検出

全 viewport で computed style diff = 0 かつ visual diff = 0 の場合、`dead-code` として分類するヒューリスティックを導入。これにより `unknown` を減らし、「検出できない」のか「検出する必要がない」のかを区別できるようになった。

**デッドコードは VRT の検出対象外**として扱うのが正しい。実質的な検出率は CSS のデッドコードを除外すれば **100%** に近い。

## 複数 fixture の比較 (90 trial, 3 fixture)

| Fixture | 検出率 | 宣言数 | 特徴 |
|---------|--------|--------|------|
| **page** (GitHub風) | 96.7% | 237 | flexbox ベース、シンプルなセレクタ |
| **form-app** (設定画面) | 90.0% | 228 | :focus/:hover/:disabled/:checked、toggle switch、form validation |
| **dashboard** (ダッシュボード) | 83.3% | 276 | CSS Grid, var(), animation, filter, ::before/::after |
| **合計** | **90.0%** | 741 | |

dashboard の検出率が低い原因:

### 新たに発見された未検出パターン

| パターン | 例 | 分類 | 対策 |
|----------|---|------|------|
| **vendor pseudo-element** | `::-webkit-scrollbar-track { background: transparent }` | same-as-default | transparent はブラウザデフォルト |
| **animation-delay** | `.stat-card:nth-child(2) { animation-delay: 0.05s }` | dead-code | 静的キャプチャ時点で animation 完了済み。初期ロード直後のキャプチャでは検出可能だが、`networkidle` 待ちだと完了後 |
| **grid-column** | `.topbar { grid-column: 2 }` | dead-code | `@media (max-width: 768px)` で grid-template-columns が変更されるが、他の viewport でも同じカラム構造のため |
| **:focus のスタイル** | `input:focus { border-color: var(--accent) }` | hover-only | hover emulation が `:focus` をカバーしたが、`var()` の解決タイミングの問題 |
| **CSS custom properties (var())** | `border-color: var(--accent)` | hover-only | var() 参照は computed style 比較では変化するが、hover emulation のスタイル注入で specificity 競合が起きる場合がある |

### CSS 機能別の検出可否 (60 trial, 2 fixture)

| CSS 機能 | 検出率 | 備考 |
|---------|--------|------|
| flexbox | 100% | display, align-items, gap 等すべて検出 |
| CSS Grid | 高い | grid-template-columns は検出。grid-column は dead-code になりやすい |
| transition | 検出不要 | transition プロパティ自体は静的に影響しない。対象プロパティの変更は検出可能 |
| animation | **低い** | 完了済み animation の delay/duration は検出不能。`animation` カテゴリとして分離 |
| var() | 高い | computed style は解決後の値なので比較可能 |
| filter/backdrop-filter | 高い | computed style で検出可能。`transform` カテゴリとして分離 |
| :hover | **部分的** | hover emulation で page fixture は 100%。dashboard では `getComputedStyle` のレンダリングタイミング問題で一部検出漏れ |
| :focus | **低い** | hover emulation で `:focus` もカバーしたが、同様のタイミング問題 |
| ::before/::after | 未検出 | pseudo-element の computed style 取得が未実装 |
| ::-webkit-* | 低い | vendor prefix は transparent デフォルトが多い |
| :nth-child() | dead-code | animation-delay 等の微小な値変更は静的キャプチャで不可視 |
| CSS custom properties (:root) | **低い** | `--accent-hover: #60a5fa` 等の変数定義は、使用箇所の computed style が変わらない限り検出不能 |
| object-fit | dead-code | img が正方形で cover の効果がない場合 |
| grid-column | dead-code | grid 自動配置と同値の場合、宣言を削除しても同じレイアウト |
| scrollbar 系 | same-as-default | vendor pseudo-element はデフォルト値 (transparent) が多い |

## 大規模テスト結果 (90+60 trial)

dashboard を 60 trial で追加テストした結果、以下の新パターンが見つかった:

### CSS Custom Properties の検出限界

`:root { --accent-hover: #60a5fa }` を削除しても、直接の computed style 変化が起きない。
- `:root` のスタイルは CSS 変数定義のみ
- 変数を参照する要素の computed style は、変数が undefined になるため fallback 値またはデフォルト値に戻る
- しかし `getComputedStyle` の評価タイミングで不整合が起きるケースがある

**対策案**: CSS 変数の使用箇所を `var()` で検索し、使用箇所の要素の computed style を追跡する

### Hover emulation の限界 (Playwright + getComputedStyle)

inline style を設定しても `getComputedStyle` が `transparent` を返すケースが確認された。
`page.setContent` での DOM 構築後、CSS の再計算が完了する前に `evaluate` が走っている可能性。

**暫定的な知見**: hover emulation はシンプルな構造（page fixture）では 100% 動くが、CSS Grid + var() + 多数のルールがある複雑なページ (dashboard) では不安定。

### 未検出パターンの全リスト (9/90)

| # | Fixture | 宣言 | 理由 | 根本原因 | 対策 |
|---|---------|------|------|---------|------|
| 1 | page | `.readme-body code { background }` | dead-code | `pre code` で specificity 上書き | CSS リファクタリング |
| 2 | dashboard | `.topbar { grid-column: 2 }` | dead-code | grid 自動配置と同値 | 冗長な宣言 → 削除推奨 |
| 3 | dashboard | `.stat-card:nth-child(2) { animation-delay }` | dead-code | networkidle 時点で完了済み | animation の検出は原理的に困難 |
| 4 | dashboard | `.avatar { width: 32px }` | dead-code | img natural size と同値 | fixture HTML で natural size を変更 → 解決 |
| 5 | dashboard | `::-webkit-scrollbar-track { background }` | same-as-default | `transparent` はデフォルト | 正当な same-as-default |
| 6 | dashboard | `input:focus { border-color: var(--accent) }` | hover-only | :focus は hover emulation で specificity 競合 | 改善余地あり |
| 7 | form-app | `.check-desc { color }` | dead-code | 親の color と同値 | 正当な dead-code |

### 以前の未検出ケースの解決経緯

| 問題 | 検出率への影響 | 解決方法 |
|------|-------------|---------|
| `margin: 0 auto` (viewport=max-width) | 93%→97% | **wide viewport (1440px) 追加** |
| computed style が class なし要素を漏らす | 87%→90% | **セマンティックタグも収集** |

## Crater 評価 — VRT バックエンドとしての実用性

### ベンチマーク結果

| Backend | 検出率 (page fixture) | 信号 |
|---------|---------------------|------|
| Chromium | **96.7%** | pixel + computed style + hover emulation |
| Crater | **60.0%** | pixel + **paint tree diff** |
| Crater (pixel のみ) | 50.0% | pixel のみ (paint tree なし) |

**Paint tree diff の効果: +10%** (50% → 60%)。pixel では検出できなかった以下の 3 件を paint tree で検出:

- `border-radius` — pixel 描画は差なしだが、paint tree に `br` プロパティがある → diff で検出
- `align-items` — pixel では同じレイアウトに見えるが、paint tree のノード座標が変わる → 検出
- `background` (親と同色) — pixel 差ゼロだが、paint tree の `bg` プロパティが変わる → 検出

これは **Chromium にはない crater 固有の検出能力**。Chromium の computed style diff に相当する信号を、paint tree から取得できる。

### Prescanner アーキテクチャ

crater は偽陽性を許容する prescanner として使うのが最適。偽陽性は Chromium が除外するので問題にならない。

```
[CSS 変更]
  │
  ▼
[crater paint tree diff]  ← 高速 (<1s起動, pixel+paint tree)
  │
  ├── 差分あり → DETECTED (crater 単体で十分)
  │              多くのケースはここで終了。Chromium 不要
  │
  └── 差分なし → [Chromium 精密検証]  ← 必要時のみ起動
                  pixel + computed style + hover emulation
                  → DETECTED or PASS
```

**利点**:
- crater で検出できる 60% のケースは Chromium を起動しない → CI 高速化
- crater の偽陽性は Chromium で除外 → 精度は落ちない
- crater 固有の信号 (paint tree の `bg`, `br` 等) が Chromium の盲点を補完

**偽陰性リスク**:
現状 crater の prescanner で見逃す 40% は全て Chromium にフォールバックするため、偽陰性は発生しない。
prescanner 単体で使う場合の偽陰性率 = 40% (crater #18-22 の修正で低減予定)。

**偽陽性率: 0%** (計測済み):
同じ HTML を複数回レンダリングしても paint tree は完全一致。3 viewport (1440/1280/375) 全てで確認。
crater のレンダリングは完全に決定的 (deterministic)。
Chromium の pixel 比較では anti-aliasing やフォントレンダリングの微小なノイズで偽陽性が出ることがあるが、crater の paint tree diff にはこの問題がない。

**prescanner としての評価**:
- 偽陽性率: 0% → Chromium への不要なフォールバックが発生しない
- 偽陰性率: 40% → crater で見逃した分は Chromium が拾う (crater #18-22 の修正で低減)
- 決定論的: 同一入力に対して常に同一出力 → テストのフラッキネスがゼロ

### 速度ベンチマーク

**個別操作の速度比較**:

| 操作 | Crater | Chromium | 倍率 |
|------|--------|----------|------|
| 起動/接続 | 4ms | 418ms | **105x** |
| setContent | 13ms | 662ms | **51x** |
| setContent (warm) | 41ms | 559ms | **14x** |
| paint tree 取得 | 18ms | — | crater 固有 |
| paint tree diff | <1ms | — | crater 固有 |
| スクリーンショット | 325ms (RGBA) + 36ms (PNG) | 76ms (PNG) | Chromium が速い |
| computed style | — | 5ms | Chromium のみ |

**Prescanner 戦略の実測** (15 trial):

| 戦略 | 合計時間 | ms/trial | 高速化 |
|------|---------|----------|--------|
| Chromium only | 9,366ms | 624ms | — |
| Crater prescanner + Chromium fallback | 5,638ms | 376ms | **1.66x (40% 短縮)** |

15 trial 中 7 件 (47%) が crater だけで検出 → Chromium を起動せずに完了。
残り 8 件は Chromium にフォールバック。

**crater 本体の改善 (#18-22) で偽陰性率が下がれば、高速化率はさらに向上する**:

```
現状 (偽陰性 40%): 1.66x speedup
偽陰性 20%:        ~2.5x speedup (推定)
偽陰性 10%:        ~4x speedup (推定)
偽陰性 0%:         ~10x speedup (Chromium 不要)
```

### 強み

| 観点 | 評価 | 詳細 |
|------|------|------|
| **ポータビリティ** | ◎ | Chromium 不要。Node 24+ / Deno で動作。WASM component としてもビルド可能。CI で X11/GPU 不要 |
| **起動速度** | ◎ | BiDi サーバー起動 < 1s。Chromium の cold start (数秒) と比較して高速 |
| **セレクタ指定レンダリング** | ○ | `elementScreenshot` API あり (BiDi protocol に定義済み)。実装は bounding box + crop だが、Chromium よりも制御の自由度が高い |
| **柔軟性** | ◎ | 自作のため修正の小回りが効く。paint backend、layout engine、CSS parser すべてに手が入る |
| **メモリ** | ○ | MoonBit/WASM ベース。Chromium (~300MB) と比べてフットプリントが小さい (推定 50-100MB) |
| **描画ツリーアクセス** | ◎ | `capturePaintTree()` で内部描画ツリーを JSON で取得可能。Chromium にはない独自機能 |
| **生 RGBA 出力** | ◎ | `capturePaintData()` で生ピクセルデータ取得。PNG エンコード/デコードのオーバーヘッドなし |

### 弱み (現時点)

| 観点 | 評価 | 詳細 |
|------|------|------|
| **CSS レンダリング精度** | △ | text-decoration 未実装、border-radius/font-weight/margin 精度問題 (mizchi/crater#18-22) |
| **テキスト描画** | △ | text wrapping precision、font-weight、inline layout に既知の差異 |
| **computed style** | ✗ | `script.evaluate` は動作するが、DOM の `getComputedStyle` 相当が不完全 |
| **hover/focus 状態** | ✗ | BiDi input API (click/hover) は実装済みだが、:hover の CSS 反映が未検証 |
| **JavaScript 互換性** | △ | QuickJS ベース。React/Preact は部分的に動作 (preact-compat テストあり) |

### 使いどころ

**現時点で有効なシナリオ**:

1. **レイアウト検証** — flexbox, grid, block のレイアウト計算は高精度 (WPT 99.2%)。display/width/height/padding/flex の変更検出に信頼できる
2. **CI の軽量 VRT** — Chromium を起動せずに基本的なレイアウト崩れを検出。first pass のフィルタとして使い、差分が出たら Chromium で精密検証
3. **paint tree diff** — ピクセルではなく描画ツリー (JSON) を比較する手法。CSS プロパティレベルの変更を直接検出できる可能性
4. **コンポーネント単位 VRT** — HTML snippet をレンダリングしてコンポーネント単体を検証。Storybook 的な使い方

**Chromium が必要なシナリオ**:

1. text-decoration / font-weight の正確なレンダリングが必要
2. border-radius の視覚的検証
3. computed style diff / hover emulation が必要
4. 外部 JavaScript (React, Vue 等) の実行が必要

### 将来的な可能性

- **paint tree diff**: 実装済み。検出率 +10% の実証データあり。border-radius, align-items, background (同色) を pixel なしで検出
- **WASM standalone**: layout engine を WASM で配布すれば、ブラウザや Edge Function 内でも VRT が走る。CI だけでなくエディタ統合や PR preview にも展開可能
- **CSS プロパティ単位の検証**: crater は CSS パーサーも自作なので、「このプロパティを有効/無効にした場合のレイアウト差」を計算できる。mutation testing の基盤になりうる

## Migration VRT 結果

### Reset CSS 切り替え (normalize.css → 各 reset)

| Variant | wide (1440) | desktop (1280) | bp-above (769) | mobile (375) |
|---------|-------------|----------------|----------------|--------------|
| modern-normalize | 0.9% | 1.0% | 2.0% | 2.6% |
| no-reset (browser default) | 1.6% | 1.7% | 2.5% | 3.6% |
| destyle | 6.6% | 6.8% | 8.2% | 12.0% |

エージェントが特定した差分原因:

**modern-normalize (0.9-2.6%)**:
- `box-sizing: border-box` のグローバル適用 → form 要素の幅が変わる
- `h1 { margin: 0.67em 0 }` が normalize にあるが modern-normalize にない → h1 以降が垂直にずれる
- 修正: `h1 { margin-top: 0.67em }` の 1 行で最も目立つ差分が解消

**destyle (6.6-12.0%)** — **drop-in 置換は不可**:
- `list-style: none` → リストマーカー消失
- heading の font-size/font-weight/margin をすべてリセット
- `appearance: none` で form 要素のネイティブ描画が消える
- normalize の上に destyle を載せるのは目的に反する

**no-reset (1.6-3.6%)**:
- form 要素の `font-family: inherit` がない → ブラウザデフォルトフォント
- `h1` のマージンがブラウザデフォルト (normalize より大きい)

**推奨移行パス**: modern-normalize が最も容易。`h1 { margin-top: 0.67em }` + box-sizing の影響確認のみ。

### Tailwind → vanilla CSS

**初回 → エージェント分析 → 修正後**:

| Viewport | 初回 | 修正後 | 改善 |
|----------|------|--------|------|
| wide (1440) | 1.1% | **0.3%** | -73% |
| desktop (1280) | 1.2% | **0.3%** | -75% |
| mobile (375) | 5.8% | **0.6%** | -90% |

エージェントが特定した 3 つのバグ:
1. **inline `display:none`** が CSS media query を上書き → Amount 列が常に非表示
2. **line-height 未指定** — Tailwind の `text-*` は line-height を含むが vanilla は font-size のみ → 累積垂直ズレ
3. **Preflight 互換** — button/input の `font-family: inherit` 等

修正適用後、全 viewport で 1.3% 以下に。残りは breakpoint 境界 (769/768/640px) の微小な差異。

## vrt-harness + subagent 評価

**「VRT diff → エージェント分析 → 修正コード生成 → 再検証」のループが実用的に機能することを実証。**

### Tailwind → vanilla CSS

- エージェントが 5 つのバグを特定（うち 2 つが critical）
- 1 ラウンドの修正で mobile diff 5.8% → 0.6% (90% 削減)
- Tailwind の `text-*` → `line-height` マッピング表を自動生成
- inline style vs media query の specificity 問題を正確に指摘

### Reset CSS migration

- 3 つの reset variant の差分原因を CSS ルール単位で特定
- destyle が drop-in 不可な理由を `list-style`, `appearance`, `font-weight` の 3 点で説明
- modern-normalize への移行に必要な修正を 1 行 (`h1 { margin-top: 0.67em }`) に絞り込み
- 差分 0% にするための補償 CSS を完全に列挙

### ブラインドテスト (after を見せない)

> 詳細: `docs/reports/2026-04-01-tailwind-migration-blind-test.md`

after.html を見せず、before.html (Tailwind) + VRT diff だけで vanilla CSS を生成させた。

| Iteration | desktop | mobile | 操作 |
|-----------|---------|--------|------|
| 0 (CSS なし) | 1.7% | 36.7% | — |
| 1 (初回 CSS) | 0.3% | 0.6% | Tailwind クラス → CSS 変換 |
| 3 (最終) | **0.0%** | **0.0%** | td:last-child font-size 修正 |

**3 ラウンド、58 tool calls (632s) で全 7 viewport pixel-perfect 達成。**

#### CSS 移行で効く知見

| 知見 | 内容 |
|------|------|
| **line-height が最重要** | Tailwind `text-sm` = font-size + line-height のセット。font-size だけ変換すると垂直ズレが累積 |
| **部分適用の罠** | クラスが一部の要素にだけ付いている場合、一括 CSS 変換で過剰適用 |
| **Preflight のバージョン差** | CDN vs PostCSS で微妙に異なる。font-smoothing, font-family |
| **heatmap が原因特定に有効** | diff % だけでなく spatial pattern (テーブル行のズレ等) が手がかり |
| **簡単な変換** | layout (flex/grid), 色, spacing, border → ほぼ 1:1 対応 |
| **難しい変換** | line-height, text-decoration, 部分適用, Preflight 互換 |

### 評価まとめ

| 指標 | 結果 |
|------|------|
| バグ特定の精度 | 高 — CSS プロパティ単位で原因を正確に特定 |
| 修正コードの品質 | 高 — ブラインドテストで 0.0% 達成 |
| 移行判断の妥当性 | 高 — destyle の不適合を正しく判定、modern-normalize を推奨 |
| ループ回数 | 3 ラウンドで pixel-perfect |
| エージェント効率 | 58 tool calls / 632s ≈ 10 分。人間なら数時間の作業 |

**vrt-harness は「移行を成立させるコードを生成する」基盤として十分に機能する。**

### Reset CSS blind test (E3)

> 詳細: `docs/reports/2026-04-04-e3-reset-css-blind-test.md`

normalize.css → modern-normalize への切り替えで、app CSS の補償を blind で書かせた。

| | 初期 diff | 修正後 | ラウンド | Tool calls | 時間 |
|---|---|---|---|---|---|
| Reset CSS (normalize → modern-normalize) | 2.6% | **0.0%** | **1** | **6** | **54s** |
| Tailwind → vanilla CSS (比較) | 36.7% | 0.0% | 3 | 58 | 632s |

修正内容: `*, *::before, *::after { box-sizing: content-box; }` の 1 行追加。
modern-normalize のグローバル `border-box` を打ち消して normalize.css と同じ box model に戻した。

## CSS 移行の Fix パターン集

ブラインドテスト 2 件 + 通常評価 2 件の知見から、CSS 移行で頻出する diff 原因と fix パターンを体系化。

### パターン 1: box-sizing の差異

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | 全体的な layout-shift。mobile で顕著 | reset CSS が `border-box` をグローバル適用 (modern-normalize, Tailwind Preflight) | `*, ::before, ::after { box-sizing: content-box }` で打ち消す、または padding/border を考慮して width を調整 |
| **VRT ヒント** | spatial pattern が全面的 (全要素が数 px ずれる) | | |
| **難易度** | 低 — 1 行修正 | | |

### パターン 2: line-height のセット漏れ

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | テキスト行の垂直ズレが累積。mobile で顕著 | Tailwind `text-sm` = font-size + line-height のセット。vanilla CSS で font-size だけ書くと line-height が body から継承 | 各テキストサイズに対応する line-height を明示指定 |
| **VRT ヒント** | heatmap でテキスト行ごとの横縞パターン | | |
| **難易度** | 中 — マッピングテーブルが必要 | | |

Tailwind line-height マッピング:
```
text-xs  (0.75rem)  → line-height: 1rem
text-sm  (0.875rem) → line-height: 1.25rem
text-base (1rem)    → line-height: 1.5rem
text-lg  (1.125rem) → line-height: 1.75rem
text-xl  (1.25rem)  → line-height: 1.75rem
text-2xl (1.5rem)   → line-height: 2rem
```

### パターン 3: inline style vs CSS specificity

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | 特定の要素が常に非表示/表示 | `style="display:none"` が CSS media query (`@media (min-width: 640px)`) より優先される | inline style を削除し、CSS クラスで制御 |
| **VRT ヒント** | 特定 viewport でのみ要素が欠落 | | |
| **難易度** | 低 — 構造の問題。CSS ではなく HTML の修正 | | |

### パターン 4: 部分適用 (一部の要素にだけクラスがある)

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | テーブルの行高さが微妙に異なる | Tailwind で `text-sm` が最初の 3 列だけに適用、最後の列は body デフォルト。vanilla CSS で全列に `font-size: 0.875rem` を適用すると過剰 | `td:not(:last-child) { font-size: 0.875rem }` 等のセレクタで限定 |
| **VRT ヒント** | テーブル行の高さが均等にずれる (2px/行 × N 行 = 累積) | | |
| **難易度** | 高 — before のクラス構造を読み解く必要がある | | |

### パターン 5: Preflight / reset CSS のデフォルト差

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | リストマーカー消失、form 要素の見た目変化 | destyle 等の aggressive reset で `list-style: none`, `appearance: none` が適用される | 必要なデフォルトを明示的に復元: `ul { list-style: disc }`, `select { appearance: auto }` |
| **VRT ヒント** | diff が非常に大きい (6-12%)。特定の要素タイプに集中 | | |
| **難易度** | 高 — drop-in 置換不可。normalize の再実装に近い | | |

### パターン 6: heading の margin-top 欠落

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | h1 以降の全コンテンツが上にずれる | normalize.css は `h1 { margin: 0.67em 0 }` を設定。modern-normalize はしない。app CSS が `margin-bottom` のみ指定で `margin-top` が異なる | `h1 { margin-top: 0.67em }` を追加 |
| **VRT ヒント** | h1 の位置から下方向に累積シフト | | |
| **難易度** | 低 — 1 行修正 | | |

### パターン 7: font-smoothing の差

| | 症状 | 原因 | 修正 |
|---|------|------|------|
| **検出** | 全テキストの微小な pixel diff (<0.5%) | Tailwind Preflight (PostCSS) は `-webkit-font-smoothing: antialiased` を含むが CDN 版は含まない | font-smoothing を明示指定、または削除して統一 |
| **VRT ヒント** | diff が全面的だが比率が非常に小さい | | |
| **難易度** | 低 — 1 行、ただしバージョン依存 | | |

### Fix パターンの適用順序

CSS 移行の diff を修正する際の推奨順序:

1. **box-sizing** — 全体に影響。最初に揃える
2. **heading/block の margin** — 上方向の累積シフトを解消
3. **line-height** — テキスト行の垂直ズレを解消
4. **inline style → CSS** — specificity 問題を解消
5. **部分適用の修正** — セレクタの限定
6. **Preflight デフォルト** — リストマーカー、form 要素
7. **font-smoothing** — 最後の微調整

この順序で適用すると、各ステップで diff が確実に減少し、VRT ループの収束が速い。

### 画像サイズ不一致の扱い

初回テストで「高さが異なるとページ全体が 100% diff」になる問題が発覚。
共通領域のみ pixelmatch で比較し、余剰領域は追加 diff として計上する方式に修正。
これにより高さが数 px 異なるだけで全面 diff になることを防いだ。

## pixelmatch 実装比較

同一画像 (identical) での比較。500x500 = 250,000 pixels。

| 実装 | 500x500 | 1280x900 | 1920x1080 |
|------|---------|----------|-----------|
| **npm pixelmatch v7** (JS) | **0.56ms** | **2.52ms** | **4.50ms** |
| mizchi/pixelmatch (MoonBit JS) | 1.94ms | ~9ms (est.) | ~16ms (est.) |
| mizchi/pixelmatch (MoonBit WASM-GC) | 1.11ms | ~5ms (est.) | ~9ms (est.) |

npm pixelmatch v7 が最速 (C で書かれた algorithm の JS 実装)。
MoonBit WASM-GC は JS 版より ~1.7x 速いが、npm v7 には及ばない。

**ボトルネックは pixelmatch ではなく PNG encode** (153ms/回)。crater の `capturePaintData` (生 RGBA) を使えば PNG encode/decode をスキップできる。

| 操作 | 時間 | 備考 |
|------|------|------|
| pixelmatch 1280x900 | 2.5ms | 高速。ボトルネックではない |
| PNG encode 1280x900 | 153ms | **最大のボトルネック** |
| PNG decode 1280x900 | 73ms | 2番目 |
| paint tree diff (125 nodes) | 0.07ms | crater 固有。極めて高速 |

**最適化の方向**: PNG を介さず生 RGBA で比較する。crater prescanner では既にこれが可能。

## 知見のまとめ

### 効果が高かった手法 (実装済み)

| 手法 | 改善幅 | 仕組み |
|------|--------|--------|
| **Multi-viewport** | +7→+9% | wide(1440) + desktop(1280) + mobile(375) の 3 viewport |
| **Computed style diff** | +10% | `getComputedStyle` でセマンティックタグ含む全要素を比較 |
| **Hover emulation** | +6% | `:hover` ルールを常時有効化 `<style>` として注入 → computed style 差分 |
| **Dead-code 分類** | 精度向上 | 全 viewport で差分ゼロ → デッドコードとして除外 |

### CSS プロパティの検出容易性ランキング (最終版, 60 trial)

```
100%  display, font-size, color, text-decoration, width, height
      align-items, border-radius, margin-*, font-weight, flex
 90%  background, padding (コンテキスト依存)
  0%  デッドコード (上書きされたルール / 対象要素なし)
```

### 最終検出率 (90 trial, 3 fixture, 741 CSS 宣言)

```
VRT 検出率:      92.2%  (83/90)
未検出の内訳:     dead-code 71%, same-as-default 14%, hover-only 14%

Fixture 別:
  page (GitHub風):       96.7%  (29/30) — dead-code 1件
  form-app (設定画面):   96.7%  (29/30) — dead-code 1件
  dashboard:             83.3%  (25/30) — dead-code 3, same-as-default 1, hover-only 1
```

### プロパティカテゴリ別 (90 trial)

```
100%  spacing (9), typography (20), layout (17)
 91%  visual (33)  — background の同系色問題
 71%  sizing (7)   — natural size と同値の dead-code
  0%  animation (1) — 完了後のキャプチャでは不可視
```

### Always Detected (100%, n>=2)

`font-size` (9), `color` (9), `text-decoration` (6), `display` (5), `border-radius` (4), `padding` (4), `gap` (4), `border-bottom` (4), `align-items` (3), `height` (3)

### Flaky (不安定)

- `width` 50% — natural size と CSS width が同値の dead-code
- `background` 82% — 親と同系色、`pre code` 上書き等

## VLM モデル比較 (2026-04-04)

### Fix Loop 結果 (hard case: .readme-body pre 6 props, 4.1% diff)

| Model | Fix | 速度 | コスト/call | 月額 (21K/日) | CHANGE 数 |
|-------|-----|------|-----------|-------------|----------|
| **meta-llama/llama-4-scout** | ✅ 1r | **1.0s** | $0.14e-7 | **$0.09** | 11 |
| **amazon/nova-lite-v1** | ✅ 1r | 2.3s | $0.14e-7 | $0.09 | 7 |
| qwen/qwen3-vl-235b-a22b (MoE) | ✅ 1r | 3.2s | $0.25e-7 | $0.16 | 8 |
| amazon/nova-2-lite-v1 | ✅ 1r | 3.5s | $1.38e-7 | $0.87 | 27 |
| google/gemini-3-flash-preview | ✅ 1r | 5.1s | $1.20e-7 | $0.76 | 10 |
| qwen/qwen3-vl-8b-instruct | ✅ 1r | 7.0s | $0.30e-7 | $0.19 | 28 |
| bytedance-seed/seed-1.6-flash | ✅ 1r | 8.6s | $0.49e-7 | $0.31 | 10 |
| openai/gpt-5-nano | ✅ 1r | 10.1s | $0.24e-7 | $0.15 | 0 |
| google/gemma-4-31b-it | ✅ 1r | 40.5s | $0.10e-7 | $0.06 | — |
| openai/gpt-4.1-nano | ❌ | 1.2s | — | — | — |

### 画像解像度とトークンコスト

| 解像度 | トークン | コスト倍率 |
|--------|---------|----------|
| 800x600 (full) | 499 | 1x |
| 400x300 (medium) | 132 | 0.26x |
| 200x150 (low) | 94 | 0.19x |

色 (カラー/グレースケール/2値) はトークン数に影響しない。

### Viewport 別解像度プリセット

| Preset | サイズ | 対応 viewport |
|--------|--------|-------------|
| low | 375x320 | mobile (375-640px) |
| medium | 640x480 | tablet/desktop (768-1280px) |
| high | 1280x900 | wide (1440px+) |

### 2段階パイプライン

```
Stage 1 (VLM, 安い): heatmap → 構造化 diff (CHANGE: element | property | before | after)
Stage 2 (LLM, 高精度): 構造化 diff + CSS source + CSS text diff → FIX: selector | property | value
```

**CSS text diff を Stage 2 に直接渡すと VLM の品質差が無関係になる。** 全モデルが同じ fix 結果に到達。

### コスト試算 (10,000 ページ/日)

| 構成 | AI/月 | レンダリング/月 | 合計 |
|------|-------|-------------|------|
| Crater + llama-4-scout | $0.09 | $0 | **$0.09** |
| Crater + free モデル | $0 | $0 | **$0** |
| Chromium + llama-4-scout | $0.09 | $168 | $168 |

### レンダリングコスト比較 (10,000 ページ/日, 80,500 renders)

| | Chromium | Crater pixel | Crater paint tree | Crater batch |
|---|---|---|---|---|
| 速度/VP | 600ms | 50ms | 18ms | 10ms |
| CPU/日 | 13.5h | 1.1h | 0.4h | 0.2h |
| Speedup | 1x | 12x | 33x | 60x |

### インフラ別 合計月額 (AI $0.10 + Compute)

| 構成 | 月額 |
|------|------|
| Self-hosted + Crater | **$0.10** |
| Fly.io + Crater paint tree | **$0.14** |
| Fly.io + Crater pixel | $0.21 |
| CF Workers + Crater WASM | $1 |
| GH Actions + Crater paint tree | $6 |
| GH Actions + Crater pixel | $16 |
| GH Actions + Chromium | $193 |
