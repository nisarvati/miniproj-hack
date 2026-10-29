-- Schema of ONE pharmacy's own database. Each pharmacy owns an independent copy of this,
-- on its own database with its own credentials. It is authoritative for that pharmacy's stock.

-- Exactly one row: which pharmacy this database belongs to.
CREATE TABLE pharmacy_profile (
  singleton      BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  pharmacy_code  TEXT NOT NULL CHECK (pharmacy_code ~ '^P[0-9]{3,}$'),
  name           TEXT NOT NULL
);

CREATE TABLE inventory (
  medicine_code  TEXT PRIMARY KEY CHECK (medicine_code ~ '^M[0-9]{3,}$'),
  quantity       INTEGER NOT NULL CHECK (quantity >= 0),
  price          NUMERIC(10,2) NOT NULL CHECK (price > 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
