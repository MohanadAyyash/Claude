-- Undo phase 3 (modules/ipc.js) — run ONLY after the previous code version is deployed again, and after a backup.
-- Invoices, BOQ progress and payments are not touched; only the certificate snapshots and the KPI target go.
BEGIN;
DROP TABLE IF EXISTS ipcs;
DELETE FROM settings WHERE key='kpi_manday_target';
COMMIT;
