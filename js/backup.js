// גיבוי ושחזור בטוח של מחזור (שלב 7, חלקים א+ב). לוגיקה טהורה, נבדקת ב-app/tests.
// עקרונות:
//  * הגיבוי מכיל נתוני ניהול של מחזור אחד בלבד (תלמידים, קבוצות, משימות, הגשות כרשומות, ציונים וכו'), לא את קובצי ההגשות עצמם.
//    לכן גיבוי אינו מאפשר לשחזר מסמך שנמחק לצמיתות מה-Drive (FILES_NOTICE).
//  * פנקס ה-Notes האישי יכול להיכלל בקובץ כחלק אישי מסומן (`personal`). שחזור מחזור לעולם אינו נוגע בו; שחזור הפנקס הוא פעולה נפרדת.
//  * לפני כל שחזור נשמר אוטומטית גיבוי של המצב הנוכחי (autoBackups בשורש, מחוץ לנתוני המחזור), ואפשר לחזור אליו.
//  * במהלך שחזור המחזור נעול (cycle.restoring): הגשות וכתיבות נדחות.
//  * שחזור הוא הכול-או-כלום: כשל באמצע מחזיר את המחזור לקדמותו ולא נשמר שום שינוי בנתוניו.
//  * הגשות שנוספו אחרי הגיבוי (מאוחרות) אינן מצורפות אוטומטית (אפיון 11.3): המורה רואה אותן ומחליט במפורש. בלי אישור צירוף הן נשמרות במקום מוגן (heldSubmissions) ואפשר לצרף אותן בהמשך. כל החלטה נרשמת ב-decisionLog.
//  * שחזור אינו מוצג כמושלם כשחסר קובץ בפועל: התוצאה "incomplete" והקבצים מסומנים fileMissing עד קישור מחדש.
import { DATA_KEYS, getCycle } from './cycles.js';
import { newId } from './logic.js';
import * as NB from './notes.js';

export const KIND = 'teacher-cycle-backup';
export const VERSION = 1;
export const MAX_AUTO = 10;
export const MAX_LOG = 300;
export const BATCH = 25;
export const FILES_NOTICE = 'הגיבוי שומר את נתוני הניהול (תלמידים, קבוצות, משימות, הגשות כרשומות, ציונים והערות), אבל לא את קובצי ההגשות עצמם. אם מסמך נמחק לצמיתות מה-Drive, אי אפשר לשחזר אותו מהגיבוי הזה.';

const clone = (x) => structuredClone(x);
const nowIso = () => new Date().toISOString();
const iso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function needTeacher(session) {
  if (!session || session.role !== 'teacher') throw new Error('פעולה זו מיועדת למורה בלבד.');
}

// ---------- יצירת גיבוי ----------
export function makeBackup(root, session, cycleId, { includePersonal = false, now = nowIso() } = {}) {
  needTeacher(session);
  const c = getCycle(root, cycleId);
  const b = {
    kind: KIND, version: VERSION, savedAt: now, notice: FILES_NOTICE,
    cycle: { id: c.id, name: c.name, start: c.start, end: c.end, defenseDate: c.defenseDate, archived: !!c.archived },
    data: Object.fromEntries(DATA_KEYS.map((k) => [k, clone(c.data[k] || [])])),
  };
  if (includePersonal) b.personal = NB.personalBackup(root.notesBook, session, { now });
  return b;
}

