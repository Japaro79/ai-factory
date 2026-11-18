<#
  Registers (or removes) the Windows Task Scheduler job that polls the factory.
    .\scripts\schedule.ps1                 # every 15 minutes
    .\scripts\schedule.ps1 -Minutes 30
    .\scripts\schedule.ps1 -Remove
  The task runs as the current user, only while logged on, so it uses your own gh and Claude sessions.
#>
param([int]$Minutes = 15, [switch]$Remove)

$name = "AIFactory\Poll"
if ($Remove) {
  schtasks /Delete /TN $name /F
  exit $LASTEXITCODE
}

$launcher = Join-Path $PSScriptRoot "poll-hidden.vbs"
schtasks /Create /TN $name /SC MINUTE /MO $Minutes /TR "wscript.exe `"$launcher`"" /F
exit $LASTEXITCODE
