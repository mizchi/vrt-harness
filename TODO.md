# TODO

## Vision

**大規模レンダラー間の差分検証ツール**。

ユースケース:
- Chromium vs Crater (ブラウザエンジン間の差分)
- Website v1 vs v2 (UI ライブラリのリライト)
- デザインシステムのバージョン間比較

Crater 込みで Cloudflare Workers 上で動作する。WebUI は別リポジトリ。

## Done

- [x] 3-track parallel pipeline (Diff Intent / Visual Semantic / A11y Semantic)
- [x] Cross-validation matrix (Visual × A11y × Intent)
- [x] 2-tier expectations (short-cycle + long-cycle spec)
- [x] Introspect / Spec verify / Reasoning chains / Goal Runner
- [x] Visual pipeline: pixelmatch + heatmap
- [x] CSS Challenge: 3 fixture, 741 CSS 宣言, Chromium 93.3%
- [x] Multi-viewport (wide 1440 + desktop 1280 + mobile 375)
- [x] Computed style diff + Hover emulation + ::before/::after
- [x] Detection pattern DB (JSONL) + 集計レポート
- [x] Crater BiDi 統合 + Paint tree diff (検出率 60%, 偽陽性 0%)
- [x] Prescanner 実測 (1.66x speedup, 40% 時間短縮)

---

## Backlog

### 1. Diff Approval System — 許容する差分の宣言

大規模レンダラー比較では、100% 一致は非現実的。**許容する差分パターンを宣言して approve** する仕組みが必要。

#### 1.1 Approval manifest

```typescript
interface ApprovalManifest {
  rules: ApprovalRule[];
}

interface ApprovalRule {
  // マッチ条件
  selector?: string;           // ".header", "nav > a" etc.
  property?: string;           // "font-size", "color" etc.
  category?: PropertyCategory; // "typography", "visual" etc.
  changeType?: string;         // "geometry", "paint", "text"

  // 許容条件
  tolerance?: {
    pixels?: number;           // pixel diff 許容値
    ratio?: number;            // diff ratio 許容値 (0-1)
    geometryDelta?: number;    // x/y/w/h の許容誤差 (px)
    colorDelta?: number;       // RGBA 各チャネルの許容誤差
  };

  // メタ
  reason: string;              // "crater does not support text-decoration yet"
  issue?: string;              // "mizchi/crater#18"
  expires?: string;            // "2026-06-01" — 期限付き approve
}
```

- [x] ApprovalManifest 型定義とパーサー
- [x] paint tree diff / pixel diff に tolerance を適用するフィルタ
- [x] `approval.json` をプロジェクトに配置して diff 判定に使用
- [x] `--strict` フラグで approval 無視 (全差分を報告)
- [x] 期限切れ approval の警告

#### 1.2 Auto-approve ワークフロー

- [x] 差分レポートから `approval.json` エントリを生成するヘルパー
- [x] `just vrt-approve` で未承認の差分を対話的に approve/reject
- [x] approve 履歴の追跡 (誰が、いつ、なぜ)

### 2. API インターフェース — Cloudflare Workers 対応

WebUI とは切り離した headless API。Cloudflare Workers + crater WASM で動作。

#### 2.1 Core API (REST/JSON)

```
POST /api/compare
  body: { baseline: HTML, current: HTML, viewport, options }
  response: { diffResult, paintTreeChanges, approvalStatus }

POST /api/compare/batch
  body: { baseline: HTML, mutations: [...], viewport }
  response: { results: [...] }

GET /api/report/:runId
  response: { summary, trials, byCategory, ... }

POST /api/approve
  body: { runId, rules: ApprovalRule[] }

GET /api/status
  response: { craterVersion, capabilities, ... }
```

- [x] API 型定義 (`src/api-types.ts`)
- [x] ローカル実行用の API サーバー (`src/api-server.ts`) — Node.js / Hono
- [ ] Cloudflare Workers エントリポイント (`worker/`)
- [ ] crater WASM バックエンド (layout のみ — paint は将来)
- [ ] レスポンスの JSON スキーマ / OpenAPI spec