// ---------- בדיקת קובץ ----------
// מחזיר גיבוי נקי (בלי החלק האישי: הוא מטופל בנפרד). זורק שגיאה בעברית לקובץ שאינו תקין, בלי לשנות דבר.
export function validate(backup) {
  if (!backup || typeof backup !== 'object') throw new Error('הקובץ אינו קובץ גיבוי של מחזור.');
  if (backup.kind === NB.BACKUP_KIND) throw new Error('זה קובץ גיבוי של פנקס ה-Notes בלבד. שחזור הפנקס נעשה במסך "פנקס Notes".');
  if (backup.kind !== KIND) throw new Error('הקובץ אינו קובץ גיבוי של מחזור (אולי זה ייצוא או קובץ אחר).');
  if (backup.version !== VERSION) throw new Error('גרסת קובץ הגיבוי אינה נתמכת.');
  const c = backup.cycle;
  if (!c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name.trim()) throw new Error('בקובץ חסרים פרטי המחזור.');
  if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) throw new Error('בקובץ חסרים נתוני המחזור.');
  const data = {};
  for (const k of DATA_KEYS) {
    const v = backup.data[k];
    if (v === undefined) { data[k] = []; continue; }
    if (!Array.isArray(v)) throw new Error(`הקובץ פגום: "${k}" אינו רשימה.`);
    data[k] = clone(v);
  }
  for (const k of ['students', 'groups', 'tasks', 'submissions']) {
    const seen = new Set();
    for (const x of data[k]) {
      if (!x || typeof x.id !== 'string' || !x.id) throw new Error(`הקובץ פגום: רשומה ב-"${k}" בלי מזהה.`);
      if (seen.has(x.id)) throw new Error(`הקובץ פגום: מזהה כפול ב-"${k}".`);
      seen.add(x.id);
    }
  }
  for (const s of data.submissions) {
    if (typeof s.taskId !== 'string' || typeof s.unitId !== 'string') throw new Error('הקובץ פגום: הגשה בלי משימה או יחידה.');
  }
  return {
    kind: KIND, version: VERSION, savedAt: iso(backup.savedAt) ? backup.savedAt : '',
    cycle: { id: c.id, name: c.name.trim(), start: c.start || '', end: c.end || '', defenseDate: c.defenseDate || '', archived: !!c.archived },
    data, hasPersonal: !!(backup.personal && backup.personal.kind === NB.BACKUP_KIND),
  };
}

// הקובץ מכיל חלק אישי? מחזיר אותו (לשחזור הפנקס, פעולה נפרדת) או זורק שגיאה.
export function personalPart(backup) {
  if (backup && backup.kind === NB.BACKUP_KIND) return backup;
  if (backup && backup.kind === KIND && backup.personal) return backup.personal;
  throw new Error('בקובץ אין חלק אישי של פנקס ה-Notes.');
}

// קובץ שהמורה בחר לשחזור הפנקס: גיבוי פנקס בלבד, או גיבוי מחזור עם חלק אישי
export const personalPartOf = personalPart;

// ---------- הגשות שנוספו אחרי הגיבוי ----------
function lateOnes(clean, cur) {
  const inBackup = new Set(clean.data.submissions.map((s) => s.id));
  const tasks = new Set(clean.data.tasks.map((t) => t.id));
  const students = new Set(clean.data.students.map((s) => s.id));
  const groups = new Set(clean.data.groups.map((g) => g.id));
  const attachable = [];
  const blocked = [];
  for (const s of (cur ? cur.data.submissions : []).filter((x) => !inBackup.has(x.id))) {
    const unitOk = s.unitType === 'group' ? groups.has(s.unitId) : students.has(s.unitId);
    const uploaderOk = !s.uploadedBy || students.has(s.uploadedBy);
    if (tasks.has(s.taskId) && unitOk && uploaderOk) attachable.push(s);
    else blocked.push(s);
  }
  return { attachable, blocked };
}
const brief = (s, cur) => {
  const t = cur && cur.data.tasks.find((x) => x.id === s.taskId);
  return { id: s.id, fileName: s.fileName, uploadedAt: s.uploadedAt, taskId: s.taskId, taskTitle: t ? t.title : '', unitType: s.unitType, unitId: s.unitId };
};

