// הגשות עבודות: לוגיקה טהורה (נבדקת ב-app/tests). כל הפונקציות מחזירות מצב חדש ואינן משנות את הקיים.
// עקרונות:
//  * הגשה נקלטת ברגע ששמירת קובץ המקור הצליחה. חותמת הזמן (uploadedAt) והאיחור נקבעים אז ואינם משתנים לעולם.
//  * כשל בשמירה = אין הגשה (נזרקת שגיאה ושום דבר לא נרשם). כשל בהמרה ל-PDF = ההגשה עדיין נקלטה, וההמרה מסומנת ככשלה.
//  * בהגשה קבוצתית נשמר מי מהתלמידים העלה את הקובץ בפועל (uploadedBy).
//  * כל העלאה חדשה לאותה משימה ויחידה היא גרסה חדשה. הגרסה האחרונה נחשבת, והקודמות נשמרות.
import { newId } from './logic.js';
import * as T from './tasks.js';

export const MAX_BYTES = 20 * 1024 * 1024;
export const SOURCE_EXT = ['docx', 'doc', 'pdf'];

const clone = (s) => structuredClone(s);
const ext = (name) => (String(name).split('.').length > 1 ? String(name).split('.').pop().toLowerCase() : '');
const nowIso = () => new Date().toISOString();

export class SubmissionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// בדיקת קובץ לפני קליטה. הודעות בעברית פשוטה.
export function validateFile({ fileName, size }, allowed = SOURCE_EXT) {
  if (!String(fileName || '').trim()) return { ok: false, code: 'nofile', message: 'לא נבחר קובץ.' };
  if (!allowed.includes(ext(fileName))) {
    return { ok: false, code: 'format', message: `הקובץ לא נקלט: סוג הקובץ אינו נתמך. אפשר להגיש ${allowed.includes('docx') ? 'מסמך Word (docx) או PDF' : 'קובץ PDF'}.` };
  }
  if (!(Number(size) > 0)) return { ok: false, code: 'empty', message: 'הקובץ לא נקלט: הוא ריק.' };
  if (Number(size) > MAX_BYTES) return { ok: false, code: 'size', message: `הקובץ לא נקלט: הוא גדול מדי (מעל ${MAX_BYTES / 1024 / 1024}MB). אפשר לכווץ תמונות במסמך ולנסות שוב.` };
  return { ok: true };
}

export const endOfDayMs = (date) => Date.parse(`${date}T23:59:59`);

// ---------- תיקונים (קריאה). הפעולות של המורה ב-corrections.js ----------
// מצב: returned (הוחזרה לתיקון) | submitted (התיקון הוגש) | rereview (בבדיקה חוזרת)
export const correctionsOf = (state, taskId, unitType, unitId) => (state.corrections || [])
  .filter((c) => c.taskId === taskId && c.unitType === unitType && c.unitId === unitId)
  .sort((a, b) => (a.returnedAt < b.returnedAt ? -1 : a.returnedAt > b.returnedAt ? 1 : 0));
export const currentCorrection = (state, taskId, unitType, unitId) => correctionsOf(state, taskId, unitType, unitId).at(-1) || null;
export const correctionState = (c) => (c.reopenedAt ? 'rereview' : c.submittedSubmissionId ? 'submitted' : 'returned');
// בקשת תיקון פתוחה: הוחזרה וטרם הוגשה גרסה מתוקנת
export const openCorrection = (state, taskId, unitType, unitId) => { const c = currentCorrection(state, taskId, unitType, unitId); return c && correctionState(c) === 'returned' ? c : null; };

// ---------- שאילתות ----------
export const versionsOf = (state, taskId, unitType, unitId) => (state.submissions || [])
  .filter((x) => x.taskId === taskId && x.unitType === unitType && x.unitId === unitId)
  .sort((a, b) => a.version - b.version);

export const latestOf = (state, taskId, unitType, unitId) => versionsOf(state, taskId, unitType, unitId).at(-1) || null;

const studentName = (state, id) => (state.students.find((s) => s.id === id) || {}).name || '';

// המועד הקובע ליחידה (כולל ארכה), בלי תלות בהגשה.
function effectiveDue(state, task, unit) {
  const eff = T.effectiveDates(state, task, unit.type === 'group' ? { groupId: unit.id } : { studentId: unit.id });
  return eff.due;
}

