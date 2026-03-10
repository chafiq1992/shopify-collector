# app/main.py
from __future__ import annotations

import os, tempfile, json, shutil, traceback, threading, time, collections
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any
from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed
from datetime import datetime as _dt

import requests
import yaml
from fastapi import FastAPI, UploadFile, File, Form, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, Response
from pydantic import BaseModel

from .print_utils import print_pdf_silent, html_to_pdf, set_post_print_delay
from .shopify import fetch_order_by_number, hydrate_order_for_template, ensure_variant_images
from .liquid_template import render_liquid
from starlette.staticfiles import StaticFiles
import base64

# ----------------- config & app -----------------
BASE = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE / "config.yaml"

def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

app = FastAPI(title="Windows Print Receiver", version="1.0")

def setup_cors(app: FastAPI):
    try:
        cfg = load_config()
        origins = cfg.get("allowed_origins", [])
    except Exception:
        origins = []
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins or ["*"],   # tighten to your domains in prod
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

setup_cors(app)
# Ensure logos directory exists and serve it for browser previews
(BASE / "logos").mkdir(exist_ok=True)
app.mount("/logos", StaticFiles(directory=str(BASE / "logos")), name="logos")

# ----------------- models -----------------
class PDFUrlBody(BaseModel):
    pdf_url: str
    copies: int = 1
    printer: Optional[str] = None
    store: Optional[str] = None

class OrdersBody(BaseModel):
    orders: List[str]
    copies: int = 1
    printer: Optional[str] = None
    store: Optional[str] = None

# ----------------- helpers -----------------
def check_secret(cfg: dict, x_secret: Optional[str]):
    expect = (cfg or {}).get("shared_secret")
    if expect and x_secret != expect:
        raise ValueError("Unauthorized (bad x-secret)")

def _is_forward_mode(cfg: Dict[str, Any]) -> bool:
    try:
        return str((cfg or {}).get("print_mode") or "local").strip().lower() == "forward"
    except Exception:
        return False

def _forward_base_url(cfg: Dict[str, Any]) -> str:
    return str((cfg or {}).get("forward_to_url") or "").strip().rstrip("/")

def _forward_timeout(cfg: Dict[str, Any]) -> int:
    try:
        return int((cfg or {}).get("forward_timeout_seconds") or 90)
    except Exception:
        return 90

def _forward_secret(cfg: Dict[str, Any]) -> str:
    # Prefer explicit forward_secret; fallback to shared_secret
    return str((cfg or {}).get("forward_secret") or (cfg or {}).get("shared_secret") or "").strip()

def _forward_headers(cfg: Dict[str, Any]) -> Dict[str, str]:
    h: Dict[str, str] = {"X-Print-Forwarded": "1"}
    sec = _forward_secret(cfg)
    if sec:
        h["X-Secret"] = sec
    return h

def _forward_json(cfg: Dict[str, Any], path: str, payload: Dict[str, Any]):
    base = _forward_base_url(cfg)
    if not base:
        raise ValueError("print_mode=forward but forward_to_url is empty")
    url = f"{base}{path}"
    r = requests.post(url, json=payload, headers=_forward_headers(cfg), timeout=_forward_timeout(cfg))
    # Bubble up remote errors
    if r.status_code >= 400:
        raise RuntimeError(f"Forward failed ({r.status_code}): {r.text[:500]}")
    try:
        return r.json()
    except Exception:
        return {"ok": True, "forwarded": True, "raw": r.text}

def _forward_multipart_pdf(cfg: Dict[str, Any], file: UploadFile, copies: int, printer: Optional[str], store: Optional[str]):
    base = _forward_base_url(cfg)
    if not base:
        raise ValueError("print_mode=forward but forward_to_url is empty")
    url = f"{base}/print/pdf-upload"
    content = file.file.read()
    files = {"file": (file.filename or "label.pdf", content, file.content_type or "application/pdf")}
    data = {
        "copies": str(int(copies or 1)),
    }
    if printer is not None:
        data["printer"] = printer
    if store is not None:
        data["store"] = store
    r = requests.post(url, files=files, data=data, headers=_forward_headers(cfg), timeout=_forward_timeout(cfg))
    if r.status_code >= 400:
        raise RuntimeError(f"Forward upload failed ({r.status_code}): {r.text[:500]}")
    try:
        return r.json()
    except Exception:
        return {"ok": True, "forwarded": True, "raw": r.text}

def _json_error(e: Exception, code: int = 400):
    return JSONResponse(
        status_code=code,
        content={
            "ok": False,
            "error": str(e),
            "trace": traceback.format_exc().splitlines()[-8:],
        },
    )

