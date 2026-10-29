-- Staff logins for the pharmacy portal. Each account belongs to exactly one pharmacy (by public code, so it survives
-- a re-seed of the central pharmacies table) and can only change that pharmacy's stock.
CREATE TABLE pharmacy_users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  pharmacy_code  TEXT NOT NULL CHECK (pharmacy_code ~ '^P[0-9]{3,}$'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pharmacy_users_email_unique ON pharmacy_users (lower(email));
