---
id: T090b
title: Edax教師蒸留学習(混合損失: teacher Huber + pairwise ranking + WTHOR outcome)
status: in_progress # todo | in_progress | review | redo | done | blocked
assignee: codex(gpt-5.6-sol)
attempts: 1
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

## 明確化(2026-07-15、Codexの停止質問4点へのオーケストレーター裁定)

1. **pairwise lossの数式 = teacher値差のHuber回帰**(設計書「差を学習」の字義どおり、margin/温度の追加ハイパラを避ける):
   - 符号規約: 子局面の教師値 t(move) はコーパスどおり「親の手番視点」(bestValue=max)。モデル側の手のスコアは negamax で `m(move) = −f(child)`(f はパターン評価、子局面の手番視点、石差単位に換算)。
   - ペア損失 = `Huber_δ4( (m(b)−m(o)) − (t(b)−t(o)) )`(δ=4はT088採用値を流用)。b=teacher best child、o=ペア相手。
2. **engineChoice = 現行本番重み pattern_v2.bin の static 評価 argmax**(`argmax_move −f_v2(child)`)を**データセット構築時に一度だけ**計算して固定(決定論・安価。探索は使わない)。engineChoice==teacher best の局面ではそのペアをスキップ(他のペア種は残す)。ペア種は仕様どおり best×{engineChoice, X/C candidate(diffFromBest最大のX/C手等の代表1手), teacher上位2位}に限定し、重複ペアは除去。
3. **分割 = canonicalKeyのハッシュによる決定論的 position分割: train 90% / validation 5% / frozen teacher test 5%**(seed非依存・再現可能。件数を作業ログとmanifest類に記録)。frozenはゲート(a)のbest-move agreement等の最終判定専用でチューニングに使わない。smokeコーパスは開発動作確認専用で学習・評価のどの集合にも入れない(canonical重複があってもprimary側の割当を正とする)。ゲート(b)のoracle regretは従来どおり `compare_pattern_v3.py`+t085固定局面コーパス(教師データとは独立)で測る。
4. **WTHOR outcomeが無いレコード(engineLoss等)**: outcome項を省略し、そのサンプル内で残り2項の係数を再正規化(0.6/0.3→2/3・1/3)。該当は65/50,000件で影響は微小だが、規約として明記。

## フィードバック(やり直し時にオーケストレーターが記入)

### redo #1(2026-07-15、verifier+codex-review両不合格)

**ブロッカー: パス局面の手番・符号処理の誤り**(codex-review検出、verifierがPython独立実装で規模を完全一致裏付け: 相手パス子2,669件/該当1,944局面/teacher bestがパス誘発1,287局面)。`train/src/t090_distillation.rs` の3箇所(engineChoice構築・pairwise学習・metrics計算)が無条件に `-model.predict(child, mover.opposite())` を使っているが、正しくは:
- 通常の子(相手に合法手あり): `−f(child, 相手)`
- **相手パスの子(相手に合法手なし・元手番に合法手あり)**: `+f(child, 元手番)`(符号反転なし・手番同じ。`engine/src/search.rs:1473` / `eval_cli apply` と同規約)
- **終局の子(双方合法手なし)**: パターン評価ではなく最終石差(親手番視点)を直接使う

修正項目:
1. 上記3箇所の符号規約を修正し、**パスあり/終局の子局面を含む専用テスト**を追加(初期局面のみのテストでは検出できなかった教訓)。
2. **3構成×2seed・frozen指標・採用ゲート(a)〜(e)を全面再実行**。前回の数値・不採用結論は無効として扱い、新しい数値で判定し直す(ゲート(b)の測定系自体は正しいことをverifierが確認済みなので再利用してよい)。
3. **(中1) WTHOR 2024の学習混入を解消**: outcome mapへの集約をT088の年代分離(2015〜2023のみ学習側、2024はゲート(c)専用)に合わせ、teacherコーパスとのcanonical重複方針を作業ログ/manifestに記録。
4. **(中2) コーパスローダのテストをfixture化**: gitignore対象ファイルの有無に依存せず、コミット可能な最小JSON fixture(またはテスト内生成)でデシリアライズ・canonicalKey照合・合法手検査・bestValue整合・ペア構築を常に検証する。
5. **(軽微)**: metrics.tsvのresume時重複行の防止(checkpoint後に書く or 再開時に切り詰め)、CLI数値引数のparse失敗を明示エラー化。
6. 完了時: cargo test(新テスト込み)・FFO不変・作業ログに新しいablation表とゲート判定を記録。コミット対象一覧明記(オーケストレーター代行)。

## 作業ログ(担当エージェントが追記)

