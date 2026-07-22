# T191: lazy orderingのhistory有効経路への拡張(historyスナップショット方式)

T190のlazy ordering(TT手先行構築、省略成功率67.5%)は`ctx.history`が有効な経路(MPC on経路・ノード予算経路の`enable_history: true`)では順序不変性が崩れるため対象外だった。しかし本番の対局CPU(強)が使うノード予算経路(`search_with_eval_with_node_limit_and_exact_quota`)は`enable_history: true`がハードコードされており、T190時点ではlazyの恩恵を受けていなかった。history値を「ノード入場時(TT手の子探索前)」にスナップショットしておくことで、残候補の遅延ソートでも現行と厳密に同一のキー値を使えるため、探索結果ビット不変のままhistory有効経路へlazyを拡張した。

## (a) 実装内容

`engine/src/search.rs`:

- **`HistoryTable::snapshot`**: `side`分のhistory値(`[u32; 64]`)をノード入場時点の状態で複製する新規メソッド。ヒープ確保なし、256バイトの配列コピー。
- **`HistorySource`列挙型**: `ordered_moves`のhistory引数の型を`Option<&HistoryTable>`から`Option<HistorySource>`(`Live(&HistoryTable)` / `Snapshot(&[u32; 64])`)へ変更。どちらも`.get(side, mv)`で同じ値を返し、ソートロジック(タプルキー構成・比較順序・`sort_by_cached_key`)自体は一切変更していない。
- **lazyゲートの拡張**: `negascout`のlazy分岐ゲートから`ctx.history.is_none()`条件を除去し、`lazy_ordering_enabled_for_run()`(テスト専用の`TEST_FORCE_LEGACY_ORDERING`の否定)のみに変更。TT手が現ノードで合法なら、history有効/無効にかかわらず常にlazy経路へ入る。
- **スナップショットの取得位置**: lazy分岐(TT手が合法な場合)に入った直後、TT手のサブツリー探索(`process_candidate!(&tt_om)`、内部で`ctx.history`を更新しうる再帰呼び出しを含む)を始める**前**に`ctx.history.as_deref().map(|h| h.snapshot(side))`でスナップショットを取る。
  - TT手だけでbeta cutoffが起きた場合(`cutoff == true`)は従来どおり残候補の構築を丸ごと省略する。
  - カットオフしなかった場合、残候補(`legal & !tm_bit`)を`ordered_moves`で構築する際、history有効時は`history_snapshot.as_ref().map(HistorySource::Snapshot)`を渡す(TT手のサブツリー探索中に他ノードが行った`ctx.history`の更新に一切影響されない、ノード入場時点の値のまま)。
  - TT手なし/非合法、またはlazy経路自体が無効な場合の一括構築(従来どおり)は`ctx.history.as_deref().map(HistorySource::Live)`を渡す(この時点ではまだどの候補手も処理していないため、ライブの値=ノード入場時点の値で完全に一致する)。

## (b) 絶対条件: 探索結果の完全一致

### 単体テスト(`search::tests`)

新規テスト2件(T190の同種テストのhistory有効版、T190と併存):

1. **`lazy_ordering_matches_legacy_full_construction_with_history_enabled_across_diverse_midgame_searches`** — `SearchPolicy { enable_history: true, enable_aspiration: true, enable_mpc: false }`(本番のノード予算経路と同じhistory設定)で、8局面×depth<=8(反復深化)にわたり、lazy有効(既定)とレガシー強制(`ForceLegacyOrderingGuard`)の探索結果(best_move/score/depth/nodes)が完全一致することを確認。
2. **`lazy_ordering_activates_and_skips_residual_with_history_enabled_across_diverse_midgame_searches`** — 同条件で、history有効時にもlazy発動・残候補省略のテレメトリが実際に発火する(0件のままpassしない)ことを確認。

**regression-catching実証(本タスクの核心)**: 実装後、残候補構築の`ordered_moves`呼び出しへ渡す第5引数を、意図的に`history_snapshot.as_ref().map(HistorySource::Snapshot)`から`ctx.history.as_deref().map(HistorySource::Live)`(=ノード入場時点のスナップショットではなく、TT手のサブツリー探索完了後の残候補ソート実行時点のライブhistory値)へ改変した。この改変により`lazy_ordering_matches_legacy_full_construction_with_history_enabled_across_diverse_midgame_searches`が

