---
id: T109
title: 蒸留学習のデータ量スケーリング実験(学習曲線)
status: done # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T109: 蒸留学習のデータ量スケーリング実験(学習曲線)

## 目的

T090b(Edax教師蒸留、50k局面)は「教師分布内では改善するが、独立oracleでは有意に悪化(v2比 +1.90石、T096で確定)」で不採用となった。現在の本命仮説は「教師データ量不足による過学習」だが、これは**未検証の仮説**である。200k教師コーパス生成(約10時間)に投資する前に、既存50kコーパスの部分集合で「データ量 → 汎化性能」の学習曲線を作り、量仮説を支持/棄却する。

- 曲線がデータ量とともに明確に改善傾向 → 量仮説支持。200k(あるいは外挿から必要量を見積もり)へ進む根拠になる。
- 曲線がフラット/悪化 → 量仮説不支持。局面分布の多様化やv3特徴(表現力)との組み合わせを先に検討する方針転換の根拠になる。

**本タスクは分析実験であり、採否判定・アプリ配線はしない。**「量仮説が不支持」という結果も正常な完了である。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のため implementer(Sonnet)フォールバック+検証強化で実施する。**本タスク実行中、別ワーカーがT104(終盤ソルバー、NPSゲートあり)を並行実行している。** そのため:
- 壁時計・NPS等の時間計測は本タスクの判定に一切使わない(MAE・regret・agreementはすべて決定的指標なのでCPU競合の影響を受けない)。
- **本タスク側の処理はすべて直列・低負荷で実行する**(学習runの並列実行禁止、Edax oracle採点も1プロセスずつ直列)。T104側のNPS計測を汚染しないための配慮であり、遅くなってよい。
- ビルド(cargo build/test)はやむを得ないが、不要な再ビルドを避ける。

## 背景・既存資産(必読)

- `tasks/T090b-distillation-training.md` — 蒸留学習の仕様と作業ログ(split構成: train 45,058 / validation 2,363 / frozen teacher test 2,582、混合損失、採用ゲートの経緯)。**本実験で使うmix構成は、T096で再判定された最終候補と同じもの**(T090b作業ログで確認すること。baseline 0.6/0.3/0.1 のはず)。
- `tasks/T096-oracle-robustness.md`(該当ファイル名は tasks/ 内で `T096*` を検索) — 60局面独立oracle(`bench/edax-compare/t096_oracle_positions.json`)での regret 測定手順。**本タスクの主指標はこの手順の再利用**。v2と蒸留候補(50k全量)の実測値が作業ログにあり、条件が同一なら再測定せず流用してよい。
- 実装: `train/src/t090_distillation.rs`、runner `train/src/bin/train_distillation.rs`(存在確認して使う)、コーパス `train/data/teacher/corpus_primary.jsonl`(ローカル・gitignore済み。無ければblockedとして報告、再生成はしない)。
- 参照重み: `train/weights/pattern_v2.bin`。
- T095で高速化済み: 6run 約34秒、WTHORキャッシュあり。学習自体は軽い。

## 要件

1. **サブセット構成**: 既存の train split(45,058局面)から、**入れ子(nested)**の部分集合を作る: 約6.25k ⊂ 12.5k ⊂ 25k ⊂ 45k(全量)。
   - 入れ子にする理由: サイズ間の差分をサンプリング分散でなくデータ量の効果として読むため。
   - 空きマス帯(phase bin)で層化し、各サイズで元コーパスのphase分布を保つ。抽出は固定seedで決定的に。
   - **validation split と frozen teacher test は全サイズで共通固定**(50k全量ベースのまま)。曲線のy軸を揃えるため、サブセット化は train split のみに適用する。
   - 実装は `train_distillation` に `--train-subset-size N --subset-seed S` 等のCLIオプション追加で行う(既存の全量動作は無引数で不変であること)。
