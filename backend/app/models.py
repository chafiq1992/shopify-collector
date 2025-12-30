import uuid
from datetime import datetime
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    JSON,
    func,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from .db import Base


def _json_type():
    """JSON type compatible with Postgres and SQLite."""
    return JSON().with_variant(JSONB, "postgresql")


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False, default="collector")
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_login_at = Column(DateTime(timezone=True), nullable=True)

    events = relationship("OrderEvent", back_populates="user", cascade="all,delete")


class OrderEvent(Base):
    __tablename__ = "order_events"
    __table_args__ = (
        # Prevent double-counting the same order action for the same store.
        # Note: existing SQLite DBs won't auto-migrate; new DBs will enforce it.
        UniqueConstraint("order_gid", "store_key", "action", name="uq_order_events_order_store_action"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    order_number = Column(String(64), nullable=False, index=True)
    order_gid = Column(String(128), nullable=True)
    store_key = Column(String(32), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    action = Column(String(32), nullable=False, index=True)
    # "metadata" is reserved by SQLAlchemy Declarative; use event_metadata instead
    event_metadata = Column(_json_type(), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)

    user = relationship("User", back_populates="events")


class DailyUserStats(Base):
    __tablename__ = "daily_user_stats"

    user_id = Column(String(36), ForeignKey("users.id"), primary_key=True)
    day = Column(Date, primary_key=True)
    store_key = Column(String(32), primary_key=True)
    collected_count = Column(Integer, nullable=False, default=0)
    out_count = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    user = relationship("User")


class AppSetting(Base):
    """
    Simple key/value settings store (JSON value) for small configuration + per-store secrets.

    Used for Shopify OAuth persistence:
      key = "shopify_oauth:{store_label}"
      value = {"shop": "...myshopify.com", "access_token": "...", "scopes": "...", "installed_at": "..."}
    """

    __tablename__ = "app_settings"

    key = Column(String(255), primary_key=True)
    value = Column(_json_type(), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
