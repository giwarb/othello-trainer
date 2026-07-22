# T192: Logistello book 検証資産

[Logistello](https://skatgame.net/mburo/log.html)(Michael Buro作、今日でも最強クラスの
オセロAIの一つ)の自己対戦棋譜集(book skeleton)を、本エンジンの終盤ソルバー・
評価関数の**独立した第三者検証資産**として取り込んだもの。学習データとしては使わない。

- 出典: <https://skatgame.net/mburo/log.html>
- アセット: `logbook.wtb.gz`(WTHOR形式、約3.7万自己対戦ライン)
- ライセンス: GPL(同ページに記載の配布条件どおり)
- サイトの記載: "All ~37K lines are at least 24-ply WLD correct."
  (本タスクでは「24空き(残りマス24)まで」の意味として扱う。詳細は
  `t192_verification_report.md`)

## 生データを一切コミットしない方針

本リポジトリの一貫方針に従い、以下はコミットしない(`.gitignore`対象):

- `data/logbook.wtb.gz` / `data/logbook.wtb`(生データ、`download-logbook.ps1`で都度取得)
- `data/logistello_24empty_positions.json`(全件抽出JSON、
  `train::bin::logistello_extract`で都度再生成。数万局面規模のため)
- `verify-results/`(照合ハーネスのresumableチェックポイント)

コミット対象は、固定シードでサンプリングした100局面のcuratedセットと
その照合結果サマリのみ。

## 使い方

```powershell
# 1. 生データを取得(再実行安全、都度公式サイトから取り直す)
./bench/logistello/download-logbook.ps1

# 2. 全ラインの24空き時点局面を抽出(全件JSON、コミット対象外)
cargo build --release -p train --bin logistello_extract
./target/release/logistello_extract.exe `
  --input bench/logistello/data/logbook.wtb `
  --out bench/logistello/data/logistello_24empty_positions.json

# 3. 固定シードで100局面をサンプリング(コミット対象のcuratedセットを生成)
python bench/logistello/select_sample.py

# 4. eval_cli solve(フルウィンドウ・完全読み)で照合(局面単位チェックポイント+resume)
cargo build --release -p engine --bin eval_cli
python bench/logistello/verify_wld.py run
python bench/logistello/verify_wld.py report
```

## ファイル一覧

| ファイル | コミット | 内容 |
|---|---|---|
| `download-logbook.ps1` | ○ | 生データDL+gzip展開+sha256表示 |
| `data/` | × (.gitignore) | 生データ・全件抽出JSON |
| `logistello_wld_sample_positions.json` | ○ | 固定シード層化サンプリングした100局面(24空き) |
| `logistello_wld_sample_labels.json` | ○ | 上記のtheoreticalScore由来ラベル(仮説付き、`verify_wld.py`で検証) |
| `select_sample.py` | ○ | 全件抽出→100局面curatedセットの生成スクリプト |
| `verify_wld.py` | ○ | eval_cli solveによる完全読み照合ハーネス(チェックポイント+resume) |
| `verify-results/` | × (.gitignore) | 照合の生チェックポイント |
| `verify_summary.json` | ○ | 照合結果の集計(小さいサマリのみ) |
| `t192_verification_report.md` | ○ | 抽出統計・照合結果・`theoreticalScore`の意味の結論 |

抽出ツール本体(`train/src/bin/logistello_extract.rs`)は`train`クレート配下。
既存のWTHOR学習パイプライン(`train/data/`, `bookgen/`)とは目的・ディレクトリとも
分離している(本資産は学習データ化しない)。
