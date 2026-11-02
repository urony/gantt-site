// שכבת שמירה לדמו ולשרת העתידי. כלל מרכזי (DEV_PLAN, "כלל חיבור לשרת"): אין "הצלחה" לפני שמירה בפועל.
// commit כותב קודם לשכבת האחסון, ורק אם הכתיבה הצליחה מתעדכן המצב בזיכרון. כשל = SaveError, המצב נשאר כפי שהיה,
// ושום דבר לא נשמר חלקית. ניסיון חוזר בטוח כי הפעולה מחושבת מחדש מהמצב השמור ולא מהמצב שנכשל.
// אחסון (backend) הוא אובייקט { load(): root | null, save(root): void (זורק בכשל, ואטומי) }.

export class SaveError extends Error {
  constructor(detail) {
    super('השמירה נכשלה, ולכן הפעולה לא בוצעה ושום דבר לא נשמר. אפשר לנסות שוב.');
    this.name = 'SaveError';
    this.detail = detail || '';
  }
}

export function createStore({ backend, init, migrate = (x) => x }) {
  let memory = null;
  let loadFailed = false; // קריאה שנכשלה: אסור לכתוב נתוני התחלה מעל נתונים קיימים שלא הצלחנו לקרוא
  function get() {
    if (memory) return memory;
    let loaded = null;
    try { loaded = backend.load(); loadFailed = false; } catch (e) { loaded = null; loadFailed = true; }
    const m = loaded ? migrate(loaded) : null;
    // שדרוג פורמט (migrate החזיר מבנה אחר): קודם גיבוי של המקור כפי שנקרא. אם הגיבוי נכשל לא ממשיכים ולא כותבים כלום (COMPATIBILITY_POLICY, סעיף 4).
    if (m && m !== loaded && backend.archive) {
      try { backend.archive(loaded); } catch (e) { loadFailed = true; throw new Error('הגיבוי שלפני השדרוג נכשל, ולכן הנתונים לא נטענו. נסו שוב.'); }
    }
    if (m) { memory = m; return memory; }
    const fresh = init(loaded);
    if (loadFailed) { memory = fresh; return memory; }
    try { backend.save(fresh); } catch (e) { /* הדמו ממשיך מהזיכרון; פעולה בפועל תיכשל בגלוי */ }
    memory = fresh;
    return memory;
  }
  function commit(next) {
    if (loadFailed) throw new SaveError('הנתונים לא נטענו, לכן אי אפשר לשמור');
    try { backend.save(next); } catch (e) { throw new SaveError(e && e.message); }
    memory = next;
    return next;
  }
  // שמירה אסינכרונית (שרת): הצלחה רק אחרי שהאחסון אישר. בכשל התוצאה בפועל אינה ודאית (ייתכן שהכתיבה הושלמה והאישור אבד),
  // ולכן מבטלים את הזיכרון והמצב נטען מחדש מהאחסון, שהוא מקור האמת.
  async function commitAsync(next) {
    if (loadFailed) throw new SaveError('הנתונים לא נטענו, לכן אי אפשר לשמור');
    try { await (backend.saveAsync ? backend.saveAsync(next) : backend.save(next)); } catch (e) { memory = null; throw new SaveError(e && e.message); }
    memory = next;
    return next;
  }
  // טעינה מחדש מהאחסון (למשל אחרי כשל, כדי לוודא שהזיכרון תואם למה שנשמר)
  function reload() { memory = null; loadFailed = false; return get(); }
  return { get, commit, commitAsync, reload };
}

// עסקה לבקשה אחת בשרת: כל השינויים מצטברים בצד, ומתפרסמים רק אחרי flush מוצלח (כתיבה אסינכרונית שאושרה).
export function createTxStore(store) {
  let pending = null;
  return {
    get: () => pending || store.get(),
    commit(next) { pending = next; return next; },
    hasPending: () => !!pending,
    async flush() { if (!pending) return; const p = pending; await store.commitAsync(p); pending = null; },
  };
}

