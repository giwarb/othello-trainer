---
id: T117
title: 詰めオセロ: ステージクリア型UI+localStorageクリア記録
status: todo # todo | in_progress | review | redo | done | blocked
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
