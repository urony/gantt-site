// פנקס Notes אישי של המורה: לוגיקה טהורה (נבדקת ב-app/tests). אינה משנה את הקיים.
// עקרונות (החלטת המורה):
//  * הפנקס אישי למורה בלבד: כל פעולה דורשת מורה, והפנקס אינו חלק מנתוני מחזור, ולכן אינו נשלח לתלמיד ואינו בייצוא מחזור.
//  * הפנקס נשמר בשכבה אישית נפרדת (root.notesBook). בגרסה האמיתית: קובץ אישי ב-Drive של המורה.
//  * שמירה אמינה בלי מערכת מורכבת: היסטוריית עריכות קצרה לכל Note, מחיקה לסל (לא נעלמת), וגיבוי/שחזור של הפנקס כקובץ.
//    שחזור הוא מיזוג (לא דורס Note חדש יותר), מציג תצוגה מקדימה, ושומר נקודת שחזור שאפשר לחזור אליה.
//    בשלב 7 הגיבוי יצורף למנגנון הגיבוי הכללי של המורה כחלק אישי מסומן.
import { newId } from './logic.js';

export const MAX_TEXT = 5000;
export const MAX_HISTORY = 20;
export const BACKUP_KIND = 'teacher-personal-notes';
export const BACKUP_VERSION = 1;
export const SCOPES = { general: 'כללית', student: 'תלמיד', group: 'קבוצה' };
export const STATUSES = { none: 'ללא סימון', todo: 'דורש טיפול', done: 'טופל' };

const clone = (x) => structuredClone(x);
const nowIso = () => new Date().toISOString();

export const emptyBook = () => ({ items: [], restorePoint: null });

export function normalizeBook(b) {
  const r = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  return { items: Array.isArray(r.items) ? r.items : [], restorePoint: r.restorePoint || null };
}

function needTeacher(session) {
  if (!session || session.role !== 'teacher') throw new Error('פנקס ה-Notes אישי למורה בלבד.');
}

// ---------- בדיקת קלט ----------
function cleanFields({ text, scope = 'general', cycleId = null, refId = null, refName = '', status = 'none' }) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('ה-Note ריק. כתוב טקסט.');
  if (t.length > MAX_TEXT) throw new Error(`ה-Note ארוך מדי (מעל ${MAX_TEXT} תווים).`);
  if (!SCOPES[scope]) throw new Error('שיוך לא תקין.');
  if (!STATUSES[status]) throw new Error('סימון לא תקין.');
  if (scope !== 'general' && (!refId || !cycleId)) throw new Error(scope === 'student' ? 'לא נבחר תלמיד.' : 'לא נבחרה קבוצה.');
  return scope === 'general'
    ? { text: t, scope, cycleId: null, refId: null, refName: '', status }
    : { text: t, scope, cycleId, refId, refName: String(refName || '').slice(0, 120), status };
}

const find = (book, id) => {
  const n = book.items.find((x) => x.id === id);
  if (!n) throw new Error('ה-Note לא נמצא.');
  return n;
};

// ---------- פעולות ----------
// מזהה שנבחר בלקוח (d.id): ראו addComment ב-review.js. קיים מזהה כזה: אין שינוי (שליחה חוזרת).
export const CLIENT_ID = /^note_[a-z0-9]{8,40}$/;
export function addNote(book, session, d, { now = nowIso() } = {}) {
  needTeacher(session);
  const id = d && d.id !== undefined && d.id !== null ? String(d.id) : null;
  if (id !== null && !CLIENT_ID.test(id)) throw new Error('מזהה Note לא תקין');
  if (id !== null && normalizeBook(book).items.some((x) => x.id === id)) return normalizeBook(book);
  const b = clone(normalizeBook(book));
  b.items.push({ id: id !== null ? id : newId('note'), ...cleanFields(d), createdAt: now, updatedAt: now, deletedAt: null, history: [] });
  return b;
}

