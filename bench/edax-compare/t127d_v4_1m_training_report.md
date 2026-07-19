# T127d: v4 x expanded1m distillation training and oracle evaluation

## Summary

Distilling v4 (61-stage) features with teacher-only loss on the new expanded1m corpus
(1,000,000 records, `train/data/teacher/corpus_expanded1m.jsonl`, T127c-verified) produced:

| configuration | actual train samples | seeds | oracle regret (mean) |
|---|---:|---:|---:|
| 500k bridge | 499,974 | 1 | 2.4000 |
| 1M full (corpus_expanded1m) | 899,467 | 3 | **1.9000** (SD=0, all 3 seeds identical) |

Both points are **worse than the T126 three-point extrapolation predicted** (predicted ~1.85-1.98
at 500k, ~1.47-1.68 at 900k) and the measured 1M mean (1.9) sits **above** the pre-registered
planning range of 1.4-1.63 discs from T126's extrapolation, and above the design report's
"discontinue" threshold of 1.70 (`tasks/design/T127-corpus-1m-report.md` section 7). The
one-million point is statistically indistinguishable from v2xWTHOR (1.5667, paired bootstrap
95% CI [-0.567, 1.4]) but its point estimate is worse, and it does not approach v4xWTHOR full
(1.1111, T124) or v3xWTHOR full (1.4778, T111).

This report covers training, checkpoint/resume verification, oracle scoring with the M2 guard,
and a curve re-estimate/4M extrapolation update. **Adoption, production wiring, and the
continue/hold/stop decision for a four-million corpus are out of scope** (T127e).

## Corpus and split

- Corpus: `train/data/teacher/corpus_expanded1m.jsonl`, 1,000,000 records,
  SHA-256 `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86` (T127c-verified,
  0 errors).
- The trainer's deterministic split (`fnv1a(canonicalKey) % 100`: train 0-89, validation 90-94,
  frozen 95-99) is identical across both runs since both read the same corpus file: **full train
  = 899,467**, validation = 49,278, frozen = 51,255. The corpus record count (1,000,000) and the
  trainer's actual train-split count (899,467) are deliberately kept distinct in this report
  (requirement 9); "the 1M run" below always means the full 899,467-sample train split of
  `corpus_expanded1m.jsonl`, not a literal one million training samples.

## Streaming decision (requirement 1)

`load_corpus()` in `train/src/t090_distillation.rs` still reads the full 1.6GB JSONL with
`fs::read_to_string` before building a `Vec<DistillRecord>`. Before committing to the full-scale
runs, three smoke tests loaded the complete `corpus_expanded1m.jsonl` on this machine (16GB RAM,
~8.5GB free at the start of the session):

| `--train-subset-size` | `--max-epochs` | wall time | outcome |
|---:|---:|---:|---|
| 2,000 | 60 | 42.8s | OK |
| 500,000 | 1 | 21.4s | OK |
| 500,000 | 4 | 33.3s | OK |

No OOM, swapping, or abnormal slowdown was observed, and the full production runs below (500k
bridge and 1M/3-seed, each reloading the same 1.6GB corpus once per invocation) completed in a
few minutes each. **`train/src/t090_distillation.rs` was left unchanged** — no streaming rewrite
was needed at this scale, and the streaming requirement's "unless needed, don't change it" clause
applies.

## Checkpoint/resume verification (requirement 4/5)

The existing per-epoch atomic checkpoint mechanism (used by T120/T123/T124/T126) was re-verified
against a genuine mid-training interruption, not just a "rerun a completed command" check:

1. A scratch run (`train/data/t127d/resume-check`, 200,000-sample subset, not part of the
   official curve — deleted after the check) was started in the background.
2. It was interrupted by an out-of-band process termination partway through epoch 7 (epoch-06.bin
   / epoch-06.state / metrics.tsv already saved for epoch 6; no epoch-07 artifacts, no
   `complete.txt`).
3. Re-invoking the identical command printed `resume mix=teacher-only seed=1 epoch=6` and
   continued training from epoch 7 through completion (exit code 0).

Both production runs below also used the existing per-epoch atomic weights/state/metrics save;
progress (epoch number, validation loss, elapsed effect via epoch count) was visible in the log
throughout, satisfying the long-running-task checkpoint/progress rule.

## 500k bridge (seed 1)

Command:

