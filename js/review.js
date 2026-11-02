// בדיקה ידנית: הערות על מסמכים שהוגשו, קטגוריות והרשאות נראות. לוגיקה טהורה (נבדקת ב-app/tests).
// עקרונות (מהאפיון ומהחלטות המורה):
//  * הערה שייכת לגרסת הגשה מסוימת (submissionId). הערות אינן עוברות אוטומטית לגרסה אחרת.
//  * הערה נוצרת כטיפוס "draft" (טיוטה), ואינה נראית לתלמיד עד פרסום מפורש (חלק הבא). רק המורה יוצר ועורך הערות.
//  * הערה יכולה להיות מקומית (מעוגנת לקטע) או כללית. בהערות על מטלה קבוצתית: לכל הקבוצה, או אישית לתלמיד אחד.
//  * מבנה ההערה נושא מקור (source) ומצב אישור (aiState) כדי שהצעות AI עתידיות יישמרו כהצעות בלבד. כרגע: מורה בלבד.
import { newId, currentGroupId, DEFAULT_CATEGORIES } from './logic.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const MAX_TEXT = 2000;

export { DEFAULT_CATEGORIES };

// ---------- קטגוריות (משותפות לכל המחזורים, כמו בנק המשימות) ----------
function checkCategory({ name, color }) {
  if (!String(name || '').trim()) throw new Error('חסר שם לקטגוריה');
  if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) throw new Error('צבע לא תקין');
}
export function addCategory(state, { name, color }) {
  checkCategory({ name, color });
  const n = name.trim();
  if (state.commentCategories.some((c) => !c.archived && c.name === n)) throw new Error('כבר קיימת קטגוריה בשם הזה');
  const s = clone(state);
  s.commentCategories.push({ id: newId('cat'), name: n, color, archived: false });
  return s;
}
export function updateCategory(state, id, { name, color }) {
  checkCategory({ name, color });
  const s = clone(state);
  const c = s.commentCategories.find((x) => x.id === id);
  if (!c) throw new Error('הקטגוריה לא נמצאה');
  if (s.commentCategories.some((x) => x.id !== id && !x.archived && x.name === name.trim())) throw new Error('כבר קיימת קטגוריה בשם הזה');
  c.name = name.trim();
  c.color = color;
  return s;
}
// "מחיקה" של קטגוריה היא הסתרה: אינה זמינה להערות חדשות, והערות קיימות ממשיכות להציג אותה.
export function setCategoryArchived(state, id, archived) {
  const s = clone(state);
  const c = s.commentCategories.find((x) => x.id === id);
  if (!c) throw new Error('הקטגוריה לא נמצאה');
  if (archived && s.commentCategories.filter((x) => !x.archived && x.id !== id).length === 0) throw new Error('חייבת להישאר לפחות קטגוריה אחת');
  c.archived = !!archived;
  return s;
}
// פלטת צבעים לקטגוריות: גוונים ברורים שקל להבחין ביניהם. הערה מודגשת במסמך בצבע הקטגוריה.
export const CATEGORY_PALETTE = ['#ffd54f', '#81d4fa', '#a5d6a7', '#f48fb1', '#ffb74d', '#ce93d8', '#80cbc4', '#ef9a9a', '#dce775', '#90caf9', '#bcaaa4', '#b0bec5'];
// הצבע הראשון בפלטה שאינו בשימוש בקטגוריה פעילה (לקטגוריה חדשה)
export function nextFreeColor(state) {
  const used = new Set(state.commentCategories.filter((c) => !c.archived).map((c) => c.color.toLowerCase()));
  return CATEGORY_PALETTE.find((c) => !used.has(c)) || CATEGORY_PALETTE[state.commentCategories.length % CATEGORY_PALETTE.length];
}
export const activeCategories = (state) => state.commentCategories.filter((c) => !c.archived);
export const categoryOf = (state, id) => state.commentCategories.find((c) => c.id === id) || { id, name: 'קטגוריה שנמחקה', color: '#cccccc', archived: true };

// ---------- הערות ----------
const teacherOnly = (session) => { if (!session || session.role !== 'teacher') throw new Error('רק המורה יוצר ועורך הערות'); };
const sub = (state, id) => {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new Error('ההגשה לא נמצאה');
  return x;
};

// מי רשאי להיות הנמען של הערה אישית: חבר נוכחי בקבוצה של ההגשה (במטלה קבוצתית). במטלה אישית אין הערה אישית נפרדת.
function checkAudience(state, s, studentId) {
  if (!studentId) return null;
  if (s.unitType !== 'group') throw new Error('במטלה אישית ההערה היא ממילא של התלמיד');
  if (currentGroupId(state, studentId) !== s.unitId) throw new Error('התלמיד אינו חבר בקבוצה הזו');
  return studentId;
}

function checkFields(state, { scope, anchor, categoryId, text }) {
  if (!['local', 'general'].includes(scope)) throw new Error('סוג הערה לא תקין');
  const t = String(text || '').trim();
  if (!t) throw new Error('חסר טקסט להערה');
  if (t.length > MAX_TEXT) throw new Error(`ההערה ארוכה מדי (עד ${MAX_TEXT} תווים)`);
  if (scope === 'local' && !(anchor && anchor.quote && anchor.page >= 1)) throw new Error('הערה מקומית חייבת לכלול קטע מסומן');
  const cat = state.commentCategories.find((c) => c.id === categoryId);
  if (!cat) throw new Error('קטגוריה לא תקינה');
  return t;
}

