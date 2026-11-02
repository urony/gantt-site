// נתוני דמה בלבד: שמות מומצאים ודוא"ל בדומיין שאינו קיים. אין כאן מידע אמיתי.
import { emptyState, createCycle, addStudent, addGroup, assignStudent, membersOf, setStudentActive, GROUP_COLORS, GROUP_SYMBOLS } from './logic.js';
import * as T from './tasks.js';
import * as C from './cycles.js';
import { defaultAdminEvents } from './admin-events.js';
import * as S from './submissions.js';
import * as R from './review.js';
import * as F from './feedback.js';
import * as X from './corrections.js';

const FIRST = ['נועה', 'יובל', 'מאיה', 'איתי', 'שירה', 'עידו', 'תמר', 'אורי', 'ליאור', 'דנה', 'רועי', 'נטע', 'גיל', 'הילה', 'אמיר', 'רוני', 'עומר', 'מיכל', 'אביב', 'יעל', 'ניר', 'שקד', 'אלון', 'רז', 'טל', 'ענבר', 'דור', 'גפן', 'ים', 'סתיו'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'דהן', 'אזולאי', 'שמעון'];
const GROUP_NAMES = ['לב וכלי דם', 'מערכת העצבים', 'מערכת הנשימה', 'מערכת השלד', 'מערכת העיכול', 'המערכת החיסונית', 'מערכת האנדוקרינית', 'מערכת השתן', 'עור ותחושה', 'גנטיקה'];

// תבנית משימות לדוגמה (המורה יכול לערוך הכול: הוספה, מחיקה, מועדים וסדר). היסט וימים נספרים מתחילת המחזור.
export const TEMPLATE = [
  { key: 'topic', title: 'בחירת נושא וקבוצה', kind: 'group', startOffset: 0, duration: 21, weight: 0 },
  { key: 'proposal', sub: true, title: 'הצעת מחקר', kind: 'group', startOffset: 22, duration: 28, weight: 5, dep: 'topic', links: [{ title: 'דף הנחיות להצעת מחקר (דמה)', url: 'https://example.com/guidelines' }, { title: 'דוגמה להצעה טובה (דמה)', url: 'https://example.com/sample.pdf' }] },
  { key: 'log', title: 'יומן עבודה אישי', kind: 'personal', startOffset: 22, duration: 240, weight: 5 },
  { key: 'summary', sub: true, title: 'סיכום אישי קצר', kind: 'personal', startOffset: 40, duration: 24, weight: 0 },
  { key: 'review', title: 'סקירת ספרות', kind: 'group', startOffset: 51, duration: 42, weight: 10, dep: 'proposal' },
  { key: 'method', title: 'תכנון שיטת העבודה', kind: 'group', startOffset: 94, duration: 28, weight: 5, dep: 'review' },
  { key: 'data', title: 'איסוף נתונים', kind: 'group', startOffset: 123, duration: 56, weight: 10, dep: 'method' },
  { key: 'results', title: 'ניתוח ותוצאות', kind: 'group', startOffset: 180, duration: 35, weight: 10, dep: 'data' },
  { key: 'draft', sub: true, title: 'טיוטה ראשונה', kind: 'group', startOffset: 216, duration: 35, weight: 15, dep: 'results' },
  { key: 'fix', title: 'תיקונים לפי משוב', kind: 'group', startOffset: 252, duration: 21, weight: 5, dep: 'draft' },
  { key: 'reflect', sub: true, title: 'רפלקציה אישית', kind: 'personal', startOffset: 252, duration: 21, weight: 5, dep: 'draft' },
  { key: 'final', sub: true, title: 'הגשה סופית', kind: 'group', startOffset: 274, duration: 14, weight: 10, dep: 'fix' },
  { key: 'defense', title: 'הגנה בעל פה', kind: 'personal', startOffset: 289, duration: 14, weight: 20, dep: 'final' },
];

