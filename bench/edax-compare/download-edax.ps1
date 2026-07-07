# T022: Edax (https://github.com/abulmo/edax-reversi) の公式リリースバイナリを
# ダウンロード・展開するスクリプト。
#
# 取得元: https://github.com/abulmo/edax-reversi/releases/tag/v4.6
# アセット: edax-4.6-MS-windows-x86.zip (Windows x86/x64向けビルド一式)
#
# Edaxのバイナリ・付属データ(data/eval.dat 等)はライセンス上の再配布可否が
# 未確認のため、本リポジトリにはコミットしない(.gitignore対象)。
# このスクリプトを実行するたびに、公式リリースから直接取得し直す。
#
# 実行方法(このディレクトリで):
#   powershell -File .\download-edax.ps1
#
# 実行後、.\edax-extract\wEdax-x86-64.exe 等が使えるようになる
# (AVX2非対応CPU向けの .\edax-extract\wEdax-x86-64-v2.exe / -v3.exe もある)。

$ErrorActionPreference = "Stop"

$version = "4.6"
$url = "https://github.com/abulmo/edax-reversi/releases/download/v$version/edax-$version-MS-windows-x86.zip"
$zipPath = Join-Path $PSScriptRoot "edax-$version-MS-windows-x86.zip"
$destDir = Join-Path $PSScriptRoot "edax-extract"

Write-Host "Downloading Edax v$version from $url ..."
Invoke-WebRequest -Uri $url -OutFile $zipPath

Write-Host "Extracting to $destDir ..."
Expand-Archive -Path $zipPath -DestinationPath $destDir -Force

Write-Host "Done. Edax executables:"
Get-ChildItem -Path $destDir -Filter "*.exe" | ForEach-Object { Write-Host "  $($_.FullName)" }
