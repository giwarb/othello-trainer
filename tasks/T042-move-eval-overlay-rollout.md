---
id: T042
title: 盤面セル評価オーバーレイを残り4モード(定石練習・中盤練習・詰めオセロ・棋譜解析)へ展開
status: todo
assignee: implementer
attempts: 0
---

# T042: 盤面セル評価オーバーレイを残り4モード(定石練習・中盤練習・詰めオセロ・棋譜解析)へ展開

## 目的

T039で対局モードに実装した「盤面セル評価オーバーレイ」(候補手マスに評価インジケータをプラス/マイナスで表示、ON/OFF切替可能)を、ユーザー要望通り残り4モード(定石練習・中盤練習・詰めオセロ・棋譜解析)にも展開する。

## 背景・コンテキスト(このリポジトリを知らない前提で読めるように)

- T039で以下の共通部品を実装済み(**これらのファイルは変更せず、そのまま再利用すること**):
  - `app/src/components/MoveEvalOverlay.tsx` / `MoveEvalOverlay.css` — 候補手評価オーバーレイ本体(8x8 CSS Grid、`pointer-events:none`)。Props: `{ allMoves: MoveEvalJson[] | null, mover: 'black' | 'white', thresholds: ClassifyThresholds, visible: boolean }`(実際のシグネチャは`app/src/components/MoveEvalOverlay.tsx`を直接確認すること)。
  - `app/src/components/moveEvalOverlayLogic.ts` — 分類→色マッピングの純粋関数(`computeCellEvals`/`formatLoss`)。
  - `app/src/settings/moveEvalOverlaySettings.ts` — オーバーレイ表示ON/OFF設定(`localStorage`キー`othello-trainer:moveEvalOverlay`、既定`false`)。**全モード共通の設定なので、この1つのトグルがどのモードでもON/OFFを共有する**(モードごとに別々の設定は持たせない)。
- 対局モードでの統合パターン(`app/src/app.tsx`、コミット`07b154d`・`8b6d442`)を**参考実装として必ず確認してから**、各モードに同じパターンを適用すること: (1) 人間の手番になったタイミングを検知する`useEffect`で、オーバーレイ設定がONなら`requestAnalyzeAll(board, sideToMove, limit)`(`app/src/engine/client.ts`)を呼び候補手評価を取得、CPU/相手番のときは`null`にリセット。(2) `<Board .../>`を`.board-with-move-eval-overlay`のようなラッパーで囲み、直後に`<MoveEvalOverlay .../>`を重ねる。(3) `othello-trainer:analysisClassifyThresholds`(`app/src/analysis/thresholdSettings.ts`)から`thresholds`を読み込む(T039で対局モードもこの共有設定を使う実装になっている)。(4) オーバーレイON/OFFのチェックボックスUIを追加(`moveEvalOverlaySettings.ts`で永続化、既に対局モードにあるものと同じ文言・実装でよい)。
- 対象4モードのファイルと、既存の「着手後」候補手評価呼び出し箇所(参考。今回追加するのは「着手前」の呼び出し):
  - 定石練習: `app/src/joseki/PracticeMode.tsx`(`lookupJosekiNode`で定石内候補手取得済み、`requestAnalyzeAll`呼び出しは261行目付近)。人間の手番検知は既存の状態遷移ロジック(SRS・DAG進行)を確認して使うこと。
  - 中盤練習: `app/src/midgame/PracticeMode.tsx`(`requestAnalyzeAll`呼び出しは210・309・400行目付近)。388行目付近に二重クリック防止ガードの実装例があるので、オーバーレイの二重リクエスト防止にも同様の配慮をすること。
  - 詰めオセロ: `app/src/tsume/PlayMode.tsx`(`requestAnalyzeAll`呼び出しは293・332行目付近)。詰めオセロは完全読み判定なので、オーバーレイをONにすると事実上正解手が見えてしまうが、これはユーザーが明示的にトグルをONにした場合のみなので許容する(ユーザー承認済み、「全モード(対局含む)に入れ、デフォルト非ON」)。
  - 棋譜解析: `app/src/analysis/BlunderPanel.tsx`(T030「フリー分岐探索」機能で、盤面をクリックして代替手を試せるインタラクティブなBoardが存在するはず)。棋譜のリプレイ専用の非インタラクティブな盤面表示箇所には適用不要で、**実際に人間がクリックして手を進められる箇所にのみ**適用すること。

