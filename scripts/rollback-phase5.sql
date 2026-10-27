-- Undo phase 5 (Zoho mapping) and the bank-accounts change — run ONLY after the previous code is deployed again, and after a backup.
-- Payments keep their amounts; the extra bank ledger accounts are kept if anything was posted to them.
BEGIN;
DROP TABLE IF EXISTS zoho_map;
ALTER TABLE payments DROP COLUMN bank_account_id;
ALTER TABLE bank_lines DROP COLUMN bank_account_id;
DROP TABLE IF EXISTS bank_accounts;
COMMIT;
