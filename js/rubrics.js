// מחוונים וניקוד בבדיקה. לוגיקה טהורה (נבדקת ב-app/tests). שלוש רמות נפרדות (החלטת המורה):
//  1. מחוון בסיס: בספריית המערכת (משותפת לכל המחזורים, כמו בנק המשימות). עריכה מעלה גרסה.
//  2. מחוון משימה: עותק של מחוון בסיס, משויך למשימה במחזור, וניתן לעריכה חופשית.
//  3. צילום מצב: עותק קבוע של מחוון המשימה, שנלקח בפעם הראשונה שמנקדים הגשה מסוימת. שינוי במחוון הבסיס או במחוון המשימה
//     אינו משנה ניקוד שכבר התחיל. כל גרסת הגשה מנוקדת בנפרד, ולכן ניקוד קודם נשמר בהיסטוריה.
// כל משימה מקבלת ציון 0 עד 100: סך הנקודות חלקי סך המקסימום של המחוון. אין כאן עיגול, שקלול או פרסום (חלקים ב-ג).
// הניקוד פנימי: אינו גלוי לתלמיד, ואין פרסום ציון בחלק זה. סיכוני פסילה הם סימון בלבד ואינם משנים ציון.
import { newId } from './logic.js';
import { buildDefaultLibrary, RISK_FLAGS } from './rubric-defaults.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const MAX_CRITERIA = 40;
export const MAX_DESC = 3000;
export const MAX_NAME = 200;
export const MAX_NOTE = 1000;

const teacherOnly = (session, what = 'הפעולה') => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };
const sub = (state, id) => {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new Error('ההגשה לא נמצאה');
  return x;
};
const task = (state, id) => {
  const t = (state.tasks || []).find((x) => x.id === id);
  if (!t) throw new Error('המשימה לא נמצאה');
  return t;
};

// ---------- בדיקת תקינות ----------
function cleanCriteria(kind, list) {
  if (!Array.isArray(list) || !list.length) throw new Error('חייב להיות לפחות קריטריון אחד');
  if (list.length > MAX_CRITERIA) throw new Error(`יותר מדי קריטריונים (עד ${MAX_CRITERIA})`);
  const seen = new Set();
  return list.map((x, i) => {
    const name = String(x.name || '').trim();
    if (!name) throw new Error(`לקריטריון ${i + 1} חסר שם`);
    if (name.length > MAX_NAME) throw new Error('שם קריטריון ארוך מדי');
    const max = kind === 'checklist' ? 0 : Number(x.max);
    if (kind !== 'checklist' && !(Number.isFinite(max) && max > 0 && max <= 1000)) throw new Error(`לקריטריון "${name}" נדרש ניקוד מרבי חיובי (עד 1000)`);
    const id = x.id && !seen.has(x.id) ? x.id : newId('crt');
    seen.add(id);
    const d = (k) => { const v = String(x[k] || ''); if (v.length > MAX_DESC) throw new Error('תיאור רמה ארוך מדי'); return v; };
    return { id, name, max, green: d('green'), yellow: d('yellow'), red: d('red') };
  });
}
function checkHead({ name, kind }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('חסר שם למחוון');
  if (n.length > MAX_NAME) throw new Error('שם המחוון ארוך מדי');
  if (!['points', 'checklist'].includes(kind)) throw new Error('סוג מחוון לא תקין');
  return n;
}

// ---------- ספריית מחווני בסיס (משותפת לכל המחזורים) ----------
export const libraryOf = (state, { includeArchived = false } = {}) => (state.rubricLibrary || buildDefaultLibrary()).filter((r) => includeArchived || !r.archived);
export const baseRubric = (state, id) => (state.rubricLibrary || []).find((r) => r.id === id) || null;
export const rubricTotal = (r) => r.criteria.reduce((n, x) => n + x.max, 0);

