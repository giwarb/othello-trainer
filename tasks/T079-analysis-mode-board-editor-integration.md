---
id: T079
title: 棋譜解析モードに盤面自由配置エディタを統合し、任意局面から解析できるようにする
status: done
assignee: implementer
attempts: 0
---

# T079: 棋譜解析モードに盤面自由配置エディタを統合し、任意局面から解析できるようにする

## 目的

ユーザー要望(2026-07-12、対局モードへの盤面自由配置機能追加(T077)の依頼時に「分析にも使えるようにしたい」と明言)。T077で新設した盤面自由配置エディタ(`BoardEditor`)を棋譜解析モードにも統合し、任意の局面から着手を積み上げて解析できるようにする。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

explorerによる事前調査の結果:

- `app/src/components/BoardEditor.tsx`(T077で新設): `{board, sideToMove, onChange}`を受け取る制御コンポーネント。状態は呼び出し側が保持する設計で、`app/src/app.tsx`(対局モード)での統合パターン(`editorBoard`/`editorSideToMove` state + `handleEditorChange`)がそのまま参考になる。
- `app/src/analysis/AnalysisMode.tsx`(27行目付近)の`InputTab`型は現状`'transcript' | 'manual'`(「テキストで入力」「盤面で並べる」)の2択。「盤面で並べる」タブ(`manualMoves`配列、`handleManualMove`、`app/src/analysis/analyzeGame.ts`の`replayGame`で毎回再生)は**必ず標準初期配置から始まり合法手のみ積み上げる**方式。
- **`replayGame`(`analyzeGame.ts`、120〜141行目付近)は`const start = initialBoard()`で開始局面がハードコードされている。`analyzeGame`関数(182〜265行目付近)も入力は`moves: readonly string[]`のみで、開始局面を注入する引数が無い。** 任意局面からの解析をサポートするには、`replayGame`・`analyzeGame`双方に「開始局面(盤面+手番)」を渡せる任意引数を追加する必要がある(**省略時は`initialBoard()`+黒番をデフォルトにし、既存呼び出し元(全て標準初期局面前提)との後方互換を保つこと**)。
- **重要な注意点**: `analyzeGame.ts`(195行目付近)の`const firstMoveSquare = notationToSquare(moves[0]!)`と、定石DB照会(234行目付近、`lookupJosekiNode(josekiDb, pos.board, mover, firstMoveSquare)`)は、標準初期局面からの黒の合法手4通り(d3/c4/f5/e6)を前提にした`opForFirstMove`(`joseki/normalize.ts`)に依存しており、カスタム開始局面から始めた場合の最初の着手がこの4マス以外だと`RangeError`を投げ、解析全体が失敗する(T077でも同種の問題が見つかり`safeLookupJosekiNode`で対症療法したが、今回は根本的に「カスタム開始局面では定石DB照会自体を無効化する」のが自然な設計)。オセロクエスト式の定石DBはそもそも標準初期局面を前提にしたものであり、カスタム開始局面の対局では意味を持たないため、**カスタム開始局面から解析する場合は定石DB照会を最初から行わない(`evalSource`が「定石」になることは無い)仕様でよい**。
- `Board`コンポーネント(対局用、合法手のみクリック発火)は開始局面に依存しない汎用ロジックであり、カスタム開始局面からの着手積み上げにもそのまま使い回せる。「盤面で並べる」タブの`handleManualMove`と同じ仕組みを、開始局面だけカスタムにして流用できる。

## 変更対象

- `app/src/analysis/analyzeGame.ts` — `replayGame`・`analyzeGame`に、開始局面(盤面+手番)を指定できる任意パラメータを追加する(省略時は標準初期局面、既存の後方互換を保つ)。カスタム開始局面が指定された場合は定石DB照会を行わない。
- `app/src/analysis/AnalysisMode.tsx` — 新しい入力タブ(例:「盤面を自由配置」)を追加する。`BoardEditor`で開始局面(盤面+手番)を作成した後、既存の「盤面で並べる」と同様に`Board`コンポーネントの合法手クリックで着手を積み上げていき、解析を実行できるようにする。

