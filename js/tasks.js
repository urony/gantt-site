// לוגיקה טהורה של תכנון: משימות, תלויות, חופשות, חריגות (ארכות), תבנית משימות, התקדמות והשלמה.
// כל הפונקציות מחזירות מצב חדש ואינן משנות את הקיים. נבדקות ב-app/tests.
import { newId, currentGroupId, DEFAULT_CATEGORIES, pruneFeedback } from './logic.js';

const DAY = 864e5;
export const D = {
  parse: (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); },
  fmt: (t) => new Date(t).toISOString().slice(0, 10),
  add: (s, n) => D.fmt(D.parse(s) + n * DAY),
  diff: (a, b) => Math.round((D.parse(a) - D.parse(b)) / DAY),
  today: () => new Date().toISOString().slice(0, 10),
  valid: (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(D.parse(s)),
};

const clone = (s) => structuredClone(s);

// ---------- קישורים (חומרי עזר והנחיות) ----------
// רק http/https. כתובת בלי פרוטוקול מקבלת https. כותרת ריקה מוחלפת בשם האתר.
export function normalizeLinks(links) {
  if (links == null) return [];
  if (!Array.isArray(links)) throw new Error('רשימת הקישורים אינה תקינה');
  return links.map((l) => {
    let url = String((l && l.url) || '').trim();
    const title = String((l && l.title) || '').trim();
    if (!url && !title) return null;
    if (!url) throw new Error(`חסרה כתובת לקישור "${title}"`);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    // ללא new URL: אינו קיים ב-Apps Script. אותה בדיקה בביטוי רגולרי (פרוטוקול http/https, מארח תקין, בלי פרטי משתמש)
    const pm = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    if (!pm || !['http', 'https'].includes(pm[1].toLowerCase())) throw new Error('מותרים רק קישורים שמתחילים ב-http או https');
    const um = /^(https?):\/\/([^\s\/?#@:]+)(:\d+)?([\/?#][^\s]*)?$/i.exec(url);
    if (!um) throw new Error(`כתובת הקישור אינה תקינה: ${url}`);
    const hostname = um[2].toLowerCase();
    return { id: (l && l.id) || newId('lnk'), title: title || hostname, url: `${um[1].toLowerCase()}://${hostname}${um[3] || ''}${um[4] || '/'}` };
  }).filter(Boolean);
}

export function ensureV2(state) {
  const s = clone(state);
  s.version = 2;
  s.tasks ??= [];
  s.taskTemplate ??= [];
  s.vacations ??= [];
  s.adminEvents ??= [];
  s.exceptions ??= [];
  s.progress ??= [];
  s.submissions ??= [];
  s.comments ??= [];
  s.reviews ??= [];
  s.marks ??= [];
  s.threads ??= [];
  s.corrections ??= [];
  s.commentCategories ??= structuredClone(DEFAULT_CATEGORIES);
  // משימות ישנות בלי קישור לבנק: קישור לפי שם רק כשהשם ייחודי בבנק
  for (const t of s.tasks) {
    if (t.sourceId === undefined) {
      const m = s.taskTemplate.filter((x) => x.title === t.title);
      t.sourceId = m.length === 1 ? m[0].id : null;
    }
  }
  return s;
}

function task(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new Error('משימה לא נמצאה');
  return t;
}

// ---------- משימות פעילות ולא פעילות ----------
// משימה לא פעילה נשמרת במחזור עם כל פרטיה (מועדים, קישורים, תלויות, ארכות והתקדמות), אך אינה חלק מהתוכנית הפעילה.
// זה מצב שונה מ"הושלמה".
export const isActive = (t) => t.active !== false;

// ---------- תלויות ----------
export function hasCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn || []]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of deps.get(id) || []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return [...deps.keys()].some(visit);
}

export function dependents(state, id) {
  const out = new Set();
  const walk = (x) => state.tasks.filter((t) => isActive(t) && (t.dependsOn || []).includes(x)).forEach((t) => { if (!out.has(t.id)) { out.add(t.id); walk(t.id); } });
  walk(id);
  return [...out];
}

