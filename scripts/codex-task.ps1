# Codex CLI にタスク仕様ファイルを渡して非対話実行するラッパー (Windows)
# 使い方: ./scripts/codex-task.ps1 tasks/T001-add-login.md [-Model gpt-5-codex]
param(
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [string]$Model
)

if (-not (Test-Path $TaskFile)) {
    Write-Error "タスクファイルが見つかりません: $TaskFile"
    exit 1
}

$taskName = [IO.Path]::GetFileNameWithoutExtension($TaskFile)
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
$logFile = "logs/codex-$taskName.log"

$prompt = @"
以下のタスク仕様に従って作業してください。「やらないこと(スコープ外)」を厳守し、
完了前に「受け入れ基準」のコマンドを実行して確認すること。
完了後、タスクファイル ($TaskFile) 末尾の「作業ログ」に実施内容を追記すること。

$(Get-Content $TaskFile -Raw)
"@

$codexArgs = @("exec", "--full-auto")
if ($Model) { $codexArgs += @("-m", $Model) }
$codexArgs += $prompt

Write-Host "Codex にタスクを委譲します: $TaskFile (log: $logFile)"
& codex @codexArgs 2>&1 | Tee-Object -FilePath $logFile
exit $LASTEXITCODE
