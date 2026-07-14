# Codex CLI 呼び出しの共通ヘルパー(codex-task.ps1 / codex-design.ps1 / codex-review.ps1 から dot-source して使う)
#
# 背景(T091): 旧実装は `$prompt | & codex @codexArgs | Tee-Object -FilePath $logFile` だったため、
# - PowerShell のパイプラインは既定で stdout オブジェクトしか流さず、codex exec が進捗を書き出す stderr が
#   まったく捕捉されていなかった(完了時の最終メッセージ数KBのみがログに残る)。
# - ネイティブコマンドへの `2>&1` は PowerShell 5.1 では stderr 行を ErrorRecord にラップし `$?` を汚す。
# ここでは .NET の System.Diagnostics.Process を直接使い、OutputDataReceived/ErrorDataReceived イベントで
# 行が届くたびに逐次 $LogFile へ UTF-8 で追記する(完了時の一括書き出しを避ける)。

# Windows のネイティブ引数文字列を組み立てる(ProcessStartInfo.ArgumentList は .NET Framework 4.x に存在しないため)。
function ConvertTo-ProcessArgumentString {
    param([string[]]$ArgumentList)
    $parts = foreach ($a in $ArgumentList) {
        if ($a -match '[\s"]') {
            '"' + ($a -replace '"', '\"') + '"'
        }
        else {
            $a
        }
    }
    return ($parts -join ' ')
}

# codex を起動し、stdin にプロンプトを渡しつつ stdout/stderr を逐次 $LogFile に UTF-8(BOM無し)で書き込む。
# 戻り値: codex プロセスの終了コード(呼び出し側で `exit $exitCode` すること)。
function Invoke-CodexWithLiveLog {
    param(
        [Parameter(Mandatory = $true)][string[]]$CodexArgs,
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    $codexCmd = Get-Command codex -CommandType Application -ErrorAction Stop
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false

    if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
    $writer = New-Object System.IO.StreamWriter($LogFile, $false, $utf8NoBom)
    $writer.AutoFlush = $true

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $codexCmd.Source
    $psi.Arguments = ConvertTo-ProcessArgumentString -ArgumentList $CodexArgs
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $utf8NoBom
    $psi.StandardErrorEncoding = $utf8NoBom
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    # -Action スクリプトブロックは別ランスペースで動くため、$writer をロックして排他書き込みする。
    $outputHandler = {
        if ($null -ne $EventArgs.Data) {
            $w = $Event.MessageData
            [System.Threading.Monitor]::Enter($w)
            try {
                $w.WriteLine($EventArgs.Data)
            }
            finally {
                [System.Threading.Monitor]::Exit($w)
            }
        }
    }

    $stdoutSub = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action $outputHandler -MessageData $writer
    $stderrSub = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action $outputHandler -MessageData $writer

    try {
        $process.Start() | Out-Null
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()

        # プロンプトは引数ではなく標準入力で UTF-8(BOM無し)のバイト列として直接渡す
        # (StreamWriter の既定エンコーディングは環境依存のため、BaseStream に直接書き込んで確実に UTF-8 にする)。
        $bytes = $utf8NoBom.GetBytes($Prompt)
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()

        # 生の WaitForExit() は呼び出し元のランスペースをブロッキング占有し続け、
        # Register-ObjectEvent の -Action(同じランスペースを使って実行される)がプロセス終了まで
        # 一切ディスパッチされない(検証済み: ログが逐次書かれず完了時に一括で書かれてしまう)。
        # 短い Start-Sleep を挟んでランスペースを都度解放するポーリングループに置き換える。
        while (-not $process.HasExited) {
            Start-Sleep -Milliseconds 200
        }
        $process.WaitForExit()
        # 非同期イベントの取りこぼし防止(プロセス終了直後にまだ届いていない末尾行がある場合があるため少し待つ)。
        Start-Sleep -Milliseconds 300

        return $process.ExitCode
    }
    finally {
        Unregister-Event -SourceIdentifier $stdoutSub.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $stderrSub.Name -ErrorAction SilentlyContinue
        Remove-Job -Name $stdoutSub.Name -Force -ErrorAction SilentlyContinue
        Remove-Job -Name $stderrSub.Name -Force -ErrorAction SilentlyContinue
        $writer.Flush()
        $writer.Close()
        $process.Dispose()
    }
}
