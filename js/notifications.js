// התראות למורה, תזכורות לתלמידים ויומן שליחות: לוגיקה טהורה (נבדקת ב-app/tests). אינה משנה את הקיים.
// עקרונות:
//  * התראות המורה (state.notifs) והודעות התלמיד (רשומות audience 'student' ביומן state.sendLog) נפרדות לגמרי.
//    תלמיד אינו מקבל את מרכז ההתראות, ולא את ההודעות של תלמיד אחר.
//  * התראה "נקראה" אינה "טופלה": נקראה = המורה ראה. טופלה = הבעיה נפתרה (נגזרת מהמצב) או שהמורה סגר אירוע.
//  * התראה אחת לכל אירוע (key). אירוע שחזר אחרי שנפתר נפתח מחדש ולא נוצר פעמיים.
//  * תזכורת נקבעת לפי המועד התקף (כולל ארכה), נפסקת בהגשה, ונשלחת פעם אחת לכל (משימה, תלמיד, שלב, ערוץ, מועד).
//  * דוא"ל מכיל קישור בלבד: בלי שם, משימה, ציון, משוב או מידע רפואי.
//  * בדמו אין שליחת דוא"ל אמיתית: "שליחה" היא רשומה ביומן בלבד.
import { newId } from './logic.js';
import * as T from './tasks.js';
import * as S from './submissions.js';
import * as F from './feedback.js';

export const TYPES = {
  missing: { label: 'הגשה חסרה', icon: '🔴' },
  late: { label: 'הגשה באיחור', icon: '🟠' },
  newsub: { label: 'הגשה חדשה לבדיקה', icon: '📥' },
  toolarge: { label: 'קובץ גדול מדי', icon: '📦' },
  savefail: { label: 'כשל שמירה', icon: '💾' },
  incomplete: { label: 'העלאה שלא הושלמה', icon: '⚠️' },
  convfail: { label: 'כשל המרה ל-PDF', icon: '⚠️' },
  question: { label: 'שאלת תלמיד', icon: '❓' },
  drive: { label: 'מקום ב-Drive', icon: '🗄️' },
  quota: { label: 'מכסת דוא"ל', icon: '✉️' },
};
// סוגים שאפשר לבקש עבורם דוא"ל למורה (התראת מכסה עצמה אינה נשלחת בדוא"ל: אין טעם לשלוח כשהמכסה נגמרה)
export const EMAIL_TYPES = Object.keys(TYPES).filter((k) => k !== 'quota');
export const MAX_CAP = 1500;
export const NEWSUB_DAYS = 14; // התראה על הגשה חדשה רק להגשות מהימים האחרונים: הגשות ישנות שממתינות לבדיקה נשארות ברשימה ובבית, בלי להציף התראות
export const STALE_DAYS = 3; // תזכורת שהמועד שלה עבר ביותר מכך לא נשלחת בדיעבד (למשל אחרי חודש בלי הרצה)
export const MAIL_LINK_BASE = 'https://medical-projects.example/app'; // כתובת לדוגמה בלבד בדמו

const clone = (x) => structuredClone(x);
const nowIso = () => new Date().toISOString();
const fmtD = (d) => (d ? d.split('-').reverse().join('.') : '');

function needTeacher(session) {
  if (!session || session.role !== 'teacher') throw new Error('רק המורה יכול לבצע פעולה זו.');
}

// ---------- הגדרות ----------
export const defaultSettings = () => ({
  reminders: { enabled: true, offsets: [-3, 0, 1], email: true }, // ימים ביחס למועד: שלילי = לפני, 0 = ביום המועד, חיובי = אחרי
  emailCategories: Object.fromEntries(EMAIL_TYPES.map((k) => [k, false])), // ברירת מחדל: בלי הצפה בדוא"ל
  dailyEmailCap: 50,
  driveUsedPct: 40, // ערך מדומה בדמו
  driveWarnPct: 90,
});

