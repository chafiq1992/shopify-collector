import os
import shutil
import time
from typing import Dict, Tuple

import requests

# Watches a folder for new PDFs and uploads them to the receiver.
#
# Typical usage:
#   - Configure a virtual PDF printer (PDFCreator recommended) to auto-save PDFs to WATCH_DIR without prompting.
#   - Run this sender on the "other PC". Every time they print to that printer, a PDF appears in WATCH_DIR.
#   - Sender uploads the PDF to DEST_URL and moves it to /sent or /failed.

WATCH_DIR = (os.getenv("LAN_PRINT_WATCH_DIR", r"C:\AutoPrint\outbox") or "").strip()
DEST_URL = (os.getenv("LAN_PRINT_DEST_URL", "http://127.0.0.1:8790/print/pdf") or "").strip().rstrip("/")
API_KEY = (os.getenv("LAN_PRINT_API_KEY", "") or "").strip()
PRINTER = (os.getenv("LAN_PRINT_PRINTER", "") or "").strip()
COPIES = int((os.getenv("LAN_PRINT_COPIES", "") or "1").strip() or 1)

POLL_SEC = float((os.getenv("LAN_PRINT_POLL_SEC", "") or "1").strip() or 1)
STABLE_SEC = float((os.getenv("LAN_PRINT_STABLE_SEC", "") or "1.5").strip() or 1.5)
MAX_BYTES = int((os.getenv("LAN_PRINT_MAX_BYTES", "") or str(25 * 1024 * 1024)).strip() or (25 * 1024 * 1024))

SENT_DIR = os.path.join(WATCH_DIR, "sent")
FAILED_DIR = os.path.join(WATCH_DIR, "failed")
os.makedirs(WATCH_DIR, exist_ok=True)
os.makedirs(SENT_DIR, exist_ok=True)
os.makedirs(FAILED_DIR, exist_ok=True)


def _is_pdf(p: str) -> bool:
    return p.lower().endswith(".pdf")


def _iter_candidate_pdfs():
    for name in os.listdir(WATCH_DIR):
        p = os.path.join(WATCH_DIR, name)
        if os.path.isdir(p):
            continue
        if name.startswith("~"):
            continue
        if name.lower().endswith(".tmp"):
            continue
        if name.lower().endswith(".part"):
            continue
        if name in ("sent", "failed"):
            continue
        if _is_pdf(p):
            yield p


def _move_to(dir_path: str, src: str) -> str:
    base = os.path.basename(src)
    dst = os.path.join(dir_path, base)
    # If exists, make unique
    if os.path.exists(dst):
        root, ext = os.path.splitext(base)
        dst = os.path.join(dir_path, f"{root}-{int(time.time())}{ext}")
    shutil.move(src, dst)
    return dst


def _upload_pdf(path: str) -> Tuple[bool, str]:
    size = os.path.getsize(path)
    if size <= 0:
        return False, "empty file"
    if size > MAX_BYTES:
        return False, f"file too large ({size} bytes)"

    headers = {}
    if API_KEY:
        headers["x-api-key"] = API_KEY

    data = {}
    if PRINTER:
        data["printer"] = PRINTER
    if COPIES and COPIES != 1:
        data["copies"] = str(int(COPIES))

    with open(path, "rb") as f:
        files = {"file": (os.path.basename(path), f, "application/pdf")}
        r = requests.post(f"{DEST_URL}/print/pdf", headers=headers, data=data, files=files, timeout=60)
    if not r.ok:
        try:
            js = r.json()
            detail = js.get("detail") or r.text
        except Exception:
            detail = r.text
        return False, f"{r.status_code}: {detail}"
    return True, "ok"


def main():
    print("LAN Print Sender started.")
    print(f"  WATCH_DIR = {WATCH_DIR}")
    print(f"  DEST_URL  = {DEST_URL}")
    print(f"  PRINTER   = {PRINTER or '(receiver default)'}")
    print(f"  COPIES    = {COPIES}")

    # Track last observed size + first seen time + last changed time
    seen: Dict[str, Tuple[int, float, float]] = {}  # path -> (size, first_seen_ts, last_change_ts)

    while True:
        try:
            now = time.time()
            paths = list(_iter_candidate_pdfs())

            # Remove entries that disappeared
            for p in list(seen.keys()):
                if p not in paths:
                    seen.pop(p, None)

            for p in paths:
                try:
                    st = os.stat(p)
                    size = int(st.st_size)
                    mtime = float(st.st_mtime)
                except Exception:
                    continue

                prev = seen.get(p)
                if not prev:
                    seen[p] = (size, now, now)
                    continue

                prev_size, first_seen, last_change = prev
                if size != prev_size:
                    seen[p] = (size, first_seen, now)
                    continue

                # file size stable for STABLE_SEC and not too fresh
                if (now - last_change) < STABLE_SEC:
                    continue

                # Extra guard: if file is still being written but size stable, wait a bit if mtime is too recent
                if (now - mtime) < (STABLE_SEC / 2):
                    continue

                print(f"Uploading: {os.path.basename(p)} ({size} bytes)")
                ok, msg = _upload_pdf(p)
                if ok:
                    dst = _move_to(SENT_DIR, p)
                    print(f"  sent -> {dst}")
                else:
                    dst = _move_to(FAILED_DIR, p)
                    print(f"  FAILED ({msg}) -> {dst}")

                seen.pop(p, None)

        except Exception as e:
            print("Loop error:", e)

        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()


