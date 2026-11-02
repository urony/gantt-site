// פרסום ציונים לתלמיד וביטול פרסום. לוגיקה טהורה (נבדקת ב-app/tests). החלטות המורה:
//  * המורה שולט בכל פרסום לתלמיד ויכול לבטל כל תוכן שפרסם, בנפרד לכל פריט: ציון משימה, ציון כולל, והערות/משוב (ב-feedback.js).
//  * ביטול פרסום אינו מוחק תוכן או היסטוריה: הוא מסיר את הפריט מתצוגת התלמיד עד פרסום מפורש מחדש. שום דבר אינו מתפרסם מחדש אוטומטית.
//    (ביטול אינו מוחק מידע שהתלמיד כבר ראה.)
//  * התלמיד רואה ציון שלם בלבד (עיגול חצי כלפי מעלה). הערכים המדויקים נשמרים אצל המורה לחישוב. התלמיד אינו רואה את פירוט המחוון והניקוד.
//  * פרסום ציון משימה מסומן כברירת מחדל בעת שליחת משוב וניתן לביטול. פרסום הציון הכולל הוא פעולה נפרדת.
//  * שינוי ציון, משקל או החרגה אינו מפרסם: הוא רק מסמן "שינוי שטרם פורסם". ציון שפורסם נשאר גלוי כתמונת מצב גם אם אחר כך נחסם החישוב.
//  * ההרשאות נאכפות כאן (בשכבת הלוגיקה, שרצה בשרת): פעולות פרסום וביטול למורה בלבד, ותצוגת התלמיד (gradesForStudent) מחזירה רק פריטים שפורסמו לו.
import { newId, currentGroupId } from './logic.js';
import * as G from './grades.js';
import * as F from './feedback.js';
import { visibleCommentsForStudent } from './review.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
const teacherOnly = (session, what = 'הפעולה') => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };

export const pubOf = (state, kind, taskId, studentId) => (state.gradePubs || []).find((p) => p.kind === kind && p.taskId === (taskId || null) && p.studentId === studentId) || null;

// הערך הנוכחי של הציון (מדויק, ללא עיגול) או null אם אין/נחסם
function currentExact(state, kind, taskId, studentId) {
  if (kind === 'task') {
    if (G.isExcluded(state, taskId, studentId)) return null;
    const g = G.gradeOf(state, taskId, studentId);
    return g && g.value !== null && g.value !== undefined ? g.value : null;
  }
  const o = G.overall(state, studentId);
  return o.ok ? o.exact : null;
}

// מצב פרסום של פריט, לתצוגת המורה:
//  empty: אין ציון ולא פורסם | waiting: יש ציון ולא פורסם | published: פורסם ותואם | changed: פורסם, והציון הנוכחי שונה (שינוי שטרם פורסם)
//  blocked: פורסם, והציון הנוכחי חסום או חסר (התלמיד ממשיך לראות את מה שפורסם) | retracted: בוטל הפרסום (התלמיד אינו רואה)
export function pubStatus(state, kind, taskId, studentId) {
  const p = pubOf(state, kind, taskId, studentId);
  const cur = currentExact(state, kind, taskId, studentId);
  const curShown = cur === null ? null : G.roundHalfUp(cur);
  if (!p) return { status: cur === null ? 'empty' : 'waiting', current: cur, currentShown: curShown, pub: null };
  if (p.state === 'retracted') return { status: 'retracted', current: cur, currentShown: curShown, pub: p };
  if (cur === null) return { status: 'blocked', current: null, currentShown: null, pub: p };
  return { status: Math.abs(cur - p.exact) < 1e-9 ? 'published' : 'changed', current: cur, currentShown: curShown, pub: p };
}

function applyPub(s, { kind, taskId = null, studentId, exact, extra = {}, now }) {
  s.gradePubs = s.gradePubs || [];
  let p = s.gradePubs.find((x) => x.kind === kind && x.taskId === taskId && x.studentId === studentId);
  if (!p) { p = { id: newId('pub'), kind, taskId, studentId, state: 'retracted', shown: null, exact: null, publishedAt: null, retractedAt: null, history: [] }; s.gradePubs.push(p); }
  const action = p.state === 'published' ? 'update' : p.history.some((h) => h.action === 'retract') ? 'republish' : 'publish';
  Object.assign(p, { state: 'published', shown: G.roundHalfUp(exact), exact, publishedAt: now, retractedAt: null, ...extra });
  p.history.push({ action, at: now, shown: p.shown, exact });
}