export function normalizeSettings(raw) {
  const d = defaultSettings();
  const r = raw && !Array.isArray(raw) && typeof raw === 'object' ? raw : {};
  return {
    reminders: { ...d.reminders, ...(r.reminders || {}) },
    emailCategories: { ...d.emailCategories, ...(r.emailCategories || {}) },
    dailyEmailCap: r.dailyEmailCap ?? d.dailyEmailCap,
    driveUsedPct: r.driveUsedPct ?? d.driveUsedPct,
    driveWarnPct: r.driveWarnPct ?? d.driveWarnPct,
  };
}

export function normalizeOffsets(list) {
  const arr = [...new Set((list || []).map(Number))];
  if (arr.some((n) => !Number.isInteger(n) || n < -30 || n > 30)) throw new Error('ימי התזכורת: מספרים שלמים בין 30- ל-30.');
  if (arr.length > 5) throw new Error('אפשר עד 5 תזכורות למשימה.');
  return arr.sort((a, b) => a - b);
}

const inRange = (v, lo, hi, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(msg); return n; };

// עדכון הגדרות כלליות של חשבון המורה. מקבל רק את השדות שנשלחו.
export function setSettings(state, session, patch) {
  needTeacher(session);
  const cur = normalizeSettings(state.notifSettings);
  const next = clone(cur);
  if (patch.reminders) {
    const p = patch.reminders;
    if (p.enabled !== undefined) next.reminders.enabled = !!p.enabled;
    if (p.email !== undefined) next.reminders.email = !!p.email;
    if (p.offsets !== undefined) next.reminders.offsets = normalizeOffsets(p.offsets);
  }
  if (patch.emailCategories) for (const k of EMAIL_TYPES) if (patch.emailCategories[k] !== undefined) next.emailCategories[k] = !!patch.emailCategories[k];
  if (patch.dailyEmailCap !== undefined) next.dailyEmailCap = inRange(patch.dailyEmailCap, 0, MAX_CAP, `מכסת הדוא"ל היומית: מספר שלם בין 0 ל-${MAX_CAP}.`);
  if (patch.driveUsedPct !== undefined) next.driveUsedPct = inRange(patch.driveUsedPct, 0, 100, 'אחוז תפוסה: בין 0 ל-100.');
  if (patch.driveWarnPct !== undefined) next.driveWarnPct = inRange(patch.driveWarnPct, 1, 100, 'סף אזהרה: בין 1 ל-100.');
  const s = clone(state);
  s.notifSettings = next;
  return s;
}

// החרגה למשימה: mode = 'default' | 'off' | 'custom' (עם offsets ו-email)
export function setTaskReminder(state, session, taskId, { mode, offsets = [], email = true }) {
  needTeacher(session);
  if (!state.tasks.some((t) => t.id === taskId)) throw new Error('המשימה לא נמצאה.');
  if (!['default', 'off', 'custom'].includes(mode)) throw new Error('מצב תזכורת לא תקין.');
  const s = clone(state);
  s.taskReminders = (s.taskReminders || []).filter((x) => x.taskId !== taskId);
  if (mode === 'off') s.taskReminders.push({ taskId, mode: 'off' });
  if (mode === 'custom') s.taskReminders.push({ taskId, mode: 'custom', offsets: normalizeOffsets(offsets), email: !!email });
  return s;
}

// ההגדרה בפועל למשימה. המתג הכללי כבוי = אין תזכורות בכלל, גם במשימות עם הגדרה אישית.
export function reminderConfig(state, taskId) {
  const g = normalizeSettings(state.notifSettings).reminders;
  if (!g.enabled) return { enabled: false, offsets: [], email: false, source: 'global-off' };
  const o = (state.taskReminders || []).find((x) => x.taskId === taskId);
  if (!o) return { enabled: true, offsets: g.offsets, email: g.email, source: 'default' };
  if (o.mode === 'off') return { enabled: false, offsets: [], email: false, source: 'off' };
  return { enabled: true, offsets: o.offsets, email: o.email, source: 'custom' };
}

