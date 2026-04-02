# flaker / vrt-harness 統合設計

## 背景

`flaker` は test selection / flaky 判定 / quarantine / 履歴蓄積に強い。  
`vrt-harness` は VRT 実行、approval、migration fix loop、renderer 差分解析に強い。

この 2 つを組み合わせると、VRT を単発の比較ツールではなく、CI 上で再試行・隔離・傾向分析できる test suite として運用できる。

対象リポジトリ:

- `flaker`: [/Users/mz/ghq/github.com/mizchi/metric-ci](/Users/mz/ghq/github.com/mizchi/metric-ci)
- `vrt-harness`: [/Users/mz/ghq/github.com/mizchi/vrt-harness](/Users/mz/ghq/github.com/mizchi/vrt-harness)

## ゴール

- Migration VRT を `flaker` の custom runner 経由で実行できる
- `variant x viewport x backend` 単位で安定した test identity を持てる
- `flaker flaky --by-variant` で renderer / viewport ごとの不安定さを見られる
- `approval` と `quarantine` の責務を分離したまま併用できる

## 非ゴール

- `css-challenge-bench` の seed ベース trial をそのまま `flaker` の test として扱うこと
- `approval.json` を `flaker.quarantine.json` に統合すること
- 最初から `flaker` 本体に組み込み runner を追加すること

初期実装では `vrt-harness` 側に custom runner を置き、`flaker` から外部コマンドとして呼ぶ。

## 責務境界

### flaker が持つ責務

- test listing / sampling / execution orchestration
- 実行履歴の蓄積
- flaky 判定
- quarantine
- variant 別の傾向分析

根拠: [docs/why-flaker.ja.md](/Users/mz/ghq/github.com/mizchi/metric-ci/docs/why-flaker.ja.md), [types.ts](/Users/mz/ghq/github.com/mizchi/metric-ci/src/cli/runners/types.ts), [quarantine-manifest.ts](/Users/mz/ghq/github.com/mizchi/metric-ci/src/cli/quarantine-manifest.ts)

### vrt-harness が持つ責務

- HTML/URL のレンダリング比較
- pixel diff / paint tree diff / computed style diff
- approval による known diff フィルタ
- migration compare report と fix loop

根拠: [migration-compare.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/migration-compare.ts), [approval.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/approval.ts), [migration-fix-loop-core.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/migration-fix-loop-core.ts)

## 基本方針

`flaker` から見た VRT は「特殊な test runner」ではなく、「custom runner で実行可能な test suite」である。

そのため統合の中心は import adapter ではなく runner protocol に置く。

```text
flaker sample/run/quarantine
  -> custom runner
    -> vrt-harness migration-compare
      -> report.json + test results
        -> flaker DuckDB
```

## 統合対象の優先順

### Phase 1: Migration VRT custom runner

最優先。`migration-compare` はすでに機械可読 report を出せるため、最小コストで接続できる。

### Phase 2: Playwright VRT import

既存の `playwright test` ベースの `vrt` を `flaker import --adapter playwright` または `collect` で分析する。

### Phase 3: report import

`migration-report.json` や `bench-report.json` を直接 `flaker` に流し込む adapter を追加する。

2026-04-02 時点では `metric-ci` 側に built-in の `vrt-migration` adapter と `vrt-bench` adapter が入り、`import / collect / report summarize` で `migration-report.json` と `bench-report.json` を直接扱える。`vrt-harness` 側の `src/flaker-vrt-report-adapter.ts` は custom adapter 経路や legacy report 補完用として残す。
`vrt-harness` 側には `.github/workflows/migration-report.yml` を置き、`workflow_dispatch` で 1 scenario を実行して artifact 名 `migration-report` を出す。`metric-ci collect` の既定設定と衝突しないよう、初期運用では 1 run = 1 scenario に固定する。
同様に `.github/workflows/bench-report.yml` を置き、1 fixture の `css-challenge-bench` を Chromium backend で実行して artifact 名 `bench-report` を出す。`vrt-bench` adapter は artifact 内に単一の `bench-report.json` がある前提なので、ここも 1 run = 1 fixture に固定する。

## なぜ Migration VRT から始めるか

- `runMigrationCompare()` が export 済みで、CLI ではなく関数として呼べる
- `fixedViewports` を渡せるので、`flaker` から指定された test subset だけ実行しやすい
- `clean / approved / remaining` の収束概念がすでにある