// מזהה שנבחר בלקוח (id): מאפשר להציג הערה מיד ולשמור אותה ברקע, ושליחה חוזרת של אותה הערה אינה יוצרת כפילות (קיים מזהה כזה: אין שינוי).
export const CLIENT_ID = /^cmt_[a-z0-9]{8,40}$/;
export function addComment(state, session, { id = null, submissionId, scope, anchor = null, categoryId, text, studentId = null }) {
  teacherOnly(session);
  if (id !== null && !CLIENT_ID.test(String(id))) throw new Error('מזהה הערה לא תקין');
  if (id !== null) {
    const dup = state.comments.find((x) => x.id === id);
    if (dup) { if (dup.submissionId !== submissionId) throw new Error('מזהה הערה תפוס'); return state; }
  }
  const s0 = sub(state, submissionId);
  const t = checkFields(state, { scope, anchor, categoryId, text });
  if (state.commentCategories.find((c) => c.id === categoryId).archived) throw new Error('הקטגוריה הוסתרה ואינה זמינה להערות חדשות');
  const audience = checkAudience(state, s0, studentId);
  const s = clone(state);
  const at = nowIso();
  s.comments.push({
    id: id !== null ? id : newId('cmt'), submissionId, taskId: s0.taskId, unitType: s0.unitType, unitId: s0.unitId, studentId: audience,
    scope, anchor: scope === 'local' ? clone(anchor) : null, categoryId, text: t,
    source: 'teacher', aiState: null, status: 'draft', publishedAt: null, retracted: false, pubHistory: [], createdAt: at, updatedAt: at,
  });
  return s;
}

const cmt = (state, id) => {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw new Error('ההערה לא נמצאה');
  return c;
};

// עריכה: טיוטות בלבד בשלב זה. הערה שפורסמה תיערך רק בתהליך פרסום מחדש (חלק הבא).
export function updateComment(state, session, id, patch) {
  teacherOnly(session);
  const cur = cmt(state, id);
  if (cur.status !== 'draft') throw new Error('אי אפשר לערוך הערה שפורסמה');
  const next = { scope: cur.scope, anchor: cur.anchor, categoryId: cur.categoryId, text: cur.text, studentId: cur.studentId, ...patch };
  const t = checkFields(state, next);
  const s0 = sub(state, cur.submissionId);
  const audience = checkAudience(state, s0, next.studentId || null);
  if (next.categoryId !== cur.categoryId && state.commentCategories.find((c) => c.id === next.categoryId).archived) throw new Error('הקטגוריה הוסתרה ואינה זמינה להערות חדשות');
  const s = clone(state);
  const c = cmt(s, id);
  Object.assign(c, { scope: next.scope, anchor: next.scope === 'local' ? clone(next.anchor) : null, categoryId: next.categoryId, text: t, studentId: audience, updatedAt: nowIso() });
  return s;
}

export function deleteComment(state, session, id) {
  teacherOnly(session);
  const cur = cmt(state, id);
  if (cur.status !== 'draft') throw new Error('אי אפשר למחוק הערה שפורסמה. אפשר לבטל את פרסומה');
  if ((cur.pubHistory || []).length) throw new Error('הערה שפורסמה בעבר נשמרת עם ההיסטוריה שלה ואי אפשר למחוק אותה. אפשר לערוך אותה ולפרסם מחדש');
  const s = clone(state);
  s.comments = s.comments.filter((x) => x.id !== id);
  return s;
}

export const commentsOf = (state, submissionId) => state.comments.filter((c) => c.submissionId === submissionId);

// ---------- נראות לתלמיד ----------
// הערה גלויה לתלמיד רק אם פורסמה, והיא שייכת ליחידה שלו: הערה לכל הקבוצה (חברי הקבוצה הנוכחיים), או אישית אליו.
// בעבודה אישית: רק התלמיד עצמו. טיוטות, הצעות והערות טיפול אינן גלויות לעולם.
export function visibleToStudent(state, studentId, c) {
  if (c.status !== 'published' || c.source !== 'teacher') return false;
  const st = state.students.find((x) => x.id === studentId);
  if (!st || !st.active) return false;
  if (c.unitType === 'student') return c.unitId === studentId;
  if (currentGroupId(state, studentId) !== c.unitId) return false;
  return !c.studentId || c.studentId === studentId;
}
export const visibleCommentsForStudent = (state, studentId) => state.comments.filter((c) => visibleToStudent(state, studentId, c));

// ---------- מסמכי דמה ----------
// בדמו אין קבצים אמיתיים. לכל הגשה מוצמד PDF סינתטי (נוצר לבדיקות, ללא מידע אמיתי).
export const DEMO_DOCS = ['doc1-v1', 'doc2-table', 'doc3-long', 'doc4-scan'];
export function demoDocFor(submission) {
  if (submission.demoFile) return submission.demoFile;
  let h = 0;
  for (const ch of submission.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DEMO_DOCS[h % DEMO_DOCS.length];
}
// אפשר לפתוח לבדיקה רק PDF שהומר בהצלחה (או צורף על ידי התלמיד).
export const reviewable = (submission) => submission.conversion.status === 'done';