// ---------- דוא"ל (קישור בלבד) ----------
export function buildEmail(audience) {
  if (audience === 'teacher') return { subject: 'יש התראה חדשה במערכת הליווי', body: `יש פריט שממתין לטיפולך במערכת.\nלצפייה: ${MAIL_LINK_BASE}#/notifications` };
  return { subject: 'תזכורת ממערכת הליווי', body: `יש משימה שממתינה להגשה.\nלכניסה למערכת: ${MAIL_LINK_BASE}#/home` };
}

export const emailsSentOn = (entries, day) => (entries || []).filter((e) => e.channel === 'email' && e.status === 'sent' && e.day === day).length;
export function mailQuota(entries, day, cap) {
  const used = emailsSentOn(entries, day);
  const capped = (entries || []).filter((e) => e.channel === 'email' && e.status === 'capped' && e.day === day).length;
  return { used, cap, left: Math.max(0, cap - used), capped, full: used >= cap };
}

// ---------- התראות למורה ----------
export const notifStatus = (n) => (n.resolvedAt ? 'resolved' : n.read ? 'open-read' : 'open-unread');
export function notifCounts(state) {
  const list = state.notifs || [];
  return { unread: list.filter((n) => notifStatus(n) === 'open-unread').length, open: list.filter((n) => !n.resolvedAt).length, resolved: list.filter((n) => n.resolvedAt).length };
}

const studentNameOf = (state, id) => (state.students.find((x) => x.id === id) || {}).name || '';

// כל מה שדורש טיפול כרגע, נגזר מהמצב. אותו key = אותו אירוע.
function derive(state, now) {
  const out = [];
  const settings = normalizeSettings(state.notifSettings);
  const today = now.slice(0, 10);
  for (const r of S.trackerRows(state, { now })) {
    const where = `${r.unit.name} · "${r.task.title}"`;
    if (r.code === 'missing-late' && r.completion !== 'approved') {
      out.push({ key: `missing:${r.task.id}:${r.unit.type}:${r.unit.id}`, type: 'missing', refs: { taskId: r.task.id, unitType: r.unit.type, unitId: r.unit.id }, text: `לא הוגשה עבודה (המועד היה ${fmtD(r.due)}): ${where}`, link: '#/submissions' });
    }
    if (r.latest && r.code === 'late' && F.attentionReasons(state, r.latest, r.completion).includes('review')) {
      out.push({ key: `late:${r.latest.id}`, type: 'late', refs: { taskId: r.task.id, unitType: r.unit.type, unitId: r.unit.id, subId: r.latest.id }, text: `הוגשה באיחור וממתינה לבדיקה: ${where}`, link: '#/submissions' });
    }
    if (r.latest && r.code !== 'late' && Date.parse(now) - Date.parse(r.latest.uploadedAt) <= NEWSUB_DAYS * 86400000 && F.attentionReasons(state, r.latest, r.completion).includes('review')) {
      out.push({ key: `newsub:${r.latest.id}`, type: 'newsub', refs: { taskId: r.task.id, unitType: r.unit.type, unitId: r.unit.id, subId: r.latest.id }, text: `הוגשה עבודה חדשה וממתינה לבדיקה: ${where}`, link: '#/submissions' });
    }
    if (r.latest && r.conversion === 'failed' && (r.latest.conversion || {}).pdfSource !== 'student') {
      out.push({ key: `convfail:${r.latest.id}`, type: 'convfail', refs: { taskId: r.task.id, unitType: r.unit.type, unitId: r.unit.id, subId: r.latest.id }, text: `ההמרה ל-PDF נכשלה (ההגשה נקלטה): ${where}`, link: '#/submissions' });
    }
  }
  for (const { question: q, comment: c } of F.openQuestions(state)) {
    const sub = (state.submissions || []).find((x) => x.id === c.submissionId);
    const task = sub && state.tasks.find((t) => t.id === sub.taskId);
    out.push({ key: `question:${q.id}`, type: 'question', refs: { threadId: q.id, commentId: c.id, subId: c.submissionId }, text: `שאלת הבהרה מ${studentNameOf(state, q.authorId) || 'תלמיד'}${task ? ` על "${task.title}"` : ''}`, link: '#/submissions' });
  }
  if (settings.driveUsedPct >= settings.driveWarnPct) {
    out.push({ key: 'drive:warn', type: 'drive', refs: {}, text: `מקום ה-Drive תפוס ב-${settings.driveUsedPct}% (ערך מדומה בדמו)`, link: '#/notifications' });
  }
  const cappedToday = (state.sendLog || []).filter((e) => e.channel === 'email' && e.status === 'capped' && e.day === today);
  if (cappedToday.length) {
    out.push({ key: `quota:${today}`, type: 'quota', refs: {}, text: `מכסת הדוא"ל היומית (${settings.dailyEmailCap}) הגיעה למגבלה: ${cappedToday.length} הודעות לא נשלחו בדוא"ל`, link: '#/notifications' });
  }
  return out;
}

