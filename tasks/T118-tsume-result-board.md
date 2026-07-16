---
id: T118
title: 詰めオセロ: 終局時に最終盤面を残したまま結果を表示する
status: review # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 1
---

# T118: 詰めオセロ: 終局時に最終盤面を残したまま結果を表示する

## 目的(ユーザー要望 2026-07-17)

> 詰めオセロは、相手の番で終わったときに、結果がめっちゃわかりにくいです。相手が打ち終わってから、その盤面を残したまま、結果を出すようにしてほしいです。

## 原因(explorer調査済み、2026-07-17)

`app/src/tsume/PlayMode.tsx`:
1. `ClearResultInfo`(61-64行)に`board`フィールドが無く、クリア結果セクションのJSX(552-568行)に`<Board>`が描画されない(失敗結果セクション578-580行には`<Board>`がある非対称構造)。
2. 相手の手番で終局する経路(296-320行のuseEffect内)で、相手の最終手を適用した`nextSession`を`setSession`せずに`finishClear(nextSession)`へ直行しており、画面上の盤面(React state `session.board`)が最終手未反映のまま結果表示に遷移する。同パターンは人間側の最終手クリア(374-407行の`handlePlayerMove`内)にもある。

## 要件

1. クリア・失敗いずれの結果表示でも、**終局時の最終盤面(相手の最終手・人間の最終手を含む)を表示したまま**結果を出す。最終手のハイライト(`lastMove`)も表示する。
2. 修正方針(調査レポートの3点セットを基本とし、実装者の判断で同等以上の設計にしてよい): `ClearResultInfo`に最終盤面(+lastMove)を持たせる / `finishClear`前に`setSession`で最終盤面を反映する / クリア結果セクションに`<Board>`を追加する。相手番終局・人間番終局の両経路で効くこと。
3. 結果の文言・スコア表示等の既存要素は維持する(盤面の追加が主目的)。レスポンシブ崩れがないこと。
4. テスト: 終局時の結果情報に最終盤面が含まれること(相手番終局・人間番終局の両ケース)をテストで固定する。純粋ロジックとして切り出せるならその単体テスト、必要ならT115で導入済みのjsdomコンポーネントテスト(`app/src/app.playmode.test.tsx`の流儀)を使う。

## やらないこと(スコープ外)

- ステージクリア型UI(T117で実施)
- 出題ロジック・判定ロジックの変更
- 中盤練習モードへの変更

## 受け入れ基準(検証コマンド)

- [ ] `npm test -- --run`(app)全件パス+`npx tsc --noEmit`エラーなし
- [ ] 相手番終局・人間番終局の両ケースで最終盤面が結果表示に含まれることのテストがある
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、Pages公開URLの詰めオセロで「相手の応手で終局する問題」を実際に解き、相手の最終手が置かれた盤面が表示されたまま結果が出ることを確認
- [ ] 変更対象ファイルのみパス指定でコミット(`(T118)`)。tasks/とCLAUDE.mdはコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが`git status --short`に残っていないこと(bench/edax-compareのgen/verify/test 3ファイル=T114 WIPは対象外・触れないこと)

## 備考

- **T114(コーパス生成、python 8並列)が稼働中**。生成プロセスと`train/data/teacher/`に一切触れない。wall time系の計測はしない。
- 直後にT117(ステージクリア型UI)が同じ`app/src/tsume/`を触るため、本タスクの変更は小さく焦点を絞ること。

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 codex-review判定: 不合格(コード修正不要、検証の追完のみ)

codex-reviewの所見: **実装・テストに問題なし**(両終局経路の回帰テストも適切)。不合格理由は受け入れ基準の「Pages公開URLで**相手の応手で終局する問題**を実際に解き、相手の最終手が置かれた盤面が表示されたまま結果が出ることを確認」が未実施であること(実施したのは人間番終局の問題+Canvasピクセル未確認)。**この確認を完了すればコード変更なしで合格**(レポート: tasks/review/T118-tsume-result-board-codex-review.md)。

追完指示:
1. **相手(エンジン)の応手で終局する問題**を特定する(puzzles.jsonをローカルでオセロロジックにかけて「正解手順の最終着手が相手側になる問題」を探すのが確実。パスが絡まなければ空き数が偶数の問題が候補)。
2. Pages公開URL上でその問題を実際に解き、**相手の最終手が置かれた盤面が表示されたまま結果が出る**ことを確認する。前回の in-app Browser paneはバックグラウンドタブ扱いでCanvasのrAF描画が止まる制約があったため、**Playwright(headless chromium、T115検証で実績あり: npx playwright+自前スクリプト)を使うこと**。スクリーンショット(最終手適用後の結果画面)をscratchpadに保存し、盤面領域が最終局面を描画していることを確認・作業ログに記録する。
3. コードは変更しない。確認できたら作業ログに証跡(問題ID・手順・スクリーンショットの要約)を追記して完了報告。

