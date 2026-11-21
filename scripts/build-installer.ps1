$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $AppRoot
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) { throw 'Building requires Node.js 24 LTS on this development computer. Destination computers need only the finished installer.' }
& $NodeCommand.Source (Join-Path $PSScriptRoot 'build-installer.cjs')
if ($LASTEXITCODE -ne 0) { throw "Installer build failed with exit code $LASTEXITCODE." }
