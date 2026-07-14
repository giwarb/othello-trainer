---
id: T090b
title: Edax教師蒸留学習(混合損失: teacher Huber + pairwise ranking + WTHOR outcome)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T090b: Edax教師蒸留学習

## 目的

T090aで生成した教師コーパス(Edax level 16 / exact の全合法手評価値、primary 50,000局面)を使い、パターン評価の重みを蒸留学習する。T087/T088で確定した「WTHOR最終石差ラベルが律速」への直接の対策であり、**評価関数改善の本命**。

## 委譲体制の注記

本来は難易度ルーティングでCodex対象。Codex利用上限(〜7/20)中はimplementer(Sonnet)フォールバック(ユーザー承認済み)。ただし**Codexが復帰していれば通常ルーティング(codex-task.ps1 -Model gpt-5.6-sol)に戻す**。仕様に無い設計判断は推測で進めず停止・報告。

## 背景・コンテキスト(必読文書)

- **設計書(規範)**: `tasks/design/T085-beat-level10-report.md` の **§9 T090b節**。
- 教師コーパス: `train/data/teacher/corpus_primary.jsonl`(T090a成果物、gitignore領域。スキーマは `bench/edax-compare/gen_teacher_corpus.py` 冒頭docstringが正本)。smoke 1,000局面(`corpus_smoke.jsonl`)を開発・動作確認用に使える。
- 学習基盤: T088の `train/src/t088_experiment.rs` / `experiment.rs`(年代分割・D4正規化・Huber・early stopping・run identity・epoch単位checkpoint/resume)を再利用・拡張する。
- 特徴量はv2(22インスタンス/6クラス)のまま。PWV3形式で書き出す(T087実装済み)。

## 要件(設計書§9 T090b節が規範)

1. **混合損失**: `0.6 × Huber(局面のteacher value) + 0.3 × pairwise ranking loss + 0.1 × WTHOR outcome Huber` を基準構成とし、混合比のablation(少なくとも {teacher-only 1.0/0/0、基準 0.6/0.3/0.1、ranking無し 0.7/0/0.3} の3構成×2seed以上)を行う。
2. **pairwise ranking loss**: teacher best child と「自作エンジン選択 or 上位候補child」の差を学習。全合法手総当たりはせず、**best / engine choice / X/C candidate / teacher上位2手**に限定してペアを構成(設計書どおり)。
3. **WTHOR outcome項**: 完全に捨てない(teacher近似の癖への過適合防止、重み0.1)。T088のcanonical平均outcomeを流用。
4. **学習制御**: T088で実装済みの early stopping / LR decay / epoch単位checkpoint+resume / run identity照合をそのまま使う。validation は teacher コーパスのホールドアウト(局面単位、canonical重複なし)で行い、選択に frozen セットを使わない。
5. **採用ゲート**(§9): (a) frozen teacher set で best-move agreement 改善 (b) mean regret 20%以上改善(Edax oracle、compare_pattern_v3.py) (c) WTHOR 2024 MAE が10%以上悪化しない (d) NPS 80%以上 (e) **level 10 の20局スモークで平均石差5石以上改善した候補だけ60局へ進む**(60局はT090cの範囲。本タスクは20局スモークまで)。
6. **長時間実行ルール厳守**: run単位・epoch単位のcheckpoint/resume、進捗逐次ログ、実行計画と所要見込みを開始時に作業ログへ。
7. 採用候補が出た場合: 新重み(PWV3、8MB以下)をコミット対象に含める(例: `train/weights/pattern_v2d.bin`)。**engine既定評価への配線はT090c合格後の別タスク**。不採用も正常完了(設定・指標を残す)。

## やらないこと(スコープ外)

- 60局・100〜200局の最終棋力判定 = T090c
- engine既定評価・アプリへの配線
- 教師コーパスの追加生成(拡張200kはT090bの結果を見て判断)
- v3特徴の同時投入(蒸留がv2で成功した後の追加ablation候補として別途判断)
- 探索側の変更

## 受け入れ基準(検証コマンド)

- [ ] `cargo test -p train` / `cargo test -p engine` 全件パス(pairwise loss・混合損失・コーパスローダの単体テスト含む)
- [ ] `cargo test -p engine --release --test ffo_bench` — FFO #40-44 不変(探索・既定評価は無変更)
- [ ] 混合比ablation(3構成×2seed以上)が完走し、validation指標の表が作業ログにある
- [ ] 採用ゲート(a)〜(d)の実測値と判定が作業ログに明記されている
- [ ] ゲート通過候補があれば20局スモーク(level 10、node160k)を実施し石差を記録。5石以上改善ならT090c進出を報告
- [ ] 新重みを作った場合は8MB以下・PWV3検証パス
- [ ] 変更対象ファイルのみパス指定でコミット・push、Actions成功確認(実装ワーカーがコミット可能な場合。Codexならオーケストレーター代行)
- [ ] タスク完了時点で、当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
