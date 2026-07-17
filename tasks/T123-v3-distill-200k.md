---
id: T123
title: v3特徴×200k蒸留(teacher-only)実験
status: in_progress # todo | in_progress | review | redo | done | blocked
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
