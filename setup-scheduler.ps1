# Setup Windows Task Scheduler for CEU Tracker
# Run this script as Administrator

$taskName = "CEU-Tracker-Daily"
$workingDir = "C:\Users\danie\OneDrive\Desktop\Cursor Projects\CEU Tracker\CEU-Tracker"

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Create the action
$action = New-ScheduledTaskAction -Execute "node" -Argument "index.js" -WorkingDirectory $workingDir

# Create the trigger (daily at 8:00 AM)
$trigger = New-ScheduledTaskTrigger -Daily -At 8:00AM

# Create settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Register the task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Daily CEU scraping and dashboard update" -RunLevel Highest

Write-Host "Scheduled task '$taskName' created successfully!" -ForegroundColor Green
Write-Host "The scraper will run daily at 8:00 AM" -ForegroundColor Cyan
Write-Host ""
Write-Host "To modify the schedule, open Task Scheduler and find '$taskName'" -ForegroundColor Yellow
