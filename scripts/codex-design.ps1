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
リポジトリ直下の AGENTS.md(ワーカー向けガイド)の「設計コンサル/最終レビュー役」の規律に従い、サブエージェントを起動せずにあなた自身が直接ツールでファイルを読んで調査してください。
レポート全文を最終メッセージとしてそのまま出力してください(ファイル保存はこのラッパーが行うため、「保存できなかった」という報告や要約への圧縮は不要です)。
以下の設計依頼に対し、次の要素を含む設計レポートを最終メッセージとして日本語で書いてください。
(a) 推奨する設計とその理由
(b) 検討した代替案と却下理由
(c) 実装タスクへの分割案(各タスクの変更対象ファイル・依存関係・リスク)
(d) 未確定事項・オーケストレーターへの確認事項

$(Get-Content $RequestFile -Raw -Encoding UTF8)
"@

# windows.sandbox の既定値 "elevated" だとこの環境では CreateProcessWithLogonW が失敗しコマンド実行できないため、
# ~/.codex/config.toml は変更せず、実行時オーバーライドで "unelevated" を指定する。
$codexArgs = @("exec", "-m", $Model, "-s", "read-only", "--ephemeral", "-c", "windows.sandbox=unelevated", "-o", $Out)

Write-Host "Codex に設計コンサルを依頼します: $RequestFile (log: $logFile)"
# プロンプトはコマンドライン引数ではなく標準入力経由で渡す(codex exec は PROMPT 引数が無いか "-" のとき stdin から読む仕様)。
# PowerShell 5.1 の native exe への引数渡しは文字列中の二重引用符を正しくエスケープできず、`"` を含む長いプロンプト
# (依頼ファイルにコードブロックや引用符が含まれる場合)が複数引数に分割されて失敗するため。
# codex exec の進捗は stderr に、最終メッセージは stdout に出るため、両方を逐次 $logFile に UTF-8 で書き込む
# 共通ヘルパー(T091)を使う。単純な `| Tee-Object` では stderr が捕捉されない欠陥があった。
. "$PSScriptRoot\_codex-common.ps1"
$exitCode = Invoke-CodexWithLiveLog -CodexArgs $codexArgs -Prompt $prompt -LogFile $logFile

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
