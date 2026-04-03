# TODO

## Vision

**大規模レンダラー間の差分検証ツール**。

ユースケース:
- Chromium vs Crater (ブラウザエンジン間の差分)
- Website v1 vs v2 (UI ライブラリのリライト)
- デザインシステムのバージョン間比較

Crater 込みで Cloudflare Workers 上で動作する。WebUI は別リポジトリ。

## Done (65 items)

### Core Pipeline
- [x] 3-track parallel pipeline (Diff Intent / Visual Semantic / A11y Semantic)
- [x] Cross-validation matrix (Visual × A11y × Intent)
- [x] 2-tier expectations (short-cycle + long-cycle spec)
- [x] Introspect / Spec verify / Reasoning chains / Goal Runner
- [x] Visual pipeline: pixelmatch v7 + heatmap + image size mismatch handling

### CSS Challenge Bench
- [x] 3 fixture (page / dashboard / form-app), 741 CSS 宣言
- [x] Property deletion mode + Selector block deletion mode
- [x] Multi-viewport (wide 1440 + desktop 1280 + mobile 375)
- [x] Computed style diff (esbuild __name bug 修正済み)
- [x] Hover emulation (:hover/:focus ルール常時有効化 + Playwright fallback)
- [x] ::before/::after pseudo-element computed style
- [x] CSS Custom Properties var() 追跡
- [x] Detection pattern DB (JSONL) + 集計レポート
- [x] Property/selector 分類, 未検出理由の自動分類 (dead-code, hover-only, etc.)
- [x] Chromium 検出率 93.3% (scoped)

### Crater 統合
- [x] Crater BiDi クライアント + Paint tree diff (検出率 60%, 偽陽性 0%)
- [x] Prescanner モード (1.66x speedup)
- [x] Best-effort computed style capture via BiDi
- [x] Bench summary persistence + speedup report

### Migration VRT
- [x] migration-compare.ts: breakpoint 自動発見 + quickcheck 的 viewport 生成
- [x] Reset CSS fixture (normalize / modern-normalize / destyle / no-reset)
- [x] Tailwind → vanilla CSS fixture + blind test (0.0% pixel-perfect 達成)
- [x] shadcn/ui → luna fixture
- [x] Diff approval system (tolerance, expires, issue 連携)
- [x] Auto-approve workflow (vrt-approve)

### Viewport Discovery
- [x] @media breakpoint 抽出 (regex + crater BiDi)
- [x] 境界 ±1px + ランダムサンプルの viewport 生成
- [x] ResponsiveBreakpoint 型 (ge/gt/le/lt) + merge
- [x] crater getResponsiveBreakpoints BiDi API 統合

### API / CLI
- [x] API 型定義 (src/api-types.ts) — Compare, Smoke, Report, Status
- [x] Hono API サーバー (/api/compare, /api/compare-renderers, /api/smoke-test, /api/status)
- [x] /api/compare に computed style diff 統合
- [x] VrtClient SDK (src/vrt-client.ts)
- [x] 統一 CLI (src/vrt.ts) — compare, bench, report, discover, smoke, serve, status
- [x] GitHub Actions CI workflow (vrt-compare.yml)

### Smoke Test
- [x] A11y-driven ランダム操作 (Playwright getByRole)
- [x] Disabled 要素スキップ
- [x] LLM reasoning モード
- [x] Console error / uncaught exception / crash 監視
- [x] External navigation ブロック
- [x] Seed ベースの再現可能なランダム化

### Performance
- [x] pixelmatch v6 → v7
- [x] pixelmatch native benchmark (85µs, 6.6x vs npm v7)
- [x] tsx → node --experimental-strip-types (esbuild 排除)
- [x] benchmark.ts (決定的 API のベースライン計測)

### CI / Integration
- [x] flaker VRT runner + adapters (migration, bench)
- [x] migration-report / bench-report artifact workflows

---

## Evaluation Phase — 次にやること

### E1. 外部プロジェクトでの dogfooding

実際のプロジェクトで vrt-harness を使い、実用性を検証する。

- [ ] 既存の Web プロジェクトで `vrt compare` を実行
- [ ] PR ごとの CI で VRT を回し、false positive 率を計測
- [ ] subagent に diff レポートを渡して修正コードを生成させ、成功率を計測
- [ ] 結果を `docs/reports/` に記録

### E2. Crater prescanner の追跡

crater 側の修正 (#18-22) 後の検出率向上を計測する。

- [ ] text-decoration #18 修正後のベンチ再実行
- [ ] 検出率 60% → 目標 80%+ への進捗追跡
- [ ] prescanner speedup 1.66x → 目標 3x+ への進捗追跡

### E3. Blind test の追試

Tailwind blind test を別の fixture/シナリオで再現し、再現性を確認する。

- [ ] shadcn → luna で blind test
- [ ] Reset CSS 切り替えで blind test
- [ ] 成功基準: 3 ラウンド以内に diff < 1%

---

## Backlog (評価後に優先度を決める)

### インフラ / デプロイ
- [ ] Cloudflare Workers エントリポイント (`worker/`)
- [ ] crater WASM バックエンド (layout のみ — paint は将来)
- [ ] Cloudflare R2 / KV / D1 ストレージ
- [ ] npm パッケージ化 (`@mizchi/vrt-client`)
- [ ] OpenAPI spec

### Crater 側 (mizchi/crater)

**レンダリング修正**:
- [ ] text-decoration #18 / border-radius #19 / font-weight #20 / margin #21 / align-items #22

**VRT 検出率向上 (94.4% → 100%)**:
- [ ] Breakpoint-aware CSS rule mapping #33 — media-scoped 検出漏れ解消
- [ ] Hover/focus state computed style #34 — hover-only 検出漏れ解消
- [ ] Computed styles BiDi #26 — prescanner 検出率 60% → 80%+
- [ ] CSS rule usage tracking #27 — dead-code 判定

**VRT 最適化**:
- [ ] Paint tree diff API #23 / CSS mutation API #24 / Selector-scoped rendering #25
- [ ] Batch rendering #28
- [ ] VRT prescanner benchmark tracking #29

### 機能拡張
- [ ] コンポーネント (セレクタ) 単位の比較
- [ ] 差分の分類強化 (layout shift / color change / text change / element added/removed)
- [ ] Smoke test: Crater BiDi バックエンド
- [ ] Smoke test: 操作後の a11y tree 整合性チェック
- [ ] animation 検出 (animation-play-state: paused / CSSOM diff)
- [ ] external stylesheet の breakpoint discovery

### Playwright 統合
- [ ] `nlAssert()` with Vision LLM
- [ ] `onlyOnFailure` pattern
- [ ] `toHaveScreenshot()` integration

### Spec coverage
- [ ] Heading hierarchy validation
- [ ] ARIA relationship validation
- [ ] Color contrast invariants
- [ ] Responsive layout invariants

### ダッシュボード (別リポジトリ)
- [ ] 実行結果の一覧・検索
- [ ] 差分のビジュアル表示 (heatmap, side-by-side, overlay)
- [ ] Approval の対話的操作
- [ ] 検出率の時系列グラフ
- [ ] コンポーネント単位のステータスマトリクス