## 作業ログ(担当エージェントが追記)

- 2026-07-17 実装(implementer)
  - `app/src/tsume/PlayMode.tsx`
    - `ClearResultInfo`に`board`(最終盤面)・`sideToMove`・`lastMove`を追加。
    - `finishClear(s: Session)`が、着手適用済みの`s`(呼び出し元は相手番終局・
      人間番終局いずれの経路でも`nextSession`を渡している)からそのまま
      `board`/`sideToMove`/`lastMove`を`resultInfo`に詰めるよう修正
      (調査レポートの案「`finishClear`前に`setSession`する」は採用せず、
      `ClearResultInfo`自体に最終盤面を持たせることで同等の効果を得た。
      `session.board`を経由しない分、不要な中間レンダーが増えない利点がある)。
    - クリア結果セクション(`.tsume-result--clear`)に`<Board>`を追加
      (失敗結果セクションと同じ`board-container tsume-result__board`ラッパー、
      `onMove`は渡さずクリック不可)。
  - `app/src/tsume/PlayMode.test.tsx`(新規): jsdomコンポーネントテスト。
    実際の`game/othello.ts`ロジック(`createBoard`等、モックしない)で
    「黒(人間)の着手で終局する盤面」「白(相手)の着手で終局する盤面」を
    それぞれ構成し、`Board`コンポーネントをスタブ化してpropsを捕捉、結果画面
    (`.tsume-result--clear`)に渡される`board`/`lastMove`が最終手適用後の
    値であることを検証する2ケースを追加。`getSharedEngineClient`
    (`requestAnalyzeAll`)・`loadPuzzles`をモックし、IndexedDB(`tsume/stats.ts`)
    は`fake-indexeddb/auto`で実コードパスのまま動作させた。

- 検証結果
  - `npm test -- --run`(app): 65 test files / 526 tests 全件パス。
  - `npx tsc --noEmit`(app): エラーなし。
  - コミット: `ee5f0ed`(`app/src/tsume/PlayMode.tsx`・`app/src/tsume/PlayMode.test.tsx`のみ)、
    `git push origin main`済み(`ad713b6..ee5f0ed`)。
  - GitHub Actions「Deploy to GitHub Pages」(run 29535570149): 成功
    (`gh run watch`で確認、`build`/`deploy`ジョブとも成功)。
  - Pages公開URL(`https://giwarb.github.io/othello-trainer/`)で実際に確認:
    詰めオセロ・難易度1の問題を「候補手評価を表示」オーバーレイのヒントを
    見ながら最後まで(d2→a1→a6→a3→a2)正解を打ち続け、黒(人間)の最終手で
    終局する「正解!」結果画面に到達。`.tsume-result__board canvas`が
    存在すること(=結果画面に`<Board>`が実際に描画されていること)をDOM上で
    確認した(修正前は`.tsume-result--clear`セクションに`<Board>`が
    一切無かったため、この要素自体が存在しなかったはずの箇所)。コンソール
    エラーなし。
    - 補足: このブラウザ自動化環境ではCanvasの`requestAnimationFrame`
      描画がバックグラウンドタブ扱いで進まないらしく(get_page_text/DOM上の
      状態(候補手評価オーバーレイの値・「✓ 正解」表示・結果画面遷移)は
      逐次正しく更新される一方、Canvasのピクセル内容が古いフレームのまま
      なる事象を観測した)、ピクセル単位で最終局面の石配置を目視確認する
      ことはできなかった。石配置レベルの厳密な正しさは上記jsdomテスト
      (bigint盤面の完全一致アサーション)で担保しており、Pages確認では
      「結果画面に`<Board>`(canvas)が実際に描画される」という構造面の
      デプロイ確認に留めた。「相手(エンジン)の着手で終局する」経路は
      同一実装で人間番終局と分岐しない共通コード(`finishClear`)を通るため、
      jsdomテストの2ケース(人間番終局・相手番終局)で個別に固定済み。
  - `git status --short`: `app/`配下は本タスクの2ファイルのみでクリーン
    (T114 WIP 3ファイルは対象外・未変更のまま)。一時ファイル
    (`.claude/launch.json`等)は作成していない。

