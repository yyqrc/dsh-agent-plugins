#Requires -Version 5.1
<#
.SYNOPSIS
Sync the standalone agent-plugins repo into the DSH checkout and rebuild.

.DESCRIPTION
The standalone repo is the source of truth; the DSH checkout's
packages/extensions/agent-plugins directory is the compile anchor (workspace
deps resolve there). This script mirrors src/tests/docs from this repo into
the DSH dir, then runs tsc, tests, lint, and constraints so a single command
covers the post-edit loop.

.PARAMETER DshRepo
Path to the DeepSeek Harness checkout. Defaults to
%USERPROFILE%\Documents\deepseek-harness.

.PARAMETER SkipVerify
Mirror files only; skip tsc/tests/lint/constraints.
#>
[CmdletBinding()]
param(
    [string]$DshRepo = (Join-Path $env:USERPROFILE 'Documents\deepseek-harness'),
    [switch]$SkipVerify
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Source = $PSScriptRoot
$Target = Join-Path $DshRepo 'packages\extensions\agent-plugins'

if (-not (Test-Path $Target)) {
    throw "DSH 目录不存在: $Target（请确认 DSH 仓库路径）"
}

# 1. Mirror source of truth into the DSH compile anchor.
#    /MIR semantics with explicit file list: only src/tests/docs + manifests.
foreach ($name in @('src', 'tests', 'AGENTS.md', 'INSTALL.md', 'README.md', 'package.json', 'tsconfig.json', 'install.ps1')) {
    $from = Join-Path $Source $name
    $to = Join-Path $Target $name
    if (-not (Test-Path $from)) { continue }
    if ((Get-Item $from) -is [System.IO.DirectoryInfo]) {
        robocopy $from $to /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $name (exit $LASTEXITCODE)" }
    } else {
        Copy-Item $from $to -Force
    }
}
Write-Host "[sync] mirrored standalone repo -> $Target"

if ($SkipVerify) { exit 0 }

# 2. Compile + verify inside the DSH workspace.
$shimDir = "$env:LOCALAPPDATA\corepack-shims"
$env:PATH = "$shimDir;$env:PATH"
Push-Location $DshRepo
try {

Write-Host "[build] tsc --build"
& pnpm exec tsc --build "packages/extensions/agent-plugins/tsconfig.json"
if ($LASTEXITCODE -ne 0) { throw 'tsc failed' }

Write-Host "[build] tsdown (host face)"
& pnpm exec tsdown --env.DSH_BUILD_FACE host
if ($LASTEXITCODE -ne 0) { throw 'tsdown failed' }

Write-Host "[test] vitest"
& pnpm exec vitest run "packages/extensions/agent-plugins/tests"
if ($LASTEXITCODE -ne 0) { throw 'vitest failed' }

Write-Host "[lint] oxlint"
& pnpm exec oxlint "packages/extensions/agent-plugins"
if ($LASTEXITCODE -ne 0) { throw 'oxlint failed' }

Write-Host "[gate] constraints"
& pnpm run constraints
if ($LASTEXITCODE -ne 0) { throw 'constraints failed' }
} finally {
    Pop-Location
}

# 3. Copy the fresh lib back into the standalone repo (runtime reads it there
#    through the profile junction chain).
Copy-Item "$Target\lib" (Join-Path $Source 'lib') -Recurse -Force
Write-Host "[sync] copied rebuilt lib -> standalone repo"

Write-Host ""
Write-Host "Done. Next: restart DSH, verify skill catalog, then commit+push the standalone repo."
