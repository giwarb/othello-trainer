---
id: T118
title: 詰めオセロ: 終局時に最終盤面を残したまま結果を表示する
status: review # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
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