## 変更対象

- `app/src/joseki/PracticeMode.tsx` — 盤面評価オーバーレイの統合(人間の手番時のみ)。
- `app/src/midgame/PracticeMode.tsx` — 同上。
- `app/src/tsume/PlayMode.tsx` — 同上(出題中の手番)。
- `app/src/analysis/BlunderPanel.tsx` — フリー分岐探索のインタラクティブ盤面部分にのみ統合。

## 要件

1. 4モードすべてで、オーバーレイ設定ON時に人間の手番(または詰めオセロの出題中、棋譜解析のフリー分岐探索中)になった時点で候補手マスに評価インジケータが表示されること。
2. オーバーレイ設定OFF(デフォルト)のときは、4モードいずれも既存の挙動・見た目から一切変化しないこと。
3. オーバーレイ設定の永続化は`moveEvalOverlaySettings.ts`を再利用し、対局モードで設定したON/OFFが他モードにも引き継がれること(モードをまたいでも同じ設定値が使われること)。
4. 各モードの合法手クリックによる着手・進行が、オーバーレイ表示中も正常に機能すること(`pointer-events:none`を必ず維持)。
5. 二重リクエスト防止(既存の各モードのガードパターンを踏襲)を行い、無駄な`requestAnalyzeAll`の重複呼び出しを避けること。
6. 既存のテストが壊れないこと。

## やらないこと(スコープ外)

- `MoveEvalOverlay.tsx`・`moveEvalOverlayLogic.ts`・`moveEvalOverlaySettings.ts`(T039で実装済みの共通部品)自体の変更は行わない(バグがある場合はフィードバックとして報告し、オーケストレーターの判断を仰ぐこと)。
- 各モード独自の悪手判定閾値設定UIの新設は行わない(既存の棋譜解析モードの設定画面を共有する、T039と同じ方針)。
- 棋譜解析モードのうち、リプレイ専用(過去の着手を一覧・グラフで振り返るだけ)の非インタラクティブな箇所への適用は不要。

## 受け入れ基準(検証コマンド)

- [ ] `npm test`(`app/`配下)が全件パスする。
- [ ] `npm run build`(`app/`配下)が成功する。
- [ ] 実機確認: 定石練習・中盤練習・詰めオセロ・棋譜解析(フリー分岐探索)の4モードそれぞれで、オーバーレイON時に候補手マスへ評価インジケータが表示され、着手・進行が正常に行われることをブラウザ(`npm run dev`)で確認する。対局モードで設定したON/OFFが他モードに引き継がれることも確認する。
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、`playwright`で本番公開URL(`https://giwarb.github.io/othello-trainer/`)上で4モードすべての動作を実機確認する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

- 2026-07-09 implementer: `git show 07b154d`(T039対局モード統合)を参考実装として確認し、同じパターンを4ファイルへ展開した。
  - `app/src/joseki/PracticeMode.tsx`: `state.sideToMove === state.humanSide`(人間の手番)かつ`analyzing`でないときに`ANALYZE_LIMIT`で`requestAnalyzeAll`を呼びオーバーレイ用状態(`overlayMoves`)を更新するeffectを追加。`board-container`に`board-with-move-eval-overlay`を付与し`MoveEvalOverlay`を重ね、`playing`フェーズのstatus直下にトグルチェックボックスを追加。
  - `app/src/midgame/PracticeMode.tsx`: 同様に`session.sideToMove === session.humanSide`かつ`!analyzing`のときに`MIDGAME_ANALYZE_LIMIT`で取得。トグルは`playing`フェーズの評価バー下に追加。
  - `app/src/tsume/PlayMode.tsx`: `session.sideToMove === session.humanSide`かつ`!analyzing`のときに`puzzleAnalyzeLimit(session.puzzle)`(完全読み)で取得。詰めオセロは正解手が見えてしまう点はタスク仕様通り許容(ユーザー承認済み)。トグルは`lastMoveCorrect`表示の下に追加。
  - `app/src/analysis/BlunderPanel.tsx`: スコープ通り「フリー分岐探索」のインタラクティブ盤面(`branchTree`/`handleBranchMove`)のみに適用。`currentMover(branchTree) !== null`かつ`!branchBusy`のときに`ANALYZE_LIMIT`で取得。着手前局面の非インタラクティブなBoard・詰めオセロ即席判定の盤面(`tsumeSession`)は対象外(タスクの「変更対象」記載通り)。
  - いずれも二重リクエスト防止は各モード既存の`analyzing`/`branchBusy`ガードを流用(要件5)。共通部品(`MoveEvalOverlay.tsx`/`moveEvalOverlayLogic.ts`/`moveEvalOverlaySettings.ts`)は無変更。
