# vrt-harness

Visual Regression Testing + Accessibility Semantic Verification harness for coding agents.

Detects visual and semantic regressions, reasons about whether changes match intent, and generates fix plans — with optional LLM-powered AI diagnosis.

## Quick Start

```bash
pnpm install

# Run 150 tests
pnpm test

# Run demos (kitty terminal graphics)
pnpm demo              # 5 basic scenarios
pnpm demo:fix          # detect → AI diagnose → fix → verify
pnpm demo:multi        # 3 complex scenarios
pnpm demo:multistep    # 6-step dashboard rebuild

# With AI reasoning
ANTHROPIC_API_KEY=sk-ant-... pnpm demo:fix
```

## Architecture

```
Code Change
    │
    ├── Track 1: Diff Intent (git diff → dep graph → affected → intent)
    ├── Track 2: Visual Semantic Diff (screenshots → pixelmatch → heatmap → classify)
    └── Track 3: A11y Semantic Diff (a11y tree → diff → landmark/role/name changes)
          │
          ▼
    Cross-Validation (Visual × A11y × Intent)
          │
          ▼
    Verdict (approve / reject / escalate)
          │
          ▼
    Quality Gate (whiteout / error-state / coverage / a11y regression)
```

### Two-tier expectations

- **Short cycle** (`expectation.json`): per-commit — "this commit removes the nav"
- **Long cycle** (`spec.json`): invariants — "all pages must have a main landmark"

Short cycle can temporarily override long cycle (e.g., "regression-expected").

### Flexibility principle

`description` is canonical. Structured fields are optional hints. As models improve, structured fields become unnecessary — the system degrades gracefully to description-only.

```json
// Minimal (works today, works with future models)
{ "testId": "home", "expect": "Navigation removed from header" }

// With hints (better precision now)
{
  "testId": "home",
  "expect": "Navigation removed",
  "a11y": "regression-expected",
  "expectedA11yChanges": [{ "description": "Navigation landmark removed" }]
}
```

## CLI (when integrated with a project)

```bash
vrt init          # Create baseline screenshots + a11y trees
vrt capture       # Take current snapshots
vrt expect        # Auto-generate expectation.json from diff
vrt verify        # Run verification pipeline
vrt approve       # Promote snapshots to baselines
vrt introspect    # Generate spec.json from a11y snapshots
vrt spec-verify   # Verify spec invariants
vrt report        # Show last report
vrt graph         # Show dependency graph
vrt affected      # Show components affected by changes
```

## Approval Manifest

Known diff を `approval.json` で許容できる。

```json
{
  "rules": [
    {
      "selector": ".card",
      "property": "margin-left",
      "category": "spacing",
      "changeType": "geometry",
      "tolerance": { "pixels": 80, "ratio": 0.02, "geometryDelta": 4 },
      "reason": "Known small spacing drift between renderers",
      "issue": "mizchi/crater#21",
      "expires": "2026-06-01"
    }
  ]
}
```

