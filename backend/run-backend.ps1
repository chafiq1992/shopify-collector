$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root\venv")) {
  py -3 -m venv "$root\venv"
}

& "$root\venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
& "$root\venv\Scripts\python.exe" -m pip install -r "$root\requirements.txt"

Write-Host "Starting backend (includes local relay) on http://localhost:8080 ..." -ForegroundColor Cyan
& "$root\venv\Scripts\python.exe" -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8080 --reload