// סטטוס הגשה ליחידה אחת במשימה. now = ISO.
export function submissionStatus(state, task, unit, now = nowIso()) {
  const due = effectiveDue(state, task, unit);
  const latest = latestOf(state, task.id, unit.type, unit.id);
  const prog = T.getProgress(state, task.id, unit.type, unit.id);
  const overdue = Date.parse(now) > endOfDayMs(due);
  if (!latest) return { code: overdue ? 'missing-late' : 'none', due, latest: null, versions: 0, overdue, completion: prog.completion };
  return {
    code: latest.late ? 'late' : 'submitted', due, latest, versions: versionsOf(state, task.id, unit.type, unit.id).length, overdue,
    conversion: latest.conversion.status, pdfRequested: !!latest.pdfRequested, uploader: studentName(state, latest.uploadedBy), completion: prog.completion,
  };
}

// שורות מעקב למורה: כל יחידה בכל משימת הגשה פעילה.
export function trackerRows(state, { taskId = null, now = nowIso() } = {}) {
  const rows = [];
  for (const t of T.orderedTasks(state).filter((x) => x.requiresSubmission && (!taskId || x.id === taskId))) {
    for (const u of T.unitsOfTask(state, t)) {
      const cur = currentCorrection(state, t.id, u.type, u.id);
      rows.push({ task: t, unit: u, ...submissionStatus(state, t, u, now), correction: cur, correctionState: cur ? correctionState(cur) : null });
    }
  }
  return rows;
}

export function trackerSummary(rows) {
  return {
    total: rows.length,
    submitted: rows.filter((r) => r.latest).length,
    late: rows.filter((r) => r.code === 'late').length,
    missingLate: rows.filter((r) => r.code === 'missing-late').length,
    conversionFailed: rows.filter((r) => r.latest && r.conversion === 'failed').length,
    pdfRequested: rows.filter((r) => r.latest && r.pdfRequested).length,
  };
}

// ---------- הרשאות ----------
function ownUnit(state, session, t, unitType, unitId) {
  if (!session || session.role !== 'student') throw new SubmissionError('auth', 'רק תלמיד מגיש עבודה.');
  const visible = T.tasksForStudent(state, session.userId).some((x) => x.id === t.id);
  const mine = T.unitForStudent(state, t, session.userId);
  if (!visible || mine.type !== unitType || mine.id !== unitId) throw new SubmissionError('auth', 'אין הרשאה להגיש ביחידה זו.');
}

// ---------- פעולות ----------
// קליטת הגשה. אם הקובץ לא תקין או שהשמירה נכשלה, נזרקת שגיאה ושום דבר לא נרשם (אין הגשה חלקית).
export function submitFile(state, session, { taskId, unitType, unitId, fileName, size, now = nowIso(), fileKey = null }) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t || !T.isActive(t)) throw new SubmissionError('task', 'המשימה לא נמצאה.');
  if (!t.requiresSubmission) throw new SubmissionError('task', 'במשימה הזו לא מגישים קובץ.');
  ownUnit(state, session, t, unitType, unitId);
  const cur = T.getProgress(state, taskId, unitType, unitId);
  if (cur.completion === 'approved') throw new SubmissionError('approved', 'ההשלמה כבר אושרה על ידי המורה. כדי להגיש שוב, בקש מהמורה לפתוח מחדש.');
  const v = validateFile({ fileName, size });
  if (!v.ok) throw new SubmissionError(v.code, v.message);
  // גרסה מתוקנת: האיחור נמדד מול מועד התיקון (אם נקבע), וההגשה אינה בקשת אישור או בקשה לבדיקה נוספת
  const fix = openCorrection(state, taskId, unitType, unitId);
  const due = fix && fix.dueDate ? fix.dueDate : effectiveDue(state, t, { type: unitType, id: unitId });
  const prev = versionsOf(state, taskId, unitType, unitId);
  const subId = newId('sub');
  let s = clone(state);
  s.submissions.push({
    id: subId, taskId, unitType, unitId, version: prev.length + 1, fileName: String(fileName).trim(), size: Number(size),
    uploadedBy: session.userId, uploadedAt: now, late: Date.parse(now) > endOfDayMs(due), isCorrection: !!fix,
    conversion: { status: 'pending', attempts: 1 }, pdfRequested: false,
    ...(fileKey ? { fileKey } : {}),
  });
  if (fix) {
    const c = s.corrections.find((x) => x.id === fix.id);
    c.submittedSubmissionId = subId;
    c.submittedAt = now;
    return s;
  }
  // הגשה רגילה היא גם בקשת אישור מהמורה (ההשלמה עצמה נקבעת רק על ידיו)
  s = T.claimCompletion(s, session, taskId, unitType, unitId, true);
  return s;
}

