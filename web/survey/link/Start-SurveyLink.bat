@echo off
rem Survey Link for the N-Space and J-Space Surveys. Double-click to start; close the window to stop.
rem Each start fetches the latest Survey Link from the Atlas site (only that address, only a file that
rem is Survey Link) and then runs it. Without a connection it runs the copy already in this folder.
title Survey Link
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $u = 'https://idan-armstrong.github.io/eve-assistant/survey/link/SurveyLink.ps1'; $t = Join-Path $env:TEMP 'SurveyLink.download.ps1'; try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $t -TimeoutSec 15; $c = Get-Content -Raw $t; if ($c -match 'Survey Link: the clipboard' -and $c -match '\$Version = ''([0-9.]+)''') { Copy-Item $t '%~dp0SurveyLink.ps1' -Force; Write-Host ('  Survey Link is up to date: version ' + $Matches[1]) -ForegroundColor Green } else { Write-Host '  The download did not look like Survey Link; using the copy in this folder.' -ForegroundColor Yellow } } catch { Write-Host '  Could not check for an update; using the copy in this folder.' -ForegroundColor Yellow }"
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -Command "Unblock-File -Path '%~dp0SurveyLink.ps1' -ErrorAction SilentlyContinue; & '%~dp0SurveyLink.ps1'"
echo.
echo Survey Link has stopped.
pause