// תלות מסוג "סיום-להתחלה": המשימה התלויה חייבת להתחיל אחרי שהקודמת הסתיימה.
export function dependencyViolations(state, allTasks = state.tasks) {
  const tasks = allTasks.filter(isActive); // משימה לא פעילה אינה חלק מהתוכנית ואינה יוצרת אזהרות
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  for (const t of tasks) {
    for (const p of t.dependsOn || []) {
      const pt = byId.get(p);
      if (pt && t.start <= pt.due) out.push({ taskId: t.id, predecessorId: p });
    }
  }
  return out;
}

// ---------- חופשות ואילוצים ----------
export function addVacation(state, { title, start, end }) {
  const t = String(title || '').trim();
  if (!t) throw new Error('חסר שם לחופשה');
  if (!D.valid(start) || !D.valid(end)) throw new Error('תאריך לא תקין');
  if (start > end) throw new Error('תאריך הסיום קודם להתחלה');
  const s = clone(state);
  s.vacations.push({ id: newId('vac'), title: t, start, end });
  return s;
}

export function deleteVacation(state, id) {
  const s = clone(state);
  s.vacations = s.vacations.filter((v) => v.id !== id);
  return s;
}

export function vacationOverlaps(state, { start, due }) {
  return state.vacations.filter((v) => v.start <= due && v.end >= start);
}

// ---------- משימות ----------
function validateTask(state, d, selfId) {
  if (!String(d.title || '').trim()) throw new Error('חסר שם משימה');
  if (!['group', 'personal'].includes(d.kind)) throw new Error('סוג משימה לא תקין');
  if (!D.valid(d.start) || !D.valid(d.due)) throw new Error('תאריך לא תקין');
  if (d.start > d.due) throw new Error('מועד ההגשה קודם להתחלה');
  const w = Number(d.weight ?? 0);
  if (!(w >= 0 && w <= 100)) throw new Error('משקל חייב להיות בין 0 ל-100');
  for (const p of d.dependsOn || []) {
    if (p === selfId) throw new Error('משימה אינה יכולה להיות תלויה בעצמה');
    if (!state.tasks.some((t) => t.id === p)) throw new Error('תלות במשימה שאינה קיימת');
  }
}

export function addTask(state, d) {
  const data = { description: '', weight: 0, dependsOn: [], assignees: [], links: [], ...d };
  validateTask(state, data);
  const links = normalizeLinks(data.links);
  const s = clone(state);
  const order = s.tasks.reduce((m, t) => Math.max(m, t.order), 0) + 1;
  s.tasks.push({ id: newId('tsk'), title: data.title.trim(), description: data.description, kind: data.kind, start: data.start, due: data.due, weight: Number(data.weight), order, dependsOn: [...data.dependsOn], assignees: [...data.assignees], links, sourceId: data.sourceId ?? null, requiresSubmission: !!data.requiresSubmission });
  if (hasCycle(s.tasks)) throw new Error('התלות יוצרת מעגל');
  return s;
}

export function updateTask(state, id, d) {
  const cur = task(state, id);
  const data = { ...cur, ...d };
  validateTask(state, data, id);
  const links = normalizeLinks(data.links);
  const s = clone(state);
  const t = s.tasks.find((x) => x.id === id);
  Object.assign(t, { links, requiresSubmission: data.requiresSubmission === undefined ? !!t.requiresSubmission : !!data.requiresSubmission, title: data.title.trim(), description: data.description ?? '', kind: data.kind, start: data.start, due: data.due, weight: Number(data.weight), dependsOn: [...(data.dependsOn || [])], assignees: [...(data.assignees || [])] });
  if (hasCycle(s.tasks)) throw new Error('התלות יוצרת מעגל');
  return s;
}

