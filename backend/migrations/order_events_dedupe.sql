-- Run this against the production Postgres (Cloud SQL) once.
--
-- Why: the old UniqueConstraint(order_gid, store_key, action) was per-order and
-- caused silent IntegrityErrors whenever a second agent tried to log the same
-- action on an order someone had already touched. Confirmation actions are
-- *attempts* (N1/N2/N3/N4/Nowtp/Enatt/Confirmed/Cancelled), not state, so we
-- want every legitimate attempt recorded. Dedupe is now per-(user, action, day)
-- in application code; collected/out/fulfilled keep their existing per-order
-- pre-check in the endpoint.

ALTER TABLE order_events
  DROP CONSTRAINT IF EXISTS uq_order_events_order_store_action;

-- Some Postgres versions back the constraint with an auto-named index; drop it
-- defensively too. (No-op if it never existed.)
DROP INDEX IF EXISTS uq_order_events_order_store_action;

CREATE INDEX IF NOT EXISTS ix_order_events_user_action_created
  ON order_events (user_id, action, created_at);

CREATE INDEX IF NOT EXISTS ix_order_events_order_action
  ON order_events (order_gid, action);
