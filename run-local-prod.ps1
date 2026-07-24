[CmdletBinding()]
param(
    [int]$FrontendPort = 12008,
    [int]$BackendPort = 12009,
    [int]$StartupTimeoutSeconds = 90,
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$environmentFile = Join-Path $repoRoot ".env.local"

$backendDirectory = Join-Path $repoRoot "apps\backend"
$frontendDirectory = Join-Path $repoRoot "apps\frontend"

$backendEntry = Join-Path $backendDirectory "dist\index.js"
$frontendEntry = Join-Path `
    $frontendDirectory `
    "node_modules\next\dist\bin\next"
$frontendBuildId = Join-Path $frontendDirectory ".next\BUILD_ID"
$backendDependencyMarker = Join-Path `
    $backendDirectory `
    "node_modules\express\package.json"
$pnpmModulesMarker = Join-Path $repoRoot "node_modules\.modules.yaml"
$zodTypesEntry = Join-Path $repoRoot "packages\zod-types\dist\index.js"
$trpcEntry = Join-Path $repoRoot "packages\trpc\dist\index.js"

$runtimeDirectory = Join-Path $repoRoot ".runtime"
$runnerDirectory = Join-Path `
    $runtimeDirectory `
    "mcp-runners\default"

$pidFile = Join-Path `
    $runtimeDirectory `
    "local-prod.pids.json"

$backendOutLog = Join-Path `
    $runtimeDirectory `
    "backend.out.log"

$backendErrorLog = Join-Path `
    $runtimeDirectory `
    "backend.err.log"

$frontendOutLog = Join-Path `
    $runtimeDirectory `
    "frontend.out.log"

$frontendErrorLog = Join-Path `
    $runtimeDirectory `
    "frontend.err.log"

function Import-EnvironmentFile {
    param([string]$Path)

    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()

        if (
            $line.Length -eq 0 -or
            $line.StartsWith("#")
        ) {
            continue
        }

        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            continue
        }

        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()

        if (
            $value.Length -ge 2 -and
            (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [Environment]::SetEnvironmentVariable(
            $name,
            $value,
            "Process"
        )
    }
}

function Test-HttpEndpoint {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest `
            -Uri $Url `
            -UseBasicParsing `
            -TimeoutSec 2 `
            -MaximumRedirection 0 `
            -ErrorAction Stop

        return [int]$response.StatusCode -lt 500
    }
    catch {
        if ($null -ne $_.Exception.Response) {
            try {
                return [int]$_.Exception.Response.StatusCode -lt 500
            }
            catch {
            }
        }

        return $false
    }
}

function Show-LogTail {
    param(
        [string]$Title,
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        Write-Host ""
        Write-Host "----- $Title -----"
        Get-Content -LiteralPath $Path -Tail 30
    }
}

function Invoke-Pnpm {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Write-Host ""
    Write-Host $Description
    Write-Host ("> pnpm " + ($Arguments -join " "))

    Push-Location $repoRoot
    try {
        & $script:PnpmExecutable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Description failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "Starting MetaMCP local in PROD mode..."

if (-not (Test-Path -LiteralPath $environmentFile)) {
    throw "Missing environment file: $environmentFile"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    throw "Node.js is not installed or node.exe is not available in PATH."
}
$nodeExecutable = $nodeCommand.Source

# Stop an earlier source-mode instance before modifying build artifacts.
& (Join-Path $repoRoot "stop-local.ps1") `
    -FrontendPort $FrontendPort `
    -BackendPort $BackendPort

$dependencyMarkers = @(
    $pnpmModulesMarker,
    $frontendEntry,
    $backendDependencyMarker
)
$missingDependencies = @(
    $dependencyMarkers |
        Where-Object { -not (Test-Path -LiteralPath $_) }
)

$needsInstall = $missingDependencies.Count -gt 0
$needsZodBuild = $Rebuild -or -not (Test-Path -LiteralPath $zodTypesEntry)
$needsTrpcBuild = $Rebuild -or -not (Test-Path -LiteralPath $trpcEntry)
$needsBackendBuild = $Rebuild -or -not (Test-Path -LiteralPath $backendEntry)
$needsFrontendBuild = $Rebuild -or -not (Test-Path -LiteralPath $frontendBuildId)
$needsPreparation = `
    $needsInstall -or `
    $needsZodBuild -or `
    $needsTrpcBuild -or `
    $needsBackendBuild -or `
    $needsFrontendBuild

if ($needsPreparation) {
    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $pnpmCommand) {
        throw "pnpm.cmd is required to prepare missing production artifacts but is not available in PATH."
    }
    $script:PnpmExecutable = $pnpmCommand.Source

    if ($needsInstall) {
        Write-Host "Missing dependency markers:"
        $missingDependencies | ForEach-Object { Write-Host "  $_" }
        Invoke-Pnpm `
            -Description "Installing workspace dependencies..." `
            -Arguments @(
                "install",
                "--no-frozen-lockfile",
                "--reporter",
                "append-only"
            )

        $stillMissing = @(
            $dependencyMarkers |
                Where-Object { -not (Test-Path -LiteralPath $_) }
        )
        if ($stillMissing.Count -gt 0) {
            throw "pnpm install completed but required dependencies are still missing:`n$($stillMissing -join "`n")"
        }
    }

    if ($needsZodBuild) {
        Invoke-Pnpm `
            -Description "Building @repo/zod-types..." `
            -Arguments @("--filter", "@repo/zod-types", "build")
    }

    if ($needsTrpcBuild) {
        Invoke-Pnpm `
            -Description "Building @repo/trpc..." `
            -Arguments @("--filter", "@repo/trpc", "build")
    }

    if ($needsBackendBuild) {
        Invoke-Pnpm `
            -Description "Building backend production bundle..." `
            -Arguments @("--filter", "backend", "build")
    }

    if ($needsFrontendBuild) {
        if ($Rebuild) {
            Remove-Item `
                -LiteralPath (Join-Path $frontendDirectory ".next") `
                -Recurse `
                -Force `
                -ErrorAction SilentlyContinue
        }

        Invoke-Pnpm `
            -Description "Checking frontend TypeScript..." `
            -Arguments @("--filter", "frontend", "check-types")

        Invoke-Pnpm `
            -Description "Building frontend production bundle..." `
            -Arguments @("--filter", "frontend", "build")
    }
}

$requiredArtifacts = @(
    $zodTypesEntry,
    $trpcEntry,
    $backendEntry,
    $frontendEntry,
    $frontendBuildId
)
$missingArtifacts = @(
    $requiredArtifacts |
        Where-Object { -not (Test-Path -LiteralPath $_) }
)
if ($missingArtifacts.Count -gt 0) {
    throw "Production preparation did not create all required files:`n$($missingArtifacts -join "`n")"
}

New-Item -ItemType Directory `
    -Path $runnerDirectory `
    -Force | Out-Null

Import-EnvironmentFile -Path $environmentFile

$env:NODE_ENV = "production"
$env:BACKEND_HOST = "127.0.0.1"
$env:BACKEND_PORT = [string]$BackendPort
$env:HOSTNAME = "127.0.0.1"
$env:PORT = [string]$FrontendPort
$env:METAMCP_NPX_CWD = $runnerDirectory

foreach (
    $logPath in @(
        $backendOutLog,
        $backendErrorLog,
        $frontendOutLog,
        $frontendErrorLog
    )
) {
    Remove-Item -LiteralPath $logPath `
        -Force `
        -ErrorAction SilentlyContinue
}

$backend = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @("dist/index.js") `
    -WorkingDirectory $backendDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $backendOutLog `
    -RedirectStandardError $backendErrorLog `
    -PassThru

try {
    $frontend = Start-Process `
        -FilePath $nodeExecutable `
        -ArgumentList @(
            $frontendEntry,
            "start",
            "--port",
            [string]$FrontendPort
        ) `
        -WorkingDirectory $frontendDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $frontendOutLog `
        -RedirectStandardError $frontendErrorLog `
        -PassThru
}
catch {
    & "$env:SystemRoot\System32\taskkill.exe" `
        /PID $backend.Id `
        /T `
        /F 2>$null | Out-Null

    throw
}

[pscustomobject]@{
    BackendPid  = $backend.Id
    FrontendPid = $frontend.Id
    StartedAt   = (Get-Date).ToString("o")
} |
    ConvertTo-Json |
    Set-Content `
        -LiteralPath $pidFile `
        -Encoding UTF8

$backendUrl = "http://127.0.0.1:$BackendPort/health"
$frontendUrl = "http://127.0.0.1:$FrontendPort/en"

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$backendReady = $false
$frontendReady = $false

while ((Get-Date) -lt $deadline) {
    if ($backend.HasExited) {
        break
    }

    if ($frontend.HasExited) {
        break
    }

    if (-not $backendReady) {
        $backendReady = Test-HttpEndpoint -Url $backendUrl
    }

    if (-not $frontendReady) {
        $frontendReady = Test-HttpEndpoint -Url $frontendUrl
    }

    if ($backendReady -and $frontendReady) {
        break
    }

    Start-Sleep -Milliseconds 500
}

if (-not $backendReady -or -not $frontendReady) {
    Show-LogTail `
        -Title "Backend stderr" `
        -Path $backendErrorLog

    Show-LogTail `
        -Title "Backend stdout" `
        -Path $backendOutLog

    Show-LogTail `
        -Title "Frontend stderr" `
        -Path $frontendErrorLog

    Show-LogTail `
        -Title "Frontend stdout" `
        -Path $frontendOutLog

    & (Join-Path $repoRoot "stop-local.ps1") `
        -FrontendPort $FrontendPort `
        -BackendPort $BackendPort

    throw "MetaMCP did not become ready within $StartupTimeoutSeconds seconds."
}

Write-Host ""
Write-Host "MetaMCP PROD local is ready."
Write-Host "Backend PID: $($backend.Id)"
Write-Host "Frontend PID: $($frontend.Id)"
Write-Host "Local UI: http://localhost:$FrontendPort"