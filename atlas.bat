@echo off
title New Eden Atlas
cd /d "%~dp0"
where py >nul 2>&1 && (set PY=py) || (set PY=python)
echo Starting New Eden Atlas - close this window to stop.
%PY% serve.py
if errorlevel 1 pause
