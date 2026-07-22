# T190: lazy ordering(TT手先行・残候補の遅延順序付け)+パス経路マスク持ち越し

T188プロファイルで`ordered_moves`が依然として壁時計の47.7%(MPC off)を占めていた問題への対応。TT手が最初の1手でbeta cutoffを起こすノードでは、残候補(平均10.6〜11.0手のうち約2.8手しか実際には探索されない)の構築(`apply_move`+合法手マスク計算)+ソートが完全に無駄だったため、TT手だけを先に構築・探索し、カットオフしなかった場合にのみ残候補を従来と同一順で構築するlazy orderingに置き換えた。あわせてT189レビューの軽微指摘(パス経路の相手側マスク二重計算)を解消した。探索結果(best_move/score/depth/nodes)は完全不変。

## (a) 実装内容

`engine/src/search.rs`:

- **lazy ordering**: `negascout`のTT probe後、`ctx.history`が`None`(=`SearchPolicy::default()`、ノード予算探索以外の本番/固定深さ経路。ノード予算経路は`enable_history: true`が固定でこの条件に該当しない)かつTT手が現ノードで合法な場合だけ、TT手1件分の`OrderedMove`(`apply_move`+次手番の合法手マスク)を先に構築・探索する。この探索でbeta cutoffが起きれば、残候補(`legal`からTT手を除いた集合)の構築(`apply_move`+合法手マスク計算×平均10手弱)・`sort_by_cached_key`を丸ごと省略する。カットオフしなければ、従来と同一キー(corner優先→mobility昇順)で残候補を安定ソートして構築し、2手目以降として処理を継続する。TT手なし/非合法・history有効時(MPC on経路)は従来の一括構築経路をそのまま通る。
  - 候補手1件分の処理(ETC・増分hash・増分state・増分legal・NWS再探索・best更新・beta cutoff時のhistory加算)は、ローカル`macro_rules! process_candidate!`にまとめ、lazy経路(TT手1件)と一括経路(残候補、または通常時の全候補)の両方が同一の本体を通るようにした。マクロの中身自体はT182〜T189から一切変更していない(列の供給方法だけが異なる)。
  - 正当性: 探索順は常に`[tt_move, ソート順の残候補...]`であるため、TT手の探索でカットオフした場合は残候補が一切参照されず、構築を遅延しても探索されるノード列は完全同一。安定ソートの性質上、「tt_moveを除いてから残候補を同一キーでソートする」列は、現行(除かずに先頭へrotateする)実装の2番目以降と完全に一致する。history有効時(MPC on)はorderingキーがhistory値を含み、TT手のサブツリー探索中の更新がキーに混入して順序が変わりうるため、lazy化の対象から除外した(現行の一括構築経路のまま)。
- **パス経路のマスク持ち越し(T189申し送り)**: `legal == 0`分岐で両者パス判定のために計算する`board.legal_moves(side.opposite())`を`opp_legal`変数に保持し、パス再帰(`side.opposite()`への`negascout`呼び出し)の`known_legal`引数へ`Some(opp_legal)`として渡すよう変更(以前は`None`で捨てて子ノード冒頭で再計算していた)。パス経路は`board`が不変で手番だけ反転するため、この値は子ノードの合法手マスクと完全に一致する。

## (b) 絶対条件: 探索結果の完全一致

### 単体テスト(`search::tests`)

新規テレメトリ・テスト専用スイッチ:
- `TEST_LAZY_ORDERING_ACTIVATIONS` / `TEST_LAZY_ORDERING_RESIDUAL_SKIPPED`(T182/T187/T189と同型のスレッドローカルカウンタ)。
- `TEST_FORCE_LEGACY_ORDERING` + `ForceLegacyOrderingGuard`(RAII): テスト実行中だけlazy経路を強制的に無効化し、T189までの一括構築経路を通させるスイッチ。パニック時も`Drop`で確実に元へ戻す。

