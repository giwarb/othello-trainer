# T128 最終レビュー(Claude 代替レビュー)

- 対象: コミット `23253db`(app: 中盤練習の悪手判定を1手先対比の明確悪化パターンに刷新(T128))
- 仕様: `tasks/T128-midgame-clear-blunder-compare.md`
- レビュー方法: `git show`による差分・周辺コード読解(clearBlunder.ts / ClearBlunderCompare.tsx / PracticeMode.tsx / PracticeMode.css / テスト3本、依存先の motifs.ts / whyBad.ts / explain.rs / stageProgress 経路)+ `npx vitest run`(73ファイル/613件 全パス)+ `npx tsc --noEmit -p tsconfig.app.json`(直接呼び出し、pretypecheckフック不経由。エラーなし)。Rust/wasmビルド・`npm run typecheck`・bench/train配下には触れていない。

## 総合判定: 合格(重大指摘なし。中1件・軽微5件)

---

## 観点1: ゲートの正しさ — おおむね良好、フォールバック経路に中1件

**正常経路は正しい。** `handlePlayerMove`で評価値不合格→`Promise.all`で両手の`requestFeatureSet`→**await直後に`sessionGenerationRef`世代チェック**→`detectClearBlunderPatterns`が`null`なら`applyMoveAndContinue`(正解経路と同一の共通ヘルパー)へ。合格扱い経路のステージ記録は従来の合格経路と完全に同じ(`checkEnd`→`recordStageAttemptNow('clear'|'fail')`、内部で世代チェック済み)なので、「合格として書かれる」は構造的に保証されている。失敗確定時の`recordStageAttemptNow(stageKey,'fail')`は`handleModeFailure`先頭の同期タイミング(直前に世代検証済み)で行われ、T117(localStorage同期書き込み)/T119(世代ガード)の教訓を正しく踏襲している。

**【中1】フォールバック経路(特徴量取得失敗)で世代ガードが欠落。** `handlePlayerMove`のゲートの`catch`節:

```ts
} catch (error) {
  console.error('明確な悪化パターン判定用の特徴量取得に失敗しました', error)
  await handleModeFailure(s, square, playedNotation, judgement, generation, null)
```

`Promise.all`のawaitがrejectで戻った後、**`sessionGenerationRef.current !== generation`の再チェックなしに**`handleModeFailure`を呼んでおり、その先頭で`recordStageAttemptNow(s.stageKey, 'fail')`が無条件に走る。`requestFeatureSet`待ちの間にユーザーが離脱(`backToSettings`/新セッション開始)していた場合、離脱済みセッションのfail記録がlocalStorageに書かれる——T119で潰したのと同型のstale書き込み。UI側(`setPhase('result')`等)は`handleModeFailure`内の世代チェックで守られるが、永続記録は守られない。発生条件はエンジンエラー+同時離脱の複合で稀だが、レビュー観点1で明示されたクラスの欠陥。**修正はcatch節冒頭に`if (sessionGenerationRef.current !== generation) return`を1行足すだけ**であり、次の小修正タスクでの対応を推奨(単独redoにするほどではない)。

- `judgement.bestMove`が無い経路(直後の`handleModeFailure(..., null)`)はawaitを挟まず世代有効のまま呼ばれるため問題なし。
- フォールバックで「従来どおり評価値のみで不合格」とする設計自体は妥当(ゲートを適用できない以上、緩める方向に倒さないのは安全側)。

## 観点2: 検出器の正しさ — 仕様どおり、座標系の取り違えなし

- 5検出器とも仕様表の判定条件・閾値(3/—/—/4/2)どおりで、閾値は名前付き定数+根拠コメントあり(要件充足)。
- 座標系: `CORNER_SQUARES=[0,7,56,63]`はa1/h1/a8/h8で`squareToNotation`(file=sq%8, rank=sq/8)と整合。whyBad.tsの`X_SQUARE_TO_CORNER`(b2→a1等)も同一系。取り違えなし。
- **corner-gift**: `legalMoves`は空きマスにしか手を返さないため「すでに隅が埋まっている」ケースは自然に除外される。着手後に相手がパス(合法手0)の場合も空配列→検出なしで安全。
- **x-c-danger**: `detectXUchi`/`detectCUchi`(→whyBad.tsの`detectCornerRisk`)は**対応する隅が空であることを条件に含む**ため、仕様の「空き隅に隣接」を正しく満たす。最善手側がX/C打ちのときの除外も実装済み。
- **stable-loss**: `FeatureSet.stableDiff`はengine側(`explain.rs`)で「着手後局面のstable(side)−stable(opp)」と確認。両特徴量が同一`preMoveSide`・同一着手前局面由来なのでbest−playedの差分比較は厳密に成立。コメントの説明も実装と一致。
- ゲート判定への深読み混入なし(`legalMoves`/`applyMove`/既存特徴量・モチーフのみ、エンジン追加呼び出しなし)。

