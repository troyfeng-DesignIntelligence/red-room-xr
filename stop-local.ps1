[CmdletBinding()]
param([ValidateRange(1, 65535)][int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4173 }))
$ErrorActionPreference = 'Stop'
$serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.mjs'))
$statePath = Join-Path $PSScriptRoot ".local\server-$Port.json"
try {
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Host "There is no recorded Red Room XR server on port $Port."
        exit 0
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.app -ne 'red-room-xr' -or $state.serverPath -ne $serverPath -or $state.port -ne $Port) {
        throw 'The local status file does not match this project. No process was stopped.'
    }
    $serverProcessId = [int]$state.pid
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
    if (-not $processInfo) {
        Remove-Item -LiteralPath $statePath
        Write-Host 'The local server has already stopped.'
        exit 0
    }
    $escapedPath = [regex]::Escape($serverPath)
    $validCommand = $processInfo.CommandLine -match ('(?:^|\s)(?:"' + $escapedPath + '"|' + $escapedPath + ')(?=\s|$)')
    $recordedStart = [DateTimeOffset]::Parse($state.startedAt)
    $processStart = [DateTimeOffset]$processInfo.CreationDate
    $matchesStart = [Math]::Abs(($recordedStart - $processStart).TotalSeconds) -lt 30
    if ($processInfo.Name -ne 'node.exe' -or -not $validCommand -or -not $matchesStart) {
        throw 'The recorded PID belongs to another process. No process was stopped.'
    }
    Stop-Process -Id $serverProcessId -ErrorAction Stop
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    Write-Host "Red Room XR on port $Port has stopped."
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