新規テスト3件:
1. **`lazy_ordering_matches_legacy_full_construction_across_diverse_midgame_searches`** — 8局面×depth<=8(反復深化)で、lazy有効(既定)とレガシー強制(`ForceLegacyOrderingGuard`)の探索結果(best_move/score/depth/nodes)が完全一致することを確認。
2. **`lazy_ordering_activates_and_skips_residual_across_diverse_midgame_searches`** — 同じ8局面でlazy発動回数・残候補構築省略回数のテレメトリが実際に発火する(0件のままpassしない)ことを確認。
3. **`known_legal_carryover_fires_exactly_once_per_forced_single_side_pass`** — 決定的自己対戦(常に最下位ビットの合法手を選択)で見つけた強制片側パス局面から、パス経由の`search()`と直接`search()`の`incremental_legal_checks()`差分が正確に+1になることを確認(パス経路のknown_legal持ち越しの直接証拠)。

**regression-catching実証**: 実装中、残候補の`ordered_moves`呼び出しへ渡すマスクを一時的に`legal & !tm_bit`→`legal`(TT手を除外しない=TT手の重複探索を意図的に混入)に変更し、`lazy_ordering_matches_legacy_full_construction_across_diverse_midgame_searches`を実行したところ、`nodes`不一致(`left: 22224, right: 22098`)で即座に失敗することを確認した。直後に`legal & !tm_bit`へ復元し、`cargo test -p engine --lib`が255 passed(復元前と同数)に戻ったことを確認済み。

`cargo test -p engine`(全ターゲット): **255 passed(既存252 + 新規3件)/ 0 failed / 2 ignored**(lib)、`calibrate_mpc`/`puzzlegen`/`self_play_gen`の既存テストも全件pass。**t182/t184/t185の固定値回帰テスト(score/best_move/depth/nodes)はアサート値を一切変更せずに全パス**(絶対条件を実測で確認)。

### テレメトリ実測(要件: lazy発動ノード数・残候補構築省略ノード数)

`lazy_ordering_activates_and_skips_residual_across_diverse_midgame_searches`(8局面×depth<=8、`pattern_v6.bin`)実行結果:

| 指標 | 実測値 |
|---|---:|
| lazy ordering発動ノード数(TT手先行構築に入った回数) | **17,673** |
| うち残候補構築を丸ごと省略できた回数(TT手だけでcutoff) | **11,926**(発動の約67.5%) |

### 探索結果の完全一致(worktree比較、20局面×MPC off/on×3ラウンド)

`git worktree add`で変更前(T189完了時点のHEAD、`bca08ca`)を`C:/Users/yoshi/work/t190-worktrees/before`に独立チェックアウトし、`eval_cli`(`--features mpc_enabled`)を独立ビルド(現ワークツリーの`target/`とは完全に分離、SHA256が異なることを確認: before=`411db32b...`, after=`a434fa06...`)。

