@echo off
title EasyChat - sharing
cd /d "%~dp0"

call scripts\find-python.bat
if errorlevel 1 goto :stop
if not defined PY goto :stop

"%PY%" %PYOPT% share.py

:stop
echo.
echo   EasyChat has stopped. Press any key to close this window.
pause >nul