### 2026-07-15 pre-implementation investigation (specification clarification required)

- Read `AGENTS.md`, design report section 9, the authoritative teacher-corpus schema,
  the T088 training framework, and existing gate measurement scripts. Confirmed that
  the local 50,000-position primary corpus and 1,000-position smoke corpus exist.
- Long-run plan: checkpoint each of the 3 configurations x 2 seeds by run and epoch,
  print validation progress after every epoch, checkpoint gate measurements per
  position, and checkpoint the level-10 smoke per game. Estimate runtime from a smoke
  one-epoch measurement and record it before starting the primary runs.
- No code, training run, or acceptance command was started because the normative
  documents do not define: (1) the pairwise-loss formula/margin/temperature and child
  score sign convention; (2) how to obtain `engineChoice`, which is absent from the
  corpus, and exactly which candidates form pairs; (3) primary validation split and
  frozen-teacher-set definitions, including smoke/primary overlap handling; (4) how
  to apply the outcome term to corpus positions without a matched WTHOR canonical
  outcome. Per `AGENTS.md`, implementation stopped rather than guessing.
- Investigation commands: UTF-8 `Get-Content`, `rg -n`, and `git status --short`.
  No supplemental decision was found. The pre-existing out-of-scope change is
  `tasks/STATUS.md`. Commit: not implemented / not committed.

### 2026-07-15 implementation and primary-run plan

- Implemented the teacher-corpus loader, deterministic canonical-key position split,
  fixed reference-weight engine choice, limited unique pair construction, and the
  clarified mixed Huber objective in a dedicated T090b runner. The runner preserves
  T088's early stopping, LR decay, run-identity rejection, epoch progress logging,
  and atomic epoch checkpoint/resume behavior.
- Smoke measurement command:
  `cargo run -p train --release --bin train_distillation -- --corpus train/data/teacher/corpus_smoke.jsonl --checkpoint-dir train/data/t090b/smoke --mixes baseline --seeds 1 --max-epochs 1 --reference-weights train/weights/pattern_v2.bin`.
  Result: PASS; split train/validation/frozen = 890/54/56, outcome matches =
  829/52/54 (65 missing in total), wall time 26.5 seconds including release build and
  one-time WTHOR loading.
- Primary plan: run `{teacher-only, baseline, no-ranking} x seeds {1,2}`, at most 60
  epochs each. Every epoch atomically saves current weights and state and prints
  validation progress; every run has a separate identity and completion marker, so
  interruption resumes from the last completed epoch. Based on the smoke measurement,
  estimated primary wall time is 10-30 minutes. Gate (b) remains position-checkpointed
  by `compare_pattern_v3.py`; a level-10 smoke, if reached, remains game-checkpointed
  by `vs_edax.py`.

### 2026-07-15 implementation result

- Primary deterministic split (`fnv1a(canonicalKey) % 100`): train **45,055**,
  validation **2,363**, frozen teacher test **2,582**. WTHOR canonical outcome was
  matched for 44,994 / 2,361 / 2,580 respectively; the specified 65 non-WTHOR
  records omit the outcome term and renormalize the remaining coefficients. Frozen
  WTHOR 2024 contains 138,476 canonical positions. Smoke is not included in any split.
- The final epoch-numbered checkpoint implementation was rerun from scratch for all
  six runs. It produced byte-identical selected weights to the initial run. A same-
  identity restart printed `resume mix=baseline seed=2 epoch=59` and completed without
  repeating an epoch. Each run retains one complete `epoch-N.bin` / `epoch-N.state`
  pair plus best/final artifacts; identity mismatch is rejected.

| mix | seed | best epoch / epochs | validation mixed loss | validation teacher MAE | validation ranking MAE | frozen agreement | frozen mean regret | WTHOR 2024 MAE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| teacher-only 1/0/0 | 1 | 39 / 41 | 23.550049 | 7.610597 | 13.687892 | 0.314098 | 8.236251 | 15.445753 |
| teacher-only 1/0/0 | 2 | 38 / 38 | 23.547520 | 7.609925 | 13.684723 | 0.313710 | 8.250581 | 15.443605 |
| baseline 0.6/0.3/0.1 | 1 | 55 / 56 | 27.392184 | 7.495471 | 9.098022 | 0.406274 | 3.969404 | 15.302234 |
| baseline 0.6/0.3/0.1 | 2 | 58 / 59 | **27.347963** | **7.490193** | **9.072993** | **0.407049** | **3.955461** | **15.291866** |
| no-ranking 0.7/0/0.3 | 1 | 41 / 41 | 32.710499 | 7.719055 | 13.824954 | 0.312936 | 8.338885 | 15.390803 |
| no-ranking 0.7/0/0.3 | 2 | 36 / 38 | 32.760661 | 7.729952 | 13.852348 | 0.313710 | 8.406274 | 15.419343 |