## 要件

1. 棋譜解析モードに、`BoardEditor`を使って任意の開始局面(石の配置・手番)を作成できる新しい入力タブを追加すること。
2. 作成した開始局面から、既存の「盤面で並べる」と同様に、合法手クリックで着手を積み上げていけること。
3. 積み上げた着手列を、作成した開始局面を起点として解析できること(評価グラフ・ムーブリスト・悪手分析パネル等、既存の解析結果表示が正しく機能すること)。
4. カスタム開始局面から解析する場合、定石DB照会に起因するエラー(`RangeError`等)が発生しないこと(定石DB照会自体を行わない、または安全に無効化すること)。
5. 既存の「テキストで入力」「盤面で並べる」(標準初期局面前提)の動作に回帰が無いこと(`replayGame`/`analyzeGame`の変更が後方互換であることを確認する)。
6. 375px幅等の狭い画面でも新しい入力タブが問題なく操作できること。
7. 既存のテストが壊れないこと。`replayGame`/`analyzeGame`への開始局面パラメータ追加について、新規テスト(カスタム開始局面からの解析が正しく動作すること、定石DB照会が行われないこと)を追加すること。

## やらないこと(スコープ外)

- 既存の「盤面で並べる」タブ自体の実装変更は行わない(新しい入力タブとして追加するのみ)。
- 対局モード(T077で実装済み)の変更は行わない。
- カスタム開始局面の「合法性・到達可能性」の検証は行わない(T077と同様、任意の配置を許可してよい)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする(新規テスト含む)。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: `npm run dev`で、棋譜解析モードの新しい入力タブから任意の局面を作成し、そこから着手を積み上げて解析を実行し、評価グラフ・ムーブリスト・悪手分析パネルが正しく表示されることを確認する。定石DB照会に起因するエラーが発生しないことを確認する。既存の「テキストで入力」「盤面で並べる」タブの動作に回帰が無いことを確認する。375px幅でも操作できることを確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で上記を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

2026-07-12 09:02 implementer: 実装完了。

### 変更内容

- `app/src/analysis/analyzeGame.ts`:
  - `StartPosition`型(`{ board, sideToMove }`)を新設し、`replayGame(moves, start?)`・
    `analyzeGame(engine, moves, options)`(`options.start?: StartPosition`)に任意引数として追加。
    省略時は従来通り`initialBoard()`+黒番(既存呼び出し元は無変更で動作、後方互換)。
  - `analyzeGame`側で`options.start`が指定された場合、`options.josekiDb`の値に関わらず
    `josekiDb`をローカルで`null`扱いにし、定石DB照会(`lookupJosekiNode`)を完全に無効化。
    標準初期局面前提の対称正規化(`joseki/normalize.ts`の`opForFirstMove`)がカスタム開始局面の
    初手でRangeErrorを投げる問題を根本的に回避。
- `app/src/analysis/AnalysisMode.tsx`:
  - `BoardEditor`(T077)をインポートし、`InputTab`に`'custom'`を追加。新タブ「盤面を自由配置」を
    「テキストで入力」「盤面で並べる」の後に追加。
  - タブ内は2段階UI: (1) `BoardEditor`で開始局面(石の配置・手番)を組み立て「この局面から開始」で
    確定 → (2) 確定後は既存の`Board`コンポーネントで合法手クリックにより着手を積み上げ(既存の
    「盤面で並べる」の`handleManualMove`と同じ仕組みを`customStart`起点で流用)、「解析開始」で
    `startAnalysis(customMoves, customStart)`を呼ぶ。「開始局面を編集し直す」でエディタに戻れる。
  - `startAnalysis`に`start?: StartPosition`引数を追加し、`analyzeGame`にそのまま渡すよう変更。
- `app/src/analysis/AnalysisMode.css`: `.analysis-input__custom`/`.analysis-input__custom-buttons`
  (既存の`manual`系と同等のレイアウト)を追加。タブが3つになったため`.analysis-input__tabs`に
  `flex-wrap: wrap`を追加(375px幅で3つ目のタブが独立した行に折り返される)。
