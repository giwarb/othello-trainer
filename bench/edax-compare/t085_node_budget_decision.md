# T085b: ノード予算校正・採用判定

## 結論

採用値は **160,000 nodes / wall保険1,500 ms** とする。固定48局面の主判定と20局スモークの採用条件をすべて満たした候補のうち、最小のノード予算である。level 10 primaryは、この候補だけを30 opening × 両色の60局で実施し完走した。

## 固定48局面 oracle regret（主判定）

oracleは各局面の全合法手について、着手後の同一rootをEdax 4.6 level 16で評価した。各node系列はwall保険1,500 ms付きで同一局面を2回探索した。

| 系列 | 平均regret（石） | 決定性 | wall保険発動 | depth0 | 平均深さ | 平均nodes |
|---|---:|---:|---:|---:|---:|---:|
| wall 1,000 ms / node無制限 | 4.104 | 対象外 | 29/48 | 7 | 7.917 | 627,040 |
| node 160k / wall 1,500 ms | 1.604 | 48/48 (100%) | 0/48 | 0 | 9.354 | 133,962 |
| node 200k / wall 1,500 ms | 1.396 | 48/48 (100%) | 0/48 | 0 | 9.646 | 160,570 |
| node 240k / wall 1,500 ms | 1.396 | 48/48 (100%) | 0/48 | 0 | 9.708 | 185,955 |
| node 300k / wall 1,500 ms | 1.521 | 48/48 (100%) | 0/48 | 0 | 9.896 | 221,386 |

160kはwall系列より平均regretが2.500石（60.9%）小さい。より大きい候補も条件を満たすが、「すべて満たす中で最小」を適用して160kを選んだ。

生データ: `t085_node_budget_calibration.json`（oracle 48局面、5系列×48局面=240件、局面単位checkpoint）

## 採用条件

| 条件 | 160k実測 | 判定 |
|---|---:|---|
| 決定性100% | 固定48/48一致、opening回帰10/10一致 | 合格 |
| wall保険発動5%以下 | 固定局面0/48、スモーク実着手0/485、primary実着手0/1,431 | 合格 |
| depth0ゼロ | 固定局面0、スモーク0/485、primary 0/1,431 | 合格 |
| wall系列より平均oracle regretが悪化しない | 1.604 vs 4.104（−2.500石） | 合格 |
| 20局スモーク平均石差が3石以上悪化しない | −33.65 vs 既存wall −35.80（+2.15石） | 合格 |
| 条件を満たす最小予算 | 候補160k/200k/240k/300kの最小 | 合格 |

20局スモークの戦績は1勝0分19敗。比較基準はT084確定成果物 `vs_edax_results.json` のsingle-root / level 10 / 20局であり、wall系列の再実行はしていない。

## level 10 primary 60局

160k候補だけを `openings.json` のprimary 30局面×両色で実行した。

- 完走: 60/60局（1局単位のアトミックcheckpoint）
- 戦績: 4勝2分54敗
- 平均石差: −29.067石（最小−62、最大+22）
- engine着手: 1,431、wall保険発動0、depth0ゼロ
- 中断再開確認: 完走後の再実行で60局をresumeし、全局をskip

生データ: `t085_node160_primary_results.json`。20局スモークは `t085_node160_smoke_results.json`。

## provenance・保存方式

resume互換性はrun keyに加え、git tree、作業ツリー上のengine source hash、harness hash、重みhash、Edax本体・評価データhash、実行するeval_cli hashを比較し、いずれかが異なれば拒否する。`eval_cli`は毎回 `cargo build --release -p engine --bin eval_cli` を通した後にhashを記録する。

checkpointは同一directoryの一時ファイルをflush・fsync後、`os.replace()`で置換する。自己テストで5種のprovenance不一致拒否と、replace直前の中断でも既存JSONが破損しないことを確認した。
