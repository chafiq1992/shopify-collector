$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$root\venv")) {
  py -3 -m venv "$root\venv"
}

& "$root\venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
& "$root\venv\Scripts\python.exe" -m pip install -r "$root\requirements.txt"

# Configure these on the "other PC"
if (-not $env:LAN_PRINT_WATCH_DIR) { $env:LAN_PRINT_WATCH_DIR = "C:\AutoPrint\outbox" }
if (-not $env:LAN_PRINT_DEST_URL) { $env:LAN_PRINT_DEST_URL = "http://127.0.0.1:8790" } # set to printer-PC IP
if (-not $env:LAN_PRINT_API_KEY) { $env:LAN_PRINT_API_KEY = "" } # must match receiver if set
if (-not $env:LAN_PRINT_PRINTER) { $env:LAN_PRINT_PRINTER = "" } # optional; receiver default otherwise
if (-not $env:LAN_PRINT_COPIES) { $env:LAN_PRINT_COPIES = "1" }

Write-Host "Starting LAN PDF sender (watch folder -> receiver)..." -ForegroundColor Cyan
& "$root\venv\Scripts\python.exe" "$PSScriptRoot\sender.py"


