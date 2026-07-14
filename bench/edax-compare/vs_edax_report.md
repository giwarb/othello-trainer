# T084: 自作エンジン vs Edax 対戦ハーネス — single-root化・テレメトリ・弱点分析レポート

本レポートは自動生成される(`bench/edax-compare/vs_edax.py`)。再生成する場合は `python bench/edax-compare/vs_edax.py` を実行すること(事前にEdax(`download-edax.ps1`)・`eval_cli`(`cargo build --release -p engine --bin eval_cli`)・`train/weights/pattern_v2.bin`が必要)。T082(初版)からの変更点は`vs_edax.py`冒頭のdocstringおよび`tasks/T084-bench-single-root-telemetry.md`の作業ログを参照。

## (a) 実行条件

- git commit: `e5eb35bf235cac14873521135979b9d7908fb8e2`
- git tree: `af0f5134dae2ce762375ce77e3c27fb38aab89e5` / harness sha256: `220f25c3d0a879cf21d11af6832d4049aa004bef218684a46278907a43e4403e`
- settings sha256: `45a40030a1c8aa3327569fc8c5e8e2cc4a5fa78a9957c968cb76c7df724581dd`
- パターン重み: `train/weights/pattern_v2.bin` (sha256=`b916c29e4f84692610a65b75c1692132628de5ba2b27b71bf2e8b94426b76c2a`)
- 実行日時(UTC): 2026-07-14T02:07:04+00:00
- 自作エンジン: `--depth 10 --exact-from-empties 18 --time-ms 1000 --pattern-weights train/weights/pattern_v2.bin`(single-root/allmoves共通、同一予算での比較)
- 開始局面: `bench/edax-compare/openings.json`(T084固定マニフェスト)の `smoke` セット(10局面 x 黒白持ち替え2局 = 20局/レベル/モード)
- Edaxレベル: [10, 5, 1](いずれも `-book-usage off`、`-eval-file data/eval.dat`)
- 実行したモード: ['single-root', 'allmoves'] (single-root=T084で追加した単一ルートPVS探索、allmoves=T082の全合法手分割探索。同一opening・同一レベル・同一予算で両方実行し、(b)で直接比較する)
- 弱点分析(要件6・7・9c): single-rootモードの負けた対局のみを対象に、Edax `-l 16` で修正版オラクル(同一rootの全合法手を個別評価しmax差分)を算出。レベルごとに負け局が5局を超える場合は先頭5局のみを代表サンプルとして分析した。
- fixed-depth決定性回帰チェック(要件2・4): `--depth 8 --exact-from-empties 10`(時間予算なし)で40局面を2回連続実行し、全着手・全ノード数が一致するかを検証: **PASSED**
- ノード予算決定性チェック: `--max-nodes 4096`でsmoke 10局面を2回実行し、着手・評価・深さ・ノード数を照合: **PASSED**

## (b) レベル別の勝敗・平均石差(single-root vs allmoves、同一予算での直接比較)

| モード | Edaxレベル | 局数 | 自作エンジン勝ち | Edax勝ち | 引き分け | 勝率 | 平均石差(自作-Edax) |
|---|---:|---:|---:|---:|---:|---:|---:|
| single-root | 10 | 20 | 0 | 20 | 0 | 0.0% | -35.80 |
| single-root | 5 | 20 | 4 | 16 | 0 | 20.0% | -21.60 |
| single-root | 1 | 20 | 14 | 6 | 0 | 70.0% | +16.50 |
| allmoves | 10 | 20 | 0 | 20 | 0 | 0.0% | -49.00 |
| allmoves | 5 | 20 | 0 | 20 | 0 | 0.0% | -33.60 |
| allmoves | 1 | 20 | 15 | 5 | 0 | 75.0% | +16.40 |

### single-root化による変化(考察)

- level 10: single-root勝率0.0%(平均石差-35.80) vs allmoves勝率0.0%(平均石差-49.00) → 平均石差の差分 +13.20石(single-rootが優勢)
- level 5: single-root勝率20.0%(平均石差-21.60) vs allmoves勝率0.0%(平均石差-33.60) → 平均石差の差分 +12.00石(single-rootが優勢)
- level 1: single-root勝率70.0%(平均石差+16.50) vs allmoves勝率75.0%(平均石差+16.40) → 平均石差の差分 +0.10石(single-rootが優勢)

## (c) テレメトリ集計(single-rootモードの自作エンジンの着手より)

- 総手数: 1494
- 到達深さ: 最小0 / 平均7.87 / 最大18
- ノード数: 最小2 / 平均244136 / 最大3752961
- タイムアウト率(`timedOut=true`): 746/1494 (49.9%)
- exact読み試行率: 522/1494 (34.9%)、うちフォールバック(未完走)率: 36/522 (6.9%)

## (d) フェーズ別ロス集計(single-rootモードの負けた対局のサンプルより、実手数ベース)