export function addBaseRubric(state, session, { name, kind = 'points', criteria }) {
  teacherOnly(session, 'הוספת מחוון');
  const n = checkHead({ name, kind });
  const s = clone(state);
  s.rubricLibrary = s.rubricLibrary || buildDefaultLibrary();
  if (s.rubricLibrary.some((r) => !r.archived && r.name === n)) throw new Error('כבר קיים מחוון בשם הזה');
  s.rubricLibrary.push({ id: newId('rbk'), key: null, name: n, kind, version: 1, archived: false, builtIn: false, criteria: cleanCriteria(kind, criteria) });
  return s;
}
// עריכה מעלה גרסה. מחוונים של משימות וצילומי מצב קיימים אינם משתנים.
export function updateBaseRubric(state, session, id, { name, criteria }) {
  teacherOnly(session, 'עריכת מחוון');
  const cur = baseRubric(state, id);
  if (!cur) throw new Error('המחוון לא נמצא');
  const n = checkHead({ name, kind: cur.kind });
  const s = clone(state);
  if (s.rubricLibrary.some((r) => r.id !== id && !r.archived && r.name === n)) throw new Error('כבר קיים מחוון בשם הזה');
  const r = baseRubric(s, id);
  Object.assign(r, { name: n, criteria: cleanCriteria(cur.kind, criteria), version: cur.version + 1 });
  return s;
}
export function duplicateBaseRubric(state, session, id) {
  teacherOnly(session, 'שכפול מחוון');
  const cur = baseRubric(state, id);
  if (!cur) throw new Error('המחוון לא נמצא');
  let n = `${cur.name} (עותק)`;
  for (let i = 2; (state.rubricLibrary || []).some((r) => r.name === n); i++) n = `${cur.name} (עותק ${i})`;
  return addBaseRubric(state, session, { name: n, kind: cur.kind, criteria: cur.criteria.map((x) => ({ ...x, id: undefined })) });
}
// "מחיקה" היא הסתרה: אינה משנה מחוונים משויכים וצילומי מצב.
export function setBaseArchived(state, session, id, archived) {
  teacherOnly(session, 'הסתרת מחוון');
  if (!baseRubric(state, id)) throw new Error('המחוון לא נמצא');
  const s = clone(state);
  baseRubric(s, id).archived = !!archived;
  return s;
}

// ---------- מחוון משימה (במחזור) ----------
export const taskRubricOf = (state, taskId) => (state.taskRubrics || []).find((r) => r.taskId === taskId) || null;

export function assignRubric(state, session, taskId, baseId, { now = nowIso() } = {}) {
  teacherOnly(session, 'שיוך מחוון למשימה');
  task(state, taskId);
  const b = baseRubric(state, baseId);
  if (!b) throw new Error('מחוון הבסיס לא נמצא');
  const s = clone(state);
  s.taskRubrics = (s.taskRubrics || []).filter((r) => r.taskId !== taskId);
  s.taskRubrics.push({ taskId, baseId: b.id, baseVersion: b.version, name: b.name, kind: b.kind, criteria: clone(b.criteria), updatedAt: now });
  return s;
}
export function updateTaskRubric(state, session, taskId, { name, criteria }, { now = nowIso() } = {}) {
  teacherOnly(session, 'עריכת מחוון משימה');
  const cur = taskRubricOf(state, taskId);
  if (!cur) throw new Error('למשימה אין מחוון');
  const n = checkHead({ name, kind: cur.kind });
  const s = clone(state);
  Object.assign(taskRubricOf(s, taskId), { name: n, criteria: cleanCriteria(cur.kind, criteria), updatedAt: now });
  return s;
}
export function removeTaskRubric(state, session, taskId) {
  teacherOnly(session, 'הסרת מחוון ממשימה');
  const s = clone(state);
  s.taskRubrics = (s.taskRubrics || []).filter((r) => r.taskId !== taskId);
  return s;
}

// ---------- ניקוד הגשה (צילום מצב קבוע) ----------
export const sheetOf = (state, submissionId) => (state.scoreSheets || []).find((x) => x.submissionId === submissionId) || null;

function ensureSheet(s, submissionId, now) {
  let sh = sheetOf(s, submissionId);
  if (sh) return sh;
  const sb = sub(s, submissionId);
  const tr = taskRubricOf(s, sb.taskId);
  if (!tr) throw new Error('למשימה אין מחוון. בחר מחוון במסך "מחוונים"');
  s.scoreSheets = s.scoreSheets || [];
  sh = {
    id: newId('shp'), submissionId, taskId: sb.taskId, unitType: sb.unitType, unitId: sb.unitId, version: sb.version,
    snapshot: { baseId: tr.baseId, baseVersion: tr.baseVersion, name: tr.name, kind: tr.kind, criteria: clone(tr.criteria), takenAt: now },
    points: {}, checks: {}, risks: [], note: '', createdAt: now, updatedAt: now,
  };
  s.scoreSheets.push(sh);
  return sh;
}

