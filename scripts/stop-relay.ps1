$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $projectRoot '.agent-link\runtime\relay.pid'
$relayScript = Join-Path $projectRoot 'src\relay-server.js'

if (-not (Test-Path $pidFile)) {
    Write-Output 'AgentLink relay is not running.'
    exit 0
}

$relayPid = [int](Get-Content -Raw $pidFile)
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $relayPid" -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidFile
    Write-Output 'Stale relay PID removed.'
    exit 0
}

if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike "*$relayScript*") {
    throw "Refusing to stop PID $relayPid because it is not this AgentLink relay."
}

Stop-Process -Id $relayPid
Remove-Item -LiteralPath $pidFile
Write-Output "AgentLink relay stopped (PID $relayPid)."
