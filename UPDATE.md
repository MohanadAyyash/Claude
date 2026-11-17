# تحديث النظام على جهاز المكتب / Updating the office PC

**بالعربي باختصار:** شغّل `Trigon-Update.bat` من مجلد النظام (دبل كليك). يأخذ نسخة من البيانات، ينزّل النسخة الجديدة، يثبّت
المكتبات المطلوبة في نسخة جانبية، وبعدها فقط يوقف النظام ويبدّل الملفات. إذا فشل أي شيء بعد الإيقاف يرجّع النسخة السابقة
كما كانت تماماً ويشغّلها، ويطلع برسالة واضحة إن كان الرجوع نجح. البيانات (`data`) لا تُلمس أبداً. الملف يحدّث نفسه بعد إغلاق
نافذته. **أول مرة فقط** بعد هذا التحديث: انسخ `Trigon-Update.bat` الجديد يدوياً (القسم ١).

## 1. One-time bootstrap (the first time only)
The updater on the office PC today is an older version: it skips itself (`/XF Trigon-Update.bat`), does not install dependencies
and does not roll back. It cannot install the new updater, so do this once, after this change is merged:

1. Take a verified backup first (Settings → Backups → download, or copy the `data` folder somewhere else and open the copy once).
2. Download the new updater into the system folder, replacing the old one (PowerShell, in the system folder, e.g. `C:\erp`):
   ```powershell
   Invoke-WebRequest -UseBasicParsing -Uri https://raw.githubusercontent.com/MohanadAyyash/Trigon-ERP-System/claude/construction-management-app-rfq8al/Trigon-Update.bat -OutFile .\Trigon-Update.bat
   ```
   (or open that address in a browser and save the file as `Trigon-Update.bat` next to `server.js`).
3. Double-click `Trigon-Update.bat`. From now on it updates itself.

If the old updater is run once more by mistake, nothing breaks: the program files arrive without `jose`, the ERP runs, and
Settings → Microsoft 365 lists `jose` as missing. Do the bootstrap above and run the new updater.

## 2. What the updater does
`Trigon-Update.bat` (asks for administrator rights) only backs up the data and downloads the release; the update itself is
`scripts\update.js` **from the downloaded release**, so the update logic is always the reviewed one of the version being installed.

| Step | What happens | If it fails |
|---|---|---|
| 1/6 | `data` copied to `data-backup-<date>` | stops, nothing changed |
| 2/6 | release ZIP downloaded and checked | stops, nothing changed |
| 3/6 | staging folder `.update-staging-…` inside the system folder: each program folder = the live one with the release copied over it (so files only on this PC, e.g. `brand\stamp.png`, are kept); `npm ci --omit=dev --ignore-scripts` from `package-lock.json`; `npm ls`; `require('jose')` | staging deleted, **the system was never stopped**, nothing changed |
| 4/6 | system stopped (TrigonERP task + `node server.js`); checks it no longer answers | rollback (below) |
| 5/6 | each program entry and `node_modules` swapped **by renaming** (same disk): live → `app-backup-<date>`, staged → live; then every file is compared (sha256) with the staged release, and `require('jose')` is run in the system folder | rollback |
| 6/6 | system started, `/api/status` must answer within 40 s | rollback |

**Rollback:** stop the system, remove the new entries, move the previous ones back from `app-backup-…`, compare every file (sha256)
with the list taken before the swap, start the previous version and check it answers. The window ends with either
`ROLLBACK SUCCEEDED: the previous version is restored (checked byte for byte) and running` or `ROLLBACK FAILED: …` with what to copy
back by hand. It never starts files that were not verified. Exit code is **1** in both cases, **0** only when the new version answers.

If the PC loses power in the middle of step 5, nothing is deleted: the previous entries are in `app-backup-<date>` and the new ones
in `.update-staging-<date>`; move the `app-backup-<date>` entries back into the system folder (replacing those with the same name),
then start the system.

**Never touched:** `data`, `.env`, `data-backup-*`, `run-*.cmd` and any other file that is not part of the release.
The previous version stays in `app-backup-<date>`; the newest 3 are kept, and older ones are deleted only after a successful update.

**Self-update:** the release's `Trigon-Update.bat` is staged as `Trigon-Update.bat.new` (checked by sha256). A small helper
(`scripts\update-finish.js`) waits until the updater windows have closed (cmd.exe reads a batch file while running it, so it must not
change underneath them), renames it into place, checks the sha256 again and writes the result to `update-history.log`. On any problem
the `.new` file is removed and the old updater stays; the next update tries again. Start the updater by double-clicking it (if it is
typed into an open cmd window, it is replaced when that window is closed).

## 3. Manual test on Windows (required before merging / deploying)
`test-updater.js` runs the same `scripts/update.js` on Linux with an injected service controller. The batch file, PowerShell,
elevation, the scheduled task, `npm.cmd` and Windows file locking can only be checked on Windows. Do this on a **disposable copy**
first, never on the only live installation.

The updater only acts on its own folder: it stops/starts the `TrigonERP` task only if the task's working directory is that folder,
and stops only the `node` process listening on that folder's port (and the launcher window around it). A test copy therefore uses
`Trigon-Start.bat`, which always listens on port 3000 - so the live system must be stopped while you test.

