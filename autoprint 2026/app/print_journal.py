"""Durable spool receipts: retries resume unfinished parts, never replay submitted ones."""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
import hashlib
from contextlib import contextmanager
from pathlib import Path


class JobBusy(RuntimeError):
    pass


class SubmissionUncertain(RuntimeError):
    """A process may have submitted pages; an operator must check the printer."""


class PrintJournal:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT, updated REAL NOT NULL, plan TEXT, fingerprint TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS parts (job TEXT NOT NULL, part TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job, part))")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def claim(self, job_id: str, stale_seconds: float = 120, payload=None):
        owner = uuid.uuid4().hex
        now = time.time()
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest() if payload is not None else None
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT state, updated, fingerprint FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row and row[2] != fingerprint:
                raise ValueError("Print job ID was reused with different content; use a new request ID")
            if row and row[0] == "done":
                return Receipt(self, job_id, owner, completed=True)
            if row and row[0] == "running" and now - row[1] < stale_seconds:
                raise JobBusy(f"Print job {job_id} is already processing")
            db.execute("INSERT INTO jobs(id,state,owner,updated,fingerprint) VALUES(?,'running',?,?,?) ON CONFLICT(id) DO UPDATE SET state='running',owner=excluded.owner,updated=excluded.updated", (job_id, owner, now, fingerprint))
        return Receipt(self, job_id, owner)


class Receipt:
    def __init__(self, journal, job_id, owner, completed=False):
        self.journal, self.job_id, self.owner = journal, job_id, owner
        self.completed = completed
        self.can_submit = None

    def touch(self):
        with self.journal.connect() as db:
            updated = db.execute("UPDATE jobs SET updated=? WHERE id=? AND owner=? AND state='running'", (time.time(), self.job_id, self.owner)).rowcount
        if not updated and not self.completed:
            raise JobBusy("Print job ownership was lost")

    def plan(self, proposed):
        # Preserve the original chunks even if config changes while a job retries.
        with self.journal.connect() as db:
            row = db.execute("SELECT plan FROM jobs WHERE id=?", (self.job_id,)).fetchone()
            if row and row[0]:
                return json.loads(row[0])
            db.execute("UPDATE jobs SET plan=? WHERE id=? AND owner=?", (json.dumps(proposed), self.job_id, self.owner))
        return proposed

    def is_submitted(self, part):
        with self.journal.connect() as db:
            row = db.execute("SELECT state FROM parts WHERE job=? AND part=?", (self.job_id, str(part))).fetchone()
        if row and row[0] == "submitting":
            raise SubmissionUncertain(f"Job {self.job_id}, part {part}: submission was interrupted. Check the printer before explicitly reprinting.")
        return bool(row and row[0] == "submitted")

    def before_submit(self, part):
        if self.can_submit and not self.can_submit():
            raise JobBusy("Print lease is no longer confirmed; submission stopped")
        self.touch()
        with self.journal.connect() as db:
            db.execute("INSERT INTO parts VALUES(?,?,'submitting')", (self.job_id, str(part)))

    def submitted(self, part):
        with self.journal.connect() as db:
            db.execute("UPDATE parts SET state='submitted' WHERE job=? AND part=?", (self.job_id, str(part)))

    def not_started(self, part):
        with self.journal.connect() as db:
            db.execute("DELETE FROM parts WHERE job=? AND part=? AND state='submitting'", (self.job_id, str(part)))

    def finish(self):
        with self.journal.connect() as db:
            updated = db.execute("UPDATE jobs SET state='done',owner=NULL,updated=? WHERE id=? AND owner=?", (time.time(), self.job_id, self.owner)).rowcount
        if not updated:
            raise JobBusy("Print job ownership was lost before completion")
        self.completed = True

    def release(self):
        with self.journal.connect() as db:
            db.execute("UPDATE jobs SET state='pending',owner=NULL,updated=? WHERE id=? AND owner=? AND state='running'", (time.time(), self.job_id, self.owner))
