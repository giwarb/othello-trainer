# T127f Edax hash A/B report

## 結論

**現行の hash 指定なし生成を続行する。`-h 22` / `-h 24` への乗り換え条件は満たさない。**

score / bestMove / diffFromBest は exact 帯・level16 帯とも全件一致し、各設定2回の決定性も全件一致した。一方、CPU 競合下のペア計測では `-h 22` はほぼ同速だがわずかに遅く、`-h 24` は明確に遅かった。判定式「値が完全一致、かつ15%以上高速」の速度条件をどちらも満たさない。

## 方法

- selection plan SHA-256: `2f26451299ea000c2ee118ab91330d1cdbc283903b0f23474b882210f2698483`
- selection snapshot: 8 shard checkpoint が各 28,876–28,942件の時点。incremental 800,000件中、生成済み31,180件、未生成768,820件。
- 固定 seed `t127f-edax-hash-ab-v1` と `SHA-256(seed, band, positionId)` の順位で、snapshot 時点の未生成局面から exact 帯150親、level16 帯150親を決定的に選択した。
- exact 帯は親 empties <= 21（非終局子を level 60）、level16 帯は親 empties > 21（非終局子を level 16）。生成と同じ `-n 1` を使用した。
- 各親について hash 無しと `-h 22`、hash 無しと `-h 24` を直結ペアで実行し、親ごと・hash ごとに先後を交互化した。速度は `default elapsed / hash elapsed` の150ペア幾何平均。
- hash 無しは2回、`-h 22` / `-h 24` も各2回ラベル付けし、同一設定間の決定性を比較した。再現確認用の追加実行は速度集計に含めていない。
- scratchpad: `%TEMP%\t127f_edax_hash_ab\sample.json`, `results.jsonl`, `summary.json`。1ペアまたは1再現実行ごとに append + flush + fsync し、resume 可能。リポジトリおよび生成中の plan/checkpoint への書き込みは行っていない。
- 全A/B所要時間: 6,149.4秒（約102.5分）。expanded1m の8 shard生成と同時走行するCPU競合下で計測した。

## 値一致と決定性

| 帯 | 親数 | 子ラベル数 | default vs `-h 22` | default vs `-h 24` | 最大score差 | 同一設定2回 |
|---|---:|---:|---:|---:|---:|---|
| exact | 150 | 840 | 不一致0 | 不一致0 | 0石 | default / h22 / h24 全件一致 |
| level16 | 150 | 1,676 | 不一致0 | 不一致0 | 0石 | default / h22 / h24 全件一致 |

比較対象は各子の score と diffFromBest、および各親の bestMove。したがって両帯・両hashとも「値変化なし」と判定する。

## 速度

speedup は1.0超が高速、1.0未満が低速を表す。

| 帯 | `-h 22` speedup | `-h 22` 時間変化 | `-h 24` speedup | `-h 24` 時間変化 |
|---|---:|---:|---:|---:|
| exact | 0.9899x | 1.02%遅い | 0.6409x | 56.04%遅い |
| level16 | 0.9986x | 0.14%遅い | 0.8301x | 20.46%遅い |

production 残件の帯構成は exact 380,113件、level16 388,707件（合計768,820件、仕様の「残り約77万件」と整合）。この比率で帯別 speedup の対数を重み付けした全体推定は次のとおり。

| 設定 | 重み付きspeedup | 短縮率 | 77万件に掛けた短縮相当 | 現行40時間からの残り時間推定 |
|---|---:|---:|---:|---:|
| `-h 22` | 0.9943x | -0.577% | -4,443件相当 | 40.23時間（約14分増） |
| `-h 24` | 0.7304x | -36.906% | -284,178件相当 | 54.76時間（約14.76時間増） |

短縮率は `1 - 1 / speedup`。負値は短縮ではなく増加を意味する。残り時間は現行見積もり40時間を `speedup` で割った値である。

## 実装・回帰確認

- `vs_edax.py::_edax_solve_batch()` に `edax_hash_bits: int | None = None` を加えた。`None` の場合は従来のコマンド列に何も追加せず、指定時だけ `-h <bits>` を加える。
- scratchpad の一時 pytest で subprocess command を捕捉し、未指定時の引数列が従来と同一で `-h` を含まないこと、および22指定時だけ `-h 22` が加わることを確認した。

## 推奨判定

値一致条件は満たすが、15%以上高速という条件を満たさない。`-h 22` は統計上ほぼ中立、`-h 24` はメモリ競合下で大幅に遅い。**expanded1m 生成は停止・作り直しをせず、現在の hash 指定なし設定を続行することを推奨する。**
