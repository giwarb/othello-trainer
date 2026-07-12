---
id: T077
title: 対局モードに人間vs人間モード・評価値表示切替・盤面自由配置からの開始を追加
status: done
assignee: implementer
attempts: 0
---

# T077: 対局モードに人間vs人間モード・評価値表示切替・盤面自由配置からの開始を追加

## 目的

ユーザー要望(2026-07-12):
1. 「対局モードに、CPUを使わず両方人間で打てるようにして」
2. 「現在の評価値も表示を切り替えられるようにしてほしい」
3. 「自由に駒を配置して、そこからスタートできるようにする機能も入れて、分析にも使えるようにしたい」(本タスクでは対局モードへの統合まで。棋譜解析モードへの統合は別タスクで対応する、下記「やらないこと」参照)

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

### 1. 人間vs人間モードについて

- 対局モードは`app/src/app.tsx`の`PlayMode`関数と`app/src/game/gameLoop.ts`で構成される。`GameState`は`humanSide: Side`(人間が担当する1色)を必ず持ち、`GamePhase`(`'human' | 'cpu' | 'over'`)を`phaseFor(side, humanSide)`(gameLoop.ts、55〜57行目付近)が「その色は人間側か」で機械的に判定する構造。
- 開始ボタン(「黒番で開始」「白番で開始」「ランダムで開始」、app.tsx 347〜355行目付近)は`startNewGame(choice: Side | 'random')`→`createGame(humanSide)`(gameLoop.ts、72〜82行目付近、常に黒番から開始)を呼ぶ。
- CPU応手は`app.tsx`(203〜229行目付近)の`useEffect`が`game.phase === 'cpu'`を検知して`requestCpuMove`(gameLoop.ts、155〜168行目付近)を呼ぶ仕組み。
- 人間vs人間にするには、`GameState`にモードフラグ(例: `vsHuman: boolean`、または`humanSide: Side | 'both'`)を追加し、`phaseFor`をこのフラグに応じて常に`'human'`を返すよう分岐する必要がある。既存の合法手判定・パス処理・終局判定(`playMove`/`afterMove`)はそのまま流用可能。

### 2. 評価値表示の切り替えについて

- 対局モード自体には「現在の盤面全体の評価スコア」を常時表示するUIが無い。現状あるのは、直前の人間の着手のみを評価する`EvalBadge`(app.tsx、`evalInfo` state、405〜410行目付近、`evaluateHumanMove`関数、285〜314行目付近)と、候補手ごとのマス目オーバーレイ`MoveEvalOverlay`(セル単位、盤面全体のバー表示ではない)のみ。
- 中盤練習モードの`app/src/midgame/EvalBar.tsx`(全42行)は、`{ discDiff: number }`のみを受け取るシンプルな表示専用コンポーネント(石差を-16〜+16でクランプして横バー表示、`formatDiscDiff`で数値ラベル化)で、盤面種別や特定モードの状態に依存しないため、対局モードにそのまま転用できる。表示/非表示の判断ロジックは呼び出し側が持つ設計(`midgame/PracticeMode.tsx`の`showEvalBar`/`evalBarValue` stateパターンと同じものを対局モードにも実装すればよい)。
- ON/OFF設定の永続化は`app/src/settings/moveEvalOverlaySettings.ts`(`StorageLike`インターフェース経由でlocalStorageに真偽値を保存/読込)と同じパターンを新設すればよい(例: `app/src/settings/evalBarSettings.ts`、キー`othello-trainer:playEvalBar`)。
- 「現在の評価値」は、現在の盤面状態(直前の着手後の局面、手番が変わった直後の状態)に対してエンジンの1局面評価(`requestAnalyze`、複数候補手をまとめて評価する`requestAnalyzeAll`ではない)を呼べば得られる。**T076(中盤練習の時間予算バグ修正)は複数候補手をまとめて評価する`search_all_moves_with_eval`(`requestAnalyzeAll`)の時間予算共有に関する修正であり、単一局面の評価(`requestAnalyze`、`search_with_eval`)には元々影響しない**ため、本タスクでは時間予算配分について特別な注意は不要(通常の`AnalyzeLimit`を指定すればよい)。

### 3. 盤面自由配置からの開始について

