-- Personal medicine calendar (patients signed in with Google).
--
-- `patients` is a different thing from the older `users` table. `users` is keyed by an email address that anyone can type (it is
-- how restock alerts work without a sign-in), so it proves nothing about who someone is. A patient row exists only for a person
-- who signed in with Google, and is keyed by Google's own stable account identifier (the OpenID `sub`), never by email. The two are
-- deliberately not linked: matching them on an unverified email address would let one person read another's data.
CREATE TABLE patients (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          TEXT NOT NULL CHECK (provider IN ('google')),
  provider_subject  TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  -- Shown back to the person only. Never used to find or merge accounts.
  email             TEXT CHECK (email IS NULL OR length(email) <= 320),
  name              TEXT CHECK (name IS NULL OR length(name) <= 200),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per Google account, however many first sign-ins race: the server upserts on this.
  CONSTRAINT patients_identity_unique UNIQUE (provider, provider_subject)
);

-- What a person has recorded for themselves. MedLink is not a pharmacy: ORDERED and PURCHASED are the person's own notes, not
-- orders or purchases that MedLink placed, processed or verified, and nothing here says a medicine is available anywhere.
CREATE TABLE medicine_calendar_entries (
  -- Not a counter: ids are not guessable. Access is still decided by patient_id in every query, never by knowing an id.
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     BIGINT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- Optional reference to the catalogue. If the medicine is ever removed, the entry keeps its name.
  medicine_id    BIGINT REFERENCES medicines(id) ON DELETE SET NULL,
  -- For a catalogue medicine this is a snapshot taken by the server from the catalogue, not text from the client.
  medicine_name  TEXT NOT NULL CHECK (length(btrim(medicine_name)) BETWEEN 1 AND 200),
  entry_type     TEXT NOT NULL CHECK (entry_type IN ('WANT_TO_GET', 'ORDERED', 'PURCHASED', 'REMINDER')),
  -- A calendar day exactly as the person picked it (their own calendar), not an instant: there is no timezone to convert.
  entry_date     DATE NOT NULL,
  notes          TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT medicine_calendar_entries_completed CHECK ((status = 'DONE') = (completed_at IS NOT NULL))
);

-- "My entries between two dates", the only way the calendar reads.
CREATE INDEX medicine_calendar_entries_patient_date ON medicine_calendar_entries (patient_id, entry_date, created_at, id);
-- Serves the foreign key when a catalogue medicine is deleted.
CREATE INDEX medicine_calendar_entries_medicine ON medicine_calendar_entries (medicine_id) WHERE medicine_id IS NOT NULL;
