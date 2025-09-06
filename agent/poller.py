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


def print_locally(orders, copies, store: str | None = None):
    # Call your existing local receiver on this PC
    # Try to pull overrides from backend to enrich customer data only for irranova
    overrides = {}
    if (store or "").strip().lower() == "irranova":
        try:
            joined = ",".join([str(o).lstrip("#") for o in orders])
            headers = {"x-api-key": API_KEY} if API_KEY else {}
            ro = requests.get(f"{RELAY_URL}/api/overrides", params={"orders": joined}, headers=headers, timeout=10)
            ro.raise_for_status()
            overrides = (ro.json() or {}).get("overrides") or {}
        except Exception:
            overrides = {}

    r = requests.post(
        f"{LOCAL_PRINTER_URL}/print/orders",
        json={"orders": orders, "copies": copies, **({"store": store} if store else {}), **({"overrides": overrides} if overrides else {})},
        timeout=30,
    )
    r.raise_for_status()


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
                    print_locally(orders, copies, store)
                    ack_job(job.get("job_id"))
            time.sleep(PULL_INTERVAL_SEC)
        except Exception as e:
            print("Error:", e)
            time.sleep(3)


if __name__ == "__main__":
    main()


