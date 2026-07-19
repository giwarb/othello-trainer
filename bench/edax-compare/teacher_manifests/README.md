# T090a/T114/T127c teacher corpus manifests

`corpus_smoke.meta.json`, `corpus_primary.meta.json`, `corpus_expanded200k.meta.json`, and
`corpus_expanded1m.meta.json` are the committed manifests for the local, gitignored corpus. The
authoritative JSONL schema is documented in `../gen_teacher_corpus.py`'s module docstring. Corpus
JSONL files remain under `train/data/teacher/` and must not be committed.

`corpus_expanded200k.meta.json` (T114, 200,000 positions, WTHOR years 2000-2024) uses
`exactEmptiesThreshold: 20`, unlike `smoke`/`primary` which use the original `24`. See its
`migration` section for why (generation-pace ETA slowdown at empties 20-29, user ruling
2026-07-16) and how the transition from 24 to 20 was performed without losing already-labeled
records outside the affected empties range.

`corpus_expanded1m.meta.json` (T127c, 1,000,000 positions, WTHOR years 2000-2024) fully contains
`corpus_expanded200k` as its first 200,000 records (`positionId=0..199999`, byte-identical, see
`provenance.baseCorpus`) plus 800,000 newly generated records (`positionId=200000..999999`, see
`provenance.incrementalGeneration`). Generation switched methods twice mid-run without changing
values (cross-parent warm batching, then the AVX2 `wEdax-x86-64-v3.exe` binary); the exact
per-shard record counts at each switch are pinned in the sidecar file
`corpus_expanded1m_method_boundaries.json` (git-tracked, unaffected by checkpoint rewrites) and
transcribed into `provenance.methodBoundaries` by `finalize_teacher_corpus.py --expanded1m`. All
1,000,000 records were independently verified record-by-record by
`verify_teacher_corpus.py expanded1m` (0 errors); see the manifest's `verification` section.
