// מחזורים מרובים. המצב הכולל (root) מכיל רשימת מחזורים ובנק משימות משותף.
// כל מחזור מחזיק נתונים נפרדים: תלמידים, קבוצות, שיוכים, משימות, חופשות, ארכות והתקדמות.
// כל שאר הלוגיקה (logic.js, tasks.js) עובדת על "פרוסה" שטוחה של מחזור אחד, ולכן אינה משתנה.
import { newId, DEFAULT_CATEGORIES } from './logic.js';
import { buildDefaultLibrary } from './rubric-defaults.js';
import { defaultSettings, normalizeSettings } from './notifications.js';
import { emptyBook } from './notes.js';
import { defaultAdminEvents } from './admin-events.js';

export const DATA_KEYS = ['students', 'groups', 'memberships', 'tasks', 'vacations', 'exceptions', 'progress', 'submissions', 'comments', 'reviews', 'marks', 'threads', 'corrections', 'aiRounds', 'aiProposals', 'aiQuarantine', 'taskRubrics', 'scoreSheets', 'gradeScheme', 'grades', 'exclusions', 'personalWeights', 'extraGrades', 'gradePubs', 'notifs', 'sendLog', 'taskReminders', 'adminEvents'];
const clone = (x) => structuredClone(x);

const emptyData = () => Object.fromEntries(DATA_KEYS.map((k) => [k, []]));

export function emptyRoot() {
  return { version: 3, activeCycleId: null, cycles: [], taskTemplate: [], aiEnabled: false, rubricLibrary: buildDefaultLibrary(), gradeTemplates: [], notifSettings: defaultSettings(), notesBook: emptyBook(), autoBackups: [], trashCycles: [], heldSubmissions: [], decisionLog: [], lastRestore: null, commentCategories: structuredClone(DEFAULT_CATEGORIES) };
}

// מצב ישן (מחזור אחד, גרסה 2) הופך למחזור יחיד בתוך מבנה חדש.
export function migrate(raw) {
  if (raw && raw.version === 3) return raw;
  const root = emptyRoot();
  root.taskTemplate = clone((raw && raw.taskTemplate) || []);
  root.commentCategories = clone((raw && raw.commentCategories) || DEFAULT_CATEGORIES);
  root.rubricLibrary = clone((raw && raw.rubricLibrary) || buildDefaultLibrary());
  const c = (raw && raw.cycle) || { name: 'מחזור', start: '', end: '', defenseDate: '' };
  const data = emptyData();
  for (const k of DATA_KEYS) data[k] = clone((raw && raw[k]) || []);
  const id = c.id || newId('cyc');
  root.cycles.push({ id, name: c.name, start: c.start || '', end: c.end || '', defenseDate: c.defenseDate || '', archived: false, data });
  root.activeCycleId = id;
  return root;
}

export function getCycle(root, id) {
  const c = root.cycles.find((x) => x.id === id);
  if (!c) throw new Error('המחזור לא נמצא');
  return c;
}

// פרוסה שטוחה של מחזור אחד, בצורה שהלוגיקה הקיימת מכירה.
export function sliceOf(root, id) {
  const c = getCycle(root, id);
  return {
    version: 2,
    cycle: { id: c.id, name: c.name, start: c.start, end: c.end, defenseDate: c.defenseDate, school: c.school || '' },
    ...clone(emptyData()),
    ...clone(c.data),
    aiEnabled: !!root.aiEnabled,
    rubricLibrary: clone(root.rubricLibrary || buildDefaultLibrary()),
    gradeTemplates: clone(root.gradeTemplates || []),
    notifSettings: normalizeSettings(root.notifSettings),
    taskTemplate: clone(root.taskTemplate),
    commentCategories: clone(root.commentCategories || DEFAULT_CATEGORIES),
  };
}

