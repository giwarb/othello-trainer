---
id: T113
title: teacher-only学習曲線(同一トレーナー内の密度勾配計測)
status: in_progress # todo | in_progress | review | done | blocked
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
