# セレクタブロック削除モードの分析

## 調査結果

`diffComputedStyles` を直接呼ぶと 54 diffs が出るが、bench ランナー経由だと 0。
原因は `captureComputedStyleSnapshotInDom` (bench 用のリファクタ版) と
直接の `page.evaluate` でスナップショット形式が異なる可能性がある。

**次のアクション**: `captureComputedStyleSnapshotInDom` のスナップショットが baseline/broken で
同一キーを返しているか、フォーマット変換のロスがないかを確認する。

## 現状 (page fixture, 15 trial)

| 信号 | property モード | selector モード | 備考 |
|------|----------------|----------------|------|
| Visual diff (pixel) | 76.7% | 93.3% | セレクタ全体削除は pixel 変化が大きい |
| Computed style diff | 73.3% | 0% | **バグ: tracked targets のフィルタが不完全** |
| Hover diff | 6.7% | 0% | 同上 |
| A11y diff | 16.7% | 46.7% | セレクタ全体削除で要素の表示が変わる |
| Any signal | 93.3% | 93.3% | pixel diff だけで拾えている |

## 検出精度を上げる方向性

### 1. Computed style diff を selector モードで正しく動かす

現在のバグ: selector モードで `removed` が block の最初の宣言 1 つだけなので、
`findExpectedComputedStyleTargets` が 1 プロパティ分しか追跡しない。
→ ブロック内の全宣言を渡すよう修正済みだが、フィルタロジック (`filterComputedStyleDiffsByTargets`) が
セレクタ名のマッチで取りこぼしている可能性がある。

**修正案**: selector モードでは tracked targets フィルタをバイパスし、全 computed style diff を検出として扱う。

### 2. 削除前後の computed style snapshot をブロック単位で比較

現在: 全要素の computed style を取得 → 全体で diff
改善: 削除されたセレクタに該当する要素だけの computed style を重点的に比較

```typescript
// セレクタ ".header" のブロックを削除した場合:
// 1. document.querySelectorAll(".header") で対象要素を取得
// 2. baseline と broken の computed style を比較
// 3. 差分があれば検出
```

### 3. CSS セレクタ → 影響要素のマッピング

CSS セレクタからどの DOM 要素に影響するかを Playwright の `page.locator()` で特定し、
その要素だけの computed style/bounding box を比較する。

```typescript
const elements = await page.locator(removedBlock.selector).all();
for (const el of elements) {
  const before = await el.evaluate(getComputedStyle);
  // ... CSS 削除後 ...
  const after = await el.evaluate(getComputedStyle);
  // diff
}
```

### 4. DOM bounding box diff

computed style ではなく、要素の bounding box (`getBoundingClientRect`) を比較する。
CSS セレクタを消せばレイアウトが変わるので、bounding box の変化で検出できる。

pixel diff より高速で、computed style より簡潔。

### 5. Crater paint tree diff の活用

selector モードでは crater の paint tree diff が最も効果的:
- paint tree には CSS プロパティの計算結果が含まれる
- セレクタを消せば paint tree の bg, color, fs, bounds が全て変わる
- pixel diff よりもプロパティレベルで「何が変わったか」がわかる

### 6. 復旧精度の向上 (LLM ベース)

検出だけでなく復旧の精度を上げるには:

1. **diff レポートの情報量を増やす**
   - 「この要素の padding が 12px 24px → 0 に変わった」(computed style diff)
   - 「この要素が flex → block に変わった」(paint tree diff)
   - 「この要素の高さが 64px → 48px に変わった」(bounding box diff)

2. **残存 CSS からの推論**
   - 削除されたセレクタと同名の `:hover` ルールが残っているなら、元のセレクタがあったはず
   - 同じ要素に適用される他のルールとの一貫性チェック

3. **HTML 構造からの推論**
   - `.header` クラスを持つ要素の HTML 構造を見れば、必要なスタイルを推測できる
   - 周囲の要素との一貫性 (同じ親の他の子のスタイルを参考に)

## 優先度

| アプローチ | 効果 | コスト | 優先度 |
|-----------|------|--------|--------|
| Computed style diff のバグ修正 | 高 (0% → 70%+) | 低 | **即対応** |
| Crater paint tree diff | 高 | 低 (既存) | **高** |
| CSS セレクタ → 影響要素マッピング | 中 | 中 | 中 |
| DOM bounding box diff | 中 | 低 | 中 |
| LLM 復旧精度 | 高 | 高 | 後回し |
