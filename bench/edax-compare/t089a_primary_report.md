# T084: 自作エンジン vs Edax 対戦ハーネス — single-root化・テレメトリ・弱点分析レポート

本レポートは自動生成される(`bench/edax-compare/vs_edax.py`)。再生成する場合は `python bench/edax-compare/vs_edax.py` を実行すること(事前にEdax(`download-edax.ps1`)・`eval_cli`(`cargo build --release -p engine --bin eval_cli`)・`train/weights/pattern_v2.bin`が必要)。T082(初版)からの変更点は`vs_edax.py`冒頭のdocstringおよび`tasks/T084-bench-single-root-telemetry.md`の作業ログを参照。

## (a) 実行条件

- git commit: `0cf615fd72a862b00dd4286ee71549f6e5b65a14`
- git tree: `dfb9f7914721bea9d5ab73401749d6d0bacdd00f` / harness sha256: `5ade32a9c2e8e0a72064ff7a7712df3d6893f503f8946671fc609d1b90bac3c7`
- settings sha256: `ecb56313497d0219208e407b16e4fc074b5efa2ef5a58ed03f646f9fdfa635c6`
- パターン重み: `train/weights/pattern_v2.bin` (sha256=`b916c29e4f84692610a65b75c1692132628de5ba2b27b71bf2e8b94426b76c2a`)
- 実行日時(UTC): 2026-07-14T12:46:54+00:00
- 自作エンジン: `--depth 10 --exact-from-empties 18 --time-ms 1500 --pattern-weights train/weights/pattern_v2.bin`(single-root/allmoves共通、同一予算での比較)
- 開始局面: `bench/edax-compare/openings.json`(T084固定マニフェスト)の `primary` セット(30局面 x 黒白持ち替え2局 = 60局/レベル/モード)
- Edaxレベル: [10](いずれも `-book-usage off`、`-eval-file data/eval.dat`)
- 実行したモード: ['single-root'] (single-root=T084で追加した単一ルートPVS探索、allmoves=T082の全合法手分割探索。同一opening・同一レベル・同一予算で両方実行し、(b)で直接比較する)
- 弱点分析(要件6・7・9c): single-rootモードの負けた対局のみを対象に、Edax `-l 16` で修正版オラクル(同一rootの全合法手を個別評価しmax差分)を算出。レベルごとに負け局が5局を超える場合は先頭5局のみを代表サンプルとして分析した。
- ノード予算決定性チェック: `--max-nodes 160000`でsmoke 10局面を2回実行し、着手・評価・深さ・ノード数を照合: **PASSED**

## (b) レベル別の勝敗・平均石差(single-root vs allmoves、同一予算での直接比較)

| モード | Edaxレベル | 局数 | 自作エンジン勝ち | Edax勝ち | 引き分け | 勝率 | 平均石差(自作-Edax) |
|---|---:|---:|---:|---:|---:|---:|---:|
| single-root | 10 | 60 | 3 | 56 | 1 | 5.0% | -25.57 |

## (c) テレメトリ集計(single-rootモードの自作エンジンの着手より)

- 総手数: 1432
- 到達深さ: 最小1 / 平均8.40 / 最大14
- ノード数: 最小4 / 平均115292 / 最大160001
- タイムアウト率(`timedOut=true`): 0/1432 (0.0%)
- exact読み試行率: 658/1432 (45.9%)、うちフォールバック(未完走)率: 59/658 (9.0%)

## (d) フェーズ別ロス集計(single-rootモードの負けた対局のサンプルより、実手数ベース)

負けた対局が無かった(または分析対象がゼロ件だった)ため、ロス集計は該当なし。
## (e) ロスの大きい局面トップ10

該当なし。

## (f) 考察

- 勝率が最も5割に近いのはsingle-root `-l 10`(勝率5.0%、平均石差-25.57石)であり、このレベル付近が現状の自作エンジンの実力の目安と考えられる。
- 負けた対局が無かった(または分析対象がゼロ件だった)ため、フェーズ別の弱点は今回は特定できなかった。
- T084が最優先で取り組んだのは計測の正しさ(single-root化・テレメトリ・オラクルロス修正)であり、評価関数・探索の改善そのものはスコープ外(T085以降)。本レポートの(b)〜(e)は、今後の施策の採否判断に使う「補正済みの」ベースラインとして位置づけられる。