// עריכה: טקסט, שיוך וסימון. כל שינוי בטקסט או בשיוך שומר את הנוסח הקודם בהיסטוריה (עד MAX_HISTORY).
export function updateNote(book, session, id, patch, { now = nowIso() } = {}) {
  needTeacher(session);
  const b = clone(normalizeBook(book));
  const n = find(b, id);
  if (n.deletedAt) throw new Error('ה-Note בסל. שחזר אותו כדי לערוך.');
  const next = cleanFields({ text: n.text, scope: n.scope, cycleId: n.cycleId, refId: n.refId, refName: n.refName, status: n.status, ...patch });
  const changedContent = next.text !== n.text || next.scope !== n.scope || next.refId !== n.refId;
  if (changedContent) {
    n.history.push({ at: n.updatedAt, text: n.text, scope: n.scope, refName: n.refName });
    if (n.history.length > MAX_HISTORY) n.history = n.history.slice(-MAX_HISTORY);
  }
  Object.assign(n, next);
  if (changedContent || next.status !== undefined) n.updatedAt = now;
  return b;
}

export function setStatus(book, session, id, status, opts) {
  needTeacher(session);
  if (!STATUSES[status]) throw new Error('סימון לא תקין.');
  return updateNote(book, session, id, { status }, opts);
}

// מחיקה היא העברה לסל: ה-Note נשמר עד מחיקה לצמיתות
export function deleteNote(book, session, id, { now = nowIso() } = {}) {
  needTeacher(session);
  const b = clone(normalizeBook(book));
  const n = find(b, id);
  if (!n.deletedAt) { n.deletedAt = now; n.updatedAt = now; }
  return b;
}

export function restoreNote(book, session, id, { now = nowIso() } = {}) {
  needTeacher(session);
  const b = clone(normalizeBook(book));
  const n = find(b, id);
  n.deletedAt = null;
  n.updatedAt = now;
  return b;
}

// מחיקה לצמיתות: רק מהסל
export function purgeNote(book, session, id) {
  needTeacher(session);
  const b = clone(normalizeBook(book));
  const n = find(b, id);
  if (!n.deletedAt) throw new Error('אפשר למחוק לצמיתות רק Note שנמצא בסל.');
  b.items = b.items.filter((x) => x.id !== id);
  return b;
}

// ---------- חיפוש וסינון ----------
// q: חיפוש בטקסט ובשם התלמיד או הקבוצה. scope/status/cycleId: 'all' או ערך. trash: true = הסל בלבד.
export function searchNotes(book, session, { q = '', scope = 'all', status = 'all', cycleId = 'all', trash = false } = {}) {
  needTeacher(session);
  const term = String(q).trim().toLowerCase();
  return normalizeBook(book).items
    .filter((n) => (trash ? !!n.deletedAt : !n.deletedAt))
    .filter((n) => scope === 'all' || n.scope === scope)
    .filter((n) => status === 'all' || n.status === status)
    .filter((n) => cycleId === 'all' || n.scope === 'general' || n.cycleId === cycleId)
    .filter((n) => !term || n.text.toLowerCase().includes(term) || (n.refName || '').toLowerCase().includes(term))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export const todoCount = (book) => normalizeBook(book).items.filter((n) => !n.deletedAt && n.status === 'todo').length;

// ---------- גיבוי ושחזור ----------
// קובץ הגיבוי מכיל את הפנקס בלבד (בלי נתוני מחזור). אינו קובץ ייצוא מחזור.
export function personalBackup(book, session, { now = nowIso() } = {}) {
  needTeacher(session);
  return { kind: BACKUP_KIND, version: BACKUP_VERSION, savedAt: now, items: clone(normalizeBook(book).items) };
}

function sanitizeItem(x) {
  const f = cleanFields({ text: x.text, scope: x.scope, cycleId: x.cycleId, refId: x.refId, refName: x.refName, status: x.status });
  if (typeof x.id !== 'string' || !x.id) throw new Error('רשומה בלי מזהה.');
  const iso = (v, d) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : d);
  const created = iso(x.createdAt, nowIso());
  const history = (Array.isArray(x.history) ? x.history : []).slice(-MAX_HISTORY).map((h) => ({ at: iso(h.at, created), text: String(h.text || '').slice(0, MAX_TEXT), scope: SCOPES[h.scope] ? h.scope : 'general', refName: String(h.refName || '').slice(0, 120) }));
  return { id: x.id, ...f, createdAt: created, updatedAt: iso(x.updatedAt, created), deletedAt: x.deletedAt ? iso(x.deletedAt, nowIso()) : null, history };
}

