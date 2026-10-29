-- Transactional outbox. Every change to `inventory` records an event row IN THE SAME TRANSACTION,
-- whoever made the change (pharmacy software, a script, plain SQL). A rolled-back change leaves no event.
-- The inventory connector later reads unpublished rows and turns them into MedLink events.

CREATE TABLE outbox (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Assigned once here, so re-publishing the same row always carries the same eventId (idempotency key).
  event_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('SALE','RESTOCK','PRICE_UPDATED','MEDICINE_ADDED','MEDICINE_REMOVED')),
  medicine_code   TEXT NOT NULL,
  quantity_delta  INTEGER,
  quantity_after  INTEGER,
  price           NUMERIC(10,2),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  -- Rows that cannot be turned into a valid event are parked here instead of blocking the queue.
  failed_at       TIMESTAMPTZ,
  error           TEXT
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL AND failed_at IS NULL;

CREATE FUNCTION inventory_to_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after, price)
    VALUES ('MEDICINE_ADDED', NEW.medicine_code, NEW.quantity, NEW.quantity, NEW.price);

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after)
    VALUES ('MEDICINE_REMOVED', OLD.medicine_code, -OLD.quantity, 0);

  ELSE
    IF NEW.medicine_code <> OLD.medicine_code THEN
      RAISE EXCEPTION 'inventory.medicine_code is immutable; remove and re-add the item instead';
    END IF;
    -- A single UPDATE that changes both price and quantity produces two events (price first).
    IF NEW.price <> OLD.price THEN
      INSERT INTO outbox (event_type, medicine_code, price)
      VALUES ('PRICE_UPDATED', NEW.medicine_code, NEW.price);
    END IF;
    -- Any decrease is reported as a SALE, any increase as a RESTOCK.
    IF NEW.quantity <> OLD.quantity THEN
      INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after, price)
      VALUES (CASE WHEN NEW.quantity < OLD.quantity THEN 'SALE' ELSE 'RESTOCK' END,
              NEW.medicine_code, NEW.quantity - OLD.quantity, NEW.quantity, NEW.price);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER inventory_outbox
  AFTER INSERT OR UPDATE OR DELETE ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_to_outbox();

-- Databases created before this migration already hold stock the outbox never saw:
-- record it as an initial MEDICINE_ADDED snapshot so downstream state can be built from events alone.
INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after, price, occurred_at)
SELECT 'MEDICINE_ADDED', medicine_code, quantity, quantity, price, updated_at FROM inventory;
