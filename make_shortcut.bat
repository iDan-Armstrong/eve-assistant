@echo off
rem One-time setup: creates the "New Eden Atlas" desktop shortcut with the Atlas icon.
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'New Eden Atlas.lnk')); $s.TargetPath='%REPO%\atlas.bat'; $s.WorkingDirectory='%REPO%'; $s.IconLocation='%REPO%\assets\atlas.ico,0'; $s.Description='New Eden Atlas - interactive EVE Online star atlas'; $s.Save()"
if errorlevel 1 (echo Shortcut creation failed. & pause & exit /b 1)
echo Done - "New Eden Atlas" is on your desktop.
timeout /t 3 >nul