根拠: [migration-compare.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/migration-compare.ts), [migration-fix-loop-core.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/migration-fix-loop-core.ts)

## 安定した test identity

`flaker` では test identity が安定していることが重要。`auto-discover` された viewport を毎回その場で使うと、HTML 変更で test 集合が揺れて flaky 判定が歪む。

このため、`flaker` 統合では scenario manifest に固定 viewport を持たせる。

## Scenario Manifest

ファイル名は `flaker.vrt.json` とする。

```json
{
  "scenarios": [
    {
      "id": "migration/tailwind-to-vanilla",
      "kind": "migration",
      "dir": "fixtures/migration/tailwind-to-vanilla",
      "baseline": "before.html",
      "variants": ["after.html"],
      "approval": "approval.json",
      "backend": "chromium",
      "viewports": [
        { "label": "wide", "width": 1440, "height": 900 },
        { "label": "desktop", "width": 1280, "height": 900 },
        { "label": "desktop-bp-up", "width": 1025, "height": 900 },
        { "label": "desktop-bp-down", "width": 1024, "height": 900 },
        { "label": "mobile", "width": 375, "height": 812 }
      ]
    }
  ]
}
```

### 設計上の決定

- `viewports` は必須
- `approval` は任意。未指定なら `migration-compare` の既存自動探索に従う
- `backend` は scenario の既定値。個別 test から override はしない
- `kind` は将来 `page-compare` や `component-compare` を足すために残す

## TestId への写像

`flaker` の `quarantine manifest` は `spec` が実在パスであることを期待するため、`suite` には variant HTML への相対パスを使う。

| flaker field | 値 |
| --- | --- |
| `suite` | `fixtures/migration/<scenario>/<variant>.html` |
| `testName` | `viewport:<label>` |
| `taskId` | scenario id (`migration/tailwind-to-vanilla`) |
| `variant.backend` | `chromium` / `crater` / `prescanner` |
| `variant.viewport` | `wide` / `desktop` / `mobile` など |
| `variant.width` | viewport width |
| `variant.height` | viewport height |

例:

```json
{
  "suite": "fixtures/migration/tailwind-to-vanilla/after.html",
  "testName": "viewport:desktop",
  "taskId": "migration/tailwind-to-vanilla",
  "variant": {
    "backend": "chromium",
    "viewport": "desktop",
    "width": "1280",
    "height": "900"
  }
}
```

この形なら `flaker quarantine` が file path を指せるし、`flaker flaky --by-variant` で viewport / backend ごとの傾向も見える。

## Runner プロトコル

`flaker` 側は既存の custom runner をそのまま使う。

根拠: [runner-adapters.md](/Users/mz/ghq/github.com/mizchi/metric-ci/docs/runner-adapters.md), [custom-runner.ts](/Users/mz/ghq/github.com/mizchi/metric-ci/src/cli/runners/custom-runner.ts)

### list

`flaker-vrt-runner.ts list` は `flaker.vrt.json` を読み、`scenario x variant x viewport` を列挙して `TestId[]` を返す。

### execute

`flaker-vrt-runner.ts execute` は指定された `TestId[]` を scenario ごとに束ね、各 scenario について 1 回だけ `runMigrationCompare()` を呼ぶ。

呼び出し時のルール:

- `variants` は要求された `suite` から逆算
- `fixedViewports` は要求された `testName` / `variant.viewport` から復元
- `autoDiscover` は `false`
- `outputDir` は `test-results/flaker-vrt/<timestamp-or-runid>/...`

## Result Status の写像

`migration-compare` の result を `flaker` の `TestCaseResult.status` へ落とす。

| migration result | flaker status | 理由 |
| --- | --- | --- |
| `diffPixels === 0` | `passed` | 完全一致 |
| `approved === true` | `passed` | known diff は VRT 上は許容済み |
| `partiallyApproved === true` かつ残差分あり | `failed` | approval しても差分が残っている |
| `remaining` | `failed` | 未解決差分 |
| browser launch / crater 接続失敗 / timeout | `flaky` | 一時的な infra failure とみなす |
| manifest により skip | `skipped` | quarantine runtime が上書き |

### 重要な決定

`clean` と `approved` はどちらも `passed` として扱う。

`approved` を別 status にしない理由:

