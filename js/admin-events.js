// תזכורות מנהלתיות למורה (טופס 4, טופס 5, תיאום מבחן בעל פה).
// אלה אינן משימות: הן אוסף נתונים נפרד (adminEvents), בדומה לחופשות. הן אינן נכנסות לחישובי ציונים,
// השלמה, הגשות או התראות, ואינן נשלחות לתלמידים (מוסתרות בשכבת הנתונים ב-gradepub.js).
// כל הפונקציות מחזירות מצב חדש ואינן משנות את הקיים.
import { newId } from './logic.js';
import { D } from './tasks.js';

export const ADMIN_KINDS = {
  form4: { title: 'תזכורת: מילוי טופס 4', icon: '📌' },
  form5: { title: 'תזכורת: מילוי טופס 5', icon: '📌' },
  oral: { title: 'תיאום מועד מבחן בעל פה עם הבוחן החיצוני והעברת העבודות אליו', icon: '📌' },
};
export const ADMIN_KIND_ORDER = ['form4', 'form5', 'oral'];

const clone = (s) => structuredClone(s);
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

// הוספת חודשים לתאריך, עם קיצוץ ליום האחרון בחודש היעד.
export function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, lastDay(ny, nm)))}`;
}

// שנת הלימודים של ההגשה: מסתיימת ביוני/יולי. ספטמבר עד דצמבר שייכים לשנת הלימודים שמסתיימת בשנה הבאה.
// העוגן: סיום המחזור, אחרת מועד ההגנה, אחרת תחילת המחזור, אחרת היום.
export function submissionYear(cycle, today = D.today()) {
  const anchor = [cycle && cycle.end, cycle && cycle.defenseDate, cycle && cycle.start].find((x) => D.valid(x)) || today;
  const [y, m] = anchor.split('-').map(Number);
  return m >= 9 ? y + 1 : y;
}

// ברירות מחדל (גמישות וניתנות לעריכה): טופס 4 באוקטובר, טופס 5 מ-3 עד 4 חודשים אחריו, בעל פה בפברואר עד מרץ.
export function defaultWindows(cycle, today = D.today()) {
  const y = submissionYear(cycle, today);
  const f4 = { start: `${y - 1}-10-01`, end: `${y - 1}-10-31` };
  return {
    form4: f4,
    form5: { start: addMonths(f4.start, 3), end: addMonths(f4.start, 4) },
    oral: { start: `${y}-02-01`, end: `${y}-03-31` },
  };
}

const make = (kind, win) => ({ id: newId('adm'), kind, title: ADMIN_KINDS[kind].title, start: win.start, end: win.end, note: '', done: false });

// אירועים ראשוניים למחזור חדש. kinds: אילו סוגים ליצור (ברירת מחדל: כולם).
export function defaultAdminEvents(cycle, { today = D.today(), kinds = ADMIN_KIND_ORDER } = {}) {
  const w = defaultWindows(cycle, today);
  return kinds.map((k) => make(k, w[k]));
}

export const adminEventsOf = (state) => state.adminEvents || [];

export function missingKinds(state) {
  const have = new Set(adminEventsOf(state).map((e) => e.kind));
  return ADMIN_KIND_ORDER.filter((k) => !have.has(k));
}

// הכפתור "הוסף אירועים מנהלתיים": מוסיף רק סוגים שחסרים, ולעולם לא נוגע בקיימים.
export function addDefaultAdminEvents(state, { today = D.today() } = {}) {
  const s = clone(state);
  s.adminEvents ??= [];
  const kinds = missingKinds(s);
  s.adminEvents.push(...defaultAdminEvents(s.cycle, { today, kinds }));
  return s;
}

export function updateAdminEvent(state, id, d) {
  const s = clone(state);
  const e = (s.adminEvents || []).find((x) => x.id === id);
  if (!e) throw new Error('התזכורת לא נמצאה');
  const title = String((d.title ?? e.title) || '').trim();
  if (!title) throw new Error('חסרה כותרת לתזכורת');
  const start = d.start ?? e.start;
  const end = d.end ?? e.end;
  if (!D.valid(start) || !D.valid(end)) throw new Error('תאריך לא תקין');
  if (start > end) throw new Error('תאריך הסיום קודם להתחלה');
  Object.assign(e, { title, start, end, note: String(d.note ?? e.note ?? '').trim(), done: d.done === undefined ? !!e.done : !!d.done });
  return s;
}

export function setAdminEventDone(state, id, done) {
  return updateAdminEvent(state, id, { done: !!done });
}

export function deleteAdminEvent(state, id) {
  const s = clone(state);
  s.adminEvents = (s.adminEvents || []).filter((e) => e.id !== id);
  return s;
}

export const adminEventsOnDay = (state, day) => adminEventsOf(state).filter((e) => e.start <= day && day <= e.end);

// תזכורות קרובות להצגה בבית: שלא בוצעו, ושעוד לא נגמרו (או נגמרו לפני פחות מ-30 יום ועדיין לא סומנו כבוצעו, כדי שלא יישכחו).
export function upcomingAdminEvents(state, today = D.today(), limit = 5) {
  return adminEventsOf(state)
    .filter((e) => !e.done && e.end >= D.add(today, -30))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    .slice(0, limit)
    .map((e) => ({ ...e, status: today > e.end ? 'overdue' : today >= e.start ? 'open' : 'future' }));
}
