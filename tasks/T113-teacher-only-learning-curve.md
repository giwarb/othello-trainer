---
id: T113
title: teacher-only学習曲線(同一トレーナー内の密度勾配計測)
status: done # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T113: teacher-only学習曲線

## 目的

T112で「同一45k局面でもoutcomeラベルは3.6〜3.8石と最悪 → 密度(局面数)が主因」という推定が得られたが、代替レビューが指摘したとおり **v2×WTHOR(103万件、1.57石)との比較は別トレーナー間で交絡が6軸ある**。この限定を潰すため、**同一トレーナー内**で「teacher-only(=T112で45k最良だった2.8石の構成)の学習曲線」を計測し、密度の勾配を直接測る。

- **teacher-onlyの曲線がデータ量とともに明確に改善**(T109のbaseline曲線=フラットとは対照的) → 密度仮説が同一トレーナー内で確認され、**200k+コーパス(teacher-only損失で)の投資判断が復活**。外挿から必要量も見積もれる。
- **teacher-onlyの曲線もフラット** → 密度でも損失でもない残余(局面分布の質・トレーナー設定)が焦点になる。

**本タスクは分析実験。採否判定はしない。** どちらの結果も正常な完了。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック+検証強化。**別ワーカーがT105(終盤ソルバー、NPS計測あり)を並行実行中**のため:
- 全処理を直列・低負荷・**フォアグラウンドのみ**(バックグラウンド起動禁止)。時間計測は判定に使わない。

## 背景・既存資産(必読)

- `tasks/T109-distillation-learning-curve.md` — baseline mixでの学習曲線(フラットだった)。**本タスクはこのmix違い再実行であり、サブセット基盤(`--train-subset-size`、入れ子層化、subset-seed=42)をそのまま使う**。
- `tasks/T112-label-loss-ablation.md` — teacher-only(2.8石)の位置づけと、oracle計測のM2ガード運用。
- `tasks/T111-v3-wthor-robustness.md` — oracle行再利用スクリプト(SHA整合ガード付き)の作法。
- 実装は既に全部ある: `train/src/t090_distillation.rs`(teacher-only mix、subset機能)、`bench/edax-compare/compare_pattern_v3.py`。**コード変更は原則不要のはず**(必要になったら理由を作業ログに書いて最小限で)。

## 要件

1. **学習**: teacher-only mix × サイズ {6250, 12500, 25000, full} × seeds 1,2,3(T109と同じ入れ子サブセット、subset-seed=42、pattern-set v2既定、`train/data/t113/`)。
2. **oracle計測(T096 60局面、主指標)**: 各サイズの代表seed1(+端点6250/fullでもう1seed)。full-seed1はT112のteacher-only seed1と同一重みになるはず(サブセット無し・同一seed) — **SHA-256一致を確認できれば再計測不要でT112実測(2.8)を流用**。各計測でM2ガード(v2行=1.5667の完全再現)。
3. **記録**: results.tsv(train/val teacher MAE・frozen agreement・oracle regret)、T109のbaseline曲線との対比表、log-linear回帰(傾き・R²)と200k/1M外挿。
4. **長時間実行ルール**: 逐次保存・resume・進捗ログ・節目ごとの作業ログ追記。

## やらないこと(スコープ外)

- 200kコーパス生成の実行(本タスクは投資判断の材料集めまで)
- 混合比チューニング・v3との組み合わせ・ステージ解像度実験
- 採否判定・アプリ配線・NPS計測

## 受け入れ基準(検証コマンド)

- [ ] teacher-only 4サイズ×3seedsが完走し `train/data/t113/` にmetrics.tsv・summaryがある
- [ ] oracle計測(計画した点)が完走し、M2ガード記録が作業ログにある
- [ ] 作業ログに「サイズ×指標」の表、baseline曲線(T109)との対比、傾き・R²・200k/1M外挿がある
- [ ] コード変更が発生した場合のみパス明示でコミット(データ非コミット)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 実装調査・学習run完了(進捗チェックポイント)

**事前調査**: T109(baseline学習曲線・subset基盤)、T112(teacher-only=2.8石の位置づけ、M2ガード運用)、T111(oracle再利用スクリプトの作法)を読了。`train/src/t090_distillation.rs`に`teacher-only`mix・`--train-subset-size`/`--subset-seed`が既に実装済みであることを確認。**コード変更は不要**(`cargo build --release -p train --bin train_distillation`は無変更でビルド成功)。