export function buildDemoState() {
  let s = emptyState();
  s = createCycle(s, { name: 'מחזור דמה תשפ"ז', start: '2026-09-01', end: '2027-06-30', defenseDate: '2027-06-15' });
  GROUP_NAMES.forEach((name, i) => { s = addGroup(s, { name, color: GROUP_COLORS[i], symbol: GROUP_SYMBOLS[i] }); });
  FIRST.forEach((f, i) => {
    s = addStudent(s, { name: `${f} ${LAST[i % LAST.length]}`, email: `student${String(i + 1).padStart(2, '0')}@example.invalid` });
  });
  // שלושה תלמידים בכל קבוצה, למעט תלמיד אחד ללא קבוצה ותלמיד אחד לא פעיל.
  s.students.forEach((st, i) => {
    if (i === 29) return; // ללא קבוצה
    s = assignStudent(s, st.id, s.groups[Math.floor(i / 3) % s.groups.length].id, '2026-09-01');
  });
  s = setStudentActive(s, s.students[27].id, false);

  // תבנית משימות ומשימות מהתבנית
  const ids = {};
  for (const it of TEMPLATE) {
    s = T.addTemplateItem(s, { title: it.title, kind: it.kind, startOffset: it.startOffset, duration: it.duration, weight: it.weight, dependsOn: it.dep ? [ids[it.dep]] : [], links: it.links || [], requiresSubmission: !!it.sub });
    ids[it.key] = s.taskTemplate[s.taskTemplate.length - 1].id;
  }
  s = T.applyTemplate(s, { mode: 'replace' });

  // חופשות דמה (תאריכים משוערים, להמחשה בלבד)
  s = T.addVacation(s, { title: 'חגי תשרי (דמה)', start: '2026-09-11', end: '2026-10-04' });
  s = T.addVacation(s, { title: 'חנוכה (דמה)', start: '2026-12-04', end: '2026-12-11' });
  s = T.addVacation(s, { title: 'חופשת פסח (דמה)', start: '2027-04-14', end: '2027-04-30' });

  // ארכה נקודתית לקבוצה אחת, והתקדמות לדוגמה
  const byTitle = (t) => s.tasks.find((x) => x.title === t);
  const proposal = byTitle('הצעת מחקר');
  s = T.setException(s, { taskId: proposal.id, unitType: 'group', unitId: s.groups[2].id, start: proposal.start, due: T.D.add(proposal.due, 7) });
  const teacher = { role: 'teacher', userId: 'teacher' };
  s.groups.slice(0, 6).forEach((g, i) => {
    s = T.setProgress(s, teacher, proposal.id, 'group', g.id, i === 0 ? 100 : 60 + i * 5);
  });
  const topic = byTitle('בחירת נושא וקבוצה');
  s.groups.forEach((g, i) => {
    s = T.setProgress(s, teacher, topic.id, 'group', g.id, 100);
    if (i < 8) s = T.reviewCompletion(s, teacher, topic.id, 'group', g.id, 'approve');
  });
  const stu = { role: 'student', userId: s.students[0].id };
  s = T.claimCompletion(s, stu, proposal.id, 'group', s.groups[0].id, true);

  // הגשות לדוגמה להצעת מחקר: בזמן, באיחור עם כשל המרה, ועם ארכה ושתי גרסאות. בקבוצות, מי שהעלה בפועל נשמר.
  const member = (g, i) => ({ role: 'student', userId: membersOf(s, g.id)[i].id });
  const sub = (g, i, fileName, size, at) => S.submitFile(s, member(g, i), { taskId: proposal.id, unitType: 'group', unitId: g.id, fileName, size, now: at });
  const conv = (g, version, ok) => { const x = S.versionsOf(s, proposal.id, 'group', g.id)[version - 1]; return S.completeConversion(s, x.id, { ok, now: x.uploadedAt }); };
  const [g0, g1, g2] = s.groups;
  const demo = (g, version, doc) => { const x = S.versionsOf(s, proposal.id, 'group', g.id)[version - 1]; s.submissions.find((y) => y.id === x.id).demoFile = doc; };
  s = sub(g0, 1, 'הצעת מחקר לב וכלי דם.docx', 412000, '2026-10-15T10:00:00'); s = conv(g0, 1, true); demo(g0, 1, 'doc1-v1');
  s = sub(g1, 2, 'הצעה - מערכת העצבים.docx', 380000, '2026-10-23T09:30:00'); s = conv(g1, 1, false); demo(g1, 1, 'doc2-table');
  s = sub(g2, 0, 'הצעה נשימה גרסה ראשונה.docx', 350000, '2026-10-24T18:00:00'); s = conv(g2, 1, true); demo(g2, 1, 'doc3-long');
  // קבוצה 3: הגרסה הראשונה הוחזרה לתיקון עם משוב כתוב, והקבוצה הגישה גרסה מתוקנת ("התיקון הוגש", בלי בקשה לבדיקה נוספת)
  const tch0 = { role: 'teacher', userId: 'teacher' };
  const sg2 = S.latestOf(s, proposal.id, 'group', g2.id);
  s = R.addComment(s, tch0, { submissionId: sg2.id, scope: 'general', categoryId: 'cat_structure', text: 'חסרה חלוקה ברורה לסעיפים. נא להוסיף כותרות לפי המבנה שנלמד.' });
  s = X.returnForCorrection(s, tch0, sg2.id, { text: 'נא לתקן את מבנה ההצעה ולהוסיף מקורות לכל טענה מדעית, ואז להגיש גרסה מתוקנת.', dueDate: '2026-11-08', now: '2026-10-25T10:00:00' });
  s = sub(g2, 2, 'הצעה נשימה גרסה מתוקנת.pdf', 365000, '2026-10-26T20:15:00'); s = conv(g2, 2, true); demo(g2, 2, 'doc1-v2');

  // קבוצה 5 ("מערכת העיכול"): הוחזרה לתיקון וממתינה לגרסה מתוקנת
  const g4 = s.groups[4];
  s = sub(g4, 0, 'סקירה מערכת העיכול.docx', 300000, '2026-10-18T09:00:00'); s = conv(g4, 1, true);
  const sg4 = S.latestOf(s, proposal.id, 'group', g4.id);
  s.submissions.find((y) => y.id === sg4.id).demoFile = 'doc2-table';
  s = R.addComment(s, tch0, { submissionId: sg4.id, scope: 'general', categoryId: 'cat_science', text: 'הטבלה אינה מבוארת ואין מקורות. יש להשלים לפני ההמשך.' });
  s = X.returnForCorrection(s, tch0, sg4.id, { text: 'נא להוסיף הסבר לטבלה ולצטט את המקורות, ולהגיש גרסה מתוקנת.', dueDate: '2026-11-12', now: '2026-10-27T11:00:00' });

  // משוב לדוגמה לקבוצה הראשונה: הערות שפורסמו (כלליות, מקומית ואישית), טיוטה שטרם פורסמה, שאלת הבהרה פתוחה ותגובה.
  const tch = { role: 'teacher', userId: 'teacher' };
  const sg0 = S.latestOf(s, proposal.id, 'group', g0.id);
  const [m0, m1, m2] = [0, 1, 2].map((i) => membersOf(s, g0.id)[i]);
  const quote = 'סוכרת מסוג 1 היא מחלה אוטואימונית';
  const add = (d) => { s = R.addComment(s, tch, { submissionId: sg0.id, ...d }); return s.comments.at(-1); };
  add({ scope: 'general', categoryId: 'cat_advice', text: 'הצעה מסודרת ובהירה. כדאי להוסיף מקורות עדכניים לפני הסקירה.' });
  const local = add({ scope: 'local', anchor: { page: 1, start: 59, end: 59 + quote.length, quote, prefix: '', suffix: '' }, categoryId: 'cat_science', text: 'חסר מקור לטענה הזו. אפשר לצטט מאמר סקירה.' });
  add({ scope: 'general', categoryId: 'cat_structure', studentId: m0.id, text: 'נועה, נא להרחיב את סעיף הרקע בחלק שאת כותבת.' });
  s = F.publishFeedback(s, tch, sg0.id, { now: '2026-10-27T09:00:00' });
  s = F.setChecked(s, tch, sg0.id, true, { note: 'לבדוק שוב את סעיף השיטות בגרסה הבאה', now: '2026-10-27T08:50:00' });
  add({ scope: 'general', categoryId: 'cat_wording', text: 'לבדוק ניסוח בסעיף המטרות. (הערה שנוספה אחרי השליחה הראשונה ועדיין לא נשלחה לתלמידים.)' });
  s = F.addThread(s, { role: 'student', userId: m1.id }, local.id, { kind: 'question', text: 'איזה סוג מקורות מתאים כאן? מאמר סקירה או מחקר מקורי?', now: '2026-10-27T18:30:00' });
  s = F.addThread(s, { role: 'student', userId: m2.id }, local.id, { kind: 'reply', text: 'אני אחפש מאמר סקירה ואעלה לקבוצה.', now: '2026-10-27T19:10:00' });
  s = F.setFixed(s, { role: 'student', userId: m2.id }, local.id, false, { now: '2026-10-27T19:11:00' });
  return s;
}