def _select_store(cfg: Dict[str, Any], store_key: Optional[str]) -> Tuple[str, str, str, str, str, str]:
    """
    Returns (shop, token, api_version, currency_suffix, template_name, printer_name)
    Supports both legacy single-store keys and new cfg["stores"][store_key].
    """
    # Defaults from legacy layout
    legacy = {
        "shop_domain": cfg.get("shop_domain", ""),
        "admin_api_token": cfg.get("admin_api_token", ""),
        "admin_api_version": cfg.get("admin_api_version", "2024-07"),
        "currency_suffix": cfg.get("currency_suffix", ""),
        "template": cfg.get("template", "label.liquid"),
        "printer_name": cfg.get("printer_name", ""),
    }

    stores = cfg.get("stores") or {}
    selected = None
    if stores:
        if store_key and store_key in stores:
            selected = stores[store_key]
        else:
            # first store in dict
            first_key = next(iter(stores.keys()))
            selected = stores[first_key]
    data = selected or legacy

    shop = data.get("shop_domain") or legacy["shop_domain"]
    token = data.get("admin_api_token") or legacy["admin_api_token"]
    api_version = data.get("admin_api_version") or legacy["admin_api_version"]
    currency_suffix = data.get("currency_suffix") or legacy["currency_suffix"]
    template_name = data.get("template") or legacy["template"] or "label.liquid"
    printer_name = data.get("printer_name") or legacy["printer_name"]
    printer_name = _normalize_printer_name(printer_name)
    return shop, token, api_version, currency_suffix, template_name, printer_name

def _normalize_printer_name(name: Optional[str]) -> str:
    n = (name or "").strip()
    if not n:
        return ""
    low = n.lower()
    if low in ("default", "system", "auto"):
        return ""
    if n.startswith("<") and n.endswith(">"):
        return ""
    return n

def _parse_order_number_int(order_number: str) -> int:
    try:
        s = str(order_number).lstrip("#").strip()
        digits = "".join(ch for ch in s if ch.isdigit())
        return int(digits) if digits else -1
    except Exception:
        return -1

def _select_store_for_order(cfg: Dict[str, Any], order_number: str, preferred_store: Optional[str]) -> Tuple[str, str, str, str, str, str]:
    # If explicit store is given, honor it
    if preferred_store:
        return _select_store(cfg, preferred_store)

    # Try routing rules in config
    rules = ((cfg.get("routing") or {}).get("by_order_number") or [])
    if rules:
        num = _parse_order_number_int(order_number)
        for rule in rules:
            store_key = (rule or {}).get("store")
            if not store_key:
                continue
            min_v = rule.get("min")
            max_v = rule.get("max")
            if (min_v is None or (isinstance(min_v, int) and num >= min_v)) and (max_v is None or (isinstance(max_v, int) and num <= max_v)):
                return _select_store(cfg, store_key)

    # Fallback simple heuristic if two stores are present
    stores = list((cfg.get("stores") or {}).keys())
    if len(stores) >= 2:
        num = _parse_order_number_int(order_number)
        # Heuristic: >=100000 -> first store, else second
        if num >= 100000:
            return _select_store(cfg, stores[0])
        else:
            return _select_store(cfg, stores[1])

    # Default: legacy / first store
    return _select_store(cfg, None)

# ----------------- overrides bridging (collector -> local) -----------------
def _collector_base_url(cfg: Dict[str, Any]) -> str:
    # Reuse relay_url as the collector base; both run on the same service
    return (cfg.get("relay_url") or "").strip().rstrip("/")

def fetch_overrides_from_collector(cfg: Dict[str, Any], order_numbers: list[str], store: Optional[str]) -> dict[str, dict]:
    base = _collector_base_url(cfg)
    if not base or not order_numbers:
        return {}
    try:
        joined = ",".join(str(n).lstrip("#") for n in order_numbers)
        params = {"orders": joined}
        if store:
            params["store"] = store
        r = requests.get(f"{base}/api/overrides", params=params, timeout=20)
        r.raise_for_status()
        js = r.json() or {}
        return js.get("overrides") or {}
    except Exception:
        return {}

def _merge_shipping_address(order: dict, override_addr: dict) -> dict:
    if not override_addr:
        return order
    sa = dict(order.get("shipping_address") or {})
    # Prefer override values when present
    for key in ("name","address1","address2","city","zip","province","country","phone"):
        val = override_addr.get(key)
        if val:
            sa[key] = val
    order["shipping_address"] = sa
    return order

