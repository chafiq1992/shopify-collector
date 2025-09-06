import os, time, uuid
from typing import List, Optional, Dict
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

# -------- Config --------
API_KEY = os.getenv("API_KEY", "CHANGE_ME_API_KEY")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "").split(",") if os.getenv("ALLOWED_ORIGINS") else ["*"]

# Quick in-memory queue { pc_id -> [jobs] }
JOBS: Dict[str, List[dict]] = {}

app = FastAPI(title="Print Relay")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EnqueueBody(BaseModel):
    pc_id: str
    orders: List[str] = []
    copies: int = 1
    pdf_url: Optional[str] = None
    store: Optional[str] = None


class AckBody(BaseModel):
    pc_id: str
    secret: str
    job_id: str


# Register PCs statically (pc_id -> secret)
PCS = {
    os.getenv("PC_ID_1", "pc-lab-1"): os.getenv("PC_SECRET_1", "SECRET1"),
    os.getenv("PC_ID_2", "pc-lab-2"): os.getenv("PC_SECRET_2", "SECRET2"),
}


def _require_pc(pc_id: str, secret: str):
    expect = PCS.get(pc_id)
    if not expect or secret != expect:
        raise HTTPException(status_code=401, detail="unauthorized")


def _require_api_key(x_api_key: Optional[str]):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")


@app.post("/enqueue")
def enqueue(job: EnqueueBody, x_api_key: Optional[str] = Header(default=None)):
    _require_api_key(x_api_key)
    if job.pc_id not in PCS:
        raise HTTPException(status_code=404, detail="unknown pc_id")
    jid = str(uuid.uuid4())
    payload = {
        "job_id": jid,
        "ts": int(time.time()),
        "orders": [str(o).lstrip("#") for o in (job.orders or [])],
        "copies": max(1, job.copies),
        "pdf_url": job.pdf_url or None,
        "store": (job.store or None),
    }
    JOBS.setdefault(job.pc_id, []).append(payload)
    return {"ok": True, "job_id": jid, "queued": len(JOBS[job.pc_id])}


@app.get("/pull")
def pull(pc_id: str, secret: str, max_items: int = 5):
    _require_pc(pc_id, secret)
    q = JOBS.get(pc_id, [])
    if not q:
        return {"ok": True, "jobs": []}
    out = q[:max_items]
    JOBS[pc_id] = q[max_items:]
    return {"ok": True, "jobs": out}


@app.post("/ack")
def ack(b: AckBody):
    _require_pc(b.pc_id, b.secret)
    return {"ok": True}


