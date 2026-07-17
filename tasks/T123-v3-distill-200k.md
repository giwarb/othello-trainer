---
id: T123
title: v3特徴×200k蒸留(teacher-only)実験
status: done # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T123: v3特徴×200k蒸留(teacher-only)実験

## 目的(ユーザー指示 2026-07-17 昼)

T120(v2×200k蒸留=2.39石、v2×WTHOR 1.57超えならず)の追試として、**表現力の高いv3特徴で同じ200k蒸留**を行い、蒸留路線がモデル容量律速だったのかを確認する。ユーザー指示:「v3×20万蒸留を試した後、v4(ステージ1石刻み)の実験へ」— 本タスクはその第1段。

## 前提・既存資産

- コーパス: `train/data/teacher/corpus_expanded200k.jsonl`(T114、閾値20世代)。
- 学習基盤: `t090_distillation.rs`(pattern-set選択=T110導入済み、teacher-only損失=T112/T113/T120で使用済み)。**T120と同一ハイパーパラメータ・同一手順のpattern-setだけv3版**が理想(差分を最小化)。
- 参考実測: v3×蒸留50k=2.67石(T110)、v2×蒸留200k=2.389石(T120)、v3×WTHOR=1.40石(T111/T121、今日採用)、v2×WTHOR=1.5667石。
- oracle採点: T096の60局面、v2行1.5667の完全再現ガード(T110 M2)必須。

## 要件

1. expanded200k全量でv3特徴×teacher-only損失を**3seed**学習(checkpoint/resume対応)。T120からの変更点(pattern-set以外)があれば作業ログに明記。
2. 各seedのoracle regret計測(M2ガード込み)。T120(v2×蒸留200k)・T111(v3×WTHOR)・v2×WTHORとの比較表を作る。
3. 結論: (a)v3化で蒸留がどれだけ伸びたか、(b)v3×WTHOR(1.40)との差、(c)次段(v4)や「WTHOR全局面ラベル付け(検討中)」への示唆、をレポートに明記。
4. 実験メタ・レポート(`bench/edax-compare/t123_v3_distill_200k.meta.json` / `_report.md`)をコミット対象に。重み等はgitignore領域。
5. `cargo test -p train` 全件パス(コード変更時)。

## やらないこと(スコープ外)

- v4特徴の実装(T124)
- 本番配線・採否判定
- コーパスの追加生成

## 受け入れ基準(検証コマンド)

- [ ] 3seedの学習完走とoracle regret確定(M2ガード付き)
- [ ] T120/T111/v2との比較表と結論3点がレポートにある
- [ ] checkpoint/resume対応の記録
- [ ] `cargo test -p train`パス(コード変更時)
- [ ] メタ・レポートのみパス指定でコミット(`(T123)`)
- [ ] タスク完了時点で当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)

### 2026-07-17 12:10 JST Codex 3seed学習・oracle評価完了

- 事前確認: `AGENTS.md`、T120/T110/T111/T121の作業ログと既存trainer・採点スクリプトを確認。開始時`git status --short`は空で、競合する学習・採点プロセスなし。コミット済みソースから`cargo build --release -p train --bin train_distillation`と`cargo build --release -p engine --bin eval_cli`を実行し成功。eval_cli SHA-256は`cd30961a...d9cf`。
- 学習: `target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t123/expanded200k-v3 --mixes teacher-only --seeds 1,2,3 --pattern-set v3 --reference-weights train/weights/pattern_v2.bin --jobs 1`を実行。split=train 180,110 / validation 9,685 / frozen 10,205、3seedともearly stoppingで完走（best epoch 26/29/30、completed epoch 30/31/30）。T120からの変更はpattern-set v2→v3と新規出力先のみで、コーパス、teacher-only損失、seed、max 60 epoch、LR schedule、L2=1e-5、reference weights、jobs=1は同一。
- checkpoint/resume: epochごとの重み・state・metricsをatomic保存する既存機構を使用。完走後に同一学習コマンドを再実行し、`resume mix=teacher-only seed=1 epoch=30` / seed2 epoch=31 / seed3 epoch=30、exit 0を実測確認。oracleも局面単位atomic checkpointで同一provenanceなら同一コマンドresume対応。完走後、別タスクT122のコミットでHEAD treeが`4ec89e...`から`4cf117...`へ進んだ後の再実行は`resume identity mismatch; refusing stale checkpoint`で拒否され、stale checkpoint拒否ガードも実測確認した（保存済み完走結果には影響なし）。
- oracle: 各seedをフルスクラッチで `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t123/expanded200k-v3/teacher-only-seed-<seed>/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t123/oracle/teacher-only-seed-<seed>.json` により採点。regretはseed 1/2/3=`1.8667 / 1.8667 / 2.3000`石、平均`2.0111`、seed SD`0.2502`、range`1.8667–2.3000`。全3回でv2行=`1.5666666666666667`を完全再現しM2ガード通過。candidate−v2の個別paired bootstrap 95% CIはseed 1/2 `[-0.5000,1.1333]`、seed 3 `[-0.2000,1.7333]`。3seed局面平均−v2は+0.4444石、CI `[-0.3556,1.2778]`。
- 比較・結論: T120 v2×200k蒸留平均2.3889石から0.3778石改善（v3−v2蒸留の局面対応CI `[-1.5333,0.6444]`）したが有意ではない。T111 v3×WTHOR 3seed平均1.4778石より+0.5333石、T121採用候補1.4000石より+0.6111石悪い。容量律速仮説は部分支持に留まり、v4は試す価値がある一方、WTHOR全局面ラベル付けで分布・ラベル要因を切り分ける価値が高いと結論。

- 成果物: `bench/edax-compare/t123_v3_distill_200k.meta.json`、`bench/edax-compare/t123_v3_distill_200k_report.md`。学習重み・metrics・oracle生JSONは`train/data/t123/`（gitignore領域）。コード変更なし。v4実装、本番配線・採否判定、コーパス追加生成は未実施。
- 検証: `python -m json.tool bench/edax-compare/t123_v3_distill_200k.meta.json` PASS、UTF-8化け文字チェック PASS、`git diff --check` PASS、`cargo test -p train` PASS（56 unit + real_data 1、失敗0）。生JSONから3seed平均・SD・CIを独立再集計し、メタ・レポート記載値と一致。
- コミットハッシュ: 未作成（`.git`書き込み禁止のためオーケストレーター代行）。コミット対象は上記メタ・レポート2ファイルのみ、件名 `(T123)`。タスクファイルは作業ログ追記のみでコミット対象外。
