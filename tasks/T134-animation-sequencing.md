---
id: T134
title: 対局: 石返しアニメーションの直列化(自分の返しが終わってからCPUの着手を見せる)
status: todo # T133完了後に着手(app.tsx競合のため直列)
assignee: implementer(Sonnet)
attempts: 0
---

# T134: アニメーション直列化

## 目的(ユーザー指示 2026-07-18 午後)

「CPUと戦うとき、こちらが返した後すぐ返されてよくわからなくなる。返すアニメーションが終わった後、次のアニメーションして、というのを入れて。」— 自分の着手の石返しアニメーションが終わる前にCPUの応手が盤面に反映され、どの石がどう返ったか追えない。**アニメーションを直列化**する: 自分の返しが完全に終わる→短い間(え)→CPUの着手+返しアニメーション、の順に見せる。

## 実装方針

1. **現状調査から始める**: 盤面はCanvas 1枚描画(`app/src/components/Board.tsx`)。石返しアニメーションの現実装(有無・所要時間・完了検知の仕組み)をまず確認し、作業ログに記録する。
2. **CPUの計算は並行でよいが、見せるのは待つ**: CPU応手のエンジン計算は従来どおり即開始してよい(強CPUの終盤完全読みは数秒かかるため、ここを直列化すると体感が悪化する)。**盤面への適用(またはアニメーション開始)だけを「直前のアニメーション完了+間(200〜300ms程度、定数化)」まで遅延**させる。
3. **連続手も直列**: 自分がパスでCPUが連打する場合・CPU→自分の順でも、各アニメーションが重ならないこと。
4. **対象は対局モード(app.tsxのPlay系)**。中盤練習・詰めオセロの相手応手は本タスクのスコープ外(同一の共通機構がBoard側で自然に効くなら適用してよいが、専用対応はしない)。

## 危険箇所の警告(必読)

- **T115の前例**: CPU着手effectの二重発火と「思考中」解除のレース(定石ブック即時応手で顕在化)を`firstMoveSquareRef`で修正した経緯がある(`tasks/T115-*.md`参照)。遅延を入れる際にこのレースを再導入しないこと。既存の回帰テスト(リポジトリ初のjsdomコンポーネントテスト群)を必ず全パスさせる。
- 定石ブックon時の即時応手(初手117ms)も同じ経路を通る。ブック応手にも直列化は適用する(即時に返されるのが一番わかりにくいケース)が、ハングさせないこと。
- T132の履歴記録(`appendPlayedMove`、CPU着手effect内)・T133の変更ともapp.tsxで交差する。**最初に`git pull --rebase`で最新mainを取り込むこと。**

## やらないこと(スコープ外)