def apply_overrides(order: dict, override: dict | None) -> dict:
    if not override:
        return order
    try:
        # email / phone at top-level
        for k in ("email", "phone", "tags"):
            v = override.get(k)
            if v:
                order[k] = v
        # customer display name (template currently does not use, but keep consistent)
        cust = (override.get("customer") or {})
        if cust:
            oc = dict(order.get("customer") or {})
            if cust.get("displayName"):
                oc["first_name"] = (cust.get("displayName") or "").strip()
            if cust.get("email"):
                oc["email"] = cust.get("email")
            if cust.get("phone"):
                oc["phone"] = cust.get("phone")
            order["customer"] = oc
        # shipping address mapping
        order = _merge_shipping_address(order, override.get("shippingAddress") or {})
    except Exception:
        return order
    return order

# ----------------- rate limit helpers -----------------
def _sleep_for_retry(resp, default_delay: float):
    try:
        ra = (resp.headers.get("Retry-After") if resp and getattr(resp, "headers", None) else None)
        delay = float(ra) if ra else float(default_delay)
    except Exception:
        delay = float(default_delay)
    time.sleep(max(0.5, delay))

def _fetch_order_with_retry(shop: str, api_version: str, token: str, num: str, max_retries: int = 5):
    delay = 1.0
    last_exc: Exception | None = None
    for i in range(max(1, max_retries)):
        try:
            return fetch_order_by_number(shop, api_version, token, num)
        except Exception as e:
            resp = getattr(e, "response", None)
            status = None
            try:
                status = resp.status_code if resp is not None else None
            except Exception:
                status = None
            # 429: backoff and retry
            if status == 429 and i < max_retries - 1:
                _sleep_for_retry(resp, delay)
                delay = min(delay * 2.0, 8.0)
                continue
            # 5xx: transient
            if status and 500 <= int(status) < 600 and i < max_retries - 1:
                time.sleep(delay)
                delay = min(delay * 2.0, 8.0)
                continue
            last_exc = e
            break
    if last_exc:
        raise last_exc
    raise RuntimeError("Failed to fetch order after retries")

_shopify_sem_lock = threading.Lock()
_shopify_sem_size = 1
_shopify_sem = threading.BoundedSemaphore(_shopify_sem_size)

def _set_shopify_request_concurrency(value: Any):
    global _shopify_sem_size, _shopify_sem
    try:
        n = max(1, int(value or 1))
    except Exception:
        n = 1
    with _shopify_sem_lock:
        if n != _shopify_sem_size:
            _shopify_sem = threading.BoundedSemaphore(n)
            _shopify_sem_size = n

def _extract_body(html: str, start: str = "<body>", end: str = "</body>") -> str:
    s, e = html.find(start), html.rfind(end)
    return html[s + len(start) : e] if s != -1 and e != -1 and e > s else html

def _extract_style(html: str) -> str:
    s, e = html.find("<style>"), html.rfind("</style>")
    return html[s + 7 : e] if s != -1 and e != -1 and e > s else ""

def _process_single_order(num: str, cfg: dict, overrides_map: dict, store_override: Optional[str]) -> Tuple[str, str, str]:
    """Returns (body_html, style, store_printer). Used for parallel order processing."""
    shop, token, api_version, currency_suffix, template_name, store_printer = _select_store_for_order(cfg, str(num), store_override)
    tpl_path = BASE / "templates" / template_name
    with _shopify_sem:
        order = _fetch_order_with_retry(shop, api_version, token, str(num).lstrip("#"), max_retries=7)
        order = ensure_variant_images(order, shop, api_version, token)
    ov = overrides_map.get(str(num).lstrip("#")) if overrides_map else None
    if ov:
        order = apply_overrides(order, ov)
    order = hydrate_order_for_template(order, currency_suffix=currency_suffix)
    logos_dir = BASE / "logos"
    try:
        logos_available = [p.stem.lower() for p in logos_dir.glob("*.png")]
    except Exception:
        logos_available = []
    order_qr_src = _qr_data_uri(str(order.get("order_number") or ""), size=280)
    wa_qr_src = _qr_data_uri("https://wa.me/212677624078", size=170)
    html = render_liquid(tpl_path, {
        "order": order,
        "logos_base": logos_dir.as_uri(),
        "logos_available": logos_available,
        "order_qr_src": order_qr_src,
        "wa_qr_src": wa_qr_src,
    })
    return _extract_body(html), _extract_style(html), store_printer or ""

# ----------------- batching helper -----------------
def _chunked(seq, size: int):
    try:
        n = int(size)
    except Exception:
        n = 0
    if not seq or n <= 1:
        yield list(seq or [])
        return
    buf = []
    for x in seq:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf

# ----------------- routes -----------------
@app.get("/health")
def health():
    return {"ok": True}

