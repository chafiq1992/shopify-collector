$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$PSScriptRoot\venv")) {
  py -3 -m venv "$PSScriptRoot\venv"
}

& "$PSScriptRoot\venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
& "$PSScriptRoot\venv\Scripts\python.exe" -m pip install -r "$root\requirements.txt"

if (-not $env:RELAY_URL) { $env:RELAY_URL = "http://localhost:8080" }
if (-not $env:PC_ID) { $env:PC_ID = "pc-lab-1" }
if (-not $env:PC_SECRET) { $env:PC_SECRET = "SECRET1" }
if (-not $env:LOCAL_PRINTER_URL) { $env:LOCAL_PRINTER_URL = "http://127.0.0.1:8787" }
# Optional: override SumatraPDF / Edge paths and label printer name
# $env:SUMATRA_PATH = "C:\Program Files\SumatraPDF\SumatraPDF.exe"
# $env:LABEL_PRINTER = ""   # empty = default printer
# $env:EDGE_PATH = ""       # auto-detected

Write-Host "Starting auto-print agent..." -ForegroundColor Cyan
& "$PSScriptRoot\venv\Scripts\python.exe" "$PSScriptRoot\poller.py"

