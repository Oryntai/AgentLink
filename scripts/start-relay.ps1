$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = (Get-Command node -ErrorAction Stop).Source
$runDir = Join-Path $projectRoot '.agent-link\runtime'
$pidFile = Join-Path $runDir 'relay.pid'
$stdoutFile = Join-Path $runDir 'relay.stdout.log'
$stderrFile = Join-Path $runDir 'relay.stderr.log'
$relayScript = Join-Path $projectRoot 'src\relay-server.js'

New-Item -ItemType Directory -Path $runDir -Force | Out-Null

if (Test-Path $pidFile) {
    $existingPid = [int](Get-Content -Raw $pidFile)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like "*$relayScript*") {
        Write-Output "AgentLink relay is already running (PID $existingPid)."
        exit 0
    }
}

$process = Start-Process -FilePath $runtime `
    -ArgumentList @($relayScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id
Start-Sleep -Milliseconds 500

if ($process.HasExited) {
    throw "Relay exited during startup. Inspect $stderrFile"
}

Write-Output "AgentLink relay started (PID $($process.Id))."
Write-Output "Health: http://127.0.0.1:8787/healthz"
Write-Output "Logs: $stdoutFile and $stderrFile"
