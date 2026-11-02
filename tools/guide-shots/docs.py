# image blocks: (heading in AR guide, heading in EN guide, image, caption ar, caption en, [(ar, en), ...])
B = [
("### 2.1 إنشاء حساب المدير", "### 2.1 Create the administrator account", "01-setup", "شاشة الإعداد لأول مرة", "First-time setup screen", [
 ("اكتب اسم مستخدم للمدير، مثل admin. ستستخدمه في كل مرة تدخل فيها.", "Type an administrator username, e.g. admin. You will use it every time you sign in."),
 ("كلمة مرور قوية من 6 أحرف على الأقل. لا تشاركها مع أحد.", "A strong password of at least 6 characters. Do not share it."),
 ("اسم الشركة كما سيظهر في النظام (يمكن تعديله لاحقاً من الإعدادات).", "The company name as it will show in the system (you can change it later in Settings)."),
 ("اضغط «إنشاء الحساب» فتدخل مباشرةً كمدير للنظام.", "Press Create account; you are signed in as administrator right away."),
 ("لتبديل لغة الواجهة قبل البدء.", "Switches the interface language before you start.")]),
("### 1.1 فتح النظام", "### 1.1 Opening the system", "02-login", "شاشة تسجيل الدخول", "Sign-in screen", [
 ("اسم المستخدم الذي أعطاك إياه مدير النظام.", "The username the administrator gave you."),
 ("كلمة المرور. بعد 8 محاولات خاطئة يُقفل الحساب مؤقتاً.", "Your password. After 8 wrong attempts the account is locked for a while."),
 ("اضغط «دخول».", "Press Sign in."),
 ("تبديل اللغة بين العربية والإنجليزية.", "Switch between Arabic and English.")]),
("### 1.3 الشاشة", "### 1.3 The screen", "03-dashboard", "لوحة التحكم بعد الدخول", "The dashboard after signing in", [
 ("القائمة الجانبية: فيها كل أقسام النظام مقسّمة إلى مجموعات، ولا يظهر لك إلا ما يسمح به دورك. في أسفلها زر اللغة وزر الخروج.", "The side menu: every section of the system grouped by area; you only see what your role allows. Language and Logout buttons are at its bottom."),
 ("مؤشرات الشركة: المشاريع النشطة، قيمة العقود، المفوتر، المصروفات، الربح، الرصيد النقدي، المستحقات والمحتجزات. تحتها التدفق النقدي وتنبيهات الامتثال والفواتير المتأخرة وربحية كل مشروع.", "Company KPIs: active projects, contract value, invoiced, expenses, profit, cash, receivables and retention. Below: cash flow, compliance alerts, overdue invoices and profit per project."),
 ("يطبع الصفحة الحالية على ترويسة الشركة مع الختم والتوقيع. موجود في كل صفحة.", "Prints the current page on the company letterhead with stamp and signature. It is on every page.")]),
("### 2.2 بيانات الشركة", "### 2.2 Company details", "04-settings-company", "الإعدادات — بيانات الشركة", "Settings — company details", [
 ("اسم الشركة بالإنجليزية والعربية كما في الرخصة، ويُطبع على كل المستندات.", "Company name in English and Arabic as on the licence; printed on every document."),
 ("الرقم الضريبي (15 رقماً). بدونه لا تُصدر فواتير ضريبية صحيحة.", "VAT TRN (15 digits). Without it tax invoices are not valid."),
 ("بادئة الترقيم، مثل TC، فتصبح أرقام العروض والخطابات TC26/01-CLIENT.", "Numbering prefix, e.g. TC, so quotations and letters are numbered TC26/01-CLIENT."),
 ("رقم المنشأة في وزارة الموارد البشرية، وبنك الشركة ورمز التوجيه والآيبان: كلها مطلوبة لملف رواتب WPS.", "MOHRE establishment ID, company bank, routing code and IBAN: all required for the WPS salary file."),
 ("إذا لم تُسجَّل الشركة في الضريبة بعد اختر «لا»، فتصبح الضريبة 0% ويكون عنوان المستند «فاتورة».", "If the company is not VAT-registered yet choose No: VAT becomes 0% and documents are titled Invoice."),
 ("بيانات البنك التي تظهر أسفل كل فاتورة ليحوّل لك العميل عليها.", "Bank details printed at the bottom of every invoice so clients can pay you."),
 ("لا تنسَ «حفظ» بعد أي تعديل.", "Remember to press Save after any change.")]),
("### 2.3 الشعار والختم والتوقيع", "### 2.3 Logo, stamp and signature", "05-settings-brand", "الإعدادات — هوية الشركة", "Settings — company identity", [
 ("يركّب شعارات تريجون والبيانات القانونية بنقرة واحدة.", "Installs the Trigon logos and legal details in one click."),
 ("اختر ملف صورة الختم (PNG بخلفية شفافة، حتى 2 ميجابايت) فيُرفع مباشرة ويظهر في المعاينة.", "Choose the stamp image (transparent PNG, up to 2 MB); it uploads at once and shows in the preview."),
 ("بنفس الطريقة ارفع التوقيع المعتمد. يُطبع الختم والتوقيع على الفواتير والخطابات والتقارير.", "Upload the authorised signature the same way. Stamp and signature print on invoices, letters and reports.")]),
("### 2.4 إرسال البريد الإلكتروني (نسخة الخادم)", "### 2.4 Email sending (server edition)", "06-settings-email", "الإعدادات — إرسال البريد", "Settings — email sending", [
 ("طريقة الإرسال: SMTP (اسم مستخدم وكلمة مرور) أو Microsoft 365 (الأفضل لبريد Outlook). تتغير الحقول حسب اختيارك.", "Sending method: SMTP (username & password) or Microsoft 365 (best for Outlook mail). The fields change with your choice."),
 ("العنوان الذي تصل منه الرسائل للعملاء والموردين، مثل accounts@trigon.ae.", "The address clients and suppliers receive mail from, e.g. accounts@trigon.ae."),
 ("بيانات خادم البريد من مزوّد البريد (الخادم، المنفذ، المستخدم، كلمة المرور، التشفير).", "Mail-server details from your mail provider (server, port, user, password, encryption)."),
 ("احفظ الإعدادات.", "Save the settings."),
 ("اكتب بريدك في الخانة واضغط «إرسال تجربة» للتأكد أن الإرسال يعمل.", "Type your email in the box and press Send test to check sending works.")]),
("### 3.2 إضافة مستخدم", "### 3.2 Add a user", "07-settings-users", "الإعدادات — المستخدمون والصلاحيات", "Settings — users & roles", [
 ("يفتح نموذج مستخدم جديد.", "Opens the new-user form."),
 ("يضع كلمة مرور جديدة لمستخدم نسي كلمة المرور.", "Sets a new password for a user who forgot theirs."),
 ("يغيّر دور المستخدم، فتتغير الصفحات التي يراها.", "Changes the user's role, which changes the pages they see."),
 ("لمهندس الموقع والفورمان فقط: اختيار المشاريع التي يراها.", "Site engineers and foremen only: choose the projects they see."),
 ("ملفك الشخصي: الاسم والمسمى والجوال تظهر في توقيع الإيميلات التي ترسلها.", "Your profile: name, title and mobile appear in the signature of emails you send.")]),
("### 3.2 إضافة مستخدم", "### 3.2 Add a user", "08-user-new", "نموذج مستخدم جديد", "New user form", [
 ("اسم المستخدم الذي سيدخل به (بدون مسافات).", "The username they will sign in with (no spaces)."),
 ("كلمة مرور مؤقتة (6 أحرف على الأقل). اطلب منه تغييرها من الإعدادات.", "A temporary password (6+ characters). Ask them to change it in Settings."),
 ("الدور يحدد الصلاحيات (انظر الجدول أعلاه).", "The role decides the permissions (see the table above)."),
 ("إذا كان موظفاً، اربطه بملفه ليرى بوابته وتعمل اعتمادات المدير المباشر.", "If they are staff, link their employee record so the portal and line-manager approvals work."),
 ("اضغط «إنشاء».", "Press Create.")]),
("## 4. العملاء والموردون", "## 4. Clients and suppliers", "09-party-new", "إضافة عميل", "Adding a client", [
 ("النوع: عميل، أو مورد، أو مقاول باطن. يحدد أين يظهر (العروض والفواتير، أو المشتريات).", "Type: client, supplier or subcontractor. Decides where it appears (quotes & invoices, or purchasing)."),
 ("الاسم الرسمي كما في الرخصة (إلزامي).", "The legal name as on the licence (required)."),
 ("الرقم الضريبي 15 رقماً: يظهر على الفاتورة الضريبية، ويسمح باسترداد ضريبة المشتريات.", "15-digit TRN: shown on tax invoices and needed to recover input VAT."),
 ("العنوان مطلوب في الفاتورة الضريبية. أكمل أيضاً الهاتف والبريد والبنك.", "The address is required on tax invoices. Also fill phone, email and bank."),
 ("احفظ. بعدها افتح السجل لإرفاق الرخصة وشهادة الضريبة.", "Save. Then open the record to attach the licence and VAT certificate.")]),
("## 5. المناقصات والفرص", "## 5. Tenders and opportunities", "10-tenders", "لوحة المناقصات", "Tender board", [
 ("ملخص: عدد الفرص المفتوحة، قيمتها، القيمة المتوقعة (القيمة × الاحتمال)، ما فزنا به، ونسبة الفوز.", "Summary: open count, pipeline value, weighted value (value × probability), won this year, win rate."),
 ("كل عمود مرحلة (فرصة، دعوة، تسعير، مقدَّمة، تفاوض)، وكل بطاقة مناقصة. اضغط البطاقة لفتحها.", "Each column is a stage (lead, invited, preparing, submitted, negotiation); each card is a tender. Click a card to open it."),
 ("إضافة مناقصة أو فرصة جديدة.", "Add a new tender or opportunity.")]),
("### 5.2 متابعة المناقصة", "### 5.2 Move it forward", "11-tender-modal", "نافذة المناقصة", "Tender window", [
 ("اسم المناقصة أو الفرصة.", "The tender or opportunity title."),
 ("المرحلة الحالية. غيّرها كلما تقدمت، فتنتقل البطاقة إلى العمود الصحيح.", "The current stage. Change it as it moves; the card moves to the right column."),
 ("القيمة التقديرية للمشروع.", "Estimated project value."),
 ("احتمال الفوز %: يُستخدم في القيمة المتوقعة.", "Win probability %: used for the weighted value."),
 ("«إنشاء عرض سعر» يجهز عرضاً مرتبطاً بالمناقصة؛ بعد إنشائه يصبح الزر «فتح عرض السعر».", "Create quotation makes a quotation linked to the tender; afterwards it becomes Open quotation."),
 ("«🏆 فزنا — تحويل إلى مشروع»: يحوّل العرض المرتبط إلى مشروع ويعلّم المناقصة «فزنا».", "🏆 Won — convert to project: turns the linked quotation into a project and marks the tender as won."),
 ("احفظ التعديلات.", "Save the changes.")]),
("### 6.1 إنشاء عرض سعر", "### 6.1 Create a quotation", "12-quotes", "قائمة عروض الأسعار", "Quotation list", [
 ("عرض سعر جديد.", "New quotation."),
 ("اضغط أي عرض لفتحه وتعديله أو طباعته أو إرساله.", "Click any quotation to open, edit, print or send it."),
 ("الحالة: مسودة، مُرسل، مقبول، مرفوض.", "Status: draft, sent, accepted, rejected.")]),
("### 6.1 إنشاء عرض سعر", "### 6.1 Create a quotation", "13-quote-new", "نموذج عرض سعر جديد", "New quotation form", [
 ("اترك رقم العرض فارغاً فيُعطى رقماً تلقائياً حسب البادئة.", "Leave the number empty to get an automatic number from the prefix."),
 ("اختر العميل (يجب أن يكون مضافاً في «العملاء والموردون»).", "Choose the client (it must exist in Clients & suppliers)."),
 ("مدة صلاحية العرض بالأيام، وتُطبع على الغلاف.", "Validity in days; printed on the cover."),
 ("جدول البنود: اكتب الوصف والوحدة والكمية والسعر، واختر نوع الضريبة لكل بند. المبلغ يُحسب تلقائياً، و× يحذف البند.", "Lines: type description, unit, qty, rate and pick the VAT type per line. The amount is calculated; × deletes a line."),
 ("«+ بند» لإضافة سطر جديد.", "+ Line adds a row."),
 ("الإجمالي قبل الضريبة، والضريبة، والإجمالي النهائي: تتحدث فوراً.", "Subtotal, VAT and total update instantly."),
 ("الشروط تأتي من الإعدادات ويمكن تعديلها لهذا العرض.", "Terms come from Settings and can be edited for this quotation."),
 ("«حفظ» لحفظ العرض في القائمة.", "Save stores the quotation in the list.")]),
("### 6.2 إرسال العرض للعميل", "### 6.2 Send it to the client", "14-quote-actions", "أزرار عرض السعر بعد الحفظ", "Quotation buttons after saving", [
 ("«طباعة» و«PDF»: العرض بغلاف وترويسة وختم.", "Print and PDF: the quotation with cover, letterhead and stamp."),
 ("«إرسال بالإيميل»: يرسله لبريد العميل مع PDF.", "Email: sends it to the client with a PDF."),
 ("بعد موافقة العميل: «تحويل إلى مشروع» ينشئ المشروع وينسخ البنود إلى جدول الكميات.", "After approval: Convert to project creates the project and copies the lines into the BOQ."),
 ("«رابط القبول للعميل»: رابط يقبل فيه العميل العرض بالتوقيع أو يرفضه.", "Client acceptance link: the client accepts with a signature or declines."),
 ("إذا تابعت يدوياً، غيّر الحالة إلى مُرسل أو مقبول أو مرفوض ثم احفظ.", "If you follow up by hand, set the status to sent, accepted or rejected and save.")]),
("### 6.2 إرسال العرض للعميل", "### 6.2 Send it to the client", "15-quote-link", "رابط القبول الإلكتروني", "Online acceptance link", [
 ("الرابط الذي يفتحه العميل بدون حساب.", "The link the client opens without an account."),
 ("نسخه لإرساله بالواتساب مثلاً.", "Copy it, e.g. to send by WhatsApp."),
 ("أو إرساله بالإيميل مع العرض مباشرة.", "Or email it with the quotation directly.")]),
("### 7.1 إضافة مشروع", "### 7.1 Add a project", "16-projects", "قائمة المشاريع", "Project list", [
 ("إضافة مشروع جديد.", "Add a new project."),
 ("اضغط المشروع لفتح صفحته الكاملة.", "Click a project to open its full page."),
 ("تصدير القائمة إلى Excel.", "Export the list to Excel.")]),
("### 7.1 إضافة مشروع", "### 7.1 Add a project", "17-project-new", "نموذج مشروع جديد", "New project form", [
 ("رمز المشروع واسمه. الاسم إلزامي، والرمز يساعد في البحث والتقارير.", "Project code and name. The name is required; the code helps searching and reports."),
 ("العميل صاحب المشروع.", "The client who owns the project."),
 ("الإمارة: تُستخدم في الخانة 1 من إقرار الضريبة.", "Emirate: used in box 1 of the VAT return."),
 ("قيمة العقد بدون ضريبة ونسبة المحتجزات التي تُخصم من كل فاتورة.", "Contract value ex VAT and the retention % deducted from each invoice."),
 ("نسبة الدفعة المقدمة ونسبة استردادها من كل مستخلص.", "Advance payment % and the recovery % per progress invoice."),
 ("تاريخ التسليم ونسبة المحتجزات المفرج عنها فيه، وفترة الصيانة للباقي.", "Handover date, the retention % released then, and the defects period for the rest."),
 ("إحداثيات الموقع ونطاقه لتسجيل حضور العمال من الجوال.", "Site coordinates and radius for phone attendance."),
 ("احفظ.", "Save.")]),
("### 7.2 صفحة المشروع", "### 7.2 The project page", "18-project-page", "صفحة المشروع", "Project page", [
 ("أرقام المشروع لحظياً: العقد، أوامر التغيير، المفوتر ونسبته، المحصّل، المستحق، التكلفة، الربح والهامش.", "Live figures: contract, variations, invoiced and %, collected, receivable, cost, profit, margin."),
 ("تعديل بيانات المشروع أو تغيير حالته.", "Edit the project or change its status."),
 ("إصدار فاتورة إنجاز حسب نسب الإنجاز في الجدول.", "Issue a progress invoice from the BOQ completion."),
 ("تسجيل مصروف مرتبط بالمشروع مباشرة (وبجانبه «+ فاتورة» لفاتورة يدوية).", "Record an expense on the project (next to it, + Invoice for a manual invoice).")]),
("### 7.3 جدول الكميات (BOQ) ونسبة الإنجاز", "### 7.3 Bill of quantities (BOQ) and progress", "19-project-boq", "جدول الكميات وأوامر التغيير", "BOQ and variation orders", [
 ("إضافة بند جديد للجدول.", "Add a new BOQ item."),
 ("اضغط أي بند لتعديله أو تحديث نسبة إنجازه.", "Click any item to edit it or update its completion %."),
 ("الإجماليات: قيمة الجدول، التكلفة المقدّرة، والإنجاز الكلي للمشروع.", "Totals: BOQ value, budget cost and overall progress."),
 ("إضافة أمر تغيير (Variation).", "Add a variation order.")]),
("### 7.3 جدول الكميات (BOQ) ونسبة الإنجاز", "### 7.3 Bill of quantities (BOQ) and progress", "20-boq-item", "نافذة بند الجدول", "BOQ item window", [
 ("وصف البند (والقسم أعلاه لتجميع البنود).", "Item description (and the section above it to group items)."),
 ("الكمية وسعر البيع للوحدة: منها تُحسب قيمة البند.", "Quantity and sell rate: they give the item value."),
 ("التكلفة المقدّرة للوحدة: تُستخدم في الميزانية والتوقعات.", "Budget cost per unit: used in the budget and forecast."),
 ("نسبة الإنجاز: حدّثها مع تقدم العمل؛ فاتورة الإنجاز تفوتر الفرق منذ آخر فاتورة.", "Completion %: update it as work progresses; the progress invoice bills the change since the last one."),
 ("احفظ.", "Save.")]),
("### 7.4 أوامر التغيير", "### 7.4 Variation orders", "21-variation", "نافذة أمر التغيير", "Variation order window", [
 ("رقم أمر التغيير والتاريخ.", "Variation number and date."),
 ("المبلغ بدون ضريبة. للتخفيض اكتب مبلغاً سالباً.", "Amount ex VAT. For an omission use a negative amount."),
 ("الحالة: «معتمد» فقط يُضاف إلى القيمة المعدّلة للعقد.", "Status: only Approved is added to the revised contract value."),
 ("احفظ.", "Save.")]),
("### 7.5 الميزانية والتوقعات", "### 7.5 Budget and forecast", "22-budget", "بطاقة الميزانية والتوقعات", "Budget & forecast card", [
 ("بعد إدخال الأرقام اضغط «حفظ الميزانية».", "After entering the figures press Save budget."),
 ("أدخل الميزانية لكل بند تكلفة (مواد، عمالة، مقاولو باطن…). بجانبها الفعلي والملتزم به والمتبقي.", "Enter the budget per category (materials, labour, subcontract…). Next to it: actual, committed and remaining."),
 ("التكلفة المتوقعة عند الإنجاز والهامش المتوقع؛ يظهر تنبيه أحمر إذا تجاوزت الميزانية.", "Forecast cost at completion and forecast margin; a red warning shows when over budget.")]),
("### 7.7 الدفعة المقدمة والمحتجزات", "### 7.7 Advance payment and retention", "23-advance-retention", "الدفعة المقدمة والمحتجزات والإنتاجية", "Advance, retention and productivity", [
 ("الدفعة المقدمة: المفوتر، المسترد من المستخلصات، والمتبقي. والمحتجزات: المحجوز، المفرج عنه، وما يُستحق عند التسليم وبعد الصيانة.", "Advance: invoiced, recovered from progress invoices, remaining. Retention: held, released, due at handover and after the defects period."),
 ("الإيراد لكل عامل في اليوم لكل شهر، مقارنةً بالهدف.", "Revenue per worker-day per month against the target."),
 ("تعديل الهدف (درهم لكل عامل في اليوم).", "Edit the target (AED per worker-day).")]),
("### 7.6 التقارير الأسبوعية", "### 7.6 Weekly updates", "24-weekly-notes", "التقارير الأسبوعية والملاحظات والمستندات", "Weekly updates, notes and documents", [
 ("تقرير أسبوعي جديد: الحالة، نسبة الإنجاز، وملخص الأسبوع.", "New weekly update: status, progress % and a summary."),
 ("الملاحظات: اكتب ملاحظة، واذكر زميلاً بـ @اسم_المستخدم فيصله إشعار.", "Notes: write a note; mention a colleague with @username to notify them."),
 ("المستندات المرفقة: العقد، المخططات، التصاريح، مع تاريخ الانتهاء.", "Attached documents: contract, drawings, permits, with expiry date.")]),
("## 8. فواتير العملاء", "## 8. Sales invoices", "25-invoices", "قائمة فواتير العملاء", "Sales invoice list", [
 ("فاتورة يدوية جديدة (فاتورة الإنجاز تُنشأ من صفحة المشروع).", "New manual invoice (progress invoices are created from the project page)."),
 ("الرصيد المتبقي على العميل، شاملاً المحتجزات غير المحصّلة.", "Balance owed by the client, including uncollected retention."),
 ("الحالة: مدفوع، جزئي، متأخر، ملغاة…", "Status: paid, partial, overdue, void…")]),
("### 8.3 بعد الإصدار", "### 8.3 After issuing", "26-invoice", "فاتورة إنجاز مفتوحة", "An open progress invoice", [
 ("المشروع الذي تتبع له الفاتورة.", "The project the invoice belongs to."),
 ("نسبة المحتجزات التي تُخصم من هذه الفاتورة.", "Retention % deducted on this invoice."),
 ("الإجمالي والضريبة والمحتجزات.", "Totals, VAT and retention."),
 ("«شهادة الدفع (المستخلص)» وPDF: المستخلص المرحلي مع السابق والحالي والتراكمي.", "Payment certificate and PDF: the IPC with previous, current and cumulative."),
 ("«تسجيل دفعة» عند استلام المبلغ من العميل.", "Record payment when the client pays."),
 ("«إصدار إشعار دائن» لتخفيض الفاتورة أو إلغائها محاسبياً.", "Issue credit note to reduce or reverse the invoice."),
 ("«إلغاء الفاتورة»: لمدير النظام فقط، مع سبب إلزامي. الفاتورة الضريبية لا تُحذف.", "Void: administrator only, with a mandatory reason. Tax invoices are never deleted.")]),
("## 9. المدفوعات والمقبوضات", "## 9. Payments and receipts", "27-payment", "نافذة تسجيل دفعة", "Record payment window", [
 ("النوع: مقبوضات من عميل، أو دفعة لمورد.", "Type: receipt from a client, or payment to a supplier."),
 ("الفاتورة أو المصروف المرتبط (تظهر المفتوحة فقط مع رصيدها).", "The linked invoice or bill (only open ones, with their balance)."),
 ("المبلغ (يُقترح الرصيد المتبقي تلقائياً).", "Amount (the remaining balance is suggested)."),
 ("طريقة الدفع: تحويل، شيك، نقد، بطاقة. والحساب البنكي إذا كان لديك أكثر من بنك.", "Method: transfer, cheque, cash, card; and the bank account if you have several."),
 ("للشيك: تاريخ الاستحقاق والحالة. الشيك «قيد التحصيل» لا يدخل الرصيد النقدي حتى يُصرف.", "For cheques: date and status. A pending cheque is not counted in cash until it clears."),
 ("علّم هذا الخيار إذا كانت الدفعة إفراجاً عن المحتجزات.", "Tick this if the payment is a retention release."),
 ("احفظ.", "Save.")]),
("## 10. أعمار الديون وكشوف الحساب", "## 10. Ageing and statements of account", "28-ageing", "أعمار الديون", "Ageing report", [
 ("التاريخ الذي تُحسب عليه الأعمار.", "The date ageing is calculated at."),
 ("الأرصدة موزعة حسب أيام التأخير: حالي، 1–30، 31–60، 61–90، أكثر من 90، والمحتجزات.", "Balances split by days overdue: current, 1–30, 31–60, 61–90, 90+, and retention."),
 ("اضغط على العميل أو المورد لفتح كشف حسابه.", "Click a customer or supplier to open its statement.")]),
("## 10. أعمار الديون وكشوف الحساب", "## 10. Ageing and statements of account", "29-statement", "كشف حساب عميل", "Customer statement", [
 ("اختر الفترة.", "Choose the period."),
 ("طباعة الكشف بترويسة الشركة.", "Print the statement on the letterhead."),
 ("إرساله بالإيميل للعميل مع PDF.", "Email it to the client with a PDF.")]),
("## 11. يومية الموقع", "## 11. Site diary", "30-sitediary", "نموذج يومية الموقع", "Site diary form", [
 ("المشروع وتاريخ اليوم.", "Project and date."),
 ("الطقس وعدد العمال في الموقع.", "Weather and manpower on site."),
 ("الأعمال المنجزة اليوم بالتفصيل.", "Work done today in detail."),
 ("العوائق والتأخيرات (مهمة للمطالبات لاحقاً).", "Issues and delays (useful for claims later)."),
 ("احفظ.", "Save.")]),
("### 12.1 طلب الأسعار ومقارنة الموردين", "### 12.1 RFQ and supplier comparison", "31-rfq", "طلب أسعار ومقارنة الموردين", "RFQ and supplier comparison", [
 ("البنود المطلوبة: الوصف والوحدة والكمية.", "Required items: description, unit, quantity."),
 ("عمود لكل مورد: اختر المورد واكتب سعره لكل بند. الإجمالي يُحسب تلقائياً.", "One column per supplier: pick the supplier and type their rate per item. Totals are automatic."),
 ("إضافة مورد آخر للمقارنة.", "Add another supplier to compare."),
 ("الأقل سعراً يظهر مُبرزاً. «ترسية + أمر شراء» تحت المورد المختار ينشئ أمر الشراء فوراً.", "The lowest total is highlighted. Award + PO under the chosen supplier creates the purchase order at once.")]),
("## 13. المصروفات والمشتريات", "## 13. Expenses and purchases", "33-bill", "مصروف موزّع على مشروعين", "Expense split across two projects", [
 ("المورد.", "Supplier."),
 ("البند: يحدد نوع التكلفة في تقارير المشروع (واختر «شراء أصل ثابت» للأصول).", "Category: sets the cost type in project reports (use Fixed asset purchase for assets)."),
 ("المبلغ بدون ضريبة، ومبلغ الضريبة كما في فاتورة المورد.", "Amount ex VAT and the VAT as on the supplier invoice."),
 ("رقم فاتورة المورد للرجوع إليها.", "Supplier invoice number for reference."),
 ("علّم هذا الخيار لتوزيع المصروف على عدة مشاريع.", "Tick to split the expense across projects."),
 ("اختر المشاريع ونسبة كل مشروع؛ يجب أن يكون المجموع 100% (يظهر بالأخضر).", "Choose the projects and each %; the total must be 100% (shown in green)."),
 ("احفظ، ثم «تسجيل دفعة» عند الدفع.", "Save, then Record payment when you pay.")]),
("### 14.1 عقد مقاول الباطن", "### 14.1 Subcontract", "34-subcontract", "عقد مقاول باطن وشهاداته", "Subcontract and its certificates", [
 ("شهادة دفع جديدة لهذا العقد.", "New payment certificate for this subcontract."),
 ("الشهادات السابقة: التراكمي، هذه الفترة، المحتجزات، المستحق، والحالة.", "Previous certificates: cumulative, this period, retention, payable and status.")]),
("## 15. المخزون", "## 15. Stock", "36-stock", "المخزون", "Stock", [
 ("إضافة صنف جديد.", "Add a new item."),
 ("حركة مخزون: استلام، صرف لمشروع، أو تسوية.", "Stock movement: receive, issue to project, or adjust."),
 ("الكميات ومتوسط التكلفة والقيمة، وتنبيه عند النزول تحت حد إعادة الطلب.", "Quantities, average cost, value, and a flag under the reorder level.")]),
("## 17. العهدة النقدية", "## 17. Petty cash", "37-petty", "العهدة النقدية", "Petty cash", [
 ("تغذية العهدة بمبلغ نقدي.", "Top up the cash float."),
 ("مصروف نقدي على مشروع (يُسجَّل كمصروف مع الضريبة).", "Cash expense on a project (booked as an expense with VAT)."),
 ("الرصيد المتبقي في العهدة.", "Remaining float balance.")]),
("## 16. الأصول والمعدات", "## 16. Assets and equipment", "38-assets", "الأصول والمعدات", "Assets & equipment", [
 ("إضافة أصل (سيارة، معدة، جهاز).", "Add an asset (vehicle, plant, equipment)."),
 ("الإهلاك المجمع والقيمة الدفترية تُحسب شهرياً تلقائياً.", "Accumulated depreciation and book value are calculated monthly.")]),
("### 18.1 ملف الموظف", "### 18.1 Employee record", "40-employees", "قائمة الموظفين", "Employee list", [
 ("إضافة موظف جديد.", "Add a new employee."),
 ("اضغط الموظف لفتح ملفه الكامل.", "Click an employee to open the full record."),
 ("مكافأة نهاية الخدمة التقديرية حتى اليوم.", "Estimated end-of-service gratuity to date."),
 ("يظهر «ناقص» بالأحمر إذا لم يُدخل الآيبان.", "Shows “missing” in red when the IBAN is not entered.")]),
("### 18.1 ملف الموظف", "### 18.1 Employee record", "41-employee-new", "نموذج موظف جديد", "New employee form", [
 ("الاسم كما في جواز السفر (إلزامي). بجانبه المهنة.", "Name as in the passport (required). Next to it the designation."),
 ("رقم بطاقة العمل 14 رقماً، ورقم الهوية والجواز والجنسية: مطلوبة لـ WPS والمستندات.", "14-digit labour card number, Emirates ID, passport, nationality: needed for WPS and documents."),
 ("تاريخ الالتحاق: منه تُحسب الإجازات ونهاية الخدمة.", "Join date: leave and gratuity are calculated from it."),
 ("تحميل التكلفة: المشروع الذي يُحمَّل عليه راتبه، أو «عمومي» للإدارة.", "Cost charged to: the project carrying the salary, or General for head office."),
 ("الراتب الأساسي والبدلات (سكن، مواصلات، أخرى).", "Basic wage and allowances (housing, transport, other)."),
 ("البنك أو الصرافة، رمز التوجيه 9 أرقام، والآيبان: بدونها لا يدخل في ملف SIF.", "Bank or exchange house, 9-digit routing code, IBAN: without them the employee is left out of the SIF."),
 ("تواريخ انتهاء الهوية والإقامة والجواز وبطاقة العمل: تصل تنبيهات قبل الانتهاء.", "Expiry of Emirates ID, visa, passport and labour card: alerts come before they expire."),
 ("المدير المباشر: أول من يعتمد إجازاته.", "Line manager: first to approve their leave."),
 ("نهاية فترة التجربة (حتى 6 أشهر).", "End of probation (max 6 months)."),
 ("احفظ.", "Save.")]),
("### 18.2 بعد الحفظ — افتح ملف الموظف مرة أخرى", "### 18.2 After saving — open the employee again", "42-employee-extras", "أسفل ملف الموظف", "Bottom of the employee record", [
 ("المستندات المرفقة: ارفع الجواز والإقامة والعقد مع تاريخ الانتهاء.", "Attached documents: upload passport, visa, contract with expiry."),
 ("حساب بوابة الموظف: اسم مستخدم وكلمة مرور ليدخل من جواله.", "Employee portal account: username and password for their phone."),
 ("الانضمام والمغادرة: قائمة إجراءات الانضمام، والتسوية عند المغادرة.", "Onboarding & offboarding: the onboarding checklist, and the settlement when leaving.")]),
("### 18.2 بعد الحفظ — افتح ملف الموظف مرة أخرى", "### 18.2 After saving — open the employee again", "43-onboarding", "قائمة إجراءات الانضمام", "Onboarding checklist", [
 ("علّم كل بند عند إنجازه؛ يُحفظ اسم من أنجزه والتاريخ.", "Tick each step when done; who did it and when is saved."),
 ("قسم المغادرة والتسوية النهائية (البند 25).", "The leaving & final settlement part (section 25).")]),
("## 19. الحضور والعمل الإضافي", "## 19. Attendance and overtime", "44-attendance", "صفحة الحضور اليومي", "Daily attendance page", [
 ("اختر التاريخ.", "Choose the date."),
 ("«تسجيل حضور الفريق» للعمال بدون هاتف.", "Clock in my crew, for workers without a phone."),
 ("حالة اليوم لكل موظف: حاضر، غائب، إجازة، مرضي، عطلة، راحة.", "Day status per employee: present, absent, leave, sick, holiday, off."),
 ("ساعات الإضافي +25% (نهاري) و+50% (ليلي أو راحة). تنتقل للرواتب.", "Overtime hours +25% (day) and +50% (night or rest day). They feed payroll."),
 ("المشروع الذي عمل فيه (لتوزيع تكلفة الراتب).", "The project worked on (for salary cost allocation).")]),
("### 19.2 العمال بدون هاتف (الفورمان / المشرف)", "### 19.2 Crew without phones (foreman / supervisor)", "45-crew", "تسجيل حضور الفريق", "Clock in my crew", [
 ("اختر دخول أو خروج.", "Choose In or Out."),
 ("علّم أسماء العمال الموجودين.", "Tick the workers present."),
 ("«تسجيل»: يُحفظ الوقت من الخادم مع موقع جوالك.", "Record: the server time is saved with your phone location.")]),
("## 20. الإجازات", "## 20. Leave", "46-leave", "صفحة الإجازات", "Leave page", [
 ("تسجيل إجازة لموظف.", "Record leave for an employee."),
 ("قرار: موافقة أو رفض الإجازة المعلّقة.", "Decide: approve or reject pending leave."),
 ("أرصدة الإجازات لكل موظف.", "Leave balances per employee.")]),
("## 20. الإجازات", "## 20. Leave", "47-leave-new", "نموذج إجازة", "Leave form", [
 ("الموظف.", "Employee."),
 ("نوع الإجازة: سنوية، مرضية، بدون راتب…", "Leave type: annual, sick, unpaid…"),
 ("من تاريخ وإلى تاريخ؛ تُحسب الأيام تلقائياً.", "From and to dates; the days are calculated."),
 ("السبب.", "Reason."),
 ("احفظ.", "Save.")]),
("## 21. طلبات الموظفين والسلف", "## 21. Employee requests and salary advances", "48-requests", "طلبات الموظفين والسلف", "Employee requests and advances", [
 ("تسجيل طلب نيابةً عن موظف.", "File a request on behalf of an employee."),
 ("طلب خطاب (شهادة راتب، NOC…): «إصدار الخطاب» مباشرةً.", "Letter request (salary certificate, NOC…): Issue letter directly."),
 ("باقي الطلبات (سلفة، تجديد…): «قرار».", "Other requests (advance, renewal…): Decide."),
 ("سلفة جديدة بأقساط تُخصم تلقائياً من الراتب.", "New advance with instalments deducted from salary automatically.")]),
("## 22. الاعتمادات", "## 22. Approvals", "49-approvals", "صفحة الاعتمادات", "Approvals page", [
 ("موافقة: ينتقل الطلب للمستوى التالي أو يُعتمد نهائياً.", "Approve: moves to the next level or is finally approved."),
 ("رفض مع كتابة السبب؛ يصل للموظف.", "Reject with a reason; the employee is told.")]),
("## 23. الخطابات الرسمية", "## 23. Official letters", "50-letter-new", "نموذج خطاب جديد", "New letter form", [
 ("الموظف.", "Employee."),
 ("نوع الخطاب: شهادة راتب، شهادة عمل، NOC، تحويل راتب، خبرة.", "Letter type: salary, employment, NOC, salary transfer, experience."),
 ("الجهة الموجّه إليها (مثل اسم البنك أو السفارة).", "Addressed to (e.g. the bank or embassy)."),
 ("الغرض (سفر، قرض…).", "Purpose (travel, loan…)."),
 ("إصدار وطباعة: يأخذ رقماً مرجعياً ويُطبع بالترويسة الرسمية والختم.", "Issue & print: gets a reference number and prints on the official letterhead with stamp.")]),
("## 24. الرواتب ونظام حماية الأجور", "## 24. Payroll and WPS", "51-payroll", "كشف رواتب الشهر قبل الاعتماد", "Monthly payroll before finalizing", [
 ("اختر الشهر.", "Choose the month."),
 ("«إنشاء كشف الشهر»: يجمع الرواتب والحضور والإضافي والإجازات والسلف. إذا كانت هناك بيانات ناقصة (آيبان، رمز توجيه…) يظهر مربع أحمر «بيانات ناقصة / تنبيهات» فوق الجدول؛ صحّحها في ملف الموظف أولاً.", "Generate month: pulls salaries, attendance, overtime, leave and advances. If data is missing (IBAN, routing code…), a red “Missing data / warnings” box appears above the table — fix it in the employee record first."),
 ("الخانات قابلة للتعديل: الأيام، الإضافي، المكافآت، الخصومات؛ ويُعاد حساب الصافي.", "Editable cells: days, overtime, bonus, deductions; the net recalculates."),
 ("«اعتماد الكشف»: يقفل الشهر ويسجل القيود ومخصص نهاية الخدمة.", "Finalize payroll: locks the month and books entries and the gratuity provision.")]),
("## 24. الرواتب ونظام حماية الأجور", "## 24. Payroll and WPS", "52-payroll-final", "كشف معتمد ومدفوع", "Finalized and paid payroll", [
 ("تحميل ملف SIF ورفعه في بوابة البنك أو الصرافة.", "Download the SIF and upload it to the bank or exchange house portal."),
 ("بعد التحويل اضغط «تم تحويل الرواتب»، فيظهر «مدفوع» مع التاريخ.", "After the transfer press Mark salaries paid; it shows Paid with the date."),
 ("تصدير الكشف إلى Excel.", "Export the sheet to Excel.")]),
("## 25. مغادرة الموظف والتسوية النهائية", "## 25. Employee leaving and final settlement", "53-offboarding", "المغادرة والتسوية النهائية", "Leaving & final settlement", [
 ("أدخل آخر يوم عمل، والسبب، وتاريخ الإشعار، وأي خصومات.", "Enter the last day, reason, notice date and any deductions."),
 ("«بدء المغادرة وحساب التسوية»: يحسب الراتب حتى آخر يوم وبدل الإجازات ونهاية الخدمة والسلفة.", "Start offboarding & calculate: works out salary to the last day, leave pay, gratuity and advance.")]),
("## 26. لوحة الموارد البشرية: مستويات الاعتماد وقواعد الحضور", "## 26. HR dashboard: approval chains and attendance rules", "54-hrdash", "لوحة الموارد البشرية", "HR dashboard", [
 ("الموظفون النشطون، والإجازات والطلبات المعلّقة، ومن في إجازة اليوم.", "Active staff, pending leave and requests, who is on leave today."),
 ("مستندات تنتهي خلال 60 يوماً.", "Documents expiring within 60 days."),
 ("مراجعة الالتزام بقانون العمل لهذا الشهر.", "Labour-law compliance issues this month.")]),
("### 26.1 مستويات الاعتماد", "### 26.1 Approval chains", "55-hr-rules", "مستويات الاعتماد وقواعد الحضور", "Approval chains and attendance rules", [
 ("مستويات الاعتماد: لكل مستوى المعتمِد والحد الأدنى (أيام أو مبلغ).", "Approval chains: each level's approver and threshold (days or amount)."),
 ("حفظ المستويات.", "Save the chains."),
 ("قواعد الحضور: ساعات العمل، يوم الراحة، التسجيل خارج الموقع، رمضان، حظر الظهيرة.", "Attendance rules: hours, rest day, outside-site clocking, Ramadan, midday ban.")]),
("## 27. بوابة الموظف", "## 27. Employee portal (for staff)", "56-portal", "بوابة الموظف على الجوال", "Employee portal on a phone", [
 ("زر كبير لتسجيل الحضور والانصراف مع الموقع.", "Big button to clock in and out with location."),
 ("طلب إجازة.", "Request leave."),
 ("طلب آخر: شهادة راتب، NOC، سلفة…", "Other request: salary certificate, NOC, advance…"),
 ("رصيد الإجازات. وفي الأسفل: طلباتي، والخطابات، وقسائم الراتب.", "Leave balance. Further down: my requests, letters and payslips.")]),
("## 28. المحاسبة", "## 28. Accounting", "60-coa", "دليل الحسابات", "Chart of accounts", [
 ("حساب جديد.", "New account."),
 ("اضغط حساباً لتعديل اسمه.", "Click an account to edit its name.")]),
("## 28. المحاسبة", "## 28. Accounting", "61-journal", "قيد يومية يدوي", "Manual journal entry", [
 ("التاريخ والبيان.", "Date and memo."),
 ("الأسطر: اختر الحساب واكتب المدين أو الدائن.", "Lines: pick the account and type debit or credit."),
 ("إضافة سطر.", "Add a line."),
 ("الحفظ يتطلب أن يتساوى المدين والدائن.", "Saving requires debits to equal credits.")]),
("## 28. المحاسبة", "## 28. Accounting", "62-financials", "القوائم المالية", "Financial statements", [
 ("الفترة من / إلى.", "Period from / to."),
 ("عرض.", "Show."),
 ("الإيرادات والمصروفات وصافي الربح، ثم ميزان المراجعة وقائمة الدخل والمركز المالي.", "Revenue, expenses, net profit; then trial balance, P&L and balance sheet.")]),
("## 28. المحاسبة", "## 28. Accounting", "63-bank", "مطابقة البنك", "Bank reconciliation", [
 ("الحسابات البنكية.", "Bank accounts."),
 ("استيراد كشف البنك (CSV أو لصق).", "Import the bank statement (CSV or paste)."),
 ("مطابقة تلقائية للحركات.", "Auto-match the lines."),
 ("رصيد الكشف، رصيد الدفاتر، والفرق (يجب أن يكون صفراً).", "Statement balance, book balance and the difference (should be zero).")]),
("## 29. الربط مع Zoho Books", "## 29. Zoho Books link", "64-zoho", "الربط مع Zoho Books", "Zoho Books link", [
 ("تجربة بدون إرسال: تعرض ما سيُنشأ أو يُحدَّث في Zoho دون كتابة أي شيء. بعد الربط يظهر بجانبها «إرسال إلى Zoho الآن».", "Dry run: shows what would be created or updated in Zoho without writing anything. Once connected, Send to Zoho now appears next to it."),
 ("تقرير المعاملات اليومي: ما فُوتر وصُرف وقُبض ودُفع في كل يوم.", "Daily transactions report: what was invoiced, billed, received and paid each day.")]),
("## 30. الضرائب والامتثال", "## 30. Tax and compliance", "65-vat", "تقرير ضريبة القيمة المضافة", "VAT report", [
 ("الفترة الضريبية.", "Tax period."),
 ("المبيعات وضريبة المخرجات والمدخلات وصافي الضريبة.", "Sales, output and input VAT, net VAT."),
 ("المبيعات حسب الإمارة للخانة 1 في الإقرار.", "Sales by emirate for box 1 of the return.")]),
("## 30. الضرائب والامتثال", "## 30. Tax and compliance", "66-compliance", "الامتثال والتدقيق", "Compliance & audit", [
 ("كل التنبيهات في مكان واحد: انتهاء الرخصة والهويات والإقامات، عملاء بدون رقم ضريبي، رواتب متأخرة، شيكات مرتجعة.", "All alerts in one place: licence, ID and visa expiries, clients without TRN, late salaries, bounced cheques."),
 ("المواعيد الأساسية: إقرار الضريبة، ضريبة الشركات، الرواتب، ومدة حفظ السجلات.", "Key deadlines: VAT return, corporate tax, salaries and record retention."),
 ("جاهزية الفوترة الإلكترونية: الفواتير التي ينقصها بيانات.", "E-invoicing readiness: invoices with missing data.")]),
("## 30. الضرائب والامتثال", "## 30. Tax and compliance", "67-documents", "المستندات", "Documents", [
 ("مستندات الشركة مع تاريخ الانتهاء.", "Company documents with expiry."),
 ("كل المرفقات في النظام.", "Every attachment in the system.")]),
("## 31. المهام والملاحظات والإشعارات", "## 31. Tasks, notes and notifications", "68-task-new", "مهمة جديدة", "New task", [
 ("عنوان المهمة.", "Task title."),
 ("المسؤول عنها، ويصله إشعار.", "The assignee, who is notified."),
 ("تاريخ الاستحقاق.", "Due date."),
 ("المشروع المرتبط.", "Related project."),
 ("احفظ.", "Save.")]),
("## 31. المهام والملاحظات والإشعارات", "## 31. Tasks, notes and notifications", "69-notifications", "الإشعارات", "Notifications", [
 ("تفعيل الإشعارات على هذا الجهاز (الجوال) لتصلك الاعتمادات والتنبيهات حتى والتطبيق مغلق. أسفلها قائمة الإشعارات، و«تعليم الكل كمقروء» عند وجود إشعارات.", "Turn on notifications on this device (phone) to get approvals and alerts even when the app is closed. Below it is the list, with Mark all read when there are notifications.")]),
("## 32. الطباعة وPDF وExcel والجوال", "## 32. Printing, PDF, Excel and mobile", "70-mobile", "النظام على الجوال", "The system on a phone", [
 ("زر ☰ يفتح القائمة.", "The ☰ button opens the menu.")]),
("## 32. الطباعة وPDF وExcel والجوال", "## 32. Printing, PDF, Excel and mobile", "71-mobile-menu", "القائمة على الجوال", "The menu on a phone", [
 ("اختر الصفحة من القائمة.", "Pick a page from the menu.")]),
("### 2.7 نصوص المستندات والتواقيع", "### 2.7 Document texts and signatories", "81-settings-legal", "الإعدادات — الاسم القانوني والتواقيع", "Settings — legal name and signatories", [
 ("الاسم القانوني كما في الرخصة وشهادة الضريبة: يظهر مع الرقم الضريبي أعلى الفواتير الضريبية والإشعارات الدائنة وشهادات مقاولي الباطن.", "Legal name as on the licence and TRN certificate: shown with the TRN at the top of tax invoices, credit notes and subcontractor certificates."),
 ("خانات التوقيع في شهادات دفع مقاولي الباطن، مفصولة بفاصلة.", "Signature boxes on subcontractor payment certificates, comma-separated."),
 ("اسم ومنصب من يوقّع اتفاقيات عقد الباطن عن الشركة.", "Name and position of whoever signs sub-contract agreements for the company.")]),
("### 2.7 نصوص المستندات والتواقيع", "### 2.7 Document texts and signatories", "82-settings-texts", "الإعدادات — نصوص الاتفاقية وأوامر الشراء", "Settings — agreement and purchase-order texts", [
 ("نص اتفاقية عقد الباطن القياسي: الكلمات بين {{ }} تُعبّأ تلقائياً من بيانات كل عقد.", "Standard sub-contract wording: words between {{ }} fill in from each subcontract."),
 ("الملاحظات الثابتة التي تُطبع على كل أمر شراء.", "Standard notes printed on every purchase order."),
 ("الشروط العامة للشراء: صفحة ثانية في كل أمر شراء؛ فارغة = بدون صفحة.", "General conditions of purchase: page 2 of every purchase order; empty = no page.")]),
("### 7.1 إضافة مشروع", "### 7.1 Add a project", "72-project-contract", "حقول العمل مع مقاول رئيسي في نموذج المشروع", "Fields for work under a main contractor", [
 ("العقد الرئيسي: اسم عقد المقاول الرئيسي، يُطبع على البروفورما والفاتورة.", "Main contract: the main contractor's contract name, printed on the proforma and invoice."),
 ("رقم العقد أو عقد الباطن أو أمر الشراء من العميل: يُطبع على كل فاتورة.", "Contract / sub-contract / PO no. from the client: printed on every invoice."),
 ("مدة الدفع بالأيام: تاريخ استحقاق الفواتير الصادرة من الـ PC.", "Payment terms in days: due date of invoices issued from a PC."),
 ("أساس الضريبة في الـ PC: على الصافي بعد المحتجزات والخصومات، أو على قيمة الأعمال.", "VAT basis on PCs: on the net after retention and contra charges, or on the work value.")]),
("### 8.4 العمل مع مقاول رئيسي: البروفورما (طلب الدفعة)", "### 8.4 Working under a main contractor: proforma (payment application)", "73-claims-card", "بطاقة البروفورما وشهادات الدفع في صفحة المشروع", "Proformas & payment certificates card on the project page", [
 ("بروفورما جديدة تُعبّأ من جدول الكميات.", "New proforma filled from the BOQ."),
 ("تسجيل PC مستلم بدون بروفورما (مثل أول PC في النظام).", "Record a PC received without a proforma (e.g. the first PC in the system)."),
 ("صافي المطلوب في كل بروفورما.", "Net claimed on each proforma."),
 ("صافي المعتمد في الـ PC والفرق عن المطلوب (بالأحمر إذا خُصم).", "Net certified on the PC and the difference from the claim (red when cut)."),
 ("الفاتورة الضريبية الصادرة من الـ PC؛ اضغطها لفتحها.", "The tax invoice issued from the PC; click it to open.")]),
("### 8.4 العمل مع مقاول رئيسي: البروفورما (طلب الدفعة)", "### 8.4 Working under a main contractor: proforma (payment application)", "74-proforma", "نافذة البروفورما", "Proforma window", [
 ("للأعمال حتى تاريخ.", "For works up to."),
 ("المواد بالموقع (تراكمي) إن وجدت.", "Materials on site (cumulative), if any."),
 ("الكمية التراكمية لكل بند؛ السابق يأتي من آخر PC.", "Cumulative quantity per item; the previous one comes from the last PC."),
 ("الملخص التراكمي: الأعمال (A)، المحتجزات والخصومات والدفعات السابقة (B)، والصافي.", "Cumulative summary: work (A), retention, contra and previous payments (B), and the net."),
 ("طباعة البروفورما بالإنجليزية بدون ضريبة أو رقم ضريبي أو بيانات بنك.", "Print the proforma in English without VAT, TRN or bank details."),
 ("بعد الإرسال للمقاول الرئيسي: تعليم كمُقدَّم.", "After sending it to the main contractor: mark as submitted."),
 ("عند وصول الـ PC: تسجيل الـ PC المستلم.", "When the PC arrives: record the PC received.")]),
("### 8.4 العمل مع مقاول رئيسي: البروفورما (طلب الدفعة)", "### 8.4 Working under a main contractor: proforma (payment application)", "p1-proforma", "البروفورما مطبوعة", "The printed proforma", [
 ("جدول الكميات: كمية العقد، السابق، هذه الفترة، التراكمي والمبلغ والنسبة.", "BOQ: contract quantity, previous, this period, cumulative, amount and %."),
 ("الملخص والصافي بالحروف — بدون ضريبة أو رقم ضريبي أو بيانات بنك.", "Summary and the net in words — no VAT, TRN or bank details.")]),
("### 8.5 تسجيل الـ PC المستلم", "### 8.5 Recording the PC received", "75-pc", "نافذة تسجيل الـ PC", "Recording a PC", [
 ("رقم الـ PC وتاريخ إصداره.", "PC no. and date of issue."),
 ("البروفورما التي يعتمدها هذا الـ PC.", "The proforma this PC certifies."),
 ("الأرقام التراكمية كما هي مطبوعة على الـ PC.", "The cumulative figures exactly as printed on the PC."),
 ("الدفعات السابقة: تُحسب تلقائياً من الشهادات السابقة؛ قارنها بالـ PC.", "Previous payments: worked out from the earlier certificates; compare with the PC."),
 ("الكمية المعتمدة لكل بند: عدّل ما خصمه المقاول الرئيسي.", "Certified quantity per item: change what the main contractor cut."),
 ("استخدم مجموع البنود كقيمة الأعمال.", "Use the item total as the value of work done."),
 ("الصافي والضريبة والمجموع كما ستكون في الفاتورة، وملخص الضريبة.", "Net, VAT and total as they will be invoiced, and the VAT summary."),
 ("احفظ؛ ثم يظهر زر «إصدار الفاتورة الضريبية».", "Save; the Issue the tax invoice button then appears.")]),
("### 8.6 الفاتورة الضريبية من الـ PC", "### 8.6 Tax invoice from the PC", "76-pc-invoice", "فاتورة ضريبية صادرة من PC", "Tax invoice issued from a PC", [
 ("مرجع العميل: رقم الـ PC.", "Client reference: the PC number."),
 ("البنود من الـ PC: أعمال الفترة، والخصومات؛ لا تُعدَّل هنا.", "Lines from the PC: work of the period and contra charges; not edited here."),
 ("الضريبة على الصافي بعد المحتجزات، والمستحق الآن يساوي الـ PC.", "VAT on the net after retention; due now equals the PC.")]),
("### 8.6 الفاتورة الضريبية من الـ PC", "### 8.6 Tax invoice from the PC", "p2-tax-invoice", "الفاتورة الضريبية مطبوعة", "The printed tax invoice", [
 ("الاسم القانوني والرقم الضريبي أعلى الصفحة؛ العميل ورقمه الضريبي وتفاصيل العقد والـ PC.", "Legal name and TRN at the top; client with TRN, contract details and the PC."),
 ("بيانات البنك بجانب الإجماليات، بدون خطوط توقيع.", "Bank details beside the totals, no signature lines.")]),
("### 12.2 أمر الشراء", "### 12.2 Purchase order", "77-po", "نافذة أمر الشراء", "Purchase order window", [
 ("المورد والمشروع.", "Supplier and project."),
 ("شروط الدفع.", "Terms of payment."),
 ("مكان التسليم ومسؤول الاستلام بالموقع.", "Deliver to and the site contact."),
 ("مدة الاتفاقية من / إلى.", "Agreement period from / to."),
 ("رقم طلب الشراء الداخلي ومرجع عرض سعر المورد.", "Purchase request no. and the supplier's quotation."),
 ("كود الصنف لكل بند.", "Item code per line."),
 ("الخصم % لكل بند؛ الصافي بعد الخصم.", "Discount % per line; the net after the discount."),
 ("مجموع الخصم والإجمالي قبل وبعد الضريبة.", "Total discount and the totals before and after VAT.")]),
("### 12.2 أمر الشراء", "### 12.2 Purchase order", "p4-purchase-order", "أمر الشراء مطبوعاً (الصفحة الأولى)", "The printed purchase order (page 1)", [
 ("المورد ورقمه الضريبي، وتريجون ورقمها الضريبي، وPR وعرض السعر.", "Supplier with TRN, Trigon with TRN, PR and quotation."),
 ("البنود بالكود والخصم، والإجمالي بالحروف، والملاحظات الثابتة، وتوقيع الطرفين؛ الشروط العامة في الصفحة الثانية.", "Lines with code and discount, total in words, standard notes and both signatures; the general conditions on page 2.")]),
("### 14.1 عقد مقاول الباطن", "### 14.1 Subcontract", "78-subcontract-form", "بيانات عقد الباطن", "Subcontract details", [
 ("رقم الاتفاقية وتاريخها.", "Agreement no. and date."),
 ("تواريخ البدء والإنجاز والتمديد.", "Start, completion and extended completion dates."),
 ("مجموع أوامر التغيير المعتمدة.", "Total of approved variations."),
 ("أساس الضريبة في الشهادات.", "VAT basis on certificates."),
 ("نسبة الإضافة على الخصومات (مثل 12%).", "Contra charge uplift (e.g. 12%).")]),
("### 14.2 شهادة الدفع", "### 14.2 Payment certificate", "79-subcert", "نافذة شهادة دفع مقاول الباطن", "Subcontractor payment certificate window", [
 ("للأعمال حتى تاريخ.", "For works up to."),
 ("الأعمال والمواد حتى تاريخه بشكل تراكمي.", "Work and materials to date, cumulative."),
 ("تكلفة الخصم: اكتبها فتُضاف النسبة وتظهر في الخصومات.", "Contra cost: type it and the uplift is added into the contra charges."),
 ("الإفراج عن محتجزات في هذه الشهادة.", "Release of retention in this certificate."),
 ("مرجع طلب الدفعة من المقاول؛ يُطبع في الملاحظات.", "The subcontractor's payment application; printed in the notes."),
 ("توزيع الأكواد: سطر لكل كود ثم المبلغ.", "Cost codes: one per line, code then amount."),
 ("ملخص الشهادة، وبعد الحفظ الأرقام التراكمية وملخص الضريبة.", "Certificate summary; after saving, the cumulative figures and VAT summary."),
 ("طباعة بشكل الـ PC.", "Print in the PC layout.")]),
("### 14.2 شهادة الدفع", "### 14.2 Payment certificate", "p3-sub-pc", "شهادة دفع مقاول الباطن مطبوعة", "The printed subcontractor payment certificate", [
 ("بيانات العقد والتواريخ، ثم المعتمد (A) والخصومات (B) والصافي والضريبة.", "Contract details and dates, then certified (A), deductions (B), net and VAT."),
 ("ملخص الضريبة والأكواد والملاحظات والمبلغ بالحروف وخانات التوقيع.", "VAT summary, cost codes, notes, amount in words and signature boxes.")]),
("### 14.3 اتفاقية عقد الباطن", "### 14.3 Sub-contract agreement", "80-sc-agreement", "نافذة اتفاقية عقد الباطن", "Sub-contract agreement window", [
 ("أيام الدفع وفترة الصيانة.", "Payment days and defects period."),
 ("رقم رخصة مقاول الباطن (يُطبع في مقدمة الاتفاقية).", "Sub-contractor licence no. (printed in the opening of the agreement)."),
 ("ملحق 1: جدول الكميات.", "Appendix 1: bill of quantities."),
 ("اجعل مجموع الجدول قيمة العقد.", "Use the BOQ total as the contract value."),
 ("ملحق 2: الشروط الخاصة ونطاق العمل.", "Appendix 2: particular conditions and scope."),
 ("ملحق 3: مصفوفة المسؤوليات — المقاول / مقاول الباطن / الاثنين / N/A.", "Appendix 3: responsibility matrix — contractor / sub-contractor / both / N/A."),
 ("طباعة / PDF.", "Print / PDF.")]),
("### 14.3 اتفاقية عقد الباطن", "### 14.3 Sub-contract agreement", "p5-sc-agreement", "صفحة من الاتفاقية مطبوعة", "A page of the printed agreement", [
 ("الأطراف والبنود مع الخانات معبّأة من بيانات العقد.", "The parties and the clauses with the fields filled in from the subcontract.")]),
]
import os, re, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs')
def build(lang):
    fn = f'{D}/USER-GUIDE-{lang.upper()}.md'
    s = open(fn, encoding='utf8').read()
    s = re.sub(r'<!--img-->.*?<!--/img-->\n*', '', s, flags=re.S); s = re.sub(r'\n{3,}', '\n\n', s)
    lines = s.split('\n')
    # group blocks by heading
    from collections import OrderedDict
    groups = OrderedDict()
    for b in B:
        h = b[0] if lang == 'ar' else b[1]
        groups.setdefault(h, []).append(b)
    for h, bs in groups.items():
        try: i = next(k for k, l in enumerate(lines) if l.strip() == h)
        except StopIteration: print('missing heading', lang, h); continue
        level = h.split(' ')[0]
        j = i + 1
        while j < len(lines) and not (lines[j].startswith('#') ) and lines[j].strip() != '---': j += 1
        out = []
        for b in bs:
            img = b[2]
            if not os.path.exists(f'{D}/../public/guide/img/{lang}/{img}.jpg'): print('no image', lang, img); continue
            cap = b[3] if lang == 'ar' else b[4]
            out += ['<!--img-->', '', f'**{"📷 " + cap}**', '', f'![{cap}](../public/guide/img/{lang}/{img}.jpg)', '']
            n = 0
            for k, (a, e) in enumerate(b[5], 1):
                if a is None: continue
                out.append(f'{k}. {a if lang == "ar" else e}')
            out += ['', '<!--/img-->']
        while j > 0 and lines[j - 1].strip() == '': j -= 1
        lines[j:j] = [''] + out
    open(fn, 'w', encoding='utf8').write('\n'.join(lines))
for l in ('ar', 'en'): build(l)
