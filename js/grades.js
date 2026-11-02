// ציונים פנימיים וציון כולל. לוגיקה טהורה (נבדקת ב-app/tests). אין כאן פרסום: כל הציונים פנימיים עד חלק ג.
// החלטות המורה:
//  * ציון תקף אחד לכל תלמיד ולכל משימה (0 עד 100, ללא עיגול). ציון חדש אינו מוחק קודם: ההיסטוריה נשמרת (history) עם מועד, מקור והערה.
//  * ציון קבוצתי ניתן לחברי הקבוצה לפי החברות במועד ההגשה (לא במועד מתן הציון). תלמיד שעבר קבוצה שומר את ציוניו, ותלמיד שהצטרף אחרי
//    ההגשה אינו מקבל ציון אוטומטי (המורה יכול לקבוע לו ציון ידני). ציון אישי ידני בתוך קבוצה אינו נדרס אלא במפורש.
//  * ערכת הציונים לכל מחזור: רכיב "העבודה" (ממוצע משוקלל של המשימות לפי משקלן) ורכיבים נוספים אישיים (תלמידאות, בחנים וכו') עם פריטים.
//    התבנית האישית שומרת מבנה ומשקלים בלבד, ושימוש בה יוצר עותק עצמאי.
//  * ציון כולל מחושב רק כשכל הסכומים 100% וכל מרכיב בעל משקל קיבל ציון. אין נרמול או חלוקה מחדש אוטומטית של משקלים.
//    החרגת משימה (לתלמיד אחד או לכל המחזור) היא החלטה מפורשת עם נימוק, הפיכה, ואינה מוחקת ציון. אחריה המורה מתאים משקלים בעצמו
//    (משקלים אישיים לתלמיד, או משקלי משימות למחזור).
//  * עיגול פעם אחת בסוף: 89.49 ל-89 ו-89.50 ל-90.
import { newId, currentGroupId } from './logic.js';
import { isActive } from './tasks.js';
import * as K from './rubrics.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const TOL = 1e-6;
export const MAX_NOTE = 500;
export const MAX_REASON = 500;

const teacherOnly = (session, what = 'הפעולה') => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };
const task = (state, id) => {
  const t = (state.tasks || []).find((x) => x.id === id);
  if (!t) throw new Error('המשימה לא נמצאה');
  return t;
};
const student = (state, id) => {
  const x = (state.students || []).find((y) => y.id === id);
  if (!x) throw new Error('התלמיד לא נמצא');
  return x;
};
const num = (v, what = 'הערך') => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new Error(`${what} חייב להיות מספר`);
  return n;
};
const needReason = (r) => {
  const t = String(r || '').trim();
  if (!t) throw new Error('נדרש נימוק');
  return t.slice(0, MAX_REASON);
};

// עיגול חצי כלפי מעלה, פעם אחת בלבד (ה-epsilon מונע שגיאת נקודה צפה כמו 89.49999999999999)
export const roundHalfUp = (x) => Math.floor(x + 0.5 + 1e-9);

// ---------- ערכת ציונים (למחזור) ----------
export const defaultScheme = () => ({ components: [{ id: 'cmp_work', kind: 'work', name: 'העבודה', weight: 100, items: [] }], updatedAt: null, fromTemplate: null });
export const schemeOf = (state) => ((state.gradeScheme || [])[0]) || defaultScheme();

