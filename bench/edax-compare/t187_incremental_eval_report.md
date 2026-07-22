# T187: パターン評価の増分化(incremental pattern evaluation)

`PatternWeights::score`が葉ノードごとに46パターンインスタンス×約9セルをフルスキャンして3進インデックスを再計算していたコスト(T180推定で壁時計の約42%)を、Edax/Egaroucid流の「着手差分だけパターンインデックスを更新する」増分評価に置き換えた高速化タスク。探索結果(best_move/score/depth/ノード数)がビット単位で完全不変であることが絶対条件。

## (a) 実装内容

`engine/src/patterns.rs`:
- `POW3`(3進数の桁重みテーブル)を`pub(crate)`化。
- `swap12(state: u32) -> u32`を追加(raw状態の全桁について1↔2〈黒石↔白石〉を入れ替える)。`pattern_state_index(cells, board, Side::White) == swap12(pattern_state_index(cells, board, Side::Black))`が常に成り立つことをプロパティテストで確認済み(`swap12_of_black_perspective_state_equals_white_perspective_state`)。

`engine/src/pattern_eval.rs`:
- `PatternState`構造体(`raw: [u32; MAX_PATTERN_INSTANCES]`、`MAX_PATTERN_INSTANCES = 64`の固定長配列、Copy)を追加。全パターンインスタンスの黒視点(絶対色、手番非依存)raw 3進状態を1つの配列にまとめて保持する。
  - `PatternState::from_board`: 盤面からフル再計算する(増分計算の起点・debug照合の基準)。
  - `PatternState::child`: 親状態をコピーし、着手マス(空→mover色)とflipsマス(相手色→mover色)の桁だけを差分更新する。
- `PatternWeights`に増分評価用テーブルを追加し、構築時(全6コンストラクタの最終ステップ、`canonical_tables`確定後)に一度だけ計算する:
  - `cell_to_instances[cell]`: そのセルを含む全パターンインスタンスの`(instance_id, pow3_digit)`一覧。
  - `idx_black[class][raw]` / `idx_white[class][raw]`: 黒視点/白視点のraw状態からテーブル添字への写像(`idx_white`は`swap12`を経由するため、パスは状態更新ゼロで手番だけ切り替わる)。
- `PatternWeights::score_with_state`を追加。既存`score`と**完全に同一のf32加算順序**(パターンインスタンスi=0..昇順→スカラー特徴の順)でパターン項・スカラー特徴を合算する。

`engine/src/search.rs`:
- `negascout`/`negascout_or_etc`/`mpc_try_cutoff`/`mpc_try_cutoff_inner`に`known_state`/`state`/`next_state: Option<PatternState>`パラメータを追加し、T182の`known_hash`と同じ構図で配線した(パスは状態不変のまま渡す、子局面ループでは1手につき1回だけ`state.child(...)`を計算しNWS/フルウィンドウ再探索の最大3回で使い回す、MPCプローブは同一局面なので`state`をそのまま渡す)。
- 葉ノード(`depth==0`)は新設の`static_eval_with_state`(`state`があれば`score_with_state`経由、無ければ既存`static_eval`に委譲)を呼ぶ。
- `debug_assertions`時、パス・子局面ループの両方で`PatternState::from_board`によるフル再計算と`debug_assert_eq!`で照合(T182/T105と同型のテレメトリ`TEST_INCREMENTAL_STATE_CHECKS`込み)。
- 適用範囲は`negascout`の葉評価経路のみ厳守: `search_all_moves_with_eval_core_restricted`内の`static_eval`直接呼び出しは無変更。ルート呼び出し(`search_with_eval_inner`・`aspiration_search`・`search_all_moves_with_eval_core_restricted`)は`known_state=None`を渡すのみ(以降`negascout`内部で自動的にフル計算→増分に切り替わる)。

### 設計逸脱: `MAX_PATTERN_INSTANCES`固定長配列(64)

タスク仕様は「PatternState(46インスタンス分のu32配列)」としていたが、`patterns.rs`のテスト・`train`クレートが使う`PatternConfig`は22〜50インスタンスまで複数構成があるため、コンパイル時に46へ固定すると汎用性を失う。代わりに`pub const MAX_PATTERN_INSTANCES: usize = 64`の固定長配列を採用し、実際に使うインスタンス数は`weights.patterns.len()`(現行最大50)に委ねた。`build_incremental_tables`内に`assert!(patterns.len() <= MAX_PATTERN_INSTANCES)`を入れてあるため、将来この上限を超える構成を追加すればテストで即座に気付ける。

## (b) 絶対条件: 探索結果の完全一致

### 単体テスト(プロパティテスト)

`engine/src/pattern_eval.rs::tests::incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`(要件2)を新規追加。実際の学習済み重み(`pattern_v6.bin`、全クラス非ゼロ)を使い、30ゲームのランダム自己対局(パス含む)の全手数で以下を検証:

- (a) `PatternState::child`による増分更新 == `PatternState::from_board`のフル再計算(526手・パス2回以上を確認)。
- (b) `score_with_state(...).to_bits() == score(...).to_bits()`(手番側・相手側両方の視点で、`idx_black`/`idx_white`双方のテーブルを通す)。

