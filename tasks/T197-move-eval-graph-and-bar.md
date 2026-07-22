---
id: T197
title: 対局・中盤練習: 「打った手の評価値」折れ線グラフ+有利不利表示の変更
status: todo
assignee: implementer
attempts: 0
---

# T197: 対局・中盤練習: 「打った手の評価値」折れ線グラフ+有利不利表示の変更

## 目的(ユーザー依頼 2026-07-23)

1. 対局モード・中盤練習モードで、手を打つたびに**その打った手の評価値**(=着手前局面の探索でその手に付いた評価値。**打った後の盤面を改めて評価した値ではない**)を記録し、折れ線グラフに表示する。
2. 画面上の有利不利表示(評価バー)を、「現在の盤面評価」から「**前回の相手の手の評価値**」に変更する。

## 背景・コンテキスト(explorer調査済み 2026-07-23。着手時に現物と突き合わせること)

- **「打った手の評価値」は既に計算済みで捨てているだけ**。新規エンジン呼び出しを追加しないこと(コスト・TTクリア構造を変えない):
  - 対局・人間の手: `evaluateHumanMove`(`app/src/app.tsx:700-729`)の `playedEval.discDiff`。
  - 対局・CPUの手: `requestCpuMove`(`app/src/game/gameLoop.ts:248-267`)が受け取る `response.score` を**現状捨てている** → 戻り値に含めて上位(`app.tsx:539-553`)へ返す配線を追加。CPUの定石ブック手(`bookMove`経路)は探索しないため評価値なし(null)。
  - 中盤練習・人間の手: `handlePlayerMove`(`PracticeMode.tsx:474-541`)の `playedDiscDiff`(現状`MoveOutcome`に未保存→フィールド追加)。
  - 中盤練習・相手の手: 相手応手effect(`PracticeMode.tsx:398-435`)の `allMoves` から選んだ手のdiscDiffを引く(追加コストゼロ)。
- **符号規約**: `discDiff`は手番視点。グラフ・バー表示時は視点変換が必要(`mover === perspective ? v : -v` パターン多数、例 `app.tsx:636`)。
- **グラフ部品**: `app/src/analysis/EvalGraph.tsx`(SVG折れ線、`points: {ply, value(黒視点), isExact, evalSource, move?}[]`、定石区間は値0固定+帯色分けというT046規約、悪手マーカー・ホバー付き)。`analyzeGame`非依存でpropsだけで再利用可能。
- **現行の評価バー**: 対局=`app.tsx:603-647`(`requestAnalyzeAll`→`computeBoardEvalScore`)、中盤練習=`updateEvalBarFromMoves`(`PracticeMode.tsx:244-248`、呼び出し3箇所)。キャプションは「現在の評価値」。
- 履歴: 対局は`moveHistory: string[]`(`app.tsx:433`、appendPlayedMove経由で人間/CPUの2箇所から追記。パスは記録しない)。評価値は並行配列を新設するのが自然。
- 既存テスト: `app.playmode.evalDisplay.test.tsx` 等が「評価バー=現在の盤面評価」を前提にしている → 期待値の更新が必要。

## 設計方針(オーケストレーター指定)

1. **記録**: 対局モードに `moveEvalHistory: {ply, notation, side, discDiff: number|null, source: EvalSource, isExact: boolean}[]` を新設し、人間着手時(`handleMove`)・CPU着手時の2箇所で `moveHistory` と同期して追記する。中盤練習は `SessionState` に同型の時系列配列(人間+相手の全手)を追加。パスは記録しない(既存規約どおり)。リセット/新規対局/ステージ開始で初期化。
2. **グラフ**: `EvalGraph` を再利用。`value` は**黒視点**に変換(黒の手はそのまま、白の手は符号反転)し、キャプションで「+は黒有利/各点はその手を打った時点の手の評価」と明示。CPU定石ブック手(discDiff=null)と人間の定石内の手(`source==='joseki'`)はT046規約に合わせ **値0固定+evalSource 'joseki'**(帯で定石と分かる)。対局画面では盤面の下(または横パネル)に配置し、狭幅ではみ出さないこと。中盤練習はプレイ画面と結果画面の両方に表示(最大6点程度の短い折れ線でよい)。
3. **有利不利表示の変更**: 評価バーの値を「前回の相手の手の評価値」に変更する。
   - 対人CPU対局: 相手=CPU。CPUの直前の手の`discDiff`(CPU視点)を**人間視点に符号反転**して表示。キャプションを「相手の直前の手の評価(あなた視点、+ならあなた有利)」に変更。
   - まだ相手が打っていない(初手前など)→ バーは中立(0)+「まだ相手の手がありません」的な控えめ表示。
   - CPUが定石ブック手(評価値なし)→ 数値を出さず「定石」表示(既存EvalBadgeの`joseki`扱いに準拠)。
   - 2人対戦(vsHuman)モードがある場合: 「直前に打たれた手の評価値(打った側視点)」を手番色ラベル付きで表示する(単一の"自分"が存在しないため)。
   - 中盤練習: 相手応手のdiscDiff(相手視点)を人間視点に反転してバー表示(同キャプション)。
   - 現行の「盤面評価用requestAnalyzeAll」はオーバーレイ表示用に引き続き必要だが、バー値算出(`computeBoardEvalScore`)への依存は撤去してよい。
4. **エンジン呼び出しを増やさない**(重要): 本タスクは既存レスポンスの転用のみ。`requestAnalyzeAll`/`requestAnalyze`の呼び出し回数・順序・limitを変えない。

## やらないこと(スコープ外)

- 悪手比較UI(T195/T196)
- 既知の重複呼び出し(`app.tsx:588-590`コメントのオーバーレイ用+evaluateHumanMoveの二重requestAnalyzeAll)の統合(既存どおり残す)
- エンジン側(Rust)の変更、解析キャッシュ(ANALYSIS_ENGINE_VERSION)の変更(表示のみの変更のため不要)
- 棋譜解析モードのグラフ(既存のまま)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cd app && npm test` 全件パス。新規テスト: (a) moveEvalHistoryへの記録(人間手・CPU手・ブック手null・パス非記録・視点変換) (b) バー値=相手の直前の手の評価値(符号・初手前・ブック手のケース)。既存の評価バー系テストは新仕様に合わせて期待値更新(単なる削除で逃げない)。
- [ ] `npm run build` 成功。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLで実機確認: 対局モードで数手進めてグラフに点が増えること、定石区間が帯表示になること、評価バーが相手の直前の手の評価を表示すること(キャプション込み)。中盤練習でも同様。確認記録を作業ログへ。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