function cleanScheme(components) {
  if (!Array.isArray(components) || !components.length) throw new Error('חייב להיות לפחות רכיב אחד');
  if (components.filter((c) => c.kind === 'work').length !== 1) throw new Error('חייב להיות בדיוק רכיב "העבודה" אחד');
  const used = new Set();
  const uid = (id, p) => { const v = id && !used.has(id) ? id : newId(p); used.add(v); return v; };
  return components.map((c) => {
    const name = String(c.name || '').trim();
    if (!name) throw new Error('לרכיב חסר שם');
    const weight = num(c.weight, `משקל הרכיב "${name}"`);
    if (weight < 0 || weight > 100) throw new Error(`משקל הרכיב "${name}" חייב להיות בין 0 ל-100`);
    const kind = c.kind === 'work' ? 'work' : 'extra';
    const items = kind === 'work' ? [] : (c.items || []).map((it) => {
      const n = String(it.name || '').trim();
      if (!n) throw new Error(`לפריט ברכיב "${name}" חסר שם`);
      const w = num(it.weight, `משקל הפריט "${n}"`);
      if (w <= 0 || w > 100) throw new Error(`משקל הפריט "${n}" חייב להיות בין 0 ל-100`);
      return { id: uid(it.id, 'itm'), name: n, weight: w };
    });
    if (kind === 'extra' && !items.length) throw new Error(`לרכיב "${name}" חייב להיות לפחות פריט אחד`);
    return { id: kind === 'work' ? (c.id || 'cmp_work') : uid(c.id, 'cmp'), kind, name, weight, items };
  });
}

// בעיות מבנה של ערכה (סכומים). אינן חוסמות שמירה, אך חוסמות חישוב ציון כולל.
export function schemeProblems(scheme) {
  const out = [];
  const total = scheme.components.reduce((n, c) => n + c.weight, 0);
  if (Math.abs(total - 100) > TOL) out.push({ code: 'components-sum', text: `סכום משקלי הרכיבים הוא ${total}% ולא 100%.` });
  for (const c of scheme.components) {
    if (c.kind === 'extra') {
      const s = c.items.reduce((n, i) => n + i.weight, 0);
      if (Math.abs(s - 100) > TOL) out.push({ code: 'items-sum', componentId: c.id, text: `סכום משקלי הפריטים ברכיב "${c.name}" הוא ${s}% ולא 100%.` });
    }
  }
  return out;
}

export function setScheme(state, session, { components }, { now = nowIso() } = {}) {
  teacherOnly(session, 'עריכת ערכת הציונים');
  const comps = cleanScheme(components);
  const keep = new Set(comps.flatMap((c) => c.items.map((i) => i.id)));
  const lost = (state.extraGrades || []).filter((g) => g.value !== null && !keep.has(g.itemId));
  if (lost.length) throw new Error('אי אפשר להסיר פריט שכבר הוזנו לו ציונים. אפשר לשנות את שמו ואת משקלו');
  const s = clone(state);
  s.gradeScheme = [{ components: comps, updatedAt: now, fromTemplate: (state.gradeScheme && state.gradeScheme[0] && state.gradeScheme[0].fromTemplate) || null }];
  s.extraGrades = (s.extraGrades || []).filter((g) => keep.has(g.itemId));
  return s;
}

// ---------- תבניות אישיות (משותפות לכל המחזורים, מבנה ומשקלים בלבד) ----------
export const templatesOf = (state) => state.gradeTemplates || [];
export function saveTemplate(state, session, name, { now = nowIso() } = {}) {
  teacherOnly(session, 'שמירת תבנית');
  const n = String(name || '').trim();
  if (!n) throw new Error('חסר שם לתבנית');
  if (n.length > 100) throw new Error('שם התבנית ארוך מדי');
  if (templatesOf(state).some((t) => t.name === n)) throw new Error('כבר קיימת תבנית בשם הזה');
  const sc = schemeOf(state);
  const s = clone(state);
  s.gradeTemplates = s.gradeTemplates || [];
  s.gradeTemplates.push({ id: newId('gtp'), name: n, createdAt: now, components: sc.components.map((c) => ({ kind: c.kind, name: c.name, weight: c.weight, items: c.items.map((i) => ({ name: i.name, weight: i.weight })) })) });
  return s;
}
export function deleteTemplate(state, session, id) {
  teacherOnly(session, 'מחיקת תבנית');
  if (!templatesOf(state).some((t) => t.id === id)) throw new Error('התבנית לא נמצאה');
  const s = clone(state);
  s.gradeTemplates = s.gradeTemplates.filter((t) => t.id !== id);
  return s;
}
// שימוש בתבנית: עותק עצמאי למחזור. נחסם אם כבר הוזנו ציוני רכיבים נוספים (כדי לא ליצור יתומים).
export function applyTemplate(state, session, id, { now = nowIso() } = {}) {
  teacherOnly(session, 'שימוש בתבנית');
  const t = templatesOf(state).find((x) => x.id === id);
  if (!t) throw new Error('התבנית לא נמצאה');
  if ((state.extraGrades || []).some((g) => g.value !== null)) throw new Error('במחזור כבר הוזנו ציונים לרכיבים נוספים, ולכן אי אפשר להחליף את הערכה בתבנית');
  const comps = cleanScheme(t.components.map((c) => ({ ...c, id: undefined, items: c.items.map((i) => ({ ...i, id: undefined })) })));
  const s = clone(state);
  s.gradeScheme = [{ components: comps, updatedAt: now, fromTemplate: { id: t.id, name: t.name } }];
  s.extraGrades = [];
  return s;
}