実行開始時の`git status --short`: `engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs` `tasks/T105-endgame-incremental-state.md`のみ(T105並行WIP由来、本タスクとは無関係)。

**学習run(4サイズ×3seed、teacher-only mixのみ、subset-seed=42固定、直列・フォアグラウンド)**:

コマンド: `./target/release/train_distillation.exe --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t113/subset-<N> --mixes teacher-only --seeds 1,2,3 --train-subset-size <N> --subset-seed 42 --reference-weights train/weights/pattern_v2.bin --jobs 1`(N∈{6250,12500,25000}、fullは`--train-subset-size`省略)。4コマンドを順に実行、全12run完走(合計2分未満)。`train/data/t113/subset-{6250,12500,25000,full}/teacher-only-seed-{1,2,3}/`に`metrics.tsv`・`result.tsv`が生成された。実測train件数はT109と同一(6245/12494/24994/45055)。

**SHA-256一致確認(full-seed1/seed2がT112teacher-onlyと同一重みという想定の検証)**:
- `train/data/t113/subset-full/teacher-only-seed-1/final.bin` = `5145ae126cc6b1aa7ae6dbc99d7a538a012e0c7656124a6fe0efe94e95344d84` = `train/data/t090b/primary-redo1-v2/teacher-only-seed-1/final.bin`と**完全一致**。T112がこの重みでoracle計測済み(`train/data/t112/oracle/teacher-only-seed-1.json`、candidate meanRegret=2.8)のため、**full-seed1のoracle再計測は不要でT112実測値(2.8)を流用**。
- `train/data/t113/subset-full/teacher-only-seed-2/final.bin` = `479ed4d0ef2cadad0aa70f9c2b4c4272c24d584437a14c33b1821e806eababc8` = `train/data/t090b/primary-redo1-v2/teacher-only-seed-2/final.bin`と**完全一致**。ただしT112はteacher-only seed2のoracleを計測していない(T112はseed1のみ)ため、**full-seed2は新規oracle計測が必要**。
- `train/data/t113/subset-full/teacher-only-seed-3/final.bin` = `4e997a3ba603f4cb0b3ef938c025b2e6a848d050c4d36e60bae32c11876e3307`(T090bに対応する既存重みなし、subset-full系列の3本目として新規生成)。oracle計測はseed1/seed2の代表2点で計画通り(seed3は要件外)。

**サイズ×in-corpus指標の表**(best epoch時点):

| サイズ(実測) | seed | train MAE | val MAE | frozen agreement | frozen regret(in-corpus) | wthor_2024 MAE |
|---|---:|---:|---:|---:|---:|---:|
| 6245 | 1 | 2.5099 | 9.7285 | 0.2661 | 9.7223 | 17.2016 |
| 6245 | 2 | 2.4707 | 9.7283 | 0.2641 | 9.7541 | 17.1970 |
| 6245 | 3 | 2.5639 | 9.7312 | 0.2645 | 9.7289 | 17.2071 |
| 12494 | 1 | 3.6027 | 8.8690 | 0.2843 | 9.2421 | 16.5389 |
| 12494 | 2 | 3.5245 | 8.8651 | 0.2831 | 9.3238 | 16.5283 |
| 12494 | 3 | 3.9087 | 8.8933 | 0.2827 | 9.2537 | 16.5807 |
| 24994 | 1 | 3.9359 | 8.1208 | 0.3033 | 8.8180 | 15.9090 |
| 24994 | 2 | 3.8358 | 8.1182 | 0.3048 | 8.7742 | 15.9008 |
| 24994 | 3 | 4.1742 | 8.1371 | 0.3025 | 8.7607 | 15.9332 |
| 45055(全量) | 1 | 4.4990 | 7.6106 | 0.3133 | 8.2517 | 15.4458 |
| 45055(全量) | 2 | 4.4762 | 7.6099 | 0.3129 | 8.2684 | 15.4436 |
| 45055(全量) | 3 | 4.4496 | 7.6085 | 0.3133 | 8.2374 | 15.4413 |

in-corpus指標(val teacher MAE 9.73→8.88→8.12→7.61、frozen agreement 0.265→0.283→0.303→0.313、frozen regret 9.73→9.27→8.78→8.25)はT109のbaseline曲線と同様、データ量に対して滑らかに単調改善している(学習パイプライン自体は正常動作)。

次: oracle計測(6250-seed1/seed2, 12500-seed1, 25000-seed1, full-seed1[流用], full-seed2[新規])を計画通り実行し、M2ガードを確認する。

