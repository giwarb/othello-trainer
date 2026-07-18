---
id: T141
title: 中盤練習: ステージクリア型への全面改訂(3往復・評価値常時表示・★1〜3判定)
status: in_progress
assignee: implementer(Sonnet)
attempts: 0
---

# T141: 中盤練習のステージクリア型改訂

## 目的(ユーザー指示 2026-07-19 朝、原文)

「中盤練習はモードや相手の強さを選ぶのはやめます。初期画面は、ステージから選ぶだけにする。評価値が常に出ているようにして、3回応手しあう。評価値が5以上減らなければ★、評価値が1以上減らなければ★★、すべて最善手を打ち返し続けられたら★★★という感じのステージクリア型にしたい。」

## 仕様(オーケストレーター裁定込み。裁定は変更可能な旨ユーザーに通知済み)

1. **初期画面=ステージ一覧のみ**: 判定モードチップ・相手の強さ・開始局面ソース・「開始」(ランダム出題)を廃止し、中盤練習に入ると直接111ステージのグリッドを表示。苦手パターン統計(T129)と復習フィルタ(T130)はグリッド画面上部に残す(フィルタの状態語彙は5に合わせ変更)。
2. **プレイの流れ**: ステージ選択→その局面から**プレイヤーが3手打つ**。各手に**相手は最善応手**(エンジンbestMove)を返す。3往復(自分3手+相手3応手)終了→結果画面。途中で終局・打てる手なし等の場合はその時点で終了し、打てた手ぶんで判定。
3. **評価値の常時表示**: 対局モード(T138)と同じ候補手評価オーバーレイ+評価バーを、中盤練習のプレイ中に常時表示(ON/OFFチェック廃止)。中盤開始局面は定石外なのでブックcapなしの生値でよい(T138の部品を再利用、bookSquares空)。視点はプレイヤー視点。
4. **★判定**(裁定: 損失は「開始時評価値 − 終了時評価値」(プレイヤー視点、同一エンジン設定で計測)で測る):
   - 損失 < 5石 → ★
   - 損失 < 1石 → ★★
   - 3手すべてが最善手(各時点の候補手評価の最大値と同値の手)→ ★★★
   - 損失 ≥ 5石 → クリア失敗(★0)
   - 判定に使う評価は表示と同じanalyzeAll結果を使い、二重計算しない。
5. **記録**: 新localStorageキー `othello-trainer:midgame-stage-stars`: `{ [stageKey]: { bestStars: 0-3, attempts, lastResultStars, lastAttemptAt, firstClearedAt } }`(StorageLike様式、同期書き込み・世代ガードはT117/T119教訓)。**旧記録(判定モード別)からの移行**: 読み込み時に旧記録でいずれかのモードのクリアがあるステージは`bestStars>=1`として一度だけシード(旧データは消さない)。グリッドセルは★0〜3を表示(旧「★=モード数」表示を置換)。進捗バー・ホーム実績行(T137)の「クリア」定義は`bestStars>=1`に更新。
6. **復習フィルタ(T130)の語彙更新**: すべて/未挑戦/失敗あり/未クリア(★0)/クリア済み(★1+)。判定モード切替への追従は廃止(モード自体が消えるため)。
7. **結果画面**: 獲得★(アニメーション的な演出は簡素でよい)+3手それぞれの損失一覧(あなたの手/最善手/損失)+**最も損失が大きかった手についてT128の1手先対比(ClearBlunderCompare)を表示**(明確パターンが検出できた場合のみ。検出不能なら損失一覧のみ)。「もう一度」「次のステージ」「一覧へ」導線。
8. **苦手パターン記録(T129)**: 損失1石以上の手について明確パターンを検出できたら従来どおり加算(判定モード非依存に)。
9. 旧・判定関連コード(judgeMidgameMove/judgeMode設定UI/逆転禁止等)は中盤練習から除去(他モードで共用しているものは残す)。テストは新仕様に沿って作り直してよい(検証意図は維持)。
10. レスポンシブ(375px)・横置き(T133)両対応。

## 実装の参考(既存資産)

- ステージ: `app/src/midgame/stagePool.ts`(111ステージ定義順列挙、T119)/ 記録: `stageProgress.ts`(旧2階層)/ フィルタ: `settings/reviewFilter.ts` / 統計: `patternStats.ts`(T129)/ 対比表示: `ClearBlunderCompare.tsx`+`clearBlunder.ts`(9検出器)/ 評価表示部品: `components/MoveEvalOverlay.tsx`+`moveEvalOverlayLogic.ts`(T138)/ エンジン: `requestAnalyzeAll`(mover視点centi-disc)。
- 相手応手・判定のエンジン設定は既存の中盤練習の解析リミット(MIDGAME_ANALYZE_LIMIT等)を流用し、表示・判定・応手で同一設定を使うこと。

