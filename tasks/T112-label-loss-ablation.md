---
id: T112
title: 同一45k局面でのラベル/損失対照実験(密度仮説 vs 損失仮説の切り分け)
status: review # todo | in_progress | review | done | blocked
assignee: implementer(Sonnet, Codex上限フォールバック)
attempts: 0
---

# T112: 同一45k局面でのラベル/損失対照実験

## 目的

蒸留(50kコーパス)がWTHOR全量学習(103万局面)より分布外oracleで悪い原因を、**「局面の密度(数)」なのか「ラベル/損失の性質」なのか**に切り分ける(ユーザー承認 2026-07-16)。方法は「**同じ教師コーパスの局面集合を固定し、ラベル・損失だけを入れ替える**」対照実験。

判定の分かれ方(作業ログには数値と解釈候補を書けばよい。判定はオーケストレーター):
- **outcome回帰のみ(セルc)が1.6石前後を維持** → 4.5万局面で足りる = 犯人はラベル/損失の性質(混合損失設計(D)が本命に)。
- **セルcが3石級に悪化** → 犯人は密度(局面数)。蒸留ラベルには10万〜100万級の局面が必要という示唆。

**本タスクは分析実験。採否判定・アプリ配線はしない。**

## 委譲体制の注記

Codex週間上限(リセット7/22 6:00)のためimplementer(Sonnet)フォールバック+検証強化。**別ワーカーがT104/T105(終盤ソルバー、NPS計測あり)を並行実行中**のため:
- 全処理を直列・低負荷・**フォアグラウンドのみ**で実行(バックグラウンド起動禁止=T109事故防止)。遅くてよい。時間計測は判定に使わない。

## 背景・既存資産(必読)

