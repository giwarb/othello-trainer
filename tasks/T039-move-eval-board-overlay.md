---
id: T039
title: 盤面セル評価オーバーレイ(候補手ごとの評価インジケータ)+ 対局モードへの統合
status: review
assignee: implementer
attempts: 0
---

# T039: 盤面セル評価オーバーレイ(候補手ごとの評価インジケータ)+ 対局モードへの統合

## 目的

ユーザー要望: 盤面上の各合法手のマスに、その手を打った場合の評価(良い手ならプラス、悪い手ならマイナス)を視覚的に表示する機能がほしい。表示ON/OFFは切り替え可能にする。まず共通コンポーネントと設定の仕組みを作り、対局モードで実証する(他モードへの展開は別タスクT041で行う)。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- 盤面描画: `app/src/components/Board.tsx`(29-129行目)がCanvasで盤面・石・合法手マーカーを描画する。`legalMoves(board, sideToMove)`(68行目)で合法手集合を取得。座標系は`square = rank0*8+file`(0..63、fileは列・rank0は行)。再描画トリガーは`useEffect`の依存配列`[board, sideToMove, lastMove]`(106行目)。`Board`自体はクリック判定・描画をCanvas内で完結しており、マスごとの追加装飾を挿すAPIは無い。**`Board.tsx`自体は変更しない**(座標系・クリックロジックに手を入れない)。
- 既存の類似オーバーレイ機構: `app/src/analysis/BoardOverlay.tsx`(46-55行目)がモチーフ検出可視化(T032)で使っているパターン。8x8のCSS Grid(`div`)で各マスにハイライト色を重ねる。`app/src/analysis/BoardOverlay.css`の`.board-with-overlay`(position:relative、親ラッパー)+`.board-overlay`(position:absolute; inset:0; pointer-events:none)を使い、`app/src/analysis/BlunderPanel.tsx`(479-480行目)で`<Board .../>{boardHighlights && <BoardOverlay .../>}`という形で重ねている。**今回の評価インジケータもこのパターンを踏襲する**(`pointer-events:none`にしないと`Board`のクリック判定を妨げてしまうので必ず維持すること)。
- 候補手一括評価API: `app/src/engine/client.ts`(114-135行目)の`requestAnalyzeAll(board, sideToMove, limit)`(WASM側`search_all_moves`、T018で実装)が、現局面の全合法手の評価(`MoveEvalJson[]`、各要素に着手先マス・評価値・`type`(`'midgame'|'exact'`)を含む)を一括取得できる。既存の呼び出し箇所(`app/src/app.tsx:197`等)は**すべて「人間が着手した後」に評価するためのもの**であり、「着手前に全合法手を評価してマスに表示する」用途では呼ばれていない。本タスクではこの目的のための新規呼び出しを対局モード(`app/src/app.tsx`)に追加する。
- 悪手分類ロジック: `app/src/analysis/classifyMove.ts`(23-31行目)の`classifyMove(lossDiscs, thresholds)`が、最善手からの損失量(石差)を`best / inaccuracy / dubious / blunder`の4段階に分類する純粋関数。`thresholds`は`app/src/blunder/storage.ts`の`BlunderConfig`(ユーザーが調整可能な悪手判定閾値、`localStorage`キー`othello-trainer:blunderConfig`で永続化)から取得する。**この関数・設定をそのまま再利用**し、各候補手について「その手を選んだ場合の損失量」を計算し4段階に分類、緑(best)〜赤(blunder)のグラデーション色で表示する。
- 設定の永続化パターン: `app/src/blunder/storage.ts`(19, 41, 54行目)が`BlunderConfig`を`localStorage`にJSON文字列で保存・読込する薄いラッパー関数(`loadBlunderConfig()` / `saveBlunderConfig(config)`のような形)を提供している。今回の「オーバーレイ表示ON/OFF」設定も同じパターンで新規モジュールを作り、モード間・リロード後も設定が引き継がれるようにする。

## 変更対象