export function deleteTask(state, id) {
  task(state, id);
  const s = clone(state);
  s.tasks = s.tasks.filter((t) => t.id !== id);
  s.tasks.forEach((t) => { t.dependsOn = (t.dependsOn || []).filter((p) => p !== id); });
  s.exceptions = s.exceptions.filter((e) => e.taskId !== id);
  s.progress = s.progress.filter((p) => p.taskId !== id);
  s.submissions = (s.submissions || []).filter((x) => x.taskId !== id);
  s.comments = (s.comments || []).filter((x) => x.taskId !== id);
  pruneFeedback(s);
  return s;
}

export function moveTask(state, id, dir) {
  const sorted = orderedTasks(state);
  const i = sorted.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('משימה לא נמצאה');
  const j = i + (dir === 'up' ? -1 : 1);
  if (j < 0 || j >= sorted.length) return state;
  const s = clone(state);
  const a = s.tasks.find((t) => t.id === sorted[i].id);
  const b = s.tasks.find((t) => t.id === sorted[j].id);
  [a.order, b.order] = [b.order, a.order];
  return s;
}

const byOrder = (a, b) => a.order - b.order;
export const orderedTasks = (state) => state.tasks.filter(isActive).sort(byOrder);
export const inactiveTasks = (state) => state.tasks.filter((t) => !isActive(t)).sort(byOrder);

// משימות פעילות שתלויות ישירות במשימה (לאזהרה לפני הפיכתה ללא פעילה).
export const activeDirectDependents = (state, id) => state.tasks.filter((t) => isActive(t) && (t.dependsOn || []).includes(id));

export function setTaskActive(state, id, active) {
  task(state, id);
  const s = clone(state);
  s.tasks.find((t) => t.id === id).active = !!active;
  return s;
}

// מצב פריט בבנק ביחס למחזור: אין עותק, פעיל, או רק לא פעיל. הקישור הוא לפי מזהה המקור ולא לפי שם.
export function bankStatus(state, itemId) {
  const copies = state.tasks.filter((t) => t.sourceId === itemId);
  const active = copies.filter(isActive);
  const inactive = copies.filter((t) => !isActive(t));
  return { state: active.length ? 'active' : inactive.length ? 'inactive' : 'none', active, inactive };
}

// ---------- חריגות (ארכה נקודתית) ----------
export function setException(state, { taskId, unitType, unitId, start, due }) {
  const t = task(state, taskId);
  if (!['group', 'student'].includes(unitType)) throw new Error('סוג יחידה לא תקין');
  if (!D.valid(due)) throw new Error('תאריך לא תקין');
  const st = start || t.start;
  if (st > due) throw new Error('מועד ההגשה קודם להתחלה');
  const s = clone(state);
  const ex = s.exceptions.find((e) => e.taskId === taskId && e.unitType === unitType && e.unitId === unitId);
  if (ex) { ex.start = st; ex.due = due; } else s.exceptions.push({ id: newId('exc'), taskId, unitType, unitId, start: st, due });
  return s;
}

export function removeException(state, id) {
  const s = clone(state);
  s.exceptions = s.exceptions.filter((e) => e.id !== id);
  return s;
}

// תאריכים אפקטיביים ליחידה: חריגת תלמיד גוברת על חריגת קבוצה, וזו גוברת על תאריכי הכיתה.
export function effectiveDates(state, t, { studentId = null, groupId = null } = {}) {
  const gid = groupId ?? (studentId ? currentGroupId(state, studentId) : null);
  const find = (type, uid) => uid && state.exceptions.find((e) => e.taskId === t.id && e.unitType === type && e.unitId === uid);
  const ex = find('student', studentId) || find('group', gid);
  return ex ? { start: ex.start, due: ex.due, exception: ex } : { start: t.start, due: t.due, exception: null };
}

