import os
import shutil
import subprocess
import tempfile
import time
import requests

RELAY_URL = os.getenv("RELAY_URL", "http://localhost:8080")
PC_ID = os.getenv("PC_ID", "pc-lab-1")
PC_SECRET = os.getenv("PC_SECRET", "SECRET1")
LOCAL_PRINTER_URL = os.getenv("LOCAL_PRINTER_URL", "http://127.0.0.1:8787")
API_KEY = os.getenv("API_KEY", "")

PULL_INTERVAL_SEC = float(os.getenv("PULL_INTERVAL_SEC", "2"))

SUMATRA_PATH = (os.getenv("SUMATRA_PATH", "") or "").strip()
LABEL_PRINTER = (os.getenv("LABEL_PRINTER", "") or "").strip()
EDGE_PATH = (os.getenv("EDGE_PATH", "") or "").strip()


def pull_jobs():
    r = requests.get(
        f"{RELAY_URL}/pull",
        params={"pc_id": PC_ID, "secret": PC_SECRET, "max_items": 5},
        timeout=10,
    )
    r.raise_for_status()
    return r.json().get("jobs", [])


def ack_job(job_id: str):
    r = requests.post(
        f"{RELAY_URL}/ack",
        json={"pc_id": PC_ID, "secret": PC_SECRET, "job_id": job_id},
        timeout=10,
    )
    r.raise_for_status()


def requeue_job(orders, copies, store: str | None = None):
    try:
        headers = {"x-api-key": API_KEY} if API_KEY else {}
        payload = {
            "pc_id": PC_ID,
            "orders": [str(o).lstrip("#") for o in (orders or [])],
            "copies": int(copies) if copies else 1,
            **({"store": store} if store else {}),
        }
        r = requests.post(f"{RELAY_URL}/enqueue", json=payload, headers=headers, timeout=10)
        r.raise_for_status()
        return True
    except Exception as e:
        print("Failed to re-enqueue job:", e)
        return False

def print_locally(orders, copies, store: str | None = None) -> bool:
    # Call your existing local receiver on this PC
    # Try to pull overrides from backend to enrich customer data only for irranova
    overrides = {}
    # Try to fetch print-friendly data (only unfulfilled items + current total) from backend if available
    print_data = []
    try:
        joined = ",".join([str(o).lstrip("#") for o in orders])
        params = {"numbers": joined, **({"store": store} if store else {})}
        rpd = requests.get(f"{RELAY_URL}/api/print-data", params=params, timeout=15)
        if rpd.ok:
            js = rpd.json() or {}
            print_data = js.get("orders") or []
    except Exception:
        print_data = []
    def _is_complete(ov: dict | None) -> bool:
        if not isinstance(ov, dict):
            return False
        try:
            cust = (ov.get("customer") or {})
            shp = (ov.get("shippingAddress") or {})
            name_ok = bool(((cust.get("displayName") or "").strip()) or ((shp.get("name") or "").strip()))
            contact_ok = bool(((cust.get("email") or ov.get("email") or "").strip()) or ((cust.get("phone") or ov.get("phone") or (shp.get("phone") or "")).strip()))
            return name_ok and contact_ok
        except Exception:
            return False

    def _fetch_overrides(required_orders: list[str], force_live: bool) -> dict:
        try:
            joined = ",".join([str(o).lstrip("#") for o in required_orders])
            headers = {"x-api-key": API_KEY} if API_KEY else {}
            params = {"orders": joined, **({"store": store} if store else {}), **({"force_live": "1"} if force_live else {})}
            ro = requests.get(f"{RELAY_URL}/api/overrides", params=params, headers=headers, timeout=15)
            ro.raise_for_status()
            return (ro.json() or {}).get("overrides") or {}
        except Exception:
            return {}

	# For irranova (or unknown store), ensure customer info is present before printing
	store_key = (store or "").strip().lower()
	require_overrides = (store_key == "irranova" or store_key == "")
	if require_overrides:
		# Try up to 3 attempts: cached, then force_live twice with short backoff
		attempts = [False, True, True]
		wait_secs = [0.0, 1.0, 2.0]
		overrides = {}
		for idx, force in enumerate(attempts):
			if idx > 0 and wait_secs[idx] > 0:
				try:
					time.sleep(wait_secs[idx])
				except Exception:
					pass
			overrides = _fetch_overrides(orders, force)
			all_ok = True
			for o in orders:
				k = str(o).lstrip("#")
				if not _is_complete(overrides.get(k)):
					all_ok = False
					break
			if all_ok:
				break
		# If still missing and store is unknown, try explicit Irranova fallback once
		missing = [str(o).lstrip("#") for o in orders if not _is_complete(overrides.get(str(o).lstrip("#")))]
		if missing and store_key == "":
			try:
				joined = ",".join([str(o).lstrip("#") for o in missing])
				headers = {"x-api-key": API_KEY} if API_KEY else {}
				ro2 = requests.get(f"{RELAY_URL}/api/overrides", params={"orders": joined, "store": "irranova", "force_live": "1"}, headers=headers, timeout=12)
				ro2.raise_for_status()
				ov2 = (ro2.json() or {}).get("overrides") or {}
				overrides.update(ov2)
			except Exception:
				pass
		# Final check: if still not complete, do not print
		missing = [str(o).lstrip("#") for o in orders if not _is_complete(overrides.get(str(o).lstrip("#")))]
		if missing:
			print("Missing customer info for:", missing, "— re-enqueueing and skipping print")
			return False
	else:
		# Non-irranova: best-effort fetch (no block)
		try:
			overrides = _fetch_overrides(orders, False)
		except Exception:
			overrides = {}

    payload = {
        "orders": orders,
        "copies": copies,
        **({"store": store} if store else {}),
        **({"overrides": overrides} if overrides else {}),
        **({"print_data": print_data} if print_data else {}),
        "qr_mode": True,
    }
    r = requests.post(f"{LOCAL_PRINTER_URL}/print/orders", json=payload, timeout=30)
    r.raise_for_status()
    try:
        data = r.json() or {}
    except Exception:
        data = {}
    # Consider printed only if not explicitly skipped
    if not data.get("ok", True):
        return False
    if data.get("skipped_all"):
        return False
    return True


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


