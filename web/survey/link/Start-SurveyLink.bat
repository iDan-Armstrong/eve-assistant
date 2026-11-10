@echo off
rem Survey Link for N-Space Survey. Double-click to start; close the window to stop.
title Survey Link
cd /d "%~dp0"
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -Command "Unblock-File -Path '%~dp0SurveyLink.ps1' -ErrorAction SilentlyContinue; & '%~dp0SurveyLink.ps1'"
echo.
echo Survey Link has stopped.
pause
