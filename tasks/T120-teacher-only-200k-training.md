---
id: T120
title: 200kコーパスでのteacher-only蒸留学習(T113外挿の検証・採否候補の作成)
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T120: 200kコーパスでのteacher-only蒸留学習

## 目的

T114で完成した拡張教師コーパス(expanded200k、200,000局面、閾値20世代)を使い、**teacher-only損失での蒸留学習**を実行して、T113の学習曲線外挿(**200k → oracle regret ≈1.92石**、現行v2×WTHOR=1.57石)を検証する。regretがv2に十分接近すれば、次の採否判定(T090cプロトコル)の候補になる。

## 前提・既存資産

- コーパス: `train/data/teacher/corpus_expanded200k.jsonl`(gitignore領域、manifest: `bench/edax-compare/teacher_manifests/corpus_expanded200k.meta.json`)。**注意: exactEmptiesThreshold=20世代**(T090a primaryの24と異なる。空き21-24の子ラベルはEdax level 16見積もり)。
- 学習基盤: `train/src/bin/t090_distillation.rs`(T090b/T109/T112/T113で使用)。**teacher-only損失構成はT112/T113で実装・使用済み**(45k内序列で最良: 2.8石、T113曲線 3.83→2.80石/R²=0.971)。
- 採点: T096の60局面頑健oracle(層化・教師コーパス非重複。expanded200kはoracle 60キーの非混入を機械検証済みなので独立性は保たれている)。**oracle採点に使うeval_cliはコミット済みビルド由来とし、v2×WTHOR行(1.5667)の完全再現を毎回確認する**(T110申し送りM2)。
- seed頑健性の流儀: T111(3seed)。

## 要件

