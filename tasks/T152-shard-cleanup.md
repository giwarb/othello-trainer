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

### 2026-07-20 実装(implementer)

**1. 削除前の安全確認**
- `train/data/teacher/corpus_expanded1m.jsonl` サイズ: 1,595,551,517 bytes (一致)
- SHA-256 (削除前): `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86` (`sha256sum` で実測、タスク指定値と一致)
- `git check-ignore -v` でシャード対象ファイルが `.gitignore:32:train/data/` によりgitignore領域であることを確認済み

**2. 削除対象一覧(パス・サイズ、計32ファイル・1,813,486,333 bytes = 約1.69GiB)**

| パス | サイズ(bytes) |
|---|---|
| train/data/teacher/corpus_expanded1m_shard0of8.jsonl | 199,369,008 |
| train/data/teacher/corpus_expanded1m_shard0of8.meta.json | 9,216 |
| train/data/teacher/corpus_expanded1m_shard0of8.plan.jsonl | 27,156,253 |
| train/data/teacher/logs/expanded1m_shard0of8.log | 76,224 |
| train/data/teacher/corpus_expanded1m_shard1of8.jsonl | 199,637,773 |
| train/data/teacher/corpus_expanded1m_shard1of8.meta.json | 9,217 |
| train/data/teacher/corpus_expanded1m_shard1of8.plan.jsonl | 27,156,247 |
| train/data/teacher/logs/expanded1m_shard1of8.log | 76,223 |
| train/data/teacher/corpus_expanded1m_shard2of8.jsonl | 199,406,337 |
| train/data/teacher/corpus_expanded1m_shard2of8.meta.json | 9,218 |
| train/data/teacher/corpus_expanded1m_shard2of8.plan.jsonl | 27,156,587 |
| train/data/teacher/logs/expanded1m_shard2of8.log | 76,432 |
| train/data/teacher/corpus_expanded1m_shard3of8.jsonl | 199,460,056 |
| train/data/teacher/corpus_expanded1m_shard3of8.meta.json | 9,218 |
| train/data/teacher/corpus_expanded1m_shard3of8.plan.jsonl | 27,156,245 |
| train/data/teacher/logs/expanded1m_shard3of8.log | 76,483 |
| train/data/teacher/corpus_expanded1m_shard4of8.jsonl | 199,290,139 |
| train/data/teacher/corpus_expanded1m_shard4of8.meta.json | 9,218 |
| train/data/teacher/corpus_expanded1m_shard4of8.plan.jsonl | 27,156,309 |
| train/data/teacher/logs/expanded1m_shard4of8.log | 76,224 |
| train/data/teacher/corpus_expanded1m_shard5of8.jsonl | 199,572,612 |
| train/data/teacher/corpus_expanded1m_shard5of8.meta.json | 9,218 |
| train/data/teacher/corpus_expanded1m_shard5of8.plan.jsonl | 27,156,338 |
| train/data/teacher/logs/expanded1m_shard5of8.log | 76,171 |
| train/data/teacher/corpus_expanded1m_shard6of8.jsonl | 199,438,390 |
| train/data/teacher/corpus_expanded1m_shard6of8.meta.json | 9,217 |
| train/data/teacher/corpus_expanded1m_shard6of8.plan.jsonl | 27,156,371 |
| train/data/teacher/logs/expanded1m_shard6of8.log | 76,276 |
| train/data/teacher/corpus_expanded1m_shard7of8.jsonl | 199,377,202 |
| train/data/teacher/corpus_expanded1m_shard7of8.meta.json | 9,218 |
| train/data/teacher/corpus_expanded1m_shard7of8.plan.jsonl | 27,156,470 |
| train/data/teacher/logs/expanded1m_shard7of8.log | 76,223 |

`rm` で上記32ファイルを削除(全件成功、exit 0)。

**3. 削除しないもの(タスク指定どおり無傷を確認)**
- merged本体 `corpus_expanded1m.jsonl`、生meta `corpus_expanded1m.meta.json`、selection plan `corpus_expanded1m_selection_plan.jsonl`/`.meta.json` — 存在・サイズとも変化なし
- `corpus_expanded200k*` 一式(shard含む8本) — 無傷
- `corpus_primary*`、`corpus_smoke*` — 未操作
- `bench/edax-compare/teacher_manifests/` — 未操作(対象ディレクトリ外)

**4. 判断に迷い削除しなかったもの(報告)**
- `train/data/teacher/backup-t127h-migration/`、`backup-t127j-migration/`、`backup-t127j-plan/` に、過去の移行作業(T127h/T127j)由来と思われる `corpus_expanded1m_shard*of8.jsonl` / `.meta.json` / `.plan.jsonl` および `corpus_expanded1m_selection_plan.jsonl` のコピーが残存していることを発見(概算: backup-t127h-migration 約914MB、backup-t127j-migration 約890MB、backup-t127j-plan 約417MB)。本タスクの削除対象定義(「train/data/teacher/ 配下の expanded1m のシャード成果物のみ」)には直接該当する記載がなく、独自削除は行わずここに報告のみとした。
- `train/data/teacher/logs/` 内の `shard{0-7}of8.log`(`expanded1m_`接頭辞なし、Jul17付)は日時・サイズから`expanded200k`系のログと判断し削除対象から除外した。

**5. 削除後の再確認**
- merged本体 SHA-256(削除後再実測): `067a4e3a0076d39f793164c0b2168375a5a9d450cf1f7325ba0e4661e4741e86`(削除前と一致、不変)
- merged本体サイズ: 1,595,551,517 bytes(不変)
- `git status --short` : 出力なし(クリーン)

**解放サイズ**: 1,813,486,333 bytes(約1.69 GiB)

実行コマンド: `sha256sum`(削除前後)、`git check-ignore -v`、`rm`(32ファイル)、`ls -la`、`git status --short`。すべて成功。
