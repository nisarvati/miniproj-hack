-- Email-and-password sign-in for patients (the alternative to Google).
--
-- Accounts used to live in the web server's memory, so they vanished on every restart and, on a serverless host, differed from one instance to the next.
-- They now live here. A credential account is NOT a patient: `patients` (migration 006) is keyed by Google's stable account identifier, and a calendar
-- is only ever opened for a verified Google identity. The email on a credential account is typed by whoever signs up and is never verified, so it
-- identifies nobody and is never used to find, link or merge anything.
CREATE TABLE credential_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lower-cased by the application; the check and the unique index make that true for every writer.
  email          TEXT NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- "scrypt$N$r$p$<salt>$<hash>": a salted, slow hash with its own parameters, so the cost can be raised later. Never a plain or fast hash.
  password_hash  TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%' AND length(password_hash) <= 512),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credential_accounts_email_key ON credential_accounts (email);

-- Sign-in and sign-up attempt counters, kept here (not in memory) so the limit holds across serverless instances and restarts. A key is a hash of what is
-- being limited (an address, or an address with an email), never the raw address or email.
CREATE TABLE auth_throttle (
  key           TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  count         INTEGER NOT NULL CHECK (count >= 0),
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Old windows are deleted in passing (see the application); this keeps that cheap.
CREATE INDEX auth_throttle_window_start ON auth_throttle (window_start);