// ---------- חברות במועד ההגשה ----------
export function membersAtDate(state, groupId, date) {
  const d = String(date).slice(0, 10);
  const ids = state.memberships.filter((m) => m.groupId === groupId && m.from <= d && (m.to === null || d < m.to)).map((m) => m.studentId);
  return state.students.filter((st) => ids.includes(st.id));
}

// ---------- ציונים של משימות ----------
export const gradeOf = (state, taskId, studentId) => (state.grades || []).find((g) => g.taskId === taskId && g.studentId === studentId) || null;
export const gradeHistory = (g) => (g ? [...g.history] : []);

function putGrade(s, { taskId, studentId, value, source, sheetId = null, submissionId = null, note = '', individual = false, now }) {
  let g = (s.grades = s.grades || []).find((x) => x.taskId === taskId && x.studentId === studentId);
  if (!g) { g = { id: newId('grd'), taskId, studentId, value: null, history: [] }; s.grades.push(g); }
  Object.assign(g, { value, source, sheetId, submissionId, note, individual, setAt: now });
  g.history.push({ value, source, sheetId, submissionId, note, individual, at: now });
}

// מי זכאי לציון מהניקוד של הגשה: יחיד, או חברי הקבוצה במועד ההגשה. מציג גם מי נשמר כציון אישי ידני (ידלג אלא אם מחליטים אחרת).
export function applyPreview(state, submissionId) {
  const sb = (state.submissions || []).find((x) => x.id === submissionId);
  if (!sb) throw new Error('ההגשה לא נמצאה');
  const sheet = K.sheetOf(state, submissionId);
  const sc = sheet ? K.scoreOf(sheet) : null;
  const members = sb.unitType === 'group' ? membersAtDate(state, sb.unitId, sb.uploadedAt) : state.students.filter((x) => x.id === sb.unitId);
  return {
    ready: !!(sc && sc.kind === 'points' && sc.complete), percent: sc && sc.complete ? sc.percent : null,
    students: members.map((m) => { const cur = gradeOf(state, sb.taskId, m.id); return { studentId: m.id, name: m.name, current: cur ? cur.value : null, individual: !!(cur && cur.individual), activeNow: m.active }; }),
  };
}

// השוואה בין הניקוד שבעבודה (ציון פוטנציאלי מהקריטריונים) לבין ציון המשימה שהמורה קבע בפועל, לכל זכאי.
// none: אין ציון תקף | same: הציון התקף שווה לניקוד | differs: הציון התקף שונה מהניקוד (נקבע קודם או ידנית) | individual: ציון אישי ידני (לא יידרס בלי אישור)
export function sheetGradeStatus(state, submissionId) {
  const pv = applyPreview(state, submissionId);
  const rows = pv.students.map((m) => {
    let st = 'none';
    if (m.current !== null && m.current !== undefined) st = m.individual ? 'individual' : (pv.ready && Math.abs(m.current - pv.percent) < 1e-9 ? 'same' : 'differs');
    return { ...m, status: st };
  });
  return { ready: pv.ready, percent: pv.percent, rows, needsSet: pv.ready && rows.some((r) => r.status === 'none' || r.status === 'differs'), hasIndividual: rows.some((r) => r.status === 'individual'), allSame: pv.ready && rows.length > 0 && rows.every((r) => r.status === 'same') };
}