1. **学習実行**: expanded200k全量でteacher-only損失学習を**3seed**実行(T113と同一トレーナー・同一ハイパーパラメータ系。変更した点があれば作業ログに明記)。checkpoint/resume対応(既存基盤の流儀)。
2. **評価**: 各seedの60局面oracle regretを計測し、T113曲線(6.25k/12.5k/25k/45kの実測)への当てはまり・外挿値1.92石との比較・v2×WTHOR(1.57石)との差を統計的に評価(T111と同じ流儀での区間・検定)。
3. **副次評価(安価なら)**: in-corpus指標(frozen系)も記録し、T113系列と比較可能にする。
4. **申し送り対応**: [T110 M1'] `run_one`の`truncate_metrics_after`をヘッダ検証より後に移す(1行入替)。[T109 M1] 旧run dirをresumeした場合のmetrics.tsv列ずれに注意(全run新規dirなら無関係、その旨記録)。
5. **結論の型**: 「外挿は再現したか(1.92±どの程度か)」「v2×WTHORとの差は有意か」「採否判定(T090c: 対局スモーク)へ進む価値があるか」の3点をレポートに明記。閾値20世代というラベル条件の違い(T113は閾値24世代の45kサブセットで学習)が結果解釈に与える影響も考察に含める。
6. コーパス・重み等の大容量物はgitignore領域、実験メタ/レポートはコミット(既存流儀)。

## やらないこと(スコープ外)

- 本番への重み配線・採用判定(regretが良好でも、採否はT090cプロトコルの別タスク)
- v3特徴・ステージ解像度の組み合わせ実験(本タスクの結果を見てから安価に追加判断)
- コーパスの再生成・追加生成

## 受け入れ基準(検証コマンド)

- [ ] 3seedの学習が完走し、各seedのoracle regret(60局面)が確定している
- [ ] v2×WTHOR行(1.5667)の完全再現確認が各採点実行に付いている
- [ ] T113外挿(1.92石)との比較・v2(1.57石)との統計比較・採否判定への推奨がレポート/作業ログにある
- [ ] 学習がcheckpoint/resume対応で実行された記録がある
- [ ] `cargo test -p train` 全件パス(コード変更時)
- [ ] 実験メタ・レポートの変更対象ファイルのみパス指定でコミット(`(T120)`)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## 備考

- **T108(最終ゲート計測、壁時計・専有CPU必須)が先行実行中の場合は本タスクを開始しない**(CPU競合で計測を汚染するため。オーケストレーターが委譲タイミングを制御する)。
- 学習自体は決定的・ノードベースではないがCPU重負荷。進捗を外部観測可能にすること。

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 3seed学習・60局面oracle評価完了

**事前確認**: `git status --short`は空、T108/cargo/rustc/python/Edax系の実行プロセスなし。`train/data/teacher/corpus_expanded200k.jsonl`（200,000件、SHA-256 `412477e2...690e9`）とmanifestの`exactEmptiesThreshold=20`を確認した。`run_one`のM1'順序は既に `ensure_metrics_header` → `truncate_metrics_after` へ修正済みで回帰テストも存在するため、コード変更なし。全runを新規`train/data/t120/`へ作成したのでT109 M1の旧metrics列ずれは非該当。

**学習**: cleanなコミット済みソースから `cargo build --release -p train --bin train_distillation` を実行（成功）。T113と同じteacher-only / v2 / 既定max 60 epoch / 既定LR schedule / L2=1e-5、seed 1,2,3、jobs=1で次を実行し全run完走（early stopping epoch 34/37/35）。ハイパーパラメータ変更なし、コーパスとrun dirのみ変更。

`target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t120/expanded200k --mixes teacher-only --seeds 1,2,3 --reference-weights train/weights/pattern_v2.bin --jobs 1`

splitはtrain 180,110 / validation 9,685 / frozen 10,205。各epochで`epoch-N.bin`/`.state`とmetricsをatomic保存し、同一コマンドでresume可能。実際の中断はなし。

| seed | best epoch | validation teacher MAE | frozen agreement | frozen regret | WTHOR 2024 MAE | oracle regret |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 34 | 6.4670 | 0.3637 | 6.9000 | 14.7414 | 2.4667 |
| 2 | 37 | 6.4661 | 0.3629 | 6.8996 | 14.7426 | 2.3667 |
| 3 | 35 | 6.4751 | 0.3615 | 7.0037 | 14.7522 | 2.3333 |
| 平均 | — | 6.4694 | 0.3627 | 6.9344 | 14.7454 | **2.3889** |

T113 full（train 45,055）の3seed平均（validation teacher MAE約7.6097 / frozen agreement約0.3132 / frozen regret約8.2525 / WTHOR MAE約15.4436 / oracle 2.8）から全指標が改善した。

**oracle評価**: `cargo build --release -p engine --bin eval_cli`（成功、SHA-256 `cd30961a...d9cf`）後、各seedで `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t120/expanded200k/teacher-only-seed-<seed>/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t120/oracle/teacher-only-seed-<seed>.json` をフルスクラッチ実行。各局面をatomic checkpointし、同一コマンドでresume可能。3回ともv2 mean regret=`1.5666666666666667`を完全再現（M2 PASS）。candidate−v2のpaired bootstrap（100,000回、seed 96002）95% CIはseed1 +0.9000 [-0.1667,2.1000]、seed2 +0.8000 [-0.3000,2.0000]、seed3 +0.7667 [-0.2667,1.9333]で全て`no_significant_difference`。3seedの局面平均とv2の対応差は+0.8222石、95% CI [-0.2333,2.0000]で有意差なし。ただし全seedの点推定はv2より悪い。

**外挿検証**: T113式の200k予測1.9196石に対し実測平均2.3889石（+0.4693、24.4%悪化）、実train 180,110件での予測1.9778石に対しても+0.4110石。従って1.92という点推定は未再現。ただし45kの2.8から改善方向は再現し、5点再fitは傾き-1.0113石/log10、R²=0.9515。元4点回帰の200k 95% prediction interval [1.0610,2.7782]および3seed平均局面bootstrap CI [1.4667,3.4556]はいずれも今回実測と1.92を包含するため、統計的な明確な反証ではない。

**閾値差**: T113 primaryはexact閾値24、expanded200kは20で、空き21–24の子がlevel 16見積もり（exact率0.346→0.268）。ラベルノイズ増加は外挿未達の一因になり得るが、年代範囲・局面選定・phase/opening分布も同時に異なるため閾値だけへ因果帰属できない。

**結論3点**: (1) 外挿の改善方向は再現したが1.92石の点推定は未再現（実測2.3889±0.0694石はseed SD、range 2.3333–2.4667）。(2) v2との差+0.8222石はpaired bootstrap 95% CIが0を跨ぎ有意でないが、点推定は全seedで悪い。(3) 3seed安定・45k比改善・v2差非有意なので、既に得た候補をT090c対局スモークへ進める価値は限定付きである。ただし採用前提ではなく最終棄却ゲートとして扱う。本番配線・対局・採用判定は未実施。

**コミット対象成果物**: `bench/edax-compare/t120_teacher_only_200k.meta.json`、`bench/edax-compare/t120_teacher_only_200k_report.md`。コーパス・重み・oracle生JSONは`train/data/`のgitignore領域。コミットハッシュは環境制約により未作成（オーケストレーター代行）。

**最終検証**: `python -m json.tool bench/edax-compare/t120_teacher_only_200k.meta.json` PASS、UTF-8化け文字チェック PASS、`git diff --check` PASS、`cargo test -p train` PASS（56 unit + real_data 1、失敗0）。学習コマンドを同一run dirへ再実行し、`resume mix=teacher-only seed=1 epoch=34` / seed2 epoch=37 / seed3 epoch=35を確認してexit 0（完走済みcheckpointを正しく認識）。
