---
id: T152
title: ハウスキーピング: 1M教師コーパスのシャードファイル削除(ユーザー承認済み)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer(Sonnet)
attempts: 0
---

# T152: 1Mシャード削除

## 目的

expanded1m生成(T127b)のシャードファイル(検証済みmerged corpusと内容重複、約1.6GB)を削除してディスクを解放する。**ユーザー承認済み(2026-07-20)**。

## 要件(慎重に、削除は不可逆)

1. **削除前の安全確認(必須)**: `train/data/teacher/corpus_expanded1m.jsonl` の存在・サイズ 1,595,551,517 bytes・SHA-256 = `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86` を実測で確認する。**一致しない場合は何も削除せず停止して報告。**
2. 削除対象: `train/data/teacher/` 配下の expanded1m の**シャード**成果物のみ — シャードjsonl(expanded1m_shard*of8 形式の8本)とそのシャード単位meta/checkpoint/plan、シャード実行ログ(train/data/teacher/logs/expanded1m_shard*)。削除前に対象一覧(パス・サイズ)を作業ログに記録する。
3. **削除しないもの**: merged本体(corpus_expanded1m.jsonl)、生meta(corpus_expanded1m.meta.json)、selection plan(resume不要でも来歴として保持)、corpus_expanded200k系一式、bench/edax-compare/teacher_manifests/ 配下すべて、他コーパス(primary/smoke等)。**判断に迷うファイルは削除せず一覧にして報告。**
4. 削除後: merged本体のSHA-256を再実測し不変を確認。解放サイズを報告。

## 受け入れ基準

1. 削除前後のSHA-256確認記録(一致)と、削除対象一覧・解放サイズが作業ログにある
2. merged本体・manifest類・200k系が無傷である(ls確認)
3. gitで追跡されるファイルへの変更はゼロ(gitignore領域のみの操作)。`git status --short` クリーン

## コミット規律

- 本タスクはgitignore領域のファイル削除のみでコミット対象なし。tasks/への作業ログ追記のみ行う(コミットはオーケストレーター)

## 作業ログ

(ワーカーが追記)
