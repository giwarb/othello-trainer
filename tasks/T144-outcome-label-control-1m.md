---
id: T144
title: ラベル対照実験@1M: 蒸留と同一局面でWTHOR最終石差ラベル学習を比較(ユーザー指示)
status: done # verifier合格(全数値独立再現・CI完全一致)、代替レビュー省略(opt-inフラグのみの軽微変更と裁定)、2026-07-20
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

### 2026-07-20 01:4x JST 完了

- **前提確認**: 開始時`git status --short`は空(train/src変更含む)。T127dのteacher-only@1M(899,467件、regret=1.900、3seed完全一致)を`bench/edax-compare/t127d_v4_1m_training.meta.json`から参照。
- **カバレッジ計測**: 既存`outcome_matched_train`manifestフィールドで、corpus_expanded1mのtrain split(899,467)中、WTHOR outcome一致件数=**220,450件(24.51%、欠落75.49%)**。閾値2%を大幅に超過したため要件2の等実効集合対照を実施(必須)。T112当時(45k、欠落約19.8%)より欠落率が大幅に高い(コーパスの年範囲2000-2024 vs outcome参照表2015-2023の非重複が一因と推定、断定はせず)。
- **軽微なトレーナー追加**: `train/src/t090_distillation.rs`に値なしフラグ`--outcome-matched-only`を追加(train splitをoutcome一致レコードのみへ絞る、`--train-subset-size`より先に適用)。未指定時はmanifest/identity/挙動とも既存と完全不変(既存の一貫した設計方針を踏襲)。新規関数`filter_outcome_matched`+ユニットテスト2件(順序保持・全件一致時no-op)。`cargo test -p train`: 58 passed(56既存+2新規)、0 failed。トレーナーの大規模改修ではなく軽微追加のみ(スコープ内)。
- **学習**:
  - outcome-only@1Mフル、v4、seed1/2/3、T127dの1M runと同一構成(--jobs 1、reference-weights pattern_v2.bin、train-subset-size無指定)。全train split(899,467)を対象にしたが、no-op機構により実効学習は220,450件相当。3seedとも60epoch上限未到達でpatience停止(best/completed epoch 16/17, 12/17, 14/16)。
  - 等実効集合対照: teacher-only、seed1のみ、`--outcome-matched-only`指定(train=220,450に絞り込み確認済み)。best/completed epoch=27/27。
- **oracle評価(T096 60局面、M2ガード)**: 全4回(outcome-only seed1/2/3、teacher-only対照)でv2=1.5666666666666667を完全再現、PASS。
  - outcome-only: seed1=4.0333, seed2=3.8000, seed3=3.9000、3seed平均=**3.9111**、sample SD=0.1171。teacher-only@1M(1.900)とのpaired bootstrap(3seed局面平均): 差分+2.0111、95%CI[0.7222,3.4222]、outcome_worse(有意)。
  - teacher-only対照(N=220,450): regret=**3.8333**。teacher-only@1M(N=899,467)との比較: 差分+1.9333、95%CI[0.6667,3.3333](有意にサンプル数減少分が悪化)。**outcome-only(同一N)との比較: 差分-0.0778、95%CI[-1.5667,1.3333]、no_significant_difference** — 同一Nでは両ラベルが統計的に区別できない。
- **事前登録解釈への当てはめ**: outcome-only@1M=3.9111は「≦1.9程度」ではなく明確に悪い(T112の45k対照3.6-3.8と同水準)→ **ラベル問題説を棄却し、量説を採用**。さらに等N対照実験により、これが消去法ではなく直接的な確認的証拠であることを示した(同一220,450件でteacher-onlyもoutcome-onlyとほぼ同じ悪化を示す)。T127dのK=4密度説と併存しうる要因として報告(定量的な寄与分解は本タスクの範囲外)。
- **eval_cliバイナリの注記**: 本タスクの4回のoracle計測は全て同一eval_cliビルド(SHA-256 e56092090e...)を使用(各oracle JSONのmetadata.evalCliSha256で確認)。T127dのteacher-only@1M参照値のビルド(e874bb4c...)とは異なる(セッション間でmainにT139等の変更が入り共有target/releaseが再ビルドされたため)が、両ビルドともv2=1.5666666666666667を完全再現しスコアリング挙動の一貫性を確認済み。
- **成果物**: `bench/edax-compare/t144_outcome_label_control_1m.meta.json`、`bench/edax-compare/t144_outcome_label_control_1m_report.md`(新設)。`train/src/t090_distillation.rs`(フラグ追加)。学習重み・oracle生JSON・ログは`train/data/t144/`(gitignore領域)。`bench/edax-compare/`の既存pyファイル群(T143成果物)は変更していない。
- **コミット**: `git add train/src/t090_distillation.rs bench/edax-compare/t144_outcome_label_control_1m.meta.json bench/edax-compare/t144_outcome_label_control_1m_report.md` → commit `bfae49a` → `git push origin main`(0d64f25..bfae49a)。完了時`git status --short`はクリーン(gitignore領域除く、tasks/本ファイルの作業ログ追記のみ未コミットで意図通り)。