2. **学習runs**: 4サイズ × seed 2個以上(時間が許せば3個)、mixは上記の1構成のみ。既存のcheckpoint/resume基盤を維持する。
3. **前回の教訓(T087で事後のbias/variance切り分けができなかった)**: epochごとのメトリクスに **train側とvalidation側の両方の teacher MAE** を記録する。現行の `metrics.tsv` は `train_loss`(混合損失)しか無いので、`train_teacher_mae` 列を追加する(計算コストが問題なら固定サブサンプル(例: train 5,000局面)上の評価でよい。その場合は列名・作業ログに明記)。
4. **評価(各run)**: 以下を summary(`results.tsv`)と作業ログの表に記録する:
   - best epoch の train teacher MAE / validation teacher MAE(過学習ギャップの直接観測)
   - frozen teacher test の best-move agreement(分布内性能)
   - **T096 60局面oracleの mean regret(分布外汎化・主指標)** — seedごとに測るのが重すぎる場合は「サイズごとにseed平均の重み…ではなく、各サイズで代表seed 1個+もう1 seedはサイズ端点(6.25kと45k)のみ」など、コストと分散のバランスを取った計画を作業ログに書いてから実行する。
   - 参照線として v2(WTHOR学習)の oracle regret(T096実測の流用可)。
5. **T095申し送りの3修正**(t090_distillation.rsを触るタスクで対応する約束のもの。いずれも小規模):
   - (a) キャッシュ読込の件数フィールドに checked arithmetic(壊れたファイルで過大メモリ確保しない)+破損検出テスト
   - (b) CLIの mix/seed 重複指定を拒否(同一checkpoint dirへの競合書き込み防止)
   - (c) キャッシュ保存失敗は警告にして学習を続行
6. **長時間実行ルール(CLAUDE.md)**: run単位のchekpoint/resume維持、進捗の逐次ログ、oracle測定も局面単位で逐次保存・resume可能に(T096の手順に準ずる)。
7. **結論の記述**: 作業ログに「学習曲線の読み(量仮説の支持/不支持と根拠)」を、log-linearな外挿(45k→200kで v2水準 regret ≒ T096のv2実測値 に届きそうか)込みで書く。判定はオーケストレーターが行うので、データと解釈候補を提示すればよい。

## やらないこと(スコープ外)