// "קבע כציון המשימה": מפעיל ציון מניקוד שהושלם לזכאים. ציון אישי ידני אינו נדרס אלא עם overwriteIndividual.
export function setGradeFromSheet(state, session, submissionId, { overwriteIndividual = false, now = nowIso() } = {}) {
  teacherOnly(session, 'קביעת ציון');
  const pv = applyPreview(state, submissionId);
  if (!pv.ready) throw new Error('הניקוד טרם הושלם: כל הקריטריונים צריכים לקבל ניקוד');
  const sb = state.submissions.find((x) => x.id === submissionId);
  const sheet = K.sheetOf(state, submissionId);
  const s = clone(state);
  let n = 0;
  for (const m of pv.students) {
    if (m.individual && !overwriteIndividual) continue;
    putGrade(s, { taskId: sb.taskId, studentId: m.studentId, value: pv.percent, source: 'rubric', sheetId: sheet.id, submissionId, note: '', individual: false, now });
    n++;
  }
  if (!n) throw new Error('כל הזכאים מחזיקים בציון אישי ידני. כדי לדרוס אותו צריך אישור מפורש');
  return s;
}

// ציון ידני לתלמיד (כולל 0 לאי-הגשה, וציון אישי בתוך קבוצה). value=null מבטל את הציון התקף (ההיסטוריה נשמרת).
export function setStudentGrade(state, session, taskId, studentId, value, { note = '', now = nowIso() } = {}) {
  teacherOnly(session, 'קביעת ציון');
  const t = task(state, taskId);
  student(state, studentId);
  let v = null;
  if (value !== null && value !== '' && value !== undefined) {
    v = num(value, 'הציון');
    if (v < 0 || v > 100) throw new Error('הציון חייב להיות בין 0 ל-100');
    v = Math.round(v * 100) / 100;
  }
  const s = clone(state);
  putGrade(s, { taskId, studentId, value: v, source: 'manual', note: String(note || '').slice(0, MAX_NOTE), individual: t.kind === 'group', now });
  return s;
}

// ציון קבוצתי ידני (בלי מחוון): ציון אחד לכל חברי הקבוצה הרלוונטיים. הזכאות לפי החברות במועד ההגשה (הגרסה האחרונה של הקבוצה במשימה, או גרסה
// שצוינה). אם אין הגשה כלל, לפי חברי הקבוצה כעת. ציון אישי ידני שנקבע קודם אינו נדרס אלא באישור מפורש (overwriteIndividual).
export function unitGradePreview(state, taskId, groupId, { submissionId = null } = {}) {
  const t = task(state, taskId);
  if (t.kind !== 'group') throw new Error('זו משימה אישית');
  if (!state.groups.some((x) => x.id === groupId)) throw new Error('הקבוצה לא נמצאה');
  const subs = (state.submissions || []).filter((x) => x.taskId === taskId && x.unitType === 'group' && x.unitId === groupId).sort((x, y) => y.version - x.version);
  const sb = submissionId ? subs.find((x) => x.id === submissionId) : subs[0];
  if (submissionId && !sb) throw new Error('ההגשה לא נמצאה');
  const members = sb ? membersAtDate(state, groupId, sb.uploadedAt) : state.students.filter((st) => currentGroupId(state, st.id) === groupId);
  return {
    basis: sb ? 'submission' : 'current', submissionId: sb ? sb.id : null, version: sb ? sb.version : null, date: sb ? sb.uploadedAt : null,
    students: members.map((m) => { const cur = gradeOf(state, taskId, m.id); return { studentId: m.id, name: m.name, current: cur ? cur.value : null, individual: !!(cur && cur.individual), activeNow: m.active, currentGroup: currentGroupId(state, m.id) === groupId }; }),
  };
}