- Gate candidate: baseline seed 2, PWV3, 2,729,712 bytes (under 8 MB; loader and
  SHA-256 verification passed).
  - **(a) PASS**: frozen best-move agreement 0.367545 -> 0.407049
    (+3.9504 percentage points, +10.75% relative).
  - **(b) FAIL**: independent `compare_pattern_v3.py` fixed 18-position Edax-oracle
    mean regret 2.000000 -> 2.666667 stones (**33.33% worse**, versus required 20%
    improvement). The JSON was checkpointed after every position.
  - **(c) PASS**: WTHOR 2024 MAE 14.358465 -> 15.291866, +6.50%, within the allowed
    +10%.
  - **(d) PASS**: deterministic 28-position depth-8 native NPS, seven runs each;
    v2 median 859,807 vs candidate median 839,340, ratio **97.62%** (required >=80%).
  - **(e) NOT RUN**: the candidate failed gate (b), so it did not qualify for the
    level-10 20-game smoke. No candidate weight is adopted or copied into
    `train/weights`, and T090c progression is not recommended.
- Acceptance commands:
  - `cargo test -p train`: PASS, 32 unit tests + 1 real-data test, including corpus
    loader, pairwise loss direction/sign, mixed-loss renormalization, and split tests.
  - `cargo test -p engine`: PASS, 178 passed / 2 ignored (plus bin/doc tests).
  - `cargo test -p engine --release --test ffo_bench`: PASS, FFO fast #40-44,
    1 passed / 1 heavy ignored, 519.87 seconds.
  - `cargo build --release -p engine --bin eval_cli --bin calibrate_mpc`: PASS.
  - `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t090b/primary-v2/baseline-seed-2/final.bin --output train/data/t090b/gates/oracle.json`: PASS (measurement completed; gate result failed as above).
  - Targeted `rustfmt` on the two new Rust source files: PASS. The repository-wide
    `cargo fmt --all -- --check` reports pre-existing formatting differences in
    out-of-scope engine/train files; none were modified.
- Overall decision: **not adopted (normal negative experiment)** because gate (b)
  failed despite the large in-corpus frozen regret improvement. Generated corpus,
  checkpoints, metrics, and gate JSON remain under the existing ignored `train/data`
  area. Commit: unavailable in the Codex sandbox; orchestrator to commit the listed
  source/task files.

### 2026-07-15 redo #1 implementation and final result

- Corrected all child-score consumers (fixed-reference engine choice, pairwise training and
  frozen/validation metrics) to share the engine's negamax convention: normal children use
  `-f(child, opponent)`, opponent-pass children use `+f(child, parent mover)`, and terminal
  children use the exact parent-perspective disc difference with no model gradient. Added
  dedicated opponent-pass score/gradient and terminal-score tests.
- Replaced the optional ignored-data corpus test with a generated minimal JSONL fixture that
  always verifies deserialization, canonicalKey matching, legal children, bestValue/
  diffFromBest consistency and limited unique pair construction. Resume now truncates rows
  beyond the completed checkpoint and de-duplicates epoch rows in `metrics.tsv`. Invalid
  numeric CLI arguments now return explicit errors instead of panicking.
- WTHOR outcome policy now matches T088 test priority: outcome averages use 2015-2023 games,
  then remove every canonical key occurring in 2024. Thus 2024 outcomes are exclusive to gate
  (c). Teacher records may still carry Edax labels regardless of source year; only their
  auxiliary WTHOR outcome target is omitted for a 2024-overlapping key. This policy and counts
  are written to the manifest, and run identity was bumped to schema 4.
- Redo smoke command (one epoch, checkpointed):
  `cargo run -p train --release --bin train_distillation -- --corpus train/data/teacher/corpus_smoke.jsonl --checkpoint-dir train/data/t090b/redo-smoke-v2 --mixes baseline --seeds 1 --max-epochs 1 --reference-weights train/weights/pattern_v2.bin`.
  PASS in 25.3 seconds including a 4.49-second release rebuild. Split = 890/54/56 and
  outcome matches = 625/39/37.
- Final primary command used a fresh schema-4 run directory:
  `cargo run -p train --release --bin train_distillation -- --corpus train/data/teacher/corpus_primary.jsonl --checkpoint-dir train/data/t090b/primary-redo1-v2 --mixes teacher-only,baseline,no-ranking --seeds 1,2 --max-epochs 60 --reference-weights train/weights/pattern_v2.bin`.
  All six runs completed with an epoch checkpoint and progress line after each epoch. Split =
  train **45,055**, validation **2,363**, frozen **2,582**; 2015-2023 non-2024-overlap outcome
  matches = **36,131 / 1,883 / 2,063**. All six `metrics.tsv` files have exactly one unique row
  per completed epoch.

