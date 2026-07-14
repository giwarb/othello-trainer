# Codex CLI にタスク仕様ファイルを渡して非対話実行するラッパー (Windows)
# 使い方: ./scripts/codex-task.ps1 tasks/T085-foo.md [-Model gpt-5.6-sol]
#   - 難しい実装(エンジン/アルゴリズム/複数モジュール横断/redo後の立て直し)は -Model gpt-5.6-sol を指定する(委譲方法B'、2026-07-14 構成見直し)
#   - 独立性が高い軽いタスクは -Model 省略(Codex 既定モデル)でよい
# workspace-write サンドボックス(--full-auto)で実行するため、Codex はリポジトリを変更・コミットできる。
param(
    [Parameter(Mandatory = $true)][string]$TaskFile,
    [string]$Model
)

if (-not (Test-Path $TaskFile)) {
    Write-Error "タスクファイルが見つかりません: $TaskFile"
    exit 1
}
if ($TaskFile -match '^-') {
    Write-Error "タスクファイルパスが '-' で始まっています(オプションの誤渡しの可能性): $TaskFile"
    exit 1
}

$taskName = [IO.Path]::GetFileNameWithoutExtension($TaskFile)
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
$logFile = "logs/codex-$taskName.log"

$prompt = @"
あなたはこのリポジトリの実装ワーカーです。リポジトリ直下の AGENTS.md(ワーカー向けガイド)を読み、その規律に従ってください。サブエージェントへの委譲はせず、あなた自身が直接実装してください。

以下のタスク仕様に従って作業してください。
- 「変更対象」「要件」「やらないこと(スコープ外)」を厳守する。仕様外のリファクタリングや「ついでの改善」はしない。
- 完了前に「受け入れ基準」のコマンドを実際に実行して確認する。
- コミットはタスクの変更対象ファイルのみをパス明示で git add する(git add . / -A は禁止)。tasks/ 配下・CLAUDE.md・AGENTS.md はコミットしない。
- 完了後、タスクファイル ($TaskFile) 末尾の「作業ログ」に日時・実施内容・実行コマンドと結果・コミットハッシュを追記する(この追記はコミットしない)。
- 仕様が曖昧な場合は推測で進めず、曖昧な点と選択肢を最終メッセージに明記して停止する。

$(Get-Content $TaskFile -Raw -Encoding UTF8)
"@

# windows.sandbox の既定値 "elevated" だとこの環境では CreateProcessWithLogonW が失敗するため "unelevated" を指定(T081 と同じ)。
$codexArgs = @("exec", "--full-auto", "--ephemeral", "-c", "windows.sandbox=unelevated")
if ($Model) { $codexArgs += @("-m", $Model) }

Write-Host "Codex にタスクを委譲します: $TaskFile (model: $(if ($Model) { $Model } else { '(既定)' }), log: $logFile)"
# プロンプトは引数ではなく標準入力で渡す(PS5.1 の引数渡しは `"` を含む長文で分割される。T081 の教訓)。
# stdin パイプの既定エンコーディング(ASCII)では日本語が化けるため UTF-8(BOM無し)へ明示切替。
$priorOutputEncoding = $OutputEncoding
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
    $prompt | & codex @codexArgs | Tee-Object -FilePath $logFile
    $exitCode = $LASTEXITCODE
}
finally {
    $OutputEncoding = $priorOutputEncoding
}

exit $exitCode
