DELIVERY LABEL PRINT AGENT
==========================

Copy this entire "print-agent" folder to the laptop with the USB printer.

REQUIREMENTS:
  1. Python 3  →  https://www.python.org/downloads/  (check "Add to PATH" during install)
  2. SumatraPDF →  https://www.sumatrapdfreader.org/download-free-pdf-viewer

SETUP:
  1. Open start.ps1 in Notepad
  2. Edit PC_ID, PC_SECRET, and API_KEY to match your Cloud Run env vars
  3. Make sure your USB printer is set as the default Windows printer

RUN:
  Right-click start.ps1 → "Run with PowerShell"

  First run will auto-create a Python venv and install dependencies.
  After that it polls for labels every 2 seconds and prints silently.

AUTO-START ON BOOT (optional):
  1. Press Win+R, type: shell:startup, press Enter
  2. Create a shortcut to start.ps1 in that folder

FILES:
  poller.py         - The print agent (polls for labels, prints them)
  start.ps1         - Launcher (edit config here, then double-click)
  requirements.txt  - Python dependency (just "requests")
