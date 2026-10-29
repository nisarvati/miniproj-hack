-- Restock plans: a pharmacy's own to-do list of "get more of this medicine by this date", kept in the pharmacy's OWN database.
--
-- A plan is a PLANNING record and nothing else. Creating, editing, rescheduling, completing or cancelling one never touches `inventory`, the movement
-- history or the outbox: stock changes only through the recorded restock (inventory_movements, 003), which is what tells MedLink stock arrived.
-- "COMPLETED" means the planning task is done, not that any stock has arrived.
CREATE TABLE restock_plans (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The public identifier returned by the API.
  plan_id             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  -- No foreign key to inventory: a plan outlives a medicine the pharmacy stops listing. Creation checks the medicine is stocked.
  medicine_code       TEXT NOT NULL CHECK (medicine_code ~ '^M[0-9]{3,}$'),
  planned_quantity    INTEGER NOT NULL CHECK (planned_quantity BETWEEN 1 AND 1000000),
  status              TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  -- A calendar day, as the person chose it (no time zone to convert).
  target_date         DATE NOT NULL,
  notes               TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 500),
  -- pharmacy_users.id in the central database (no foreign key: databases are independent). Not an email address.
  created_by_user_id  BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  -- The completion time exists exactly while the plan is COMPLETED, so reopening a plan cannot leave a stale one behind.
  CONSTRAINT restock_plans_completed_at CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

-- At most ONE open (PLANNED or IN_PROGRESS) plan per medicine. This is what stops a double click, or a plan made from the same alert twice, from
-- creating duplicates, and it holds however many requests arrive at once. Completed and cancelled plans do not count.
CREATE UNIQUE INDEX restock_plans_one_open ON restock_plans (medicine_code) WHERE status IN ('PLANNED', 'IN_PROGRESS');
-- Listing: soonest target first, optionally by status.
CREATE INDEX restock_plans_by_target ON restock_plans (target_date, id);
CREATE INDEX restock_plans_by_status ON restock_plans (status, target_date, id);
