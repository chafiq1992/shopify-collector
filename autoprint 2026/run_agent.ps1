$ErrorActionPreference = "Stop"

# Change to repo root (this script's directory)
Set-Location -Path $PSScriptRoot

$root = $PSScriptRoot
$venv = Join-Path $root ".venv"
$pythonExe = Join-Path $venv "Scripts\python.exe"

# Ensure venv exists
if (-not (Test-Path $pythonExe)) {
    python -m venv $venv
}

# Install requirements
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install -r (Join-Path $root "requirements.txt")

# Ensure SumatraPDF portable is on PATH for this process and child
$env:PATH = (Join-Path $root "tools\SumatraPDF") + ";" + $env:PATH

# Optional logging
$logs = Join-Path $root "logs"
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$ts = (Get-Date -Format "yyyyMMdd_HHmmss")
$logFile = Join-Path $logs ("agent_" + $ts + ".log")
$errFile = Join-Path $logs ("agent_" + $ts + ".err.log")

# Start the agent in background (hidden window) and return immediately
Start-Process -FilePath $pythonExe `
    -ArgumentList "-m","app.main" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile


