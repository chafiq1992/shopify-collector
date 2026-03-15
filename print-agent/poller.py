"""
Delivery Label Print Agent — high-reliability, parallel-printing poller.

Key design choices:
  - Long-polling: server holds the connection until jobs arrive (near-zero latency).
  - ThreadPoolExecutor: prints up to MAX_WORKERS labels in parallel.
  - Lease + ack/nack: server keeps the job until we confirm success.
    If we crash, the server auto-reclaims the job after ~90s.
  - Retry: on print failure we nack (server re-queues, up to 4 attempts).
  - Connection pooling via requests.Session (single TCP connection reused).
  - Exe paths resolved once at startup.
"""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

os.environ.setdefault("PYTHONUNBUFFERED", "1")
import requests

def _log(msg: str):
    print(msg, flush=True)

# ── Config ───────────────────────────────────────────────────────────
RELAY_URL   = os.getenv("RELAY_URL", "https://shopify-collector-985002633728.europe-west1.run.app").rstrip("/")
PC_ID       = os.getenv("PC_ID", "pc-lab-1")
PC_SECRET   = os.getenv("PC_SECRET", "SECRET1")
API_KEY     = os.getenv("API_KEY", "")

LONG_POLL_SEC   = int(os.getenv("LONG_POLL_SEC", "20"))
MAX_ITEMS       = int(os.getenv("MAX_ITEMS", "10"))
MAX_WORKERS     = int(os.getenv("MAX_WORKERS", "3"))
FALLBACK_SLEEP  = float(os.getenv("FALLBACK_SLEEP", "1"))

SUMATRA_PATH    = (os.getenv("SUMATRA_PATH", "") or "").strip()
LABEL_PRINTER   = (os.getenv("LABEL_PRINTER", "") or "").strip()
EDGE_PATH       = (os.getenv("EDGE_PATH", "") or "").strip()

# ── Globals (set once at startup) ────────────────────────────────────
_sumatra: str = ""
_edge: str = ""
_session: requests.Session = requests.Session()
_shutdown = False


# ── Exe resolution (cached) ─────────────────────────────────────────
def _find_sumatra() -> str:
    if SUMATRA_PATH and os.path.isfile(SUMATRA_PATH):
        return SUMATRA_PATH
    for c in [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    ]:
        if os.path.isfile(c):
            return c
    return ""


def _find_edge() -> str:
    if EDGE_PATH and os.path.isfile(EDGE_PATH):
        return EDGE_PATH
    for c in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]:
        if os.path.isfile(c):
            return c
    return ""


# ── Relay helpers (use session for connection reuse) ─────────────────
def pull_jobs() -> list:
    """Long-poll the server. Returns immediately when jobs exist or after LONG_POLL_SEC."""
    r = _session.get(
        f"{RELAY_URL}/pull",
        params={
            "pc_id": PC_ID,
            "secret": PC_SECRET,
            "max_items": MAX_ITEMS,
            "wait": LONG_POLL_SEC,
        },
        timeout=LONG_POLL_SEC + 10,
    )
    r.raise_for_status()
    return r.json().get("jobs", [])


def ack_job(job_id: str):
    try:
        _session.post(
            f"{RELAY_URL}/ack",
            json={"pc_id": PC_ID, "secret": PC_SECRET, "job_id": job_id},
            timeout=10,
        )
    except Exception as e:
        _log(f"  [WARN] ack failed for {job_id}: {e}")


def nack_job(job_id: str):
    """Tell the server this job failed so it can be retried."""
    try:
        _session.post(
            f"{RELAY_URL}/nack",
            json={"pc_id": PC_ID, "secret": PC_SECRET, "job_id": job_id},
            timeout=10,
        )
    except Exception as e:
        _log(f"  [WARN] nack failed for {job_id}: {e}")


# ── Printer helpers ──────────────────────────────────────────────────
def _print_pdf(pdf_path: str, printer: str = "", copies: int = 1):
    if not _sumatra:
        raise RuntimeError("SumatraPDF not found. Install it or set SUMATRA_PATH.")
    if printer:
        cmd = [_sumatra, "-print-to", printer, "-silent", "-exit-on-print",
               "-print-settings", f"copies={copies}", pdf_path]
    else:
        cmd = [_sumatra, "-print-to-default", "-silent", "-exit-on-print",
               "-print-settings", f"copies={copies}", pdf_path]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    if p.returncode != 0:
        raise RuntimeError(f"SumatraPDF exit {p.returncode}: {(p.stderr or p.stdout or '').strip()}")


def _html_to_pdf(html_path: str, pdf_path: str):
    if not _edge:
        raise RuntimeError("Edge/Chrome not found. Set EDGE_PATH.")
    cmd = [_edge, "--headless", "--disable-gpu", "--no-sandbox",
           f"--print-to-pdf={pdf_path}", f"file:///{html_path.replace(os.sep, '/')}"]
    subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) == 0:
        raise RuntimeError("HTML-to-PDF conversion produced no output")


# ── Print one label (runs inside a thread) ───────────────────────────
def _process_label(job: dict) -> bool:
    """Download and print a single delivery label. Returns True on success."""
    delivery_order_id = job.get("delivery_order_id", "")
    envoy_code = job.get("envoy_code", "") or ""

    url = f"{RELAY_URL}/api/delivery-label/{delivery_order_id}"
    params: dict = {"autoprint": "false"}
    if envoy_code:
        params["envoy_code"] = envoy_code

    r = None
    try:
        if envoy_code:
            r = _session.get(url, params=params, timeout=30)
        else:
            r = _session.get(url, params={**params, "format": "pdf"}, timeout=30)
        r.raise_for_status()
    except Exception:
        try:
            r = _session.get(url, params=params, timeout=30)
            r.raise_for_status()
        except Exception as e:
            _log(f"  [ERR] download failed: {e}")
            return False

    content_type = (r.headers.get("content-type") or "").lower()
    tmp_dir = tempfile.mkdtemp(prefix="label-")
    try:
        if "application/pdf" in content_type:
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(pdf_path, "wb") as f:
                f.write(r.content)
            _print_pdf(pdf_path, LABEL_PRINTER)
        else:
            html_path = os.path.join(tmp_dir, "label.html")
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(html_path, "wb") as f:
                f.write(r.content)
            _html_to_pdf(html_path, pdf_path)
            _print_pdf(pdf_path, LABEL_PRINTER)
        return True
    except Exception as e:
        _log(f"  [ERR] print failed: {e}")
        return False
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def handle_job(job: dict):
    """Process a single job: print, then ack or nack."""
    job_id = job.get("job_id", "?")
    job_type = job.get("type", "order")

    if job_type != "label":
        _log(f"[SKIP] non-label job type={job_type}")
        ack_job(job_id)
        return

    dlv_id = job.get("delivery_order_id", "")
    _log(f"[LABEL] {dlv_id}  (job={job_id[:8]})")

    ok = False
    try:
        ok = _process_label(job)
    except Exception as e:
        _log(f"  [ERR] exception: {e}")

    if ok:
        _log(f"  [OK] printed {dlv_id}")
        ack_job(job_id)
    else:
        _log(f"  [RETRY] nacking {dlv_id}")
        nack_job(job_id)


# ── Main loop ────────────────────────────────────────────────────────
def main():
    global _sumatra, _edge, _shutdown

    _sumatra = _find_sumatra()
    _edge = _find_edge()

    _log("=" * 55)
    _log("  DELIVERY LABEL PRINT AGENT  (v2 -- parallel + reliable)")
    _log("=" * 55)
    _log(f"  Relay:       {RELAY_URL}")
    _log(f"  PC ID:       {PC_ID}")
    _log(f"  Printer:     {LABEL_PRINTER or '(default)'}")
    _log(f"  Sumatra:     {_sumatra or 'NOT FOUND'}")
    _log(f"  Edge:        {_edge or 'NOT FOUND'}")
    _log(f"  Long-poll:   {LONG_POLL_SEC}s")
    _log(f"  Workers:     {MAX_WORKERS} parallel")
    _log("=" * 55)
    _log("Waiting for print jobs...\n")

    def _on_signal(sig, _frame):
        global _shutdown
        _shutdown = True
        _log("\n[SHUTDOWN] Finishing in-flight jobs...")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        while not _shutdown:
            try:
                jobs = pull_jobs()
                if not jobs:
                    continue

                futures = {pool.submit(handle_job, job): job for job in jobs}
                for fut in as_completed(futures, timeout=120):
                    try:
                        fut.result()
                    except Exception as e:
                        job = futures[fut]
                        _log(f"  [ERR] worker exception for {job.get('job_id','?')}: {e}")
                        nack_job(job.get("job_id", ""))

            except requests.exceptions.ConnectionError:
                _log("[NET] connection lost -- retrying in 5s")
                time.sleep(5)
            except requests.exceptions.Timeout:
                pass
            except requests.exceptions.HTTPError as e:
                status = getattr(e.response, "status_code", 0) if hasattr(e, "response") else 0
                if status == 401:
                    _log("[AUTH] 401 Unauthorized -- check PC_ID / PC_SECRET in start.ps1. Retrying in 30s...")
                    time.sleep(30)
                else:
                    _log(f"[HTTP] {e} -- retrying in 5s")
                    time.sleep(5)
            except Exception as e:
                _log(f"[ERR] {e}")
                time.sleep(FALLBACK_SLEEP)

    _log("[SHUTDOWN] Done.")


if __name__ == "__main__":
    main()
