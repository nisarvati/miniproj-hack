CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  latitude    DOUBLE PRECISION CHECK (latitude BETWEEN -90 AND 90),
  longitude   DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- location is optional, but never half-specified
  CONSTRAINT users_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE TABLE medicines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_name    TEXT NOT NULL,
  generic_name  TEXT NOT NULL,
  dosage        TEXT NOT NULL,
  form          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT medicines_variant_unique UNIQUE (brand_name, dosage, form)
);

CREATE INDEX medicines_brand_trgm   ON medicines USING gin (lower(brand_name) gin_trgm_ops);
CREATE INDEX medicines_generic_trgm ON medicines USING gin (lower(generic_name) gin_trgm_ops);

CREATE TABLE pharmacies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pharmacies_name_address_unique UNIQUE (name, address)
);

CREATE TABLE inventory (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pharmacy_id  BIGINT NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  medicine_id  BIGINT NOT NULL REFERENCES medicines(id)  ON DELETE CASCADE,
  quantity     INTEGER NOT NULL CHECK (quantity >= 0),
  price        NUMERIC(10,2) NOT NULL CHECK (price > 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_pharmacy_medicine_unique UNIQUE (pharmacy_id, medicine_id)
);

-- The unique constraint already indexes (pharmacy_id, medicine_id) for per-pharmacy lookups.
-- This one serves "which pharmacies stock medicine X".
CREATE INDEX inventory_medicine_idx ON inventory (medicine_id) INCLUDE (pharmacy_id, quantity, price);