@app.get("/status")
def print_queue_status():
    """Live print queue: active jobs, recent history, stats."""
    active, history, stats = _pq.snapshot()
    return {
        "ok": True,
        "stats": stats,
        "active": [
            {"job_id": e.job_id, "kind": e.kind, "desc": e.desc,
             "state": e.state, "elapsed_s": round((_dt.now() - e.t0).total_seconds(), 1)}
            for e in active
        ],
        "recent": [
            {"job_id": e.job_id, "kind": e.kind, "desc": e.desc,
             "state": e.state, "elapsed_s": round((e.t1 - e.t0).total_seconds(), 1) if e.t1 else 0,
             "error": e.error}
            for e in history
        ],
    }

@app.get("/preview/order")
def preview_order(number: str, store: Optional[str] = None, x_secret: Optional[str] = Header(default=None)):
    """
    Render the label HTML for a single Shopify order number for quick preview in a browser.
    """
    try:
        cfg = load_config()
        check_secret(cfg, x_secret)
        shop, token, api_version, currency_suffix, template_name, _ = _select_store_for_order(cfg, str(number), store)
        tpl_path = BASE / "templates" / template_name
        order = fetch_order_by_number(shop, api_version, token, str(number).lstrip("#"))
        # Apply overrides if available
        overrides_map = fetch_overrides_from_collector(cfg, [str(number)], store)
        ov = overrides_map.get(str(number).lstrip("#")) if overrides_map else None
        if ov:
            order = apply_overrides(order, ov)
        order = hydrate_order_for_template(order, currency_suffix=currency_suffix)
        order = ensure_variant_images(order, shop, api_version, token)
        logos_dir = BASE / "logos"
        try:
            logos_available = [p.stem.lower() for p in logos_dir.glob("*.png")]
        except Exception:
            logos_available = []
        # Provide embedded QR data URIs for reliable rendering
        order_qr_src = _qr_data_uri(str(order.get("order_number") or ""), size=280)
        wa_qr_src = _qr_data_uri("https://wa.me/212677624078", size=170)
        html = render_liquid(
            tpl_path,
            {
                "order": order,
                "logos_base": "/logos",
                "logos_available": logos_available,
                "order_qr_src": order_qr_src,
                "wa_qr_src": wa_qr_src,
            },
        )
        return HTMLResponse(content=html)
    except Exception as e:
        return _json_error(e)

@app.get("/qr")
def generate_qr(text: str = Query(...), size: int = Query(170)):
    """
    Generate a QR code PNG locally to avoid external services.
    """
    try:
        import qrcode
        from io import BytesIO
        from PIL import Image
    except Exception as e:
        return _json_error(Exception("QR dependencies missing. Please install 'qrcode' and 'Pillow'."), 500)
    try:
        qr = qrcode.QRCode(border=1, box_size=4)
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        # Resize to requested square size (pixels)
        size_px = max(16, min(int(size or 170), 1024))
        img = img.resize((size_px, size_px), Image.NEAREST)
        buf = BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return Response(content=buf.getvalue(), media_type="image/png")
    except Exception as e:
        return _json_error(e, 500)

def _qr_data_uri(text: str, size: int = 170) -> str:
    """
    Generate a QR code as a data:image/png;base64 URI for embedding in HTML.
    """
    try:
        import qrcode
        from io import BytesIO
        from PIL import Image
    except Exception:
        # Fallback to external service if local deps missing
        safe = requests.utils.quote(str(text) if text is not None else "")
        s = max(16, min(int(size or 170), 1024))
        return f"https://quickchart.io/barcode?type=qrcode&text={safe}&size={s}"
    size_px = max(16, min(int(size or 170), 1024))
    qr = qrcode.QRCode(border=1, box_size=4)
    qr.add_data(text or "")
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img = img.resize((size_px, size_px), Image.NEAREST)
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"

@app.post("/print/pdf")
def print_pdf_url(
    b: PDFUrlBody,
    x_secret: Optional[str] = Header(default=None),
    x_print_forwarded: Optional[str] = Header(default=None),
):
    try:
        cfg = load_config()
        check_secret(cfg, x_secret)
        if _is_forward_mode(cfg):
            if x_print_forwarded:
                raise ValueError("Forward loop detected (already forwarded)")
            return _forward_json(cfg, "/print/pdf", b.model_dump())
        # store is irrelevant for direct PDF printing except printer selection
        _, _, _, _, _, store_printer = _select_store(cfg, b.store)
        requested_printer = _normalize_printer_name(b.printer)

        r = requests.get(b.pdf_url, timeout=60)
        r.raise_for_status()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(r.content)
            tmp.flush()
            pdf_path = tmp.name
        try:
            print_pdf_silent(
                pdf_path,
                printer=requested_printer or store_printer or _normalize_printer_name(cfg.get("printer_name")),
                sumatra_path=cfg.get("sumatra_path"),
                copies=b.copies,
            )
            return {"ok": True}
        finally:
            try: os.remove(pdf_path)
            except: pass
    except Exception as e:
        return _json_error(e)