- **重要な訂正**: 棋譜解析モードの「盤面で並べる」タブ(`app/src/analysis/AnalysisMode.tsx`、347〜379行目付近)は、任意のマスに自由に石を置く機能ではない。実体は「初期配置から合法手だけをクリックして棋譜を積み上げていく」入力方式(`handleManualMove`→`manualMoves`配列に追記→`replayGame`で再生、必ず標準初期配置から開始し`legalMoves`チェックを通った手のみ許可)。**この既存機能は今回欲しい「盤面自由配置」機能とは別物であり、流用できない。**
- 石を置く/消すクリック自体は共通の`Board`コンポーネント(`app/src/components/Board.tsx`)の`onMove` propが担うが、これは「現在の手番にとって合法なマスのみ」発火する設計のため、非合法配置や手番の任意選択には使えない。
- したがって、盤面自由配置機能は**新規のUIコンポーネント**として実装する必要がある(例: `app/src/components/BoardEditor.tsx`)。石を置く/取り除くロジック自体(`Board`型のビット操作)は`app/src/game/othello.ts`のユーティリティを流用できるが、UIとしては新規実装になる。

## 変更対象

- `app/src/game/gameLoop.ts` — 人間vs人間モードのフラグ追加、および任意の開始局面(自由配置された盤面+手番)から`GameState`を作れるように`createGame`相当の関数を拡張する。
- `app/src/app.tsx`(`PlayMode`関数) — 上記3つの機能のUI統合。
- 新規: `app/src/components/BoardEditor.tsx`(+CSS) — 盤面自由配置エディタ。任意のマスをクリックして石を置く/消す(例: 現在置く色(黒/白/消去)を選択してからマスをクリックする、またはクリックのたびに空→黒→白→空を循環させる、実装判断でよい)、手番(次に打つ色)を選択できるUI。確定すると`{ board: Board, sideToMove: Side }`を返す。
- 新規: `app/src/settings/evalBarSettings.ts` — 評価値バー表示のON/OFF設定の永続化(`moveEvalOverlaySettings.ts`と同じパターン)。

## 要件

1. 対局モードの開始画面に、「CPU対戦」(既存、黒番/白番/ランダムで開始)に加えて「2人対戦(人間 vs 人間)」を選べる導線を追加すること。2人対戦を選ぶと、CPU応手が一切発生せず、双方の手番で人間のクリックによる着手を受け付けること。
2. 対局モード中、盤面全体の「現在の評価値」を表示するUI(`EvalBar`を再利用)を追加し、表示/非表示を切り替えられるトグル(ボタン等)を用意すること。設定は`localStorage`に永続化し、リロード後も保持されること。
3. 評価値表示は、着手が行われるたびに更新されること(直前の着手後の局面を評価する)。2人対戦モードでも同様に機能すること。
4. 対局モードの開始画面に「盤面を自由に配置して開始」の導線を追加し、新設の`BoardEditor`で任意の局面(石の配置・手番)を作成し、その局面から対局を開始できること。自由配置から開始する対局は、CPU対戦(色・強さ選択)・2人対戦のいずれでも開始できること。
5. 自由配置から開始した対局でも、既存の合法手判定・パス処理・終局判定・悪手判定・評価値表示(要件2)が正しく機能すること。
6. 375px幅等の狭い画面でも、盤面自由配置エディタが問題なく操作できること(レスポンシブ)。
7. 既存のテストが壊れないこと。新規ロジック(`BoardEditor`の石配置ロジック、`GameState`の人間vs人間判定、任意開始局面からの`createGame`)のうち、コンポーネント本体から分離できる純粋関数があれば、vitestで単体テストすること。

## やらないこと(スコープ外)

- 棋譜解析モードへの`BoardEditor`統合(「分析にも使えるように」という要望への完全な対応)は、本タスクでは行わない。対局モードでの実装が完了し`BoardEditor`コンポーネントが安定してから、別タスクで棋譜解析モードに統合する(既存の「盤面で並べる」タブとは別の新しい入力方式として追加する想定)。
- 自由配置した局面の「合法性・到達可能性」(実際のゲームでその配置に至りうるか)の検証は行わない(任意の配置を許可してよい)。ただし、既存のパス・終局判定ロジックが、両者とも合法手が無い開始局面(異常な配置)でも例外を投げず適切に終局扱いにできることは確認すること。
- 対局モード以外(定石練習・中盤練習・詰めオセロ・棋譜解析)の変更は行わない。
- CPU対戦時の相手強さ選択UIの変更は行わない。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする(新規テスト含む)。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、(a)「2人対戦」を選んで開始し、CPU応手が一切発生せず双方の手番で人間の着手を受け付けること、(b)評価値表示トグルをONにすると盤面評価値バーが表示され、着手のたびに更新されること、トグル状態がリロード後も保持されること、(c)「盤面を自由に配置して開始」から任意の局面を作成し、そこから対局(2人対戦・CPU対戦の両方)を開始できること、開始後の合法手判定・終局判定が正しく機能することを確認する。375px幅でも操作できることを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

