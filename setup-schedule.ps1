# setup-schedule.ps1 — Register CE Broker Tracker as a Windows Scheduled Task
# Run once (as Administrator) to set up weekly Monday 7am scraping.
#
# Usage:
#   Right-click PowerShell → "Run as Administrator"
#   cd "C:\Users\danie\OneDrive\Desktop\Cursor Projects\CEU Broker Tracker"
#   .\setup-schedule.ps1

$TaskName   = "CEU Broker Tracker - Weekly Scrape"
$BatFile    = "$PSScriptRoot\run.bat"
$WorkingDir = $PSScriptRoot

Write-Host ""
Write-Host "=== CE Broker Tracker — Task Scheduler Setup ===" -ForegroundColor Cyan
Write-Host "  Task name : $TaskName"
Write-Host "  Script    : $BatFile"
Write-Host "  Schedule  : Every Monday at 7:00 AM"
Write-Host ""

# Action: run cmd.exe /c "run.bat" so the console window appears briefly
$action = New-ScheduledTaskAction `
  -Execute  "cmd.exe" `
  -Argument "/c `"$BatFile`"" `
  -WorkingDirectory $WorkingDir

# Trigger: weekly, every Monday at 07:00
$trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -WeeksInterval 1 `
  -DaysOfWeek Monday `
  -At "7:00AM"

# Settings: allow up to 2-hour run, start only if network is up, don't wake PC
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit  (New-TimeSpan -Hours 2) `
  -RunOnlyIfNetworkAvailable $true `
  -WakeToRun           $false `
  -StartWhenAvailable  $true

# Register (overwrites any existing task with the same name)
Register-ScheduledTask `
  -TaskName   $TaskName `
  -Action     $action `
  -Trigger    $trigger `
  -Settings   $settings `
  -Description "Automatically scrapes CE Broker every Monday at 7 AM and publishes dashboard to Vercel." `
  -RunLevel   Limited `
  -Force | Out-Null

Write-Host "Task registered successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  Verify  : Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Run now : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Remove  : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
Write-Host "  Log     : Get-Content '$WorkingDir\logs\run.log' -Tail 50"
Write-Host ""
