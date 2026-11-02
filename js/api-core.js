// ליבת ממשק הנתונים (api). אותו קוד רץ בדפדפן (api-local.js, אחסון localStorage) ובשרת (server/handler.js).
// הממשק מדבר רק דרך האובייקט שנוצר כאן, וכל הפעולות אסינכרוניות כמו שיחה אמיתית לשרת.
// הזהות (session) ניתנת מבחוץ: בדפדפן מהדמו, ובשרת מהאסימון המאומת בלבד, ולא מהלקוח.
// המצב השמור כולל מספר מחזורים (cycles.js). הממשק רואה תמיד פרוסה שטוחה של מחזור אחד:
// למורה המחזור שנבחר בבורר, ולתלמיד המחזור שבו נכנס. נתוני מחזורים אחרים אינם נשלחים לתלמיד.
// env = { store: {get, commit}, session: {get, set}, sim, later(ms, fn(store)) }
import * as L from './logic.js';
import * as T from './tasks.js';
import * as AE from './admin-events.js';
import * as C from './cycles.js';
import * as S from './submissions.js';
import * as R from './review.js';
import * as F from './feedback.js';
import * as X from './corrections.js';
import * as A from './ai.js';
import * as K from './rubrics.js';
import * as G from './grades.js';
import * as PB from './gradepub.js';
import * as N from './notifications.js';
import * as NB from './notes.js';
import * as B from './backup.js';
import * as LC from './lifecycle.js';
import * as M from './maintenance.js';
import { buildDemoRoot } from './seed.js';
import { SaveError } from './store.js';