- アニメーション自体の見た目の変更(速度・演出)/中盤練習・詰めオセロ専用の対応/設定でのon/off切り替え(要望が出たら別タスク)
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] 直列化のユニット/コンポーネントテスト(fake timers等): 自分の着手→アニメ完了前はCPU手が盤面に反映されない→完了+間の後に反映される/パス絡みの連続手も重ならない/ブック即時応手でもハングしない(T115回帰テスト全パス)
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機でCPU対局(ブックon/off両方)を数手進め、自分の返し完了→間→CPU応手の順に見えること・「思考中」が正しく解除されることを確認
- [ ] 変更対象のみパス明示コミット(`app:`、`(T134)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-18 着手・現状調査

- `git pull --rebase`前に`tasks/`配下の未コミット差分(オーケストレーター作業中のもの、`bench/edax-compare/`ではなく`tasks/STATUS.md`等)があり`git stash`で退避→pull(既にup to date)→`stash pop`で復元(このタスクでは`tasks/`を触らない・コミットしない)。
- `app/src/components/Board.tsx`: 石返し/出現アニメーションは`requestAnimationFrame`で`FLIP_ANIMATION_MS`(220ms)かけて描画する既存実装(T066)。`board`/`sideToMove`/`lastMove`をpropsで受け取り、`useEffect([board, sideToMove, lastMove])`で前回描画済み盤面(`prevBoardRef`)との差分(`diffBoards`)を見て単発着手ならアニメーション、それ以外(新規対局・局面ジャンプ)は即描画。
- `app/src/app.tsx`の`PlayMode`: CPU着手用`useEffect`が`game.phase==='cpu'`になったら`requestCpuMove`(定石ブックヒットならエンジン探索せず即時、そうでなければWorker探索)を呼び、解決後`setGame(next)`で`game`を更新。`<Board board={game.board} ... />`が`game`を直接参照しているため、CPUの応手が(定石ブックなら特に)即座に確定→即座に描画され、直前の自分の返しアニメーション(220ms)完了前に次のアニメーションが重なっていた(ユーザー報告どおり)。
- T115の経緯(`tasks/T115-book-on-thinking-hang.md`)を確認: `firstMoveSquare`を`useState`にしていたことで、CPU着手effectが同一の人間の着手に対して二重発火し、互いの`cancelled`クリーンアップを踏みつけて「思考中」が解除されないハングを起こしていた。修正は`firstMoveSquareRef`(`useRef`)化+`game.phase!=='cpu'`になったら`thinking`を強制falseにする安全網effect。**この教訓から、今回の直列化実装では新たな`useEffect([game])`を追加せず、既存の`setGame`呼び出し箇所(CPU着手effectの`.then`・`handleMove`・各種新規対局開始関数)に直接、直列化キューへの`push`/`reset`呼び出しを併記する設計にした**(effectの依存配列変化による再発火・cleanup競合のリスクを構造的に回避)。

### 2026-07-18 設計・実装

- 直列化ロジックを`app/src/game/displayQueue.ts`に純粋関数として切り出し(`createDisplaySequencer<T>(onApply, delayMs, timers?)`)。キュー+クールダウンタイマー方式: `push`はキューが空でタイマーが動いていない(アイドル)なら即座に`onApply`、そうでなければキューに積むだけ。`onApply`のたびに`delayMs`のクールダウンタイマーを張り、満了時に次をpopして`onApply`(満了時にキューが空なら何もしない=アイドルへ戻る)。`reset`はキュー・タイマーを破棄して即座に`onApply`(新規対局開始用、待ち時間を引き継がない)。タイマー関数を注入可能にし、vitestのフェイクタイマーで決定的にテストできるようにした。
- `app/src/components/Board.tsx`に`DISPLAY_GAP_MS`(250ms)を`FLIP_ANIMATION_MS`と並べてexport(既存の`FLIP_ANIMATION_MS`と同じ理由: `app.tsx`のテストが`vi.mock`でまとめて0に差し替えられるようにするため)。
- `app/src/app.tsx`の`PlayMode`に、`<Board>`・手番表示・スコア等「実際に見せる」状態として`displayGame`(`useState<GameState>`)を追加し、コンポーネントのライフタイム中1つの`createDisplaySequencer`インスタンス(`displaySequencerRef`、`useRef`遅延初期化)を保持。`game`(内部の対局状態、CPU計算・履歴・評価取得等すべてこれまでどおり即時更新)とは別に、`displaySequencerRef.current.push(next)`を以下の`setGame`呼び出し箇所に併記した:
  - CPU着手effectの`.then`(CPUの応手確定時)
  - `handleMove`(人間の自分の着手時。表示側がアイドルなら即座に反映される)
  - 各種新規対局開始関数(`startNewGame`/`startVsHumanGame`/`startFromEditor`)は`push`ではなく`reset`(前対局の待ち時間を一切引き継がず即座に初期局面を表示)
- JSXの「盤面と一緒に読む」表示(`<Board>`のboard/sideToMove/lastMove、手番テキスト、passMessage、石数、「振り返る」ボタンの表示条件、終局演出のトリガー・内容)をすべて`game`から`displayGame`基準に切り替えた。理由: これらを`game`のまま残すと、CPUの応手がまだ盤面に反映されていない待ち時間中に「手番: 黒」等の文言・石数・演出だけ先に進んでしまい、盤面とテキストの間で新たな不整合(混乱の別形態)を生むため。候補手評価オーバーレイ(`MoveEvalOverlay`)の取得effectも同様の理由で`displayGame`基準にした(盤面上の各マスに重ねて描画するため、盤面がまだ追いついていない間に取得・表示すると座標がずれて見える)。
- 意図的に`game`のまま残したもの(要検討事項ではなく設計判断): CPU着手effect本体・「思考中」safety-net effect・`evaluateHumanMove`(自分の着手直後のスナップショット評価、CPUの表示タイミングと無関係)・`moveHistory`(「振り返る」棋譜の正確な記録には表示タイミングと無関係な即時性が必要)・評価値バー(`evalBarValue`、盤面上の座標対応が無い数値表示のため、遅延させる必然性がない)。スコープ外注記のとおり「CPUの計算自体は裏で先行させる」要件を満たすため。

### 2026-07-18 デバッグ: 既存回帰テスト3件の失敗と原因特定

- 実装直後、`npx vitest run`で`app.playmode.test.tsx`(T115)・`app.playmode.cpuHistory.test.tsx`(T133)・`app.playmode.review.test.tsx`(T132)の3ファイルが失敗(3件)。エラーメッセージは「ボタンが見つからない」等、一見無関係な内容で、`process.on('unhandledRejection'/'uncaughtException')`・`window.addEventListener('error', ...)`いずれにも例外が捕捉されず原因特定に時間を要した。
- `PlayMode`関数本体に一時的な`console.log`を仕込んで二分探索した結果、`displaySequencerRef`初期化行(`FLIP_ANIMATION_MS + DISPLAY_GAP_MS`)で例外が発生していることを特定。実際のエラー: `[vitest] No "DISPLAY_GAP_MS" export is defined on the "./components/Board.tsx" mock.` — この3ファイルは`vi.mock('./components/Board.tsx', () => ({ Board: ..., FLIP_ANIMATION_MS: 0 }))`という完全置き換え型のモックを持っており、`DISPLAY_GAP_MS`という新しいnamed exportを返していなかったため、vitestのモックランナーがアクセス時に明示的なエラーを投げていた(Preactの通常のレンダーエラー伝播経路には乗らず、`act()`のtry/catchにもグローバルエラーハンドラにも現れない、vitestモックランナー特有のエラー経路だったため発見が遅れた)。
- 該当3ファイルの`vi.mock('./components/Board.tsx', ...)`に`DISPLAY_GAP_MS: 0`を追記して解決(`FLIP_ANIMATION_MS: 0`と同じ意図のコメント付き)。デバッグ用に一時追加した`console.log`・`process.on`/`window.addEventListener`は全て削除済み(`git diff`で残っていないことを確認)。
- なお`app/src/analysis/AnalysisMode.initialTranscript.test.tsx`も`Board.tsx`をモックしているが、`<App/>`/`<PlayMode/>`を経由せず`<AnalysisMode/>`を直接レンダーするテストのため`app.tsx`(ひいては`DISPLAY_GAP_MS`)を読み込まず、影響なし(実際に無修正で全件パス)。

### 2026-07-18 テスト作成・検証

- `app/src/game/displayQueue.test.ts`(新規): `createDisplaySequencer`単体の純粋ロジックテスト(`vi.useFakeTimers()`)。(1)アイドル中のpushは即座反映、(2)クールダウン中のpushはdelayMs経過まで反映されない、(3)3連続pushしても重ならず順番に1つずつ処理される(パス連打相当)、(4)`reset`はキュー・タイマーを破棄し即座反映、(5)`reset`直後のpushはアイドルからの再開として即座反映。5件全パス。
- `app/src/app.playmode.animationSequencing.test.tsx`(新規): `<App/>`を通した統合シナリオ。`Board`のモックを`sideToMove`/`lastMove`をdata属性で露出するスタブに差し替え、`FLIP_ANIMATION_MS=20`/`DISPLAY_GAP_MS=30`(本番比小さいが非ゼロ)をモックし`vi.useFakeTimers()`+`advanceTimersByTimeAsync`で決定的に時間を進める。黒(人間)d3着手は即座に反映→定石ブックの白(CPU)e3応手は`game`としては即座に確定するがFLIP+GAP(50ms)経過まで盤面(`data-last-move`)に反映されない→49ms時点でも未反映→50ms時点で反映→「思考中」も正しく解除され「手番: 黒」に戻ることを検証。
- **regression-catchingであることを実証**: `<Board board={game.board} ... />`(displayGame化前の状態)に一時的に戻して本テストを実行し、「50ms未満の時点でd3のまま」のアサーションが実際に失敗する(即座にe3へ進んでしまう)ことを確認した上で、`displayGame`へ復元(`git diff`で復元漏れがないことを確認済み)。
- 全体: `npx vitest run` **87ファイル721件全件パス**(既存714件+新規7件〈displayQueue.test.ts 5件+animationSequencing.test.tsx 2件〉)。連続2回実行して安定してパスすることを確認(1回目の全件実行中、`app.playmode.review.test.tsx`が既定の5000msタイムアウトで1度だけ失敗したが、単体実行では2秒台で完走することを確認しており、`bench/edax-compare`の教師コーパス生成(8並列python、CPU重負荷)によるシステム負荷起因のフレークと判断。実際その後の2回の全体実行では発生せず)。
- `npx tsc --noEmit -p app/tsconfig.app.json`: エラーなし。

### 2026-07-18 コミット前確認

- `git status --short`: 変更・未追跡は本タスクの変更対象ファイルのみ(`app/src/app.tsx` `app/src/components/Board.tsx` `app/src/game/displayQueue.ts`〈新規〉 `app/src/game/displayQueue.test.ts`〈新規〉 `app/src/app.playmode.test.tsx` `app/src/app.playmode.cpuHistory.test.tsx` `app/src/app.playmode.review.test.tsx` `app/src/app.playmode.animationSequencing.test.tsx`〈新規〉)。`tasks/`はSTATUS.md等の並行作業分がオーケストレーター側で既にコミット済み(`d26ca39`)になっており、本タスクの作業ログ追記のみが残る想定どおり。`bench/`・`train/data/teacher/`には一切触れていない。
