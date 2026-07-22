# T189: 合法手マスクの親子持ち越し+スカラー特徴での再利用

T188プロファイル(`bench/edax-compare/t188_profiling_report.md`)で判明した「同一の(盤面, 手番)に対する合法手マスクの親子間二重計算」を排除する高速化タスク。親の`ordered_moves`がソートキー計算のために計算済みの`next_board.legal_moves(side.opposite())`を捨てずに保持し、子ノードの`negascout`冒頭・MPCプローブ・葉のスカラー特徴(mover側モビリティ)で再利用する。探索結果(best_move/score/depth/ノード数)がビット単位で完全不変であることが絶対条件。

## (a) 実装内容

`engine/src/search.rs`:
- `OrderedMove`に`legal: u64`(`next_board`における次手番の合法手マスク)を追加。`ordered_moves`の候補手列挙ループ(`while remaining != 0`)で`next_board.legal_moves(side.opposite())`を1回だけ計算して格納する。3箇所の`sort_by_cached_key`クロージャ(history無し/構成A/構成B)は`m.next_board.legal_moves(side.opposite()).count_ones()`の直接呼び出しをやめ、格納済みの`m.legal.count_ones()`を読むだけに変更した。`sort_by_cached_key`は要素ごとに1回だけキーを計算する仕様のため、計算する場所をループ側に移しても呼び出し回数(候補手1件につき1回)・比較順序(キーの値は完全に同一)は一切変わらない。
- `negascout`に`known_legal: Option<u64>`引数を追加。冒頭の`let legal = ...`で、`known_legal`が`Some`ならフル再計算(`board.legal_moves(side)`)をスキップしてそのまま使い、`debug_assert_eq!`でフル再計算との一致を照合する(T182の`known_hash`・T187の`known_state`と同型の配線)。パス経路(自分だけ合法手がない場合の相手番再帰)は、相手側の合法手マスクを親が持っていないため常に`None`を渡す(要件どおり従来の再計算のまま)。
- 候補手ループで`child_legal = om.legal`を取り出し、最大3回(初手・NWS・窓外れ再探索)の`negascout_or_etc`呼び出しへ渡す(T182のhash増分・T187の状態増分と同じ「1手につき1回計算・複数回使い回す」構図)。`negascout_or_etc`に`next_legal: u64`引数を追加し、`negascout`へ`Some(next_legal)`として転送する。`om.legal`自体は独自の差分導出ロジックを持たない(`ordered_moves`内でのフル計算そのもの)ため、このループ内では追加のdebug_assertを行わず、値の正しさは`negascout`冒頭の`known_legal`受信側で一元的に検証する。
- `mpc_try_cutoff`/`mpc_try_cutoff_inner`に`legal: u64`引数を追加し、同一`(board, side)`への2つのプローブ(`negascout`呼び出し)へ`Some(legal)`として渡す。
- 葉ノード(`depth==0`)の`static_eval_with_state`呼び出しに`legal`(mover側=`side`の合法手マスク、直前のパス判定を通過済みなので必ず非0)を渡すよう変更。`static_eval_with_state`に`legal: u64`引数を追加し、`PatternWeights::score_with_state_with_known_legal`(新設)へそのまま転送する。

`engine/src/pattern_eval.rs`:
- `scalar_features_with_known_mover_legal(board, mover, known_mover_legal)`を追加。`scalar_features`と同一の`own`/`opp`割り当て(`Board::legal_moves`の内部実装`legal_moves_relative(own, opp, empty)`と一致)を使い、mover側の合法手だけ既知値を使う。opponent側の合法手・空隣接特徴のフル計算・加算式・加算順は`scalar_features`と完全同一。内部で`debug_assert_eq!(known_mover_legal, legal_moves_relative(own, opp, empty), ...)`を実行する。
- `PatternWeights::score_with_state_with_known_legal(&self, state, board, mover, known_mover_legal)`を追加。パターン項の計算(`idx_black`/`idx_white`経由)は`score_with_state`と完全同一で、スカラー特徴だけ上記の増分版を使う。既存の公開`score()`・`score_with_state()`は無変更(フル計算のまま)。

## (b) 絶対条件: 探索結果の完全一致

### 単体テスト

- 新規テレメトリ`TEST_INCREMENTAL_LEGAL_CHECKS`(T182/T187と同型のスレッドローカルカウンタ)+`record_incremental_legal_check`/`reset_incremental_legal_checks`/`incremental_legal_checks`を追加。
- 新規テスト`search::tests::incremental_legal_check_fires_across_diverse_midgame_searches`(T187の`incremental_state_check_fires_across_diverse_midgame_searches`をテンプレート)。反復深化+MPC+ETC+aspiration+historyの全経路を8局面で回し、`known_legal`のdebug照合が200回以上発火することを確認(パターン重みに依存しない経路なので重み無し=ヒューリスティックフォールバックで実行)。
- 既存プロパティテスト`pattern_eval::tests::incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`に、`score_with_state_with_known_legal(&state, &board, side, board.legal_moves(side))`が`score(&board, side)`とビット単位(`to_bits()`)で一致することを確認する`assert_eq!`を追加(既存の2件のassertは無改変)。

