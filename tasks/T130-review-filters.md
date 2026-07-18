---
id: T130
title: 詰めオセロ/中盤練習: ステージグリッドの復習フィルタ(未クリア・失敗ありで絞る)
status: todo # T129完了後に着手(PracticeMode.tsxが競合するため直列)
assignee: implementer(Sonnet)
attempts: 0
---

# T130: 復習フィルタ

## 目的

ステージ記録(クリア日時・失敗回数、T117/T119で導入)は「復習モードに備える」意図で保存してきたが、現状グリッドは色分け表示のみで**絞り込み導線がない**(調査確定)。「失敗した問題・まだ解けていない問題だけをやり直す」を1タップにする。

## 要件

1. 詰めオセロ(182問グリッド、`app/src/tsume/PlayMode.tsx:608-648`付近)と中盤練習(111ステージ、`app/src/midgame/PracticeMode.tsx`のグリッド)に共通のフィルタチップを追加: **すべて / 未挑戦 / 失敗あり / 未クリア / クリア済み**。
2. 記録源は既存stageProgress(`othello-trainer:tsume-stage-progress` / `othello-trainer:midgame-stage-progress`)。中盤練習は**現在選択中の判定モードの記録**で判定する(T119の2階層構造)。
3. フィルタ選択は保存する(localStorage、次回起動時も維持)。該当0件時の空表示メッセージ。
4. グリッドの既存の色分け・★表示・クリック挙動は変えない。レスポンシブ維持。

## やらないこと(スコープ外)

- パターン別出題・SRS化・出題順の変更 / stageProgressスキーマ変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] フィルタ each(5種)×両モードの表示件数が記録どおりになるjsdomテスト、選択の永続化テスト、中盤練習の判定モード切替でフィルタ結果が追従するテスト
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機で両モードのフィルタ動作確認(375px込み)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T130)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

- 2026-07-18 実装開始。`git pull --rebase`でT129完了報告の追記(オーケストレーターが先にコミット済みだったため実質差分なし)を取り込み、着手。
- 調査: `app/src/tsume/stageProgress.ts`(1階層、`Puzzle.id`キー)・`app/src/midgame/stageProgress.ts`(T119、`stageKey`→`JudgeMode`→`Entry`の2階層)・`PlayMode.tsx`/`PracticeMode.tsx`のステージ一覧グリッド(`.tsume-stage-grid`/`.midgame-stage-grid`)・`app/src/settings/judgeModeStorage.ts`等の永続化パターンを確認。CSSは`app/src/midgame/PracticeMode.css`のコメントに「モジュール間のCSS読み込み順に依存しないよう複製する」既存方針があったため、JSロジックのみ`app/src/settings/reviewFilter.ts`に共通化し、CSSは両モードのCSSファイルに複製。
- 実装: `app/src/settings/reviewFilter.ts`(新規、`ReviewFilter`型5種・`loadReviewFilter`/`saveReviewFilter`(`StorageLike`+キー引数)・`matchesReviewFilter`純粋関数)。`PlayMode.tsx`/`PracticeMode.tsx`にフィルタ状態・ハンドラ・絞り込み済みリスト(`filteredStageEntries`/`filteredStagePool`)を追加し、既存のグリッド描画をラップ(元の`index`・色分け・★表示・クリック挙動は変更なし)。中盤練習は要件2どおり`stageStatusForMode`+`stageProgress[stage.key]?.[judgeMode]?.failCount`で現在の判定モードの記録のみを見る。CSSは`.tsume-stage-select__filters`系/`.midgame-stage-select__filters`系を追加(`--color-accent-bg`+`--color-accent-dark`、`analysis/AnalysisMode.css`の`.analysis-input__tab--active`と同じ配色方針)。
- テスト: `app/src/settings/reviewFilter.test.ts`(永続化往復・不正値フォールバック・`matchesReviewFilter`全15組み合わせ)。`app/src/tsume/PlayMode.reviewFilter.test.tsx`(フィルタ5種の表示件数、空表示、永続化+再マウント保持)。`app/src/midgame/PracticeMode.reviewFilter.test.tsx`(同左+要件2の判定モード切替追従)。
  - 中盤練習テストで詰まった点: 合成定石ラインの初手をp1=c4/p2=d3/p3=e6/p4=f5のように分けて4ステージ作るつもりが、`joseki/normalize.ts`の`opForFirstMove`が初手のマス自体を基準に全着手を正規化するため、深さ1のラインは初手が何であれ同一局面に収束し1ステージにしか分離できなかった(黒の初手4種は盤面対称変換で相互に移りあうため)。全ラインで初手をf5に統一し、2手目以降(f5合法応手f4/d6/f6、および3手目まで進めたf5→f4→c3)で分岐させることで4ステージに分離(scratchpadではなくリポジトリ内に一時デバッグテスト`_debugStage.test.ts`を作って`game/othello.ts`の合法手を確認した後、削除済み。`git status`に残っていないことを確認済み)。
- 検証: `npx tsc --noEmit -p app/tsconfig.app.json` エラーなし(着手時点でapp.tsx側に他タスク(T132)由来の未使用変数エラーが一時的に見えたが、自分のファイル群には影響なくその後解消を確認)。`npx vitest run`(app配下)711件全パス(新規テスト含む)。
- コミット `f167a26`(`app:` プレフィックス、T130対象ファイルのみをパス明示でadd)。push後、GitHub Actions「Deploy to GitHub Pages」(run 29628992042)が成功したことを確認(`gh run watch`)。
- Pages実機確認(`https://giwarb.github.io/othello-trainer/`、Claude Browser MCP):
  - 詰めオセロ: 設定画面→ステージ一覧で「復習フィルタ」チップ(すべて/未挑戦/失敗あり/未クリア/クリア済み)が表示され、「クリア済み」クリックで該当0件→「条件に一致する問題がありません。」の空表示、「未挑戦」クリックで182問中182問(active状態のCSSクラスも正しく切替)表示を確認。`localStorage['othello-trainer:tsume-review-filter']`が`"unattempted"`で永続化されていることを確認。375x812でも`document.documentElement.scrollWidth === clientWidth`(横スクロールなし)を確認。
  - 中盤練習: 同様に設定画面→ステージ一覧でフィルタチップ表示、「未挑戦」クリックで111問中110問表示(実機の既存進捗1件を反映した妥当な結果)、`localStorage['othello-trainer:midgame-review-filter']`が`"unattempted"`で永続化されることを確認。375x812でも横スクロールなしを確認。
  - (注記: `computer`スクリーンショットツールがこのセッションでは繰り返しタイムアウトしたため、視覚確認は`read_page`のアクセシビリティツリーと`javascript_tool`によるDOM/localStorage直接確認で代替した。)
- 以上ですべての受け入れ基準を満たした。`git status --short`もクリーン(タスクファイル自体の差分を除く)。