// ---------- שינוי מועד (כיתתי) והשלכות ----------
// מחזיר את ההשלכות של שינוי תאריכים לפני אישורו: תלויות שנשברות, חפיפה עם חופשות וחריגות שיושפעו.
export function impactOfChange(state, id, { start, due }) {
  const cur = task(state, id);
  const tentative = state.tasks.map((t) => (t.id === id ? { ...t, start, due } : t));
  const before = new Set(dependencyViolations(state).map((v) => `${v.predecessorId}>${v.taskId}`));
  const violations = dependencyViolations(state, tentative).filter((v) => !before.has(`${v.predecessorId}>${v.taskId}`)).map((v) => ({ ...v, title: tentative.find((t) => t.id === v.taskId).title, predecessorTitle: tentative.find((t) => t.id === v.predecessorId).title }));
  const vacations = vacationOverlaps(state, { start, due }).filter((v) => !vacationOverlaps(state, { start: cur.start, due: cur.due }).some((x) => x.id === v.id));
  const exceptions = state.exceptions.filter((e) => e.taskId === id);
  return { violations, vacations, exceptions, deltaStart: D.diff(start, cur.start), deltaDue: D.diff(due, cur.due) };
}

// שינוי תאריכי משימה לכל הכיתה: חל גם על חריגות, למעט אלה שהמורה בחר לשמר.
// moveDependents: הזזת משימות תלויות באותו מספר ימים (פעולה מפורשת של המורה בלבד).
export function setTaskDates(state, id, { start, due }, { keepExceptionIds = [], moveDependents = false } = {}) {
  const cur = task(state, id);
  if (!D.valid(start) || !D.valid(due)) throw new Error('תאריך לא תקין');
  if (start > due) throw new Error('מועד ההגשה קודם להתחלה');
  const dS = D.diff(start, cur.start);
  const dD = D.diff(due, cur.due);
  const s = clone(state);
  const shiftEx = (taskId, a, b) => s.exceptions.filter((e) => e.taskId === taskId && !keepExceptionIds.includes(e.id)).forEach((e) => { e.start = D.add(e.start, a); e.due = D.add(e.due, b); });
  const t = s.tasks.find((x) => x.id === id);
  t.start = start;
  t.due = due;
  shiftEx(id, dS, dD);
  if (moveDependents && dD !== 0) {
    for (const did of dependents(state, id)) {
      const dt = s.tasks.find((x) => x.id === did);
      dt.start = D.add(dt.start, dD);
      dt.due = D.add(dt.due, dD);
      shiftEx(did, dD, dD);
    }
  }
  return s;
}

// ---------- תבנית משימות (ניתנת לעריכה מלאה) ----------
function validateTemplateItem(state, d, selfId) {
  if (!String(d.title || '').trim()) throw new Error('חסר שם משימה');
  if (!['group', 'personal'].includes(d.kind)) throw new Error('סוג משימה לא תקין');
  if (!(Number.isInteger(Number(d.startOffset)) && Number(d.startOffset) >= 0)) throw new Error('היסט התחלה חייב להיות מספר שלם מ-0');
  if (!(Number.isInteger(Number(d.duration)) && Number(d.duration) >= 1)) throw new Error('משך חייב להיות לפחות יום אחד');
  const w = Number(d.weight ?? 0);
  if (!(w >= 0 && w <= 100)) throw new Error('משקל חייב להיות בין 0 ל-100');
  for (const p of d.dependsOn || []) {
    if (p === selfId) throw new Error('משימה אינה יכולה להיות תלויה בעצמה');
    if (!state.taskTemplate.some((t) => t.id === p)) throw new Error('תלות בפריט שאינו קיים');
  }
}

export function addTemplateItem(state, d) {
  const data = { description: '', weight: 0, dependsOn: [], links: [], ...d };
  validateTemplateItem(state, data);
  const links = normalizeLinks(data.links);
  const s = clone(state);
  const order = s.taskTemplate.reduce((m, t) => Math.max(m, t.order), 0) + 1;
  s.taskTemplate.push({ id: newId('tpl'), title: data.title.trim(), description: data.description, kind: data.kind, startOffset: Number(data.startOffset), duration: Number(data.duration), weight: Number(data.weight), order, dependsOn: [...data.dependsOn], links, requiresSubmission: !!data.requiresSubmission });
  if (hasCycle(s.taskTemplate)) throw new Error('התלות יוצרת מעגל');
  return s;
}