T183〜T189と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`のsplit==test・空き29-36帯、先頭20件、ID `mpc-29-36-test-001..020`)を、before/afterの両バイナリで`eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`(MPC off/on両方)で実行し、局面ごとの`nodes`/`move`/`discDiff`を照合した。

**結果: MPC off・MPC onの全ラウンド・全局面(20局面×2条件×3ラウンド=計120局面回)でnodes/move/discDiffが完全一致(mismatch=0件)**。totalNodesは`mpc_off=59,440,032`・`mpc_on=6,487,461`で、T180から一貫して確立されている値(T185/T187/T188/T189レポートの値と完全一致)。

`cargo test --release -p engine --test ffo_bench -- fast`: `ffo_endgame_fast_positions_solved_correctly_with_timing_and_nps ... ok`(1 passed / 0 failed、59.06s)。終盤ソルバー(`endgame.rs`)は評価関数を一切使わないため無関係だが、念のための回帰として確認した。

## (c) NPS実測(標準手順: worktree独立ビルド+交互3回+専有確認)

手順: `git worktree add`で変更前(`bca08ca`)を独立ディレクトリにチェックアウトして`eval_cli`(`--features mpc_enabled`)を独立ビルド。現ワークツリー(変更後)も同様にビルド。実行直前に`tasklist`でcargo/rustc/eval_cli/pythonが動いていないことを確認(専有状態、mpc off/on計測それぞれの直前に再確認)。20局面バッチを、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after、round1: after→before、round2: before→after)3ラウンド実行し、各ラウンドの合計ノード数÷合計経過msでNPSを算出、3ラウンド平均を採用した。

| 条件 | before(3回平均) | after(3回平均) | 倍率 | ノード数(before/after) |
|---|---:|---:|---:|---:|
| MPC off | 2,051,468 NPS | 2,215,765 NPS | **+8.0%** | 59,440,032 / 59,440,032(完全一致) |
| MPC on | 1,957,015 NPS | 1,968,345 NPS | **+0.6%** | 6,487,461 / 6,487,461(完全一致) |

3ラウンドの内訳(順序を入れ替えても一貫してafterがbeforeを上回る、またはMPC onでは同水準):

- MPC off: before = 1,979,355 / 2,074,696 / 2,100,354 → after = 2,184,251 / 2,154,874 / 2,308,171(NPS)
- MPC on: before = 1,953,466 / 1,953,466 / 1,964,112 → after = 1,961,736 / 1,983,933 / 1,959,366(NPS)

各条件内(before同士・after同士)のラウンド間ばらつきは概ね2〜6%程度に収まっており、MPC offのbefore-after間の差(+8.0%、3ラウンドとも一貫してafterが上回る)はこの計測誤差を明確に超えている。MPC onは事前見込み(「効果ゼロ〜微増」、lazy非適用+パス持ち越しのみ)どおり+0.6%とほぼ横ばいで、悪化していないことを確認した。raw JSONは`bench/edax-compare/t190_lazy_ordering_report.raw.json`に保存(ラウンドごとの内訳・バイナリSHA256・テレメトリ実測込み)。

目的で見込んでいた「MPC offのfill+sort(約25%)のうち、TT手が存在し最初の1手でカットオフするノードの分が丸ごと消える」効果について、T189実測の`orderedMovesPureMachineryAdjustedPctWall`(MPC offで3.93%と、その時点で既に大部分が合法手マスク持ち越しで解消済みだった数字)を踏まえると、本タスクの実測+8.0%は「TT手先行によるノード順序の変化(cutoffのタイミングが早まる副次効果)」と「残構築省略そのもの」の両方を含んだ値と考えられる。テレメトリ実測(発動17,673件中67.5%で残構築を省略)は、狙った最適化が実際に高頻度で機能していることを裏付けている。

## (d) 採用判定

- ノード数完全一致(mpc_off/on両方、120局面回すべてでmismatch=0) + NPS改善が計測誤差を明確に超える(MPC off +8.0%、3ラウンドとも一貫して同方向)+ MPC on非悪化(+0.6%)。要件5の採用条件を満たすため**採用**。

## (e) 総括

- T182(hash増分)・T185(ordered_moves固定長化)・T186(legal引数化)・T187(パターン評価増分化)・T189(合法手マスク持ち越し)に続く「一度計算した値を捨てずに配る」系の最適化に加え、本タスクでは「まだ使うかどうか分からない値の計算自体を遅延する」という異なる種類の最適化(lazy evaluation)を導入した。TT手先行+残候補の遅延構築により、探索結果を完全に保ったままMPC offで+8.0%の追加高速化を達成した。
- 絶対条件(ビット単位不変)は、単体テスト(意図的バグ注入によるregression-catching実証込み)、テレメトリ(lazy発動・残候補省略の実発火確認)、worktree比較による20局面×2条件×3ラウンド=120局面回の完全一致確認、の三重で担保した。
- history有効時(MPC on)はlazy化の正当性が崩れるため対象外としており、実測(+0.6%、非悪化)もこれと整合している。