// פרסום ציוני משימה לתלמידים (פעולה מפורשת). מדלג על מי שאין לו ציון, או שהמשימה מוחרגת לו, או שכבר פורסם הערך הנוכחי.
export function publishTaskGrades(state, session, taskId, studentIds, { now = nowIso() } = {}) {
  teacherOnly(session, 'פרסום ציון');
  if (!(state.tasks || []).some((t) => t.id === taskId)) throw new Error('המשימה לא נמצאה');
  const s = clone(state);
  let n = 0;
  for (const id of studentIds) {
    const st = pubStatus(state, 'task', taskId, id);
    if (st.current === null || st.status === 'published') continue;
    applyPub(s, { kind: 'task', taskId, studentId: id, exact: st.current, now });
    n++;
  }
  if (!n) throw new Error('אין ציונים תקפים לפרסום (חסר ציון, מוחרג, או שכבר פורסם הערך הנוכחי)');
  return s;
}
export function retractTaskGrades(state, session, taskId, studentIds, { now = nowIso() } = {}) {
  return retract(state, session, 'task', taskId, studentIds, now);
}

// פרסום הציון הכולל: פעולה נפרדת, רק לתלמידים שהציון הכולל שלהם מחושב. נשמר צילום מצב של הרכיבים (לתיעוד המורה בלבד).
export function publishOverall(state, session, studentIds, { now = nowIso() } = {}) {
  teacherOnly(session, 'פרסום ציון כולל');
  const s = clone(state);
  let n = 0;
  for (const id of studentIds) {
    const o = G.overall(state, id);
    const st = pubStatus(state, 'overall', null, id);
    if (!o.ok || st.status === 'published') continue;
    applyPub(s, { kind: 'overall', studentId: id, exact: o.exact, extra: { components: o.components.map((c) => ({ name: c.name, weight: c.weight, grade: c.grade })) }, now });
    n++;
  }
  if (!n) throw new Error('אין ציון כולל מחושב לפרסום (חסר ציון או משקלים שאינם 100%, או שכבר פורסם הערך הנוכחי)');
  return s;
}
export function retractOverall(state, session, studentIds, { now = nowIso() } = {}) {
  return retract(state, session, 'overall', null, studentIds, now);
}

function retract(state, session, kind, taskId, studentIds, now) {
  teacherOnly(session, 'ביטול פרסום');
  const s = clone(state);
  let n = 0;
  for (const id of studentIds) {
    const p = (s.gradePubs || []).find((x) => x.kind === kind && x.taskId === (taskId || null) && x.studentId === id);
    if (!p || p.state !== 'published') continue;
    p.state = 'retracted'; p.retractedAt = now;
    p.history.push({ action: 'retract', at: now, shown: p.shown, exact: p.exact });
    n++;
  }
  if (!n) throw new Error('אין פרסום פעיל לביטול');
  return s;
}

export function pubHistory(state, kind, taskId, studentId) {
  const p = pubOf(state, kind, taskId, studentId);
  return p ? [...p.history] : [];
}

// שליחת משוב יחד עם פרסום ציון המשימה (ברירת מחדל: מפרסם את הציון). ציון שבוטל פרסומו אינו מתפרסם מחדש בדרך הזו: רק בפרסום מפורש שלו. הציון מפורסם רק למי שזכאי (חברי הקבוצה במועד ההגשה) ויש לו ציון תקף.
export function gradePublishCandidates(state, submissionId) {
  const pv = G.applyPreview(state, submissionId);
  const sb = state.submissions.find((x) => x.id === submissionId);
  return pv.students.map((m) => ({ ...m, ...pubStatus(state, 'task', sb.taskId, m.studentId) }));
}
export function sendFeedbackWithGrade(state, session, submissionId, { publishGrade = true, now = nowIso() } = {}) {
  teacherOnly(session, 'שליחת משוב');
  let s = F.publishFeedback(state, session, submissionId, { now });
  if (publishGrade) {
    const sb = state.submissions.find((x) => x.id === submissionId);
    const ids = gradePublishCandidates(state, submissionId).filter((c) => c.current !== null && c.status !== 'published' && c.status !== 'retracted').map((c) => c.studentId);
    if (ids.length) s = publishTaskGrades(s, session, sb.taskId, ids, { now });
  }
  return s;
}

