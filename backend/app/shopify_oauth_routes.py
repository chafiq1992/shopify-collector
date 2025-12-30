from __future__ import annotations

import os
import re
import hmac
import hashlib
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .settings_store import get_shopify_oauth_record, set_shopify_oauth_record

router = APIRouter()


def _bool_env(name: str, default: bool = False) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _base_url() -> str:
    base = (os.environ.get("BASE_URL") or "").strip()
    if not base:
        raise HTTPException(status_code=500, detail="BASE_URL not configured")
    return base.rstrip("/")


def _oauth_scopes() -> str:
    scopes = (os.environ.get("SHOPIFY_OAUTH_SCOPES") or "").strip()
    if not scopes:
        raise HTTPException(status_code=500, detail="SHOPIFY_OAUTH_SCOPES not configured")
    # Shopify expects comma-separated
    return ",".join([s.strip() for s in scopes.split(",") if s.strip()])


def _oauth_enabled_stores() -> set[str]:
    raw = (os.environ.get("SHOPIFY_OAUTH_STORES") or "").strip()
    if not raw:
        return {"irranova"}  # safe default
    out: set[str] = set()
    for part in raw.split(","):
        p = (part or "").strip().lower()
        if p:
            out.add(p)
    return out


def _require_oauth_enabled_store(store_label: str) -> str:
    s = (store_label or "").strip().lower()
    if s not in ("irrakids", "irranova"):
        raise HTTPException(status_code=400, detail="invalid store")
    if s not in _oauth_enabled_stores():
        raise HTTPException(status_code=400, detail="oauth not enabled for this store")
    return s


_SHOP_RE = re.compile(r"([a-z0-9][a-z0-9-]*\.myshopify\.com)")


def normalize_shop_domain(raw: str) -> str:
    """
    Strictly normalize the shop domain (repairing common paste bugs like:
    'foo.myshopify.commyshopify.com' -> 'foo.myshopify.com').
    """
    s = (raw or "").strip().lower()
    if not s:
        raise HTTPException(status_code=400, detail="missing shop")

    # If user pasted a URL, extract host portion
    host = s
    try:
        if "://" in s:
            u = urllib.parse.urlparse(s)
            host = (u.netloc or u.path or "").strip().lower()
    except Exception:
        host = s

    # Remove path/query fragments if any remain
    host = host.split("/")[0].split("?")[0].split("#")[0].strip().lower()

    m = _SHOP_RE.search(host) or _SHOP_RE.search(s)
    if not m:
        raise HTTPException(status_code=400, detail="invalid shop (expected *.myshopify.com)")
    return m.group(1)


def _state_secret() -> str:
    sec = (os.environ.get("OAUTH_STATE_SECRET") or "").strip()
    if sec:
        return sec
    # fallback to JWT_SECRET used by app auth
    sec = (os.environ.get("JWT_SECRET") or "").strip()
    if sec:
        return sec
    raise HTTPException(status_code=500, detail="OAUTH_STATE_SECRET (or JWT_SECRET) not configured")


def _now_ts() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def sign_state(payload: Dict[str, Any]) -> str:
    return jwt.encode(payload, _state_secret(), algorithm="HS256")


def verify_state(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, _state_secret(), algorithms=["HS256"])
    except JWTError:
        raise HTTPException(status_code=400, detail="invalid state")


def _client_creds() -> Tuple[str, str]:
    cid = (os.environ.get("SHOPIFY_CLIENT_ID") or "").strip()
    sec = (os.environ.get("SHOPIFY_CLIENT_SECRET") or "").strip()
    if not cid or not sec:
        raise HTTPException(status_code=500, detail="SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET not configured")
    return cid, sec


def _canonical_hmac_msg(qp: List[Tuple[str, str]]) -> str:
    # Exclude hmac + signature; keep other keys (including host) if present.
    keep = [(k, v) for (k, v) in qp if k not in ("hmac", "signature")]
    keep.sort(key=lambda kv: (kv[0], kv[1]))
    return urllib.parse.urlencode(keep, doseq=True)