### 2026-07-20 verifier検収

- **`git show bfae49a --stat`**: 3ファイルのみ(`train/src/t090_distillation.rs` 68行追加、`bench/edax-compare/t144_outcome_label_control_1m.{meta.json,report.md}` 新設)。PASS。
- **数値の独立再集計**: `train/data/t144/oracle/*.json`(gitignore領域、ローカルに現存)を直接読み、4run全てで`v2.meanRegret=1.5666666666666667`を確認(M2ガードPASS×4)。`candidate.meanRegret`はseed1=4.033333333333333/seed2=3.8/seed3=3.9/対照(teacher-only@N=220,450)=3.8333333333333335で報告値と完全一致。3seed平均=3.911111...、sample SD(n-1)=0.11713を自算し報告の3.9111/0.1171と一致。
- **カバレッジ**: `train/data/t144/outcome-only-1m/manifest.txt`および`teacher-only-matched-subset/manifest.txt`を直接読み、`train=899467`/`outcome_matched_train=220450`(220450/899467=24.513%)を確認。さらに`train/data/t127d/expanded1m-v4-1m/manifest.txt`(T127d当時の同一corpus実行)にも同一の`outcome_matched_train=220450`が既に記録されており、本タスク固有の新規算出ではなく既存manifestフィールドの参照であることも確認。
- **`--outcome-matched-only`未指定時の不変性**: `git show bfae49a -- train/src/t090_distillation.rs`を読み、フラグ未指定時は`outcome_matched_manifest_line`が空文字列のままmanifest/identity文字列に影響しないことをコードで確認(outcome-only-1mの3 run実際のmanifest.txtにも`outcome_matched_only=`行が存在しないことで裏付け)。`cargo test -p train`をローカル実行し**58 passed; 0 failed**(新規2件`filter_outcome_matched_keeps_only_records_with_outcome_and_preserves_order`/`filter_outcome_matched_is_a_no_op_when_all_records_have_outcome`含む)を確認、報告と一致。
- **paired bootstrap CIの独立再現**: `compare_pattern_v3.py`の`paired_bootstrap`(`random.Random(seed).choice`ベース、seed既定96002・samples 100000)と同一アルゴリズムを自前のPythonスクリプトで実装し、T127dのteacher-only@1M生oracle JSON(`train/data/t127d/oracle/1m-seed-{1,2,3}.json`、ローカルに現存、3seedとも meanRegret=1.9で一致)とT144の4本のoracle JSONの`results[].rows[].regret`(60局面ペア)から再計算した結果、以下が完全一致(浮動小数点誤差内): outcome-only seed1 vs teacher-only@1M = +2.1333 [0.8000,3.5667]/seed2=+1.9000 [0.6333,3.2667]/seed3=+2.0000 [0.6333,3.4667]/3seed平均=+2.0111 [0.7222,3.4222]/control(N=220,450) vs teacher-only@1M full=+1.9333 [0.6667,3.3333]/control vs outcome-only同N平均=-0.0778 [-1.5667,1.3333]。全てPASS。
- **コミット規律・push**: `bfae49a`は`origin/main`と一致(`git fetch`後`git log HEAD..origin/main`空)、`git status --short`はクリーン(検収時点のtasks/配下の別タスク差分・未追跡ファイルはT144由来ではない)。
- **事前登録解釈への当てはめ**: outcome-only@1M=3.9111はT112の45k対照(3.6〜3.8、`tasks/T112-label-loss-ablation.md`で実測確認)と同水準で「明確に悪い」に該当し、レポートの「ラベル問題説を棄却、量説を採用」という結論は数値と整合。等N対照(3.8333 vs 3.9111、有意差なし)は消去法ではなく直接的な確証データとして機能しており、レポートの記述と整合。
- **付随観察(要オーケストレーター判断、合否には影響しない)**: タスクファイルのfrontmatterが`status: todo`/`attempts: 0`のままで、作業ログの完了報告・commit記録と乖離している(進捗管理ルール上はレビュー中/doneへの更新漏れの可能性)。verifierはfrontmatterを書き換える権限がないため、事実として報告のみ行う。
- **総合判定**: 受け入れ基準4項目すべてPASS。**合格**。
