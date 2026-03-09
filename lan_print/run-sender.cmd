@echo off
setlocal

REM Double-click launcher for the sender (Windows).
REM If the script fails, keep the window open so you can read the error.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-sender.ps1"

echo.
echo (Sender exited. If this was unexpected, copy the error above.)
pause

endlocal