- `app/src/analysis/analyzeGame.test.ts`: `createBoard`・`StartPosition`をインポートし、新規
  `describe('analysis/analyzeGame: カスタム開始局面(T079...)')`を追加(4件)。黒d4・白d5のみの
  カスタム局面(黒番)から`replayGame`/`analyzeGame`が正しく動作すること、`josekiDb`を渡しても
  評価ソースが`'joseki'`にならない(RangeErrorも起きない)こと、`start`省略時の後方互換を確認。

### 受け入れ基準の実行結果

- `npm test`(`app/`): 全件パス。`Test Files 60 passed (60)` `Tests 506 passed (506)`
  (既存485件+新規21件相当。実際の内訳は新規4件+既存全件、他タスクの並行変更分も含む)。
- `npm run build`(`app/`): 成功(`tsc -b && vite build`、wasmビルド含め正常終了)。
- 実機確認(`npm run dev`、Playwright): scratchpad配下`t079_e2e.mjs`で以下を自動確認。
  - 「盤面を自由配置」タブ: 標準初期局面のまま次の手番を「白」に変更(標準初期局面では
    白番の合法手はc5/d6/e3/f4で、定石DBが前提とする黒の初手4通りd3/c4/f5/e6のいずれとも
    異なるため、真にカスタムな開始局面のシナリオになる)→「この局面から開始」→盤面クリックで
    c5に着手(1手)→「解析開始」→`.analysis-result`が表示され、ムーブリストに「定石」の
    文字列が含まれないこと(定石DB照会が無効化されている証跡)を確認。悪手分析パネルも
    エラーなく開閉できることを確認。
  - 回帰確認: 「テキストで入力」(`f5d6c3d3c4`)・「盤面で並べる」(標準初期局面前提)の
    いずれも解析結果画面まで正常に到達することを確認。
  - 375px幅: 新しいページで「盤面を自由配置」タブを開き、`document.documentElement.scrollWidth`
    が`clientWidth`を超えない(横スクロール無し)ことを確認、スクリーンショットでもタブ・
    エディタ・盤面・ボタン群が縦積みで崩れず表示されることを目視確認。開始局面確定→合法手
    クリック(d3)→着手1手積み上がることも確認。
  - コンソールエラー・ページエラーともに0件。
  - スクリプト全体が`ALL CHECKS PASSED`で正常終了。
- 本番デプロイ確認:
  - コミット`c2cf90f`(`app/src/analysis/AnalysisMode.css`・`AnalysisMode.tsx`・
    `analyzeGame.test.ts`・`analyzeGame.ts`・`tasks/T079-*.md`のみをステージ、他の
    未コミット変更は含めず)を作成し`git push origin main`。
  - GitHub Actions「Deploy to GitHub Pages」(run 29173119683)を`gh run watch`で監視、
    `build`(1m2s)・`deploy`(8s)とも成功(`✓`)を確認。
  - 本番URL(`https://giwarb.github.io/othello-trainer/`)に対し、上記と同じPlaywright
    スクリプト(`t079_e2e.mjs`)を実行し、`ALL CHECKS PASSED`(カスタム開始局面からの解析・
    定石DB非参照・悪手分析パネル・テキスト入力/盤面で並べるタブの回帰無し・375px幅での
    横スクロール無し・着手積み上げ・コンソール/ページエラー0件)を確認。

### 判断に迷った点

- 「盤面を自由配置」タブの2段階UI(エディタ確定→着手積み上げ)は、タスク仕様の
  「BoardEditorで開始局面を作成した後、既存の『盤面で並べる』と同様に合法手クリックで
  着手を積み上げる」という記述をそのまま素直に実装した設計であり、他に自然な選択肢は
  ないと判断した(対局モードの`PlayMode`での`editorOpen`のような別画面遷移ではなく、
  同一タブ内で状態を切り替える方式にしたのは、解析結果に戻ってきたときに同じタブ内で
  完結させたかったため)。

---

2026-07-12 09:20 verifier: 受け入れ基準を独立に検証。**合格**。

### 実行内容と結果

