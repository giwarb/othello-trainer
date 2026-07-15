---
id: T110
title: v3特徴×蒸留の組み合わせ実験(表現力仮説の検証)
status: review # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T110: v3特徴×蒸留の組み合わせ実験

## 目的

T109で「50k蒸留の失敗はデータ量では解決しない(バイアス型)」と確定した。次の有力仮説は**表現力不足**(v2の22インスタンス/6クラスでは蒸留ラベルの信号を吸いきれない。ユーザー仮説2026-07-16)。T087で構築済みのv3特徴(edge+2X+対角オフセット5/6/7、38インスタンス/10クラス)と、T090aの蒸留コーパス(50k、Edaxラベル)を**初めて組み合わせて**学習し、分布外汎化(T096 60局面oracle regret)が改善するかを検証する分析実験。

- v3×蒸留のregretがv2×蒸留(3.47石)から明確に改善しv2×WTHOR(1.57石)へ近づく → 表現力仮説支持。採用候補化・200k再検討の根拠になる。
- 改善しない → 表現力でも量でもない = 教師コーパスの局面分布か混合損失設計が本丸、と絞り込める。

**本タスクは分析実験であり、採否判定・アプリ配線はしない。** どちらの結果も正常な完了。

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック+検証強化(verifier+Claude代替レビュー)。**別ワーカーがT104(終盤ソルバー、NPSゲートあり)を並行実行中**のため:
- 全処理を直列・低負荷で実行(学習run並列禁止、Edax採点1プロセスずつ)。遅くてよい。
- 時間計測は判定に使わない(全指標が決定的)。

## 背景・既存資産(必読)

- `tasks/T109-distillation-learning-curve.md` — 直前の実験。trainerの現状(subset機能・train_teacher_mae列・T095修正済み)と、oracle計測の節約手法(oracleRows/v2 rowsの再利用resume)はここに記載。
- `tasks/T087-pattern-v3.md` — v3特徴の定義(v3 = v2 + edge2x + diag567、38インスタンス/10クラス)とPWV3形式。生成コードは `engine/src/patterns.rs`、PWV3 writer/loaderは `engine/src/pattern_eval.rs`。**T087のv3学習済み重み(WTHOR教師)が `train/data/t087/v3-seed-{1,2,3}.bin` にローカル残存しているはず**(gitignore領域。無ければその旨記録し、v3×WTHOR参照点は省略)。
- `tasks/T090b-distillation-training.md` — 蒸留学習仕様(baseline mix 0.6/0.3/0.1、split、reference-weightsの役割)。
- 実装: `train/src/t090_distillation.rs`(現行はv2特徴固定のはず)。oracle採点: `bench/edax-compare/compare_pattern_v3.py`(元々v3比較用に作られておりPWV3候補を扱えるはず。要確認)。
- **申し送り(本タスクで対応)**: T109レビュー指摘[中M1] = T109以前の旧run dirをresumeするとmetrics.tsvのヘッダ列数不一致で列ずれする。resume時にヘッダ検証を入れて不一致なら明確にエラーにする(小規模修正)。

## 要件

1. **trainerのパターン集合選択**: `train_distillation` にv3特徴構成で学習できるオプションを追加(例: `--pattern-set v2|v3`、既定v2)。**無指定時は既存動作と完全等価**であること(T109と同じ手法: 同一smokeコマンドで重みSHA-256一致を実測確認)。resume identityにpattern-setを含め、取り違えresumeを拒否する。
2. **学習構成**: コーパスはprimary 50k全量、mixはbaselineのみ、seeds 1,2,3。
   - 主構成: v3×蒸留(初期化はT090bのv2蒸留と同じ流儀に合わせる。reference-weightsの役割を確認し、v3では対応するv3参照が無い場合の扱い(ゼロ初期化等)を作業ログに明記)。
   - 参考構成(安価なら): T087のv3-seed重みを初期値にしたfine-tune 1run。重すぎる・基盤が噛み合わない場合は省略可(理由を記録)。
