// ייבוא חופשות מלוח משרד החינוך למנגנון "חופשות ואילוצים" הקיים (state.vacations). לוגיקה טהורה, בלי רשת ובלי DOM,
// כדי שתרוץ גם בשרת (Apps Script) וגם בדפדפן. טעינת קובצי הלוחות נמצאת ב-moe-catalog.js (לקוח בלבד).
// עקרונות מחייבים:
//  * הנתונים מגיעים רק מקובצי לוח מובנים (app/data/moe-vacations/*.json) שנוצרו מחוזר רשמי של משרד החינוך ואומתו. אין תאריכים משוערים.
//  * ייבוא חוזר אינו יוצר כפילות: זיהוי לפי מפתח יציב (src.key) השמור ברשומה, גם אם המורה ערך אותה אחר כך.
//  * ייבוא אינו מוחק ואינו דורס חופשה קיימת, ואינו משנה מועדי משימות או הגשות. התנגשות עם משימות ממשיכה להיות מסומנת במנגנון הקיים.
import { newId } from './logic.js';
import { D } from './tasks.js';

const clone = (s) => structuredClone(s);
export const MAX_IMPORT = 200;
export const SCHOOL_TYPES = { jewish: 'יהודי', arab: 'ערבי' };
const KEY_RE = /^moe:\d{4}-\d{4}:(jewish|arab):[a-z0-9-]{1,60}$/;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// שנת לימודים ("2026-2027") שבה נופל תאריך: מאוגוסט ואילך שייך לשנה שמתחילה באותה שנה קלנדרית.
export function schoolYearOf(date) {
  if (!D.valid(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

// כל שנות הלימודים שבהן נוגע טווח תאריכים (מחזור פרויקט יכול להשתרע על שתיים). ממוין.
export function schoolYearsOfRange(start, end) {
  const a = schoolYearOf(start);
  const b = schoolYearOf(end || start);
  if (!a) return b ? [b] : [];
  if (!b || b < a) return [a];
  const out = [];
  let y = Number(a.slice(0, 4));
  while (`${y}-${y + 1}` <= b && out.length < 10) { out.push(`${y}-${y + 1}`); y += 1; }
  return out;
}

// בדיקת תקינות של לוח שנה מובנה (נקראת גם בבדיקות הנתונים). מחזירה רשימת בעיות, ריקה = תקין.
export function validateCalendar(cal) {
  const problems = [];
  if (!cal || typeof cal !== 'object') return ['הלוח אינו אובייקט'];
  if (!/^\d{4}-\d{4}$/.test(cal.yearId || '')) problems.push('yearId לא תקין');
  if (!cal.label) problems.push('חסר label');
  const seen = new Set();
  for (const [school, c] of Object.entries(cal.calendars || {})) {
    if (!SCHOOL_TYPES[school]) problems.push(`סוג בית ספר לא מוכר: ${school}`);
    const s = (c && c.source) || {};
    for (const f of ['title', 'notice', 'url', 'published', 'verifiedOn']) if (!s[f]) problems.push(`${school}: חסר source.${f}`);
    if (s.url && !/^https:\/\/(apps|pop)\.education\.gov\.il\//.test(s.url)) problems.push(`${school}: כתובת מקור אינה של משרד החינוך`);
    if (!c || !Array.isArray(c.items) || !c.items.length) { problems.push(`${school}: אין פריטים`); continue; }
    for (const it of c.items) {
      const id = `${school}/${it.key}`;
      if (!KEY_RE.test(it.key || '') || !String(it.key).startsWith(`moe:${cal.yearId}:${school}:`)) problems.push(`${id}: מפתח לא תקין`);
      if (seen.has(it.key)) problems.push(`${id}: מפתח כפול`);
      seen.add(it.key);
      if (!str(it.title, 120)) problems.push(`${id}: חסר שם`);
      if (!D.valid(it.start) || !D.valid(it.end)) problems.push(`${id}: תאריך לא תקין`);
      else if (it.start > it.end) problems.push(`${id}: סיום לפני התחלה`);
    }
  }
  // תיעוד מקור: כל תאריך שתוקן וכל פריט שהושמט חייבים להיות מתועדים במפורש
  const byKey = new Map();
  for (const c of Object.values(cal.calendars || {})) for (const it of (c.items || [])) byKey.set(it.key, it);
  for (const x of (cal.corrections || [])) {
    const it = byKey.get(x.key);
    if (!it) problems.push(`תיקון מתועד לפריט שאינו קיים: ${x.key}`);
    else if (it.start !== x.entered && it.end !== x.entered) problems.push(`${x.key}: התאריך שהוזן אינו תואם את התיעוד`);
    for (const f of ['notice', 'section', 'sourceText', 'entered', 'reason', 'verifiedBy', 'verifiedOn']) if (!x[f]) problems.push(`${x.key}: בתיעוד התיקון חסר ${f}`);
  }
  for (const x of (cal.omitted || [])) {
    for (const f of ['notice', 'section', 'title', 'sourceText', 'reason', 'omittedOn']) if (!x[f]) problems.push(`פריט מושמט: חסר ${f}`);
  }
  return problems;
}

// סטטוס כל פריט ביחס למצב המחזור: new (חדש), exists (כבר יובא, לפי מפתח), similar (קיימת חופשה בתאריכים זהים שלא יובאה)
export function planImport(state, calendar, school) {
  const cal = calendar && calendar.calendars && calendar.calendars[school];
  if (!cal) return [];
  const vacs = (state && state.vacations) || [];
  const keys = new Set(vacs.map((v) => v.src && v.src.key).filter(Boolean));
  return cal.items.map((it) => {
    const status = keys.has(it.key) ? 'exists' : (vacs.some((v) => v.start === it.start && v.end === it.end) ? 'similar' : 'new');
    // שום פריט אינו מסומן מראש: המורה בוחר בעצמו (או מסמן קבוצה שלמה)
    return { ...it, group: it.group || it.community || 'חופשות רשמיות', status, selected: false };
  });
}

// רשימת הפריטים לשליחה ל-importVacations, עם מטא-נתוני המקור לכל רשומה
export function buildImportItems(calendar, school, keys) {
  const cal = calendar.calendars[school];
  const want = new Set(keys);
  return cal.items.filter((it) => want.has(it.key)).map((it) => ({
    key: it.key,
    title: it.community ? `${it.title} (${it.community})` : it.title,
    start: it.start,
    end: it.end,
    src: { key: it.key, year: calendar.yearId, yearLabel: calendar.label, school, schoolLabel: SCHOOL_TYPES[school], community: it.community || '', level: cal.level || '', notice: cal.source.notice, url: cal.source.url, published: cal.source.published, verifiedOn: cal.source.verifiedOn },
  }));
}

// מוסיף את הפריטים שאינם קיימים (לפי מפתח). פריט קיים מדולג בשקט, בלי לגעת בו. מחזיר מצב חדש.
export function importVacations(state, items, now) {
  if (!Array.isArray(items) || !items.length) throw new Error('לא נבחרו חופשות לייבוא');
  if (items.length > MAX_IMPORT) throw new Error('יותר מדי חופשות בבת אחת');
  const s = clone(state);
  s.vacations = s.vacations || [];
  const have = new Set(s.vacations.map((v) => v.src && v.src.key).filter(Boolean));
  const stamp = str(now, 40);
  for (const it of items) {
    const title = str(it && it.title, 120);
    const src = (it && it.src) || {};
    if (!title) throw new Error('חסר שם לחופשה');
    if (!D.valid(it.start) || !D.valid(it.end)) throw new Error('תאריך לא תקין');
    if (it.start > it.end) throw new Error('תאריך הסיום קודם להתחלה');
    if (!KEY_RE.test(src.key || '') || src.key !== it.key) throw new Error('מפתח מקור לא תקין');
    if (have.has(src.key)) continue;
    have.add(src.key);
    s.vacations.push({
      id: newId('vac'), title, start: it.start, end: it.end,
      src: { key: src.key, year: str(src.year, 9), yearLabel: str(src.yearLabel, 40), school: str(src.school, 10), schoolLabel: str(src.schoolLabel, 20), community: str(src.community, 80), level: str(src.level, 40), notice: str(src.notice, 20), url: str(src.url, 300), published: str(src.published, 10), verifiedOn: str(src.verifiedOn, 10), importedAt: stamp },
    });
  }
  return s;
}

// עריכת חופשה קיימת (ידנית או מיובאת). המפתח ומקור הנתונים נשמרים, כך שייבוא חוזר לא יוצר כפילות.
export function updateVacation(state, id, { title, start, end }) {
  const t = str(title, 120);
  if (!t) throw new Error('חסר שם לחופשה');
  if (!D.valid(start) || !D.valid(end)) throw new Error('תאריך לא תקין');
  if (start > end) throw new Error('תאריך הסיום קודם להתחלה');
  const s = clone(state);
  const v = s.vacations.find((x) => x.id === id);
  if (!v) throw new Error('החופשה לא נמצאה');
  v.title = t; v.start = start; v.end = end;
  if (v.src) v.src.edited = true;
  return s;
}

// ---------- ייבוא בלחיצה אחת ----------
// שנות הלימודים הרלוונטיות למחזור: מתחילת המחזור ועד המאוחר מבין יעד הסיום ומועד ההגנה. בלי תאריכי מחזור: שנת הלימודים הנוכחית.
export function yearsForCycle(cycle, today) {
  const c = cycle || {};
  const start = D.valid(c.start) ? c.start : today;
  const ends = [c.end, c.defenseDate].filter((x) => D.valid(x));
  const end = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : start;
  return schoolYearsOfRange(start, end < start ? start : end);
}

// catalog: { index: {years:[{id,label,status,message,file}]}, calendars: { [yearId]: לוח } }.
// מחזיר לכל שנה: חופשות מוכנות לייבוא (חדשות בלבד), או הודעה ברורה שהלוח טרם פורסם או אומת. אין תאריכים משוערים.
// pick (אופציונלי): פונקציה שמחליטה אילו שורות נבחרות. כברירת מחדל לא נבחר דבר: המורה בוחר בעצמו.
export function quickImportPlan(state, catalog, school, cycle, today, pick) {
  if (!SCHOOL_TYPES[school]) throw new Error('לא נבחר סוג בית ספר');
  const entries = ((catalog && catalog.index && catalog.index.years) || []);
  const years = yearsForCycle(cycle, today).map((id) => {
    const entry = entries.find((e) => e.id === id);
    const cal = catalog && catalog.calendars && catalog.calendars[id];
    if (!entry) return { id, label: id, ok: false, message: `הלוח הרשמי של משרד החינוך לשנת הלימודים ${id.replace('-', '–')} עדיין לא נוסף למערכת. הוא יתווסף בעדכון אחרי הפרסום והאימות, ולא יוצגו תאריכים משוערים.`, rows: [] };
    if (entry.status !== 'verified') return { id, label: entry.label, ok: false, message: entry.message || `הלוח הרשמי של ${entry.label} עדיין לא פורסם או לא אומת.`, rows: [] };
    if (!cal || validateCalendar(cal).length) return { id, label: entry.label, ok: false, message: `קובץ הלוח של ${entry.label} אינו תקין או לא נטען, ולכן לא יובא. נסו שוב מאוחר יותר.`, rows: [] };
    if (!cal.calendars[school]) return { id, label: entry.label, ok: false, message: `אין לוח ${SCHOOL_TYPES[school]} מאומת עבור ${entry.label}.`, rows: [] };
    const rows = planImport(state, cal, school);
    return { id, label: entry.label, ok: true, message: '', rows, calendar: cal, notes: cal.verificationNotes || [] };
  });
  const items = [];
  for (const y of years) {
    if (!y.ok) continue;
    items.push(...buildImportItems(y.calendar, school, y.rows.filter((r) => r.status === 'new' && typeof pick === 'function' && pick(r)).map((r) => r.key)));
  }
  return { school, years, items };
}

// ---------- סוג בית ספר כהגדרה של המחזור ----------
// מי שמחליף סוג בית ספר אחרי ייבוא: אפשר להסיר את החופשות שיובאו מהלוח הקודם. מוסרות רק חופשות מיובאות שלא נערכו;
// חופשה שהוזנה ידנית, או שיובאה ונערכה, נשארת. מועדי משימות והגשות אינם משתנים.
export function planSchoolChange(state, newSchool) {
  const old = (state.cycle && state.cycle.school) || '';
  const imported = ((state && state.vacations) || []).filter((v) => v.src && v.src.school && v.src.school !== newSchool);
  return {
    from: old, to: newSchool,
    importedOther: imported.length,
    removable: imported.filter((v) => !v.src.edited).length,
    keptEdited: imported.filter((v) => v.src.edited).length,
  };
}

export function setSchool(state, school, removeOld) {
  if (!SCHOOL_TYPES[school]) throw new Error('סוג בית ספר לא מוכר');
  const s = clone(state);
  s.cycle = Object.assign({}, s.cycle, { school });
  if (removeOld) s.vacations = (s.vacations || []).filter((v) => !(v.src && v.src.school && v.src.school !== school && !v.src.edited));
  return s;
}
