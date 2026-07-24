[CmdletBinding()]
param(
    [int]$FrontendPort = 12008,
    [int]$BackendPort = 12009
)

$ErrorActionPreference = "SilentlyContinue"

$repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
$runtimeDirectory = Join-Path $repoRoot ".runtime"
$pidFile = Join-Path $runtimeDirectory "local-prod.pids.json"

function Stop-ProcessTree {
    param([int]$ProcessId)

    if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
        return
    }

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return
    }

    Write-Host "Stopping PID $ProcessId ($($process.ProcessName))..."

    & "$env:SystemRoot\System32\taskkill.exe" `
        /PID $ProcessId `
        /T `
        /F 2>$null | Out-Null
}

Write-Host "Stopping local MetaMCP frontend/backend..."

$processIds = New-Object "System.Collections.Generic.HashSet[int]"

# Process IDs saved by run-local-prod.ps1.
if (Test-Path -LiteralPath $pidFile) {
    try {
        $saved = Get-Content -LiteralPath $pidFile -Raw |
            ConvertFrom-Json

        if ($saved.BackendPid) {
            $null = $processIds.Add([int]$saved.BackendPid)
        }

        if ($saved.FrontendPid) {
            $null = $processIds.Add([int]$saved.FrontendPid)
        }
    }
    catch {
        Write-Warning "Could not read $pidFile."
    }
}

# Processes currently listening on the reserved ports.
foreach ($port in @($FrontendPort, $BackendPort)) {
    $connections = Get-NetTCPConnection `
        -State Listen `
        -LocalPort $port `
        -ErrorAction SilentlyContinue

    foreach ($connection in $connections) {
        if ($connection.OwningProcess -gt 0) {
            $null = $processIds.Add(
                [int]$connection.OwningProcess
            )
        }
    }
}

# Clean old pnpm/cmd/node chains started from this repository.
$repoProcesses = Get-CimInstance Win32_Process |
    Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        $_.CommandLine -like "*$repoRoot*" -and
        (
            $_.CommandLine -match "dist[\\/]+index\.js" -or
            $_.CommandLine -match "next(\.cmd|\.js)?[`" ]+start" -or
            $_.CommandLine -match "--filter[`" ]+backend[`" ]+start" -or
            $_.CommandLine -match "dotenv-cli[\\/]cli\.js"
        )
    }

foreach ($process in $repoProcesses) {
    $null = $processIds.Add([int]$process.ProcessId)
}

foreach ($processId in $processIds) {
    Stop-ProcessTree -ProcessId $processId
}

Start-Sleep -Milliseconds 500

Remove-Item -LiteralPath $pidFile `
    -Force `
    -ErrorAction SilentlyContinue

Write-Host "Local MetaMCP frontend/backend stopped."