#### 2.2 Client SDK

- [x] TypeScript client (`src/vrt-client.ts`)
- [ ] CLI wrapper (`vrt compare --baseline a.html --current b.html`)
- [ ] CI integration (GitHub Actions)
- [ ] npm パッケージ化 (`@mizchi/vrt-client`)

#### 2.3 データストレージ

- [ ] Cloudflare R2 にスナップショット/レポートを保存
- [ ] KV に approval manifest を保存
- [ ] D1 に実行履歴を保存 (将来)

#### 2.4 flaker / CI integration

> 設計: [docs/flaker-integration-design.md](/Users/mz/ghq/github.com/mizchi/vrt-harness/docs/flaker-integration-design.md)

- [x] `flaker.vrt.json` の型定義と loader
- [x] `src/flaker-vrt-runner.ts` custom runner (`migration-compare` -> `TestCaseResult[]`)
- [x] `examples/flaker.toml` / `examples/flaker.vrt.json`
- [x] `migration-report.json` import adapter
- [x] `metric-ci` built-in `vrt-migration` adapter (`flaker import --adapter vrt-migration`)
- [x] `migration-report` artifact workflow (`.github/workflows/migration-report.yml`)
- [x] `metric-ci` built-in `vrt-bench` adapter (`flaker import --adapter vrt-bench`)
- [x] `bench-report` artifact workflow (`.github/workflows/bench-report.yml`)

### 3. Renderer Comparison Mode — レンダラー間差分

Website v1 vs v2 やレンダラー比較の汎用フレームワーク。

- [ ] 2つの HTML/URL を入力として受け取り、両方をレンダリングして比較
- [ ] レンダラーの組み合わせ指定: `chromium vs crater`, `crater-v1 vs crater-v2`, `url-a vs url-b`
- [ ] ページ単位ではなくコンポーネント (セレクタ) 単位の比較
- [ ] 差分の分類: layout shift / color change / text change / element added/removed
- [ ] Approval manifest で既知の差分をフィルタ

#### 3.1 Responsive breakpoint discovery via crater

> 設計: [docs/crater-breakpoint-discovery-design.md](/Users/mz/ghq/github.com/mizchi/vrt-harness/docs/crater-breakpoint-discovery-design.md)

- [x] crater core に parser ベースの `discover_responsive_breakpoints(html, external_css?)`
- [x] crater BiDi に `browsingContext.getResponsiveBreakpoints`
- [x] v1 は width-only / screen-only / inline-live styles に限定
- [x] `vrt-harness` 側の `viewport-discovery.ts` を extract / generate に分離
- [x] `migration-compare --discover-backend crater|regex|auto`
- [x] baseline / variant の breakpoint union
- [x] discovery diagnostics を report JSON に保存
- [ ] v2 で external stylesheet を discovery に含める

### 4. ダッシュボード (別リポジトリ、将来)

> WebUI は API の上に構築する。このリポジトリでは API まで。

- [ ] 実行結果の一覧・検索
- [ ] 差分のビジュアル表示 (heatmap, side-by-side, overlay)
- [ ] Approval の対話的操作
- [ ] 検出率の時系列グラフ (crater 改善のトラッキング)
- [ ] コンポーネント単位のステータスマトリクス

---

### 6. Migration VRT — CSS フレームワーク / UI ライブラリの移行検証

#### コンセプト

「見た目を変えずに実装を変える」移行の回帰テスト。VRT harness で差分を検出し、差分ゼロを目標にコード変更を繰り返す。最終的に「移行を成立させるコードを生成できるか？」で vrt-harness 自体を評価する。

#### 移行シナリオ

| シナリオ | Before | After | 難易度 |
|---------|--------|-------|--------|
| **Tailwind → vanilla CSS** | Tailwind utility classes | 等価な vanilla CSS | 中 |
| **shadcn/ui → luna** | React + shadcn/ui コンポーネント | mizchi/luna コンポーネント | 高 |
| **Reset CSS 切り替え** | normalize.css | modern-normalize / sanitize.css / destyle | 低 |

