# start-nanoclaw.ps1 — Start NanoClaw on Windows
$nodePath = 'C:\Program Files\nodejs\node.exe'
$indexJs  = 'C:\Users\kyle\Documents\Projects\Personal\nanoclaw\dist\index.js'
$workDir  = 'C:\Users\kyle\Documents\Projects\Personal\nanoclaw'
$logFile  = 'C:\Users\kyle\Documents\Projects\Personal\nanoclaw\logs\nanoclaw.log'
$errFile  = 'C:\Users\kyle\Documents\Projects\Personal\nanoclaw\logs\nanoclaw.error.log'
$pidFile  = 'C:\Users\kyle\Documents\Projects\Personal\nanoclaw\nanoclaw.pid'

# Stop existing instance if running
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
    Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

# Wait for Docker daemon to be ready (up to 120 seconds)
Write-Host "Waiting for Docker..."
$dockerReady = $false
for ($i = 0; $i -lt 24; $i++) {
  $result = & docker info 2>&1
  if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $dockerReady) {
  Write-Host "Docker did not become ready in time — NanoClaw will start anyway"
}

Write-Host "Starting NanoClaw..."
$proc = Start-Process -FilePath $nodePath -ArgumentList $indexJs -WorkingDirectory $workDir -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errFile -PassThru
$proc.Id | Set-Content $pidFile
Write-Host "NanoClaw started (PID $($proc.Id))"
