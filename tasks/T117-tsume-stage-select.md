---
id: T117
title: 詰めオセロ: ステージクリア型UI+localStorageクリア記録
status: done # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 1
---

# T117: 詰めオセロ: ステージクリア型UI+localStorageクリア記録

## 目的(ユーザー要望 2026-07-17)

> 中盤練習、詰めオセロは問題番号を選んでクリアするようなステージクリア型のUIがいいです。データ保存はlocalStorageで、いつクリアしたとか、失敗したとか、そのあたりの記録を残して、後での機能拡張(復習モードなど)に備えます。最低限、クリア済みのはそうとわかるUIがいいですね。

本タスクは**詰めオセロ側**を実装する(中盤練習側は問題プールの新設が必要なためユーザーの設計判断待ち、別タスク)。

## 前提(explorer調査 2026-07-17)

- 問題プール: `app/public/puzzles.json`(182問、`loadPuzzles()`が1回fetchしキャッシュ、`app/src/tsume/loadPuzzles.ts:21-42`)。各問題は安定ID `Puzzle.id`(`"tsume-N"`形式、**欠番あり・連番ではない**)と`difficulty`(1-5)を持つ(`app/src/tsume/types.ts:56-81`)。
- 現在の出題導線は「難易度別ランダム」「完全ランダム」「デイリー」の3種のみ(`app/src/tsume/PlayMode.tsx:104-116 pickPuzzle`)。番号選択は存在しない。
- 挑戦履歴はIndexedDB `tsumeAttempts`に保存済み(`app/src/tsume/stats.ts`)— これは変更しない。
- localStorageの既存規約: `StorageLike`(getItem/setItem)を介す薄いラッパー、キーは`othello-trainer:xxx`、JSONシリアライズ、壊れた値は既定値フォールバック(参考実装: `app/src/settings/evalBarSettings.ts:11-43`、`app/src/midgame/judgeModeStorage.ts:14-54`)。**この規約を踏襲すること。**

## 要件

1. **ステージ選択画面**: 詰めオセロモードに「ステージ一覧」を追加する。全182問を**配列順の通し番号(1〜182)**でグリッド表示し、各セルに番号・難易度・状態を表示する。状態は3種: 未挑戦 / 挑戦済み未クリア / **クリア済み(一目でわかるマーク・配色)**。タップ/クリックでその問題に挑戦。レスポンシブ必須(モバイルでグリッドが折り返して操作可能なこと)。
2. **既存導線の維持**: 難易度別ランダム・完全ランダム・デイリーの既存モードは残す(ステージ一覧はそれらと並ぶ新しい入口)。
3. **localStorage記録**: 新モジュール(例: `app/src/tsume/stageProgress.ts`)で、`Puzzle.id`をキーに以下を記録する: `firstClearedAt` / `lastClearedAt` / `clearCount` / `failCount` / `lastAttemptAt` / `lastResult('clear'|'fail')`(ISO文字列・数値)。**ステージ経由に限らず、ランダム/デイリー経由の挑戦結果も同じ記録を更新する**(同じ問題IDなので。将来の復習モード拡張に備え、取りこぼさない)。既存規約(StorageLikeラッパー・キー`othello-trainer:tsume-stage-progress`・破損時フォールバック)に従う。
4. **結果画面からの導線**: ステージ経由で挑戦した場合、結果画面に「ステージ一覧へ戻る」(および可能なら「次の問題へ」)を追加する。
5. **ID安定性の注記**: `puzzles.json`は`puzzles:build`で再生成されるとIDの集合が変わりうる。記録は`Puzzle.id`キーで保存し、現存しないIDの記録は無視(エラーにしない)する設計とし、コード内コメントでこのリスクを注記する。
6. **テスト**: stageProgressモジュールの単体テスト(Mapベースの`StorageLike`フェイクで、記録の更新・読み出し・破損値フォールバック・未知IDの無視)。ステージ状態導出ロジック(未挑戦/未クリア/クリア済み)のテスト。既存テスト全件パス維持。

## やらないこと(スコープ外)

- 中盤練習モードのステージ化(問題プール設計のユーザー判断待ち、別タスク)
- IndexedDB(`tsumeAttempts`等)のスキーマ変更
- 復習モード自体の実装(記録スキーマで備えるだけ)
- 既存の出題・判定ロジックの変更

## 受け入れ基準(検証コマンド)

