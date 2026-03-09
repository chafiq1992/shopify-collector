$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$root\venv")) {
  py -3 -m venv "$root\venv"
}

& "$root\venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
& "$root\venv\Scripts\python.exe" -m pip install -r "$root\requirements.txt"

if (-not $env:LAN_PRINT_API_KEY) { $env:LAN_PRINT_API_KEY = "" } # set to require x-api-key
if (-not $env:LAN_PRINT_DEFAULT_PRINTER) { $env:LAN_PRINT_DEFAULT_PRINTER = "" } # optional
if (-not $env:SUMATRA_PATH) { $env:SUMATRA_PATH = "" } # recommended
if (-not $env:LAN_PRINT_TIMEOUT_SEC) { $env:LAN_PRINT_TIMEOUT_SEC = "45" }

Write-Host "Starting LAN PDF print receiver on http://0.0.0.0:8790 ..." -ForegroundColor Cyan
& "$root\venv\Scripts\python.exe" -m uvicorn receiver:app --app-dir "$PSScriptRoot" --host 0.0.0.0 --port 8790