// הודעת דוא"ל למורה על התראה חדשה, אם הקטגוריה מסומנת. מכבד מכסה יומית. מחזיר 1 אם נשלח.
function queueTeacherEmail(s, n, now, budget) {
  const settings = normalizeSettings(s.notifSettings);
  if (!EMAIL_TYPES.includes(n.type) || !settings.emailCategories[n.type]) return 0;
  const key = `tmail:${n.id}:${n.reopenedAt || n.createdAt}`;
  if ((s.sendLog || []).some((e) => e.key === key)) return 0;
  const ok = budget > 0;
  s.sendLog.push({ id: newId('snd'), key, audience: 'teacher', kind: 'notification', channel: 'email', at: now, day: now.slice(0, 10), to: 'teacher', notifType: n.type, status: ok ? 'sent' : 'capped', ...buildEmail('teacher') });
  return ok ? 1 : 0;
}

// מסנכרן את רשימת ההתראות עם המצב הנוכחי. התראה שהבעיה שלה נפתרה מסומנת "טופלה"; בעיה חדשה יוצרת התראה אחת.
// emailBudget = כמה הודעות דוא"ל נשארו היום בחשבון המורה (בכל המחזורים).
export function syncNotifications(state, { now = nowIso(), emailBudget = Infinity } = {}) {
  const s = clone(state);
  s.notifs ||= [];
  s.sendLog ||= [];
  const before = JSON.stringify([s.notifs, s.sendLog]);
  let budget = emailBudget;
  const fresh = [];
  const apply = (active) => {
    const keys = new Set(active.map((a) => a.key));
    for (const a of active) {
      const n = s.notifs.find((x) => x.key === a.key);
      if (!n) {
        const nn = { id: newId('ntf'), key: a.key, source: 'derived', type: a.type, refs: a.refs, text: a.text, link: a.link, createdAt: now, lastAt: now, count: 1, read: false, readAt: null, resolvedAt: null };
        s.notifs.push(nn);
        fresh.push(nn);
      } else if (n.resolvedAt) {
        Object.assign(n, { resolvedAt: null, read: false, readAt: null, reopenedAt: now, lastAt: now, text: a.text, refs: a.refs, link: a.link });
        fresh.push(n);
      }
    }
    for (const n of s.notifs) if (n.source === 'derived' && !n.resolvedAt && !keys.has(n.key)) n.resolvedAt = now;
  };
  apply(derive(s, now));
  for (const n of fresh) budget -= queueTeacherEmail(s, n, now, budget);
  apply(derive(s, now)); // התראת מכסה תלויה ביומן, שאולי השתנה בשליחת דוא"ל ההתראות
  return { state: s, changed: JSON.stringify([s.notifs, s.sendLog]) !== before, emailsUsed: emailBudget === Infinity ? 0 : emailBudget - budget };
}

