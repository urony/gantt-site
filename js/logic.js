// לוגיקה טהורה של המערכת (בלי דפדפן ובלי Google): תלמידים, קבוצות, שיוך והרשאות.
// כל הפונקציות מחזירות מצב חדש ואינן משנות את הקיים. נבדקות ב-app/tests.

import { buildDefaultLibrary } from './rubric-defaults.js';

export const GROUP_COLORS = ['#2f6fed', '#e0662b', '#2a9d6a', '#9b4dca', '#d6336c', '#0b8f9c', '#b58105', '#5c6bc0', '#c2410c', '#4d7c0f'];
export const GROUP_SYMBOLS = ['🧬', '🫀', '🧠', '🦴', '🩺', '💊', '🔬', '🫁', '🩸', '🧪'];

let counter = 0;
export function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const clone = (s) => structuredClone(s);
const today = () => new Date().toISOString().slice(0, 10);

// קטגוריות הערות ברירת מחדל (המורה רשאי לשנות, להוסיף ולהסתיר)
export const DEFAULT_CATEGORIES = [
  { id: 'cat_science', name: 'תוכן מדעי', color: '#ffd54f', archived: false },
  { id: 'cat_structure', name: 'מבנה', color: '#81d4fa', archived: false },
  { id: 'cat_wording', name: 'ניסוח', color: '#a5d6a7', archived: false },
  { id: 'cat_advice', name: 'המלצות', color: '#f48fb1', archived: false },
];

// מנקה רשומות משוב שהגשתן או הערתן נמחקו (בדיקה פנימית, סימוני תוקן ותגובות)
export function pruneFeedback(s) {
  const subs = new Set((s.submissions || []).map((x) => x.id));
  s.comments = (s.comments || []).filter((c) => subs.has(c.submissionId));
  const cms = new Set(s.comments.map((c) => c.id));
  s.reviews = (s.reviews || []).filter((r) => subs.has(r.submissionId));
  s.marks = (s.marks || []).filter((m) => cms.has(m.commentId));
  s.threads = (s.threads || []).filter((t) => cms.has(t.commentId));
  s.corrections = (s.corrections || []).filter((c) => subs.has(c.returnedSubmissionId));
  s.aiRounds = (s.aiRounds || []).filter((r) => subs.has(r.submissionId));
  s.aiProposals = (s.aiProposals || []).filter((p) => subs.has(p.submissionId));
  s.aiQuarantine = (s.aiQuarantine || []).filter((q) => subs.has(q.submissionId));
  s.scoreSheets = (s.scoreSheets || []).filter((x) => subs.has(x.submissionId));
  const tasks = new Set((s.tasks || []).map((t) => t.id));
  s.taskRubrics = (s.taskRubrics || []).filter((r) => tasks.has(r.taskId));
  const studs = new Set((s.students || []).map((x) => x.id));
  s.grades = (s.grades || []).filter((g) => tasks.has(g.taskId) && studs.has(g.studentId));
  s.exclusions = (s.exclusions || []).filter((e) => tasks.has(e.taskId) && (e.studentId === null || studs.has(e.studentId)));
  s.personalWeights = (s.personalWeights || []).filter((p) => studs.has(p.studentId));
  s.extraGrades = (s.extraGrades || []).filter((g) => studs.has(g.studentId));
  s.taskReminders = (s.taskReminders || []).filter((r) => tasks.has(r.taskId));
  s.gradePubs = (s.gradePubs || []).filter((p) => studs.has(p.studentId) && (p.taskId === null || tasks.has(p.taskId)));
  return s;
}

export function emptyState() {
  return { version: 2, cycle: null, students: [], groups: [], memberships: [], tasks: [], taskTemplate: [], vacations: [], adminEvents: [], exceptions: [], progress: [], submissions: [], comments: [], reviews: [], marks: [], threads: [], corrections: [], aiEnabled: false, aiRounds: [], aiProposals: [], aiQuarantine: [], taskRubrics: [], scoreSheets: [], rubricLibrary: buildDefaultLibrary(), gradeTemplates: [], gradeScheme: [], grades: [], exclusions: [], personalWeights: [], extraGrades: [], gradePubs: [], commentCategories: structuredClone(DEFAULT_CATEGORIES) };
}

export function validateCycle(c) {
  const errors = [];
  if (!c || !String(c.name || '').trim()) errors.push('חסר שם מחזור');
  if (c && c.start && c.end && c.start > c.end) errors.push('תאריך הסיום קודם להתחלה');
  if (c && c.defenseDate && c.start && c.defenseDate < c.start) errors.push('מועד ההגנה קודם להתחלת המחזור');
  return errors;
}

const s0school = (state) => (state && state.cycle && state.cycle.school) || '';
export function createCycle(state, data) {
  const errors = validateCycle(data);
  if (errors.length) throw new Error(errors.join('. '));
  const s = clone(state);
  s.cycle = { id: s.cycle ? s.cycle.id : newId('cyc'), name: data.name.trim(), start: data.start || '', end: data.end || '', defenseDate: data.defenseDate || '' };
  if (s0school(state)) s.cycle.school = s0school(state); // סוג בית הספר הוא הגדרת מחזור ואינו נמחק בשמירת פרטי המחזור
  return s;
}

export function addStudent(state, { name, email }) {
  const n = String(name || '').trim();
  const e = String(email || '').trim().toLowerCase();
  if (!n) throw new Error('חסר שם תלמיד');
  if (e && state.students.some((x) => x.email === e)) throw new Error('כבר קיים תלמיד עם אותו דוא"ל');
  const s = clone(state);
  const st = { id: newId('stu'), name: n, email: e, active: true, createdAt: today() };
  s.students.push(st);
  return s;
}

