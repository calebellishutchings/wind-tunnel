param([switch]$Dev)
$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $AppRoot

# The packaged app needs no Node.js installation.
$PackagedApp = Join-Path $AppRoot 'release\win-unpacked\ENS Wind Tunnel.exe'
if ((-not $Dev) -and (Test-Path -LiteralPath $PackagedApp)) {
    & $PackagedApp
    exit 0
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$NodeBinary = if ($NodeCommand) { $NodeCommand.Source } else {
    Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $NodeBinary)) {
    throw 'Install Node.js 24 LTS, then follow wind-tunnel-app/README.md.'
}
$PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$BundledPnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.cjs'
$CorepackCommand = Get-Command corepack.cmd -ErrorAction SilentlyContinue

function Invoke-Pnpm([string[]]$Arguments) {
    if ($PnpmCommand) { & $PnpmCommand.Source @Arguments }
    elseif (Test-Path -LiteralPath $BundledPnpm) { & $NodeBinary $BundledPnpm @Arguments }
    elseif ($CorepackCommand) { & $CorepackCommand.Source pnpm @Arguments }
    else { throw 'Install pnpm 11.25.0, then follow wind-tunnel-app/README.md.' }
    if ($LASTEXITCODE -ne 0) { throw "pnpm failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules'))) {
    throw 'Dependencies are missing. Run pnpm install --frozen-lockfile in wind-tunnel-app first.'
}
if ($Dev) { Invoke-Pnpm @('dev') }
else {
    if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'out\main\index.js'))) { Invoke-Pnpm @('build') }
    & $NodeBinary (Join-Path $AppRoot 'node_modules\electron\cli.js') $AppRoot
    if ($LASTEXITCODE -ne 0) { throw "Electron failed with exit code $LASTEXITCODE" }
}
