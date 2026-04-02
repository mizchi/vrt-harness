# crater breakpoint discovery 設計

2026-04-02 時点では crater core / BiDi / `vrt-harness` 連携は実装済みで、未完は external stylesheet discovery などの v2 領域。

## 背景

当初の `vrt-harness` は breakpoint を quickcheck の境界値として扱う発想は持っていたが、抽出は regex ベースで、`<style>` しか見ていなかった。

現在は `migration-compare --discover-backend auto|regex|crater` が入り、既定の `auto` は crater の `getResponsiveBreakpoints` を優先し、使えない場合だけ regex discovery にフォールバックする。

一方 `crater` は以下をすでに持っている。

- media query parser / evaluator
- stylesheet parser
- BiDi 拡張 (`capturePaintTree`, `setViewport`)

そのため、breakpoint discovery の正規化と contract は `crater` 側に寄せ、`vrt-harness` 側はそれを test input に変換する責務に絞るのが自然。

## ゴール

- CSS media query から responsive breakpoint 候補を parser ベースで抽出できる
- `vrt-harness` がそれを quickcheck の境界値として viewport 群に変換できる
- `migration-compare` で baseline / variant の breakpoint を union して使える
- 将来 external stylesheet や container query に拡張しやすい contract を先に固定する

## 非ゴール

- v1 で「見た目が実際に変わる breakpoint」を推定すること
- v1 で container query や `prefers-color-scheme` を test input に展開すること
- `crater` が viewport budget や random sampling policy まで持つこと
- `flaker` 用の固定 viewport 戦略を `crater` に移すこと

## 責務境界

### crater が持つ責務

- media query を parser ベースで正規化する
- `px / em / rem` のような単位差を吸収する
- `min-width`, `max-width`, range syntax を同じ contract に落とす
- 現在の document から breakpoint 候補を返す
- 幅以外の条件や未対応条件を diagnostics として返す

### vrt-harness が持つ責務

- baseline / variant の breakpoint 集合を union する
- `>= N` を `N-1, N` に展開するなど、quickcheck 境界入力へ変換する
- `maxViewports`, `randomSamples`, 標準 viewport 混在を制御する
- flaky 解析や CI 用の固定 viewport manifest を管理する

## 基本方針

`crater` が返すのは `suggested viewports` ではなく `canonical responsive breakpoints` に留める。

理由:

- viewport 生成は `vrt-harness` の test policy
- `maxViewports` や `randomSamples` は harness / CI の都合で変わる
- `flaker` のような安定 identity を要求する系では fixed viewport が必要
- `crater` は CSS semantics の正として振る舞う方が再利用しやすい

## 目指す API 層

```text
crater core
  -> discover_responsive_breakpoints(html, external_css?)

crater BiDi
  -> browsingContext.getResponsiveBreakpoints

vrt-harness
  -> union breakpoints
  -> generateViewports(...)
```

## v1 スコープ

v1 は narrow に切る。

- axis: `width` のみ
- media type: `screen`, `all`, type 省略のみ
- feature:
  - `min-width`
  - `max-width`
  - `width >=`
  - `width >`
  - `width <=`
  - `width <`
- unit:
  - `px`
  - `em`
  - `rem`
- source:
  - current document に存在する inline / live `<style>`

## v1 で diagnostics に逃がすもの

- `print`, `speech`
- `height`, `min-height`, `max-height`
- `orientation`
- `aspect-ratio`
- `prefers-color-scheme`
- `prefers-reduced-motion`
- `container query`
- `vw`, `vh`
- `not ...`

ただし width 条件と同時に出るものは、完全に捨てず `guards` として返す。

例:

```css
@media (min-width: 768px) and (orientation: landscape) { ... }
```

この場合は `width >= 768` を breakpoint として返し、`orientation:landscape` は `guards` に載せる。

## crater core contract

```ts
type ResponsiveBreakpoint = {
  axis: "width";
  op: "ge" | "gt" | "le" | "lt";
  valuePx: number;
  raw: string;
  normalized: string;
  guards: string[];
  ruleCount: number;
};

type BreakpointDiscoveryDiagnostics = {
  stylesheetCount: number;
  ruleCount: number;
  externalStylesheetLinks: string[];
  ignoredQueries: string[];
  unsupportedQueries: string[];
};

type BreakpointDiscoveryResult = {
  breakpoints: ResponsiveBreakpoint[];
  diagnostics: BreakpointDiscoveryDiagnostics;
};
```

### 正規化ルール

- `min-width: 768px` -> `{ op: "ge", valuePx: 768 }`
- `max-width: 48em` -> `{ op: "le", valuePx: 768 }`
- `width > 600px` -> `{ op: "gt", valuePx: 600 }`
- `width < 1024px` -> `{ op: "lt", valuePx: 1024 }`

同値 breakpoint は `(op, valuePx, guards)` 単位で集約し、`ruleCount` を加算する。

## crater BiDi contract

メソッド名:

```json
{
  "method": "browsingContext.getResponsiveBreakpoints",
  "params": {
    "context": "session-1",
    "mode": "live-inline",
    "axis": "width",
    "includeDiagnostics": true
  }
}
```

レスポンス:

```json
{
  "breakpoints": [
    {
      "axis": "width",
      "op": "ge",
      "valuePx": 768,
      "raw": "(min-width: 48em)",
      "normalized": "(width >= 768px)",
      "guards": [],
      "ruleCount": 8
    }
  ],
  "diagnostics": {
    "stylesheetCount": 2,
    "ruleCount": 145,
    "externalStylesheetLinks": [],
    "ignoredQueries": ["print"],
    "unsupportedQueries": ["(prefers-color-scheme: dark)"]
  }
}
```

### `mode` を入れる理由

最初から `mode` を持たせておくと、後で transport を壊さずに拡張できる。

- `live-inline`: live document を serialize して inline `<style>` を解析
- `html-inline`: `__lastHTML` ベースで元 HTML を解析
- 将来: `live-inline+external`

既定値は `live-inline` を推奨する。runtime-injected `<style>` を拾えるため。

## crater 内部実装方針

新規モジュール候補:

```text
src/css/media/discovery.mbt
```

責務:

- HTML から stylesheet text を集める
- 各 stylesheet を `parse_stylesheet` する
- `rule.media_query` を走査する
- width 系条件を canonical breakpoint に変換する
- diagnostics を組み立てる

擬似アルゴリズム:

```text
parse_document(html)
  -> stylesheets[]
  -> stylesheet_links[]

for each stylesheet
  parse_stylesheet(css)
  for each rule
    if media_query exists
      extract width breakpoints
      classify non-width conditions into guards / ignored / unsupported
      aggregate ruleCount
```

### なぜ pure API を先に作るか

- BiDi transport なしで unit test できる
- HTML fixture から deterministic に検証できる
- 将来 CLI や batch API にも再利用できる

## live document と external CSS の扱い

### v1

`capturePaintTree` と同様に live document を serialize して pure API に渡す。  
この段階では inline `<style>` と runtime-injected `<style>` を対象にする。

### v2

外部 stylesheet も discovery に含める。

候補は 2 案。

1. session / browser 側の loaded CSS text を BiDi handler から参照する
2. `globalThis.__loadedStylesheets` のような JS 側キャッシュを持つ

現状の `SessionState` は薄く、browser state を直接持っていないため、v1 はここまで踏み込まない。

## vrt-harness 側の受け口

`src/viewport-discovery.ts` は regex extraction と viewport generation が密結合している。  
crater 導入時には、生成ロジックを正 API にして抽出元を差し替えられるようにする。

想定:

- `extractBreakpointsRegex()` を fallback として残す
- `generateViewports()` を `op` ベースに拡張
- `discoverViewports()` は crater / regex の adapter にする

### boundary への写像

- `ge N` -> `N-1`, `N`
- `gt N` -> `N`, `N+1`
- `le N` -> `N`, `N+1`
- `lt N` -> `N-1`, `N`

`migration-compare` は baseline / variant を別々に問い合わせ、breakpoint を union してから viewport を生成する。

## testing strategy

### crater core unit tests

最低限の Red:

1. `@media (min-width: 768px)` -> `ge 768`
2. `@media (max-width: 48em)` -> `le 768`
3. `@media (width > 600px)` -> `gt 600`
4. `@media (min-width: 768px) and (orientation: landscape)` -> `ge 768 + guards`
5. comma-separated query を dedupe できる
6. `print` を `ignoredQueries` に積む

### BiDi integration tests

- current context の inline `<style>` を取れる
- runtime に追加した `<style>` も取れる
- context 不正時に `no such frame`
- 未対応条件が diagnostics に出る

### vrt-harness tests

- crater breakpoint を `generateViewports()` に流せる
- baseline / variant の union が取れる
- `--discover-backend crater|regex|auto` の切り替えができる
- crater unavailable 時は regex fallback

## 段階的な実装

### Phase 1

- crater core: `discover_responsive_breakpoints(html)`
- crater BiDi: `browsingContext.getResponsiveBreakpoints`
- vrt-harness: crater client method

### Phase 2

- `viewport-discovery.ts` を `extract` と `generate` に分離
- `migration-compare` に `--discover-backend crater|regex|auto`
- baseline / variant の breakpoint union
- report に discovery diagnostics を残す

### Phase 3

- external stylesheet 対応
- `ruleCount` で breakpoint の優先度付け
- `height`, `orientation`, `prefers-color-scheme` の段階的対応
- `vrt discover` CLI に crater backend を載せる

## open questions

### 1. `not` をどう扱うか

v1 は diagnostics に逃がすのが安全。  
`not` を正確に境界値へ落とすと semantic が一段複雑になる。

### 2. `guards` を viewport へ反映するか

v1 はしない。  
`orientation` や color scheme を同時にテストしたくなった段階で、viewport 以外の test dimension に拡張する。

### 3. external stylesheet をどこで保持するか

BiDi session 直下ではなく、browser runtime 側に寄せる方が自然。  
ただし v1 の価値は inline/live styles だけでも十分ある。

## 採用判断

この設計を採ると、

- `crater` は CSS / media semantics の正
- `vrt-harness` は quickcheck 入力生成の正

という役割分担が崩れない。  
v1 を narrow に切れるので、parser ベース discovery の価値を早く出しつつ、external CSS や multi-axis discovery へ安全に拡張できる。
