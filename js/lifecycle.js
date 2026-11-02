// מחזור חיים של מחזור: ארכיון, גישת תלמידים לארכיון, סל מחזורים ומחיקה (שלב 7, חלק ג). לוגיקה טהורה, נבדקת ב-app/tests.
// עקרונות:
//  * לפני העברה לארכיון ולפני מחיקה נשמר גיבוי אוטומטי (backup.js, autoBackups).
//  * ארכיון סוגר גישת תלמידים. המורה יכול לפתוח להם גישה לקריאה בלבד (studentAccessOpen) בלי להפוך את המחזור לפעיל.
//  * אין מחיקה אוטומטית של שום דבר: לא מארכיון ולא מהסל. מחיקה מחזור = העברה לסל ל-30 יום לפחות; הסל נשאר עד שהמורה מוחק לצמיתות באישור מפורש (הקלדת שם המחזור).
//  * הגשות שמורות בצד (heldSubmissions) ויומן ההחלטות אינם נמחקים עם המחזור.
import { getCycle } from './cycles.js';
import { addAutoBackup } from './backup.js';
import { newId } from './logic.js';

export const TRASH_DAYS = 30;
const DAY = 86400000;
const clone = (x) => structuredClone(x);
const nowIso = () => new Date().toISOString();

function needTeacher(session) {
  if (!session || session.role !== 'teacher') throw new Error('פעולה זו מיועדת למורה בלבד.');
}
const logAdd = (log, e) => [...(log || []), { id: newId('log'), ...e }].slice(-300);

// ---------- ארכיון ----------
export function archiveCycle(root, session, id, { now = nowIso() } = {}) {
  needTeacher(session);
  const c = getCycle(root, id);
  if (c.restoring) throw new Error('המחזור בשחזור כרגע. נסו שוב בעוד רגע.');
  if (c.archived) return clone(root);
  const r = addAutoBackup(root, session, id, 'לפני העברה לארכיון', { now });
  const cc = getCycle(r, id);
  cc.archived = true;
  cc.studentAccessOpen = false;
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'archive', cycleId: id, cycleName: cc.name, decision: 'archive', attached: [], held: [], fileNames: [], note: 'גישת תלמידים נסגרה' });
  return r;
}

export function unarchiveCycle(root, session, id, { now = nowIso() } = {}) {
  needTeacher(session);
  const r = clone(root);
  const c = getCycle(r, id);
  if (!c.archived) return r;
  c.archived = false;
  delete c.studentAccessOpen;
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'unarchive', cycleId: id, cycleName: c.name, decision: 'unarchive', attached: [], held: [], fileNames: [], note: '' });
  return r;
}

// פתיחה או סגירה של גישת קריאה לתלמידים במחזור בארכיון, בלי להפוך אותו לפעיל ובלי לאפשר להם לשנות דבר.
export function setStudentAccess(root, session, id, open, { now = nowIso() } = {}) {
  needTeacher(session);
  const r = clone(root);
  const c = getCycle(r, id);
  if (!c.archived) throw new Error('גישת תלמידים נקבעת רק למחזור שבארכיון. מחזור פעיל פתוח לתלמידים.');
  c.studentAccessOpen = !!open;
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'student-access', cycleId: id, cycleName: c.name, decision: open ? 'open' : 'close', attached: [], held: [], fileNames: [], note: open ? 'קריאה בלבד' : '' });
  return r;
}

// ---------- מחיקה לסל ----------
const sameName = (a, b) => String(a || '').trim() === String(b || '').trim();

