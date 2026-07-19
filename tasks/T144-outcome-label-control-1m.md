---
id: T144
title: ラベル対照実験@1M: 蒸留と同一局面でWTHOR最終石差ラベル学習を比較(ユーザー指示)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet、T127dワーカー継続)
attempts: 0
---

# T144: 同一局面ラベル対照@1M

## 目的(ユーザー指示 2026-07-20)

「蒸留と全く同じ局面で、ラベルをWTHOR最終石差にした教師データを作って学習し、蒸留(Edax level16/exactラベル)と比較する。それでもWTHOR側が勝つなら、蒸留の仕方(Edax level16を使うこと)に問題があるかもしれない」— T127dの結果(teacher-only@1M=1.900がv2×WTHOR=1.5667に届かない)の原因を、**ラベル要因**として同一局面・同一トレーナー・同一ハイパラで分離する。

## 事前登録の解釈

- outcome-only@1M(同一局面)が teacher-only@1M(1.900)と**同等以上(≦1.9程度)** → Edax level16ラベル側に問題がある可能性が高い(蒸留の仕方を再検討: level16の質、exact混在、diff情報の未活用等)。
- outcome-only@1M が**明確に悪い**(T112の45k対照では outcome 3.6-3.8 > teacher 2.8 だった) → ラベルは原因ではなく、残る説明は量(WTHOR学習443万 vs 蒸留90万)・分布(層化/X/Cオーバーサンプル)・トレーナー差の側。
- 参考: v2×WTHOR(1.5667)は別トレーナー・旧103万サンプル(19,119局全手・自然分布)の学習であり、本実験と直接比較する際はトレーナー交絡6軸(T112申し送り)に留意。

## 背景・基盤

- コーパス: `train/data/teacher/corpus_expanded1m.jsonl`(T127c検証済み、train split=899,467件)。
- トレーナー: `train/src/t090_distillation.rs` は T112 で outcome-only mix を導入済み(WTHOR再生による最終石差ラベル)。**T112当時の既知問題**: 2024年重複除外ポリシーによりoutcomeが引けないレコードが約19.8%発生し、実効学習集合が系統的に偏った。1Mでの実効カバレッジを必ず計測・報告すること。
- T127dの既存結果(比較対象): teacher-only@1M 3seed=1.900、学習構成は tasks/T127d-v4-1m-training.md 作業ログのコマンド参照。

## 要件

1. **outcome-only@1Mフル、v4、seed 1/2/3**: T127dの1M runと同一構成(v4、--jobs 1、reference-weights、epoch checkpoint/resume)でmixのみ outcome-only に変更して学習し、T096 oracle 60局面で評価(M2ガード付き)。
2. **カバレッジ対等化**: outcome-onlyの実効学習件数がtrain split(899,467)から大きく欠ける場合(目安: 欠落>2%)、**同一の実効集合(outcomeが引けるレコードのみ)でteacher-onlyも1本(seed1)再学習**し、「完全に同一の局面集合」での直接比較を成立させる。欠落が軽微ならその旨を数値で示し省略可。
3. **統計**: 3seed平均・SD、teacher-only@1M(1.900)とのpaired bootstrap CI、v2(1.5667)との位置づけ。
4. **報告**: 実効件数(全mix)、oracle結果、事前登録解釈のどちらに該当するかの1段落。bench/edax-compare/ に追補レポート(t127d_v4_1m_training_report.md への追記または新設 t144_*.md)+meta jsonで記録。
5. 長時間実行ルール(epoch checkpoint/resume・進捗ログ)はT127dと同様(1runは数分想定なので軽め運用でよい)。

## スコープ外

- トレーナーの大規模改修(outcome-only mixの既存実装を使う。カバレッジ計測・軽微修正は可)
- 4M生成、対局ゲート、採用判定、app/engine変更(Pages確認不要)
- bench/edax-compare/ のT143成果物(py群)の変更

## 受け入れ基準

1. outcome-only@1M 3seedのoracle regretがM2ガード記録付きでレポートにある
2. 実効学習件数(カバレッジ)が報告され、必要な場合は同一実効集合でのteacher-only対照が実施されている
3. 統計(3seed平均・SD・paired CI)と事前登録解釈への当てはめが記載されている
4. 変更ファイルはパス明示でコミットしmainへpush、完了時 `git status --short` クリーン(gitignore領域除く)

## コミット規律

- コミットしてよいのはタスクの変更対象ファイルのみ。`tasks/` と `CLAUDE.md` はコミットしない(作業ログ追記は行う)

## 作業ログ

(ワーカーが節目ごとに追記)