// שליחה מרוכזת: רק עבודות שסומנו "סיימתי לבדוק" (כמו F.publishBatch), ובאותה ברירת מחדל לפרסום ציון המשימה
export function sendBatchWithGrades(state, session, submissionIds, { publishGrade = true, now = nowIso() } = {}) {
  teacherOnly(session, 'שליחת משוב');
  if (!submissionIds.length) throw new Error('לא נבחרו עבודות לשליחה');
  let s = state;
  for (const id of submissionIds) {
    if (!F.reviewOf(s, id).checked) throw new Error('אפשר לשלוח בשליחה מרוכזת רק עבודות שסומנו "סיימתי לבדוק"');
    s = sendFeedbackWithGrade(s, session, id, { publishGrade, now });
  }
  return s;
}

// ---------- תצוגת תלמיד ----------
// מידע פנימי שאינו נשלח לתלמיד בשום צורה (לא מוסתר רק בממשק): ציונים פנימיים, ניקוד, מחוונים, הצעות AI, טיוטות והערות שבוטל פרסומן.
const INTERNAL = ['grades', 'exclusions', 'personalWeights', 'extraGrades', 'gradeScheme', 'gradeTemplates', 'scoreSheets', 'taskRubrics', 'rubricLibrary', 'aiRounds', 'aiProposals', 'aiQuarantine', 'gradePubs', 'reviews', 'notifs', 'sendLog', 'taskReminders', 'notifSettings', 'adminEvents'];
// הפרדה בנתוני המחזור: תלמיד מקבל רק את עצמו, את חברי קבוצתו הנוכחית (בלי דוא"ל) ואת ההגשות, ההתקדמות והתיקונים של היחידות שלו.
// זו הגנה בשכבת הנתונים (בשרת), לא סינון בממשק בלבד.
function scopeToStudent(s, state, studentId) {
  const gid = currentGroupId(state, studentId);
  const mineUnit = (x) => (x.unitType === 'group' ? !!gid && x.unitId === gid : x.unitId === studentId);
  const mates = new Set((state.memberships || []).filter((m) => gid && m.groupId === gid && !m.to).map((m) => m.studentId));
  mates.add(studentId);
  s.students = (state.students || []).filter((x) => mates.has(x.id)).map((x) => (x.id === studentId ? x : { id: x.id, name: x.name, active: x.active }));
  s.groups = (state.groups || []).filter((g) => g.id === gid);
  s.memberships = (state.memberships || []).filter((m) => mates.has(m.studentId) && (m.studentId === studentId || m.groupId === gid));
  for (const k of ['submissions', 'progress', 'exceptions', 'corrections']) s[k] = (state[k] || []).filter(mineUnit);
}
export function redactForStudent(state, studentId) {
  const s = clone(state);
  const mine = visibleCommentsForStudent(state, studentId);
  const ids = new Set(mine.map((c) => c.id));
  s.comments = mine.map((c) => { const x = clone(c); delete x.pubHistory; delete x.retracted; delete x.retractedAt; delete x.origin; delete x.proposalId; delete x.aiState; return x; });
  s.threads = (state.threads || []).filter((t) => ids.has(t.commentId));
  s.marks = (state.marks || []).filter((m) => ids.has(m.commentId));
  for (const k of INTERNAL) s[k] = [];
  scopeToStudent(s, state, studentId);
  s.aiEnabled = false;
  s.myGrades = gradesForStudent(state, studentId);
  return s;
}
// רק מה שפורסם לתלמיד, ורק ערכים שלמים. אין מקור, אין פירוט מחוון, ואין ערך מדויק.
export function gradesForStudent(state, studentId) {
  const st = (state.students || []).find((x) => x.id === studentId);
  if (!st || !st.active) return { tasks: [], overall: null };
  const mine = (state.gradePubs || []).filter((p) => p.studentId === studentId && p.state === 'published');
  const tasks = mine.filter((p) => p.kind === 'task').map((p) => ({ taskId: p.taskId, title: (state.tasks.find((t) => t.id === p.taskId) || { title: '(משימה שנמחקה)' }).title, value: p.shown, publishedAt: p.publishedAt }))
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const o = mine.find((p) => p.kind === 'overall');
  return { tasks, overall: o ? { value: o.shown, publishedAt: o.publishedAt } : null };
}

// סיכום מצב פרסום להצגה למורה: מה פורסם, מה בוטל, מה ממתין
export function publicationSummary(state, submissionId) {
  const comments = state.comments.filter((c) => c.submissionId === submissionId);
  return {
    published: comments.filter((c) => c.status === 'published').length,
    retracted: comments.filter((c) => c.status === 'draft' && c.retracted).length,
    waiting: comments.filter((c) => c.status === 'draft' && !c.retracted).length,
  };
}