// מצב כולל לדמו: מחזור א׳ המלא, ומחזור ב׳ קטן ונפרד (עם תלמידה אחת שמופיעה בשני המחזורים, מקרה נדיר).
// בנק המשימות משותף לשני המחזורים.
// מספר גרסת נתוני הדמו. כשהוא עולה, דפדפן עם נתוני דמה ישנים נטען מחדש אוטומטית (נתוני דמה בלבד).
export const DEMO_SEED = 8;

export function buildDemoRoot() {
  let root = C.migrate(buildDemoState());
  root.cycles[0].data.adminEvents = defaultAdminEvents(root.cycles[0]); // מחזור א׳ נוצר ממצב ישן: מוסיפים לו את התזכורות המנהלתיות להדגמה
  const aId = root.activeCycleId;
  root = C.addCycle(root, { name: 'מחזור דמה תשפ"ח', start: '2027-09-01', end: '2028-06-30', defenseDate: '2028-06-15' });
  const bId = root.activeCycleId;
  root = C.applyToCycle(root, bId, (s) => {
    s = addGroup(s, { name: 'רפואת ספורט', color: GROUP_COLORS[0], symbol: GROUP_SYMBOLS[0] });
    s = addGroup(s, { name: 'תזונה', color: GROUP_COLORS[1], symbol: GROUP_SYMBOLS[1] });
    const names = ['גל אשכנזי', 'מור חביב', 'ערן סעדה', 'ליה בן דוד', 'תום רגב'];
    names.forEach((n, i) => { s = addStudent(s, { name: n, email: `cycleb${i + 1}@example.invalid` }); });
    s = addStudent(s, { name: 'שירה פרידמן', email: 'student05@example.invalid' }); // אותה תלמידה כמו במחזור א׳
    s.students.forEach((st, i) => { s = assignStudent(s, st.id, s.groups[i % 2].id, '2027-09-01'); });
    s = T.applyTemplate(s, { mode: 'replace' });
    // להדגמה: משימה אחת במחזור ב׳ מוצאת מהתוכנית (לא פעילה), ושמורה לשימוש עתידי
    return T.setTaskActive(s, s.tasks.find((t) => t.title === 'רפלקציה אישית').id, false);
  });
  // פריט בבנק שלא נוסף לאף מחזור (מצב "לא נוספה למחזור")
  root = C.applyToCycle(root, bId, (s) => T.addTemplateItem(s, { title: 'מצגת סיכום (דמה)', kind: 'group', startOffset: 270, duration: 7, weight: 0 }), { bankOnly: true });
  return { ...C.setActiveCycle(root, aId), demoSeed: DEMO_SEED };
}
