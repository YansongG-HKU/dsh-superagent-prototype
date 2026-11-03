#Requires -Version 7.0
<#
.SYNOPSIS
  Build this bundle and add its machine configuration to a DeepSeek Harness profile.

.DESCRIPTION
  Builds `lib/` with the repository's pnpm toolchain and appends the `dsh-superagent` entry
  (with the required `stateDir`) to the profile's cordis.patch.yml. It does not install the
  bundle into the profile: the Host's plugin manager owns that step (see the printed hint).

.PARAMETER Profile
  DSH profile that will load the bundle. The Electron desktop app uses `desktop`.

.PARAMETER StateDir
  Absolute directory for the database, lock, worker shims, agent git configuration and
  ticket directories. Keep it outside the repository.

.PARAMETER DshHome
  DSH home directory. Defaults to %USERPROFILE%\.dsh.

.PARAMETER SkipBuild
  Skip `pnpm install` and `pnpm build` (when `lib/` is already current).

.EXAMPLE
  ./tools/install.ps1 -Profile desktop -StateDir "$env:USERPROFILE\.dsh\state\superagent"
#>
param(
  [string]$Profile = 'desktop',
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent'),
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path $profileDir)) {
  throw "DSH profile `"$Profile`" not found at $profileDir. Create it first (for the Web template: dsh $Profile --from-default-profile web)."
}
if (-not [System.IO.Path]::IsPathRooted($StateDir)) { throw "StateDir must be an absolute path." }

# --- locate pnpm -------------------------------------------------------------------------
$pnpm = $null
$candidate = Get-Command pnpm -ErrorAction SilentlyContinue
if ($candidate) { $pnpm = $candidate.Source }
else {
  # Fall back to the pnpm bundled with the DSH Desktop runtime.
  $bundled = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  if (Test-Path $bundled) { $pnpm = $bundled; $pnpmIsScript = $true }
}
if (-not $pnpm) { throw 'pnpm not found. Install pnpm (https://pnpm.io/installation) or run this from a machine with the DSH Desktop runtime.' }

function Invoke-Pnpm([string[]]$Arguments) {
  if ($pnpmIsScript) {
    $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
    & $node $pnpm @Arguments
  }
  else { & $pnpm @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not $SkipBuild) {
  Write-Host "Building $root ..."
  Push-Location $root
  try {
    Invoke-Pnpm @('install')
    Invoke-Pnpm @('build')
  }
  finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $root 'lib\index.js'))) { throw "lib\index.js is missing; run without -SkipBuild." }

# --- machine configuration ---------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StateDir 'gh-agent') | Out-Null
$escaped = $StateDir.Replace("'", "''")
$entry = @(
  '# --- dsh-superagent (added by tools/install.ps1) ---',
  '- id: dsh-superagent',
  '  config:',
  "    stateDir: '$escaped'"
) -join "`n"

$patch = Get-Content $patchFile -Raw -ErrorAction SilentlyContinue
if ($null -eq $patch) { $patch = "[]`n" }
if ($patch -match '(?m)^\s*-\s*id:\s*dsh-superagent\s*$') {
  Write-Host "cordis.patch.yml already has a dsh-superagent entry; leaving it untouched."
}
else {
  if ($patch.Trim() -eq '[]') { $patch = '' }
  Add-Content -Path $patchFile -Value ("`n" + $entry + "`n") -NoNewline
  Write-Host "Added the dsh-superagent stateDir entry to $patchFile"
}

# --- next steps --------------------------------------------------------------------------
Write-Host @"

Bundle built. Remaining steps:

1) Install the bundle into the `"$Profile`" profile.
   Desktop (Electron-managed) profile: ask your DSH agent to install it, for example:

     Install the bundle at "$root" into the current profile with plugin_manager,
     then open the Superagent page.

   A custom profile can be installed from a shell with dsh on PATH:

     dsh plugin --profile $Profile add "link:$root"

2) Create the agent's isolated gh configuration (once):

     ./tools/setup-agent-gh.ps1 -AgentUser <agent-github-login> -StateDir "$StateDir"

3) Open the Superagent panel, or run:

     ./tools/configure.mjs -BaseUrl http://127.0.0.1:54746 -Repo owner/name -Cli C:\path\to\gh.exe -AgentLogin <agent> -OperatorLogin <you> -Clone C:\path\to\clone

   then check:

     ./tools/status.ps1 -Url http://127.0.0.1:54746
"@
