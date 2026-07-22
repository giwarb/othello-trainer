# T192: Logistello book 検証資産化レポート

ステータス: **抽出・サンプリング完了、完全読み照合フェーズは待機中**
(オーケストレーターの指示により、Edax速度・対局計測でのマシン専有を優先するため、
`verify_wld.py run` によるバッチ完全読みは本レポート作成時点では未実行)。

## 1. 形式確認(最初の関門)

`https://skatgame.net/mburo/logbook.wtb.gz` をダウンロード・gzip展開すると
`logbook.wtb`(2,564,228バイト)が得られる。ヘッダ16バイトを読むと:

| フィールド | 値 |
|---|---|
| 作成日 | 1999-12-05 |
| N1(ゲーム数) | 37709 |
| N2 | 0(ゲームアーカイブ) |
| 対象年 | 1999 |
| P1(盤サイズ) | 0(= 8x8) |
| P2(種別) | 0(通常) |
| P3(深さ) | 0 |

本体長 `2564228-16=2564212` バイトは `37709*68` と一致し、
`train::wthor::parse` の検証(N2=0, P1∈{0,8}, N1×68==本体長)をそのまま通った
(`cargo build --release -p train --bin logistello_extract` でのビルド・実行成功、
`cargo test -p train` 全件パスで確認)。**`train/src/wthor.rs` 本体の変更は不要だった。**

なお `P3(深さ)` が `0` であり、公式FFOアーカイブ(WTH_2023/2024.wtb、P3=24)とは異なる。
Logistelloのbook生成ツールはこのヘッダフィールドを埋めていないとみられ、
「24空きまでWLD検証済み」という保証は、このヘッダ値ではなくダウンロードページの
記載(`https://skatgame.net/mburo/log.html`)由来である。

## 2. `theoretical_score` の意味(実データでの確認)

37709ライン全件について `theoretical_score`(1バイト)と `black_disc_count`
(実測終局黒石数、1バイト)を比較した結果、**全件で完全一致**した
(`equal count 37709 / diff count 0`、値域は10〜60)。

これは以下を強く示唆する:

- `theoretical_score` は「黒の最終石数」(0..64スケール、`black_disc_count`と同一定義)であり、
  石差(diff、-64..64)でも「diff+64」エンコーディングでもない
  (後者ならこの値域・完全一致は起こりにくい)。
- 本bookの全ラインは、実際に打たれた対局がそのまま「理論値」と一致している。
  すなわち Logistello の自己対戦は 24空き以降を(ダウンロードページの主張どおり)
  一貫して最適継続しており、対局の最終結果がそのまま「24空き局面の完全読みスコア」
  として使える。

**結論(仮説、`verify_wld.py`による完全読み照合で最終確認する)**:
24空き局面(手番 `side_to_move`)における完全読みスコア(手番視点、石差)は

```
black_diff = 2 * theoretical_score - 64
expectedScoreSideToMove = black_diff            (side_to_move == black のとき)
                         = -black_diff           (side_to_move == white のとき)
```

この仮説はまだ `eval_cli solve` による実測と突き合わせていない(次節参照)。

## 3. 抽出統計

`train::bin::logistello_extract`(`--input bench/logistello/data/logbook.wtb`)の結果:

| 項目 | 件数 |
|---|---|
| 総ライン数 | 37,709 |
| 24空きに届かずスキップ(`moves.len()<36`) | 0 |
| 再生エラーでスキップ | 0 |
| 36手再生後の空きが24でない(データ異常防御) | 0 |
| 重複(盤面+手番の完全一致)除去 | 9,539 |
| **抽出ユニーク局面数** | **28,170** |

全ラインが57〜60手(60マス埋まる想定)持っており、24空き抽出でスキップが
発生しなかったのは想定どおり(各着手は必ず1マスを埋めるため、36手再生後は
必ず空き24になる不変量による)。

## 4. curatedサンプル(100局面)

`bench/logistello/select_sample.py`(固定シード文字列 `"logistello-t192"`、
`random.Random`)で、`theoretical_score`の黒石差符号(`black_win` / `black_loss` / `draw`)
比例配分(最大剰余法、drawは最低5局面保証)により100局面を選定:

| カテゴリ | 母集団(28,170中) | 選定数 |
|---|---|---|
| black_win | 10,988 | 39 |
| black_loss | 11,784 | 42 |
| draw | 5,398 | 19 |

出力: `logistello_wld_sample_positions.json`(局面本体) +
`logistello_wld_sample_labels.json`(`theoreticalScore`由来ラベル、
`expectedScoreSideToMove`/`expectedWldSideToMove`は前節の仮説値、`metadata.verified=false`)。

## 5. 完全読み照合(未実施)

`bench/logistello/verify_wld.py`(`eval_cli solve --alpha -64 --beta 64`、
局面単位チェックポイント`verify-results/t192-checkpoint.json`+resume対応)を実装済み。
オーケストレーターの指示により、Edax速度・対局計測でのマシン専有を優先するため、
本タスクの完全読みバッチ(100局面、1局面あたり数秒〜数十秒見込み)は
**未実行**。マシンが空き次第、以下を実行して本節を更新する:

```powershell
cargo build --release -p engine --bin eval_cli
python bench/logistello/verify_wld.py run
python bench/logistello/verify_wld.py report
```

`report`サブコマンドは `verify_summary.json`(コミット対象、集計のみ)に
`scoreMatchRate` / `wldMatchRate` / カテゴリ別内訳 / 不一致行を書き出す。
不一致が出た場合は原因分析(ラベル定義の解釈違い/データ品質/自前ソルバー疑い)を
追記する(自前ソルバーを疑う場合の反証: FFO終盤問題(#40-49)は全問正解済み)。

## 6. 今後の用途(暫定、照合完了後に確定)

完全読み照合で `expectedScoreSideToMove` の仮説が高一致率(理想的には100%)で
裏付けられれば、この100局面(および必要なら全28,170局面からの追加サンプル)を
「第三者由来・独立の完全読み回帰テスト」として `bench/` 配下のCIまたは定期ベンチに
組み込む候補にできる(既存のFFO終盤問題・T096/T157オラクルセットと並ぶ、
出自の異なる検証資産としての価値がある)。具体的な組み込み方針は照合完了後、
一致率を見てから判断する。
