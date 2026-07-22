# T183: 本格プロファイリング — T180「未解明67%」の解明

本レポートはT180で残った疑問(探索1ノードあたり時間の約67%が既知コンポーネント〈評価・盤面操作・TT・hash〉で説明できない)を、実際のサンプリング/計測プロファイリングで解明した結果をまとめる。実装(最適化そのもの)は行っていない。詳細な手順・生データはmeta(`bench/edax-compare/t183_profiling_report.meta.json`)を参照。

## (a) 実行条件・手法

- git commit(計測ベース): `a76812e`(T182配線済みmain)
- パターン重み: `train/weights/pattern_v6.bin`(sha256=`e69f3b1c33432bafd388af82adde64270ec8c51acaab070bbfff4cf4caf20fc9`)
- 対象局面: T180/T182と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`から`emptyBucket=='29-36' and split=='test'`の先頭20件を抽出したもの、sha256=`a52cdc9487275cadf75a8f6b1867ebc80a355a80a52243948e93ce19d373f2cc`)
- 探索条件: `depth=12, exact_from_empties=0`、MPC off(`SearchPolicy::default()`相当)/MPC on(`enable_history/enable_aspiration/enable_mpc`全てtrue、`eval_cli best --enable-mpc`と同じポリシー)の両方
- 実行環境: AMD Ryzen 7 5800U(16論理コア)、専有実行(他の重い並行プロセスが無いことを`Get-Process`で確認済み)

### 手法選定(外部ツール不使用)

候補として Intel VTune・AMD uProf・Windows Performance Recorder(ETW)+WPA・`cargo flamegraph`を検討した。本機には`wpr.exe`(ETW記録)は標準搭載されているが、解析用の`wpa.exe`(Windows Performance Analyzer)は未導入で、シンボル解決込みの解析には追加取得が必要になる。`cargo flamegraph`も未導入。**いずれも新規インストールが必要になるため、承認を待つより先に、インストール不要な代替手段で十分な精度が得られるか検証した。**

採用した手法: `engine/src/search.rs`の`negascout`ホットパスに**一時的に**RDTSC(`core::arch::x86_64::_rdtsc`)ベースの区間別サイクルカウンタを直接埋め込み、T180と同じ20局面バッチをプロセス内(サブプロセス起動なし)でループする専用の一時バイナリ(`engine/src/bin/t183_profile.rs`)を作成して計測した。計測後は**`git checkout -- engine/src/search.rs`と一時バイナリの削除で完全に復元し、diffゼロを確認済み**(下記(e)参照)。この手法を選んだ理由:

1. 外部ツールのインストール承認待ちが不要(タスクの時間的制約と両立)。
2. 非再帰区間(TT probe/store・`ordered_moves`・`apply_move`・hash差分計算・`static_eval`・ETC・MPC自身のオーバーヘッド)だけを狙って計測できるため、サンプリングプロファイラより**関数の呼び出し回数まで正確に**分かる(後述の最重要発見はこの「呼び出し回数」の異常な多さから見つかった)。
3. RDTSCは1回あたり数ns程度と軽量(`std::time::Instant`のQueryPerformanceCounter経由より大幅に安い)。計測オーバーヘッド自体は残るため、**絶対値(ns/node)はこの計測に限り数%程度増加している可能性がある。相対的な内訳比率(%)を主たる成果物とする**。
4. RDTSCとホスト時刻(`std::time::Instant`)を500ms間隔で相関させて校正(`ns_per_cycle`)した。今回の実測では`ns_per_cycle=0.527319`(≒1.896GHz)で、Ryzen 7 5800Uの定格ベースクロック(1.9GHz)とほぼ一致しており、invariant TSCがベースクロックに固定されていることを裏付ける。

### 計測区間(バケット)一覧

| バケット | 計測対象 |
|---|---|
| `entry_checks` | `negascout`冒頭のノード数加算・timeout/max_nodes/time_msチェック・exact_from_empties判定 |
| `legal_moves_top` | `negascout`冒頭の`board.legal_moves(side)` |
| `tt_probe` / `tt_store` | 置換表の参照・格納 |
| `mpc_overhead_self` | `mpc_try_cutoff`/`mpc_try_cutoff_inner`**自身**の前処理(校正値ルックアップ・番兵判定・フラグ切替)。2回の`negascout`プローブ再帰呼び出し自体の時間は**含めない**(その時間はプローブが辿る各ノード自身の各バケットへ通常通り計上されるため、二重計上回避) |
| `ordered_moves_sort_machinery_other` | `ordered_moves`呼び出し全体(**内訳の他バケットを含む合計**、下記参照) |
| `ordered_moves_redundant_legal_moves` | `ordered_moves`冒頭の`board.legal_moves(side)`(`negascout`が既に計算済みの値と同一) |
| `ordered_moves_sort_apply_move` / `ordered_moves_sort_legal_moves` | ソートキー計算クロージャ内の`board.apply_move`と`next_board.legal_moves`(オポネントモビリティ算出) |
| `apply_move_loop` | `negascout`の候補手ループ自身の`board.apply_move`(実際の子局面生成用、`ordered_moves`内のものとは別呼び出し) |
| `hash_diff_loop` | 候補手ループの`incremental_move_hash`差分計算(T182配線後) |
| `etc_try_cutoff` | ETC(Enhanced Transposition Cutoff)本体(非再帰、TT参照1回) |
| `static_eval` | 葉ノード評価(`PatternWeights::score`) |
| `pass_hash` | パス経路のhash差分計算 |

`ordered_moves_sort_machinery_other`は`ordered_moves`関数全体の所要時間(内部で計上される`redundant_legal_moves`/`sort_apply_move`/`sort_legal_moves`も含む)なので、以下の集計では**「`ordered_moves`合計」から内訳3項目を差し引いた残り**を「純粋なソート機構(Vec確保・enumerate・Timsort系アルゴリズム本体・tt_move昇格)」として別掲する(二重計上を避けるため)。

## (b) 関数/区間レベルの時間分布(全項目、inclusive/exclusive区別済み)

### MPC off(nodes=59,440,032、wall=124.405s、ns/node=2093)

| 区間 | 時間 | %wall | 呼び出し回数 | 備考 |
|---|---:|---:|---:|---|
| **`ordered_moves`合計(inclusive)** | **87.693s** | **70.49%** | 21,618,686 | 下記3項目を含む |
| 　├ `sort_apply_move` | 31.129s | 25.02% | 1,417,009,316 | ordered_moves呼び出し1回あたり平均**65.5回** |
| 　├ `sort_legal_moves` | 39.943s | 32.11% | 1,417,009,316 | 同上 |
| 　├ `redundant_legal_moves` | 0.187s | 0.15% | 21,618,686 | 1回あたり1回(想定通り) |
| 　└ 純粋ソート機構(残り) | 16.433s | 13.21% | — | Vec確保・ビット列挙・Timsort本体・tt_move昇格 |
| `static_eval` | 24.128s | 19.39% | 37,766,022 | 638.9 ns/call |
| `legal_moves_top` | 2.048s | 1.65% | 59,440,032 | |
| `apply_move_loop` | 1.399s | 1.12% | 61,083,332 | |
| `etc_try_cutoff` | 1.346s | 1.08% | 61,092,329 | |
| `entry_checks` | 0.704s | 0.57% | 59,440,032 | |
| `hash_diff_loop` | 0.582s | 0.47% | 61,083,332 | T182配線後、想定通り極小 |
| `tt_store` | 0.477s | 0.38% | 21,618,686 | |
| `tt_probe` | 0.205s | 0.16% | 21,619,873 | |
| `pass_hash` | ~0s | 0.00% | 54,136 | |
| `mpc_overhead_self` | 0s | — | 0 | MPC off時は不使用 |
| **非重複合計** | **118.583s** | **95.32%** | | |
| **残差(未計測)** | **5.823s** | **4.68%** | | 呼び出し/復帰オーバーヘッド・RDTSC計測自体のコスト等 |

### MPC on(nodes=6,487,461、wall=16.816s、ns/node=2592)

| 区間 | 時間 | %wall | 呼び出し回数 | 備考 |
|---|---:|---:|---:|---|
| **`ordered_moves`合計(inclusive)** | **12.554s** | **74.66%** | 2,295,933 | |
| 　├ `sort_apply_move` | 3.803s | 22.61% | 180,270,086 | 1回あたり平均**78.5回** |
| 　├ `sort_legal_moves` | 1.749s | 10.40% | 180,270,086 | 同上 |
| 　├ `redundant_legal_moves` | 0.020s | 0.12% | 2,295,933 | |
| 　└ 純粋ソート機構(残り) | 6.982s | 41.52% | — | |
| `static_eval` | 2.791s | 16.60% | 4,153,497 | |
| `legal_moves_top` | 0.228s | 1.36% | 6,487,461 | |
| `apply_move_loop` | 0.160s | 0.95% | 6,707,463 | |
| `etc_try_cutoff` | 0.132s | 0.78% | 6,708,797 | |
| `entry_checks` | 0.071s | 0.42% | 6,487,461 | |
| `hash_diff_loop` | 0.064s | 0.38% | 6,707,463 | |
| `tt_store` | 0.039s | 0.23% | 2,295,933 | |
| `tt_probe` | 0.022s | 0.13% | 2,332,277 | |
| `mpc_overhead_self` | 0.0205s | 0.12% | 2,117,757 | MPC自身の前処理のみ(プローブ再帰は除く) |
| `pass_hash` | ~0s | 0.00% | 1,687 | |
| **非重複合計** | **16.082s** | **95.63%** | | |
| **残差(未計測)** | **0.734s** | **4.37%** | | |

## (c) T180「67%未解明」との突合 — 最重要発見

**結論: 67%の大半は`ordered_moves`(ムーブオーダリング)が占めており、しかもその主因は`Vec::sort_by_key`の既知の仕様(キー関数をO(1)回ではなくO(n log n)回、比較のたびに毎回呼び直す)だった。**

T180の内訳モデルで「既知(評価・盤面操作・TT・hash)」として計上されていたと考えられる区間(`static_eval` + `tt_probe/store` + `legal_moves_top` + `apply_move_loop` + `hash_diff_loop` + `entry_checks` + `etc_try_cutoff`)を合計すると、MPC off条件で**24.8%**にしかならない(T180の推定「既知33%」とおおむね近い水準)。残りの**70.49%**が`ordered_moves`であり、これがT180の「67%未解明」の正体である。

### なぜ`ordered_moves`がここまで高コストなのか

`engine/src/search.rs`の`ordered_moves`は、候補手を「隅優先 → 相手モビリティ昇順」で並べ替えるために`moves.sort_by_key(|&mv| { ... let next_board = board.apply_move(side, bit); let opp_mobility = next_board.legal_moves(side.opposite()).count_ones(); ... })`という形でソートキーを計算している。

Rustの標準ライブラリには**`sort_by_key`(キー関数を比較のたびに再計算)**と**`sort_by_cached_key`(キー関数を要素ごとに1回だけ計算してキャッシュ)**の2種類があり、両者は明確に使い分けが意図されている(`sort_by_cached_key`のドキュメントに「キー関数が高価な場合に有効」と明記)。`ordered_moves`は前者(`sort_by_key`)を使っているにもかかわらず、キー関数の中身は`apply_move`(盤面全体のbitboard演算)+`legal_moves`(Kogge-Stone系の合法手列挙)という**決して安くない処理**である。

実測: `ordered_moves`呼び出し1回あたり、ソートキークロージャは平均**65.5回(MPC off)/78.5回(MPC on)**呼ばれている。これは要素数(合法手数、典型的に4〜12程度)よりずっと多い —— `negascout`自身の候補手ループ(`apply_move_loop`、要素数と同じ回数だけ呼ばれる。MPC off時61,083,332回 ≒ ordered_moves呼び出し数の約2.8倍、すなわち平均して1ノードあたり実際に処理する候補手は3手弱)と比較すると、**ソートキー計算だけで本来必要な回数の20倍以上**が費やされている。

**独立検証**: `sort_by_key` vs `sort_by_cached_key`の呼び出し回数を単純なRustプログラムで直接比較したところ(降順配列に対して)、n=8で56回 vs 8回(7倍)、n=16で240回 vs 16回(15倍)と、要素数が増えるほど倍率が増大する傾向を確認し、実測(65.5〜78.5倍、実局面の合法手数分布・比較アルゴリズムの詳細により単純なn log nより高めの倍率)と整合する(該当スクリプトは`bench/edax-compare/`にはコミットしていない使い捨て検証。再現方法は meta参照)。

## (d) MPC on特有のコストの分離

- `mpc_overhead_self`(校正値ルックアップ・番兵判定・suppress_mpcトグル等、**プローブの再帰探索自体を除く**自己コスト): **0.0205s / 16.816s = 0.12%** — MPC自体の判定オーバーヘッドはごく僅か。
- **プローブ部分木のノード数**: `ctx.suppress_mpc == true`のノード(=MPCの浅いプローブ探索が辿るノード)は**951,171 / 6,487,461 = 14.66%**。すなわちMPC onの全探索ノードのうち約15%は「メインのPV探索」ではなく「打ち切り判定用の浅い確認探索」に費やされている。これはMPCの設計上必然のコスト(確率的カットオフの検証にはある程度の追加探索が要る)であり、それ自体は不具合ではない。
- MPC on時の`ordered_moves`比率(74.66%)がMPC off時(70.49%)よりわずかに高いのは、プローブ部分木内でも同じ`ordered_moves`が呼ばれ続けるため(MPCがordered_movesのコスト構造を変えるわけではない)。

## (e) 一時変更の完全復元・回帰確認

- 計測用の一時変更は`engine/src/search.rs`へのRDTSC計装(`git diff`で確認後)と、一時バイナリ`engine/src/bin/t183_profile.rs`(新規ファイル)のみ。
- `git checkout -- engine/src/search.rs`で復元、`rm engine/src/bin/t183_profile.rs`で一時バイナリを削除し、`git status --short`が空(diffゼロ)であることを確認済み。
- 復元後 `cargo test -p engine --lib`: **245 passed; 0 failed; 2 ignored**(T182までの状態と同一件数)。
- FFO fastは本タスクでは未再実行(`negascout`〈中盤探索〉のみを計装しており、`endgame.rs`〈終盤完全読み〉は本タスクで一切変更していないため、影響なしと判断。直近のT182作業ログでFFO fast 5問全問正解を確認済み)。

## (f) 改訂版の最適化優先順位リスト(実測に基づく、実装は次タスク)

| 優先度 | 施策 | 実測根拠 | 実測上限(見積り) | リスク |
|---|---|---|---|---|
| **1(新設・最優先)** | `ordered_moves`の3箇所の`sort_by_key`を`sort_by_cached_key`に置き換える | ソートキー計算(`sort_apply_move`+`sort_legal_moves`)がMPC off時57.1%・MPC on時33.0%を占め、うち本来1回で済むはずの計算が65.5〜78.5倍再計算されている | ソートキー計算コストが呼び出し回数と同じ比率(約1/65〜1/78)に削減されると仮定すると、MPC off: 71.07s→約1.09s(約70s減、**全体で最大-56%、約2.3倍高速化**)。MPC on: 5.55s→約0.07s(約5.48s減、**全体で最大-32.6%、約1.5倍高速化**)。実際の削減率は`sort_by_cached_key`自身のキャッシュ配列確保コスト・キャッシュ局所性の変化で目減りしうるため上限値として扱う | 低(ソート結果自体は不変、キー計算方法のみ変更。既存の固定深さ回帰テスト〈ノード数固定〉で前後一致を直接検証可能) |
| 2 | `ordered_moves`の「純粋ソート機構」部分(Vec確保・ビット列挙・tt_move昇格)をヒープ確保無しの固定長配列(`endgame.rs`の`MoveInfo`/`[MoveInfo; 64]`と同型)に置き換える | 優先1適用後に残る13.21%(MPC off)/41.52%(MPC on)がこのバケットの内訳 | 優先1適用後、Vec確保コストの割合次第だが数%程度のさらなる削減が見込める(endgame.rs側の既存実装が同型の最適化を既に採用済みで参考にできる) | 中(`ordered_moves`の返り値の型を変える必要があり、呼び出し元〈`negascout`の候補手ループ〉との連携部分の書き換えを伴う) |
| 3 | `ordered_moves`が計算した`next_board`(ソート用に使い捨てていたもの)を`negascout`の候補手ループへ持ち越し、`apply_move_loop`(1.12%/0.95%)の再計算を避ける | 優先1・2と同じ`ordered_moves`の返り値構造変更のついでに実施可能 | 1.12%(MPC off)/0.95%(MPC on)のうち大半を削減見込み(小さいが優先2と同時に実装すれば追加コストほぼゼロ) | 中(優先2と同時実施が自然) |
| 4(従来T180優先3、据え置き) | `static_eval`の増分評価化(葉ノードごとのフル再計算を避け、着手による特徴量差分だけ更新) | 19.39%(MPC off)/16.60%(MPC on)を占める、T182のhash増分化と同型のアプローチが適用できる可能性 | 理論上限は19.39%/16.60%(全て解消できた場合)だが、増分更新自体のオーバーヘッドがあるため実際の削減率は本タスクでは未検証。優先度の高い1〜3より効果検証コストが高い(パターン評価の特徴量抽出ロジック全体の見直しが必要) | 高(評価関数の再構築を伴い、T182のような同一性の証明がより複雑になる) |
| (参考・対応不要) | MPCプローブ部分木の削減 | プローブ部分木は全ノードの14.66%(MPC on)だが、MPCの設計上必然のコストであり、これ自体を「無駄」として削減対象にするのは校正パラメータ(t値・キャリブレーション表)の再調整の話であり、本タスクの計測対象外 | — | — |

**T180の順位表との関係**: T180優先1(増分hash配線)は既にT182で実装済み(採用決着)。T180優先2(ムーブオーダリング簡略化)は本タスクで「なぜ・どれだけ高コストか」を具体的に特定できたため、上表の優先1〜3として大幅に格上げ・具体化した。T180優先3(増分評価)は上表の優先4としてそのまま据え置き。

## (g) 総括

- T180で「67%未解明」だった探索1ノードあたり時間の内訳は、本タスクの計装により**95%超が説明可能**になった(残差はMPC off 4.68%・MPC on 4.37%で、呼び出し/復帰オーバーヘッドや計測自体のコストなど許容範囲の水準)。
- 未解明分の正体は単一の原因(`ordered_moves`、70.49%/74.66%)であり、その中でもさらに単一の原因(`sort_by_key`のO(n log n)回キー再計算)が支配的(57.1%/33.0%)と特定できた。
- この発見に基づく優先1(`sort_by_cached_key`への置き換え)は、変更行数が非常に小さく(3箇所の関数呼び出し変更のみ)、挙動不変性の検証も容易(ソート結果自体は変わらないため既存の固定深さ回帰テストがそのまま使える)ため、次の実装タスクとして即着手可能と判断する。