3. **記録**: T109で整備したtrain/validation両方のteacher MAE(epochごと)、frozen agreement、best epoch情報。
4. **oracle評価(主指標)**: T096 60局面oracleのmean regret+paired bootstrap CI を以下の4点で統一比較する表を作る:
   - v3×蒸留(本タスク、代表seed。seed間で重みが異なるので最低1点、安ければ複数)
   - v2×蒸留 = 3.4667(T109/T096実測の流用)
   - v2×WTHOR = 1.5667(同上)
   - v3×WTHOR(T087のv3-seed重みが残っていれば1点計測。T087当時の18局面oracleの2.22石は局面集合が違うため直接比較に使わないこと)
   - oracleRows/v2 rowsの再利用によるEdax呼び出し節約はT109の手法を踏襲してよい(ただしT109で発覚したseedスクリプトのバグ2件の轍を踏まないこと)。
5. **長時間実行ルール**: epoch単位checkpoint/resume維持、oracle採点は局面単位で逐次保存・resume可能、進捗逐次ログ、節目ごとに作業ログ追記。
6. **結論の記述**: 表現力仮説の支持/不支持の解釈候補と根拠(regretの変化量、CI、train/val MAEギャップの変化=容量が増えて過学習が悪化していないか)を作業ログに書く。判定はオーケストレーター。

## やらないこと(スコープ外)