1. `npm test`(`app/`): 全件パス。`Test Files 60 passed (60)` / `Tests 506 passed (506)`。
   `analyzeGame.test.ts`単体実行でも`Tests 22 passed (22)`(うちT079新規4件を目視確認、
   全てカスタム開始局面の`describe`ブロック内に存在)。
2. `npm run build`(`app/`): 成功(`wasm:build` → `tsc -b && vite build` → sw version注入
   まで正常終了)。
3. コードリードによる確認:
   - `replayGame(moves, start?)`・`analyzeGame(engine, moves, options)`の`options.start?`は
     ともに任意引数で、省略時は`initialBoard()`+黒番にフォールバックしており後方互換
     (`analyzeGame.ts` 134〜137行目、158〜183行目)。
   - `analyzeGame`内で`const josekiDb = options.start ? null : (options.josekiDb ?? null)`
     (224行目)により、`start`指定時は`options.josekiDb`の値に関わらず定石DB照会
     (`lookupJosekiNode`)が完全にスキップされることをコードで確認。
4. 実機確認(独自にPlaywrightスクリプトを作成し、implementerの申告を鵜呑みにせず再検証。
   `npm run dev`のローカルサーバー(port 5177)に対して実行):
   - 「盤面を自由配置」タブが存在し、`BoardEditor`で次の手番を「白」に切り替え(標準
     初期局面のまま、白番の合法手c5/d6/e3/f4は定石DBが前提とする黒の初手4通り
     d3/c4/f5/e6のいずれとも異なる、真にカスタムなシナリオ)→「この局面から開始」→
     盤面クリックでc5に着手(1手)→「解析開始」で解析結果画面に到達することを確認。
   - ムーブリストのテキストに「定石」の文字列が含まれないことを確認(定石DB照会が
     無効化されている証跡)。悪手分析パネル(この着手は「疑問手」判定になった)を
     開いてもエラーが出ないことを確認。評価グラフ(`svg`/`canvas`)要素の表示も確認。
   - 回帰確認: 「テキストで入力」(`f5d6c3d3c4`)・「盤面で並べる」(標準初期局面前提)の
     いずれも問題なく解析結果画面に到達することを確認。
   - 375px幅: `document.documentElement.scrollWidth`が`clientWidth`と一致(横スクロール
     無し)。スクリーンショットでもタブが折り返され、エディタ・盤面・ボタン群が縦積みで
     崩れずに表示されることを目視確認。開始局面確定→合法手クリックで着手が1手積み
     上がることも確認。
   - コンソールエラー・ページエラーともに0件。
   - なお検証中、最初にPlaywrightスクリプトで「白」というテキストにマッチする要素を
     誤って`BoardEditor`の「白を置く」(石を置くツール選択、`placement`用ラジオ)にヒット
     させてしまい、実際には「次の手番」を白に切り替えられていなかった(結果的に標準の
     黒番のままd3に着手する回だった)ミスがあった。セレクタを
     `.board-editor__side-to-move input[type=radio]`に修正して切り分け、正しく白番の
     開始局面から検証し直した(implementer側の実装自体の問題ではなく、こちらの検証
     スクリプトの初期ミスであり、修正後は正常に動作することを確認済み)。
5. 本番デプロイ確認:
   - `git log`でコミット`c2cf90f`(T079実装)がmainにpush済みであることを確認。
   - `gh run list --branch main`で、`c2cf90f`に対応する「Deploy to GitHub Pages」
     (run 29173119683)が`completed / success`であることを確認。
   - 本番URL(`https://giwarb.github.io/othello-trainer/`)に対し、ローカル検証と同一の
     Playwrightスクリプトを実行し、上記4の全項目(カスタム開始局面からの解析・定石DB
     非参照・悪手分析パネル・テキスト入力/盤面で並べるタブの回帰無し・375px幅での
     横スクロール無し・着手積み上げ・コンソール/ページエラー0件)が`ALL CHECKS PASSED`
     で全てパスすることを確認。

### 判定

合格。受け入れ基準4項目すべてを独立に再現・確認できた。