// אירוע שנרשם ברגע שקרה (לא נגזר מהמצב): ניסיון להעלות קובץ גדול מדי, כשל שמירה. המורה סוגר אותו ידנית.
// אירוע זהה חוזר לא יוצר התראה נוספת: הספירה עולה וההתראה חוזרת להיות "לא נקראה".
export function recordEvent(state, { type, key, refs = {}, text, link = '#/submissions', now = nowIso(), emailBudget = Infinity }) {
  if (!['toolarge', 'savefail', 'incomplete'].includes(type)) throw new Error('סוג אירוע לא מוכר.');
  const s = clone(state);
  s.notifs ||= [];
  s.sendLog ||= [];
  let n = s.notifs.find((x) => x.key === key);
  let isNew = false;
  if (!n) {
    n = { id: newId('ntf'), key, source: 'event', type, refs, text, link, createdAt: now, lastAt: now, count: 1, read: false, readAt: null, resolvedAt: null };
    s.notifs.push(n);
    isNew = true;
  } else {
    n.count = (n.count || 1) + 1;
    n.lastAt = now;
    n.text = text;
    n.read = false;
    n.readAt = null;
    if (n.resolvedAt) { n.resolvedAt = null; n.reopenedAt = now; isNew = true; }
  }
  const used = isNew ? queueTeacherEmail(s, n, now, emailBudget) : 0;
  return { state: s, emailsUsed: used };
}

export function markRead(state, session, ids, read = true, now = nowIso()) {
  needTeacher(session);
  const s = clone(state);
  const all = ids === 'all';
  for (const n of s.notifs || []) {
    if (!all && !ids.includes(n.id)) continue;
    n.read = !!read;
    n.readAt = read ? now : null;
  }
  return s;
}

// סגירה ידנית של אירוע (קובץ גדול מדי, כשל שמירה). התראה שנגזרת מהמצב נסגרת לבד כשהבעיה נפתרת.
export function resolveEvent(state, session, id, now = nowIso()) {
  needTeacher(session);
  const s = clone(state);
  const n = (s.notifs || []).find((x) => x.id === id);
  if (!n) throw new Error('ההתראה לא נמצאה.');
  if (n.source !== 'event') throw new Error('ההתראה הזו נסגרת מעצמה כשהבעיה נפתרת.');
  n.resolvedAt = now;
  n.read = true;
  n.readAt ||= now;
  return s;
}

export function reopenEvent(state, session, id) {
  needTeacher(session);
  const s = clone(state);
  const n = (s.notifs || []).find((x) => x.id === id);
  if (!n || n.source !== 'event') throw new Error('ההתראה לא נמצאה.');
  n.resolvedAt = null;
  return s;
}

// ---------- תזכורות לתלמידים ----------
const activeMembers = (state, groupId) => state.memberships.filter((m) => m.groupId === groupId && m.to === null).map((m) => state.students.find((x) => x.id === m.studentId)).filter((x) => x && x.active);

function recipientsOf(state, unit) {
  if (unit.type === 'group') return activeMembers(state, unit.id);
  const st = state.students.find((x) => x.id === unit.id);
  return st && st.active ? [st] : [];
}

function reminderText(title, due, offset) {
  if (offset < 0) return `תזכורת: "${title}" להגשה עד ${fmtD(due)} (${offset === -1 ? "מחר" : "בעוד " + (-offset) + " ימים"})`;
  if (offset === 0) return `תזכורת: היום המועד האחרון להגשת "${title}"`;
  return `תזכורת: עבר המועד להגשת "${title}" (${fmtD(due)}). אפשר להגיש עכשיו`;
}