- `flaker` の現在の status モデルは `passed/failed/skipped/flaky`
- `approved` は identity ではなく run metadata
- `approved` を identity に入れると履歴が分断される

`approved` の詳細は `vrt-harness` 側の report artifact に残す。

## Approval と Quarantine の分離

### approval

`approval.json` は「視覚差分としてはあるが、プロダクト上は許容する既知差分」。

例:

- renderer gap
- reset CSS 差分
- tiny spacing drift

根拠: [approval.ts](/Users/mz/ghq/github.com/mizchi/vrt-harness/src/approval.ts)

### quarantine

`flaker.quarantine.json` は「CI 運用上、いまは block しない test」。

例:

- crater server がたまに落ちる
- mobile viewport だけ非決定的
- 特定の backend だけ timeout が出る

根拠: [quarantine-manifest.ts](/Users/mz/ghq/github.com/mizchi/metric-ci/src/cli/quarantine-manifest.ts), [quarantine-runtime.ts](/Users/mz/ghq/github.com/mizchi/metric-ci/src/cli/runners/quarantine-runtime.ts)

### 運用ルール

- 既知の正当差分は `approval`
- 非決定的な落ち方は `quarantine`
- `approval` を増やして flaky を隠さない
- `quarantine` を増やして known diff を隠さない

## 出力 artifacts

custom runner は `stdout` に summary を返すだけでなく、元の report を保存する。

想定パス:

```text
test-results/flaker-vrt/
  2026-04-02T18-00-00/
    migration-tailwind-to-vanilla-report.json
    migration-reset-css-report.json
```

`stdout` には report path を出しておく。深掘りは `vrt-harness` の artifact を見る。

## flaker.toml 例

```toml
[repo]
owner = "mizchi"
name = "vrt-harness"

[storage]
path = ".flaker/data.duckdb"

[adapter]
type = "vrt-migration"
artifact_name = "migration-report"

[runner]
type = "custom"
list = "node --experimental-strip-types ./src/flaker-vrt-runner.ts list"
execute = "node --experimental-strip-types ./src/flaker-vrt-runner.ts execute"

[affected]
resolver = "simple"
config = ""

[quarantine]
auto = true
flaky_rate_threshold = 30.0
min_runs = 5
```

`vrt-harness` 単体リポジトリで運用するなら runner はこの repo に置き、artifact 収集は `metric-ci` built-in の `vrt-migration` adapter を使う。

## 実装フェーズ

### Phase 1: 最小接続

- `src/flaker-vrt-config.ts`
  - `flaker.vrt.json` の型定義とパーサー
- `src/flaker-vrt-runner.ts`
  - `list`
  - `execute`
  - `migration-compare` 専用
- `fixtures/migration/*` を scenario manifest に登録

完了条件:

- `flaker run --runner custom` で migration VRT が動く
- `flaker flaky --by-variant` に `viewport` と `backend` が出る

### Phase 2: 運用導線

- `examples/flaker.toml`
- `examples/flaker.vrt.json`
- `just flaker-vrt-list`
- `just flaker-vrt-run`

完了条件:

- 新規 repo で copy して最短導入できる

### Phase 3: 追加統合

- `migration-report.json` import adapter
- Playwright VRT import の README 導線
- `css-bench` summary import

2026-04-02 時点では上記 3 件とも完了している。残りは built-in runner 化ではなく、artifact 運用の実例を積むフェーズ。

## Open Questions

### 1. runner の配置場所

初期実装は `vrt-harness` 側でよい。理由:

- `runMigrationCompare()` などの内部 API に直接触れる
- `metric-ci` 側は現在 rename/開発中で dirty worktree がある
- built-in runner 化は protocol が固まった後でよい

### 2. crater backend の扱い

`backend = crater` / `prescanner` は Phase 1 の対象に含めるが、`flaky` 判定との相性を考えてまず `chromium` を既定値にする。

### 3. dynamic viewport discovery

`flaker` 用 test identity では使わない。authoring 支援としてだけ残す。

## 受け入れ条件

この設計が実装された状態とは、次を満たすこと:

1. `flaker-vrt-runner.ts list` が安定した `TestId[]` を返す
2. `flaker-vrt-runner.ts execute` が `migration-compare` を subset 実行できる
3. `approved` は `passed` に写像される
4. `crater` / browser の一時 failure は `flaky` に写像される
5. `flaker quarantine` と `approval.json` を同時に使っても責務が衝突しない
