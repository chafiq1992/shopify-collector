import os
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

APP_TITLE = "LAN Print Receiver (PDF)"

# Security: set API_KEY to require x-api-key header
API_KEY = (os.getenv("LAN_PRINT_API_KEY", "") or "").strip()

# Printing config
SUMATRA_PATH = (os.getenv("SUMATRA_PATH", "") or "").strip()
DEFAULT_PRINTER = (os.getenv("LAN_PRINT_DEFAULT_PRINTER", "") or "").strip()
PRINT_TIMEOUT_SEC = int((os.getenv("LAN_PRINT_TIMEOUT_SEC", "") or "45").strip() or 45)

SPOOL_DIR = (os.getenv("LAN_PRINT_SPOOL_DIR", "") or "").strip()
if not SPOOL_DIR:
    SPOOL_DIR = os.path.join(tempfile.gettempdir(), "lan-print-spool")
os.makedirs(SPOOL_DIR, exist_ok=True)


def _require_api_key(x_api_key: Optional[str]):
    if API_KEY and (x_api_key or "") != API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


def _find_sumatra() -> str:
    if SUMATRA_PATH and os.path.isfile(SUMATRA_PATH):
        return SUMATRA_PATH
    candidates = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return ""


def _sumatra_print(pdf_path: str, printer: str, copies: int) -> None:
    exe = _find_sumatra()
    if not exe:
        raise RuntimeError(
            "SumatraPDF.exe not found. Install SumatraPDF and set SUMATRA_PATH, "
            "or install it in Program Files."
        )

    copies = max(1, int(copies or 1))
    # Sumatra supports:
    # -print-to "Printer Name" OR -print-to-default
    # -silent -exit-on-print -print-settings "copies=N"
    if printer:
        cmd = [exe, "-print-to", printer, "-silent", "-exit-on-print", "-print-settings", f"copies={copies}", pdf_path]
    else:
        cmd = [exe, "-print-to-default", "-silent", "-exit-on-print", "-print-settings", f"copies={copies}", pdf_path]

    p = subprocess.run(cmd, capture_output=True, text=True, timeout=PRINT_TIMEOUT_SEC)
    if p.returncode != 0:
        stderr = (p.stderr or "").strip()
        stdout = (p.stdout or "").strip()
        raise RuntimeError(f"SumatraPDF print failed (code={p.returncode}). {stderr or stdout or 'No output.'}")


app = FastAPI(title=APP_TITLE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": APP_TITLE,
        "spool_dir": SPOOL_DIR,
        "api_key_required": bool(API_KEY),
        "sumatra_found": bool(_find_sumatra()),
        "default_printer": DEFAULT_PRINTER or None,
    }


@app.post("/print/pdf")
async def print_pdf(
    file: UploadFile = File(...),
    x_api_key: Optional[str] = Header(default=None),
    printer: Optional[str] = None,
    copies: int = 1,
):
    _require_api_key(x_api_key)

    fn = (file.filename or "document.pdf").strip()
    if not fn.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only .pdf supported")

    job_id = f"{int(time.time())}-{os.getpid()}"
    out_path = os.path.join(SPOOL_DIR, f"{job_id}-{fn}".replace("..", "."))

    try:
        with open(out_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"failed to save upload: {e}")

    try:
        chosen_printer = (printer or DEFAULT_PRINTER or "").strip()
        _sumatra_print(out_path, chosen_printer, copies)
        return {"ok": True, "job_id": job_id, "printer": chosen_printer or "DEFAULT", "copies": max(1, int(copies or 1))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Keep spool clean
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except Exception:
            pass


