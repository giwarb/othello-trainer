# T188: T187後のRDTSC再プロファイル — 次候補の実測選定

本レポートは、T184(`sort_by_cached_key`)・T185(`ordered_moves`固定長配列化+`next_board`持ち越し)・T186(`legal_moves`重複排除)・T187(パターン評価の増分化)適用後の中盤探索の実コスト内訳を、[T183](t183_profiling_report.md)と同じRDTSC一時計装方式で取り直したものである。実装(高速化そのもの)は行っていない。生データ・手法の詳細は`t188_profiling_report.meta.json`・`t188_profiling_report.raw.json`を参照。

## (a) 実行条件・手法

- git commit(計測ベース): `0a28e99c`(T185/T187適用済みmain)
- パターン重み: `train/weights/pattern_v6.bin`(sha256=`e69f3b1c...`、T183/T187と同一ファイル・変更なし)
- 対象局面: T180/T183/T185/T187と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`の`emptyBucket=='29-36' and split=='test'`の先頭20件、ID`mpc-29-36-test-001..020`)
- 探索条件: `depth=12, exact_from_empties=0`、MPC off(`SearchPolicy::default()`相当)/MPC on(`enable_history/enable_aspiration/enable_mpc`全てtrue)の両方
- 実行環境: AMD Ryzen 7 5800U(16論理コア)、T183と同一マシン。計装ビルド直前・計測直前の2回、専有(競合プロセス無し)を確認
- 総ノード数: MPC off `59,440,032`・MPC on `6,487,461`(**T180以来一貫して確立されている値と完全一致**。T184〜T187の全変更が探索結果=探索木の形を一切変えない「安全な」高速化だったことの追加傍証)
- 壁時計: MPC off `43.012s`・MPC on `5.033s`(T183実測の`124.405s`/`16.816s`から、T184〜T187累積で約2.9倍・約3.3倍高速化。この比較は本タスクの主目的ではないため参考値)

### 手法(T183を踏襲、構造変化に合わせて区間割りを更新)

T183と同じ、`engine/src/search.rs`のホットパスへ**一時的に**RDTSC(`core::arch::x86_64::_rdtsc`)ベースの区間別サイクルカウンタを埋め込み、専用の一時バイナリ(`engine/src/bin/t188_profile.rs`)で20局面バッチをプロセス内(サブプロセス起動なし)でループして計測した。計測後は`git checkout`+一時ファイル削除で完全に復元した(下記(e)参照)。

T183からの構造変化に合わせて計装コードを新規追加した(新設一時モジュール`engine/src/profile188.rs`、16バケット):

| バケット | 計測対象 | T183バケットとの対応 |
|---|---|---|
| `entry_checks` | `negascout`冒頭のノード数加算・timeout/max_nodes/time_msチェック・exact_from_empties判定 | 同一 |
| `legal_moves_top` | `negascout`冒頭の`board.legal_moves(side)` | 同一 |
| `tt_probe` / `tt_store` | 置換表の参照・格納(`negascout`本体) | 同一 |
| `mpc_overhead_self` | `mpc_try_cutoff`/`mpc_try_cutoff_inner`自身の前処理(2回のプローブ再帰呼び出し自体は含めない) | 同一 |
| `ordered_moves_total` | `ordered_moves`呼び出し全体(inclusive) | `ordered_moves_sort_machinery_other`に相当 |
| `ordered_moves_fill_apply_move` | 候補手列挙ループの`board.apply_move`(next_board生成) | `sort_apply_move`に相当だが、T184修正により**要素数分(1回/候補手)まで既に削減済み**(旧: 要素数の65.5〜78.5倍) |
| `ordered_moves_sort_legal_moves` | `sort_by_cached_key`のキー計算内`next_board.legal_moves` | `sort_legal_moves`に相当、同じくT184で要素数分まで削減済み |
| `hash_diff_loop` | 候補手ループの`incremental_move_hash`差分計算 | 同一 |
| `pattern_state_child` | **[新規/T187]** 候補手ループの`PatternState::child`(増分更新) | なし(T187で新設) |
| `pattern_state_from_board_root` | **[新規/T187]** `known_state`が無い場合のフル再計算(ルート等) | なし(T187で新設) |
| `etc_try_cutoff` | ETC本体(呼び出し元での計測) | 同一 |
| `static_eval_leaf_total` | **[更新]** `negascout`葉ノード評価全体(`static_eval_with_state`、増分/フォールバック両経路を含む) | `static_eval`に相当 |
| `score_pattern_lookup` | **[新規/T187]** `score_with_state`内、パターン表引きループ | なし(T187以前は`static_eval`内で未分離) |
| `score_scalar_features` | **[新規]** `score_with_state`内、スカラー特徴(`exact_mobility_advantage`/`empty_adjacency_exposure_advantage`)計算 | なし |
| `pass_hash` | パス経路のhash差分計算 | 同一 |

`ordered_moves_total`と`static_eval_leaf_total`はそれぞれ内訳項目を含む**inclusive**時間であり、T183と同じく「合計から内訳を差し引いた残り」を別掲する(二重計上回避)。

`entry_checks`は、本タスクの計測プロトコル(depth固定・time_ms=None・max_nodes=None)では冒頭3つの早期return(timed_out/max_nodes/time_ms)が実測上一度も発火しない(呼び出し回数が両モードで総ノード数と完全一致することで確認)ため、単一区間として単純化して計測した。

### 計装オーバーヘッドの校正(T183にはなかった追加校正)

T183では「未解明67%」の主因が`sort_by_key`のO(n log n)回キー再計算であり、要素あたりのreal workが計装オーバーヘッドに比べ十分大きかった。T184修正後は候補手1つあたりのreal work自体が小さくなった(1回のみの計算)ため、**計装そのもののオーバーヘッドが無視できない比率を占めるようになった**。これを定量化するため、計測本体の直前に計装と全く同じパターン(`let t0=rdtsc(); <no-op>; add(rdtsc()-t0);`)を5,000万回実行するマイクロベンチマークを追加した。

**結果: 17.272808 ns/call**(1回の計測ペアあたり)。

`ordered_moves_fill_apply_move`(候補手1手あたりの`apply_move`)は両モードとも**16.4〜16.6 ns/call**であり、この校正床(17.3 ns/call)と同水準かそれ以下だった。すなわち**この区間は本方式では実コストと計装ノイズを判別できない**(下記(c)参照)。

## (b) 区間別時間分布(MPC off/on、inclusive/exclusive区別済み)

### MPC off(nodes=59,440,032、wall=43.012s、ns/node=723.6)

| 区間 | 時間 | %wall | 呼び出し回数 | ns/call |
|---|---:|---:|---:|---:|
| **`ordered_moves`合計(inclusive)** | **20.511s** | **47.69%** | 21,618,686 | 948.8 |
| 　├ `fill_apply_move` | 3.771s | 8.77% | 229,879,921 | 16.4 |
| 　├ `sort_legal_moves` | 7.109s | 16.53% | 229,834,072 | 30.9 |
| 　└ pure machinery(raw、要注記) | 9.630s | 22.39% | — | — |
| 　└ pure machinery(**計装税調整後**) | 1.690s | 3.93% | — | — |
| **`static_eval`合計(inclusive)** | **9.028s** | **20.99%** | 37,766,022 | 239.1 |
| 　├ `score_pattern_lookup` | 4.057s | 9.43% | 37,766,022 | 107.4 |
| 　├ `score_scalar_features` | 3.750s | 8.72% | 37,766,022 | 99.3 |
| 　└ wrapper overhead(stage/idx解決・clamp等) | 1.221s | 2.84% | — | — |
| `legal_moves_top` | 2.142s | 4.98% | 59,440,032 | 36.0 |
| `pattern_state_child` | 2.478s | 5.76% | 61,083,332 | 40.6 |
| `etc_try_cutoff` | 1.241s | 2.88% | 61,092,329 | 20.3 |
| `entry_checks` | 0.694s | 1.61% | 59,440,032 | 11.7 |
| `hash_diff_loop` | 0.679s | 1.58% | 61,083,332 | 11.1 |
| `tt_store` | 0.437s | 1.02% | 21,618,686 | 20.2 |
| `tt_probe` | 0.214s | 0.50% | 21,619,873 | 9.9 |
| `pattern_state_from_board_root` | ~0s | 0.00% | 240 | 650.4 |
| `pass_hash` | ~0s | 0.00% | 54,136 | 9.0 |
| `mpc_overhead_self` | 0s | — | 0 | — |
| **非重複合計** | **37.425s** | **87.01%** | | |
| **残差** | **5.587s** | **12.99%** | | 下記(c)参照、大半が計装自体のオーバーヘッドで説明できる |

### MPC on(nodes=6,487,461、wall=5.033s、ns/node=775.7)

| 区間 | 時間 | %wall | 呼び出し回数 | ns/call |
|---|---:|---:|---:|---:|
| **`ordered_moves`合計(inclusive)** | **2.395s** | **47.60%** | 2,295,933 | 1043.3 |
| 　├ `fill_apply_move` | 0.420s | 8.35% | 25,267,393 | 16.6 |
| 　├ `sort_legal_moves` | 0.225s | 4.48% | 25,266,361 | 8.9 |
| 　└ pure machinery(raw、要注記) | 1.750s | 34.77% | — | — |
| 　└ pure machinery(**計装税調整後**) | 0.877s | 17.43% | — | — |
| **`static_eval`合計(inclusive)** | **1.073s** | **21.33%** | 4,153,497 | 258.5 |
| 　├ `score_pattern_lookup` | 0.501s | 9.95% | 4,153,497 | 120.6 |
| 　├ `score_scalar_features` | 0.432s | 8.59% | 4,153,497 | 104.1 |
| 　└ wrapper overhead | 0.140s | 2.79% | — | — |
| `legal_moves_top` | 0.231s | 4.59% | 6,487,461 | 35.6 |
| `pattern_state_child` | 0.282s | 5.60% | 6,707,463 | 42.0 |
| `etc_try_cutoff` | 0.120s | 2.38% | 6,708,797 | 17.9 |
| `entry_checks` | 0.069s | 1.38% | 6,487,461 | 10.7 |
| `hash_diff_loop` | 0.078s | 1.55% | 6,707,463 | 11.6 |
| `mpc_overhead_self` | 0.021s | 0.41% | 2,168,869 | 9.6 |
| `tt_store` | 0.036s | 0.72% | 2,295,933 | 15.8 |
| `tt_probe` | 0.023s | 0.46% | 2,332,277 | 10.0 |
| `pattern_state_from_board_root` | ~0s | 0.01% | 457 | 552.1 |
| `pass_hash` | ~0s | 0.00% | 1,687 | 9.2 |
| **非重複合計** | **4.330s** | **86.03%** | | |
| **残差** | **0.703s** | **13.97%** | | |

## (c) 残差・「pure machinery」の解釈(T183になかった注記)

T183の残差(4.37〜4.68%)に比べ、本タスクの残差(12.99%〜13.97%)は大きい。これは中盤探索の実コスト構造が悪化したのではなく、**本タスクで新設した高頻度バケット(`ordered_moves`のfill/sortループ、候補手1つにつき1回=数億回呼ばれる)による計装自体のブックキーピングコストが、計測対象そのものと同程度の桁になった**ためである。

**残差が計装オーバーヘッドで説明できることの確認**: 各top-levelバケット(候補手ループ内の`fill_apply_move`/`sort_legal_moves`のように`ordered_moves_total`の内側に完全に包含されるものを除く)の呼び出し1回ごとに、`add()`呼び出し自体のブックキーピングコスト(校正値17.27ns/callのうち、2回目のRDTSC読み取り自体は各バケット自身のdelta計算に使われるため、残差に漏れ出すのは主に`add()`関数呼び出し自体のコスト)が、そのバケットの計測終了後・次のバケット計測開始前の「隙間」として残差に計上される。top-levelバケットの呼び出し回数の合計(MPC off: 404,816,700回、MPC on: 46,347,298回)に校正値17.27ns/callを乗じると、MPC off 6.992s(16.26%)・MPC on 0.801s(15.91%)となり、実測残差(5.587s=12.99%、0.703s=13.97%)と**オーダーが一致する**(推定値がやや大きいのは、校正値17.27nsのうち一部〈2回目のRDTSC読み取り自体〉は各バケット自身のdeltaに含まれ残差には漏れ出さないため、残差への寄与は校正値の全部ではなく一部にとどまることと整合する)。

**結論: 本タスクの残差は「未解明の実コスト」ではなく、主にRDTSC計装自体のオーバーヘッドで説明できる。** T183の教訓と同じく「相対的な内訳比率を主たる成果物とし、絶対値は参考値とする」方針を維持しつつ、**特に`ordered_moves_fill_apply_move`(16.4〜16.6ns/call、校正床17.3ns/call以下)と`pure machinery`のraw値(22.39%/34.77%)は、実コストと計装ノイズを本方式では判別できない**ことを明記する。`pure machinery`について、`fill_apply_move`+`sort_legal_moves`の呼び出し回数分の推定計装税を差し引いた「調整後」値(MPC off 3.93%、MPC on 17.43%)を参考として併記した。MPC onの調整後値がMPC offより大きいのは、MPC on時は`ctx.history`が`Some`のため`ordered_moves`のソートキーが3要素タプル(corner, mobility, `Reverse(history)`)になり、`history.get(side, m.mv)`呼び出し(計測対象外、pure machineryに混入)を伴うためと考えられ、測定ノイズだけでは説明できない構造的な差である。

## (d) MPC on特有のコストの分離

- `mpc_overhead_self`(プローブの再帰探索自体を除く自己コスト): 0.021s / 5.033s = 0.41% — T183(0.12%)と同水準、MPC自体の判定オーバーヘッドは引き続きごく僅か。呼び出し回数(2,168,869)はT183の集計方式(1呼び出しにつき1回)と異なり本タスクでは複数区間に細分化して計上しているため単純比較不可だが、コスト自体が小さいという結論は変わらない。
- MPC on時の`ordered_moves`比率(47.60%)はMPC off時(47.69%)とほぼ同水準(T183ではMPC on時の方が明確に高かった〈70.49%→74.66%〉が、これはT183当時の`sort_by_key`バグがMPC onのプローブ部分木でも同様に発現していたため。T184修正後はこの差自体が解消している)。

## (e) 一時変更の完全復元・回帰確認

- 計測用の一時変更は、新設一時モジュール`engine/src/profile188.rs`(新規ファイル)、`engine/src/lib.rs`への`pub mod profile188;`追加、`engine/src/search.rs`(`negascout`/`negascout_or_etc`/`etc_try_cutoff`呼び出し元/`mpc_try_cutoff`/`mpc_try_cutoff_inner`/`ordered_moves`/`static_eval_with_state`への計測呼び出し)、`engine/src/pattern_eval.rs`(`score_with_state`への計測呼び出し)、一時計測バイナリ`engine/src/bin/t188_profile.rs`(新規ファイル)。
- `git checkout -- engine/src/search.rs engine/src/pattern_eval.rs engine/src/lib.rs`で既存ファイルへの変更を復元、`rm engine/src/profile188.rs engine/src/bin/t188_profile.rs`で新規一時ファイルを削除。`git status --short`で`engine/`配下の差分・未追跡ファイルがゼロであることを確認済み。
- 復元後`cargo test -p engine --lib`: **251 passed; 0 failed; 2 ignored**(T187完了時点と同一件数)。
- 復元後`cargo test -p engine --test ffo_bench --release -- --nocapture`: FFO #40〜#44の5問全問正解(`FAST TOTAL: 5 positions solved correctly`)。`negascout`(中盤探索)のみを計装しており`endgame.rs`(終盤完全読み)は本タスクで一切変更していないため影響なしと想定していたが、念のため実測で確認した。

## (f) 改訂版の最適化優先順位リスト(実測に基づく、実装は次タスク)

タスク仕様の5候補((a)スカラー特徴の増分化・軽量化 (b)orderingのモビリティキー計算削減 (c)ソート機構の軽量化 (d)flips_for_moveのテーブル化 (e)TT probe/store改善)を、上記実測に基づき評価する。

| 優先度 | 施策 | 実測根拠 | リスク |
|---|---|---|---|
| **1** | **(a) スカラー特徴(`exact_mobility_advantage`/`empty_adjacency_exposure_advantage`)のコスト削減** | `score_scalar_features`が8.6〜8.7%(両モードで同水準、校正床を大きく上回る有意な信号)。T187で既にインクリメンタル化された`score_pattern_lookup`(9.4〜10.0%)とほぼ同水準のコストを、依然フル再計算(`scalar_features()`、`legal_moves_relative`を2回+`empty_adjacency_incidence`)で払っている | 中〜高。`exact_mobility_advantage`は3進パターン桁のような単純な差分更新ができない可能性が高い(1手で開放/消滅する合法手の変化は着手マス周辺だけに閉じない)。着手前に設計要否の判断が必要(codex-design相談の候補) |
| **2** | **(b) `ordered_moves`のモビリティ順序付けコスト削減** | `sort_legal_moves`がMPC off(統計的に安定な条件)で16.5%。候補手は平均10.6〜11.0手生成されるが実際に探索されるのは平均2.8手程度(beta cutoffで打ち切り)であり、順序付けのためだけに全候補手の相手モビリティをフル計算しているコストが大きい | 中。順序付けの精度は枝刈り効率に直接影響するため、単純な近似化はノード数増加で相殺されうる。実装時はNPSだけでなくノード数の完全一致(近似を許容する場合は悪化幅)を標準手順で検証する必要がある |
| 3(優先度低) | (c) `ordered_moves`の純粋ソート機構のさらなる軽量化 | raw値(22.4%/34.8%)の大部分は(c)節の分析どおり計装自体のオーバーヘッドであり、調整後推定(MPC off 3.9%)は小さい。T185で既に固定長配列化・`next_board`持ち越し済みであり、追加の軽量化余地は限定的 | 低いが投資対効果も低い |
| **候補に値しない** | (d) `flips_for_move`のテーブル化 | 測定値(16.4〜16.6 ns/call)が計装自体のオーバーヘッド床(17.3 ns/call)以下であり、実コストが有意にそれを上回っているという証拠は得られなかった。T183〜T185で呼び出し回数は既に必要最小限(候補手1つにつき1回)まで削減済み。RDTSCによるこれ以上の細分化計測は本方式の限界を超える | — |
| **候補に値しない** | (e) TT probe/store改善 | 0.5〜1.0%(両モード合算)。T183と同じ結論で変化なし | — |

**T183の順位表との関係**: T183優先1(`sort_by_key`→`sort_by_cached_key`)はT184で実装済み。T183優先2・3(固定長配列化・`next_board`持ち越し)はT185で実装済み。T183優先4(据え置き、`static_eval`の増分評価化)はT187で実装済み(パターン項のみ、スカラー特徴は未着手)。本タスクはその**T187が対象にしなかったスカラー特徴**を新たな優先1として繰り上げ、T183で発見された`ordered_moves`の残余コスト(旧バグ修正後に残る、本来必要な順序付けコストそのもの)を優先2として具体化した。

## (g) 総括

- T184〜T187適用後もノード数(MPC off `59,440,032`・MPC on `6,487,461`)はT180以来一貫して不変であり、これまでの高速化シリーズが探索木の形を一切変えない安全な変更だったことを追加確認した。
- `ordered_moves`(47.6〜47.7%)と`static_eval`(21.0〜21.3%)が引き続き中盤探索コストの2大バケットである。ただし内実はT183当時とは異なり、`ordered_moves`は**もはや`sort_by_key`のバグではなく、平均10.6〜11.0手の候補手すべてに対して順序付け用の相手モビリティを計算するという、アルゴリズム的に本質的なコスト**であり、`static_eval`は**T187で既にインクリメンタル化されたパターン項(9.4〜10.0%)と、依然フル再計算のスカラー特徴(8.6〜8.7%)がほぼ均等に分担する**構造になっている。
- 本タスクで新たに判明した最大の知見は、**RDTSCによる区間別計装そのものが、要素あたり数十ns以下の操作(候補手ごとの`apply_move`等)に対しては計測限界(校正床17.3ns/call)に達し、実コストと計装ノイズを判別できなくなる**ことである((c)節)。T183時点では`sort_by_key`バグにより要素あたりの実コストが人為的に極端に大きく、この限界が問題にならなかったが、T184修正後の「正しい」コスト構造ではこの限界が顕在化した。次にさらなる細分化計測が必要になった場合は、RDTSCの限界を踏まえ、サンプリングプロファイラ(T183で検討し保留したVTune/WPA等)または「該当コードを削除/簡略化してNPSを差分測定する」実験的アプローチへの切り替えを検討すべきである。
- 優先順位付けの結論(詳細は(f)節): 優先1はスカラー特徴のコスト削減(T187の対象外だったパターン評価の残り半分)、優先2は`ordered_moves`のモビリティ順序付けコスト削減。優先3(ソート機構の追加軽量化)は投資対効果が低いと判断し据え置き、`flips_for_move`のテーブル化(候補d)とTT probe/store改善(候補e)は実測に基づき候補から外した。