@app.post("/print/pdf-upload")
def print_pdf_upload(
    file: UploadFile = File(...),
    copies: int = Form(1),
    printer: Optional[str] = Form(None),
    store: Optional[str] = Form(None),
    x_secret: Optional[str] = Header(default=None),
    x_print_forwarded: Optional[str] = Header(default=None),
):
    try:
        cfg = load_config()
        check_secret(cfg, x_secret)
        if _is_forward_mode(cfg):
            if x_print_forwarded:
                raise ValueError("Forward loop detected (already forwarded)")
            return _forward_multipart_pdf(cfg, file=file, copies=copies, printer=printer, store=store)
        _, _, _, _, _, store_printer = _select_store(cfg, store)
        requested_printer = _normalize_printer_name(printer)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(file.file.read())
            tmp.flush()
            pdf_path = tmp.name
        try:
            print_pdf_silent(
                pdf_path,
                printer=requested_printer or store_printer or _normalize_printer_name(cfg.get("printer_name")),
                sumatra_path=cfg.get("sumatra_path"),
                copies=int(copies),
            )
            return {"ok": True}
        finally:
            try: os.remove(pdf_path)
            except: pass
    except Exception as e:
        return _json_error(e)

@app.post("/print/orders")
def print_orders(
    b: OrdersBody,
    x_secret: Optional[str] = Header(default=None),
    x_print_forwarded: Optional[str] = Header(default=None),
):
    try:
        cfg = load_config()
        _set_shopify_request_concurrency(cfg.get("shopify_request_concurrency", 1))
        check_secret(cfg, x_secret)
        if _is_forward_mode(cfg):
            if x_print_forwarded:
                raise ValueError("Forward loop detected (already forwarded)")
            return _forward_json(cfg, "/print/orders", b.model_dump())

        max_per_batch = int(cfg.get("max_orders_per_batch", 0) or 0)
        order_groups = list(_chunked(b.orders or [], max_per_batch)) if (b.orders and max_per_batch and max_per_batch > 1) else [b.orders or []]
        fetch_workers = int(cfg.get("fetch_order_workers", 4))
        results = []
        overrides_map = fetch_overrides_from_collector(cfg, b.orders or [], b.store)
        chosen_printer = _normalize_printer_name(b.printer)

        for group in order_groups:
            if not group:
                continue
            with ThreadPoolExecutor(max_workers=fetch_workers) as pool:
                futures = [pool.submit(_process_single_order, str(num), cfg, overrides_map, b.store) for num in group]
                order_results = [f.result() for f in futures]
            bodies = [r[0] for r in order_results]
            first_style = (order_results[0][1] if order_results else "") or "@page { size: 100mm 100mm; margin: 0; }"
            if not chosen_printer:
                chosen_printer = next((r[2] for r in order_results if r[2]), "")
            results.extend([{"order": num, "prepared": True} for num in group])

            # Build combined HTML with page breaks for this group
            if not bodies:
                # No printable bodies in this group (likely all skipped) → skip PDF creation
                continue
            combined = (
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
                + "<style>" + (first_style or "@page { size: 100mm 100mm; margin: 0; }") + "</style>"
                + "<style>.page-break{ page-break-after: always; }</style>"
                + "</head><body>"
                + ("<div>" + "</div><div class=\"page-break\"></div><div>".join(bodies) + "</div>")
                + "</body></html>"
            )

            # HTML → single PDF for this group
            with tempfile.NamedTemporaryFile(delete=False, suffix=".html") as fhtml:
                fhtml.write(combined.encode("utf-8"))
                fhtml.flush()
                out_pdf = fhtml.name.replace(".html", ".pdf")

            html_to_pdf(
                fhtml.name,
                out_pdf,
                chrome_path=cfg.get("chrome_path"),
                edge_path=cfg.get("edge_path"),
            )

            # Print this group's PDF
            print_pdf_silent(
                out_pdf,
                printer=chosen_printer or _normalize_printer_name(cfg.get("printer_name")),
                sumatra_path=cfg.get("sumatra_path"),
                copies=b.copies,
            )

            # cleanup
            try: os.remove(fhtml.name)
            except: pass
            try: os.remove(out_pdf)
            except: pass
            time.sleep(0.3)

        return {"ok": True, "results": results, "combined": True}
    except Exception as e:
        return _json_error(e)