export function updateTemplateItem(state, id, d) {
  const cur = state.taskTemplate.find((t) => t.id === id);
  if (!cur) throw new Error('פריט תבנית לא נמצא');
  const data = { ...cur, ...d };
  validateTemplateItem(state, data, id);
  const links = normalizeLinks(data.links);
  const s = clone(state);
  const t = s.taskTemplate.find((x) => x.id === id);
  Object.assign(t, { links, requiresSubmission: data.requiresSubmission === undefined ? !!t.requiresSubmission : !!data.requiresSubmission, title: data.title.trim(), description: data.description ?? '', kind: data.kind, startOffset: Number(data.startOffset), duration: Number(data.duration), weight: Number(data.weight), dependsOn: [...(data.dependsOn || [])] });
  if (hasCycle(s.taskTemplate)) throw new Error('התלות יוצרת מעגל');
  return s;
}

export function deleteTemplateItem(state, id) {
  if (!state.taskTemplate.some((t) => t.id === id)) throw new Error('פריט תבנית לא נמצא');
  const s = clone(state);
  s.taskTemplate = s.taskTemplate.filter((t) => t.id !== id);
  s.taskTemplate.forEach((t) => { t.dependsOn = (t.dependsOn || []).filter((p) => p !== id); });
  return s;
}

export function moveTemplateItem(state, id, dir) {
  const sorted = [...state.taskTemplate].sort((a, b) => a.order - b.order);
  const i = sorted.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('פריט תבנית לא נמצא');
  const j = i + (dir === 'up' ? -1 : 1);
  if (j < 0 || j >= sorted.length) return state;
  const s = clone(state);
  const a = s.taskTemplate.find((t) => t.id === sorted[i].id);
  const b = s.taskTemplate.find((t) => t.id === sorted[j].id);
  [a.order, b.order] = [b.order, a.order];
  return s;
}

export const orderedTemplate = (state) => [...state.taskTemplate].sort((a, b) => a.order - b.order);

// יצירת משימות מהתבנית לפי תאריך התחלת המחזור. mode: 'append' מוסיף, 'replace' מחליף את כל המשימות הקיימות.
export function applyTemplate(state, { mode = 'append' } = {}) {
  if (!state.cycle || !D.valid(state.cycle.start)) throw new Error('הגדר קודם תאריך התחלת מחזור');
  const s = clone(state);
  if (mode === 'replace') { s.tasks = []; s.exceptions = []; s.progress = []; }
  const idMap = new Map();
  let order = s.tasks.reduce((m, t) => Math.max(m, t.order), 0);
  for (const it of orderedTemplate(s)) {
    const start = D.add(s.cycle.start, it.startOffset);
    const t = { id: newId('tsk'), title: it.title, description: it.description || '', kind: it.kind, start, due: D.add(start, it.duration - 1), weight: it.weight, order: ++order, dependsOn: [], assignees: [], links: structuredClone(it.links || []), sourceId: it.id, requiresSubmission: !!it.requiresSubmission };
    idMap.set(it.id, t.id);
    s.tasks.push(t);
  }
  for (const it of s.taskTemplate) {
    const t = s.tasks.find((x) => x.id === idMap.get(it.id));
    t.dependsOn = (it.dependsOn || []).map((p) => idMap.get(p)).filter(Boolean);
  }
  return s;
}

// הוספת משימה בודדת מהבנק (התבנית) למחזור, בלי לגעת במשימות הקיימות.
// העותק עצמאי: בלי תלויות, ועריכה בבנק או בעותק אינה משפיעה על השני.
export function addTaskFromBank(state, templateId, { start } = {}) {
  const it = state.taskTemplate.find((x) => x.id === templateId);
  if (!it) throw new Error('הפריט לא נמצא בבנק');
  const base = state.cycle && D.valid(state.cycle.start) ? D.add(state.cycle.start, it.startOffset) : D.today();
  const st = start || base;
  if (!D.valid(st)) throw new Error('תאריך לא תקין');
  return addTask(state, { title: it.title, description: it.description || '', kind: it.kind, start: st, due: D.add(st, it.duration - 1), weight: it.weight, dependsOn: [], assignees: [], links: structuredClone(it.links || []), sourceId: it.id, requiresSubmission: !!it.requiresSubmission });
}

