import os
import time
import requests

RELAY_URL = os.getenv("RELAY_URL", "http://localhost:8080")
PC_ID = os.getenv("PC_ID", "pc-lab-1")
PC_SECRET = os.getenv("PC_SECRET", "SECRET1")
LOCAL_PRINTER_URL = os.getenv("LOCAL_PRINTER_URL", "http://127.0.0.1:8787")
API_KEY = os.getenv("API_KEY", "")

PULL_INTERVAL_SEC = float(os.getenv("PULL_INTERVAL_SEC", "2"))


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


def main():
    print("Agent poller started.")
    while True:
        try:
            jobs = pull_jobs()
            if jobs:
                for job in jobs:
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
                        # If we couldn't print (e.g., missing customer info), re-enqueue for later
                        requeued = requeue_job(orders, copies, store)
                        if not requeued:
                            print("Re-enqueue failed; will retry on next poll")
            time.sleep(PULL_INTERVAL_SEC)
        except Exception as e:
            print("Error:", e)
            time.sleep(3)


if __name__ == "__main__":
    main()