// תצוגה מקדימה: מה יוחלף, מה ייעלם מהמצב הנוכחי, הגשות שנוספו מאז הגיבוי.
export function previewRestore(root, session, backup) {
  needTeacher(session);
  const clean = validate(backup);
  const cur = root.cycles.find((c) => c.id === clean.cycle.id) || null;
  const late = lateOnes(clean, cur);
  const subsNow = cur ? cur.data.submissions.length : 0;
  return {
    cycleId: clean.cycle.id, cycleName: clean.cycle.name, savedAt: clean.savedAt, exists: !!cur,
    currentName: cur ? cur.name : '', hasPersonal: clean.hasPersonal,
    counts: { students: clean.data.students.length, groups: clean.data.groups.length, tasks: clean.data.tasks.length, submissions: clean.data.submissions.length },
    currentCounts: cur ? { students: cur.data.students.length, groups: cur.data.groups.length, tasks: cur.data.tasks.length, submissions: subsNow } : null,
    lateAttachable: late.attachable.map((s) => brief(s, cur)),
    lateBlocked: late.blocked.map((s) => brief(s, cur)),
    willOverwrite: !!cur,
    notice: FILES_NOTICE,
  };
}

// ---------- גיבוי אוטומטי (לפני שחזור; בהמשך גם לפני ארכיון ומחיקה) ----------
export function addAutoBackup(root, session, cycleId, reason, { now = nowIso() } = {}) {
  needTeacher(session);
  const r = clone(root);
  const bk = makeBackup(r, session, cycleId, { includePersonal: false, now });
  r.autoBackups = [{ id: newId('abk'), cycleId, cycleName: bk.cycle.name, at: now, reason, backup: bk }, ...(r.autoBackups || [])].slice(0, MAX_AUTO);
  return r;
}
export const autoBackupList = (root) => (root.autoBackups || []).map(({ id, cycleId, cycleName, at, reason, backup }) => ({ id, cycleId, cycleName, at, reason, submissions: backup.data.submissions.length }));

// ---------- שחזור ----------
const setCycle = (root, cycleId, fn) => {
  const r = clone(root);
  const c = r.cycles.find((x) => x.id === cycleId);
  if (c) fn(c);
  return r;
};

