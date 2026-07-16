# T090a/T114 teacher corpus manifests

`corpus_smoke.meta.json`, `corpus_primary.meta.json`, and `corpus_expanded200k.meta.json` are
the committed manifests for the local, gitignored corpus. The authoritative JSONL schema is
documented in `../gen_teacher_corpus.py`'s module docstring. Corpus JSONL files remain under
`train/data/teacher/` and must not be committed.

`corpus_expanded200k.meta.json` (T114, 200,000 positions, WTHOR years 2000-2024) uses
`exactEmptiesThreshold: 20`, unlike `smoke`/`primary` which use the original `24`. See its
`migration` section for why (generation-pace ETA slowdown at empties 20-29, user ruling
2026-07-16) and how the transition from 24 to 20 was performed without losing already-labeled
records outside the affected empties range.