// בדיקת קובץ גיבוי. זורק שגיאה בעברית אם אינו קובץ גיבוי תקין של הפנקס. מחזיר רשימת Notes נקייה.
export function validateBackup(backup) {
  if (!backup || typeof backup !== 'object') throw new Error('הקובץ אינו קובץ גיבוי של הפנקס.');
  if (backup.kind !== BACKUP_KIND) throw new Error('זה אינו קובץ גיבוי של פנקס ה-Notes (אולי זה ייצוא מחזור).');
  if (backup.version !== BACKUP_VERSION) throw new Error('גרסת קובץ הגיבוי אינה נתמכת.');
  if (!Array.isArray(backup.items)) throw new Error('בקובץ הגיבוי אין רשימת Notes.');
  const seen = new Set();
  return backup.items.map((x, i) => {
    let s;
    try { s = sanitizeItem(x || {}); } catch (e) { throw new Error(`רשומה ${i + 1} בקובץ אינה תקינה: ${e.message}`); }
    if (seen.has(s.id)) throw new Error(`רשומה ${i + 1} כפולה בקובץ.`);
    seen.add(s.id);
    return s;
  });
}

// תצוגה מקדימה: מה ייווסף, מה יתעדכן (הגיבוי חדש יותר), מה יישאר כפי שהוא (הנוכחי חדש יותר או זהה), ומה קיים רק כאן.
export function previewRestore(book, session, backup) {
  needTeacher(session);
  const incoming = validateBackup(backup);
  const cur = new Map(normalizeBook(book).items.map((n) => [n.id, n]));
  const out = { added: [], updated: [], keptNewer: [], same: [], onlyHere: 0, total: incoming.length, savedAt: backup.savedAt || '' };
  for (const n of incoming) {
    const c = cur.get(n.id);
    if (!c) out.added.push(n.id);
    else if (JSON.stringify(strip(c)) === JSON.stringify(strip(n))) out.same.push(n.id);
    else if (n.updatedAt > c.updatedAt) out.updated.push(n.id);
    else out.keptNewer.push(n.id);
  }
  const inc = new Set(incoming.map((n) => n.id));
  out.onlyHere = [...cur.keys()].filter((id) => !inc.has(id)).length;
  return out;
}
const strip = ({ history, ...r }) => r; // eslint-disable-line no-unused-vars

// שחזור = מיזוג: Note שאינו קיים נוסף; Note שהגיבוי חדש ממנו מתעדכן (והנוסח הנוכחי נשמר בהיסטוריה שלו);
// Note נוכחי חדש יותר או זהה נשאר; מה שקיים רק כאן נשמר. לפני השחזור נשמרת נקודת שחזור לחזרה.
export function restoreFromBackup(book, session, backup, { now = nowIso() } = {}) {
  needTeacher(session);
  const incoming = validateBackup(backup);
  const prev = normalizeBook(book);
  const b = clone(prev);
  b.restorePoint = { at: now, items: clone(prev.items) };
  for (const n of incoming) {
    const i = b.items.findIndex((x) => x.id === n.id);
    if (i < 0) { b.items.push(n); continue; }
    const c = b.items[i];
    if (n.updatedAt > c.updatedAt) {
      const hist = [...(c.history || []), { at: c.updatedAt, text: c.text, scope: c.scope, refName: c.refName }].slice(-MAX_HISTORY);
      b.items[i] = { ...n, history: hist };
    }
  }
  return b;
}

// חזרה למצב שלפני השחזור האחרון (אם נשמרה נקודה)
export function undoRestore(book, session) {
  needTeacher(session);
  const cur = normalizeBook(book);
  if (!cur.restorePoint) throw new Error('אין שחזור לבטל.');
  return { items: clone(cur.restorePoint.items), restorePoint: null };
}