#### Viewport 戦略

各シナリオで以下の viewport をテスト:

```
PC:     1440px (wide), 1280px (desktop)
Mobile: 375px (iPhone SE), 390px (iPhone 14)
```

breakpoint がある場合 (例: `@media (max-width: 768px)`):
- breakpoint 直上 (769px) と直下 (768px) の 2 viewport を追加
- breakpoint 境界で layout が正しく切り替わるかを検証

#### Fixture 構成

```
fixtures/migration/
├── tailwind-to-vanilla/
│   ├── before.html         # Tailwind CDN + utility classes
│   ├── after.html          # 等価な vanilla CSS
│   └── approval.json       # 許容する差分 (あれば)
├── shadcn-to-luna/
│   ├── before.html         # React + shadcn/ui (SSR 済み HTML)
│   ├── after.html          # luna コンポーネント
│   └── approval.json
├── reset-css/
│   ├── normalize.html      # normalize.css
│   ├── modern-normalize.html
│   ├── sanitize.html
│   ├── destyle.html
│   └── content.html        # 共通の HTML コンテンツ (CSS だけ差し替え)
```

#### 実装タスク

**Phase 1: Fixture 作成と動作確認**

- [x] Tailwind fixture (before/after) — ダッシュボード UI を Tailwind → vanilla CSS
- [x] Reset CSS fixture — 同一 HTML に 4 種の reset CSS を適用
- [x] shadcn/luna fixture — Button, Card, Form, Dialog コンポーネント
- [x] Breakpoint 境界テスト (768px ±1, 1024px ±1)
- [x] `just migration-tailwind` / `just migration-shadcn` で差分比較

**Phase 2: Migration diff の評価**

- [x] Before/After の pixel diff + paint tree diff を取得
- [x] 差分を分類: layout shift / color change / spacing / typography
- [x] Approval manifest で「許容する差分」をフィルタ
- [x] tailwind-to-vanilla の after.html を差分ゼロまで修正
- [ ] 他 fixture の残差分ゼロ化 / approval manifest 整備

**Phase 3: vrt-harness 自体の評価**

- [x] 差分レポートから「修正すべき CSS」を特定できるか？
- [x] LLM に diff を渡して修正コードを生成できるか？
- [x] 修正 → VRT → 差分チェック → 修正のループが回るか？
- [x] 最終的に差分ゼロ (または approval 済み) に到達するか？

### CSS 検出精度の改善

> 知見: `docs/knowledge.md` | crater 状況: `docs/crater-css-status.md`

#### animation 検出 (スコープ外 — 別手法)

- [ ] `animation-play-state: paused` 注入 / CSSOM diff / rAF ベース

#### hover emulation 安定化

- [x] rAF 待ち + reflow 強制
- [x] Playwright hover/focus フォールバック

#### CSS Custom Properties

- [x] `var()` 使用箇所追跡 → 参照先 computed style / hover style 比較

#### fixture 追加

- [x] e-commerce / blog / LP / admin

### Crater 統合

> crater issue: #18-22 (バグ修正), #23-28 (VRT 最適化), #29 (ベンチマーク追跡)

#### Crater 側 (mizchi/crater)

- [ ] text-decoration #18 / border-radius #19 / font-weight #20 / margin #21 / align-items #22
- [ ] Paint tree diff API #23 / CSS mutation API #24 / Selector-scoped rendering #25
- [ ] Computed styles BiDi #26 / CSS rule usage #27 / Batch rendering #28
- [ ] VRT prescanner benchmark tracking #29

#### VRT harness 側

