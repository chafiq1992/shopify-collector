@echo off
setlocal EnableExtensions

rem Change to repo root
cd /d %~dp0
set "ROOT=%CD%"
set "VENV=%ROOT%\.venv"
set "PY=%VENV%\Scripts\python.exe"

rem Ensure venv exists
if not exist "%PY%" (
  python -m venv "%VENV%"
)

rem Install/update requirements
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r "%ROOT%\requirements.txt"

rem Ensure SumatraPDF portable is on PATH for this process
set "PATH=%ROOT%\tools\SumatraPDF;%PATH%"

rem Start the agent minimized and return immediately
start "AutoPrintAgent" /min "%PY%" -m app.main
exit /b 0


