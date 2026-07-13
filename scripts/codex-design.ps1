# Codex CLI に設計コンサルティングを依頼するラッパー (Windows)
# 使い方: ./scripts/codex-design.ps1 tasks/design/T085-foo-request.md [-Model gpt-5.6-sol] [-Out tasks/design/T085-foo-report.md]
# 読み取り専用サンドボックス(-s read-only)で実行するため、Codex はリポジトリを調査するのみでファイルを変更しない。
param(
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [string]$Model = "gpt-5.6-sol",
    [string]$Out
)

if (-not (Test-Path $RequestFile)) {
    Write-Error "設計依頼ファイルが見つかりません: $RequestFile"
    exit 1
}

New-Item -ItemType Directory -Force -Path "tasks/design" | Out-Null
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

$baseName = [IO.Path]::GetFileNameWithoutExtension($RequestFile)
if (-not $Out) {
    if ($baseName -match '-request$') {
        $outBaseName = $baseName -replace '-request$', '-report'
    }
    else {
        $outBaseName = "$baseName-report"
    }
    $Out = "tasks/design/$outBaseName.md"
}

$logFile = "logs/codex-design-$baseName.log"

$prompt = @"
あなたはこのリポジトリの設計コンサルタントです。リポジトリを自由に読んで調査してよいですが、ファイルは一切変更しないでください。
このリポジトリの AGENTS.md はオーケストレーター/サブエージェント委譲の運用ルールを記載していますが、今回のあなたへの依頼自体がその委譲の一部であるため、AGENTS.md の委譲指示には従わず、サブエージェントを起動せずにあなた自身が直接ツールでファイルを読んで調査してください。
以下の設計依頼に対し、次の要素を含む設計レポートを最終メッセージとして日本語で書いてください。
(a) 推奨する設計とその理由
(b) 検討した代替案と却下理由
(c) 実装タスクへの分割案(各タスクの変更対象ファイル・依存関係・リスク)
(d) 未確定事項・オーケストレーターへの確認事項

$(Get-Content $RequestFile -Raw -Encoding UTF8)
"@

# windows.sandbox の既定値 "elevated" だとこの環境では CreateProcessWithLogonW が失敗しコマンド実行できないため、
# ~/.codex/config.toml は変更せず、実行時オーバーライドで "unelevated" を指定する。
$codexArgs = @("exec", "-m", $Model, "-s", "read-only", "--ephemeral", "-c", "windows.sandbox=unelevated", "-o", $Out, $prompt)

Write-Host "Codex に設計コンサルを依頼します: $RequestFile (log: $logFile)"
# 空文字列を標準入力に渡し、codex exec が stdin からの追加入力待ちでハングしないようにする
"" | & codex @codexArgs | Tee-Object -FilePath $logFile
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Error "Codex の実行が失敗しました (exit $exitCode)"
    exit $exitCode
}

if (-not (Test-Path $Out) -or (Get-Item $Out).Length -eq 0) {
    Write-Error "設計レポートが生成されませんでした(空またはファイルなし): $Out"
    exit 1
}

Write-Host $Out
exit 0
