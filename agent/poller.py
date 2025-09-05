import os
import time
import requests

RELAY_URL = os.getenv("RELAY_URL", "http://localhost:8080")
PC_ID = os.getenv("PC_ID", "pc-lab-1")
PC_SECRET = os.getenv("PC_SECRET", "SECRET1")
LOCAL_PRINTER_URL = os.getenv("LOCAL_PRINTER_URL", "http://127.0.0.1:8787")

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


def print_locally(orders, copies):
    # Call your existing local receiver on this PC
    r = requests.post(
        f"{LOCAL_PRINTER_URL}/print/orders",
        json={"orders": orders, "copies": copies},
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
                    print(f"Printing {orders} x{copies}")
                    print_locally(orders, copies)
                    ack_job(job.get("job_id"))
            time.sleep(PULL_INTERVAL_SEC)
        except Exception as e:
            print("Error:", e)
            time.sleep(3)


if __name__ == "__main__":
    main()


