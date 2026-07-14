---
id: T091
title: Codexラッパーのログ収集修正(stderr進捗の逐次記録、tail可能化)
status: todo # todo | in_progress | review | redo | done | blocked
assignee: implementer
attempts: 0
---

# T091: Codexラッパーのログ収集修正(stderr進捗の逐次記録、tail可能化)

## 目的

CLAUDE.md の運用は「Codex委譲中の進捗は `logs/codex-T###-*.log` を tail して確認する」だが、実際には機能していない(ユーザー指摘 2026-07-14)。T084/T085a の実測で、ログには**完了時に最終メッセージ(stdout、数KB)だけ**が書かれ、進捗ストリーム(約900KB)は捕捉されていなかった。オーケストレーターが run_in_background の一時捕捉ファイルで代替できたのは偶然で、恒久ログとして欠陥がある。

## 原因(調査済み)

`scripts/codex-task.ps1` 47行目:

```powershell
$prompt | & codex @codexArgs | Tee-Object -FilePath $logFile
```

- `codex exec` は進捗(セッションヘッダ・実行アクション・途中出力)を **stderr** に流し、stdout には最終メッセージしか出さない。
- パイプラインは stdout しか流さないため、`Tee-Object` は最終メッセージのみ受け取る。ログファイルの作成自体も最初のオブジェクト到着時=実行完了時になる。

## 変更対象

- `scripts/codex-task.ps1` — stderr をログへ逐次合流
- `scripts/codex-design.ps1` / `scripts/codex-review.ps1` — 同じ欠陥があるか確認し、あれば同方式で修正(codex-design のログは45KB残っている実績があるので、既に異なる書き方をしている可能性がある。まず現状を読んで判断すること)
- 必要なら `AGENTS.md` / スクリプト冒頭コメントの記述を実態に合わせて微修正

## 要件

1. Codex実行中の進捗(stderr)と最終メッセージ(stdout)の両方が `$logFile` に**逐次**(実行中に tail で読める粒度で)書き込まれること。完了時一括書き出しは不可(CLAUDE.md「長時間実行タスクの運用ルール」と同趣旨)。
2. PowerShell 5.1 の制約に注意: ネイティブコマンドへの `2>&1` は stderr 行を ErrorRecord にラップし `$?` を汚す。`ForEach-Object { "$_" }` での文字列化、`Start-Process -RedirectStandardError`、`cmd /c "... 2>&1"` 等から動作するものを選ぶこと。**exit code(`$LASTEXITCODE` 相当)がラッパーの exit code として正しく伝播すること**(オーケストレーターが成否判定に使う)。
3. 日本語が化けずにログに残ること(UTF-8)。現行の `$OutputEncoding` UTF-8 切替(stdin側)は維持。
4. **T081のWindows回避策を壊さない**: stdin渡し(引数渡し禁止)・UTF-8(BOM無し)・`-c windows.sandbox=unelevated`・`--ephemeral`。プロンプト本文も変更しない。
5. `run_in_background` 起動との併用を想定(ラッパー自体の標準出力にも従来どおり進捗が流れてよい)。

## やらないこと(スコープ外)

- Codex CLI 自体の設定変更(`~/.codex/config.toml` 等)
- プロンプトテンプレートの内容変更
- CLAUDE.md の運用ルール変更(記述が実態と合わなくなる場合のみ、該当1文の修正を報告して指示を仰ぐ)

## 受け入れ基準(検証コマンド)

- [ ] 軽い実タスクで検証: 一時的なダミータスクファイル(scratchpad に作成、リポジトリ内に残さない)を `./scripts/codex-task.ps1 <dummy> ` で実行し、**実行中に**別シェルから `Get-Content $logFile -Tail 5` で進捗行が読めること(完了前にログが数KB以上育っていること)を確認し、証跡(タイムスタンプ付きのログサイズ推移)を作業ログに記録
- [ ] 完了後のログに stderr 由来の進捗と stdout 由来の最終メッセージの両方が含まれ、日本語が可読であること
- [ ] ラッパーの exit code が codex の exit code を伝播すること(正常0・異常非0の両方を確認。異常系は存在しないモデル名指定等で再現してよい)
- [ ] `./scripts/codex-review.ps1` / `./scripts/codex-design.ps1` について同欠陥の有無の調査結果を作業ログに記録し、あれば同修正を適用(検証はどちらか片方の実実行1回でよい。read-onlyなので軽い依頼書で試せる)
- [ ] 変更をコミット・push し、タスク完了時点で当該タスク由来の差分・未追跡ファイルが `git status --short` に残っていないこと

## フィードバック(やり直し時にオーケストレーターが記入)

(なし)

## 作業ログ(担当エージェントが追記)
