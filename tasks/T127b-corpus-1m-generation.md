---
id: T127b
title: expanded1m本番生成(80万件新規、約41時間)
status: in_progress # todo | in_progress | review | redo | done | blocked
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
