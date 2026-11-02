// תור שמירה ברקע (למורה): הערות ופעולות ב-Notes נרשמות מיד בממשק ונשמרות בשרת ברקע, בקבוצות, כך שהמורה אינו ממתין לכל שמירה.
// כללים (נבדקים ב-app/tests/write-queue.test.mjs):
//  * אין "נשמר" לפני שהשרת אישר. עד אז הפעולה "ממתינה", ובכשל היא נשארת גלויה עם הטקסט ואפשרות לנסות שוב או לבטל. הטקסט לא נעלם.
//  * כל פעולה נשמרת קודם בדפדפן (localStorage), ולכן שורדת ניתוק, רענון וסגירה לא צפויה, וממשיכה אחרי כניסה מחדש.
//  * קבוצה בדרך לשרת נשמרת עם מזהה קבוע (batchId). ניסיון חוזר (גם אחרי רענון) שולח אותה בדיוק עם אותו מזהה, והשרת אינו מבצע פעמיים;
//    ובנוסף, להערות ול-Notes חדשים יש מזהה שנקבע בלקוח, ושליחה חוזרת שלהם אינה יוצרת כפילות.
//  * פעולה שהשרת דחה (למשל הערה על קטגוריה שהוסתרה) אינה פוגעת בשאר הפעולות בקבוצה, ומסומנת ככושלת.
const SKEY = 'gantt-write-queue-v1:';

export function newClientId(prefix) {
  const r = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('') : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}${r}`.slice(0, 44);
}

const AUTH_LOST = new Set(['unauthenticated', 'access_ended']);

// send(batchId, ops) => Promise<{ state, results|null }> ; storage: {getItem,setItem,removeItem} ; exists(op, state) => boolean (אימות אחרי אישור כפול)
export function createWriteQueue({ send, storage = null, userKey = 'teacher', onChange = () => {}, onSaved = () => {}, exists = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), backoff = [1500, 3000, 6000, 12000], maxBatch = 50, autoStart = true } = {}) {
  const key = SKEY + userKey;
  let st = { queue: [], inflight: null, failed: [] };
  try { const raw = storage && storage.getItem(key); if (raw) { const p = JSON.parse(raw); st = { queue: p.queue || [], inflight: p.inflight || null, failed: p.failed || [] }; } } catch (e) { /* תור שנפגם: מתחילים ריק */ }
  let running = false; let paused = false; let attempt = 0; let lastError = ''; let savedAt = null; let waiters = [];
  const persist = () => { try { storage && storage.setItem(key, JSON.stringify(st)); } catch (e) { /* ללא שמירה מקומית: התור עדיין פועל בזיכרון */ } };
  const pendingOps = () => [...(st.inflight ? st.inflight.ops : []), ...st.queue];
  const status = () => ({ pending: pendingOps().length, sending: running && !paused, failed: st.failed.length, paused, error: lastError, savedAt });
  const notify = () => { try { onChange(status()); } catch (e) { /* ממשק אינו מכשיל שמירה */ } };
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };

  function enqueue(action, args) {
    const op = { opId: newClientId('op'), action, args, at: Date.now() };
    st.queue.push(op); persist(); notify();
    if (autoStart) Promise.resolve().then(run);
    return op.opId;
  }

  async function run() {
    if (running || paused) return;
    running = true; notify();
    try {
      for (;;) {
        if (!st.inflight) {
          if (!st.queue.length) break;
          st.inflight = { batchId: newClientId('b'), ops: st.queue.splice(0, maxBatch) };
          persist(); notify();
        }
        let res;
        try {
          res = await send(st.inflight.batchId, st.inflight.ops.map((o) => ({ action: o.action, args: o.args })));
        } catch (e) {
          if (e && AUTH_LOST.has(e.code)) { paused = true; lastError = 'ההתחברות פגה. יש להיכנס שוב. שינויים שלא נשמרו ממתינים במכשיר ויישמרו אחרי הכניסה.'; break; }
          if (!e || e.retryable === false) {
            // כשל קבוע של כל הקבוצה (למשל אין הרשאה): הפעולות נשארות גלויות ככושלות, עם הטקסט
            const msg = (e && e.message) || 'השמירה נכשלה';
            for (const o of st.inflight.ops) st.failed.push({ ...o, message: msg });
            st.inflight = null; persist(); notify(); continue;
          }
          lastError = (e && e.message) || 'אין חיבור לשרת';
          const wait = backoff[Math.min(attempt, backoff.length - 1)]; attempt++;
          notify();
          await sleep(wait);
          continue; // אותה קבוצה, אותו מזהה
        }
        attempt = 0; lastError = '';
        const ops = st.inflight.ops;
        const results = res && Array.isArray(res.results) ? res.results : null;
        ops.forEach((o, i) => {
          if (results) { if (!results[i] || !results[i].ok) st.failed.push({ ...o, message: (results[i] && results[i].message) || 'הפעולה נדחתה' }); }
          else if (!exists(o, res && res.state)) st.failed.push({ ...o, message: 'לא ידוע אם נשמרה. בדקו וצרו מחדש אם צריך.' });
        });
        st.inflight = null; savedAt = Date.now(); persist();
        try { onSaved(res && res.state); } catch (e) { /* ממשק אינו מכשיל שמירה */ }
        notify();
      }
    } finally { running = false; notify(); wake(); }
  }

  // ממתין עד שאין פעולות ממתינות (או עד עצירה). true = הכול נשמר ואין כשלים.
  async function drain() {
    for (;;) {
      if (!pendingOps().length) return st.failed.length === 0;
      if (paused) return false;
      if (!running) Promise.resolve().then(run);
      await new Promise((r) => waiters.push(r));
    }
  }

  return {
    enqueue, drain, status,
    pendingOps, failedOps: () => st.failed.slice(),
    hasWork: () => pendingOps().length > 0 || st.failed.length > 0,
    resume() { paused = false; lastError = ''; notify(); Promise.resolve().then(run); },
    start() { Promise.resolve().then(run); },
    retryFailed(opId) { const i = st.failed.findIndex((o) => o.opId === opId); if (i < 0) return; const [o] = st.failed.splice(i, 1); delete o.message; st.queue.push(o); persist(); notify(); Promise.resolve().then(run); },
    discardFailed(opId) { st.failed = st.failed.filter((o) => o.opId !== opId); persist(); notify(); },
  };
}
