#Requires -Version 5.1
<#
.SYNOPSIS
Wire the agent-plugins loader into a local DeepSeek Harness checkout.

.DESCRIPTION
The loader package is a workspace package inside the DeepSeek Harness repo;
this script junctions it into the two resolution points a source-run DSH
reads: the repo's apps/cli/node_modules tree and the user profile's
node_modules tree. It also verifies the profile patch has the loader row and
prints the row when missing (it never edits the patch itself).

.PARAMETER DshRepo
Path to the DeepSeek Harness checkout. Defaults to
C:\Users\shifengzhou\Documents\deepseek-harness.

.PARAMETER CheckOnly
Only report what would be wired, without creating junctions.
#>
[CmdletBinding()]
param(
    [string]$DshRepo = 'C:\Users\shifengzhou\Documents\deepseek-harness',
    [switch]$CheckOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$PluginDir = $PSScriptRoot
$CliLink = Join-Path $DshRepo 'apps\cli\node_modules\@deepseek-ai\dsh-agent-plugins'
$ProfileLink = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-plugins'
$ProfilePatch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'

function Test-LinkTarget([string]$Path, [string]$Target) {
    if (-not (Test-Path $Path)) { return $false }
    $item = Get-Item $Path -Force
    return $item.LinkType -and ($item.Target -eq $Target -or (Resolve-Path $Path -ErrorAction SilentlyContinue).Path -eq (Resolve-Path $Target -ErrorAction SilentlyContinue).Path)
}

Write-Host "=== agent-plugins loader wiring ==="
Write-Host "plugin dir : $PluginDir"
Write-Host "dsh repo   : $DshRepo"
Write-Host ""

# 1. Repo-side junction.
$repoOk = Test-LinkTarget $CliLink $PluginDir
if ($repoOk) {
    Write-Host "[OK] $CliLink already links to the plugin dir."
} elseif ($CheckOnly) {
    Write-Host "[MISSING] would create junction: $CliLink -> $PluginDir"
} else {
    New-Item -ItemType Directory -Path (Split-Path $CliLink) -Force | Out-Null
    if (Test-Path $CliLink) { Remove-Item $CliLink -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Junction -Path $CliLink -Target $PluginDir | Out-Null
    Write-Host "[DONE] junction created: $CliLink -> $PluginDir"
}

# 2. Profile-side junction (points at the repo-side link, mirroring how
#    existing profile packages chain to apps/cli/node_modules).
$profileOk = Test-LinkTarget $ProfileLink $CliLink
if ($profileOk) {
    Write-Host "[OK] $ProfileLink already links to the repo-side link."
} elseif ($CheckOnly) {
    Write-Host "[MISSING] would create junction: $ProfileLink -> $CliLink"
} else {
    New-Item -ItemType Directory -Path (Split-Path $ProfileLink) -Force | Out-Null
    if (Test-Path $ProfileLink) { Remove-Item $ProfileLink -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Junction -Path $ProfileLink -Target $CliLink | Out-Null
    Write-Host "[DONE] junction created: $ProfileLink -> $CliLink"
}

# 3. Profile patch row.
Write-Host ""
if (Test-Path $ProfilePatch) {
    $hasRow = Select-String -Path $ProfilePatch -Pattern "dsh-agent-plugins" -SimpleMatch -Quiet
    if ($hasRow) {
        Write-Host "[OK] profile patch already references @deepseek-ai/dsh-agent-plugins."
    } else {
        Write-Host "[MISSING] profile patch has no loader row. Append to $ProfilePatch :"
        Write-Host ""
        Write-Host "- insert:"
        Write-Host "    - id: agent-plugins"
        Write-Host "      name: '@deepseek-ai/dsh-agent-plugins'"
    }
} else {
    Write-Host "[MISSING] profile patch file not found: $ProfilePatch"
    Write-Host "         Create it with the loader row (see INSTALL.md)."
}

# 4. Build reminder.
Write-Host ""
$libExists = Test-Path (Join-Path $PluginDir 'lib\index.js')
if ($libExists) {
    Write-Host "[OK] lib/index.js exists. If you edit src/, rebuild with:"
} else {
    Write-Host "[WARN] lib/index.js missing. Build before starting DSH:"
}
Write-Host "      cd $DshRepo; pnpm exec tsc --build packages/extensions/agent-plugins/tsconfig.json; pnpm exec tsdown --env.DSH_BUILD_FACE host"

Write-Host ""
Write-Host "Next: restart DSH, then check the session skill catalog for <plugin>-<skill> names."
