---
id: T117
title: 詰めオセロ: ステージクリア型UI+localStorageクリア記録
status: review # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
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

## 作業ログ(担当エージェントが追記)

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
