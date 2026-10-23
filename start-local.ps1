[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4173 }),
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$serverPath = [IO.Path]::GetFullPath((Join-Path $projectDirectory 'server.mjs'))
$runtimeDirectory = Join-Path $projectDirectory '.local'
$baseUrl = "http://localhost:$Port"
$healthUrl = "http://127.0.0.1:$Port/health"
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($serverPath.ToLowerInvariant()))
    $expectedInstance = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant().Substring(0, 20)
} finally { $hasher.Dispose() }

function Get-AppHealth {
    try { return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -ErrorAction Stop }
    catch { return $null }
}
function Test-AppHealth($Health) {
    return $null -ne $Health -and $Health.app -eq 'red-room-xr' -and $Health.instance -eq $expectedInstance
}
function Open-App {
    Write-Host "Red Room XR is ready: $baseUrl"
    if (-not $NoBrowser) { Start-Process -FilePath $baseUrl }
}

try {
    $health = Get-AppHealth
    if (Test-AppHealth $health) {
        Open-App
        exit 0
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw 'Node.js was not found. Install Node.js LTS from https://nodejs.org/, then reopen this launcher. No npm install is needed.'
    }
    # Probe availability without terminating or reusing unrelated services.
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $probe.Start() }
    catch {
        $health = Get-AppHealth
        if (Test-AppHealth $health) { Open-App; exit 0 }
        $suggestedPort = if ($Port -eq 65535) { 4173 } else { $Port + 1 }
        throw "Port $Port is used by another service. Leave it running and use: .\start-local.ps1 -Port $suggestedPort"
    } finally { $probe.Stop() }
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $outputLog = Join-Path $runtimeDirectory "server-$Port.log"
    $errorLog = Join-Path $runtimeDirectory "server-$Port.error.log"
    $arguments = '"' + $serverPath + '" --port ' + $Port
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList $arguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        $health = Get-AppHealth
        if (Test-AppHealth $health) {
            Open-App
            exit 0
        }
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
    }
    $detail = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { 'No server error log is available.' }
    throw "The local server did not become ready. $detail"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
