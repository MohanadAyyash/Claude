# Trigon ERP — User Guide (English)

> Arabic version: [USER-GUIDE-AR.md](USER-GUIDE-AR.md)
>
> This guide follows the screens of the system step by step, in the order a contracting company normally works:
> set up the company → clients → tender → quotation → project → invoicing and collection → purchasing → HR and payroll → accounting and tax.
> Button and menu names are written **in bold**, exactly as they appear in the English interface.

---

## Contents

1. [Getting started](#1-getting-started)
2. [First-time setup (administrator)](#2-first-time-setup-administrator)
3. [Users and roles](#3-users-and-roles)
4. [Clients and suppliers](#4-clients-and-suppliers)
5. [Tenders and opportunities](#5-tenders-and-opportunities)
6. [Quotations](#6-quotations)
7. [Projects](#7-projects)
8. [Sales invoices](#8-sales-invoices)
9. [Payments and receipts](#9-payments-and-receipts)
10. [Ageing and statements of account](#10-ageing-and-statements-of-account)
11. [Site diary](#11-site-diary)
12. [Requests for quotation (RFQ) and purchase orders](#12-requests-for-quotation-rfq-and-purchase-orders)
13. [Expenses and purchases](#13-expenses-and-purchases)
14. [Subcontracts and payment certificates](#14-subcontracts-and-payment-certificates)
15. [Stock](#15-stock)
16. [Assets and equipment](#16-assets-and-equipment)
17. [Petty cash](#17-petty-cash)
18. [Adding an employee](#18-adding-an-employee)
19. [Attendance and overtime](#19-attendance-and-overtime)
20. [Leave](#20-leave)
21. [Employee requests and salary advances](#21-employee-requests-and-salary-advances)
22. [Approvals](#22-approvals)
23. [Official letters](#23-official-letters)
24. [Payroll and WPS](#24-payroll-and-wps)
25. [Employee leaving and final settlement](#25-employee-leaving-and-final-settlement)
26. [HR dashboard: approval chains and attendance rules](#26-hr-dashboard-approval-chains-and-attendance-rules)
27. [Employee portal (for staff)](#27-employee-portal-for-staff)
28. [Accounting](#28-accounting)
29. [Zoho Books link](#29-zoho-books-link)
30. [Tax and compliance](#30-tax-and-compliance)
31. [Tasks, notes and notifications](#31-tasks-notes-and-notifications)
32. [Printing, PDF, Excel and mobile](#32-printing-pdf-excel-and-mobile)
33. [Backup and good practice](#33-backup-and-good-practice)
34. [Common questions](#34-common-questions)

---

## 1. Getting started

### 1.1 Opening the system
1. Open the system's address in Chrome, Edge or Safari:
   - In the office: `http://<server-IP>:3000`
   - Online: your sub-domain, for example `https://erp.trigon.ae`
2. Enter your **Username** and **Password**, then press **Sign in**.
3. After 8 wrong passwords the account is locked for a while. Ask the administrator to reset your password if you forgot it.

### 1.2 Language
- On the sign-in screen, click **English / عربي** under the button.
- After signing in, use the **English / عربي** button at the bottom of the side menu. The whole interface switches direction (RTL/LTR).

### 1.3 The screen
- **Side menu** (on the right in Arabic, on the left in English) grouped as: Projects & sales, Procurement & stock, Accounting, Human resources, Tax & compliance.
- You only see the pages your role allows (see section 3).
- On a phone the menu opens from the **☰** button at the top.
- Most lists work the same way: **+ Add** (or **+ New**) opens a form; click any row to open and edit it; **Save** stores it; **Delete** removes it (when allowed).
- Every page has a **🖨 Print on letterhead** button, and most lists have an **Excel** button.
- **Logout** is at the bottom of the side menu.

---

## 2. First-time setup (administrator)

### 2.1 Create the administrator account
1. The first time the system opens, it shows **First-time setup**.
2. Enter **Username**, **Password** (at least 6 characters) and **Company name**.
3. On an online server you may be asked for a **Setup token** — it is the `SETUP_TOKEN` value in the server's `.env` file.
4. Press **Create account**. You are now signed in as administrator.

### 2.2 Company details
Menu: **Settings** → first card.
1. Fill in:
   - **Company name (English)** and **Company name (Arabic)**
   - **VAT TRN (15 digits)** — required to issue tax invoices
   - **Corporate tax TRN**
   - **Phone**, **Email**, **Website**, **P.O. Box**, **Address (English)**, **Address (Arabic)**
   - **Document reference prefix (e.g. TC)** — quotations and letters are numbered like `TC26/01-CLIENT`
   - **Licence authority**, **Trade licence no.**, **Licence expiry** (you get an alert before it expires)
   - **Default VAT %** (normally 5) and **Currency** (AED)
   - **MOHRE establishment ID (13 digits)**, **Company bank**, **Company bank routing code (9 digits)**, **Company IBAN** — all needed for the WPS salary file
   - **Document footer text**
2. **VAT registered?** — choose **No** if the company is not registered yet: invoices then default to 0% VAT and are titled "Invoice" instead of "Tax invoice".
3. **Bank details (shown on invoices)** — the text printed on every invoice for clients to pay you.
4. **Default quotation terms** — pre-filled into every new quotation.
5. Press **Save**.

### 2.3 Logo, stamp and signature
Menu: **Settings** → **Company identity: logo, stamp & signature**.
1. Quick way: press **Install the Trigon brand pack (logos, stamp, legal details)** and confirm. This installs the Trigon logos and the legal details (name, licence, address, P.O. Box).
2. Or upload each image yourself (PNG with transparent background, up to 2 MB): **Primary logo**, **Arabic logo (official letterhead)**, **Reversed logo**, **Logo line (e-mail signature)**, **Mark only**, **Official stamp**, **Authorised signature**.
3. The official stamp is not shipped with the code — upload it here. It prints only on documents issued by the system, so give printing rights only to authorised people.
4. To replace an image, upload a new one; to remove it, press **Remove**.

### 2.4 Email sending (server edition)
Menu: **Settings** → **Email sending**.
1. **Sending method**:
   - **Microsoft 365** (recommended for Outlook mail): enter **Directory (tenant) ID**, **Application (client) ID**, **Client secret (Value)** from an app registered in Microsoft Entra with the *Mail.Send* application permission.
   - **SMTP**: enter **SMTP server**, **Port (587 or 465)**, **SMTP username**, **SMTP password** and **Encryption**.
2. Enter **From address** (e.g. `accounts@trigon.ae`).
3. Press **Save**, then type your email in the test box and press **Send test**.

### 2.5 My profile (email signature)
Menu: **Settings** → **My profile**. Enter **Full name**, **Job title**, **Mobile** → **Save**. These appear in the signature of every email you send from the system.

### 2.6 Change your password
Menu: **Settings** → **Change password** → type the new password → **Change**.

---

## 3. Users and roles

### 3.1 Roles
| Role | What it can do |
|---|---|
| **Admin** | Everything, including settings, users and voiding tax invoices |
| **Accountant** | Finance and accounting; no users or settings |
| **Project manager** | Projects, purchasing, attendance; no payroll or tax |
| **Quantity surveyor** | Tenders, quotations, projects, invoices (sees values) |
| **Site engineer** | Assigned projects only, BOQ progress, site diary, RFQs, stock — no money figures |
| **Foreman** | Attendance of their crew and site diary of assigned projects |
| **Procurement officer** | RFQs, purchase orders, subcontracts, expenses, suppliers |
| **Storekeeper** | Stock and purchase orders |
| **HR** | Employees, leave, requests, letters, payroll; no accounts |
| **Viewer** | Read only |
| **Employee (portal)** | Their own portal only (leave, payslips, requests, attendance) |

### 3.2 Add a user
1. **Settings** → **Users & roles** → **+ User**.
2. Enter **Username** and **Password (min 6)**, choose the **Role**.
3. If the user is also an employee, choose **Linked employee** (needed for leave approvals and the portal).
4. Press **Create**.

### 3.3 Manage a user
In the users table:
- **Reset password** — type the new password.
- **Change role** — type/choose the new role.
- **Projects** (site engineers and foremen only) — tick the projects they may see. They see only these projects and their crews.

---

## 4. Clients and suppliers

Menu: **Clients & suppliers**. Do this before quotations, invoices and purchases.

1. Press **+ Add**.
2. **Type**: **Client**, **Supplier** or **Subcontractor**.
3. **Name** (required).
4. **Tax registration no. (TRN)** — required for tax invoices to VAT-registered businesses, and for recovering input VAT from suppliers.
5. **Phone**, **Email** (used when emailing quotations/invoices), **Address** (required on tax invoices).
6. **Bank name**, **IBAN**, **Notes**.
7. Press **Save**.
8. Open the record again to attach documents (trade licence, VAT certificate…) in the **Attached documents** panel.

---

## 5. Tenders and opportunities

Menu: **Tenders & opportunities**. The board shows each stage with its value, plus **Open pipeline**, **Weighted (value × probability)**, **Won this year** and **Win rate**.

### 5.1 Add a tender
1. Press **+ Tender / opportunity**.
2. Fill in: **Tender / opportunity** (title), **Client** — or type **Or a new organisation name** (the client is created for you), **Source** (invitation, referral, tender portal…).
3. **Stage**: Lead → Invited → Preparing → Submitted → Negotiation → Won / Lost.
4. **Estimated value**, **Win probability %**, **Submission date**, **Expected close**, **Owner**, **Notes**.
5. **Save**.

### 5.2 Move it forward
1. Click the tender card to open it and change the **Stage** as it progresses.
2. **Create quotation** — makes a quotation linked to the tender (then **Open quotation** to work on it).
3. When you win: **Won — convert to project** — converts the quotation to a project and marks the tender as won.
4. When you lose: set the stage to **Lost** and fill **Lost reason**.

---

## 6. Quotations

Menu: **Quotations**.

### 6.1 Create a quotation
1. Press **+ New**.
2. **Quote no.** — leave empty to get the automatic number (e.g. `TC26/01-CLIENT`).
3. **Date**, **Client**, **Project name**, **Validity (days)** (default 30), **Status** (Draft), **VAT %**.
4. Lines: for each line fill **Description**, **Unit**, **Qty**, **Rate** and choose VAT (**Standard 5%**, **Zero-rated** or **Exempt**). Press **+ Line** for more lines and **×** to delete a line. The subtotal, VAT and total update as you type.
5. **Notes** and **Terms** (pre-filled from Settings).
6. Press **Save**.

### 6.2 Send it to the client
Open the quotation, then:
- **Print** or **PDF** — prints with the cover page and letterhead. (Add `?cover=0` to the print link to print without the cover.)
- **Email** — type the client's email; the PDF is attached.
- **🔗 Client acceptance link** — gives a link the client opens without signing in. They review the quotation and either **accept** with their name and signature or **decline** with a comment. You are notified at once and the result shows on the quotation. Use **Copy**, **Email with the quotation** or **Preview**.
- Change **Status** to **Sent**, then **Accepted** or **Rejected** if you follow up by hand.

### 6.3 Convert to a project
When the client accepts, open the quotation and press **Convert to project**. The project is created and the quotation lines are copied into the project's **BOQ**.

---

## 7. Projects

Menu: **Projects**.

### 7.1 Add a project
Either convert a quotation (6.3) or a tender (5.2), or:
1. Press **+ Add**.
2. **Code** (e.g. P-2026-01), **Project name** (required), **Client**, **Location**.
3. **Emirate (for VAT return)** — needed for box 1 of the VAT return.
4. **Contract value (ex VAT)**.
5. **Retention % (on invoices)** — e.g. 10.
6. **Status** (Active), **Start date**, **End date**.
7. Advance payment: **Advance payment % of contract** and **Advance recovery % per progress invoice** (empty = same %).
8. Retention release: **Handover date**, **Retention released at handover %** (default 50), **Defects liability period (months)** (default 12; the rest is released after it).
9. Phone attendance: **Site latitude**, **Site longitude**, **Site radius (m)** (default 300). The easiest way: open the project on your phone while on site and press **📍 Use my current location (while on site)**.
10. **Notes** → **Save**.

### 7.2 The project page
Click the project to open it. You see:
- Figures: **Contract value**, **Approved variations**, **Revised value**, **Invoiced**, **Billed %**, **Collected**, **Receivable**, **Cost**, **Profit**, **Margin**.
- Buttons: **Edit**, **Progress invoice from BOQ**, **+ Invoice**, **+ Expense**.

### 7.3 Bill of quantities (BOQ) and progress
1. Press **+ Item**.
2. **Section**, **Description**, **Unit**, **Quantity**, **Sell rate / unit**, **Budget cost / unit**, **Completion %**.
3. **Save**. Click an item later to update **Completion %** as work progresses (site engineers can update completion straight from their project page).
4. Below the table: **Budget vs actual** (budget cost against actual cost).

### 7.4 Variation orders
1. Press **+ Variation**.
2. **Number**, **Date**, **Description**, **Amount (ex VAT, negative for omission)**, **Status** (Pending / Approved / Rejected).
3. **Save**. Only **Approved** variations are added to the revised contract value.

### 7.5 Budget and forecast
In the **Budget & forecast** card on the project page:
1. Enter the budget for each cost category.
2. Press **Save budget**.
3. The card shows **Actual**, **Committed (POs & subcontracts)**, **Remaining**, **Forecast cost at completion** and **Forecast margin**. Forecast cost = actual so far + budget of the work not yet done. A warning appears when the forecast is over budget.

### 7.6 Weekly updates
1. In **Weekly updates** press **+ Update**.
2. Choose the status, **Progress %**, **Date**, and write **How is it going? (done, issues, next steps)**.
3. **Save** — the budget, actual and forecast figures of that date are saved with the update.

### 7.7 Advance payment and retention
The **Advance payment & retention** card shows the advance invoiced, recovered and still to recover, and retention held, released, due at handover and after the defects period.
- **Issue the advance payment invoice** — creates the tax invoice for the advance (VAT applies). It is recovered automatically from each progress invoice.
- To release retention, record a receipt on the invoice and tick **This is a retention release** (section 9).

### 7.8 Revenue per worker-day
The card shows, per month: **Certified work** ÷ **Worker-days (attendance)** = **Per worker-day**, against the **Target**. Press **Edit target** to change it.

### 7.9 Notes, documents and other sections
- **Notes & follow-up**: write a note; mention a colleague with `@username` to notify them.
- **Attached documents**: choose **Type**, **Expiry date (optional)**, choose a file (max 8 MB) → **Upload**.
- The page also lists the project's **Invoices**, **Expenses** and **Cost by category**.

### 7.10 Editing or closing a project
**Edit** → change fields → **Save**. A project that has invoices or expenses cannot be deleted — set its **Status** to **Completed**, **On hold** or **Cancelled** instead.

---

## 8. Sales invoices

Menu: **Sales invoices**.

### 8.1 Progress invoice from the BOQ (recommended)
1. Update the **Completion %** of the BOQ items (7.3).
2. On the project page press **Progress invoice from BOQ**.
3. The system creates an invoice for the newly completed work, deducts retention and advance recovery, and opens it.
4. Check it and press **Save**.
5. **Payment certificate** / **Certificate PDF** prints the interim payment certificate (IPC): per item contract qty, previous, this period, cumulative and %, then retention, advance recovery, net, VAT and amount due.

### 8.2 Manual invoice
1. **+ New** (or **+ Invoice** on the project page).
2. **Invoice no.** (automatic, e.g. `INV-2026-001`), **Date**, **Project** (required), **Due date**, **VAT %**, **Retention %**.
3. Add lines as in quotations → **Save**.
4. Warnings appear if the client has no TRN or no address — fix them in **Clients & suppliers**.

### 8.3 After issuing
Open the invoice:
- **Print**, **PDF**, **Email**.
- **Payment reminder** (only when overdue) — emails a reminder with the outstanding balance.
- **Record payment** — see section 9.
- **Issue credit note** — enter the reason; a credit note is created against the invoice (use it to reduce or cancel an invoice).
- **Void** (administrator only) — enter the mandatory reason. Tax invoices are never deleted; they are voided or credited.

---

## 9. Payments and receipts

Menu: **Payments** (or **Record payment** inside an invoice or expense).

1. Press **+ Record payment**.
2. **Type**: **Receipt from client** or **Payment to supplier**.
3. **Against**: choose the open invoice or bill.
4. **Date**, **Amount**.
5. **Method**: Bank transfer, Cheque, Cash or Card. If you have more than one bank account, choose the **Bank account**.
6. For cheques: **Cheque date** and **Cheque status** (Pending / Cleared / Bounced). Pending and bounced cheques are not counted in the cash balance, and a bounced cheque does not settle the invoice.
7. **Reference / cheque no.**
8. For a retention payment from the client tick **This is a retention release**.
9. **Save**. To update a cheque later (e.g. it cleared), open it in the payments list.

---

## 10. Ageing and statements of account

Menu: **Ageing & statements**.
1. Choose **Receivables (customers)** or **Payables (suppliers)** and the **As of** date.
2. Balances are split by days past due. Retention not yet due is shown apart.
3. Click a customer or supplier to open the **Statement of account**, choose **From** / **To**, then **Print** or **Email** (sent with a PDF).

---

## 11. Site diary

Menu: **Site diary**.
1. **+ Add**.
2. **Project**, **Date**, **Weather**, **Manpower**, **Work done**, **Issues / delays**, **Other notes**.
3. **Save**. It prints on the letterhead with **🖨 Print on letterhead**.

---

## 12. Requests for quotation (RFQ) and purchase orders

### 12.1 RFQ and supplier comparison
Menu: **RFQs**.
1. **+ New RFQ**.
2. Choose the **Project** and write a **Description**.
3. List the items: **Item**, **Unit**, **Qty** (**+ Item** for more).
4. Press **+ Supplier** for each supplier that quoted and type their rate for every item, plus **Delivery (days)**.
5. The system totals each supplier and highlights the lowest.
6. **Save**.
7. Press **Award + PO** under the chosen supplier — a purchase order is created automatically.

### 12.2 Purchase order
Menu: **Purchase orders** (or created from the RFQ).
1. **+ New PO**: **Supplier**, **Project**, **Date**, **Delivery date**, **VAT %**, items, **Terms**, **Notes**, **Status**.
2. **Print** or **Email supplier**.
3. When the goods arrive press **Receive → create bill** — this creates the supplier bill for the order value.

---

## 13. Expenses and purchases

Menu: **Expenses & purchases** (or **+ Expense** on the project page).
1. **+ New**.
2. **Date**, **Supplier**, **Project** (empty = overhead).
3. **Category**: Materials, Labour, Subcontractor, Equipment, Transport, Permits & fees, Accommodation, Visas & labour fees, Medical insurance, Overheads, Other — or **Fixed asset purchase (depreciated)** for assets.
4. **Description**, **Amount (ex VAT)**, **VAT amount (if any)**, **Supplier invoice no.**
5. Shared cost (rent, shared equipment…): tick **Split this expense across several projects**, add projects with **+ Project** and enter the % for each (must total 100%).
6. **Save**, then **Record payment** when you pay it.

> Do not enter salaries here as "Labour" — payroll is booked by the Payroll module.

---

## 14. Subcontracts and payment certificates

Menu: **Subcontracts & certificates**.

### 14.1 Subcontract
1. **+ Add**: **Subcontractor**, **Project**, **Scope of work**, **Contract value (ex VAT)**, **Retention %**, **Advance payment**, **Status** → **Save**.

### 14.2 Payment certificate
1. Open the subcontract → **+ New certificate**.
2. Enter **Work completed to date (cumulative, ex VAT)**, **Advance recovery**, **Deductions / back-charges**.
3. The system shows **Previously certified**, **This period**, retention, VAT and **Payable now**.
4. Press **Approve & book cost** — after approval it cannot be edited and the cost is booked to the project.
5. Pay it from **Payments**.

---

## 15. Stock

Menu: **Stock**.
1. **+ Add** an item: **Code**, name, **Unit**, **Reorder level**, **Location**.
2. **Stock movement**: choose **Receive**, **Issue to project** or **Adjustment (+/−)**, the item, **Quantity**, **Unit cost (receipts)**, **Project**, **Reference** → **Save**.
3. The list shows quantity, **Avg cost**, **Value** and a **Low** flag under the reorder level.

> Stock tracks quantities and average cost only; material cost is booked through bills and purchase orders.

---

## 16. Assets and equipment

Menu: **Assets & equipment**.
1. **+ Add**: **Asset**, **Category**, **Serial / plate**, **Purchase date**, **Cost**, **Salvage value**, **Useful life (years)**, **Current project**, **Status**, **Disposal date** → **Save**.
2. Depreciation is straight-line monthly from the purchase month; the list shows **Accum. dep.** and **Net book value**.
3. Record the purchase bill with category **Fixed asset purchase** so it is not expensed in full.

---

## 17. Petty cash

Menu: **Petty cash**.
1. **+ Top up**: **Date**, **Amount**, **Note** → **Save**.
2. **+ Cash expense**: **Date**, **Project**, **Category**, **Description**, **Amount (ex VAT)**, VAT → **Save**. It is booked as a project expense and paid from the float.
3. The page shows the **Petty cash balance**. Keep a receipt or tax invoice for each expense.

---

## 18. Adding an employee

Menu: **Employees**.

### 18.1 Employee record
1. **+ Add**.
2. Identity: **Name (as per passport)** (required), **Designation**, **Labour card / Person code (14 digits)**, **Emirates ID**, **Passport no.**, **Nationality**.
3. Employment: **Join date**, **Status** (Active), **Cost charged to** (a project, or General — head office), **Probation ends (max 6 months)**, **Line manager (approves leave first)**.
4. Salary: **Basic wage**, **Housing allowance**, **Transport allowance**, **Other allowances**.
5. WPS bank: **Bank / exchange house**, **Routing code (9 digits)**, **IBAN** — required for the salary file.
6. Expiry dates: **Emirates ID expiry**, **Residence visa expiry**, **Passport expiry**, **Labour card expiry** — alerts appear before they expire.
7. **Phone**, **Email**, **Emergency contact**, **Opening leave balance (days)**, **Notes**.
8. **Save**. The list shows **Monthly total**, **Gratuity (est.)** and flags a missing IBAN.

### 18.2 After saving — open the employee again
- **Attached documents**: upload passport, visa, Emirates ID, contract… with expiry dates.
- **Employee portal account**: type **Username** and **Password (6+ chars)** → **Create account**. (Or **Reset password** if it exists.)
- **Onboarding & offboarding** → **Start onboarding**: tick the 12 steps as they are done (work permit and MOHRE contract, medical, Emirates ID, health insurance, ILOE, WPS salary account, safety induction…).
- **Notes & follow-up** with `@mentions`.

---

## 19. Attendance and overtime

Menu: **Attendance & overtime**.

### 19.1 Clock-in by phone (employee)
1. The employee opens **My portal** on the phone and presses **Clock in** (and **Clock out** at the end of the day).
2. The time comes from the server and the phone's location is attached.
3. Outside the site radius the record is flagged and the line manager alerted (or blocked — see 26.2).

### 19.2 Crew without phones (foreman / supervisor)
1. **Clock in my crew**.
2. Choose **In** or **Out**, tick the names, **Record**. The current time is saved with your phone's location.
3. HR only can enter a **Past time (HR correction)** (e.g. a forgotten clock-out).

### 19.3 Daily attendance sheet
1. Choose the date. For each employee set **Status**, **OT +25%**, **OT +50%**, **Project**, **Note** — each row saves automatically.
2. For work on the rest day, choose the compensation: **Pay +50%** or **Substitute day off**.
3. Overtime and absences feed the payroll when the month is generated.

---

## 20. Leave

Menu: **Leave**.
1. **Record leave** (or the employee requests it from the portal).
2. **Employee**, **Type** (Annual, Sick, Unpaid, Maternity, Paternity, Bereavement, Other), **From**, **To**, **Reason** → **Save**.
3. **Decide** — approve or reject with an optional note (it then follows the approval chain).
4. **Leave balances** shows per employee: months, accrued, opening, used, balance and sick days in the last 12 months. (2 days/month after 6 months, 30 days/year after a year.)
5. Sick-leave pay is calculated automatically in payroll: 15 days full pay, 30 half pay, 45 unpaid per year of service; unpaid during probation.

---

## 21. Employee requests and salary advances

Menu: **Employee requests**.

### 21.1 Requests
1. Employees request from the portal, or HR presses **Request on behalf**.
2. **Employee**, **Request type** (Salary certificate, Employment certificate, No-objection certificate, Salary transfer letter, Experience certificate, Salary advance, Visa / ID / passport renewal, Complaint / feedback, Other), **Amount** and **Instalments** for advances, **Details**.
3. For letter requests press **Issue letter** (the request is approved and the letter is created); for others press **Decide**. **Reject** asks for a reason.

### 21.2 Salary advances
1. **Salary advances & repayment** → **+ New advance**.
2. **Employee**, **Amount**, **Instalments**, **First deduction month (YYYY-MM)**, **Paid by** (Bank / Cash), **Note** → **Save**.
3. The instalment is deducted automatically when the month's payroll is generated; the remaining balance shows on the payslip and in the final settlement.

---

## 22. Approvals

Menu: **Approvals**. Shows the leave and requests that reached your level of the approval chain.
1. Review the request (and the employee's leave balance).
2. **Approve** or **Reject** (with a note). After you approve it moves to the next level; the employee is told the final decision.

---

## 23. Official letters

Menu: **Official letters**.
1. **New letter**.
2. **Employee**, **Letter type** (Salary certificate, Employment certificate, No-objection certificate, Salary transfer letter, Experience certificate), **Addressed to (optional)**, **Purpose**.
3. **Issue & print** — the letter gets a sequential reference number and prints on the bilingual official letterhead with stamp and signature. Review the wording before signing.
4. Reprint later with **Print** or **PDF** from the list.

---

## 24. Payroll and WPS

Menu: **Payroll & WPS**. Monthly steps:
1. Check that attendance, leave and advances for the month are complete.
2. Choose the month and press **Generate month**.
3. Read **Missing data / warnings** (missing IBAN, routing code, person code…) and fix them in the employee record.
4. Adjust per employee if needed: **Days**, **Leave days**, **OT hrs (+25%)**, **OT hrs (+50%)**, **Bonus**, **Deductions**. **Net** recalculates.
   - Daily wage = gross ÷ 30. OT hour = basic ÷ 30 ÷ 8, +25% by day, +50% at night (10 pm–4 am) or on rest days/public holidays.
5. **Finalize payroll** — after this the month cannot be edited; the cost is split to projects and the end-of-service provision is booked.
6. **Download WPS SIF file** and upload it through your bank or exchange house portal (ask the bank to validate the first file).
7. After the transfer press **Mark salaries paid**. Salaries unpaid 15 days after month-end appear as a compliance alert.
8. Employees see their payslips in the portal; **Excel** exports the sheet.

---

## 25. Employee leaving and final settlement

Open the employee → **Onboarding & offboarding** → **Leaving & final settlement**.
1. **Last working day**, **Reason** (Resignation, Termination by the company, End of contract, Other), **Notice given on**, **Other deductions**.
2. **Start offboarding & calculate**. The system shows: **Salary to the last day**, leave encashment (on basic), end-of-service gratuity (21/30 days), notice-period shortfall (notice must be 30–90 days), **Outstanding advance**, **Deductions** and **Total**.
3. Change the inputs and press **Recalculate** if needed; tick the offboarding checklist.
4. **Complete & disable account** — the employee becomes "Left" and their system account is disabled.

---

## 26. HR dashboard: approval chains and attendance rules

Menu: **HR dashboard** — active employees, leave and requests waiting, who is on leave today, documents expiring within 60 days, and a monthly **Labour-law compliance** list (overtime limits, 7 days without rest, midday ban work, probation over 6 months, clock-ins outside the site).

### 26.1 Approval chains
1. Under **Approval chains** set levels for **Leave** and **Employee requests**.
2. Each level: **Approver** (line manager or a role) and threshold (**From days** for leave, **From amount** for requests).
3. **Save**. Default: leave → line manager then HR; requests → HR, then admin from 5,000.

### 26.2 Attendance rules
- **Daily working hours (max 8)**, **Break minutes**, **Weekly rest day**.
- **Clocking outside the site area**: *Allowed, flagged, manager alerted* or *Blocked*.
- **Ramadan from / to** (2 hours shorter days).
- **Midday ban from / to (MM-DD)** e.g. `06-15` to `09-15`, **Ban starts at / ends at** (12:30–15:00).
- **"Days in period" in the SIF file**.
- **Save** (administrator).

---

## 27. Employee portal (for staff)

The employee signs in with the account HR created (18.2) and lands on **My portal**:
1. **Clock in / Clock out** (attendance).
2. **Annual leave balance (days)**, accrued to date, sick leave in the last 12 months, document expiry dates.
3. **Request leave**: **Leave type**, **From**, **To**, **Reason** → **Save**.
4. **Other request**: **Request type**, amount/instalments for advances, **Details** → **Save**.
5. **My requests** — status; approved letters open with **Open letter** / **PDF**.
6. **Payslips** → **View / print**.
7. Install it on the phone (section 32.3) to receive notifications.

---

## 28. Accounting

Most entries are made automatically from invoices, bills, payments, payroll and assets.

- **Chart of accounts** — **+ Account**: **Code (3–6 digits)**, **Name (English)**, **Name (Arabic)**, **Type** → **Save**. Built-in accounts cannot be deleted.
- **Journal entries** — **+ New entry**: date, **Memo**, lines (account, **Debit**, **Credit**; **+ Line**). It must be balanced → **Save**.
- **General ledger** — choose an account and **From / To**, **Show**. Positive balance = debit, negative = credit.
- **Financial statements** — choose **From / To** → **Show**: **Trial balance**, **Profit & loss**, **Balance sheet**.
- **Bank reconciliation**:
  1. **Add an account** (name, bank, IBAN, ledger) if you have more than one bank.
  2. **Import statement** — upload the bank CSV or paste the lines → **Import**.
  3. **Auto-match**, then **Match** the rest by hand (or **Unmatch**).
  4. Check that **Difference** is zero.

---

## 29. Zoho Books link

Menu: **Zoho Books link** (administrator / accountant). Full details in [ZOHO.md](../ZOHO.md).
1. **Connection**: Zoho keys come from the server's `.env` file. Create a Self Client in the Zoho API console, generate a code with the shown scope, paste it in **Grant code** → **Connect**, then pick the **Zoho Books organisation**.
2. **Account & project mapping**: bank/cash, **Default expense account**, and a reporting tag or Zoho project per project.
3. Choose **Send transactions dated from**, then press **Dry run (nothing sent)** to preview.
4. **Send to Zoho now**, or tick **Enable the link** and **Send automatically every day**.
5. **Send history** → **Retry failed**. The **Daily transactions report** lists what was invoiced, billed, received and paid each day.
6. Standalone edition: use the **Zoho Books import files** instead.

---

## 30. Tax and compliance

- **VAT report**: choose **From / To** → **Show**. Shows standard-rated, zero-rated and exempt sales, output VAT, purchases, recoverable input VAT, **Net VAT payable to FTA**, box 1 by emirate, and warnings (e.g. input VAT without supplier TRN). File within 28 days of period end via EmaraTax.
- **Corporate tax**: choose the year. Shows revenue, expenses, payroll, profit, taxable income and 9% above AED 375,000, and Small Business Relief if revenue is under AED 3m.
- **Compliance & audit**: all alerts (missing TRN/MOHRE ID, licence and visa expiries, unpaid salaries, bounced cheques…), key deadlines, e-invoicing readiness and the **Audit log** of every change.
- **Documents**: all attachments in one place, plus **Company documents (licence, MOA, insurance…)** — upload with an expiry date to get alerts.

> The system is not officially certified by the FTA, MOHRE or the Central Bank. Review returns and the SIF file with your accountant and bank.

---

## 31. Tasks, notes and notifications

- **Tasks**: **+ Task** → **Task**, **Assignee**, **Due date**, **Status**, **Tag**, **Project**, **Details**, **Sub-tasks** → **Save**. Switch between **My tasks** and **All open tasks**.
- **Notes**: on projects and employees, mention `@username` to notify a colleague.
- **Notifications**: approvals, decisions, mentions and alerts. **Turn on notifications on this device** to receive them on the phone (on iPhone, add the app to the Home Screen first — iOS 16.4+). **Send a test**, **Mark all read**.

---

## 32. Printing, PDF, Excel and mobile

1. **Documents** (quotation, invoice, PO, IPC, letter, payslip): **Print** or **PDF** inside the document.
2. **Any page**: **🖨 Print on letterhead**. **Excel** exports the list.
3. **Install on phone**:
   - iPhone: Safari → Share → **Add to Home Screen**.
   - Android: browser menu → **Install app / Add to Home screen**.
   - When a new version is available, tap the banner to update.

---

## 33. Backup and good practice

1. **Settings** → **Backup** → **Download backup** — at least weekly, store it outside the computer. It contains attachments and the email password; keep it safe.
2. Use a long, unique administrator password; do not share the admin account — give each person their own user and role.
3. Keep financial records 5–7 years.
4. After each code update restart the server.

---

## 34. Common questions

| Question | Answer |
|---|---|
| I can't delete an invoice | Tax invoices cannot be deleted. Issue a **credit note**, or the administrator can **Void** it with a reason. |
| I can't delete a project | It has invoices or expenses — set its status to **Cancelled**. |
| Payroll is locked | It was finalized. Corrections go into next month (bonus / deductions). |
| An employee doesn't see their portal | Their user must be linked to the employee record (Settings → Users, or create the account from the employee record). |
| A site engineer sees no projects | Settings → Users → **Projects** → tick their projects. |
| Phone clock-in says outside the site | Set the project's latitude/longitude/radius (7.1, step 9). |
| "This page could not be loaded… old version" | Restart the server and refresh the page (Ctrl+F5). |