- 受け入れ基準の実行結果:
  - `npm test`(`app/`): 54ファイル455件全件パス。
  - `npm run build`(`app/`): 成功(`tsc -b && vite build`)。
  - 実機確認(`npm run dev`、Playwright CLIスクリプトで自動操作): 対局モードでオーバーレイをONにした後、定石練習・中盤練習・詰めオセロの3モードでチェックボックスが既にON(共有設定の引き継ぎ確認)、各モードでオーバーレイのマスが表示され(石数はモードごとに4〜17件)、オーバーレイ表示中でも盤面クリックで着手が正常に進行すること(手番表示の変化で確認)を確認した。棋譜解析モードはテキスト解析結果の悪手マーカーから`BlunderPanel`を開き、フリー分岐探索の盤面でオーバーレイが表示されること(エンジンの単一Workerキューが比較PV/評価内訳/モチーフの計算を先に処理するため表示まで数秒かかることを確認)、トグルOFFでオーバーレイDOMが消えること、盤面クリックが正常に機能することを確認した。詰めオセロは完全読みのため空きマス数が多い問題では解析に時間がかかる(既存の仕様通り、着手判定にも同じ探索を使っているため新規の問題ではない)。全ケースでconsole/pageエラーなし。
  - 本番デプロイ確認: `git push origin main`(commit `fbf053a`)。GitHub Actions「Deploy to GitHub Pages」run 29018555348 は初回`build`ジョブが"The job was not acquired by Runner of type hosted even after multiple attempts"というGitHub側の一時的なランナー割り当て失敗で失敗(過去のT039ログ追記コミットでも同種の一過性失敗が発生・自然復旧しており、コード起因ではないと判断)。`gh run rerun 29018555348`で再実行したところ、build(1m28s)・deploy(2m58s)ともに成功(`gh run view 29018555348`で確認)。
    その後、Playwright(`chromium.launch()`、ヘッドレス、`app/`の`node_modules/playwright`を利用した使い捨てスクリプトで自動操作、確認後に削除)で本番URL(`https://giwarb.github.io/othello-trainer/`)に対し以下を確認した:
    - 対局モードでオーバーレイをONにすると盤面に評価インジケータ(4マス)が表示される。
    - 定石練習(黒番開始): トグルが共有設定によりON継承済み・オーバーレイ4マス表示・盤面クリックで着手が進行(手番が黒→白に変化)。
    - 中盤練習(開始): トグルON継承・オーバーレイ6〜10マス表示・盤面クリックで着手が進行(判定中表示に変化)。
    - 詰めオセロ(難易度1、空きマス数が少なく完全読みが速く終わる問題を選択): トグルON継承・オーバーレイ2〜5マス表示・盤面クリックで着手が進行(手番が変化)。
    - 棋譜解析: 盤面で10手手動入力→解析開始→悪手マーカー(5件検出)から`BlunderPanel`を開き、フリー分岐探索の盤面でトグルON継承・オーバーレイ4マス表示を確認。エンジンの単一Workerキューが比較PV/評価内訳/モチーフ計算を先に処理するため表示までに数秒かかる点はローカル確認時と同様。さらに、盤面が長いページの下方にあり既定のPlaywrightビューポート(720px)からはみ出していたため`scrollIntoViewIfNeeded()`を使わない初回試行ではクリックが空振りする事象があったが、これはテストスクリプト側の問題(ビューポート外座標へのクリック)であり、アプリの`pointer-events:none`実装自体の不具合ではないことを`scrollIntoViewIfNeeded()`追加後の再試行で確認した(修正後、盤面クリックで手番が黒→白に変化することを確認)。
    - 全ケースでconsole/pageエラーなし。
  - 以上により、受け入れ基準4項目すべて満たしたと判断。
