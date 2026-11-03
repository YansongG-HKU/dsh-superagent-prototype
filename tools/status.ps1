#Requires -Version 7.0
<#
.SYNOPSIS
  Print dsh-superagent setup, health and ticket status by reading its management API.

.DESCRIPTION
  Reads the loopback management API of a running dsh-superagent host (the DSH Web server
  hosting the plugin) and prints setup problems, resolved accounts, health entries,
  the last day's flow and the tickets waiting for a person.
  Exit codes follow the prototype's service script: 0 healthy, 2 a component reports an
  error, 3 waiting for setup (1 means the API is unreachable).

.PARAMETER Url
  Web server root hosting dsh-superagent. Defaults to $env:DSH_SUPERAGENT_URL, else
  http://127.0.0.1:54746 (the DSH Desktop app).
#>
param([string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:54746' }))

$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')
$headers = @{ 'x-orchestrator-request' = '1' }

try { $state = Invoke-RestMethod -Uri "$Url/orchestrator/api/state" -Headers $headers -TimeoutSec 8 }
catch {
  Write-Output "dsh-superagent is unreachable at $Url : $($_.Exception.Message)"
  exit 1
}

$problem = $state.setup.problem
$accounts = $state.setup.accounts
Write-Output "stateDir : $($state.setup.machine.stateDir)"
Write-Output "accounts : $(if ($accounts) { "repository $($accounts.repository) / agent @$($accounts.agent)" } else { 'setup not resolved' })"
Write-Output "setup    : $(if ($problem) { "missing: $($problem.detail)" } else { 'ok' })"
Write-Output "paused   : $($state.paused)"
Write-Output "executor : running $($state.load.running) / max $($state.load.maxWorkers), queued $($state.load.queued)"
Write-Output ''
Write-Output 'health:'
foreach ($name in ($state.health.PSObject.Properties.Name | Sort-Object)) {
  $entry = $state.health.$name
  Write-Output ("  {0,-14} {1,-8} {2}" -f $name, $entry.state, $entry.detail)
}

try {
  $overview = Invoke-RestMethod -Uri "$Url/orchestrator/api/overview" -Headers $headers -TimeoutSec 8
  Write-Output ''
  Write-Output "last day: received $($overview.flow.received), assessed $($overview.flow.judged), accepted $($overview.flow.accepted)"
  if (@($overview.person).Count -gt 0) {
    Write-Output 'tickets waiting for a person:'
    foreach ($ticket in $overview.person) { Write-Output ("  {0}  [{1}/{2}]  {3}" -f $ticket.id.Substring(0, 12), $ticket.stage, $ticket.action, $ticket.title) }
  } else { Write-Output 'no ticket waits for a person.' }
  if (@($overview.problems).Count -gt 0) {
    Write-Output 'system problems:'
    foreach ($item in $overview.problems) { Write-Output ("  {0}: {1}" -f $item.name, $item.detail) }
  }
} catch { Write-Output "overview unavailable: $($_.Exception.Message)" }

if ($problem) { exit 3 }
if (@($state.health.PSObject.Properties.Value | Where-Object { $_.state -eq 'error' }).Count -gt 0) { exit 2 }
exit 0