export function setUnitGrade(state, session, taskId, groupId, value, { submissionId = null, note = '', overwriteIndividual = false, now = nowIso() } = {}) {
  teacherOnly(session, 'קביעת ציון קבוצתי');
  const pv = unitGradePreview(state, taskId, groupId, { submissionId });
  const v = num(value, 'הציון');
  if (v < 0 || v > 100) throw new Error('הציון חייב להיות בין 0 ל-100');
  if (!pv.students.length) throw new Error('אין חברי קבוצה זכאים לציון');
  const s = clone(state);
  let n = 0;
  for (const m of pv.students) {
    if (m.individual && !overwriteIndividual) continue;
    putGrade(s, { taskId, studentId: m.studentId, value: Math.round(v * 100) / 100, source: 'manual-group', submissionId: pv.submissionId, note: String(note || '').slice(0, MAX_NOTE), individual: false, now });
    n++;
  }
  if (!n) throw new Error('כל הזכאים מחזיקים בציון אישי ידני. כדי לדרוס אותו צריך אישור מפורש');
  return s;
}

// ---------- החרגות ומשקלים אישיים ----------
export const exclusionsOf = (state, { activeOnly = true } = {}) => (state.exclusions || []).filter((e) => !activeOnly || e.active);
export const isExcluded = (state, taskId, studentId) => exclusionsOf(state).some((e) => e.taskId === taskId && (e.studentId === null || e.studentId === studentId));
export const isExcludedCycleWide = (state, taskId) => exclusionsOf(state).some((e) => e.taskId === taskId && e.studentId === null);
export const personalWeightsOf = (state, studentId) => (state.personalWeights || []).find((p) => p.studentId === studentId) || null;

// האם המשימה נספרת בציון התלמיד (פעילה, משקל חיובי, חלה עליו). משימה שיש לתלמיד עליה ציון נחשבת כחלה עליו.
function applies(state, t, studentId) {
  if (!isActive(t)) return false;
  const assignees = t.assignees || [];
  if (!assignees.length) return true;
  if (gradeOf(state, t.id, studentId)) return true;
  return t.kind === 'group' ? assignees.includes(currentGroupId(state, studentId)) : assignees.includes(studentId);
}
export const countedTasks = (state, studentId) => state.tasks.filter((t) => applies(state, t, studentId) && Number(t.weight) > 0).sort((a, b) => a.order - b.order);

// ההשלכות של החרגה, להצגה לפני אישור (לתלמיד או לכל המחזור)
export function exclusionImpact(state, taskId, studentId = null) {
  const t = task(state, taskId);
  const w = Number(t.weight) || 0;
  const ids = studentId ? [studentId] : state.students.filter((x) => x.active).map((x) => x.id);
  const sums = ids.map((id) => relevantSum(state, id, { without: taskId }));
  const personal = studentId ? false : ids.filter((id) => personalWeightsOf(state, id)).map((id) => student(state, id).name);
  return { weight: w, newSum: sums.length ? sums[0].sum : 0, missing: sums.length ? 100 - sums[0].sum : 0, personalOverrides: personal || [] };
}

export function excludeTask(state, session, taskId, { studentId = null, reason, now = nowIso() } = {}) {
  teacherOnly(session, 'החרגת משימה');
  task(state, taskId);
  if (studentId) student(state, studentId);
  const why = needReason(reason);
  if (exclusionsOf(state).some((e) => e.taskId === taskId && e.studentId === studentId)) throw new Error('המשימה כבר מוחרגת');
  const s = clone(state);
  (s.exclusions = s.exclusions || []).push({ id: newId('exc'), taskId, studentId: studentId || null, reason: why, at: now, active: true, endedAt: null });
  return s;
}
export function includeTask(state, session, taskId, { studentId = null, now = nowIso() } = {}) {
  teacherOnly(session, 'החזרת משימה לחישוב');
  const s = clone(state);
  const e = (s.exclusions || []).find((x) => x.active && x.taskId === taskId && x.studentId === (studentId || null));
  if (!e) throw new Error('אין החרגה פעילה כזו');
  Object.assign(e, { active: false, endedAt: now });
  return s;
}