- [ ] `npm test -- --run`(app)全件パス+`npx tsc --noEmit`エラーなし
- [ ] stageProgress単体テスト(更新・読み出し・フォールバック・未知ID無視)がある
- [ ] 変更をmainにpushし、GitHub Actionsのデプロイ成功を確認し、Pages公開URLで: ステージ一覧が表示される→任意の問題をクリアする→一覧に戻るとクリア済みマークが付いている→**ページをリロードしても記録が残っている**、を実際に確認
- [ ] 変更対象ファイルのみパス指定でコミット(`(T117)`)。tasks/とCLAUDE.mdはコミットしない
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが`git status --short`に残っていないこと(bench/edax-compareのgen/verify/test 3ファイル=T114 WIPは対象外・触れないこと)

## 備考

- **T118(終局時の最終盤面表示)が先行して同じ`app/src/tsume/PlayMode.tsx`を変更する。本タスクはT118完了後に着手し、その変更の上に積むこと。**
- **T114(コーパス生成、python 8並列)が稼働中**。生成プロセスと`train/data/teacher/`に一切触れない。

## フィードバック(やり直し時にオーケストレーターが記入)

### 2026-07-17 redo #1(verifier合格 / codex-review不合格: ブロッカー1件)

レポート: tasks/review/T117-tsume-stage-select-codex-review.md

1. **[重大・必須] localStorage記録の喪失レース**: `saveAttempt`が`recordAttempt`/`getAllAttempts`(IndexedDB)をawaitした**後**に`recordStageAttempt`を呼んでいるため、結果画面表示直後のリロード/離脱・IndexedDB遅延で記録が書かれないまま失われる(受け入れ基準「リロードしても記録が残る」を通常操作で破れる)。**修正: 挑戦結果確定時に最初のawaitより前で同期的に`recordStageAttempt`を実行する**(結果画面表示前)。記録の日時も挑戦確定時刻になること。回帰テスト: 「IndexedDB保存が未完了(pending)でもlocalStorage記録が既に書かれている」ことをテストで固定する。
2. **[中・今回対応] 破損値検証の甘さ**: スキーマの意味的制約(カウントが非負整数、lastResultが'clear'|'fail'、日時が文字列等)を満たさない値のフォールバックが不完全(レビュー(b)節)。バリデーションを補強しテスト追加。
3. **[軽微・今回対応] PlayMode.cssに追加した日本語コメントが文字化けしている**。正しいUTF-8で修正(エンコーディング事故。他の追加コメントに同様の問題がないかも確認)。
4. [軽微・対応不要・申し送り] ステージ一覧のUI統合テストは今回必須にしない。

修正後: `npm test`/`tsc`グリーン→パス明示コミット(`(T117)`)→push→Actions成功確認。Pages再確認は変更点(記録タイミング)に絞った軽い確認でよい(全面再走不要)。完了報告に修正内容と回帰テストの説明を含めること。

なし(verifier合格)。

## 作業ログ(担当エージェントが追記)

