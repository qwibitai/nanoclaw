$projectDir = "C:\Users\jarvi\OpenClawV1\nanoclaw"
$logFile = "$projectDir\logs\nanoclaw.log"

Set-Location $projectDir

while ($true) {
    $proc = Start-Process -FilePath "node" -ArgumentList "dist\index.js" -WorkingDirectory $projectDir -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$projectDir\logs\nanoclaw-error.log"
    Write-Host "NanoClaw started (PID: $($proc.Id))"
    $proc.WaitForExit()
    Write-Host "NanoClaw exited with code $($proc.ExitCode). Restarting in 5s..."
    Start-Sleep -Seconds 5
}