### 2026-07-12 implementer

**実施内容:**

1. `app/src/game/gameLoop.ts`
   - `GameState`に`vsHuman: boolean`フィールドを追加。`phaseFor`は`vsHuman`が真なら常に`'human'`を返すよう変更(要件1)。
   - `createGame(humanSide, options?: { vsHuman?: boolean })`に第2引数(オプション)を追加(既存呼び出し元は変更不要、後方互換)。
   - 任意局面から対局を開始する`createGameFromPosition(board, sideToMove, humanSide, options?)`を新規追加。内部で`resolveInitialState`ヘルパーを新設し、`afterMove`と同じパス/終局判定規則を初期局面にも適用(要件4・5、「両者とも合法手が無い開始局面でも例外を投げず終局扱いにする」を満たす)。
   - `afterMove`/`playMove`に`vsHuman`を伝播。
   - `app/src/game/gameLoop.test.ts`にvsHuman・`createGameFromPosition`(通常開始/片側パス/両者パスで即終局/vsHuman併用)のテストを追加。

2. `app/src/components/boardEditorLogic.ts`(新規)+ `boardEditorLogic.test.ts`(新規)
   - 盤面自由配置の石配置を行う純粋関数`setSquare(board, square, placement)`と`EMPTY_BOARD`を実装。単体テスト6件。

3. `app/src/components/BoardEditor.tsx`(新規)+ `BoardEditor.css`(新規)
   - 既存の`Board`コンポーネント(合法手クリック専用)は自由配置に使えないため、新規のHTML(CSS Grid+button要素)実装とした。「置く石(黒/白/消す)」パレット・「次の手番」選択・「初期配置に戻す」「全て消す」ボタンを持つ制御コンポーネント(`board`/`sideToMove`/`onChange`をpropsで受け取る)。
   - レスポンシブ: `@media (max-width: 400px)`でパレット・ツールボタンの文字サイズを調整(要件6)。

4. `app/src/settings/evalBarSettings.ts`(新規)+ `evalBarSettings.test.ts`(新規)
   - `moveEvalOverlaySettings.ts`と同一パターンで評価値バー表示ON/OFFを`localStorage`(キー`othello-trainer:playEvalBar`)に永続化。単体テスト6件。

5. `app/src/app.tsx`(`PlayMode`関数)
   - 新規対局ボタン列に「2人対戦で開始」「盤面を自由に配置して開始」を追加(要件1・4)。
   - 「現在の評価値を表示」トグルを追加(`evalBarEnabled`、`localStorage`永続化)。ON時、`game`が変わるたび(人間/CPU/2人対戦いずれの着手後、新規対局開始時も)`requestAnalyze`で現局面を評価し、`midgame/EvalBar.tsx`を転用して表示(要件2・3)。表示の基準色は2人対戦時は黒固定、CPU対戦時は`humanSide`視点(終局後はエンジン呼び出しをせず石差を直接使用、合法手が無い局面をエンジンに問い合わせるのを避けるため)。
   - `editorOpen`state追加。「盤面を自由に配置して開始」で`BoardEditor`を表示し(通常の対局盤は隠す)、「この局面から開始: 黒番/白番/ランダム/2人対戦」ボタンで`createGameFromPosition`を呼んで対局開始(要件4・5)。
   - 2人対戦モードの状態文言("2人対戦モードです。")、終局演出(`celebrationKindForGame`: 2人対戦時は常に`'draw'`と同じ落ち着いたトーン、CPU対戦は既存の`celebrationKindFor`のまま)。
   - **実装中に発見した既存バグの修正**: 自由配置・2人対戦(白から開始する等)で最初の着手が定石DBの正規化前提(黒の初手はd3/c4/f5/e6のいずれか)を満たさない場合、`lookupJosekiNode`内部の`opForFirstMove`が`RangeError`を投げ、`evaluateHumanMove`全体(悪手判定・評価値表示含む)が中断されてしまうことをPlaywright実機確認中に発見(要件5「自由配置から開始した対局でも…悪手判定・評価値表示が正しく機能すること」に抵触)。`safeLookupJosekiNode`ラッパーを追加し、例外を「定石対象外」として握りつぶすことで修正(`joseki/normalize.ts`/`lookup.ts`自体は変更していない)。

