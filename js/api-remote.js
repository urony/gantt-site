// לקוח לשרת: אותו ממשק כמו api-local, אבל כל פעולה נשלחת לשרת, וההרשאות נאכפות שם.
// פעולה שמשנה מידע נשלחת עם מזהה בקשה; ניתוק, עומס או כשל שמירה מטופלים בניסיון חוזר באותו מזהה, והשרת אינו מבצע פעמיים.
// הצלחה מוצגת רק כשהשרת אישר שהכתיבה בוצעה. כניסה: login(credential) מחזיר את הזהות המאומתת מהשרת.
// האסימון נשמר ב-sessionStorage של הלשונית בלבד (נעלם בסגירתה). הבקשה נשלחת כ-text/plain כדי למנוע בקשת preflight מול Apps Script.
import { API_VERSION, MIN_SERVER_API, apiOf, SERVER_OUTDATED_MESSAGE } from './version.js';

export class RemoteError extends Error {
  constructor(error) { super(error.message || 'הפעולה נכשלה'); this.name = 'RemoteError'; this.code = error.code; this.retryable = !!error.retryable; }
}

const READ_ONLY = new Set(['getState']);
const AUTH_LOST = new Set(['unauthenticated', 'access_ended']);
const rid = () => 'r' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const SKEY_BASE = 'gantt-remote-session-v1'; // המפתח כולל את כתובת השרת: אסימון של שרת אחד לא יישלח לעולם לשרת אחר (פריסה מרובת מורים)

export function createRemoteApi({ url, fetchImpl = (...a) => fetch(...a), retries = 3, backoffMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), storage = null, busyBudgetMs = 240000, jitter = Math.random, clock = () => Date.now(), minServerApi = MIN_SERVER_API, clientApi = API_VERSION }) {
  const SKEY = SKEY_BASE + '@' + url;
  let token = null; let session = null; let loginState = null; let serverApi = null;
  // יומן ביצועים (לבדיקות מול שרת אמיתי) והודעות סטטוס לממשק (המתנה בתור)
  const perf = []; let listener = null;
  const emit = (ev) => { try { listener && listener(ev); } catch (e) { /* ממשק אינו מכשיל בקשה */ } };
  const persist = () => { try { storage && (token ? storage.setItem(SKEY, JSON.stringify({ token, session })) : storage.removeItem(SKEY)); } catch (e) { /* ללא שמירה בין טעינות */ } };
  try { const saved = storage && JSON.parse(storage.getItem(SKEY)); if (saved && saved.token) { token = saved.token; session = saved.session; } } catch (e) { /* ignore */ }
  async function post(msg) {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...msg, clientApi }) });
    const out = await r.json();
    // גרסת השרת: חסר = שרת מלפני המנגנון (גרסה 1). שרת ישן מהטווח שהאתר תומך בו נכשל בהודעה ברורה, לא בשגיאה מוזרה.
    if (out && typeof out === 'object') {
      serverApi = apiOf(out.apiVersion);
      if (serverApi < minServerApi) return { ok: false, error: { code: 'server_outdated', message: SERVER_OUTDATED_MESSAGE } };
    }
    return out;
  }
  // שליחה עם ניסיון חוזר רק על כשל רשת או כשל שהשרת סימן כניתן לחזרה (שמירה, עומס), תמיד עם אותו requestId
  async function send(action, args, fixedId) {
    const requestId = READ_ONLY.has(action) ? undefined : (fixedId || rid());
    let last; let waited = 0; // זמן המתנה מצטבר בתור (השרת עסוק)
    const t0 = clock(); let tries = 0;
    let srv; let trace; const record = (ok, code) => { perf.push({ action, ms: clock() - t0, queuedMs: waited, tries, ok, ...(srv !== undefined ? { srvMs: srv } : {}), ...(trace && Object.keys(trace).length ? { trace: JSON.stringify(trace) } : {}), ...(code ? { code } : {}) }); if (perf.length > 200) perf.shift(); if (waited) emit({ phase: 'idle', action }); };
    for (let i = 0; i <= retries; i++) {
      try {
        tries++;
        const out = await post({ action, args, token, requestId });
        srv = out.srvMs; trace = out.srvTrace;
        if (out.ok) { if (out.newToken) { token = out.newToken; persist(); } record(true); return out.result; }
        if (AUTH_LOST.has(out.error.code)) { token = null; session = null; persist(); }
        if (!out.error.retryable) throw new RemoteError(out.error);
        last = new RemoteError(out.error);
        // השרת עסוק (נעילה תפוסה, למשל הרבה הגשות בו-זמנית): ממתינים בתור בסבלנות, עם פיזור אקראי, בלי לצרוך את ניסיונות הרשת. אותו requestId, אז אין כפילות.
        if (out.error.code === 'busy' && waited < busyBudgetMs) { const w = 1500 + Math.floor(jitter() * 4500); waited += w; emit({ phase: 'queued', action, waitedMs: waited }); await sleep(w); i--; continue; }
      } catch (e) {
        if (e instanceof RemoteError) { if (!e.retryable) { record(false, e.code); throw e; } last = e; } else last = new RemoteError({ code: 'network', message: 'אין חיבור לשרת. נסו שוב.', retryable: true });
      }
      if (i < retries) await sleep(backoffMs * (i + 1));
    }
    record(false, last && last.code);
    throw last;
  }
  const own = {
    async loginNonce() {
      const out = await post({ action: 'loginNonce' });
      if (!out.ok) throw new RemoteError(out.error);
      return out.result.nonce;
    },
    async login(credential) {
      const out = await post({ action: 'login', credential });
      if (!out.ok) throw new RemoteError(out.error);
      token = out.result.token; session = out.result.session; loginState = out.result.state || null; persist();
      return session;
    },
    async logout() { try { await post({ action: 'logout', token }); } finally { token = null; session = null; persist(); } },
    getSession: () => (session ? { ...session } : null),
    getServerApi: () => serverApi,
    // המצב ההתחלתי שחזר עם הכניסה (פעם אחת); אם אין, הממשק מבקש getState כרגיל
    takeLoginState() { const s = loginState; loginState = null; return s; },
    setStatusListener(fn) { listener = fn; },
    getPerfLog: () => perf.slice(),
    // קבוצת פעולות עם מזהה קבוע (נשמר בלקוח עד אישור): שליחה חוזרת אחרי ניתוק או רענון אינה מבצעת פעמיים
    applyBatchWithId: (batchId, ops) => send('applyBatch', [ops], batchId),
    async switchStudentCycle(cycleId) {
      const out = await send('switchStudentCycle', [cycleId]);
      if (session) { session = { ...session, cycleId }; persist(); }
      return out;
    },
  };
  return new Proxy(own, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== 'string' || name === 'then') return undefined;
      return (...args) => send(name, args);
    },
  });
}