export function deleteCycle(root, session, id, { confirmName, now = nowIso() } = {}) {
  needTeacher(session);
  const c = getCycle(root, id);
  if (!sameName(confirmName, c.name)) throw new Error('כדי למחוק יש להקליד את שם המחזור במדויק.');
  if (c.restoring) throw new Error('המחזור בשחזור כרגע ואי אפשר למחוק אותו.');
  if (root.cycles.length <= 1) throw new Error('אי אפשר למחוק את המחזור היחיד. צרו מחזור נוסף קודם.');
  // גיבוי אוטומטי, ואז העברה לסל. שום דבר לא נמחק לצמיתות.
  const r = addAutoBackup(root, session, id, 'לפני מחיקה', { now });
  const idx = r.cycles.findIndex((x) => x.id === id);
  const [cycle] = r.cycles.splice(idx, 1);
  delete cycle.studentAccessOpen;
  const retainUntil = new Date(Date.parse(now) + TRASH_DAYS * DAY).toISOString();
  r.trashCycles = [{ id: newId('trash'), cycleId: id, name: cycle.name, deletedAt: now, retainUntil, wasActive: r.activeCycleId === id, cycle }, ...(r.trashCycles || [])];
  if (r.activeCycleId === id) r.activeCycleId = (r.cycles.find((x) => !x.archived) || r.cycles[0]).id;
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'delete', cycleId: id, cycleName: cycle.name, decision: 'trash', attached: [], held: [], fileNames: [], note: `הועבר לסל, נשמר לפחות עד ${retainUntil.slice(0, 10)}` });
  return r;
}

export function trashList(root, { now = nowIso() } = {}) {
  return (root.trashCycles || []).map((t) => ({
    id: t.id, cycleId: t.cycleId, name: t.name, deletedAt: t.deletedAt, retainUntil: t.retainUntil,
    daysLeft: Math.max(0, Math.ceil((Date.parse(t.retainUntil) - Date.parse(now)) / DAY)),
    pastRetention: Date.parse(now) > Date.parse(t.retainUntil),
    counts: { students: t.cycle.data.students.length, tasks: t.cycle.data.tasks.length, submissions: t.cycle.data.submissions.length },
  }));
}

export function restoreFromTrash(root, session, trashId, { now = nowIso() } = {}) {
  needTeacher(session);
  const t = (root.trashCycles || []).find((x) => x.id === trashId);
  if (!t) throw new Error('המחזור לא נמצא בסל.');
  if (root.cycles.some((c) => c.id === t.cycleId)) throw new Error('כבר קיים מחזור עם אותו מזהה (אולי שוחזר מגיבוי). אפשר למחוק את אחד מהם.');
  const r = clone(root);
  const cycle = clone(t.cycle);
  if (r.cycles.some((c) => c.name === cycle.name)) cycle.name = `${cycle.name} (משוחזר)`;
  cycle.archived = true; // חוזר סגור לתלמידים ולא פעיל; המורה מחליט אם להחזיר לפעיל
  delete cycle.studentAccessOpen;
  r.cycles.push(cycle);
  r.trashCycles = r.trashCycles.filter((x) => x.id !== trashId);
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'trash-restore', cycleId: cycle.id, cycleName: cycle.name, decision: 'restore', attached: [], held: [], fileNames: [], note: 'חזר כארכיון, ללא גישת תלמידים' });
  return r;
}

// מחיקה לצמיתות מהסל: רק ביוזמת המורה, עם הקלדת שם המחזור. אין מחיקה אוטומטית אחרי 30 יום.
export function purgeTrashed(root, session, trashId, { confirmName, now = nowIso() } = {}) {
  needTeacher(session);
  const t = (root.trashCycles || []).find((x) => x.id === trashId);
  if (!t) throw new Error('המחזור לא נמצא בסל.');
  if (!sameName(confirmName, t.name)) throw new Error('כדי למחוק לצמיתות יש להקליד את שם המחזור במדויק.');
  const r = clone(root);
  r.trashCycles = r.trashCycles.filter((x) => x.id !== trashId);
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'purge', cycleId: t.cycleId, cycleName: t.name, decision: 'purge', attached: [], held: [], fileNames: [], note: 'נמחק לצמיתות מהסל' });
  return r;
}
