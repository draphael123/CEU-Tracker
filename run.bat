@echo off
:: CE Broker Tracker — Weekly automated scrape
:: Runs node index.js and appends output to logs\run.log

setlocal
set PROJECT_DIR=%~dp0
cd /d "%PROJECT_DIR%"

if not exist logs mkdir logs

:: Rotate log file if it exceeds ~5 MB (5242880 bytes)
for %%F in (logs\run.log) do (
  if %%~zF GTR 5242880 (
    move /Y logs\run.log logs\run.log.bak >nul 2>&1
  )
)

echo ============================================================ >> logs\run.log
echo  Run started: %DATE% %TIME% >> logs\run.log
echo ============================================================ >> logs\run.log

node index.js >> logs\run.log 2>&1

echo  Run finished: %DATE% %TIME% >> logs\run.log
echo. >> logs\run.log
