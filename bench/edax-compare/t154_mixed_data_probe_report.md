# T154: Mixed-data probe — WTHOR vs. Egaroucid vs. mixed, same trainer

## Summary

Three same-trainer probe trainings (`train/src/t090_distillation.rs`'s `--simple-corpus`
teacher-only path, added in T153; unmodified in this task) were run at matched scale (v4 pattern
set, `--seeds 1`, `--jobs 1`, T096 60-position oracle with the M2 guard):

| run | data source | pool size | train (actual) | oracle mean regret | v2 M2 guard |
|---|---|---:|---:|---:|---|
| **A** | WTHOR full, converted to simple format | 4,431,504 | 4,011,443 | **1.5000** | PASS (1.5666666666666667) |
| **B** | Egaroucid, reservoir-matched to A's pool | 4,431,504 | 3,982,785 | **1.2333** | PASS (1.5666666666666667) |
| **C** | WTHOR full + Egaroucid stones≤15 (mixed) | 5,945,601 | 5,368,814 | **1.4333** | PASS (1.5666666666666667) |

Reference points from prior tasks (not recomputed here):

| point | mean regret |
|---|---:|
| v2 x WTHOR full | 1.5667 |
| v4 x WTHOR full (`train_patterns_v3`, T124) | **1.1111** |
| v4 x Egaroucid subset @900k (T153, different trainer scale) | 1.8667 |

**Trainer-difference finding (primary result of this task):** Run A trains the exact same
4,431,504 WTHOR samples that `train_patterns_v3` used to reach 1.1111 (T124), through the same
v4 pattern set and the same teacher-signal semantics (final disc difference), but through the
`t090_distillation.rs` `--simple-corpus` trainer instead. Run A's regret is **1.5000**, a
**+0.3889** degradation from the known 1.1111 point. This falls squarely in the "1.5-1.9" band
of interpretation (2) from this task's pre-registration (see "Interpretation" below): **the
trainer itself (loss shape, learning-rate schedule, weighting — not the data) is the dominant
source of the gap** between the T153 Egaroucid probes and the production v4xWTHOR benchmark.

**Data-difference finding (secondary):** within the same trainer and the same pool size, B
(Egaroucid) beats A (WTHOR) by 0.2667 regret (1.2333 vs 1.5000), and C (WTHOR + Egaroucid
opening-quality subset) beats A by 0.0667 (1.4333 vs 1.5000) while falling short of B. Both
directions are consistent with "Egaroucid's data is at least as good as, and possibly better
than, WTHOR's outcome-labeled data" — but per the pre-registered interpretation, since the
trainer gap dominates, these B/C-vs-A deltas are reported as **secondary/reference signals**, not
as evidence that a larger Egaroucid-based `t090_distillation.rs` training would beat production.
None of the three runs are statistically distinguishable from v2 at n=60 (all 95% CIs vs. v2
straddle zero); the A/B/C ordering is a point-estimate signal from a fixed, shared 60-position
corpus, not a proven ranking.

## Pre-registered design (recap)

Per `tasks/T154-mixed-data-probe.md`: three runs, all v4 / teacher-only(simple) / seed 1 /
`--jobs 1` / t090 simple mode / T096 oracle 60 positions + M2 guard.

- **Run A**: WTHOR full converted to simple records — same data + features as
  `train_patterns_v3`'s 1.1111 result, different trainer only. A vs. 1.1111 measures the trainer
  gap.
- **Run B**: Egaroucid only, reservoir-sampled to match A's pool size — measures the data gap
  (A vs. B) at matched scale, within the same trainer.
- **Run C**: WTHOR full + Egaroucid stones≤15 (the portion with exhaustive/level-17-search
  labels rather than self-play-outcome labels) — measures "add quantity + add opening quality"
  (C vs. A).

**Interpretation rule (as pre-registered):**
1. If A ≈ 1.1-point and B/C beat A → trainer gap is small, data quality is the lever →
   candidate for a full/large-scale `t090_distillation.rs` training (separate, heavier task).
2. If A is clearly worse (e.g. 1.5-1.9) than 1.1111 → the `t090_distillation.rs` trainer itself
   (loss shape / LR / weighting) is the dominant gap → future direction should be "bring good
   data into `train_patterns_v3`" instead, and B/C's absolute values are reference-only.

**Result: A = 1.5000 lands in the interpretation-(2) band.** See "Conclusion and next steps"
below.

