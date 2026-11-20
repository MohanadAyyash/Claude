// Read-only Copilot foundation: deterministic server-side tools; the provider only phrases their projected results.
const BODY_LIMIT = 16 * 1024, QUESTION_LIMIT = 1000, RESULT_LIMIT = 50;
const USER_LIMIT = 20, GLOBAL_LIMIT = 200, WINDOW_MS = 60e3, PROVIDER_TIMEOUT_MS = 30e3;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const { project } = require('../lib/copilot-policy');
const list = value => String(value || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
const loadJose = () => { try { return require('jose'); } catch { return null; } };
const loopback = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
const { randomUUID } = require('node:crypto');
module.exports = ctx => {
  const { db, send } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS copilot_history (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL, answer TEXT NOT NULL, created_at INTEGER NOT NULL, auth_fingerprint TEXT,
    intent TEXT, data_json TEXT, context_json TEXT, conversation_id TEXT
  );
  CREATE INDEX IF NOT EXISTS copilot_history_user_created ON copilot_history(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS copilot_conversations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, auth_fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS copilot_conversations_user_updated ON copilot_conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS copilot_memory (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL, project_id INTEGER, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS copilot_memory_user_created ON copilot_memory(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS copilot_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    personalization_enabled INTEGER NOT NULL DEFAULT 1,
    language_counts TEXT NOT NULL DEFAULT '{}', intent_counts TEXT NOT NULL DEFAULT '{}',
    project_counts TEXT NOT NULL DEFAULT '{}', entity_counts TEXT NOT NULL DEFAULT '{}', filter_counts TEXT NOT NULL DEFAULT '{}',
    notice_seen INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS copilot_feedback (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    history_id INTEGER NOT NULL REFERENCES copilot_history(id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK(rating IN ('helpful','not_helpful')),
    reason TEXT CHECK(reason IS NULL OR reason IN ('inaccurate','unclear','incomplete','other')),
    created_at INTEGER NOT NULL, UNIQUE(user_id, history_id)
  );
  CREATE TABLE IF NOT EXISTS copilot_audit (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, event TEXT NOT NULL, intent TEXT,
    outcome TEXT NOT NULL, http_status INTEGER, created_at INTEGER NOT NULL,
    authorized_count INTEGER NOT NULL DEFAULT 0, redacted INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS copilot_audit_created ON copilot_audit(created_at DESC);`);
  const addCol = (table, column, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addCol('copilot_history', 'auth_fingerprint', 'TEXT');
  addCol('copilot_history', 'intent', 'TEXT');
  addCol('copilot_history', 'data_json', 'TEXT');
  addCol('copilot_history', 'context_json', 'TEXT');
  addCol('copilot_history', 'conversation_id', 'TEXT');
  addCol('copilot_preferences', 'entity_counts', "TEXT NOT NULL DEFAULT '{}'");
  addCol('copilot_audit', 'authorized_count', 'INTEGER NOT NULL DEFAULT 0');
  addCol('copilot_audit', 'redacted', 'INTEGER NOT NULL DEFAULT 0');
  addCol('copilot_audit', 'duration_ms', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS copilot_history_conversation ON copilot_history(user_id,conversation_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS copilot_purge_disabled_user AFTER UPDATE OF disabled ON users
    WHEN NEW.disabled=1 AND COALESCE(OLD.disabled,0)<>1
    BEGIN
      DELETE FROM copilot_conversations WHERE user_id=NEW.id;
      DELETE FROM copilot_history WHERE user_id=NEW.id;
      DELETE FROM copilot_memory WHERE user_id=NEW.id;
      DELETE FROM copilot_preferences WHERE user_id=NEW.id;
    END;`);

  const windows = { global: [], users: new Map() }, jwksSets = new Map();
  const now = () => Date.now();
  function configuredInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw).trim())) throw fail(503, `${name} must be an integer from ${min} to ${max}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(503, `${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  const resultLimit = () => Math.min(RESULT_LIMIT, configuredInt('COPILOT_MAX_RESULTS', RESULT_LIMIT, 1, RESULT_LIMIT));
  const timeoutMs = () => configuredInt('COPILOT_TIMEOUT_MS', PROVIDER_TIMEOUT_MS, 1000, PROVIDER_TIMEOUT_MS);
  const userLimit = () => configuredInt('COPILOT_USER_LIMIT', USER_LIMIT, 1, 1000);
  const globalLimit = () => configuredInt('COPILOT_GLOBAL_LIMIT', GLOBAL_LIMIT, 1, 10000);
  const historyDays = () => configuredInt('COPILOT_HISTORY_RETENTION_DAYS', 90, 1, 3650);
  const provider = require('../lib/ai-provider')({ fail, timeoutMs });
  const pruneHistory = () => {
    const cutoff = now() - historyDays() * 864e5;
    db.prepare('DELETE FROM copilot_history WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM copilot_conversations WHERE updated_at < ?').run(cutoff);
  };
  for (const row of db.prepare('SELECT id,user_id,question,created_at,auth_fingerprint FROM copilot_history WHERE conversation_id IS NULL ORDER BY id').all()) {
    const id = randomUUID();
    db.prepare('INSERT INTO copilot_conversations(id,user_id,title,created_at,updated_at,auth_fingerprint) VALUES(?,?,?,?,?,?)')
      .run(id, row.user_id, String(row.question).slice(0, 100), row.created_at, row.created_at, row.auth_fingerprint);
    db.prepare('UPDATE copilot_history SET conversation_id=? WHERE id=? AND conversation_id IS NULL').run(id, row.id);
  }
  pruneHistory();

  function auditEvent(userId, event, intent, outcome, status, metrics = {}) {
    const createdAt = now();
    db.prepare('DELETE FROM copilot_audit WHERE created_at < ?').run(createdAt - 365 * 864e5);
    db.prepare(`INSERT INTO copilot_audit(user_id,event,intent,outcome,http_status,created_at,authorized_count,redacted,duration_ms)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(userId, event, intent || null, outcome, status || null, createdAt,
      Number.isSafeInteger(metrics.authorizedCount) ? metrics.authorizedCount : 0, metrics.redacted ? 1 : 0,
      Number.isSafeInteger(metrics.durationMs) ? metrics.durationMs : null);
  }

  function featureAllowed(user) {
    if (process.env.COPILOT_ENABLED !== '1' || !user) return false;
    const ids = new Set(list(process.env.COPILOT_ALLOWED_USERS).filter(x => /^\d+$/.test(x)).map(Number).filter(x => Number.isSafeInteger(x) && x > 0));
    const roles = new Set(list(process.env.COPILOT_ALLOWED_ROLES).filter(x => ctx.ROLES.includes(x)));
    return ids.has(Number(user.id)) || roles.has(user.role);
  }

  function consumeQuery(userId) {
    const cutoff = now() - WINDOW_MS;
    windows.global = windows.global.filter(t => t > cutoff);
    for (const [id, times] of windows.users) {
      const active = times.filter(t => t > cutoff);
      if (active.length) windows.users.set(id, active); else windows.users.delete(id);
    }
    const times = windows.users.get(userId) || [];
    if (times.length >= userLimit() || windows.global.length >= globalLimit()) throw fail(429, 'Copilot query limit reached; try again in a minute');
    const t = now(); times.push(t); windows.users.set(userId, times); windows.global.push(t);
  }

  function entraConfig() {
    const env = process.env, tenant = String(env.COPILOT_ENTRA_TENANT_ID || '').trim().toLowerCase();
    const audience = String(env.COPILOT_ENTRA_API_AUDIENCE || '').trim();
    const loginClient = String(env.M365_CLIENT_ID || '').trim().toLowerCase();
    if (!GUID.test(tenant) || !audience || (loginClient && audience.toLowerCase() === loginClient.toLowerCase())) return null;
    const issuer = String(env.COPILOT_ENTRA_ISSUER || `https://login.microsoftonline.com/${tenant}/v2.0`).replace(/\/+$/, '');
    const jwksUrl = String(env.COPILOT_ENTRA_JWKS_URL || `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);
    try {
      const iss = new URL(issuer), jwks = new URL(jwksUrl);
      if ((!['https:', 'http:'].includes(iss.protocol) || (iss.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && loopback(iss.hostname)))) ||
          (!['https:', 'http:'].includes(jwks.protocol) || (jwks.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && loopback(jwks.hostname))) ) ||
          iss.username || iss.password || iss.search || iss.hash || jwks.username || jwks.password || jwks.hash) return null;
    } catch { return null; }
    return { tenant, audience, issuer, jwksUrl, loginClient };
  }

  async function bearerUser(req) {
    const header = String(req.headers.authorization || '');
    if (!header) return null;
    const tokenMatch = /^Bearer ([^\s]+)$/i.exec(header);
    if (!tokenMatch || tokenMatch[1].length > 16384 || process.env.COPILOT_ENTRA_ENABLED !== '1') return null;
    const cfg = entraConfig(), jose = loadJose();
    if (!cfg || !jose) throw fail(503, 'Copilot Entra authentication is not configured');
    if (!jwksSets.has(cfg.jwksUrl)) jwksSets.set(cfg.jwksUrl, jose.createRemoteJWKSet(new URL(cfg.jwksUrl), { timeoutDuration: timeoutMs(), cooldownDuration: 30e3, cacheMaxAge: 10 * 60e3 }));
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(tokenMatch[1], jwksSets.get(cfg.jwksUrl), {
        algorithms: ['RS256'], issuer: cfg.issuer, audience: cfg.audience, clockTolerance: 30,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'tid', 'oid', 'scp'],
      }));
    } catch (e) {
      const code = String(e && e.code || '');
      if (code.startsWith('ERR_JWKS_') && code !== 'ERR_JWKS_NO_MATCHING_KEY') throw fail(503, 'Copilot Entra signing keys could not be checked');
      return null;
    }
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (String(payload.tid).toLowerCase() !== cfg.tenant || !GUID.test(String(payload.oid)) ||
        aud.length !== 1 || aud[0] !== cfg.audience || (cfg.loginClient && aud.some(x => String(x).toLowerCase() === cfg.loginClient)) ||
        typeof payload.scp !== 'string' || !payload.scp.split(/\s+/).includes('Copilot.Read')) return null;
    const matches = db.prepare(`SELECT u.id,u.username,u.role,u.employee_id
      FROM m365_connections c JOIN users u ON u.id=c.user_id
      WHERE lower(c.tenant_id)=? AND lower(c.microsoft_user_id)=? AND COALESCE(u.disabled,0)=0 LIMIT 2`)
      .all(cfg.tenant, String(payload.oid).toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  }

  async function readBoundedJson(req) {
    if (req._body !== undefined) {
      if (Buffer.byteLength(JSON.stringify(req._body), 'utf8') > BODY_LIMIT) throw fail(413, 'Copilot request body is too large');
      return req._body;
    }
    let bytes = 0, settled = false;
    const chunks = [];
    return new Promise((resolve, reject) => {
      const refuse = (status, message) => {
        if (settled) return;
        settled = true; reject(fail(status, message)); req.resume();
      };
      req.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > BODY_LIMIT) return refuse(413, 'Copilot request body is too large');
        chunks.push(chunk);
      });
      req.on('error', e => { if (!settled) { settled = true; reject(e); } });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          resolve(value);
        } catch { reject(fail(400, 'Copilot request must be a JSON object')); }
      });
    });
  }

  const normalize = s => s.normalize('NFKC').toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  function unsafeQuestion(question) {
    const q = normalize(question);
    return /(?:https?:\/\/|ftp:\/\/|www\.)|(?:^|[\s])\.\.[\\/]/i.test(question) ||
      /\b(?:select|insert|update|delete|drop|alter|pragma|attach|create)\b[\s\S]{0,100}\b(?:from|into|table|database)\b/.test(q) ||
      /\b(?:microsoft graph|graph\.microsoft\.com|call graph|graph endpoint|api key|access token|refresh token|tokens?|password|secret|credential|webhook|private key|encryption key|totp|setup token|session token|password hash|payroll|salary|salaries|wps|iban|bank details?|bank account|emirates id|passport|employee(?:\s+(?:personal|identity|medical|bank))?\s+documents?|medical information|personal address|personal phone|general ledger|journal entries?|database backup|backups?|raw audit details?|audit security|security details?)\b/.test(q) ||
      /(?:\.env\b|رمز الدخول|كلمة المرور|كلمه المرور|بيانات الاعتماد|الرواتب|الراتب|أجور|راتب|نظام حماية الأجور|تفاصيل بنكية|بيانات بنكية|الحساب البنكي|رقم الحساب|جواز السفر|الهوية الإماراتية|الهوية الاماراتية|العنوان الشخصي|معلومات طبية|الهاتف الشخصي|كلمة سر|مفتاح تشفير|توكن|رمز جلسة|نسخة احتياطية|دفتر الأستاذ|دفتر الاستاذ)/.test(q);
  }
  function route(question) {
    const q = normalize(question);
    if (unsafeQuestion(question)) return null;
    if (/\b(payroll|salary|salaries|wps|iban|bank account|employee(?: personal| documents?)?|medical|passport|emirates id|general ledger|journal entries?)\b|الرواتب|الراتب|دفتر الاستاذ|دفتر الأستاذ|جواز السفر|الهوية الاماراتية/.test(q)) return null;
    if (/\b(quotes?|quotations?)\b|عروض الاسعار|عروض الأسعار|الاقتباسات/.test(q)) return 'quotation_summary';
    if (/\b(subcontractor payment certificates?|payment certificates?)\b|شهادات الدفع|شهادات مستخلصات المقاولين/.test(q)) return 'certificate_summary';
    if (/\b(sync failures?|failed uploads?|sharepoint failures?|(?:failed|failure|failures?).{0,30}(?:po|purchase order|document|sharepoint|sync)|(?:sharepoint|sync).{0,30}(?:fail|failed|failure|synchronization))\b|فشل المزامنه|فشل الحفظ|اخفاق المزامنه/.test(q)) return 'sync_failures';
    if (/\b(approval queue|pending approvals?|spend approvals?)\b|طلبات الاعتماد|قائمة الاعتمادات|اعتمادات الصرف/.test(q)) return 'approval_queue';
    if (/\b(documents?|attachments?|files?|drawings?|rfis?|submittals?)\b|مستندات|مرفقات|وثائق|رسومات|مخططات|التقديمات/.test(q)) return 'project_documents';
    if (/\b(subcontracts?|subcontractor contracts?|contracts?|contract summaries?)\b|عقود المقاولين|عقد مقاول باطن|مقاولو الباطن|العقود/.test(q)) return 'contract_summary';
    if (/\b(procurement|purchase orders?|pos?|rfqs?)\b|المشتريات|اوامر الشراء|أوامر الشراء|طلبات الاسعار|طلبات الأسعار/.test(q)) return 'procurement_status';
    if (/\b(invoices?|tax invoices?|credit notes?)\b|فواتير|فاتوره|اشعارات دائنه/.test(q)) return 'invoice_summary';
    if (/\b(revenue|invoiced|costs?|profit|margin|contract value|receivables?|collections?|financials?)\b|ايراد|تكلفه|ارباح|الربح|الهامش|المستحق|المقبوض|قيمه العقود/.test(q)) return 'project_financials';
    if (/\bprojects?\b|\bsites?\b|مشروع|مشاريع/.test(q)) return 'project_status';
    return null;
  }

  const PERSONALIZATION_DEFAULT = process.env.COPILOT_PERSONALIZATION_ENABLED !== '0';
  const COUNTER_COLUMNS = ['language_counts', 'intent_counts', 'project_counts', 'entity_counts', 'filter_counts'];
  const COUNTER_KEYS = new Set(['language_counts', 'intent_counts', 'project_counts', 'entity_counts', 'filter_counts']);
  const jsonObject = raw => {
    try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  };
  const jsonArray = raw => {
    try { const value = JSON.parse(raw || '[]'); return Array.isArray(value) ? value : []; }
    catch { return []; }
  };
  function preferenceRow(userId) {
    db.prepare('INSERT OR IGNORE INTO copilot_preferences(user_id,personalization_enabled,updated_at) VALUES(?,?,?)')
      .run(userId, PERSONALIZATION_DEFAULT ? 1 : 0, now());
    return db.prepare('SELECT * FROM copilot_preferences WHERE user_id=?').get(userId);
  }
  function personalizationOn(userId) {
    return PERSONALIZATION_DEFAULT && preferenceRow(userId).personalization_enabled === 1;
  }
  function projectAccessible(user, projectId) {
    if (!Number.isSafeInteger(+projectId) || +projectId < 1 || !ctx.can(user.role, 'GET', 'projects')) return false;
    const scope = projectIds(user);
    return (!scope || scope.has(+projectId)) && !!db.prepare('SELECT 1 FROM projects WHERE id=?').get(+projectId);
  }
  function purgeInaccessibleProjectPreferences(user) {
    const pref = preferenceRow(user.id);
    const projectCounts = jsonObject(pref.project_counts), allowed = {};
    for (const [id, count] of Object.entries(projectCounts)) {
      if (projectAccessible(user, +id) && Number.isSafeInteger(count) && count > 0) allowed[id] = count;
    }
    if (JSON.stringify(projectCounts) !== JSON.stringify(allowed)) {
      db.prepare('UPDATE copilot_preferences SET project_counts=?,updated_at=? WHERE user_id=?')
        .run(JSON.stringify(allowed), now(), user.id);
    }
    for (const item of db.prepare('SELECT id,project_id FROM copilot_memory WHERE user_id=? AND project_id IS NOT NULL').all(user.id)) {
      if (!projectAccessible(user, item.project_id)) db.prepare('DELETE FROM copilot_memory WHERE id=? AND user_id=?').run(item.id, user.id);
    }
  }
  function memoryPayload(user) {
    purgeInaccessibleProjectPreferences(user);
    const pref = preferenceRow(user.id), counts = {};
    for (const key of COUNTER_COLUMNS) counts[key] = jsonObject(pref[key]);
    const projects = Object.entries(counts.project_counts)
      .filter(([id]) => projectAccessible(user, +id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ id: +id, name: db.prepare('SELECT name FROM projects WHERE id=?').get(+id)?.name || '', count }));
    return {
      items: db.prepare('SELECT id,content,created_at,project_id FROM copilot_memory WHERE user_id=? ORDER BY created_at DESC,id DESC').all(user.id),
      personalization_enabled: PERSONALIZATION_DEFAULT && pref.personalization_enabled === 1,
      first_use_notice: pref.notice_seen !== 1,
      preferences: {
        language: Object.entries(counts.language_counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        intents: Object.entries(counts.intent_counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([intent, count]) => ({ intent, count })),
        projects,
        entities: Object.entries(counts.entity_counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([entity, count]) => ({ entity, count })),
        filters: Object.entries(counts.filter_counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([filter, count]) => ({ filter, count })),
      },
    };
  }
  function presentationPreferences(user) {
    const output = { currency: null, include_vat: false, language: null };
    for (const row of db.prepare('SELECT content FROM copilot_memory WHERE user_id=? ORDER BY created_at DESC,id DESC').all(user.id)) {
      const q = normalize(row.content);
      if (!output.language && /\b(?:answer|reply|respond|speak)\s+in\s+arabic\b|(?:اجب|أجب|رد|تحدث).{0,15}بالعربي/.test(q)) output.language = 'ar';
      if (!output.language && /\b(?:answer|reply|respond|speak)\s+in\s+english\b|(?:اجب|أجب|رد|تحدث).{0,15}بالانجليزي/.test(q)) output.language = 'en';
      if (!output.currency && /\baed\b|درهم/.test(q)) output.currency = 'AED';
      if (/\bvat\b|ضريبة/.test(q)) output.include_vat = true;
    }
    return output;
  }
  function policyOverrideMemory(content) {
    const q = normalize(content);
    return /\b(?:ignore|override|bypass|change|disable|forget|break).{0,50}(?:policy|rules|authorization|access|allowlist|exclusion|salary|payroll|wps|bank|secret|token|password)|\b(?:show|reveal|allow|permit).{0,40}(?:salary|salaries|payroll|wps|iban|bank details?|emirates id|passport|secrets?|tokens?|passwords?)\b/.test(q) ||
      /(?:تجاهل|تجاوز|غيّر|غير|اعرض|اظهر|اكشف).{0,40}(?:السياسة|الصلاحيات|الرواتب|الراتب|الآيبان|الهوية|كلمة المرور)/.test(q);
  }
  function sensitiveMemory(content) {
    const q = normalize(content);
    return /\b(?:payroll|salary|salaries|wps|iban|bank details?|bank account|emirates id|identity number|national id|passport|medical information|personal address|personal phone|password|secret|token|credential|webhook|private key|encryption key|totp|setup token|session token|password hash)\b|784-\d{4}-\d{7}-\d|AE\d{2}[A-Z0-9]{19,}|الرواتب|الراتب|أجور|راتب|الآيبان|ايبان|تفاصيل بنكية|بيانات بنكية|رقم الهوية|جواز السفر|الهوية الإماراتية|الهوية الاماراتية|معلومات طبية|العنوان الشخصي|الهاتف الشخصي|كلمة المرور|كلمة سر|مفتاح تشفير|توكن|رمز جلسة/.test(q);
  }
  function addMemory(user, content) {
    const value = String(content || '').trim();
    if (!value || Array.from(value).length > 300) throw fail(400, 'Memory must contain 1–300 characters');
    if (policyOverrideMemory(value)) throw fail(422, 'Memory cannot change Copilot policy, exclusions, or authorization');
    if (sensitiveMemory(value)) throw fail(422, 'Sensitive information cannot be saved in Copilot memory');
    const scope = projectIds(user), projectId = projectFilter(value, scope);
    const mentionsProject = /\b(?:project|site)\b|مشروع|موقع/.test(normalize(value));
    if (mentionsProject && projectId === 0) throw fail(403, 'I could not match that to a project you can access');
    const count = db.prepare('SELECT COUNT(*) n FROM copilot_memory WHERE user_id=?').get(user.id).n;
    if (count >= 50) throw fail(409, 'Your memory is full; delete an item before adding another');
    const result = db.prepare('INSERT INTO copilot_memory(user_id,content,project_id,created_at) VALUES(?,?,?,?)')
      .run(user.id, value, projectId || null, now());
    return Number(result.lastInsertRowid);
  }
  function incrementCounter(pref, column, key) {
    if (!COUNTER_KEYS.has(column) || !key || typeof key !== 'string') return;
    const counts = jsonObject(pref[column]);
    counts[key] = Math.min(1_000_000, (Number.isSafeInteger(counts[key]) ? counts[key] : 0) + 1);
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30);
    db.prepare(`UPDATE copilot_preferences SET ${column}=?,updated_at=? WHERE user_id=?`)
      .run(JSON.stringify(Object.fromEntries(entries)), now(), pref.user_id);
  }
  function learnUsage(user, question, intent, data) {
    if (!personalizationOn(user.id)) return;
    const pref = preferenceRow(user.id), q = normalize(question);
    incrementCounter(pref, 'language_counts', /[\u0600-\u06ff]/.test(question) ? 'ar' : 'en');
    incrementCounter(pref, 'intent_counts', intent);
    const entity = ({ project_status: 'project', project_financials: 'project', project_documents: 'document',
      invoice_summary: 'invoice', procurement_status: 'purchase_order', quotation_summary: 'quotation',
      contract_summary: 'contract', certificate_summary: 'certificate', approval_queue: 'approval', sync_failures: 'sync' })[intent];
    if (entity) incrementCounter(pref, 'entity_counts', entity);
    for (const id of new Set((data || []).map(row => Number(row.project_id || (intent.startsWith('project_') ? row.id : 0))).filter(Number.isSafeInteger).filter(id => id > 0))) {
      if (projectAccessible(user, id)) incrementCounter(preferenceRow(user.id), 'project_counts', String(id));
    }
    for (const filter of ['overdue', 'outstanding', 'open', 'active', 'expiring', 'approval']) {
      const rx = ({ overdue: /\boverdue|late|past due|متأخر/, outstanding: /\boutstanding|unpaid|receivable|المستحق|غير مدفوع/,
        open: /\bopen\b|مفتوح/, active: /\bactive\b|نشط/, expiring: /\bexpir|تنتهي|انتهاء/, approval: /\bapproval|pending approval|اعتماد/ })[filter];
      if (rx.test(q)) incrementCounter(preferenceRow(user.id), 'filter_counts', filter);
    }
  }

  const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function createConversation(user, title, fingerprint) {
    const id = randomUUID(), at = now();
    db.prepare('INSERT INTO copilot_conversations(id,user_id,title,created_at,updated_at,auth_fingerprint) VALUES(?,?,?,?,?,?)')
      .run(id, user.id, String(title || 'New conversation').slice(0, 100), at, at, fingerprint);
    return { id, user_id: user.id, title: String(title || 'New conversation').slice(0, 100), created_at: at, updated_at: at, auth_fingerprint: fingerprint };
  }
  function ownConversation(user, id) {
    if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) return null;
    return db.prepare('SELECT * FROM copilot_conversations WHERE id=? AND user_id=?').get(id, user.id) || null;
  }
  function messageContext(intent, data, question, prior = null) {
    const scope = {
      project_id: prior?.project_id || null,
      record_ids: [],
      filters: {},
    };
    const q = normalize(question);
    const filters = ['overdue', 'outstanding', 'open', 'active', 'expiring', 'approval'];
    for (const filter of filters) {
      const rx = ({ overdue: /\boverdue|late|past due|متأخر/, outstanding: /\boutstanding|unpaid|receivable|المستحق|غير مدفوع/,
        open: /\bopen\b|مفتوح/, active: /\bactive\b|نشط/, expiring: /\bexpir|تنتهي|انتهاء/, approval: /\bapproval|pending approval|اعتماد/ })[filter];
      if (rx.test(q)) scope.filters[filter] = true;
      else if (prior?.filters?.[filter]) scope.filters[filter] = true;
    }
    const records = [], referencedProjects = new Set();
    for (const row of data || []) {
      const projectId = Number(row.project_id || (intent === 'project_documents' ? row.entity_id :
        ['project_status', 'project_financials'].includes(intent) ? row.id : 0));
      if (Number.isSafeInteger(projectId) && projectId > 0) {
        referencedProjects.add(projectId);
        if (!records.some(item => item.kind === 'project' && item.id === projectId)) records.push({ kind: 'project', id: projectId });
      }
      const recordId = Number(row.id || row.ref_id || row.entity_id || 0);
      if (Number.isSafeInteger(recordId) && recordId > 0) {
        records.push({ kind: intent, id: recordId });
      }
    }
    if (referencedProjects.size === 1) scope.project_id = [...referencedProjects][0];
    else if (referencedProjects.size > 1) scope.project_id = null;
    scope.record_ids = records.slice(0, RESULT_LIMIT);
    return scope;
  }
  function saveMessage(user, conversation, question, answer, intent, data, context, fingerprint) {
    const createdAt = now();
    let historyId;
    ctx.tx(() => {
      const firstMessage = !db.prepare('SELECT 1 FROM copilot_history WHERE user_id=? AND conversation_id=? LIMIT 1')
        .get(user.id, conversation.id);
      if (firstMessage && ['New conversation', 'محادثة جديدة'].includes(conversation.title)) {
        db.prepare('UPDATE copilot_conversations SET title=? WHERE id=? AND user_id=?')
          .run(String(question).slice(0, 100), conversation.id, user.id);
      }
      const result = db.prepare(`INSERT INTO copilot_history(user_id,question,answer,created_at,auth_fingerprint,intent,data_json,context_json,conversation_id)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(user.id, question, answer, createdAt, fingerprint, intent || null,
        JSON.stringify(data || []), JSON.stringify(context || {}), conversation.id);
      historyId = Number(result.lastInsertRowid);
      db.prepare('UPDATE copilot_conversations SET updated_at=?,auth_fingerprint=? WHERE id=? AND user_id=?')
        .run(createdAt, fingerprint, conversation.id, user.id);
    });
    return historyId;
  }
  function parseContext(raw, user) {
    const value = jsonObject(raw);
    const projectId = Number.isSafeInteger(+value.project_id) && projectAccessible(user, +value.project_id) ? +value.project_id : null;
    return {
      intent: typeof value.intent === 'string' && ['project_status', 'project_financials', 'invoice_summary', 'procurement_status',
        'quotation_summary', 'contract_summary', 'certificate_summary', 'project_documents', 'approval_queue', 'sync_failures'].includes(value.intent)
        ? value.intent : null,
      project_id: projectId,
      record_ids: Array.isArray(value.record_ids) ? value.record_ids.filter(item => item && typeof item.kind === 'string' &&
        Number.isSafeInteger(+item.id) && +item.id > 0).slice(0, RESULT_LIMIT).map(item => ({ kind: item.kind.slice(0, 40), id: +item.id })) : [],
      filters: value.filters && typeof value.filters === 'object' && !Array.isArray(value.filters)
        ? Object.fromEntries(['overdue', 'outstanding', 'open', 'active', 'expiring', 'approval'].filter(key => value.filters[key] === true).map(key => [key, true])) : {},
    };
  }
  function isGreeting(question) {
    return /^(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|what can you do\??|help)\s*[!.؟?]*$/i.test(question.trim()) ||
      /^(?:مرحبا|مرحباً|اهلا|أهلاً|السلام عليكم|شكرا|شكراً|ماذا تستطيع|ماذا يمكنك|ما الذي يمكنك فعله)\s*[!.؟?]*$/i.test(question.trim());
  }
  function memoryCommand(question) {
    const match = /^(?:remember(?:\s+that)?|please remember(?:\s+that)?|تذكّر(?:\s+أن)?|تذكر(?:\s+أن)?)\s*[:،]?\s*([\s\S]+)$/i.exec(question.trim());
    if (match) return { action: 'save', content: match[1].trim() };
    if (/^(?:what do you remember about me\??|what do you remember\??|ماذا تتذكر عني[؟?]?)$/i.test(question.trim())) return { action: 'list' };
    return null;
  }

  function projectIds(user) {
    const scope = ctx.siteScope(user);
    return scope ? scope.projects : null;
  }

  function authFingerprint(user) {
    const scope = projectIds(user);
    return JSON.stringify([user.role, scope ? [...scope].sort((a, b) => a - b) : null]);
  }

  function currentUser(userId) {
    return db.prepare(`SELECT id,username,role,employee_id,COALESCE(disabled,0) disabled
      FROM users WHERE id=?`).get(userId) || null;
  }

  function projectFilter(question, scope) {
    const q = normalize(question);
    const candidates = db.prepare('SELECT id,code,name FROM projects ORDER BY id').all()
      .filter(row => !scope || scope.has(row.id))
      .filter(row => [row.code, row.name].some(value => value && q.includes(normalize(String(value)))));
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 1) return 0;
    const marker = /(?:\b(?:project|site)\s+([a-z0-9][a-z0-9_-]*)|مشروع\s+([\p{L}\d_-]+))/iu.exec(question);
    const key = normalize(marker && (marker[1] || marker[2]) || '');
    if (!key || new Set([
      'status', 'summary', 'financials', 'profit', 'cost', 'projects', 'procurement', 'documents', 'document',
      'drawings', 'drawing', 'rfis', 'rfi', 'submittals', 'submittal', 'contracts', 'contract',
      'expenses', 'active', 'invoices', 'invoice', 'approvals', 'approval',
    ]).has(key)) return null;
    return 0;
  }

  function sharePointUrl(entity, entityId, docType) {
    const row = db.prepare(`SELECT web_url FROM m365_documents
      WHERE entity=? AND entity_id=? AND doc_type=? AND status='uploaded'`).get(entity, entityId, docType);
    return safeSharePointUrl(row?.web_url);
  }

  function selectedProject(question, scope) {
    const id = projectFilter(question, scope);
    return id == null ? null : id;
  }

  function filterByProject(rows, question, projectField = 'project_id', scope = null) {
    const projectId = selectedProject(question, scope);
    return rows.filter(row => (!scope || scope.has(row[projectField])) &&
      (projectId == null || row[projectField] === projectId));
  }

  function projectStatus(user, question) {
    if (!ctx.can(user.role, 'GET', 'projects')) throw fail(403, 'Your ERP role cannot read projects');
    const scope = projectIds(user), selected = selectedProject(question, scope);
    if (scope && !scope.size) return [];
    if (selected === 0) return [];
    const activeOnly = /\bactive\b|مشاريع نشطه|المشاريع النشطه/.test(normalize(question));
    const where = [selected != null ? 'p.id=?' : '', activeOnly ? "p.status='active'" : ''].filter(Boolean);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = scope
      ? db.prepare(`SELECT p.id,p.code,p.name,p.location,p.status,p.start_date,p.end_date FROM projects p
        JOIN user_projects up ON up.project_id=p.id ${whereSql ? `${whereSql} AND` : 'WHERE'} up.user_id=? ORDER BY p.id DESC LIMIT ?`)
        .all(...(selected != null ? [selected] : []), user.id, resultLimit())
      : db.prepare(`SELECT p.id,p.code,p.name,p.location,p.status,p.start_date,p.end_date FROM projects p ${whereSql} ORDER BY p.id DESC LIMIT ?`)
        .all(...(selected != null ? [selected] : []), resultLimit());
    return rows
      .map(p => ({ ...project(p, ['id', 'code', 'name', 'location', 'status', 'start_date', 'end_date']), href: `#projects/${p.id}` }));
  }

  function projectFinancials(user, question) {
    if (!ctx.can(user.role, 'GET', 'project-summary')) throw fail(403, 'Your ERP role cannot read project financial summaries');
    const scope = projectIds(user);
    return filterByProject(ctx.projectRows(), question, 'id', scope).slice(0, resultLimit()).map(p => ({
      ...project(p, ['id', 'code', 'name', 'status', 'contract_value', 'invoiced', 'collected', 'receivable', 'cost', 'profit', 'margin']),
      revised_contract_value: p.revised_value,
      href: ctx.can(user.role, 'GET', 'projects') ? `#projects/${p.id}` : null,
    }));
  }

  function invoiceSummary(user, question) {
    if (!ctx.can(user.role, 'GET', 'invoices')) throw fail(403, 'Your ERP role cannot read invoices');
    const scope = projectIds(user);
    const q = normalize(question), all = ctx.enrich().invoices;
    let rows = filterByProject(all, question, 'project_id', scope);
    if (/\b(outstanding|unpaid|receivable)\b|المستحق|غير مدفوع|المتبقي/.test(q)) rows = rows.filter(i => i.balance > 0.005);
    if (/\b(this month|issued this month)\b|هذا الشهر|الشهر الحالي/.test(q)) {
      const month = String(ctx.today()).slice(0, 7); rows = rows.filter(i => String(i.date || '').slice(0, 7) === month);
    }
    if (/\b(by|per) project\b|حسب المشروع|لكل مشروع/.test(q)) {
      const groups = new Map();
      for (const invoice of rows) {
        const key = invoice.project_id || 0, group = groups.get(key) || { project_id: key || null, project_name: invoice.project_name || null, invoice_count: 0, subtotal: 0, vat: 0, total: 0, balance: 0 };
        group.invoice_count++; group.subtotal += invoice.subtotal || 0; group.vat += invoice.vat || 0;
        group.total += invoice.total || 0; group.balance += invoice.balance || 0; groups.set(key, group);
      }
      return [...groups.values()].sort((a, b) => (b.project_id || 0) - (a.project_id || 0)).slice(0, resultLimit()).map(row => ({
        ...project(row, ['project_id', 'project_name', 'invoice_count', 'subtotal', 'vat', 'total', 'balance']),
        href: row.project_id && ctx.can(user.role, 'GET', 'projects') ? `#projects/${row.project_id}` : null,
      }));
    }
    const number = all.find(i => i.number && q.includes(normalize(i.number)));
    if (number) rows = rows.filter(i => i.id === number.id);
    else {
      const explicit = /(?:\binvoice\s+([a-z0-9][a-z0-9-]*)|فاتورة\s+([\p{L}\d-]+))/iu.exec(question);
      const ref = normalize(explicit && (explicit[1] || explicit[2]) || '');
      if (ref && !new Set(['summary', 'totals', 'outstanding', 'status', 'this']).has(ref)) rows = [];
    }
    const explaining = /\b(explain|why|status)\b|اشرح|حاله|حالة/.test(q);
    return rows.slice().sort((a, b) => b.id - a.id).slice(0, resultLimit()).map(i => ({
      ...project(i, ['id', 'number', 'date', 'due_date', 'project_name', 'kind', 'status', 'subtotal', 'vat', 'total', 'paid', 'balance', 'retention_open']),
      status_explanation: ({ void: 'Voided', credit: 'Credit note', overdue: 'Past due date with an open balance', partial: 'Partially paid', unpaid: 'Unpaid', retention: 'Balance is retained', paid: 'Paid' })[i.status] || 'ERP status',
      history: explaining ? db.prepare("SELECT ts,action FROM audit_log WHERE tbl='invoices' AND rec=? ORDER BY id DESC LIMIT 5").all(i.id) : undefined,
      sharepoint_url: sharePointUrl('invoices', i.id, 'Invoices'),
      href: `#invoices/${i.id}`,
    }));
  }

  function procurementStatus(user, question) {
    const canPo = ctx.can(user.role, 'GET', 'purchase_orders'), canRfq = ctx.can(user.role, 'GET', 'rfqs');
    if (!canPo && !canRfq) throw fail(403, 'Your ERP role cannot read procurement records');
    const scope = projectIds(user), cap = resultLimit(), q = normalize(question);
    const asksPo = /\b(?:po|purchase orders?)\b|اوامر الشراء/.test(q);
    const asksRfq = /\brfqs?\b|طلبات الاسعار/.test(q);
    const poSpecific = asksPo || /\b(overdue|late|past due|supplier|suppliers|vendor|vendors|above|over|more than|greater than|latest)\b|بانتظار الاعتماد|قيد الاعتماد|فوق|أكثر من/.test(q);
    if ((poSpecific && !canPo) || (asksRfq && !canRfq)) throw fail(403, 'Your ERP role cannot read the requested procurement records');
    if (scope && !scope.size) return [];
    const thresholdMatch = /(?:above|over|more than|greater than|exceeding|فوق|أكثر من|اكبر من)\s*(?:aed\s*)?([\d,]+)/i.exec(question);
    const threshold = thresholdMatch ? Number(thresholdMatch[1].replace(/,/g, '')) : null;
    const latestPdf = /\b(latest|most recent)\b.{0,30}\b(po|purchase order)\b.{0,20}\b(pdf|document)\b|\b(latest|most recent)\b.{0,20}\b(pdf|document)\b.{0,20}\b(po|purchase order)\b|احدث.*(?:امر شراء|أمر شراء|pdf|مستند)/.test(q);
    const overdue = /\b(overdue|late|past due)\b|متأخر/.test(q);
    const openOnly = /\b(open)\s*(?:purchase orders?|pos?)\b|اوامر الشراء المفتوحه|أوامر الشراء المفتوحة/.test(q);
    const awaitingApproval = /\b(waiting for approval|pending approval|awaiting approval)\b|بانتظار الاعتماد|قيد الاعتماد/.test(q);
    const scopeIds = scope ? [...scope] : null, selected = selectedProject(question, scope);
    if (selected === 0) return [];
    const explicitPoRef = /(?:\bfor\s+(PO[-/][A-Z0-9-]+)|\b(?:po|purchase order)\s+(PO[-/][A-Z0-9-]+|\d{3,})|أمر شراء\s+(PO[-/][A-Z0-9-]+|\d{3,}))/iu.exec(question)?.[1] ||
      /(?:\b(?:po|purchase order)\s+(PO[-/][A-Z0-9-]+|\d{3,})|أمر شراء\s+(PO[-/][A-Z0-9-]+|\d{3,}))/iu.exec(question)?.[1];
    const poWhere = [], poArgs = [];
    if (scopeIds) { poWhere.push(`project_id IN (${scopeIds.map(() => '?').join(',')})`); poArgs.push(...scopeIds); }
    if (selected != null) { poWhere.push('project_id=?'); poArgs.push(selected); }
    if (explicitPoRef) { poWhere.push('lower(number)=lower(?)'); poArgs.push(explicitPoRef); }
    if (overdue) { poWhere.push("delivery_date IS NOT NULL AND delivery_date<? AND status NOT IN ('closed','cancelled')"); poArgs.push(ctx.today()); }
    if (openOnly) poWhere.push("status NOT IN ('closed','cancelled')");
    if (awaitingApproval) poWhere.push("EXISTS (SELECT 1 FROM spend_approvals a WHERE a.kind='po' AND a.ref_id=purchase_orders.id AND a.status='pending')");
    if (latestPdf) poWhere.push("EXISTS (SELECT 1 FROM m365_documents d WHERE d.entity='purchase_orders' AND d.entity_id=purchase_orders.id AND d.doc_type='Purchase Orders' AND d.status='uploaded')");
    const allPos = [];
    if (canPo) {
      const scanLimit = threshold !== null ? 5001 : cap;
      const rows = db.prepare(`SELECT id,number,date,delivery_date,status,project_id,party_id,items,vat_pct FROM purchase_orders
        ${poWhere.length ? `WHERE ${poWhere.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...poArgs, scanLimit);
      if (threshold !== null && rows.length > 5000) throw fail(422, 'Purchase-order value query is too broad; specify a project or narrower filter');
      allPos.push(...rows.map(row => ({ row, view: ctx.poView ? ctx.poView(row) : row })));
    }
    const mentionedNumber = explicitPoRef ? allPos[0] : allPos.find(({ row }) => row.number && q.includes(normalize(row.number)));
    const topSuppliers = /\b(which|top|most)\b.{0,35}\b(supplier|suppliers|vendor|vendors)\b|\b(supplier|vendor)\b.{0,35}\b(most|highest)\b.{0,15}\b(po|purchase order)\b|اكثر.*(?:مورد|موردين)/.test(q);
    if (topSuppliers) {
      const monthStart = `${String(ctx.today()).slice(0, 7)}-01`, nextMonth = new Date(`${monthStart}T00:00:00.000Z`);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const scopeClause = scopeIds ? `AND project_id IN (${scopeIds.map(() => '?').join(',')})` : '';
      const selectedClause = selected != null ? 'AND project_id=?' : '';
      return db.prepare(`SELECT party_id,COUNT(*) purchase_order_count FROM purchase_orders
        WHERE date>=? AND date<? AND status IN ('sent','received','closed') ${scopeClause} ${selectedClause}
        GROUP BY party_id ORDER BY purchase_order_count DESC,party_id LIMIT ?`)
        .all(monthStart, nextMonth.toISOString().slice(0, 10), ...(scopeIds || []), ...(selected != null ? [selected] : []), cap)
        .map(row => ({ supplier_name: db.prepare('SELECT name FROM parties WHERE id=?').get(row.party_id)?.name || 'Unknown supplier', purchase_order_count: row.purchase_order_count }));
    }
    const out = [];
    let poRows = allPos;
    if (mentionedNumber) poRows = poRows.filter(({ row }) => row.id === mentionedNumber.row.id);
    else if (/(?:\b(?:po|purchase order)\s+[a-z0-9][a-z0-9-]*|\bfor\s+po\s+[a-z0-9][a-z0-9-]*|أمر شراء\s+[\p{L}\d-]+)/iu.test(question)) poRows = [];
    if (threshold !== null && Number.isFinite(threshold)) poRows = poRows.filter(({ view }) => view.total > threshold);
    if (latestPdf) {
      poRows = poRows.filter(({ row }) => sharePointUrl('purchase_orders', row.id, 'Purchase Orders'));
      if (!mentionedNumber) poRows.sort((a, b) => {
        const aAt = db.prepare("SELECT uploaded_at FROM m365_documents WHERE entity='purchase_orders' AND entity_id=? AND doc_type='Purchase Orders'").get(a.row.id)?.uploaded_at || '';
        const bAt = db.prepare("SELECT uploaded_at FROM m365_documents WHERE entity='purchase_orders' AND entity_id=? AND doc_type='Purchase Orders'").get(b.row.id)?.uploaded_at || '';
        return bAt.localeCompare(aAt) || b.row.id - a.row.id;
      }).splice(1);
    }
    for (const { row, view } of poRows.slice(0, cap)) {
      const projectName = row.project_id == null ? null : db.prepare('SELECT name FROM projects WHERE id=?').get(row.project_id)?.name || null;
      const approvalState = ctx.poSpendState ? ctx.poSpendState(row.id) : null;
      out.push({
        ...project(row, ['id', 'number', 'date', 'delivery_date', 'status', 'project_id']),
        project_name: projectName, supplier_name: view.supplier_name || null, total: view.total,
        approval_status: approvalState, sharepoint_url: sharePointUrl('purchase_orders', row.id, 'Purchase Orders'),
        history: db.prepare("SELECT ts,action FROM audit_log WHERE tbl='purchase_orders' AND rec=? ORDER BY id DESC LIMIT 5").all(row.id),
        kind: 'purchase_order', href: `#po/${row.id}`,
      });
    }
    if (canRfq && out.length < cap && !mentionedNumber && !latestPdf && threshold === null) {
      const rfqWhere = [], rfqArgs = [];
      if (scopeIds) { rfqWhere.push(`project_id IN (${scopeIds.map(() => '?').join(',')})`); rfqArgs.push(...scopeIds); }
      if (selected != null) { rfqWhere.push('project_id=?'); rfqArgs.push(selected); }
      const rfqs = db.prepare(`SELECT id,number,date,status,project_id FROM rfqs
        ${rfqWhere.length ? `WHERE ${rfqWhere.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...rfqArgs, cap);
      const filtered = filterByProject(rfqs, question, 'project_id', scope);
      for (const row of filtered) {
        if (out.length >= cap) break;
        const projectName = row.project_id == null ? null : db.prepare('SELECT name FROM projects WHERE id=?').get(row.project_id)?.name || null;
        out.push({ ...project(row, ['id', 'number', 'date', 'status', 'project_id']), project_name: projectName, kind: 'rfq', href: `#rfq/${row.id}` });
      }
    }
    return out;
  }

  function quotationSummary(user, question) {
    if (!ctx.can(user.role, 'GET', 'quotes')) throw fail(403, 'Your ERP role cannot read quotations');
    let rows = ctx.enrich().quotes;
    const scope = projectIds(user);
    rows = filterByProject(rows, question, 'project_id', scope);
    if (/\b(open|outstanding|pending)\b|مفتوح|قيد الانتظار/.test(normalize(question))) {
      rows = rows.filter(row => ['draft', 'sent', 'pending'].includes(String(row.status || '').toLowerCase()));
    }
    return rows.sort((a, b) => b.id - a.id).slice(0, resultLimit()).map(row => ({
      ...project(row, ['id', 'number', 'date', 'project_name', 'status', 'subtotal', 'vat', 'total']),
      sharepoint_url: sharePointUrl('quotes', row.id, 'Quotations'),
      href: row.project_id && ctx.can(user.role, 'GET', 'projects') ? `#projects/${row.project_id}` : null,
    }));
  }

  function certificateSummary(user, question) {
    if (!ctx.can(user.role, 'GET', 'sub_certs')) throw fail(403, 'Your ERP role cannot read subcontract certificates');
    const scope = projectIds(user), selected = selectedProject(question, scope);
    if ((scope && !scope.size) || selected === 0) return [];
    const where = [], args = [];
    if (scope) { where.push(`s.project_id IN (${[...scope].map(() => '?').join(',')})`); args.push(...scope); }
    if (selected != null) { where.push('s.project_id=?'); args.push(selected); }
    if (/\b(approved|accepted)\b|معتمده|معتمدة/.test(normalize(question))) where.push("c.status='approved'");
    const rows = db.prepare(`SELECT c.id,c.number,c.date,c.status,c.cumulative,c.subcontract_id,s.project_id,s.agreement_no,p.name project_name
      FROM sub_certs c JOIN subcontracts s ON s.id=c.subcontract_id LEFT JOIN projects p ON p.id=s.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ?`).all(...args, resultLimit());
    return rows.map(row => ({
      ...project(row, ['id', 'number', 'date', 'status', 'cumulative', 'project_id', 'project_name', 'agreement_no']),
      sharepoint_url: sharePointUrl('sub_certs', row.id, 'Payment Certificates'),
      href: row.subcontract_id && ctx.can(user.role, 'GET', 'subcontracts') ? `#subcontracts/${row.subcontract_id}` : null,
    }));
  }

  function contractSummary(user, question) {
    if (!ctx.can(user.role, 'GET', 'subcontracts')) throw fail(403, 'Your ERP role cannot read subcontract records');
    const scope = projectIds(user), q = normalize(question);
    const rows = db.prepare(`SELECT s.id,s.project_id,s.agreement_no,s.description,s.status,s.contract_value,s.start_date,s.completion_date,p.name project_name
      FROM subcontracts s LEFT JOIN projects p ON p.id=s.project_id ORDER BY s.id DESC`).all();
    let selected = rows.filter(row => !scope || (row.project_id != null && scope.has(row.project_id)));
    const expires = /\b(?:within|next|in)\s+(\d{1,3})\s+days?\b|خلال\s+(\d{1,3})\s+يوم/.exec(question);
    if (/\b(expir|expiring|expiry)\b|تنتهي|انتهاء/.test(q)) {
      const days = Number(expires && (expires[1] || expires[2]) || 60), last = new Date(`${ctx.today()}T00:00:00.000Z`);
      last.setUTCDate(last.getUTCDate() + Math.min(days, 3650));
      const end = last.toISOString().slice(0, 10), start = String(ctx.today()).slice(0, 10);
      selected = selected.filter(row => row.completion_date && row.completion_date >= start && row.completion_date <= end);
    }
    selected = filterByProject(selected, question, 'project_id', scope);
    if (/\b(latest|most recent)\b.{0,30}\b(contract|document|pdf)\b|احدث.*(?:عقد|مستند)/.test(q)) {
      selected = selected.filter(row => sharePointUrl('subcontracts', row.id, 'Contracts'))
        .sort((a, b) => {
          const aAt = db.prepare("SELECT updated_at FROM m365_documents WHERE entity='subcontracts' AND entity_id=? AND doc_type='Contracts'").get(a.id)?.updated_at || '';
          const bAt = db.prepare("SELECT updated_at FROM m365_documents WHERE entity='subcontracts' AND entity_id=? AND doc_type='Contracts'").get(b.id)?.updated_at || '';
          return bAt.localeCompare(aAt) || b.id - a.id;
        }).slice(0, 1);
    }
    return selected.slice(0, resultLimit()).map(row => ({
      ...project(row, ['id', 'project_id', 'agreement_no', 'status', 'contract_value', 'start_date', 'completion_date', 'project_name']),
      sharepoint_url: sharePointUrl('subcontracts', row.id, 'Contracts'), href: `#subcontracts/${row.id}`,
    }));
  }

  function safeSharePointUrl(raw) {
    if (!raw) return null;
    try {
      const url = new URL(raw), host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !['sharepoint.com', 'sharepoint.us', 'sharepoint.de', 'sharepoint.cn', 'sharepoint.africa', 'sharepoint-mil.us']
        .some(suffix => host === suffix || host.endsWith(`.${suffix}`)) || url.username || url.password || (url.port && url.port !== '443')) return null;
      url.search = ''; url.hash = '';
      return url.toString();
    } catch { return null; }
  }

  function projectDocuments(user, question) {
    if (!ctx.can(user.role, 'GET', 'projects') || !ctx.docAllowed || !ctx.docAllowed(user.role, 'project', false)) throw fail(403, 'Your ERP role cannot read project document metadata');
    const scope = projectIds(user), selected = selectedProject(question, scope);
    if ((scope && !scope.size) || selected === 0) return [];
    const q = normalize(question), requestedTypes = [];
    if (/\b(drawings?)\b|رسومات|مخططات/.test(q)) requestedTypes.push('drawing');
    if (/\b(rfis?)\b|طلبات المعلومات/.test(q)) requestedTypes.push('rfi');
    if (/\b(submittals?)\b|التقديمات/.test(q)) requestedTypes.push('submittal');
    const where = ['entity=?'], args = ['project'];
    if (scope) { where.push(`entity_id IN (${[...scope].map(() => '?').join(',')})`); args.push(...scope); }
    if (selected != null) { where.push('entity_id=?'); args.push(selected); }
    if (requestedTypes.length) {
      where.push(`(${requestedTypes.map(() => "lower(COALESCE(doc_type,'')) LIKE ? OR lower(COALESCE(category,'')) LIKE ?").join(' OR ')})`);
      for (const type of requestedTypes) args.push(`%${type}%`, `%${type}%`);
    }
    const rows = db.prepare(`SELECT id,entity,entity_id,doc_type,expiry_date,created FROM documents
      WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, resultLimit());
    return rows.map(row => {
        const sync = db.prepare(`SELECT doc_type,status,web_url FROM m365_documents
          WHERE entity='documents' AND entity_id=? ORDER BY updated_at DESC LIMIT 1`).get(row.id);
        return {
          ...project(row, ['id', 'entity', 'entity_id', 'doc_type', 'expiry_date', 'created']),
          sync_status: sync?.status || 'not_synced',
          sharepoint_url: sync?.status === 'uploaded' ? safeSharePointUrl(sync.web_url) : null,
          href: `#projects/${row.entity_id}`,
        };
      });
  }

  function approvalQueue(user, question) {
    if (!ctx.can(user.role, 'GET', 'spend-approvals') || !ctx.can(user.role, 'GET', 'purchase_orders')) throw fail(403, 'Your ERP role cannot read purchase-order approvals');
    const scope = projectIds(user), selected = selectedProject(question, scope);
    if ((scope && !scope.size) || selected === 0) return [];
    const where = ["a.status='pending'"], args = [];
    if (scope) { where.push(`p.project_id IN (${[...scope].map(() => '?').join(',')})`); args.push(...scope); }
    if (selected != null) { where.push('p.project_id=?'); args.push(selected); }
    const rows = db.prepare(`SELECT a.id,a.kind,a.ref_id,a.amount,a.status,a.requested_at,p.number,p.project_id,pr.name project_name
      FROM spend_approvals a JOIN purchase_orders p ON a.kind='po' AND p.id=a.ref_id
      LEFT JOIN projects pr ON pr.id=p.project_id WHERE ${where.join(' AND ')} ORDER BY a.requested_at DESC,a.id DESC LIMIT ?`)
      .all(...args, resultLimit());
    return rows.map(row => ({
      ...project(row, ['id', 'kind', 'ref_id', 'amount', 'status', 'requested_at', 'number', 'project_id', 'project_name']),
      href: `#po/${row.ref_id}`,
    }));
  }

  function syncRecord(user, item) {
    const map = { purchase_orders: ['purchase_orders', '#po/'], rfqs: ['rfqs', '#rfq/'], quotes: ['quotes', '#projects/'],
      invoices: ['invoices', '#invoices/'], subcontracts: ['subcontracts', '#subcontracts/'] };
    if (item.entity === 'documents') {
      const doc = db.prepare('SELECT entity,entity_id FROM documents WHERE id=?').get(item.entity_id);
      if (!doc || doc.entity !== 'project' || !ctx.docAllowed?.(user.role, 'project', false) || !ctx.can(user.role, 'GET', 'projects')) return null;
      return { title: item.doc_type, project_id: doc.entity_id, href: `#projects/${doc.entity_id}` };
    }
    if (item.entity === 'sub_certs') {
      if (!ctx.can(user.role, 'GET', 'sub_certs')) return null;
      const row = db.prepare('SELECT c.id,c.number,c.subcontract_id,s.project_id FROM sub_certs c JOIN subcontracts s ON s.id=c.subcontract_id WHERE c.id=?').get(item.entity_id);
      if (!row) return null;
      return { title: row.number, project_id: row.project_id,
        href: ctx.can(user.role, 'GET', 'subcontracts') ? `#subcontracts/${row.subcontract_id}` : null };
    }
    const config = map[item.entity];
    if (!config || !ctx.can(user.role, 'GET', config[0])) return null;
    const row = db.prepare(`SELECT id,number,project_id FROM ${item.entity} WHERE id=?`).get(item.entity_id);
    if (!row) return null;
    const href = item.entity === 'quotes'
      ? row.project_id && ctx.can(user.role, 'GET', 'projects') ? `#projects/${row.project_id}` : null
      : `${config[1]}${row.id}`;
    return { title: row.number || item.doc_type, project_id: row.project_id, href };
  }

  function syncFailures(user, question) {
    const scope = projectIds(user), q = normalize(question), selected = selectedProject(question, scope);
    const poOnly = /\bpos?\b|\bpurchase orders?\b|امر شراء|أمر شراء/.test(q);
    if ((scope && !scope.size) || selected === 0) return [];
    const where = ["status='failed'"];
    if (poOnly) { where.push("entity='purchase_orders'"); }
    const batchSize = Math.max(50, resultLimit() * 4), output = [];
    let offset = 0;
    while (output.length < resultLimit()) {
      const rows = db.prepare(`SELECT entity,entity_id,doc_type,status,fails,next_attempt_at,updated_at
        FROM m365_documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,entity,entity_id LIMIT ? OFFSET ?`)
        .all(batchSize, offset);
      if (!rows.length) break;
      offset += rows.length;
      for (const item of rows) {
        const record = syncRecord(user, item);
        if (!record || (scope && (record.project_id == null || !scope.has(record.project_id))) ||
            (selected != null && record.project_id !== selected)) continue;
        output.push({ entity: item.entity, entity_id: item.entity_id, doc_type: item.doc_type, status: item.status,
          fails: item.fails, next_attempt_at: item.next_attempt_at, updated_at: item.updated_at,
          record_number: record.title, href: record.href });
        if (output.length >= resultLimit()) break;
      }
    }
    if (!output.length && !ctx.can(user.role, 'GET', 'purchase_orders') &&
        !(ctx.can(user.role, 'GET', 'projects') && ctx.docAllowed?.(user.role, 'project', false))) {
      throw fail(403, 'Your ERP role cannot read SharePoint sync status');
    }
    return output;
  }
  function statusPayload(user, enabled) {
    const canReadAudit = ctx.can(user.role, 'GET', 'audit'), recentCutoff = now() - 864e5;
    const operationalStatus = canReadAudit ? db.prepare(`SELECT MAX(CASE WHEN event='ask' AND outcome='completed' THEN created_at END) last_success_at,
      AVG(CASE WHEN event='ask' AND duration_ms IS NOT NULL THEN duration_ms END) avg_duration_ms,
      SUM(CASE WHEN outcome IN ('failed','rate_limited') AND created_at>=? THEN 1 ELSE 0 END) recent_failures
      FROM copilot_audit`).get(recentCutoff) : null;
    const lastFailure = canReadAudit ? db.prepare(`SELECT outcome,http_status,created_at FROM copilot_audit
      WHERE outcome IN ('failed','rate_limited') AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(recentCutoff) : null;
    const cutoff = now() - WINDOW_MS;
    const userQueries = (windows.users.get(user.id) || []).filter(t => t > cutoff).length;
    const processQueries = windows.global.filter(t => t > cutoff).length;
    return {
      enabled, intents: ['project_status', 'project_financials', 'invoice_summary', 'procurement_status', 'quotation_summary', 'contract_summary', 'certificate_summary', 'project_documents', 'approval_queue', 'sync_failures'],
      max_results: resultLimit(), history_retention_days: historyDays(), provider_configured: provider.configured(),
      provider: ['azure-openai', 'azure-foundry', 'mock'].includes(process.env.COPILOT_PROVIDER || 'azure-openai')
        ? process.env.COPILOT_PROVIDER || 'azure-openai' : 'unconfigured',
      rate_limit: { user_per_minute: userLimit(), process_per_minute: globalLimit() },
      ...(operationalStatus ? { operational_status: {
        last_success_at: operationalStatus.last_success_at || null, average_duration_ms: Math.round(operationalStatus.avg_duration_ms || 0),
        recent_failure_count: Number(operationalStatus.recent_failures || 0),
        last_failure: lastFailure ? {
          category: lastFailure.outcome === 'rate_limited' ? 'rate_limited' : 'failed',
          http_status: lastFailure.http_status, at: lastFailure.created_at,
        } : null,
        rate_limit_state: { current_user_queries_last_minute: userQueries, process_queries_last_minute: processQueries },
      } } : {}),
    };
  }

  async function handle(req, res, url, parts, sessionUser) {
    res.setHeader('Cache-Control', 'no-store');
    const [, action] = parts;
    const enabled = process.env.COPILOT_ENABLED === '1';
    if (!enabled && !(action === 'status' && req.method === 'GET')) return send(res, 404, { error: 'not found' }), true;
    const identity = sessionUser || await bearerUser(req);
    if (!identity) return send(res, 401, { error: 'unauthorized' }), true;
    const user = currentUser(identity.id);
    if (!user || user.disabled) {
      auditEvent(Number(identity.id) || 0, 'denied', null, 'inactive_user', 401);
      return send(res, 401, { error: 'unauthorized' }), true;
    }
    if (!enabled) {
      if (!ctx.can(user.role, 'GET', 'audit')) return send(res, 404, { error: 'not found' }), true;
      return send(res, 200, statusPayload(user, false)), true;
    }
    if (!featureAllowed(user)) {
      auditEvent(user.id, 'denied', null, 'feature_allowlist', 403);
      return send(res, 403, { error: 'Copilot is not enabled for this ERP user' }), true;
    }
    const fingerprint = authFingerprint(user);

    if (action === 'status' && req.method === 'GET') {
      return send(res, 200, statusPayload(user, true)), true;
    }

    if (action === 'conversations' && req.method === 'GET' && !parts[2]) {
      pruneHistory();
      const stale = db.prepare('SELECT id FROM copilot_conversations WHERE user_id=? AND (auth_fingerprint IS NULL OR auth_fingerprint<>?)').all(user.id, fingerprint);
      for (const row of stale) {
        db.prepare('DELETE FROM copilot_history WHERE user_id=? AND conversation_id=?').run(user.id, row.id);
        db.prepare('DELETE FROM copilot_conversations WHERE user_id=? AND id=?').run(user.id, row.id);
      }
      return send(res, 200, db.prepare('SELECT id,title,created_at,updated_at FROM copilot_conversations WHERE user_id=? ORDER BY updated_at DESC,id DESC')
        .all(user.id)), true;
    }
    if (action === 'conversations' && req.method === 'POST' && !parts[2]) {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' }), true;
      const body = await readBoundedJson(req), title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
      const conversation = createConversation(user, title || 'New conversation', fingerprint);
      auditEvent(user.id, 'conversation_create', null, 'completed', 201, { redacted: true });
      return send(res, 201, { id: conversation.id, title: conversation.title, created_at: conversation.created_at }), true;
    }
    if (action === 'conversations' && req.method === 'DELETE' && parts[2]) {
      const conversation = ownConversation(user, parts[2]);
      if (!conversation) return send(res, 404, { error: 'Conversation not found' }), true;
      ctx.tx(() => {
        db.prepare('DELETE FROM copilot_history WHERE user_id=? AND conversation_id=?').run(user.id, conversation.id);
        db.prepare('DELETE FROM copilot_conversations WHERE user_id=? AND id=?').run(user.id, conversation.id);
        auditEvent(user.id, 'conversation_delete', null, 'completed', 200, { redacted: true });
      });
      return send(res, 200, { deleted: true }), true;
    }

    if (action === 'history' && req.method === 'GET') {
      pruneHistory();
      const stale = db.prepare('SELECT id FROM copilot_conversations WHERE user_id=? AND (auth_fingerprint IS NULL OR auth_fingerprint<>?)').all(user.id, fingerprint);
      for (const row of stale) {
        db.prepare('DELETE FROM copilot_history WHERE user_id=? AND conversation_id=?').run(user.id, row.id);
        db.prepare('DELETE FROM copilot_conversations WHERE user_id=? AND id=?').run(user.id, row.id);
      }
      const conversationId = url.searchParams.get('conversation_id');
      if (conversationId && !ownConversation(user, conversationId)) return send(res, 404, { error: 'Conversation not found' }), true;
      const rows = conversationId
        ? db.prepare('SELECT id,question,answer,created_at,intent,data_json FROM copilot_history WHERE user_id=? AND conversation_id=? ORDER BY created_at,id')
          .all(user.id, conversationId)
        : db.prepare('SELECT id,question,answer,created_at,intent,data_json,conversation_id FROM copilot_history WHERE user_id=? ORDER BY created_at DESC,id DESC')
          .all(user.id);
      return send(res, 200, rows.map(row => ({ id: row.id, question: row.question, answer: row.answer, created_at: row.created_at,
        intent: row.intent, conversation_id: row.conversation_id || conversationId || null,
        data: jsonArray(row.data_json) }))), true;
    }
    if (action === 'history' && req.method === 'DELETE') {
      let r;
      ctx.tx(() => {
        r = db.prepare('DELETE FROM copilot_conversations WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM copilot_history WHERE user_id=?').run(user.id);
        auditEvent(user.id, 'history_clear', null, 'completed', 200, { redacted: true });
      });
      return send(res, 200, { cleared: Number(r.changes) }), true;
    }
    if (action === 'memory' && req.method === 'GET' && !parts[2]) {
      return send(res, 200, memoryPayload(user)), true;
    }
    if (action === 'memory' && req.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' }), true;
      const body = await readBoundedJson(req), id = addMemory(user, body.content);
      auditEvent(user.id, 'memory_add', null, 'completed', 201, { redacted: true });
      return send(res, 201, { id }), true;
    }
    if (action === 'memory' && req.method === 'DELETE') {
      const id = parts[2] ? Number(parts[2]) : null;
      if (parts[2] && (!Number.isSafeInteger(id) || id < 1)) return send(res, 400, { error: 'Invalid memory item' }), true;
      const result = id
        ? db.prepare('DELETE FROM copilot_memory WHERE user_id=? AND id=?').run(user.id, id)
        : db.prepare('DELETE FROM copilot_memory WHERE user_id=?').run(user.id);
      if (id && !result.changes) return send(res, 404, { error: 'Memory item not found' }), true;
      auditEvent(user.id, id ? 'memory_delete' : 'memory_clear', null, 'completed', 200, { redacted: true });
      return send(res, 200, { deleted: Number(result.changes) }), true;
    }
    if (action === 'personalization' && req.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' }), true;
      const body = await readBoundedJson(req);
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be a boolean' }), true;
      preferenceRow(user.id);
      db.prepare('UPDATE copilot_preferences SET personalization_enabled=?,updated_at=? WHERE user_id=?')
        .run(body.enabled && PERSONALIZATION_DEFAULT ? 1 : 0, now(), user.id);
      auditEvent(user.id, 'personalization_toggle', null, body.enabled ? 'enabled' : 'disabled', 200, { redacted: true });
      return send(res, 200, { enabled: personalizationOn(user.id) }), true;
    }
    if (action === 'preferences' && req.method === 'DELETE') {
      preferenceRow(user.id);
      db.prepare(`UPDATE copilot_preferences SET language_counts='{}',intent_counts='{}',project_counts='{}',
        entity_counts='{}',filter_counts='{}',updated_at=? WHERE user_id=?`).run(now(), user.id);
      auditEvent(user.id, 'preferences_reset', null, 'completed', 200, { redacted: true });
      return send(res, 200, { reset: true }), true;
    }
    if (action === 'notice' && req.method === 'POST') {
      preferenceRow(user.id);
      db.prepare('UPDATE copilot_preferences SET notice_seen=1,updated_at=? WHERE user_id=?').run(now(), user.id);
      return send(res, 200, { seen: true }), true;
    }
    if (action === 'export' && req.method === 'GET') {
      pruneHistory();
      const conversations = db.prepare('SELECT id,title,created_at,updated_at FROM copilot_conversations WHERE user_id=? ORDER BY created_at,id')
        .all(user.id);
      const messages = db.prepare(`SELECT id,conversation_id,question,answer,intent,data_json,created_at FROM copilot_history
        WHERE user_id=? ORDER BY created_at,id`).all(user.id).map(row => {
        let data = [];
        try { const parsed = JSON.parse(row.data_json || '[]'); if (Array.isArray(parsed)) data = parsed; } catch {}
        return { ...row, data_json: undefined, data };
      });
      const feedback = db.prepare(`SELECT f.history_id,f.rating,f.reason,f.created_at FROM copilot_feedback f
        JOIN copilot_history h ON h.id=f.history_id WHERE f.user_id=? ORDER BY f.created_at,h.id`).all(user.id);
      return send(res, 200, { conversations, messages, feedback, ...memoryPayload(user) }), true;
    }
    if (action === 'feedback' && req.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' }), true;
      const body = await readBoundedJson(req);
      const historyId = Number(body.history_id), rating = body.rating, reason = body.reason || null;
      if (!Number.isSafeInteger(historyId) || historyId < 1 || !['helpful', 'not_helpful'].includes(rating) ||
          (reason !== null && !['inaccurate', 'unclear', 'incomplete', 'other'].includes(reason))) {
        return send(res, 400, { error: 'Feedback must include an owned history_id, a valid rating, and an optional reason code' }), true;
      }
      if (!db.prepare('SELECT 1 FROM copilot_history WHERE id=? AND user_id=?').get(historyId, user.id)) return send(res, 404, { error: 'Copilot history item not found' }), true;
      ctx.tx(() => {
        db.prepare(`INSERT INTO copilot_feedback(user_id,history_id,rating,reason,created_at) VALUES(?,?,?,?,?)
          ON CONFLICT(user_id,history_id) DO UPDATE SET rating=excluded.rating,reason=excluded.reason,created_at=excluded.created_at`)
          .run(user.id, historyId, rating, reason, now());
        auditEvent(user.id, 'feedback', null, rating, 200, { redacted: true });
      });
      return send(res, 200, { saved: true }), true;
    }
    if (action === 'audit' && req.method === 'GET') {
      if (!ctx.can(user.role, 'GET', 'audit')) return send(res, 403, { error: 'Only ERP administrators can read Copilot audit events' }), true;
      return send(res, 200, db.prepare(`SELECT user_id,event,intent,outcome,http_status,created_at,authorized_count,redacted,duration_ms FROM copilot_audit
        ORDER BY created_at DESC,id DESC LIMIT ?`).all(resultLimit())), true;
    }
    if (action !== 'ask' || req.method !== 'POST') return send(res, 404, { error: 'not found' }), true;
    let intent = null, authorizedCount = 0, redacted = false;
    const started = now();
    try {
      consumeQuery(user.id);
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fail(415, 'Content-Type must be application/json');
      const body = await readBoundedJson(req), question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || Array.from(question).length > QUESTION_LIMIT) throw fail(400, 'Question must contain 1–1000 characters');
      let conversation = body.conversation_id ? ownConversation(user, body.conversation_id) : null;
      if (body.conversation_id && !conversation) throw fail(404, 'Conversation not found');
      if (!conversation) conversation = createConversation(user, question.slice(0, 100), fingerprint);
      let previous = null;
      if (conversation.auth_fingerprint !== fingerprint) {
        db.prepare('DELETE FROM copilot_history WHERE user_id=? AND conversation_id=?').run(user.id, conversation.id);
        db.prepare('UPDATE copilot_conversations SET auth_fingerprint=? WHERE user_id=? AND id=?').run(fingerprint, user.id, conversation.id);
        conversation.auth_fingerprint = fingerprint;
      } else {
        const last = db.prepare('SELECT context_json FROM copilot_history WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1')
          .get(user.id, conversation.id);
        if (last) previous = parseContext(last.context_json, user);
      }
      const command = memoryCommand(question);
      if (unsafeQuestion(question)) throw fail(422, 'That topic is not available in Copilot. Ask about an authorized project, invoice, procurement, contract, document, approval, or sync status instead.');
      if (command?.action === 'save') {
        addMemory(user, command.content);
        const answer = /[\u0600-\u06ff]/.test(question) ? 'تم حفظ المعلومة في ذاكرتك الشخصية. يمكنك عرضها أو حذفها من «ذاكرتي».' : 'Saved to your private memory. View or delete it in “My memory”.';
        const context = previous || {};
        const historyId = saveMessage(user, conversation, question, answer, null, [], context, fingerprint);
        auditEvent(user.id, 'memory_add', null, 'completed', 200, { redacted: true });
        return send(res, 200, { id: historyId, conversation_id: conversation.id, answer, data: [], created_at: now(), intent: null }), true;
      }
      if (command?.action === 'list') {
        const memories = memoryPayload(user).items;
        const answer = memories.length
          ? (/[\u0600-\u06ff]/.test(question) ? `هذه المعلومات المحفوظة لك فقط:\n${memories.map(item => `• ${item.content}`).join('\n')}` : `These are your private saved items:\n${memories.map(item => `• ${item.content}`).join('\n')}`)
          : (/[\u0600-\u06ff]/.test(question) ? 'لا توجد معلومات محفوظة في ذاكرتك بعد.' : 'You have no saved memory items yet.');
        const historyId = saveMessage(user, conversation, question, answer, null, [], previous || {}, fingerprint);
        return send(res, 200, { id: historyId, conversation_id: conversation.id, answer, data: [], created_at: now(), intent: null }), true;
      }
      if (isGreeting(question)) {
        const answer = /[\u0600-\u06ff]/.test(question)
          ? 'أستطيع عرض حالة المشاريع وملخصاتها المالية المصرح بها، والفواتير، والمشتريات وأوامر الشراء، والعروض، والعقود، والمستندات، والاعتمادات، وحالة مزامنة SharePoint. لا أنفذ أي إجراء.'
          : 'I can summarize authorized project status and financials, invoices, procurement and POs, quotations, contracts, documents, approvals, and SharePoint sync status. I cannot take actions.';
        const historyId = saveMessage(user, conversation, question, answer, 'help', [], previous || {}, fingerprint);
        return send(res, 200, { id: historyId, conversation_id: conversation.id, intent: 'help', answer, data: [], created_at: now() }), true;
      }
      intent = route(question);
      const q = normalize(question);
      const followup = /^(?:and|also|for|only|which|what about|filter|that|those|them|it)\b|^(?:و|وكمان|وأيضا|ايضا|بالنسبة|لـ|فقط|ما حال|أي منها)|^(?:show|list|find)\b.*\b(?:for|about)\s+(?:it|that|this|them|those)\b|^(?:اعرض|أظهر|اظهر)\b.*(?:له|لها|لهم|ذلك|هذا|هذه)/i.test(q);
      const refersToSingle = /^(?:(?:and\s+)?(?:for|about)\s+(?:it|that|this|them|those)\b|(?:show|list|find|open|explain|summarize)\b.*\b(?:for|about)\s+(?:it|that|this|them|those)\b|which one\b|(?:له|لها|لهم|ذلك|هذا|هذه|ايهم|أيهم)\b)/i.test(q);
      if (refersToSingle && (!previous?.intent || (!previous.project_id && previous.record_ids.length > 1))) {
        const answer = /[\u0600-\u06ff]/.test(question) ? 'أي سجل تقصد؟ اذكر اسم المشروع أو رقمه.' : 'Which record do you mean? Please specify the project or record number.';
        const historyId = saveMessage(user, conversation, question, answer, 'clarification', [], previous || {}, fingerprint);
        return send(res, 200, { id: historyId, conversation_id: conversation.id, intent: 'clarification', clarification: true, answer, data: [], created_at: now() }), true;
      }
      if (!intent && followup && previous?.intent) {
        intent = previous.intent;
      }
      if (!intent) {
        if (followup && previous) {
          const answer = /[\u0600-\u06ff]/.test(question) ? 'ما السؤال أو المشروع الذي تريد متابعته؟ اذكره لأتحقق من الصلاحيات قبل البحث.' : 'Which question or project should I follow up on? Please specify it so I can check access before searching.';
          const historyId = saveMessage(user, conversation, question, answer, 'clarification', [], {}, fingerprint);
          return send(res, 200, { id: historyId, conversation_id: conversation.id, intent: 'clarification', clarification: true, answer, data: [], created_at: now() }), true;
        }
        throw fail(422, 'Supported topics: project status and financial summaries, invoices, procurement, quotations, subcontracts, subcontract certificates, project documents, approvals, and SharePoint sync status');
      }
      let effectiveQuestion = question, assumedProject = null, assumedFilter = null;
      let explicitProject = projectFilter(question, projectIds(user));
      let contextualProject = previous?.project_id && projectAccessible(user, previous.project_id) ? previous.project_id : null;
      if (explicitProject == null && !contextualProject && personalizationOn(user.id)) {
        const pref = preferenceRow(user.id), projects = jsonObject(pref.project_counts);
        const top = Object.entries(projects).sort((a, b) => b[1] - a[1]).find(([id]) => projectAccessible(user, +id));
        if (top) contextualProject = +top[0];
        if (!contextualProject) {
          contextualProject = db.prepare('SELECT project_id FROM copilot_memory WHERE user_id=? AND project_id IS NOT NULL ORDER BY created_at DESC,id DESC')
            .all(user.id).map(row => +row.project_id).find(id => projectAccessible(user, id)) || null;
        }
      }
      if (explicitProject == null && contextualProject) {
        const row = db.prepare('SELECT name FROM projects WHERE id=?').get(contextualProject);
        if (row?.name) {
          effectiveQuestion = `${question} project ${row.name}`;
          if (!previous?.project_id) assumedProject = row.name;
        }
      }
      const filterForIntent = {
        project_status: ['active'], invoice_summary: ['outstanding'],
        procurement_status: ['overdue', 'open', 'approval'],
        quotation_summary: ['open'], contract_summary: ['expiring'],
      }[intent] || [];
      const filterTerms = { overdue: 'overdue', outstanding: 'outstanding', open: 'open', active: 'active', expiring: 'expiring', approval: 'pending approval' };
      const explicitFilters = {
        overdue: /\boverdue|late|past due|متأخر/, outstanding: /\boutstanding|unpaid|receivable|المستحق|غير مدفوع/,
        open: /\bopen\b|مفتوح/, active: /\bactive\b|نشط/, expiring: /\bexpir|تنتهي|انتهاء/, approval: /\bapproval|pending approval|اعتماد/,
      };
      const questionWithProject = normalize(effectiveQuestion);
      if (personalizationOn(user.id) && !filterForIntent.some(filter => explicitFilters[filter].test(questionWithProject)) &&
          !filterForIntent.some(filter => previous?.intent === intent && previous.filters[filter])) {
        const preferred = Object.entries(jsonObject(preferenceRow(user.id).filter_counts))
          .sort((a, b) => b[1] - a[1]).find(([filter]) => filterForIntent.includes(filter));
        if (preferred) {
          assumedFilter = preferred[0];
          effectiveQuestion += ` ${filterTerms[assumedFilter]}`;
        }
      }
      if (previous?.intent === intent && followup) {
        for (const [filter, term] of Object.entries(filterTerms)) {
          if (previous.filters[filter] && !new RegExp(`\\b${term.replace(' ', '\\s+')}\\b`).test(normalize(effectiveQuestion))) {
            effectiveQuestion += ` ${term}`;
          }
        }
      }
      const tools = {
        project_status: projectStatus, project_financials: projectFinancials, invoice_summary: invoiceSummary,
        procurement_status: procurementStatus, quotation_summary: quotationSummary, contract_summary: contractSummary,
        certificate_summary: certificateSummary, project_documents: projectDocuments,
        approval_queue: approvalQueue, sync_failures: syncFailures,
      };
      const data = tools[intent](user, effectiveQuestion);
      authorizedCount = data.length; redacted = true;
      pruneHistory();
      const pref = preferenceRow(user.id), formatting = presentationPreferences(user);
      const learnedLanguage = personalizationOn(user.id)
        ? Object.entries(jsonObject(pref.language_counts)).sort((a, b) => b[1] - a[1])[0]?.[0] : null;
      const language = formatting.language || learnedLanguage || (/[\u0600-\u06ff]/.test(question) ? 'ar' : 'en');
      let answer = data.length ? await provider.phrase(effectiveQuestion, intent, data, language, formatting)
        : /[\u0600-\u06ff]/.test(question) ? 'لم يتم العثور على نتائج ERP مسموح بها لهذا السؤال.' : 'No matching authorized ERP records were found.';
      const latestUser = currentUser(user.id);
      if (!latestUser || latestUser.disabled) {
        auditEvent(user.id, 'ask', intent, 'denied', 401, { authorizedCount, redacted, durationMs: now() - started });
        return send(res, 401, { error: 'unauthorized' }), true;
      }
      if (!featureAllowed(latestUser)) {
        auditEvent(user.id, 'ask', intent, 'denied', 403, { authorizedCount, redacted, durationMs: now() - started });
        return send(res, 403, { error: 'Copilot is not enabled for this ERP user' }), true;
      }
      if (authFingerprint(latestUser) !== fingerprint) throw fail(403, 'ERP permissions changed during this request; please try again');
      const context = messageContext(intent, data, effectiveQuestion, { ...previous, project_id: contextualProject });
      context.intent = intent;
      learnUsage(user, question, intent, data);
      if (assumedFilter) {
        const label = { overdue: 'overdue', outstanding: 'outstanding', open: 'open', active: 'active', expiring: 'expiring', approval: 'pending approval' }[assumedFilter];
        answer = language === 'ar' ? `بافتراض التصفية: ${label}. ${answer}` : `Assuming filter: ${label}. ${answer}`;
      }
      if (assumedProject) answer = language === 'ar' ? `بافتراض مشروع ${assumedProject}: ${answer}` : `Assuming project ${assumedProject}: ${answer}`;
      const created_at = now(), historyId = saveMessage(user, conversation, question, answer, intent, data, context, fingerprint);
      auditEvent(user.id, 'ask', intent, 'completed', 200, { authorizedCount, redacted, durationMs: now() - started });
      return send(res, 200, { id: historyId, intent, answer, data, created_at, conversation_id: conversation.id });
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      const outcome = status === 422 ? 'unsupported' : status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'denied' : 'failed';
      auditEvent(user.id, status === 429 ? 'rate_limit' : 'ask', intent, outcome, status,
        { authorizedCount, redacted, durationMs: now() - started });
      if (!e.status) {
        ctx.logError?.(e, req);
        return send(res, 500, { error: 'Copilot request could not be completed' }), true;
      }
      throw e;
    }
  }

  ctx.copilotHandle = handle;
  return {};
};
