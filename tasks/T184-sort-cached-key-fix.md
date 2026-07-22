---
id: T184
title: 高速化(3): ordered_movesのsort_by_key→sort_by_cached_key修正(T183優先1位)
status: todo
assignee: implementer
attempts: 0
---

# T184: sort_by_cached_key修正

## 目的

T183の発見: `engine/src/search.rs` の `ordered_moves` 内3箇所の `Vec::sort_by_key` が、高コストなキー計算(`apply_move`+`legal_moves`)を比較のたびに再計算しており(要素あたり65.5〜78.5回)、探索時間の70〜75%を占めている。`sort_by_cached_key`(要素ごと1回)への置換で **MPC off最大-56%(約2.3倍)・on最大-32.6%(約1.5倍)** の実測上限。リスク低(両者とも安定ソートのため順序・探索結果は不変のはず)。

## 要件

1. `ordered_moves`の3箇所を`sort_by_cached_key`へ置換(または同等の「キーを1回だけ計算して並べ替える」実装。実装が単純で速い方。キー型・タイブレークは完全に現状維持)。
2. **絶対条件: 探索結果(score・best_move・depth・nodes)が修正前後で完全一致**(安定ソート同士なので理論上一致するはず。T182と同じ前後比較テスト+T180の20局面バッチでの全探索一致確認)。
3. **NPS実測は標準手順で**(恒常教訓): worktree独立ビルド(修正前)+現HEAD(修正後)、交互3回、MPC off/on、専有確認。平均±レンジで報告。
4. FFO fast不変(endgame.rsは無関係のはずだが回帰確認)。`cargo test -p engine`全パス。
5. 期待効果が大きいため、達成したNPSで**対Edax倍率の更新値**(T180の57-69倍からどこまで縮んだか)も算出して記載。
6. ANALYSIS_ENGINE_VERSION繰り上げ不要の見込み(評価値・探索結果不変)。崩れたら報告。
7. 完了時 `git status --short` クリーン(パス明示コミット。`tasks/`とCLAUDE.mdはコミットしない)

## スコープ外

- T183優先2位以降(固定長配列化・next_board持ち越し・増分評価)— 本修正の実測を見てから
- WASM再ビルド・本番配線(次のデプロイに自然に乗る)

## コミット規律

- 計測は専有・標準手順。ターンを終えて通知待ち禁止(ツール内ループ)。作業ログ節目追記

## 作業ログ

(ワーカーが節目ごとに追記)