// io = { getRoot, commit, fileExists(sub) -> boolean | Promise<boolean>, onStep?({done,total}) }
// שחזור מחזור שלם. אין פעולה חלקית: נעילה, גיבוי אוטומטי, בדיקת קבצים בקבוצות, והחלפה אחת אטומית.
export async function restoreCycle(io, session, backup, { lateDecision, now = nowIso() } = {}) {
  needTeacher(session);
  const clean = validate(backup);
  const cycleId = clean.cycle.id;
  let root = io.getRoot();
  const cur = root.cycles.find((c) => c.id === cycleId) || null;
  if (cur && cur.restoring) throw new Error('המחזור כבר בשחזור כרגע. אפשר לנסות שוב בעוד רגע.');
  const late = lateOnes(clean, cur);
  if (late.attachable.length && lateDecision !== 'attach' && lateDecision !== 'hold') {
    throw new Error('נמצאו הגשות שהגיעו אחרי הגיבוי. יש להחליט במפורש אם לצרף אותן למחזור המשוחזר או לשמור אותן בצד. לא בוצע שום שינוי.');
  }
  const doAttach = lateDecision === 'attach';

  // 1. גיבוי אוטומטי של המצב הנוכחי + נעילה
  if (cur) {
    root = addAutoBackup(root, session, cycleId, 'לפני שחזור', { now });
    root = setCycle(root, cycleId, (c) => { c.restoring = { since: now }; });
    io.commit(root);
  }
  const unlock = () => {
    const r2 = io.getRoot();
    if (r2.cycles.some((c) => c.id === cycleId && c.restoring)) io.commit(setCycle(r2, cycleId, (c) => { delete c.restoring; }));
  };

  try {
    // 2. בניית המחזור המשוחזר בזיכרון בלבד
    const data = clone(clean.data);
    const attached = [];
    if (doAttach && cur) {
      for (const s of late.attachable) {
        const same = data.submissions.filter((x) => x.taskId === s.taskId && x.unitType === s.unitType && x.unitId === s.unitId);
        const sub = { ...clone(s), version: same.length + 1, attachedAfterRestore: true };
        data.submissions.push(sub);
        attached.push(brief(s, cur));
        if (!data.progress.some((p) => p.taskId === s.taskId && p.unitType === s.unitType && p.unitId === s.unitId)) {
          const p = cur.data.progress.find((x) => x.taskId === s.taskId && x.unitType === s.unitType && x.unitId === s.unitId);
          if (p) data.progress.push(clone(p));
        }
      }
    }
    // 3. בדיקת קיום הקבצים בפועל, בקבוצות (אפשר להפסיק באמצע בלי נזק: עדיין לא נשמר דבר)
    const missing = [];
    const subs = data.submissions;
    for (let i = 0; i < subs.length; i += BATCH) {
      const part = subs.slice(i, i + BATCH);
      // לא Promise.all: ב-Apps Script הקוד סינכרוני (async/await מוסרים), ו-Promise.all היה מחזיר אובייקט במקום רשימה וכל הקבצים היו מסומנים חסרים
      const res = [];
      for (const s of part) res.push(!!(await io.fileExists(s)));
      part.forEach((s, j) => { if (!res[j]) { s.fileMissing = true; missing.push({ id: s.id, fileName: s.fileName, taskId: s.taskId }); } else delete s.fileMissing; });
      if (io.onStep) io.onStep({ done: Math.min(subs.length, i + BATCH), total: subs.length });
    }
    // 4. החלפה אטומית וסיום
    const result = {
      at: now, cycleId, cycleName: clean.cycle.name, backupSavedAt: clean.savedAt,
      status: missing.length ? 'incomplete' : 'complete', filesChecked: subs.length, missingFiles: missing,
      attachedLate: attached, notAttached: (doAttach ? late.blocked : [...late.attachable, ...late.blocked]).map((s) => brief(s, cur)), lateDecision: late.attachable.length ? lateDecision : null,
      createdNew: !cur,
    };
    let r3 = io.getRoot();
    if (cur) {
      r3 = setCycle(r3, cycleId, (c) => { Object.assign(c, { name: clean.cycle.name, start: clean.cycle.start, end: clean.cycle.end, defenseDate: clean.cycle.defenseDate, archived: clean.cycle.archived, data }); delete c.restoring; });
    } else {
      r3 = clone(r3);
      r3.cycles.push({ id: cycleId, name: clean.cycle.name, start: clean.cycle.start, end: clean.cycle.end, defenseDate: clean.cycle.defenseDate, archived: clean.cycle.archived, data });
    }
    r3.lastRestore = result;
    // הגשות שלא צורפו נשמרות במקום מוגן (עם רשומת ההגשה המלאה והפניה לקובץ), והחלטת המורה נרשמת
    const held = (doAttach ? late.blocked : [...late.attachable, ...late.blocked]);
    const heldNow = new Set((r3.heldSubmissions || []).map((h) => h.sub.id));
    r3.heldSubmissions = [...(r3.heldSubmissions || []), ...held.filter((s) => !heldNow.has(s.id)).map((s) => ({ id: newId('held'), cycleId, cycleName: clean.cycle.name, heldAt: now, reason: late.blocked.includes(s) ? 'cannot-attach' : 'declined', taskTitle: brief(s, cur).taskTitle, sub: clone(s) }))];
    r3.decisionLog = logAdd(r3.decisionLog, { at: now, kind: 'restore', cycleId, cycleName: clean.cycle.name, decision: late.attachable.length ? (doAttach ? 'attach' : 'hold') : 'none', attached: attached.map((x) => x.id), held: held.map((x) => x.id), fileNames: [...attached, ...held.map((s) => brief(s, cur))].map((x) => x.fileName), note: late.blocked.length ? 'חלק מההגשות לא ניתנות לצירוף ונשמרו בצד' : '' });
    io.commit(r3);
    return result;
  } catch (e) {
    unlock();
    throw new Error(`השחזור נכשל ולא בוצע. המחזור נשאר כפי שהיה לפני הניסיון (${e.message || 'שגיאה'}).`);
  }
}