- `app/src/settings/moveEvalOverlaySettings.ts`(新規) — オーバーレイ表示ON/OFF設定の型・読込・保存関数。`localStorage`キーは`othello-trainer:moveEvalOverlay`、デフォルトは`false`(非表示)。`app/src/blunder/storage.ts`と同じ実装パターンに揃える。
- `app/src/components/MoveEvalOverlay.tsx`(新規) — 候補手評価オーバーレイの本体コンポーネント。Props例: `{ allMoves: MoveEvalJson[] | null, mover: 'black' | 'white', thresholds: BlunderConfig, visible: boolean }`。`allMoves`が`null`または`visible`が`false`のときは何も描画しない。`allMoves`がある場合、各候補手について「その手の評価値(mover視点の石差)」と「候補手中の最善評価値」の差から`lossDiscs`を計算し、`classifyMove(lossDiscs, thresholds)`で分類、分類に応じた色(例: best=緑、inaccuracy=黄緑、dubious=橙、blunder=赤)のマーカーをそのマス位置に描画する(`BoardOverlay.tsx`と同じ8x8 CSS Gridの実装方式)。マーカーには「+N」「-N」のような損失量の数値も小さく表示する(best=0は「±0」等)。
- `app/src/components/MoveEvalOverlay.css`(新規、または既存の`BoardOverlay.css`と同様の配置) — オーバーレイのスタイル。`.board-with-overlay` / `.board-overlay`は既存の`app/src/analysis/BoardOverlay.css`の定義と重複しないよう、共通化するか(`app/src/components/`配下に共通CSSとして切り出す)、同名クラスの衝突を避けた別名にすること。
- `app/src/app.tsx` — 対局モードへの統合。(1)人間の手番になったタイミング(既存の`game.phase === 'human'`相当の判定を確認して使う)で、オーバーレイ設定がONなら`requestAnalyzeAll(board, sideToMove, limit)`を呼び候補手評価を取得する(二重リクエスト防止のガードを入れること。既存の`evaluateHumanMove`等の呼び出しと競合しないよう、状態管理を分離するか使い回すか実装時に判断してよい)。(2)`<Board .../>`の直後に`<MoveEvalOverlay .../>`を重ねて表示する。(3)オーバーレイ表示ON/OFFを切り替えるトグルUI(チェックボックスまたはボタン、ラベル例:「候補手評価を表示」)を追加し、`moveEvalOverlaySettings.ts`で永続化する。

## 要件

1. オーバーレイ設定がOFF(デフォルト)のときは、対局モードの挙動・見た目は現状から一切変化しないこと(既存の対局モードのテストがあれば壊れないこと)。
2. オーバーレイ設定をONにすると、人間の手番になった時点で、合法手のあるマスすべてに評価インジケータ(色+損失量の数値)が表示されること。CPU(白または黒)の手番中は表示されない、または前回人間手番時の情報が残っていても実害がない形で構わない(細かい仕様はコード上自然な形でよい)。
3. 色分けは`classifyMove.ts`の`best/inaccuracy/dubious/blunder`の4区分に対応し、`BlunderConfig`の閾値設定を尊重すること(ハードコードした独自閾値を新設しない)。
4. オーバーレイのON/OFF設定は`localStorage`に永続化され、ページリロード後も維持されること。
5. `Board.tsx`のクリック判定(合法手クリックで着手)がオーバーレイ表示中も正常に機能すること(`pointer-events:none`を必ず維持)。
6. 新規コンポーネント(`MoveEvalOverlay.tsx`)・設定モジュール(`moveEvalOverlaySettings.ts`)のユニットテストを追加すること(分類→色マッピングのロジック、設定の読込・保存の往復)。

## やらないこと(スコープ外)

- 定石練習・中盤練習・詰めオセロ・棋譜解析(フリー分岐探索)への展開は、本タスクでは行わない(後続タスクT041で対応)。ただし共通コンポーネント(`MoveEvalOverlay.tsx`)・設定モジュールは他モードからもそのまま再利用できる汎用的なProps設計にしておくこと。
- `Board.tsx`自体の変更(座標系・クリックロジック)は行わない。
- `classifyMove.ts`のロジック変更・閾値のデフォルト値変更は行わない。
- パフォーマンス最適化(既存の着手後評価呼び出しと今回の着手前評価呼び出しを1回に統合する等)は行わなくてよい(将来の改善候補として作業ログに記録すれば十分)。
- CPU側の手番でもオーバーレイを出す機能は不要(人間の手番のみでよい)。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする(新規テストを含む)。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 対局モードでオーバーレイをONにすると合法手マスに評価インジケータが表示され、着手すると通常通り進行すること、OFFにすると表示が消えること、リロード後も直前のON/OFF設定が維持されることをブラウザ(`npm run dev`)で確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で対局モードのオーバーレイ表示・トグル操作を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

<!-- 例: 2026-07-06 12:00 implementer: xxx を実装。`npm test` 12件パス。 -->