## Data preparation (requirement 1-2)

### WTHOR → simple-format conversion

New tool `train/src/bin/wthor_to_simple.rs` reuses `train::train_data::samples_from_game`
(unmodified; 1 sample per move, mover-perspective final disc difference — the exact function
`train_patterns_v3` uses) and writes each `Sample` as a `<64-char board> <integer score>` line
(`X`=mover's own stones, `O`=opponent's, `-`=empty — the same convention
`t090_distillation.rs::parse_simple_record` reads, so the output is a drop-in `--simple-corpus`
input with zero changes to the trainer). File enumeration mirrors `train_patterns_v3::data_files`
(`train/data/*.wtb`, sorted).

```
target/release/wthor_to_simple.exe --data-dir train/data --out train/data/t154/wthor_all.txt
```

Result: **4,431,504 samples from 74,024 games** (0 invalid, 0 empty, 25 `.wtb` files scanned).

**Requirement-2 count reconciliation (acceptance criterion 2):** `train_patterns_v3`'s WTHOR
training (T124) reports **train=3,988,509 + frozen=442,995 = 4,431,504** total samples from the
identical file set and identical `samples_from_game` call — an exact match on the total, as
expected (both tools consume the same 74,024 games through the same sampling function). The
**split scheme differs** between the two trainers, though:

- `train_patterns_v3` splits by **game**: the last 10% of games (by count) become the frozen
  holdout; the first 90% of games' samples become the (full) train pool. This gives exactly
  3,988,509 train / 442,995 frozen (90.0%/10.0% by game count, not by sample).
- `t090_distillation.rs`'s simple-corpus mode splits by **individual record**, via
  `fnv1a(canonicalKey) % 100`: buckets 0-89 → train, 90-94 → validation, 95-99 → frozen
  (discarded). This is unmodified existing T153 infrastructure, reused as-is.

Run A's actual manifest (`train/data/t154/wthor-v4/manifest.txt`): train=4,011,443 (90.53%),
validation=196,581 (4.44%), frozen_discarded=223,480 (5.04%) — the train fraction (90.53%) is
close to, but not numerically identical to, `train_patterns_v3`'s 90.0% game-level split, because
one splits per-game and the other per-position-hash. Both are "≈90% for training" by
construction; the difference (4,011,443 vs. 3,988,509, +0.56%) is small relative to the trainer
gap discussed above and is not the object of this task's comparison — Run A's train set is
already "the full WTHOR pool, ≈90% for training" by either scheme.

### Egaroucid stones≤15 subset

New tool `train/src/bin/egaroucid_filter_stones.rs` streams Egaroucid's 26 `.txt` files
(unchanged from T153's acquisition) and keeps lines whose board has ≤15 total stones (`X`+`O`
count), unmodified otherwise (still a valid `--simple-corpus` input).

```
target/release/egaroucid_filter_stones.exe \
  --in-dir train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 \
  --out train/data/t154/egaroucid_le15.txt --max-stones 15
```

Result: **1,514,097 lines** (scanned 25,514,097, 0 malformed). Per-stone-count breakdown
(measured, not estimated from the README table):

| stones | count |
|---:|---:|
| 4 | 1 |
| 5 | 1 |
| 6 | 3 |
| 7 | 14 |
| 8 | 60 |
| 9 | 322 |
| 10 | 1,773 |
| 11 | 10,649 |
| 12 | 67,245 |
| 13 | 434,029 |
| 14 | 500,000 |
| 15 | 500,000 |
| **total** | **1,514,097** |

The 4-13 stone counts match T153's citation of the README population table exactly (e.g. 13
stones = 434,029), confirming the filter is correct. The task's rough estimate ("README表では
4〜15石合計約143万件想定") undercounted slightly because it did not account for the 14- and
15-stone buckets both being capped at the full 500,000 (the README table's per-bucket cap applies
starting at 14 stones, not 16 as a naive "opening moves 1-11 only" reading might suggest); the
measured total is 1,514,097, about 84k above the ~1.43M estimate.

### Mixed pool (Run C)