Preparation (outside working hours)
1. Take a verified backup of the live system (Settings → Backups → download, and open the downloaded copy once).
2. Stop the live system: PowerShell **as administrator** → `Stop-ScheduledTask TrigonERP`, and check `http://localhost:3000`
   no longer opens.
3. Copy the system folder to `C:\erp-test` (with `data`; without `app-backup-*` / `data-backup-*` to save space) and **delete
   `C:\erp-test\node_modules`** if it exists. Copy the new `Trigon-Update.bat` from this branch into `C:\erp-test`.
4. Note `Get-FileHash C:\erp-test\data\erp.db` and `Get-FileHash C:\erp-test\Trigon-Update.bat`.
5. Registry access: `npm ping` → `PONG`.

Before the merge the default branch has no `scripts/update.js`, so the tests download this branch: in the admin Command Prompt
below, first `set TRIGON_UPDATE_BRANCH=copilot/m365-foundation` (only branch names of this repository are accepted).

Download check (identifies why a download fails; delete the test ZIPs afterwards) - in an **administrator Command Prompt**:
- A. As the updater ran it before the fix (Windows PowerShell, no profile, TLS 1.2 forced):
  `powershell -NoProfile -Command "$PSVersionTable.PSVersion; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri https://github.com/MohanadAyyash/Trigon-ERP-System/archive/refs/heads/copilot/m365-foundation.zip -OutFile $env:TEMP\t1.zip; (Get-Item $env:TEMP\t1.zip).Length"`
- B. The same without forcing TLS 1.2:
  `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol; Invoke-WebRequest -UseBasicParsing -Uri https://github.com/MohanadAyyash/Trigon-ERP-System/archive/refs/heads/copilot/m365-foundation.zip -OutFile $env:TEMP\t2.zip; (Get-Item $env:TEMP\t2.zip).Length"`
- C. Windows' own curl: `curl.exe -fsSL -o "%TEMP%\t3.zip" https://github.com/MohanadAyyash/Trigon-ERP-System/archive/refs/heads/copilot/m365-foundation.zip` then `dir "%TEMP%\t3.zip"`
- D. In the PowerShell window where the manual download worked: `$PSVersionTable.PSVersion` and
  `[Net.WebRequest]::DefaultWebProxy.GetProxy('https://github.com')`
Write down for A-D: success + size, or the full error text.

Tests - open **Command Prompt as administrator**, `cd /d C:\erp-test` (so the `set` lines below reach the updater), and after each
run, when the window says "Press any key", press a key and then type `echo EXIT=%errorlevel%`
6. **Normal update** (no node_modules yet): `Trigon-Update.bat` → `DONE - Trigon ERP is updated and running.`, `EXIT=0`.
   At step 2/6 the window shows the PowerShell version, the TLS setting, the proxy (if any) and `downloaded with <method> (… MB)`;
   if a method fails, its full error chain is shown before the next one is tried. Note which method succeeded.
   `http://localhost:3000` opens the TEST copy; log in, open a project and an invoice: the data is there.
7. `node -e "console.log(require('jose/package.json').version)"` → `5.10.0`. No `.update-staging-*` folder; one new `app-backup-*`.
8. **The updater replaced itself:** close the admin Command Prompt window (the updater waits for the window that ran it), wait 5 s,
   then in `C:\erp-test`: `Trigon-Update.bat.new` does not exist; `type update-history.log` shows
   `Trigon-Update.bat replaced with the new version`; `Get-FileHash Trigon-Update.bat` equals the hash of the file in the branch.
   (After the merge, the normal double-click is checked once more on the live system: same three points.)
9. **Second run:** run it again → `DONE`, `EXIT=0`, no `.new` left (the updater is already current), the data is still there.
10. **A failed dependency install changes nothing:** `set npm_config_registry=http://127.0.0.1:9/` then `Trigon-Update.bat`.
    Expect `UPDATE FAILED: npm ci failed … nothing was changed`, `EXIT=1`, the test system **still answering** throughout,
    no `.update-staging-*`, no new `app-backup-*`. Then `set npm_config_registry=` to clear it.
11. **A failure after the stop rolls back:** `set TRIGON_UPDATE_FAULT=health` then `Trigon-Update.bat`. Expect `UPDATE FAILED`,
    `ROLLBACK SUCCEEDED: the previous version is restored (checked byte for byte) and running`, `EXIT=1`, the system answering,
    no `.update-staging-*` left. Repeat with `copy`, `modules`, `jose` and `start`. Then `set TRIGON_UPDATE_FAULT=` to clear it.
    (To make the "previous version" differ from the release, add a line `rem test` to `C:\erp-test\Trigon-Start.bat` before
    these runs and check it is still there afterwards.)
12. After the tests: open the system and check the data; the updater never writes to `data` (only the data backup copies it).
13. Repeat test 6 once in a folder with a space in its path (e.g. `C:\ERP Test`).
14. Stop the test copy (close its window), start the live system again: `Start-ScheduledTask TrigonERP`, and check
    `http://localhost:3000` / `https://erp.trigon.ae` show the live data.
15. Send back the result of each step (OK / the message shown). Only then: bootstrap the live updater (section 1) after another
    verified backup, and run it.