- 2026-07-17 verifier検証(implementerと独立、コード修正なし)
  - `git show --stat a93abf2`: 変更は`app/src/tsume/PlayMode.css`・`PlayMode.tsx`・
    `stageProgress.test.ts`・`stageProgress.ts`の4ファイルのみ。一致。
  - `npm test -- --run`(app): 66 test files / 541 tests 全件パス。
    `npx tsc --noEmit`(app): エラーなし(出力なし=成功)。
  - `stageProgress.test.ts`(199行)を通読: `loadStageProgress`/`saveStageProgress`
    の往復・壊れたJSON/形不正値のフォールバック、`recordStageAttempt`の
    初回クリア/初回失敗/firstClearedAt保持/clearCount増加/別ID独立性/
    now省略時の現在時刻使用、`stageStatus`の3状態導出+現存しないIDでも
    例外にならないこと、を検証。いずれも本物の`stageProgress.ts`の関数を
    `FakeStorage`(Mapベース)経由で呼び出しており、自己参照(モジュール内で
    定義したものをそのままテストするような自己言及)テストではない。
    要件6の必須ケース(更新・読み出し・破損値フォールバック・未知ID無視)を
    実質的に満たしている。
  - 要件3(取りこぼし確認): `PlayMode.tsx`の`saveAttempt`(261-284行)は
    `finishClear`/`finishFail`から出題経路(`SelectionKind`:
    difficulty/random/daily/stage)を問わず常に呼ばれ、内部で無条件に
    `recordStageAttempt(localStorage, s.puzzle.id, ...)`を呼んでいる
    ことをコード上で確認。ランダム/デイリー経由でもステージ記録が
    更新される実装になっている。
  - GitHub Actions: `gh run list`でコミット`a93abf2`の
    「Deploy to GitHub Pages」(run 29538043552)が`success`であることを確認。
  - Pages実機スポット確認(Playwright、headless chromium、implementerとは
    独立の新規ブラウザセッション、viewport 1280x1400):
    1. 詰めオセロ→「ステージ一覧」で`.tsume-stage-grid__cell`が182件
       表示されることを確認。
    2. `puzzles.json`をfetchし`tsume-72`が45番目であることを確認(implementer
       記録と一致)。初期状態は`--unattempted`/`localStorage`は`null`。
    3. 実装者の作業ログに記載されたPV(`a7,a2,a5,b1,a1,b2`)を自力で
       canvasクリック再現(1280x1400ビューポートでcanvas全体が可視範囲に
       入るよう調整。最初1280x720で試した際は盤面下部がビューポート外に
       出て`page.mouse.click`が空振りする問題があったため修正)し、
       「正解!」の結果画面に到達、PVの正しさも独立に再確認できた。
    4. 「ステージ一覧へ戻る」ボタン(要件4)の存在・押下後、45番セルが
       `--cleared`(title「クリア済み」)に変わることを確認。
    5. `localStorage['othello-trainer:tsume-stage-progress']`に
       `tsume-72`のレコード(`firstClearedAt`/`lastClearedAt`/`clearCount:1`/
       `failCount:0`/`lastAttemptAt`/`lastResult:'clear'`)が要件3の
       スキーマどおり保存されていることを確認。
    6. `page.reload()`後も45番セルが`--cleared`のまま、`localStorage`の
       内容も保持されていることを確認(要件3の永続性)。
    7. 参考として375x812のモバイル幅でもグリッド182件表示・横スクロール
       発生なし(`scrollWidth - innerWidth === 0`)を確認。
    8. 全シナリオでコンソール/ページエラー0件。
  - `git status --short`: T117由来の差分・未追跡ファイルなし。残るのは
    `bench/edax-compare/`配下のT114 WIP 5ファイルのみ(対象外・未変更)。
  - 使用した一時ファイル(scratchpad、コミット対象外):
    `pw/verify_t117_*.mjs`・`pw/check_board.mjs`・`pw/check_json.mjs`・
    `pw/verify_t117_mobile.mjs`(すべてscratchpad配下、リポジトリ非配置)。
  - 判定: 合格。

- 2026-07-17 実装(implementer、T118と同じセッション。T118のPlayMode.tsx変更の上に積んだ)
  - `app/src/tsume/stageProgress.ts`(新規): ステージ挑戦記録モジュール。
    `StorageLike`インターフェース(`app/src/blunder/storage.ts`等と同じ規約)、
    キー`othello-trainer:tsume-stage-progress`、`Puzzle.id`をキーに
    `firstClearedAt`/`lastClearedAt`/`clearCount`/`failCount`/`lastAttemptAt`/
    `lastResult('clear'|'fail')`を記録する`recordStageAttempt`、状態導出
    `stageStatus`(`'unattempted'|'attempted'|'cleared'`、一度クリアすれば
    以後失敗を挟んでも`cleared`のまま)を実装。破損JSON・形不正時は空レコード
    にフォールバック(例外を投げない)。要件5(ID安定性)はコード内コメントで
    注記、実装上は「現存しないIDのレコードは単に参照されない」設計とした
    (能動的な削除・移行処理は行わない)。
  - `app/src/tsume/stageProgress.test.ts`(新規): 15件。読み込み/保存の往復、
    壊れたJSON・形不正値のフォールバック、初回クリア/失敗の記録内容、
    firstClearedAt/lastClearedAtの更新規則、クリア後の失敗でも実績が
    失われないこと、別IDの独立性、`now`省略時の現在時刻使用、
    `stageStatus`の3状態導出、現存しないIDのレコードがあってもエラーに
    ならないことを検証。
  - `app/src/tsume/PlayMode.tsx`:
    - `Phase`に`'stageSelect'`、`SelectionKind`に`'stage'`(+`Selection.stageIndex`)
      を追加。`pickPuzzle`は`kind:'stage'`のとき重み付き抽選を経由せず
      `pool[stageIndex]`をそのまま返す(範囲外なら`RangeError`)。
    - `stageProgress` stateを起動時に`localStorage`から読み込み、
      `saveAttempt`(IndexedDB記録と同じ関数、出題経路を問わず常に呼ばれる)
      内で`recordStageAttempt`も呼んで更新することで、要件3
      (ステージ経由に限らず全経路の結果を記録)を満たした。
    - 設定画面に「ステージ一覧」ボタンを追加(`goToStageSelect`)。
      ステージ一覧画面(`phase==='stageSelect'`)は全問題を`pool`配列順の
      通し番号でグリッド表示し、各セルに番号・難易度・状態(色分け+
      クリア済みは✓マーク)を表示、クリックで`startPractice({kind:'stage',
      stageIndex})`。
    - 結果画面(clear/fail両方)に、`lastSelection?.kind==='stage'`のときのみ
      「ステージ一覧へ戻る」ボタンを追加(要件4)。「次の問題」はステージ経由の
      場合、次の番号のステージへ自動的に進む(最終ステージならステージ一覧へ
      戻る)よう`nextPuzzle`を拡張。
  - `app/src/tsume/PlayMode.css`: `.tsume-stage-select`/`.tsume-stage-grid`
    (`repeat(auto-fill, minmax(3.4rem,1fr))`、375px幅では`minmax(2.8rem,1fr)`に
    縮小)/`.tsume-stage-grid__cell`(未挑戦=`--color-bg-tertiary`系、
    挑戦済み未クリア=固定の薄黄色、クリア済み=固定の薄緑色+✓、既存の
    `.tsume-result--clear`等と同じ「固定背景+固定濃色文字ペア」方針)を追加。