**regression-catching実証**: `PatternState::child`の着手マス更新を`next.apply_delta(weights, mv, mover_trit + 1)`(意図的に1ずれたdeltaを注入)に一時改変して実行したところ、上記プロパティテストが即座に`assertion left == right failed: incremental PatternState mismatch at square 19 ...`でFAILすることを確認した。直後に元のコードへ戻し、再実行してPASSに復帰したことも確認済み(詳細手順は`tasks/T187-incremental-pattern-eval.md`の作業ログ参照)。

### 探索結果の完全一致(worktree比較)

`git worktree add`で変更前(T186完了時点のHEAD、`4144c5d`)を独立ディレクトリにチェックアウトし、そこで`eval_cli`(`--features mpc_enabled`)を独立ビルド(現ワークツリーの`target/`とは完全に分離)。T180由来の中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`のsplit==test・空き29-36帯、先頭20件、ID`mpc-29-36-test-001..020`)を、変更前・変更後の両バイナリで`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights pattern_v6.bin`(MPC off/on両方)で実行した。

**結果: 20局面×MPC off/onの全40探索で、move/depth/nodes/discDiffが完全一致(mismatch=0件)**。totalNodesは`mpc_off=59,440,032`・`mpc_on=6,487,461`で、T180から一貫して確立されている値(T185レポートの値と完全一致)。

新規回帰テスト`search::tests::incremental_state_check_fires_across_diverse_midgame_searches`(`engine/src/search.rs`)を追加し、`PatternState`の増分/フル再計算照合(`debug_assert_eq!`)が実際の探索経路(反復深化+MPC+ETC+aspiration+history)で発火することを確認(8局面で200回以上発火)。

`cargo test -p engine --lib`: **251 passed; 0 failed; 2 ignored**(T186完了時点の247 passedから、本タスクで追加した新規テスト4件〈`patterns::tests::swap12_is_an_involution_and_fixes_zero`・`patterns::tests::swap12_of_black_perspective_state_equals_white_perspective_state`・`pattern_eval::tests::incremental_pattern_state_matches_full_recompute_across_random_self_play_including_passes`・`search::tests::incremental_state_check_fires_across_diverse_midgame_searches`〉を加えて251)。**t182/t184/t185の固定値回帰テスト(score/best_move/depth/nodes)はアサート値を一切変更せずに全パス**(絶対条件を実測で確認)。

## (c) NPS実測(標準手順: worktree独立ビルド+交互3回+専有確認)

手順: `git worktree add`で変更前(`4144c5d`)を独立ディレクトリにチェックアウトして`eval_cli`(`--features mpc_enabled`)を独立ビルド。現ワークツリー(変更後)も同様にビルド。実行直前に`tasklist`でcargo/rustc/eval_cli/pythonが動いていないことを確認(専有状態)。20局面バッチを、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after、round1: after→before、round2: before→after)3ラウンド実行し、各ラウンドの合計ノード数÷合計経過msでNPSを算出、3ラウンド平均を採用した。

| 条件 | before(3回平均) | after(3回平均) | 倍率 | ノード数(before/after) |
|---|---:|---:|---:|---:|
| MPC off | 1,292,744 NPS | 1,770,617 NPS | **+37.0%** | 59,440,032 / 59,440,032(完全一致) |
| MPC on | 1,255,323 NPS | 1,734,227 NPS | **+38.1%** | 6,487,461 / 6,487,461(完全一致) |

3ラウンドとも(順序を入れ替えても)一貫してafterがbeforeを上回っており(mpc_off: 1,303,595 / 1,299,293 / 1,275,346 → 1,765,685 / 1,734,412 / 1,811,754、mpc_on: 1,187,962 / 1,293,869 / 1,284,137 → 1,718,078 / 1,743,004 / 1,741,600)、系統誤差の兆候はない。目標(2桁%の短縮)を明確に達成した。raw JSONは`bench/edax-compare/t187_incremental_eval_report.raw.json`に保存(ラウンドごとの内訳・使用局面ID一覧・SHA256込み)。

## (d) FFO fast(不変)

`cargo test -p engine --test ffo_bench --release -- --nocapture`: #40〜#44の5問全問正解(期待値と完全一致、`FAST TOTAL: 5 positions solved correctly`)。終盤ソルバー(`endgame.rs`)は評価関数を一切使わないため無関係だが、念のための回帰として確認した。

## (e) 採用判定

- ノード数完全一致(mpc_off/on両方、0 mismatch) + NPS改善が計測誤差を明確に超える(+37.0%/+38.1%、3ラウンドとも一貫して同方向)。要件5の採用条件を満たすため**採用**。
- パターン項が評価コストの約83%・evalが壁時計の約42%という事前推定(T180)から、増分化による評価コスト削減が壁時計全体の30%台後半の短縮として現れたのは推定と整合する結果。

## (f) 総括

- T185までの探索側最適化(hash増分化・ソート修正・固定長配列化)に続き、評価関数側の最大コストバケットだった`score`のフルスキャンを増分化し、探索結果を完全に保ったまま37〜38%の追加高速化を達成した。
- 絶対条件(ビット単位不変)は単体プロパティテスト(意図的バグ注入によるregression-catching実証込み)と、worktree比較による20局面×40探索の完全一致確認の二重で担保した。