// files (אופציונלי): שירות קבצים אמיתי (files.js). כשהוא קיים, הגשה היא רק דרך העלאה במקטעים, והפעולות "הגשה לפי שם וגודל" נחסמות.
export function createApi({ store, session: sessionPort, sim, later, files = null }) {
const get = () => store.get();
const commit = (s) => store.commit(s);
const sess = () => sessionPort.get();
const needFiles = () => { if (!files) throw new S.SubmissionError('nofiles', 'העלאת קבצים אינה זמינה בסביבה הזו.'); return files; };
// המחזור הנוכחי: של התלמיד לפי הכניסה שלו, או של המורה לפי הבורר.
const curId = (root = get()) => {
  const s = sess();
  if (s && s.role === 'student' && !C.studentCanAccess(root, s)) throw new Error('המחזור נסגר או אינו זמין לתלמידים. יש להיכנס מחדש.');
  return s && s.role === 'student' && s.cycleId && root.cycles.some((c) => c.id === s.cycleId) ? s.cycleId : root.activeCycleId;
};

const nowIso = () => new Date().toISOString();
const BATCH_ACTIONS = new Set(['addComment', 'updateComment', 'deleteComment', 'addNote', 'updateNote', 'setNoteStatus', 'deleteNote']);
// כמה הודעות דוא"ל נשארו היום בחשבון המורה (המכסה אחת לכל החשבון, בכל המחזורים)
function emailBudgetLeft(root, day) {
  const cap = N.normalizeSettings(root.notifSettings).dailyEmailCap;
  const used = root.cycles.reduce((n, c) => n + N.emailsSentOn(c.data.sendLog, day), 0);
  return Math.max(0, cap - used);
}
// בשרת האמיתי זה יקרה ברקע. בדמו ההתראות מתעדכנות בכל קריאת מצב של המורה במחזור הפעיל (שאינו בארכיון).
function syncTeacher() {
  const s = sess();
  if (!s || s.role !== 'teacher') return;
  const root = get();
  const id = curId(root);
  if (root.cycles.find((c) => c.id === id).archived) return;
  const now = nowIso();
  const r = N.syncNotifications(C.sliceOf(root, id), { now, emailBudget: emailBudgetLeft(root, now.slice(0, 10)) });
  if (r.changed) { try { commit(C.applyToCycle(root, id, () => r.state)); } catch (e) { if (!(e instanceof SaveError)) throw e; /* עדכון ההתראות יתבצע שוב בקריאה הבאה */ } }
}

let accessEnded = false;
function view() {
  syncTeacher();
  const root = get();
  // תלמיד שהמחזור שלו הועבר לארכיון או נמחק (או שהוא כבר לא פעיל בו) מנותק, ואינו רואה דבר
  const s0 = sess();
  if (s0 && s0.role === 'student' && !C.studentCanAccess(root, s0)) { api.setSession(null); accessEnded = true; }
  const id = curId(root);
  const s = sess();
  const flat = C.sliceOf(root, id);
  const cyc = root.cycles.find((c) => c.id === id);
  let cycles = C.cycleList(root);
  if (s && s.role === 'student') {
    const me = flat.students.find((x) => x.id === s.userId);
    const mine = me ? C.cyclesOfStudentEmail(root, me.email).map((x) => x.cycleId) : [];
    cycles = cycles.filter((c) => mine.includes(c.id));
  }
  if (accessEnded) { flat.accessEnded = true; accessEnded = false; }
  flat.cycles = cycles;
  flat.activeCycleId = id;
  flat.archived = !!cyc.archived;
  // לאן הועתק כל פריט בבנק (בכל המחזורים), להסבר לפני מחיקה מהבנק. מיועד למורה בלבד.
  if (!s || s.role === 'teacher') {
    flat.bankUsage = {};
    for (const c of root.cycles) {
      for (const t of c.data.tasks) {
        if (!t.sourceId) continue;
        const list = (flat.bankUsage[t.sourceId] ??= []);
        let e = list.find((x) => x.cycleId === c.id);
        if (!e) list.push(e = { cycleId: c.id, cycleName: c.name, active: 0, inactive: 0 });
        e[T.isActive(t) ? 'active' : 'inactive'] += 1;
      }
    }
  }
  if (s && s.role === 'student') {
    const out = PB.redactForStudent(flat, s.userId);
    out.myMessages = N.messagesForStudent(flat, s.userId); // רק ההודעות של התלמיד עצמו
    return out;
  }
  if (!s || s.role === 'teacher') {
    const day = nowIso().slice(0, 10);
    flat.autoBackups = B.autoBackupList(root);
    flat.trash = LC.trashList(root, { now: nowIso() });
    flat.cycleAccess = Object.fromEntries(root.cycles.map((c) => [c.id, !!c.studentAccessOpen]));
    flat.lastRestore = root.lastRestore || null;
    flat.lastBackupAt = root.lastBackupAt || null;
    flat.heldSubmissions = (root.heldSubmissions || []).map(({ id, cycleId, cycleName, heldAt, reason, taskTitle, sub }) => ({ id, cycleId, cycleName, heldAt, reason, taskTitle, fileName: sub.fileName, uploadedAt: sub.uploadedAt }));
    flat.decisionLog = (root.decisionLog || []).slice(-50).reverse();
    flat.notesBook = NB.normalizeBook(root.notesBook); // רק למורה: אינו חלק מפרוסת המחזור
    flat.mailQuota = N.mailQuota(root.cycles.flatMap((c) => c.data.sendLog || []), day, N.normalizeSettings(root.notifSettings).dailyEmailCap);
  }
  if (!s) {
    // תלמיד מומלץ לבדיקה: יש לו גם הגשה קבוצתית וגם הגשה אישית שעוד לא הוגשו (הראשון שנמצא בכל המחזורים)
    let hinted = false;
    flat.loginOptions = root.cycles.filter((c) => !c.archived || c.studentAccessOpen).flatMap((c) => {
      const cs = C.sliceOf(root, c.id);
      return c.data.students.filter((x) => x.active).map((x) => {
        let hint = false;
        if (!hinted) {
          const acts = S.studentFocus(cs, x.id, new Date().toISOString()).actions.filter((a) => a.kind === 'submit');
          hint = acts.some((a) => a.task.kind === 'group') && acts.some((a) => a.task.kind === 'personal');
          if (hint) hinted = true;
        }
        return { cycleId: c.id, cycleName: c.name, id: x.id, name: x.name, hint };
      });
    });
  }
  return flat;
}

const act = (fn) => async (...a) => { commit(C.applyToCycle(get(), curId(), (s) => fn(s, ...a))); return structuredClone(view()); };
// פעולות על הבנק המשותף: מותרות גם כשהמחזור הנוכחי בארכיון
const actBank = (fn) => async (...a) => { commit(C.applyToCycle(get(), curId(), (s) => fn(s, ...a), { bankOnly: true })); return structuredClone(view()); };
const actBankSess = (fn) => async (...a) => { commit(C.applyToCycle(get(), curId(), (s) => fn(s, sess(), ...a), { bankOnly: true })); return structuredClone(view()); };
const actBook = (fn) => async (...a) => { const root = get(); commit({ ...root, notesBook: fn(NB.normalizeBook(root.notesBook), sess(), ...a) }); return structuredClone(view()); };
const actSess = (fn) => async (...a) => { commit(C.applyToCycle(get(), curId(), (s) => fn(s, sess(), ...a))); return structuredClone(view()); };

// ----- הגשות (דמו) -----
// בגרסה האמיתית השרת שומר את הקובץ ומריץ את ההמרה. כאן ההמרה מדומה בהשהיה קצרה, ואפשר לדמות כשלים כדי לבדוק את ההודעות.
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
const CONVERT_MS = 1600;

function scheduleConversion(cycleId, subId, willFail) {
  later(CONVERT_MS, (st) => {
    try {
      st.commit(C.applyToCycle(st.get(), cycleId, (s) => S.completeConversion(s, subId, { ok: !willFail, now: new Date().toISOString(), error: willFail ? 'ההמרה ל-PDF נכשלה (כשל מדומה)' : '' }), { allowArchived: true }));
      notify();
    } catch (e) { /* המחזור הוסר או הועבר לארכיון: אין מה לעדכן */ }
  });
}

// כשל בהגשה (קובץ גדול מדי, כשל שמירה) נרשם כאירוע למורה. בשרת האמיתי השרת רושם אותו.
function recordSubmissionFailure(cycleId, e, { taskId, unitType, unitId, file }) {
  if (!e || !['size', 'save'].includes(e.code)) return;
  try {
    const session = sess();
    const root = get();
    const flat = C.sliceOf(root, cycleId);
    const task = flat.tasks.find((x) => x.id === taskId);
    const who = (flat.students.find((x) => x.id === (session && session.userId)) || {}).name || '';
    const unit = unitType === 'group' ? (flat.groups.find((g) => g.id === unitId) || {}).name : who;
    const title = task ? task.title : '';
    const mb = Math.round((Number(file.size) / 1024 / 1024) * 10) / 10;
    const now = nowIso();
    const ev = e.code === 'size'
      ? { type: 'toolarge', key: `toolarge:${taskId}:${unitId}:${file.fileName}:${file.size}`, text: `נחסמה העלאת הקובץ "${file.fileName}" (${mb}MB, גדול מדי) ל"${title}". הועלה על ידי ${who}${unitType === 'group' ? `, קבוצה: ${unit}` : ''}` }
      : { type: 'savefail', key: `savefail:${taskId}:${unitId}`, text: `תקלה בשמירת קובץ שהוגש ל"${title}" (${who}${unitType === 'group' ? `, קבוצה: ${unit}` : ''}). ההגשה לא נקלטה` };
    const r = N.recordEvent(flat, { ...ev, refs: { taskId, unitType, unitId }, now, emailBudget: emailBudgetLeft(root, now.slice(0, 10)) });
    commit(C.applyToCycle(root, cycleId, () => r.state));
  } catch (err) { /* רישום האירוע אינו מסתיר את שגיאת ההגשה עצמה */ }
}

let lastRun = null;

const api = {
  // מצב מדומה לבדיקות בלבד
  setSimulation(patch) { Object.assign(sim, patch); },
  getSimulation: () => ({ ...sim }),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  // התלמיד מגיש קובץ. כשל בשמירה = שום דבר לא נרשם. כשל בהמרה = ההגשה נקלטה.
  async submitFile(taskId, unitType, unitId, file) {
    if (files) throw new S.SubmissionError('upload', 'ההגשה נעשית דרך העלאת קובץ.');
    const cycleId = curId();
    try {
      if (sim.failSave) throw new S.SubmissionError('save', 'ההגשה לא נקלטה: הייתה תקלה בשמירת הקובץ. נסה שוב בעוד רגע. אם זה חוזר, פנה למורה.');
      commit(C.applyToCycle(get(), cycleId, (s) => S.submitFile(s, sess(), { taskId, unitType, unitId, fileName: file.fileName, size: file.size })));
    } catch (e) {
      recordSubmissionFailure(cycleId, e, { taskId, unitType, unitId, file });
      throw e;
    }
    const sub = S.latestOf(C.sliceOf(get(), cycleId), taskId, unitType, unitId);
    scheduleConversion(cycleId, sub.id, sim.failConvert);
    return structuredClone(view());
  },
  async retryConversion(subId) {
    const cycleId = curId();
    commit(C.applyToCycle(get(), cycleId, (s) => S.retryConversion(s, sess(), subId)));
    if (!files) scheduleConversion(cycleId, subId, sim.failConvert); // בשרת אמיתי הלקוח קורא אחר כך ל-runConversion
    return structuredClone(view());
  },
  requestPdf: actSess((s, session, id) => S.requestPdf(s, session, id, { now: new Date().toISOString() })),
  attachPdf: actSess((s, session, id, file) => {
    if (files) throw new S.SubmissionError('upload', 'צירוף PDF נעשה דרך העלאת קובץ.');
    return S.attachPdf(s, session, id, { fileName: file.fileName, size: file.size, now: new Date().toISOString() });
  }),

  // ----- קבצים אמיתיים (רק כשיש שירות קבצים) -----
  // פתיחת העלאה להגשה: כל הבדיקות (הרשאה, משימה, גודל, סוג) נעשות מראש, בלי לשנות דבר. ההגשה נרשמת רק בסיום ההעלאה.
  async beginUpload(taskId, unitType, unitId, file) {
    const f = needFiles();
    const cycleId = curId();
    S.submitFile(C.sliceOf(get(), cycleId), sess(), { taskId, unitType, unitId, fileName: file.fileName, size: file.size });
    return f.begin({ userId: sess().userId, purpose: 'source', fileName: file.fileName, size: file.size, bind: { cycleId, taskId, unitType, unitId } });
  },
  async beginPdfUpload(subId, file) {
    const f = needFiles();
    const cycleId = curId();
    S.attachPdf(C.sliceOf(get(), cycleId), sess(), subId, { fileName: file.fileName, size: file.size });
    return f.begin({ userId: sess().userId, purpose: 'pdf', fileName: file.fileName, size: file.size, bind: { cycleId, subId } });
  },
  async uploadChunk(uploadId, index, data, sha256) {
    return needFiles().putChunk({ userId: sess().userId, uploadId, index, data, sha256 });
  },
  // בדיקת שלמות וסוג וחתימה (בלי רישום הגשה). חלק הכבד של הסיום, מחוץ לנעילה, כדי שהרישום (הנעול) יהיה קצר גם כשיש הרבה הגשות בו-זמנית. בטוח לקרוא שוב.
  async sealUpload(uploadId) {
    const f = needFiles();
    await f.seal({ userId: sess().userId, uploadId });
    return { sealed: true };
  },
  // סיום: בדיקת שלמות וסוג, חתימה, ורק אז רישום ההגשה (קובץ המקור ומועד ההגשה נשמרים לפני כל המרה). כשל רישום: ההעלאה חתומה וניתן לנסות שוב.
  async finishUpload(uploadId) {
    const f = needFiles();
    const userId = sess().userId;
    const meta = await f.meta(uploadId);
    if (meta.userId !== userId) throw new S.SubmissionError('upload', 'העלאה לא נמצאה.');
    const cycleId = meta.bind.cycleId;
    if (cycleId !== curId()) throw new S.SubmissionError('upload', 'ההעלאה שייכת למחזור אחר.');
    const flat = C.sliceOf(get(), cycleId);
    if ((flat.submissions || []).some((x) => x.fileKey === uploadId || (x.conversion && x.conversion.pdfKey === uploadId))) return structuredClone(view()); // כבר נרשמה
    const sealed = await f.seal({ userId, uploadId });
    if (sealed.purpose === 'source') {
      commit(C.applyToCycle(get(), cycleId, (s) => S.submitFile(s, sess(), { ...sealed.bind, fileName: sealed.fileName, size: sealed.size, fileKey: uploadId })));
    } else {
      commit(C.applyToCycle(get(), cycleId, (s) => S.attachPdf(s, sess(), sealed.bind.subId, { fileName: sealed.fileName, size: sealed.size, now: new Date().toISOString(), fileKey: uploadId })));
    }
    return structuredClone(view());
  },
  // המרה ל-PDF (אחרי שההגשה כבר נשמרה). כשל המרה אינו מבטל הגשה: ההגשה נשארת, והסטטוס "נכשלה".
  async runConversion(subId) {
    const f = needFiles();
    const cycleId = curId();
    const sub = (C.sliceOf(get(), cycleId).submissions || []).find((x) => x.id === subId);
    if (!sub || !S.canTouch(C.sliceOf(get(), cycleId), sess(), sub)) throw new S.SubmissionError('auth', 'אין הרשאה.');
    if (sub.conversion.status !== 'pending') return structuredClone(view());
    const r = await f.convert({ fileKey: sub.fileKey, fileName: sub.fileName, userId: sess().userId });
    commit(C.applyToCycle(get(), cycleId, (s) => S.completeConversion(s, subId, { ok: r.ok, error: r.error, pdfKey: r.pdfKey, pdfName: r.pdfName, pdfSource: r.pdfSource, now: new Date().toISOString() }), { allowArchived: true }));
    return structuredClone(view());
  },
  // קריאת מקטע של קובץ המקור או ה-PDF של הגשה. ההרשאה נבדקת מול ההגשה: מורה, או התלמיד/הקבוצה שהגישו. לעולם לא לפי מפתח בלבד.
  async readFileChunk(subId, kind, index) {
    const f = needFiles();
    const cycleId = curId();
    const flat = C.sliceOf(get(), cycleId);
    const sub = (flat.submissions || []).find((x) => x.id === subId);
    if (!sub || !S.canTouch(flat, sess(), sub)) throw new S.SubmissionError('auth', 'אין הרשאה.');
    const k = kind === 'pdf' ? (sub.conversion.status === 'done' ? sub.conversion.pdfKey : null) : kind === 'source' ? sub.fileKey : null;
    if (!k) throw new S.SubmissionError('nofile', 'הקובץ אינו זמין.');
    return f.readChunk(k, index);
  },
  async getState() { return structuredClone(view()); },
  // איפוס נתוני הדמה אינו מוחק את פנקס ה-Notes האישי של המורה
  async resetDemo() { const fresh = buildDemoRoot(); fresh.notesBook = NB.normalizeBook(get().notesBook); commit(fresh); return structuredClone(view()); },
  // מחזורים (המורה)
  async addCycle(d) { commit(C.addCycle(get(), d)); return structuredClone(view()); },
  async setActiveCycle(id) { commit(C.setActiveCycle(get(), id)); return structuredClone(view()); },
  async setArchived(id, archived) { commit(archived ? LC.archiveCycle(get(), sess(), id, { now: nowIso() }) : LC.unarchiveCycle(get(), sess(), id, { now: nowIso() })); return structuredClone(view()); },
  setStudentAccess: async (id, open) => { commit(LC.setStudentAccess(get(), sess(), id, open, { now: nowIso() })); return structuredClone(view()); },
  deleteCycle: async (id, confirmName) => { commit(LC.deleteCycle(get(), sess(), id, { confirmName, now: nowIso() })); return structuredClone(view()); },
  restoreTrashed: async (trashId) => { commit(LC.restoreFromTrash(get(), sess(), trashId, { now: nowIso() })); return structuredClone(view()); },
  purgeTrashed: async (trashId, confirmName) => { commit(LC.purgeTrashed(get(), sess(), trashId, { confirmName, now: nowIso() })); return structuredClone(view()); },
  // תלמיד הרשום בשני מחזורים עובר ביניהם. הזהות נקבעת לפי הדוא"ל, ורק למחזור שבו הוא פעיל ושאינו בארכיון.
  async switchStudentCycle(cycleId) {
    const s = sess();
    const root = get();
    if (!s || s.role !== 'student') throw new Error('אין הרשאה');
    const me = C.getCycle(root, curId(root)).data.students.find((x) => x.id === s.userId);
    const target = me && C.cyclesOfStudentEmail(root, me.email).find((x) => x.cycleId === cycleId);
    if (!target) throw new Error('אין לך גישה למחזור הזה');
    api.setSession({ role: 'student', userId: target.student.id, cycleId });
    return structuredClone(view());
  },
  // מחזור, תלמידים וקבוצות
  saveCycle: act(L.createCycle),
  addStudent: act(L.addStudent),
  updateStudent: act(L.updateStudent),
  setStudentActive: act(L.setStudentActive),
  addGroup: act(L.addGroup),
  updateGroup: act(L.updateGroup),
  deleteGroup: act(L.deleteGroup),
  assignStudent: act(L.assignStudent),
  // תכנון
  addTask: act(T.addTask),
  setTaskActive: act(T.setTaskActive),
  updateTask: act(T.updateTask),
  deleteTask: act(T.deleteTask),
  moveTask: act(T.moveTask),
  setTaskDates: act(T.setTaskDates),
  setException: act(T.setException),
  removeException: act(T.removeException),
  addVacation: act(T.addVacation),
  deleteVacation: act(T.deleteVacation),
  addDefaultAdminEvents: act((s) => AE.addDefaultAdminEvents(s)),
  updateAdminEvent: act(AE.updateAdminEvent),
  deleteAdminEvent: act(AE.deleteAdminEvent),
  addTemplateItem: actBank(T.addTemplateItem),
  updateTemplateItem: actBank(T.updateTemplateItem),
  deleteTemplateItem: actBank(T.deleteTemplateItem),
  moveTemplateItem: actBank(T.moveTemplateItem),
  applyTemplate: act(T.applyTemplate),
  addTaskFromBank: act(T.addTaskFromBank),
  // התקדמות והשלמה: ההרשאה נבדקת לפי הכניסה הנוכחית, כמו בשרת
  // בדיקה ידנית: הערות (טיפוסי טיוטה) וקטגוריות (משותפות, ניתנות לעריכה גם במחזור בארכיון)
  addComment: actSess(R.addComment),
  updateComment: actSess(R.updateComment),
  deleteComment: actSess(R.deleteComment),
  // משוב: סימון פנימי, שליחה (פרסום), תוקן, תגובות ושאלות
  setChecked: actSess((s, session, id, checked, opts) => F.setChecked(s, session, id, checked, { ...opts, now: new Date().toISOString() })),
  setTreated: actSess(F.setTreated),
  publishFeedback: actSess((s, session, id) => F.publishFeedback(s, session, id, { now: new Date().toISOString() })),
  publishBatch: actSess((s, session, ids) => F.publishBatch(s, session, ids, { now: new Date().toISOString() })),
  // שליחת משוב עם פרסום ציון המשימה (ברירת מחדל), פרסום וביטול פרסום של ציונים והערות
  sendFeedbackWithGrade: actSess((s, session, id, o) => PB.sendFeedbackWithGrade(s, session, id, { ...o, now: new Date().toISOString() })),
  sendBatchWithGrades: actSess((s, session, ids, o) => PB.sendBatchWithGrades(s, session, ids, { ...o, now: new Date().toISOString() })),
  publishTaskGrades: actSess((s, session, taskId, ids) => PB.publishTaskGrades(s, session, taskId, ids, { now: new Date().toISOString() })),
  retractTaskGrades: actSess((s, session, taskId, ids) => PB.retractTaskGrades(s, session, taskId, ids, { now: new Date().toISOString() })),
  publishOverallGrades: actSess((s, session, ids) => PB.publishOverall(s, session, ids, { now: new Date().toISOString() })),
  retractOverallGrades: actSess((s, session, ids) => PB.retractOverall(s, session, ids, { now: new Date().toISOString() })),
  retractComment: actSess((s, session, id) => F.retractComment(s, session, id, { now: new Date().toISOString() })),
  retractSubmissionFeedback: actSess((s, session, id) => F.retractSubmissionFeedback(s, session, id, { now: new Date().toISOString() })),
  setFixed: actSess((s, session, id, fixed) => F.setFixed(s, session, id, fixed, { now: new Date().toISOString() })),
  addThread: actSess((s, session, id, d) => F.addThread(s, session, id, { ...d, now: new Date().toISOString() })),
  // מחוונים (ספרייה משותפת) וניקוד פנימי
  addBaseRubric: actBankSess(K.addBaseRubric),
  updateBaseRubric: actBankSess(K.updateBaseRubric),
  duplicateBaseRubric: actBankSess(K.duplicateBaseRubric),
  setBaseArchived: actBankSess(K.setBaseArchived),
  assignRubric: actSess((s, session, taskId, baseId) => K.assignRubric(s, session, taskId, baseId, { now: new Date().toISOString() })),
  updateTaskRubric: actSess((s, session, taskId, d) => K.updateTaskRubric(s, session, taskId, d, { now: new Date().toISOString() })),
  removeTaskRubric: actSess(K.removeTaskRubric),
  startScoring: actSess((s, session, id) => K.startScoring(s, session, id, { now: new Date().toISOString() })),
  setScorePoints: actSess((s, session, id, crit, v) => K.setPoints(s, session, id, crit, v, { now: new Date().toISOString() })),
  setScoreCheck: actSess((s, session, id, crit, v) => K.setCheck(s, session, id, crit, v, { now: new Date().toISOString() })),
  setScoreNote: actSess((s, session, id, note) => K.setNote(s, session, id, note, { now: new Date().toISOString() })),
  setScoreRisk: actSess((s, session, id, key, on) => K.setRisk(s, session, id, key, on, { now: new Date().toISOString() })),
  // ציונים פנימיים: ערכה, תבניות, ציוני משימות, החרגות, משקלים
  setGradeScheme: actSess((s, session, d) => G.setScheme(s, session, d, { now: new Date().toISOString() })),
  saveGradeTemplate: actBankSess((s, session, name) => G.saveTemplate(s, session, name, { now: new Date().toISOString() })),
  deleteGradeTemplate: actBankSess(G.deleteTemplate),
  applyGradeTemplate: actSess((s, session, id) => G.applyTemplate(s, session, id, { now: new Date().toISOString() })),
  setGradeFromSheet: actSess((s, session, id, o) => G.setGradeFromSheet(s, session, id, { ...o, now: new Date().toISOString() })),
  setStudentGrade: actSess((s, session, taskId, studentId, v, o) => G.setStudentGrade(s, session, taskId, studentId, v, { ...o, now: new Date().toISOString() })),
  setGroupGrade: actSess((s, session, taskId, groupId, v, o) => G.setUnitGrade(s, session, taskId, groupId, v, { ...o, now: new Date().toISOString() })),
  setGradeItem: actSess((s, session, itemId, studentId, v, o) => G.setItemGrade(s, session, itemId, studentId, v, { ...o, now: new Date().toISOString() })),
  excludeGradeTask: actSess((s, session, taskId, o) => G.excludeTask(s, session, taskId, { ...o, now: new Date().toISOString() })),
  includeGradeTask: actSess((s, session, taskId, o) => G.includeTask(s, session, taskId, { ...o, now: new Date().toISOString() })),
  setPersonalGradeWeights: actSess((s, session, studentId, w, o) => G.setPersonalWeights(s, session, studentId, w, { ...o, now: new Date().toISOString() })),
  clearPersonalGradeWeights: actSess(G.clearPersonalWeights),
  setGradeTaskWeights: actSess(G.setTaskWeights),
  // תשתית AI (ללא ספק אמיתי): מתג, הסגר, סבב בדיקה, החלטות על הצעות
  setAiEnabled: actSess(A.setAiEnabled),
  setAiQuarantine: actSess((s, session, id, on, opts) => A.setQuarantine(s, session, id, on, { ...opts, now: new Date().toISOString() })),
  startAiRound: actSess((s, session, id, d) => A.startRound(s, session, id, { ...d, now: new Date().toISOString() })),
  quarantineAiIfSuspicious: actSess((s, session, id, pages) => A.quarantineIfSuspicious(s, session, id, pages, { now: new Date().toISOString() })),
  anchorAiProposal: actSess(A.anchorProposal),
  makeAiProposalGeneral: actSess(A.makeProposalGeneral),
  approveAiProposal: actSess(A.approveProposal),
  rejectAiProposal: actSess(A.rejectProposal),
  // החזרה לתיקון וגרסאות מתוקנות
  returnForCorrection: actSess((s, session, id, d) => X.returnForCorrection(s, session, id, { ...d, now: new Date().toISOString() })),
  setCorrectionDue: actSess((s, session, id, due) => X.setCorrectionDue(s, session, id, due, { now: new Date().toISOString() })),
  reopenForReview: actSess((s, session, id) => X.reopenForReview(s, session, id, { now: new Date().toISOString() })),
  addCategory: actBank(R.addCategory),
  updateCategory: actBank(R.updateCategory),
  setCategoryArchived: actBank(R.setCategoryArchived),
  setProgress: actSess(T.setProgress),
  claimCompletion: actSess(T.claimCompletion),
  reviewCompletion: actSess(T.reviewCompletion),
  // התראות ותזכורות (המורה בלבד; ההרשאה נבדקת בלוגיקה)
  markNotifRead: actSess((s, session, ids, read = true) => N.markRead(s, session, ids, read, nowIso())),
  resolveNotifEvent: actSess((s, session, id) => N.resolveEvent(s, session, id, nowIso())),
  reopenNotifEvent: actSess(N.reopenEvent),
  setNotifSettings: actBankSess(N.setSettings),
  setTaskReminder: actSess(N.setTaskReminder),
  // בדיקת תזכורות לכל המחזורים הפעילים. day = תאריך לבדיקה (YYYY-MM-DD); בלי תאריך = היום. מכסת הדוא"ל משותפת לכל המחזורים.
  async runReminders(day) {
    const session = sess();
    const now = day ? `${day}T08:00:00` : nowIso();
    if (day && !T.D.valid(day)) throw new Error('תאריך לא תקין.');
    let root = get();
    let budget = emailBudgetLeft(root, now.slice(0, 10));
    const sum = { day: now.slice(0, 10), system: 0, email: 0, capped: 0 };
    for (const c of root.cycles.filter((x) => !x.archived)) {
      const r = N.runReminders(C.sliceOf(root, c.id), session, { now, emailBudget: budget });
      budget -= r.emailsUsed;
      sum.system += r.system; sum.email += r.email; sum.capped += r.capped;
      root = C.applyToCycle(root, c.id, () => r.state);
    }
    commit(root);
    lastRun = sum;
    return structuredClone(view());
  },
  getLastReminderRun: () => (lastRun ? { ...lastRun } : null),
  // קבוצת פעולות שנשמרות יחד (שמירה ברקע בלקוח): ההערות והפנקס בלבד. כל פעולה נבדקת לחוד: פעולה שנדחתה אינה פוגעת בשאר.
  // מוחזר המצב המעודכן ותוצאה לכל פעולה, בסדר שנשלחו. כשל אחסון זורק (ואז שום דבר לא נשמר והלקוח ינסה שוב).
  async applyBatch(ops) {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100) throw new Error('קבוצת פעולות לא תקינה.');
    const results = [];
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !BATCH_ACTIONS.has(op.action) || !Array.isArray(op.args)) { results.push({ ok: false, message: 'פעולה לא מותרת בקבוצה.' }); continue; }
      try { await api[op.action](...op.args); results.push({ ok: true }); } catch (e) { if (e instanceof SaveError) throw e; results.push({ ok: false, message: (e && e.message) || 'הפעולה נדחתה' }); }
    }
    return { state: structuredClone(view()), results };
  },
  // פנקס Notes אישי (המורה בלבד; ההרשאה נבדקת בלוגיקה). אינו חלק מנתוני מחזור.
  addNote: actBook((b, session, d) => NB.addNote(b, session, d, { now: nowIso() })),
  updateNote: actBook((b, session, id, patch) => NB.updateNote(b, session, id, patch, { now: nowIso() })),
  setNoteStatus: actBook((b, session, id, st) => NB.setStatus(b, session, id, st, { now: nowIso() })),
  deleteNote: actBook((b, session, id) => NB.deleteNote(b, session, id, { now: nowIso() })),
  restoreNote: actBook((b, session, id) => NB.restoreNote(b, session, id, { now: nowIso() })),
  purgeNote: actBook(NB.purgeNote),
  restoreNotesBackup: actBook((b, session, backup) => NB.restoreFromBackup(b, session, B.personalPartOf(backup), { now: nowIso() })),
  undoNotesRestore: actBook(NB.undoRestore),
  exportNotesBackup: async () => NB.personalBackup(get().notesBook, sess(), { now: nowIso() }),
  previewNotesRestore: async (backup) => NB.previewRestore(get().notesBook, sess(), B.personalPartOf(backup)),
  // ----- גיבוי ושחזור מחזור (שלב 7). הפנקס האישי נכלל בקובץ רק לפי בחירה, ושחזור מחזור אינו נוגע בו -----
  // ההורדה נרשמת (lastBackupAt), כדי שהמערכת תזכיר למורה גיבוי כשעבר שבוע (פתרון זמני עד גיבוי אוטומטי)
  exportCycleBackup: async ({ includePersonal = false } = {}) => { const b = B.makeBackup(get(), sess(), curId(), { includePersonal, now: nowIso() }); commit({ ...get(), lastBackupAt: nowIso() }); return b; },
  previewCycleRestore: async (backup) => B.previewRestore(get(), sess(), backup),
  async restoreCycleBackup(backup, { lateDecision, onStep } = {}) {
    const io = {
      getRoot: get, commit,
      fileExists: async (s) => { if (sim.failRestore) throw new Error('כשל מדומה בבדיקת הקבצים'); return !sim.missingFileIds.includes(s.id); },
      onStep,
    };
    // בשרת אמיתי: בדיקה מול האחסון בפועל (רשימת קבצים אחת), ולא הנחה שהכול קיים
    if (files && files.existenceChecker) { const exists = await files.existenceChecker(); io.fileExists = async (s) => exists(s); }
    try { await B.restoreCycle(io, sess(), backup, { lateDecision, now: nowIso() }); } finally { notify(); }
    return structuredClone(view());
  },
  // ----- תחזוקה (חלק 5ג): ניקוי העלאות יתומות ודיווח על העלאות שלא הושלמו. רק המורה. בלי שינוי בנתוני ההגשות.
  // runMaintenance אינה נועלת (עובדת רק על קבצים נפרדים) ולכן אינה מעכבת תלמידים; הרישום של ההתראות הוא פעולה נפרדת וקצרה.
  async runMaintenance({ dryRun = false } = {}) {
    if (!sess() || sess().role !== 'teacher') throw new Error('פעולה זו מיועדת למורה בלבד.');
    if (!files) return { scanned: 0, deleted: [], incomplete: [], referenced: 0, active: 0, keptGrace: 0, capped: false, unavailable: true };
    const r = await files.scanUploads({ referenced: M.referencedUploadIds(get()), nowMs: Date.now(), dryRun: !!dryRun });
    const root = get();
    const nameOf = (cycleId, bind, userId) => {
      const flat = C.sliceOf(root, cycleId);
      const st = flat.students.find((x) => x.id === userId);
      const task = flat.tasks.find((x) => x.id === (bind && bind.taskId));
      return { who: (st && st.name) || 'תלמיד', taskTitle: task ? task.title : '' };
    };
    r.incomplete = r.incomplete.map((u) => {
      const cycleId = (u.bind && u.bind.cycleId) || curId();
      let n = { who: 'תלמיד', taskTitle: '' };
      try { n = nameOf(cycleId, u.bind, u.userId); } catch (e) { /* מחזור שנמחק */ }
      return { ...u, ...n, cycleId };
    });
    return r;
  },
  // רישום התראה למורה על העלאות שלא הושלמו. מקבל רק מזהי העלאה, והפרטים נקראים מהאחסון (לא נלקחים מהלקוח).
  // התראה אחת מסכמת לכל מחזור (לא אחת לכל העלאה). העלאה שאחריה התלמיד הגיש בהצלחה באותה משימה אינה נספרת.
  // כשאין עוד העלאות כאלה, ההתראה (והתראות ישנות לכל העלאה) נסגרות מעצמן.
  async reportIncompleteUploads(uploadIds) {
    if (!sess() || sess().role !== 'teacher') throw new Error('פעולה זו מיועדת למורה בלבד.');
    const f = needFiles();
    if (!Array.isArray(uploadIds)) throw new Error('בקשה לא תקינה.');
    let root = get(); const now = nowIso(); let added = 0; let changed = false;
    const referenced = M.referencedUploadIds(root);
    const byCycle = {};
    for (const id of uploadIds.slice(0, 50)) {
      if (!/^[a-f0-9]{32}$/.test(String(id))) continue;
      if (referenced.has(id)) continue;
      let meta; try { meta = await f.meta(id); } catch (e) { continue; }
      const cycleId = meta.bind && meta.bind.cycleId;
      if (!cycleId || !root.cycles.some((c) => c.id === cycleId)) continue;
      const flat = C.sliceOf(root, cycleId);
      if (M.supersededBy(flat.submissions, meta)) continue;
      const st = flat.students.find((x) => x.id === meta.userId);
      const task = flat.tasks.find((x) => x.id === (meta.bind && meta.bind.taskId));
      if (!byCycle[cycleId]) byCycle[cycleId] = [];
      byCycle[cycleId].push({ id, who: (st && st.name) || 'תלמיד', fileName: meta.fileName, taskTitle: task ? task.title : '', sealed: !!meta.sealed, at: meta.startedAt || '' });
    }
    for (const c of root.cycles) {
      const items = (byCycle[c.id] || []).sort((a, b) => (a.at < b.at ? 1 : -1));
      let flat = C.sliceOf(root, c.id);
      const open = (flat.notifs || []).filter((n) => n.type === 'incomplete' && !n.resolvedAt);
      if (!items.length && !open.length) continue;
      const sig = items.map((x) => x.id).sort().join(',');
      const sum = open.find((n) => n.key === M.SUMMARY_KEY);
      let next = flat;
      // התראות ישנות, אחת לכל העלאה, נסגרות: ההתראה המסכמת מחליפה אותן
      const legacy = open.filter((n) => n.key !== M.SUMMARY_KEY);
      if (legacy.length || (!items.length && sum)) {
        next = structuredClone(next);
        for (const n of next.notifs) if (n.type === 'incomplete' && !n.resolvedAt && (n.key !== M.SUMMARY_KEY || !items.length)) { n.resolvedAt = now; n.read = true; if (!n.readAt) n.readAt = now; }
        changed = true;
      }
      if (items.length && !(sum && sum.refs && sum.refs.sig === sig)) {
        const ev = N.recordEvent(next, { type: 'incomplete', key: M.SUMMARY_KEY, refs: { sig }, text: M.incompleteSummaryText(items), now, emailBudget: 0 });
        next = ev.state;
        const n = next.notifs.find((x) => x.key === M.SUMMARY_KEY); n.refs = { sig }; n.count = 1;
        added++; changed = true;
      }
      if (next !== flat) root = C.applyToCycle(root, c.id, () => next);
    }
    if (changed) commit(root);
    return { added, changed };
  },
  attachHeld: async (id) => { commit(B.attachHeld(get(), sess(), id, { now: nowIso() })); return structuredClone(view()); },
  undoAutoBackup: async (id) => { commit(B.undoToAutoBackup(get(), sess(), id, { now: nowIso() })); return structuredClone(view()); },
  async relinkFile(subId) {
    if (sim.missingFileIds.includes(subId)) throw new Error('הקובץ עדיין לא נמצא ב-Drive (דמו). החזירו אותו ונסו שוב.');
    commit(B.relinkFile(get(), sess(), curId(), subId));
    return structuredClone(view());
  },
  getSession: sess,
  setSession: (s) => sessionPort.set(s),
};
return api;
}
