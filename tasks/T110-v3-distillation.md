---
id: T110
title: v3特徴×蒸留の組み合わせ実験(表現力仮説の検証)
status: in_progress # todo | in_progress | review | done | blocked
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
