---
id: T189
title: 高速化(8): 合法手マスクの親子持ち越し+スカラー特徴での再利用
status: done
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

- 2026-07-22 実装完了(1st pass): `engine/src/search.rs`
  - `OrderedMove`に`legal: u64`(next_board側の合法手マスク)を追加。`ordered_moves`の列挙ループで1回だけ計算して格納し、3箇所の`sort_by_cached_key`クロージャは`m.legal.count_ones()`を読むだけに変更(呼び出し回数・比較順序は不変、計算場所をループ側に移しただけ)。
  - `negascout`に`known_legal: Option<u64>`引数を追加。冒頭で`known_legal`があれば`board.legal_moves(side)`のフル再計算をスキップし、`Some`のときは`debug_assert_eq!`でフル再計算と照合(T189テレメトリ`record_incremental_legal_check`)。パス経路の再帰呼び出しは`None`固定(相手側マスク未知のため)。
  - 候補手ループで`child_legal = om.legal`を取り出し、`negascout_or_etc`の3箇所の呼び出し(初手・NWS・窓外れ再探索)へ渡す。`negascout_or_etc`に`next_legal: u64`引数を追加し、`negascout`へ`Some(next_legal)`として転送。
  - `mpc_try_cutoff`/`mpc_try_cutoff_inner`に`legal: u64`引数を追加し、2箇所のプローブ(`negascout`呼び出し)へ`Some(legal)`として渡す。
  - `depth == 0`の葉評価で`static_eval_with_state`へ`legal`を渡すよう変更(引数`known_legal: u64`追加)。
  - 新規テレメトリ: `TEST_INCREMENTAL_LEGAL_CHECKS`カウンタ+`record_incremental_legal_check`/`reset_incremental_legal_checks`/`incremental_legal_checks`(T182/T187と同型)。
  - 新規テスト`incremental_legal_check_fires_across_diverse_midgame_searches`(T187のテンプレート踏襲、重み無しで実行=ヒューリスティックフォールバック経路でも発火することを確認)。
  - 既存の`mpc_try_cutoff`直接呼び出しテスト4件・root呼び出し3箇所に`None`/`legal`引数を追加して更新。
- 2026-07-22 実装完了(1st pass): `engine/src/pattern_eval.rs`
  - `scalar_features_with_known_mover_legal(board, mover, known_mover_legal)`を追加(mover側は既知値、opponent側・空隣接特徴はフル計算のまま、内部で`debug_assert_eq!`照合)。
  - `PatternWeights::score_with_state_with_known_legal(&self, state, board, mover, known_mover_legal)`を追加。パターン項の計算は`score_with_state`と完全同一、スカラー特徴だけ上記の増分版を使う。既存の`score`/`score_with_state`は無変更。
  - 既存プロパティテスト`incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`に、`score_with_state_with_known_legal(&state, &board, side, board.legal_moves(side))`が`score(&board, side)`とビット一致することを確認する`assert_eq!`を追加(既存2件のassertは無改変)。
- 2026-07-22 `cargo build -p engine`成功。`cargo test -p engine`(lib)252 passed / 0 failed / 2 ignored(既存のignore済みテストのみ、変更前と同数)。t182/t184/t185固定値テスト・T187プロパティテスト・新規T189テスト全てpass。
- 2026-07-22 regression-catching実証: `let child_legal = om.legal;`を一時的に`om.legal ^ 1`に改変し`cargo test -p engine --lib search::tests::incremental_legal_check_fires_across_diverse_midgame_searches`を実行 → `T189 incremental legal-mask mismatch`のdebug_assertでpanicして即座に失敗することを確認。直後に元の`om.legal`へ復元し、`cargo test -p engine`(lib)252 passed / 0 failedへ回復したことを確認済み。
- 2026-07-22 `cargo test --release -p engine --test ffo_bench -- fast`(fast問題)実行 → `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps ... ok`(1 passed / 0 failed、60.51s)。全問正解を確認。
- 2026-07-22 NPS計測(worktree独立ビルド+交互3回+専有確認)
  - `git worktree add ../othello-trainer-t189-before 948b7a4`で変更前(T188完了時点HEAD)を独立ディレクトリにチェックアウトし、`cargo build --release --bin eval_cli --features mpc_enabled`で独立ビルド。現ワークツリー(変更後)も同様にビルド(`eval_cli.exe`のsha256が異なることを確認、同一ファイルサイズだが別ビルド)。
  - 実行直前(mpc off計測前・mpc on計測前それぞれ)に`tasklist`でcargo/rustc/eval_cli/python等が動いていないことを確認(専有状態)。
  - T183〜T188と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`のsplit=='test'・29<=empties<=36、先頭20件、ID`mpc-29-36-test-001..020`)を`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin [--enable-mpc]`で、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after / round1: after→before / round2: before→after)3ラウンド×MPC off/on実行。
  - 結果: ノード数完全一致(mpc_off=59,440,032/59,440,032、mpc_on=6,487,461/6,487,461)、move/depth/nodes/discDiffの40探索全一致(mismatch=0)。NPS: mpc_off before平均1,728,004→after平均1,943,089(**+12.4%**)、mpc_on before平均1,678,761→after平均1,821,964(**+8.5%**)。3ラウンドとも一貫してafterがbeforeを上回った(詳細はレポート参照)。
  - worktreeは計測後`git worktree remove --force ../othello-trainer-t189-before`で削除済み(`git worktree list`でメインワークツリーのみ残存を確認)。
  - レポート`bench/edax-compare/t189_legal_carryover_report.md`+raw JSON`bench/edax-compare/t189_legal_carryover_report.raw.json`を作成。
- 2026-07-22 コミット・デプロイ: `git add engine/src/search.rs engine/src/pattern_eval.rs bench/edax-compare/t189_legal_carryover_report.md bench/edax-compare/t189_legal_carryover_report.raw.json`(パス明示、`git add .`不使用)→コミット`f31f066`→`git push`(`948b7a4..f31f066 main -> main`)。
  - `gh run watch`で「Deploy to GitHub Pages」(29902050253)・「Rust Tests」(29902050124)両方の成功を確認(build/deploy両ジョブ✓、`cargo test -p engine`(debug)・`cargo test -p engine --release --test ffo_bench`(FFO fast)・`cargo test -p train`すべて✓)。
  - GitHub Pages公開URL(`https://giwarb.github.io/othello-trainer/`)をブラウザで開き、「対局」モードで黒番開始→d3(合法手)をクリック→石数2/2→3/3・定石表示「虎(他76)(2手目)」・CPU(白)の応手後に評価値付き候補手リストが表示されることを確認(WASMエンジン〈本タスクの変更を含む〉が実機で正しく動作)。
  - 最終`git status --short`は`tasks/T189-legal-mask-carryover.md`(本作業ログ、オーケストレーター担当分)のみで、コード側の差分・未追跡ファイルは残っていないことを確認済み。