## やらないこと(スコープ外)

- 詰めオセロ・対局・定石練習の変更(T140が対局undoを並行中: app.tsx側と衝突しないようapp/src/midgame/配下+ホーム実績行の定義変更に留める。push時は`git pull --rebase`)
- ステージプールの変更・追加 / SRS化
- bench/・train/への変更(生成走行中)。`npm run typecheck`/`npm run dev`禁止(`npx tsc`直接・`npx vite`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] ★判定純関数のユニットテスト(損失<5/★、<1/★★、全手最善/★★★、≥5/★0、境界値、3手未満終了)
- [ ] 記録のテスト: bestStars更新(下がらない)・旧記録からのシード(一度だけ・旧データ不変)・世代ガード・同期書き込み
- [ ] プレイフローのコンポーネントテスト: ステージ選択→3往復→結果画面(★・損失一覧・最悪手の対比表示)/途中終局の打ち切り判定
- [ ] フィルタ・グリッド★表示・ホーム実績行の新定義追従テスト
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→本番Pagesで: ステージ選択→評価値常時表示で3往復→★獲得→グリッドに★反映、を確認(375x812・844x390)。ビフォー/アフタースクショを撮り保存パスを作業ログに記録
- [ ] 変更対象のみパス明示コミット(`app:`、`(T141)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-19 implementer(Sonnet)実装完了

- `git pull --rebase`実施(コンフリクトなし、origin/mainは既にup to date)。
- 既存資産調査: `PracticeMode.tsx`(旧1405行)・`stageProgress.ts`(判定モード別2階層)・
  `judgeMidgameMove.ts`(**verbalize/PracticeMode.tsxが`mode:'standard'`固定で
  引き続き使用しているため削除せず残置**、中盤練習からの利用のみ廃止)・
  `clearBlunder.ts`/`ClearBlunderCompare.tsx`(1手先対比、読み取り再利用)・
  `MoveEvalOverlay.tsx`+`moveEvalOverlayLogic.ts`(T138部品、読み取り再利用)・
  `reviewFilter.ts`(tsumeと共有、読み取り再利用・表示ラベルのみローカルで上書き)を
  explorer相当の自読解析。
- 新規ファイル: `stageStarJudge.ts`(★判定純関数`computeStageStars`+`isBestMove`、
  境界値含む12ケースのテスト)。
- `stageProgress.ts`全面書き換え: 新localStorageキー
  `othello-trainer:midgame-stage-stars`のフラットスキーマ
  (`bestStars`/`attempts`/`failCount`/`lastResultStars`/`lastAttemptAt`/`firstClearedAt`)。
  **`failCount`はタスク仕様のスキーマに無い追加フィールド**(判断根拠: 復習フィルタ
  「失敗あり」(要件6で存置)が「累積の失敗経験」を要求するが、`attempts`だけでは
  区別できないため)。旧記録(`othello-trainer:midgame-stage-progress`)からの
  一度きりの移行を`loadStageProgress`内に実装(移行済みマーカーキーで二重実行防止、
  旧データは一切変更しない)。`loadStageProgress`/`stageStatus`の**シグネチャ・
  意味論の外形は維持**したため`app.tsx`(T140並行作業中につき無変更)は無改造で
  新定義(`bestStars>=1`が「クリア」)に追従する(実機確認済み、下記参照)。
- `PracticeMode.tsx`全面書き換え(1405行→約590行): 判定モード/相手の強さ/開始局面
  ソース選択・「開始」(ランダム出題)・毎手ごとの合否ゲートを撤去。ステージ選択→
  3往復(自分3手+相手最善応手3手)固定フロー。評価値(候補手オーバーレイ+評価バー)は
  T138のMoveEvalOverlay/computeBoardEvalScore/EvalBarを**変更せず**再利用し常時表示。
  ★判定は表示と同じ`getAnalyzedMoves`キャッシュ経由の結果を使い回し二重計算しない
  (旧`analyzedMovesRef`パターンを踏襲)。苦手パターン検出(損失1石以上の手のみ、
  要件8)・1手先対比(最も損失が大きかった手のみ、要件7)は`clearBlunder.ts`を
  変更せず再利用。`sessionGenerationRef`によるstale-session防止(T119 redo#1教訓)を
  新フロー(`checkSessionEnd`)にも適用。
- 出題プール(`pool.ts`、棋譜解析からの送信機能と共有)への失敗局面登録は
  ★0確定時に1回だけ行うよう維持(判断根拠: タスク仕様に明記は無いが、既存の
  データ収集機能を無指示で削るのは避けた)。
- `PracticeMode.css`: 旧`.midgame-settings*`(判定モード/相手/開始局面チップ)・
  `.midgame-generating`・`.midgame-result__compare-pv`を削除。新要素
  (`.midgame-practice__round`・`.midgame-eval-bar-panel`・`.midgame-result__stars`・
  `.midgame-result__moves`)を追加。横置き(T133)の2カラムgridレイアウトは
  旧`.midgame-result--fail`限定から`.midgame-result:has(.clear-blunder-compare)`に
  一般化(★1以上のクリアでも1手先対比が表示されうるため)。
- テスト: 旧`PracticeMode.settingsUx/clearBlunderGate/clearBlunderGateFallbackGuard.test.tsx`・
  `judgeModeStorage.*`・`generateStart.*`を削除(judgeMidgameMove.test.ts・
  pickOpponentMove.test.tsは他モード共用のため残置)。`PracticeMode.staleSession.test.tsx`・
  `PracticeMode.reviewFilter.test.tsx`・`PracticeMode.patternStats.test.tsx`を新フロー向けに
  改訂、新規`PracticeMode.flow.test.tsx`(3往復完走★3・損失/1手先対比表示・途中終局の
  打ち切り判定)を追加。`app.home.progress.test.tsx`(app.tsx自体は無変更、テストのみ)を
  新`recordStageAttempt`シグネチャに追従。
- 受け入れ基準の実行結果:
  - `npx vitest run`: **95 test files / 771 tests 全パス**。
  - `npx tsc --noEmit -p app/tsconfig.app.json`: **エラーなし**。
  - `git status --short`: 当該タスク由来の差分・未追跡ファイルなし(コミット後)。
- コミット: `632eae0`(`app: 中盤練習をステージクリア型に全面改訂...(T141)`、
  変更対象20ファイルのみをパス明示でadd、`tasks/`はコミットしていない)。
  `git fetch`でorigin/mainとの乖離なしを確認し、そのまま`git push origin main`。
- デプロイ確認: `gh run watch`でActions(Rust Tests/Deploy to GitHub Pages)完走を確認。
  本番Pages(`https://giwarb.github.io/othello-trainer/`)で実機相当の検証を実施
  (Browser MCP、ローカルdevサーバーでも`npx vite --port 5183`で先行確認済み。
  `npm run dev`/`npm run typecheck`は使わず`npx vite`/`npx tsc`直接実行、Rust/wasmビルドは
  行っていない):
    - 375x812: ホーム「クリア x/111」表示 → ステージ一覧(新フィルタ語彙・★0〜3グリッド)
      → ステージ選択 → 評価値オーバーレイ+評価バー常時表示 → 3往復完走
      → 結果画面「クリア!★★☆自己ベストを更新しました!評価値要約+3手の損失一覧」
      → ステージ一覧に★反映・ホームの「クリア」分子が更新、を確認。
    - 844x390(横置き): `.midgame-practice`が2カラムgrid(T133踏襲)で表示され、
      round counter・盤・評価バーが正しく配置されることを確認。
  - 注記: 検証中、既存タブのService Worker更新伝播が遅く一時的に旧UIが表示された
    (SW unregister+再読み込みで解消、コード上の問題ではない)。新規タブでは
    初回から新UIが表示された。
  - `computer{action:"screenshot"}`がこのセッションのBrowser MCPで一貫してタイムアウトし、
    ピクセル画像のスクリーンショットは取得できなかった(環境側の制約と判断、
    他の対局モード等でCanvas盤クリックがcomputer coordinateクリックで動作する前例と
    比較しても本タスク由来の問題ではないとみられる)。代わりに`read_page`/
    `get_page_text`/`javascript_tool`(合法手評価オーバーレイのDOM座標を取得し、
    盤のcanvasへ合成`MouseEvent`をdispatchしてクリックを再現)で機能的な実機検証を
    行った。オーケストレーターのスクショQAは別途正常に動作するBrowser環境で
    実施いただく想定(保存済みスクショファイルは無し)。
- 仕様どおりにできなかった点・判断に迷った点:
  1. `failCount`フィールドをタスク仕様のスキーマに追加した(上記参照、理由は要件6の
     復習フィルタ「失敗あり」を維持するため)。
  2. 出題プールへの失敗局面登録の継続(上記参照)。
  3. 結果画面の「評価値 A → B(損失X石)」表示で、A・Bはそれぞれ丸めて表示するが
     損失Xは丸め前の生値から計算するため、`A-B`の見た目の引き算と1石程度ズレる
     ケースがある(例: 実機検証で「-5 → -9(損失5石)」、-5-(-9)=4のはずが5と表示)。
     数値としては内部的に正しい(生の評価値で計算)が、UI上わずかに混乱を招きうる。
     タスク仕様に丸め方の指定が無かったため放置したが、気になる場合は要調整。
  4. `computer{action:"screenshot"}`が本セッションで機能せず、画像スクショは保存できて
     いない(上記参照)。