**regression-catching実証**: 候補手ループの`let child_legal = om.legal;`を一時的に`om.legal ^ 1`(1ビットだけ意図的に反転)へ改変し、`cargo test -p engine --lib search::tests::incremental_legal_check_fires_across_diverse_midgame_searches`を実行したところ、`assertion left == right failed: T189 incremental legal-mask mismatch`のdebug_assertで即座にpanicして失敗することを確認した。直後に元の`let child_legal = om.legal;`へ復元し、`cargo test -p engine`(lib)が252 passed / 0 failed(復元前と同数)に戻ったことを確認済み。

### 探索結果の完全一致(worktree比較)

`git worktree add`で変更前(T188完了時点のHEAD、`948b7a4`)を独立ディレクトリにチェックアウトし、そこで`eval_cli`(`--features mpc_enabled`)を独立ビルド(現ワークツリーの`target/`とは完全に分離、`eval_cli.exe`のsha256が異なることを確認)。T183〜T188と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`のsplit==test・空き29-36帯、先頭20件、ID`mpc-29-36-test-001..020`)を、変更前・変更後の両バイナリで`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`(MPC off/on両方)で実行した。

**結果: 20局面×MPC off/onの全40探索で、move/depth/nodes/discDiffが完全一致(mismatch=0件)**。totalNodesは`mpc_off=59,440,032`・`mpc_on=6,487,461`で、T180から一貫して確立されている値(T185/T187/T188レポートの値と完全一致)。

`cargo test -p engine --lib`: **252 passed; 0 failed; 2 ignored**(T188完了時点と同数のignore、新規追加した`search::tests::incremental_legal_check_fires_across_diverse_midgame_searches`1件を含めて252)。**t182/t184/t185の固定値回帰テスト(score/best_move/depth/nodes)はアサート値を一切変更せずに全パス**(絶対条件を実測で確認)。

## (c) NPS実測(標準手順: worktree独立ビルド+交互3回+専有確認)

手順: `git worktree add`で変更前(`948b7a4`)を独立ディレクトリにチェックアウトして`eval_cli`(`--features mpc_enabled`)を独立ビルド。現ワークツリー(変更後)も同様にビルド。実行直前に`tasklist`でcargo/rustc/eval_cli/pythonが動いていないことを確認(専有状態、mpc off/on計測それぞれの直前に再確認)。20局面バッチを、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after、round1: after→before、round2: before→after)3ラウンド実行し、各ラウンドの合計ノード数÷合計経過msでNPSを算出、3ラウンド平均を採用した。

| 条件 | before(3回平均) | after(3回平均) | 倍率 | ノード数(before/after) |
|---|---:|---:|---:|---:|
| MPC off | 1,728,004 NPS | 1,943,089 NPS | **+12.4%** | 59,440,032 / 59,440,032(完全一致) |
| MPC on | 1,678,761 NPS | 1,821,964 NPS | **+8.5%** | 6,487,461 / 6,487,461(完全一致) |

3ラウンドとも(順序を入れ替えても)一貫してafterがbeforeを上回っており、系統誤差の兆候はない:
- MPC off: before = 1,747,619 / 1,738,979 / 1,697,414 → after = 1,926,057 / 1,924,186 / 1,979,026(NPS)
- MPC on: before = 1,686,807 / 1,689,003 / 1,660,471 → after = 1,787,672 / 1,839,371 / 1,838,849(NPS)

各条件内(before同士・after同士)のラウンド間ばらつきは概ね2〜3%程度に収まっており、before-after間の差(+8.5%〜+12.4%)はこの計測誤差を明確に超えている。raw JSONは`bench/edax-compare/t189_legal_carryover_report.raw.json`に保存(ラウンドごとの内訳・使用局面ID・SHA256込み)。

目的で見込んでいた「NPS +7〜8%程度」(legal_moves_top 5.0%とスカラー内の手番側モビリティ約3.2%の解消)に対し、MPC off実測は+12.4%とやや上回り、MPC on実測は+8.5%とほぼ見込み通りだった。MPC offの方が改善幅が大きいのは、MPC onではhistory heuristicが有効になりソートキーが3要素タプル(corner, mobility, Reverse(history))へ増え、`ordered_moves`全体に占める本タスクの対象部分(合法手マスク計算)の相対比率がMPC offよりわずかに小さくなるため(T188の`orderedMovesPureMachineryAdjustedPctWall`がMPC onで17.43%・MPC offで3.93%という非対称性と整合的)と考えられる。

## (d) FFO fast(不変)

`cargo test --release -p engine --test ffo_bench -- fast`: `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps ... ok`(1 passed / 0 failed、60.51s)。終盤ソルバー(`endgame.rs`)は評価関数を一切使わないため無関係だが、念のための回帰として確認した。

## (e) 採用判定

- ノード数完全一致(mpc_off/on両方、0 mismatch) + NPS改善が計測誤差を明確に超える(+12.4%/+8.5%、3ラウンドとも一貫して同方向)。要件6の採用条件を満たすため**採用**。

## (f) 総括

- T182(hash増分)・T185(ordered_moves固定長化)・T186(legal引数化)・T187(パターン評価増分化)に続き、「一度計算した値を捨てずに配る」系の最適化として、合法手マスクの親子持ち越しを実装した。探索結果を完全に保ったまま8.5〜12.4%の追加高速化を達成した。
- 絶対条件(ビット単位不変)は単体テスト(意図的バグ注入によるregression-catching実証込み)と、worktree比較による20局面×40探索の完全一致確認の二重で担保した。
- T188のプロファイルで次点だった「ordered_movesのモビリティ順序付けコスト削減」(候補b、遅延ordering/TT手先行のlazy化)は本タスクのスコープ外(T190で検討予定)。