### 2026-07-16 T096 60局面oracle regret計測完了・M2ガード・回帰・外挿・結論

**手順**: T109/T111/T112を踏襲。scratchpad一時スクリプト`t113_seed_oracle_state.py`(非コミット、リポジトリ外)を新規作成。**T112が遭遇したガード不一致(gitTree/evalCliSha256がT104/T105の並行ビルドで変化)を教訓に、最初から「候補seed(6250-seed1)をフルスクラッチで1本計測し、以後の4本はその同一実行内で得たoracleRows/v2 rowsを使い回す」方式**を採用した(T112のようにT090b由来の古いidentityから種付けしようとして不一致で弾かれる事態を回避)。スクリプトはcandidateSha256以外の全フィールド(schema/depth/gitTree/v2Sha256/evalCliSha256/edaxSha256/edaxEvalSha256/corpusSha256)が種元と完全一致することを確認し、1つでも不一致なら例外で中止するガードを実装(T111/T112と同一方針)。

1. **6250-seed1(フルスクラッチ)**: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t113/subset-6250/teacher-only-seed-1/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t113/oracle/subset-6250-seed1.json`。**M2ガード: v2 meanRegret = 1.5666666666666667(1.5667石)を完全再現。PASS**。candidate meanRegret = **3.8333333333333335**。
2. **6250-seed2 / 12500-seed1 / 25000-seed1 / full-seed2(種付け+resume)**: `t113_seed_oracle_state.py`で6250-seed1のoracleRows/v2 rowsを新candidateSha256へコピー(4回とも種付け時にガード一致を確認)、同じ`compare_pattern_v3.py`コマンドで候補60件のみ新規Edax計測。4本とも**M2ガードPASS**(v2=1.5666666666666667)。candidate meanRegret: 6250-seed2=**3.8333333333333335**(6250-seed1と完全同値)、12500-seed1=**3.533333333333333**、25000-seed1=**2.966666666666667**、full-seed2=**2.8**。
3. **full-seed1(SHA一致による流用、新規計測なし)**: `train/data/t113/subset-full/teacher-only-seed-1/final.bin`のSHA-256(`5145ae12...`)が`train/data/t090b/primary-redo1-v2/teacher-only-seed-1/final.bin`と完全一致(同一コーパス・同一seed・サブセット無しなので理論通り)。この重みはT112で既にoracle計測済み(`train/data/t112/oracle/teacher-only-seed-1.json`)のため**再計測せずT112実測値を流用**。T112ファイルの`v2Sha256`(現在と一致)・`candidateSha256`(T113のfull-seed1と一致)を確認し、rowsから独立再計算してv2=1.5666666666666667(M2ガード相当、T112時点で既にPASS確認済み)・candidate=2.8を再確認した。
4. **full-seed2との整合性確認**: full-seed1(流用、2.8)とfull-seed2(新規計測、2.8)が完全一致し、60局面という限定サンプルでの既知パターン(depth-8静的評価argmaxが複数seedで一致しうる、T110/T112で観測済み)を再現している。teacher-only構成が2シード間で安定していることの傍証。

**M2ガード記録(全計測、v2 meanRegret=1.5666666666666667の完全再現)**:

| oracle計測 | v2 meanRegret | 判定 |
|---|---:|---|
| subset-6250-seed1(新規) | 1.5666666666666667 | PASS |
| subset-6250-seed2(新規) | 1.5666666666666667 | PASS |
| subset-12500-seed1(新規) | 1.5666666666666667 | PASS |
| subset-25000-seed1(新規) | 1.5666666666666667 | PASS |
| full-seed2(新規) | 1.5666666666666667 | PASS |
| full-seed1(T112流用、`train/data/t112/oracle/teacher-only-seed-1.json`) | 1.5666666666666667(T112実測、独立再計算で再確認) | PASS |

**中止判定なし(6計測すべてPASS)。**

**サイズ×指標の全体表(oracle regret列を追加、in-corpus指標は上記チェックポイントと同一)**:

| サイズ(実測) | seed | val teacher MAE | frozen agreement | frozen regret(in-corpus) | oracle regret(独立60局面) | 出所 |
|---|---:|---:|---:|---:|---:|---|
| 6245 | 1 | 9.7285 | 0.2661 | 9.7223 | 3.8333 | 新規計測 |
| 6245 | 2 | 9.7283 | 0.2641 | 9.7541 | 3.8333 | 新規計測 |
| 6245 | 3 | 9.7312 | 0.2645 | 9.7289 | (未測定) | - |
| 12494 | 1 | 8.8690 | 0.2843 | 9.2421 | 3.5333 | 新規計測 |
| 12494 | 2 | 8.8651 | 0.2831 | 9.3238 | (未測定) | - |
| 12494 | 3 | 8.8933 | 0.2827 | 9.2537 | (未測定) | - |
| 24994 | 1 | 8.1208 | 0.3033 | 8.8180 | 2.9667 | 新規計測 |
| 24994 | 2 | 8.1182 | 0.3048 | 8.7742 | (未測定) | - |
| 24994 | 3 | 8.1371 | 0.3025 | 8.7607 | (未測定) | - |
| 45055(全量) | 1 | 7.6106 | 0.3133 | 8.2517 | **2.8000** | T112流用(SHA一致) |
| 45055(全量) | 2 | 7.6099 | 0.3129 | 8.2684 | **2.8000** | 新規計測 |
| 45055(全量) | 3 | 7.6085 | 0.3133 | 8.2374 | (未測定) | - |
| v2参照 | - | - | 0.3683 | 5.7634 | 1.5667 | T096実測流用 |

summary: `train/data/t113/results.tsv`(gitignore領域、上表と同一データ)。

### T109 baseline曲線との対比(同一トレーナー・同一subset基盤、mixのみ違う)

| サイズ | baseline(T109)oracle regret | teacher-only(T113)oracle regret | 差(baseline − teacher-only) |
|---:|---:|---:|---:|
| 6250 | 3.0667(seed1) | 3.8333(seed1) | -0.7667 |
| 12500 | 4.4000(seed1) | 3.5333(seed1) | +0.8667 |
| 25000 | 2.7000(seed1) | 2.9667(seed1) | -0.2667 |
| 45055(full) | 3.4667(seed1/2) | 2.8000(seed1/2) | +0.6667 |

サイズ点ごとの単純差は符号が一定しない(6250はteacher-onlyの方が悪い、45055はteacher-onlyの方が良い)が、**傾向(曲線の形)がまったく異なる**: baselineは6.25k→45kの7倍のレンジで増減が不規則(3.07→4.40→2.70→3.47、傾き-0.188・R²≈0.009=実質フラット/ノイズ支配)なのに対し、teacher-onlyは**単調に一貫して改善**する(3.83→3.53→2.97→2.80)。

### log-linear回帰(4点、6245/12494/24994/45055のseed1代表値)と外挿

x = log10(サイズ)、y = oracle regret として最小二乗回帰:

| サイズ | log10(サイズ) | oracle regret(seed1) |
|---:|---:|---:|
| 6245 | 3.79553 | 3.83333 |
| 12494 | 4.09670 | 3.53333 |
| 24994 | 4.39784 | 2.96667 |
| 45055 | 4.65374 | 2.80000 |

回帰式: **regret ≈ 8.7071 − 1.2804 × log10(サイズ)**、**決定係数 R² = 0.9714**(baselineのR²≈0.009とは対照的に、データ量で分散のほぼ全て(97%)が説明される強い線形トレンド)。

外挿:
- **200,000局面**: log10(200000)=5.30103 → 予測regret ≈ **1.92石**(v2の1.5667石に肉薄)。
- **1,000,000局面**: log10(1000000)=6.0 → 予測regret ≈ **1.02石**(v2の1.5667石を下回る予測。ただしフィット範囲(6.25k〜45k)を1桁以上外挿しており、この点での信頼性は保証されない)。

検算コマンド: `python3`でxs=[log10(6245),log10(12494),log10(24994),log10(45055)]、ys=[3.8333333333333335,3.533333333333333,2.966666666666667,2.8]から最小二乗法で`slope=-1.2804122510744396, intercept=8.707099674807827, R^2=0.9714339118507755`を算出し、200k/1M地点を代入して再現(作業ログの数値と一致)。

### 密度仮説への含意(解釈候補、判定はオーケストレーター)

1. **T112の限定(別トレーナー間の6軸交絡)は本タスクで解消された**: T112はv2×WTHOR(103万件、別トレーナー・別特徴量スケール等)との比較だったが、本タスクは**同一トレーナー(t090_distillation.rs)・同一mix(teacher-only)・同一subset基盤(入れ子層化、subset-seed=42)**で局面数だけを変えており、交絡を最小化した直接比較になっている。
2. **teacher-onlyの曲線は明確にデータ量とともに改善し(単調減少・R²=0.97)、baselineのフラットな曲線(R²≈0.009)と対照的**である。これは「T112で示唆された密度仮説(局面数を増やせば改善する)」が**teacher-onlyラベル(Edax深読み値のみ、outcome/rankingを含まない)に限っては同一トレーナー内で確認された**ことを意味する。
3. **200k外挿(1.92石)はv2水準(1.5667石)にかなり近づくが届かない予測**であり、1M外挴(1.02石)はv2を上回る(regretが小さい)予測になるが、フィット範囲を大きく超える外挿のため過信は禁物(R²が高いのは4点のみでの当てはまりであり、非線形な収束(漸近線)の可能性を排除できない)。
4. **teacher-only(2.8石@45k)はbaseline(3.4667石@45k)より明確に良い**(T112の比較表でも同じ序列: teacher-only < no-ranking < baseline < outcome-only)。密度を増やす投資と合わせて、**損失をteacher-only寄りに寄せる(rankingやoutcome項の重みを下げる)方向も同時に効く可能性が高い**——密度と損失は排他的な仮説ではなく、両方が効く複合的な構造だと考えられる(T112の結論とも整合)。
5. **200kコーパス投資の判断材料**: 「teacher-onlyの損失で200kコーパスを学習すればv2に近い水準(regret 1.9〜2.0石程度)まで改善する可能性が高い」という定量的な見積りが得られた。ただしこれは4点・60局面oracleという小標本からの外挿であり、実際に200kコーパスを生成して検証する前の仮説に留まる。

### 検証コマンド一覧

- 学習: `train_distillation.exe --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t113/subset-<N> --mixes teacher-only --seeds 1,2,3 --train-subset-size <N> --subset-seed 42 --reference-weights train/weights/pattern_v2.bin --jobs 1`(N∈{6250,12500,25000}、fullは`--train-subset-size`省略)。
- oracle計測(フルスクラッチ、1件目): `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t113/subset-6250/teacher-only-seed-1/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t113/oracle/subset-6250-seed1.json`。
- oracle計測(2件目以降、種付け+resume): scratchpad一時スクリプト`t113_seed_oracle_state.py`(非コミット)でoracleRows/v2 rowsを新candidateSha256へコピーしてから同一`compare_pattern_v3.py`コマンドで候補行のみ計測。
- 独立再集計: `python3`で`train/data/t113/oracle/*.json`および`train/data/t112/oracle/teacher-only-seed-1.json`の`results[].rows[].regret`から直接meanRegretを再計算し、本文記載値と完全一致することを確認(自己参照ではなく生データからの独立集計)。
- 回帰・外挿の検算: 上記python3スニペット(最小二乗法の手計算と一致)。

### 中断からの再開(resume)の動作説明

学習run側は既存のepoch単位checkpoint/resume機構(T090b/T095/T109から無変更)がそのまま効く。oracle測定側は`compare_pattern_v3.py`の局面単位atomic checkpoint(`oracleRows`→`v2`行→`candidate`行の順に1件ずつ追記・都度書き込み)がそのまま効く。本タスク実行中に実際の中断は発生しなかったが(全12run+6oracle計測を合計10分未満で完走)、`progress.log`(`train/data/t113/progress.log`、gitignore領域)に各フェーズの開始時刻を逐次記録しており、機構自体は既存タスク(T109/T111/T112)で実地確認済みのため中断時も同一パスの再実行で継続可能。

### コミット対象・スコープ外差分

- **コード変更なし**: `train/src/t090_distillation.rs`は無変更(teacher-only mix・subset機能は既にT109/T112で実装済み)。**コミット対象のコード変更が発生しなかったため、コミットは行っていない。**
- `train/data/t113/`(学習run成果物・oracle計測結果・results.tsv・progress.log)は`train/data/`のgitignore対象のためコミット対象外(`git check-ignore -v`で確認済み)。
- 一時ファイル: scratchpad(`t113_seed_oracle_state.py`)のみで、リポジトリ内には作成していない。
- 実行終了時点の`git status --short`: `engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs` `tasks/T105-endgame-incremental-state.md`のみ(すべてT105由来、本タスクでは一切変更していない)。T113由来の差分・未追跡ファイルは残存していない。

**結論**: 本タスクは分析実験であり採否判定は行わない。上記の通り「teacher-only損失に限れば同一トレーナー内で密度仮説が支持される(R²=0.97の単調改善)」という結果が得られ、baselineのフラット曲線(T109)との対照が明確になった。200kコーパス生成への投資判断はオーケストレーターの判断に委ねる。