function findSub(state, id) {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new SubmissionError('nosub', 'ההגשה לא נמצאה.');
  return x;
}

// תוצאת המרה (מדומה בדמו; בגרסה האמיתית השרת מחזיר תוצאה). אינה נוגעת בחותמת הזמן או באיחור.
export function completeConversion(state, submissionId, { ok, now = nowIso(), error = '', pdfKey = null, pdfName = null, pdfSource = 'converted' }) {
  const cur = findSub(state, submissionId);
  if (cur.conversion.status !== 'pending') return state;
  const s = clone(state);
  const x = findSub(s, submissionId);
  if (ok) {
    x.conversion = { ...x.conversion, status: 'done', pdfName: pdfName || String(x.fileName).replace(/\.[^.]+$/, '') + '.pdf', pdfSource, convertedAt: now, ...(pdfKey ? { pdfKey } : {}) };
  } else {
    x.conversion = { ...x.conversion, status: 'failed', failedAt: now, error: error || 'ההמרה ל-PDF נכשלה' };
  }
  return s;
}

export const canTouch = (state, session, sub) => {
  if (session && session.role === 'teacher') return true;
  if (!session || session.role !== 'student') return false;
  const t = state.tasks.find((x) => x.id === sub.taskId);
  const mine = t && T.unitForStudent(state, t, session.userId);
  return !!mine && mine.type === sub.unitType && mine.id === sub.unitId && T.tasksForStudent(state, session.userId).some((x) => x.id === t.id);
};

// ניסיון המרה חוזר (המורה או הגישה של אותה יחידה). לא משנה מועד הגשה.
export function retryConversion(state, session, submissionId) {
  const cur = findSub(state, submissionId);
  if (!canTouch(state, session, cur)) throw new SubmissionError('auth', 'אין הרשאה.');
  if (cur.conversion.status !== 'failed') throw new SubmissionError('state', 'אין מה לנסות שוב: ההמרה לא נכשלה.');
  const s = clone(state);
  const x = findSub(s, submissionId);
  x.conversion = { status: 'pending', attempts: (x.conversion.attempts || 1) + 1 };
  return s;
}

// המורה מבקש PDF נוסף מהתלמיד. אינו פוגע במועד ההגשה.
export function requestPdf(state, session, submissionId, { now = nowIso() } = {}) {
  if (!session || session.role !== 'teacher') throw new SubmissionError('auth', 'רק המורה מבקש PDF.');
  findSub(state, submissionId);
  const s = clone(state);
  const x = findSub(s, submissionId);
  x.pdfRequested = true;
  x.pdfRequestedAt = now;
  return s;
}

// התלמיד מצרף PDF משלו להגשה קיימת (למשל אחרי כשל המרה). ההגשה המקורית וחותמת הזמן נשארות כפי שהיו.
export function attachPdf(state, session, submissionId, { fileName, size, now = nowIso(), fileKey = null }) {
  const cur = findSub(state, submissionId);
  if (!canTouch(state, session, cur)) throw new SubmissionError('auth', 'אין הרשאה.');
  const v = validateFile({ fileName, size }, ['pdf']);
  if (!v.ok) throw new SubmissionError(v.code, v.message);
  const s = clone(state);
  const x = findSub(s, submissionId);
  x.conversion = { ...x.conversion, status: 'done', pdfName: String(fileName).trim(), pdfSource: 'student', attachedAt: now, attachedBy: session.userId, ...(fileKey ? { pdfKey: fileKey } : {}) };
  x.pdfRequested = false;
  return s;
}

// ---------- מסך תלמיד ממוקד ----------
// מה נדרש מהתלמיד עכשיו. מחזיר רשימות לפי דחיפות: actions (פעולה נדרשת), waiting (ממתין למורה), later (בהמשך), done (הושלם).
// בקשת התיקון הנוכחית של היחידה של התלמיד במשימה (או null)
export function correctionForStudent(state, studentId, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t || !T.tasksForStudent(state, studentId).some((x) => x.id === taskId)) return null;
  const u = T.unitForStudent(state, t, studentId);
  return currentCorrection(state, taskId, u.type, u.id);
}