- 2026-07-09 implementer: 以下を新規実装した。
  - `app/src/settings/moveEvalOverlaySettings.ts`(新規): オーバーレイ表示ON/OFF設定の型・読込・保存関数(`localStorage`キー`othello-trainer:moveEvalOverlay`、既定`false`)。`app/src/blunder/storage.ts`と同じ`StorageLike`パターン。
  - `app/src/components/moveEvalOverlayLogic.ts`(新規): 分類→色マッピングの純粋関数(`computeCellEvals`: `MoveEvalJson[]`からマス番号→`{classification, lossDiscs}`のMapを構築、`formatLoss`: 損失量を`±0`/`-N.N`形式に整形)。`vitest.config.ts`が`.test.ts`のみを対象にしている(`.tsx`非対応、`BoardOverlay.tsx`も無テスト)ため、テスト可能なロジックはコンポーネント本体から分離した。
  - `app/src/components/MoveEvalOverlay.tsx`(新規): 候補手評価オーバーレイ本体。`analysis/BoardOverlay.tsx`と同じ8x8 CSS Grid + `position:absolute` + `pointer-events:none`方式。`visible===false`または`allMoves===null`のときは`null`を返す。
  - `app/src/components/MoveEvalOverlay.css`(新規): `.board-with-move-eval-overlay`/`.move-eval-overlay`/`.move-eval-overlay__cell--{best,inaccuracy,dubious,blunder}`等、`BoardOverlay.css`とクラス名が衝突しない別名で定義。
  - `app/src/app.tsx`: `PlayMode`に統合。(1) `game.phase === 'human' && moveEvalOverlayEnabled`のときのみ`requestAnalyzeAll`を新規`useEffect`で呼び`overlayMoves`に格納(既存の`evaluateHumanMove`とは独立した状態・エフェクト、着手後評価とは競合しない)。(2) `<Board>`を`.board-container.board-with-move-eval-overlay`で包み、直後に`<MoveEvalOverlay>`を重ねて表示。(3) 「候補手評価を表示」チェックボックスを追加し`moveEvalOverlaySettings.ts`で永続化。
  - `app/src/settings/moveEvalOverlaySettings.test.ts`(新規)・`app/src/components/moveEvalOverlayLogic.test.ts`(新規): 設定の読込・保存の往復(壊れたJSON・型不正時のフォールバック含む)、分類→色マッピング(閾値どおりの4区分、`notationToSquare`によるマス番号変換)をテスト。

  **仕様上の判断(タスク記載の`BlunderConfig`と実装の相違)**: タスク背景説明では`MoveEvalOverlay`のProps例として`thresholds: BlunderConfig`(`method`/`lossThreshold`/`rankThreshold`)を挙げていたが、実際に`classifyMove(lossDiscs, thresholds)`が受け取る型は`ClassifyThresholds`(`inaccuracy`/`dubious`/`blunder`、`app/src/analysis/types.ts`)であり、両者はフィールドが異なる別の型(`BlunderConfig`は3方式の悪手判定用、`ClassifyThresholds`は4段階分類の閾値用)。`classifyMove.ts`のロジック変更は「やらないこと」に明記されているため変更できず、既存の`app/src/analysis/thresholdSettings.ts`(`ClassifyThresholds`の`localStorage`永続化、棋譜解析モードの閾値設定と共有)をそのまま再利用する形にした。要件3「ハードコードした独自閾値を新設しない」の趣旨には、この実装(既存の`ClassifyThresholds`設定をそのまま読み込む)の方が忠実と判断した。対局モード側に独自の閾値編集UIは追加していない(棋譜解析モードの設定画面で変更すれば対局モードのオーバーレイにも反映される)。

  **検証結果**:
  - `npm test`(`app/`配下): 54ファイル・455件全件パス(新規テスト12件超を含む)。
  - `npm run build`(`app/`配下): 成功(`tsc -b && vite build && inject-sw-version`)。ビルド中、並行作業中の他エージェントによる`train/`クレートの一時的な不整合(`cargo metadata`失敗)で`prebuild`(wasm再ビルド)が一度失敗したが、`engine`クレート自体は本タスクで変更していないため既存の`app/src/engine/pkg`を使い`npx tsc -b && npx vite build && node scripts/inject-sw-version.mjs`を直接実行して成功を確認(その後`npm run dev`実行時には`train`側が修正されており`wasm:build`も正常完了した)。
  - 実機確認(`npm run dev`、Playwrightスクリプトで自動化): オーバーレイ既定OFF→ONで黒の初手4マスに評価インジケータ(すべて`best`分類、損失0)が表示される→オーバーレイのマスを`force`クリック(pointer-events:noneを貫通してCanvas側のクリックが正しく発火することを確認)→着手が通常どおり進行(CPUが応答して対局が続く)→OFFにすると表示が消える→ONにしてリロードすると設定(true)が維持される、をすべて確認。コンソール/ページエラーなし。
  - 本番デプロイ・公開確認: mainにpush(commit `07b154d`)し、GitHub Actions「Deploy to GitHub Pages」(run 29016456964)が`build`→`deploy`とも成功したことを`gh run watch`で確認した。その後Playwright(`chromium`、`npx playwright install chromium`済み)で本番URL(`https://giwarb.github.io/othello-trainer/`)にアクセスし、ローカル確認と同じ手順(既定OFF→ONで黒の初手4マスにオーバーレイ表示(すべて`best`)→オーバーレイ上をforceクリックしてもCanvas側のクリックが正常に発火し着手が進行→OFFで表示が消える→ONにしてリロードすると設定`true`が維持される)をすべて確認した。コンソール/ページエラーなし。

## 受け入れ基準チェック結果

- [x] `npm test`(`app/`配下): 54ファイル・455件全件パス。
- [x] `npm run build`(`app/`配下): 成功(`tsc -b && vite build && inject-sw-version`)。
- [x] 実機確認(`npm run dev` + Playwright自動化): 上記のとおり全項目確認済み。
- [x] mainへpush・GitHub Actionsデプロイ成功・本番公開URLでのPlaywright確認: commit `07b154d`、run 29016456964 成功、本番URLでの動作確認済み。