# =====================================================================
#  PRINT QUEUE TRACKER  (thread-safe job tracking + console dashboard)
# =====================================================================
class _JobEntry:
    __slots__ = ("job_id", "kind", "desc", "state", "t0", "t1", "error")
    def __init__(self, job_id: str, kind: str, desc: str):
        self.job_id, self.kind, self.desc = job_id, kind, desc
        self.state = "queued"
        self.t0: _dt = _dt.now()
        self.t1: _dt | None = None
        self.error = ""

class _PrintQueue:
    def __init__(self, history_size: int = 200):
        self._lock = threading.Lock()
        self._active: Dict[str, _JobEntry] = {}
        self._history: collections.deque = collections.deque(maxlen=history_size)
        self.printed = 0
        self.failed = 0
        self.total = 0
        self.started_at = _dt.now()

    def add(self, jid: str, kind: str, desc: str):
        with self._lock:
            self._active[jid] = _JobEntry(jid, kind, desc)
            self.total += 1

    def printing(self, jid: str):
        with self._lock:
            e = self._active.get(jid)
            if e:
                e.state = "printing"

    def done(self, jid: str):
        with self._lock:
            e = self._active.pop(jid, None)
            if e:
                e.state, e.t1 = "done", _dt.now()
                self._history.appendleft(e)
                self.printed += 1

    def fail(self, jid: str, error: str = ""):
        with self._lock:
            e = self._active.pop(jid, None)
            if e:
                e.state, e.t1, e.error = "failed", _dt.now(), error
                self._history.appendleft(e)
                self.failed += 1

    def snapshot(self):
        with self._lock:
            return (
                list(self._active.values()),
                list(self._history)[:15],
                {"printed": self.printed, "failed": self.failed, "total": self.total},
            )

_pq = _PrintQueue()