6. `app/src/app.css`
   - `.play-eval-bar`(評価値バーのキャプション付きコンテナ)・`.board-editor-panel`のスタイルを追加。

**受け入れ基準の実行結果:**

- `npm test`(`app/`配下): 60ファイル / 502件 全件パス。
  ```
  Test Files  60 passed (60)
       Tests  502 passed (502)
  ```
- `npm run build`(`app/`配下): 成功(`tsc -b && vite build`ともにエラーなし)。
- 実機確認(ローカル、`npm run dev` + Playwright、viewport 375x800):
  - (a) 「2人対戦で開始」→ 黒がd3をクリック後「手番: 白」に、続けて白がc3をクリック後「手番: 黒」に遷移。CPU応手(`requestCpuMove`)は一切発火しないことを確認。
  - (b) 「現在の評価値を表示」チェックで`.play-eval-bar`(EvalBar)が表示され、着手のたびに数値が更新されることを確認。ページリロード後もチェック状態がtrueのまま保持されることを確認(`localStorage`永続化)。
  - (c) 「盤面を自由に配置して開始」→ パレットで黒/白を置く・消すがそれぞれ正しく盤面(`.board-editor__cell--black`/`--white`のカウント)に反映されることを確認。「初期配置に戻す」+「次の手番: 白」を選び「2人対戦で開始」→ 標準初期局面で白番から開始され、白の合法手(c5)をクリックすると黒番に遷移することを確認(既存の合法手判定・パス処理が自由配置後の対局でも機能)。さらに、a1にのみ黒石1個という異常配置(両者とも合法手なし)から開始すると、例外を投げず即座に「対局終了。」と表示されることを確認(やらないこと欄の確認事項)。
  - 自由配置から開始した対局でも、着手後に`.eval-info`(EvalBadge、悪手判定バッジ)が正しく表示されることを確認(上記「実装中に発見した既存バグ」の修正確認)。
  - 375px幅で全操作(パレット選択・盤面クリック・手番選択・開始ボタン群)が問題なく行えることをスクリーンショットで確認。
  - Playwrightスクリプト実行中、ブラウザコンソールに`console.error`が一切出力されないことを確認(`ALL CHECKS PASSED (no console errors)`)。
- 本番デプロイ確認:
  - `git push origin main`(コミット`be48db2`)。
  - `gh run watch 29170703702 --exit-status` でGitHub Actions「Deploy to GitHub Pages」の完了を確認: `build`・`deploy`ジョブともに成功(`success`/`completed`)。
  - 本番URL(`https://giwarb.github.io/othello-trainer/`)に対して、ローカル確認と同じPlaywrightスクリプト(viewport 375x800)を実行し、(a)2人対戦モード、(b)評価値バー表示・トグルのリロード後永続化、(c)盤面自由配置エディタでの配置/消去・「初期配置に戻す」+手番選択からの対局開始・合法手判定/パス処理、異常配置(両者合法手なし)での即終局、着手後の`.eval-info`(悪手判定バッジ)表示、のすべてを再確認。ローカルと同じ結果(`ALL CHECKS PASSED (no console errors)`)。

**判断に迷った点:**

- 評価値バーの基準色(符号の視点)をどちらにするか: CPU対戦は既存の`evalInfo`/中盤練習モードと同じ「`humanSide`視点(+なら自分が有利)」、2人対戦は単一の「自分」が存在しないため黒視点固定とした。キャプション(`「現在の評価値(◯視点、+なら有利)」`)で明示することで曖昧さを軽減している。
- 2人対戦モードの終局演出(`ResultCelebration`)の種別: 既存の`celebrationKindFor`は`humanSide`視点の勝敗を前提とするため、2人対戦では常に`'draw'`と同じ落ち着いたトーンにした(どちらか一方だけを「勝ち演出」にするのは不自然なため)。
- 盤面自由配置エディタの石配置UI: タスクファイルが挙げた2案(色選択+クリック/クリックで循環)のうち、「置く石」パレット(黒/白/消すのラジオボタン)+クリックで配置、を採用した(状態遷移が明示的でテストしやすく、誤操作もしにくいため)。
- 上記の「既存バグの修正」(`safeLookupJosekiNode`)はスコープ外のファイル(`joseki/`配下)を変更せず、`app.tsx`側の呼び出し箇所のみで対処した(要件5を満たすために必要な最小限の修正と判断)。