```
target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl \
  --checkpoint-dir train/data/t127d/expanded1m-v4-500k-bridge --mixes teacher-only --seeds 1 \
  --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 \
  --train-subset-size 500000
```

`--subset-seed` defaulted to 42 (T126's convention). Target 500,000 produced 499,974 actual train
samples (stratified-floor shortfall of 26, consistent with T109/T126's method). Training stopped
by patience at epoch 29/29 (did not need the 60-epoch cap).

| metric | value |
|---|---:|
| train_teacher_mae | 4.351038 |
| validation_loss | 19.956412 |
| validation_teacher_mae | 6.661462 |
| frozen_agreement | 0.402517 |
| frozen_mean_regret | 5.967457 |
| wthor_2024_mae | 14.809149 |

Oracle (T096 60 positions): v2 = 1.5666666666666667 (**M2 guard PASS**), candidate = **2.4000**,
difference +0.8333, paired bootstrap 95% CI [-0.1667, 1.9333], `no_significant_difference`.

## 1M full (seeds 1/2/3)

Command:

```
target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl \
  --checkpoint-dir train/data/t127d/expanded1m-v4-1m --mixes teacher-only --seeds 1,2,3 \
  --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1
```

No `--train-subset-size` (full 899,467-sample train split). All three seeds ran in one process
invocation (corpus loaded once and shared); training stopped by patience for every seed
(best/completed epoch 31/31, 33/33, 33/36 — seed 3 stayed 3 epochs past its own best before the
stale counter reached 5).

| seed | best epoch | completed epoch | validation_loss | frozen_agreement | frozen_mean_regret | wthor_2024_mae |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 31 | 31 | 18.460410 | 0.427197 | 5.202985 | 14.538322 |
| 2 | 33 | 33 | 18.453075 | 0.427529 | 5.188528 | 14.536250 |
| 3 | 33 | 36 | 18.435398 | 0.428387 | 5.145683 | 14.532877 |

Oracle (T096 60 positions), each scored independently against v2 with its own M2 guard check:

| seed | v2 mean regret | M2 guard | candidate mean regret | difference from v2 | 95% CI |
|---:|---:|---|---:|---:|---:|
| 1 | 1.5666666666666667 | PASS | 1.9000 | +0.3333 | [-0.5667, 1.4000] |
| 2 | 1.5666666666666667 | PASS | 1.9000 | +0.3333 | [-0.5667, 1.4000] |
| 3 | 1.5666666666666667 | PASS | 1.9000 | +0.3333 | [-0.5667, 1.4000] |
| **mean** | | | **1.9000** | **+0.3333** | |

**Seed sample SD = 0.0.** A direct per-position comparison of the three seeds' `compare_pattern_v3.py`
output confirms all three chose the identical engine move on all 60 oracle positions, even though
the three weight files have distinct SHA-256 hashes and slightly different frozen-corpus metrics
(frozen_mean_regret 5.203/5.189/5.146). At this data scale the three seeds converge to the same
argmax policy on this specific 60-position test set; this is a genuine result, not a duplication
bug, but it should not be read as "the models are identical everywhere" — only that this
particular oracle does not distinguish them. Because the three seed values are identical, the
seed-pooled position-level bootstrap CI equals each individual seed's CI above.

## Learning curve re-estimate and 4M extrapolation update

Five points now exist for the v4 teacher-only distillation curve (T126's 45k/90k/180k nested
subsets of expanded200k, plus this task's 500k bridge and 899,467/"1M" full points from
expanded1m):

| target | actual train | oracle regret |
|---:|---:|---:|
| 45,000 | 44,965 | 4.7667 |
| 90,000 | 89,966 | 3.6333 |
| 180,000 | 179,957 | 2.7667 |
| 500,000 | 499,974 | 2.4000 |
| full (expanded1m) | 899,467 | 1.9000 |

| model | fit | R2 | 1,000,000 (near-interpolation) | 4,000,000 (extrapolation) |
|---|---|---:|---:|---:|
| `a + b/sqrt(N)` | a=1.1524, b=753.719 | 0.9870 | 1.9061 | 1.5292 |
| power law `a*N^-k` (nonlinear fit) | a=124.878, k=0.30755 | 0.9734 | 1.7832 | 1.1642 |
| **log-linear `a + b*log10(N)`** (requirement-9 primary refit) | a=13.970, b=-2.0510 | 0.9293 | 1.6638 | 0.4289 |
| **4M planning range** | not a confidence interval | | | **0.43-1.53** |

Fit quality dropped for every model versus T126's 3-point fits (which had R2 = 0.994-1.000): the
500k and 899,467 points sit noticeably above (worse than) what the 3-point curve predicted.

| quantity | 3-point (T126) prediction | measured (T127d) | gap |
|---|---:|---:|---:|
| regret at 500k | 1.85 (power law) - 1.98 (inv-sqrt) | 2.4000 | +0.42 to +0.55 |
| regret at 899,467/"1M" | 1.47 (power law) - 1.68 (inv-sqrt) | 1.9000 | +0.22 to +0.43 |

The measured 1M mean (1.9000) is **outside** (worse than) the pre-registered planning range of
1.4-1.63 discs quoted in this task's own header and in T126's report, and it is above the design
report's stated discontinue threshold of >1.70 (`tasks/design/T127-corpus-1m-report.md`, section
7). This is reported here as objective input; the continue/hold/stop call itself belongs to T127e.

### Interpretation

The T126 curve was fit on three nested subsets of the *same* expanded200k corpus (same per-game
extraction density, K=1). The new 500k/1M points come from `corpus_expanded1m`, which the T127
design report built with **K=4 per-bin extraction** (up to 4 positions per game per phase-bin
instead of 1) to reach one million records economically. That deliberately increases same-game
position density and changes the correlation structure of the added data (design report section
3.9 flagged this explicitly and recommended the bridge subset for exactly this reason). The
observed slowdown is consistent with, though not proof of, that same-game correlation reducing
the effective sample size faster than raw record counts suggest — i.e., 899,467 K=4-flavored
positions may carry less independent information than 899,467 K=1 positions would have. This
task does not attempt to separate that effect from ordinary curve-shape uncertainty (only one
training seed's worth of "curve shape" data existed at each of the five sizes; only the final
899,467-sample point itself was run at 3 seeds).

## Benchmarks for context

| configuration | oracle regret |
|---|---:|
| v2 x WTHOR full | 1.5667 |
| v3 x WTHOR full (T111) | 1.4778 |
| v4 x WTHOR full (T124) | 1.1111 |
| v4 x WTHOR reduced to 180k (T126) | 3.8222 |
| v4 x distilled 180k, expanded200k (T124) | 2.8667 |
| **v4 x distilled 500k bridge (T127d)** | **2.4000** |
| **v4 x distilled full expanded1m / 899,467 (T127d)** | **1.9000** |

## cargo test

`cargo test -p train` (debug profile): 56 lib unit tests + 2 `teacher_candidates` unit tests + 1
`real_data` integration test, all passed, 0 failed. No `train/src` changes were made in this task
(see the streaming decision above), so this is a baseline/regression confirmation rather than a
response to a code change.

## Limitations

- Only the final 899,467-sample point was measured with 3 seeds; the 500k bridge and every T126
  curve point used a single training seed. The curve re-estimate therefore mixes single-seed and
  3-seed-mean points.
- The three 1M seeds are argmax-identical on the 60-position oracle (seed SD = 0 for this
  measure); this narrows the seed-uncertainty story for the headline number but does not
  establish that the underlying models are identical or that a fourth seed would agree.
- The design report's K=4 per-game density change (section 3.9) is a plausible but unconfirmed
  explanation for the curve's slowdown; this task does not isolate it from other possible causes
  (different year/opening/phase composition of the incremental 800k, oracle finite-sample noise,
  or genuine diminishing returns of teacher-only distillation past ~200k independent positions).
- The 60-position T096 oracle is the same fixed set used throughout this series; its finite size
  means both the paired-bootstrap CIs and the seed-SD=0 finding are specific to these 60 positions.
- No production wiring, adoption decision, game-play gating, or four-million corpus generation was
  performed. `bench/edax-compare/*.py` generator files were not touched (concurrent T143 scope).

## Commands and artifacts

- 500k bridge training: `target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl --checkpoint-dir train/data/t127d/expanded1m-v4-500k-bridge --mixes teacher-only --seeds 1 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 --train-subset-size 500000`
- 1M full training: `target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl --checkpoint-dir train/data/t127d/expanded1m-v4-1m --mixes teacher-only --seeds 1,2,3 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1`
- Oracle scoring (per run): `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate <run-dir>/teacher-only-seed-<N>/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t127d/oracle/<label>.json`

Weights, epoch checkpoints, metrics, and raw oracle JSON are under gitignored `train/data/t127d/`.
