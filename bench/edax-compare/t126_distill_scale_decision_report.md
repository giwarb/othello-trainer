# T126 distillation scale decision

## Conclusion

**Generate one million distilled positions as a staged investment, then remeasure before committing to four million.**

Reducing v4 WTHOR training to the same scale as the distilled corpus raised oracle regret to a
three-seed mean of 3.8222 discs. This is well above the prespecified 2.5-disc threshold. The
2.7111-disc gap from full WTHOR (1.1111) is therefore primarily a data-volume effect. At the
same scale, distillation scored 2.7667--2.8667, about one disc better than reduced WTHOR, so the
distillation labels/distribution are not the observed deficit's cause.

The one-million projection is approximately 1.4--1.6 discs, which does not reliably beat the
existing full-WTHOR v4 result of 1.1111. The four-million projection is 0.8--1.2, but it is a
long extrapolation from only three one-seed points. A two-day one-million run has information
value as a stage gate; going directly to the eight-day four-million run does not.

## Primary experiment: v4 WTHOR at 180k

The run kept the T124 WTHOR data, v4 model, MSE, learning rate 0.005, L2=1e-5, and 20 epochs.
Only the train sample count changed. Within every v4 empty-count phase, a seed-42 fixed shuffle
was created and `floor(target * phase_count / total)` samples were taken. This is the same
deterministic, stratified, nested method used by T109. Target 180,110 produced 180,077 train
samples (33 fewer due to per-phase flooring); all 442,995 frozen samples remained fixed.

| seed | frozen MAE | oracle regret | difference from v2 | paired bootstrap 95% CI | result |
|---:|---:|---:|---:|---:|---|
| 1 | 17.9447 | 3.9667 | +2.4000 | [0.9000, 4.1000] | candidate_worse |
| 2 | 17.8921 | 3.6667 | +2.1000 | [0.6667, 3.7667] | candidate_worse |
| 3 | 17.9157 | 3.8333 | +2.2667 | [0.8000, 3.9667] | candidate_worse |
| **mean** | **17.9175** | **3.8222** | **+2.2556** | -- | seed SD=0.1503 |

Every run exactly reproduced v2 regret=1.5666666667 on the same 60 T096 positions, passing the
M2 guard. Training atomically saved weights and identity each epoch. Re-running the completed
command skipped epoch computation for all three runs. Oracle state was atomically saved after
each oracle/v2/candidate position and resumes under identical provenance.

## Three-way comparison and attribution

| configuration | train samples | seeds | oracle regret | difference from WTHOR 180k |
|---|---:|---:|---:|---:|
| v4 distilled expanded200k (T124) | 180,110 | 3 | 2.8667 | -0.9556 |
| v4 distilled nested 180k (T126) | 179,957 | 1 | 2.7667 | -1.0556 |
| **v4 WTHOR reduced 180k (T126)** | **180,077** | **3** | **3.8222** | **0** |
| v4 WTHOR full (T124) | 3,988,509 | 3 | 1.1111 | -2.7111 |

Distillation is about one disc better in the equal-volume comparison. Thus the combined
label/distribution hypothesis is disfavored as the explanation for 2.87 discs. WTHOR improves
by 2.71 discs when scaled by about 22x. The observed 3.82-disc reduced-WTHOR result decisively
selects the task's prespecified "volume dominates" interpretation.

## Secondary experiment: distilled v4 learning curve

Seed-42 nested subsets were selected from the expanded200k train split. All runs used v4,
teacher-only, and training seed 1. Validation (9,685) and frozen (10,205) were fixed.

| target | actual train | best/completed epoch | validation teacher MAE | oracle regret | difference from v2 (95% CI) |
|---:|---:|---:|---:|---:|---:|
| 45,000 | 44,965 | 39 / 40 | 8.6065 | 4.7667 | +3.2000 [1.5667, 4.9667] |
| 90,000 | 89,966 | 37 / 37 | 7.7794 | 3.6333 | +2.0667 [0.6333, 3.7000] |
| 180,000 | 179,957 | 26 / 31 | 7.0879 | 2.7667 | +1.2000 [0.0667, 2.4333] |