// ---------- אזהרות והסברים ----------
// שלושה סוגים נפרדים: תכנון (תלות שבורה), התנגשות עם חופשה, ובקשה הממתינה לאישור המורה.
export const WARNING_KINDS = {
  plan: { icon: '⛔', label: 'אזהרת תכנון: תלות שבורה', help: 'משימה מתחילה לפני שמשימה שהיא תלויה בה הסתיימה. הפעולה הנדרשת: להזיז את אחת המשימות, או לערוך את התלויות.' },
  vacation: { icon: '🏖️', label: 'התנגשות עם חופשה', help: 'המשימה חופפת לחופשה או לאילוץ שהוגדרו. המערכת אינה מזיזה דבר לבד. הפעולה הנדרשת: להחליט אם להזיז את המשימה או להשאיר כמו שהיא.' },
  pending: { icon: '⏳', label: 'בקשה הממתינה לאישור', help: 'תלמיד או קבוצה ביקשו לסמן את המשימה כהושלמה. ההשלמה נחשבת רק אחרי אישור שלך. הפעולה הנדרשת: לאשר, או להחזיר לתיקון.' },
};

export function taskWarnings(state, t, eff = { start: t.start, due: t.due }) {
  const out = [];
  for (const v of dependencyViolations(state).filter((x) => x.taskId === t.id)) {
    const pred = state.tasks.find((x) => x.id === v.predecessorId);
    out.push({ type: 'plan', ...WARNING_KINDS.plan, text: `מתחילה לפני שהסתיימה "${pred ? pred.title : ''}".` });
  }
  const vac = vacationOverlaps(state, { start: eff.start, due: eff.due });
  if (vac.length) out.push({ type: 'vacation', ...WARNING_KINDS.vacation, text: `חופפת ל: ${vac.map((v) => v.title).join(', ')}.` });
  const pend = completionSummary(state, t).claimed;
  if (pend) out.push({ type: 'pending', ...WARNING_KINDS.pending, text: `${pend} בקשות ממתינות.` });
  return out;
}

// ---------- יחידות, נראות, התקדמות והשלמה ----------
export function unitsOfTask(state, t) {
  if (t.kind === 'group') {
    return state.groups.filter((g) => !t.assignees.length || t.assignees.includes(g.id)).map((g) => ({ type: 'group', id: g.id, name: g.name }));
  }
  return state.students.filter((x) => x.active && (!t.assignees.length || t.assignees.includes(x.id))).map((x) => ({ type: 'student', id: x.id, name: x.name }));
}

// משימות שתלמיד רשאי לראות: קבוצתיות של הקבוצה שלו, ואישיות שלו בלבד. משימה אישית של תלמיד אחר אינה נראית.
export function tasksForStudent(state, studentId) {
  const st = state.students.find((x) => x.id === studentId);
  if (!st || !st.active) return [];
  const gid = currentGroupId(state, studentId);
  return orderedTasks(state).filter((t) => (t.kind === 'group' ? !!gid && (!t.assignees.length || t.assignees.includes(gid)) : !t.assignees.length || t.assignees.includes(studentId)));
}

export function unitForStudent(state, t, studentId) {
  return t.kind === 'group' ? { type: 'group', id: currentGroupId(state, studentId) } : { type: 'student', id: studentId };
}

export function getProgress(state, taskId, unitType, unitId) {
  return state.progress.find((p) => p.taskId === taskId && p.unitType === unitType && p.unitId === unitId) || { taskId, unitType, unitId, percent: 0, completion: 'none' };
}

