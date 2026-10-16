---
id: T204
title: 偶奇振れ計測ハーネスと固定局面セットの恒常化(bench/parity/)
status: todo        # 提案中(ユーザー承認待ち)
assignee: implementer
attempts: 0
---

# T204: 偶奇振れ計測ハーネスと固定局面セットの恒常化

## 目的
探索深さによる評価値の振れ(偶奇差・同偶奇差)を、任意の重みファイルについて Edax と比べて再現可能に計測できるようにする。T205 以降の評価関数改善のゲートとして使う。

## 背景・コンテキスト
- T203(`tasks/T203-depth-parity-investigation.md`)で、評価値の深さ振れを Edax と比較した。調査用のスクリプトとデータは `tasks/design/T203-data/` に一時保存してある。
  - `run.py`: 深さ掃引の実行(逐次追記・resume 対応)
  - `stats.py` / `stats2.py`: 指標の集計
  - `positions.json`: 38局面
  - `diag_scripts/positions_b.json`: 拡大セット
  - `oth.py` / `mkpos.py`: 盤面ユーティリティ
  - `depth_parity.csv`: 調査時の結果。比較基準になる
- 当エンジンの深さ固定探索: `engine/src/bin/eval_cli.rs`。例: `eval_cli best --depth d --exact-from-empties 0 --pattern-weights <bin>`。入力 JSON は `{"board":"<64文字 X/O/->","side_to_move":"black"}`。ビルドは `cargo build -p engine --release --bin eval_cli`。
- Edax 4.6: `bench/edax-compare/` 配下に取得・展開の仕組みがある(`download-edax.ps1`、`edax-extract`)。呼び出し例: `wEdax-x86-64.exe -solve p.obf -l d -book-usage off -selectivity 5 -n 1 -eval-file data/eval.dat`。`-solve` は最終反復の値だけを返すため、深さごとに別プロセスで実行する。

## 変更対象
- `bench/parity/`(新設)
  - 固定局面セット: 38局面版と拡大版(上記の json を整理して取り込む)
  - 実行スクリプト
  - 集計スクリプト
  - README

## 要件
1. `python bench/parity/run_parity.py --weights <bin> --engine ours|edax --depths 1-12 --set core38|ext --out <csv>` 相当の CLI。
   - 1局面×1深さごとに CSV に逐次追記する。起動時に既存 CSV を読み、完了済みはスキップする(resume)。
   - 進捗を標準出力に出す。
2. Edax の結果はキャッシュとして CSV に残し、2回目以降は再利用できるようにする(Edax の値は重みに依存しないため)。
3. `python bench/parity/stats_parity.py <ours.csv> <edax.csv>` で次を表示し、JSON でも出力する。
   - 主指標: d=5..12 の同偶奇差 |v(d)−v(d−2)| の平均
   - 偶奇差 |v(d)−v(d−1)| の平均、符号付きの奇数−偶数ギャップ
   - Edax d12 の最善手との一致率(深さ別)、Edax d12 との MAE
   - 当エンジン/Edax の比と、局面ブートストラップによる 95%CI(seed 固定)
4. 現行 `app/public/pattern_v6.bin` で core38 を実行し、T203 の値(同偶奇差 1.82、偶奇差 2.48、ギャップ +2.12)をおおむね再現することを確認する。決定的探索なので、同じビルドなら一致するはず。不一致なら理由を記録する。
5. README に使い方、指標の定義、T203 での基準値を書く。

## やらないこと(スコープ外)
- 評価関数・探索・重みの変更(T205 以降)
- `app/` の変更
- 対局ゲート(`vs_edax.py`)の実行

## 受け入れ基準(検証コマンド)
- [ ] `python bench/parity/run_parity.py --weights app/public/pattern_v6.bin --engine ours --depths 1-12 --set core38 --out <scratch>/ours.csv` が完走する。途中で Ctrl+C して再実行すると、続きから再開する。
- [ ] Edax 側の core38 も同様に完走する。
- [ ] `stats_parity.py` が要件3の指標を出力し、T203 の基準値と比較表を作業ログに記録してある。
- [ ] 指標計算の単体テスト(小さな合成 CSV で期待値と一致)が `python -m pytest bench/parity` でパスする。
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていない。実行結果の CSV は scratchpad に置く。リポジトリに置く場合は `.gitignore` に追加する。
- [ ] 変更対象ファイルのみをパス明示でコミットし、main に push する。

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