- 検証結果
  - `npm test -- --run`(app): 66 test files / 541 tests 全件パス
    (既存526件+stageProgress新規15件)。
  - `npx tsc --noEmit`(app): エラーなし。
  - コミット: `a93abf2`(`app/src/tsume/PlayMode.css`・`PlayMode.tsx`・
    `stageProgress.ts`・`stageProgress.test.ts`の4ファイルのみ)、
    `git push origin main`済み(`9a57e04..a93abf2`)。
  - GitHub Actions「Deploy to GitHub Pages」(run 29538043552): 成功。
  - Pages公開URL(`https://giwarb.github.io/othello-trainer/`)で
    Playwright(headless chromium、T118のin-app Browser pane Canvas rAF
    停止問題を踏まえて採用)により実機確認:
    1. 詰めオセロ→「ステージ一覧」で182問のグリッド(`.tsume-stage-grid__cell`
       182件)が表示されることを確認。
    2. `puzzles.json`をページ上から`fetch`して`tsume-72`(完全読みPVが
       一意な問題、T118検証時に使った特定手法を流用)のステージ番号(45番)を
       特定し、クリック前は`--unattempted`であることを確認。
    3. 開始後、事前計算済みPV(`a7,a2,a5,b1,a1,b2`、相手番で終局するケース)
       どおりに着手し「正解!」結果画面に到達、「ステージ一覧へ戻る」ボタンの
       存在を確認して押下。
    4. 一覧に戻ると45番セルが`--cleared`(緑背景+✓)に変わっていることを確認
       (スクリーンショット`T117-stage-list-after-clear.png`、scratchpad保存)。
    5. `page.reload()`でページを再読み込みし、詰めオセロ→ステージ一覧を
       開き直しても45番セルが`--cleared`のままであることを確認
       (スクリーンショット`T117-stage-list-after-reload.png`)。`localStorage`の
       生値も直接読み出し、`clearCount:1`等が正しく記録されていることを確認。
    6. モバイル幅(375x812)でステージ一覧を表示し、横スクロールが発生しない
       こと(`document.documentElement.scrollWidth - window.innerWidth === 0`)
       を確認(スクリーンショット`T117-stage-list-mobile-375.png`、7列で
       折り返し表示)。
    7. ブラウザコンソールエラー: 全シナリオで0件。
  - 使用した一時ファイル(scratchpad、リポジトリ非配置、コミット対象外):
    `pw/verify_t117_stage_select.mjs`、`pw/check_mobile.mjs`、
    `T117-stage-list-after-clear.png`・`T117-stage-list-after-reload.png`・
    `T117-stage-list-mobile-375.png`。T118から引き続き使っている
    `pw/`配下の一時npmプロジェクト(`playwright`)も同様にリポジトリ外。
  - `git status --short`: 本タスク由来の差分・未追跡ファイルは残っていない
    (`app/`配下は本タスクの4ファイルのみでコミット・push済み)。T114 WIP
    5ファイル(`bench/edax-compare/`配下)は対象外・未変更のまま。
    `train/data/teacher/`・T114生成プロセスには一切触れていない。

