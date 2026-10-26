@echo off
rem Starts the Puffer Party recorder, the dashboard and the always-on-top live window.
rem Extra arguments are passed on, e.g.  run.bat --dump
title Puffer Party Recorder
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
    pause
    exit /b 1
)

python -c "import webview" >nul 2>nul
if errorlevel 1 (
    echo Installing pywebview for the live window ^(one time only^)...
    python -m pip install --quiet pywebview
)

python recorder.py --live %*
if errorlevel 1 pause
