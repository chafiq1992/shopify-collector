import os, subprocess, shutil, threading, time
from pathlib import Path

try:
    import win32print  # type: ignore
except Exception:
    win32print = None

# Serialize all printing: only one job at a time to avoid printer dropping jobs
_printer_lock = threading.Lock()
# Delay after each print so the printer can physically output before the next job
_post_print_delay = 1.5

def set_post_print_delay(seconds: float):
    global _post_print_delay
    _post_print_delay = max(0.0, float(seconds))

def get_default_printer():
    if win32print:
        try:
            return win32print.GetDefaultPrinter()
        except Exception:
            return None
    return None

def print_pdf_silent(pdf_path: str, printer: str = None, sumatra_path: str = None, copies: int = 1):
    exe = sumatra_path or "SumatraPDF.exe"
    if not shutil.which(exe) and not (sumatra_path and Path(sumatra_path).exists()):
        raise RuntimeError("SumatraPDF.exe not found. Set 'sumatra_path' in config.yaml.")
    printer = printer or get_default_printer()
    if not printer:
        raise RuntimeError("No printer specified and no default printer found.")
    copies = max(1, int(copies))
    with _printer_lock:
        for _ in range(copies):
            cmd = [exe, "-print-to", printer, "-silent", "-exit-on-print", pdf_path]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"Sumatra print failed (code {result.returncode}). stderr: {result.stderr or result.stdout}")
            if _post_print_delay > 0:
                time.sleep(_post_print_delay)

def _pick_browser(chrome_path: str = "", edge_path: str = "") -> list[str]:
    candidates = []
    # Prefer explicit paths if provided
    if edge_path:
        candidates.append(edge_path)
    if chrome_path:
        candidates.append(chrome_path)
    # Common installs
    candidates += [
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    return [p for p in candidates if Path(p).exists()]

def _run_headless(browser: str, html_path: str, out_pdf: str, use_headless_new: bool, budget_ms: int) -> tuple[int, str, str]:
    headless_flag = "--headless=new" if use_headless_new else "--headless"
    args = [
        browser,
        headless_flag,
        "--disable-gpu",
        "--no-sandbox",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--disable-software-rasterizer",
        "--disable-features=PdfOopif",
        f"--print-to-pdf={out_pdf}",
        Path(html_path).as_uri(),
        f"--virtual-time-budget={budget_ms}",
    ]
    # Do NOT use shell=True; capture outputs for diagnostics
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.returncode, proc.stdout, proc.stderr

def html_to_pdf(html_path: str, out_pdf: str, chrome_path: str = "", edge_path: str = ""):
    browsers = _pick_browser(chrome_path, edge_path)
    if not browsers:
        raise RuntimeError("Edge/Chrome executable not found. Set edge_path or chrome_path in config.yaml.")

    last_err = []
    # Try each browser with headless=new, then headless
    for browser in browsers:
        for use_new in (True, False):
            code, out, err = _run_headless(browser, html_path, out_pdf, use_headless_new=use_new, budget_ms=8000)
            if code == 0 and Path(out_pdf).exists() and Path(out_pdf).stat().st_size > 0:
                return
            last_err.append(f"{Path(browser).name} ({'new' if use_new else 'old'}): code={code}, stderr={err.strip() or out.strip()}")
    raise RuntimeError("Headless print-to-pdf failed. Tried:\n" + "\n".join(last_err[:6]))
