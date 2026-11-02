// משוב: "סיימתי לבדוק" (סימון פנימי), שליחת משוב (פרסום מפורש), "תוקן" (כלי פנימי של התלמידים), תגובות ושאלות.
// לוגיקה טהורה (נבדקת ב-app/tests). החלטות המורה שמוטמעות כאן:
//  1. המורה שולט בפרסום: הערה היא טיוטה עד ש"שליחת משוב" מפרסמת אותה. המצב נשמר בנתונים, ולכן טיוטה אינה גלויה לתלמיד גם אחרי יציאה וחזרה.
//  2. תוספת מאוחרת לאחר שליחה היא טיוטה חדשה, וגלויה רק אחרי שליחה מפורשת נוספת.
//  3. הערה קבוצתית גלויה לכל חברי הקבוצה, הערה אישית רק לנמען (ראו visibleToStudent ב-review.js).
//  4. "תוקן": רשומה משותפת נפרדת מהערת המורה (marks). כל מי שרואה את ההערה יכול לעדכן אותה, והעדכון חל על כולם.
//     המורה אינו רואה אותה ואינו מאשר תיקונים. לא נשמר מי סימן. הערך מוגדר במפורש (לא "החלפה") כך שעדכון כפול אינו סותר.
//     בשרת האמיתי כל סימון הוא עדכון אטומי של רשומה אחת, לא כתיבה מחדש של קובץ המשוב של המורה.
//  5. תלמידים מגיבים לשאלות הבהרה בהערות שהם רואים. תגובה או שאלה על הערה קבוצתית גלויות לכל חברי הקבוצה, ועל הערה אישית רק לתלמיד ולמורה.
//  6. "סיימתי לבדוק" אינו שולח דבר. שליחת משוב היא פעולה נפרדת.
import { newId } from './logic.js';
import { visibleToStudent, commentsOf } from './review.js';
import { currentCorrection, correctionState } from './submissions.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const MAX_THREAD_TEXT = 1000;

const teacherOnly = (session, what = 'הפעולה') => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };
const sub = (state, id) => {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new Error('ההגשה לא נמצאה');
  return x;
};
const cmt = (state, id) => {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw new Error('ההערה לא נמצאה');
  return c;
};

// ---------- מצב בדיקה פנימי של המורה ----------
export const reviewOf = (state, submissionId) => (state.reviews || []).find((r) => r.submissionId === submissionId)
  || { submissionId, checked: false, note: '', checkedAt: null, treated: false, firstSentAt: null, lastSentAt: null };

function upsertReview(s, submissionId, patch) {
  let r = s.reviews.find((x) => x.submissionId === submissionId);
  if (!r) { r = reviewOf(s, submissionId); s.reviews.push(r); }
  Object.assign(r, patch);
}

// "סיימתי לבדוק": סימון פנימי בלבד. אינו מפרסם הערות ואינו משנה דבר שהתלמיד רואה. הערת הטיפול אינה גלויה לתלמיד.
export function setChecked(state, session, submissionId, checked, { note, now = nowIso() } = {}) {
  teacherOnly(session, 'סימון "סיימתי לבדוק"');
  sub(state, submissionId);
  const cur = reviewOf(state, submissionId);
  const n = note === undefined ? cur.note : String(note || '').slice(0, 1000);
  const s = clone(state);
  upsertReview(s, submissionId, { checked: !!checked, note: n, checkedAt: checked ? (cur.checked ? cur.checkedAt : now) : null });
  return s;
}

// "טופל": עבודה שהמורה בדק מחוץ למערכת. בלי פרסום ובלי הערות.
export function setTreated(state, session, submissionId, treated) {
  teacherOnly(session, 'סימון "טופל"');
  sub(state, submissionId);
  const s = clone(state);
  upsertReview(s, submissionId, { treated: !!treated });
  return s;
}

// ---------- שליחת משוב (פרסום) ----------
export const draftsOf = (state, submissionId) => commentsOf(state, submissionId).filter((c) => c.status === 'draft');
export const publishedOf = (state, submissionId) => commentsOf(state, submissionId).filter((c) => c.status === 'published');

