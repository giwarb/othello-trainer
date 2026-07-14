---
id: T091
title: Codexラッパーのログ収集修正(stderr進捗の逐次記録、tail可能化)
status: review # todo | in_progress | review | redo | done | blocked
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

- 2026-07-14 実装(implementer): 原因調査・実装・検証を実施。

  **原因調査**: `scripts/codex-design.ps1` `scripts/codex-review.ps1` も `scripts/codex-task.ps1` と全く同じ `$prompt | & codex @codexArgs | Tee-Object -FilePath $logFile` パターンで同じ欠陥を持っていることを確認(codex-design.ps1 の 45KB ログ実績は「別実装」ではなく、たまたま最終メッセージが大きかったなど別要因と判断)。

  **実装**: 新規 `scripts/_codex-common.ps1` に共通ヘルパー `Invoke-CodexWithLiveLog` を追加し、3スクリプトから dot-source して使う方式に統一。
  - PowerShell 5.1(.NET Framework 4.x)では `ProcessStartInfo.ArgumentList` / `StandardInputEncoding` が存在しないことを実機で確認済み(`$psi.GetType().GetProperty(...)` で検証)。そのため引数は自前の `ConvertTo-ProcessArgumentString` で組み立て、stdin は `StandardInput.BaseStream` に UTF-8(BOM無し)バイト列を直接書き込む方式にした。
  - `System.Diagnostics.Process` を直接使い、`OutputDataReceived`/`ErrorDataReceived` を `Register-ObjectEvent -Action` で購読し、行が届くたびに `StreamWriter`(AutoFlush=true, UTF-8 BOM無し)へ排他書き込みする。
  - **重要な落とし穴(実機検証で判明)**: `$process.WaitForExit()` という生の .NET ブロッキング呼び出しを使うと、呼び出し元ランスペースが占有され続け、`Register-ObjectEvent -Action`(同じランスペースを使って実行される)がプロセス終了までディスパッチされない。実際に検証用ハーネス(cmd.exe の子プロセスで1秒間隔の2行のstderr出力)で確認したところ、`WaitForExit()` を使うと2行がプロセス終了直前にまとめて書かれた(逐次書き込みになっていなかった)。`while (-not $process.HasExited) { Start-Sleep -Milliseconds 200 }` のポーリングループに置き換えたところ、行ごとに正しいタイミングで逐次書き込まれることを確認した。
  - `scripts/_codex-common.ps1` は UTF-8 **BOM付き**で保存(`[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($true))`)。Write ツールで新規作成した直後は BOM無しで、dot-source 時に日本語コメントが原因でパーサーエラー(`Missing closing '}'`等)になることを実機で確認し、既存スクリプト(`codex-task.ps1` 等、いずれも BOM付き)に合わせて修正した。

  **検証(受け入れ基準)**:
  1. 軽い実タスクでの検証: scratchpad にダミータスク(`T091-dummy-verify.md`、cargo/engine/リポジトリに一切触れず、scratchpad 内のテキストファイルに1行書き込むだけ)を作成し `./scripts/codex-task.ps1 <dummy>` を実行。別シェルから `Get-Content logs/codex-T091-dummy-verify.log` のサイズを5秒間隔でポーリングし、実行中に育っていくことを確認した(証跡、タイムスタンプ付き):
     ```
     14:55:31 size=3322 bytes
     14:55:36 size=4284 bytes
     14:55:41 size=12819 bytes   (この直後、stderr のサンドボックスエラーメッセージが tail に表示されることを確認)
     14:55:46 size=13034 bytes
     14:55:51 size=13501 bytes
     14:56:19 size=15085 bytes
     14:56:24 size=15799 bytes
     14:56:29 size=16235 bytes  (完了、最終メッセージが末尾に追記された状態)
     ```
     最終ログ(152行)には、進捗(`exec` ツール呼び出し・stderr の ERROR ログ・codex のツール実行結果)と最終メッセージ(stdout)の両方が含まれ、日本語("指定ファイルに `dummy-verify-ok` を書き込み、内容確認と作業ログ追記を完了しました。"等)も文字化けなく可読だった。
  2. 完了後ログの内容確認: 上記の通り、stderr由来の進捗(`exec` トレース・ツール実行ログ・ERROR行)と stdout由来の最終メッセージの両方が同一ログに含まれ、日本語も可読であることを確認。
  3. exit code 伝播: 正常系はダミータスクが成功し(codex側でファイル書き込み成功)、ラッパーの exit code = 0 を確認(バックグラウンド実行の完了通知でも "exit code 0" と表示)。異常系は `-Model "nonexistent-model-xyz-does-not-exist"` を指定して再実行し、codex 側が `ERROR: ... invalid_request_error` を返して失敗、ラッパーの `$LASTEXITCODE` = 1 が正しく伝播することを確認した(PowerShell ツールも `Exit code 1` と報告)。
  4. `codex-design.ps1` / `codex-review.ps1` の同欠陥調査: 上記の通り両方とも同じ `Tee-Object` パターンで同一欠陥を持っていたため、同じ `Invoke-CodexWithLiveLog` ヘルパーで修正。実実行検証は `codex-review.ps1` で実施(read-only、`tasks/T091-codex-wrapper-live-logging.md` に対し `-Range HEAD~1..HEAD` で実行)。ログサイズが 16265→24081→40265→46067→50176→51865→58279 bytes と実行中に育ち続けることを確認(exit code 0 で正常終了、`tasks/review/` にレポート生成も確認)。なお、この検証実行で使った `-Range HEAD~1..HEAD` は T091 の実装コミット範囲ではない(未コミットのため)ため、生成されたレビュー内容自体は「不合格」(範囲不一致のため)だったが、これは検証の目的(ログ収集機構の動作確認)には無関係であり、このレビュー成果物ファイルは意味を持たないため検証後に削除した(`tasks/review/` には残していない)。`codex-design.ps1` は `codex-review.ps1` と全く同じ `Invoke-CodexWithLiveLog` 呼び出し1行の差分のみのため、個別の実実行検証は行っていない(受け入れ基準の「どちらか片方の実実行1回でよい」に該当)。
  5. `git status --short` 確認: 変更対象は `scripts/codex-task.ps1` `scripts/codex-design.ps1` `scripts/codex-review.ps1`(既存3ファイルの修正)と `scripts/_codex-common.ps1`(新規)のみ。並行実行中の T085a(Codex ワーカー)由来の `engine/` `bench/` 差分は一切触れていない。

  **AGENTS.md**: `Tee-Object` やログ収集の実装詳細に言及した記述は無かったため、修正不要と判断(スコープ外の変更はしていない)。

  **実行コマンド(抜粋)**:
  - `Get-Command codex -CommandType Application` で codex.exe のパス確認
  - `[System.Diagnostics.ProcessStartInfo].GetProperties()` 等で .NET Framework 4.x の API 可用性を実機確認
  - `./scripts/codex-task.ps1 <scratchpad>/T091-dummy-verify.md`(正常系・異常系)
  - `./scripts/codex-review.ps1 tasks/T091-codex-wrapper-live-logging.md -Range HEAD~1..HEAD`
  - `[System.Management.Automation.Language.Parser]::ParseFile(...)` で4スクリプトの構文チェック(全て OK)

  **コミット**: CLAUDE.md のコミット責任分担(ワーカーがタスクの変更対象をタスクの一部としてコミット)に従い、`scripts/codex-task.ps1` `scripts/codex-design.ps1` `scripts/codex-review.ps1` `scripts/_codex-common.ps1` のみをパス指定でコミットした(`git add -A` 等は使用していない)。
