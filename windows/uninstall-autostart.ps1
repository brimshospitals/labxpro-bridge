# Stop LabXpro Bridge starting with Windows. Run as Administrator.
$name = "LabXpro Bridge"
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "LabXpro Bridge no longer starts with Windows." -ForegroundColor Yellow
Read-Host "Press Enter to close"
