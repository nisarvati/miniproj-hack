-- Stable public identifiers used in cross-system events (e.g. pharmacyId "P001", medicineId "M001").
-- Pharmacy databases are independent of this one, so they reference medicines by code, not by numeric id.
ALTER TABLE pharmacies ADD COLUMN code TEXT;
UPDATE pharmacies SET code = 'P' || lpad(id::text, 3, '0');
ALTER TABLE pharmacies
  ALTER COLUMN code SET NOT NULL,
  ADD CONSTRAINT pharmacies_code_unique UNIQUE (code),
  ADD CONSTRAINT pharmacies_code_format CHECK (code ~ '^P[0-9]{3,}$');

ALTER TABLE medicines ADD COLUMN code TEXT;
UPDATE medicines SET code = 'M' || lpad(id::text, 3, '0');
ALTER TABLE medicines
  ALTER COLUMN code SET NOT NULL,
  ADD CONSTRAINT medicines_code_unique UNIQUE (code),
  ADD CONSTRAINT medicines_code_format CHECK (code ~ '^M[0-9]{3,}$');