def _sumatra_print_pdf(pdf_path: str, printer: str = "", copies: int = 1) -> None:
    exe = _find_sumatra()
    if not exe:
        raise RuntimeError("SumatraPDF not found. Install it or set SUMATRA_PATH.")
    copies = max(1, int(copies or 1))
    if printer:
        cmd = [exe, "-print-to", printer, "-silent", "-exit-on-print",
               "-print-settings", f"copies={copies}", pdf_path]
    else:
        cmd = [exe, "-print-to-default", "-silent", "-exit-on-print",
               "-print-settings", f"copies={copies}", pdf_path]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    if p.returncode != 0:
        raise RuntimeError(f"SumatraPDF failed (code={p.returncode}): {(p.stderr or p.stdout or '').strip()}")


def _html_to_pdf(html_path: str, pdf_path: str) -> None:
    """Convert an HTML file to PDF using Edge/Chrome headless."""
    exe = _find_edge()
    if not exe:
        raise RuntimeError("Edge/Chrome not found for HTML-to-PDF conversion. Set EDGE_PATH.")
    cmd = [exe, "--headless", "--disable-gpu", "--no-sandbox",
           f"--print-to-pdf={pdf_path}", f"file:///{html_path.replace(os.sep, '/')}"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) == 0:
        raise RuntimeError(f"HTML-to-PDF failed: {(p.stderr or p.stdout or 'no output').strip()}")


def print_label(delivery_order_id: str) -> bool:
    """Download a delivery label and print it silently."""
    url = f"{RELAY_URL}/api/delivery-label/{delivery_order_id}"
    try:
        r = requests.get(url, params={"format": "pdf", "autoprint": "false"}, timeout=30)
        r.raise_for_status()
    except Exception as e:
        print(f"  Failed to fetch label (PDF attempt): {e}")
        try:
            r = requests.get(url, params={"autoprint": "false"}, timeout=30)
            r.raise_for_status()
        except Exception as e2:
            print(f"  Failed to fetch label (HTML fallback): {e2}")
            return False

    content_type = (r.headers.get("content-type") or "").lower()
    tmp_dir = tempfile.mkdtemp(prefix="label-print-")
    try:
        if "application/pdf" in content_type:
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(pdf_path, "wb") as f:
                f.write(r.content)
            _sumatra_print_pdf(pdf_path, LABEL_PRINTER)
            print(f"  Printed label PDF for order {delivery_order_id}")
            return True
        else:
            html_path = os.path.join(tmp_dir, "label.html")
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(html_path, "wb") as f:
                f.write(r.content)
            _html_to_pdf(html_path, pdf_path)
            _sumatra_print_pdf(pdf_path, LABEL_PRINTER)
            print(f"  Printed label (HTML→PDF) for order {delivery_order_id}")
            return True
    except Exception as e:
        print(f"  Label print error: {e}")
        return False
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    print("Agent poller started.")
    print(f"  SumatraPDF: {_find_sumatra() or 'NOT FOUND'}")
    print(f"  Edge/Chrome: {_find_edge() or 'NOT FOUND'}")
    while True:
        try:
            jobs = pull_jobs()
            if jobs:
                for job in jobs:
                    job_type = job.get("type", "order")

                    if job_type == "label":
                        dlv_id = job.get("delivery_order_id", "")
                        print(f"Label job: delivery_order_id={dlv_id}")
                        try:
                            ok = print_label(dlv_id)
                        except Exception as le:
                            print(f"  Label print exception: {le}")
                            ok = False
                        if ok:
                            ack_job(job.get("job_id"))
                        else:
                            print("  Label print failed; will not re-enqueue")
                        continue

                    orders = job.get("orders", [])
                    copies = int(job.get("copies", 1))
                    store = job.get("store")
                    print(f"Printing {orders} x{copies}")
                    printed = False
                    try:
                        printed = print_locally(orders, copies, store)
                    except Exception as pe:
                        print("Local print error:", pe)
                        printed = False
                    if printed:
                        ack_job(job.get("job_id"))
                    else:
                        requeued = requeue_job(orders, copies, store)
                        if not requeued:
                            print("Re-enqueue failed; will retry on next poll")
            time.sleep(PULL_INTERVAL_SEC)
        except Exception as e:
            print("Error:", e)
            time.sleep(3)


if __name__ == "__main__":
    main()