Oracle regret improves monotonically by 1.1333 and 0.8667 discs on successive doublings, while
validation metrics also improve monotonically. The nested 180k point is within 0.1 disc of the
independent T124 full-split three-seed result (2.8667 for every seed). All three curve points
exactly reproduced the v2 M2 guard.

### Extrapolation

Only three points are available, so the range below is a sensitivity analysis, not a statistical
prediction interval. Two simple saturating models were used.

| model | fit | one million | four million |
|---|---:|---:|---:|
| `a + b / sqrt(N)` | R2=0.9995 | 1.6331 | 1.2101 |
| power law with exponent fit to the three points | exponent=0.387 | 1.4000 | 0.7979 |
| **planning range** | not a confidence interval | **1.4--1.6** | **0.8--1.2** |

A log-linear fit has R2=0.9941 but predicts -1.75 discs at four million, which is not physically
meaningful, so it was excluded from the planning range. One million is about 5.6x beyond the last
point and four million about 22x; uncertainty is especially high for four million.

## Investment comparison

| option | compute investment | expected oracle regret | value and risk | recommendation |
|---|---:|---:|---|---|
| one million distilled | about 2 days | 1.4--1.6 | likely reaches v2; may not beat v4 WTHOR, but anchors the four-million decision | **run** |
| four million full | about 8 days | 0.8--1.2 | greatest upside, but relies on a 22x extrapolation | **hold until one-million result** |
| stop | 0 days | retain v4 WTHOR 1.111 | no immediate quality loss, but abandons equal-volume advantage and a clear curve | not preferred now |

After one million, remeasure the same oracle with the M2 guard. Continue to four million only if
the measured point is approximately 1.4 or better and sustains a credible path below 1.111. At
1.4--1.7, stop by default because beating current v4 WTHOR is unlikely; above 1.7, stop. This is
a label-generation investment gate, not a production acceptance gate.

## Limitations

- The oracle uses the same fixed 60 positions, and every curve point uses only training seed 1.
  Per-point bootstrap intervals cover position variation, not training-seed or extrapolation error.
- WTHOR and distillation differ in both labels and position distribution. This task separates their
  combined equal-volume effect from volume; it does not separate label quality from distribution.
- The subsets are nested inside expanded200k. A changed generation distribution at one million
  may not continue this curve.
- No one-million/four-million corpus generation, production wiring, acceptance decision, or v4
  algorithm change was performed.

## Commands and artifacts

- Primary training: `target/release/train_patterns_v3.exe --configs v4 --seeds 1,2,3 --epochs 20 --output-dir train/data/t126/wthor-v4-180k --train-subset-size 180110 --subset-seed 42`
- Primary oracle, per seed: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t126/wthor-v4-180k/v4-seed-<seed>.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t126/oracle/wthor-180k-seed-<seed>.json`
- Curve training, per size: `target/release/train_distillation.exe --corpus train/data/teacher/corpus_expanded200k.jsonl --checkpoint-dir train/data/t126/distill-v4-<size> --mixes teacher-only --seeds 1 --pattern-set v4 --reference-weights train/weights/pattern_v2.bin --jobs 1 --train-subset-size <target> --subset-seed 42`
- Curve oracle, per size: `python bench/edax-compare/compare_pattern_v3.py --v2 train/weights/pattern_v2.bin --candidate train/data/t126/distill-v4-<size>/teacher-only-seed-1/final.bin --corpus bench/edax-compare/t096_oracle_positions.json --output train/data/t126/oracle/distill-<size>-seed-1.json`

Weights, epoch checkpoints, metrics, and raw oracle JSON are under gitignored `train/data/t126/`.