```
assertion `left == right` failed: n=5: nodes differs between lazy and legacy ordering (history enabled)
  left: 4409
 right: 4408
```

で確実に失敗することを確認し、直後にスナップショット渡しへ復元、`cargo test -p engine --lib`が257 passed(復元前と同数)に戻ったことを確認済み。これは「TT手探索中の他ノードのhistory更新が残候補の順序に混入しうる」というT190で無効化されていた懸念が、スナップショット無しでは実際に発現すること、およびスナップショット方式がそれを正しく防いでいることの直接証拠である。

`cargo test -p engine`(全ターゲット): **257 passed(既存255 + 新規2件) / 0 failed / 2 ignored**(lib)。`calibrate_mpc`/`puzzlegen`/`self_play_gen`の既存テストも全件pass。**t182/t184/t185の固定値回帰テスト(score/best_move/depth/nodes)はアサート値を一切変更せずに全パス**(絶対条件を実測で確認、t182系はMPC on=history有効を含む)。

`cargo test --release -p engine --test ffo_bench -- --nocapture`: fast問題(#40〜#44)5問全問正解(nodes=641,077,417、time=59.196s、nps=10,829,742)。終盤ソルバー(`endgame.rs`)は評価関数を一切使わないため本タスクの変更とは無関係だが、念のための回帰確認として実施した。

### テレメトリ実測(要件4: history有効経路のlazy発動数・省略成功数)

`lazy_ordering_activates_and_skips_residual_with_history_enabled_across_diverse_midgame_searches`(8局面×depth<=8、`SearchPolicy { enable_history: true, .. }`、`pattern_v6.bin`)実行結果:

| 指標 | 実測値 |
|---|---:|
| lazy ordering発動ノード数(TT手先行構築に入った回数、history有効) | **19,423** |
| うち残候補構築を丸ごと省略できた回数(TT手だけでcutoff) | **12,848**(発動の約66.1%) |

T190のhistory無効経路の実測(発動17,673件中67.5%省略)とほぼ同水準の省略率であり、history有効経路でもTT手先行構築が同程度の頻度で無駄な残候補構築を回避できていることを示している。

### 探索結果の完全一致(worktree比較、20局面×3条件×3ラウンド)

`git worktree add`で変更前(T191着手直前のHEAD、`29a9c12`)を`../t191-worktrees/before`に独立チェックアウトし、`eval_cli`(`--features mpc_enabled`)を独立ビルド(現ワークツリーの`target/`とは完全に分離、SHA256が異なることを確認: before=`26301bc0...`, after=`e52686da...`)。

T183〜T190と同じ中盤20局面バッチ(`bench/edax-compare/t156_mpc_positions.json`のsplit==test・空き29-36帯、先頭20件、ID `mpc-29-36-test-001..020`)を、before/afterの両バイナリで以下3条件で実行し、局面ごとの`nodes`/`move`/`discDiff`を照合した。

- **MPC off**: `eval_cli best --depth 12 --exact-from-empties 0 --pattern-weights train/weights/pattern_v6.bin`(history無効、T190までと変わらない経路)
- **MPC on**: 上記+`--enable-mpc`(history有効、`SearchPolicy { enable_history: true, enable_aspiration: true, enable_mpc: true }`)
- **node_budget(参考、本番経路相当)**: 上記+`--max-nodes 160000`(`--enable-mpc`無し。本番の`search_with_eval_with_node_limit_and_exact_quota`と同じ`enable_history: true, enable_mpc: false`のノード予算経路)

**結果: 3条件・全ラウンド・全局面(20局面×3条件×3ラウンド=計180局面回)でnodes/move/discDiffが完全一致(mismatch=0件)**。totalNodesは`mpc_off=59,440,032`・`mpc_on=6,487,461`(T180から一貫して確立されている値)・`node_budget=3,200,000`(20局面×160,000ノード予算をすべて使い切っており、予算経路の想定どおり)。

## (c) NPS実測(標準手順: worktree独立ビルド+交互3回+専有確認)

手順: `git worktree add`で変更前(`29a9c12`)を独立ディレクトリにチェックアウトして`eval_cli`(`--features mpc_enabled`)を独立ビルド。現ワークツリー(変更後)も同様にビルド。実行直前に`tasklist`でcargo/rustc/eval_cli/pythonが動いていないことを確認(専有状態、各条件の計測前に再確認)。20局面バッチを、before/afterの順序を各ラウンドで入れ替えながら(round0: before→after、round1: after→before、round2: before→after)3ラウンド実行し、各ラウンドの合計ノード数÷合計経過msでNPSを算出、3ラウンド平均を採用した。

| 条件 | before(3回平均) | after(3回平均) | 倍率 | ノード数(before/after) |
|---|---:|---:|---:|---:|
| MPC off | 2,153,488 NPS | 2,145,857 NPS | -0.35%(非悪化) | 59,440,032 / 59,440,032(完全一致) |
| MPC on | 1,813,587 NPS | 1,923,115 NPS | **+6.04%** | 6,487,461 / 6,487,461(完全一致) |
| node_budget(参考) | 1,860,134 NPS | 2,120,689 NPS | **+14.01%** | 3,200,000 / 3,200,000(完全一致) |

3ラウンドの内訳(MPC on・node_budgetは3ラウンドとも一貫してafterがbeforeを上回る):

- MPC off: before = 2,174,026 / 2,143,837 / 2,142,601 → after = 2,166,656 / 2,146,237 / 2,124,679(NPS、いずれもほぼ同水準)
- MPC on: before = 1,799,074 / 1,831,064 / 1,810,623 → after = 1,900,252 / 1,939,450 / 1,929,643(NPS、いずれもafterが+5.6〜+6.6%上回る)
- node_budget: before = 1,857,226 / 1,870,251 / 1,852,924 → after = 2,112,211 / 2,139,037 / 2,110,818(NPS、いずれもafterが+13.7〜+14.4%上回る)

MPC off(history無効)はT191での変更対象外の経路(既にT190で全面適用済み)であり、-0.35%は計測誤差の範囲内の横ばい(各条件内のラウンド間ばらつきと同程度)で、非悪化を確認した。MPC on・node_budget(いずれもhistory有効)は3ラウンドとも一貫してafterが上回っており、ラウンド間ばらつき(各条件内で1〜2%程度)を明確に超える改善である。raw JSONは`bench/edax-compare/t191_lazy_history_report.raw.json`に保存(ラウンドごとの内訳・バイナリSHA256・テレメトリ実測込み)。

node_budget(本番のCPU強が使うノード予算経路相当)で+14.0%という、MPC on(+6.0%)よりも大きな改善が出ている点は、node_budget条件が`enable_mpc: false`のためMPC probeのオーバーヘッドが無く、lazy orderingによる`ordered_moves`省略の効果がより直接的にNPSへ反映されるためと考えられる。いずれもノード数は完全一致しており、探索結果を変えずに実測上の高速化が得られていることを確認した。

## (d) 採用判定

- ノード数完全一致(mpc_off/on/node_budgetの3条件、180局面回すべてでmismatch=0) + MPC on/node_budgetのNPS改善が計測誤差(ラウンド間ばらつき1〜2%程度)を明確に超える(MPC on +6.04%、node_budget +14.01%、いずれも3ラウンドとも一貫して同方向)+ MPC off非悪化(-0.35%、誤差範囲)。要件6の採用条件を満たすため**採用**。

## (e) 総括

- T190で「history有効時は正当性が崩れるため対象外」としていた制約を、historyスナップショット(ノード入場時点の値を固定する)という方式で解消し、本番のノード予算経路(CPU強が使う経路)にもlazy orderingの恩恵を及ぼした。
- 絶対条件(ビット単位不変)は、単体テスト(意図的バグ注入によるregression-catching実証込み)、テレメトリ(history有効経路でのlazy発動・残候補省略の実発火確認、66.1%)、worktree比較による20局面×3条件×3ラウンド=180局面回の完全一致確認、の三重で担保した。
- 本番経路に近いnode_budget条件で+14.0%という、これまでのT190(MPC off +8.0%)に匹敵する規模の改善が得られており、本番対局(CPU強)の応答性向上に直接寄与する見込み。
