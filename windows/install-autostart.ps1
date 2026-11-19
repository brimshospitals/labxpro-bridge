# LabXpro Bridge: start with Windows (even before anyone logs in) and restart if it stops.
# Right-click → "Run with PowerShell" as Administrator, from the LabXpro-Bridge folder.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $dir "bridge.config.json"))) {
  Write-Host "bridge.config.json not found. Copy bridge.config.example.json to bridge.config.json and paste your machine keys first." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}
$name = "LabXpro Bridge"
$action = New-ScheduledTaskAction -Execute (Join-Path $dir "node.exe") -Argument "src\main.js bridge.config.json" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "LabXpro Bridge now starts with Windows. Status page: http://localhost:4545" -ForegroundColor Green
Read-Host "Press Enter to close"
