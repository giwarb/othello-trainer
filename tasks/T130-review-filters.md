---
id: T130
title: 詰めオセロ/中盤練習: ステージグリッドの復習フィルタ(未クリア・失敗ありで絞る)
status: todo # T129完了後に着手(PracticeMode.tsxが競合するため直列)
assignee: implementer(Sonnet)
attempts: 0
---

# T130: 復習フィルタ

## 目的

ステージ記録(クリア日時・失敗回数、T117/T119で導入)は「復習モードに備える」意図で保存してきたが、現状グリッドは色分け表示のみで**絞り込み導線がない**(調査確定)。「失敗した問題・まだ解けていない問題だけをやり直す」を1タップにする。

## 要件

1. 詰めオセロ(182問グリッド、`app/src/tsume/PlayMode.tsx:608-648`付近)と中盤練習(111ステージ、`app/src/midgame/PracticeMode.tsx`のグリッド)に共通のフィルタチップを追加: **すべて / 未挑戦 / 失敗あり / 未クリア / クリア済み**。
2. 記録源は既存stageProgress(`othello-trainer:tsume-stage-progress` / `othello-trainer:midgame-stage-progress`)。中盤練習は**現在選択中の判定モードの記録**で判定する(T119の2階層構造)。
3. フィルタ選択は保存する(localStorage、次回起動時も維持)。該当0件時の空表示メッセージ。
4. グリッドの既存の色分け・★表示・クリック挙動は変えない。レスポンシブ維持。

## やらないこと(スコープ外)

- パターン別出題・SRS化・出題順の変更 / stageProgressスキーマ変更
- bench/・train/への変更(生成走行中)。`npm run typecheck`禁止(`npx tsc`直接)。Rust/wasmビルド禁止。一時ファイルはscratchpadへ。

## 受け入れ基準

- [ ] フィルタ each(5種)×両モードの表示件数が記録どおりになるjsdomテスト、選択の永続化テスト、中盤練習の判定モード切替でフィルタ結果が追従するテスト
- [ ] `npx vitest run` 全パス、`npx tsc --noEmit -p app/tsconfig.app.json` エラーなし
- [ ] mainへpush→Actions成功→Pages実機で両モードのフィルタ動作確認(375px込み)
- [ ] 変更対象のみパス明示コミット(`app:`、`(T130)`)。`tasks/`はコミットしない
- [ ] 当該タスク由来の差分・未追跡が`git status --short`に残っていない

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)