// מריץ בדיקת תזכורות לפי התאריך now. לכל (משימה, תלמיד) נשלח לכל היותר השלב האחרון שהגיע זמנו, פעם אחת בכל ערוץ.
// הגשה, אישור השלמה, משימה לא פעילה או תלמיד לא פעיל: אין תזכורת. מגבלת הדוא"ל היומית נאכפת.
export function runReminders(state, session, { now = nowIso(), emailBudget = Infinity } = {}) {
  needTeacher(session);
  const s = clone(state);
  s.sendLog ||= [];
  const today = now.slice(0, 10);
  let budget = emailBudget;
  let system = 0;
  let email = 0;
  let capped = 0;
  const valid = new Set(); // מפתחות שהתזכורת שלהם רלוונטית עכשיו (נקבע מחדש בכל הרצה)
  for (const t of T.orderedTasks(s).filter((x) => x.requiresSubmission)) {
    const cfg = reminderConfig(s, t.id);
    if (!cfg.enabled || !cfg.offsets.length) continue;
    for (const unit of T.unitsOfTask(s, t)) {
      if (S.latestOf(s, t.id, unit.type, unit.id)) continue; // הוגש: התזכורות נפסקות
      if (T.getProgress(s, t.id, unit.type, unit.id).completion === 'approved') continue;
      const eff = T.effectiveDates(s, t, unit.type === 'group' ? { groupId: unit.id } : { studentId: unit.id });
      if (today < eff.start) continue;
      const stages = cfg.offsets.map((o) => ({ o, day: T.D.add(eff.due, o) })).filter((x) => x.day <= today).sort((a, b) => (a.day < b.day ? -1 : 1));
      const cur = stages.at(-1);
      if (!cur || T.D.diff(today, cur.day) > STALE_DAYS) continue;
      for (const st of recipientsOf(s, unit)) {
        const channels = cfg.email ? ['system', 'email'] : ['system'];
        for (const ch of channels) {
          const key = `rem:${t.id}:${st.id}:${cur.o}:${ch}:${eff.due}`;
          valid.add(key);
          const ex = s.sendLog.find((e) => e.key === key);
          if (ex && ex.status === 'sent') continue; // לא שולחים פעמיים
          const mail = ch === 'email' ? buildEmail('student') : { subject: 'תזכורת להגשה', body: reminderText(t.title, eff.due, cur.o) };
          const ok = ch === 'system' || budget > 0;
          const rec = { id: ex ? ex.id : newId('snd'), key, audience: 'student', kind: 'reminder', channel: ch, at: now, day: today, studentId: st.id, toEmail: ch === 'email' ? st.email : '', taskId: t.id, unitType: unit.type, unitId: unit.id, offset: cur.o, due: eff.due, status: ok ? 'sent' : 'capped', attempts: (ex ? ex.attempts || 1 : 0) + 1, ...mail };
          if (ex) Object.assign(ex, rec); else s.sendLog.push(rec);
          if (ch === 'system') system += 1;
          else if (ok) { email += 1; budget -= 1; } else capped += 1;
        }
      }
    }
  }
  // דוא"ל שחיכה למכסה ואינו רלוונטי עוד (הוגש, המשימה בוטלה או הוסרה, התזכורות כובו, המועד זז בארכה, התלמיד לא פעיל) מבוטל ולא נשלח
  for (const e of s.sendLog) {
    if (e.kind === 'reminder' && e.channel === 'email' && e.status === 'capped' && !valid.has(e.key)) Object.assign(e, { status: 'cancelled', cancelledAt: now, cancelReason: 'לא רלוונטית עוד' });
  }
  return { state: s, system, email, capped, emailsUsed: email };
}

// ההודעות שתלמיד רואה אצלו במערכת (רק שלו). active = המשימה עדיין פתוחה להגשה.
export function messagesForStudent(state, studentId, limit = 20) {
  return (state.sendLog || [])
    .filter((e) => e.audience === 'student' && e.channel === 'system' && e.status === 'sent' && e.studentId === studentId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
    .map((e) => {
      const t = state.tasks.find((x) => x.id === e.taskId);
      const submitted = !!S.latestOf(state, e.taskId, e.unitType, e.unitId);
      const approved = T.getProgress(state, e.taskId, e.unitType, e.unitId).completion === 'approved';
      return { id: e.id, text: e.body, at: e.at, taskId: e.taskId, active: !!t && T.isActive(t) && !submitted && !approved };
    });
}

// יומן שליחות למורה: הכול, מהחדש לישן, עם שמות.
export function logRows(state, { audience = 'all' } = {}) {
  return (state.sendLog || [])
    .filter((e) => audience === 'all' || e.audience === audience)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((e) => ({ ...e, studentName: e.studentId ? studentNameOf(state, e.studentId) : '', taskTitle: (state.tasks.find((t) => t.id === e.taskId) || {}).title || '' }));
}
