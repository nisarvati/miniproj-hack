-- Movement history: what the pharmacy's staff did to its stock, kept durably in the pharmacy's OWN database.
--
-- A row is written in the SAME transaction as the inventory change (and so as the outbox event the trigger records for it):
-- all three commit together or none does. It records only changes made through the portal's sale, restock and stock-count
-- operations. Nothing before this migration is back-filled, and changes made some other way (plain SQL, adding or removing a
-- listing) have no row here: the outbox, not this table, remains the record of every change that must reach MedLink.
CREATE TABLE inventory_movements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The public identifier returned by the API (the numeric id is only for ordering).
  movement_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  medicine_code    TEXT NOT NULL CHECK (medicine_code ~ '^M[0-9]{3,}$'),
  -- The direction of the change, as the outbox trigger classifies it: fewer units is a SALE, more is a RESTOCK.
  operation        TEXT NOT NULL CHECK (operation IN ('SALE', 'RESTOCK')),
  -- TRANSACTION: an explicit sale or restock. STOCK_COUNT: staff counted the shelf and corrected the quantity.
  source           TEXT NOT NULL CHECK (source IN ('TRANSACTION', 'STOCK_COUNT')),
  quantity_delta   INTEGER NOT NULL,
  quantity_before  INTEGER NOT NULL CHECK (quantity_before >= 0),
  quantity_after   INTEGER NOT NULL CHECK (quantity_after >= 0),
  -- pharmacy_users.id in the central database (no foreign key: databases are independent). Not an email address.
  actor_user_id    BIGINT,
  -- The client's retry key for an explicit sale or restock, and a fingerprint of what it asked for, so a retry is recognised
  -- as the same request and a reused key with different details is refused. NULL when no key was sent.
  idempotency_key  TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 100),
  request_hash     TEXT,
  -- The outbox event this change produced, so a movement can be followed downstream.
  event_id         UUID,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_delta_matches CHECK (quantity_after = quantity_before + quantity_delta),
  CONSTRAINT inventory_movements_direction CHECK (
    (operation = 'SALE' AND quantity_delta < 0) OR (operation = 'RESTOCK' AND quantity_delta > 0)
  ),
  CONSTRAINT inventory_movements_key_has_hash CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
);

-- One movement per retry key: this is what makes a retried request safe, however many copies arrive at once.
CREATE UNIQUE INDEX inventory_movements_idempotency_key ON inventory_movements (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- "Latest movements first", the only way history is read.
CREATE INDEX inventory_movements_recent ON inventory_movements (occurred_at DESC, id DESC);
