---
id: T126
title: 蒸留100万規模化の投資判断のための切り分け実験(ラベル要因 vs 量・分布要因)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: Codex gpt-5.6-sol(codex-task)
attempts: 0
---

# T126: 蒸留100万規模化の切り分け実験

## 目的(ユーザー指示 2026-07-17 午後)

> 次にやるべきは蒸留局面を100万規模に増やすかを考えてやりたい

100万規模の教師ラベル生成(約2日)〜WTHOR全局面ラベル付け(約8日)への投資判断に必要な切り分けを、**学習だけの安い実験**で行う。問い: 「v4×蒸留20万=2.87石の悪さは、(a)ラベルの質/分布のせいか、(b)単にデータ量のせいか」。

## 実験設計

1. **主実験: v4×WTHOR@縮小サンプル**: WTHOR学習のtrainサンプルを蒸留コーパスと同規模(約18万サンプル、決定的サブサンプル)に絞ってv4を学習(3seed)し、oracle regretを計測。
   - 比較: v4×蒸留@18万(実測2.8667) vs v4×WTHOR@18万(本実験) vs v4×WTHOR@全量400万(実測1.111)。
   - 読み方: WTHOR@18万が2.5石以上なら「量が支配的 → 蒸留増量の価値大」。1点台なら「WTHOR側の分布/密度特性が支配的 → 蒸留増量は分が悪い」。
2. **副実験(安価なら): v4×蒸留の学習曲線**: expanded200kの入れ子サブセット(45k/90k/180k、T109の層化サブセット方式)で各1seed学習し、v4蒸留の傾きを実測 → 100万/400万への外挿を出す。
3. **判断材料のまとめ**: 上記から「100万蒸留(2日)・400万全量(8日)・見送り」の期待値比較表を作り、推奨を明記(最終判断はユーザー)。

## 前提・注意

- **T125(v4対局審査)の完了後に実行**(対局の時間計測を汚染しないため。オーケストレーターが委譲タイミングを制御)。
- WTHORサブサンプルは決定的(seed固定)で、サンプル数を作業ログに正確に記録。学習ハイパーパラメータはT124のWTHOR学習と同一(サンプル数のみ変更)。トレーナーにサブサンプル機能が無ければ最小限追加(既存挙動不変、テスト付き)。
- oracle採点はM2ガード(v2行1.5667完全再現)必須。checkpoint/resume対応。
- 成果物: `bench/edax-compare/t126_distill_scale_decision.meta.json` / `_report.md`(コミット対象)。重み等はgitignore領域。

## やらないこと(スコープ外)

- 100万/400万コーパスの生成そのもの(判断後の別タスク)
- 本番配線・採否判定
- v4アルゴリズム変更

## 受け入れ基準(検証コマンド)

- [ ] v4×WTHOR@18万(3seed)のregretがM2ガード付きで確定
- [ ] (実施時)蒸留学習曲線サブセットの結果と外挿がある
- [ ] 3構成比較(蒸留18万/WTHOR18万/WTHOR全量)と投資判断の推奨がレポートにある
- [ ] `cargo test -p train`パス(コード変更時)
- [ ] メタ・レポートのみパス指定でコミット(`(T126)`)
- [ ] タスク完了時点で当該タスク由来の差分・未追跡が`git status --short`に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

## 作業ログ(担当エージェントが追記)


### 2026-07-17 13:58 JST Codex implementation and experiments complete

- Preconditions: read AGENTS.md, README, T109, T124, and T125 as UTF-8; initial `git status
  --short` was empty. T125's header still says in_progress, but its 13:31 JST completion log and
  artifact exist, and the orchestrator delegated T126, so the timing prerequisite was satisfied.
- Implementation: added `--train-subset-size` and `--subset-seed` (default 42) to
  `train/src/bin/train_patterns_v3.rs`. Only the WTHOR train split is stratified by v4 empty-count
  phase. Each phase takes a prefix of a fixed shuffle using
  `floor(target * phase_count / total)`, following T109. Added tests for determinism/nesting,
  stratified proportions, and target-at-or-above-total behavior. Without the option, the existing
  full train set and identity string remain unchanged. With it, target/actual/seed/full counts are
  included in the resume identity.
- Primary training command: `target/release/train_patterns_v3.exe --configs v4 --seeds 1,2,3
  --epochs 20 --output-dir train/data/t126/wthor-v4-180k --train-subset-size 180110
  --subset-seed 42`. Full WTHOR train=3,988,509, target=180,110, actual after phase floors=180,077,
  frozen=442,995. All three seeds completed 20 epochs; frozen MAE=17.944658/17.892121/17.915659.
  Weights and identity were atomically saved each epoch. Re-running the command skipped epoch
  computation for all three completed runs.
- Primary T096 60-position oracle: seed 1/2/3 regret=3.9667/3.6667/3.8333, mean **3.8222**,
  seed sample SD=0.1503. Every run exactly reproduced v2=1.5666666667 (M2 PASS). Candidate-v2
  differences and paired-bootstrap 95% CIs were +2.4000 [0.9000,4.1000], +2.1000
  [0.6667,3.7667], and +2.2667 [0.8000,3.9667], all candidate_worse. Oracle/v2/candidate rows
  were atomically checkpointed per position and resume under identical provenance.
- Attribution: v4 distilled 180k=T124 2.8667 (T126 nested seed1=2.7667), v4 WTHOR 180k=3.8222,
  and v4 WTHOR full=T124 1.1111. Reduced WTHOR is far above the prespecified 2.5 threshold, while
  distillation is about one disc better at equal volume. The combined distillation label/distribution
  effect is favorable; **data volume dominates** the deficit.
- Secondary curve: trained nested expanded200k subsets at targets 45k/90k/180k with subset seed 42,
  v4 teacher-only, training seed 1. Actual counts=44,965/89,966/179,957; best/completed epochs=
  39/40, 37/37, 26/31. Oracle regret improved monotonically **4.7667 -> 3.6333 -> 2.7667** and
  all points passed M2. Saturating inverse-sqrt and fitted-power-law sensitivity models give planning
  ranges of 1.4--1.63 at one million and 0.80--1.21 at four million (not statistical CIs).
- Recommendation: make the approximately two-day one-million corpus a staged investment, remeasure,
  and only then decide on the approximately eight-day four-million corpus. Continue to four million
  only if one million is approximately 1.4 or better and sustains a credible path below existing
  v4 WTHOR 1.111; stop by default at 1.4--1.7 and stop above 1.7.
- Resume checks: WTHOR completed-run skip, distillation `resume ... epoch=31`, and completed oracle
  rerun without new Edax rows were observed. Raw weights, metrics, checkpoints, and oracle JSON are
  under gitignored `train/data/t126/`.
- Verification: `cargo test -p train` PASS (library 56, new binary tests 3, real_data 1);
  `python -m json.tool bench/edax-compare/t126_distill_scale_decision.meta.json` PASS; metadata vs
  all six raw oracle JSON values PASS; `git diff --check` PASS; UTF-8 corruption check PASS.
- Artifacts: `bench/edax-compare/t126_distill_scale_decision.meta.json` and
  `bench/edax-compare/t126_distill_scale_decision_report.md`. Commit hash not created because `.git`
  is read-only. Orchestrator commit files: those two artifacts plus
  `train/src/bin/train_patterns_v3.rs`, subject `(T126)`. This task-file log is not a commit target.