- 2026-07-17 追完(implementer、redo #1: 「相手の応手で終局する問題」のPages実機確認)
  - **コードは変更していない**(codex-review所見どおり実装・テストは合格済み)。
    前回の確認が不足していた「相手(エンジン)の応手で終局する問題」を実際に
    解く検証のみを追完した。
  - 手順1(問題の特定): `app/public/puzzles.json`(182問)をローカルで
    完全読みnegamax+alpha-beta(scratchpad一時スクリプト、リポジトリ非配置)
    にかけ、「人間側は毎手最善手、相手側は毎手『最も粘る手』(=相手自身の
    最終石差を最大化する手、`PlayMode.tsx`の実装と同一規則)」を両者が
    貫いた場合の完全読み主変化(PV)を全問について算出。空きマス数の少ない
    問題(≦12)に絞って「PVの最終着手が相手(エンジン)側になる」問題を
    47件検出し、うち各手番で最善手が一意(タイなし、実エンジンの手順選択との
    ズレリスクが無い)なもの8件を安全な検証候補として選定
    (`tsume-72`/`tsume-135`/`tsume-270`/`tsume-17`/`tsume-26`/`tsume-215`/
    `tsume-269`/`tsume-187`)。難易度1に該当候補が6件あるため、「難易度1」で
    ランダム出題を繰り返し、表示される「◯番、最善で±N」「空きMマス」の
    組み合わせ(フィンガープリント)が候補と一致するまで再抽選する方式を採用。
  - 手順2(Pages実機確認): 前回はin-app Browser paneを使ったが、
    Canvasの`requestAnimationFrame`描画がバックグラウンドタブ扱いで
    停止する制約が判明したため、**Playwright(headless chromium、
    `npx`経由でscratchpad一時プロジェクトにインストール)**に切り替えた。
    - `https://giwarb.github.io/othello-trainer/` → 詰めオセロ → 難易度1で
      再抽選を繰り返し、2回目の試行で`tsume-215`(白番、空き7、最善+22、
      PV: `H:a3,O:g6,H:d1,H:f2,H:h2,H:h6,O:h7`、最終着手`O:h7`=相手番)に一致。
    - PVどおりに`a3,g6,d1,f2,h2,h6,h7`を順にクリック(各着手後、相手の
      着手演出`OPPONENT_MOVE_DELAY_MS`込みで900ms待機、途中で
      `.tsume-result--fail`が出ないこと=PVが実エンジンの判定とズレていない
      ことを毎手確認)。
    - 最終手(`h7`、相手側)適用後、`.tsume-result--clear`(「正解! 最善を
      維持したまま解ききりました(目標: +22、勝ち)。」)に到達。
    - `.tsume-result__board canvas`が存在し(結果画面に`<Board>`が実際に
      描画されている)、そのcanvasをピクセルサンプリングした結果
      `{"black":21,"white":43,"empty":0}`(空きマス0=盤面が完全に埋まった
      最終局面と一致、`finalEmpties:0`の事前計算と符合)。
    - スクリーンショット(`T118-opponent-end-result-tsume-215.png`、
      scratchpad保存)を目視確認: 結果画面の盤面に黒21・白43の石が最後まで
      正しく描画されており、**相手の最終着手`h7`のマスに`lastMove`ハイライト
      (赤丸マーカー)が表示されている**ことを確認。修正前は
      `.tsume-result--clear`セクションに`<Board>`自体が存在しなかった箇所。
    - ブラウザコンソールエラー: 0件。
  - 使用した一時ファイル(scratchpad、リポジトリ非配置、コミット対象外):
    `find_opponent_end_puzzle.mjs`(問題特定スクリプト)、
    `opponent_end_candidates.txt`(候補一覧の出力)、
    `pw/verify_t118_opponent_end.mjs`(Playwright検証スクリプト)、
    `pw/`配下の一時npmプロジェクト(`npm install playwright`)、
    `T118-opponent-end-result-tsume-215.png`(結果画面スクリーンショット)。
    いずれもリポジトリ外(セッションのscratchpadディレクトリ)に保存しており、
    `git status --short`への影響なし。
  - 受け入れ基準3点目(「Pages公開URLの詰めオセロで『相手の応手で終局する
    問題』を実際に解き、相手の最終手が置かれた盤面が表示されたまま結果が
    出ることを確認」)を上記手順で満たしたと判断する。
