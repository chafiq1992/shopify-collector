import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from .db import get_session
from .models import User

router = APIRouter()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=True)
oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

JWT_SECRET = os.environ.get("JWT_SECRET", "CHANGE_ME_SECRET").strip()
JWT_EXPIRES_MINUTES = int(os.environ.get("JWT_EXPIRES_MINUTES", "720").strip() or 720)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class LoginBody(BaseModel):
    email: EmailStr
    password: str


class RegisterBody(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None
    role: Optional[str] = None  # admin | collector


def hash_password(pw: str) -> str:
    return pwd_context.hash(pw)


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(pw, hashed)
    except Exception:
        return False


def _issue_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MINUTES)
    payload = {"sub": str(user.id), "role": user.role, "exp": exp}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def get_current_user(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_session)) -> User:
    cred_exc = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        uid = payload.get("sub")
        if not uid:
            raise cred_exc
    except JWTError:
        raise cred_exc
    user = await db.scalar(select(User).where(User.id == uid))
    if not user or not user.is_active:
        raise cred_exc
    return user


async def get_current_user_optional(token: str = Depends(oauth2_optional), db: AsyncSession = Depends(get_session)) -> Optional[User]:
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        uid = payload.get("sub")
        if not uid:
            return None
    except JWTError:
        return None
    return await db.scalar(select(User).where(User.id == uid, User.is_active == True))


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin required")
    return user


@router.post("/api/auth/login", response_model=TokenResponse)
async def login(body: LoginBody, db: AsyncSession = Depends(get_session)):
    user = await db.scalar(select(User).where(User.email == body.email.lower().strip()))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid credentials")
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    token = _issue_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email, "name": user.name, "role": user.role},
    }


@router.post("/api/auth/register", response_model=TokenResponse)
async def register(body: RegisterBody, db: AsyncSession = Depends(get_session), current_user: Optional[User] = Depends(get_current_user_optional)):
    # Determine if this is the first user
    total_users = await db.scalar(select(func.count()).select_from(User))
    is_first_user = total_users == 0

    if not is_first_user:
        # Existing users: only admins may create new users
        if not current_user or current_user.role != "admin":
            raise HTTPException(status_code=403, detail="admin required to register new users")

    exists = await db.scalar(select(User).where(User.email == body.email.lower().strip()))
    if exists:
        raise HTTPException(status_code=400, detail="email already exists")

    role = body.role if body.role in ("admin", "collector") else "collector"
    if is_first_user:
        role = "admin"

    user = User(
        email=body.email.lower().strip(),
        name=(body.name or "").strip() or None,
        password_hash=hash_password(body.password),
        role=role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    token = _issue_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email, "name": user.name, "role": user.role},
    }


@router.get("/api/auth/me")
async def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role}

