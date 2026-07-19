---
id: T127b
title: expanded1m本番生成(80万件新規、約41時間)
status: done # 2026-07-19 23:04 生成完走(1,000,000/1,000,000、8シャード全てexit 0)。データ検証はT127c
assignee: オーケストレーター(プロセス管理)+T127a基盤
attempts: 0
---

# T127b: expanded1m本番生成

設計: tasks/design/T127-corpus-1m-report.md §5 T127b節。コード変更なし(T127a確定コミットd0f68daのまま凍結)。

- 起動: `python bench/edax-compare/gen_teacher_corpus.py expanded1m --num-shards 8 --skip-extract --reuse-selection-plan`(detached、ログ logs/t127b-gen.log)
- base 200k import→新規800k生成(8シャード各10万)。1局面単位checkpoint、resume時はrunKey+実ファイルSHA照合(不一致拒否)
- 進捗観測: シャードjsonl行数(初期値=base 200,000行、完了=1,000,000行)
- **生成中ルール(レポート§6)**: 重い計測・学習・releaseビルド・生成関連ファイル変更は禁止(必要ならシャードごと停止→作業→resume)。停止時は親+8シャードを一組で管理
- 完了後: T127c(検証・manifest+テスト固定2件のフォローアップ)へ

## 作業ログ

- 2026-07-17 21:3x: cold→warm 32親束方式へ乗り換え(T127h、292,679件全件保持でresume)。
- 2026-07-18 07:1x: Edax v3(AVX2)バイナリへ乗り換え(T127i/j、493,703件全件保持、値全帯全件一致確認済み)。方式境界はサイドカー teacher_manifests/corpus_expanded1m_method_boundaries.json が正。
- 2026-07-19 15:06: PC再起動で停止(629,415件時点)。15:5x resumeで再起動(629,447から継続、束checkpointにより損失実質ゼロ)。ログはlogs/t127b-gen4.logへ切替。
- 2026-07-19 21時台: シャード0/4/5から順に重い帯(空き20-29 incremental)を抜けペース4.5k→140k件/h超へ回復。
- 2026-07-19 23:04: **完走**。1,000,000/1,000,000件、8シャード全てexit 0、merge成功(train/data/teacher/corpus_expanded1m.jsonl、1,595,551,517 bytes)。stderrエラーなし。全期間を通じ生成データの破棄・再生成なし(3方式の境界はサイドカー参照)。→ 検証・manifest確定はT127cへ。