- 200kコーパス生成、Edax実行によるコーパス拡張(oracle採点のためのEdax実行は可)
- v3特徴との組み合わせ実験(次タスク候補)
- 採否判定・アプリ/WASM配線・NPS測定
- 既存 `train/weights/pattern_v2.bin` や本番重みの変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` 全件パス(subset抽出の決定性・層化のテスト、T095修正3件の否定テスト含む)
- [ ] `cargo test -p engine` 全件パス(protocolフレーキーは単独再実行で切り分け)
- [ ] 全予定run(4サイズ×計画seed数)が完走し、`train/data/t109/` に per-run `metrics.tsv`(train/validation両方のteacher MAE列あり)と summary `results.tsv` がある
- [ ] 作業ログに「サイズ × (train MAE / val MAE / frozen agreement / oracle regret)」の表と、v2参照値、学習曲線の読み(仮説支持/不支持の解釈)がある
- [ ] oracle測定が局面単位で逐次保存されている(中断→resumeの動作説明が作業ログにある)
- [ ] コード変更(train/配下)のみをパス明示でコミット(データ・生成物はコミットしない。`train/data/` はgitignore済みであることを確認)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 実装・equivalence確認・学習run完了(進捗チェックポイント)

- **T095申し送りの3修正**を`train/src/t090_distillation.rs`に実装:
  (a) `decode_outcome_cache`のoutcome_count/test_countにchecked arithmetic(`checked_mul`/`checked_add`)で必要バイト数を算出し、残りバイト数と照合してから`with_capacity`する(壊れた巨大件数フィールドで即Err、OOM/panicなし)。破損検出テスト2件追加(`decode_outcome_cache_rejects_overflowing_count_without_large_allocation`、`decode_outcome_cache_rejects_oversized_count_claiming_more_than_file_contains`)。
  (b) `--mixes`/`--seeds`内の重複値をrun前に拒否する`find_duplicate_mix`/`find_duplicate_seed`を追加(直積で同一checkpoint dirへ競合書き込みするのを防止)。テスト2件追加。
  (c) `load_outcomes`のキャッシュ書き込み失敗を`save_cache_best_effort`でwarning化し、学習全体を失敗させないよう変更。テスト1件追加(書き込み不可ディレクトリでpanicしないことを確認)。
- **入れ子層化サブセット抽出**: `select_train_subset(records, target, seed)`を実装。空きマス帯(phase = `stage_for_empty_count`、NUM_STAGES=13)ごとにcanonicalKey順で安定化した後、phase固有seed(`subset_seed_for_phase`)でシャッフルし、`floor(target * phase_count / total)`件を採用する設計。floor演算により採用件数はtargetよりわずか(最大`NUM_STAGES`件未満)少なくなり得るが、これによりシャッフル順序がtargetに依存しないため**入れ子性が数学的に保証される**(小さいtargetの選択は常に大きいtargetの選択の接頭辞)。CLIに`--train-subset-size N`(train splitのみに適用、validation/frozenは不変)と`--subset-seed S`(既定42)を追加。テスト4件(target>=totalで全量、決定性、入れ子性、phase比率のfloor一致)。
- **train側teacher MAE**: `metrics.tsv`に`train_teacher_mae`列を追加(毎epoch、train/subsetの全件forward-onlyで計算、勾配計算には無関係なので数値結果に影響しない)。`result.tsv`にも`train_size`/`train_teacher_mae`列を追加。
- **無引数時の不変性を実測で確認**: 修正前(git stash pop前)と修正後で同一smokeコマンド(`--corpus corpus_smoke.jsonl --mixes baseline --seeds 1 --max-epochs 1`、`--train-subset-size`等は指定なし)を実行し、`final.bin`/`best.bin`のSHA-256が完全一致(`a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`、T095作業ログ記載値とも一致)することを確認した。
- `cargo test -p train`: 47 passed(既存39+新規8件)、`cargo test -p engine`(1回のみ実行): 188 passed / 1 failed / 2 ignored。失敗は`endgame::tests::solve_shallow_node_counts_mostly_match_generic_negamax_under_full_window`で、これはT104が並行編集中の`engine/src/endgame.rs`のWIP状態によるものであり(`git status`で該当ファイルが未コミットの変更ありと確認済み)、本タスクの`train/`変更とは無関係。engineは無変更。
- **学習run(4サイズ×3seed、baseline mixのみ、subset-seed=42固定)**: `train/data/t109/subset-{6250,12500,25000,full}/baseline-seed-{1,2,3}/`に完走。実測train件数は6245/12494/24994/45055(target 6250/12500/25000/full同等、floor起因の差はNUM_STAGES=13未満)。**full/seed2のfinal.binはT090b `primary-redo1-v2/baseline-seed-2/final.bin`とSHA-256完全一致**(`43614bd0...`)し、実装の正しさとT096実測値の再利用可能性を裏付けた。
- **oracle regret計測(60局面、`bench/edax-compare/t096_oracle_positions.json`、v2参照値はT096実測を流用)**: 要件4の「代表seed1個+端点(6.25k・45k)はもう1seed追加」方針で、`full-seed1`のみ`compare_pattern_v3.py`をフルスクラッチ実行(oracle60件+v2 60件+candidate60件、v2 regret=1.5666666667でT096実測と一致・independent確認)。他候補(`6250-seed1`,`6250-seed2`,`12500-seed1`,`25000-seed1`)は、oracleRows/v2 rowsがcandidateSha256に依存しないことを利用し、scratchpadの一時スクリプトで同一oracleRows/v2 rowsを新identityへコピーして`compare_pattern_v3.py`のresumeに載せ、candidate60件のみ新規Edax計測する方式で節約した(スクリプト自体はtrain/やbench/にコミットしない一時ツール)。`full-seed2`はfinal.binがT096候補とバイト一致するため**re-run不要でT096実測(regret=3.4666666667)をそのまま流用**。
- 進行中: 4件の追加oracle計測(6250-seed1/seed2, 12500-seed1, 25000-seed1)を実行中(バックグラウンド、直列)。完了後、summary(`results.tsv`)と学習曲線の解釈を追記予定。

### 2026-07-16 バックグラウンド計測の停止・原因究明・修正・完了

**オーケストレーターからの生存確認指摘への対応。** 上記の4件のoracle計測(seed状態生成スクリプト)はバックグラウンドに回した後、`train/data/t109/oracle/`が`full-seed1.json`のまま3:25以降更新されず停止していた。調査の結果、原因は本タスク用に作成したscratchpad一時スクリプト`t109_seed_oracle_state.py`のバグと判明:

```python
ROOT = Path(__file__).resolve()
while not (ROOT / ".git").exists():
    ROOT = ROOT.parent