`train/data/t154/wthor_all.txt` (4,431,504 lines) and `train/data/t154/egaroucid_le15.txt`
(1,514,097 lines) were concatenated (`cat wthor_all.txt egaroucid_le15.txt > mixed_c.txt`,
WTHOR-first per the task's ordering) into **5,945,601 lines**, fed to `--simple-corpus` as a
single file with no de-duplication (any positions present in both sources are trained on twice,
as a form of implicit re-weighting, per the task's explicit instruction not to deduplicate).

None of `train/data/t154/*` is committed (already covered by the repository's existing
`train/data/` gitignore rule, same as T153's Egaroucid data and prior WTHOR-derived artifacts).

## Trainer code change

**None.** `train/src/t090_distillation.rs` and `train/src/train_data.rs` are byte-for-byte
unchanged from T153. Only two new, independent CLI tools were added
(`train/src/bin/wthor_to_simple.rs`, `train/src/bin/egaroucid_filter_stones.rs}`), each producing
plain-text files that feed the existing, unmodified `--simple-corpus` trainer path. This was a
deliberate design choice to keep the three runs' training code identical, isolating the
comparison to "which text file(s) does `--simple-corpus` read" — the same guarantee T153 relied
on for its own two probes.

`cargo test -p train --release`: **99 passed, 0 failed** — the pre-existing 90 tests (74 in
`t090_distillation.rs` + 4 in `train_data.rs` + 2 in `regression.rs` + 3 in `train_patterns_v3.rs`
+ 10 in `wthor_lines.rs` + 1 integration test in `tests/real_data.rs`), all unchanged and green,
plus 9 new tests (5 in `wthor_to_simple.rs`, 4 in `egaroucid_filter_stones.rs`) covering: 64-char
board + integer score formatting, mover-perspective X/O assignment (own vs. opponent swap when
`mover=White`), board+outcome round-trip, cross-run determinism, stone counting, malformed-line
rejection, filter correctness and ordering/determinism across sorted input files.

## Training runs (requirement 3)

All runs used `target/release/train_distillation.exe` (`--pattern-set v4 --seeds 1 --jobs 1
--max-epochs 60`, default `--l2 1e-5`), launched via detached `Start-Process` per the long-running
task convention (Bash-tool background launches are known to die at tool-call boundaries in this
environment) and polled for `result.tsv`. Per-epoch checkpoint/resume is provided unmodified by
the existing `simple_run_one` infrastructure (atomic `epoch-NN.bin`/`.state` writes, resume by
`identity.txt` match); progress was visible in `logs/t154-*.stdout.log` throughout (no crash or
interruption occurred in this task, but the mechanism was available and is unmodified from
T153). All three finished on their own via the patience-5 early-stop rule, well under the max 60
epochs.

| run | command | epochs (best/completed) | train teacher MAE | validation loss | validation teacher MAE |
|---|---|---:|---:|---:|---:|
| A | `--simple-corpus train/data/t154/wthor_all.txt --checkpoint-dir train/data/t154/wthor-v4` | 23/25 | 13.197257 | 47.877210 | 13.763418 |
| B | `--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --checkpoint-dir train/data/t154/egaroucid-v4 --simple-max-records 4431504 --subset-seed 42` | 42/42 | 4.212934 | 14.918887 | 5.364459 |
| C | `--simple-corpus train/data/t154/mixed_c.txt --checkpoint-dir train/data/t154/mixed-v4` | 17/22 | 10.733194 | 37.615572 | 11.115042 |

The large gap in raw validation-loss scale between A (~48) and B (~15) reflects the underlying
score distributions and label smoothness of the two data sources (Egaroucid's data, including its
self-play-outcome-labeled majority, has lower variance per-position than WTHOR's actual-game
final-disc-difference outcomes at matched sample counts) rather than model quality — the loss
scale is not directly comparable across data sources, which is exactly why the task uses the
independent oracle-regret metric below rather than validation loss for the cross-run comparison.

### Oracle evaluation (T096 60 positions, `compare_pattern_v3.py`, M2 guard)

```
python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin \
  --candidate train/data/t154/<run>-v4/teacher-only-seed-1/final.bin \
  --corpus bench/edax-compare/t096_oracle_positions.json \
  --output train/data/t154/oracle/<run>-v4-seed-1.json
```

| run | v2 mean regret | M2 guard | candidate mean regret | diff from v2 | 95% CI vs v2 | classification |
|---|---:|---|---:|---:|---|---|
| A (WTHOR) | 1.5666666666666667 | **PASS** | **1.5000** | -0.0667 | [-0.767, 0.667] | no_significant_difference |
| B (Egaroucid) | 1.5666666666666667 | **PASS** | **1.2333** | -0.3333 | [-0.967, 0.333] | no_significant_difference |
| C (mixed) | 1.5666666666666667 | **PASS** | **1.4333** | -0.1333 | [-0.800, 0.533] | no_significant_difference |

All three M2 guards reproduce the known v2 constant (`1.5666666666666667`) exactly, confirming
the shared oracle harness (edax binary, `eval.dat`, `eval_cli.exe`, `pattern_v2.bin`, the T096
corpus) is byte-identical to T153's and prior tasks' (SHA-256 hashes recorded in the meta JSON
match T153's exactly).

## Interpretation applied to the pre-registered rules

- **A = 1.5000**, not ≈1.1 — so branch (1) ("trainer gap small, proceed toward a large-scale
  Egaroucid `t090_distillation.rs` training") does **not** apply as its literal precondition.
- **A falls in the "1.5-1.9" band named in branch (2)**: "t090トレーナー側の差(損失形・LR・
  重み付け)が支配的 → 今後は「良いデータをtrain_patterns_v3側に取り込む」方向へ転換". This is
  the applicable branch. The +0.39 gap between A (1.5000, this task, `t090_distillation.rs`,
  4,431,504 WTHOR samples) and the known 1.1111 (T124, `train_patterns_v3`, the same 4,431,504
  WTHOR samples) isolates the trainer as the dominant variable, since the data, pattern set
  (v4), and teacher signal (mover-perspective final disc difference) are held identical between
  the two.
- Per branch (2), **B and C's absolute regret values (1.2333, 1.4333) are reference-only**, not
  evidence that scaling `t090_distillation.rs` + Egaroucid data to full size would beat
  production (1.1111). They remain directionally informative as **relative** signals within the
  same (currently weaker) trainer: B < C < A, i.e. Egaroucid data (both alone and as an addition
  to WTHOR) outperforms WTHOR alone under this trainer, at n=60 with all CIs vs. v2 still
  straddling zero.

## Conclusion and next steps (per this task's scope)

This task's scope is diagnostic only (no full-scale training, no game-play gate, no
`train_patterns_v3` changes — see "Scope confirmation" below). The objective, in-scope
conclusion is:

1. **The T153 Egaroucid-vs-WTHOR comparison was confounded by trainer**, as suspected. Isolating
   the trainer (this task's Run A) shows a substantial gap (1.5000 vs. 1.1111, +0.39) between
   `t090_distillation.rs`'s teacher-only simple-corpus path and `train_patterns_v3` on the
   identical WTHOR dataset and pattern set.
2. Within `t090_distillation.rs`, Egaroucid data is **not worse than, and by this probe's point
   estimate somewhat better than**, WTHOR data at matched sample counts (B: 1.2333 vs A: 1.5000)
   and mixing in Egaroucid's opening-quality subset also helps somewhat (C: 1.4333 vs A: 1.5000,
   though C falls short of B — plausibly because C is 74.5% WTHOR by sample count, so the
   Egaroucid-quality contribution is diluted relative to B, and because Egaroucid's ≤15-stone
   subset skews toward opening-phase positions rather than covering all game phases evenly the
   way B's full-scale, all-phase reservoir sample does).
3. **Recommended next step (not executed in this task, per scope):** per interpretation branch
   (2), the more promising direction is investigating what specifically makes
   `t090_distillation.rs`'s simple-corpus teacher-only training weaker than
   `train_patterns_v3` on identical data (loss function shape, learning-rate schedule/decay,
   L2/regularization, or subtler differences in the phase-stage feature computation path), and/or
   feeding good external data (Egaroucid) into `train_patterns_v3`'s own pipeline instead of
   `t090_distillation.rs`'s. Both are separate, out-of-scope tasks.

## Scope confirmation

Per this task's own scope section: **full 25.5M-record training, a game-play gate, and any
production-adoption decision or `train_patterns_v3` code change are out of scope for T154.** The
results above are reported as objective input for that later decision, not as an adoption
recommendation. No `app/` or `engine/` changes were made (GitHub Pages verification not
applicable to this task, per the task's own note).

`cargo test -p train --release`: PASS (99 passed, 0 failed; see meta JSON). Data files under
`train/data/t154/` (converted corpora, checkpoints, weights, oracle outputs) are not committed
(already covered by the repository's `train/data/` gitignore rule).
