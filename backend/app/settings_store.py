from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AppSetting


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