- 完了。コミットハッシュ`f31f066`。NPS実測: MPC off +12.4%(1,728,004→1,943,089)、MPC on +8.5%(1,678,761→1,821,964)。ノード数完全一致(mpc_off=59,440,032、mpc_on=6,487,461、いずれもbefore/after一致・mismatch=0)。

## 検証ログ(verifier、2026-07-22)

対象コミット f31f066(push済み、リポジトリ `C:\Users\yoshi\work\othello-trainer`)を独立に検証した。結果: **合格**。

1. `cargo test -p engine` — 全件パス(252 passed / 0 failed / 2 ignored、debug、約51s)。protocol.rs系18件も単独再実行(`-- protocol::`)で全パス、フレーキーな失敗は再現しなかった。新規テスト`search::tests::incremental_legal_check_fires_across_diverse_midgame_searches`を単独実行(`--exact`)しても存在・パスを確認。
2. `git show f31f066 -- engine/src/search.rs` / `-- engine/src/pattern_eval.rs` の全文diffを読解。
   - t182/t184/t185の固定値テスト本体・アサート値は無変更(diffに現れるのは`mpc_try_cutoff`直接呼び出しテスト3件への`legal`引数追加のみで、`assert_eq!`の期待値・比較対象は変更なし)。
   - T187プロパティテスト(`pattern_eval.rs`の自己対戦ラウンドトリップ)は既存2箇所の`assert_eq!`(state版・opposite mover版)が無改変で残存し、新規に`score_with_state_with_known_legal`用の`assert_eq!`が1件追加されているのみ。
   - orderingキー: 3箇所の`sort_by_cached_key`クロージャで`m.next_board.legal_moves(side.opposite()).count_ones()` → `m.legal.count_ones()`に変更。`m.legal`は`ordered_moves`の列挙ループで`next_board.legal_moves(side.opposite())`として計算した値そのもの(同一計算式)であり、タプル`(is_corner, opp_mobility[, hist])`の構成・順序・型は3箇所とも無変更。ordering意味論の変更なしと判定。
3. regression-catching追試を自分の手で実施: `engine/src/search.rs`の`let child_legal = om.legal;`を`om.legal ^ 1;`へ一時改変し、`cargo test -p engine --lib -- search::tests::incremental_legal_check_fires_across_diverse_midgame_searches --exact`を実行 → `T189 incremental legal-mask mismatch`のdebug_assertでFAILすることを確認(`left: 1, right: 0`)。直後に元の`om.legal;`へ復元し、同テストが再びPASSすることを確認。`git status --short`で復元完了(差分ゼロ)を確認済み。
4. `bench/edax-compare/t189_legal_carryover_report.raw.json`を読解。mpc_off/mpc_on とも `mismatches: 0`(20/20チェック済み)。NPS: mpc_off before平均(1747619.43+1738978.73+1697413.67)/3≈1,728,004、after平均(1926056.58+1924186.07+1979025.54)/3≈1,943,089(+12.4%)。mpc_on before平均(1686807.33+1689003.12+1660471.21)/3≈1,678,761、after平均(1787671.81+1839370.85+1838849.49)/3≈1,821,964(+8.5%)。いずれもレポート記載値と再計算結果が一致し、報告値はrawから導出可能と確認。
5. `cargo test --release -p engine --test ffo_bench -- fast` — `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps ... ok`(1 passed / 0 failed、59.73s)。全問正解。
6. `git status --short`・`git worktree list` — verifier作業前後ともにクリーン(コード側の差分・未追跡ファイルなし、ベンチworktree残骸なし。メインワークツリーのみ)。なお検証中、オーケストレーターによる別コミット`bc1f39d`(タスクファイルをreview状態へ更新)が並行して行われ、HEADがf31f066→bc1f39dへ進んだ(コード側の内容に影響なし、確認済み)。
7. GitHub Actions: `gh run list`/`gh run view`でコミットf31f066に対応する「Rust Tests」(29902050124、3m40s)・「Deploy to GitHub Pages」(29902050253、1m24s)双方が`success`であることを確認。

結論: 受け入れ基準1〜8すべて再現確認でき、実装者の完了報告(ノード完全一致・NPS改善・regression-catching・CI成功)と一致した。矛盾・懸念事項は見つからなかった。
