---
id: T189
title: 高速化(8): 合法手マスクの親子持ち越し+スカラー特徴での再利用
status: todo
assignee: implementer
attempts: 0
---

# T189: 高速化(8): 合法手マスクの親子持ち越し+スカラー特徴での再利用

## 目的

T188プロファイル(`bench/edax-compare/t188_profiling_report.md`)で判明した「同一の(盤面, 手番)に対する合法手マスクの親子間二重計算」を排除する。親の `ordered_moves` はorderingキーのために全候補手について `next_board.legal_moves(side.opposite())` を計算済み(sort_legal_moves、MPC off 16.5%)なのに、子ノードの `negascout` 冒頭で同じマスクを再計算し(legal_moves_top、5.0%)、さらに葉のスカラー特徴 `exact_mobility_advantage` でも手番側の合法手を三たび計算している(score_scalar_features 8.7%の一部)。T185のnext_board持ち越し・T186の重複排除と同型の「計算済みの値を配るだけ」の変更であり、**探索結果はビット単位で完全不変**。期待効果はNPS +7〜8%程度(legal_moves_top 5.0%とスカラー内の手番側モビリティ約3.2%の解消)。

## 背景・コンテキスト

- `engine/src/search.rs` の `ordered_moves`(2296行付近〜)は候補手ごとに `OrderedMove { mv, next_board }` を構築し、orderingキー(`sort_by_cached_key`)の中で `m.next_board.legal_moves(side.opposite())` を計算している。この値は popcount されてキーになるだけで、**マスク自体は捨てられている**。
- 子ノードの `negascout` 冒頭(1789行付近)は `board.legal_moves(side)` を計算する(パス判定+T186でordered_movesへ渡す用)。親から見ると `next_board == 子board`、`side.opposite() == 子side` なので**全く同じ値**。
- 葉評価のスカラー特徴(`engine/src/pattern_eval.rs` の `scalar_features` / `exact_mobility_advantage`)は mover側とopponent側の合法手を `legal_moves_relative` でフル計算している。mover側は negascout 冒頭の `legal` と同一値。
- MPCプローブ(`mpc_try_cutoff`)は同一(board, side)に対する再帰なので、そのノードで既知の `legal` をそのまま渡せる(T187のstateと同じ構図)。
- パス経路の再帰は盤面同一・手番反転なので親の `legal` は使えない(相手側マスクは未計算)。パス側は従来どおり再計算でよい(pass_hash実測~0%、パス自体が稀)。

## 変更対象

- `engine/src/search.rs` —
  1. `OrderedMove` に `legal: u64`(next_boardにおける次手番の合法手マスク)を追加し、orderingキー計算で得たマスクを保持する(popcountだけ取って捨てない)。`sort_by_cached_key` のキー計算構造を変えずにマスクを保存する実装に注意(キー計算関数の呼び出し回数・比較順序を変えない。T185の固定長配列構築時に一緒に格納するのが素直)。
  2. `negascout` の子ノード再帰呼び出しへ `known_legal: Option<u64>` を渡す(T182のknown_hash・T187のknown_stateと同型の配線)。子側冒頭は `known_legal` があれば `board.legal_moves(side)` をスキップ。debug_assertions時はフル計算との一致を `debug_assert_eq!` で照合(T187の前例に倣う)。
  3. `mpc_try_cutoff`/`mpc_try_cutoff_inner` にも同ノードの `legal` を渡す。パス経路は `None` を渡す(従来どおり再計算)。
  4. 葉評価: `static_eval_with_state` 経由で `legal`(mover側マスク)を `score_with_state` のスカラー特徴計算へ渡す。
- `engine/src/pattern_eval.rs` — `scalar_features`(または score_with_state 内スカラー部)に「mover側合法手マスクの既知値」を受け取る経路を追加。**popcountの取り方・f32への変換・加算順は現行と完全同一にする**(値はマスクが同一なので自動的に一致する)。既存の公開 `score()` は無変更(フル計算のまま)。

## 要件

1. 探索結果(best_move/score/depth/ノード数)がMPC on/off両方でビット単位不変。
2. orderingの順序・キー定義は一切変えない(マスクを「捨てずに保存する」だけ)。
3. debug_assertions時の照合(known_legal == フル再計算)をパス以外の全受け渡し経路に入れる。
4. プロパティテストまたは既存回帰テストで担保:
   - 既存の固定値テスト(t182/t184/t185)がアサート値無改変でパス。
   - 新規テスト: ランダム局面群での探索で debug照合が実際に発火することを確認するテスト(T187の `incremental_state_check_fires_across_diverse_midgame_searches` がテンプレート)。
5. NPS計測(検証の恒常的教訓に従う): worktree独立ビルド(変更前=直前mainコミット vs 変更後)+交互実行(A,B/B,A)×各3回+マシン専有、T183/T187/T188と同じ20局面バッチ、MPC off/on両方、ノード数完全一致確認込み。レポート `bench/edax-compare/t189_legal_carryover_report.md` + raw JSON。
6. 採用条件: ノード数完全一致 + NPS改善が計測誤差を明確に超えること。

## やらないこと(スコープ外)

- orderingキーの変更・遅延ordering(TT move先行のlazy化は次タスクT190で検討)
- opponent側モビリティや空隣接特徴の増分化・軽量化(本タスクは「既知値の再利用」のみ)
- `endgame.rs`・学習側・重み形式の変更
- `ANALYSIS_ENGINE_VERSION` のインクリメント(探索結果完全不変のため不要)
- `tasks/` 配下・`CLAUDE.md` のコミット(作業ログ追記のみ)

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p engine` 全件パス(protocol.rsの既知フレーキーは単独再実行で切り分け)。
- [ ] t182/t184/t185 固定値テストが無改変でパス。
- [ ] 新規テスト(要件4)がパスし、known_legalの受け渡しに意図的なバグ(例: 別マスクを渡す)を入れると失敗することを確認済み(regression-catching実証、確認後は元に戻す)。
- [ ] NPS計測の結果、ノード数完全一致かつNPS改善。レポート+raw JSONをコミット。
- [ ] `cargo test --release -p engine --test ffo_bench` のfast問題が全問正解。
- [ ] 変更を main に push し、GitHub Actions のデプロイ成功を確認し、GitHub Pages 公開URLで対局が動作することを確認する(`gh run watch` でデプロイ完了を待つ)。
- [ ] コミットは変更対象ファイルのみをパス明示で add(`git add .` 禁止)。タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