function upsertProgress(s, taskId, unitType, unitId, patch) {
  let p = s.progress.find((x) => x.taskId === taskId && x.unitType === unitType && x.unitId === unitId);
  if (!p) { p = { taskId, unitType, unitId, percent: 0, completion: 'none' }; s.progress.push(p); }
  Object.assign(p, patch);
}

function authorizeUnit(state, session, t, unitType, unitId) {
  if (!session) throw new Error('נדרשת כניסה');
  if (session.role === 'teacher') return;
  if (session.role !== 'student') throw new Error('אין הרשאה');
  const visible = tasksForStudent(state, session.userId).some((x) => x.id === t.id);
  const mine = unitForStudent(state, t, session.userId);
  if (!visible || mine.type !== unitType || mine.id !== unitId) throw new Error('אין הרשאה לעדכן יחידה זו');
}

// דיווח התקדמות באחוזים. תלמיד מדווח על היחידה שלו בלבד. דיווח אינו משנה את סטטוס ההשלמה.
export function setProgress(state, session, taskId, unitType, unitId, percent) {
  const t = task(state, taskId);
  authorizeUnit(state, session, t, unitType, unitId);
  const p = typeof percent === 'string' && percent.trim() !== '' ? Number(percent) : percent;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100) throw new Error('אחוז ההתקדמות חייב להיות מספר שלם בין 0 ל-100');
  const cur = getProgress(state, taskId, unitType, unitId);
  if (session.role === 'student' && cur.completion === 'approved') throw new Error('ההשלמה כבר אושרה על ידי המורה');
  const s = clone(state);
  upsertProgress(s, taskId, unitType, unitId, { percent: p, updatedAt: D.today(), updatedBy: session.role });
  return s;
}

// תלמיד מבקש לסמן השלמה (או מבטל בקשה). ההשלמה אינה נחשבת עד אישור המורה.
export function claimCompletion(state, session, taskId, unitType, unitId, claimed = true) {
  const t = task(state, taskId);
  if (!session || session.role !== 'student') throw new Error('רק תלמיד מבקש סימון השלמה');
  authorizeUnit(state, session, t, unitType, unitId);
  const cur = getProgress(state, taskId, unitType, unitId);
  if (cur.completion === 'approved') throw new Error('ההשלמה כבר אושרה על ידי המורה');
  const s = clone(state);
  upsertProgress(s, taskId, unitType, unitId, { completion: claimed ? 'claimed' : 'none', updatedAt: D.today() });
  return s;
}

// אישור או החזרה של השלמה: המורה בלבד.
export function reviewCompletion(state, session, taskId, unitType, unitId, decision) {
  if (!session || session.role !== 'teacher') throw new Error('רק המורה מאשר השלמה');
  task(state, taskId);
  if (!['approve', 'reject', 'reopen'].includes(decision)) throw new Error('החלטה לא תקינה');
  const s = clone(state);
  upsertProgress(s, taskId, unitType, unitId, { completion: decision === 'approve' ? 'approved' : 'none', updatedAt: D.today() });
  return s;
}

export function completionSummary(state, t) {
  const units = unitsOfTask(state, t);
  const rows = units.map((u) => ({ ...u, ...getProgress(state, t.id, u.type, u.id) }));
  return { units: rows, approved: rows.filter((r) => r.completion === 'approved').length, claimed: rows.filter((r) => r.completion === 'claimed').length, total: rows.length, avgPercent: rows.length ? Math.round(rows.reduce((a, r) => a + r.percent, 0) / rows.length) : 0 };
}

// ---------- לוח שנה ----------
export function tasksOnDay(state, day, view = {}) {
  const list = view.tasks || orderedTasks(state);
  return list.filter((t) => { const e = view.effective ? view.effective(t) : { start: t.start, due: t.due }; return e.start <= day && day <= e.due; });
}
export const vacationsOnDay = (state, day) => state.vacations.filter((v) => v.start <= day && day <= v.end);
