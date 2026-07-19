# T144: outcome-only vs teacher-only label control on the identical expanded1m positions

## Summary

Trained v4, `--jobs 1`, on the **exact same train split** as T127d's 1M full run
(`corpus_expanded1m.jsonl`, train=899,467), changing only the loss mix from `teacher-only`
(Edax level-16/exact distillation labels) to `outcome-only` (WTHOR final-disc-difference labels,
T112 mix). Purpose: isolate whether T127d's teacher-only@1M result (1.9000, worse than the
pre-registered 1.4-1.63 expectation) is a **label-quality** problem (Edax level 16) or a
**data-volume/other** problem, by holding the position set and trainer fixed and swapping only
the label source.

| configuration | effective train samples | seeds | oracle regret |
|---|---:|---:|---:|
| teacher-only@1M (T127d, reference) | 899,467 | 3 (identical) | 1.9000 |
| **outcome-only@1M (this task)** | 220,450 (see coverage below) | 3 | **3.9111** (SD=0.1171) |
| **teacher-only, restricted to the same 220,450-record set (control)** | 220,450 | 1 | **3.8333** |

**Pre-registered interpretation: outcome-only@1M (3.9111) is clearly worse than teacher-only@1M
(1.9000), not `<=1.9`, so this falls in the "label is not the cause" branch.** The equal-N
control makes this a positive finding rather than an inference by exclusion: teacher-only
restricted to the same 220,450 outcome-matched positions scores 3.8333 — statistically
indistinguishable from outcome-only's 3.9111 at the same N (paired bootstrap diff -0.0778, 95%
CI [-1.5667, 1.3333]) — while both are significantly worse than teacher-only's full-899,467-sample
result (diff vs. full ~+1.93 to +2.01, CIs excluding zero). **The gap is explained by data volume
(899,467 vs. 220,450 effective samples), not by Edax level-16 label quality.**

## Coverage measurement (requirement 2 gate)

The trainer's existing `outcome_matched_train` manifest field (built during T112, counts records
in the train split for which a canonical-key match exists in the WTHOR 2015-2023 outcome lookup)
reports, for the full 899,467-sample train split of `corpus_expanded1m.jsonl`:

```
train=899467
outcome_matched_train=220450
```

**Coverage = 220,450 / 899,467 = 24.51%** (missing = 75.49%). This is far above the task's 2%
missing threshold for requiring an equal-effective-set control, so the control run (below) was
mandatory, not optional. This missing rate is much larger than T112's ~19.8% missing at 45k scale;
a plausible (not confirmed) explanation is that `corpus_expanded1m` spans WTHOR years 2000-2024
while the outcome lookup table only covers 2015-2023 (2024 is reserved for a separate gate), so
canonical positions unique to 2000-2014 games have no chance of a lookup match unless the same
canonical key recurs in a 2015-2023 game.

## Trainer change: `--outcome-matched-only` (requirement 2)

`train/src/t090_distillation.rs` gained one new opt-in boolean flag, `--outcome-matched-only`,
used only for the equal-effective-set control below:

- Absent (default): behavior, manifest, and resume identity are byte-for-byte unchanged from
  before this task (verified: the existing `train_full_size`/`outcome_matched_train` fields and
  identity string only change when this flag or the pre-existing `--outcome-matched-only`-adjacent
  identity line is emitted, which only happens when the flag is passed).
- Present: filters the train split down to records with `outcome.is_some()` immediately after the
  deterministic split and before any `--train-subset-size` subsampling (composable with it,
  though this task did not combine the two). Adds `outcome_matched_only=true` to `manifest.txt`
  and to the resume identity string (so a checkpoint dir cannot be silently resumed with a
  mismatched matched/unmatched configuration).
- New function `filter_outcome_matched()` plus two unit tests
  (`filter_outcome_matched_keeps_only_records_with_outcome_and_preserves_order`,
  `filter_outcome_matched_is_a_no_op_when_all_records_have_outcome`). `cargo test -p train`:
  58 passed (56 pre-existing + 2 new), 0 failed.

## Training commands

```
# outcome-only@1M full, 3 seeds (identical config to T127d's teacher-only@1M run, mix swapped)
target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl \
  --checkpoint-dir train/data/t144/outcome-only-1m --mixes outcome-only --seeds 1,2,3 \
  --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1

# teacher-only, restricted to the outcome-matched 220,450-record set (equal-N control), seed 1
target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded1m.jsonl \
  --checkpoint-dir train/data/t144/teacher-only-matched-subset --mixes teacher-only --seeds 1 \
  --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 \
  --outcome-matched-only
```

Both runs used the existing per-epoch atomic checkpoint mechanism; all four (3 outcome-only seeds
+ 1 control) stopped by patience well under the 60-epoch cap (best/completed epochs 16/17, 12/17,
14/16, and 27/27 respectively) and printed progress every epoch to their log files, consistent
with the long-running-task checkpoint/progress rule (each run finished in a few minutes, so no
mid-run interruption/resume was exercised in this task — T127d already verified genuine
interrupt-then-resume behavior on this same trainer).

## Detailed results

### outcome-only@1M (3 seeds)

| seed | best epoch | completed epoch | validation_loss | frozen_agreement | frozen_mean_regret | oracle regret |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16 | 17 | 13.608902 | 0.337996 | 7.603687 | 4.0333 |
| 2 | 12 | 17 | 13.623393 | 0.336904 | 7.658765 | 3.8000 |
| 3 | 14 | 16 | 13.613737 | 0.338191 | 7.585523 | 3.9000 |
| **mean** | | | | | | **3.9111** |

