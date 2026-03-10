import os
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

APP_TITLE = "LAN Print Receiver"

API_KEY = (os.getenv("LAN_PRINT_API_KEY", "") or "").strip()

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


def _find_chrome() -> str:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return ""


def _html_to_pdf(html_path: str, pdf_path: str) -> None:
    """Convert an HTML file to PDF using headless Chrome/Edge."""
    chrome = _find_chrome()
    if not chrome:
        raise RuntimeError(
            "Chrome or Edge not found. Install Google Chrome or Microsoft Edge "
            "for HTML-to-PDF conversion."
        )
    cmd = [
        chrome,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        f"--print-to-pdf={pdf_path}",
        "--print-to-pdf-no-header",
        html_path,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=PRINT_TIMEOUT_SEC)
    if not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) == 0:
        stderr = (p.stderr or "").strip()
        raise RuntimeError(f"HTML-to-PDF conversion failed. {stderr or 'No output PDF.'}")


def _sumatra_print(pdf_path: str, printer: str, copies: int) -> None:
    exe = _find_sumatra()
    if not exe:
        raise RuntimeError(
            "SumatraPDF.exe not found. Install SumatraPDF and set SUMATRA_PATH, "
            "or install it in Program Files."
        )

    copies = max(1, int(copies or 1))
    if printer:
        cmd = [exe, "-print-to", printer, "-silent", "-exit-on-print", "-print-settings", f"copies={copies}", pdf_path]
    else:
        cmd = [exe, "-print-to-default", "-silent", "-exit-on-print", "-print-settings", f"copies={copies}", pdf_path]

    p = subprocess.run(cmd, capture_output=True, text=True, timeout=PRINT_TIMEOUT_SEC)
    if p.returncode != 0:
        stderr = (p.stderr or "").strip()
        stdout = (p.stdout or "").strip()
        raise RuntimeError(f"SumatraPDF print failed (code={p.returncode}). {stderr or stdout or 'No output.'}")


def _cleanup(*paths):
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


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
        "chrome_found": bool(_find_chrome()),
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
        _cleanup(out_path)
        raise HTTPException(status_code=500, detail=f"failed to save upload: {e}")

    try:
        chosen_printer = (printer or DEFAULT_PRINTER or "").strip()
        _sumatra_print(out_path, chosen_printer, copies)
        return {"ok": True, "job_id": job_id, "printer": chosen_printer or "DEFAULT", "copies": max(1, int(copies or 1))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(out_path)


class HtmlPrintRequest(BaseModel):
    html: str
    printer: Optional[str] = None
    copies: int = 1


@app.post("/print/html")
async def print_html(
    body: HtmlPrintRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    """Accept raw HTML, convert to PDF via headless Chrome/Edge, then print."""
    _require_api_key(x_api_key)

    if not body.html or not body.html.strip():
        raise HTTPException(status_code=400, detail="html body is empty")

    job_id = f"{int(time.time())}-{os.getpid()}"
    html_path = os.path.join(SPOOL_DIR, f"{job_id}-label.html")
    pdf_path = os.path.join(SPOOL_DIR, f"{job_id}-label.pdf")

    try:
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(body.html)
    except Exception as e:
        _cleanup(html_path)
        raise HTTPException(status_code=500, detail=f"failed to save HTML: {e}")

    try:
        _html_to_pdf(html_path, pdf_path)
        chosen_printer = (body.printer or DEFAULT_PRINTER or "").strip()
        _sumatra_print(pdf_path, chosen_printer, body.copies)
        return {
            "ok": True,
            "job_id": job_id,
            "printer": chosen_printer or "DEFAULT",
            "copies": max(1, int(body.copies or 1)),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(html_path, pdf_path)