軽微な指摘:
- **【軽微1】stable-lossのメッセージが不正確になりうる**: diffは(自分−相手)の確定石**差分**の差なので、played側で相手の確定石が増えたことが原因の場合でも「最善手なら確定石が{k}個増えていました」と表示される(自分の確定石は増えない)。またハイライトは`computeStableSquares(自分側)`のみで、このケースでは2枚の盤面のハイライトが同一になり文と絵が噛み合わない。実害は小さいが文言の再考余地あり。
- **【軽微2】corner-giftは複数の隅を同時に献上する場合、最初の1隅しか報告しない**(`CORNER_SQUARES.find`)。表示上の網羅性の問題のみ。
- **【軽微3】noReversalモードでplayed==bestMoveのままreversedになった場合**、2局面が同一→全検出器null→合格扱いになる。「最善を打っても逆転する局面」を救済する方向でユーザー裁定と整合するため妥当と判断するが、noReversalモードの意味が実質変わる点は申し送りとして記録しておくべき。
- **【軽微4】opponent-mobilityのハイライトが相手の全合法手(最大10数マス)を両盤面に塗る**ため視覚ノイズが大きめ。UX上の好みの範囲。

## 観点3: 撤去の完全性と影響 — 完全

- `loadFailExplanation`/`failRequestIdRef`/`resetFailExplanation`/モチーフタグUI/waterfall/回収点の参照はコメント内の言及1箇所を除きゼロ(grepで確認)。未使用importなし(`tsconfig.app.json`は`noUnusedLocals/noUnusedParameters: true`でtscクリーン)。
- 撤去に対応するCSS(`.midgame-result__board`/`.midgame-highlight-overlay`/`.motif-badge--active`/`.midgame-result__explanation`)も削除済みで、到達不能CSSの残りなし。`BlunderPanel.css`のimportもPracticeMode.tsxから除去され、`BlunderPanel.tsx`側は自前でimportしているため影響なし。
- コミットは`app/src/midgame/`配下7ファイルのみ。`attribution.ts`/`refutation.ts`/`motifs.ts`等の共有モジュールは無変更で、棋譜解析(BlunderPanel)側への影響は構造的にない。

## 観点4: テストの実質 — 自己参照になっていない

- `clearBlunder.test.ts`(14件): 検出器の陽性・陰性とも**実盤面を`createBoard`/`initialBoard`+実`applyMove`で構築し、実際の`legalMoves`/`frontierSquares`/`computeStableSquares`計算を通す**。モックで検出条件を注入して恒真化する構造ではない。stable-lossのみ`stableDiff`をFeatureSetに手書き注入するが、これは本番でもエンジン供給値である(注入値が実盤面と整合することはハイライト4マスのアサートで裏取りされている)ため妥当。
- ゲート統合テスト: engineスタブは`requestAnalyzeAll`のdiscDiffで「c1=劣着」を作るだけで、**ゲート判定そのもの(検出器)は実盤面計算**。`requestFeatureSet`が両手で呼ばれたことのスパイ確認・`.midgame-result--fail`非遷移・localStorageの`failCount`不書き込みまで確認しており、実質のある回帰テスト。`requestAnalyze`を意図的にrejectさせて`handleModeFailure`非到達を担保する作りも良い。
- **【軽微5】ゲートの「不合格方向」(明確パターン検出→失敗画面+fail記録)の統合テストが無い**。`ClearBlunderCompare.test.tsx`が表示側を、`clearBlunder.test.ts`が検出側をそれぞれ単体で押さえているため実害は小さいが、`handlePlayerMove`→`handleModeFailure(patterns)`→fail記録の一気通貫は未固定。

## 検証実行結果

- `npx vitest run`(app): Test Files 73 passed / Tests 613 passed
- `npx tsc --noEmit -p tsconfig.app.json`: エラーなし
- `git status --short -- app/src/midgame`: 差分・未追跡なし(レビュー時点)

## 指摘まとめ

| # | 区分 | 内容 | 対応推奨 |
|---|---|---|---|
| 中1 | 中 | ゲートのフォールバックcatch節に世代ガード欠落(stale fail記録の可能性) | catch冒頭に世代チェック1行を追加(次の小修正で可) |
| 軽微1 | 軽微 | stable-lossの文言が「相手の確定石増」由来のとき不正確 | 文言・ハイライトの再考(任意) |
| 軽微2 | 軽微 | corner-giftは複数隅献上時に1隅のみ報告 | 任意 |
| 軽微3 | 軽微 | played==bestのreversed失敗が常に合格扱いになる(仕様整合だが意味変化) | STATUS.mdに申し送り |
| 軽微4 | 軽微 | opponent-mobilityのハイライトが多すぎる | 任意 |
| 軽微5 | 軽微 | ゲート不合格方向の一気通貫テストなし | 任意 |

**結論: 合格。** 重大(ブロッカー)指摘なし。中1件は発生条件が稀(エンジンエラー+同時離脱)かつ1行修正で解消できるため、done判定を妨げないが、T119教訓の対象クラスなので早期の追修正を推奨する。