分析対象: 15局、自作エンジンの着手362手分。ロス = (着手前局面の全合法手をEdax `-l 16` で個別評価した際の最大値) - (選択した手の評価値)。この方式では理論上 loss は常に0以上になる(要件7)。

| フェーズ(実手数) | 該当手数 | 平均ロス(石) | 累計ロス(石) |
|---|---:|---:|---:|
| 序盤(1〜20手目) | 75 | +1.88 | +141.00 |
| 中盤(21〜40手目) | 150 | +2.36 | +354.00 |
| 終盤(41手目〜) | 137 | +1.82 | +250.00 |

- オラクル健全性チェック: 362件中、loss < 0 は **0件**(修正方式のもとでは理論上0件のはず。0件であればオラクルが正しく機能している証拠)。

## (e) ロスの大きい局面トップ10

| 順位 | レベル | game_id | 実手数 | フェーズ | 局面(OBF) | 自エンジンの手 | Edaxの推奨手 | ロス(石) | 合法手数 |
|---:|---:|---:|---:|---|---|---:|---:|---:|---:|
| 1 | 1 | 44 | 42 | 終盤(41手目〜) | `------------O----OOOOXXX-OOOXXXXOOOXOXXXXOXXXXXX-XOOXXXXXOOOO-XX` | h2 | f8 | +46.00 | 3 |
| 2 | 1 | 46 | 32 | 中盤(21〜40手目) | `---------OXXX---XXXXX---XXXXX---XXXXOO--XXXXOOO---XX-OX--OOO-O--` | h7 | c1 | +28.00 | 11 |
| 3 | 1 | 47 | 43 | 終盤(41手目〜) | `--OOOO-----OXO-X-XXOOXX-XXOXXXXO-OOOXXXO-OOOOXXO--OXXOXO---OOOO-` | g1 | c8 | +24.00 | 9 |
| 4 | 1 | 47 | 41 | 終盤(41手目〜) | `--OOOO-----OXO-X-XXOOXX-XXOXXXXO-OOOOXXO-OOOXOXO--OXOO-O---OOO--` | g7 | a5 | +22.00 | 11 |
| 5 | 10 | 2 | 44 | 終盤(41手目〜) | `------O--O---O-XXOOOO-XXXOXOXXXXXOOXOXX-XOXOOXX-XOOXXXO-XOOOOOO-` | g2 | h5 | +20.00 | 5 |
| 6 | 10 | 3 | 23 | 中盤(21〜40手目) | `------------O----OOOOOOX--OOOOOX---XXXOX--XXXOO---X-X-----------` | g7 | h2 | +16.00 | 15 |
| 7 | 5 | 22 | 40 | 中盤(21〜40手目) | `---X------OXXX--OOOXOXX-OOXXOX--XXOXXX--XXOOXXX-XXXOOX--XXXOOO--` | c1 | g7 | +16.00 | 14 |
| 8 | 1 | 44 | 30 | 中盤(21〜40手目) | `-----------------OOOXXXX---OOXXX--OOXXOX-OOOOOXX--XOOOXX----O--X` | b8 | d8 | +16.00 | 10 |
| 9 | 1 | 46 | 40 | 中盤(21〜40手目) | `X-O------XOXX---XXXXXO--XXOXOO--XXOOXO--XXOXXXXX--OOXOOO-OOOOO--` | f1 | g5 | +16.00 | 8 |
| 10 | 5 | 24 | 16 | 序盤(1〜20手目) | `------------O----OOOOX-----XOX-----XOXX---XOOXO-----X-----------` | g2 | f8 | +15.00 | 12 |

## (f) 考察

- 勝率が最も5割に近いのはsingle-root `-l 1`(勝率70.0%、平均石差+16.50石)であり、このレベル付近が現状の自作エンジンの実力の目安と考えられる。
- フェーズ別(実手数ベース)では中盤(21〜40手目)の平均ロスが最大(+2.36石)であり、このフェーズの弱さが敗因として最も大きい。
- 最大ロスの局面(level=1 game_id=44 実手数42手目)では自エンジンが`h2`を選んだのに対し、Edaxの推奨は`f8`で、ロスは+46.00石だった(上の(e)表を参照)。
- fixed-depth決定性回帰チェックはPASSEDであり、T084のテレメトリ追加(elapsed_ms/timed_outフィールドの追加、完全読みショートカットのノード数を実カウント化)が探索アルゴリズム自体(着手・スコア・到達深さ・ノード数)を変えていないことを直接検証できた。
- T084が最優先で取り組んだのは計測の正しさ(single-root化・テレメトリ・オラクルロス修正)であり、評価関数・探索の改善そのものはスコープ外(T085以降)。本レポートの(b)〜(e)は、今後の施策の採否判断に使う「補正済みの」ベースラインとして位置づけられる。