// ---------- אחסון localStorage (הדמו) ----------
export function localBackend(storage, key) {
  return {
    load() { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; },
    save(root) { storage.setItem(key, JSON.stringify(root)); },
    archive(raw) { storage.setItem(key + '-pre-migration', JSON.stringify(raw)); },
  };
}

// עטיפה להדמיית כשל כתיבה (ארגז בדיקות בדמו)
export function failingBackend(inner, shouldFail) {
  return {
    load: () => inner.load(),
    save(root) { if (shouldFail()) throw new Error('כשל כתיבה מדומה'); inner.save(root); },
  };
}

// ---------- חלוקה לקבצים (כמו במבנה ה-Drive המתוכנן: קובץ לכל מחזור, פנקס נפרד) ----------
export function splitRoot(root) {
  const { cycles = [], notesBook, ...rest } = root;
  const files = { 'meta.json': { ...rest, cycleIds: cycles.map((c) => c.id) } };
  for (const c of cycles) files[`cycles/${c.id}.json`] = c;
  if (notesBook !== undefined) files['notes.json'] = notesBook;
  return files;
}
export function joinRoot(files) {
  const meta = files['meta.json'];
  if (!meta) return null;
  const { cycleIds, ...rest } = meta;
  const cycles = cycleIds.map((id) => {
    const c = files[`cycles/${id}.json`];
    if (!c) throw new Error('קובץ מחזור חסר: ' + id);
    return c;
  });
  const root = { ...rest, cycles };
  if (files['notes.json'] !== undefined) root.notesBook = files['notes.json'];
  return root;
}

// ---------- סימולטור Drive מקומי ----------
// כתיבה אטומית: כל הקבצים החדשים נכתבים לאזור ביניים, ורק כשכולם הצליחו הם מחליפים את הקיימים.
// נכתבים רק קבצים ששונו. ניתן להזריק כשל בכתיבת הקובץ ה-N (failOnWrite) או בקריאה.
export function createDriveSim() {
  let files = {};
  const sim = {
    failOnWrite: 0, // 1 = הקובץ הראשון שישונה ייכשל; 0 = אין כשל
    failLoad: false,
    latencyMs: 0,
    failAsync: '', // 'before' = הכתיבה נכשלת; 'after' = הכתיבה הושלמה אך האישור אבד (ניתוק); מתאפס אחרי שימוש אחד
    asyncWrites: 0,
    lastWrite: { changed: [], total: 0 },
    archives: [], failArchive: false, // גיבויי מקור שנשמרו לפני שדרוג פורמט
    get files() { return Object.keys(files); },
    backend: {
      async saveAsync(root) {
        if (sim.latencyMs) await new Promise((r) => setTimeout(r, sim.latencyMs));
        const mode = sim.failAsync;
        sim.failAsync = '';
        if (mode === 'before') throw new Error('כשל מדומה: השרת לא זמין');
        sim.backend.save(root);
        sim.asyncWrites += 1;
        if (mode === 'after') throw new Error('כשל מדומה: הקשר נותק לפני אישור הכתיבה');
      },
      archive(raw) {
        if (sim.failArchive) throw new Error('כשל גיבוי מדומה');
        sim.archives.push(structuredClone(raw));
      },
      load() {
        if (sim.failLoad) throw new Error('כשל קריאה מדומה');
        return Object.keys(files).length ? joinRoot(structuredClone(files)) : null;
      },
      save(root) {
        const next = splitRoot(structuredClone(root));
        const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(files[k]));
        const removed = Object.keys(files).filter((k) => !(k in next));
        const staged = {};
        changed.forEach((k, i) => {
          if (sim.failOnWrite && i + 1 === sim.failOnWrite) throw new Error('כשל מדומה בכתיבת ' + k);
          staged[k] = next[k];
        });
        files = { ...Object.fromEntries(Object.entries(files).filter(([k]) => !removed.includes(k))), ...staged };
        sim.lastWrite = { changed, total: Object.keys(next).length };
      },
    },
  };
  return sim;
}