// תחילת סבב בדיקה: צילום מצב של המחוון נקבע מיד, גם לפני שניתן ניקוד כלשהו (אפיון 11.3).
// פעולה חוזרת אינה משנה צילום קיים. למשימה בלי מחוון אין מה לצלם, והמצב מוחזר כמות שהוא.
export function startScoring(state, session, submissionId, { now = nowIso() } = {}) {
  teacherOnly(session, 'תחילת בדיקה');
  sub(state, submissionId);
  if (sheetOf(state, submissionId) || !taskRubricOf(state, sub(state, submissionId).taskId)) return state;
  const s = clone(state);
  ensureSheet(s, submissionId, now);
  return s;
}

export function setPoints(state, session, submissionId, criterionId, value, { now = nowIso() } = {}) {
  teacherOnly(session, 'מתן ניקוד');
  sub(state, submissionId);
  const s = clone(state);
  const sh = ensureSheet(s, submissionId, now);
  if (sh.snapshot.kind !== 'points') throw new Error('זה מחוון רשימת בדיקה, ללא ניקוד');
  const cr = sh.snapshot.criteria.find((x) => x.id === criterionId);
  if (!cr) throw new Error('הקריטריון לא נמצא במחוון של הבדיקה');
  if (value === null || value === '' || value === undefined) delete sh.points[criterionId];
  else {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error('הניקוד חייב להיות מספר');
    if (v < 0 || v > cr.max) throw new Error(`הניקוד חייב להיות בין 0 ל-${cr.max}`);
    sh.points[criterionId] = Math.round(v * 100) / 100;
  }
  sh.updatedAt = now;
  return s;
}

export function setCheck(state, session, submissionId, criterionId, value, { now = nowIso() } = {}) {
  teacherOnly(session, 'סימון ברשימת בדיקה');
  sub(state, submissionId);
  const s = clone(state);
  const sh = ensureSheet(s, submissionId, now);
  if (!sh.snapshot.criteria.some((x) => x.id === criterionId)) throw new Error('הפריט לא נמצא ברשימה');
  if (value === null || value === undefined) delete sh.checks[criterionId];
  else sh.checks[criterionId] = !!value;
  sh.updatedAt = now;
  return s;
}

export function setNote(state, session, submissionId, note, { now = nowIso() } = {}) {
  teacherOnly(session, 'הערת ניקוד');
  sub(state, submissionId);
  const s = clone(state);
  const sh = ensureSheet(s, submissionId, now);
  sh.note = String(note || '').slice(0, MAX_NOTE);
  sh.updatedAt = now;
  return s;
}

// סיכון פסילה: סימון בלבד. אינו משנה ציון. הודעה לתלמיד תישלח רק בשליחת משוב מפורשת (חלק ג).
export function setRisk(state, session, submissionId, flagKey, on, { now = nowIso() } = {}) {
  teacherOnly(session, 'סימון סיכון פסילה');
  sub(state, submissionId);
  if (!RISK_FLAGS.some((f) => f.key === flagKey)) throw new Error('סוג סיכון לא מוכר');
  const s = clone(state);
  const sh = ensureSheet(s, submissionId, now);
  sh.risks = sh.risks.filter((k) => k !== flagKey);
  if (on) sh.risks.push(flagKey);
  sh.updatedAt = now;
  return s;
}

// חישוב: ציון 0-100 הוא סך הנקודות חלקי סך המקסימום. אין עיגול. null עד שכל הקריטריונים קיבלו ניקוד.
export function scoreOf(sheet) {
  if (!sheet) return null;
  const cr = sheet.snapshot.criteria;
  if (sheet.snapshot.kind === 'checklist') {
    const done = cr.filter((x) => sheet.checks[x.id] === true).length;
    const answered = cr.filter((x) => sheet.checks[x.id] !== undefined).length;
    return { kind: 'checklist', total: cr.length, done, answered, complete: answered === cr.length, allOk: done === cr.length };
  }
  const max = cr.reduce((n, x) => n + x.max, 0);
  const scored = cr.filter((x) => sheet.points[x.id] !== undefined);
  const points = scored.reduce((n, x) => n + sheet.points[x.id], 0);
  const complete = scored.length === cr.length;
  return { kind: 'points', points, max, scored: scored.length, total: cr.length, complete, percent: complete ? (points / max) * 100 : null };
}

// רמת הצבע של ניקוד קריטריון, לתצוגה בלבד (הכוונה)
export function bandOf(points, max) {
  if (points === undefined || points === null || !max) return null;
  const p = points / max;
  return p >= 0.9 ? 'green' : p >= 0.5 ? 'yellow' : 'red';
}

export const sheetsOfTask = (state, taskId) => (state.scoreSheets || []).filter((x) => x.taskId === taskId);