- `tasks/T090b-distillation-training.md` — 混合損失の定義(baseline 0.6 teacher Huber / 0.3 ranking / 0.1 outcome)と既存ablation(teacher-only 1.0/0/0、no-ranking 0.7/0/0.3)。**no-ranking / teacher-only の学習済み重みが `train/data/t090b/primary-redo1-v2/{no-ranking,teacher-only}-seed-{1,2}/final.bin` に残存しているはず**(gitignore領域) — これらは**再学習不要でoracle計測のみ**でよい。
- `tasks/T110-v3-distillation.md` / `tasks/T111-v3-wthor-robustness.md` 作業ログ — oracle計測手順(oracleRows/v2行の再利用によるEdax節約、T111の`t111_seed_oracle_state.py`はSHA整合ガード付きで最も洗練されている。踏襲推奨)。
- 実装: `train/src/t090_distillation.rs`(mixは名前付き定義のはず。outcome-only を追加する)。
- **申し送り(本タスクで対応、T110レビュー[中M1'])**: `run_one`で`truncate_metrics_after`が`ensure_metrics_header`より先に実行され、ヘッダ不一致拒否経路が完全には副作用フリーでない。**順序を入れ替える(検証→truncate)**1行修正+可能なら回帰テスト。
- **M2ガード(標準)**: 各oracle計測でv2行=1.5667の完全再現を確認。再現しなければ中止して報告。

## 要件

1. **outcome-only mixの追加**: 混合比 (teacher 0 / ranking 0 / outcome 1.0) の名前付きmix `outcome-only` を追加する。
   - WTHOR outcomeが無いレコード(engineLoss由来65/50,000件)はoutcome-onlyでは学習に使えない。**スキップし、件数を作業ログに明記**(既存の再正規化規約との整合も確認)。
   - 局面集合はprimary 50k(train split 45,058)そのまま。サブセット化しない。pattern-setはv2(既定)。
   - 既存mix(baseline等)の数値挙動が不変であること(退行確認: 既存テスト+可能ならbaseline 1epochスモークのSHA一致)。
2. **学習**: outcome-only × seeds 1,2,3(既存checkpoint/resume基盤、train/data/t112/)。epochメトリクスはtrain/val両方のteacher MAE(既存基盤)に加え、outcome-onlyではvalidationのoutcome MAEも読めることが望ましい(既存列で賄えるなら追加不要、判断を作業ログに)。
3. **oracle計測(T096 60局面、主指標)**: 以下を計測し、既存値と合わせた比較表を作る:
   - (c) outcome-only seed1(3seedの重みが実質同挙動か確認し、異なるならもう1seed)
   - (b) no-ranking seed1(T090b既存重み、oracle未計測なら計測)
   - (b') teacher-only seed1(同上)
   - 参照(流用): baseline蒸留=3.4667、v2×WTHOR(103万)=1.5667、v3×蒸留=2.6667
   - 各計測でM2ガード(v2行1.5667再現)を確認・記録。
4. **長時間実行ルール**: epoch/局面単位の逐次保存・resume、進捗ログ、節目ごとの作業ログ追記。
5. **結論材料の記述**: 比較表と、密度仮説/損失仮説それぞれへの含意(rankingの寄与の正負も no-ranking / teacher-only との対比で読めるはず)を作業ログに書く。

## やらないこと(スコープ外)

- 200kコーパス生成・局面分布の変更・ステージ解像度実験(別タスク)
- 混合比の最適化探索(この実験は切り分けが目的。チューニングは結果を見てから)
- 採否判定・アプリ/WASM配線・NPS計測

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` 全件パス(outcome-only mixの単体テスト、M1'順序修正の回帰テスト含む)
- [ ] 既存mixの数値不変確認(baseline 1epochスモークのSHA-256一致 or 同等の根拠)が作業ログにある
- [ ] outcome-only 3seedsが完走し `train/data/t112/` にmetrics.tsv・summaryがある
- [ ] oracle比較表(outcome-only / no-ranking / teacher-only / baseline / v2×WTHOR / v3×蒸留)とM2ガード記録が作業ログにある
- [ ] スキップしたoutcome欠落レコード件数が作業ログに明記されている
- [ ] コード変更(train/配下のみ)をパス明示でコミット(データ非コミット)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと(T104/T105由来は除外)

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)

### 2026-07-16 実装・equivalence確認・学習run/oracle計測 完了

**事前調査**: `tasks/T090b-distillation-training.md`(mix定義・再正規化規約・6構成×2seedの数値)、`tasks/T110-v3-distillation.md`/`tasks/T111-v3-wthor-robustness.md`(oracle計測手順・oracleRows/v2 rows再利用の節約手法・M2ガードの運用)を読了。`train/data/t090b/primary-redo1-v2/{no-ranking,teacher-only}-seed-1/final.bin`の存在を確認(再学習不要)。実行開始時の`git status --short`は`engine/src/endgame.rs` `engine/src/search.rs`のみ(T104/T105並行WIP由来、本タスクとは無関係)。

**実装(`train/src/t090_distillation.rs`のみ変更、コミット`3b0644d`)**:

1. **outcome-onlyミックス追加**: `Mix::parse`に`"outcome-only"`(teacher 0.0/ranking 0.0/outcome 1.0)を追加。
2. **既存の再正規化規約(`coefficients`)との整合を確認**: outcomeが有る局面は`(0.0, 0.0, 1.0)`(教師項・ランキング項は完全ゼロ)、outcomeが無い局面は再正規化の分母(teacher+ranking)が0のため`(0.0, 0.0, 0.0)`になる。既存コードがこの分岐を既に持っていたため追加ロジックは不要だったが、**副作用の見落としを発見**: `train_step`が`teacher_weight * teacher_gradient`を`teacher_weight==0`でも無条件に`add_gradient`していたため、gradientマップに`value=0.0`のエントリが作られ、末尾のL2減衰(`weight -= lr*(value + l2*weight)`)がこの局面の触れた特徴だけに余計にかかる(完全スキップのはずが微小な重み減衰が発生する)ことが判明した。`if teacher_weight != 0.0`のガードを追加し、outcome-onlyでoutcomeが無い局面を`train_step`レベルで完全なno-op(loss=0、重み一切不変)に修正した。既存mix(teacher-only/baseline/no-ranking)はteacher_weightが常に非ゼロのため、この修正による挙動変化はゼロ。
3. **M1'修正(申し送り対応)**: `run_one`内で`truncate_metrics_after`が`ensure_metrics_header`より先に実行されており、ヘッダ不一致でresumeを拒否する経路でも一度`atomic_write`でファイルを書き戻していた(T110レビュー指摘M1'、完全には副作用フリーでない拒否経路)。呼び出し順序を入れ替え(`ensure_metrics_header`→`truncate_metrics_after`)、ヘッダ不一致時はファイルに一切触れずに`Err`で停止するよう修正した。

**新規テスト4件(`cargo test -p train`)**:
- `outcome_only_mix_has_pure_outcome_coefficients_and_is_fully_skipped_without_outcome`: outcome有り`(0,0,1.0)`、無し`(0,0,0)`を確認。
- `train_step_is_a_full_no_op_for_outcome_only_mix_without_outcome`: outcome-only×outcome無しレコードで`train_step`のloss=0・モデルバイト列(`to_bytes_v3()`)が完全不変であることを確認(上記2の修正の直接的な回帰テスト)。
- `run_one_rejects_stale_header_before_truncate_mutates_the_file`: 旧ヘッダのmetrics.tsvを事前配置し`run_one`を呼ぶと、ヘッダ不一致エラーで停止し、かつファイルバイト列が呼び出し前後で完全一致(=truncateが一切実行されていない)ことを確認(M1'の直接的な回帰テスト)。
- (既存の`ensure_metrics_header_*`系3件・`outcome_missing_renormalizes_remaining_terms`は無変更のまま継続パス)

`cargo test -p train`: **56 passed / 0 failed**(lib、既存52+新規4)+ `real_data`統合テスト1 passed。全件パス。

**既存mix退行確認(SHA-256一致)**: `cargo build --release -p train --bin train_distillation`後、修正前と同一のsmokeコマンド(`--corpus corpus_smoke.jsonl --mixes baseline --seeds 1 --max-epochs 1 --reference-weights train/weights/pattern_v2.bin`、`--pattern-set`等未指定)を実行し、`final.bin`/`best.bin`のSHA-256が`a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`で完全一致(T095/T109/T110作業ログ記載値と同一)。baseline mixの数値挙動は完全に不変であることを実測確認した。

---

### outcome-only学習run(primary 50k全量、pattern-set v2既定、seeds 1/2/3)

コマンド: `./target/release/train_distillation.exe --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t112 --mixes outcome-only --seeds 1,2,3 --pattern-set v2 --reference-weights train/weights/pattern_v2.bin --jobs 1`(直列・フォアグラウンド1コマンド、T104/T105への配慮でjobs=1)。

split(canonicalKeyハッシュ、既存基盤で不変): train **45,055** / validation **2,363** / frozen **2,582**。**outcome一致件数: train 36,131 / validation 1,883 / frozen 2,063**(2015-2023年代限定・2024重複除外の既存T090b redo#1ポリシーがそのまま適用される)。

**outcome欠落(スキップ)件数の明記**:
- **本タスク実行時点の実測値**: train側 **45,055 − 36,131 = 8,924件(19.8%)** がoutcome-onlyで学習に使えず(coefficients=`(0,0,0)`によりtrain_stepが完全no-opになる、上記修正で保証)スキップされる。validation側も480件(20.3%)・frozen側519件(20.1%)が同様にoutcome欠落。
- **タスク文中の「65/50,000件」との差異**: この数字はT090b初版(2024年代分離ポリシー導入前)の「WTHOR側にcanonical一致が全く無い」レコード数(engineLoss由来)であり、T090b redo#1(2026-07-15)で導入された「2024年と重複するcanonicalKeyのoutcomeも除外する」ポリシー(frozen 2024をgate(c)専用に保つための年代分離)が現行コードにそのまま組み込まれているため、実際のtrain側欠落件数は8,924件まで拡大している。タスク作成時点でこの新しいポリシー導入後の数値が反映されていなかったための差異であり、コード上の不整合ではない(`load_corpus`のoutcome付与ロジック自体はT090b redo#1から無変更)。両方の数値をここに明記する。

3 seedとも早期打ち切り(stale>=5)で完走: seed1 epoch20/25、seed2 epoch20/25、seed3 epoch18/23。長時間実行ルール: 既存のepoch単位atomic checkpoint(T090b/T109/T110から無変更)がそのまま機能し、進捗は各epochで`start`/`saved`行として逐次出力・`metrics.tsv`に逐次追記された。本タスクでは中断は発生しなかった(1コマンドで3 seed完走、合計10分未満)。

| seed | best_epoch/epochs | train_teacher_mae(参考,無意味\*) | validation_teacher_mae(参考,無意味\*) | frozen_agreement | frozen_mean_regret(in-corpus) | wthor_2024_mae | bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20/25 | 8.413065 | 9.994526 | 0.284663 | 8.578234 | 16.110202 | 2,729,712 |
| 2 | 20/25 | 8.432198 | 9.941253 | 0.284663 | 8.596824 | 16.102561 | 2,729,712 |
| 3 | 18/23 | 8.418839 | 9.922411 | 0.286212 | 8.589466 | 16.135240 | 2,729,712 |

\* `metrics`関数のteacher_mae列はteacher項が寄与しない(outcome-only)ためモデル選択(best epoch選択は`validation_loss`=outcome項のみの混合損失で行っている)には使っていない参考値。best epoch選択自体はoutcome-onlyの`validation_loss`(outcome Huber損失のみ)に基づいており正しい。

final.bin: `train/data/t112/outcome-only-seed-{1,2,3}/final.bin`(SHA-256はそれぞれ`6161322a...`/`9b0e88be...`/`7f87f0ec...`、3seedとも重みバイト列は相異なることを確認済み)。

---

### T096 60局面oracle regret(主指標、M2ガード付き)

手順はT110/T111を踏襲: scratchpad一時スクリプト`t112_seed_oracle_state.py`(非コミット、リポジトリ外)を新規作成。T109で発覚した2バグ(祖先ディレクトリ探索の無限ループ、`meanRegret`欠落)をT111と同様に最初から回避する実装(`git rev-parse --show-toplevel`でROOT解決、コピーするv2行に明示的に`meanRegret`を再計算して設定)に加え、**v2Sha256/corpusSha256/evalCliSha256/edaxSha256/edaxEvalSha256が現在のファイルと完全一致することを確認し、1つでも不一致なら例外で中止するガード**を実装した(T111と同一方針)。

1. **outcome-only seed1(フルスクラッチ)**: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t112/outcome-only-seed-1/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t112/oracle/outcome-only-seed-1.json`。**M2ガード: v2 meanRegret = 1.5666666666666667(=1.5667石)を完全再現。PASS**。candidate meanRegret = **3.8**。
2. **outcome-only seed2/seed3(oracleRows/v2再利用+resume)**: `t112_seed_oracle_state.py`でseed1のJSONから種付け→同一`compare_pattern_v3.py`コマンドで候補60件のみ新規Edax計測。両方とも種付け時・完了後の2箇所でv2再現(1.5666666666666667)を確認。**PASS**。candidate meanRegret: seed2=**3.8**(seed1と完全同値。`candidateSha256`は異なる[重みは確かに別物]がregret行はバイト一致、depth-8静的評価argmaxがこの60局面群でたまたま一致=T110で観測済みの既知パターン)、seed3=**3.6**。
3. **no-ranking seed1(既存T090b重み、oracle新規計測、種付け再利用)**: 同じくoutcome-only seed1のJSONから種付け。**M2ガード PASS**(v2=1.5666666666666667)。candidate meanRegret = **3.1333333333333333**。
4. **teacher-only seed1(既存T090b重み、oracle新規計測)**: 種付け再利用を試みたところ、`evalCliSha256`不一致(`fa2ccf16...`→`d7c2ea31...`、T104/T105の並行ビルドによりeval_cli.exeが更新された)でスクリプトのガードが**設計どおり例外で中止**した。T111と同じ状況のため、**フルスクラッチで再計測**(oracleRows・v2・candidateの全180件をEdax再計算)。**M2ガード PASS**(新しいビルドでもv2=1.5666666666666667、T111で確認済みの「ビルド差はv2 oracle regretに実質影響しない」という知見を再現)。candidate meanRegret = **2.8**。

全5計測、独立Python再集計(`results[].rows`からの直接再計算)で作業ログの数値と完全一致を確認済み(下記「検証コマンド一覧」参照)。**M2ガードは5計測すべてでPASS、中止判定なし**(teacher-onlyの種付け再利用のみガードにより中止し、フルスクラッチへフォールバックした)。

### 比較表(T096 60局面oracle regret、主指標)

| 構成 | 対象重み | oracle regret(60局面) | v2差分 | 95% CI | 判定 |
|---|---|---:|---:|---|---|
| outcome-only(seed1、本タスク新規) | `train/data/t112/outcome-only-seed-1/final.bin` | **3.8** | +2.2333 | [0.667, 3.933] | candidate_worse |
| outcome-only(seed2、本タスク新規) | `train/data/t112/outcome-only-seed-2/final.bin` | **3.8** | +2.2333 | [0.667, 3.933] | candidate_worse |
| outcome-only(seed3、本タスク新規) | `train/data/t112/outcome-only-seed-3/final.bin` | **3.6** | +2.0333 | [0.567, 3.633] | candidate_worse |
| no-ranking(seed1、T090b既存重み・oracle新規計測) | `train/data/t090b/primary-redo1-v2/no-ranking-seed-1/final.bin` | **3.1333** | +1.5667 | [0.167, 3.167] | candidate_worse |
| teacher-only(seed1、T090b既存重み・oracle新規計測) | `train/data/t090b/primary-redo1-v2/teacher-only-seed-1/final.bin` | **2.8** | +1.2333 | [0.100, 2.467] | candidate_worse |
| baseline(参照、T109/T110実測流用) | `train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin` | 3.4667 | +1.9 | [0.667, 3.300] | candidate_worse |
| v2×WTHOR(参照、v2実測=本タスクのM2ガードそのもの) | `train/weights/pattern_v2.bin` | 1.5667 | 0(自身) | — | — |
| v3×蒸留(参照、T110実測流用) | `train/data/t110/v3/baseline-seed-{1,2,3}/final.bin` | 2.6667 | +1.1 | [-0.200, 2.600] | no_significant_difference |

summary: `train/data/t112/results.tsv`(gitignore領域、上表と同一データ)。

### 密度仮説/損失仮説への含意(解釈候補、判定はオーケストレーター)

1. **タスクの判定基準に照らすと「セルc(outcome-only)が3石級に悪化」に該当し、密度仮説を支持する**: outcome-only(3.6〜3.8石)は「1.6石前後を維持」という損失仮説支持の基準から大きく外れ、むしろ**baseline(3.4667)より悪い**。同じoutcomeラベル・同じHuber損失を使うv2×WTHOR(1.5667石、約103万局面)と比べると、局面数を45,055(実質36,131)まで減らしただけで regret が約2.3倍(1.57→3.6-3.8)に悪化しており、**「同じラベル種で局面数だけを1/30近くに減らす」という最もクリーンな対照実験が、密度仮説を直接支持する結果**になった。
2. **ただし「ラベル/損失の性質」も無視できない副次効果として観測された**: 同じ45k規模の局面集合内で比較すると、teacher-only(Edax teacher値のみ、2.8石)が最も良く、no-ranking(teacher+outcome、3.1333石)、baseline(teacher+ranking+outcome混合、3.4667石)、**outcome-only(outcomeのみ、3.6-3.8石)が最も悪い**、という一貫した序列になった。teacher項(Edaxの深い探索による正確な評価値)を含む構成ほど良く、outcome項(対局最終結果という粗くノイジーな遠位シグナル)への依存度が高い構成ほど悪化している。これは「同一局面数でもラベルの質・情報量が汎化に影響する」ことを示しており、**混合損失設計(D)の中でoutcome項の重みを下げる/teacher項を重視する方向が有望**という損失仮説側の示唆材料にもなる。
3. **総合すると「密度が主要因、ラベルの質が副次要因」という複合的な絵**: outcome-onlyの3.6-3.8石という値は、density(局面数)だけでは1.57石に届かないことを明確に示す一方、teacher-only(同じ局面数でラベルが違う)が2.8石とoutcome-onlyより明確に良いことから、**局面数を増やすだけでは不十分で、教師ラベルの質(Edax深読み値 > WTHOR最終結果)も並行して重要**という2軸の結論になる。単純な「密度 vs 損失」の二者択一ではなく、両方が効いている可能性が高い。
4. **統計的な留保**: 60局面という限られたサンプルサイズのため、全5構成の判定は「candidate_worse」(v2より有意に悪い)に分類されるが、outcome-only(3.6-3.8)・no-ranking(3.1333)・teacher-only(2.8)相互の順序については、個別のペアワイズ検定は実施していない(本タスクの要件はv2との比較のみ)。3構成間の序列(teacher-only<no-ranking<outcome-only)が偶然か構造的かは、より大きな独立oracle集合か追加のペアワイズbootstrapで確認する必要がある。
5. **seed間頑健性**: outcome-onlyの3seedは3.6〜3.8石のレンジに収まり(T110のv3×蒸留と同様、60局面という限られたサンプルでは複数seedが同一の選択手に収束することがある: seed1とseed2は完全同値だが重みバイト列は相異なることを確認済み)、いずれもbaseline(3.4667)以上に悪化しており、単一seedの偶然ではなく構成そのものの性質と考えられる。

### 検証コマンド一覧

- `cargo test -p train`: 56 passed / 0 failed(lib、新規4件含む)+ `real_data` 1 passed。
- 無指定時等価: baseline 1epoch smoke SHA-256 `a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`(既存記録と一致)。
- 学習run: `train_distillation.exe --checkpoint-dir train/data/t112 --mixes outcome-only --seeds 1,2,3 --jobs 1 ...`(上記)。
- oracle計測5件のコマンドは上記本文に記載(compare_pattern_v3.py×5、`t112_seed_oracle_state.py`種付け×3)。
- 独立再集計: `python3 -c "import json,glob; ..."`で`train/data/t112/oracle/*.json`の`results[].rows[].regret`から5件全ての`v2`/`candidate` meanRegretを再計算し、本文記載値と完全一致することを確認(v2は全件1.5666666666666667で一致)。
- `git status --short`: 実行開始時・終了時とも`engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs` `tasks/T105-endgame-incremental-state.md`のみ(T104/T105由来、除外対象)。T112由来のコード変更は`train/src/t090_distillation.rs`のみで、コミット`3b0644d`により作業ログ追記時点でクリーン。

### コミット対象・スコープ外差分

- コミット対象(パス明示、コミット済み): `train/src/t090_distillation.rs`(コミット`3b0644d`)。ローカルmainはorigin/mainより1コミット進んでいる(push未実施、Pages配信に関わらない分析タスクのためオーケストレーター判断待ち)。
- `train/data/t112/`(学習run成果物・oracle計測結果・results.tsv)は`train/data/`のgitignore対象のためコミット対象外。
- 一時ファイル: scratchpad(`t112_seed_oracle_state.py`)のみで、リポジトリ内には作成していない。
- スコープ外差分: `engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs` `tasks/T105-endgame-incremental-state.md`はすべてT104/T105(並行実行中の別タスク)由来であり、本タスクでは一切変更していない。

---

### 2026-07-16 verifier検証結果(合格)

対象コミット: `3b0644d`。リポジトリ: `C:\Users\yoshi\work\othello-trainer`。T104/T105(engine/配下)と並行のため直列・低負荷で実行、engine系の差分・失敗は本判定に含めない。

1. **`cargo test -p train`**: 実測 `56 passed; 0 failed`(lib、新規4件`outcome_only_mix_has_pure_outcome_coefficients_and_is_fully_skipped_without_outcome` / `train_step_is_a_full_no_op_for_outcome_only_mix_without_outcome` / `run_one_rejects_stale_header_before_truncate_mutates_the_file` / 既存改名なしの合計含む)+ `real_data` 統合テスト `1 passed`。作業ログ記載の56/1と完全一致。**PASS**。
2. **コミット`3b0644d`の変更ファイル**: `git show --stat 3b0644d`で`train/src/t090_distillation.rs | 130 ++++...`の1ファイルのみ確認。**PASS**。
3. **`train/data/t112/`成果物**: `outcome-only-seed-{1,2,3}/`各ディレクトリに`final.bin`(2,729,712 bytes)・`metrics.tsv`・`result.tsv`・`identity.txt`・`complete.txt`を確認。`train/data/t112/oracle/`に`outcome-only-seed-{1,2,3}.json` `no-ranking-seed-1.json` `teacher-only-seed-1.json`の5ファイル、`train/data/t112/results.tsv`(比較表と同一データ)を確認。**PASS**。
4. **比較表の独立再集計**: `train/data/t112/oracle/*.json`の5ファイルそれぞれについて、Pythonで`results[].rows[].regret`から`v2`/`candidate`のmeanRegretを直接再計算し、作業ログ記載値と完全一致を確認: outcome-only seed1=3.8/seed2=3.8/seed3=3.6、no-ranking seed1=3.1333333333333333、teacher-only seed1=2.8。v2は5ファイル全てで1.5666666666666667(M2ガード)。5ファイルとも`statistics.meanDifference`/`ci95`/`classification`も作業ログ記載値と一致。**PASS**。v3×蒸留2.6667・v2×WTHOR1.5667はT110流用値としてresults.tsvに記載されており本タスクでの新規計測ではないため元タスク(T110)の実測を根拠とする(整合性のみ確認、再現不要)。
5. **新規テスト4件の自己参照確認**: `git show 3b0644d`の差分を読み、(a)`outcome_only_mix_has_pure_outcome_coefficients_and_is_fully_skipped_without_outcome`は既存の汎用`coefficients()`関数(outcome-only専用の分岐ではなく、他mixとも共有される再正規化ロジック)を実際に呼び出しており定義のなぞり返しではない、(b)`train_step_is_a_full_no_op_for_outcome_only_mix_without_outcome`は実際の`train_step`本体(モデルバイト列比較・loss値比較という外部観測可能な結果を検証)を呼び出しており、修正対象のガード(`if teacher_weight != 0.0`)を経由した実挙動を確認している、(c)`run_one_rejects_stale_header_before_truncate_mutates_the_file`は実際の`run_one`関数を呼び出し、ヘッダ不一致時にファイルバイト列が呼び出し前後で完全一致することを確認しており、`ensure_metrics_header`→`truncate_metrics_after`の順序修正の直接的な回帰テストになっている。3件とも本体ロジックを経由した外部観測結果を検証しており自己参照ではないと判断。**PASS**。
6. **baseline退行なしSHA一致の再現**: `cargo build --release -p train --bin train_distillation`後、`train_distillation.exe --corpus train/data/teacher/corpus_smoke.jsonl --checkpoint-dir <scratchpad> --mixes baseline --seeds 1 --max-epochs 1 --reference-weights train/weights/pattern_v2.bin`を独立実行し、`final.bin`/`best.bin`のSHA-256が`a9f60406c7bb532c29983f5363bea34b48c6fb8b35872b16b96f2391d450c62a`で完全一致することを実測確認(作業ログ・T095/T109/T110記載値とも一致)。**PASS**。
7. **outcome欠落8,924/45,055件の妥当性**: `train/data/t112/manifest.txt`(プログラム生成物)に`train=45055` `outcome_matched_train=36131`の記載があり、差分8,924件(19.8%)は作業ログ記載と完全一致。`train_data.iter().filter(|r| r.outcome.is_some()).count()`という実コードの出力であることをソース該当箇所(`load_corpus`/`load_outcomes`/該当println!)で確認した。`load_outcomes`のロジック(2015-2023年のWTHOR局面から集計し、2024年に出現するcanonicalKeyは`test_map.contains_key`で除外)は、T090b redo#1コミット`0540341`(タスクT112作成日より前)で導入されたポリシーであることをgit logで確認。タスク文中の「65/50,000件」はT090b初版(`tasks/T090a-teacher-corpus.md` `tasks/T090b-distillation-training.md`記載)の「engineLoss由来でWTHOR一致が元々無いレコード数」であり、2024年重複除外ポリシー導入前の数値であることを裏付ける記述が両タスクファイルに存在。作業ログの説明は整合的で妥当と判断。**PASS(独立件数確認込み)**。
8. **`git status --short`**: 検証実行前後とも`engine/src/bitboard.rs` `engine/src/endgame.rs` `engine/src/zobrist.rs` `tasks/T105-endgame-incremental-state.md`のみ(T104/T105由来、除外対象)。T112由来の未コミット差分・未追跡ファイルなし。**PASS**。
9. **付随確認**: `outcome-only-seed-{1,2,3}/final.bin`のSHA-256(`6161322a...` / `9b0e88be...` / `7f87f0ec...`)がそれぞれのoracle JSONの`candidateSha256`と一致し、3seedとも重みが相異なることを確認。3ファイルの`v2Sha256`/`corpusSha256`は全て同一値で一貫。

**判定: 合格**。受け入れ基準7項目すべてPASS。修正・書き込みは本作業ログ追記のみで、コード・データファイルへの変更は行っていない。