- `src/migration-compare.ts` は `--approval path/to/approval.json` を受け取る。`--approval` を省略した場合、比較対象ディレクトリの `approval.json` を自動読込する。
- `src/migration-compare.ts` は `--output-dir <path>` を受け取り、`migration-report.json` の出力先を固定できる。`flaker` 連携や CI artifact 化ではこの経路を使う。
- `src/migration-compare.ts` は `--discover-backend auto|regex|crater` を受け取る。現時点の既定は `auto` で、Crater BiDi の `getResponsiveBreakpoints` が使えない場合は parser/regex ベース discovery に自動でフォールバックする。比較対象の breakpoint は baseline / variant の union を使う。
- `src/migration-compare.ts` の `migration-report.json` には `breakpointDiscovery` も残る。`crater` backend が使えた場合は document ごとの discovery diagnostics と totals も保存されるので、`ignoredQueries` や `unsupportedQueries` を後段で確認できる。
- migration fixture は `fixtures/migration/reset-css`, `fixtures/migration/tailwind-to-vanilla`, `fixtures/migration/shadcn-to-luna` を同梱している。`just migration-reset`, `just migration-tailwind`, `just migration-shadcn` でそれぞれ比較できる。
- `src/migration-compare.ts` は viewport ごとに diff を `layout-shift / spacing / color-change / typography` に分類し、summary と JSON report に載せる。
- `src/migration-compare.ts` の approval は diff 全体ではなく region 単位で評価する。migration category から `layout/spacing/visual/typography` と `geometry/paint/text` を推定するので、known diff の一部だけを残差分から外せる。JSON report には `rawCategorySummary` と `approvedPixels` も残す。
- `src/migration-compare.ts` は best-effort で `paint tree diff` も取得する。既定では `ws://127.0.0.1:9222` の Crater BiDi を見に行き、使えれば viewport ごとの `Paint Tree` summary と JSON report に `paintTree*` を載せる。無効化したい場合は `--no-paint-tree`、URL を変える場合は `--paint-tree-url` を使う。
- `src/migration-compare.ts` の JSON report には source `dir` と `variantFile` も残るので、後段の fix loop から元ファイルを再解決できる。
- `src/migration-compare.ts` は report から `clean / approved / remaining` を集計し、variant ごとの `Convergence` を summary に出す。現在の `tailwind-to-vanilla` report は `10/10 clean` で、approval なしで差分ゼロに到達している。
- `src/migration-fix-loop.ts` は `migration-report.json` を読み、最大 diff の viewport を 1 件選んで fix prompt を作る。baseline に同じ `selector/property` があればその値を自動適用し、なければ `ANTHROPIC_API_KEY` がある場合だけ LLM を呼ぶ。`just migration-fix-loop -- --report test-results/migration/migration-report.json --no-rerun` のように使える。
- `src/migration-fix-loop.ts` は `--selector/--property/--value/--media` で手動 fix、`--response-file` で外部 LLM 応答の取り込み、`--prompt-out` で prompt の保存にも対応する。既定では `<variant>.fixloop.html` を書き出し、同一プロセス内で `migration-compare` を rerun する。compare を走らせず適用だけ見たい場合は `--no-rerun` を使う。
- sandbox などで Playwright browser launch が拒否される場合、`migration-fix-loop` は fix file の書き出しを維持したまま rerun を warning 扱いでスキップする。
- `src/flaker-vrt-runner.ts` は `flaker` の custom runner protocol に合わせて `migration-compare` を test suite 化する。設定は [flaker-integration-design.md](/Users/mz/ghq/github.com/mizchi/vrt-harness/docs/flaker-integration-design.md) と [flaker.vrt.json](/Users/mz/ghq/github.com/mizchi/vrt-harness/examples/flaker.vrt.json)、[flaker.toml](/Users/mz/ghq/github.com/mizchi/vrt-harness/examples/flaker.toml) を参照。
- `metric-ci` 側には built-in の `vrt-migration` adapter が入り、`flaker import migration-report.json --adapter vrt-migration` と `report summarize --adapter vrt-migration` で `migration-report.json` を直接扱えるようになった。`src/flaker-vrt-report-adapter.ts` は custom adapter 経路や古い report の補完用として残してあり、`cat test-results/migration/migration-report.json | node --experimental-strip-types src/flaker-vrt-report-adapter.ts --scenario-id migration/tailwind-to-vanilla` や `just flaker-vrt-adapt -- --file test-results/migration/migration-report.json --scenario-id migration/tailwind-to-vanilla` のように使える。
- `metric-ci` 側には built-in の `vrt-bench` adapter も入り、`flaker import bench-report.json --adapter vrt-bench` と `report summarize --adapter vrt-bench` で `test-results/css-bench/<fixture>/bench-report.json` を直接扱える。1 declaration mutation を 1 test に正規化し、`backend/category/selectorType/interactive/fallbackUsed/resolvedBy` は variant に載る。
- `metric-ci` の `collect` は `[adapter]` から `artifact_name` と `command` を読む。`examples/flaker.toml` は `type = "vrt-migration"` / `artifact_name = "migration-report"` を含むので、そのまま `migration-report` artifact の収集設定としても使える。
- `.github/workflows/migration-report.yml` は `workflow_dispatch` で `tailwind-to-vanilla / reset-css / shadcn-to-luna` のいずれか 1 scenario を実行し、artifact 名 `migration-report` で `migration-report.json` を upload する。`metric-ci collect` の既定設定と合わせる場合は 1 run = 1 scenario に寄せる。
- `src/css-challenge-bench.ts` は `--fixture <name>` を繰り返し受け取れる。`--fixture all` で `admin-panel / blog-magazine / dashboard / ecommerce-catalog / form-app / landing-product / page` を順に回す。`just css-bench-all` もこの経路を使う。
- `src/css-challenge-bench.ts` は `--output-root <path>` を受け取り、fixture ごとの `bench-report.json` と approval suggestion の出力先を固定できる。CI artifact 化ではこの経路を使う。
- `src/css-challenge-bench.ts` は `--approval path/to/approval.json --strict --suggest-approval` を受け取る。`--strict` では approval を無視して全差分を報告し、`--suggest-approval` では `test-results/css-bench/<fixture>/approval-suggestions.json` を出力する。
- `.github/workflows/bench-report.yml` は `workflow_dispatch` で 1 fixture の `css-challenge-bench` を Chromium backend で実行し、artifact 名 `bench-report` で `bench-report.json` を upload する。`metric-ci collect` の `type = "vrt-bench"` と既定 artifact 名をそのまま使える。
- `src/css-challenge-bench.ts --backend prescanner` は `crater` を prescanner に使い、無信号時だけ Chromium にフォールバックする。結果レポートには `Resolved by crater` / `Chromium fallback` が出る。`just css-bench-prescanner --trials 5` でも同じ経路を実行できる。
- `src/css-challenge-bench.ts --backend crater` は `paint tree diff` に加えて、BiDi `script.evaluate` 経由の base computed style capture を試みる。現状の crater runtime は empty snapshot を返す場合があるため、その場合は harness 側で自動的に無効化する。hover emulation は引き続き chromium 側のみ。
- `src/css-challenge-bench.ts` は fixture の `var()` 参照を解析し、参照先 property を computed style 追跡対象に追加する。`:root` の custom property が `:hover` / `:focus` でしか使われていない場合も、その trial では hover snapshot を強制して検出に回す。
- Chromium 側の hover emulation は `<style>` 注入後に `reflow + 2x rAF` を待つ。さらに、削除された selector で CSS から消えた `:hover` / `:focus` も Playwright の実 hover/focus fallback で直接 capture する。
- bench を `--no-db` なしで実行すると、trial 明細は `data/detection-patterns.jsonl`、run summary は `data/bench-history.jsonl` に追記される。`just css-report` は backend 別の最新値と `prescanner vs chromium` の speedup を表示する。
- `src/css-challenge.ts` も `--fixture <name>` を受け取るので、単発の recovery challenge を新規 fixture で直接回せる。
- `just vrt-approve` は `--fixture <name>` ごとの `test-results/css-bench/<fixture>/approval-suggestions.json` を対話的に review して `approval.json` にマージする。`approval-history.jsonl` に `actor / actedAt / action / reason` を追記し、`--actor` と `--history` で上書きできる。確認だけなら `just vrt-approve --fixture dashboard --all-approve --output /tmp/approval.json` のように使える。
- 例は [examples/approval.example.json](/Users/mz/ghq/github.com/mizchi/vrt-harness/examples/approval.example.json)。

## Agent workflow

```
vrt init                    # once
loop {
  (make code changes)
  vrt capture               # snapshot
  vrt expect                # auto-generate expectations
  vrt verify                # check → PASS/FAIL
  if FAIL {
    read report → fix → repeat
  }
}
vrt approve                 # accept as new baseline
```

## Tests

```
150 tests across 45 suites:
- a11y-semantic: tree diffing, quality checks
- visual-pipeline: real PNG pixelmatch + heatmap
- cross-validation: Visual × A11y × Intent matrix
- expectation: fuzzy matching, scoring
- reasoning: expectation → change → realization chains
- harness: 10 fixture scenarios × 4 checks
- goal-runner: multi-step with retry
- roundtrip: introspect → spec → verify
- scenario: integrated 3-case scenarios
```

## License

MIT
