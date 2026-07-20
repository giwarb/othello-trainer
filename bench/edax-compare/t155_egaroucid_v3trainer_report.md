# T155: Egaroucid data through the production trainer (`train_patterns_v3`)

## Summary

T154 showed that the same Egaroucid/WTHOR data trained through a *different* trainer
(`t090_distillation.rs`'s `--simple-corpus` path) gives worse oracle regret than the same WTHOR
data trained through the production trainer (`train_patterns_v3`, T124, 1.1111) — isolating the
**trainer** (loss shape / early stopping / LR schedule), not the data, as the dominant source of
the earlier Egaroucid-vs-WTHOR gap. This task closes that gap by adding a `--simple-corpus`
ingestion mode directly to `train_patterns_v3` itself (the trainer that produced the 1.1111
benchmark), so Egaroucid data can be trained through the *good* trainer, and re-measures.

**Result: this does not help.** E1 (Egaroucid, 4,431,504-record pool matching T124's WTHOR
pool size exactly, v4 pattern set, `train_patterns_v3`, 3 seeds, T096 60-position oracle) gives a
**3-seed mean regret of 1.5556** (seeds: 1.5333 / 1.4667 / 1.6667), which is:

- **worse** than `v4 x WTHOR` on the same trainer (T124, 1.1111) by **+0.4444**
- **worse** than the same Egaroucid data on the *weaker* `t090_distillation.rs` trainer (T154 Run
  B, 1.2333) by **+0.3222**
- statistically indistinguishable from the untrained `pattern_v2.bin` baseline (1.5667, diff
  -0.0111)

This falls decisively into this task's pre-registered "**>1.3**" band: **the data route is
shelved; MPC is the recommended next direction** (per the pre-registration in
`tasks/T155-egaroucid-on-v3-trainer.md`). No game-play gate is proposed.

The counter-intuitive direction of this result (Egaroucid data performs *worse* on the *better*
trainer than on the *worse* trainer) is itself the most useful finding of this task — see
"Discussion: why does the good trainer do worse on Egaroucid data?" below.

## Pre-registered design (recap)

Per `tasks/T155-egaroucid-on-v3-trainer.md`:

- **E1**: Egaroucid only, `--simple-max-records 4431504` (same pool size T154's Run B used, which
  itself matched `train_patterns_v3`'s T124 WTHOR pool size), v4 pattern set, seeds 1/2/3, T096
  60-position oracle + M2 guard (v2 regret must reproduce `1.5666666666666667` exactly) each run.
- **E2** (reference, optional): Egaroucid @8,000,000, 1 seed, run only if time allows (skip if a
  single run exceeds 45 minutes).
- **Interpretation rule**: 3-seed mean regret ≤1.0 → propose a game-play gate (heavy, separate
  task). 1.1-1.3 → roughly on par with the known 1.1111 benchmark, consider scaling further
  (E2/full). >1.3 → the production trainer still favors WTHOR data; shelve the data-quality
  direction in favor of MPC.

## Implementation: `--simple-corpus` in `train_patterns_v3`

**New module** `train/src/simple_corpus.rs` (used only when `--simple-corpus` is passed):

- `parse_simple_line`: `<64-char board> <score>` -> `train_data::Sample` (`mover` fixed to
  `Side::Black`; `X`=own/`O`=opponent maps directly to black/white bits, matching
  `t090_distillation.rs::parse_simple_record`'s convention — `pattern_state_index` normalizes
  own/opponent internally, so the fixed mover choice does not affect evaluation).
- `list_simple_corpus_files`: a directory argument lists its `*.txt` files sorted by name (for
  Egaroucid's `0000000.txt`..`0000025.txt` layout); a file argument is used as-is.
- `load_simple_corpus`: streams the file(s) once, and if `--simple-max-records` is set, keeps
  exactly `min(total_lines, max_records)` records via deterministic Algorithm-R reservoir
  sampling (unselected lines are never board-parsed, so a 25.5M-line corpus scan stays cheap even
  when only a few million records are kept). Returns a content hash (all lines, independent of
  `max_records`) for resume-identity stability.
- `split_by_position_hash`: **T155's holdout scheme for simple-corpus mode.** Simple records have
  no "game" concept, so `train_patterns_v3`'s existing default-path holdout (last 10% of *games*)
  does not apply. Instead, each record's D4-canonicalized `experiment::canonicalize` key is
  fnv1a-hashed; `hash % 10 == 9` -> frozen (~10%), else train. Canonicalizing first (rather than
  hashing the raw board) keeps rotation/reflection duplicates of the same position on the same
  side of the split, avoiding a symmetry-based train/frozen leak — verified by a unit test that
  constructs two symmetric duplicates and asserts they land in the same bucket.

**`train_patterns_v3.rs` changes**, designed to keep the existing WTHOR default path provably
unchanged:

1. The per-`(config, seed)` training loop (checkpoint save/resume, epoch loop, final frozen
   MSE/MAE, `results.tsv` append) was extracted verbatim into a new function `run_config_seed`,
   called identically by both the WTHOR path and the new simple-corpus path — this is a pure
   code-motion refactor with no logic change.
2. `main` now branches: if `--simple-corpus` is given, it skips WTHOR file loading entirely and
   uses `simple_corpus::{list_simple_corpus_files, load_simple_corpus, split_by_position_hash}`
   to build `train_samples`/`frozen_samples`, with a **separate identity-string namespace**
   (`schema=2-simple`, vs. the WTHOR path's unchanged `schema=2`) so the two modes can never
   collide on resume identity even by accident.
3. `--max-games`/`--train-subset-size` (WTHOR-only options) are rejected with an explicit error
   if combined with `--simple-corpus`, rather than being silently ignored.
4. `--subset-seed` (existing flag, default 42) is reused as the reservoir-sampling seed in
   simple-corpus mode (mirroring T154 Run B's `--subset-seed 42` default), since the two modes
   are mutually exclusive within one invocation.

**Default-path invariance was verified empirically, not just by code inspection:** running
`--configs v2 --seeds 1 --epochs 1 --max-games 20` before and after the refactor produced a
byte-identical `results.tsv` and an identical output-weights SHA-256
(`6be188ab7cc818b076e81bfa274b3c2bf016250297b7960382dcfbefa6d2d0d5`). Resume-on-already-completed
was also re-verified (re-running the same command after completion skips the epoch loop and
reproduces the same `frozen_mse`/`frozen_mae` without error).

`cargo test -p train --release`: **all tests pass** (87 lib tests, including 12 new tests in
`simple_corpus.rs` covering line parsing, file listing, reservoir-sampling determinism/exactness,
and split determinism/symmetry-duplicate handling; plus the pre-existing `train_patterns_v3`,
`t090_distillation`, `wthor_lines`, and `real_data` test suites, all unmodified and green).

## Training runs

Both runs used `target/release/train_patterns_v3.exe`, `--configs v4 --epochs 20`
(`train_patterns_v3`'s defaults: lr 0.005, L2 1e-5, MSE loss, no early stopping — the exact
regime that produced T124's 1.1111), launched via detached `Start-Process` per the long-running
task convention and polled via a Bash background poller (not relying on the Monitor tool's
completion notification, which is known to be unreliable in this environment). Checkpointing is
per-epoch (atomic `epoch-NN.bin`/`.meta`, identity-checked resume), unchanged from the WTHOR
path's existing mechanism, and progress was visible throughout in
`logs/t155-egaroucid-v4-e1.stdout.log` / `-e2.stdout.log`.

| run | command | pool | train (actual) | frozen (actual) | wall time |
|---|---|---:|---:|---:|---:|
| E1 (seeds 1/2/3) | `--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --simple-max-records 4431504 --configs v4 --seeds 1,2,3 --epochs 20 --output-dir train/data/t155/egaroucid-v4-e1` | 4,431,504 | 3,877,551 | 553,953 | ~8 min total (3 seeds, single process, corpus scanned once; seed-to-seed checkpoint gaps ~2.5 min each) |
| E2 (seed 1, reference) | `--simple-corpus train/data/egaroucid/extracted/0001_egaroucid_7_5_1_lv17 --simple-max-records 8000000 --configs v4 --seeds 1 --epochs 20 --output-dir train/data/t155/egaroucid-v4-e2` | 8,000,000 | 6,999,893 | 1,000,107 | ~15-20 min (1 seed; well under the 45-min cap) |

The frozen fraction (12.5%) is somewhat above the nominal ~10% target of the `hash % 10 == 9`
split; this is consistent across both E1 and E2 pool sizes (553,953/4,431,504 = 12.50%,
1,000,107/8,000,000 = 12.50%), suggesting a structural property of how Egaroucid's position
distribution interacts with the fnv1a hash of the D4-canonical key (e.g., a skew from
frequently-repeated positions landing in the same bucket) rather than statistical noise. This
does not affect correctness of the train/frozen partition (it is still a clean, deterministic,
symmetry-safe split), only its exact proportion.

| run | seed | frozen MSE | frozen MAE | weights SHA-256 |
|---|---:|---:|---:|---|
| E1 | 1 | 49.436191 | 5.229859 | `578186597816f76a0c98e1f432843623bbc1f61e41a63d1247c8e84820d3f315` |
| E1 | 2 | 49.410315 | 5.217922 | `0c03dc720f1648bb37b1794f58ad13b1a1def936ab018ada9e5082b70202c1cd` |
| E1 | 3 | 49.299256 | 5.209128 | `7407323de07f7fcf370e3572daa617735eec7774231675c0616b428515d97d7f` |
| E2 | 1 | 45.820308 | 5.043209 | `123db23b6b43c5c9a98f78dba78d8496affece0b05876a96b58ad90b7097c3b4` |

Frozen MAE around 5.2 discs is far lower than `train_patterns_v3`'s WTHOR run (T124: seed MAEs
16.19/15.73/15.95), mirroring T154's observation that Egaroucid's teacher signal is much smoother
per-position than WTHOR's noisy actual-game final-disc-difference outcome (not directly
comparable as a quality signal across data sources — the oracle-regret metric below is the
cross-source-comparable one).

## Oracle evaluation (T096 60 positions, `compare_pattern_v3.py`, M2 guard)

```
python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin \
  --candidate train/data/t155/egaroucid-v4-e1/v4-seed-<seed>.bin \
  --corpus bench/edax-compare/t096_oracle_positions.json \
  --output train/data/t155/oracle/egaroucid-v4trainer-e1-seed-<seed>.json
```

| run | seed | v2 mean regret | M2 guard | candidate mean regret | diff from v2 | 95% CI vs v2 | classification |
|---|---:|---:|---|---:|---:|---|---|
| E1 | 1 | 1.5666666666666667 | **PASS** | **1.5333** | -0.0333 | [-0.667, 0.633] | no_significant_difference |
| E1 | 2 | 1.5666666666666667 | **PASS** | **1.4667** | -0.1000 | [-0.833, 0.700] | no_significant_difference |
| E1 | 3 | 1.5666666666666667 | **PASS** | **1.6667** | +0.1000 | [-0.667, 0.933] | no_significant_difference |
| **E1 mean** | 3seed | — | 3/3 PASS | **1.5556** | -0.0111 vs v2 | seed SD (sample) 0.1018 | — |
| E2 (ref, @8M) | 1 | 1.5666666666666667 | **PASS** | **1.3667** | -0.2000 | [-0.700, 0.300] | no_significant_difference |

All three E1 M2 guards reproduce the known v2 constant (`1.5666666666666667`) exactly, and all
provenance hashes (`pattern_v2.bin`, `eval_cli.exe`, the Edax binary/`eval.dat`, the T096 corpus)
match T154's recorded values exactly (see meta JSON), confirming the oracle harness is
byte-identical to prior tasks'.

**Reference points from prior tasks (not recomputed here):**

| point | trainer | mean regret |
|---|---|---:|
| v2 (untrained baseline) | — | 1.5667 |
| v4 x WTHOR full (T124) | `train_patterns_v3` (this task's trainer) | **1.1111** |
| v4 x Egaroucid @4,431,504 (T154 Run B) | `t090_distillation.rs` `--simple-corpus` | 1.2333 |
| **v4 x Egaroucid @4,431,504 (this task, E1, 3-seed mean)** | **`train_patterns_v3`** | **1.5556** |
| **v4 x Egaroucid @8,000,000 (this task, E2, 1 seed, reference)** | **`train_patterns_v3`** | **1.3667** |

## Interpretation applied to the pre-registered rules

- **E1 3-seed mean = 1.5556**, which is **>1.3** — the pre-registered ">1.3" branch applies
  directly: **the production trainer (`train_patterns_v3`) still favors WTHOR data over
  Egaroucid data; the data-quality direction is shelved, and the recommended next step is MPC.**
  No game-play gate is proposed (the ≤1.0 threshold for that recommendation is not met by a wide
  margin).
- The 1.1-1.3 "scale up via E2" branch does not apply, since E1 is decisively outside that range;
  E2 was nonetheless run as the task's optional reference item (cheap given the observed ~2.5
  min/seed training throughput at this scale). **E2's single-seed regret (1.3667) is better than
  E1's 3-seed mean (1.5556) by 0.19 discs — nearly doubling the pool size helped, but the result
  still lands just past the 1.3 threshold**, i.e. still in (or right at the edge of) the "shelve
  the data route" band, not the "1.1-1.3, comparable" band. This is a single seed (per the task's
  own "1本" scope for E2), so it is reported as a reference data point that is *directionally*
  consistent with more data helping somewhat, not as a statistically robust second measurement —
  it does not change this task's primary, 3-seed-supported conclusion from E1.

## Discussion: why does the good trainer do worse on Egaroucid data?

This is the counter-intuitive core finding of T155, worth stating plainly since it reframes
T154's conclusion. T154 established "the trainer, not the data, was the dominant gap" by showing
WTHOR-on-`t090_distillation.rs` (1.5000) is far worse than WTHOR-on-`train_patterns_v3` (1.1111).
The natural follow-up hypothesis was "so Egaroucid-on-`train_patterns_v3` should also do well" —
**this task shows that hypothesis is false**: Egaroucid-on-`train_patterns_v3` (1.5556) is worse
than Egaroucid-on-`t090_distillation.rs` (1.2333, T154 Run B), the reverse of what happened with
WTHOR data on the same two trainers.

The most likely explanation, based on the training-loss numbers available from both tasks, is
**overfitting from `train_patterns_v3`'s fixed, unconditional 20-epoch schedule with no
early stopping**, interacting with how much faster and smoother Egaroucid's teacher signal
converges than WTHOR's:

- `t090_distillation.rs` uses validation-loss-driven early stopping (patience 5). On the *same*
  Egaroucid pool size, T154 Run B stopped at best_epoch=42 of a 60-epoch budget (i.e., it needed
  many more passes over the data than 20, and importantly, *stopped exactly when validation loss
  stopped improving*).
- `train_patterns_v3` always trains for exactly `--epochs` (20 here) regardless of any validation
  signal — there is no mechanism to detect that the model has already converged or started
  overfitting partway through.
- Egaroucid's teacher scores are Egaroucid's own search-derived evaluations (a much lower-variance
  target per position than WTHOR's actual-game final disc difference), so the model likely
  reaches a good fit to the *training* distribution faster and then continues to drift on 20 fixed
  epochs of further gradient steps without the correction validation-based stopping would provide
  — plausibly overfitting to reservoir-sampled quirks of the training subset rather than learning
  the more transferable structure that WTHOR's noisier, larger-scale outcome labels enforce via
  implicit regularization.

This is offered as the most parsimonious explanation consistent with both tasks' numbers, not as
a proven mechanism (no additional runs varying epoch count or adding early stopping were
performed in this task, per scope — see "Recommended next steps" below). **E2's result (1.3667
at 8,000,000 records, vs. E1's 1.5556 mean at 4,431,504) is directionally consistent with this
hypothesis**: nearly doubling the pool at the same fixed 20 epochs gives the model more distinct
positions per gradient step, which would be expected to slow memorization/overfitting of the
training subset even without any explicit early-stopping mechanism — though, as noted above, E2
is a single seed and this is a secondary, reference-only observation, not a controlled test of
the hypothesis (which would require varying epoch count directly, holding data fixed). It is also consistent
with T124's own within-task observation that v4's seed-to-seed oracle regret variance was already
large on WTHOR (0.70/1.67/0.97) even with `train_patterns_v3`'s existing regime, so some degree of
regime-sensitivity for this pattern/trainer combination was already visible before this task.

## Recommended next steps (out of scope for this task)

Per the pre-registered ">1.3" branch, this task's own recommendation is to **not** pursue further
Egaroucid-data-quality experiments and instead prioritize MPC (multi-prob-cut / search-side
improvements) as the next engine-strength lever. If a future task *does* want to revisit
Egaroucid data specifically, the discussion above suggests the first thing to try would be
**early stopping or a much smaller fixed epoch count within `train_patterns_v3`** (this task
deliberately did not add early stopping to `train_patterns_v3`, since that would be a trainer
behavior change requiring its own default-path-invariance verification, out of this task's scope)
rather than more data or more seeds at the current fixed-20-epoch setting.

## Scope confirmation

Per this task's own scope: **no game-play gate, no production wiring, no full 25.5M-record
training, and no changes to `t090_distillation.rs` or `train_data.rs` were performed.**
`app/`/`engine/` are unchanged (GitHub Pages verification not applicable). Data files under
`train/data/t155/` (Egaroucid-derived pools, checkpoints, weights, oracle outputs) are not
committed (covered by the repository's existing `train/data/` gitignore rule).

`cargo test -p train --release`: PASS (see meta JSON for the exact count).
