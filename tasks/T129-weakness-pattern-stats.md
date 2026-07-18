---
id: T129
title: 中盤練習: 悪手パターンの記録と「苦手パターン」統計表示
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T129: 苦手パターン統計

## 目的

中盤練習の失敗時に表示している明確悪手パターン(T128/T128bの9種、`app/src/midgame/clearBlunder.ts`)は現状**表示のみで保存されていない**(調査確定)。これを記録し、「自分はどのパターンでよく失敗するか」を平易な言葉で見せる。ユーザーの学習方針「1手先の形の良し悪しを言語化できることが強さ」の振り返り面を支える。

## 現状(調査済み)

- 失敗時の検出結果`clearBlunderPatterns`は`PracticeMode.tsx`のローカルstate(`resultInfo`)止まり。
- 既存の記録様式: `app/src/midgame/stageProgress.ts`がlocalStorageキー`othello-trainer:midgame-stage-progress`にStorageLikeパターンで保存(T117教訓: 結果確定時に**awaitより前に同期で書く**)。
- 詰めオセロの先例: 設定画面内の簡易統計(`app/src/tsume/stats.ts`+`PlayMode.tsx:560-570`)。

## 要件

1. **記録**: 中盤練習で失敗画面に至ったとき、検出された全パターンID(表示上限2件でなく検出全件)を`localStorage`(新キー`othello-trainer:midgame-pattern-stats`、stageProgress.tsと同じStorageLike様式)にカウント保存する: `{ [patternId]: { failCount: number, lastAt: string(ISO) } }`。書き込みは結果確定時に同期で(T117教訓)、`sessionGenerationRef`世代ガード通過後のみ。ゲートで合格扱いになった手は記録しない。
2. **表示**: 中盤練習の設定/開始画面に「苦手パターン」セクションを追加(詰めオセロの簡易統計の流儀)。failCount降順で最大5件、**平易な日本語名**(ClearBlunderのメッセージと同じ語彙: 「隅を取られる手」「X打ち」「壁を作る手」「隅の取り逃し」等)+回数を表示。0件時は「まだ記録がありません」等。パターンIDと表示名の対応は`clearBlunder.ts`に単一ソースで定義し、統計側から参照する(二重管理しない)。
3. **リセット**: 統計の「記録をリセット」ボタン(確認つき)を同セクションに置く。
4. レスポンシブ(375px)で崩れないこと。

## やらないこと(スコープ外)

- 復習フィルタ・パターン別出題(T130候補)/ verbalize配下の旧StatsDashboard復活(到達不可コードのまま触らない)/ IndexedDBスキーマ変更(localStorageで完結)/ 詰めオセロ・他モードの変更
- bench/・train/への変更(教師コーパス生成走行中)。`npm run typecheck`禁止(`npx tsc --noEmit -p app/tsconfig.app.json`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] 記録のユニット/コンポーネントテスト: 失敗で全検出パターンが加算・合格扱い時は非加算・リロード後も保持・世代ガード(離脱後は書かれない)
- [ ] 表示のjsdomテスト: 降順上位5件・0件表示・リセット動作
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機で失敗→統計に反映→リロード持続を確認(375px確認込み)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T129)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