// סיכום לפני שליחה: כמה הערות, למי, ואזהרות (הערה אישית לתלמיד שאינו חבר בקבוצה כבר אינה גלויה).
export function sendSummary(state, submissionId) {
  const s0 = sub(state, submissionId);
  const drafts = draftsOf(state, submissionId);
  const groupName = s0.unitType === 'group' ? (state.groups.find((g) => g.id === s0.unitId) || {}).name || '' : '';
  const byAud = new Map();
  let orphan = 0;
  for (const c of drafts) {
    const key = c.studentId || '_unit';
    byAud.set(key, (byAud.get(key) || 0) + 1);
    if (c.studentId && !visibleToStudent(state, c.studentId, { ...c, status: 'published' })) orphan++;
  }
  return {
    total: drafts.length, general: drafts.filter((c) => c.scope === 'general').length, local: drafts.filter((c) => c.scope === 'local').length,
    audiences: [...byAud].map(([k, n]) => ({ studentId: k === '_unit' ? null : k, name: k === '_unit' ? (groupName ? `כל הקבוצה (${groupName})` : (state.students.find((x) => x.id === s0.unitId) || {}).name || '') : (state.students.find((x) => x.id === k) || {}).name || '', count: n })),
    orphan, alreadySent: !!reviewOf(state, submissionId).firstSentAt, retracted: drafts.filter((c) => c.retracted).length,
  };
}

// פרסום כל הטיוטות של הגשה אחת. פעולה מפורשת של המורה בלבד.
export function publishFeedback(state, session, submissionId, { now = nowIso() } = {}) {
  teacherOnly(session, 'שליחת משוב');
  sub(state, submissionId);
  const drafts = draftsOf(state, submissionId);
  if (!drafts.length) throw new Error('אין הערות טיוטה לשליחה');
  const s = clone(state);
  for (const c of s.comments) {
    if (c.submissionId !== submissionId || c.status !== 'draft') continue;
    c.pubHistory = c.pubHistory || [];
    c.pubHistory.push({ action: c.retracted ? 'republish' : 'publish', at: now, text: c.text });
    Object.assign(c, { status: 'published', publishedAt: now, retracted: false });
  }
  const cur = reviewOf(state, submissionId);
  upsertReview(s, submissionId, { firstSentAt: cur.firstSentAt || now, lastSentAt: now });
  return s;
}

// ביטול פרסום (המורה בלבד): ההערה חוזרת להיות טיוטה, אינה נגישה עוד לתלמיד, ונשארת עם כל ההיסטוריה. אפשר לערוך ולפרסם מחדש במפורש.
// ביטול אינו מוחק מידע שהתלמיד כבר ראה. שום הערה אינה מתפרסמת מחדש אוטומטית.
function doRetract(s, c, now) {
  c.pubHistory = c.pubHistory || [];
  c.pubHistory.push({ action: 'retract', at: now, text: c.text });
  Object.assign(c, { status: 'draft', retracted: true, retractedAt: now });
}
export function retractComment(state, session, commentId, { now = nowIso() } = {}) {
  teacherOnly(session, 'ביטול פרסום');
  const cur = cmt(state, commentId);
  if (cur.status !== 'published') throw new Error('ההערה אינה מפורסמת');
  const s = clone(state);
  doRetract(s, cmt(s, commentId), now);
  return s;
}
// ביטול פרסום של כל המשוב שנשלח על הגשה (כל ההערות המפורסמות שלה)
export function retractSubmissionFeedback(state, session, submissionId, { now = nowIso() } = {}) {
  teacherOnly(session, 'ביטול פרסום');
  sub(state, submissionId);
  if (!publishedOf(state, submissionId).length) throw new Error('אין משוב מפורסם לביטול');
  const s = clone(state);
  for (const c of s.comments) if (c.submissionId === submissionId && c.status === 'published') doRetract(s, c, now);
  return s;
}