- [x] Paint tree diff signal (検出率 +10%, 偽陽性 0%)
- [x] Prescanner モード (crater → Chromium fallback)
- [x] Bench summary persistence / speedup report (`data/bench-history.jsonl`, `just css-report`)
- [x] Best-effort computed style capture via BiDi (`script.evaluate` ベース, empty snapshot は自動無効化)
- [ ] Computed style via BiDi (#26 対応後)
- [ ] Batch rendering (#28 対応後)

### 5. A11y-Driven Smoke Test Runner — ランダム操作によるクラッシュ検出

アクセシビリティツリーからインタラクティブ要素を列挙し、**サイト内に留まる範囲で**ランダムな操作を行い、クラッシュやエラーを検出するスモークテストランナー。

#### コンセプト

```
[ページ読み込み]
  │
  ▼
[a11y ツリー取得] → インタラクティブ要素を列挙
  │                  button, link, textbox, checkbox, tab, ...
  ▼
[操作候補の生成]
  │  ├── ランダムモード: 要素をランダムに選んでクリック/入力/トグル
  │  └── LLM reasoning モード: 「ユーザーっぽい操作列」を生成
  │
  ▼
[操作実行 + 監視]
  │  ├── console.error / uncaught exception を監視
  │  ├── ページクラッシュ (navigation error) を検出
  │  ├── レスポンスなし (timeout) を検出
  │  ├── a11y ツリーが壊れていないか検証
  │  └── 外部ナビゲーション (origin 外) をブロック
  │
  ▼
[レポート]
  │  ├── 実行した操作列 (再現用)
  │  ├── 検出したエラー
  │  └── 各ステップの a11y スナップショット
```

#### 設計ポイント

**サイト外に出ない制約**:
- `<a href>` のクリックは同一 origin のみ許可
- 外部リンクはクリック対象から除外 (href の origin チェック)
- `window.open` / `target="_blank"` をインターセプト
- ナビゲーション発生時は a11y ツリーを再取得して操作を継続

**操作の種類**:

| 要素の role | 操作 |
|------------|------|
| button | click |
| link (internal) | click → ナビゲーション → 新ページで続行 |
| textbox / searchbox | focus → ランダムまたは意味のある文字列を入力 |
| checkbox / switch | toggle (check/uncheck) |
| radio | ランダムに選択 |
| tab | click (タブ切り替え) |
| combobox / listbox | open → option 選択 |
| slider | value 変更 |
| menuitem | click |

**LLM reasoning モード**:
- a11y ツリーを LLM に渡して「ユーザーが取りそうな操作列」を生成
- 例: "フォームに入力 → 送信ボタン → 結果確認" のようなシナリオ
- ランダムより再現性のあるバグを見つけやすい

**監視項目**:
- `console.error` / `console.warn` のカウント
- uncaught exception / unhandled rejection
- ページのレスポンス (操作後 N 秒以内に a11y ツリーが安定するか)
- DOM 要素数の異常増加 (メモリリーク兆候)
- a11y ツリーの整合性 (ランドマーク消失、ラベル消失)

#### 実装タスク

- [x] `src/smoke-runner.ts` — コアランナー (Playwright getByRole → 操作候補 → 実行 → 監視)
- [x] 操作候補の生成 (ランダムモード) — role に応じた操作マッピング
- [x] Playwright バックエンド (クリック、入力、ナビゲーション)
- [x] エラー監視 (console, exception, timeout)
- [x] 操作列の記録と再現 (seed ベース)
- [x] レポート出力 (操作列 + エラー + a11y スナップショット)
- [x] `just smoke-test <url>` タスク
- [ ] Crater BiDi バックエンド (同じインターフェース)
- [ ] LLM reasoning モード (a11y ツリー → 操作列生成)
- [ ] disabled 要素のスキップ (timeout 回避)
- [ ] 操作後の a11y tree 整合性チェック (ランドマーク消失検出)

#### Crater との相乗効果

- crater の BiDi API は click/hover/type/check 等を全てサポート
- crater の a11y snapshot API で各ステップの a11y ツリーを取得
- Chromium なしでスモークテストが走る → CI 軽量化
- crater 自身のバグ検出にも使える (crater でクラッシュ = crater のバグ)

### Playwright integration

- [ ] `nlAssert()` with Vision LLM
- [ ] `onlyOnFailure` pattern
- [ ] `toHaveScreenshot()` integration

### Spec & invariant coverage

- [ ] Heading hierarchy / ARIA relationship / Color contrast / Responsive layout
