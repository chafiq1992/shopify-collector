$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ╔══════════════════════════════════════════════════════════════╗
# ║  EDIT THESE VALUES TO MATCH YOUR CLOUD RUN CONFIG           ║
# ╚══════════════════════════════════════════════════════════════╝
$env:RELAY_URL   = "https://shopify-collector-985002633728.europe-west1.run.app"
$env:PC_ID       = "pc-lab-1"
$env:PC_SECRET   = "irrakids1992chafike_chh2028"
$env:API_KEY     = "i45678r99876543211234a567899k87654d"

# Leave empty to use the Windows default printer
$env:LABEL_PRINTER = ""

# Performance tuning (defaults are good for most setups)
# $env:LONG_POLL_SEC = "20"     # Server holds request until jobs arrive (0-25s)
# $env:MAX_WORKERS   = "3"      # Parallel print threads
# $env:MAX_ITEMS     = "10"     # Max jobs to pull per batch

# ── Auto-setup venv if missing ───────────────────────────────
if (-not (Test-Path "$PSScriptRoot\venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Yellow
    py -3 -m venv "$PSScriptRoot\venv"
}

Write-Host "Installing dependencies..." -ForegroundColor Yellow
& "$PSScriptRoot\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet 2>$null
& "$PSScriptRoot\venv\Scripts\python.exe" -m pip install -r "$PSScriptRoot\requirements.txt" --quiet

Write-Host ""
& "$PSScriptRoot\venv\Scripts\python.exe" "$PSScriptRoot\poller.py"
