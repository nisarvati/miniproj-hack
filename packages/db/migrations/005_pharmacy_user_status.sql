-- Sign-up requests for the pharmacy portal. A person asks for access to one pharmacy and stays 'pending' until a
-- MedLink administrator approves them; only 'active' accounts can sign in or change stock. Accounts that exist
-- already (including the seeded development ones) default to 'active', so nothing changes for them.
ALTER TABLE pharmacy_users
  ADD COLUMN status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'rejected')),
  ADD COLUMN decided_at TIMESTAMPTZ;

-- Serves the per-pharmacy cap on open requests and the administrator's "pending" list.
CREATE INDEX pharmacy_users_pending_idx ON pharmacy_users (pharmacy_code) WHERE status = 'pending';
