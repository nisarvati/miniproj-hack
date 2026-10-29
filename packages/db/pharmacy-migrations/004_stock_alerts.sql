-- Low-stock alerts: a staff-facing, per-pharmacy record of "this medicine has run low", kept in the pharmacy's OWN database next to its stock,
-- so an alert can only ever belong to the pharmacy whose database it is in.
--
-- It is derived state, never an authority over stock: the inventory table is. Alerts are opened and closed by comparing current stock with
-- the configured low-stock threshold (LOW_STOCK_THRESHOLD), after a change is committed and again whenever the alerts are read, so repeating
-- the comparison any number of times is safe. Nothing here is sent to patients, and it is separate from restock subscriptions.
CREATE TABLE stock_alerts (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The public identifier returned by the API.
  alert_id                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  medicine_code           TEXT NOT NULL CHECK (medicine_code ~ '^M[0-9]{3,}$'),
  alert_type              TEXT NOT NULL CHECK (alert_type IN ('LOW_STOCK')),
  state                   TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'RESOLVED')),
  -- What was true when the alert was opened: the stock, the threshold in force, and the risk score then (see packages/pharmacy-ops/src/risk.ts).
  quantity_at_creation    INTEGER NOT NULL CHECK (quantity_at_creation >= 0),
  threshold               INTEGER NOT NULL CHECK (threshold >= 1),
  risk_score              INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How it ended. NO_LONGER_STOCKED: the pharmacy stopped listing the medicine, so there is no stock level to report.
  resolved_at             TIMESTAMPTZ,
  resolved_reason         TEXT CHECK (resolved_reason IN ('STOCK_RECOVERED', 'NO_LONGER_STOCKED')),
  quantity_at_resolution  INTEGER CHECK (quantity_at_resolution >= 0),
  CONSTRAINT stock_alerts_resolution_complete CHECK (
    (state = 'ACTIVE' AND resolved_at IS NULL AND resolved_reason IS NULL AND quantity_at_resolution IS NULL)
    OR (state = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_reason IS NOT NULL)
  )
);

-- At most ONE active alert per medicine and type, however many evaluations run, even at the same moment. This is what makes repeated and
-- concurrent evaluation safe: the second insert simply finds the first.
CREATE UNIQUE INDEX stock_alerts_one_active ON stock_alerts (medicine_code, alert_type) WHERE state = 'ACTIVE';
-- "Latest alerts first", the way they are listed.
CREATE INDEX stock_alerts_recent ON stock_alerts (created_at DESC, id DESC);