def _verify_shopify_hmac(*, request: Request, client_secret: str) -> Tuple[bool, Dict[str, Any]]:
    qp = [(k, str(v)) for (k, v) in request.query_params.multi_items()]
    provided = (request.query_params.get("hmac") or "").strip().lower()
    keys = sorted({k for (k, _) in qp})

    if not provided:
        return False, {"error": "invalid_hmac", "reason": "missing_hmac", "keys": keys, "raw_len": 0}

    msg = _canonical_hmac_msg(qp)
    expected = hmac.new(client_secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest().lower()
    if hmac.compare_digest(expected, provided):
        return True, {"ok": True}

    # Fallback canonicalization excluding host (some proxies mutate host param)
    qp_no_host = [(k, v) for (k, v) in qp if k != "host"]
    msg2 = _canonical_hmac_msg(qp_no_host)
    expected2 = hmac.new(client_secret.encode("utf-8"), msg2.encode("utf-8"), hashlib.sha256).hexdigest().lower()
    if hmac.compare_digest(expected2, provided):
        return True, {"ok": True, "used_fallback": "exclude_host"}

    return False, {
        "error": "invalid_hmac",
        "keys": keys,
        "raw_len": len(msg),
    }


@router.get("/api/shopify/oauth/status")
async def oauth_status(
    store: str = Query(...),
    db: AsyncSession = Depends(get_session),
):
    s = (store or "").strip().lower()
    if s not in ("irrakids", "irranova"):
        raise HTTPException(status_code=400, detail="invalid store")
    rec = await get_shopify_oauth_record(db, s)
    if not rec:
        return {"connected": False, "shop": None, "scopes": None}
    return {
        "connected": bool((rec.get("access_token") or "").strip()) and bool((rec.get("shop") or "").strip()),
        "shop": rec.get("shop"),
        "scopes": rec.get("scopes"),
    }


@router.get("/api/shopify/oauth/start")
async def oauth_start(
    store: str = Query(..., description="Store label, e.g. irranova"),
    shop: str = Query(..., description="Shop domain, e.g. irranova.myshopify.com"),
):
    store_key = _require_oauth_enabled_store(store)
    shop_norm = normalize_shop_domain(shop)

    cid, _ = _client_creds()
    redirect_uri = f"{_base_url()}/api/shopify/oauth/callback"
    now = _now_ts()
    state = sign_state(
        {
            "store": store_key,
            "shop": shop_norm,
            "nonce": os.urandom(16).hex(),
            "iat": now,
            "exp": now + 10 * 60,
        }
    )
    scope = _oauth_scopes()

    qs = urllib.parse.urlencode(
        {
            "client_id": cid,
            "scope": scope,
            "redirect_uri": redirect_uri,
            "state": state,
        }
    )
    url = f"https://{shop_norm}/admin/oauth/authorize?{qs}"
    return RedirectResponse(url=url, status_code=302)


@router.get("/api/shopify/oauth/callback")
async def oauth_callback(
    request: Request,
    state: str = Query(...),
    shop: str = Query(...),
    code: str = Query(...),
    db: AsyncSession = Depends(get_session),
):
    store_key = None
    shop_norm = normalize_shop_domain(shop)
    st = verify_state(state)
    store_key = _require_oauth_enabled_store(str(st.get("store") or ""))
    shop_in_state = normalize_shop_domain(str(st.get("shop") or ""))
    if not hmac.compare_digest(shop_in_state, shop_norm):
        raise HTTPException(status_code=400, detail="state/shop mismatch")

    cid, client_secret = _client_creds()
    skip_hmac = _bool_env("SHOPIFY_OAUTH_SKIP_HMAC", default=False)
    ok_hmac, debug = _verify_shopify_hmac(request=request, client_secret=client_secret)
    if (not ok_hmac) and (not skip_hmac):
        # Return debug JSON to help troubleshoot production mismatches
        out = {"error": "invalid_hmac", "shop": shop_norm}
        if isinstance(debug, dict):
            out.update(debug)
        return JSONResponse(out, status_code=400)
    if (not ok_hmac) and skip_hmac:
        # Still enforce signed state; skip only Shopify HMAC
        try:
            print("[Shopify OAuth][WARN] Skipping Shopify HMAC verification due to SHOPIFY_OAUTH_SKIP_HMAC=1")
        except Exception:
            pass

    token_url = f"https://{shop_norm}/admin/oauth/access_token"
    resp = requests.post(
        token_url,
        json={"client_id": cid, "client_secret": client_secret, "code": code},
        timeout=30,
    )
    try:
        resp.raise_for_status()
    except Exception:
        return JSONResponse(
            {
                "error": "token_exchange_failed",
                "status": resp.status_code,
                "shop": shop_norm,
                "body": (resp.text or "")[:2000],
            },
            status_code=502,
        )
    data = resp.json() if resp.content else {}
    access_token = (data.get("access_token") or "").strip()
    scopes = (data.get("scope") or "").strip()
    if not access_token:
        return JSONResponse({"error": "token_exchange_failed", "shop": shop_norm, "missing": "access_token"}, status_code=502)

    await set_shopify_oauth_record(db, store_key, shop=shop_norm, access_token=access_token, scopes=scopes)

    # Back to internal UI
    return RedirectResponse(url=f"/shopify-connect?store={urllib.parse.quote(store_key)}&connected=1", status_code=302)