Seed sample SD = 0.1171. All three oracle runs reproduced **v2 = 1.5666666666666667 exactly
(M2 guard PASS)**.

Paired bootstrap (each seed vs. teacher-only@1M's identical 60-position regret array, seed 96002,
100,000 samples):

| comparison | mean difference | 95% CI | classification |
|---|---:|---:|---|
| outcome-only seed 1 - teacher-only@1M | +2.1333 | [0.8000, 3.5667] | outcome_worse |
| outcome-only seed 2 - teacher-only@1M | +1.9000 | [0.6333, 3.2667] | outcome_worse |
| outcome-only seed 3 - teacher-only@1M | +2.0000 | [0.6333, 3.4667] | outcome_worse |
| **3-seed position-averaged - teacher-only@1M** | **+2.0111** | **[0.7222, 3.4222]** | **outcome_worse** |

### Equal-effective-set control: teacher-only restricted to 220,450 outcome-matched records

| metric | value |
|---|---:|
| train_size | 220,450 |
| best/completed epoch | 27/27 |
| train_teacher_mae | 3.934311 |
| validation_loss | 22.671546 |
| frozen_agreement | 0.379319 |
| frozen_mean_regret | 6.578519 |
| **oracle regret** | **3.8333** |

M2 guard: v2 = 1.5666666666666667 (PASS).

| comparison | mean difference | 95% CI | classification |
|---|---:|---:|---|
| teacher-only@220,450-control - teacher-only@1M (899,467) | +1.9333 | [0.6667, 3.3333] | control (fewer samples) is significantly worse |
| **teacher-only@220,450-control - outcome-only (3-seed avg), same N=220,450** | **-0.0778** | **[-1.5667, 1.3333]** | **no_significant_difference** |

The second row is the key result: at matched sample count, the two label sources are
statistically indistinguishable (3.8333 vs. 3.9111), while both differ significantly from the
full-899,467-sample teacher-only result. This directly attributes T127d's teacher-only@1M
advantage over what outcome-only@1M would give to **sample count**, not label source.

## Conclusion (pre-registered interpretation)

Per the task's pre-registered rule:

- outcome-only@1M `<= ~1.9` -> label problem (Edax level 16 quality) -> **not observed**
  (measured 3.9111, dramatically worse).
- outcome-only@1M clearly worse (T112's 45k reference: 3.6-3.8) -> label is not the cause,
  remaining explanation is volume/distribution/trainer -> **this is what was observed**, and the
  equal-effective-set control makes the volume explanation a positive, direct finding rather than
  an inference by elimination: restricting teacher-only to the same 220,450 positions reproduces
  outcome-only's regret almost exactly (3.8333 vs. 3.9111, no significant difference), while both
  are significantly worse than the full 899,467-sample teacher-only result.

This corroborates T112's original 45k-scale finding (outcome-only 3.6-3.8 vs. teacher-only 2.8)
at 1M scale with a much stronger design (identical positions, identical trainer, equal-N control)
and is consistent with the T127d addendum's separate K=4-density finding: taken together, the
evidence to date points at **effective sample volume** (not Edax level-16 label quality, and
possibly compounded by the K=4 same-game density effect from T127d's addendum) as the dominant
factor behind teacher-only@1M's 1.9000 falling short of the pre-registered 1.4-1.63 expectation.

## Caveats

- `eval_cli` binary provenance: all four of this task's oracle scoring runs used the identical
  `eval_cli` build (SHA-256 `e56092090e7928148518351448361a10e7aef8dcbf88f86cf34cb461d87e0ab7`,
  verified via each output JSON's embedded `evalCliSha256`), so they are directly comparable to
  each other. That build differs from the one used for T127d's original teacher-only@1M scoring
  (`e874bb4c434125a4a996ffebb24c8ffcce6f535b706d2eef3baa21f70ccd740a`) because unrelated engine
  work (e.g. T139) landed on `main` between the two sessions and the shared `target/release/`
  build was rebuilt. Both builds reproduced v2 = 1.5666666666666667 exactly on the same 60
  positions, so the scoring pipeline's behavior on this oracle is consistent across builds even
  though the binaries are not byte-identical.
- Only the equal-N control used a single seed (seed 1); the outcome-only comparison uses 3 seeds.
  The 3-seed outcome-only SD (0.1171) is small enough that this asymmetry is unlikely to change
  the qualitative conclusion, but it was not itself replicated across seeds.
- The K=4 same-game density effect identified in the T127d addendum and the label-volume effect
  found here are not mutually exclusive; this task does not attempt to partition the 1M shortfall
  quantitatively between them.
- No production wiring, adoption decision, or 4M corpus work was performed. `bench/edax-compare/*.py`
  generator files were not touched.

## Artifacts

- Trainer change: `train/src/t090_distillation.rs` (new `--outcome-matched-only` flag,
  `filter_outcome_matched()`, 2 new unit tests).
- Training/oracle output (gitignored): `train/data/t144/outcome-only-1m/`,
  `train/data/t144/teacher-only-matched-subset/`, `train/data/t144/oracle/*.json`,
  `train/data/t144/logs/*.log`.
- This report and `bench/edax-compare/t144_outcome_label_control_1m.meta.json`.
