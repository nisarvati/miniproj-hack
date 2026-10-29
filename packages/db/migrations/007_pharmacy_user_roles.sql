-- Roles for portal accounts: STAFF (pharmacy staff, the only kind there has ever been) and ADMIN (MedLink administrators).
--
-- Every account that exists now becomes STAFF and keeps its pharmacy: nobody is silently promoted. An ADMIN belongs to no pharmacy (pharmacy_code is NULL),
-- so an administrator can manage who gets access but has no pharmacy's stock, history, alerts or plans to reach. Patients are not portal accounts at all
-- (they sign in with Google in the web app, docs/authentication.md), so there is no patient role here: a patient cannot present a portal session.
-- Administrators are created only by an operator with database access (`npm run portal:users -- create-admin <email>`), never through sign-up.
ALTER TABLE pharmacy_users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'STAFF' CHECK (role IN ('STAFF', 'ADMIN')),
  ALTER COLUMN pharmacy_code DROP NOT NULL;

-- A role and a pharmacy always go together: staff have exactly one pharmacy, an administrator has none.
ALTER TABLE pharmacy_users
  ADD CONSTRAINT pharmacy_users_role_scope CHECK (
    (role = 'STAFF' AND pharmacy_code IS NOT NULL) OR (role = 'ADMIN' AND pharmacy_code IS NULL)
  );
