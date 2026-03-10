@echo off
setlocal EnableExtensions

rem Change to repo root
cd /d %~dp0
set "ROOT=%CD%"
set "SCRIPT=%ROOT%\run_agent.bat"

if not exist "%SCRIPT%" (
  echo run_agent.bat not found at %SCRIPT%
  exit /b 1
)

rem Remove existing task if present
schtasks /Query /TN "AutoPrintAgent" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Updating existing scheduled task AutoPrintAgent...
  schtasks /Delete /TN "AutoPrintAgent" /F >nul 2>&1
)

echo Creating scheduled task to run at user logon...
schtasks /Create ^
  /TN "AutoPrintAgent" ^
  /SC ONLOGON ^
  /TR "\"%SCRIPT%\"" ^
  /F

if %ERRORLEVEL% NEQ 0 (
  echo Failed to create scheduled task. If prompted, try Run as Administrator.
  exit /b 1
)

echo Scheduled task created. It will launch the agent in the background on next login.
echo To start it now, double-click run_agent.bat.
exit /b 0