def _plog(msg: str):
    """Timestamped log for the poller engine."""
    print(f"[{_dt.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def _job_desc(job: dict) -> Tuple[str, str]:
    """Return (kind, short_description) for a relay job."""
    if job.get("type") == "label":
        return "LABEL", f"delivery #{job.get('delivery_order_id', '?')}"
    if job.get("pdf_url"):
        u = job["pdf_url"]
        return "PDF", (u[:45] + "..." if len(u) > 45 else u)
    orders = job.get("orders") or []
    if orders:
        nums = ", ".join(f"#{n}" for n in orders[:4])
        if len(orders) > 4:
            nums += f" +{len(orders) - 4}"
        return "ORDER", nums
    return "JOB", job.get("job_id", "?")[:16]

def _print_status_banner():
    """Print a summary dashboard to the console."""
    active, history, stats = _pq.snapshot()
    up = _dt.now() - _pq.started_at
    h, rem = divmod(int(up.total_seconds()), 3600)
    m, _ = divmod(rem, 60)
    bar = f"printed:{stats['printed']}  failed:{stats['failed']}  total:{stats['total']}  up:{h}h{m:02d}m"
    lines = [f"\n  ==== STATUS  {bar} ===="]
    if active:
        for e in active:
            sec = (_dt.now() - e.t0).total_seconds()
            lines.append(f"    [>>] {e.kind:6s} {e.desc}  ({e.state} {sec:.0f}s)")
    else:
        lines.append("    (idle -- waiting for print jobs)")
    if history:
        lines.append("  recent:")
        for e in history[:7]:
            sec = (e.t1 - e.t0).total_seconds() if e.t1 else 0
            tag = " OK" if e.state == "done" else " !!"
            suffix = f"  err: {e.error}" if e.error else ""
            lines.append(f"    [{tag}] {e.kind:6s} {e.desc}  ({sec:.1f}s){suffix}")
    lines.append("  ====")
    _plog("\n".join(lines))

# ----------------- delivery label printing (from delivery print-agent) -----------------
def _print_delivery_label(job: dict, cfg: dict):
    """Download and print a delivery label. Mirrors print-agent/poller.py logic."""
    relay = (cfg.get("relay_url") or "").strip().rstrip("/")
    if not relay:
        raise RuntimeError("relay_url not configured – cannot fetch delivery label")

    delivery_order_id = job.get("delivery_order_id", "")
    envoy_code = job.get("envoy_code", "") or ""

    url = f"{relay}/api/delivery-label/{delivery_order_id}"
    params: dict = {"autoprint": "false"}
    if envoy_code:
        params["envoy_code"] = envoy_code

    r = None
    try:
        req_params = {**params}
        if not envoy_code:
            req_params["format"] = "pdf"
        r = requests.get(url, params=req_params, timeout=30)
        r.raise_for_status()
    except Exception:
        r = requests.get(url, params=params, timeout=30)
        r.raise_for_status()

    content_type = (r.headers.get("content-type") or "").lower()
    label_printer = _normalize_printer_name(
        cfg.get("delivery_label_printer") or cfg.get("printer_name")
    )
    tmp_dir = tempfile.mkdtemp(prefix="label-")
    try:
        if "application/pdf" in content_type:
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(pdf_path, "wb") as f:
                f.write(r.content)
            print_pdf_silent(pdf_path, printer=label_printer, sumatra_path=cfg.get("sumatra_path"))
        else:
            html_path = os.path.join(tmp_dir, "label.html")
            pdf_path = os.path.join(tmp_dir, "label.pdf")
            with open(html_path, "wb") as f:
                f.write(r.content)
            html_to_pdf(html_path, pdf_path, chrome_path=cfg.get("chrome_path"), edge_path=cfg.get("edge_path"))
            print_pdf_silent(pdf_path, printer=label_printer, sumatra_path=cfg.get("sumatra_path"))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

# ----------------- optional: cloud relay poller -----------------
def _print_job(job: dict, cfg: dict):
    # Delivery label jobs (from the delivery app)
    if job.get("type") == "label":
        dlv_id = job.get("delivery_order_id", "")
        print(f"[poller] LABEL {dlv_id}")
        _print_delivery_label(job, cfg)
        return

    # If pdf_url present, print PDF directly
    if job.get("pdf_url"):
        r = requests.get(job["pdf_url"], timeout=60)
        r.raise_for_status()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(r.content); tmp.flush(); path = tmp.name
        try:
            print_pdf_silent(
                path,
                printer=cfg.get("printer_name"),
                sumatra_path=cfg.get("sumatra_path"),
                copies=int(job.get("copies", 1)),
            )
        finally:
            try: os.remove(path)
            except: pass
        return

    orders = job.get("orders") or []
    copies = int(job.get("copies", 1))
    if orders:
        chosen_printer = ""
        overrides_map = fetch_overrides_from_collector(cfg, [str(n) for n in orders], job.get("store"))
        max_per_batch = int(cfg.get("max_orders_per_batch", 0) or 0)
        order_groups = list(_chunked(orders, max_per_batch)) if (orders and max_per_batch and max_per_batch > 1) else [orders]
        fetch_workers = int(cfg.get("fetch_order_workers", 4))
        for group in order_groups:
            if not group:
                continue
            with ThreadPoolExecutor(max_workers=fetch_workers) as pool:
                futures = [pool.submit(_process_single_order, str(num), cfg, overrides_map, job.get("store")) for num in group]
                order_results = [f.result() for f in futures]
            bodies = [r[0] for r in order_results]
            first_style = (order_results[0][1] if order_results else "") or "@page { size: 100mm 100mm; margin: 0; }"
            if not chosen_printer:
                chosen_printer = next((r[2] for r in order_results if r[2]), "")

            combined = (
                "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
                + "<style>" + (first_style or "@page { size: 100mm 100mm; margin: 0; }") + "</style>"
                + "<style>.page-break{ page-break-after: always; }</style>"
                + "</head><body>"
                + ("<div>" + "</div><div class=\"page-break\"></div><div>".join(bodies) + "</div>")
                + "</body></html>"
            )

            with tempfile.NamedTemporaryFile(delete=False, suffix=".html") as fhtml:
                fhtml.write(combined.encode("utf-8")); fhtml.flush()
                out_pdf = fhtml.name.replace(".html", ".pdf")
            html_to_pdf(fhtml.name, out_pdf, chrome_path=cfg.get("chrome_path"), edge_path=cfg.get("edge_path"))
            print_pdf_silent(out_pdf, printer=chosen_printer or _normalize_printer_name(cfg.get("printer_name")), sumatra_path=cfg.get("sumatra_path"), copies=copies)
            try: os.remove(fhtml.name); os.remove(out_pdf)
            except: pass
            time.sleep(0.3)

def start_poller():
    try:
        cfg = load_config()
        set_post_print_delay(cfg.get("post_print_delay_seconds", 1.5))
        _set_shopify_request_concurrency(cfg.get("shopify_request_concurrency", 1))
    except Exception:
        _plog("[poller] cannot load config; disabled")
        return

    relay = (cfg.get("relay_url") or "").strip().rstrip("/")
    pc_id = cfg.get("pc_id")
    pc_secret = cfg.get("pc_secret")
    if not (relay and pc_id and pc_secret):
        _plog("[poller] relay disabled (set relay_url, pc_id, pc_secret in config.yaml)")
        return

    long_poll_sec = int(cfg.get("long_poll_seconds", 20))
    max_items     = int(cfg.get("max_items", 10))
    max_workers   = int(cfg.get("max_workers", 4))
    status_sec    = int(cfg.get("status_interval_seconds", 30))

    sess = requests.Session()

    # ── relay helpers (connection-pooled) ──
    def _pull() -> list:
        r = sess.get(
            f"{relay}/pull",
            params={"pc_id": pc_id, "secret": pc_secret,
                     "max_items": max_items, "wait": long_poll_sec},
            timeout=long_poll_sec + 15,
        )
        r.raise_for_status()
        return r.json().get("jobs", [])

    def _ack(jid: str):
        try:
            sess.post(f"{relay}/ack",
                       json={"pc_id": pc_id, "secret": pc_secret, "job_id": jid},
                       timeout=10)
        except Exception as e:
            _plog(f"  [WARN] ack failed {jid[:8]}: {e}")

    def _nack(jid: str):
        try:
            sess.post(f"{relay}/nack",
                       json={"pc_id": pc_id, "secret": pc_secret, "job_id": jid},
                       timeout=10)
        except Exception as e:
            _plog(f"  [WARN] nack failed {jid[:8]}: {e}")

    # ── job handler (runs inside a worker thread) ──
    def _handle(job: dict):
        jid = job.get("job_id", "?")
        kind, desc = _job_desc(job)
        _pq.add(jid, kind, desc)
        _pq.printing(jid)
        _plog(f"  [>>] {kind:6s} {desc}")
        try:
            try:
                cfg_now = load_config()
            except Exception:
                cfg_now = cfg
            _print_job(job, cfg_now)
            _ack(jid)
            _pq.done(jid)
            _plog(f"  [OK] {kind:6s} {desc}")
        except Exception as e:
            err = str(e)[:120]
            _plog(f"  [!!] {kind:6s} {desc} -- {err}")
            is_404 = "404" in str(e) or (getattr(getattr(e, "response", None), "status_code", 0) == 404)
            if is_404:
                _ack(jid)
                _plog(f"  [ACK] 404 - not retrying (resource not found)")
            else:
                _nack(jid)
            _pq.fail(jid, err)

    # ── main poller loop ──
    def _poller_loop():
        _plog("=" * 58)
        _plog("  AUTOPRINT ENGINE v2  (parallel + long-poll + reliable)")
        _plog("=" * 58)
        _plog(f"  Relay:       {relay}")
        _plog(f"  PC:          {pc_id}")
        _plog(f"  Workers:     {max_workers} parallel")
        _plog(f"  Long-poll:   {long_poll_sec}s  |  Max batch: {max_items}")
        _plog(f"  Status:      every {status_sec}s  |  HTTP: /status")
        _plog("=" * 58)
        _plog("Waiting for print jobs...\n")

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            while True:
                try:
                    jobs = _pull()
                    if not jobs:
                        continue
                    _plog(f"[PULL] {len(jobs)} job(s) received")
                    futs = {pool.submit(_handle, j): j for j in jobs}
                    for fut in _as_completed(futs, timeout=180):
                        try:
                            fut.result()
                        except Exception as e:
                            j = futs[fut]
                            jid = j.get("job_id", "")
                            _plog(f"  [ERR] worker crash {jid[:8]}: {e}")
                            _nack(jid)
                            _pq.fail(jid, str(e)[:80])

                except requests.exceptions.ConnectionError:
                    _plog("[NET] connection lost -- retry in 5s")
                    time.sleep(5)
                except requests.exceptions.Timeout:
                    pass
                except requests.exceptions.HTTPError as e:
                    st = getattr(getattr(e, "response", None), "status_code", 0)
                    if st == 401:
                        _plog("[AUTH] 401 Unauthorized -- check pc_id / pc_secret. Retry in 30s")
                        time.sleep(30)
                    else:
                        _plog(f"[HTTP] {e} -- retry in 5s")
                        time.sleep(5)
                except Exception as e:
                    _plog(f"[ERR] {e}")
                    time.sleep(2)

    # ── periodic status dashboard ──
    def _status_loop():
        while True:
            time.sleep(status_sec)
            _print_status_banner()

    threading.Thread(target=_poller_loop, daemon=True, name="autoprint-poller").start()
    threading.Thread(target=_status_loop, daemon=True, name="autoprint-status").start()

# start the engine (safe no-op if relay not configured)
start_poller()

# ----------------- runner -----------------
if __name__ == "__main__":
    import uvicorn
    try:
        cfg = load_config()
        host = cfg.get("host", "127.0.0.1")
        port = int(cfg.get("port", 8787))
    except Exception:
        host, port = "127.0.0.1", 8787
    uvicorn.run(app, host=host, port=port, log_level="info")