export function updateStudent(state, id, { name, email }) {
  const s = clone(state);
  const st = s.students.find((x) => x.id === id);
  if (!st) throw new Error('תלמיד לא נמצא');
  const n = String(name ?? st.name).trim();
  const e = String(email ?? st.email).trim().toLowerCase();
  if (!n) throw new Error('חסר שם תלמיד');
  if (e && s.students.some((x) => x.id !== id && x.email === e)) throw new Error('כבר קיים תלמיד עם אותו דוא"ל');
  st.name = n;
  st.email = e;
  return s;
}

export function setStudentActive(state, id, active) {
  const s = clone(state);
  const st = s.students.find((x) => x.id === id);
  if (!st) throw new Error('תלמיד לא נמצא');
  st.active = !!active;
  return s;
}

export function addGroup(state, { name, color, symbol }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('חסר שם קבוצה');
  if (state.groups.some((g) => g.name === n)) throw new Error('כבר קיימת קבוצה בשם הזה');
  const s = clone(state);
  const i = s.groups.length;
  s.groups.push({ id: newId('grp'), name: n, color: color || GROUP_COLORS[i % GROUP_COLORS.length], symbol: symbol || GROUP_SYMBOLS[i % GROUP_SYMBOLS.length] });
  return s;
}

export function updateGroup(state, id, { name, color, symbol }) {
  const s = clone(state);
  const g = s.groups.find((x) => x.id === id);
  if (!g) throw new Error('קבוצה לא נמצאה');
  const n = String(name ?? g.name).trim();
  if (!n) throw new Error('חסר שם קבוצה');
  if (s.groups.some((x) => x.id !== id && x.name === n)) throw new Error('כבר קיימת קבוצה בשם הזה');
  g.name = n;
  if (color) g.color = color;
  if (symbol) g.symbol = symbol;
  return s;
}

export function currentMembership(state, studentId) {
  return state.memberships.find((m) => m.studentId === studentId && m.to === null) || null;
}

export function currentGroupId(state, studentId) {
  const m = currentMembership(state, studentId);
  return m ? m.groupId : null;
}

export function membersOf(state, groupId) {
  const ids = state.memberships.filter((m) => m.groupId === groupId && m.to === null).map((m) => m.studentId);
  return state.students.filter((st) => ids.includes(st.id));
}

export function deleteGroup(state, id) {
  if (membersOf(state, id).length) throw new Error('אי אפשר למחוק קבוצה שיש בה תלמידים. העבר אותם קודם');
  const s = clone(state);
  s.groups = s.groups.filter((g) => g.id !== id);
  s.exceptions = (s.exceptions || []).filter((e) => !(e.unitType === 'group' && e.unitId === id));
  s.progress = (s.progress || []).filter((p) => !(p.unitType === 'group' && p.unitId === id));
  s.submissions = (s.submissions || []).filter((x) => !(x.unitType === 'group' && x.unitId === id));
  s.comments = (s.comments || []).filter((x) => !(x.unitType === 'group' && x.unitId === id));
  pruneFeedback(s);
  s.tasks.forEach((t) => { t.assignees = (t.assignees || []).filter((a) => a !== id); });
  return s;
}

// שיוך תלמיד לקבוצה (או ללא קבוצה, groupId=null). ההיסטוריה נשמרת ואינה נמחקת.
// פעולה חוזרת על אותו שיוך אינה יוצרת רשומה כפולה.
export function assignStudent(state, studentId, groupId, date = today()) {
  if (!state.students.some((x) => x.id === studentId)) throw new Error('תלמיד לא נמצא');
  if (groupId !== null && !state.groups.some((g) => g.id === groupId)) throw new Error('קבוצה לא נמצאה');
  const cur = currentMembership(state, studentId);
  if ((cur ? cur.groupId : null) === groupId) return state;
  const s = clone(state);
  const open = s.memberships.find((m) => m.studentId === studentId && m.to === null);
  if (open) open.to = date;
  if (groupId !== null) s.memberships.push({ studentId, groupId, from: date, to: null });
  return s;
}

export function historyOf(state, studentId) {
  return state.memberships
    .filter((m) => m.studentId === studentId)
    .map((m) => ({ ...m, groupName: (state.groups.find((g) => g.id === m.groupId) || { name: '(קבוצה שנמחקה)' }).name }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export function stats(state) {
  const active = state.students.filter((s) => s.active);
  const unassigned = active.filter((s) => !currentGroupId(state, s.id));
  return {
    students: state.students.length,
    active: active.length,
    inactive: state.students.length - active.length,
    groups: state.groups.length,
    unassigned: unassigned.length,
    emptyGroups: state.groups.filter((g) => membersOf(state, g.id).length === 0).length,
  };
}

// הרשאות. המורה רואה הכול. תלמיד רואה רק את עצמו, ורק כל עוד הוא פעיל.
// בגרסה האמיתית אותה בדיקה מתבצעת בשרת, ולא די בכך שהמשתמש מחובר ל-Google.
export function canViewStudent(state, session, studentId) {
  if (!session) return false;
  if (session.role === 'teacher') return true;
  if (session.role !== 'student') return false;
  const me = state.students.find((s) => s.id === session.userId);
  return !!me && me.active && session.userId === studentId;
}

export function canViewGroupMembers(state, session, groupId) {
  if (!session) return false;
  if (session.role === 'teacher') return true;
  if (session.role !== 'student') return false;
  const me = state.students.find((s) => s.id === session.userId);
  return !!me && me.active && currentGroupId(state, me.id) === groupId;
}

export function canEdit(session) {
  return !!session && session.role === 'teacher';
}

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