// שליחה מרוכזת: רק עבודות שסומנו "סיימתי לבדוק" ויש בהן טיוטות. שאר העבודות לא נוגעים.
export function sendableBatch(state) {
  return (state.submissions || []).filter((x) => reviewOf(state, x.id).checked && draftsOf(state, x.id).length);
}
export function publishBatch(state, session, submissionIds, { now = nowIso() } = {}) {
  teacherOnly(session, 'שליחת משוב');
  if (!submissionIds.length) throw new Error('לא נבחרו עבודות לשליחה');
  let s = state;
  for (const id of submissionIds) {
    if (!reviewOf(s, id).checked) throw new Error('אפשר לשלוח בשליחה מרוכזת רק עבודות שסומנו "סיימתי לבדוק"');
    s = publishFeedback(s, session, id, { now });
  }
  return s;
}

// מצב המשוב של הגשה, לתצוגת המורה
export function feedbackState(state, submissionId) {
  const d = draftsOf(state, submissionId).length;
  const p = publishedOf(state, submissionId).length;
  if (!d && !p) return 'none';
  if (d && !p) return 'draft';
  if (!d && p) return 'sent';
  return 'sent+drafts';
}

// ---------- "תוקן" (כלי של התלמידים) ----------
export const markOf = (state, commentId) => (state.marks || []).find((m) => m.commentId === commentId) || { commentId, fixed: false, rev: 0, updatedAt: null };

export function setFixed(state, session, commentId, fixed, { now = nowIso() } = {}) {
  if (!session || session.role !== 'student') throw new Error('סימון "תוקן" הוא כלי של התלמידים');
  const c = cmt(state, commentId);
  if (!visibleToStudent(state, session.userId, c)) throw new Error('אין הרשאה לעדכן הערה זו');
  if (typeof fixed !== 'boolean') throw new Error('ערך לא תקין');
  const cur = markOf(state, commentId);
  if (cur.fixed === fixed) return state; // עדכון כפול (גם ממקביל) אינו משנה דבר
  const s = clone(state);
  let m = s.marks.find((x) => x.commentId === commentId);
  if (!m) { m = { commentId, fixed: false, rev: 0, updatedAt: null }; s.marks.push(m); }
  Object.assign(m, { fixed, rev: m.rev + 1, updatedAt: now });
  return s;
}

