#Requires -Version 7.0
<#
.SYNOPSIS
  Run dsh-superagent in a dedicated DSH profile instead of the Desktop profile.

.DESCRIPTION
  The prototype's documented layout: a separate DSH profile (default `superagent`) and a
  separate process, so the plugin's process-wide environment changes stay out of the profile
  you work in. Requires a `dsh` CLI whose version satisfies engines.dsh and a once-created
  profile (`dsh superagent --from-default-profile web`).

  This is a convenience harness for development; it starts `dsh --profile <Profile>` in the
  background and waits for its Web UI URL. It does not manage logs beyond the two files below.

.PARAMETER Action
  start | stop | restart | url | status

.PARAMETER Profile
  DSH profile name. Default `superagent`.

.PARAMETER Dsh
  Path to the dsh CLI entry (bin.js). Default: `dsh` on PATH.

.PARAMETER OutFile / ErrFile
  Where to redirect the server's stdout/stderr (the Web UI URL with its token is printed on
  stdout by the Web app).
#>
param(
  [Parameter(Position = 0)][ValidateSet('start', 'stop', 'restart', 'url', 'status')][string]$Action = 'status',
  [string]$Profile = 'superagent',
  [string]$Dsh = 'dsh',
  [string]$OutFile = (Join-Path $PSScriptRoot 'dev-server.out.log'),
  [string]$ErrFile = (Join-Path $PSScriptRoot 'dev-server.err.log')
)

$ErrorActionPreference = 'Stop'

function Get-DevProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*--profile $Profile*" -and $_.CommandLine -like '*bin.js*' }
}
function Get-DevUrl {
  if (-not (Test-Path $OutFile)) { return $null }
  $line = Select-String -Path $OutFile -Pattern 'dsh web: (http[^\s]+)' | Select-Object -Last 1
  if ($line) { $line.Matches[0].Groups[1].Value } else { $null }
}
function Stop-Dev {
  $procs = Get-DevProcess
  foreach ($process in $procs) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($procs) { Write-Output "stopped $($procs.ProcessId -join ', ')" } else { Write-Output 'not running' }
  # A force-killed plugin can leave the state directory lock behind.
  Write-Output 'If the plugin reports "Lock file is already being held", delete <stateDir>.lock next to the state directory.'
}
function Start-Dev {
  if (Get-DevProcess) { Write-Output 'already running'; return }
  Remove-Item $OutFile, $ErrFile -ErrorAction SilentlyContinue
  $node = (Get-Command node).Source
  Start-Process -FilePath $node -ArgumentList @($Dsh, '--profile', $Profile, '--no-open') `
    -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if (Get-DevUrl) { break } }
  $url = Get-DevUrl
  if (-not $url) { Write-Output 'failed to start; see logs'; Get-Content $ErrFile -ErrorAction SilentlyContinue | Select-Object -Last 20; exit 1 }
  Write-Output "running: $url"
}

switch ($Action) {
  'start' { Start-Dev }
  'stop' { Stop-Dev }
  'restart' { Stop-Dev; Start-Sleep -Seconds 1; Start-Dev }
  'url' { Write-Output (Get-DevUrl) }
  'status' {
    Write-Output ("pids: " + ((Get-DevProcess | ForEach-Object ProcessId) -join ', '))
    Write-Output ("url: " + (Get-DevUrl))
  }
}