- 200kコーパス生成、教師コーパスの局面分布変更
- パターン形状の新規設計(T087のv3定義をそのまま使う)
- 採否判定・アプリ/WASM配線・NPS計測(参考記録も不要)
- 本番重み(`train/weights/pattern_v2.bin`)の変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` 全件パス(pattern-set選択・identity分離・M1ヘッダ検証のテスト含む)
- [ ] `cargo test -p engine` 全件パス(T104並行WIP由来の失敗は除外判定。protocolフレーキーは単独再実行で切り分け)
- [ ] 無指定時等価のSHA-256一致確認が作業ログにある
- [ ] v3×蒸留 3seedsが完走し、`train/data/t110/` にmetrics.tsv(train/val両MAE列)とsummaryがある
- [ ] 作業ログに4点比較表(v3×蒸留 / v2×蒸留 / v2×WTHOR / v3×WTHOR、T096 60局面oracle regret+CI)と解釈がある
- [ ] oracle計測が局面単位で逐次保存されresume可能
- [ ] コード変更(train/配下、必要なら engine/ のPWV3まわりは読み取り利用のみで変更しない)のみをパス明示でコミット
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T104由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 実装・equivalence確認・学習run/oracle計測完了

**実装(`train/src/t090_distillation.rs`のみ変更)**:

1. **パターン集合選択**: `PatternSet{V2,V3}` enumと`--pattern-set v2|v3`(既定`v2`)を追加。`patterns_for(pattern_set)`が`PatternSet::V2`→`patterns::generate_patterns()`、`PatternSet::V3`→`patterns::generate_patterns_for(patterns::PatternConfig::V3)`(T087で構築済み、38インスタンス/10クラス)を返す。`run_one`内の`Model::new(patterns::generate_patterns())`を`Model::new(patterns_for(pattern_set))`に変更。`run_one`/`run_all`のシグネチャに`pattern_set: PatternSet`引数を追加し、`run()`から一貫して渡す。
2. **reference-weightsの役割(明確化)**: `reference`(`--reference-weights`、既定`train/weights/pattern_v2.bin`、PWV2固定)は、(a)コーパスロード時の`engineChoice`構築(T090b既定どおり、pattern_setに関わらず常にpattern_v2の静的評価argmax)、(b)`reference.tsv`の比較基準値、の2用途にのみ使い、**学習対象モデルの初期化には一切使わない**(`Model::new`は常にゼロ初期化、`PatternWeights::zeroed`)。したがってv3学習の初期化はv2蒸留(T090b)と全く同じ流儀(ゼロ初期化)であり、「v3に対応する参照重みが無い場合の扱い」を新設する必要はなかった(reference-weightsは元々「学習の初期値」ではなく「engineChoiceの算出元」なので、pattern_setで意味が変わらない)。
3. **resume identityへのpattern-set混入**: `pattern_set_identity_line(pattern_set)`が`V2`では空文字列、`V3`では`"pattern_set=v3\n"`を返し、top-levelの`identity`文字列(`run_one`内のper-run identity.txtの元になる`identity_base`)に混ぜ込む。T109の`train_subset_size`と同じ「既定値では追加しない」流儀を踏襲し、**無指定時(v2既定)のidentity文字列は従来と完全に不変**(pattern-setの取り違えresumeは、v3側で追加される非空行により既存のidentity不一致チェックが確実に拒否する)。`manifest.txt`には`pattern_set=v2|v3`行を無条件で追加(resume判定に使われないファイルなので無指定時等価には影響しない)。
4. **M1(申し送り)対応**: `metrics.tsv`のヘッダを`METRICS_HEADER`定数に一本化し、`ensure_metrics_header(path)`を追加。ファイルが無ければ現行ヘッダで新規作成、あれば1行目が現行ヘッダと厳密一致することを確認し、不一致なら`Err`で明確に停止する(T109以前の列数が異なる旧run dirを誤ってresumeし、新しい列数の行が旧ヘッダの下に無言で追記されて列がずれる事故を防ぐ)。

**無指定時等価の実測確認(SHA-256一致)**: 修正前後で同一smokeコマンド(`--corpus corpus_smoke.jsonl --checkpoint-dir <dir> --mixes baseline --seeds 1 --max-epochs 1`、`--pattern-set`等は指定なし)を実行し、`final.bin`/`best.bin`のSHA-256が`a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`で完全一致(T095/T109作業ログ記載値とも一致)。さらに`--pattern-set v2`を明示指定しても同じ挙動になることを確認済み(コード上`None`と`Some("v2")`は同じ分岐)。

**pattern-set取り違えresumeの拒否を実地確認**: 上記smoke checkpoint-dirに対して`--pattern-set v3`で同一checkpoint-dirを指定して再実行したところ、`run identity mismatch for baseline; refusing resume`で即座に停止することを確認(コード変更なしで動作)。

**M1修正の実地確認**: T090b時代(T109以前、`train_teacher_mae`列が無い6列ヘッダ)の実run dir(`train/data/t090b/primary-redo1-v2/baseline-seed-2/`)をscratchpadへコピーし、同一コマンド(`--corpus corpus_primary.jsonl --checkpoint-dir <copy> --mixes baseline --seeds 2 --max-epochs 60`、他は既定)で резume を試みたところ、`resume mix=baseline seed=2 epoch=59`と出力した直後に`metrics.tsv header mismatch in ...: expected "...train_teacher_mae...", found "epoch	learning_rate	train_loss	validation_loss	validation_teacher_mae	validation_ranking_mae" (refusing to resume from an incompatible run directory; T109 review finding M1)`で明確に停止することを実地確認した(修正前は無言で列がずれた行を追記していたはずの経路)。

**v3特徴の生成確認**: `patterns_for(PatternSet::V3)`で生成したモデルの`to_bytes_v3()`出力が5,964,708バイトとなり、T087の推奨v3(5,964,708 bytes)と完全一致することを確認(T087の`generate_patterns_for(PatternConfig::V3)`をそのまま再利用しているため設計上当然だが、実行結果でも裏付けた)。

**テスト追加(`cargo test -p train`で検証)**: `parse_pattern_set_defaults_to_v2_and_rejects_unknown_values`、`patterns_for_v3_has_more_instances_and_classes_than_v2`(22/38インスタンス、6/10クラスを検証)、`pattern_set_identity_default_v2_is_empty_but_v3_is_distinct`、`ensure_metrics_header_creates_current_header_when_file_is_absent`、`ensure_metrics_header_accepts_matching_header_without_modifying_file`、`ensure_metrics_header_rejects_pre_t109_header_without_train_teacher_mae_column`(M1の否定テスト)の6件。

`cargo test -p train`: 59 passed(既存53+新規6件)、0 failed。`cargo test -p engine`: 191 passed / 0 failed / 2 ignored(T104のWIPは既にengineテストに影響なし、除外不要)。

**並行実行への配慮**: 本タスクの学習run・oracle採点はすべて`--jobs 1`または単一プロセスで直列実行した(T104のNPS計測を汚染しない)。

---

### 学習run(v3×蒸留、primary 50k全量、baseline mixのみ、seed 1/2/3)

コマンド: `./target/release/train_distillation.exe --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t110/v3 --mixes baseline --seeds 1,2,3 --pattern-set v3 --reference-weights train/weights/pattern_v2.bin --jobs 1`

split(T090bのcanonicalKeyハッシュ分割、pattern_setに関わらず不変): train 45,055 / validation 2,363 / frozen teacher test 2,582。3 seedとも早期打ち切り(stale>=5)で完走(epoch 44-47/60、`train/data/t110/v3/baseline-seed-{1,2,3}/complete.txt`+`result.tsv`+`final.bin`+逐次`metrics.tsv`が存在)。長時間実行ルール: 既存のepoch単位atomic checkpoint(T090b/T095/T109から無変更)がそのまま効き、本タスクでは中断は発生しなかったが、機構自体はT109までで動作確認済み。今回はフォアグラウンド実行で1コマンドの中で3 seedとも完走した(合計10分弱)。

| seed | best_epoch/epochs | train_teacher_mae | validation_teacher_mae | frozen_agreement | frozen_mean_regret(in-corpus) | wthor_2024_mae | bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 44/47 | 3.947631 | 7.077832 | 0.429899 | 3.734314 | 15.015393 | 5,964,708 |
| 2 | 44/46 | 4.094012 | 7.089514 | 0.424864 | 3.777304 | 15.035946 | 5,964,708 |
| 3 | 47/47 | 4.070483 | 7.087384 | 0.425639 | 3.762200 | 15.028789 | 5,964,708 |

v2×蒸留参照(T109/T090b `primary-redo1-v2/baseline-seed-2`実測流用): train_teacher_mae=4.6559, validation_teacher_mae=7.490193, frozen_agreement=0.407049, frozen_mean_regret=3.939582, wthor_2024_mae=15.291866, bytes=2,729,712。

**train/val teacher MAEギャップ(過学習の直接観測)**: v3(3 seed平均): train≈4.037, val≈7.085, gap≈3.048。v2(T109 full/3 seed平均): train≈4.653, val≈7.479, gap≈2.826。**v3は絶対train MAE・絶対val MAEともにv2より明確に改善する(val: 7.09 vs 7.48)一方、gapはv2よりわずかに(+0.22石)大きい**。表現力(パラメータ数)が増えた分だけ僅かに過学習しやすくなっている兆候はあるが、絶対的な汎化(val MAE)は悪化しておらずむしろ改善しているため、深刻な過学習増悪とまでは言えない。

### T096 60局面oracle regret(4点比較、主指標)

v3×蒸留のcandidateはoracleRows/v2 rowsを`compare_pattern_v3.py`に直接計算させたseed1の完走結果を、seed2/seed3・v3×WTHOR参照点で再利用した(scratchpad一時スクリプト`t110_seed_oracle_state.py`、T109の手法を踏襲しつつ`meanRegret`欠落バグ[T109で発覚]を最初から回避する実装にした。スクリプト自体はコミットしない)。v2Sha256/edaxSha256/edaxEvalSha256/corpusSha256は本タスク実行時点でT109当時の値と完全一致することを事前にsha256sumで確認済み(evalCliSha256のみT104の並行ビルドで変化していたため、v2×蒸留=3.4667等の過去値をそのまま複製はせず、**v2行はこのセッション内でseed1実行時に自前で再計測**し、`v2=1.5666666666666667`がT096/T109の既存記録と完全一致することを確認した上で使った。なお`--exact-from-empties 0`で呼び出す`eval_cli best`はT104が変更しているexact/shallow終盤ソルバー経路[SHALLOW_MAX_EMPTIES関連]を発火させない設計上のガード値のため、T104の並行WIPは本タスクのoracle計測の再現性に影響しない)。

コマンド(seed1、フルスクラッチ): `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t110/v3/baseline-seed-1/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t110/oracle/v3-baseline-seed-1.json`
コマンド(seed2/seed3/v3×WTHOR、oracleRows+v2再利用): 同上を`--candidate`だけ差し替えて実行(候補60件のみ新規Edax計測)。

| 構成 | 対象重み | oracle regret(60局面) | v2差分 | 95% CI | 判定 |
|---|---|---:|---:|---|---|
| v3×蒸留(本タスク、seed1) | `train/data/t110/v3/baseline-seed-1/final.bin` | 2.666667 | +1.100000 | [-0.200, 2.600] | no_significant_difference |
| v3×蒸留(本タスク、seed2) | `train/data/t110/v3/baseline-seed-2/final.bin` | 2.666667 | +1.100000 | [-0.200, 2.600] | no_significant_difference |
| v3×蒸留(本タスク、seed3) | `train/data/t110/v3/baseline-seed-3/final.bin` | 2.666667 | +1.100000 | [-0.200, 2.600] | no_significant_difference |
| v2×蒸留(T109/T096実測流用) | `train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin` | 3.466667 | +1.900000 | [0.667, 3.300] | candidate_worse |
| v2×WTHOR(参照、v2実測) | `train/weights/pattern_v2.bin` | 1.566667 | 0(自身) | — | — |
| v3×WTHOR(T087 v3-seed-2、本タスクでT096 60局面上に新規計測) | `train/data/t087/v3-seed-2.bin` | 1.433333 | -0.133333 | [-0.767, 0.567] | no_significant_difference |

v3×蒸留の3 seedは(偶然)全て同一の60手選択・同一regretになった(モデルは各seed final.bin単位でSHA-256が異なることを確認済みなので、キャッシュ流用のバグではなく、depth 8静的評価のargmaxがこれら60局面についてseed間で一致しただけ。frozen setでのagreement差(0.4249/0.4299/0.4256)から、seed間の実際の予測差は存在するが、この特定の60局面群では選択手が揃った)。

**注**: T087当時の18局面oracleでのv3×WTHOR regret(2.222222石)は局面集合が異なるため直接比較しない(タスク要件どおり)。本タスクのT096 60局面での新規計測(1.433333石)はv2×WTHOR(1.566667石)と統計的に有意差なし(CIが0を跨ぐ)であり、T087の18局面測定より肯定的な結果になった(サンプルサイズの違いによるノイズの可能性が高い)。

### 表現力仮説の支持/不支持:解釈候補(判定はオーケストレーター)

1. **部分的に支持**: v3×蒸留はv2×蒸留に対して、oracle regretの点推定が3.4667→2.6667(-0.8石)へ明確に改善し、v2との差の統計的分類も「candidate_worse(有意に悪い)」から「no_significant_difference(有意差なし)」へ転じた。in-corpus指標(frozen agreement 0.407→0.425前後、frozen regret 3.94→3.73-3.78、WTHOR2024 MAE 15.29→15.02-15.04、train/val teacher MAEとも改善)もすべて一貫して同方向に改善しており、表現力(パラメータ数)の増加が蒸留信号の吸収に一定の効果を持つことを支持する。
2. **しかし解消はしない**: v3×蒸留のregret(2.6667石)は、v2×WTHOR(1.5667石)・v3×WTHOR(1.4333石、いずれもv2差有意差なし)の水準にはまだ届かない(点推定でおよそ1.1-1.2石の差が残る)。表現力の追加だけでは「Edax蒸留ラベルで学習すると独立oracleでの汎化が悪化する」という中心的な問題は解消しておらず、教師コーパスの局面分布・ラベルの質・混合損失の重み付け(T090bで示唆されていた別の仮説群)が依然として主要因として残っている可能性が高い。
3. **過学習は悪化していない**: train/valギャップはv3の方がv2よりわずかに大きい(+0.22石)が、絶対値としてのvalidation teacher MAE・oracle regretはいずれも改善しているため、「容量を増やしたら過学習で汎化がさらに悪化した」という懸念は否定される(むしろ逆方向、汎化は改善している)。
4. **統計的な留保**: 60局面という限られたサンプルサイズのため、v3×蒸留 vs v2・v3×WTHOR vs v2はいずれも「有意差なし」の分類にとどまり(CI幅がそれぞれ約2.8石・1.3石と広い)、点推定の改善傾向は明確だが統計的に確定的な「改善した」という主張はできない。より確定的な判断には、より大きな独立oracle集合、または本タスクの結果を踏まえた200kコーパス×v3の追加実験が必要になる可能性がある。

### T087のv3-seed重み初期値によるfine-tune(参考構成、要件2)は省略

要件2の「参考構成」(T087のv3-seed重みを初期値にした蒸留fine-tune)は**実施を見送った**。理由: (a) 現行の`run_one`はモデル初期化を常にゼロ初期化(`Model::new(patterns_for(pattern_set))`)で固定しており、任意の重みファイルから初期化を差し替えるには新規CLIフラグ(例: `--init-weights`)・resume identityへの追加混入・チェックポイント再開ロジックとの整合など、pattern-set追加と同程度の実装面積が新たに必要になる。(b) 本タスクの主要な問い(表現力仮説の検証)は上記4点比較で既に明確な(部分支持・部分不支持の)解釈が得られており、fine-tune構成を追加しても結論の方向性を変える可能性は低いと判断した。(c) 要件文言自体が「安ければ実施、重ければ省略可(理由記録)」と明示的に許容している。以上により、コード変更なし・追加学習runなしとし、この理由をここに記録する(採否はオーケストレーター判断)。

### 検証コマンド一覧

- `cargo test -p train`: 59 passed / 0 failed(新規6件はM1・pattern-set関連、上記参照)。
- `cargo test -p engine`: 191 passed / 0 failed / 2 ignored(T104由来の失敗なし)。
- 無指定時等価: 上記smoke SHA-256一致確認(`a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`)。
- 学習run: 上記`train_distillation.exe --pattern-set v3 ...`コマンド(3 seed完走、`train/data/t110/v3/baseline-seed-{1,2,3}/`)。
- oracle計測: 上記`compare_pattern_v3.py`コマンド4回(seed1フルスクラッチ+seed2/seed3/v3×WTHORの候補行のみ再計測)、`train/data/t110/oracle/`配下に4ファイル(いずれも局面単位でatomic checkpoint、gitignore領域)。
- summary: `train/data/t110/results.tsv`(3 run + 3参照行、gitignore領域、`train/data/`が.gitignore対象であることは32行目で既存確認済み)。
- `git status --short`: `engine/src/endgame.rs` `engine/src/search.rs` `tasks/T104-endgame-shallow-solver.md`(T104由来、除外対象)のほかは`train/src/t090_distillation.rs`のみ。コミット対象は`train/src/t090_distillation.rs`(パス明示、`git add .`未使用)。`tasks/`はコミット対象外(オーケストレーター担当)。

### コミット対象・スコープ外差分

- コミット対象(パス明示予定): `train/src/t090_distillation.rs`のみ。
- `engine/`は無変更(読み取り利用のみ、PWV3ローダ・patterns::generate_patterns_for等の既存APIをそのまま呼び出しただけ)。
- `train/data/t110/`(学習run成果物・oracle計測結果・summary)は`train/data/`のgitignore対象であり、コミット対象外。
- スコープ外差分: `engine/src/endgame.rs` `engine/src/search.rs` `tasks/T104-endgame-shallow-solver.md`はすべてT104(並行実行中の別タスク)由来であり、本タスクでは一切変更していない。
- 一時ファイル: scratchpad(`t110_seed_oracle_state.py`、equivalence/M1確認用の一時checkpoint-dir)のみで、リポジトリ内には作成していない。