// ---------- תגובות ושאלות ----------
export const threadOf = (state, commentId) => (state.threads || []).filter((t) => t.commentId === commentId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

// kind: 'reply' (תגובה, לתלמיד או למורה), 'question' (שאלת הבהרה, תלמיד), 'answer' (תשובת מורה, answersId אופציונלי)
export function addThread(state, session, commentId, { kind, text, answersId = null, now = nowIso() }) {
  const c = cmt(state, commentId);
  const t = String(text || '').trim();
  if (!t) throw new Error('חסר טקסט');
  if (t.length > MAX_THREAD_TEXT) throw new Error(`הטקסט ארוך מדי (עד ${MAX_THREAD_TEXT} תווים)`);
  if (!session) throw new Error('נדרשת כניסה');
  if (c.status !== 'published') throw new Error('אפשר להגיב רק להערה שפורסמה');
  if (session.role === 'student') {
    if (!['reply', 'question'].includes(kind)) throw new Error('סוג לא תקין');
    if (!visibleToStudent(state, session.userId, c)) throw new Error('אין הרשאה להגיב להערה זו');
  } else if (session.role === 'teacher') {
    if (!['reply', 'answer'].includes(kind)) throw new Error('סוג לא תקין');
    if (answersId && !(state.threads || []).some((x) => x.id === answersId && x.commentId === commentId && x.kind === 'question')) throw new Error('השאלה לא נמצאה');
  } else throw new Error('אין הרשאה');
  const s = clone(state);
  s.threads.push({
    id: newId('thr'), commentId, kind, text: t, answersId: kind === 'answer' ? answersId : null,
    authorRole: session.role, authorId: session.role === 'student' ? session.userId : 'teacher', createdAt: now,
  });
  return s;
}

// שאלות הבהרה שטרם נענו: אין "תשובה" שמפנה אליהן, ואין תשובת מורה כללית מאוחרת יותר בשרשור
export function openQuestions(state) {
  const out = [];
  for (const q of (state.threads || []).filter((x) => x.kind === 'question')) {
    const c = state.comments.find((x) => x.id === q.commentId);
    if (!c || c.status !== 'published') continue; // הערה שבוטל פרסומה אינה נגישה לתלמיד, ואין מה לענות עליה
    const answered = state.threads.some((x) => x.commentId === q.commentId && x.authorRole === 'teacher' && (x.answersId === q.id || (!x.answersId && x.createdAt > q.createdAt)));
    if (!answered) out.push({ question: q, comment: c });
  }
  return out;
}
export const openQuestionsOf = (state, submissionId) => openQuestions(state).filter((x) => x.comment.submissionId === submissionId);

// ---------- מסך תלמיד ----------
// כל המשוב שהתלמיד רשאי לראות, מקובץ לפי הגשה (גרסה). רק הערות שפורסמו ומיועדות לו.
export function feedbackForStudent(state, studentId) {
  const vis = state.comments.filter((c) => visibleToStudent(state, studentId, c));
  const bySub = new Map();
  for (const c of vis) { if (!bySub.has(c.submissionId)) bySub.set(c.submissionId, []); bySub.get(c.submissionId).push(c); }
  const out = [];
  for (const [id, comments] of bySub) {
    const s0 = (state.submissions || []).find((x) => x.id === id);
    if (!s0) continue;
    out.push({ submission: s0, task: state.tasks.find((t) => t.id === s0.taskId), comments, unfixed: comments.filter((c) => !markOf(state, c.id).fixed).length, lastPublishedAt: comments.reduce((m, c) => (c.publishedAt > m ? c.publishedAt : m), '') });
  }
  return out.filter((x) => x.task).sort((a, b) => (a.lastPublishedAt < b.lastPublishedAt ? 1 : -1));
}

export const firstOpenQuestionOf = (state, submissionId) => openQuestionsOf(state, submissionId).sort((a, b) => (a.question.createdAt < b.question.createdAt ? -1 : 1))[0] || null;

// מה דורש טיפול מהמורה בהגשה (מסך ההגשות מציג תחילה רק פריטים כאלה). הגשה שסומנה "טופל" או שהשלמתה אושרה אינה דורשת טיפול.
//   review: טרם נבדקה ועדיין לא נשלח עליה משוב | drafts: יש הערות טיוטה לשליחה | question: שאלה פתוחה של תלמיד
//   convert: ההמרה ל-PDF נכשלה ולא צורף PDF | approve: התלמיד ביקש אישור השלמה והמורה טרם אישר (ואין סיבה אחרת)
export function attentionReasons(state, submission, completion) {
  if (!submission) return [];
  const rv = reviewOf(state, submission.id);
  if (rv.treated || completion === 'approved') return [];
  const out = [];
  // עבודה שהוחזרה לתיקון, או גרסה מתוקנת שהוגשה ולא נפתחה לבדיקה חוזרת, אינה "ממתינה לבדיקה" ואינה מבקשת אישור
  const cur = currentCorrection(state, submission.taskId, submission.unitType, submission.unitId);
  const cs = cur ? correctionState(cur) : null;
  const wasReturned = (state.corrections || []).some((c) => c.returnedSubmissionId === submission.id); // נבדקה והוחזרה
  const quiet = wasReturned || (cs === 'submitted' && cur.submittedSubmissionId === submission.id);
  if (!quiet && !rv.checked && !publishedOf(state, submission.id).length) out.push('review');
  if (draftsOf(state, submission.id).length) out.push('drafts');
  if (openQuestionsOf(state, submission.id).length) out.push('question');
  if (submission.conversion.status === 'failed' && submission.conversion.pdfSource !== 'student') out.push('convert');
  if (!quiet && completion === 'claimed' && !out.length) out.push('approve');
  return out;
}