export function studentFocus(state, studentId, now = nowIso(), soonDays = 7) {
  const out = { actions: [], waiting: [], later: [], done: [] };
  const today = now.slice(0, 10);
  for (const t of T.tasksForStudent(state, studentId)) {
    const unit = T.unitForStudent(state, t, studentId);
    const eff = T.effectiveDates(state, t, { studentId });
    const prog = T.getProgress(state, t.id, unit.type, unit.id);
    const overdue = Date.parse(now) > endOfDayMs(eff.due);
    const soon = !overdue && T.D.diff(eff.due, today) <= soonDays;
    const item = { task: t, unit, due: eff.due, completion: prog.completion, overdue };
    if (prog.completion === 'approved') { out.done.push({ ...item, note: 'הושלם ואושר' }); continue; }
    if (t.requiresSubmission) {
      const st = submissionStatus(state, t, unit, now);
      const sub = st.latest;
      const cur = currentCorrection(state, t.id, unit.type, unit.id);
      const cs = cur ? correctionState(cur) : null;
      if (cs === 'returned') {
        const fixDue = cur.dueDate || eff.due;
        const late = Date.parse(now) > endOfDayMs(fixDue);
        out.actions.push({ ...item, due: fixDue, overdue: late, urgency: 0, kind: 'fix', note: `הוחזרה לתיקון, להגיש גרסה מתוקנת עד ${fixDue.split('-').reverse().join('.')}${late ? ' (עבר המועד)' : ''}`, correction: cur });
        continue;
      }
      if (cs === 'submitted' || cs === 'rereview') {
        out.waiting.push({ ...item, note: cs === 'rereview' ? 'התיקון הוגש, המורה פתח אותו לבדיקה חוזרת' : 'התיקון הוגש. המורה יפתח אותו לבדיקה אם ירצה', submission: sub, correction: cur });
        continue;
      }
      if (sub && sub.pdfRequested) { out.actions.push({ ...item, urgency: 0, kind: 'pdf', note: 'המורה ביקש שתצרף קובץ PDF' }); continue; }
      if (!sub) {
        if (overdue) out.actions.push({ ...item, urgency: 1, kind: 'submit', note: 'עבר המועד וטרם הוגש' });
        else if (soon) out.actions.push({ ...item, urgency: 2, kind: 'submit', note: `להגיש עד ${eff.due.split('-').reverse().join('.')}` });
        else out.later.push({ ...item, note: 'טרם הוגש' });
        continue;
      }
      out.waiting.push({ ...item, note: sub.late ? 'הוגש באיחור, ממתין לבדיקת המורה' : 'הוגש, ממתין לבדיקת המורה', submission: sub });
      continue;
    }
    if (prog.completion === 'claimed') { out.waiting.push({ ...item, note: 'ממתין לאישור המורה' }); continue; }
    if (overdue) out.actions.push({ ...item, urgency: 1, kind: 'report', note: 'עבר המועד. עדכן התקדמות וביקש אישור' });
    else if (soon) out.actions.push({ ...item, urgency: 2, kind: 'report', note: `מועד עד ${eff.due.split('-').reverse().join('.')}` });
    else out.later.push({ ...item, note: '' });
  }
  const byDue = (a, b) => (a.urgency ?? 9) - (b.urgency ?? 9) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
  out.actions.sort(byDue);
  for (const k of ['waiting', 'later', 'done']) out[k].sort((a, b) => (a.due < b.due ? -1 : 1));
  return out;
}


// מיון שורות מעקב ההגשות. key: 'name' (שם קבוצה או תלמיד, לפי א-ב) | 'date' (מועד ההגשה האחרונה) | 'due' (מועד המשימה).
// שורות שטרם הוגשו (אין תאריך הגשה) נשארות בסוף בכל כיוון. dir: 'asc' | 'desc'. מיון יציב: שוויון נשאר בסדר המקורי.
export function sortTrackerRows(rows, key = 'name', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const val = (r) => (key === 'date' ? (r.latest ? r.latest.uploadedAt : null) : key === 'due' ? r.due || null : r.unit.name);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = val(a.r); const y = val(b.r);
    if (x === null && y === null) return a.i - b.i;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = key === 'name' ? String(x).localeCompare(String(y), 'he') : x < y ? -1 : x > y ? 1 : 0;
    return c ? c * sign : a.i - b.i;
  }).map((o) => o.r);
}
