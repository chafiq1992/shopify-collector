@echo off
setlocal

REM Double-click launcher for the receiver (Windows).
REM If the script fails, keep the window open so you can read the error.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-receiver.ps1"

echo.
echo (Receiver exited. If this was unexpected, copy the error above.)
pause

endlocal


