@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Change to repo root
cd /d %~dp0
set "ROOT=%CD%"
set "VENV=%ROOT%\.venv"
set "PYTHON=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"

call :ensure_config

rem Create virtual environment if missing
if not exist "%PYTHON%" (
  rem Prefer a known per-user install if present (post-silent install)
  set "BOOTPY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  if not exist "%BOOTPY%" set "BOOTPY=python"
  echo Creating virtual environment at %VENV% ...
  "%BOOTPY%" -m venv "%VENV%"
)

rem Ensure pip exists and is up-to-date
if not exist "%PIP%" (
  "%PYTHON%" -m ensurepip --upgrade >nul 2>&1
)
"%PYTHON%" -m pip install --upgrade pip >nul 2>&1
"%PYTHON%" -m pip install -r "%ROOT%\requirements.txt"

rem Add local tools to PATH for this session (Sumatra detection)
set "PATH=%ROOT%\tools\SumatraPDF;%ROOT%\tools;%PATH%"

echo Starting print agent...
"%PYTHON%" -m app.main
goto :eof

:: ---------------- helpers -----------------
:ensure_config
if exist "%ROOT%\config.yaml" goto :eof
if not exist "%ROOT%\config.example.yaml" goto :eof
echo Bootstrapping config.yaml from config.example.yaml
copy /Y "%ROOT%\config.example.yaml" "%ROOT%\config.yaml" >nul
goto :eof

rem (No Python or SumatraPDF auto-install steps; assumes they are already available)
