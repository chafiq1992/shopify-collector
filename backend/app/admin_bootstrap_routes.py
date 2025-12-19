import os
import hmac
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import User
from .auth_routes import hash_password, get_current_user, require_admin

router = APIRouter()


def _bootstrap_settings():
    token = (os.environ.get("ADMIN_BOOTSTRAP_TOKEN") or "").strip()
    allow_existing = (os.environ.get("ADMIN_BOOTSTRAP_ALLOW_EXISTING") or "").strip() in ("1", "true", "TRUE", "yes", "on")
    return token, allow_existing


def _require_bootstrap_token(x_admin_bootstrap_token: Optional[str] = Header(default=None, alias="X-Admin-Bootstrap-Token")):
    token, _ = _bootstrap_settings()
    if not token:
        raise HTTPException(status_code=404, detail="bootstrap disabled")
    if not x_admin_bootstrap_token or not hmac.compare_digest(x_admin_bootstrap_token.strip(), token):
        raise HTTPException(status_code=401, detail="invalid bootstrap token")


class BootstrapAdminBody(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None


@router.get("/api/admin/bootstrap/status")
async def bootstrap_status():
    token, allow_existing = _bootstrap_settings()
    return {"enabled": bool(token), "allow_existing": bool(allow_existing)}


@router.post("/api/admin/bootstrap/set-admin")
async def bootstrap_set_admin(
    body: BootstrapAdminBody,
    db: AsyncSession = Depends(get_session),
    _: None = Depends(_require_bootstrap_token),
):
    token, allow_existing = _bootstrap_settings()
    # If an admin already exists, block unless explicitly allowed
    admin_count = await db.scalar(select(func.count()).select_from(User).where(User.role == "admin"))
    if (admin_count or 0) > 0 and not allow_existing:
        raise HTTPException(status_code=409, detail="admin already exists; set ADMIN_BOOTSTRAP_ALLOW_EXISTING=1 to override temporarily")

    email_norm = body.email.lower().strip()
    user = await db.scalar(select(User).where(User.email == email_norm))
    if not user:
        user = User(
            email=email_norm,
            name=(body.name or "").strip() or None,
            password_hash=hash_password(body.password),
            role="admin",
            is_active=True,
        )
        db.add(user)
    else:
        user.email = email_norm
        user.name = (body.name or user.name or "").strip() or None
        user.password_hash = hash_password(body.password)
        user.role = "admin"
        user.is_active = True

    await db.commit()
    await db.refresh(user)
    return {"ok": True, "admin": {"id": user.id, "email": user.email, "name": user.name, "role": user.role}, "bootstrap_enabled": bool(token)}


class AdminCreateUserBody(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None
    role: Optional[str] = None  # admin | collector


@router.post("/api/admin/users/create")
async def admin_create_user(
    body: AdminCreateUserBody,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    email_norm = body.email.lower().strip()
    exists = await db.scalar(select(User).where(User.email == email_norm))
    if exists:
        raise HTTPException(status_code=400, detail="email already exists")
    role = body.role if body.role in ("admin", "collector") else "collector"
    user = User(
        email=email_norm,
        name=(body.name or "").strip() or None,
        password_hash=hash_password(body.password),
        role=role,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {"ok": True, "user": {"id": user.id, "email": user.email, "name": user.name, "role": user.role}}


class AdminResetPasswordBody(BaseModel):
    email: EmailStr
    new_password: str


@router.post("/api/admin/users/reset-password")
async def admin_reset_password(
    body: AdminResetPasswordBody,
    db: AsyncSession = Depends(get_session),
    _: User = Depends(require_admin),
):
    email_norm = body.email.lower().strip()
    user = await db.scalar(select(User).where(User.email == email_norm))
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    user.password_hash = hash_password(body.new_password)
    user.is_active = True
    await db.commit()
    return {"ok": True}


