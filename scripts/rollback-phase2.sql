-- Undo the phase 2 payroll schema (modules/payroll2.js) — run ONLY after the previous code version is deployed again
-- (otherwise the server re-creates these on start), and after a backup:
--   node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/erp/data/erp.db');d.exec(require('fs').readFileSync('scripts/rollback-phase2.sql','utf8'))"
-- Finalised payroll rows are not touched. What is lost: provisions, settlements, advance schedules/repayment links, the project
-- split (project cost falls back to each payroll row's main project), transport allowances, rest-day choices.
BEGIN;
DROP TABLE IF EXISTS eos_provisions;
DROP TABLE IF EXISTS eos_settlements;
DROP TABLE IF EXISTS loan_repayments;
DROP TABLE IF EXISTS loans;
DROP INDEX IF EXISTS payroll_alloc_pay;
DROP TABLE IF EXISTS payroll_alloc;
DROP TABLE IF EXISTS user_projects;
ALTER TABLE employees DROP COLUMN transport;
ALTER TABLE hr_requests DROP COLUMN installments;
ALTER TABLE attendance DROP COLUMN rest_comp;
-- substitute rest days back to plain rest days; new expense categories back to "other"
UPDATE attendance SET status='off' WHERE status='comp_off';
UPDATE bills SET category='other' WHERE category IN ('accommodation','visa','insurance');
INSERT INTO project_budgets(project_id, category, amount) SELECT project_id, 'other', SUM(amount) FROM project_budgets WHERE category IN ('accommodation','visa','insurance') GROUP BY project_id
  ON CONFLICT(project_id, category) DO UPDATE SET amount = project_budgets.amount + excluded.amount;
DELETE FROM project_budgets WHERE category IN ('accommodation','visa','insurance');
-- system accounts added in phase 2 (kept if a manual journal uses them)
DELETE FROM accounts WHERE system=1 AND code IN ('1300','5260','5710','5720','5730')
  AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.lines LIKE '%"' || accounts.code || '"%');
DELETE FROM settings WHERE key IN ('hr_midday_from','hr_midday_to','hr_midday_start','hr_midday_end','hr_sif_days');
COMMIT;
