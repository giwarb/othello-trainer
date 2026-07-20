# T158c screening report

## Decision

All screening gates passed. Deferred T158d candidate: **B3 seed 2**, SHA-256 `dae9af0b4d9e3322c6e2181071b095bca1f2272e69ba85d0e828f21e29c7c5ec`. This is not production adoption.

## Seed-by-seed 61-stage frozen harm

Seed 1 (empty 43/53/54) and seed 3 (empty 46) exceed +0.10 and are excluded. Seed 2 is the only frozen-safe seed. Full 61-stage arrays are in meta.

| seed | overall delta | worst empty | worst delta | stages > +0.10 | decision |
|---:|---:|---:|---:|---:|---|
| 1 | -0.052198 | 43 | +0.228951 | 3 | EXCLUDE |
| 2 | -0.067782 | 49 | +0.012201 | 0 | PASS |
| 3 | -0.066199 | 46 | +0.140260 | 1 | EXCLUDE |

## Gate 4: T157 oracle 180

Per-position atomic checkpoints and M2/provenance guards passed. Agreement includes value-tied top moves. Stop at regret delta >= +0.2 or agreement delta < -5 percentage points; oracle improvement is not promotion evidence.

| weight | mean regret | agreement | delta vs v4 | paired W/L/T | decision |
|---|---:|---:|---:|---:|---|
| v2 | 1.411111 | 121/180 (67.2%) | +0.000000 | 0/0/0 | M2 |
| v4_prod | 1.377778 | 126/180 (70.0%) | +0.000000 | 0/0/0 | baseline |
| seed1 | 1.533333 | 121/180 (67.2%) | +0.155556 | 17/22/141 | PASS |
| seed2 | 1.444444 | 125/180 (69.4%) | +0.066667 | 17/16/147 | PASS |
| seed3 | 1.411111 | 126/180 (70.0%) | +0.033333 | 13/11/156 | PASS |

Oracle worst empties-bin regressions vs v4: seed 1: empties 21 +1.000; seed 2: empties 19 +1.727; seed 3: empties 19 +0.909. All per-empties regret/delta values are in meta. These oracle bins were inspected with the frozen 61-stage arrays; seeds 1 and 3 remain excluded by frozen local harm.

## Learned-weight NPS and determinism

T158a's stratified 8 positions, actual learned coefficients, fresh TT: native feature on/off NPS ratio 0.9160; WASM 0.9417. Both modes repeated deterministically. Per-position elapsed/depth/nodes/move are in meta and t158c_nps_results.json. Ratios are diagnostic because feature-on changes the search tree.

## Gate 5: 24-game paired smoke

Comparator: same-run B0 seed 2. Fixed smoke10 + primary01-02, color-swapped. depth12, 160k nodes, quota60%, exact-from16, TT64MiB; <=20 empties unlimited exact. Every decision was repeated with fresh TT and checked for legality. Atomic checkpoint/resume is per game.

Candidate 12 wins, 1 draws, 11 losses; mean margin -3.083; anomalies=0; **harm_smoke_pass**. Wins are not adoption evidence.

## Deferred T158d registration

Meta key `deferredT158d` pins candidate/baseline/eval/opening/Edax hashes, git commit/tree, protocol, build, schema and screening results. The 60-game Edax gate was not run.