// משקלים אישיים לתלמיד (אחרי החרגה אישית). הסכום חייב להיות 100, והמשימות הן אלה הנספרות אצלו.
export function setPersonalWeights(state, session, studentId, weights, { reason, now = nowIso() } = {}) {
  teacherOnly(session, 'משקלים אישיים');
  student(state, studentId);
  const why = needReason(reason);
  const ids = countedTasks(state, studentId).filter((t) => !isExcluded(state, t.id, studentId)).map((t) => t.id);
  const out = {};
  let sum = 0;
  for (const id of ids) {
    const w = num(weights[id] ?? 0, 'משקל');
    if (w < 0 || w > 100) throw new Error('משקל חייב להיות בין 0 ל-100');
    out[id] = w; sum += w;
  }
  if (Math.abs(sum - 100) > TOL) throw new Error(`סכום המשקלים האישיים הוא ${Math.round(sum * 100) / 100}% ולא 100%`);
  const s = clone(state);
  s.personalWeights = (s.personalWeights || []).filter((p) => p.studentId !== studentId);
  s.personalWeights.push({ studentId, weights: out, reason: why, at: now });
  return s;
}
export function clearPersonalWeights(state, session, studentId) {
  teacherOnly(session, 'משקלים אישיים');
  const s = clone(state);
  s.personalWeights = (s.personalWeights || []).filter((p) => p.studentId !== studentId);
  return s;
}

// התאמת משקלי משימות למחזור (אחרי החרגה כללית). הסכום על המשימות הנספרות חייב להיות 100.
export function setTaskWeights(state, session, weights) {
  teacherOnly(session, 'התאמת משקלים');
  const s = clone(state);
  for (const [id, w] of Object.entries(weights)) {
    const v = num(w, 'משקל');
    if (v < 0 || v > 100) throw new Error('משקל חייב להיות בין 0 ל-100');
    task(s, id).weight = v;
  }
  const sum = s.tasks.filter((t) => isActive(t) && !isExcludedCycleWide(s, t.id)).reduce((n, t) => n + (Number(t.weight) || 0), 0);
  if (Math.abs(sum - 100) > TOL) throw new Error(`סכום המשקלים של המשימות הנספרות הוא ${Math.round(sum * 100) / 100}% ולא 100%`);
  return s;
}

// ---------- ציוני רכיבים נוספים (אישיים) ----------
export const itemGradeOf = (state, itemId, studentId) => (state.extraGrades || []).find((g) => g.itemId === itemId && g.studentId === studentId) || null;
export function setItemGrade(state, session, itemId, studentId, value, { note = '', now = nowIso() } = {}) {
  teacherOnly(session, 'קביעת ציון לפריט');
  student(state, studentId);
  const comp = schemeOf(state).components.find((c) => c.items.some((i) => i.id === itemId));
  if (!comp) throw new Error('הפריט לא נמצא בערכת הציונים');
  let v = null;
  if (value !== null && value !== '' && value !== undefined) {
    v = num(value, 'הציון');
    if (v < 0 || v > 100) throw new Error('הציון חייב להיות בין 0 ל-100');
    v = Math.round(v * 100) / 100;
  }
  const s = clone(state);
  let g = (s.extraGrades = s.extraGrades || []).find((x) => x.itemId === itemId && x.studentId === studentId);
  if (!g) { g = { id: newId('xgr'), componentId: comp.id, itemId, studentId, value: null, history: [] }; s.extraGrades.push(g); }
  g.value = v; g.setAt = now;
  g.history.push({ value: v, note: String(note || '').slice(0, MAX_NOTE), at: now });
  return s;
}

// ---------- חישוב ----------
// סכום המשקלים הרלוונטיים של תלמיד: משקלים אישיים אם הוגדרו, אחרת משקלי המשימות, ללא משימות מוחרגות.
function relevantSum(state, studentId, { without = null } = {}) {
  const pw = personalWeightsOf(state, studentId);
  const rows = [];
  for (const t of countedTasks(state, studentId)) {
    if (t.id === without || isExcluded(state, t.id, studentId)) continue;
    const w = pw && pw.weights[t.id] !== undefined ? pw.weights[t.id] : (pw ? 0 : Number(t.weight));
    rows.push({ taskId: t.id, title: t.title, weight: w });
  }
  return { sum: rows.reduce((n, r) => n + r.weight, 0), rows };
}
export function relevantWeightSum(state) {
  return state.tasks.filter((t) => isActive(t) && !isExcludedCycleWide(state, t.id)).reduce((n, t) => n + (Number(t.weight) || 0), 0);
}