| mix | seed | best epoch / epochs | validation mixed loss | validation teacher MAE | validation ranking MAE | frozen agreement | frozen mean regret | WTHOR 2024 MAE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| teacher-only 1/0/0 | 1 | 39 / 41 | 23.550049 | 7.610597 | 13.691504 | 0.313323 | 8.251743 | 15.445753 |
| teacher-only 1/0/0 | 2 | 38 / 38 | 23.547520 | 7.609925 | 13.688218 | 0.312936 | 8.268397 | 15.443605 |
| baseline 0.6/0.3/0.1 | 1 | 55 / 56 | 26.759363 | 7.485589 | 9.081751 | 0.407823 | 3.961270 | 15.306156 |
| baseline 0.6/0.3/0.1 | 2 | 58 / 59 | **26.712393** | **7.478952** | **9.056571** | **0.407049** | **3.939582** | **15.295711** |
| no-ranking 0.7/0/0.3 | 1 | 41 / 41 | 30.896461 | 7.685079 | 13.790802 | 0.311387 | 8.284276 | 15.418285 |
| no-ranking 0.7/0/0.3 | 2 | 38 / 38 | 30.949739 | 7.696871 | 13.820697 | 0.312548 | 8.389233 | 15.441660 |

- Validation-selected candidate: baseline seed 2, PWV3, **2,729,712 bytes**, SHA-256
  `43614bd042d1fbd53ae112efa8dac45cbf6f15356e9a6d400c0c8910e4fe398d`. The trainer,
  engine PWV3 loader and oracle comparison loaded it successfully; it is below 8 MB.
  - **(a) PASS**: frozen teacher best-move agreement **0.368319 -> 0.407049**
    (+3.8730 percentage points, +10.52% relative).
  - **(b) FAIL**: independent 18-position Edax-oracle mean regret **2.000000 -> 2.555556**
    stones, **27.78% worse** rather than 20% better. Command:
    `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t090b/primary-redo1-v2/baseline-seed-2/final.bin --output train/data/t090b/gates/oracle-redo1-v2.json`.
  - **(c) PASS**: WTHOR 2024 MAE **14.358465 -> 15.295711**, +6.53%, within +10%.
  - **(d) PASS**: deterministic opening/midgame 28-position depth-8 native benchmark,
    seven runs each. v2 NPS = 814257/798179/813367/808118/814069/815194/850739;
    candidate = 792517/780689/778849/773272/780261/781600/756414. Medians
    **814,069 -> 780,261**, ratio **95.85%** (required >=80%).
  - **(e) NOT RUN**: gate (b) failed, so the candidate did not qualify for the level-10
    20-game smoke. No candidate weight is copied to `train/weights`, and T090c progression is
    not recommended.
- Acceptance verification:
  - `cargo test -p train`: PASS, 36 unit tests plus 1 real-WTHOR test and doc tests. This
    includes pairwise/mixed loss, generated corpus fixture, pass/terminal child handling,
    canonical later-split priority and metrics resume tests.
  - `cargo test -p engine`: initial run had one transient failure in the pre-existing
    wall-clock-sensitive `node_limited_protocol_requests_are_deterministic` test (143,189 vs
    160,000 nodes). The test passed alone, then the complete rerun passed **178 / 2 ignored**.
    No engine source was changed.
  - `cargo test -p engine --release --test ffo_bench -- --nocapture`: PASS, FFO #40-44
    scores 38/0/6/-12/-14 unchanged, 1 passed / 1 heavy ignored, 614.833 seconds.
  - `cargo build --release -p engine --bin eval_cli --bin calibrate_mpc`: PASS.
  - Invalid `--seeds nope` returned exit 1 with `invalid --seeds: invalid digit found in string`.
  - Targeted `rustfmt train/src/t090_distillation.rs` and `git diff --check`: PASS.
- Final decision: **not adopted (normal negative experiment)** because gate (b) failed.
  Generated checkpoints, metrics and gate JSON remain in the existing ignored `train/data`
  area. Commit unavailable in the Codex sandbox; orchestrator should commit only the source
  and task-log files listed in the worker handoff.
- Final same-identity schema-4 restart reported resume epochs 41/38/56/59/41/38 for the six
  runs and left every `metrics.tsv` with rows=unique epochs (41/38/56/59/41/38), confirming
  resume does not repeat epochs or metric rows.