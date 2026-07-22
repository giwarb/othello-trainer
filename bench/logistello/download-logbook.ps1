# T192: Logistello book (Michael Buro) の WTHOR形式(.wtb)スケルトンを
# ダウンロード・gzip展開・sha256表示するスクリプト。
#
# 取得元: https://skatgame.net/mburo/log.html
# アセット: logbook.wtb.gz (自己対戦棋譜、約3.7万ライン、全ライン24空きまで
#           WLD検証済み。ページ記載: "All ~37K lines are at least 24-ply
#           WLD correct.")
# ライセンス: GPL (同ページの一次配布元記載どおり)
#
# 本リポジトリの一貫方針(生データ・巨大生成物はコミットしない)に従い、
# ダウンロード・展開したファイルは .gitignore 対象(bench/logistello/data/)。
# このスクリプトを実行するたびに公式サイトから直接取得し直す(再実行安全)。
#
# 実行方法(このディレクトリで):
#   powershell -File .\download-logbook.ps1

$ErrorActionPreference = "Stop"

$url = "https://skatgame.net/mburo/logbook.wtb.gz"
$destDir = Join-Path $PSScriptRoot "data"
$gzPath = Join-Path $destDir "logbook.wtb.gz"
$wtbPath = Join-Path $destDir "logbook.wtb"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

Write-Host "Downloading Logistello book from $url ..."
Invoke-WebRequest -Uri $url -OutFile $gzPath

Write-Host "Decompressing to $wtbPath ..."
$inStream = [System.IO.File]::OpenRead($gzPath)
try {
    $gzStream = New-Object System.IO.Compression.GzipStream($inStream, [System.IO.Compression.CompressionMode]::Decompress)
    try {
        $outStream = [System.IO.File]::Create($wtbPath)
        try {
            $gzStream.CopyTo($outStream)
        } finally {
            $outStream.Close()
        }
    } finally {
        $gzStream.Close()
    }
} finally {
    $inStream.Close()
}

Write-Host "Done. sha256 checksums:"
Get-FileHash $gzPath -Algorithm SHA256 | ForEach-Object { Write-Host "  $($_.Path): $($_.Hash)" }
Get-FileHash $wtbPath -Algorithm SHA256 | ForEach-Object { Write-Host "  $($_.Path): $($_.Hash)" }
Write-Host "logbook.wtb size: $((Get-Item $wtbPath).Length) bytes"
