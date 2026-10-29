-- Restock notifications (milestone 11).
--
-- A user asks to be told when a medicine is back in stock; when a RESTOCK event for that medicine arrives,
-- the notification service turns each waiting subscription into one notification.

CREATE TABLE restock_subscriptions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  medicine_id  BIGINT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'NOTIFIED', 'CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,
  CONSTRAINT restock_subscriptions_notified_at CHECK ((status = 'NOTIFIED') = (notified_at IS NOT NULL))
);

-- Asking twice while still waiting is one subscription. After it was fulfilled or cancelled, asking again is new.
CREATE UNIQUE INDEX restock_subscriptions_one_active ON restock_subscriptions (user_id, medicine_id) WHERE status = 'ACTIVE';
-- "Who is waiting for medicine X" is the lookup done for every RESTOCK event.
CREATE INDEX restock_subscriptions_waiting ON restock_subscriptions (medicine_id) WHERE status = 'ACTIVE';

CREATE TABLE notifications (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- UNIQUE: a subscription is fulfilled at most once, however often its restock event is delivered.
  subscription_id  BIGINT NOT NULL UNIQUE REFERENCES restock_subscriptions(id) ON DELETE CASCADE,
  medicine_id      BIGINT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  pharmacy_id      BIGINT REFERENCES pharmacies(id) ON DELETE SET NULL,
  -- The inventory event that caused it (traceability; not a foreign key, events live outside this database).
  event_id         UUID NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'MOCK',
  message          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL until the notifier has sent it. Rows still NULL after a crash are sent on the next sweep.
  delivered_at     TIMESTAMPTZ
);

CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_undelivered_idx ON notifications (id) WHERE delivered_at IS NULL;
