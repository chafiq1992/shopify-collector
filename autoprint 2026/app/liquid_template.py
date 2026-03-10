from pathlib import Path
from typing import Any, Dict
from liquid import Environment
from urllib.parse import quote
from datetime import datetime

def money_filter(v: Any, suffix: str = " DH"):
    try:
        n = float(v)
        return f"{n:,.2f}{suffix}"
    except Exception:
        return f"{v}{suffix}"

def url_encode_filter(v: Any):
    return quote(str(v))

def date_filter(v: Any, fmt: str = "%Y-%m-%d"):
    try:
        d = datetime.fromisoformat(str(v).replace("Z","+00:00"))
        return d.strftime(fmt)
    except Exception:
        return str(v)

def format_address(addr: Dict[str, Any] | None):
    if not addr:
        return ""
    parts = []
    a1 = addr.get("address1") or ""
    a2 = addr.get("address2") or ""
    line1 = a1 + ((" " + a2) if a2 else "")
    parts.append(line1.strip())
    city_zip = f"{addr.get('city','')} {addr.get('zip','')}".strip()
    if city_zip: parts.append(city_zip)
    prov_cty = f"{addr.get('province','')}, {addr.get('country','')}".strip(", ")
    if prov_cty: parts.append(prov_cty)
    return "<br/>".join(parts)

def img_url_filter(src: Any, size: str = ""):
    # Best-effort: return original URL; Shopify-specific sizing is not handled.
    return str(src or "")

env = Environment()
env.add_filter("money", money_filter)
env.add_filter("url_encode", url_encode_filter)
env.add_filter("date", date_filter)
env.add_filter("format_address", format_address)
env.add_filter("img_url", img_url_filter)

def render_liquid(template_path: Path, context: Dict[str, Any]) -> str:
    source = template_path.read_text(encoding="utf-8")
    if "order" in context and isinstance(context["order"], dict):
        suffix = context["order"].get("currency_suffix", " DH")
        env.add_filter("money", lambda v: money_filter(v, suffix))
    tpl = env.from_string(source)
    return tpl.render(**context)