// חזרה למצב שלפני שחזור (או פעולה אחרת): מחליפה את נתוני המחזור בגיבוי האוטומטי. המצב הנוכחי נשמר לפני כן כגיבוי אוטומטי.
export function undoToAutoBackup(root, session, autoId, { now = nowIso() } = {}) {
  needTeacher(session);
  const a = (root.autoBackups || []).find((x) => x.id === autoId);
  if (!a) throw new Error('הגיבוי האוטומטי לא נמצא.');
  const cur = root.cycles.find((c) => c.id === a.cycleId);
  let r = cur ? addAutoBackup(root, session, a.cycleId, 'לפני חזרה למצב קודם', { now }) : clone(root);
  const bk = a.backup;
  if (cur) {
    r = setCycle(r, a.cycleId, (c) => { Object.assign(c, { name: bk.cycle.name, start: bk.cycle.start, end: bk.cycle.end, defenseDate: bk.cycle.defenseDate, archived: bk.cycle.archived, data: clone(bk.data) }); delete c.restoring; });
  } else {
    r.cycles.push({ ...clone(bk.cycle), data: clone(bk.data) });
  }
  r.autoBackups = (r.autoBackups || []).filter((x) => x.id !== autoId);
  r.lastRestore = null;
  return r;
}

function logAdd(log, e) { return [...(log || []), { id: newId('log'), ...e }].slice(-MAX_LOG); }

// צירוף מאוחר של הגשה ששמרנו בצד, באישור מפורש של המורה. נבדק שהמשימה והיחידה עדיין קיימות.
export function attachHeld(root, session, heldId, { now = nowIso() } = {}) {
  needTeacher(session);
  const r = clone(root);
  const h = (r.heldSubmissions || []).find((x) => x.id === heldId);
  if (!h) throw new Error('ההגשה השמורה לא נמצאה.');
  const c = r.cycles.find((x) => x.id === h.cycleId);
  if (!c) throw new Error('המחזור של ההגשה לא קיים כרגע. אפשר לשחזר אותו מגיבוי ואז לנסות שוב.');
  if (c.restoring) throw new Error('המחזור בשחזור כרגע. נסו שוב בעוד רגע.');
  const s = h.sub;
  const unitOk = s.unitType === 'group' ? c.data.groups.some((g) => g.id === s.unitId) : c.data.students.some((x) => x.id === s.unitId);
  if (!c.data.tasks.some((t) => t.id === s.taskId) || !unitOk) throw new Error('המשימה או היחידה של ההגשה אינן קיימות במחזור, ולכן אי אפשר לצרף. ההגשה נשארת שמורה.');
  if (c.data.submissions.some((x) => x.id === s.id)) throw new Error('הגשה זו כבר קיימת במחזור.');
  const same = c.data.submissions.filter((x) => x.taskId === s.taskId && x.unitType === s.unitType && x.unitId === s.unitId);
  c.data.submissions.push({ ...clone(s), version: same.length + 1, attachedAfterRestore: true });
  r.heldSubmissions = r.heldSubmissions.filter((x) => x.id !== heldId);
  r.decisionLog = logAdd(r.decisionLog, { at: now, kind: 'held-attach', cycleId: h.cycleId, cycleName: h.cycleName, decision: 'attach', attached: [s.id], held: [], fileNames: [s.fileName], note: '' });
  return r;
}

// קישור מחדש של קובץ חסר (למשל אחרי שהמורה החזיר אותו ל-Drive): מסיר את הסימון, ואם לא נשארו חסרים התוצאה הופכת למושלמת.
export function relinkFile(root, session, cycleId, subId) {
  needTeacher(session);
  const r = clone(root);
  const c = getCycle(r, cycleId);
  const s = c.data.submissions.find((x) => x.id === subId);
  if (!s) throw new Error('ההגשה לא נמצאה.');
  delete s.fileMissing;
  if (r.lastRestore && r.lastRestore.cycleId === cycleId) {
    r.lastRestore.missingFiles = r.lastRestore.missingFiles.filter((m) => m.id !== subId);
    if (!r.lastRestore.missingFiles.length) r.lastRestore.status = 'complete';
  }
  return r;
}