- 2026-07-17 redo #1対応(implementer、codex-review重大指摘1件+中1件+軽微1件)
  - レポート: `tasks/review/T117-tsume-stage-select-codex-review.md`。
  - **[必須] localStorage記録の喪失レース修正**: `app/src/tsume/PlayMode.tsx`
    の`saveAttempt`は`recordAttempt`/`getAllAttempts`(IndexedDB)を`await`
    した**後**に`recordStageAttempt`(`localStorage`書き込み)を呼んでいたため、
    結果画面表示直後のリロード・離脱やIndexedDB遅延で記録が失われるレースが
    あった。修正: 新関数`recordStageProgressNow(s, correct)`を追加し、
    `finishClear`/`finishFail`の**最初のawaitより前**(`setPhase('result')`より
    前)で同期的に呼ぶよう変更(`localStorage.setItem`自体は同期API)。
    `saveAttempt`からは`recordStageAttempt`呼び出しを除去し、IndexedDB記録
    専任に戻した。
    - **回帰テスト**(新規`app/src/tsume/PlayMode.stageProgressTiming.test.tsx`、
      2件): `tsume/stats.ts`の`recordAttempt`を「意図的に解決しない
      `Promise`」に差し替えるモックで、IndexedDB保存が未解決(pending)の
      ままでも`localStorage`にステージ記録(`clearCount`/`failCount`/
      `lastResult`)が既に書き込まれていることを検証(クリア・失敗の両ケース)。
      **本テストが実際に退行を検出できることを、修正前のコード
      (`git stash`で一時的に`PlayMode.tsx`をa93abf2相当に戻して再実行)に
      対して確認済み**: 修正前は`expect(raw).not.toBeNull()`が
      `AssertionError: expected null not to be null`で2件とも失敗し、
      修正を戻すと2件とも合格することを確認した。
  - **[中] 破損値バリデーションの意味的制約を強化**: `app/src/tsume/stageProgress.ts`
    の`isValidEntry`が「型は合っているが意味的に不正な値」(`clearCount: -1`、
    `failCount: 0.5`、`lastAttemptAt: ""`、`firstClearedAt: "not-a-date"`等)を
    有効値として通していた問題を修正。`isNonNegativeInteger`(非負整数)・
    `isValidIsoDateTimeString`(`Date.parse`で解釈可能な非空文字列)の
    2ヘルパーを追加し、回数フィールド・日時フィールドそれぞれに適用。
    `stageProgress.test.ts`にレビュー指摘の具体例(負数・小数・不正日時・
    空文字列・複合ケース)5件のテストを追加(15件→20件)。
  - **[軽微] PlayMode.cssの日本語コメント文字化け指摘**: working tree・
    コミット済みblob(`a93abf2`)の両方をPython経由でバイト単位で検証
    (UTF-8として正常デコード可能、BOM無し、レビュー指摘の文字化けバイト列
    `ã‚¹ãƒ†`は検索してもファイル中に存在しない、CRLF等の行末混在も無し)。
    レビューが引用した行番号(179行目)も実際にはCSSプロパティ行であり
    コメント行ではなかった。**ファイル自体には問題が無いと判断し、
    コード変更は行っていない**(レビューツール側の表示・読み取り時の
    アーティファクトと推定)。
  - 検証結果:
    - `npm test -- --run`(app): 67 test files / 548 tests 全件パス
      (redo前541件+バリデーション5件+タイミング回帰2件)。
    - `npx tsc --noEmit`(app): エラーなし。
    - コミット: `804c463`(`app/src/tsume/PlayMode.tsx`・`stageProgress.ts`・
      `stageProgress.test.ts`・`PlayMode.stageProgressTiming.test.tsx`の
      4ファイルのみ、パス明示add)、`git push origin main`済み
      (`74ca0d4..804c463`)。`PlayMode.css`は変更なし(上記理由)。
    - GitHub Actions「Deploy to GitHub Pages」run 361(commit `804c463`、
      run id 29539342077): `gh run list`がAPI一時障害(HTTP 503、複数回
      リトライしても解消せず)で使えなかったため、ブラウザでActionsページを
      直接確認し「completed successfully」であることを確認。
    - Pages公開URLでの軽量再確認(オーケストレーター指示どおり記録タイミングに
      絞った確認、Playwright headless chromium): `tsume-72`(45番ステージ)を
      クリアし、**結果画面が表示された直後(追加の待機を挟まず)**に
      `localStorage['othello-trainer:tsume-stage-progress']`へ
      `clearCount:1`/`lastResult:'clear'`の記録が既に存在することを確認。
      あわせて`page.reload()`後も記録が残ることも再確認。コンソールエラー0件。
  - `git status --short`: 本タスク由来の差分・未追跡ファイルは残っていない。
    T114 WIP 5ファイル(`bench/edax-compare/`配下)は対象外・未変更のまま。
