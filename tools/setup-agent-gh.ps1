#Requires -Version 7.0
<#
.SYNOPSIS
  Create the agent's isolated GitHub CLI configuration for dsh-superagent.

.DESCRIPTION
  Writes `<StateDir>\gh-agent\hosts.yml` from an account already signed in to `gh`, so the
  plugin can act as that account through GH_CONFIG_DIR without touching the operator's login.
  The file is restricted to the current Windows user. The token is never printed.

  Run this as the operator, after the agent account has signed in to `gh` at least once
  (`gh auth login`, or `gh auth switch --user <agent>`).

.PARAMETER AgentUser
  GitHub login of the agent account.

.PARAMETER StateDir
  dsh-superagent state directory (the plugin configuration's stateDir).

.EXAMPLE
  ./tools/setup-agent-gh.ps1 -AgentUser acme-agent -StateDir "$env:USERPROFILE\.dsh\state\superagent"
#>
param(
  [Parameter(Mandatory = $true)][string]$AgentUser,
  [Parameter(Mandatory = $true)][string]$StateDir
)

$ErrorActionPreference = 'Stop'
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { throw 'GitHub CLI (gh) not found on PATH.' }

$configDir = Join-Path $StateDir 'gh-agent'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

# --- read the agent token without printing it -------------------------------------------
$token = $null
try { $token = (& $gh auth token --user $AgentUser 2>$null) }
catch { $token = $null }
if (-not $token) {
  # Older gh: switch the active account for a moment, read, switch back to the previous one.
  $previous = (& $gh api user --jq .login 2>$null)
  & $gh auth switch --user $AgentUser | Out-Null
  try { $token = (& $gh auth token) }
  finally { if ($previous) { & $gh auth switch --user $previous | Out-Null } }
}
$token = "$token".Trim()
if (-not $token) { throw "Could not read a token for $AgentUser. Sign that account in to gh first." }

# --- write hosts.yml (insecure storage: the token lives in this isolated file) -----------
$hosts = Join-Path $configDir 'hosts.yml'
$content = @(
  'github.com:',
  "    user: $AgentUser",
  "    oauth_token: $token",
  '    git_protocol: https'
) -join "`n"
[System.IO.File]::WriteAllText($hosts, $content + "`n")
$token = $null

# Restrict the file to the current user; ignore failures on non-NTFS or restricted shells.
& icacls $hosts /inheritance:r /grant:r "$($env:USERNAME):(R,W)" *> $null
Write-Host "Wrote $hosts (restricted to $env:USERNAME)."

# --- verify ------------------------------------------------------------------------------
$env:GH_CONFIG_DIR = $configDir
try {
  $who = (& $gh api user --jq .login)
  if ($who -ne $AgentUser) { throw "Verification failed: GH_CONFIG_DIR resolves to $who, expected $AgentUser." }
  Write-Host "Verified: GH_CONFIG_DIR=$configDir acts as $who."
}
finally { Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue }

Write-Host @"

Next: point the GitHub Source's agent CLI at the real gh executable, for example:
  (Get-Command gh).Source
and set `observeIssues` / `observeComments` (or add the `notifications` scope to the agent token).
The plugin passes GH_CONFIG_DIR to its own CLI calls and worker shells on Windows.
"@
