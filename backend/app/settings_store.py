from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AppSetting


INVOICE_ROUTING_RULES_KEY = "invoice_routing_rules"
REGISTERED_SHOPIFY_STORES_KEY = "registered_shopify_stores"


async def get_setting(db: AsyncSession, key: str) -> Any:
    row = await db.scalar(select(AppSetting).where(AppSetting.key == key))
    return None if not row else row.value


async def set_setting(db: AsyncSession, key: str, value: Any) -> None:
    row = await db.scalar(select(AppSetting).where(AppSetting.key == key))
    if not row:
        row = AppSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value
    await db.commit()


def shopify_oauth_key(store_label: str) -> str:
    return f"shopify_oauth:{(store_label or '').strip().lower()}"


async def list_shopify_oauth_store_labels(db: AsyncSession) -> list[str]:
    prefix = "shopify_oauth:"
    rows = await db.execute(select(AppSetting.key).where(AppSetting.key.like(f"{prefix}%")))
    labels: list[str] = []
    for key in rows.scalars().all():
        label = str(key or "")[len(prefix):].strip().lower()
        if label:
            labels.append(label)
    return sorted(set(labels))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_shopify_oauth_record(db: AsyncSession, store_label: str) -> Optional[Dict[str, Any]]:
    val = await get_setting(db, shopify_oauth_key(store_label))
    if not isinstance(val, dict):
        return None
    return val  # type: ignore[return-value]


async def set_shopify_oauth_record(
    db: AsyncSession,
    store_label: str,
    *,
    shop: str,
    access_token: str,
    scopes: str,
) -> None:
    payload: Dict[str, Any] = {
        "shop": (shop or "").strip().lower(),
        "access_token": (access_token or "").strip(),
        "scopes": (scopes or "").strip(),
        "installed_at": now_iso(),
    }
    await set_setting(db, shopify_oauth_key(store_label), payload)


async def get_invoice_routing_rules(db: AsyncSession) -> List[Dict[str, str]]:
    from .invoice_routing import sanitize_rules

    value = await get_setting(db, INVOICE_ROUTING_RULES_KEY)
    return sanitize_rules(value if isinstance(value, list) else [])


async def set_invoice_routing_rules(db: AsyncSession, rules: Iterable[Any]) -> List[Dict[str, str]]:
    from .invoice_routing import sanitize_rules

    cleaned = sanitize_rules(rules)
    await set_setting(db, INVOICE_ROUTING_RULES_KEY, cleaned)
    return cleaned


async def list_registered_shopify_store_labels(db: AsyncSession) -> List[str]:
    value = await get_setting(db, REGISTERED_SHOPIFY_STORES_KEY)
    if not isinstance(value, list):
        return []
    labels = {str(item or "").strip().lower() for item in value if str(item or "").strip()}
    return sorted(labels)


async def register_shopify_store_label(db: AsyncSession, store_label: str) -> List[str]:
    labels = set(await list_registered_shopify_store_labels(db))
    labels.add(str(store_label or "").strip().lower())
    cleaned = sorted(label for label in labels if label)
    await set_setting(db, REGISTERED_SHOPIFY_STORES_KEY, cleaned)
    return cleaned