// כותב פרוסה חזרה למחזור. רק נתוני המחזור הנבחר משתנים. אם bankOnly, רק הבנק המשותף.
export function writeSlice(root, id, flat, { bankOnly = false } = {}) {
  const r = clone(root);
  r.taskTemplate = clone(flat.taskTemplate);
  r.commentCategories = clone(flat.commentCategories || r.commentCategories || DEFAULT_CATEGORIES);
  r.aiEnabled = !!flat.aiEnabled;
  r.rubricLibrary = clone(flat.rubricLibrary || r.rubricLibrary || buildDefaultLibrary());
  r.gradeTemplates = clone(flat.gradeTemplates || r.gradeTemplates || []);
  r.notifSettings = normalizeSettings(flat.notifSettings || r.notifSettings);
  if (bankOnly) return r;
  const c = getCycle(r, id);
  if (flat.cycle) Object.assign(c, { name: flat.cycle.name, start: flat.cycle.start, end: flat.cycle.end, defenseDate: flat.cycle.defenseDate }, flat.cycle.school ? { school: flat.cycle.school } : {});
  for (const k of DATA_KEYS) c.data[k] = clone(flat[k]);
  return r;
}

// מחזור בארכיון הוא לקריאה בלבד: כל כתיבה לנתוניו נדחית.
export function applyToCycle(root, id, fn, opts = {}) {
  const c = getCycle(root, id);
  if (c.restoring && !opts.bankOnly) throw new Error('המחזור בשחזור כרגע ולכן אי אפשר לשנות בו דבר. נסו שוב בעוד רגע.');
  if (c.archived && !opts.bankOnly && !opts.allowArchived) throw new Error('המחזור בארכיון ולכן לקריאה בלבד. אפשר להחזיר אותו לפעיל.');
  return writeSlice(root, id, fn(sliceOf(root, id)), opts);
}

export function addCycle(root, { name, start = '', end = '', defenseDate = '' }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('חסר שם למחזור');
  if (root.cycles.some((c) => c.name === n)) throw new Error('כבר קיים מחזור בשם הזה');
  if (start && end && start > end) throw new Error('תאריך הסיום קודם להתחלה');
  const r = clone(root);
  const id = newId('cyc');
  const data = emptyData();
  data.adminEvents = defaultAdminEvents({ start, end, defenseDate }); // תזכורות מנהלתיות ראשוניות (למורה בלבד, ניתנות לעריכה)
  r.cycles.push({ id, name: n, start, end, defenseDate, archived: false, data });
  r.activeCycleId = id;
  return r;
}

export function setActiveCycle(root, id) {
  getCycle(root, id);
  return { ...root, activeCycleId: id };
}

export function setArchived(root, id, archived) {
  const r = clone(root);
  getCycle(r, id).archived = !!archived;
  return r;
}

// רשימת מחזורים לתצוגה (ללא נתונים פנימיים).
export const cycleList = (root) => root.cycles.map((c) => ({ id: c.id, name: c.name, archived: c.archived }));

// לתלמיד יש גישה למחזור רק אם הוא קיים, התלמיד פעיל בו, והמחזור אינו בארכיון (או שהמורה פתח גישת קריאה לארכיון).
export function studentCanAccess(root, session) {
  if (!session || session.role !== 'student') return false;
  const c = root.cycles.find((x) => x.id === (session.cycleId || root.activeCycleId));
  return !!(c && (!c.archived || c.studentAccessOpen) && c.data.students.some((s) => s.id === session.userId && s.active));
}

// מחזורים שבהם התלמיד (לפי דוא"ל) פעיל, והמחזור אינו בארכיון או שנפתחה בו גישת קריאה, מהחדש לישן.
export function cyclesOfStudentEmail(root, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  return root.cycles.filter((c) => !c.archived || c.studentAccessOpen)
    .map((c) => ({ cycleId: c.id, name: c.name, student: c.data.students.find((s) => s.active && s.email.toLowerCase() === e) }))
    .filter((x) => x.student)
    .reverse();
}