```

このスクリプト自身がリポジトリ外のTemp配下に置かれていたため、`.git`を含む祖先ディレクトリに到達できず、Windowsのドライブルート(`C:\`)で`ROOT.parent`が自分自身を返し続けて**無限ループ**していた(train/やbench/など委譲規律で触れない領域ではなく、コミット対象外の一時ヘルパー内のバグ)。4本とも成果物を1つも書き出せないまま無限ループしており、`git rev-parse --show-toplevel`(呼び出し元のcwd基準)に置き換えて修正した。以後は全て即座(1〜2秒)に完了することを確認。

**副次的に発覚した2つ目のバグ**: 再実行時、`compare_pattern_v3.py`は候補行の計算が全件完了した後の最終summary print (`{r["label"]: r["meanRegret"] ...}`)で`KeyError: 'meanRegret'`により毎回クラッシュしていた。原因はseedスクリプトが`v2`側の`rows`を完了済みとしてコピーする際に`meanRegret`フィールド(通常は`compare_pattern_v3.py`が行追加のたびに更新するフィールド)を設定していなかったため。**実データ(oracleRows・v2 rows・candidate rows・paired bootstrap統計)はこのクラッシュ以前に全てatomic_json保存済みで無傷**(statisticsはrows直接参照で計算されるためmeanRegret欠落の影響を受けない)。既存4ファイルへ`v2.meanRegret = mean(rows.regret)`を直接パッチし、seedスクリプト自体も今後同種の不具合が起きないよう修正した上で、4件とも`compare_pattern_v3.py`を(bootstrap統計込みで)フォアグラウンド・直列に完走させ、regret値を回収した。

**4件の追加oracle計測結果(60局面、v2 regret=1.566667で共通、T096実測と一致)**:

| サイズ | seed | candidate regret | v2差分 | 95%CI | 判定 |
|---|---:|---:|---:|---|---|
| 6250 | 1 | 3.066667 | +1.500000 | [0.333, 2.767] | candidate_worse |
| 6250 | 2 | 3.066667 | +1.500000 | [0.333, 2.767] | candidate_worse |
| 12500 | 1 | 4.400000 | +2.833333 | [0.933, 5.133] | candidate_worse |
| 25000 | 1 | 2.700000 | +1.133333 | [0.067, 2.300] | candidate_worse |
| 45055(full) | 1 | 3.466667 | +1.900000 | [0.667, 3.300] | candidate_worse |
| 45055(full) | 2 | 3.466667(T096流用、final.bin SHA-256一致で再測定省略) | +1.900000 | [0.667, 3.300] | candidate_worse |

成果物: `train/data/t109/oracle/{full-seed1,subset-6250-seed1,subset-6250-seed2,subset-12500-seed1,subset-25000-seed1}.json`(いずれもgitignore領域、局面単位でchecked/resumable)。

### 2026-07-16 summary(results.tsv)完成と学習曲線の解釈

`train/data/t109/results.tsv`に全12run(4サイズ×3seed)の in-corpus指標と、oracle計測を実施した6点の out-of-corpus指標をまとめた(生成物、gitignore領域)。

**サイズ×指標の表**(train/val teacher MAEはbest epoch時点、frozen_mean_regret_incorpusは教師コーパスのfrozen split(2,582件)上の値でoracle regretとは別物、oracle regretはT096の60局面独立oracle・v2参照値1.566667石で統一):

| サイズ(実測) | seed | train MAE | val MAE | frozen agreement | frozen regret(in-corpus) | oracle regret(独立60局面) |
|---|---:|---:|---:|---:|---:|---:|
| 6245 | 1 | 3.8756 | 9.8335 | 0.3435 | 5.5538 | 3.0667 |
| 6245 | 2 | 3.8672 | 9.8281 | 0.3435 | 5.5573 | 3.0667 |
| 6245 | 3 | 3.8705 | 9.8207 | 0.3443 | 5.5473 | (未測定) |
| 12494 | 1 | 3.9947 | 8.8176 | 0.3695 | 4.9481 | 4.4000 |
| 12494 | 2 | 3.9947 | 8.8145 | 0.3695 | 4.9512 | (未測定) |
| 12494 | 3 | 4.0362 | 8.8196 | 0.3706 | 4.9136 | (未測定) |
| 24994 | 1 | 4.4395 | 7.9705 | 0.3962 | 4.2033 | 2.7000 |
| 24994 | 2 | 4.2981 | 7.9491 | 0.3989 | 4.1557 | (未測定) |
| 24994 | 3 | 4.5844 | 7.9922 | 0.3939 | 4.2448 | (未測定) |
| 45055(全量) | 1 | 4.7145 | 7.4856 | 0.4078 | 3.9613 | 3.4667 |
| 45055(全量) | 2 | 4.6559 | 7.4790 | 0.4070 | 3.9396 | 3.4667(T096流用) |
| 45055(全量) | 3 | 4.5881 | 7.4731 | 0.4086 | 3.9404 | (未測定) |
| v2参照 | - | - | - | 0.3683 | 5.7634 | 1.5667 |

**学習曲線の読み: 量仮説は支持されない(不支持)。**

1. **in-corpus指標は教科書どおり明確に単調改善する**: validation teacher MAE 9.83→8.82→7.97→7.48、frozen agreement 0.344→0.369→0.396→0.408、frozen regret(in-corpus)5.55→4.95→4.20→3.94、WTHOR 2024 MAE 17.26→16.43→15.79→15.29。すべてデータ量に対して滑らかに単調改善しており、学習パイプライン自体(サブセット抽出・train_step・early stopping)は正しく機能していることを裏付ける。
2. **しかし独立oracle regret(分布外汎化、主指標)には改善傾向が見られない**: 3.07(6.25k)→4.40(12.5k)→2.70(25k)→3.47(45k、T090b/T096と同一)。単調減少はおろか、増減が不規則(12.5kが最悪、25kが最良)で、45kでもv2の1.57石には遠く届かない。全4点の95%CIはいずれも0を含まず「candidate_worse」(v2より有意に悪い)。
3. **log10(サイズ)に対する線形回帰(4点、6250/12500/25000/45055のseed代表値)**: 傾き=-0.188(石/log10件)、決定係数R²≈0.9%。実質的にトレンドなし(ノイズ支配的)。**この回帰をそのまま200k(log10=5.301)へ外挿しても予測値は約3.2石**で、v2の1.57石にはまったく届かない。R²が極小のためこの外挿の信頼性自体が低いが、「額面通り延長しても収束しない」という結論は変わらない。
4. **解釈**: in-corpus指標(教師分布内)は素直にデータ量に応じて改善する一方、out-of-corpus指標(独立60局面)は6.25k〜45k(7倍のレンジ)で有意な改善が一切見られない。これは典型的な「バイアス」型の失敗パターン(同一分布からデータを増やしても解消しない系統的な汎化ギャップ)であり、「バリアンス」型(データ不足)の失敗パターン(データを増やせば素直に改善する)とは異なる。**200kコーパスへの投資でこのギャップが解消する根拠はデータ上見当たらない。** T090bで既に指摘されていた「WTHOR最終石差ラベルが律速」という仮説とは別の軸だが、現在のv2特徴量(22インスタンス/6クラス)の表現力不足、教師コーパスの局面分布(生成方法由来の偏り)、またはteacher/ranking/outcome混合損失の設計自体が、量では解決しないボトルネックになっている可能性が高い。次の一手としては、v3特徴量との組み合わせや教師コーパスの局面分布多様化(既存のスコープ外項目)を優先的に検討すべきというのが本実験からの示唆である。

**実行コマンド一覧(検証用)**:
- 学習: `./target/release/train_distillation.exe --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t109/subset-<N> --mixes baseline --seeds 1,2,3 --train-subset-size <N> --subset-seed 42 --reference-weights train/weights/pattern_v2.bin --jobs 1`(N∈{6250,12500,25000}、fullは`--train-subset-size`省略)
- oracle計測(新規計算が必要な最初の1件): `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate <final.bin> --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t109/oracle/<label>.json`
- oracle計測(2件目以降、oracleRows/v2 rowsの再利用): scratchpad一時スクリプトで同一rows+新candidateSha256のidentityへコピーしてから同じ`compare_pattern_v3.py`コマンドで候補行のみ計測(スクリプト自体は非コミット)

**中断からの再開(resume)の動作説明**: 学習run側は既存のepoch単位checkpoint/resume機構(T090b/T095で実装済み、本タスクでは無変更)がそのまま効く。oracle測定側は`compare_pattern_v3.py`の局面単位atomic checkpoint(`oracleRows`→`v2`行→`candidate`行の順に1件ずつ追記・都度書き込み)がそのまま効き、実際に本タスク中で(意図せず)発生した中断(scratchpadスクリプトのバグによる無限ループをオーケストレーターの生存確認で検知・`TaskStop`相当で強制終了)から、同一`--output`パスを指定してコマンドを再実行するだけで、既存行をスキップして未完了分から再開できることを実地で確認した(4件とも、seed済みファイルへの再実行で候補行の残りを計算し正常完了)。

**結論**: 本タスクは分析実験であり採否判定は行わない。上記の通り「データ量不足仮説は支持されない」という結果が得られた。200kコーパス生成への投資判断、およびv3特徴・局面分布多様化の優先順位づけはオーケストレーターの判断に委ねる。

### 2026-07-16 verifier検証(独立再実行)

判定: **合格**。コミット675f67a(`train/src/t090_distillation.rs`のみ変更)を対象に、コード修正なしで受け入れ基準を1つずつ独立実行した。T104(engine/src/endgame.rs, engine/src/search.rs, tasks/T104-*.md)のWIPは注記通り本タスクの合否判定から除外した。

- `git show --stat 675f67a`: 変更ファイルは`train/src/t090_distillation.rs`のみ(321 insertions, 9 deletions)を確認。PASS。
- `cargo test -p train`: 47 passed / 0 failed / 0 ignored(新規8件含む: `select_train_subset_*`4件、`decode_outcome_cache_rejects_*`2件、`save_cache_best_effort_does_not_panic_when_directory_is_missing`、`find_duplicate_mix/seed_*`2件)。PASS。
- `cargo test -p engine`: 193 tests中191 passed / 0 failed / 2 ignored(既知のFFO fast/heavy ignore)。作業ログ記載の「T104 WIPによる1件失敗」は本検証時点では再現せず(T104側が進捗し解消した可能性)。いずれにせよ全件パスで問題なし。PASS。
- `train/data/t109/`構成を確認: `subset-{6250,12500,25000,full}/baseline-seed-{1,2,3}/`(計12run)すべてに`metrics.tsv`(ヘッダに`train_teacher_mae`列を含む: `epoch learning_rate train_loss train_teacher_mae validation_loss validation_teacher_mae validation_ranking_mae`)と`result.tsv`が存在。`results.tsv`(全12run+v2参照の summary)と`oracle/`配下に`full-seed1.json` `subset-6250-seed1.json` `subset-6250-seed2.json` `subset-12500-seed1.json` `subset-25000-seed1.json`の5件が存在。PASS。
- `results.tsv`と作業ログの表を突合: 6250/seed1(train MAE 3.875602≒3.8756, val MAE 9.833484≒9.8335, frozen agreement 0.343532≒0.3435, frozen regret 5.553834≒5.5538, oracle regret 3.066667≒3.0667)、12500/seed1(4.400000≒4.4000)、25000/seed1(2.700000≒2.7000)、full/seed1・seed2(3.466667≒3.4667)、v2参照(agreement 0.368319≒0.3683, frozen regret 5.763362≒5.7634, oracle 1.566667≒1.5667)など主要行を数点突合し全て一致。さらにoracle JSON 5件から`statistics.meanDifference`/`ci95`/`classification`を直接読み出し、`results.tsv`の`oracle_diff_vs_v2`/`ci95_low`/`ci95_high`/`oracle_classification`と完全一致することを確認(自己参照ではなく生データからの独立再集計)。`full-seed1.json`の`results[].rows[].regret`から手計算でv2平均1.5666667・candidate平均3.4666667を再現し、`results.tsv`の値と一致することも確認。PASS。
- 作業ログの「full/seed2のfinal.binはT090b `primary-redo1-v2/baseline-seed-2/final.bin`とSHA-256完全一致」を独自に`sha256sum`で再計算し、両ファイルとも`43614bd042d1fbd53ae112efa8dac45cbf6f15356e9a6d400c0c8910e4fe398d`で一致することを確認(T096流用値3.466667の正当性を裏付ける)。T096作業ログ(`tasks/T096-oracle-robustness.md`)の実測値(v2=1.5666666667, 候補=3.4666666667, diff=+1.9, CI=[0.6667,3.3])とも一致。PASS。
- oracle測定の局面単位逐次保存: `bench/edax-compare/compare_pattern_v3.py`のコードを読み、`atomic_json`が oracleRows/v2 rows/candidate rows それぞれ1件処理するたびに呼ばれ(L136, L156)、`--output`が既存なら`identity`一致を確認した上で完了済み行をスキップしてresumeする実装であることを確認。作業ログに記載の実際の中断・再開エピソード(scratchpad一時スクリプトの無限ループによる意図せぬ中断からの再開)とも整合。PASS。
- T095申し送り3修正の実装確認: `decode_outcome_cache`(L254〜)で`checked_mul`/`checked_add`によるオーバーフロー検出→`with_capacity`前にErr、を実装コードで確認。`find_duplicate_mix`/`find_duplicate_seed`(L1042, L1051)、`save_cache_best_effort`(L376)も実装を確認。
- テストの非自己参照性確認(テストコードを読解): `select_train_subset_is_deterministic_for_same_seed`は同一入力で2回呼び出し結果を比較(自己参照ではなく実行時比較)。`select_train_subset_nests_across_increasing_sizes`は3サイズの実行結果をHashSetの部分集合関係で検証(仕様どおりの入れ子性を独立に検証)。`select_train_subset_preserves_phase_proportions_by_floor`はfloor計算の期待値(80, 20)をテスト内で明示的に手計算しハードコードしており、実装のfloor除算ロジックと独立した期待値である。`decode_outcome_cache_rejects_overflowing_count_without_large_allocation`/`_oversized_count_claiming_more_than_file_contains`は壊れたバイト列を手構築し、エラー文字列(`"cache_size_overflow"` / `"truncated_cache"`)が期待通り返ることを検証しており自己参照ではない。`save_cache_best_effort_does_not_panic_when_directory_is_missing`は存在しないディレクトリへの書き込み試行後、パニックせずファイルも作られないことを確認。`find_duplicate_mix_detects_repeated_names_only`/`find_duplicate_seed_detects_repeated_values_only`は既知の重複/非重複入力に対する期待値をハードコードして検証。全8件とも実装関数を呼び出した上での独立した期待値比較であり、自己参照テストは無い。PASS。
- `.gitignore`確認: 32行目に`train/data/`があり、`git check-ignore -v train/data/t109/results.tsv`で該当することを確認。PASS。
- `git status --short`確認: `engine/src/endgame.rs`(M)、`engine/src/search.rs`(M)、`tasks/T104-endgame-shallow-solver.md`(M)のみで、いずれもT104由来(注記により除外対象)。T109由来の差分・未追跡ファイルは残存していない。PASS。

**総合判定: 合格。** 全7項目の受け入れ基準を満たしている。学習曲線の結論(「量仮説は不支持」)自体は分析結果であり本タスクの成功/失敗を左右しない(タスク定義どおり)。
