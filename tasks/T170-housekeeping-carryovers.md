---
id: T170
title: 申し送り消化: node-budgetゲートのv5化+local_tt.clear()回帰テスト
status: todo
assignee: implementer
attempts: 0
---

# T170: 申し送り2件の消化

## 目的

D1採用のユーザー裁定待ちの間に、積み残しの申し送り2件を消化する(いずれも小粒・独立)。

## 要件

1. **[T167レビュー中1] node-budgetビルドゲートのv5化**: `app/scripts/test-node-budget-wasm.mjs` が旧 `pattern_v4.bin` を参照したまま=非本番構成でのゲートになっている。現本番 `pattern_v5.bin` 参照に更新し、期待値(ノード数等のgolden)が変わる場合は再取得して更新(変更理由を作業ログに)。`npm run build` が通ること。
2. **[T145申し送り] local_tt.clear() 回帰テスト**: `engine/src` の `search_all_moves_with_eval` 内の `local_tt.clear()` を誤って削除しても既存テストが検知できない(検知力ゼロ、T145で確認済み)。設計案(T145作業ログ参照): トランスポジションが実際に起きる局面選定+TT容量縮小での衝突誘発により、clear()削除で結果が変わるテストを追加する。**受け入れの核心: clear()を一時的に削除するとテストが失敗し、戻すと合格することの実証(regression-catching、T117/T163方式)を作業ログに記録**。

## スコープ外

- D1候補の本番配線(ユーザー裁定後の別タスク)
- 探索・評価のロジック変更(テスト追加とスクリプト参照先変更のみ)

## 受け入れ基準

1. `npm run build`(app)成功、`cargo test -p engine` 全パス(新規テスト込み)
2. regression-catching実証の記録が作業ログにある
3. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## 作業ログ

(ワーカーが節目ごとに追記)
