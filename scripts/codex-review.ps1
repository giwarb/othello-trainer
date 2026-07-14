# Codex CLI に最終レビューを依頼するラッパー (Windows)
# 使い方: ./scripts/codex-review.ps1 tasks/T082-foo.md [-Range HEAD~1..HEAD] [-Model gpt-5.6-sol] [-Out tasks/review/T082-foo-codex-review.md]
# 読み取り専用サンドボックス(-s read-only)で実行するため、Codex は git diff / git log 等の読み取りコマンドで差分を調査するのみでファイルを変更しない。
param(
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [string]$Range = "HEAD~1..HEAD",
    [string]$Model = "gpt-5.6-sol",
    [string]$Out
)

if (-not (Test-Path $TaskFile)) {
    Write-Error "タスクファイルが見つかりません: $TaskFile"
    exit 1
}

git rev-list $Range 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Range が不正です: $Range"
    exit 1
}

New-Item -ItemType Directory -Force -Path "tasks/review" | Out-Null
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

$taskName = [IO.Path]::GetFileNameWithoutExtension($TaskFile)
if (-not $Out) {
    $Out = "tasks/review/$taskName-codex-review.md"
}
$logFile = "logs/codex-review-$taskName.log"

$prompt = @"
あなたはこのリポジトリの最終レビュアーです。git diff $Range と git log $Range を自分で実行して差分を読み、必要に応じて周辺コードも読んでください。ファイルは一切変更しないでください。
リポジトリ直下の AGENTS.md(ワーカー向けガイド)の「設計コンサル/最終レビュー役」の規律に従い、サブエージェントを起動せずにあなた自身が直接ツールで差分・コードを読んでレビューしてください。
レポート全文を最終メッセージとしてそのまま出力してください(ファイル保存はこのラッパーが行います)。
以下のタスク仕様(目的・要件・スコープ外・受け入れ基準)に照らして、次の要素を含むレビューレポートを最終メッセージとして日本語で書いてください。
(a) 重大(done を止めるブロッカー)
(b) 中(次タスクで対応すべき)
(c) 軽微(記録のみ)
(d) 総合判定(合格/不合格とその理由)
正しさ・回帰リスク・設計妥当性・タスク仕様との乖離を重点的に見てください。

$(Get-Content $TaskFile -Raw -Encoding UTF8)
"@

# windows.sandbox の既定値 "elevated" だとこの環境では CreateProcessWithLogonW が失敗しコマンド実行できないため、
# ~/.codex/config.toml は変更せず、実行時オーバーライドで "unelevated" を指定する。
$codexArgs = @("exec", "-m", $Model, "-s", "read-only", "--ephemeral", "-c", "windows.sandbox=unelevated", "-o", $Out)

Write-Host "Codex に最終レビューを依頼します: $TaskFile (range: $Range, log: $logFile)"
# プロンプトはコマンドライン引数ではなく標準入力経由で渡す(codex exec は PROMPT 引数が無いか "-" のとき stdin から読む仕様)。
# PowerShell 5.1 の native exe への引数渡しは文字列中の二重引用符を正しくエスケープできず、`"` を含む長いプロンプト
# (タスクファイルの作業ログに `git commit -m "..."` 等が含まれる)が複数引数に分割されて失敗するため。
# stdin パイプは既定で $OutputEncoding (Windows PowerShell 5.1 では ASCII) が使われ日本語が化けるため、
# UTF-8 (BOM無し) に明示的に切り替える。パイプ経由で渡すことで、従来の「空文字列パイプで EOF を与える」ハックも不要になる。
$priorOutputEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
    $prompt | & codex @codexArgs | Tee-Object -FilePath $logFile
    $exitCode = $LASTEXITCODE
}
finally {
    $OutputEncoding = $priorOutputEncoding
}

if ($exitCode -ne 0) {
    Write-Error "Codex の実行が失敗しました (exit $exitCode)"
    exit $exitCode
}

if (-not (Test-Path $Out) -or (Get-Item $Out).Length -eq 0) {
    Write-Error "レビューレポートが生成されませんでした(空またはファイルなし): $Out"
    exit 1
}

Write-Host $Out
exit 0
