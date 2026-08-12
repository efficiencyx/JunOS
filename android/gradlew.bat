@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gradle-bootstrap.ps1" %*
exit /b %ERRORLEVEL%