export function workGrade(state, studentId) {
  const pw = personalWeightsOf(state, studentId);
  const rows = countedTasks(state, studentId).map((t) => {
    const excluded = isExcluded(state, t.id, studentId);
    const w = excluded ? 0 : (pw && pw.weights[t.id] !== undefined ? pw.weights[t.id] : (pw ? 0 : Number(t.weight)));
    const g = gradeOf(state, t.id, studentId);
    return { taskId: t.id, title: t.title, weight: w, baseWeight: Number(t.weight), excluded, grade: g ? g.value : null, kind: t.kind };
  });
  const used = rows.filter((r) => !r.excluded && r.weight > 0);
  const sum = used.reduce((n, r) => n + r.weight, 0);
  const problems = [];
  if (!used.length) problems.push({ code: 'work-empty', text: 'אין משימות בעלות משקל שנספרות בציון העבודה.' });
  else if (Math.abs(sum - 100) > TOL) {
    const diff = Math.round((100 - sum) * 100) / 100;
    problems.push({ code: 'work-weights', sum, text: `סכום משקלי המשימות הנספרות הוא ${Math.round(sum * 100) / 100}% ולא 100% (${diff > 0 ? 'חסרים' : 'עודפים'} ${Math.abs(diff)}%). הציון הכולל לא יחושב עד שהמשקלים יותאמו.`, personal: rows.some((r) => r.excluded) && !isCycleExcludedAny(state, rows) });
  }
  const missing = used.filter((r) => r.grade === null || r.grade === undefined);
  for (const m of missing) problems.push({ code: 'missing-task', taskId: m.taskId, text: `חסר ציון במשימה "${m.title}" (משקל ${m.weight}%). אפשר להזין ציון ידני, כולל 0, או להחריג את המשימה.` });
  const ok = !problems.length;
  return { rows, sum, ok, grade: ok ? used.reduce((n, r) => n + r.weight * r.grade, 0) / 100 : null, problems };
}
const isCycleExcludedAny = (state, rows) => rows.some((r) => r.excluded && isExcludedCycleWide(state, r.taskId));

export function extraComponentGrade(state, studentId, comp) {
  const problems = [];
  const sum = comp.items.reduce((n, i) => n + i.weight, 0);
  if (Math.abs(sum - 100) > TOL) problems.push({ code: 'items-sum', text: `סכום משקלי הפריטים ברכיב "${comp.name}" הוא ${Math.round(sum * 100) / 100}% ולא 100%.` });
  const items = comp.items.map((i) => { const g = itemGradeOf(state, i.id, studentId); return { itemId: i.id, name: i.name, weight: i.weight, grade: g ? g.value : null }; });
  for (const i of items) if (i.grade === null) problems.push({ code: 'missing-item', itemId: i.itemId, text: `חסר ציון בפריט "${i.name}" ברכיב "${comp.name}".` });
  const ok = !problems.length;
  return { items, ok, grade: ok ? items.reduce((n, i) => n + i.weight * i.grade, 0) / 100 : null, problems };
}

// ציון כולל לתלמיד. exact ללא עיגול; rounded עיגול חד-פעמי. null עד שהכול תקין.
export function overall(state, studentId) {
  const sc = schemeOf(state);
  const problems = schemeProblems(sc);
  const components = sc.components.map((c) => {
    const r = c.kind === 'work' ? workGrade(state, studentId) : extraComponentGrade(state, studentId, c);
    if (c.weight > 0 || c.kind === 'work') problems.push(...r.problems.map((p) => ({ ...p, componentId: c.id })));
    return { id: c.id, kind: c.kind, name: c.name, weight: c.weight, grade: r.grade, ok: r.ok, detail: r };
  });
  const need = components.filter((c) => c.weight > 0);
  const ok = !problems.length && need.every((c) => c.grade !== null);
  const exact = ok ? need.reduce((n, c) => n + c.weight * c.grade, 0) / 100 : null;
  return { ok, exact, rounded: ok ? roundHalfUp(exact) : null, components, problems };
}

export function studentsForGrades(state) {
  return state.students.filter((s) => s.active);
}
