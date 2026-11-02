// החזרה לתיקון וגרסאות מתוקנות: פעולות המורה. לוגיקה טהורה (נבדקת ב-app/tests).
// החלטות המורה:
//  * המורה מחזיר עבודה לתיקון עם משוב כתוב ומועד תיקון. מצב העבודה: "הוחזרה לתיקון".
//  * הגשת גרסה מתוקנת משנה את המצב ל"התיקון הוגש". זו אינה בקשה לבדיקה נוספת ואינה עבודה חדשה הממתינה לבדיקה
//    (ההגשה אינה מבקשת אישור השלמה). "התיקון הוגש" אינו "המורה אישר שהתיקון תקין".
//  * המורה רשאי, ביוזמתו בלבד, לפתוח את הגרסה המתוקנת לבדיקה חוזרת ("בבדיקה חוזרת").
//  * אין הגבלה על מספר סבבי התיקון. כל גרסה נשמרת עם חותמת הזמן שלה, והערות אינן עוברות אוטומטית בין גרסאות.
// קריאה (correctionState, currentCorrection) והסימון האוטומטי בהגשה נמצאים ב-submissions.js.
import { newId } from './logic.js';
import * as T from './tasks.js';
import { latestOf, currentCorrection, correctionState, correctionsOf } from './submissions.js';
import { draftsOf, publishFeedback } from './feedback.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const MAX_RETURN_TEXT = 2000;

const teacherOnly = (session, what) => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };
const sub = (state, id) => {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new Error('ההגשה לא נמצאה');
  return x;
};
const corr = (state, id) => {
  const c = (state.corrections || []).find((x) => x.id === id);
  if (!c) throw new Error('הבקשה לתיקון לא נמצאה');
  return c;
};
function checkDue(dueDate, now) {
  if (dueDate === null || dueDate === '' || dueDate === undefined) return null;
  if (!T.D.valid(dueDate)) throw new Error('מועד תיקון לא תקין');
  if (dueDate < now.slice(0, 10)) throw new Error('מועד התיקון כבר עבר');
  return dueDate;
}

// מועד תיקון כיתתי אחיד כברירת מחדל: שבועיים מהיום (המורה רשאי לשנות לכל קבוצה או תלמיד)
export const defaultFixDue = (now = nowIso()) => T.D.add(now.slice(0, 10), 14);

// החזרה לתיקון של הגרסה האחרונה בלבד. אם יש הערות טיוטה הן מתפרסמות יחד עם ההחזרה (פעולה מפורשת אחת, עם סיכום).
export function returnForCorrection(state, session, submissionId, { text, dueDate = null, now = nowIso() }) {
  teacherOnly(session, 'החזרה לתיקון');
  const s0 = sub(state, submissionId);
  const latest = latestOf(state, s0.taskId, s0.unitType, s0.unitId);
  if (!latest || latest.id !== submissionId) throw new Error('אפשר להחזיר לתיקון רק את הגרסה האחרונה של העבודה');
  const cur = currentCorrection(state, s0.taskId, s0.unitType, s0.unitId);
  if (cur && correctionState(cur) === 'returned') throw new Error('העבודה כבר הוחזרה לתיקון וממתינה לגרסה מתוקנת');
  const t = String(text || '').trim();
  if (!t) throw new Error('חסר משוב כתוב: מה נדרש לתקן');
  if (t.length > MAX_RETURN_TEXT) throw new Error(`המשוב ארוך מדי (עד ${MAX_RETURN_TEXT} תווים)`);
  const due = checkDue(dueDate, now);
  const drafts = draftsOf(state, submissionId).length;
  let s = drafts ? publishFeedback(state, session, submissionId, { now }) : state;
  s = clone(s);
  s.corrections.push({
    id: newId('fix'), taskId: s0.taskId, unitType: s0.unitType, unitId: s0.unitId, returnedSubmissionId: submissionId,
    returnedAt: now, text: t, dueDate: due, publishedCount: drafts, submittedSubmissionId: null, submittedAt: null, reopenedAt: null,
  });
  // עבודה שהוחזרה לתיקון אינה "הושלמה" ואינה ממתינה לאישור
  return T.reviewCompletion(s, session, s0.taskId, s0.unitType, s0.unitId, 'reject');
}

// שינוי מועד התיקון ליחידה (ארכה): רק כל עוד ממתינים לגרסה מתוקנת
export function setCorrectionDue(state, session, correctionId, dueDate, { now = nowIso() } = {}) {
  teacherOnly(session, 'שינוי מועד תיקון');
  const c = corr(state, correctionId);
  if (correctionState(c) !== 'returned') throw new Error('אפשר לשנות מועד רק כשהעבודה ממתינה לגרסה מתוקנת');
  const due = checkDue(dueDate, now);
  const s = clone(state);
  corr(s, correctionId).dueDate = due;
  return s;
}

// המורה בוחר לפתוח את הגרסה המתוקנת לבדיקה חוזרת. אינו מאשר את התיקון ואינו משנה את הגרסה.
export function reopenForReview(state, session, correctionId, { now = nowIso() } = {}) {
  teacherOnly(session, 'פתיחה לבדיקה חוזרת');
  const c = corr(state, correctionId);
  if (correctionState(c) !== 'submitted') throw new Error('אין גרסה מתוקנת שהוגשה ואפשר לפתוח לבדיקה חוזרת');
  const s = clone(state);
  corr(s, correctionId).reopenedAt = now;
  return s;
}

// הערות מגרסאות קודמות של אותה יחידה (לעיון בלבד). לא מועברות לגרסה הנוכחית.
export function previousVersionsWithComments(state, submissionId) {
  const cur = sub(state, submissionId);
  return (state.submissions || [])
    .filter((x) => x.taskId === cur.taskId && x.unitType === cur.unitType && x.unitId === cur.unitId && x.version < cur.version)
    .sort((a, b) => b.version - a.version)
    .map((x) => ({ submission: x, comments: state.comments.filter((c) => c.submissionId === x.id) }));
}

export { correctionsOf, currentCorrection, correctionState };
