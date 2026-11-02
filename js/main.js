// ממשק המורה והתלמיד (דמו, נתוני דמה). כל הגישה לנתונים עוברת דרך api. בגרסה האמיתית api מדבר עם שרת Google.
import { api, remoteMode, config, serverUrl } from './api.js';
import { checkServerIdentity, setTrusted } from './teacher-identity.js';
import { uploadFile, downloadFile } from './file-client.js';
import * as L from './logic.js';
import * as T from './tasks.js';
import * as AE from './admin-events.js';
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
import { createWriteQueue, newClientId } from './write-queue.js';
import { applyPending, effectVisible } from './pending-view.js';
import { RISK_FLAGS } from './rubric-defaults.js';
import * as P from './privacy.js';
import { renderGantt, attachDrag, scrollToToday, scrollToDate, ZOOMS } from './gantt.js';
import { renderCalendar, shiftAnchor } from './calendar.js';

const $app = document.getElementById('app');
const $dlg = document.getElementById('dlg');
const $toast = document.getElementById('toast');
const esc = L.escapeHtml;
if (remoteMode) document.body.classList.add('remote'); // מסתיר כלי דמו (איפוס, הדמיות); השרת חוסם אותם גם בלי זה

let state = null;
let session = api.getSession();
let toastTimer = null;
const ui = {
  search: '', filter: 'all', gFilter: 'class', zoom: 3, calView: 'month', calDetail: 'points', calAnchor: T.D.today().slice(0, 8) + '01',
  openTask: null, sort: { key: 'name', dir: 1 }, taskFilter: 'all', taskTab: 'active', subTask: 'all', subStatus: 'needs', subSort: 'name', subDir: 'asc', rvFocus: null, rvFilter: 'all', aiOpen: false, aiForm: { rubric: '', prompt: '', oneTime: '', provider: 'mock', model: 'mock-1', confirmed: false }, aiScan: null, rvGhost: false, rvPrevOpen: false, reviewSub: null, fbSub: null, viewer: null, rvSel: null, rvEdit: null, rvActive: null, rvNew: null, rvOpen: new Set(), dirty: false, revertOnClose: null,
};

// הודעה קצרה; actions = [{label, fn}] מוסיף כפתורי קיצור (למשל "הצג בלוח השנה") וממתין זמן ארוך יותר.
function toast(msg, isErr = false, actions = []) {
  $toast.replaceChildren(document.createTextNode(msg));
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-btn';
    b.textContent = a.label;
    b.addEventListener('click', () => { $toast.className = 'toast'; a.fn(); });
    $toast.appendChild(b);
  });
  $toast.className = 'toast show' + (isErr ? ' err' : '') + (actions.length ? ' has-actions' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = 'toast'; }, actions.length ? 9000 : 3600);
}

// ---------- שמירה ברקע (הערות ו-Notes של המורה) ----------
// פעולה נרשמת מיד בתור (ובדפדפן) ונשמרת בשרת ברקע; "נשמר" מוצג רק אחרי אישור השרת. פירוט: write-queue.js
let wq = null; let vsMemo = { st: null, key: '', out: null }; let chipTimer = null;
function ensureQueue() {
  if (wq || !session || session.role !== 'teacher') return;
  const send = api.applyBatchWithId ? (id, ops) => api.applyBatchWithId(id, ops) : (id, ops) => api.applyBatch(ops);
  let storage = null; try { storage = window.localStorage; } catch (e) { /* בלי שמירה מקומית */ }
  wq = createWriteQueue({ send, storage, userKey: remoteMode ? 'remote' : 'demo', onChange: updateSaveChip, onSaved: (st) => { if (st) state = st; refreshAfterSave(); }, exists: effectVisible });
  wq.start();
}
// התצוגה: המצב מהשרת + מה שממתין בתור (או כשל). אותה לוגיקה טהורה כמו בשרת.
function vs() {
  if (!wq || !session || session.role !== 'teacher') return state;
  const ops = wq.pendingOps(); const failed = wq.failedOps();
  if (!ops.length && !failed.length) return state;
  const key = ops.map((o) => o.opId).join() + '|' + failed.map((o) => o.opId).join();
  if (vsMemo.st === state && vsMemo.key === key) return vsMemo.out;
  const out = applyPending(state, session, ops, failed);
  vsMemo = { st: state, key, out };
  return out;
}
function refreshReview() { if (ui.viewer) ui.viewer.setComments(reviewViewerComments()); renderReviewList(); }
function refreshAfterSave() {
  if (route() === 'review') { refreshReview(); return; }
  if (route() === 'notes' && !$dlg.open) { const a = document.activeElement; if (!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) render(); }
}
// פעולות אחרות (לא ברקע) מחכות שההערות הממתינות יישמרו, כדי שלא יפעלו על מצב חלקי (למשל שליחת משוב)
async function settleQueue() {
  if (!wq || !wq.pendingOps().length) return true;
  toast('ממתין לסיום שמירת ההערות...');
  await wq.drain();
  if (wq.pendingOps().length) { toast('ההערות עדיין לא נשמרו (ראו חיווי השמירה). הפעולה לא בוצעה.', true); return false; }
  return true;
}
function updateSaveChip(s) {
  let el = document.getElementById('saveChip');
  if (!el) { el = document.createElement('button'); el.id = 'saveChip'; el.type = 'button'; el.dataset.action = 'wq-open'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  clearTimeout(chipTimer);
  let text = ''; let cls = '';
  if (s.failed) { text = `⚠ השמירה נכשלה (${s.failed}). לחצו לטיפול`; cls = 'bad'; }
  else if (s.paused) { text = '⚠ ההתחברות פגה. יש להיכנס שוב; מה שלא נשמר ממתין במכשיר'; cls = 'bad'; }
  else if (s.pending) { text = `שומר... (${s.pending})${s.error ? ' · אין חיבור, מנסה שוב' : ''}`; cls = s.error ? 'warn' : ''; }
  else if (s.savedAt && Date.now() - s.savedAt < 3000) { text = '✓ נשמר'; cls = 'ok'; chipTimer = setTimeout(() => { if (wq) updateSaveChip(wq.status()); }, 3200); }
  el.textContent = text; el.className = 'save-chip ' + cls + (text ? ' show' : '');
}
function queueDialog() {
  if (!wq) return;
  const names = { addComment: 'הערה חדשה', updateComment: 'עריכת הערה', deleteComment: 'מחיקת הערה', addNote: 'Note חדש', updateNote: 'עריכת Note', setNoteStatus: 'שינוי סימון Note', deleteNote: 'מחיקת Note' };
  const rows = wq.failedOps().map((o) => {
    const a = o.args[0] || {};
    const txt = o.action === 'updateComment' || o.action === 'updateNote' ? (o.args[1] || {}).text : a.text;
    return `<div class="note"><div class="note-main"><div><b>${esc(names[o.action] || o.action)}</b> <span class="wbadge st-late">נכשלה</span></div><div class="muted">${esc(o.message || '')}</div>${txt ? `<div class="note-text">${esc(txt)}</div>` : ''}</div><div class="ntf-act"><button class="btn small primary" data-action="wq-retry" data-id="${esc(o.opId)}">נסה שוב</button><button class="btn small danger" data-action="wq-discard" data-id="${esc(o.opId)}">בטל</button></div></div>`;
  }).join('') || '<p class="muted">אין שמירות שנכשלו.</p>';
  showDlg(`<div class="form"><h2>שמירות שנכשלו ${helpIcon('pending-save')}</h2><p class="muted">הטקסט נשמר כאן ולא אבד. אפשר לנסות שוב או לבטל.</p>${rows}<div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}
// תחזוקה ברקע (מורה, שרת אמיתי): ניקוי העלאות יתומות והתראה על העלאות שלא הושלמו. לכל היותר פעם בכמה שעות, בלי לעכב את המסך.
// הפעולה אינה נועלת את השרת. כשל שקט: התחזוקה אינה חיונית לשימוש, ותנוסה שוב בכניסה הבאה.
let maintTimer = null;
const MAINT_KEY = 'gantt-maintenance-v2-at';
// הרצה אחת: ניקוי + רישום התראות. מחזירה סיכום קצר (גם לכפתור הידני).
async function maintenanceNow() {
  const r = await api.runMaintenance();
  try { window.localStorage.setItem(MAINT_KEY, String(Date.now())); } catch (e) { /* ללא אחסון */ }
  let out = null;
  if (r && r.incomplete) {
    // גם כשהרשימה ריקה: סוגר התראות ישנות שכבר אינן נכונות
    out = await api.reportIncompleteUploads(r.incomplete.map((x) => x.uploadId));
    if (out && (out.added || out.changed)) state = await api.getState();
  }
  return { r, out, changed: !!(out && (out.added || out.changed)) };
}
function scheduleMaintenance() {
  if (!remoteMode || !session || session.role !== 'teacher' || !api.runMaintenance || maintTimer) return;
  let last = 0;
  try { last = Number(window.localStorage.getItem(MAINT_KEY) || 0); } catch (e) { /* בלי אחסון מקומי */ }
  if (Date.now() - last < 6 * 3600 * 1000) return;
  maintTimer = setTimeout(async () => {
    try {
      const res = await maintenanceNow();
      if (res.changed && route() !== 'review') render();
    } catch (e) { /* ינוסה שוב בכניסה הבאה */ } finally { maintTimer = null; }
  }, 15000);
}
// כפתור ידני במרכז ההתראות: מריץ מיד ומציג תוצאה ברורה, כולל שגיאה אם יש
async function maintenanceManual() {
  toast('בודק העלאות שלא הושלמו...');
  try {
    const res = await maintenanceNow();
    state = await api.getState();
    const open = (state.notifs || []).filter((n) => n.type === 'incomplete' && !n.resolvedAt).length;
    if (res.r && res.r.unavailable) toast('הבדיקה אינה זמינה בשרת הזה', true);
    else toast(open ? 'יש העלאות שלא הושלמו ולא נקלטו כהגשה. ההתראה מעודכנת ברשימה.' : 'אין העלאות פתוחות שדורשות טיפול.');
  } catch (e) { toast('הבדיקה נכשלה: ' + (e.message || 'שגיאה לא ידועה'), true); }
  render();
}
window.addEventListener('beforeunload', (e) => { if (wq && wq.pendingOps().length) { e.preventDefault(); e.returnValue = ''; } });

async function run(fn, okMsg) {
  if (!(await settleQueue())) return false;
  try {
    state = await fn();
    if (okMsg) toast(okMsg);
    render();
    return true;
  } catch (e) {
    if (e && (e.code === 'unauthenticated' || e.code === 'access_ended')) { sessionLost(e.message); return false; }
    toast(e.message || 'הפעולה נכשלה', true);
    return false;
  }
}
// האסימון פג או שהגישה בוטלה בשרת: חוזרים למסך הכניסה
function sessionLost(msg) {
  session = null; state = null;
  render();
  toast(!msg || msg === 'יש להיכנס מחדש.' ? 'ההתחברות פגה (זה קורה אחרי כשעה). נא להיכנס שוב עם Google. שינויים שלא נשמרו ממתינים במכשיר ויישמרו אחרי הכניסה.' : msg, true);
}

const route = () => (location.hash.replace('#/', '') || 'home').split('?')[0];
const taskById = (id) => state.tasks.find((t) => t.id === id);
const pill = (g) => (g ? `<span class="pill"><span class="dot" style="background:${esc(g.color)}"></span>${esc(g.symbol)} ${esc(g.name)}</span>` : '<span class="muted">ללא קבוצה</span>');
const kindName = (k) => (k === 'personal' ? 'אישית' : 'קבוצתית');
const fmtD = (d) => (d ? d.split('-').reverse().join('.') : '');
const compl = { none: 'לא הושלם', claimed: 'ממתין לאישור המורה', approved: 'הושלם ואושר' };
const PROGRESS_EXPLAIN = 'אחוז ההתקדמות הוא הערכה שלך לגבי כמה מהמשימה כבר ביצעת. זה אינו ציון ואינו אישור שהמשימה הושלמה.';
const filterOf = (v) => (v === 'class' ? { type: 'class' } : v.startsWith('g:') ? { type: 'group', id: v.slice(2) } : { type: 'student', id: v.slice(2) });

// ---------- עזרה בהקשר: סימן (?) קטן שמציג הסבר קצר בלחיצה (עובד גם בטלפון) ----------
const HELP = {
  'archive-vs-trash': { title: 'ארכיון או סל?', html: '<p><b>ארכיון</b> הוא לשמירה: המחזור נשאר שלם ואפשר לעיין בו, אבל לא לשנות אותו (קריאה בלבד). תלמידים לא נכנסים אליו, אלא אם פתחת להם גישת צפייה. מתאים למחזור שהסתיים.</p><p><b>סל</b> הוא למחזור שהוא לא רוצה כבר: המחזור יוצא מהרשימה ונשמר בסל, ואפשר לשחזר אותו משם. מחיקה לצמיתות היא פעולה נפרדת, שאת/ה מבצע/ת בכוונה.</p><p class="muted">בשתי הפעולות נשמר קודם גיבוי אוטומטי, ושום דבר לא נמחק אוטומטית. קובצי ההגשות ב-Drive אינם נמחקים באף אחת מהן.</p>' },
};
HELP['internal-vs-send'] = { title: 'בדיקה פנימית או שליחת משוב?', html: '<p><b>בדיקה (פנימי)</b> היא סימון לעצמך: "סיימתי לבדוק", "טופל" והערת טיפול. אף אחד מהם לא נשלח לתלמידים.</p><p><b>משוב לתלמידים</b> הוא הפעולה היחידה שמפרסמת: רק בלחיצה על שליחה ההערות נעשות גלויות. הערות שנכתבו הן טיוטה עד אז.</p>' };
HELP['rubric-snapshot'] = { title: 'מה זה ניקוד פנימי?', html: '<p>הניקוד נעשה לפי המחוון שנקבע לסבב הבדיקה. שינוי מאוחר במחוון לא משנה בדיקה שכבר התחילה.</p><p>הניקוד אינו גלוי לתלמיד. תלמיד רואה רק ציון שלם שפרסמת לו במפורש.</p>' };
HELP['grade-scheme'] = { title: 'איך מחושב הציון הכולל?', html: '<p>הציון הכולל מחושב רק כשכל המשקלים מסתכמים ב-100% וכל מרכיב בעל משקל קיבל ציון. אחרת מוצג "לא מחושב" עם הסיבה.</p><p>העיגון נעשה פעם אחת בסוף (89.49 הופך ל-89, ו-89.50 הופך ל-90). שינוי ציון או משקל לא מפרסם דבר לתלמיד.</p>' };
HELP['backup-scope'] = { title: 'מה כולל הגיבוי?', html: '<p>הגיבוי כולל את נתוני הניהול של המחזור: תלמידים, קבוצות, משימות, הערות, ציונים והגדרות.</p><p>הוא <b>לא כולל את קובצי ההגשות</b>. מסמך שנמחק לצמיתות מ-Drive לא ישוחזר ממנו. פנקס ה-Notes נכלל רק אם סימנת, ושחזור מחזור לעולם לא נוגע בו.</p>' };
HELP['reminders'] = { title: 'איך עובדות התזכורות?', html: '<p>תזכורת נשלחת לתלמיד שטרם הגיש, לפי הימים שהגדרת ביחס למועד. היא נפסקת מעצמה כשמוגשת עבודה או כשהמועד זז.</p><p>בדוא"ל נשלח קישור בלבד, בלי ציון ובלי מידע רגיש. המכסה היומית מגבילה את הדוא"ל, והודעות במערכת תמיד נשלחות. בדמו אין שליחה אמיתית.</p>' };
HELP['cycles'] = { title: 'מה זה מחזור?', html: '<p><b>מחזור</b> הוא קבוצת תלמידים שעובדת על עבודת הגמר באותה שנה, עם התלמידים, הקבוצות, המשימות, ההגשות והציונים שלה.</p><p>אפשר לנהל כמה מחזורים. המחזור שנבחר בשורה העליונה הוא זה שרואים ועורכים. מחזור שהסתיים אפשר להעביר לארכיון (קריאה בלבד).</p>' };
HELP['task-bank'] = { title: 'מה זה בנק משימות?', html: '<p>הבנק הוא רשימת משימות מוכנות, משותפת לכל המחזורים שלך. "הוסף מהבנק" יוצר במחזור <b>עותק</b> של המשימה.</p><p>שינוי בעותק לא משנה את הבנק, ושינוי בבנק לא משנה עותקים שכבר נוספו למחזורים.</p>' };
HELP['rubric-assign'] = { title: 'שיוך מחוון למשימה', html: '<p>כאן קובעים לפי איזה מחוון תנקדו כל משימה. הבחירה יוצרת למשימה <b>עותק משלה</b> של המחוון, שאפשר לערוך בלי לשנות את מחוון הבסיס בספרייה.</p><p>ניקוד שכבר התחיל נשמר כמו שהוא גם אם תחליפו או תשנו את המחוון אחר כך.</p>' };
HELP['exceptions'] = { title: 'החרגה או ארכה?', html: '<p><b>ארכה</b> (בחלון המשימה) מזיזה רק את מועד ההגשה של קבוצה או תלמיד, ואינה משנה ציון.</p><p><b>החרגה</b> (במסך "ציונים") מוציאה משימה מחישוב הציון הכולל של תלמיד או קבוצה.</p><p class="muted">אם תלמיד פשוט לא הגיש, בדרך כלל מזינים ציון 0 ולא מחריגים.</p>' };
HELP['publish-retract'] = { title: 'פרסום וביטול פרסום', html: '<p>משוב וציון נשארים פנימיים עד שתלחצו על פרסום. רק אז התלמיד רואה אותם.</p><p><b>ביטול פרסום</b> מסיר את הפריט מהתלמיד, והתוכן וההיסטוריה נשמרים אצלכם. אפשר לפרסם שוב. מה שתלמיד כבר ראה אי אפשר למחוק.</p>' };
HELP['progress-vs-completion'] = { title: 'התקדמות או השלמה?', html: '<p><b>אחוז התקדמות</b> הוא הערכה של התלמיד או הקבוצה כמה כבר בוצע. זה אינו ציון.</p><p><b>השלמה</b> נחשבת רק אחרי שהמורה אישר אותה. תלמיד יכול לבקש אישור, והמורה מאשר או מחזיר לתיקון.</p>' };
HELP['pending-save'] = { title: 'מה זה "ממתין לשמירה"?', html: '<p>שינוי שעשיתם נשמר קודם במכשיר, ונשלח לשרת ברקע. עד שהשרת מאשר, הוא מסומן "ממתין לשמירה".</p><p>אפשר להמשיך לעבוד. אל תסגרו את הדף עד שהסימון נעלם. אם השמירה נכשלת תופיע הודעה, והטקסט לא אובד.</p>' };
HELP['restore-scope'] = { title: 'מה משחזר השחזור ומה לא?', html: '<p><b>משוחזר:</b> נתוני המחזור שנבחר: תלמידים, קבוצות, משימות, הגשות (כרשומות), הערות, מחוונים של המשימות וציונים.</p><p><b>לא משתנה בשחזור:</b> בנק המשימות (משותף לכל המחזורים), פנקס ה-Notes האישי (פעולה נפרדת), הגדרות ההתראות, וקובצי ההגשות עצמם ב-Drive. רשומת הגשה שהקובץ שלה נמחק מסומנת "קובץ חסר".</p><p class="muted">לפני כל שחזור נשמר גיבוי אוטומטי של המצב הנוכחי, ואפשר לחזור אליו.</p>' };
HELP['getting-started'] = { title: 'איך מתחילים?', html: '<p>סדר עבודה מומלץ במערכת:</p><ol><li><b>מחזור:</b> בדקו שם ותאריכים במסך "מחזור".</li><li><b>תלמידים וקבוצות:</b> הוסיפו תלמידים ושייכו אותם לקבוצות.</li><li><b>משימות:</b> החילו את תוכנית העבודה, או הוסיפו משימות מהבנק.</li><li><b>מחוונים:</b> במסך "מחוונים" שייכו מחוון לכל משימה שתנקדו.</li><li><b>הגשות ובדיקה:</b> כשתלמיד מגיש, תקבלו התראה. פתחו "בדיקה", הוסיפו הערות וניקוד.</li><li><b>משוב וציונים:</b> שלחו משוב לתלמידים ופרסמו ציון רק כשאתם מוכנים.</li><li><b>גיבוי:</b> הורידו גיבוי אחת לשבוע במסך "גיבוי ושחזור".</li></ol><p class="muted">בכל מסך יש סימני (?) עם הסבר קצר.</p>' };
function helpIcon(key) {
  return `<button type="button" class="help-q" data-action="help" data-h="${esc(key)}" aria-label="הסבר: ${esc(HELP[key].title)}" title="הסבר">?</button>`;
}
function helpDialog(key) {
  const h = HELP[key];
  if (!h) return;
  ui.openTask = null;
  showDlg(`<div class="form"><h2>${esc(h.title)}</h2>${h.html}<div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}

// ---------- כניסה ----------
// כניסה מול שרת: כפתור "התחברות עם Google" (ספריית הזהות של Google), ובשרת בדיקה מקומי גם כניסת בדיקה (test:<מייל>).
let gsiLoading = null;
function loadGsi() {
  if (window.google && window.google.accounts) return Promise.resolve();
  if (!gsiLoading) {
    gsiLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://accounts.google.com/gsi/client'; el.async = true;
      el.onload = resolve; el.onerror = () => { gsiLoading = null; reject(new Error('לא ניתן לטעון את כניסת Google')); };
      document.head.appendChild(el);
    });
  }
  return gsiLoading;
}
async function finishRemoteLogin(credential) {
  const host = document.getElementById('gsiBtn');
  if (host) host.innerHTML = '<p class="muted" role="status">מתחבר לשרת... בפעם הראשונה אחרי הפסקה זה יכול לקחת כמה שניות.</p>';
  try {
    session = await api.login(credential);
    state = (api.takeLoginState && api.takeLoginState()) || await api.getState(); // המצב חוזר עם הכניסה, בלי בקשה נוספת
    ensureQueue(); if (wq) wq.resume(); scheduleMaintenance();
    resetCycleView();
    location.hash = session.role === 'teacher' ? '#/home' : '';
    render();
  } catch (e) {
    toast(e.message || 'הכניסה נכשלה', true);
    if (credential && credential.idToken) renderRemoteLogin(); // nonce חדש לניסיון הבא
  }
}
// שער זהות: לפני כל כניסה לשרת של מורה, התלמיד רואה ומאשר את חשבון Google של בעל השרת (מאומת בחתימת Google). נכשל = אין כניסה.
// אינו חל על שרת בדיקה מקומי (testLogin). האישור נזכר בדפדפן; שינוי בדוא"ל מציג אזהרה.
let identityOk = false;
async function identityGate() {
  if (identityOk || config.testLogin) return true;
  $app.innerHTML = '<div class="login"><div class="card"><h1>מערכת ליווי פרויקט גמר</h1><p class="muted" role="status">בודק את זהות המורה…</p></div></div>';
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const r = await checkServerIdentity({ serverUrl, storage: store });
  if (r.state === 'trusted') { identityOk = true; return true; }
  const card = (inner) => { $app.innerHTML = `<div class="login"><div class="card"><h1>מערכת ליווי פרויקט גמר</h1>${inner}</div></div>`; };
  if (r.state === 'failed') {
    card('<div class="alert"><b>לא הצלחנו לאמת את זהות המורה.</b> מטעמי בטיחות לא נכנסים. בדקו את הקישור מול המורה, ונסו שוב בעוד דקה.</div><button class="btn" id="idRetry">נסו שוב</button>');
    document.getElementById('idRetry').addEventListener('click', () => renderRemoteLogin());
    return false;
  }
  const changed = r.state === 'changed';
  card(`${changed ? `<div class="alert"><b>שימו לב: חשבון המורה השתנה.</b> בפעם הקודמת אישרתם את <bdi dir="ltr">${esc(r.previous)}</bdi>. אם לא עודכנתם על שינוי, אל תמשיכו ופנו למורה בערוץ אחר.</div>` : ''}
    <p>המערכת הזאת מנוהלת על ידי חשבון Google:</p>
    <p style="font-size:1.2rem"><b><bdi dir="ltr">${esc(r.email)}</bdi></b></p>
    <p class="muted">זה אימות של Google, לא טענה של האתר. אשרו רק אם זו הכתובת של המורה שלכם. אם אתם לא בטוחים, שאלו את המורה לפני שתמשיכו.</p>
    <div class="dlg-actions"><button class="btn primary" id="idYes">${changed ? 'זה המורה שלי, המשך' : 'כן, זה המורה שלי'}</button> <button class="btn" id="idNo">לא, ביטול</button></div>`);
  return new Promise((resolve) => {
    document.getElementById('idYes').addEventListener('click', () => { if (store) setTrusted(store, serverUrl, r.email); identityOk = true; resolve(true); });
    document.getElementById('idNo').addEventListener('click', () => { card('<p>לא נכנסתם. סגרו את הדף וקבלו קישור מהמורה.</p>'); resolve(false); });
  });
}
async function renderRemoteLogin() {
  if (!(await identityGate())) return;
  $app.innerHTML = `
    <div class="login"><div class="card">
      <div><span class="badge-demo">${config.testLogin ? 'שרת בדיקה, נתוני דמה בלבד' : 'נתוני בדיקה בלבד'}</span></div>
      <h1>מערכת ליווי פרויקט גמר</h1>
      <p class="muted">הכניסה היא עם חשבון Google. מורה נכנס עם חשבון הבעלים של המערכת, ותלמיד עם החשבון שהמורה רשם.</p>
      <div id="gsiBtn" aria-live="polite"><span class="muted">טוען כניסה…</span></div>
      ${config.testLogin ? `<div class="form"><label>כניסת בדיקה (שרת מקומי בלבד)
        <input type="text" id="testCred" placeholder="test:student01@example.invalid" dir="ltr"></label>
        <button class="btn" data-action="remote-test-login">כניסת בדיקה</button></div>` : ''}
    </div></div>`;
  if (!config.googleClientId) { document.getElementById('gsiBtn').innerHTML = '<p class="muted">מזהה לקוח של Google לא הוגדר.</p>'; return; }
  try {
    const [nonce] = await Promise.all([api.loginNonce(), loadGsi()]);
    window.google.accounts.id.initialize({ client_id: config.googleClientId, nonce, callback: (r) => finishRemoteLogin({ idToken: r.credential, nonce }) });
    const host = document.getElementById('gsiBtn');
    if (host) { host.textContent = ''; window.google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'he' }); }
  } catch (e) {
    const host = document.getElementById('gsiBtn');
    if (host) host.innerHTML = '<p class="alert">' + esc(e.message || 'הכניסה אינה זמינה כרגע') + '</p>';
  }
}

function renderLogin() {
  if (remoteMode) { renderRemoteLogin(); return; }
  // אתר מרובה מורים: בלי קישור אישי של מורה אין שרת לפנות אליו, ולכן לא מציגים דמו אלא הסבר
  if (config.requireServer) {
    $app.innerHTML = '<div class="login"><div class="card"><h1>מערכת ליווי פרויקט גמר</h1><p>כדי להיכנס צריך את הקישור האישי שקיבלתם מהמורה.</p><p class="muted">אם אתם מורים ורוצים להצטרף למערכת, היכנסו לדף ההצטרפות.</p></div></div>';
    return;
  }
  const opts = state.loginOptions || [];
  const multi = new Set(opts.map((o) => o.cycleId)).size > 1;
  $app.innerHTML = `
    <div class="login"><div class="card">
      <div><span class="badge-demo">דמו, נתוני דמה בלבד</span></div>
      ${state.accessEnded ? '<div class="alert"><b>המחזור נסגר או אינו זמין לתלמידים.</b> ההתחברות הסתיימה. אם צריך גישה, פנו למורה.</div>' : ''}
      <h1>מערכת ליווי פרויקט גמר</h1>
      <p class="muted">בגרסה האמיתית הכניסה היא עם חשבון Google. כאן אפשר לבחור תפקיד כדי להתנסות.</p>
      <button class="btn primary" data-action="login-teacher">כניסה כמורה</button>
      <div class="form">
        <label>כניסה כתלמיד
          <select id="loginStudent">${opts.map((o) => `<option value="${esc(o.cycleId)}|${esc(o.id)}" ${o.hint ? 'selected' : ''}>${o.hint ? '⭐ ' : ''}${esc(o.name)}${multi ? ` (${esc(o.cycleName)})` : ''}${o.hint ? ' - מומלץ לבדיקת הגשה' : ''}</option>`).join('')}</select>
        </label>
        ${opts.some((o) => o.hint) ? '<p class="muted">לבדיקת הגשה: התלמיד המסומן ב-⭐ מסומן כבר. יש לו משימת הגשה קבוצתית ("הצעת מחקר") ומשימת הגשה אישית ("סיכום אישי קצר").</p>' : ''}
        <button class="btn" data-action="login-student">כניסה כתלמיד</button>
        <button class="btn small" data-action="reset-demo" title="מחזיר את נתוני הדמה למצב ההתחלתי">איפוס נתוני דמה</button>
      </div>
    </div></div>`;
}

// ---------- בורר מחזור ----------
// בראש כל מסך של המורה. המעבר בין מחזורים מציג בכל המסכים רק את נתוני המחזור שנבחר.
function cycleBar() {
  const cyc = state.cycles.find((c) => c.id === state.activeCycleId);
  return `<div class="cyclebar" role="group" aria-label="מחזור לימודים">
    <label for="cycleSel"><b>מחזור:</b></label>${helpIcon('cycles')}
    <select id="cycleSel">${state.cycles.map((c) => `<option value="${esc(c.id)}" ${c.id === state.activeCycleId ? 'selected' : ''}>${esc(c.name)}${c.archived ? ' (ארכיון)' : ''}</option>`).join('')}</select>
    <button class="btn small" data-action="new-cycle">+ מחזור חדש</button>
    <button class="btn small" data-action="toggle-archive" data-id="${esc(state.activeCycleId)}">${cyc && cyc.archived ? 'החזר לפעיל' : 'העבר לארכיון'}</button>
  </div>`;
}

function resetCycleView() {
  Object.assign(ui, { gFilter: 'class', taskFilter: 'all', taskTab: 'active', filter: 'all', search: '', scrolled: false });
  const st = state.cycle && state.cycle.start ? state.cycle.start : T.D.today();
  ui.calAnchor = st.slice(0, 8) + '01';
}

async function switchCycle(id) {
  if (!(await run(() => api.setActiveCycle(id)))) return;
  resetCycleView();
  render();
}

function newCycleDialog() {
  openDialog(`<h2>מחזור חדש</h2>
    <p class="muted">מחזור חדש מתחיל ריק, עם תלמידים, קבוצות ומשימות משלו. בנק המשימות משותף, ואפשר להחיל אותו על המחזור החדש.</p>
    <label>שם המחזור <input type="text" name="name" required placeholder="למשל: מחזור תשפ&quot;ט"></label>
    <div class="row2"><label>תחילת המחזור <input type="date" name="start"></label><label>יעד סיום כתיבה <input type="date" name="end"></label></div>
    <label>מועד הגנה משוער <input type="date" name="defenseDate"></label>`,
  async (f) => {
    const ok = await run(() => api.addCycle(fd(f)), 'המחזור נוצר ונבחר. הוא ריק: אפשר להוסיף תלמידים ולהחיל את בנק המשימות');
    if (ok) { resetCycleView(); location.hash = '#/home'; render(); }
    return ok;
  });
}

// ---------- ניווט ראשי בקבוצות ----------
// הסדר משקף את תהליך העבודה: התלמיד מגיש, המורה בודק ונותן משוב וציון, ואז מחליט מה לפרסם.
// "הגשות ובדיקה" הוא מסך אחד לתהליך: רשימת ההגשות, ומשם פתיחה ישירה למסך הבדיקה (גם route=review שייך לו).
const NAV_KEY = 'gantt-nav-open-v1';
const NAV_ICONS = { home: '🏠', notifications: '🔔', notes: '📝', cycle: '📅', gantt: '📊', calendar: '🗓️', tasks: '✅', template: '🧱', vacations: '🏖️', students: '👥', groups: '🧩', submissions: '📥', grades: '🎯', rubrics: '📐', backup: '💾' };
const navGroups = () => [
  { id: 'main', title: 'ראשי ומעקב', items: [
    { id: 'home', label: 'בית' },
    { id: 'notifications', label: 'התראות', badge: N.notifCounts(state).unread, badgeLabel: 'לא נקראו' },
    { id: 'notes', label: 'פנקס Notes', badge: NB.todoCount(vs().notesBook), badgeLabel: 'Notes שדורשים טיפול', soft: true },
  ] },
  { id: 'plan', title: 'תכנון וניהול', items: [
    { id: 'cycle', label: 'מחזור' },
    { id: 'gantt', label: 'גאנט' },
    { id: 'calendar', label: 'לוח שנה' },
    { id: 'tasks', label: 'משימות' },
    { id: 'template', label: 'בנק משימות ותבניות' },
    { id: 'vacations', label: 'חופשות' },
    { id: 'students', label: 'תלמידים' },
    { id: 'groups', label: 'קבוצות' },
  ] },
  { id: 'assess', title: 'הגשות והערכה', items: [
    { id: 'submissions', label: 'הגשות ובדיקה', also: ['review'] },
    { id: 'grades', label: 'ציונים' },
    { id: 'rubrics', label: 'מחוונים' },
  ] },
  { id: 'system', title: 'ניהול מערכת', items: [
    { id: 'backup', label: 'גיבוי ושחזור' },
  ] },
];
const navOpenSet = () => {
  try { const v = JSON.parse(localStorage.getItem(NAV_KEY)); if (v && typeof v === 'object') return v; } catch (e) { /* ברירת מחדל: הכול פתוח */ }
  return {};
};
const navIsOpen = (g) => navOpenSet()[g.id] !== false;
function navToggle(id) {
  const o = navOpenSet();
  o[id] = o[id] === false;
  try { localStorage.setItem(NAV_KEY, JSON.stringify(o)); } catch (e) { /* המצב לא יישמר */ }
}
function navHtml(r) {
  return navGroups().map((g) => {
    const activeIn = g.items.some((i) => i.id === r || (i.also || []).includes(r));
    const open = navIsOpen(g);
    const hidden = g.items.reduce((n, i) => n + (i.badge || 0), 0);
    const items = g.items.map((i) => {
      const act = i.id === r || (i.also || []).includes(r);
      const badge = i.badge ? ` <span class="nbadge${i.soft ? ' nb-soft' : ''}" title="${esc(i.badgeLabel)}" aria-label="${i.badge} ${esc(i.badgeLabel)}">${i.badge}</span>` : '';
      return `<a href="#/${i.id}" class="${act ? 'active' : ''}" ${act ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${NAV_ICONS[i.id] || ''}</span><span class="nav-label">${esc(i.label)}</span>${badge}</a>`;
    }).join('');
    return `<div class="nav-group ${activeIn ? 'has-active' : ''}">
      <button type="button" class="nav-head" data-action="nav-toggle" data-id="${g.id}" aria-expanded="${open}" aria-controls="nav-${g.id}"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span><span>${esc(g.title)}</span>${!open && hidden ? ` <span class="nbadge nb-soft" aria-label="${hidden} פריטים דורשים תשומת לב">${hidden}</span>` : ''}</button>
      <div class="nav-items" id="nav-${g.id}" ${open ? '' : 'hidden'}>${items}</div>
    </div>`;
  }).join('');
}

// ---------- מסגרת ----------
function shell(title, body, actions = '') {
  const r = route();
  return `
  <div class="shell">
    <aside class="side">
      <div class="brand">מערכת ליווי</div>
      <nav class="nav" aria-label="ניווט ראשי">
        ${navHtml(r)}
      </nav>
      <div class="grow"></div>
      <button class="btn small" data-action="reset-demo">איפוס נתוני דמה</button>
      <button class="btn small" data-action="logout">יציאה</button>
    </aside>
    <main class="main">
      ${cycleBar()}
      <div class="topbar"><h1>${title}</h1><span class="sp"></span>${state.archived ? '' : actions}<button type="button" class="btn small" data-action="help" data-h="getting-started" title="סדר העבודה במערכת">❓ איך מתחילים?</button><span class="badge-demo">דמו</span></div>
      ${state.archived ? '<div class="alert archived-note"><b>🗄️ המחזור בארכיון: לקריאה בלבד.</b> אפשר לעיין בכל הנתונים, אך לא לשנות אותם. כדי לערוך, החזר את המחזור לפעיל בשורת המחזור למעלה.</div>' : ''}
      ${body}
      <button class="fab-note" data-action="note-new" title="Note אישי חדש. אפשר לגרור למקום נוח; לחיצה ימנית (או לחיצה ארוכה בטלפון) מאפסת את המיקום">📝 Note חדש</button>
    </main>
  </div>`;
}

// ---------- בית ----------
function viewHome() {
  const st = L.stats(state);
  const unassigned = state.students.filter((s) => s.active && !L.currentGroupId(state, s.id));
  const emptyGroups = state.groups.filter((g) => L.membersOf(state, g.id).length === 0);
  const pending = [];
  T.orderedTasks(state).forEach((t) => T.completionSummary(state, t).units.filter((u) => u.completion === 'claimed').forEach((u) => pending.push({ t, u })));
  const alerts = [];
  const unreadN = N.notifCounts(state).unread;
  if (unreadN) alerts.push(`<div class="alert" style="border-inline-start-color:var(--brand)"><b>🔔 ${unreadN} התראות חדשות.</b> <a href="#/notifications">למרכז ההתראות</a></div>`);
  if (pending.length) alerts.push(`<div class="alert"><b>⏳ ${pending.length} בקשות השלמה ממתינות לאישור שלך:</b> ${pending.slice(0, 4).map((p) => `<a href="#/gantt" data-open-task="${esc(p.t.id)}">${esc(p.t.title)} (${esc(p.u.name)})</a>`).join(', ')}.<br><span class="muted">מה לעשות: לפתוח את המשימה ולאשר את ההשלמה, או להחזיר לתיקון. <a href="#/tasks" data-ui="taskFilter=pending">לרשימת הבקשות</a></span></div>`);
  if (unassigned.length) alerts.push(`<div class="alert"><b>${unassigned.length} תלמידים פעילים ללא קבוצה:</b> ${unassigned.map((s) => esc(s.name)).join(', ')}. <a href="#/students">לשיוך</a></div>`);
  if (emptyGroups.length) alerts.push(`<div class="alert"><b>${emptyGroups.length} קבוצות ריקות:</b> ${emptyGroups.map((g) => esc(g.name)).join(', ')}. <a href="#/groups">לקבוצות</a></div>`);
  const ss = S.trackerSummary(S.trackerRows(state, { now: nowIso() }));
  if (remoteMode) {
    const days = state.lastBackupAt ? Math.floor((Date.now() - Date.parse(state.lastBackupAt)) / 86400000) : null;
    if (days === null || days >= 7) alerts.push(`<div class="alert"><b>💾 ${days === null ? 'עדיין לא הורד גיבוי.' : `הגיבוי האחרון הורד לפני ${days} ימים.`}</b> מומלץ להוריד גיבוי אחת לשבוע ולשמור אותו מחוץ למערכת.<br><span class="muted"><a href="#/backup">למסך גיבוי ושחזור</a></span></div>`);
  }
  if (ss.conversionFailed) alerts.push(`<div class="alert"><b>⚠ ${ss.conversionFailed} הגשות עם כשל בהמרה ל-PDF.</b> ההגשות נקלטו וחותמת הזמן שלהן נשמרה.<br><span class="muted">מה לעשות: לנסות המרה שוב או לבקש PDF נוסף. <a href="#/submissions" data-ui="subStatus=failed">להגשות</a></span></div>`);
  if (ss.missingLate) alerts.push(`<div class="alert"><b>🔴 ${ss.missingLate} קבוצות או תלמידים לא הגישו אחרי המועד.</b> <a href="#/submissions" data-ui="subStatus=missing">לרשימה</a></div>`);
  const oqs = F.openQuestions(state);
  if (oqs.length) alerts.push(`<div class="alert"><b>❓ ${oqs.length} שאלות הבהרה מתלמידים ממתינות לתשובה.</b> ${oqs.slice(0, 3).map((x) => `<button class="btn small" data-action="open-question" data-id="${esc(x.comment.id)}">${esc(studentNameOf(x.question.authorId))}: ${esc(x.question.text.slice(0, 26))}…</button>`).join(' ')}<br><span class="muted">לחיצה על שאלה פותחת אותה ישירות, ושם אפשר לענות.</span></div>`);
  const toReview = S.trackerRows(state, { now: nowIso() }).filter((r) => r.latest && F.attentionReasons(state, r.latest, r.completion).includes('review')).length;
  if (toReview) alerts.push(`<div class="alert" style="border-inline-start-color:var(--brand)"><b>📥 ${toReview} הגשות ממתינות לבדיקה שלך.</b> <a href="#/submissions" data-ui="subStatus=needs">לרשימת ההגשות</a></div>`);
  const fixedN = S.trackerRows(state, { now: nowIso() }).filter((r) => r.correctionState === 'submitted').length;
  if (fixedN) alerts.push(`<div class="alert" style="border-inline-start-color:var(--brand)"><b>🔁 ${fixedN} גרסאות מתוקנות הוגשו.</b> <span class="muted">לידיעתך. הן אינן ממתינות לבדיקה, ואפשר לפתוח אותן לבדיקה חוזרת אם תרצה.</span> <a href="#/submissions" data-ui="subStatus=fixed">להצגה</a></div>`);
  const toSend = F.sendableBatch(state).length;
  if (toSend) alerts.push(`<div class="alert"><b>📤 ${toSend} עבודות סומנו "סיימתי לבדוק" וטרם נשלח משוב על הערותיהן.</b> <a href="#/submissions">להגשות</a><br><span class="muted">הערות טיוטה אינן גלויות לתלמידים עד שליחה מפורשת.</span></div>`);
  const viol = T.dependencyViolations(state);
  if (viol.length) alerts.push(`<div class="alert"><b>⛔ ${viol.length} אזהרות תכנון (תלויות שבורות):</b> משימה מתחילה לפני שהקודמת הסתיימה.<br><span class="muted">מה לעשות: להזיז אחת מהמשימות בגאנט או לערוך את התלויות. <a href="#/gantt">לגאנט</a></span></div>`);
  if (!state.cycle || !state.cycle.start) alerts.push('<div class="alert">לא הוגדרו תאריכי מחזור. <a href="#/cycle">להגדרה</a></div>');
  const upcoming = T.orderedTasks(state).filter((t) => t.due >= T.D.today()).sort((a, b) => (a.due < b.due ? -1 : 1)).slice(0, 4);
  const adminUp = AE.upcomingAdminEvents(state, T.D.today());
  const adminMissing = AE.missingKinds(state);
  const adminCard = `<div class="card" id="adminCard"><h2>📌 תזכורות מנהלתיות</h2>
      <p class="muted adm-note">תזכורות אישיות שלך בלבד: הן אינן משימות, לא נראות לתלמידים ולא משפיעות על ציונים. המועדים גמישים וניתנים לעריכה.</p>
      ${adminUp.length ? `<ul class="adm-list">${adminUp.map((e) => `<li class="${e.status}"><span class="adm-t"><button class="btn small" data-admin="${esc(e.id)}" title="עריכה">✏️</button> <b>${esc(e.title)}</b><br><span class="muted">${fmtD(e.start)} עד ${fmtD(e.end)}${e.status === 'overdue' ? ' · <b style="color:var(--bad)">החלון הסתיים ולא סומן כבוצע</b>' : e.status === 'open' ? ' · <b>החלון פתוח עכשיו</b>' : ''}</span></span><button class="btn small" data-action="adm-done" data-id="${esc(e.id)}">סימון כבוצע</button></li>`).join('')}</ul>` : '<p class="muted">אין תזכורות פתוחות.</p>'}
      ${adminMissing.length ? '<button class="btn small" data-action="adm-add-defaults">הוסף אירועים מנהלתיים</button>' : ''}
    </div>`;
  return shell(esc(state.cycle ? state.cycle.name : 'מחזור'), `
    <div class="credit">פותח על ידי אורי העליון</div>
    <div class="grid-stats">
      <a class="stat" href="#/students" data-ui="filter=active" title="לרשימת התלמידים"><div class="n">${st.active}</div>תלמידים פעילים</a>
      <a class="stat" href="#/groups" title="לקבוצות"><div class="n">${st.groups}</div>קבוצות</a>
      <a class="stat" href="#/tasks" data-ui="taskTab=active" title="לרשימת המשימות הפעילות"><div class="n">${T.orderedTasks(state).length}</div>משימות בתוכנית</a>
      <a class="stat ${pending.length ? 'warn' : ''}" href="#/tasks" data-ui="taskFilter=pending" title="לבקשות הממתינות לאישור"><div class="n">${pending.length}</div>ממתינות לאישור</a>
      <a class="stat ${st.unassigned ? 'warn' : ''}" href="#/students" data-ui="filter=unassigned" title="לתלמידים ללא קבוצה"><div class="n">${st.unassigned}</div>ללא קבוצה</a>
    </div>
    <p class="muted intro">מסך הבית מראה מה דורש את תשומת לבך עכשיו: הגשות לבדיקה, בקשות אישור, התראות ותלמידים בלי קבוצה. ההתחלה הטובה היא מהרשימה הזו.</p>
    ${alerts.join('') || '<div class="alert" style="border-inline-start-color:var(--ok)">הכול מסודר.</div>'}
    ${adminCard}
    <div class="card"><h2>משימות קרובות</h2>
      ${upcoming.length ? `<ul class="plain">${upcoming.map((t) => `<li><a href="#/gantt" data-open-task="${esc(t.id)}">${esc(t.title)}</a> <span class="muted">(${kindName(t.kind)}, עד ${fmtD(t.due)})</span></li>`).join('')}</ul>` : '<p class="muted">אין משימות קרובות. אפשר להחיל את תבנית המשימות.</p>'}
      <a class="btn primary" href="#/gantt">לגאנט</a>
    </div>`);
}

// ---------- גאנט ----------
function filterSelect(id, value, withAll = true) {
  return `<select id="${id}" aria-label="סינון תצוגה">
    ${withAll ? `<option value="class" ${value === 'class' ? 'selected' : ''}>כל הכיתה</option>` : ''}
    <optgroup label="קבוצה">${state.groups.map((g) => `<option value="g:${esc(g.id)}" ${value === 'g:' + g.id ? 'selected' : ''}>${esc(g.symbol)} ${esc(g.name)}</option>`).join('')}</optgroup>
    <optgroup label="תלמיד">${state.students.filter((s) => s.active).map((s) => `<option value="s:${esc(s.id)}" ${value === 's:' + s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</optgroup>
  </select>`;
}

function viewGantt() {
  const f = filterOf(ui.gFilter);
  const editable = f.type === 'class' && !state.archived;
  return shell('גאנט', `
    <div class="toolbar">
      ${filterSelect('gFilter', ui.gFilter)}
      <button class="btn small" data-action="zoom-out" aria-label="הקטנה">−</button>
      <button class="btn small" data-action="zoom-in" aria-label="הגדלה">+</button>
      <button class="btn small" data-action="g-today">היום</button>
      ${editable ? '<button class="btn small" data-action="shift-class">שינוי מועד כיתתי</button>' : '<span class="muted">תצוגה לפי יחידה (לקריאה). לשינוי תאריכים עבור לתצוגת "כל הכיתה".</span>'}
    </div>
    <div class="legend"><span><i class="lg k-group"></i> משימה קבוצתית</span><span><i class="lg k-personal"></i> משימה אישית</span><span><i class="lg k-exc"></i> ארכה נקודתית</span>
      ${Object.values(T.WARNING_KINDS).map((w) => `<span title="${esc(w.help)}">${w.icon} ${esc(w.label)}</span>`).join('')}<span title="ההשלמה אושרה על ידי המורה">✔ הושלם ואושר</span><span title="תזכורת מנהלתית למורה בלבד: אינה משימה ואינה משפיעה על ציונים">📌 תזכורת למורה</span>
      <button class="btn small" data-action="explain-warnings">ⓘ הסבר על הסמלים</button></div>
    <div class="card gwrap">${renderGantt(state, { filter: f, zoom: ZOOMS[ui.zoom], editable })}</div>
    <p class="muted">${editable ? 'אפשר לגרור פס כדי להזיז אותו, ולגרור את קצותיו כדי לשנות התחלה או סיום. לחיצה על פס פותחת פרטים.' : ''}</p>`,
  editable ? '<button class="btn primary" data-action="add-task">+ משימה חדשה</button>' : '');
}

// מחזור בארכיון הוא לקריאה בלבד: מסירים כפתורי עריכה ומנטרלים שדות, במקום להציג פעולות שמובילות לשגיאה.
// עריכת הבנק המשותף (tpl-*) אינה נוגעת בנתוני המחזור ולכן נשארת.
const WRITE_ACTIONS = new Set(['notif-read', 'notif-unread', 'notif-read-all', 'notif-resolve', 'notif-reopen', 'rem-run', 'rem-task-edit', 'pub-grade', 'retract-grade', 'retract-fb', 'rv-retract', 'gr-pub-overall', 'gr-retract-overall', 'gr-pub-overall-all', 'gr-pub-task', 'gr-retract-task', 'gr-group-grade', 'gr-scheme-edit', 'gr-tpl-apply', 'gr-exclude', 'gr-weights', 'gr-include', 'gr-pw-clear', 'sc-setgrade', 'rb-task-edit', 'rb-task-remove', 'ai-toggle', 'ai-quarantine', 'ai-scan', 'ai-run', 'ai-anchor', 'ai-general', 'ai-approve', 'ai-reject', 'rv-return', 'rv-reopen', 'rv-due-save', 'reopen-fix', 'rv-check', 'rv-note-save', 'rv-send', 'rv-reply', 'rv-answer', 'fb-batch', 'rv-add', 'rv-edit', 'rv-save', 'rv-del', 'sub-retry', 'sub-request-pdf', 'task-up', 'task-down', 'deactivate', 'reactivate', 'del-task', 'save-task', 'add-exc', 'rm-exc', 'review', 'bank-add', 'bank-reactivate', 'apply-template', 'add-task', 'add-vac', 'del-vac', 'adm-done', 'adm-add-defaults', 'adm-del', 'edit-student', 'toggle-active', 'add-student', 'edit-group', 'delete-group', 'remove-member', 'add-group', 'shift-class', 'add-link', 'rm-link']);
function lockArchived(root) {
  if (!state || !state.archived || !session || session.role !== 'teacher') return;
  root.querySelectorAll('[data-action]').forEach((el) => {
    const a = el.dataset.action;
    if (WRITE_ACTIONS.has(a)) el.remove();
    else if (a === 'assign' || a === 'add-to-group' || a === 'rb-assign') el.disabled = true;
  });
  root.querySelectorAll('details.more').forEach((d) => { if (!d.querySelector('.menu button')) d.remove(); }); // תפריט "עוד" שנותר ריק
  root.querySelectorAll('#taskForm input, #taskForm select, #taskForm textarea, input[data-prog], #cycleForm input, #rvNote, .gr-in').forEach((el) => { el.disabled = true; });
  root.querySelectorAll('#cycleForm button[type=submit], .links-editor > button, .link-warn, .rv-write').forEach((el) => el.remove());
}

// ---------- כפתור "Note חדש" צף וניתן להזזה ----------
// המיקום נשמר בדפדפן הזה בלבד (localStorage), נשאר בתוך המסך, ואיפוס בלחיצה ימנית (או לחיצה ארוכה בטלפון).
const FAB_KEY = 'gantt-fab-pos-v1';
const fabPos = () => { try { const p = JSON.parse(localStorage.getItem(FAB_KEY)); return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null; } catch (e) { return null; } };
const fabSave = (p) => { try { p ? localStorage.setItem(FAB_KEY, JSON.stringify(p)) : localStorage.removeItem(FAB_KEY); } catch (e) { /* המיקום לא יישמר, והכפתור עדיין פועל */ } };
function fabPlace(el, x, y) {
  const m = 8;
  const px = Math.min(Math.max(m, x), Math.max(m, window.innerWidth - el.offsetWidth - m));
  const py = Math.min(Math.max(m, y), Math.max(m, window.innerHeight - el.offsetHeight - m));
  Object.assign(el.style, { left: px + 'px', top: py + 'px', right: 'auto', bottom: 'auto' });
  return { x: px, y: py };
}
function applyFabPos() {
  const el = document.querySelector('.fab-note');
  const p = fabPos();
  if (el && p) fabPlace(el, p.x, p.y);
}
{
  let drag = null;
  document.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.fab-note');
    if (!el || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const r = el.getBoundingClientRect();
    drag = { el, dx: ev.clientX - r.left, dy: ev.clientY - r.top, sx: ev.clientX, sy: ev.clientY, moved: false, id: ev.pointerId };
  });
  document.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 6) return; // תזוזה קטנה = לחיצה
    if (!drag.moved) { drag.moved = true; drag.el.setPointerCapture(ev.pointerId); drag.el.classList.add('dragging'); }
    ev.preventDefault();
    drag.pos = fabPlace(drag.el, ev.clientX - drag.dx, ev.clientY - drag.dy);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('dragging');
    if (d.moved) { if (d.pos) fabSave(d.pos); ui.fabDragged = true; setTimeout(() => { ui.fabDragged = false; }, 80); } // מונע פתיחת Note בסיום גרירה
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest && ev.target.closest('.fab-note');
    if (!el) return;
    ev.preventDefault();
    fabSave(null);
    el.removeAttribute('style');
    toast('מיקום הכפתור אופס');
  });
  window.addEventListener('resize', applyFabPos);
}

function afterRender() {
  lockArchived($app);
  applyFabPos();
  syncStickyTop();
  if (route() !== 'review' && ui.viewer) { ui.viewer.destroy(); ui.viewer = null; }
  if (route() === 'review') initReview();
  if (route() === 'gantt' && session && session.role === 'teacher') {
    const f = filterOf(ui.gFilter);
    attachDrag($app, state, f, {
      onOpen: (id) => taskDialog(id),
      onChange: (id, start, due, revert) => requestDateChange(id, start, due, revert),
    });
    if (!ui.scrolled) { scrollToToday($app); ui.scrolled = true; }
  }
}

// ---------- לוח שנה ----------
function viewCalendar() {
  const f = filterOf(ui.gFilter);
  const { title, html } = renderCalendar(state, { filter: f, view: ui.calView, anchor: ui.calAnchor, detail: ui.calDetail });
  const unit = ui.calView === 'week' ? 'השבוע' : 'החודש';
  return shell('לוח שנה', `
    <div class="toolbar">
      ${filterSelect('gFilter', ui.gFilter)}
      <button class="btn small" data-action="cal-prev">→ ${unit} הקודם</button>
      <strong>${esc(title)}</strong>
      <button class="btn small" data-action="cal-next">${unit} הבא ←</button>
      <button class="btn small" data-action="cal-today">היום</button>
      <select id="calView" aria-label="תצוגה"><option value="month" ${ui.calView === 'month' ? 'selected' : ''}>חודשי</option><option value="week" ${ui.calView === 'week' ? 'selected' : ''}>שבועי</option></select>
      <select id="calDetail" aria-label="רמת פירוט"><option value="points" ${ui.calDetail === 'points' ? 'selected' : ''}>מועדי הגשה בלבד</option><option value="full" ${ui.calDetail === 'full' ? 'selected' : ''}>כולל משך המשימות</option></select>
    </div>
    <p class="muted cal-note">${ui.calDetail === 'points' ? '⏰ מסמן מועד הגשה של משימה. כדי לראות גם את כל הימים שבהם המשימה פעילה, בחר "כולל משך המשימות". משך המשימות המלא מוצג תמיד בגאנט.' : '▶ תחילת משימה, ⏰ מועד הגשה. המשימה מופיעה בכל יום שבו היא פעילה.'}</p>
    ${html}`);
}

// ---------- משימות ----------
function viewTasks() {
  const all = T.orderedTasks(state);
  const inactive = T.inactiveTasks(state);
  const tab = ui.taskTab === 'inactive' ? 'inactive' : 'active';
  const tabs = `<div class="tabs" role="tablist" aria-label="משימות פעילות ולא פעילות">
    <button role="tab" class="tab ${tab === 'active' ? 'on' : ''}" aria-selected="${tab === 'active'}" data-action="task-tab" data-tab="active">משימות פעילות (${all.length})</button>
    <button role="tab" class="tab ${tab === 'inactive' ? 'on' : ''}" aria-selected="${tab === 'inactive'}" data-action="task-tab" data-tab="inactive">משימות לא פעילות (${inactive.length})</button></div>`;
  const addBtns = '<button class="btn" data-action="bank-add">+ מהבנק</button><button class="btn" data-action="apply-template">החל תוכנית עבודה מלאה</button><button class="btn primary" data-action="add-task">+ משימה חדשה</button>';
  if (tab === 'inactive') {
    const rows = inactive.map((t) => {
      const sum = T.completionSummary(state, t);
      return `<tr class="inactive"><td><b>${esc(t.title)}</b> <span class="pill">${kindName(t.kind)}</span>${(t.links || []).length ? ` <span title="${t.links.length} קישורים">📎${t.links.length}</span>` : ''}</td>
        <td>${fmtD(t.start)}</td><td>${fmtD(t.due)}</td><td>${t.weight}%</td>
        <td>${sum.avgPercent}% · ${sum.approved}/${sum.total} אושרו <span class="muted">(נשמר)</span></td>
        <td><button class="btn small primary" data-action="reactivate" data-id="${esc(t.id)}">הפעל מחדש</button>
          <button class="btn small" data-action="open-task" data-id="${esc(t.id)}">פרטים</button>
          <button class="btn small danger" data-action="del-task" data-id="${esc(t.id)}">מחיקה לצמיתות</button></td></tr>`;
    }).join('');
    return shell('משימות', `<p class="muted intro">כאן רואים ומנהלים את כל משימות המחזור: מועדים, משקלים, התקדמות, והשלמות שממתינות לאישורך. לחיצה על משימה פותחת את פרטיה. ${helpIcon('progress-vs-completion')}</p>${tabs}
      <div class="alert" style="border-inline-start-color:var(--muted)"><b>משימות לא פעילות</b> נשמרות במחזור הזה עם כל פרטיהן, אך אינן בגאנט, בלוח השנה, אצל התלמידים או בחישובי ההתקדמות, ואינן יוצרות התראות או איחורים. <b>משימה לא פעילה אינה משימה שהושלמה.</b></div>
      ${inactive.length ? `<div class="table-wrap"><table><thead><tr><th>משימה</th><th>התחלה</th><th>מועד</th><th>משקל</th><th>התקדמות שנשמרה</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">אין משימות לא פעילות במחזור הזה.</div>'}`, addBtns);
  }
  const total = all.reduce((a, t) => a + t.weight, 0);
  const pendingOnly = ui.taskFilter === 'pending';
  const list = pendingOnly ? all.filter((t) => T.completionSummary(state, t).claimed) : all;
  const rows = list.map((t, i) => {
    const sum = T.completionSummary(state, t);
    const warns = T.taskWarnings(state, t).filter((w) => w.type !== 'pending');
    return `<tr>
      <td>${i + 1}</td><td><b>${esc(t.title)}</b> <span class="pill">${kindName(t.kind)}</span>${t.requiresSubmission ? ' <span class="pill" title="משימה שמחייבת הגשת תוצר">📥 הגשה</span>' : ''}${(t.links || []).length ? ` <span title="${t.links.length} קישורים">📎${t.links.length}</span>` : ''}${warns.map((w) => ` <span class="wbadge" title="${esc(w.label + ': ' + w.text)}">${w.icon} ${w.type === 'plan' ? 'תלות שבורה' : 'חופשה'}</span>`).join('')}</td>
      <td>${fmtD(t.start)}</td><td>${fmtD(t.due)}</td><td>${t.weight}%</td>
      <td>${(t.dependsOn || []).map((d) => esc((taskById(d) || {}).title || '')).join(', ') || '<span class="muted">—</span>'}</td>
      <td>${sum.avgPercent}% · ${sum.approved}/${sum.total} אושרו${sum.claimed ? ` · <b class="wbadge" title="${esc(T.WARNING_KINDS.pending.help)}">⏳ ${sum.claimed} ממתינים לאישור</b>` : ''}</td>
      <td><div class="row-actions"><button class="btn small" data-action="open-task" data-id="${esc(t.id)}">פרטים ועריכה</button>
        <details class="more"><summary class="btn small">עוד ▾</summary><div class="menu">
          <button class="btn small" data-action="task-up" data-id="${esc(t.id)}">↑ הזז למעלה</button>
          <button class="btn small" data-action="task-down" data-id="${esc(t.id)}">↓ הזז למטה</button>
          <button class="btn small" data-action="deactivate" data-id="${esc(t.id)}" title="מוציא את המשימה מהתוכנית ושומר אותה ברשימת המשימות הלא פעילות">הפוך ללא פעילה</button></div></details></div></td></tr>`;
  }).join('');
  return shell('משימות', `<p class="muted intro">כאן רואים ומנהלים את כל משימות המחזור: מועדים, משקלים, התקדמות, והשלמות שממתינות לאישורך. לחיצה על משימה פותחת את פרטיה. ${helpIcon('progress-vs-completion')}</p>${tabs}
    <div class="alert" style="border-inline-start-color:${Math.abs(G.relevantWeightSum(state) - 100) < 1e-6 ? 'var(--ok)' : 'var(--warn)'}">סכום המשקלים של המשימות הנספרות בציון: <b>${Math.round(G.relevantWeightSum(state) * 100) / 100}%</b>${Math.abs(G.relevantWeightSum(state) - 100) < 1e-6 ? '' : ' (כדי לחשב ציון כולל הסכום צריך להיות 100%)'}${G.exclusionsOf(state).some((e) => e.studentId === null) ? ' · משימות שהוחרגו לכל המחזור אינן נספרות' : ''}</div>
    <div class="toolbar"><label class="chk"><input type="checkbox" id="pendFilter" ${pendingOnly ? 'checked' : ''}> הצג רק משימות עם בקשות הממתינות לאישור</label></div>
    ${list.length ? `<div class="table-wrap sub-wrap"><table class="compact"><thead><tr><th>#</th><th>משימה</th><th>התחלה</th><th>מועד</th><th>משקל</th><th>תלויה ב</th><th>התקדמות והשלמה</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${pendingOnly ? 'אין בקשות הממתינות לאישור.' : 'עדיין אין משימות פעילות. אפשר להחיל את תבנית המשימות, להוסיף מהבנק או להוסיף משימה.'}</div>`}`, addBtns);
}

// ---------- תבנית משימות ----------
// מצב פריט בבנק ביחס למחזור הנבחר
function bankStatusCell(it) {
  const st = T.bankStatus(state, it.id);
  if (st.state === 'none') return '<span class="wbadge st-none">⚪ לא נוספה למחזור</span>';
  if (st.state === 'active') return `<span class="wbadge st-active">✅ פעילה במחזור${st.active.length > 1 ? ` (${st.active.length} עותקים)` : ''}</span>${st.inactive.length ? ` <span class="muted">+ ${st.inactive.length} לא פעילים</span>` : ''}`;
  return `<span class="wbadge st-inactive">💤 לא פעילה במחזור${st.inactive.length > 1 ? ` (${st.inactive.length} עותקים)` : ''}</span>`;
}

function bankActionBtns(it) {
  const st = T.bankStatus(state, it.id);
  const id = esc(it.id);
  if (st.state === 'none') return `<button class="btn small primary" data-action="bank-add" data-id="${id}">הוסף למחזור</button>`;
  if (st.state === 'inactive') return `<button class="btn small primary" data-action="bank-reactivate" data-id="${id}">הפעל מחדש</button> <button class="btn small" data-action="bank-add" data-id="${id}" title="יוצר משימה חדשה נוספת">עותק נוסף</button>`;
  return `<button class="btn small" data-action="bank-add" data-id="${id}" title="המשימה כבר פעילה. זה יוצר עותק נוסף">עותק נוסף</button>`;
}

function viewTemplate() {
  const list = T.orderedTemplate(state);
  const rows = list.map((t, i) => `<tr>
    <td>${i + 1}</td><td><b>${esc(t.title)}</b> <span class="pill">${kindName(t.kind)}</span>${t.requiresSubmission ? ' <span class="pill" title="משימה שמחייבת הגשת תוצר">📥 הגשה</span>' : ''}</td>
    <td>${t.startOffset}</td><td>${t.duration}</td><td>${t.weight}%</td>
    <td>${(t.dependsOn || []).map((d) => esc((state.taskTemplate.find((x) => x.id === d) || {}).title || '')).join(', ') || '<span class="muted">—</span>'}</td>
    <td>${bankStatusCell(t)}</td>
    <td><div class="row-actions">${bankActionBtns(t)}
        <button class="btn small" data-action="tpl-edit" data-id="${esc(t.id)}">עריכה</button>
        <details class="more"><summary class="btn small">עוד ▾</summary><div class="menu">
          <button class="btn small" data-action="tpl-up" data-id="${esc(t.id)}">↑ הזז למעלה</button>
          <button class="btn small" data-action="tpl-down" data-id="${esc(t.id)}">↓ הזז למטה</button>
          <button class="btn small danger" data-action="tpl-del" data-id="${esc(t.id)}" title="מוחק את הפריט מהבנק המשותף בלבד">מחיקה מהבנק</button></div></details></div></td></tr>`).join('');
  return shell('בנק משימות ותבנית', `
    <p class="muted intro">כאן מנהלים משימות מוכנות לשימוש חוזר ואת תוכנית העבודה של המחזור. ${helpIcon('task-bank')}</p>
    <div class="alert bank-note"><b>בנק המשימות משותף לכל המחזורים.</b> הוספת משימה למחזור יוצרת עותק עצמאי. שינויים במשימה במחזור אינם משנים את המשימה המקורית בבנק, ולהפך.</div>
    <div class="card explain"><h3>שני שימושים, ושניהם יוצרים עותקים</h3>
      <ul class="plain">
        <li><b>הוצאת משימה מהתוכנית:</b> במסך "משימות" אפשר "להפוך ללא פעילה" ולהחזיר בעתיד, בלי למחוק. זה שונה ממחיקת פריט מהבנק, שאינה משנה עותקים שכבר נוספו.</li>
        <li><b>הוספת משימה בודדת:</b> הכפתור "הוסף למחזור" ליד משימה מוסיף אותה בלבד, בלי להחליף או לשנות את תוכנית העבודה. העותק עצמאי וללא תלויות.</li>
        <li><b>תוכנית עבודה מלאה:</b> הכפתור "החל על המחזור" יוצר את כל המשימות יחד, עם התלויות ביניהן. אפשר להוסיף לתוכנית הקיימת או להחליף אותה.</li>
        <li><b>עריכה בבנק לא משנה עותקים קיימים</b>, ושינוי בעותק לא משנה את הבנק.</li>
      </ul></div>
    <p class="muted">התאריכים מחושבים מתחילת המחזור (${fmtD(state.cycle && state.cycle.start) || 'לא הוגדר'}): <b>התחלה</b> = ימים מתחילת המחזור, <b>משך</b> = מספר ימים.</p>
    ${list.length ? `<div class="table-wrap sub-wrap"><table class="compact"><thead><tr><th>#</th><th>משימה</th><th>התחלה (יום)</th><th>משך (ימים)</th><th>משקל</th><th>תלויה ב</th><th>מצב במחזור הנבחר</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">התבנית ריקה.</div>'}`,
  '<button class="btn" data-action="apply-template">החל תוכנית עבודה מלאה על המחזור</button><button class="btn primary" data-action="tpl-add">+ פריט חדש בבנק</button>');
}

// ---------- חופשות ----------
function viewVacations() {
  const rows = [...state.vacations].sort((a, b) => (a.start < b.start ? -1 : 1)).map((v) => {
    const hit = T.orderedTasks(state).filter((t) => t.start <= v.end && t.due >= v.start);
    return `<tr><td>${esc(v.title)}</td><td>${fmtD(v.start)}</td><td>${fmtD(v.end)}</td><td>${hit.length ? `${hit.length} משימות חופפות` : '<span class="muted">—</span>'}</td>
      <td><button class="btn small danger" data-action="del-vac" data-id="${esc(v.id)}">מחיקה</button></td></tr>`;
  }).join('');
  return shell('חופשות ואילוצים', `
    <p class="muted">חופשות מסומנות בגאנט ובלוח השנה, ומשימות שחופפות אליהן מסומנות באזהרה. המערכת אינה מזיזה משימות אוטומטית.</p>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>שם</th><th>מתאריך</th><th>עד תאריך</th><th>השפעה</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">לא הוגדרו חופשות.</div>'}`,
  '<button class="btn primary" data-action="add-vac">+ חופשה או אילוץ</button>');
}

// ---------- תלמידים ----------
function filteredStudents() {
  const q = ui.search.trim().toLowerCase();
  const groupName = (s) => { const g = state.groups.find((x) => x.id === L.currentGroupId(state, s.id)); return g ? g.name : ''; };
  const keyOf = { name: (s) => s.name, group: groupName, active: (s) => (s.active ? 0 : 1) }[ui.sort.key] || ((s) => s.name);
  return state.students.filter((s) => {
    if (q && !(`${s.name} ${s.email}`.toLowerCase().includes(q))) return false;
    if (ui.filter === 'active') return s.active;
    if (ui.filter === 'inactive') return !s.active;
    if (ui.filter === 'unassigned') return s.active && !L.currentGroupId(state, s.id);
    return true;
  }).sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    // תלמיד ללא קבוצה תמיד בסוף, בכל כיוון מיון
    if (ui.sort.key === 'group' && (!x || !y) && x !== y) return !x ? 1 : -1;
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'he');
    return (c || a.name.localeCompare(b.name, 'he')) * ui.sort.dir;
  });
}

const sortTh = (key, label) => {
  const on = ui.sort.key === key;
  const arrow = on ? (ui.sort.dir === 1 ? ' ▲' : ' ▼') : '';
  return `<th aria-sort="${on ? (ui.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort ${on ? 'on' : ''}" data-action="sort" data-key="${key}" title="מיון לפי ${label}${on ? (ui.sort.dir === 1 ? ' (כרגע בסדר עולה, לחיצה תהפוך)' : ' (כרגע בסדר יורד, לחיצה תהפוך)') : ''}">${label}${arrow}</button></th>`;
};

function studentsTable() {
  const rows = filteredStudents();
  if (!rows.length) return '<div class="empty">לא נמצאו תלמידים</div>';
  return `<div class="table-wrap sub-wrap"><table class="compact">
    <thead><tr>${sortTh('name', 'שם')}<th>דוא"ל</th>${sortTh('group', 'קבוצה')}${sortTh('active', 'סטטוס')}<th></th></tr></thead>
    <tbody>${rows.map((s) => {
      const gid = L.currentGroupId(state, s.id);
      return `<tr class="${s.active ? '' : 'inactive'}">
        <td>${esc(s.name)}</td><td dir="ltr" style="text-align:end">${esc(s.email)}</td>
        <td><select data-action="assign" data-id="${esc(s.id)}" aria-label="קבוצה של ${esc(s.name)}">
          <option value="">ללא קבוצה</option>
          ${state.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === gid ? 'selected' : ''}>${esc(g.symbol)} ${esc(g.name)}</option>`).join('')}
        </select></td>
        <td class="${s.active ? 'status-ok' : 'status-off'}">${s.active ? 'פעיל' : 'לא פעיל'}</td>
        <td><div class="row-actions"><button class="btn small" data-action="edit-student" data-id="${esc(s.id)}">עריכה</button>
            <details class="more"><summary class="btn small">עוד ▾</summary><div class="menu">
              <button class="btn small" data-action="history" data-id="${esc(s.id)}">היסטוריית שיוך</button>
              <button class="btn small" data-action="toggle-active" data-id="${esc(s.id)}">${s.active ? 'סמן כלא פעיל' : 'החזר לפעיל'}</button></div></details></div></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function viewStudents() {
  return shell('תלמידים', `
    <div class="toolbar">
      <input type="search" id="q" placeholder="חיפוש לפי שם או דוא&quot;ל" value="${esc(ui.search)}" aria-label="חיפוש">
      <select id="flt" aria-label="סינון">
        ${[['all', 'כולם'], ['active', 'פעילים'], ['inactive', 'לא פעילים'], ['unassigned', 'ללא קבוצה']].map(([v, t]) => `<option value="${v}" ${ui.filter === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <span class="muted">${filteredStudents().length} מתוך ${state.students.length}</span>
    </div>
    <div id="studentsTable">${studentsTable()}</div>`,
  '<button class="btn primary" data-action="add-student">+ תלמיד חדש</button>');
}

// ---------- קבוצות ----------
function viewGroups() {
  const cards = state.groups.map((g) => {
    const members = L.membersOf(state, g.id);
    return `<div class="group" style="--gc:${esc(g.color)}">
      <h3><span>${esc(g.symbol)}</span> ${esc(g.name)} <span class="muted" style="font-weight:400">(${members.length})</span></h3>
      <ul>${members.map((m) => `<li>${esc(m.name)}<span class="sp"></span><button class="btn small" data-action="remove-member" data-id="${esc(m.id)}" aria-label="הוצא את ${esc(m.name)} מהקבוצה">הוצאה</button></li>`).join('') || '<li class="muted">אין תלמידים בקבוצה</li>'}</ul>
      <select data-action="add-to-group" data-group="${esc(g.id)}" aria-label="הוספת תלמיד לקבוצה ${esc(g.name)}">
        <option value="">+ הוספת תלמיד לקבוצה…</option>
        ${state.students.filter((s) => s.active && L.currentGroupId(state, s.id) !== g.id).map((s) => { const cg = state.groups.find((x) => x.id === L.currentGroupId(state, s.id)); return `<option value="${esc(s.id)}">${esc(s.name)}${cg ? ` (כרגע ב${esc(cg.name)} - יועבר)` : ' (ללא קבוצה)'}</option>`; }).join('')}
      </select>
      <div class="actions"><button class="btn small" data-action="edit-group" data-id="${esc(g.id)}">עריכה</button>
        <button class="btn small danger" data-action="delete-group" data-id="${esc(g.id)}">מחיקה</button></div>
    </div>`;
  }).join('');
  return shell('קבוצות', cards ? `<div class="groups">${cards}</div>` : '<div class="empty">עדיין אין קבוצות</div>',
    '<button class="btn primary" data-action="add-group">+ קבוצה חדשה</button>');
}

// ---------- מחזור ----------
function viewCycle() {
  const c = state.cycle || { name: '', start: '', end: '', defenseDate: '' };
  return shell('מחזור', `
    <form class="card form" id="cycleForm">
      <label>שם המחזור <input type="text" name="name" value="${esc(c.name)}" required></label>
      <label>תחילת המחזור <input type="date" name="start" value="${esc(c.start)}"></label>
      <label>יעד סיום כתיבה <input type="date" name="end" value="${esc(c.end)}"></label>
      <label>מועד הגנה משוער <input type="date" name="defenseDate" value="${esc(c.defenseDate)}"></label>
      <div><button class="btn primary" type="submit">שמירה</button></div>
    </form>
    <div class="card"><h2>ארכיון, גישת תלמידים ומחיקה ${helpIcon('archive-vs-trash')}</h2>
      ${state.archived
    ? '<p>המחזור בארכיון: לקריאה בלבד, ותלמידיו ' + (state.cycleAccess[state.activeCycleId] ? '<b>יכולים לצפות בו (קריאה בלבד)</b>' : '<b>אינם יכולים להיכנס אליו</b>') + '. אפשר לפתוח או לסגור להם גישת צפייה בלי להחזיר את המחזור לפעיל.</p><div class="toolbar"><button class="btn" data-action="cycle-access" data-id="' + esc(state.activeCycleId) + '" data-v="' + (state.cycleAccess[state.activeCycleId] ? '0' : '1') + '">' + (state.cycleAccess[state.activeCycleId] ? 'סגירת גישת תלמידים' : 'פתיחת גישת צפייה לתלמידים') + '</button></div>'
    : '<p class="muted">מחזור פעיל פתוח לתלמידיו. העברה לארכיון נעשית מהשורה העליונה, וסוגרת את הגישה שלהם.</p>'}
      <p><b>מחיקת המחזור</b> מעבירה אותו לסל (לא נמחק לצמיתות) ונשמר גיבוי אוטומטי. מהסל אפשר לשחזר אותו במסך "גיבוי ושחזור".</p>
      <div class="toolbar"><button class="btn danger" data-action="cycle-delete" data-id="${esc(state.activeCycleId)}">🗑 העבר את המחזור לסל…</button></div></div>`);
}

// ---------- תלמיד ----------
// מסך מלא לתלמיד: מרחיב את התצוגה לכל רוחב החלון, ובדפדפנים שתומכים גם עובר למסך מלא אמיתי. יציאה: לחיצה שוב או Esc.
function fullBtn() {
  return `<button type="button" class="btn small" data-action="student-full" aria-pressed="${!!ui.studentFull}" title="מרחיב את התצוגה לכל רוחב המסך">${ui.studentFull ? '⤡ צמצם תצוגה' : '⛶ מסך מלא'}</button>`;
}

function viewStudentHome() {
  const me = state.students.find((s) => s.id === session.userId);
  if (!me || !L.canViewStudent(state, session, me.id)) {
    return `<div class="login"><div class="card"><h1>אין לך גישה</h1><p class="muted">החשבון אינו פעיל במחזור. פנה למורה.</p><button class="btn" data-action="logout">יציאה</button></div></div>`;
  }
  const gid = L.currentGroupId(state, me.id);
  const g = state.groups.find((x) => x.id === gid);
  const mates = g && L.canViewGroupMembers(state, session, g.id) ? L.membersOf(state, g.id).filter((m) => m.id !== me.id) : [];
  const tasks = T.tasksForStudent(state, me.id);
  const cards = tasks.map((t) => {
    const unit = T.unitForStudent(state, t, me.id);
    const eff = T.effectiveDates(state, t, { studentId: me.id });
    const p = T.getProgress(state, t.id, unit.type, unit.id);
    const late = eff.due < T.D.today() && p.completion !== 'approved';
    return `<button class="task-card ${late ? 'late' : ''}" data-action="open-task" data-id="${esc(t.id)}">
      <div class="tc-top"><b>${esc(t.title)}</b><span class="pill">${kindName(t.kind)}</span></div>
      <div class="muted">${fmtD(eff.start)} עד ${fmtD(eff.due)}${eff.exception ? ' (ארכה)' : ''}${late ? ' · עבר המועד' : ''}</div>
      ${taskTypeLine(t)}
      ${t.requiresSubmission ? fixChip(t, unit) : ''}
      ${t.requiresSubmission ? `<div>${submissionBadge(S.submissionStatus(state, t, unit, nowIso()))}</div>` : ''}
      ${taskCta(t, unit, p)}
      <div class="bar"><i style="width:${p.percent}%"></i></div>
      <div class="tc-bot"><span>${p.percent}%</span><span class="st ${p.completion}">${compl[p.completion]}</span></div></button>`;
  }).join('');
  return `<main class="main student-home ${ui.studentFull ? 'student-full' : ''}">
    ${state.cycles.length > 1 ? `<div class="cyclebar"><b>המחזור שלי:</b> ${state.cycles.map((c) => `<button class="btn small ${c.id === state.activeCycleId ? 'primary' : ''}" data-action="student-cycle" data-cycle="${esc(c.id)}">${esc(c.name)}</button>`).join(' ')}</div>` : ''}
    <div class="topbar"><h1>שלום ${esc(me.name)}</h1><span class="sp"></span><span class="badge-demo">דמו</span>${fullBtn()}<button class="btn small" data-action="logout">יציאה</button></div>
    <div class="card"><h2>הקבוצה שלי</h2>
      ${g ? `<p>${pill(g)}</p><p class="muted">חברי הקבוצה: ${mates.map((m) => esc(m.name)).join(', ') || 'אין חברים נוספים'}</p>` : '<p class="muted">עוד לא שויכת לקבוצה.</p>'}
    </div>
    ${studentFocusHtml(me.id)}
    ${studentMessagesHtml()}
    ${studentGradesHtml(me.id)}
    <h2 style="margin-top:18px">כל המשימות שלי</h2>
    <p class="muted">${PROGRESS_EXPLAIN}</p>
    ${tasks.length ? `<div class="task-cards">${cards}</div>
    <h2 style="margin-top:18px">הגאנט שלי</h2><div class="card gwrap">${renderGantt(state, { filter: { type: 'student', id: me.id }, zoom: 3, editable: false })}</div>` : '<div class="card"><p class="empty">עדיין אין משימות. הן יופיעו כאן כשהמורה יבנה את תוכנית המחזור.</p></div>'}
  </main>`;
}

// ציונים שפורסמו לתלמיד: ציון שלם בלבד, בלי פירוט מחוון. (הנתונים מגיעים מהשרת רק אם פורסמו.)
function studentGradesHtml(meId) {
  const gr = state.myGrades || { tasks: [], overall: null };
  const body = !gr.tasks.length && !gr.overall ? '<p class="muted">עוד לא פורסמו לך ציונים.</p>'
    : `${gr.overall ? `<p class="big-grade">ציון כולל: <b>${esc(gr.overall.value)}</b></p>` : ''}
      ${gr.tasks.length ? `<table class="compact"><thead><tr><th>משימה</th><th>ציון</th><th>פורסם</th></tr></thead><tbody>${gr.tasks.map((t) => `<tr><td>${esc(t.title)}</td><td><b>${esc(t.value)}</b></td><td>${fmtD(t.publishedAt.slice(0, 10))}</td></tr>`).join('')}</tbody></table>` : ''}`;
  void meId;
  return `<div class="card"><h2>🎯 הציונים שלי</h2>${body}</div>`;
}

// ---------- בדיקת עבודה (מורה): מסמך והערות מעוגנות ----------
const reviewSubmission = () => (state.submissions || []).find((x) => x.id === ui.reviewSub) || null;
const studentNameOf = (id) => (state.students.find((x) => x.id === id) || {}).name || '';

function viewReview() {
  const sub = reviewSubmission();
  if (!sub) return shell('בדיקת עבודה', '<div class="empty">לא נבחרה הגשה לבדיקה. <a href="#/submissions">למסך ההגשות</a></div>');
  const t = taskById(sub.taskId);
  const unit = T.unitsOfTask(state, t).find((u) => u.type === sub.unitType && u.id === sub.unitId) || { name: '' };
  const vs = S.versionsOf(state, sub.taskId, sub.unitType, sub.unitId);
  const ok = R.reviewable(sub);
  return shell('בדיקת עבודה', `
    <div class="card review-head">
      <div><b>${esc(t.title)}</b> · ${esc(unit.name)} · הועלה על ידי ${esc(studentNameOf(sub.uploadedBy))} · ${fmtDT(sub.uploadedAt)}${sub.late ? ' · 🕒 הוגש באיחור' : ''}</div>
      <div class="toolbar" style="margin:6px 0 0">
        <label>גרסה: <select id="revVersion">${vs.map((v) => `<option value="${esc(v.id)}" ${v.id === sub.id ? 'selected' : ''}>גרסה ${v.version} (${fmtDT(v.uploadedAt)})${v.conversion.status === 'done' ? '' : ' - אין PDF'}</option>`).join('')}</select></label>
        <a class="btn small" href="#/submissions">← חזרה להגשות</a><button type="button" class="btn small" data-action="rv-goto-score" title="קופץ לאזור הניקוד והציון בעמוד זה">🎯 לניקוד ולציון</button><a class="btn small" href="#/grades">לטבלת הציונים ←</a>
      </div>
    </div>
    <div class="rv-status"><section class="card rv-box internal" id="rvInternal">${reviewInternalHtml(sub)}</section><section class="card rv-box" id="rvPublic">${reviewPublicHtml(sub)}</section><section class="card rv-box" id="rvFix">${reviewFixHtml(sub)}</section></div>
    <section class="card rv-score" id="rvScore">${scoreHtml(sub)}</section>
    <section class="card rv-ai" id="rvAi">${aiPanelHtml(sub)}</section>
    ${ok ? `<div class="review-split">
      <section class="card rv-pdf">
        <div class="toolbar">
          <button class="btn small" data-action="rv-zoom-out" aria-label="הקטנה">−</button><span id="rvZoom" class="muted">…</span><button class="btn small" data-action="rv-zoom-in" aria-label="הגדלה">+</button>
          <button class="btn small" data-action="rv-fit">התאם לרוחב</button>
        </div>
        <div id="rvNotice" class="alert" hidden>במסמך אין טקסט שאפשר לסמן (ייתכן שהוא סרוק). אפשר להוסיף הערות כלליות בלבד.</div>
        <div id="pdfHost" class="pdf-host" dir="ltr">טוען מסמך…</div>
      </section>
      <aside class="card rv-panel" id="rvPanel">${reviewPanelHtml(sub, t)}</aside>
    </div>` : `<div class="card"><h3>אי אפשר לפתוח את הגרסה הזו לבדיקה</h3>
      <p>${sub.conversion.status === 'pending' ? 'הקובץ נקלט וההמרה ל-PDF עדיין מתבצעת. נסה שוב בעוד רגע.' : 'ההמרה ל-PDF נכשלה. ההגשה נקלטה וחותמת הזמן שלה נשמרת. אפשר לנסות המרה שוב או לבקש מהתלמיד PDF.'}</p>
      ${sub.conversion.status === 'failed' ? `<button class="btn primary" data-action="sub-retry" data-id="${esc(sub.id)}">נסה המרה שוב</button> <button class="btn" data-action="sub-request-pdf" data-id="${esc(sub.id)}">בקש PDF נוסף</button>` : ''}</div>`}`);
}

function reviewPanelHtml(sub, t) {
  const cats = R.activeCategories(state);
  const members = sub.unitType === 'group' ? L.membersOf(state, sub.unitId) : [];
  const unit = T.unitsOfTask(state, t).find((u) => u.type === sub.unitType && u.id === sub.unitId) || { name: '' };
  return `<div class="rv-write">
      <h3>הערה חדשה</h3>
      <div id="rvSelBox" class="rv-selbox"><span id="rvSelQuote" class="muted">אין קטע מסומן. אפשר להוסיף הערה כללית, או לסמן קטע במסמך (בגרירה) ולהצמיד אליו הערה.</span></div>
      <label>קטגוריה <select id="rvCat">${cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
      ${members.length
    ? `<label>למי ההערה <select id="rvAud"><option value="">👥 לכל הקבוצה</option>${members.map((m) => `<option value="${esc(m.id)}">👤 אישית: ${esc(m.name)}</option>`).join('')}</select></label>`
    : `<p class="muted">ההערה מיועדת ל: 👤 ${esc(unit.name)}</p>`}
      <label>טקסט ההערה <textarea id="rvText" rows="3" maxlength="${R.MAX_TEXT}" placeholder="כתוב את ההערה"></textarea></label>
      <div class="rv-addrow">
        <button class="btn primary big" data-action="rv-add-general">➕ הוסף הערה כללית</button>
        <button class="btn" id="rvAddLocal" data-action="rv-add" disabled title="סמן קודם קטע במסמך">📍 הוסף הערה לקטע המסומן</button>
      </div>
      <div class="subrow"><button class="btn small" data-action="rv-cats">ניהול קטגוריות</button></div>
    </div>
    <div class="rv-listhead"><h3>הערות (<span id="rvCount">0</span>)</h3>
      <span><button class="btn small" data-action="rv-expand-all">הרחב הכול</button> <button class="btn small" data-action="rv-collapse-all">צמצם הכול</button></span></div>
    <div id="rvCounts" class="rv-counts"></div>
    <ul id="rvList" class="rv-list"></ul>
    <div id="rvPrev"></div>`;
}

function reviewViewerComments() {
  const sub = reviewSubmission();
  return R.commentsOf(vs(), sub.id).map((c) => ({ id: c.id, anchor: c.anchor, color: R.categoryOf(state, c.categoryId).color }));
}

// ---------- משוב: צד המורה ----------
// שתי תיבות נפרדות בכוונה: "בדיקה (פנימי)" לא שולחת דבר. "משוב לתלמידים" היא הפעולה היחידה שמפרסמת הערות.
function reviewInternalHtml(sub) {
  const rv = F.reviewOf(state, sub.id);
  return `<h3>🔒 בדיקה (פנימי) ${helpIcon('internal-vs-send')}</h3>
    <p class="muted">סימון לעצמך בלבד. <b>אינו שולח דבר</b> ואינו גלוי לתלמידים.</p>
    <div class="subrow"><button class="btn ${rv.checked ? '' : 'primary'} rv-write" data-action="rv-check">${rv.checked ? '✔ סיימתי לבדוק (לחץ לביטול הסימון)' : '✔ סיימתי לבדוק'}</button>
      <label class="chk rv-write"><input type="checkbox" id="rvTreated" ${rv.treated ? 'checked' : ''}> טופל מחוץ למערכת</label></div>
    ${rv.checked ? `<div class="muted">סומן ב-${fmtDT(rv.checkedAt)}</div>` : ''}
    <label>הערת טיפול (פנימית) <textarea id="rvNote" rows="2" maxlength="1000" placeholder="למשל: לבדוק שוב את סעיף השיטות">${esc(rv.note)}</textarea></label>
    <button class="btn small rv-write" data-action="rv-note-save">שמירת הערת הטיפול</button>`;
}

function reviewPublicHtml(sub) {
  const rv = F.reviewOf(state, sub.id);
  const sum = F.sendSummary(state, sub.id);
  const pub = F.publishedOf(state, sub.id).length;
  const oq = F.openQuestionsOf(state, sub.id).length;
  const line = !sum.total && !pub ? 'עדיין אין הערות.'
    : pub && !sum.total ? `המשוב נשלח ב-${fmtDT(rv.lastSentAt)}. ${pub} הערות פורסמו לתלמידים.`
      : pub ? `המשוב נשלח ב-${fmtDT(rv.lastSentAt)} (${pub} הערות). <b>${sum.total} הערות חדשות הן טיוטה</b> ולא גלויות לתלמידים עד שליחה נוספת.`
        : `<b>${sum.total} הערות טיוטה.</b> התלמידים לא רואים אותן.`;
  return `<h3>📤 משוב לתלמידים ${helpIcon('internal-vs-send')} ${helpIcon('publish-retract')}</h3>
    <p>${line}</p>
    ${oq ? `<p><button class="btn small primary" data-action="open-question" data-id="${esc(F.firstOpenQuestionOf(state, sub.id).comment.id)}">❓ ${oq} שאלות ממתינות: עבור לשאלה הפתוחה</button></p>` : ''}
    ${gradePubHtml(sub)}
    <button class="btn primary big rv-write" data-action="rv-send" ${sum.total ? '' : 'disabled'}>📤 שליחת משוב לתלמידים${sum.total ? ` (${sum.total})` : ''}</button>
    <p class="muted">רק שליחה מפורשת מפרסמת הערות. הערות שנשלחו אי אפשר לערוך, ותוספת מאוחרת דורשת שליחה נוספת.</p>`;
}

// ---------- מחוונים (ספרייה, מחוון משימה) וניקוד ----------
const fmtN = (n) => String(Math.round(n * 100) / 100);
const BAND_LABEL = { green: '🟢 ירוק: שליטה מלאה', yellow: '🟡 צהוב: שליטה חלקית', red: '🔴 אדום: טעון שיפור' };

function viewRubrics() {
  const lib = K.libraryOf(state, { includeArchived: true });
  const active = lib.filter((r) => !r.archived);
  const libRows = lib.map((r) => `<tr class="${r.archived ? 'off' : ''}"><td><b>${esc(r.name)}</b>${r.builtIn ? ' <span class="wbadge st-none" title="מתוך תוכנית הלימודים. אפשר לערוך">מתוכנית הלימודים</span>' : ''}${r.archived ? ' <span class="muted">(מוסתר)</span>' : ''}</td>
    <td>${r.kind === 'checklist' ? 'רשימת בדיקה' : 'ניקוד'}</td><td>${r.kind === 'checklist' ? '—' : fmtN(K.rubricTotal(r))}</td><td>${r.criteria.length}</td><td>גרסה ${r.version}</td>
    <td><div class="row-actions"><button class="btn small" data-action="rb-edit" data-id="${esc(r.id)}">עריכה</button><button class="btn small" data-action="rb-dup" data-id="${esc(r.id)}">שכפול</button>
      <button class="btn small" data-action="${r.archived ? 'rb-show' : 'rb-hide'}" data-id="${esc(r.id)}">${r.archived ? 'החזר' : 'הסתר'}</button></div></td></tr>`).join('');
  const taskRows = T.orderedTasks(state).map((t) => {
    const tr = K.taskRubricOf(state, t.id);
    const used = (state.scoreSheets || []).filter((x) => x.taskId === t.id).length;
    return `<tr><td><b>${esc(t.title)}</b></td><td>${t.weight}%</td>
      <td><select data-action="rb-assign" data-id="${esc(t.id)}" aria-label="מחוון למשימה ${esc(t.title)}"><option value="">— ללא מחוון —</option>${active.map((r) => `<option value="${esc(r.id)}" ${tr && tr.baseId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}${tr && !active.some((r) => r.id === tr.baseId) ? `<option value="${esc(tr.baseId)}" selected>${esc(tr.name)} (מוסתר)</option>` : ''}</select></td>
      <td>${tr ? `${tr.kind === 'checklist' ? 'רשימת בדיקה' : `${fmtN(K.rubricTotal(tr))} נקודות`} · מבוסס על גרסה ${tr.baseVersion}${used ? ` · ${used} הגשות נוקדו` : ''}` : '<span class="muted">—</span>'}</td>
      <td>${tr ? `<div class="row-actions"><button class="btn small" data-action="rb-task-edit" data-id="${esc(t.id)}">עריכת מחוון המשימה</button><button class="btn small danger" data-action="rb-task-remove" data-id="${esc(t.id)}">הסר</button></div>` : ''}</td></tr>`;
  }).join('');
  return shell('מחוונים וניקוד', `
    <div class="alert bank-note"><b>שלוש רמות נפרדות:</b> (1) <b>מחוון בסיס</b> בספרייה, משותף לכל המחזורים. (2) <b>מחוון משימה</b>: עותק של מחוון בסיס, משויך למשימה במחזור הנבחר וניתן לעריכה חופשית. (3) <b>צילום מצב</b>: כשמתחילים לנקד הגשה, נשמר עותק קבוע של המחוון. שינוי במחוון הבסיס או במחוון המשימה לא ישנה בדיקה שכבר התחילה.</div>
    <p class="muted">כל משימה מקבלת ציון 0 עד 100 (סך הנקודות חלקי סך המקסימום של המחוון). מחווני ברירת המחדל לקוחים מתוכנית הלימודים (חלוקת 100 הנקודות של העבודה הכתובה), והם הצעה בלבד: אפשר לשנות כל מחוון, קריטריון, ניקוד וטקסט. הניקוד פנימי ואינו גלוי לתלמידים.</p>
    <h2>שיוך מחוון למשימות (במחזור הנבחר) ${helpIcon('rubric-assign')}</h2>
    <p class="muted">זה המקום לקבוע לפי איזה מחוון תנקדו כל משימה: בחרו מחוון בעמודה "מחוון". הבחירה יוצרת למשימה עותק משלה שאפשר לערוך ("עריכת מחוון המשימה"). משימה בלי מחוון עדיין אפשר לתת לה ציון ידני במסך הבדיקה.</p>
    ${state.archived ? '<p class="muted">המחזור בארכיון: אי אפשר לשנות בו מחוונים של משימות.</p>' : ''}
    ${taskRows ? `<div class="table-wrap"><table class="compact"><thead><tr><th>משימה</th><th>משקל</th><th>מחוון</th><th>מצב</th><th></th></tr></thead><tbody>${taskRows}</tbody></table></div>` : '<div class="empty">אין משימות במחזור.</div>'}
    <h2>ספריית מחווני בסיס</h2>
    <div class="table-wrap"><table class="compact"><thead><tr><th>מחוון</th><th>סוג</th><th>סה"כ נקודות</th><th>קריטריונים</th><th>גרסה</th><th></th></tr></thead><tbody>${libRows}</tbody></table></div>`,
  '<button class="btn primary" data-action="rb-new">+ מחוון חדש</button>');
}

function rbCritHtml(x, kind) {
  return `<div class="rb-crit" data-id="${esc(x.id || '')}">
    <div class="rb-top"><input type="text" data-f="name" value="${esc(x.name || '')}" placeholder="שם הקריטריון" aria-label="שם הקריטריון" maxlength="${K.MAX_NAME}">
      ${kind === 'checklist' ? '' : `<label class="rb-max">ניקוד מרבי <input type="number" data-f="max" min="0.5" max="1000" step="0.5" value="${esc(x.max ?? 5)}"></label>`}
      <button type="button" class="btn small danger" data-action="rb-crit-del" aria-label="הסר קריטריון">✕</button></div>
    <details class="rb-desc"><summary>תיאורי רמות (הכוונה למורה)</summary>
      ${['green', 'yellow', 'red'].map((k) => `<label>${BAND_LABEL[k]} <textarea data-f="${k}" rows="3" maxlength="${K.MAX_DESC}">${esc(x[k] || '')}</textarea></label>`).join('')}</details></div>`;
}
function rbTotalText(root, kind) {
  if (kind === 'checklist') return 'רשימת בדיקה: ללא ניקוד';
  const n = [...root.querySelectorAll('[data-f="max"]')].reduce((a, i) => a + (Number(i.value) || 0), 0);
  return `סה"כ נקודות במחוון: ${fmtN(n)}. הציון הוא 0 עד 100 (סך הנקודות חלקי ${fmtN(n)}).`;
}
function rbReadCrits(root, kind) {
  return [...root.querySelectorAll('.rb-crit')].map((r) => {
    const g = (k) => { const e = r.querySelector(`[data-f="${k}"]`); return e ? e.value : ''; };
    return { id: r.dataset.id || undefined, name: g('name'), max: kind === 'checklist' ? 0 : g('max'), green: g('green'), yellow: g('yellow'), red: g('red') };
  });
}
// עורך מחוון (בסיס או משימה). onSave מקבל {name, kind, criteria} ומחזיר true אם נשמר.
function rubricEditor({ title, name = '', kind = 'points', criteria, canPickKind = false, note = '', onSave }) {
  ui.openTask = null;
  const list = criteria && criteria.length ? criteria : [{ name: '', max: 5, green: '', yellow: '', red: '' }];
  showDlg(`<div class="form wide rb-editor" id="rbEd" data-kind="${kind}"><h2>${esc(title)}</h2>${note ? `<p class="muted">${note}</p>` : ''}
    <label>שם המחוון <input type="text" id="rbName" value="${esc(name)}" maxlength="${K.MAX_NAME}" required></label>
    ${canPickKind ? `<label>סוג <select id="rbKind"><option value="points">ניקוד (ציון 0 עד 100)</option><option value="checklist">רשימת בדיקה (ללא ניקוד)</option></select></label>` : ''}
    <div id="rbCrits">${list.map((x) => rbCritHtml(x, kind)).join('')}</div>
    <div class="subrow"><button type="button" class="btn small" data-action="rb-crit-add">+ קריטריון</button></div>
    <p id="rbTotal" class="muted"></p>
    <div class="dlg-actions"><button class="btn primary" id="rbSave">שמירה</button><button class="btn" id="rbCancel">ביטול</button></div></div>`);
  const ed = $dlg.querySelector('#rbEd');
  const curKind = () => (ed.querySelector('#rbKind') ? ed.querySelector('#rbKind').value : kind);
  const upd = () => { ed.querySelector('#rbTotal').textContent = rbTotalText(ed, curKind()); };
  ed.addEventListener('input', () => { ui.dirty = true; upd(); });
  upd();
  const kindSel = ed.querySelector('#rbKind');
  if (kindSel) kindSel.addEventListener('change', () => {
    const prevKind = ed.dataset.kind;
    ed.dataset.kind = kindSel.value;
    ed.querySelector('#rbCrits').innerHTML = rbReadCrits(ed, prevKind).map((x) => rbCritHtml(x, kindSel.value)).join('') || rbCritHtml({}, kindSel.value);
    upd();
  });
  ed.querySelector('#rbCancel').addEventListener('click', () => closeDlg());
  ed.querySelector('#rbSave').addEventListener('click', async () => {
    const k = curKind();
    const ok = await onSave({ name: ed.querySelector('#rbName').value, kind: k, criteria: rbReadCrits(ed, k) });
    if (ok) { ui.dirty = false; $dlg.close(); }
  });
}
async function rbOp(fn, msg) {
  try { state = await fn(); if (msg) toast(msg); render(); return true; } catch (e) { toast(e.message || 'הפעולה נכשלה', true); return false; }
}

// ---------- ניקוד במסך הבדיקה ----------
// ציון ידני ישירות מהבדיקה (למשימה בלי מחוון): נשמר בטבלת הציונים, פנימי, אינו מפורסם לתלמיד.
function manualGradeHtml(sub) {
  if (sub.unitType === 'group') return ''; // בהגשה קבוצתית הכפתור "👥 ציון קבוצתי ידני" כבר מוצג מעל
  const cur = G.gradeOf(state, sub.taskId, sub.unitId);
  return `<div class="sc-set"><p><b>ציון ידני</b> (0 עד 100)</p>
    <div class="rv-write"><input type="number" id="scManual" min="0" max="100" step="0.5" value="${cur && cur.value !== null && cur.value !== undefined ? esc(cur.value) : ''}" aria-label="ציון המשימה"> <button class="btn primary" data-action="sc-manual-grade" data-id="${esc(sub.taskId)}" data-student="${esc(sub.unitId)}">✔ שמור כציון המשימה</button></div>
    <p class="muted">${Number((taskById(sub.taskId) || {}).weight) > 0 ? 'הציון נשמר בטבלת הציונים' : 'הציון נשמר'} ואינו מפורסם לתלמיד עד פרסום מפורש.</p>${Number((taskById(sub.taskId) || {}).weight) > 0 ? '' : '<p class="alert">למשימה הזו אין משקל, ולכן הציון לא יופיע בטבלת הציונים ולא ייכנס לציון הכולל. אפשר להגדיר משקל במסך "ציונים" (התאמת משקלי משימות).</p>'}</div>`;
}
function scoreHtml(sub) {
  const tr = K.taskRubricOf(state, sub.taskId);
  const sh = K.sheetOf(state, sub.id);
  const head = '<h3>🎯 ניקוד (פנימי) ' + helpIcon('rubric-snapshot') + '</h3><p class="muted">לא גלוי לתלמיד. בשלב זה אין פרסום ציון ואין עיגול. הציון של המשימה הוא 0 עד 100.</p>'
    + (sub.unitType === 'group' ? `<p class="rv-write"><button class="btn small" data-action="gr-group-grade" data-id="${esc(sub.taskId)}" data-group="${esc(sub.unitId)}">👥 ציון קבוצתי ידני (בלי מחוון)</button> <span class="muted">ציון אחד לכל חברי הקבוצה שהשתתפו בהגשה. ציון אישי לתלמיד מסוים מוזן במסך "ציונים".</span></p>` : '');
  if (!tr && !sh) return `${head}${manualGradeHtml(sub)}<p class="muted">למשימה הזו אין מחוון. אם תרצה לנקד לפי קריטריונים, אפשר <a href="#/rubrics">לבחור מחוון במסך "מחוונים"</a>.</p>`;
  const rub = sh ? sh.snapshot : tr;
  const changed = sh && tr && JSON.stringify(sh.snapshot.criteria) !== JSON.stringify(tr.criteria);
  const sc = sh ? K.scoreOf(sh) : null;
  const rows = rub.criteria.map((x) => {
    const v = sh ? (rub.kind === 'checklist' ? sh.checks[x.id] : sh.points[x.id]) : undefined;
    const band = rub.kind === 'points' ? K.bandOf(v, x.max) : null;
    const input = rub.kind === 'checklist'
      ? `<select data-check="${esc(x.id)}" class="rv-write-in" aria-label="${esc(x.name)}"><option value="">—</option><option value="1" ${v === true ? 'selected' : ''}>עומד</option><option value="0" ${v === false ? 'selected' : ''}>לא עומד</option></select>`
      : `<input type="number" data-score="${esc(x.id)}" min="0" max="${x.max}" step="0.5" value="${v === undefined ? '' : esc(v)}" aria-label="ניקוד ${esc(x.name)}"> <span class="muted">מתוך ${fmtN(x.max)}</span>`;
    return `<li class="sc-row ${band ? 'b-' + band : ''}"><div class="sc-top"><b>${esc(x.name)}</b><span class="sc-in">${input}</span></div>
      ${x.green || x.yellow || x.red ? `<details class="rb-desc"><summary>תיאורי רמות</summary>${['green', 'yellow', 'red'].map((k) => (x[k] ? `<p><b>${BAND_LABEL[k]}</b><br>${esc(x[k])}</p>` : '')).join('')}<p class="muted">התיאורים הם הכוונה. אפשר לתת כל ניקוד מ-0 עד המקסימום.</p></details>` : ''}</li>`;
  }).join('');
  const total = !sc ? 'עוד לא נוקד.' : sc.kind === 'checklist'
    ? `<b>${sc.done} מתוך ${sc.total}</b> עומדים${sc.complete ? '' : ` (נבדקו ${sc.answered})`}.`
    : sc.complete ? `<b>סה"כ ${fmtN(sc.points)} מתוך ${fmtN(sc.max)} · ציון המשימה: ${fmtN(sc.percent)} מתוך 100</b>` : `נוקדו ${sc.scored} מתוך ${sc.total} קריטריונים (${fmtN(sc.points)} נקודות). הציון יחושב כשכולם ינוקדו.`;
  const prev = (state.scoreSheets || []).filter((x) => x.taskId === sub.taskId && x.unitType === sub.unitType && x.unitId === sub.unitId && x.submissionId !== sub.id).sort((a, b) => a.version - b.version);
  const prevHtml = prev.length ? `<details class="rb-desc"><summary>ניקוד בגרסאות קודמות (${prev.length})</summary><ul class="plain">${prev.map((p) => { const s2 = K.scoreOf(p); return `<li>גרסה ${p.version}: ${s2.kind === 'checklist' ? `${s2.done} מתוך ${s2.total} עומדים` : s2.complete ? `${fmtN(s2.percent)} מתוך 100` : `ניקוד חלקי (${s2.scored} מתוך ${s2.total})`} · מחוון "${esc(p.snapshot.name)}" גרסה ${p.snapshot.baseVersion}</li>`; }).join('')}</ul><p class="muted">ציון חדש אינו מוחק ציון קודם: כל גרסה נשמרת עם המחוון ששימש בה.</p></details>` : '';
  return `${head}
    <p><b>${esc(rub.name)}</b>${sh ? ` <span class="muted">(צילום מצב קבוע מתחילת הבדיקה, ${fmtDT(sh.snapshot.takenAt)}, מחוון בסיס גרסה ${sh.snapshot.baseVersion})</span>` : ' <span class="muted">(עוד לא נקבע צילום מצב: הוא נקבע בפתיחת הבדיקה של הגרסה האחרונה, ובגרסה ישנה בניקוד הראשון)</span>'}</p>
    ${changed ? '<div class="alert">המחוון של המשימה שונה מאז שהתחלת לנקד את הגרסה הזו. הניקוד נשאר לפי המחוון שבו התחלת (צילום מצב קבוע).</div>' : ''}
    <ul class="sc-list">${rows}</ul>
    <p class="sc-total">${total}</p>
    ${(() => {
      const gs = sc && sc.kind === 'points' ? K_gradeStatus(sub.id) : null;
      if (!gs) return '';
      const cur = gs.rows.filter((r) => r.current !== null && r.current !== undefined);
      const curTxt = cur.length ? `ציון המשימה התקף כיום: ${cur.map((r) => `${esc(r.name)} ${fmtG(r.current)}`).join(', ')}` : 'עוד לא נקבע ציון משימה.';
      if (!gs.ready) return `<div class="sc-set"><p class="muted">הניקוד עדיין בעבודה: הוא אינו ציון המשימה. ${curTxt} שינוי בניקוד אינו משנה ציון שכבר נקבע.</p></div>`;
      return `<div class="sc-set"><p>הניקוד שהושלם: <b>${fmtG(gs.percent)}</b> מתוך 100. ${curTxt}</p>
        ${gs.allSame ? `<p>✔ הציון נקבע ונראה בטבלת הציונים. <a href="#/grades">לטבלת הציונים</a></p>`
    : `<div class="rv-write"><button class="btn primary" data-action="sc-setgrade">✔ ${gs.rows.some((r) => r.status === 'differs') ? 'עדכן את ציון המשימה לפי הניקוד' : 'קבע כציון המשימה'}</button> <span class="muted">לחיצה אחת: הציון נשמר כציון הפנימי התקף ומופיע בטבלת הציונים, בלי הזנה נוספת.${gs.hasIndividual ? ' יש ציון אישי ידני: תתבקש להחליט אם לדרוס אותו.' : ''}</span></div>`}
        <p class="muted">ציון קודם נשמר בהיסטוריה. הציון אינו מתפרסם לתלמיד אוטומטית: פרסום (או פרסום מחדש של שינוי) הוא פעולה נפרדת בכרטיס "מצב פרסום", ותלמיד שכבר ראה ציון ממשיך לראות אותו עד אז.</p></div>`;
    })()}
    <div class="sc-risks"><b>סיכוני פסילה (סימון בלבד, אינו משנה ציון)</b>
      ${RISK_FLAGS.map((f) => `<label class="chk"><input type="checkbox" data-risk="${f.key}" ${sh && sh.risks.includes(f.key) ? 'checked' : ''}> ${esc(f.label)}</label>${sh && sh.risks.includes(f.key) ? `<div class="muted sc-risk-text">ההודעה לתלמיד: «${esc(f.studentText)}» (תישלח רק בשליחת משוב מפורשת, בחלק הבא)</div>` : ''}`).join('')}</div>
    <label>הערת ניקוד פנימית <textarea id="scNote" rows="2" maxlength="${K.MAX_NOTE}" ${sh ? '' : 'placeholder="נשמרת עם צילום המצב"'}>${esc(sh ? sh.note : '')}</textarea></label>
    ${prevHtml}`;
}
const K_gradeStatus = (subId) => { try { return G.sheetGradeStatus(state, subId); } catch (e) { return null; } };
function renderScore() {
  const el = document.getElementById('rvScore');
  const sub = reviewSubmission();
  if (el && sub) { el.innerHTML = scoreHtml(sub); lockArchived(el); if (state.archived) el.querySelectorAll('input, select, textarea').forEach((x) => { x.disabled = true; }); }
}
async function scOp(fn, msg) {
  try { state = await fn(); if (msg) toast(msg); } catch (e) { toast(e.message || 'הפעולה נכשלה', true); }
  renderScore();
}

// ---------- ציונים (פנימי) ----------
const srcLabel = (s) => (s === 'rubric' ? 'מהניקוד במחוון' : s === 'manual-group' ? 'ציון קבוצתי ידני' : 'ידני (אישי)');
const fmtG = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100));
const gradedTasks = () => state.tasks.filter((t) => T.isActive(t) && Number(t.weight) > 0).sort((a, b) => a.order - b.order);

function keepScroll(fn) {
  const y = window.scrollY;
  const wrap = document.querySelector('.gr-wrap');
  const sl = wrap ? wrap.scrollLeft : 0, st = wrap ? wrap.scrollTop : 0;
  fn();
  const w2 = document.querySelector('.gr-wrap');
  if (w2) { w2.scrollLeft = sl; w2.scrollTop = st; }
  window.scrollTo(0, y);
}
async function grOp(fn, msg, { rerender = true } = {}) {
  try { state = await fn(); if (msg) toast(msg); if (rerender) keepScroll(() => render()); return true; } catch (e) { toast(e.message || 'הפעולה נכשלה', true); if (rerender) keepScroll(() => render()); return false; }
}

function schemeSummaryHtml() {
  const sc = G.schemeOf(state);
  const probs = G.schemeProblems(sc);
  const tpls = G.templatesOf(state);
  return `<div class="card gr-scheme"><h3>ערכת הציונים של המחזור ${helpIcon('grade-scheme')}</h3>
    <p class="muted">הציון הסופי מורכב מרכיב "העבודה" (ממוצע משוקלל של המשימות לפי משקלן) ומרכיבים נוספים שתגדיר (תלמידאות, בחנים, עבודות נוספות) עם ציון אישי לכל תלמיד.</p>
    <ul class="plain">${sc.components.map((c) => `<li><b>${esc(c.name)}</b>: ${fmtG(c.weight)}% מהציון הסופי${c.kind === 'extra' ? ` · פריטים: ${c.items.map((i) => `${esc(i.name)} (${fmtG(i.weight)}%)`).join(', ')}` : ' · לפי משקלי המשימות'}</li>`).join('')}</ul>
    ${sc.fromTemplate ? `<p class="muted">נוצרה מהתבנית "${esc(sc.fromTemplate.name)}" (עותק עצמאי).</p>` : ''}
    ${probs.length ? `<div class="alert">${probs.map((p) => esc(p.text)).join('<br>')}<br><b>הציון הכולל לא יחושב עד שהסכומים יהיו 100%.</b></div>` : ''}
    <div class="row-actions"><button class="btn small primary" data-action="gr-scheme-edit">עריכת הערכה</button><button class="btn small" data-action="gr-tpl-save">שמירה כתבנית אישית</button>
      ${tpls.length ? `<select id="grTplSel" aria-label="תבנית אישית"><option value="">שימוש בתבנית אישית…</option>${tpls.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select> <button class="btn small" data-action="gr-tpl-apply">החל על המחזור</button> <button class="btn small danger" data-action="gr-tpl-del">מחק תבנית</button>` : ''}</div></div>`;
}

function exclusionsHtml() {
  const list = G.exclusionsOf(state);
  const rel = G.relevantWeightSum(state);
  return `<div class="card gr-weights"><h3>משקלי המשימות והחרגות ${helpIcon('exceptions')}</h3>
    <p>סכום משקלי המשימות הנספרות בציון העבודה: <b style="color:${Math.abs(rel - 100) < 1e-6 ? 'var(--ok)' : 'var(--bad)'}">${fmtG(rel)}%</b>${Math.abs(rel - 100) < 1e-6 ? '' : ' (נדרש 100%, אחרת הציון הכולל לא מחושב; אין נרמול אוטומטי)'}</p>
    ${list.length ? `<ul class="plain">${list.map((e) => `<li>🚫 <b>${esc((taskById(e.taskId) || {}).title || '')}</b>: ${e.studentId ? `לתלמיד ${esc(studentNameOf(e.studentId))}` : 'לכל המחזור'} · ${esc(e.reason)} <small class="muted">(${fmtD(e.at.slice(0, 10))})</small> <button class="btn small" data-action="gr-include" data-id="${esc(e.taskId)}" data-student="${esc(e.studentId || '')}">החזר לחישוב</button></li>`).join('')}</ul>` : '<p class="muted">אין החרגות. אם תלמיד לא הגיש, בדרך כלל מזינים ציון 0 ולא מחריגים.</p>'}
    <div class="row-actions"><button class="btn small" data-action="gr-exclude">החרגת משימה…</button><button class="btn small" data-action="gr-weights">התאמת משקלי משימות למחזור…</button></div></div>`;
}

function pubMark(taskId, studentId) {
  const s = PB.pubStatus(state, 'task', taskId, studentId).status;
  return s === 'published' ? '<span class="gr-pub" title="פורסם לתלמיד">📤</span>'
    : s === 'changed' ? '<span class="gr-pub chg" title="שינוי שטרם פורסם: התלמיד רואה את הציון הקודם">⚠</span>'
      : s === 'blocked' ? '<span class="gr-pub" title="פורסם. הציון הנוכחי חסר או מוחרג, והתלמיד ממשיך לראות את מה שפורסם">📤</span>'
        : s === 'retracted' ? '<span class="gr-pub chg" title="בוטל פרסום: התלמיד אינו רואה">⛔</span>' : '';
}
function overallPubHtml(studentId) {
  const st = PB.pubStatus(state, 'overall', null, studentId);
  const txt = { empty: '<span class="muted">—</span>', waiting: `ממתין (${st.currentShown})`, published: `<b>📤 פורסם ${st.pub && st.pub.shown}</b>`, changed: `<span class="wbadge st-late">שינוי שטרם פורסם</span> פורסם ${st.pub && st.pub.shown}, כעת ${st.currentShown}`, blocked: `📤 פורסם ${st.pub && st.pub.shown} <span class="muted">(חסום כעת)</span>`, retracted: `<span class="wbadge st-late">↩ בוטל</span> (היה ${st.pub && st.pub.shown})` }[st.status];
  const can = ['waiting', 'changed', 'retracted'].includes(st.status);
  const canR = ['published', 'changed', 'blocked'].includes(st.status);
  return `${txt} ${can ? `<button class="btn small" data-action="gr-pub-overall" data-id="${esc(studentId)}" title="פרסום הציון הכולל לתלמיד">📤</button>` : ''}${canR ? `<button class="btn small danger" data-action="gr-retract-overall" data-id="${esc(studentId)}" title="ביטול פרסום הציון הכולל">↩</button>` : ''}`;
}
function gradeCell(t, st) {
  if (G.isExcluded(state, t.id, st.id)) return `<td class="gr-ex" title="מוחרגת מהחישוב">מוחרג</td>`;
  const g = G.gradeOf(state, t.id, st.id);
  const tip = g ? `${srcLabel(g.source)}${g.individual ? ' (ציון אישי בקבוצה, לא נדרס אוטומטית)' : ''} · ${fmtDT(g.setAt)}${g.history.length > 1 ? ` · ${g.history.length} רשומות בהיסטוריה` : ''}` : 'אין ציון';
  return `<td><input class="gr-in" type="number" min="0" max="100" step="0.01" data-grade="${esc(t.id)}" data-student="${esc(st.id)}" value="${g && g.value !== null ? esc(g.value) : ''}" title="${esc(tip)}" aria-label="ציון ${esc(t.title)} ל${esc(st.name)}">${g && g.individual ? '<span class="gr-ind" title="ציון אישי בתוך קבוצה">👤</span>' : ''}${pubMark(t.id, st.id)}</td>`;
}

function gradeTailHtml(studentId) {
  const o = G.overall(state, studentId);
  const w = o.components.find((c) => c.kind === 'work');
  return `<td class="gr-work">${w && w.grade !== null ? fmtG(w.grade) : '<span class="muted">—</span>'}</td>
      <td class="gr-all">${o.ok ? `<b title="ציון מדויק: ${fmtG(o.exact)}">${o.rounded}</b>` : `<span class="wbadge st-pending" title="${esc(o.problems.map((p) => p.text).join(' | '))}">לא מחושב · ${o.problems.length}</span>`}</td>
      <td class="gr-pubc">${overallPubHtml(studentId)}</td>
      <td class="gr-act"><button class="btn small" data-action="gr-student" data-id="${esc(studentId)}">פירוט</button></td>`;
}
// עדכון שורה אחרי הזנת ציון, בלי לאבד פוקוס
async function grCellOp(fn, input) {
  const tr = input.closest('tr');
  try {
    state = await fn();
    if (tr) {
      const id = tr.dataset.st;
      tr.querySelectorAll('.gr-work, .gr-all, .gr-pubc, .gr-act').forEach((c) => c.remove());
      tr.insertAdjacentHTML('beforeend', gradeTailHtml(id));
      tr.classList.toggle('gr-inc', !G.overall(state, id).ok);
    }
    if (input.dataset.grade) {
      const g = G.gradeOf(state, input.dataset.grade, input.dataset.student);
      const old = input.parentElement.querySelector('.gr-ind');
      if (old) old.remove();
      if (g && g.individual) input.insertAdjacentHTML('afterend', '<span class="gr-ind" title="ציון אישי בקבוצה">👤</span>');
      input.parentElement.querySelectorAll('.gr-pub').forEach((x) => x.remove());
      input.parentElement.insertAdjacentHTML('beforeend', pubMark(input.dataset.grade, input.dataset.student));
    }
  } catch (e) {
    toast(e.message || 'הפעולה נכשלה', true);
    const g = input.dataset.grade ? G.gradeOf(state, input.dataset.grade, input.dataset.student) : G.itemGradeOf(state, input.dataset.item, input.dataset.student);
    input.value = g && g.value !== null ? g.value : '';
  }
}

function viewGrades() {
  const tasks = gradedTasks();
  const sc = G.schemeOf(state);
  const extras = sc.components.filter((c) => c.kind === 'extra');
  const students = G.studentsForGrades(state).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const head = `<tr><th class="sticky-col">תלמיד</th>${tasks.map((t) => `<th title="${esc(t.title)}">${esc(t.title.length > 16 ? t.title.slice(0, 15) + '…' : t.title)}<br><small>${fmtG(t.weight)}%${G.isExcludedCycleWide(state, t.id) ? ' · מוחרג' : ''}</small>${t.kind === 'group' ? `<br><button class="btn small" data-action="gr-group-grade" data-id="${esc(t.id)}" title="ציון אחד לכל חברי הקבוצה שהשתתפו בהגשה">👥 ציון קבוצתי</button><br><small class="muted">תא = ציון אישי</small>` : ''}<br><button class="btn small" data-action="gr-pub-task" data-id="${esc(t.id)}" title="פרסום ציוני המשימה לתלמידים שיש להם ציון (ציון שלם בלבד)">📤</button><button class="btn small danger" data-action="gr-retract-task" data-id="${esc(t.id)}" title="ביטול פרסום ציוני המשימה">↩</button></th>`).join('')}
    ${extras.map((c) => c.items.map((i) => `<th title="${esc(c.name)}: ${esc(i.name)}">${esc(i.name)}<br><small>${esc(c.name)}</small></th>`).join('')).join('')}<th>עבודה</th><th>ציון כולל</th><th>פרסום הכולל</th><th></th></tr>`;
  const rows = students.map((st) => {
    const o = G.overall(state, st.id);
    const w = o.components.find((c) => c.kind === 'work');
    const cells = tasks.map((t) => gradeCell(t, st)).join('');
    const ex = extras.map((c) => c.items.map((i) => { const g = G.itemGradeOf(state, i.id, st.id); return `<td><input class="gr-in" type="number" min="0" max="100" step="0.01" data-item="${esc(i.id)}" data-student="${esc(st.id)}" value="${g && g.value !== null ? esc(g.value) : ''}" aria-label="${esc(i.name)} ל${esc(st.name)}"></td>`; }).join('')).join('');
    const pw = G.personalWeightsOf(state, st.id);
    return `<tr data-st="${esc(st.id)}" class="${o.ok ? '' : 'gr-inc'}"><th class="sticky-col">${esc(st.name)}${pw ? ' <span class="wbadge st-late" title="משקלים אישיים">⚖</span>' : ''}</th>${cells}${ex}${gradeTailHtml(st.id)}</tr>`;
  }).join('');
  return shell('ציונים (פנימי)', `
    <div class="alert info-note"><b>🔒 ציונים פנימיים בלבד.</b> התלמידים אינם רואים אותם, ואין בשלב זה פרסום ציון. ציון כולל מחושב רק כשכל הסכומים 100% וכל מרכיב בעל משקל קיבל ציון (אפשר להזין 0, או להחריג משימה בהחלטה מפורשת). הציון הכולל מעוגן פעם אחת בסוף (89.49 ל-89, 89.50 ל-90).</div>
    ${schemeSummaryHtml()}${exclusionsHtml()}
    <div class="card gr-pubbar"><b>פרסום לתלמידים:</b> ${helpIcon('publish-retract')} <button class="btn small" data-action="gr-pub-overall-all">📤 פרסום ציון כולל לכל מי שהציון הכולל שלו מחושב…</button> <span class="muted">הכול ידני: שינוי ציון, משקל או החרגה אינו מפרסם. 📤 פורסם · ⚠ שינוי שטרם פורסם · ⛔ בוטל פרסום. התלמיד רואה ציון שלם בלבד. ביטול פרסום מסיר מהתלמיד את הפריט (מידע שכבר ראה אי אפשר למחוק), והתוכן וההיסטוריה נשמרים.</span></div>
    ${students.length && tasks.length ? `<div class="table-wrap gr-wrap"><table class="compact gr-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">אין תלמידים פעילים או משימות בעלות משקל במחזור.</div>'}
    <p class="muted">הקלדה בתא שומרת ציון (0 עד 100). ציון שנקבע מניקוד במחוון נקבע ממסך הבדיקה ("קבע כציון המשימה"). 👤 = ציון אישי בתוך קבוצה, שאינו נדרס אוטומטית.</p>`);
}

// ---------- חלונות הציונים ----------
function groupGradeDialog(taskId, groupId = '') {
  const t = taskById(taskId);
  const groups = [...state.groups].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  if (!groups.length) { toast('אין קבוצות במחזור', true); return; }
  ui.openTask = null;
  showDlg(`<div class="form wide" id="ggD"><h2>ציון קבוצתי: ${esc(t.title)}</h2>
    <p class="muted"><b>ציון קבוצתי</b> נקבע לכל חברי הקבוצה שהשתתפו בהגשה (לפי החברות במועד ההגשה). זה שונה מ<b>ציון אישי</b> לתלמיד מסוים, שמוזן בתא של התלמיד בטבלת הציונים.</p>
    <label>קבוצה <select id="ggGroup">${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <div id="ggWho"></div>
    <label>ציון (0 עד 100) <input type="number" id="ggVal" min="0" max="100" step="0.01"></label>
    <label>הערה פנימית (אופציונלי) <input type="text" id="ggNote" maxlength="${G.MAX_NOTE}"></label>
    <p class="muted">הציון פנימי: אינו מפורסם לתלמידים. ציון קודם נשמר בהיסטוריה.</p>
    <div class="dlg-actions"><button class="btn primary" id="ggOk">קבע ציון קבוצתי</button><button class="btn" id="ggNo">ביטול</button></div></div>`);
  const d = $dlg.querySelector('#ggD');
  let pv = null;
  const upd = () => {
    pv = G.unitGradePreview(state, taskId, d.querySelector('#ggGroup').value);
    const anyInd = pv.students.some((s) => s.individual);
    d.querySelector('#ggWho').innerHTML = `<p>${pv.basis === 'submission' ? `הזכאים: חברי הקבוצה <b>במועד ההגשה</b> (גרסה ${pv.version}, ${fmtDT(pv.date)}).` : '<b>אין הגשה לקבוצה במשימה הזו</b>, ולכן הזכאים הם חברי הקבוצה כעת.'}</p>
      <ul class="plain">${pv.students.map((s) => `<li>${esc(s.name)}${s.currentGroup ? '' : ' <span class="muted">(כבר לא בקבוצה, שומר את הציון)</span>'}: ציון קיים ${fmtG(s.current)}${s.individual ? ' 👤 <b>ציון אישי ידני</b>' : ''}</li>`).join('') || '<li class="muted">אין זכאים</li>'}</ul>
      <p class="muted">תלמיד שהצטרף אחרי ההגשה אינו כלול. אפשר לקבוע לו ציון אישי בטבלת הציונים.</p>
      ${anyInd ? '<label class="chk"><input type="checkbox" id="ggOver"> לדרוס גם ציונים אישיים ידניים (אחרת הם נשארים כפי שהם)</label>' : ''}`;
  };
  d.addEventListener('change', (ev) => { if (ev.target.id === 'ggGroup') upd(); });
  d.addEventListener('input', () => { ui.dirty = true; });
  upd();
  d.querySelector('#ggNo').addEventListener('click', () => closeDlg());
  d.querySelector('#ggOk').addEventListener('click', async () => {
    const over = d.querySelector('#ggOver') ? d.querySelector('#ggOver').checked : false;
    const gid = d.querySelector('#ggGroup').value;
    const val = d.querySelector('#ggVal').value;
    const note = d.querySelector('#ggNote').value;
    const onGrades = route() === 'grades';
    let ok = false;
    try { state = await api.setGroupGrade(taskId, gid, val, { submissionId: pv.submissionId, note, overwriteIndividual: over }); ok = true; } catch (e) { toast(e.message || 'הפעולה נכשלה', true); }
    if (!ok) return;
    ui.dirty = false; $dlg.close(); toast('הציון הקבוצתי נקבע לכל הזכאים (פנימי, לא מפורסם)');
    if (onGrades) keepScroll(() => render()); else renderScore();
  });
}

function studentGradeDialog(id) {
  const st = state.students.find((x) => x.id === id);
  const o = G.overall(state, id);
  const w = o.components.find((c) => c.kind === 'work');
  const pw = G.personalWeightsOf(state, id);
  const hist = (g) => (g ? g.history.map((h) => `<li>${fmtDT(h.at)}: <b>${h.value === null ? 'ציון בוטל' : fmtG(h.value)}</b> · ${srcLabel(h.source)}${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('') : '');
  const taskRows = w.detail.rows.map((r) => { const g = G.gradeOf(state, r.taskId, id); return `<tr class="${r.excluded ? 'off' : ''}"><td>${esc(r.title)}</td><td>${r.excluded ? 'מוחרג' : `${fmtG(r.weight)}%${r.weight !== r.baseWeight ? ` <small class="muted">(במחזור ${fmtG(r.baseWeight)}%)</small>` : ''}`}</td><td>${fmtG(r.grade)}</td>
    <td>${g && g.history.length ? `<details><summary>היסטוריה (${g.history.length})</summary><ul class="plain">${hist(g)}</ul></details>` : ''}</td></tr>`; }).join('');
  const extraRows = o.components.filter((c) => c.kind === 'extra').map((c) => `<tr><td colspan="4"><b>${esc(c.name)}</b> (${fmtG(c.weight)}%): ${c.grade === null ? 'חסר' : fmtG(c.grade)} · ${c.detail.items.map((i) => `${esc(i.name)} ${fmtG(i.grade)}`).join(', ')}</td></tr>`).join('');
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>ציונים: ${esc(st.name)}</h2>
    <p>${o.ok ? `ציון כולל: <b>${o.rounded}</b> <span class="muted">(מדויק: ${fmtG(o.exact)})</span>` : `<b>הציון הכולל לא מחושב.</b>`}</p>
    ${o.problems.length ? `<ul class="plain">${o.problems.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ul>` : ''}
    <div class="table-wrap"><table class="compact"><thead><tr><th>משימה</th><th>משקל</th><th>ציון</th><th></th></tr></thead><tbody>${taskRows}${extraRows}</tbody></table></div>
    ${pw ? `<p class="muted">⚖ משקלים אישיים (נקבעו ב-${fmtD(pw.at.slice(0, 10))}): ${esc(pw.reason)}</p>` : ''}
    <div class="dlg-actions"><button class="btn small" data-action="gr-exclude" data-student="${esc(id)}">החרגת משימה לתלמיד זה…</button>
      ${w.detail.rows.some((r) => r.excluded) || pw ? `<button class="btn small" data-action="gr-weights" data-student="${esc(id)}">משקלים אישיים…</button>` : ''}
      ${pw ? `<button class="btn small danger" data-action="gr-pw-clear" data-student="${esc(id)}">בטל משקלים אישיים</button>` : ''}
      <button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}

function exclusionText(taskId, studentId) {
  const t = taskById(taskId);
  if (!t) return '';
  const imp = G.exclusionImpact(state, taskId, studentId || null);
  const who = studentId ? `לתלמיד ${studentNameOf(studentId)}` : 'לכל המחזור';
  return `משימה "${t.title}" בשווי ${fmtG(imp.weight)}% תוחרג ${who}. סכום המשקלים הרלוונטי יהיה ${fmtG(imp.newSum)}% (חסרים ${fmtG(imp.missing)}%), ולכן הציון הכולל ${studentId ? 'של התלמיד' : 'של כל התלמידים'} לא יחושב עד שתתאים משקלים (${studentId ? 'משקלים אישיים לתלמיד' : 'משקלי משימות למחזור'}). אין חלוקה מחדש אוטומטית. הציון שכבר נקבע במשימה לא נמחק, וההחרגה הפיכה.${!studentId && imp.personalOverrides.length ? ` תלמידים עם משקלים אישיים לא יושפעו מההתאמה הכללית: ${imp.personalOverrides.join(', ')}.` : ''}`;
}
function excludeDialog(studentId = '') {
  const tasks = gradedTasks().filter((t) => !G.isExcludedCycleWide(state, t.id));
  if (!tasks.length) { toast('אין משימות בעלות משקל להחרגה', true); return; }
  const students = G.studentsForGrades(state).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  ui.openTask = null;
  showDlg(`<div class="form wide" id="exD"><h2>החרגת משימה מהחישוב</h2>
    <p class="muted">אם התלמיד פשוט לא הגיש, בדרך כלל מזינים ציון 0 ולא מחריגים. החרגה היא החלטה מפורשת עם נימוק.</p>
    <label>משימה <select id="exTask">${tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} (${fmtG(t.weight)}%)</option>`).join('')}</select></label>
    <div class="subrow"><label class="chk"><input type="radio" name="exScope" value="one" checked> לתלמיד אחד:</label>
      <select id="exStu">${students.map((s) => `<option value="${esc(s.id)}" ${s.id === studentId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <label class="chk"><input type="radio" name="exScope" value="cycle"> לכל המחזור</label></div>
    <label>נימוק (חובה) <textarea id="exReason" rows="2" maxlength="${G.MAX_REASON}"></textarea></label>
    <div id="exImpact" class="alert"></div>
    <div class="dlg-actions"><button class="btn primary" id="exOk">החרג</button><button class="btn" id="exNo">ביטול</button></div></div>`);
  const d = $dlg.querySelector('#exD');
  const scope = () => d.querySelector('input[name="exScope"]:checked').value;
  const upd = () => { d.querySelector('#exImpact').textContent = exclusionText(d.querySelector('#exTask').value, scope() === 'one' ? d.querySelector('#exStu').value : ''); };
  d.addEventListener('input', () => { ui.dirty = true; upd(); });
  d.addEventListener('change', upd);
  upd();
  d.querySelector('#exNo').addEventListener('click', () => closeDlg());
  d.querySelector('#exOk').addEventListener('click', async () => {
    const sid = scope() === 'one' ? d.querySelector('#exStu').value : null;
    const tid = d.querySelector('#exTask').value;
    const ok = await grOp(() => api.excludeGradeTask(tid, { studentId: sid, reason: d.querySelector('#exReason').value }), 'המשימה הוחרגה. הציון הכולל לא יחושב עד שתתאים משקלים', { rerender: false });
    if (!ok) return;
    ui.dirty = false; $dlg.close(); render();
    weightsDialog(sid || '');
  });
}

function weightsDialog(studentId = '') {
  const rows = studentId
    ? G.workGrade(state, studentId).rows.filter((r) => !r.excluded).map((r) => ({ id: r.taskId, title: r.title, w: r.weight }))
    : state.tasks.filter((t) => T.isActive(t) && !G.isExcludedCycleWide(state, t.id) && Number(t.weight) > 0).sort((a, b) => a.order - b.order).map((t) => ({ id: t.id, title: t.title, w: Number(t.weight) }));
  if (!rows.length) { toast('אין משימות להתאמת משקלים', true); return; }
  ui.openTask = null;
  showDlg(`<div class="form wide" id="wtD"><h2>${studentId ? `משקלים אישיים: ${esc(studentNameOf(studentId))}` : 'התאמת משקלי משימות למחזור'}</h2>
    <p class="muted">הסכום חייב להיות 100%. המערכת אינה מחלקת משקלים מחדש בעצמה: אתה קובע. ${studentId ? 'ההתאמה חלה על התלמיד הזה בלבד.' : 'ההתאמה חלה על כל התלמידים שאין להם משקלים אישיים.'}</p>
    <table class="compact"><thead><tr><th>משימה</th><th>משקל (%)</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.title)}</td><td><input type="number" min="0" max="100" step="0.5" data-w="${esc(r.id)}" value="${esc(r.w)}"></td></tr>`).join('')}</tbody></table>
    <p id="wtSum"></p>
    ${studentId ? '<label>נימוק (חובה) <textarea id="wtReason" rows="2" maxlength="' + G.MAX_REASON + '"></textarea></label>' : ''}
    <div class="dlg-actions"><button class="btn primary" id="wtOk">שמירה</button><button class="btn" id="wtNo">ביטול</button></div></div>`);
  const d = $dlg.querySelector('#wtD');
  const read = () => Object.fromEntries([...d.querySelectorAll('[data-w]')].map((i) => [i.dataset.w, Number(i.value) || 0]));
  const upd = () => { const s = Object.values(read()).reduce((a, b) => a + b, 0); const el = d.querySelector('#wtSum'); el.innerHTML = `סכום: <b style="color:${Math.abs(s - 100) < 1e-6 ? 'var(--ok)' : 'var(--bad)'}">${fmtG(s)}%</b>${Math.abs(s - 100) < 1e-6 ? '' : ` (${s < 100 ? 'חסרים' : 'עודפים'} ${fmtG(Math.abs(100 - s))}%)`}`; };
  d.addEventListener('input', () => { ui.dirty = true; upd(); });
  upd();
  d.querySelector('#wtNo').addEventListener('click', () => closeDlg());
  d.querySelector('#wtOk').addEventListener('click', async () => {
    const ok = await grOp(() => (studentId ? api.setPersonalGradeWeights(studentId, read(), { reason: d.querySelector('#wtReason').value }) : api.setGradeTaskWeights(read())), 'המשקלים נשמרו', { rerender: false });
    if (ok) { ui.dirty = false; $dlg.close(); render(); }
  });
}

function schemeEditorDialog() {
  const sc = G.schemeOf(state);
  const comp = (c) => `<div class="gr-comp" data-id="${esc(c.id)}" data-kind="${c.kind}"><div class="rb-top"><input type="text" data-f="name" value="${esc(c.name)}" placeholder="שם הרכיב" ${c.kind === 'work' ? 'readonly' : ''}>
      <label class="rb-max">משקל בציון הסופי (%) <input type="number" data-f="weight" min="0" max="100" step="0.5" value="${esc(c.weight)}"></label>
      ${c.kind === 'extra' ? '<button type="button" class="btn small danger" data-action="gr-comp-del">✕ הסר רכיב</button>' : '<span class="muted">רכיב העבודה (לפי משקלי המשימות)</span>'}</div>
    ${c.kind === 'extra' ? `<div class="gr-items">${c.items.map(itemRow).join('')}</div><button type="button" class="btn small" data-action="gr-item-add">+ פריט</button>` : ''}</div>`;
  const itemRow = (i) => `<div class="gr-item" data-id="${esc(i.id || '')}"><input type="text" data-f="iname" value="${esc(i.name || '')}" placeholder="שם הפריט (למשל: בוחן 1)"><label class="rb-max">משקל ברכיב (%) <input type="number" data-f="iweight" min="0.5" max="100" step="0.5" value="${esc(i.weight ?? 50)}"></label><button type="button" class="btn small danger" data-action="gr-item-del">✕</button></div>`;
  ui.openTask = null;
  showDlg(`<div class="form wide rb-editor" id="scD"><h2>עריכת ערכת הציונים</h2>
    <p class="muted">סכום משקלי הרכיבים צריך להיות 100%, וסכום משקלי הפריטים בכל רכיב נוסף 100%. פריט שכבר הוזנו לו ציונים אי אפשר להסיר. ציונים הם אישיים לכל תלמיד.</p>
    <div id="scComps">${sc.components.map(comp).join('')}</div>
    <div class="subrow"><button type="button" class="btn small" data-action="gr-comp-add">+ רכיב נוסף (תלמידאות, בחנים…)</button></div>
    <p id="scSum" class="muted"></p>
    <div class="dlg-actions"><button class="btn primary" id="scOk">שמירה</button><button class="btn" id="scNo">ביטול</button></div></div>`);
  const d = $dlg.querySelector('#scD');
  const read = () => [...d.querySelectorAll('.gr-comp')].map((c) => ({ id: c.dataset.id || undefined, kind: c.dataset.kind, name: c.querySelector('[data-f="name"]').value, weight: c.querySelector('[data-f="weight"]').value,
    items: [...c.querySelectorAll('.gr-item')].map((i) => ({ id: i.dataset.id || undefined, name: i.querySelector('[data-f="iname"]').value, weight: i.querySelector('[data-f="iweight"]').value })) }));
  const upd = () => { const s = read().reduce((n, c) => n + (Number(c.weight) || 0), 0); d.querySelector('#scSum').innerHTML = `סכום משקלי הרכיבים: <b style="color:${Math.abs(s - 100) < 1e-6 ? 'var(--ok)' : 'var(--bad)'}">${fmtG(s)}%</b>`; };
  d.addEventListener('input', () => { ui.dirty = true; upd(); });
  d.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'gr-comp-add') { d.querySelector('#scComps').insertAdjacentHTML('beforeend', comp({ id: '', kind: 'extra', name: '', weight: 0, items: [{ name: '', weight: 100 }] })); ui.dirty = true; upd(); ev.stopPropagation(); }
    else if (a.dataset.action === 'gr-comp-del') { a.closest('.gr-comp').remove(); ui.dirty = true; upd(); ev.stopPropagation(); }
    else if (a.dataset.action === 'gr-item-add') { a.previousElementSibling.insertAdjacentHTML('beforeend', itemRow({})); ui.dirty = true; ev.stopPropagation(); }
    else if (a.dataset.action === 'gr-item-del') { const box = a.closest('.gr-items'); if (box.children.length > 1) { a.closest('.gr-item').remove(); ui.dirty = true; } ev.stopPropagation(); }
  }, true);
  upd();
  d.querySelector('#scNo').addEventListener('click', () => closeDlg());
  d.querySelector('#scOk').addEventListener('click', async () => {
    const ok = await grOp(() => api.setGradeScheme({ components: read() }), 'ערכת הציונים נשמרה', { rerender: false });
    if (ok) { ui.dirty = false; $dlg.close(); render(); }
  });
}

function templateSaveDialog() {
  openDialog(`<h2>שמירה כתבנית אישית</h2>
    <p class="muted">התבנית שומרת את מבנה הרכיבים והמשקלים בלבד, בלי ציוני תלמידים. שימוש בה במחזור אחר יוצר עותק עצמאי: שינויים בו לא ישנו את התבנית.</p>
    <label>שם התבנית <input type="text" name="name" required maxlength="100" placeholder="למשל: ערכת הציונים שלי"></label>`,
  (f) => grOp(() => api.saveGradeTemplate(fd(f).name), 'התבנית נשמרה', { rerender: false }).then((ok) => { if (ok) render(); return ok; }));
}

// ---------- קביעת ציון מניקוד (במסך הבדיקה) ----------
function setGradeDialog(subId) {
  const sub = (state.submissions || []).find((x) => x.id === subId);
  const pv = G.applyPreview(state, subId);
  if (!pv.ready) { toast('הניקוד טרם הושלם', true); return; }
  const anyInd = pv.students.some((s) => s.individual);
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>קביעת ציון המשימה: ${fmtG(pv.percent)} מתוך 100</h2>
    <p>הציון ייקבע כציון התקף של ${sub.unitType === 'group' ? 'חברי הקבוצה <b>במועד ההגשה</b> (' + fmtDT(sub.uploadedAt) + ')' : 'התלמיד'}. תלמיד שעבר קבוצה שומר את ציוניו, ותלמיד שהצטרף אחרי ההגשה לא יקבל ציון אוטומטי (אפשר לקבוע לו ציון ידני במסך "ציונים"). ציון קודם נשמר בהיסטוריה.</p>
    <ul class="plain">${pv.students.map((s) => `<li>${esc(s.name)}${s.activeNow ? '' : ' <span class="muted">(לא פעיל)</span>'}: ציון קיים ${fmtG(s.current)}${s.individual ? ' 👤 <b>ציון אישי ידני</b>' : ''}</li>`).join('')}</ul>
    ${anyInd ? '<label class="chk"><input type="checkbox" id="sgOver"> לדרוס גם ציונים אישיים ידניים (אחרת הם נשארים)</label>' : ''}
    <p class="muted">זה ציון פנימי: אינו מפורסם לתלמידים.</p>
    <div class="dlg-actions"><button class="btn primary" id="sgOk">קבע כציון המשימה</button><button class="btn" id="sgNo">ביטול</button></div></div>`);
  $dlg.querySelector('#sgNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#sgOk').addEventListener('click', async () => {
    const over = $dlg.querySelector('#sgOver') ? $dlg.querySelector('#sgOver').checked : false;
    $dlg.close();
    await scOp(() => api.setGradeFromSheet(subId, { overwriteIndividual: over }), 'הציון נקבע (פנימי, לא מפורסם)');
    renderReviewPublic();
  });
}

// ---------- תשתית AI (ללא ספק אמיתי): צד המורה ----------
const AI_KIND = { local: '📍 הצעה מקומית', general: '💬 הערה כללית מכוונת (ללא מיקום)' };
function aiReadForm() {
  const g = (id) => document.getElementById(id);
  if (!g('aiRubric')) return;
  Object.assign(ui.aiForm, { rubric: g('aiRubric').value, prompt: g('aiPrompt').value, oneTime: g('aiOneTime').value, provider: g('aiProvider').value, model: g('aiModel').value, confirmed: g('aiConfirm').checked });
}
function aiScanHtml(sc) {
  if (!sc) return '<p class="muted">הסורק עוד לא הופעל על הגרסה הזו.</p>';
  const li = (x) => `<li><b>${esc(x.label)}</b>${x.page ? ` · עמוד ${x.page}` : ''} · <code>${esc(x.preview)}</code></li>`;
  return `<div class="ai-scan ${sc.verdict}"><b>${esc(sc.headline)}</b>
    ${sc.blocking.length ? `<p><b>חוסם (אין עקיפה בנימוק):</b></p><ul class="plain">${sc.blocking.slice(0, 20).map(li).join('')}</ul>` : ''}
    ${sc.weak.length ? `<p class="muted">חלש, לתשומת לב בלבד (אינו חוסם):</p><ul class="plain">${sc.weak.slice(0, 20).map(li).join('')}</ul>` : ''}
    <p class="ai-caveat">⚠ ${esc(sc.caveat)}</p></div>`;
}
function aiProposalHtml(p) {
  const cat = R.categoryOf(state, p.categoryId);
  const open = p.aiState === 'proposed';
  const fail = A.needsAnchorCheck(p);
  const state_ = p.aiState === 'approved' ? '<span class="wbadge st-active">✔ אושרה: נוצרה טיוטה</span>' : p.aiState === 'rejected' ? '<span class="wbadge st-none">נדחתה</span>' : '<span class="wbadge st-pending">הצעה, ממתינה להחלטה</span>';
  const where = p.intent === 'general' ? AI_KIND.general : p.anchor ? `📍 עמוד ${p.anchor.page}${p.anchorStatus === 'manual' ? ' (שויכה ידנית)' : ''}` : AI_KIND.local;
  return `<li class="ai-prop ${fail ? 'fail' : ''} ${open ? '' : 'done'}" data-id="${esc(p.id)}">
    <div class="rv-top"><span class="wbadge ai-badge">🤖 הצעת AI · לא גלויה לתלמיד</span> <span class="tag" style="background:${esc(cat.color)}">${esc(cat.name)}</span> <small>${where}</small> ${state_}</div>
    ${p.quote ? `<div class="q">«${esc(p.quote.slice(0, 120))}${p.quote.length > 120 ? '…' : ''}»</div>` : ''}
    ${fail ? `<div class="alert ai-anchor-fail"><b>⚠ העיגון נכשל.</b> ${esc(p.anchorNote)}. זו הצעה מקומית שלא נמצא לה מיקום חד-משמעי, ולכן נדרשת בדיקה לפני אישור. סמן קטע במסמך ולחץ "שייך לקטע המסומן", או הפוך אותה במפורש להערה כללית.</div>` : ''}
    ${open ? `<textarea data-f="aitext" rows="2" maxlength="${R.MAX_TEXT}">${esc(p.text)}</textarea>` : `<div class="rv-text">${esc(p.text)}</div>`}
    ${open ? `<div class="subrow rv-write">
      ${fail ? `<button class="btn small" data-action="ai-anchor" data-id="${esc(p.id)}" ${ui.rvSel ? '' : 'disabled'} title="${ui.rvSel ? 'משייך את ההצעה לקטע שסומן במסמך' : 'סמן קודם קטע במסמך'}">📍 שייך לקטע המסומן</button><button class="btn small" data-action="ai-general" data-id="${esc(p.id)}">💬 הפוך להערה כללית</button>` : ''}
      <button class="btn small primary" data-action="ai-approve" data-id="${esc(p.id)}" ${fail ? 'disabled title="העיגון נכשל: נדרשת בדיקה לפני אישור"' : ''}>✔ אשר כטיוטה</button>
      <button class="btn small danger" data-action="ai-reject" data-id="${esc(p.id)}">דחה</button></div>` : ''}</li>`;
}
function aiRoundHtml(r) {
  const props = A.proposalsOfRound(state, r.id);
  return `<details class="ai-round"><summary>סבב מ-${fmtDT(r.createdAt)} · גרסה ${r.submissionVersion} · ${esc((A.PROVIDERS[r.provider] || {}).label || r.provider)}${r.model ? ' · ' + esc(r.model) : ''} · ${props.length} הצעות</summary>
    <p class="muted">צילום מצב קבוע: שינוי עתידי במחוון או בפרומפט לא ישפיע על הסבב הזה.</p>
    <h4>מחוון ששימש (מזהה ${esc(r.rubric.fingerprint)})</h4><pre class="ai-snap">${esc(r.rubric.text) || '—'}</pre>
    <h4>פרומפט ששימש (מזהה ${esc(r.prompt.fingerprint)})</h4><pre class="ai-snap">${esc(r.prompt.text) || '—'}</pre>
    ${r.oneTime ? `<h4>הוראה חד-פעמית</h4><pre class="ai-snap">${esc(r.oneTime)}</pre>` : ''}
    <p>ציון מוצע: <b>${r.proposedGrade ?? '—'}</b> · ציון תקף: <b>${r.validGrade ?? '—'}</b> <span class="muted">(שני הציונים ריקים. אין ציון אוטומטי ואין פרסום ציון.)</span></p>
    <p class="muted">בדיקת פרטיות בסבב: ${esc(r.privacy.scan.weakCount ? `לא זוהה מידע מזהה ברור; ${r.privacy.scan.weakCount} פרטים חלשים (לא חוסמים). זה לא אומר שהמסמך בטוח` : 'לא זוהה מידע רגיש בבדיקה בסיסית (זה לא אומר שהמסמך בטוח)')}; אישור ידני של המורה נרשם.</p></details>`;
}
function aiPanelHtml(sub) {
  const on = A.isAiEnabled(state);
  const f = ui.aiForm;
  const q = A.quarantineOf(state, sub.id);
  const sum = A.proposalSummary(state, sub.id);
  const rounds = A.roundsOf(state, sub.id);
  const props = A.proposalsOf(state, sub.id).sort((a, b) => (a.aiState === 'proposed' ? 0 : 1) - (b.aiState === 'proposed' ? 0 : 1));
  return `<details id="aiDet" ${ui.aiOpen ? 'open' : ''}><summary><b>🤖 תשתית AI (ניסיוני)</b> <span class="wbadge ${on ? 'st-late' : 'st-none'}">${on ? 'פעילה' : 'כבויה'}</span>${sum.open ? ` <span class="wbadge st-pending">${sum.open} הצעות ממתינות${sum.needAnchor ? `, ${sum.needAnchor} עם עיגון שנכשל` : ''}</span>` : ''}</summary>
    <div class="alert info"><b>אין חיבור לספק בינה מלאכותית אמיתי ואין העברת נתונים החוצה.</b> הספק המדומה פועל במחשב הזה בלבד, על מסמכי דמה. הצעות AI אינן גלויות לתלמידים, ורק הערה שאישרת ושלחת בשליחת משוב מפורשת תופיע להם. לא נשלחים ולא נשמרים ציונים.</div>
    <label class="chk rv-write"><input type="checkbox" id="aiToggle" data-action="ai-toggle" ${on ? 'checked' : ''}> הפעל את תשתית ה-AI (כבויה כברירת מחדל)</label>
    ${on ? `
    <div class="ai-block"><h4>1. הסגר ידני</h4>
      ${q ? `<p class="alert"><b>המסמך בהסגר ידני</b> מאז ${fmtDT(q.at)}${q.reason ? ': ' + esc(q.reason) : ''}. אי אפשר להפעיל עליו סבב.</p><button class="btn small rv-write" data-action="ai-quarantine" data-on="0">הוצא מהסגר</button>`
    : `<div class="subrow rv-write"><input type="text" id="aiQReason" placeholder="סיבה (אופציונלי)" maxlength="${A.MAX_REASON}"><button class="btn small" data-action="ai-quarantine" data-on="1">העבר להסגר ידני</button></div><p class="muted">הסגר חוסם את המסמך לעיבוד AI עד שתוציא אותו ממנו.</p>`}</div>
    <div class="ai-block"><h4>2. סבב בדיקה (נשמר כצילום מצב קבוע)</h4>
      <label>מחוון (עותק קבוע יישמר בסבב) <textarea id="aiRubric" rows="3" maxlength="${A.MAX_RUBRIC}" placeholder="נוסח המחוון">${esc(f.rubric)}</textarea></label>
      <label>פרומפט <textarea id="aiPrompt" rows="3" maxlength="${A.MAX_PROMPT}" placeholder="הנחיה ל-AI">${esc(f.prompt)}</textarea></label>
      <label>הוראה חד-פעמית <input type="text" id="aiOneTime" maxlength="${A.MAX_ONE_TIME}" value="${esc(f.oneTime)}"></label>
      <div class="subrow"><label>ספק <select id="aiProvider">${Object.entries(A.PROVIDERS).map(([k, v]) => `<option value="${k}" ${f.provider === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label>מודל <input type="text" id="aiModel" maxlength="60" value="${esc(f.model)}"></label></div>
      <h4>3. שער פרטיות</h4>
      <button class="btn small" data-action="ai-scan" ${R.reviewable(sub) ? '' : 'disabled'}>🔎 הפעל סורק פרטיות בסיסי</button>
      <div id="aiScanOut">${aiScanHtml(ui.aiScan)}</div>
      <label class="chk"><input type="checkbox" id="aiConfirm" ${f.confirmed ? 'checked' : ''}> בדקתי ידנית את המסמך ואני מאשר שאין בו מידע מזהה. (חובה גם כשהסורק לא סימן דבר.)</label>
      <button class="btn primary rv-write" data-action="ai-run" ${q || !R.reviewable(sub) ? 'disabled' : ''}>▶ הפעל סבב</button>
    </div>` : ''}
    ${rounds.length ? `<div class="ai-block"><h4>סבבים קודמים (${rounds.length})</h4>${rounds.map(aiRoundHtml).join('')}</div>` : ''}
    ${props.length ? `<div class="ai-block"><h4>הצעות (${sum.open} ממתינות, ${sum.approved} אושרו, ${sum.rejected} נדחו)</h4><ul class="ai-props">${props.map(aiProposalHtml).join('')}</ul></div>` : ''}
  </details>`;
}
function renderAi() {
  const el = document.getElementById('rvAi');
  const sub = reviewSubmission();
  if (!el || !sub) return;
  aiReadForm();
  const open = document.getElementById('aiDet');
  if (open) ui.aiOpen = open.open;
  el.innerHTML = aiPanelHtml(sub);
  lockArchived(el);
}
async function aiOp(fn, msg) {
  aiReadForm();
  const ok = await revOp(fn, msg);
  renderAi();
  return ok;
}
function aiPages() {
  const pages = ui.viewer && ui.viewer.pageTexts ? ui.viewer.pageTexts() : [];
  if (!pages.length) throw new Error('המסמך עוד לא נטען');
  return pages;
}

// מצב פרסום של ציון המשימה והמשוב להגשה, עם ביטול ממוקד לכל פריט
function gradePubHtml(sub) {
  let cand = [];
  try { cand = PB.gradePublishCandidates(state, sub.id); } catch (e) { cand = []; }
  const ps = PB.publicationSummary(state, sub.id);
  const rows = cand.filter((c) => c.status !== 'empty' || c.pub).map((c) => {
    const can = ['waiting', 'changed', 'retracted'].includes(c.status);
    const canR = ['published', 'changed', 'blocked'].includes(c.status);
    return `<li class="pub-row pub-${c.status}"><b>${esc(c.name)}</b>: ${esc(({ waiting: `ציון ${c.currentShown} · ממתין לפרסום`, published: `פורסם: ${c.pub && c.pub.shown}`, changed: `פורסם ${c.pub && c.pub.shown}, כעת ${c.currentShown} · שינוי שטרם פורסם`, blocked: `פורסם ${c.pub && c.pub.shown} (הציון הנוכחי חסר או מוחרג)`, retracted: `בוטל הפרסום (היה ${c.pub && c.pub.shown}) · לא גלוי לתלמיד`, empty: 'אין ציון' })[c.status])}
      ${can ? `<button class="btn small rv-write" data-action="pub-grade" data-student="${esc(c.studentId)}">${c.status === 'retracted' ? 'פרסם מחדש' : 'פרסם ציון'}</button>` : ''}${canR ? `<button class="btn small danger rv-write" data-action="retract-grade" data-student="${esc(c.studentId)}">↩ בטל פרסום</button>` : ''}</li>`;
  }).join('');
  return `<div class="pub-box"><h4>מצב פרסום</h4>
    <p>הערות: <b>📤 פורסמו ${ps.published}</b> · <b>↩ בוטל פרסום ${ps.retracted}</b> · <b>📝 ממתינות ${ps.waiting}</b>${ps.published ? ' <button class="btn small danger rv-write" data-action="retract-fb">↩ בטל פרסום כל המשוב</button>' : ''}</p>
    ${rows ? `<p class="muted">ציון המשימה (התלמיד רואה ציון שלם בלבד):</p><ul class="plain">${rows}</ul>` : '<p class="muted">אין עדיין ציונים להגשה הזו. ציון נקבע מהניקוד ("קבע כציון המשימה") או במסך "ציונים".</p>'}</div>`;
}

function renderReviewInternal() {
  const el = document.getElementById('rvInternal');
  const sub = reviewSubmission();
  if (el && sub) { el.innerHTML = reviewInternalHtml(sub); lockArchived(el); const n = document.getElementById('rvNote'); if (n && state.archived) n.disabled = true; }
}
function renderReviewPublic() {
  const el = document.getElementById('rvPublic');
  const sub = reviewSubmission();
  if (el && sub) { el.innerHTML = reviewPublicHtml(sub); lockArchived(el); }
}

const GRADE_ST = {
  empty: 'אין ציון (לא יפורסם)', waiting: 'ציון {cur} יפורסם', published: 'כבר פורסם ({pub})', changed: 'פורסם {pub}, כעת {cur}: יתעדכן',
  blocked: 'פורסם {pub} (הציון הנוכחי חסר או מוחרג)', retracted: 'בוטל פרסומו: לא יתפרסם מחדש כאן, אפשר לפרסם בנפרד',
};
const gradeStText = (c) => GRADE_ST[c.status].replace('{cur}', c.currentShown).replace('{pub}', c.pub ? c.pub.shown : '');
function sendDialog(subId) {
  const sub = (state.submissions || []).find((x) => x.id === subId);
  const sum = F.sendSummary(state, subId);
  if (!sum.total) { toast('אין הערות טיוטה לשליחה', true); return; }
  const cand = PB.gradePublishCandidates(state, subId);
  const willGrade = cand.filter((c) => c.current !== null && c.status !== 'published' && c.status !== 'retracted').length;
  ui.openTask = null;
  showDlg(`<div class="form"><h2>שליחת משוב לתלמידים</h2>
    <p>${sum.alreadySent ? '<b>זו תוספת למשוב שכבר נשלח.</b> ' : ''}ייפרסמו עכשיו <b>${sum.total}</b> הערות (${sum.general} כלליות, ${sum.local} מקומיות)${sum.retracted ? `, מהן ${sum.retracted} שבוטל פרסומן ופורסמו מחדש` : ''}. התלמידים יראו אותן מיד.</p>
    <ul class="plain">${sum.audiences.map((a) => `<li>${a.studentId ? `👤 אישית ל-${esc(a.name)}` : `👥 ${esc(a.name)}`}: ${a.count}</li>`).join('')}</ul>
    ${sum.orphan ? `<div class="alert"><b>⚠ ${sum.orphan} הערות אישיות מיועדות לתלמיד שאינו חבר בקבוצה כעת,</b> ולכן לא יהיו גלויות לאיש.</div>` : ''}
    <div class="card gr-send"><label class="chk"><input type="checkbox" id="sendGrade" ${willGrade ? 'checked' : 'disabled'}> <b>פרסם גם את ציון המשימה</b> (התלמיד יראה ציון שלם בלבד)</label>
      <ul class="plain">${cand.map((c) => `<li>${esc(c.name)}: ${esc(gradeStText(c))}</li>`).join('')}</ul>
      <p class="muted">הסימון מסומן כברירת מחדל וניתן לבטל אותו. ציון שבוטל פרסומו אינו מתפרסם מחדש בשליחה הזו. פרסום הציון הכולל הוא פעולה נפרדת במסך "ציונים".</p></div>
    <p class="muted">אפשר לבטל פרסום של כל הערה או ציון בנפרד, ואחר כך לתקן ולפרסם מחדש (מידע שהתלמיד כבר ראה אי אפשר למחוק).</p>
    <div class="dlg-actions"><button class="btn primary big" id="sendOk">📤 שלח משוב</button><button class="btn" id="sendNo">ביטול</button></div></div>`);
  $dlg.querySelector('#sendNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#sendOk').addEventListener('click', async () => {
    const grade = $dlg.querySelector('#sendGrade').checked;
    $dlg.close();
    const ok = await revOp(() => api.sendFeedbackWithGrade(sub.id, { publishGrade: grade }), `המשוב נשלח: ${sum.total} הערות פורסמו${grade ? ' (ובנוסף ציון המשימה לזכאים)' : ''}`);
    if (ok && route() !== 'review') render();
  });
}

function batchDialog() {
  const ready = F.sendableBatch(state);
  const unchecked = (state.submissions || []).filter((x) => !F.reviewOf(state, x.id).checked && F.draftsOf(state, x.id).length).length;
  if (!ready.length) { toast('אין עבודות שסומנו "סיימתי לבדוק" וכוללות הערות טיוטה', true); return; }
  const label = (x) => { const t = taskById(x.taskId); const u = (T.unitsOfTask(state, t).find((y) => y.type === x.unitType && y.id === x.unitId) || {}).name || ''; return `${esc(t.title)}: ${esc(u)} (גרסה ${x.version})`; };
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>שליחת משוב לכל העבודות הבדוקות</h2>
    <p>ייפרסמו הערות הטיוטה ב-${ready.length} עבודות שסימנת "סיימתי לבדוק". התלמידים יראו אותן מיד.</p>
    <ul class="plain">${ready.map((x) => `<li>${label(x)}: ${F.draftsOf(state, x.id).length} הערות</li>`).join('')}</ul>
    ${unchecked ? `<p class="muted">${unchecked} עבודות עם הערות טיוטה לא סומנו "סיימתי לבדוק" ולא ייכללו בשליחה.</p>` : ''}
    <label class="chk"><input type="checkbox" id="batchGrade" checked> פרסם גם את ציוני המשימה הקיימים לזכאים (ציון שלם בלבד; ציון שבוטל פרסומו לא יתפרסם מחדש)</label>
    <div class="dlg-actions"><button class="btn primary big" id="batchOk">📤 שלח משוב ל-${ready.length} עבודות</button><button class="btn" id="batchNo">ביטול</button></div></div>`);
  $dlg.querySelector('#batchNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#batchOk').addEventListener('click', async () => {
    const grade = $dlg.querySelector('#batchGrade').checked;
    $dlg.close();
    await run(() => api.sendBatchWithGrades(ready.map((x) => x.id), { publishGrade: grade }), `המשוב נשלח ב-${ready.length} עבודות`);
  });
}

// תג מצב משוב בשורת המעקב
function feedbackCell(r) {
  if (!r.latest) return '<span class="muted">—</span>';
  const id = r.latest.id;
  const rv = F.reviewOf(state, id);
  const fs = F.feedbackState(state, id);
  const d = F.draftsOf(state, id).length;
  const oq = F.openQuestionsOf(state, id).length;
  const parts = [];
  if (rv.checked) parts.push('<span class="wbadge st-active" title="סימון פנימי של המורה. אינו גלוי לתלמידים">✔ נבדק (פנימי)</span>');
  if (rv.treated) parts.push('<span class="wbadge st-none">טופל</span>');
  if (fs === 'draft') parts.push(`<span class="wbadge st-late" title="התלמידים לא רואים אותן">📝 ${d} טיוטות, לא נשלח</span>`);
  if (fs === 'sent') parts.push('<span class="wbadge st-active">📤 משוב נשלח</span>');
  if (fs === 'sent+drafts') parts.push(`<span class="wbadge st-active">📤 נשלח</span> <span class="wbadge st-late">+ ${d} טיוטות</span>`);
  if (oq) parts.push(`<button class="btn small" data-action="open-question" data-id="${esc(F.firstOpenQuestionOf(state, id).comment.id)}" title="עבור ישר לשאלה הפתוחה">❓ ${oq} שאלות</button>`);
  return parts.join(' ') || '<span class="muted">—</span>';
}

// ברירת מחדל: כל ההערות מצומצמות. הערה שנבחרה (לחיצה עליה או על הקטע שלה) נפתחת, וניתן לפתוח ולצמצם כל הערה.
const rvIsOpen = (id) => ui.rvOpen.has(id) || ui.rvEdit === id;
const rvOpenOnly = (id) => { ui.rvOpen = new Set(id ? [id] : []); };

function rvAudience(c, sub) {
  if (c.studentId) return `<span class="aud p">👤 אישית: ${esc(studentNameOf(c.studentId))}</span>`;
  if (sub.unitType === 'group') return '<span class="aud g">👥 לכל הקבוצה</span>';
  return `<span class="aud p">👤 ${esc(studentNameOf(sub.uploadedBy))}</span>`;
}

// שרשור תגובות ושאלות (למורה): רואה הכול ועונה
function teacherThreadHtml(c) {
  const th = F.threadOf(state, c.id);
  const oq = new Map(F.openQuestionsOf(state, c.submissionId).filter((x) => x.comment.id === c.id).map((x) => [x.question.id, true]));
  const rows = th.map((e) => `<div class="thr ${e.authorRole}"><b>${e.authorRole === 'teacher' ? 'המורה' : esc(studentNameOf(e.authorId))}</b> <small class="muted">${fmtDT(e.createdAt)}${e.kind === 'question' ? ' · שאלת הבהרה' : e.kind === 'answer' ? ' · תשובה' : ''}</small>
      <div class="rv-text">${esc(e.text)}</div>${oq.get(e.id) ? `<button class="btn small primary rv-write" data-action="rv-answer" data-id="${esc(c.id)}" data-q="${esc(e.id)}">❓ ענה על השאלה (בטקסט שלמטה)</button>` : ''}</div>`).join('');
  return `<div class="thr-box"><h4>תגובות ושאלות (${th.length})</h4>${rows || '<p class="muted">אין תגובות.</p>'}
    <textarea data-f="thread" rows="2" maxlength="${F.MAX_THREAD_TEXT}" placeholder="תגובה לתלמידים על ההערה"></textarea>
    <div class="subrow rv-write"><button class="btn small" data-action="rv-reply" data-id="${esc(c.id)}">שלח תגובה</button></div>
    <p class="muted">תגובה שנשלחת כאן גלויה מיד לאותם תלמידים שרואים את ההערה.</p></div>`;
}

function renderReviewList() {
  const ul = document.getElementById('rvList');
  const sub = reviewSubmission();
  if (!ul || !sub) return;
  const rt = (ui.viewer && ui.viewer.runtime) || new Map();
  const list = R.commentsOf(vs(), sub.id);
  const startOf = (c) => ((rt.get(c.id) || {}).start ?? (c.anchor ? c.anchor.start : 0));
  // הערות כלליות בראש, החדשה ביותר ראשונה. אחריהן הערות מקומיות לפי מיקום במסמך.
  const sortedAll = [...list.filter((c) => !c.anchor).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), ...list.filter((c) => c.anchor).sort((a, b) => a.anchor.page - b.anchor.page || startOf(a) - startOf(b))];
  const fl = ['all', 'draft', 'sent'].includes(ui.rvFilter) ? ui.rvFilter : 'all';
  const sorted = sortedAll.filter((c) => fl === 'all' || (fl === 'draft' && c.status === 'draft') || (fl === 'sent' && c.status === 'published'));
  const cats = R.activeCategories(state);
  const members = sub.unitType === 'group' ? L.membersOf(state, sub.unitId) : [];
  const openQ = new Set(F.openQuestionsOf(state, sub.id).map((x) => x.comment.id));
  const nSent = list.filter((c) => c.status === 'published').length;
  const nDraft = list.length - nSent;
  const chip = (k, t, n) => `<button class="chip small ${fl === k ? 'on' : ''}" data-action="rv-filter" data-v="${k}" aria-pressed="${fl === k}">${t} <span class="chip-n">${n}</span></button>`;
  document.getElementById('rvCounts').innerHTML = `<div class="rv-sumline"><b>📤 נשלחו: ${nSent}</b> <span class="muted">·</span> <b>📝 בטיוטה: ${nDraft}</b></div><div class="chips" role="group" aria-label="סינון הערות">${chip('all', 'הכל', list.length)}${chip('draft', 'טיוטות', nDraft)}${chip('sent', 'נשלחו', nSent)}</div>`;
  document.getElementById('rvCount').textContent = sorted.length;
  ul.innerHTML = sorted.map((c) => {
    const cat = R.categoryOf(state, c.categoryId);
    const st = (rt.get(c.id) || {}).status;
    const open = rvIsOpen(c.id);
    const isDraft = c.status === 'draft';
    const prob = A.anchorProblem(c, st);
    const warn = !c.anchor ? '' : st === 'relocated' ? '<div class="warn">המיקום אותר מחדש לפי הציטוט.</div>'
      : prob === 'failed' ? '<div class="alert ai-anchor-fail"><b>⚠ העיגון נכשל.</b> זו הערה מקומית שלא נמצא לה מיקום חד-משמעי במסמך הנוכחי (מוצג הציטוט בלבד). בדוק אותה לפני שליחה: ערוך או מחק אותה, או כתוב אותה מחדש כהערה כללית.</div>' : '';
    const badge = isDraft ? (c.retracted ? '<span class="wbadge st-late" title="בוטל הפרסום: התלמיד אינו רואה את ההערה. אפשר לתקן ולפרסם מחדש בשליחת משוב">↩ בוטל פרסום</span>' : '<span class="wbadge st-none" title="התלמיד לא רואה את ההערה עד לשליחת משוב">📝 טיוטה</span>')
      : `<span class="wbadge st-active" title="פורסמה ${fmtDT(c.publishedAt)}">📤 נשלחה</span>`;
    const head = `<div class="rv-top"><button type="button" class="rv-tg" data-action="rv-toggle" data-id="${esc(c.id)}" aria-expanded="${open}" aria-label="${open ? 'צמצם הערה' : 'הרחב הערה'}">${open ? '▾' : '▸'}</button>
      <span class="tag" style="background:${esc(cat.color)}">${esc(cat.name)}</span> <small>${c.anchor ? `עמוד ${c.anchor.page}` : '💬 הערה כללית, ללא מיקום במסמך (מכוונת)'}</small> ${A.anchorProblem(c, st) === 'failed' ? '<span class="wbadge st-late">⚠ עיגון נכשל</span>' : ''} ${c.origin === 'ai-approved' ? '<span class="wbadge ai-badge" title="נוצרה מהצעת AI שאישרת">🤖 מהצעת AI</span>' : ''} ${rvAudience(c, sub)}
      ${badge}${c._pending ? ' <span class="wbadge st-pending" title="ההערה נשמרת ברקע. היא כבר מופיעה כאן">⏳ שומר...</span>' : ''}${c._failed ? ' <span class="wbadge st-late" title="' + esc(c._failed) + '">⚠ השמירה נכשלה</span>' : ''}${openQ.has(c.id) ? ' <span class="wbadge st-pending">❓ שאלה ממתינה</span>' : ''}</div>`;
    const cls = `rv-item ${open ? 'open' : 'closed'} ${c.id === ui.rvActive ? 'active' : ''} ${c.id === ui.rvNew ? 'just-added' : ''}`;
    if (ui.rvEdit === c.id && isDraft) {
      return `<li class="${cls} editing" data-id="${esc(c.id)}">${head}${c.anchor ? `<div class="q">«${esc(c.anchor.quote.slice(0, 80))}»</div>` : ''}
        <label>קטגוריה <select data-f="cat">${[...cats, ...(cats.some((x) => x.id === c.categoryId) ? [] : [cat])].map((x) => `<option value="${esc(x.id)}" ${x.id === c.categoryId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        ${members.length ? `<label>למי <select data-f="aud"><option value="">👥 לכל הקבוצה</option>${members.map((m) => `<option value="${esc(m.id)}" ${m.id === c.studentId ? 'selected' : ''}>👤 אישית: ${esc(m.name)}</option>`).join('')}</select></label>` : ''}
        <textarea data-f="text" rows="3" maxlength="${R.MAX_TEXT}">${esc(c.text)}</textarea>
        <div class="subrow"><button class="btn small primary" data-action="rv-save" data-id="${esc(c.id)}">שמירה</button><button class="btn small" data-action="rv-cancel">ביטול</button></div></li>`;
    }
    if (!open) return `<li class="${cls}" data-id="${esc(c.id)}">${head}<div class="rv-preview">${esc(c.text)}</div></li>`;
    return `<li class="${cls}" data-id="${esc(c.id)}">${head}
      ${c.anchor ? `<div class="q">«${esc(c.anchor.quote.slice(0, 80))}${c.anchor.quote.length > 80 ? '…' : ''}»</div>` : ''}${warn}
      <div class="rv-text">${esc(c.text)}</div>
      ${c._failed ? `<div class="rv-btns rv-write"><button class="btn small primary" data-action="wq-open">פרטי הכשל, ניסיון חוזר או ביטול</button></div>` : isDraft ? `<div class="rv-btns rv-write"><button class="btn small" data-action="rv-edit" data-id="${esc(c.id)}">עריכה</button>${(c.pubHistory || []).length ? '' : `<button class="btn small danger" data-action="rv-del" data-id="${esc(c.id)}">מחיקה</button>`}</div>${c.retracted ? `<p class="muted">בוטל הפרסום ב-${fmtDT(c.retractedAt)}. ההערה והיסטוריית הפרסום שלה נשמרות. אפשר לערוך ולפרסם מחדש בשליחת משוב.</p>` : ''}`
    : `<p class="muted">נשלחה ב-${fmtDT(c.publishedAt)}. אי אפשר לערוך הערה שנשלחה, אבל אפשר לבטל את הפרסום שלה.</p><div class="rv-btns rv-write"><button class="btn small danger" data-action="rv-retract" data-id="${esc(c.id)}">↩ בטל פרסום</button></div>${teacherThreadHtml(c)}`}</li>`;
  }).join('') || (list.length ? '<li class="muted">אין הערות בסינון הזה.</li>' : '<li class="muted">עדיין אין הערות. כתוב הערה כללית, או סמן קטע במסמך.</li>');
  lockArchived(document.getElementById('rvPanel'));
  renderReviewPublic();
}

function updateRvSelBox() {
  const el = document.getElementById('rvSelQuote');
  if (!el) return;
  el.textContent = ui.rvSel ? `«${ui.rvSel.quote.slice(0, 160)}${ui.rvSel.quote.length > 160 ? '…' : ''}» (עמוד ${ui.rvSel.page})` : 'אין קטע מסומן. אפשר להוסיף הערה כללית, או לסמן קטע במסמך (בגרירה) ולהצמיד אליו הערה.';
  el.className = ui.rvSel ? '' : 'muted';
  const b = document.getElementById('rvAddLocal');
  if (b) { b.disabled = !ui.rvSel; b.title = ui.rvSel ? 'מצמיד את ההערה לקטע שסומן' : 'סמן קודם קטע במסמך'; b.classList.toggle('primary', !!ui.rvSel); }
}

// הוספת הערה: כללית (בלי קשר לקטע שסומן) או מקומית לקטע המסומן. ההערה החדשה נפתחת, מוצגת בראש הערות מסוגה ומודגשת לרגע.
async function addReviewComment(general) {
  const sub = reviewSubmission();
  const aud = document.getElementById('rvAud');
  const scope = general || !ui.rvSel ? 'general' : 'local';
  if (ui.rvFilter === 'sent') ui.rvFilter = 'all'; // הערה חדשה היא טיוטה: לא להסתיר אותה מהמורה
  const studentId = aud && aud.value ? aud.value : null;
  const text = document.getElementById('rvText').value;
  ensureQueue();
  const payload = { id: newClientId('cmt'), submissionId: sub.id, scope, anchor: scope === 'local' ? ui.rvSel : null, categoryId: document.getElementById('rvCat').value, text, studentId };
  try { R.addComment(vs(), session, payload); } catch (e) { toast(e.message || 'ההערה לא תקינה', true); return; } // אותן בדיקות כמו בשרת, מיד
  wq.enqueue('addComment', [payload]);
  const made = { id: payload.id };
  document.getElementById('rvText').value = '';
  if (scope === 'local' && ui.viewer) ui.viewer.clearSelection();
  rvOpenOnly(made.id); ui.rvNew = made.id; ui.rvActive = made.id;
  refreshReview();
  document.querySelector(`#rvList [data-id="${made && made.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => { ui.rvNew = null; document.querySelector('#rvList .just-added')?.classList.remove('just-added'); }, 2500);
  const who = studentId ? `אישית ל-${studentNameOf(studentId)}` : (sub.unitType === 'group' ? 'לכל הקבוצה' : studentNameOf(sub.uploadedBy));
  toast(`ההערה ${scope === 'general' ? 'הכללית ' : ''}נוספה כטיוטה (${who}) ונשמרת ברקע. התלמיד לא רואה אותה עד לשליחת משוב.`);
}

async function initReview() {
  if (ui.viewer) { ui.viewer.destroy(); ui.viewer = null; }
  ui.rvSel = null;
  ui.rvEdit = null;
  ui.rvActive = null;
  ui.rvNew = null;
  ui.rvOpen = new Set();
  ui.rvGhost = false;
  ui.aiScan = null;
  const focus = ui.rvFocus;
  ui.rvFocus = null;
  if (focus) { rvOpenOnly(focus); ui.rvActive = focus; ui.rvNew = focus; }
  const sub = reviewSubmission();
  const host = document.getElementById('pdfHost');
  if (!sub || !host) return;
  renderReviewList();
  renderReviewPrev();
  // תחילת סבב בדיקה: צילום מצב של המחוון נקבע בפתיחה של הגרסה האחרונה (לא בגרסאות ישנות שנפתחות לעיון, ולא בארכיון)
  if (session.role === 'teacher' && !state.archived && R.reviewable(sub) && !K.sheetOf(state, sub.id) && K.taskRubricOf(state, sub.taskId)
    && (S.latestOf(state, sub.taskId, sub.unitType, sub.unitId) || {}).id === sub.id) {
    try { state = await api.startScoring(sub.id); renderScore(); } catch (e) { toast(e.message || 'לא ניתן לתעד את תחילת הבדיקה', true); }
  }
  if (focus) {
    document.querySelector(`#rvList [data-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
    setTimeout(() => { ui.rvNew = null; document.querySelector('#rvList .just-added')?.classList.remove('just-added'); }, 2500);
  }
  try {
    const { PdfReview } = await import('./pdf-viewer.js');
    if (route() !== 'review' || ui.reviewSub !== sub.id || !document.body.contains(host)) return;
    const v = new PdfReview(host, {
      onSelect: (a) => { ui.rvSel = a; updateRvSelBox(); },
      onActivate: (id) => { ui.rvActive = id; rvOpenOnly(id); renderReviewList(); document.querySelector(`#rvList [data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); },
    });
    v.comments = reviewViewerComments();
    v.onDrawn = () => { renderReviewList(); if (ui.rvGhost) renderReviewPrev(); };
    ui.viewer = v;
    await v.load(await docSource(sub, host));
    const z = document.getElementById('rvZoom');
    if (z) z.textContent = `${v.zoomPercent}%`;
    const n = document.getElementById('rvNotice');
    if (n) n.hidden = v.hasText;
    if (focus) v.activate(focus, true);
  } catch (e) {
    host.textContent = `לא ניתן לפתוח את המסמך: ${e.message}`;
  }
}

// פעולת הערה בלי רינדור מחדש של המסמך
// שינוי קטגוריות: מרענן את החלון, את בורר הקטגוריה ואת רשימת ההערות
async function catOp(fn, msg) {
  try { state = await fn(); } catch (e) { toast(e.message, true); return false; }
  toast(msg);
  categoriesDialog();
  const sel = document.getElementById('rvCat');
  if (sel) { const cur = sel.value; sel.innerHTML = R.activeCategories(state).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''); if ([...sel.options].some((o) => o.value === cur)) sel.value = cur; }
  if (ui.viewer) ui.viewer.setComments(reviewViewerComments()); else renderReviewList();
  return true;
}

async function revOp(fn, msg) {
  if (!(await settleQueue())) return false;
  try {
    state = await fn();
    if (msg) toast(msg);
    if (ui.viewer) ui.viewer.setComments(reviewViewerComments()); else renderReviewList();
    return true;
  } catch (e) {
    toast(e.message || 'הפעולה נכשלה', true);
    return false;
  }
}

function swatchesHtml(current, activeCats, selfId) {
  const usedBy = (col) => activeCats.find((x) => x.id !== selfId && x.color.toLowerCase() === col);
  return `<div class="swatches-row" role="group" aria-label="בחירת צבע">${R.CATEGORY_PALETTE.map((col) => { const u = usedBy(col); return `<button type="button" class="swatch ${col === (current || '').toLowerCase() ? 'on' : ''} ${u ? 'used' : ''}" data-action="cat-swatch" data-color="${col}" style="background:${col}" title="${u ? `בשימוש: ${esc(u.name)}` : 'צבע פנוי'}" aria-label="צבע ${col}${u ? ', בשימוש' : ''}"></button>`; }).join('')}</div>`;
}

function categoriesDialog() {
  const active = R.activeCategories(state);
  const rows = state.commentCategories.map((c) => `<div class="cat-row ${c.archived ? 'off' : ''}" data-id="${esc(c.id)}">
    <div class="cat-main"><input type="color" value="${esc(c.color)}" data-f="color" aria-label="צבע">
    <input type="text" value="${esc(c.name)}" data-f="name" aria-label="שם הקטגוריה" ${c.archived ? 'disabled' : ''}>
    ${c.archived ? `<span class="muted">מוסתרת</span><button class="btn small" data-action="cat-show" data-id="${esc(c.id)}">החזר</button>`
    : `<button class="btn small primary" data-action="cat-save" data-id="${esc(c.id)}">שמירה</button><button class="btn small danger" data-action="cat-hide" data-id="${esc(c.id)}" title="מסתיר מהערות חדשות. הערות קיימות לא משתנות">הסתר</button>`}</div>
    ${c.archived ? '' : swatchesHtml(c.color, active, c.id)}
  </div>`).join('');
  const free = R.nextFreeColor(state);
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>ניהול קטגוריות הערות</h2>
    <p class="muted">הקטגוריות משותפות לכל המחזורים. בחר צבע מהפלטה, או בחר צבע חופשי בריבוע הצבע. צבעים עם נקודה כבר בשימוש בקטגוריה אחרת. הסתרת קטגוריה אינה משנה הערות שכבר נכתבו.</p>
    ${rows}
    <h3>קטגוריה חדשה</h3>
    <div class="cat-row" id="catNew"><div class="cat-main"><input type="color" value="${free}" data-f="color" aria-label="צבע"><input type="text" data-f="name" placeholder="שם הקטגוריה" aria-label="שם הקטגוריה חדשה"><button class="btn small primary" data-action="cat-add">הוספה</button></div>${swatchesHtml(free, active, null)}</div>
    <div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}

// רינדור מחדש של רשימת ההערות במסך הפעיל (מורה או תלמיד)
const rerenderRvList = () => (route() === 'feedback' ? renderFeedbackList() : renderReviewList());

// ---------- משוב: צד התלמיד ----------
// התלמיד רואה רק הערות שפורסמו ושמיועדות לו (review.visibleToStudent). "תוקן" הוא סימון של התלמידים בלבד.
const fbSubmission = () => (state.submissions || []).find((x) => x.id === ui.fbSub) || null;
const fbComments = (sub) => (sub ? R.commentsOf(state, sub.id).filter((c) => R.visibleToStudent(state, session.userId, c)) : []);

function studentFeedbackSection(meId) {
  const list = F.feedbackForStudent(state, meId);
  if (!list.length) return '';
  return `<h3>📩 משוב מהמורה</h3><div class="focus-list">${list.map((x) => `<button class="focus-item" data-action="open-feedback" data-id="${esc(x.submission.id)}">
      <span class="fi-ic">📩</span><span class="fi-main"><b>${esc(x.task.title)}</b><span class="muted">${x.comments.length} הערות${x.unfixed ? `, ${x.unfixed} שעוד לא סימנתם כתוקנו` : ', הכול סומן כתוקן'} · גרסה ${x.submission.version}</span></span><span class="fi-due">${fmtD(x.lastPublishedAt.slice(0, 10))}</span></button>`).join('')}</div>`;
}

function viewStudentFeedback() {
  const me = state.students.find((s) => s.id === session.userId);
  const sub = fbSubmission();
  const mine = me ? F.feedbackForStudent(state, me.id) : [];
  const cur = sub && mine.find((x) => x.submission.id === sub.id);
  if (!me || !cur) {
    return `<main class="main student-home"><div class="card"><h2>אין משוב להצגה</h2><p class="muted">המשוב לא נמצא או שאינו מיועד לך.</p><button class="btn" data-action="fb-back">← חזרה</button></div></main>`;
  }
  const versions = mine.filter((x) => x.task.id === cur.task.id && x.submission.unitId === sub.unitId && x.submission.unitType === sub.unitType).sort((a, b) => a.submission.version - b.submission.version);
  const ok = R.reviewable(sub);
  return `<main class="main student-home student-wide ${ui.studentFull ? 'student-full' : ''}">
    <div class="topbar"><h1>משוב: ${esc(cur.task.title)}</h1><span class="sp"></span><span class="badge-demo">דמו</span>${fullBtn()}<button class="btn small" data-action="fb-back">← חזרה</button></div>
    <div class="card"><div class="toolbar" style="margin:0">
      <label>גרסה: <select id="fbVersion">${versions.map((v) => `<option value="${esc(v.submission.id)}" ${v.submission.id === sub.id ? 'selected' : ''}>גרסה ${v.submission.version} (${fmtDT(v.submission.uploadedAt)}, ${v.comments.length} הערות)</option>`).join('')}</select></label>
    </div>
    <p class="muted">אלה ההערות שהמורה שלח אליך. אי אפשר לשנות אותן. הסימון "תוקן" הוא כלי שלך ושל חברי הקבוצה בלבד, ואינו אישור שהמורה בדק את התיקון.</p></div>
    ${studentFixBanner(cur.task, { type: sub.unitType, id: sub.unitId }, { noBtn: true })}
    ${ok ? `<div class="review-split">
      <section class="card rv-pdf">
        <div class="toolbar"><button class="btn small" data-action="rv-zoom-out" aria-label="הקטנה">−</button><span id="rvZoom" class="muted">…</span><button class="btn small" data-action="rv-zoom-in" aria-label="הגדלה">+</button><button class="btn small" data-action="rv-fit">התאם לרוחב</button></div>
        <div id="pdfHost" class="pdf-host" dir="ltr">טוען מסמך…</div>
      </section>
      <aside class="card rv-panel" id="rvPanel"><div class="rv-listhead"><h3>הערות המורה (<span id="rvCount">0</span>)</h3>
        <span><button class="btn small" data-action="rv-expand-all">הרחב הכול</button> <button class="btn small" data-action="rv-collapse-all">צמצם הכול</button></span></div>
        <ul id="rvList" class="rv-list"></ul></aside></div>`
    : '<div class="card"><p>המסמך של הגרסה הזו עוד לא זמין לצפייה. ההערות מוצגות כרשימה.</p><aside id="rvPanel"><ul id="rvList" class="rv-list"></ul><span id="rvCount" hidden></span></aside></div>'}
  </main>`;
}

function fbThreadHtml(c) {
  const th = F.threadOf(state, c.id);
  const oq = new Set(F.openQuestionsOf(state, c.submissionId).map((x) => x.question.id));
  const rows = th.map((e) => `<div class="thr ${e.authorRole}"><b>${e.authorRole === 'teacher' ? 'המורה' : esc(studentNameOf(e.authorId))}${e.authorId === session.userId ? ' (את/ה)' : ''}</b> <small class="muted">${fmtDT(e.createdAt)}${e.kind === 'question' ? ' · שאלת הבהרה' : e.kind === 'answer' ? ' · תשובה' : ''}</small>${oq.has(e.id) ? ' <span class="wbadge st-pending">ממתינה לתשובת המורה</span>' : ''}
      <div class="rv-text">${esc(e.text)}</div></div>`).join('');
  return `<div class="thr-box"><h4>תגובות ושאלות (${th.length})</h4>${rows || '<p class="muted">אין תגובות עדיין.</p>'}
    <textarea data-f="thread" rows="2" maxlength="${F.MAX_THREAD_TEXT}" placeholder="כתוב תגובה או שאלה"></textarea>
    <div class="subrow"><button class="btn small" data-action="fb-reply" data-id="${esc(c.id)}">הגב</button><button class="btn small primary" data-action="fb-ask" data-id="${esc(c.id)}" title="שולח למורה שאלת הבהרה. הוא יענה בכתב">❓ שאל את המורה</button></div>
    <p class="muted">${c.studentId ? 'תגובה או שאלה על הערה אישית גלויות לך ולמורה בלבד.' : 'תגובה או שאלה על הערה קבוצתית גלויות לכל חברי הקבוצה ולמורה.'}</p></div>`;
}

function renderFeedbackList() {
  const ul = document.getElementById('rvList');
  const sub = fbSubmission();
  if (!ul || !sub) return;
  const rt = (ui.viewer && ui.viewer.runtime) || new Map();
  const list = fbComments(sub);
  const startOf = (c) => ((rt.get(c.id) || {}).start ?? (c.anchor ? c.anchor.start : 0));
  const sorted = [...list.filter((c) => !c.anchor).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)), ...list.filter((c) => c.anchor).sort((a, b) => a.anchor.page - b.anchor.page || startOf(a) - startOf(b))];
  document.getElementById('rvCount').textContent = sorted.length;
  ul.innerHTML = sorted.map((c) => {
    const cat = R.categoryOf(state, c.categoryId);
    const st = (rt.get(c.id) || {}).status;
    const open = ui.rvOpen.has(c.id);
    const fixed = F.markOf(state, c.id).fixed;
    const aud = c.studentId ? '<span class="aud p">👤 אישית אליך</span>' : '<span class="aud g">👥 לכל הקבוצה</span>';
    const head = `<div class="rv-top"><button type="button" class="rv-tg" data-action="rv-toggle" data-id="${esc(c.id)}" aria-expanded="${open}" aria-label="${open ? 'צמצם הערה' : 'הרחב הערה'}">${open ? '▾' : '▸'}</button>
      <span class="tag" style="background:${esc(cat.color)}">${esc(cat.name)}</span> <small>${c.anchor ? `עמוד ${c.anchor.page}` : 'הערה כללית, ללא מיקום במסמך'}</small> ${aud}
      <span class="wbadge ${fixed ? 'st-active' : 'st-none'}">${fixed ? '✔ תוקן' : 'לא סומן'}</span></div>`;
    const cls = `rv-item ${open ? 'open' : 'closed'} ${c.id === ui.rvActive ? 'active' : ''}`;
    if (!open) return `<li class="${cls}" data-id="${esc(c.id)}">${head}<div class="rv-preview">${esc(c.text)}</div></li>`;
    const warn = c.anchor && st === 'unresolved' ? '<div class="warn">לא אותר מיקום מדויק במסמך (מוצג הציטוט).</div>' : '';
    return `<li class="${cls}" data-id="${esc(c.id)}">${head}
      ${c.anchor ? `<div class="q">«${esc(c.anchor.quote.slice(0, 120))}»</div>` : ''}${warn}
      <div class="rv-text">${esc(c.text)}</div>
      <label class="fixrow"><input type="checkbox" data-fixed="${esc(c.id)}" ${fixed ? 'checked' : ''}> תוקן</label>
      <p class="muted">${c.studentId ? 'סימון פרטי שלך.' : 'סימון משותף: כל חברי הקבוצה רואים אותו ויכולים לשנות אותו.'} הוא רק כלי מעקב ואינו אישור של המורה.</p>
      ${fbThreadHtml(c)}</li>`;
  }).join('') || '<li class="muted">אין הערות בגרסה הזו.</li>';
}

async function initFeedback() {
  if (ui.viewer) { ui.viewer.destroy(); ui.viewer = null; }
  ui.rvActive = null;
  ui.rvOpen = new Set();
  const sub = fbSubmission();
  const host = document.getElementById('pdfHost');
  renderFeedbackList();
  if (!sub || !host) return;
  try {
    const { PdfReview } = await import('./pdf-viewer.js');
    if (!document.body.contains(host) || ui.fbSub !== sub.id) return;
    const v = new PdfReview(host, { onActivate: (id) => { ui.rvActive = id; ui.rvOpen = new Set([id]); renderFeedbackList(); document.querySelector(`#rvList [data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); } });
    v.comments = fbComments(sub).map((c) => ({ id: c.id, anchor: c.anchor, color: R.categoryOf(state, c.categoryId).color }));
    v.onDrawn = () => renderFeedbackList();
    ui.viewer = v;
    await v.load(await docSource(sub, host));
    const z = document.getElementById('rvZoom');
    if (z) z.textContent = `${v.zoomPercent}%`;
  } catch (e) {
    host.textContent = `לא ניתן לפתוח את המסמך: ${e.message}`;
  }
}

// פעולה של תלמיד במסך המשוב, בלי רינדור מחדש של המסמך
async function fbOp(fn, msg) {
  try {
    state = await fn();
    if (msg) toast(msg);
    renderFeedbackList();
    return true;
  } catch (e) {
    toast(e.message || 'הפעולה נכשלה', true);
    state = await api.getState();
    renderFeedbackList();
    return false;
  }
}

// ---------- החזרה לתיקון וגרסאות מתוקנות ----------
function fixStateLabel(c) {
  const st = S.correctionState(c);
  if (st === 'returned') return { code: st, text: `↩ הוחזרה לתיקון${c.dueDate ? ` עד ${fmtD(c.dueDate)}` : ''}`, cls: 'st-pending' };
  if (st === 'submitted') return { code: st, text: '🔁 התיקון הוגש', cls: 'st-active' };
  return { code: st, text: '🔎 בבדיקה חוזרת', cls: 'st-active' };
}
const fixBadge = (c) => { if (!c) return ''; const l = fixStateLabel(c); return `<span class="wbadge ${l.cls}" title="${l.code === 'submitted' ? 'הגרסה המתוקנת הוגשה. זה אינו אישור שהתיקון תקין, והיא אינה ממתינה לבדיקה אלא אם המורה יפתח אותה' : ''}">${l.text}</span>`; };

// תיבת "החזרה לתיקון" בראש מסך הבדיקה
function reviewFixHtml(sub) {
  const unitCorr = S.correctionsOf(state, sub.taskId, sub.unitType, sub.unitId);
  const cur = S.currentCorrection(state, sub.taskId, sub.unitType, sub.unitId);
  const latest = S.latestOf(state, sub.taskId, sub.unitType, sub.unitId);
  const isLatest = latest && latest.id === sub.id;
  const returnedHere = unitCorr.find((c) => c.returnedSubmissionId === sub.id);
  const fixHere = unitCorr.find((c) => c.submittedSubmissionId === sub.id);
  const verOf = (id) => (state.submissions.find((x) => x.id === id) || {}).version;
  let body = '';
  if (returnedHere) {
    const st = S.correctionState(returnedHere);
    body += `<p><b>↩ גרסה זו הוחזרה לתיקון</b> ב-${fmtDT(returnedHere.returnedAt)}${returnedHere.dueDate ? `, מועד תיקון ${fmtD(returnedHere.dueDate)}` : ''}.</p><div class="rv-text muted">${esc(returnedHere.text)}</div>`;
    if (st === 'returned') {
      body += `<label class="rv-write">מועד תיקון (ארכה) <input type="date" id="rvFixDue" value="${esc(returnedHere.dueDate || '')}"></label>
        <button class="btn small rv-write" data-action="rv-due-save" data-id="${esc(returnedHere.id)}">עדכן מועד תיקון</button>
        <p class="muted">ממתינים לגרסה מתוקנת מהתלמידים. כשתוגש, היא תופיע כ"התיקון הוגש" ולא כעבודה חדשה לבדיקה.</p>`;
    } else {
      body += `<p>${fixBadge(returnedHere)} הוגשה גרסה מתוקנת (גרסה ${verOf(returnedHere.submittedSubmissionId)}) ב-${fmtDT(returnedHere.submittedAt)}.
        <button class="btn small" data-action="open-review" data-id="${esc(returnedHere.submittedSubmissionId)}">פתח את הגרסה המתוקנת</button></p>`;
    }
  }
  if (fixHere) {
    const st = S.correctionState(fixHere);
    body += `<p><b>🔁 גרסה מתוקנת.</b> הוגשה ב-${fmtDT(fixHere.submittedAt)} בעקבות החזרה לתיקון מ-${fmtDT(fixHere.returnedAt)} (גרסה ${verOf(fixHere.returnedSubmissionId)}).</p>
      <p class="muted">${st === 'submitted' ? 'היא אינה ממתינה לבדיקה, וההגשה אינה אישור. אם תרצה לבדוק אותה, פתח לבדיקה חוזרת.' : `בבדיקה חוזרת מאז ${fmtDT(fixHere.reopenedAt)}.`}</p>
      <div class="subrow">${st === 'submitted' ? `<button class="btn primary rv-write" data-action="rv-reopen" data-id="${esc(fixHere.id)}">🔎 פתח לבדיקה חוזרת</button>` : ''}
      <button class="btn small" data-action="open-review" data-id="${esc(fixHere.returnedSubmissionId)}">⬅ לגרסה שהוחזרה</button></div>`;
  }
  const canReturn = isLatest && !(cur && S.correctionState(cur) === 'returned');
  body += canReturn
    ? `<button class="btn rv-write" data-action="rv-return">↩ ${unitCorr.length ? 'החזר שוב לתיקון' : 'החזרה לתיקון'}</button><p class="muted">מצרף משוב כתוב ומועד, ומפרסם גם הערות טיוטה (עם סיכום לפני). העבודה תסומן "לא הושלמה".</p>`
    : (!isLatest ? '<p class="muted">אפשר להחזיר לתיקון רק את הגרסה האחרונה של העבודה.</p>' : '');
  return `<h3>↩ החזרה לתיקון</h3>${body || ''}`;
}
function renderReviewFix() {
  const el = document.getElementById('rvFix');
  const sub = reviewSubmission();
  if (el && sub) { el.innerHTML = reviewFixHtml(sub); lockArchived(el); }
}

function returnDialog(subId) {
  const sub = (state.submissions || []).find((x) => x.id === subId);
  const t = taskById(sub.taskId);
  const drafts = F.draftsOf(state, subId).length;
  const approved = T.getProgress(state, sub.taskId, sub.unitType, sub.unitId).completion === 'approved';
  const unit = (T.unitsOfTask(state, t).find((u) => u.type === sub.unitType && u.id === sub.unitId) || {}).name || '';
  ui.openTask = null;
  showDlg(`<div class="form"><h2>↩ החזרה לתיקון: ${esc(t.title)} (${esc(unit)})</h2>
    <p>${sub.unitType === 'group' ? 'כל חברי הקבוצה' : 'התלמיד'} יראו שהעבודה הוחזרה לתיקון, את ההסבר שתכתוב ואת המועד.</p>
    <label>מה נדרש לתקן (משוב כתוב, חובה) <textarea id="retText" rows="4" maxlength="${X.MAX_RETURN_TEXT}" placeholder="למשל: להוסיף מקורות לכל טענה מדעית ולתקן את מבנה הסעיפים"></textarea></label>
    <label>מועד להגשת גרסה מתוקנת <input type="date" id="retDue" value="${esc(X.defaultFixDue())}"></label>
    <p class="muted">ברירת המחדל: שבועיים מהיום. אפשר לשנות כאן, ולהאריך אחר כך לכל קבוצה בנפרד.</p>
    <div class="alert">${drafts ? `<b>${drafts} הערות טיוטה יפורסמו עכשיו</b> יחד עם ההחזרה.` : 'אין הערות טיוטה לפרסום. התלמידים יקבלו את המשוב הכתוב בלבד.'}
      ${approved ? '<br><b>שים לב:</b> ההשלמה כבר אושרה, וההחזרה תסמן אותה כ"לא הושלמה".' : ''}</div>
    <p class="muted">הגשת התיקון על ידי התלמידים תסומן "התיקון הוגש". היא לא תיחשב בקשה לבדיקה חדשה, ולא תאושר אוטומטית.</p>
    <div class="dlg-actions"><button class="btn primary big" id="retOk">↩ החזר לתיקון</button><button class="btn" id="retNo">ביטול</button></div></div>`);
  $dlg.querySelector('#retNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#retOk').addEventListener('click', async () => {
    const text = $dlg.querySelector('#retText').value;
    const due = $dlg.querySelector('#retDue').value;
    const ok = await revOp(() => api.returnForCorrection(subId, { text, dueDate: due || null }), 'העבודה הוחזרה לתיקון. התלמידים רואים את המשוב והמועד');
    if (ok) { $dlg.close(); renderReviewFix(); renderReviewInternal(); } // בשגיאה החלון נשאר פתוח והטקסט נשמר
  });
}

// הערות מגרסאות קודמות: לעיון בלבד, לא מועברות לגרסה הנוכחית
function prevCommentsFlat(sub) { return X.previousVersionsWithComments(state, sub.id).flatMap((p) => p.comments); }
function renderReviewPrev() {
  const el = document.getElementById('rvPrev');
  const sub = reviewSubmission();
  if (!el || !sub) return;
  const prev = X.previousVersionsWithComments(state, sub.id);
  if (!prev.length) { el.innerHTML = ''; return; }
  const total = prev.reduce((n, p) => n + p.comments.length, 0);
  const found = ui.viewer && ui.rvGhost ? ui.viewer.ghostFound : null;
  el.innerHTML = `<details class="rv-prev" ${ui.rvPrevOpen ? 'open' : ''}><summary>📚 הערות מגרסאות קודמות (${total})</summary>
    <p class="muted">לעיון בלבד. ההערות האלה לא הועברו לגרסה הנוכחית, ולא נשלחות שוב לתלמידים.</p>
    ${total ? `<label class="chk"><input type="checkbox" id="rvGhost" ${ui.rvGhost ? 'checked' : ''}> הצג על המסמך הנוכחי (מקווקו) את הקטעים שסומנו בגרסאות הקודמות</label>
      ${found ? `<span class="muted"> נמצאו ${found.found} מתוך ${found.total} בטקסט הנוכחי</span>` : ''}` : ''}
    ${prev.map((p) => `<div class="prev-ver"><div class="prev-head"><b>גרסה ${p.submission.version}</b> <span class="muted">${fmtDT(p.submission.uploadedAt)} · ${p.comments.length} הערות</span>
        <button class="btn small" data-action="open-review" data-id="${esc(p.submission.id)}">📂 פתח גרסה זו עם הערותיה</button></div>
      ${p.comments.map((c) => { const cat = R.categoryOf(state, c.categoryId); return `<div class="prev-c"><span class="tag" style="background:${esc(cat.color)}">${esc(cat.name)}</span> <small>${c.anchor ? `עמוד ${c.anchor.page}` : 'הערה כללית, ללא מיקום במסמך'} · ${c.status === 'published' ? '📤 נשלחה' : '📝 טיוטה'}</small>
        ${c.anchor ? `<div class="q">«${esc(c.anchor.quote.slice(0, 70))}»</div>` : ''}<div>${esc(c.text)}</div></div>`; }).join('') || '<p class="muted">אין הערות בגרסה זו.</p>'}</div>`).join('')}
  </details>`;
}

// שיפורים לצד התלמיד
function studentFixBanner(t, unit, { noBtn = false } = {}) {
  const cur = S.currentCorrection(state, t.id, unit.type, unit.id);
  if (!cur) return '';
  const st = S.correctionState(cur);
  const fbs = F.feedbackForStudent(state, session.userId).filter((y) => y.task.id === t.id);
  const nCom = fbs.reduce((n, y) => n + y.comments.length, 0);
  const viewBtn = fbs.length && !noBtn ? ` <button type="button" class="btn small" data-action="open-feedback" data-id="${esc(cur.returnedSubmissionId)}">צפה במשוב (${nCom} הערות)</button>` : '';
  if (st === 'returned') {
    const late = cur.dueDate && Date.parse(nowIso()) > S.endOfDayMs(cur.dueDate);
    return `<div class="alert type-fix"><b>↩ העבודה הוחזרה לתיקון.</b> ${fmtDT(cur.returnedAt)}
      <div class="rv-text">${esc(cur.text)}</div>
      <p><b>מה נדרש ממך:</b> להגיש גרסה מתוקנת${cur.dueDate ? ` עד ${fmtD(cur.dueDate)}${late ? ' (עבר המועד, אפשר עדיין להגיש)' : ''}` : ''}. הקודמת נשמרת.${viewBtn}</p></div>`;
  }
  return `<div class="alert type-sub"><b>${st === 'rereview' ? '🔎 המורה פתח את הגרסה המתוקנת לבדיקה חוזרת.' : '🔁 התיקון הוגש.'}</b> הוגש ב-${fmtDT(cur.submittedAt)}.
    <p class="muted">${st === 'rereview' ? 'תקבל משוב אם יהיה.' : 'זה אינו אישור שהמורה בדק את התיקון. המורה יפתח אותו לבדיקה אם ירצה.'}${viewBtn}</p></div>`;
}
const fixChip = (t, unit) => { const c = S.currentCorrection(state, t.id, unit.type, unit.id); if (!c) return ''; const l = fixStateLabel(c); return `<div><span class="wbadge ${l.cls}">${l.text}</span></div>`; };

// ---------- סוג משימה ופעולה נדרשת (תלמיד) ----------
function taskTypeLine(t) {
  return t.requiresSubmission
    ? '<div class="tc-type sub"><b>📥 הגשת תוצר:</b> יש להגיש מסמך (Word או PDF)</div>'
    : '<div class="tc-type chk"><b>📝 אישור ביצוע:</b> אין צורך לצרף קובץ. מדווחים התקדמות, ובסיום מבקשים אישור מהמורה</div>';
}
function taskCta(t, unit, p) {
  if (p.completion === 'approved') return '';
  if (!t.requiresSubmission) return '';
  const has = S.latestOf(state, t.id, unit.type, unit.id);
  const fix = S.openCorrection(state, t.id, unit.type, unit.id);
  return `<div class="cta-row"><span class="btn primary big cta">${fix ? '📤 הגש גרסה מתוקנת' : has ? '📤 הגש גרסה חדשה' : '📤 הגש מסמך'}</span></div>`;
}
function taskTypeBanner(t) {
  const fix = t.requiresSubmission && session && session.role === 'student' ? S.openCorrection(state, t.id, ...(() => { const u = T.unitForStudent(state, t, session.userId); return [u.type, u.id]; })()) : null;
  return t.requiresSubmission
    ? (fix ? '<div class="alert type-fix"><b>📥 משימת הגשת תוצר, הוחזרה לתיקון.</b> הפעולה הנדרשת: להגיש גרסה מתוקנת בכפתור "הגש גרסה מתוקנת" שלמטה.</div>' : '<div class="alert type-sub"><b>📥 משימת הגשת תוצר.</b> הפעולה הנדרשת: להגיש מסמך (Word או PDF) בכפתור "הגש מסמך" שלמטה.</div>')
    : '<div class="alert type-chk"><b>📝 משימת אישור ביצוע.</b> אין צורך לצרף קובץ. עדכן את אחוז ההתקדמות שלך, ובסיום לחץ "סיימתי, בקשה לאישור המורה". ההשלמה נחשבת רק אחרי שהמורה אישר.</div>';
}

// ---------- הגשות ----------
const fmtDT = (iso) => { const d = new Date(iso); return `${fmtD(iso.slice(0, 10))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const nowIso = () => new Date().toISOString();

// תוויות מצב: תמיד סמל וטקסט, לא צבע בלבד. ההגשה והמרת ה-PDF מוצגות בנפרד.
function submissionBadge(st) {
  if (st.code === 'none') return '<span class="wbadge st-none">⚪ טרם הוגש</span>';
  if (st.code === 'missing-late') return '<span class="wbadge st-bad">🔴 לא הוגש, עבר המועד</span>';
  if (st.code === 'late') return '<span class="wbadge st-late">🕒 הוגש באיחור</span>';
  return '<span class="wbadge st-active">✅ הוגש</span>';
}
function conversionBadge(st) {
  if (!st.latest) return '<span class="muted">—</span>';
  const parts = [];
  const c = st.latest.conversion;
  if (c.status === 'pending') parts.push('<span class="wbadge st-pending" title="הקובץ נקלט וממתין להמרה">⏳ בהמרה ל-PDF</span>');
  else if (c.status === 'done') parts.push(`<span class="wbadge st-active" title="${esc(c.pdfName || '')}">📄 PDF מוכן${c.pdfSource === 'student' ? ' (מהתלמיד)' : ''}</span>`);
  else parts.push('<span class="wbadge st-bad" title="הקובץ המקורי נשמר וההגשה נקלטה. רק ההמרה נכשלה">⚠ המרה נכשלה (ההגשה נקלטה)</span>');
  if (st.latest.pdfRequested) parts.push('<span class="wbadge st-pending">📨 התבקש PDF נוסף</span>');
  return parts.join(' ');
}

// סיבות לטיפול (בלשון המורה). הלוגיקה עצמה ב-feedback.attentionReasons.
const ATTN_LABEL = { review: 'ממתין לבדיקה', drafts: 'טיוטות לשליחה', question: 'שאלה פתוחה', convert: 'המרה נכשלה', approve: 'ממתין לאישור השלמה' };

// פעולה ראשית גלויה אחת (בדיקה), "אשר השלמה" כשיש בקשה, והשאר בתפריט "עוד"
function subRowActions(r) {
  const x = r.latest;
  if (!x) return '';
  const unit = `data-task="${esc(r.task.id)}" data-utype="${r.unit.type}" data-unit="${esc(r.unit.id)}"`;
  const n = R.commentsOf(vs(), x.id).length;
  const main = [x.conversion.status === 'done'
    ? `<button class="btn small primary" data-action="open-review" data-id="${esc(x.id)}">בדיקה${n ? ` (${n})` : ''}</button>`
    : '<button class="btn small" disabled title="אפשר לבדוק רק אחרי שה-PDF מוכן">בדיקה</button>'];
  if (r.completion === 'claimed') main.push(`<button class="btn small" data-action="review" data-d="approve" ${unit}>אשר השלמה</button>`);
  const more = [`<button class="btn small" data-action="sub-versions" ${unit}>${r.versions > 1 ? `גרסאות (${r.versions})` : 'פרטי הגשה'}</button>`,
    `<button class="btn small" data-action="sub-open" data-id="${esc(x.id)}" data-kind="source" title="מוריד את הקובץ המקורי שהתלמיד הגיש, כפי שהוגש">⬇ הורד קובץ מקור</button>`];
  if (x.conversion.status === 'done') more.push(`<button class="btn small" data-action="sub-open" data-id="${esc(x.id)}" data-kind="pdf" title="מוריד את ה-PDF המשמש לתצוגת הבדיקה (ללא הערות)">⬇ הורד PDF</button>`);
  if (r.correctionState === 'submitted') more.unshift(`<button class="btn small" data-action="reopen-fix" data-id="${esc(r.correction.id)}" title="ביוזמתך בלבד. אינו מאשר את התיקון">🔎 פתח לבדיקה חוזרת</button>`);
  if (x.conversion.status === 'failed') more.push(`<button class="btn small" data-action="sub-retry" data-id="${esc(x.id)}">נסה המרה שוב</button>`);
  if (x.conversion.status !== 'pending' && !x.pdfRequested && x.conversion.pdfSource !== 'student') more.push(`<button class="btn small" data-action="sub-request-pdf" data-id="${esc(x.id)}" title="מבקש מהתלמידים לצרף קובץ PDF. אינו משנה את מועד ההגשה">בקש PDF נוסף</button>`);
  return `<div class="row-actions">${main.join(' ')}<details class="more"><summary class="btn small">עוד ▾</summary><div class="menu">${more.join('')}</div></details></div>`;
}

// סיווג שורה למסנן. needs: דורש טיפול. missing: לא הוגש. treated: טופל (סימון ידני) או השלמה אושרה.
function subBucket(r) {
  if (!r.latest) return { missing: true, reasons: [] };
  const rv = F.reviewOf(state, r.latest.id);
  return { reasons: F.attentionReasons(state, r.latest, r.completion), treated: rv.treated || r.completion === 'approved' };
}

function viewSubmissions() {
  const subTasks = T.orderedTasks(state).filter((t) => t.requiresSubmission);
  if (!subTasks.length) {
    return shell('הגשות ובדיקה', '<div class="empty">אין במחזור משימות שמחייבות הגשת תוצר. בעריכת משימה אפשר לבחור "סוג: הגשת תוצר".</div>');
  }
  if (ui.subTask !== 'all' && !subTasks.some((t) => t.id === ui.subTask)) ui.subTask = 'all';
  const rows = S.trackerRows(state, { taskId: ui.subTask === 'all' ? null : ui.subTask, now: nowIso() }).map((r) => ({ ...r, b: subBucket(r) }));
  const sum = S.trackerSummary(rows);
  const cnt = {
    returned: rows.filter((r) => r.correctionState === 'returned').length, fixed: rows.filter((r) => r.correctionState === 'submitted' || r.correctionState === 'rereview').length,
    needs: rows.filter((r) => r.b.reasons.length).length, all: rows.length, missing: rows.filter((r) => r.b.missing).length,
    treated: rows.filter((r) => r.b.treated).length, late: sum.late, failed: sum.conversionFailed,
  };
  const flt = ['needs', 'all', 'missing', 'treated', 'late', 'failed', 'returned', 'fixed'].includes(ui.subStatus) ? ui.subStatus : 'needs';
  const pass = { needs: (r) => r.b.reasons.length, all: () => true, missing: (r) => r.b.missing, treated: (r) => r.b.treated, returned: (r) => r.correctionState === 'returned', fixed: (r) => r.correctionState === 'submitted' || r.correctionState === 'rereview', late: (r) => r.code === 'late', failed: (r) => r.latest && r.conversion === 'failed' }[flt];
  const sortKey = ['name', 'date', 'due'].includes(ui.subSort) ? ui.subSort : 'name';
  const sortDir = ui.subDir === 'desc' ? 'desc' : 'asc';
  const shown = S.sortTrackerRows(rows.filter(pass), sortKey, sortDir);
  const label = { needs: 'דורשים טיפול', all: 'כל ההגשות', missing: 'לא הוגשו', treated: 'טופלו', late: 'הוגשו באיחור', failed: 'כשל בהמרה', returned: 'הוחזרו לתיקון', fixed: 'תיקון הוגש' };
  const chipIds = ['needs', 'all', 'missing', 'treated', ...['returned', 'fixed'].filter((k) => cnt[k] || flt === k), ...(['late', 'failed'].includes(flt) ? [flt] : [])];
  const chips = chipIds.map((k) => `<button class="chip ${flt === k ? 'on' : ''}" data-action="sub-filter" data-v="${k}" aria-pressed="${flt === k}" ${k === 'treated' ? 'title="סומנו \'טופל\' או שההשלמה אושרה"' : ''}>${label[k]} <span class="chip-n">${cnt[k]}</span></button>`).join('');
  const trs = shown.map((r) => {
    const reasons = r.b.reasons.map((k) => `<span class="wbadge st-pending">${ATTN_LABEL[k]}</span>`).join(' ');
    const conv = r.latest && r.conversion !== 'done' ? conversionBadge(r) : '';
    return `<tr>
      <td><b>${esc(r.unit.name)}</b>${ui.subTask === 'all' ? `<div class="muted">${esc(r.task.title)}</div>` : ''}</td>
      <td>${submissionBadge(r)}${r.correction ? `<div>${fixBadge(r.correction)}</div>` : ''}${r.latest ? `<div class="muted">${fmtDT(r.latest.uploadedAt)} · גרסה ${r.versions}${r.unit.type === 'group' ? ` · ${esc(r.uploader)}` : ''}</div>` : ''}</td>
      <td>${fmtD(r.due)}</td>
      <td class="wrapcell">${reasons} ${conv} ${feedbackCell(r)}</td>
      <td>${subRowActions(r)}</td></tr>`;
  }).join('');
  const empty = flt === 'needs' ? '<div class="empty">🎉 אין כרגע הגשות שדורשות טיפול. אפשר לעבור ל"כל ההגשות" או ל"לא הוגשו".</div>' : '<div class="empty">אין שורות שתואמות את הסינון.</div>';
  const stat = (v, n, t, warn) => `<button class="stat ${warn && n ? 'warn' : ''} ${flt === v ? 'on' : ''}" data-action="sub-filter" data-v="${v}" title="סנן: ${label[v]}"><div class="n">${n}</div>${t}</button>`;
  return shell('הגשות ובדיקה', `
    <div class="grid-stats">
      <button class="stat" data-action="sub-filter" data-v="all" title="סנן: כל ההגשות"><div class="n">${sum.submitted}/${sum.total}</div>הגישו</button>
      ${stat('late', cnt.late, 'הוגשו באיחור', true)}
      ${stat('missing', sum.missingLate, 'לא הוגשו אחרי המועד', true)}
      ${stat('failed', cnt.failed, 'כשל בהמרה ל-PDF', true)}
    </div>
    <div class="sub-bar">
      <div class="chips" role="group" aria-label="סינון הגשות">${chips}</div>
      <div class="toolbar" style="margin:8px 0 0">
        <select id="subTask" aria-label="משימה"><option value="all">כל משימות ההגשה</option>${subTasks.map((t) => `<option value="${esc(t.id)}" ${ui.subTask === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select>
        <label>מיון: <select id="subSort" aria-label="מיון ההגשות"><option value="name" ${sortKey === 'name' ? 'selected' : ''}>לפי שם קבוצה או תלמיד</option><option value="date" ${sortKey === 'date' ? 'selected' : ''}>לפי תאריך הגשה</option><option value="due" ${sortKey === 'due' ? 'selected' : ''}>לפי מועד המשימה</option></select></label><button type="button" class="btn small" data-action="sub-dir" title="הופך את כיוון המיון">${sortDir === 'asc' ? (sortKey === 'date' || sortKey === 'due' ? '⬆ מהישן לחדש' : '⬆ א עד ת') : (sortKey === 'date' || sortKey === 'due' ? '⬇ מהחדש לישן' : '⬇ ת עד א')}</button><span class="muted">מציג ${shown.length} מתוך ${rows.length}</span>
        <button class="btn" data-action="fb-batch" title="מפרסם הערות טיוטה רק בעבודות שסימנת 'סיימתי לבדוק'">📤 שלח משוב לעבודות הבדוקות (${F.sendableBatch(state).length})</button>
      </div>
    </div>
    <p class="muted sub-note">כשל בהמרה אינו כשל בהגשה: ההגשה נקלטה וחותמת הזמן נשמרת. אפשר לנסות שוב או לבקש PDF נוסף דרך "עוד".</p>
    ${shown.length ? `<div class="table-wrap sub-wrap"><table class="sub-table"><thead><tr><th>קבוצה או תלמיד</th><th>הגשה</th><th>מועד</th><th>מה נדרש / מצב</th><th></th></tr></thead><tbody>${trs}</tbody></table></div>` : empty}`);
}

// היסטוריית גרסאות ליחידה אחת. הגרסה האחרונה נחשבת; הקודמות נשמרות.
function versionsDialog(taskId, unitType, unitId) {
  const t = taskById(taskId);
  const vs = S.versionsOf(state, taskId, unitType, unitId);
  const unitName = (T.unitsOfTask(state, t).find((u) => u.type === unitType && u.id === unitId) || {}).name || '';
  const nameOf = (id) => (state.students.find((x) => x.id === id) || {}).name || '';
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>גרסאות הגשה: ${esc(t.title)} (${esc(unitName)})</h2>
    <p class="muted">הגרסה האחרונה היא הנחשבת. גרסאות קודמות נשמרות עם חותמת הזמן המקורית שלהן.</p>
    <div class="table-wrap"><table><thead><tr><th>גרסה</th><th>הוגש ב</th><th>הועלה על ידי</th><th>קובץ</th><th>מצב</th><th>המרה</th>${state.archived || (session && session.role !== 'teacher') ? '' : '<th></th>'}</tr></thead><tbody>
    ${[...vs].reverse().map((x, i) => `<tr><td>${x.version}${i === 0 ? ' <span class="pill">נוכחית</span>' : ''}${x.isCorrection ? ' <span class="pill">🔁 גרסה מתוקנת</span>' : ''}${(state.corrections || []).some((c) => c.returnedSubmissionId === x.id) ? ' <span class="pill">↩ הוחזרה לתיקון</span>' : ''}</td><td>${fmtDT(x.uploadedAt)}</td><td>${esc(nameOf(x.uploadedBy))}</td><td dir="ltr">${esc(x.fileName)}</td><td>${x.late ? '🕒 באיחור' : '✅ בזמן'}</td><td>${conversionBadge({ latest: x })}</td>${session && session.role === 'teacher' ? `<td>${x.conversion.status === 'done' ? `<button class="btn small primary" data-action="open-review" data-id="${esc(x.id)}">בדיקה${R.commentsOf(state, x.id).length ? ` (${R.commentsOf(state, x.id).length})` : ''}</button>` : ''}</td>` : ''}</tr>`).join('') || '<tr><td colspan="7" class="muted">אין הגשות</td></tr>'}
    </tbody></table></div>
    <div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}

// אזור ההגשה בתוך חלון המשימה. לתלמיד: הגשה ומצב. למורה: מצב כל היחידות.
function submissionPanelHtml(t, isTeacher) {
  if (!t.requiresSubmission) return '';
  if (isTeacher) {
    const rows = S.trackerRows(state, { taskId: t.id, now: nowIso() });
    return `<hr><h3>📥 הגשות במשימה</h3>
      <div class="table-wrap"><table><thead><tr><th>${t.kind === 'group' ? 'קבוצה' : 'תלמיד'}</th><th>מצב</th><th>הועלה על ידי</th><th>המרה</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.unit.name)}</td><td>${submissionBadge(r)}${r.latest ? `<div class="muted">${fmtDT(r.latest.uploadedAt)}, גרסה ${r.versions}</div>` : ''}</td><td>${r.latest ? esc(r.uploader) : '—'}</td><td>${conversionBadge(r)}</td>
        <td>${r.latest ? `<button type="button" class="btn small" data-action="sub-versions" data-task="${esc(t.id)}" data-utype="${r.unit.type}" data-unit="${esc(r.unit.id)}">גרסאות</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div><p><a href="#/submissions" data-ui="subTask=${esc(t.id)}" data-action="close-dlg">למסך ההגשות</a></p>`;
  }
  const unit = T.unitForStudent(state, t, session.userId);
  const st = S.submissionStatus(state, t, unit, nowIso());
  const vs = S.versionsOf(state, t.id, unit.type, unit.id);
  const nameOf = (id) => (state.students.find((x) => x.id === id) || {}).name || '';
  const approved = st.completion === 'approved';
  const x = st.latest;
  const sim = api.getSimulation();
  const fbs = F.feedbackForStudent(state, session.userId).filter((y) => y.task.id === t.id && y.submission.unitId === unit.id);
  const fbBtn = fbs.length ? `<div class="alert type-sub"><b>📩 יש משוב מהמורה על המשימה (${fbs.reduce((n, y) => n + y.comments.length, 0)} הערות).</b> <button type="button" class="btn small primary" data-action="open-feedback" data-id="${esc(fbs[0].submission.id)}">צפה במשוב</button></div>` : '';
  const openFix = S.openCorrection(state, t.id, unit.type, unit.id);
  return `<hr>${studentFixBanner(t, unit)}${fbBtn}<h3>📥 הגשת התוצר</h3>
    <p>מצב: ${submissionBadge(st)} ${x ? conversionBadge(st) : ''}</p>
    ${unit.type === 'group' ? '<p class="muted">ההגשה היא של כל הקבוצה: כל חבר קבוצה יכול להגיש, כולם יראו אותה, והמורה יראה מי העלה את הקובץ בפועל.</p>' : ''}
    ${st.overdue && !x ? '<div class="alert"><b>עבר המועד וטרם הוגש.</b> אפשר עדיין להגיש, וההגשה תסומן כאיחור.</div>' : ''}
    ${x && x.conversion.status === 'failed' && !x.pdfRequested ? '<div class="alert"><b>הקובץ נקלט וההגשה נרשמה בזמן.</b> ההמרה ל-PDF נכשלה. המורה יכול לנסות שוב או לבקש ממך PDF, ואין בכך פגיעה במועד ההגשה.</div>' : ''}
    ${x && x.pdfRequested ? `<div class="alert w-pending"><b>📨 המורה ביקש שתצרף קובץ PDF להגשה.</b> ההגשה המקורית ומועדה לא ישתנו.
      <div class="subrow"><input type="file" id="pdfFile"><button type="button" class="btn small primary" data-action="do-attach-pdf" data-id="${esc(x.id)}">צירוף PDF</button></div></div>` : ''}
    ${vs.length ? `<div class="table-wrap"><table><thead><tr><th>גרסה</th><th>הוגש ב</th><th>הועלה על ידי</th><th>קובץ</th><th>המרה</th></tr></thead><tbody>${[...vs].reverse().map((v, i) => `<tr><td>${v.version}${i === 0 ? ' (נוכחית)' : ''}${v.isCorrection ? ' 🔁 גרסה מתוקנת' : ''}</td><td>${fmtDT(v.uploadedAt)}${v.late ? ' 🕒 באיחור' : ''}</td><td>${esc(nameOf(v.uploadedBy))}</td><td dir="ltr">${esc(v.fileName)}</td><td>${conversionBadge({ latest: v })}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${approved ? '<p class="muted">ההשלמה אושרה על ידי המורה, ולכן אי אפשר להגיש שוב. כדי להגיש גרסה חדשה פנה למורה.</p>' : `
    <div class="subrow"><label class="btn primary big" for="subFile" id="subPick">📤 ${openFix ? 'הגש גרסה מתוקנת' : vs.length ? 'הגש גרסה חדשה' : 'הגש מסמך'}</label><input type="file" id="subFile" class="visually-hidden" aria-label="בחירת קובץ להגשה"><span id="subChosen" class="muted"></span>
      <button type="button" class="btn primary big" id="subSend" hidden data-action="do-submit" data-task="${esc(t.id)}" data-utype="${unit.type}" data-unit="${esc(unit.id)}">שלח את ההגשה</button></div>
    <p id="subMsg" class="submsg" role="alert"></p>
    <p class="alert">🔒 <b>פרטיות:</b> ${esc(P.STUDENT_PRIVACY_NOTICE)}</p>
    <p class="muted">שלבים: 1) לחץ על "${openFix ? 'הגש גרסה מתוקנת' : vs.length ? 'הגש גרסה חדשה' : 'הגש מסמך'}" ובחר קובץ. 2) לחץ על "שלח את ההגשה".</p>
    <p class="muted">אפשר להגיש Word (docx) או PDF, עד 20MB. הגשה חדשה נשמרת כגרסה חדשה, והקודמות נשארות. ההגשה נחשבת בקשת אישור מהמורה.</p>
    <p class="muted">קובץ Word מומר אוטומטית ל-PDF לצורך הבדיקה, וייתכנו שינויים קלים בכיווניות של מספרים ויחידות (למשל <span dir="ltr">72 BPM</span>). כדי לשמור על העיצוב בדיוק, הגישו PDF שייצאתם מ-Word. PDF מוצג כמו שהוא, בלי המרה.</p>
    <details class="demo-box"><summary>ארגז בדיקות (דמו בלבד)</summary>
      <label class="chk"><input type="checkbox" id="simSave" ${sim.failSave ? 'checked' : ''}> דמה כשל בשמירת הקובץ</label>
      <label class="chk"><input type="checkbox" id="simConv" ${sim.failConvert ? 'checked' : ''}> דמה כשל בהמרה ל-PDF</label></details>`}`;
}

// ---------- פנקס Notes אישי ----------
const cycleNameOf = (id) => ((state.cycles || []).find((c) => c.id === id) || {}).name || '';

function noteTarget(n) {
  if (n.scope === 'general') return 'כללית';
  const live = n.cycleId === state.activeCycleId ? (n.scope === 'student' ? state.students : state.groups).find((x) => x.id === n.refId) : null;
  const name = live ? live.name : n.refName;
  return `${n.scope === 'student' ? '👤' : '🧩'} ${name}${n.cycleId !== state.activeCycleId && cycleNameOf(n.cycleId) ? ` · ${cycleNameOf(n.cycleId)}` : ''}`;
}

function noteCardHtml(n, trash) {
  const badge = n.status === 'todo' ? '<span class="wbadge st-late">דורש טיפול</span>' : n.status === 'done' ? '<span class="wbadge st-active">טופל</span>' : '';
  const stBtns = trash ? '' : ['todo', 'done', 'none'].filter((k) => k !== n.status).map((k) => `<button class="btn small" data-action="note-status" data-id="${esc(n.id)}" data-v="${k}">${k === 'todo' ? 'סמן: דורש טיפול' : k === 'done' ? 'סמן: טופל' : 'נקה סימון'}</button>`).join('');
  const acts = trash
    ? `<button class="btn small" data-action="note-restore" data-id="${esc(n.id)}">שחזר מהסל</button><button class="btn small" data-action="note-purge" data-id="${esc(n.id)}">מחק לצמיתות</button>`
    : `${stBtns}<button class="btn small" data-action="note-edit" data-id="${esc(n.id)}">ערוך</button><button class="btn small" data-action="note-del" data-id="${esc(n.id)}">למחוק (לסל)</button>`;
  const hist = n.history && n.history.length ? `<details class="more-hist"><summary class="muted">היסטוריית עריכות (${n.history.length})</summary>${n.history.slice().reverse().map((h) => `<div class="nh"><span class="muted">${fmtDay(h.at)}</span> ${esc(h.text)}</div>`).join('')}</details>` : '';
  const pend = n._pending ? '<span class="wbadge st-pending" title="נשמר ברקע">⏳ שומר...</span>' : n._failed ? '<span class="wbadge st-late" title="' + esc(n._failed) + '">⚠ השמירה נכשלה</span>' : '';
  return `<div class="note ${n.status}"><div class="note-main"><div><b>${esc(noteTarget(n))}</b> ${badge} ${pend} <span class="muted">עודכן ${fmtDay(n.updatedAt)}${trash ? ` · נמחק ${fmtDay(n.deletedAt)}` : ''}</span></div>
    <div class="note-text">${esc(n.text)}</div>${hist}</div><div class="ntf-act">${acts}</div></div>`;
}

function notesFiltered() {
  return NB.searchNotes(vs().notesBook, session, { q: ui.noteQ || '', scope: ui.noteScope || 'all', status: ui.noteStatus || 'all', cycleId: ui.noteCycle || 'all', trash: !!ui.noteTrash });
}

function notesListHtml() {
  const list = notesFiltered();
  const total = vs().notesBook.items.filter((n) => (ui.noteTrash ? n.deletedAt : !n.deletedAt)).length;
  const head = `<div class="muted" style="margin:6px 0">מציג ${list.length} מתוך ${total}${ui.noteTrash ? ' (בסל)' : ''}</div>`;
  if (!list.length) return head + `<div class="empty">${ui.noteTrash ? 'הסל ריק.' : total ? 'אין Notes שמתאימים לסינון.' : 'עוד אין Notes. אפשר ליצור Note חדש מכל מסך עם הכפתור "📝 Note חדש".'}</div>`;
  return head + `<div class="ntf-list">${list.map((n) => noteCardHtml(n, !!ui.noteTrash)).join('')}</div>`;
}

function renderNotesList() {
  const el = document.getElementById('notesList');
  if (el) el.innerHTML = notesListHtml();
}

function viewNotes() {
  const sel = (id, label, cur, opts) => `<select id="${id}" aria-label="${label}">${opts.map(([v, l]) => `<option value="${v}" ${(cur || 'all') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const book = vs().notesBook;
  const restorePt = book.restorePoint;
  return shell('פנקס Notes', `
    <p class="muted">פנקס אישי שלך בלבד: התלמידים אינם רואים אותו, והוא אינו נכלל בייצוא מחזור למורה אחר. מחיקה מעבירה לסל, וכל עריכה נשמרת בהיסטוריה.</p>
    <div class="sub-bar"><div class="toolbar">
      <input type="search" id="noteQ" placeholder="חיפוש בטקסט או בשם" value="${esc(ui.noteQ || '')}" aria-label="חיפוש">
      ${sel('noteScope', 'שיוך', ui.noteScope, [['all', 'כל השיוכים'], ['general', 'כלליות'], ['student', 'לתלמיד'], ['group', 'לקבוצה']])}
      ${sel('noteStatus', 'סימון', ui.noteStatus, [['all', 'כל הסימונים'], ['todo', 'דורשות טיפול'], ['done', 'טופלו'], ['none', 'ללא סימון']])}
      ${sel('noteCycle', 'מחזור', ui.noteCycle, [['all', 'כל המחזורים'], ...(state.cycles || []).map((c) => [c.id, c.name])])}
      <label class="chk"><input type="checkbox" id="noteTrash" ${ui.noteTrash ? 'checked' : ''}> סל</label>
      <button class="btn primary" data-action="note-new">＋ Note חדש</button></div></div>
    <div id="notesList">${notesListHtml()}</div>
    <div class="card"><h2>גיבוי ושחזור</h2>
      <p class="muted">הפנקס נשמר אצלך בדמו. מומלץ לשמור גיבוי לקובץ מדי פעם. הקובץ מכיל את הפנקס בלבד, בלי נתוני מחזור או תלמידים. שחזור ממזג: הוא לא דורס Note שעודכן אחרי הגיבוי, ושומר נקודת שחזור שאפשר לחזור אליה. בגרסה האמיתית הגיבוי ייכלל בגיבוי הכללי שלך כחלק אישי מסומן.</p>
      <div class="toolbar"><button class="btn" data-action="note-backup">⬇ שמור גיבוי לקובץ</button><button class="btn" data-action="note-restore-pick">⬆ שחזור מקובץ גיבוי</button>
      <input type="file" id="noteRestoreFile" accept=".json,application/json" hidden>
      ${restorePt ? `<button class="btn" data-action="note-undo-restore">↩ חזרה למצב שלפני השחזור (${fmtDay(restorePt.at)})</button>` : ''}</div></div>`);
}

// הקשר ברירת מחדל לפי המסך: בבדיקת הגשה, ה-Note משויך לקבוצה או לתלמיד של ההגשה
function noteContext() {
  const sub = route() === 'review' ? reviewSubmission() : null;
  if (sub) return sub.unitType === 'group' ? { scope: 'group', refId: sub.unitId } : { scope: 'student', refId: sub.unitId };
  return { scope: 'general', refId: '' };
}

function noteDialog(note) {
  const ctx = note ? { scope: note.scope, refId: note.refId } : noteContext();
  const foreign = note && note.scope !== 'general' && note.cycleId !== state.activeCycleId;
  const studs = state.students.filter((s) => s.active || (note && s.id === note.refId));
  const scopeOpts = foreign
    ? `<option value="keep" selected>ללא שינוי: ${esc(noteTarget(note))}</option><option value="general">הפוך לכללית</option>`
    : Object.entries(NB.SCOPES).map(([k, l]) => `<option value="${k}" ${ctx.scope === k ? 'selected' : ''}>${l === 'כללית' ? 'כללית (ללא שיוך)' : l === 'תלמיד' ? 'לתלמיד' : 'לקבוצה'}</option>`).join('');
  openDialog(`<h2>${note ? 'עריכת Note' : 'Note חדש'}</h2>
    <label>שיוך <select name="scope" id="noteScopeSel">${scopeOpts}</select></label>
    <label id="noteStuLbl" ${ctx.scope === 'student' && !foreign ? '' : 'hidden'}>תלמיד <select name="student">${studs.map((s) => `<option value="${esc(s.id)}" ${ctx.refId === s.id ? 'selected' : ''}>${esc(s.name)}${s.active ? '' : ' (לא פעיל)'}</option>`).join('')}</select></label>
    <label id="noteGrpLbl" ${ctx.scope === 'group' && !foreign ? '' : 'hidden'}>קבוצה <select name="group">${state.groups.map((g) => `<option value="${esc(g.id)}" ${ctx.refId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <label>סימון <select name="status">${Object.entries(NB.STATUSES).map(([k, l]) => `<option value="${k}" ${(note ? note.status : 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>הטקסט <textarea name="text" rows="6" maxlength="${NB.MAX_TEXT}" required>${esc(note ? note.text : '')}</textarea></label>`,
  async (f) => {
    const x = new FormData(f);
    let scope = x.get('scope');
    let d = { text: x.get('text'), status: x.get('status') };
    if (scope === 'student') { const s = state.students.find((y) => y.id === x.get('student')); d = { ...d, scope, cycleId: state.activeCycleId, refId: s && s.id, refName: s ? s.name : '' }; }
    else if (scope === 'group') { const g = state.groups.find((y) => y.id === x.get('group')); d = { ...d, scope, cycleId: state.activeCycleId, refId: g && g.id, refName: g ? g.name : '' }; }
    else if (scope === 'general') d = { ...d, scope };
    ensureQueue();
    try {
      if (note) NB.updateNote(vs().notesBook, session, note.id, d); else { d.id = newClientId('note'); NB.addNote(vs().notesBook, session, d); }
    } catch (e) { toast(e.message || 'ה-Note לא תקין', true); return false; } // הדיאלוג נשאר פתוח, הטקסט לא אובד
    if (note) wq.enqueue('updateNote', [note.id, d]); else wq.enqueue('addNote', [d]);
    render();
    return true;
  });
  const sel = $dlg.querySelector('#noteScopeSel');
  const sync = () => { $dlg.querySelector('#noteStuLbl').hidden = sel.value !== 'student'; $dlg.querySelector('#noteGrpLbl').hidden = sel.value !== 'group'; };
  sel.addEventListener('change', sync);
  const ta = $dlg.querySelector('textarea');
  if (ta) ta.focus();
}

async function downloadNotesBackup() {
  try {
    const bk = await api.exportNotesBackup();
    const blob = new Blob([JSON.stringify(bk, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `notes-backup-${bk.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`הגיבוי נשמר לקובץ (${bk.items.length} Notes, כולל מה שבסל)`);
  } catch (e) { toast(e.message, true); }
}

async function pickNotesRestore(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch (e) { toast('הקובץ אינו קובץ JSON תקין.', true); return; }
  let pv;
  try { pv = await api.previewNotesRestore(backup); } catch (e) { toast(e.message, true); return; }
  showDlg(`<div class="form"><h2>שחזור פנקס Notes מגיבוי</h2>
    <p class="muted">הגיבוי נשמר ב-${esc(pv.savedAt ? fmtDay(pv.savedAt) : 'תאריך לא ידוע')} ומכיל ${pv.total} Notes.</p>
    <ul class="plain"><li>יתווספו: <b>${pv.added.length}</b></li><li>יתעדכנו (הגיבוי חדש יותר): <b>${pv.updated.length}</b>. הנוסח הנוכחי יישמר בהיסטוריה של ה-Note.</li>
    <li>יישארו כפי שהם (הנוכחי חדש יותר או זהה): <b>${pv.keptNewer.length + pv.same.length}</b></li><li>קיימים רק אצלך ולא ייפגעו: <b>${pv.onlyHere}</b></li></ul>
    <p class="muted">לפני השחזור נשמרת נקודת שחזור, ואפשר לבטל את השחזור מיד אחריו.</p>
    <div class="dlg-actions"><button class="btn primary" id="nrOk">בצע שחזור</button><button class="btn" id="nrNo">ביטול</button></div></div>`);
  $dlg.querySelector('#nrNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#nrOk').addEventListener('click', async () => { $dlg.close(); await run(() => api.restoreNotesBackup(backup), 'הפנקס שוחזר. אפשר לבטל בלחיצה על "חזרה למצב שלפני השחזור"'); });
}

// ---------- גיבוי ושחזור מחזור (שלב 7) ----------
function viewBackup() {
  const cyc = state.cycles.find((c) => c.id === state.activeCycleId);
  const lr = state.lastRestore;
  const sim = api.getSimulation();
  const resultHtml = lr ? `<div class="card ${lr.status === 'complete' ? '' : 'alert'}"><h2>${lr.status === 'complete' ? '✅ השחזור הסתיים' : '⚠️ השחזור הסתיים חלקית: חסרים קבצים'}</h2>
    <p>מחזור "${esc(lr.cycleName)}" שוחזר מגיבוי מ-${esc(lr.backupSavedAt ? fmtDay(lr.backupSavedAt) : 'תאריך לא ידוע')}. נבדקו ${lr.filesChecked} קבצי הגשה.</p>
    ${lr.missingFiles.length ? `<p><b>${lr.missingFiles.length} קבצים לא נמצאו ב-Drive.</b> רשומות ההגשה נשמרו וסומנו "קובץ חסר". לא נמחק דבר. החזירו את הקובץ ל-Drive ואז לחצו "קישור מחדש".</p>
      <ul class="plain">${lr.missingFiles.map((m) => `<li>${esc(m.fileName)} <button class="btn small" data-action="bk-relink" data-id="${esc(m.id)}">קישור מחדש</button></li>`).join('')}</ul>` : ''}
    ${lr.attachedLate.length ? `<p>הגשות שהגיעו אחרי הגיבוי וצורפו למחזור המשוחזר: <b>${lr.attachedLate.length}</b></p><ul class="plain">${lr.attachedLate.map((x) => `<li>${esc(x.fileName)} (${esc(x.taskTitle)}, ${esc(fmtDay(x.uploadedAt))})</li>`).join('')}</ul>` : ''}
    ${lr.notAttached.length ? `<p><b>הגשות שלא צורפו: ${lr.notAttached.length}.</b> הן לא נמחקו: הן שמורות בצד (בסעיף "הגשות שמורות בצד" למטה) ואפשר לצרף אותן בהמשך. עותק נשמר גם בגיבוי האוטומטי.</p><ul class="plain">${lr.notAttached.map((x) => `<li>${esc(x.fileName)} (${esc(x.taskTitle)}, ${esc(fmtDay(x.uploadedAt))})</li>`).join('')}</ul>` : ''}</div>` : '';
  const autos = state.autoBackups || [];
  return shell('גיבוי ושחזור', `
    <div class="alert"><b>מה הגיבוי כולל ומה לא:</b> ${esc(B.FILES_NOTICE)}</div>
    ${resultHtml}
    <div class="card"><h2>גיבוי המחזור "${esc(cyc ? cyc.name : '')}" ${helpIcon('backup-scope')}</h2>
      <p class="muted">הקובץ נשמר אצלכם. מומלץ לשמור גיבוי לפני שינויים גדולים. גיבוי נעשה גם אוטומטית לפני כל שחזור.</p>
      <label class="chk"><input type="checkbox" id="bkPersonal"> לכלול גם את פנקס ה-Notes האישי שלי (חלק אישי מסומן בקובץ). שחזור מחזור לא ישנה את הפנקס, ושחזור הפנקס הוא פעולה נפרדת.</label>
      <div class="toolbar"><button class="btn primary" data-action="bk-export">⬇ שמור גיבוי לקובץ</button></div></div>
    <div class="card"><h2>שחזור מחזור מקובץ גיבוי ${helpIcon('restore-scope')}</h2>
      <p class="muted">השחזור מחליף את כל נתוני המחזור שבקובץ. לפני כן מוצגת תצוגה מקדימה, נשמר גיבוי אוטומטי של המצב הנוכחי, ובזמן השחזור לא ניתן להגיש. הגשות שהגיעו אחרי הגיבוי לא מצורפות אוטומטית: תתבקשו להחליט, והן לא נמחקות.</p>
      <div class="toolbar"><button class="btn" data-action="bk-pick">⬆ בחירת קובץ גיבוי</button><input type="file" id="bkFile" accept=".json,application/json" hidden></div></div>
    <div class="card"><h2>סל מחזורים ${helpIcon('archive-vs-trash')}</h2>
      ${(state.trash || []).length ? '<p class="muted">מחזורים שנמחקו. הם נשארים בסל לפחות ' + 30 + ' יום ואינם נמחקים אוטומטית. מחיקה לצמיתות רק ביוזמתך.</p><div class="table-wrap"><table><thead><tr><th>מחזור</th><th>נמחק</th><th>תלמידים / משימות / הגשות</th><th>שמירה</th><th></th></tr></thead><tbody>' + state.trash.map((x) => '<tr><td>' + esc(x.name) + '</td><td>' + esc(fmtDay(x.deletedAt)) + '</td><td>' + x.counts.students + ' / ' + x.counts.tasks + ' / ' + x.counts.submissions + '</td><td>' + (x.pastRetention ? 'עברו 30 יום (עדיין שמור)' : 'עוד ' + x.daysLeft + ' ימים לפחות') + '</td><td><div class="toolbar"><button class="btn small" data-action="trash-restore" data-id="' + esc(x.id) + '">שחזור מהסל</button><button class="btn small danger" data-action="trash-purge" data-id="' + esc(x.id) + '" data-name="' + esc(x.name) + '">מחיקה לצמיתות…</button></div></td></tr>').join('') + '</tbody></table></div><p class="muted">מחזור משוחזר מהסל חוזר כארכיון, בלי גישת תלמידים.</p>' : '<p class="muted">הסל ריק.</p>'}</div>
    <div class="card"><h2>הגשות שמורות בצד</h2>
      ${(state.heldSubmissions || []).length ? '<p class="muted">הגשות שהגיעו אחרי גיבוי ולא צורפו למחזור משוחזר. הן לא נמחקו. צירוף נעשה רק באישורך.</p><div class="table-wrap"><table><thead><tr><th>קובץ</th><th>משימה</th><th>מחזור</th><th>הוגש</th><th>סיבה</th><th></th></tr></thead><tbody>' + state.heldSubmissions.map((h) => '<tr><td>' + esc(h.fileName) + '</td><td>' + esc(h.taskTitle) + '</td><td>' + esc(h.cycleName) + '</td><td>' + esc(fmtDay(h.uploadedAt)) + '</td><td>' + (h.reason === 'declined' ? 'לא אושר צירוף' : 'לא ניתן לצירוף') + '</td><td><button class="btn small" data-action="bk-attach-held" data-id="' + esc(h.id) + '">צרף למחזור</button></td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">אין.</p>'}</div>
    <div class="card"><h2>יומן החלטות</h2>
      ${(state.decisionLog || []).length ? '<div class="table-wrap"><table><thead><tr><th>מתי</th><th>מחזור</th><th>החלטה</th><th>קבצים</th></tr></thead><tbody>' + state.decisionLog.map((e) => '<tr><td>' + esc(fmtDay(e.at)) + '</td><td>' + esc(e.cycleName) + '</td><td>' + esc(({ attach: 'צורפו למחזור', hold: 'נשמרו בצד, לא צורפו', none: 'שחזור בלי הגשות מאוחרות', archive: 'הועבר לארכיון', unarchive: 'הוחזר לפעיל', open: 'נפתחה גישת צפייה לתלמידים', close: 'נסגרה גישת תלמידים', trash: 'הועבר לסל', restore: 'שוחזר מהסל', purge: 'נמחק לצמיתות מהסל' })[e.decision] || e.decision) + (e.note ? ' (' + esc(e.note) + ')' : '') + '</td><td>' + esc((e.fileNames || []).join(', ')) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="muted">עדיין אין החלטות.</p>'}</div>
    <div class="card"><h2>גיבויים אוטומטיים</h2>
      ${autos.length ? `<div class="table-wrap"><table><thead><tr><th>מחזור</th><th>מתי</th><th>סיבה</th><th>הגשות</th><th></th></tr></thead><tbody>${autos.map((a) => `<tr><td>${esc(a.cycleName)}</td><td>${esc(fmtDay(a.at))}</td><td>${esc(a.reason)}</td><td>${a.submissions}</td>
        <td><button class="btn small" data-action="bk-undo" data-id="${esc(a.id)}">↩ חזרה למצב הזה</button></td></tr>`).join('')}</tbody></table></div>
        <p class="muted">נשמרים עד ${B.MAX_AUTO} אחרונים. חזרה למצב שמור מחליפה את נתוני המחזור, ושומרת גם את המצב הנוכחי לפני כן.</p>` : '<p class="muted">עדיין אין. גיבוי אוטומטי נשמר לפני כל שחזור.</p>'}</div>
    <details class="card demo-box"><summary>🧪 הדמיות לבדיקה (דמו בלבד)</summary>
      <label class="chk"><input type="checkbox" id="simWriteFail" ${sim.failWrite ? 'checked' : ''}> דמה כשל בשמירה (כל פעולה תיכשל בגלוי ושום דבר לא יישמר)</label>
      <label class="chk"><input type="checkbox" id="simRestoreFail" ${sim.failRestore ? 'checked' : ''}> דמה כשל באמצע שחזור</label>
      <label class="chk"><input type="checkbox" id="simMissing" ${sim.missingFileIds.length ? 'checked' : ''}> דמה ששתי הגשות נמחקו מה-Drive</label></details>`);
}

// הורדת קובץ הגשה למחשב (מורה): קובץ המקור כפי שהוגש, או ה-PDF שמשמש לתצוגת הבדיקה. נבדק שלמות בכל מקטע.
async function saveSubmissionFile(subId, kind) {
  const sub = (state.submissions || []).find((x) => x.id === subId);
  if (!sub) { toast('ההגשה לא נמצאה.', true); return; }
  const name = kind === 'pdf' ? ((sub.conversion && sub.conversion.pdfName) || String(sub.fileName).replace(/.[^.]+$/, '') + '.pdf') : sub.fileName;
  try {
    toast('מוריד את הקובץ...');
    const bytes = await downloadFile(api, subId, kind, { onProgress: (p) => { if (p.total > 3) toast(`מוריד... ${p.done} מתוך ${p.total}`); } });
    const blob = new Blob([bytes], { type: kind === 'pdf' ? 'application/pdf' : 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`הקובץ "${name}" ירד למחשב.`);
  } catch (e) { toast(e.message || 'ההורדה נכשלה. נסו שוב.', true); }
}

async function downloadCycleBackup() {
  try {
    const personal = !!(document.getElementById('bkPersonal') || {}).checked;
    const bk = await api.exportCycleBackup({ includePersonal: personal });
    const blob = new Blob([JSON.stringify(bk, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cycle-backup-${bk.savedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`הגיבוי נשמר לקובץ (${bk.data.submissions.length} הגשות כרשומות, ${personal ? 'כולל' : 'בלי'} פנקס Notes). הוא לא כולל את קובצי ההגשות עצמם.`);
  } catch (e) { toast(e.message, true); }
}

async function pickCycleRestore(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); } catch (e) { toast('הקובץ אינו קובץ JSON תקין.', true); return; }
  let pv;
  try { pv = await api.previewCycleRestore(backup); } catch (e) { toast(e.message, true); return; }
  const cc = pv.currentCounts;
  const late = [...pv.lateAttachable, ...pv.lateBlocked];
  showDlg(`<div class="form wide"><h2>שחזור המחזור "${esc(pv.cycleName)}"</h2>
    <p class="muted">הגיבוי נשמר ב-${esc(pv.savedAt ? fmtDay(pv.savedAt) : 'תאריך לא ידוע')}.</p>
    ${pv.willOverwrite ? '<div class="alert"><b>אזהרה: השחזור יחליף את כל נתוני המחזור הנוכחי.</b> שינויים שנעשו אחרי הגיבוי יוחלפו. לפני כן יישמר גיבוי אוטומטי שאפשר לחזור אליו.</div>' : '<p>המחזור אינו קיים כרגע. הוא ייווצר מחדש מהגיבוי.</p>'}
    <div class="table-wrap"><table><thead><tr><th></th><th>תלמידים</th><th>קבוצות</th><th>משימות</th><th>הגשות</th></tr></thead><tbody>
      <tr><td>בגיבוי</td><td>${pv.counts.students}</td><td>${pv.counts.groups}</td><td>${pv.counts.tasks}</td><td>${pv.counts.submissions}</td></tr>
      ${cc ? `<tr><td>כעת</td><td>${cc.students}</td><td>${cc.groups}</td><td>${cc.tasks}</td><td>${cc.submissions}</td></tr>` : ''}</tbody></table></div>
    ${late.length ? `<div class="alert"><b>${late.length} הגשות הגיעו אחרי הגיבוי</b> ולא נמצאות בקובץ:<ul class="plain">${late.map((x) => `<li>${esc(x.fileName)} (${esc(x.taskTitle)}, ${esc(fmtDay(x.uploadedAt))})${pv.lateBlocked.some((b) => b.id === x.id) ? ' <b>לא ניתן לצרף: המשימה או היחידה לא קיימות בגיבוי</b>' : ''}</li>`).join('')}</ul>
      ${pv.lateAttachable.length ? '<p><b>יש לבחור אחת משתי האפשרויות לפני השחזור:</b></p><label class="chk"><input type="radio" name="bkLate" value="attach"> לצרף את ' + pv.lateAttachable.length + ' ההגשות שניתן לצרף למחזור המשוחזר</label><label class="chk"><input type="radio" name="bkLate" value="hold"> לא לצרף: לשמור אותן בצד, בלי למחוק, ולטפל בהן אחר כך</label>' : ''}
      ${pv.lateBlocked.length ? '<p class="muted">הגשות שאינן ניתנות לצירוף יישמרו בצד אוטומטית.</p>' : ''}</div>` : ''}
    ${pv.hasPersonal ? '<p class="muted">בקובץ יש גם חלק אישי של פנקס Notes. שחזור המחזור לא ייגע בו. לשחזור הפנקס: מסך "פנקס Notes".</p>' : ''}
    <p class="muted">${esc(pv.notice)}</p>
    <div class="dlg-actions"><button class="btn primary" id="crOk" ${pv.lateAttachable.length ? 'disabled' : ''}>בצע שחזור</button><button class="btn" id="crNo">ביטול</button></div></div>`);
  $dlg.querySelector('#crNo').addEventListener('click', () => closeDlg());
  $dlg.querySelectorAll('input[name=bkLate]').forEach((r) => r.addEventListener('change', () => { $dlg.querySelector('#crOk').disabled = false; }));
  $dlg.querySelector('#crOk').addEventListener('click', async () => {
    const pick = $dlg.querySelector('input[name=bkLate]:checked');
    const lateDecision = pick ? pick.value : undefined;
    $dlg.innerHTML = '<div class="form"><h2>משחזר… אל תסגרו את הדף</h2><p id="crProg" class="muted">בודק קבצים…</p></div>';
    try {
      state = await api.restoreCycleBackup(backup, { lateDecision, onStep: ({ done, total }) => { const p = document.getElementById('crProg'); if (p) p.textContent = `נבדקו ${done} מתוך ${total} קבצים…`; } });
      $dlg.close();
      const ok = state.lastRestore && state.lastRestore.status === 'complete';
      toast(ok ? 'השחזור הסתיים' : 'השחזור הסתיים חלקית: חסרים קבצים. פירוט במסך', !ok);
    } catch (e) {
      $dlg.close();
      state = await api.getState();
      toast(e.message, true);
    }
    render();
  });
}

// ---------- התראות, תזכורות ויומן שליחות ----------
const NOTIF_TABS = [['alerts', '🔔 התראות'], ['reminders', '⏰ תזכורות'], ['log', '📜 יומן שליחות'], ['settings', '⚙️ הגדרות']];
const NOTIF_FILTERS = { open: 'דורשות טיפול', unread: 'לא נקראו', resolved: 'טופלו', all: 'הכול' };
const SEND_STATUS = { sent: 'נשלח (דמה)', capped: 'נחסם: מכסה יומית', cancelled: 'בוטל: כבר לא רלוונטי' };
const CH_LABEL = { system: 'במערכת', email: 'דוא"ל' };
// שעה מקומית של המשתמש (הזמנים נשמרים ב-UTC)
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLocal = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDay = (iso) => (/Z$|[+-]\d\d:?\d\d$/.test(String(iso)) ? fmtLocal(iso) : `${fmtD(iso.slice(0, 10))} ${iso.slice(11, 16)}`);
const notifText = (t) => esc(t).replace(/\{\{t:([^}]+)\}\}/g, (m, iso) => fmtLocal(iso));
const offsetsText = (o) => (o.length ? o.map((n) => (n === 0 ? 'ביום המועד' : `${Math.abs(n) === 1 ? 'יום' : Math.abs(n) + ' ימים'} ${n < 0 ? 'לפני' : 'אחרי'}`)).join(', ') : 'ללא');

function viewNotifications() {
  const tab = NOTIF_TABS.some(([k]) => k === ui.notifTab) ? ui.notifTab : 'alerts';
  const tabs = `<div class="tabs" role="tablist">${NOTIF_TABS.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" role="tab" aria-selected="${tab === k}" data-action="notif-tab" data-v="${k}">${l}</button>`).join('')}</div>`;
  const body = { alerts: notifAlertsHtml, reminders: notifRemindersHtml, log: notifLogHtml, settings: notifSettingsHtml }[tab]();
  return shell('התראות ותזכורות', tabs + body);
}

function notifAlertsHtml() {
  const all = state.notifs || [];
  const cnt = N.notifCounts(state);
  const f = NOTIF_FILTERS[ui.notifFilter] ? ui.notifFilter : 'open';
  const num = { open: cnt.open, unread: cnt.unread, resolved: cnt.resolved, all: all.length };
  const pass = { open: (n) => !n.resolvedAt, unread: (n) => N.notifStatus(n) === 'open-unread', resolved: (n) => !!n.resolvedAt, all: () => true }[f];
  const types = [...new Set(all.map((n) => n.type))];
  const tf = types.includes(ui.notifType) ? ui.notifType : 'all';
  const list = all.filter(pass).filter((n) => tf === 'all' || n.type === tf).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  const chips = Object.entries(NOTIF_FILTERS).map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-action="notif-filter" data-v="${k}" aria-pressed="${f === k}">${l} (${num[k]})</button>`).join('');
  const item = (n) => {
    const st = N.notifStatus(n);
    const ty = N.TYPES[n.type] || { label: n.type, icon: '🔔' };
    const badge = st === 'resolved' ? '<span class="wbadge st-active">טופלה</span>' : st === 'open-unread' ? '<span class="wbadge st-pending">חדשה</span>' : '<span class="wbadge st-late">נקראה, עדיין דורשת טיפול</span>';
    const rd = n.resolvedAt ? '' : n.read ? `<button class="btn small" data-action="notif-unread" data-id="${esc(n.id)}">סמן כלא נקראה</button>` : `<button class="btn small" data-action="notif-read" data-id="${esc(n.id)}">סמן כנקראה</button>`;
    const ev = n.source !== 'event' ? '' : n.resolvedAt ? `<button class="btn small" data-action="notif-reopen" data-id="${esc(n.id)}">פתח מחדש</button>` : `<button class="btn small" data-action="notif-resolve" data-id="${esc(n.id)}" title="האירוע לא נסגר לבד: סימון מעיד שטיפלת בו">סגור כטופל</button>`;
    return `<div class="ntf ${st}"><div class="ntf-main"><div><b>${ty.icon} ${esc(ty.label)}</b> ${badge}${n.count > 1 ? ` <span class="muted">(${n.count} פעמים)</span>` : ''}</div>
      <div style="white-space:pre-line">${notifText(n.text)}</div><div class="muted">${fmtDay(n.lastAt)}${n.resolvedAt ? ` · טופלה ${fmtDay(n.resolvedAt)}` : ''}</div></div>
      <div class="ntf-act">${n.link && n.link !== '#/notifications' && !n.resolvedAt ? `<button class="btn small primary" data-action="notif-open" data-id="${esc(n.id)}" data-link="${esc(n.link)}">פתח</button>` : ''}${rd}${ev}</div></div>`;
  };
  return `<p class="muted">"נקראה" אומר שראית את ההתראה. "טופלה" אומר שהבעיה נפתרה: ברוב הסוגים זה קורה אוטומטית כשהמצב משתנה (למשל אחרי הגשה), ואירוע כמו קובץ גדול מדי נסגר על ידך.</p>
    <div class="sub-bar"><div class="chips" role="group" aria-label="סינון התראות">${chips}</div>
    <div class="toolbar" style="margin:8px 0 0"><select id="notifType" aria-label="סוג התראה"><option value="all">כל הסוגים</option>${types.map((k) => `<option value="${k}" ${tf === k ? 'selected' : ''}>${esc((N.TYPES[k] || { label: k }).label)}</option>`).join('')}</select>
    <span class="muted">מציג ${list.length} מתוך ${all.length}</span><button class="btn" data-action="notif-read-all" ${cnt.unread ? '' : 'disabled'}>סמן הכל כנקרא</button>${remoteMode ? '<button class="btn" data-action="notif-maint" title="בודק עכשיו אם יש העלאות של תלמידים שלא הושלמו, ומעדכן את ההתראה">🔄 בדוק העלאות שלא הושלמו</button>' : ''}</div></div>
    ${list.length ? `<div class="ntf-list">${list.map(item).join('')}</div>` : `<div class="empty">${f === 'open' ? '🎉 אין כרגע התראות שדורשות טיפול.' : 'אין התראות להצגה.'}</div>`}`;
}

const quotaHtml = () => {
  const q = state.mailQuota || { used: 0, cap: 0, left: 0, capped: 0, full: false };
  const pct = q.cap ? Math.min(100, Math.round((q.used / q.cap) * 100)) : 100;
  return `<div class="card quota ${q.full ? 'full' : pct >= 80 ? 'near' : ''}"><b>✉️ מכסת דוא"ל להיום: ${q.used} מתוך ${q.cap}</b>
    <div class="qbar"><i style="width:${pct}%"></i></div>
    <div class="muted">${q.full ? 'המכסה הגיעה למגבלה: הודעות נוספות יישלחו רק במערכת, והדוא"ל יישלח כשיהיה מקום.' : `נשארו ${q.left} הודעות.`}${q.capped ? ` ${q.capped} הודעות מחכות למקום.` : ''} המכסה משותפת לכל המחזורים. בדמו אין שליחה אמיתית: זו רשומה ביומן בלבד.</div></div>`;
};

function notifRemindersHtml() {
  const g = (state.notifSettings && state.notifSettings.reminders) || { enabled: true, offsets: [], email: true };
  const last = api.getLastReminderRun();
  const rows = T.orderedTasks(state).filter((t) => t.requiresSubmission).map((t) => {
    const c = N.reminderConfig(state, t.id);
    const sentN = (state.sendLog || []).filter((e) => e.kind === 'reminder' && e.taskId === t.id && e.status === 'sent' && e.channel === 'system').length;
    const txt = c.source === 'global-off' ? '<span class="muted">מושבתות (המתג הכללי כבוי)</span>' : c.source === 'off' ? '<span class="wbadge st-inactive">כבויות למשימה</span>' : `${offsetsText(c.offsets)} · ${c.email ? 'במערכת ובדוא"ל' : 'במערכת בלבד'}${c.source === 'custom' ? ' <span class="wbadge st-pending">הגדרה אישית</span>' : ''}`;
    return `<tr><td><b>${esc(t.title)}</b><div class="muted">${kindName(t.kind)} · מועד ${fmtD(t.due)}</div></td><td>${txt}</td><td>${sentN}</td><td><button class="btn small" data-action="rem-task-edit" data-id="${esc(t.id)}">הגדרה למשימה</button></td></tr>`;
  }).join('');
  return `${quotaHtml()}
    <div class="card"><h2>בדיקת תזכורות</h2>
      <p class="muted">בגרסה האמיתית הבדיקה תרוץ אוטומטית פעם ביום. בדמו מריצים ידנית, ואפשר לבחור תאריך כדי לראות מה היה נשלח. התזכורות נקבעות לפי המועד התקף של כל קבוצה או תלמיד (כולל ארכה), נפסקות כשהוגש, ולא נשלחות פעמיים. תזכורת שהמועד שלה עבר מזמן לא נשלחת בדיעבד.</p>
      <div class="toolbar"><label>תאריך לבדיקה <input type="date" id="remDay" value="${esc(ui.remDay || T.D.today())}"></label><button class="btn primary" data-action="rem-run" ${g.enabled ? '' : 'disabled title="התזכורות כבויות בהגדרות"'}>הרץ בדיקת תזכורות</button></div>
      ${last ? `<div class="alert" style="border-inline-start-color:var(--ok)">הבדיקה האחרונה (${fmtD(last.day)}): נשלחו ${last.system} הודעות במערכת, ${last.email} בדוא"ל${last.capped ? `, ${last.capped} נחסמו במכסה` : ''}.</div>` : ''}
      ${g.enabled ? '' : '<div class="alert">התזכורות כבויות לכל המשימות. אפשר להפעיל בלשונית "הגדרות".</div>'}
    </div>
    <div class="card"><h2>הגדרה לפי משימה</h2><p class="muted">ברירת מחדל: ${offsetsText(g.offsets)}, ${g.email ? 'במערכת ובדוא"ל' : 'במערכת בלבד'}. תזכורות נשלחות רק על משימות הגשה.</p>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>משימה</th><th>תזכורות</th><th>נשלחו</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">אין במחזור משימות הגשה.</div>'}</div>`;
}

function notifLogHtml() {
  const rows = N.logRows(state).slice(0, 200);
  const trs = rows.map((e) => {
    const who = e.audience === 'teacher' ? 'אליך (התראה)' : `${esc(e.studentName || '—')}`;
    const what = e.audience === 'teacher' ? esc((N.TYPES[e.notifType] || { label: '' }).label) : `תזכורת${e.taskTitle ? `: ${esc(e.taskTitle)}` : ''}`;
    const detail = e.channel === 'email' ? `<div><b>${esc(e.subject)}</b></div><div class="muted mailbody">${esc(e.body)}</div>` : esc(e.body);
    return `<tr><td>${fmtDay(e.at)}</td><td>${who}</td><td>${what}</td><td>${CH_LABEL[e.channel] || e.channel}</td><td><span class="wbadge ${e.status === 'sent' ? 'st-active' : e.status === 'cancelled' ? 'st-inactive' : 'st-late'}">${SEND_STATUS[e.status] || e.status}</span></td><td class="wrapcell">${detail}</td></tr>`;
  }).join('');
  return `<p class="muted">כל מה שהמערכת שלחה או ניסתה לשלוח: הודעות לתלמידים והודעות דוא"ל אליך. בדוא"ל מופיע קישור בלבד, בלי ציונים, משוב או פרטים רפואיים. בדמו לא נשלח דוא"ל אמיתי. מוצגות עד 200 רשומות אחרונות.</p>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>מתי</th><th>למי</th><th>על מה</th><th>ערוץ</th><th>מצב</th><th>תוכן</th></tr></thead><tbody>${trs}</tbody></table></div>` : '<div class="empty">עוד לא נשלחה אף הודעה. בלשונית "תזכורות" אפשר להריץ בדיקה.</div>'}`;
}

function notifSettingsHtml() {
  const s = state.notifSettings;
  const catRows = N.EMAIL_TYPES.map((k) => `<label class="chk"><input type="checkbox" name="cat_${k}" ${s.emailCategories[k] ? 'checked' : ''}> ${N.TYPES[k].icon} ${esc(N.TYPES[k].label)}</label>`).join('');
  return `${quotaHtml()}
    <form class="card form" id="notifSettingsForm" onsubmit="return false">
      <h2>תזכורות לתלמידים (ברירת מחדל לכל המשימות) ${helpIcon('reminders')}</h2>
      <label class="chk"><input type="checkbox" name="remEnabled" ${s.reminders.enabled ? 'checked' : ''}> תזכורות פעילות</label>
      <label>מתי לשלוח, בימים ביחס למועד ההגשה (מופרדים בפסיק)
        <input type="text" name="remOffsets" value="${esc(s.reminders.offsets.join(', '))}" dir="ltr" placeholder="-3, 0, 1"></label>
      <p class="muted">מינוס = לפני המועד, 0 = ביום המועד, פלוס = אחרי. למשל "-3, 0, 1": שלושה ימים לפני, ביום המועד, ויום אחרי. עד 5 תזכורות.</p>
      <label class="chk"><input type="checkbox" name="remEmail" ${s.reminders.email ? 'checked' : ''}> לשלוח גם בדוא"ל לתלמיד (הדוא"ל מכיל קישור בלבד)</label>
      <h2>דוא"ל אליך על התראות</h2>
      <p class="muted">ברירת המחדל: בלי דוא"ל, כדי לא להציף. סמן רק מה שחשוב לך.</p>
      <div class="checks">${catRows}</div>
      <label>מכסת דוא"ל יומית (תלמידים והתראות יחד)
        <input type="number" name="cap" min="0" max="${N.MAX_CAP}" step="1" value="${s.dailyEmailCap}"></label>
      <p class="muted">אחרי המכסה ההודעות נשארות במערכת והדוא"ל נדחה. המגבלה האמיתית של Google תלויה בסוג החשבון ולא נבדקה כאן; יש לוודא אותה בפריסה.</p>
      <h2>מקום ב-Drive (מדומה בדמו)</h2>
      <div class="row2"><label>תפוסה נוכחית (%) <input type="number" name="drive" min="0" max="100" step="1" value="${s.driveUsedPct}"></label>
      <label>להתריע מ-% <input type="number" name="driveWarn" min="1" max="100" step="1" value="${s.driveWarnPct}"></label></div>
      <p class="muted">בגרסה האמיתית הערך יימדד מה-Drive. כאן אפשר להקליד ערך כדי לראות את ההתראה.</p>
      <div class="dlg-actions"><button class="btn primary" type="button" data-action="notif-save-settings">שמירת הגדרות</button></div>
    </form>`;
}

const parseOffsets = (txt) => String(txt || '').split(/[,\s]+/).filter(Boolean).map((x) => { const n = Number(x); if (!Number.isInteger(n)) throw new Error(`"${x}" אינו מספר שלם`); return n; });

function readNotifSettings() {
  const f = document.getElementById('notifSettingsForm');
  const v = (n) => f.elements[n];
  return {
    reminders: { enabled: v('remEnabled').checked, email: v('remEmail').checked, offsets: parseOffsets(v('remOffsets').value) },
    emailCategories: Object.fromEntries(N.EMAIL_TYPES.map((k) => [k, v('cat_' + k).checked])),
    dailyEmailCap: v('cap').value, driveUsedPct: v('drive').value, driveWarnPct: v('driveWarn').value,
  };
}

function taskReminderDialog(taskId) {
  const t = taskById(taskId);
  const cur = (state.taskReminders || []).find((x) => x.taskId === taskId);
  const mode = cur ? cur.mode : 'default';
  const g = state.notifSettings.reminders;
  openDialog(`<h2>תזכורות: ${esc(t.title)}</h2>
    <label class="chk"><input type="radio" name="mode" value="default" ${mode === 'default' ? 'checked' : ''}> לפי ברירת המחדל (${offsetsText(g.offsets)}, ${g.email ? 'עם דוא"ל' : 'במערכת בלבד'})</label>
    <label class="chk"><input type="radio" name="mode" value="off" ${mode === 'off' ? 'checked' : ''}> בלי תזכורות למשימה הזו</label>
    <label class="chk"><input type="radio" name="mode" value="custom" ${mode === 'custom' ? 'checked' : ''}> הגדרה אישית</label>
    <label>ימים ביחס למועד (מופרדים בפסיק) <input type="text" name="offsets" dir="ltr" value="${esc(cur && cur.offsets ? cur.offsets.join(', ') : g.offsets.join(', '))}" placeholder="-2, 0"></label>
    <label class="chk"><input type="checkbox" name="email" ${!cur || cur.mode !== 'custom' || cur.email ? 'checked' : ''}> לשלוח גם בדוא"ל</label>
    <p class="muted">אם התזכורות כבויות בהגדרות הכלליות, הן כבויות לכל המשימות.</p>`,
  async (f) => {
    const x = new FormData(f);
    let offsets = [];
    try { if (x.get('mode') === 'custom') offsets = parseOffsets(x.get('offsets')); } catch (e) { toast(e.message, true); return false; }
    return run(() => api.setTaskReminder(taskId, { mode: x.get('mode'), offsets, email: x.get('email') === 'on' }), 'ההגדרה נשמרה');
  });
}

function studentMessagesHtml() {
  const msgs = state.myMessages || [];
  if (!msgs.length) return '';
  return `<section class="card"><h2>🔔 הודעות</h2><ul class="plain smsg">${msgs.slice(0, 6).map((m) => `<li class="${m.active ? '' : 'done'}">${esc(m.text)} <span class="muted">${fmtDay(m.at)}${m.active ? '' : ' · טופל'}</span></li>`).join('')}</ul></section>`;
}

// מסך תלמיד ממוקד: מה נדרש ממני עכשיו, מה ממתין למורה, ומה בהמשך.
function studentFocusHtml(meId) {
  const f = S.studentFocus(state, meId, nowIso());
  const item = (it) => `<button class="focus-item ${it.overdue ? 'late' : ''}" data-action="open-task" data-id="${esc(it.task.id)}">
    <span class="fi-ic">${it.kind === 'pdf' ? '📨' : it.kind === 'fix' ? '↩️' : it.task.requiresSubmission ? '📥' : '📝'}</span>
    <span class="fi-main"><b>${esc(it.task.title)}</b><span class="muted">${it.kind === 'fix' ? 'תיקון נדרש' : it.task.requiresSubmission ? 'הגשת תוצר' : 'אישור ביצוע'}${it.note ? ' · ' + esc(it.note) : ''}</span></span>
    <span class="fi-due">${fmtD(it.due)}</span></button>`;
  return `<section class="card focus"><h2>מה עליי לעשות עכשיו</h2>
    ${f.actions.length ? `<div class="focus-list">${f.actions.map(item).join('')}</div>` : '<p class="muted">אין כרגע פעולות דחופות. 👍</p>'}
    ${f.waiting.length ? `<h3>ממתין למורה</h3><div class="focus-list calm">${f.waiting.map(item).join('')}</div>` : ''}
    ${studentFeedbackSection(meId)}
  </section>`;
}

// ---------- חלונות ----------
// כל חלון קופץ נבנה דרך showDlg: כפתור X קבוע בראש החלון, ואיפוס סימון "שינויים שלא נשמרו".
function showDlg(inner) {
  $dlg.innerHTML = `<button type="button" class="dlg-x" data-action="x-dlg" aria-label="סגירה" title="סגירה">✕</button>${inner}`;
  ui.dirty = false;
  lockArchived($dlg);
  if (!$dlg.open) $dlg.showModal();
}

// סגירה מכל מקור (X, ביטול, סגירה, Esc). אם יש שינויים שלא נשמרו, שואלים לפני ביטולם.
function closeDlg() {
  if (ui.dirty && !window.confirm('יש שינויים שלא נשמרו. לסגור ולבטל אותם?')) return false;
  ui.dirty = false;
  ui.openTask = null;
  $dlg.close();
  return true;
}

function openDialog(html, onSubmit, okLabel = 'שמירה') {
  showDlg(`<form method="dialog" class="form" id="dlgForm">${html}<div class="dlg-actions"><button class="btn primary" value="ok">${esc(okLabel)}</button><button class="btn" value="cancel" formnovalidate id="dlgCancel">ביטול</button></div></form>`);
  const form = $dlg.querySelector('#dlgForm');
  form.addEventListener('submit', async (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    const ok = await onSubmit(form);
    if (ok !== false) { ui.dirty = false; $dlg.close(); }
  });
  $dlg.querySelector('#dlgCancel').addEventListener('click', (e) => { e.preventDefault(); closeDlg(); });
  ui.openTask = null;
  const first = $dlg.querySelector('input, select');
  if (first) first.focus();
}

const fd = (form) => Object.fromEntries(new FormData(form));

function studentDialog(st) {
  openDialog(`
    <h2>${st ? 'עריכת תלמיד' : 'תלמיד חדש'}</h2>
    <label>שם מלא <input type="text" name="name" value="${esc(st ? st.name : '')}" required></label>
    <label>דוא"ל <span class="hint">(חשבון Google של התלמיד)</span><input type="email" name="email" dir="ltr" value="${esc(st ? st.email : '')}"></label>`,
  (f) => run(() => (st ? api.updateStudent(st.id, fd(f)) : api.addStudent(fd(f))), st ? 'התלמיד עודכן' : 'התלמיד נוסף'));
}

function swatchGroup(name, items, current, render) {
  return `<div class="swatches" role="radiogroup">${items.map((it, i) => `<label><input type="radio" name="${name}" value="${esc(it)}" ${it === current || (!current && i === 0) ? 'checked' : ''}><span class="sw" ${render(it)}>${name === 'symbol' ? esc(it) : ''}</span></label>`).join('')}</div>`;
}

function groupDialog(g) {
  openDialog(`
    <h2>${g ? 'עריכת קבוצה' : 'קבוצה חדשה'}</h2>
    <label>שם הקבוצה <input type="text" name="name" value="${esc(g ? g.name : '')}" required></label>
    <div><b>צבע</b>${swatchGroup('color', L.GROUP_COLORS, g && g.color, (c) => `style="background:${c}"`)}</div>
    <div><b>סמל</b>${swatchGroup('symbol', L.GROUP_SYMBOLS, g && g.symbol, () => 'style="background:var(--line);font-size:1rem"')}</div>`,
  (f) => run(() => (g ? api.updateGroup(g.id, fd(f)) : api.addGroup(fd(f))), g ? 'הקבוצה עודכנה' : 'הקבוצה נוספה'));
}

function historyDialog(id) {
  const st = state.students.find((s) => s.id === id);
  const h = L.historyOf(state, id);
  ui.openTask = null;
  showDlg(`<div class="form"><h2>היסטוריית שיוך: ${esc(st.name)}</h2>
    ${h.length ? `<div class="table-wrap"><table><thead><tr><th>קבוצה</th><th>מתאריך</th><th>עד</th></tr></thead><tbody>${h.map((m) => `<tr><td>${esc(m.groupName)}</td><td>${esc(m.from)}</td><td>${m.to ? esc(m.to) : 'כיום'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">לא היה שיוך לקבוצה.</p>'}
    <div class="dlg-actions"><button class="btn" id="hClose">סגירה</button></div></div>`);
  $dlg.querySelector('#hClose').addEventListener('click', () => closeDlg());
}

function confirmDialog(text, okLabel, onOk) {
  ui.openTask = null;
  showDlg(`<div class="form"><h2>${esc(text)}</h2><div class="dlg-actions"><button class="btn primary" id="cOk">${esc(okLabel)}</button><button class="btn" id="cNo">ביטול</button></div></div>`);
  $dlg.querySelector('#cNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#cOk').addEventListener('click', async () => { $dlg.close(); await onOk(); });
}

// הסבר על הסמלים והאזהרות, כולל מה נדרש מהמורה.
function warningsHelpDialog() {
  ui.openTask = null;
  showDlg(`<div class="form wide"><h2>מה משמעות הסמלים?</h2>
    <p class="muted">הסמלים תמיד מלווים בטקסט. אפשר גם להעביר עכבר מעל סמל כדי לקרוא את ההסבר.</p>
    <div class="table-wrap"><table><thead><tr><th>סמל</th><th>סוג</th><th>משמעות ומה נדרש ממך</th></tr></thead><tbody>
      ${Object.values(T.WARNING_KINDS).map((w) => `<tr><td>${w.icon}</td><td><b>${esc(w.label)}</b></td><td style="white-space:normal">${esc(w.help)}</td></tr>`).join('')}
      <tr><td>✔</td><td><b>הושלם ואושר</b></td><td style="white-space:normal">המורה אישר שהמשימה הושלמה. אין פעולה נדרשת. אפשר לפתוח מחדש.</td></tr>
      <tr><td>▭ קו תחתון כתום</td><td><b>ארכה נקודתית</b></td><td style="white-space:normal">לקבוצה או לתלמיד יש מועד הגשה שונה משאר הכיתה.</td></tr>
      <tr><td>פס מקווקו</td><td><b>ממתין לאישור</b></td><td style="white-space:normal">הפס מסומן בקו מקווקו כשיש בקשת השלמה פתוחה.</td></tr>
    </tbody></table></div>
    <div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
}

// ----- משימות: טפסים -----
const checks = (name, items, selected) => `<div class="checks">${items.map((i) => `<label><input type="checkbox" name="${name}" value="${esc(i.id)}" ${selected.includes(i.id) ? 'checked' : ''}> ${esc(i.label)}</label>`).join('') || '<span class="muted">אין</span>'}</div>`;

// חומרי עזר: שורות כותרת + כתובת. קישור חיצוני נפתח בלשונית חדשה עם noopener.
const linkRow = (l = {}) => `<div class="link-row"><input type="text" name="linkTitle" placeholder="כותרת, למשל: דף הנחיות" value="${esc(l.title || '')}" aria-label="כותרת הקישור"><input type="text" name="linkUrl" dir="ltr" placeholder="https://..." value="${esc(l.url || '')}" aria-label="כתובת הקישור"><button type="button" class="btn small danger" data-action="rm-link">הסרה</button></div>`;
const linksEditorHtml = (links = []) => `<div class="links-editor"><b>חומרי עזר והנחיות</b> <span class="hint muted">(קישור למסמך Google, PDF או אתר)</span>
  <div class="link-rows">${(links || []).map(linkRow).join('')}</div>
  <button type="button" class="btn small" data-action="add-link">+ הוספת קישור</button>
  <p class="muted link-warn">שים לב: קישור אינו מעניק הרשאת צפייה. יש לשתף את המסמך עצמו (ב-Google Drive) עם התלמידים המתאימים.</p></div>`;
const readLinks = (form) => { const f = new FormData(form); const ts = f.getAll('linkTitle'); const us = f.getAll('linkUrl'); return us.map((u, i) => ({ title: ts[i], url: u })); };
// קישורי דמה (דומיינים שמורים לדוגמה) אינם נפתחים: מוצגת הודעה בעברית במקום שגיאת דפדפן באנגלית.
const isDemoLink = (url) => /(^|\.)(example\.(com|org|net)|example|invalid|test)$/i.test(new URL(url).hostname);
const linkAnchor = (l) => (isDemoLink(l.url)
  ? `<a href="#" data-action="demo-link">${esc(l.title)}</a> <span class="pill" title="קישור לדוגמה בלבד, אינו נפתח">קישור דמה, לא נפתח</span>`
  : `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a> <span class="muted" dir="ltr">${esc(new URL(l.url).hostname)}</span>`);
const linksViewHtml = (links) => ((links || []).length ? `<div class="links-view"><h3>חומרי עזר והנחיות</h3><ul class="plain">${links.map((l) => `<li>${linkAnchor(l)}</li>`).join('')}</ul><p class="muted">אם המסמך לא נפתח, ייתכן שהמורה עדיין לא שיתף אותו איתך. פנה למורה.</p></div>` : '');

function taskFormHtml(t) {
  const others = T.orderedTasks(state).filter((x) => !t || x.id !== t.id).map((x) => ({ id: x.id, label: x.title }));
  const kind = t ? t.kind : 'group';
  const asg = kind === 'group' ? state.groups.map((g) => ({ id: g.id, label: g.name })) : state.students.filter((s) => s.active).map((s) => ({ id: s.id, label: s.name }));
  const today = T.D.today();
  return `
    <label>שם המשימה <input type="text" name="title" value="${esc(t ? t.title : '')}" required></label>
    <label>תיאור <input type="text" name="description" value="${esc(t ? t.description : '')}"></label>
    <div class="row2">
      <label>סוג <select name="kind" id="tkKind"><option value="group" ${kind === 'group' ? 'selected' : ''}>קבוצתית</option><option value="personal" ${kind === 'personal' ? 'selected' : ''}>אישית</option></select></label>
      <label>משקל (%) <input type="number" name="weight" min="0" max="100" step="1" value="${t ? t.weight : 0}"></label>
    </div>
    <label>סוג המשימה <select name="requiresSubmission"><option value="0" ${t && t.requiresSubmission ? '' : 'selected'}>אישור ביצוע (המורה מאשר שהושלמה)</option><option value="1" ${t && t.requiresSubmission ? 'selected' : ''}>הגשת תוצר (התלמיד מעלה קובץ)</option></select></label>
    <div class="row2">
      <label>התחלה <input type="date" name="start" value="${esc(t ? t.start : today)}" required></label>
      <label>מועד הגשה <input type="date" name="due" value="${esc(t ? t.due : T.D.add(today, 14))}" required></label>
    </div>
    <div><b>תלויה במשימות</b> <span class="hint muted">(צריכות להסתיים לפני שהמשימה מתחילה)</span>${checks('dep', others, t ? t.dependsOn : [])}</div>
    <div><b>למי המשימה</b> <span class="hint muted">(ללא סימון: לכל ${kind === 'group' ? 'הקבוצות' : 'התלמידים'}. שינוי הסוג מתעדכן אחרי שמירה)</span>${checks('asg', asg, t ? t.assignees : [])}</div>
    ${linksEditorHtml(t ? t.links : [])}`;
}

function readTaskForm(form) {
  const f = new FormData(form);
  return { title: f.get('title'), description: f.get('description') || '', kind: f.get('kind'), weight: Number(f.get('weight') || 0), start: f.get('start'), due: f.get('due'), dependsOn: f.getAll('dep'), assignees: f.getAll('asg'), links: readLinks(form), requiresSubmission: f.get('requiresSubmission') === '1' };
}

// אחרי יצירה או שמירה: הודעת הצלחה ברורה עם קיצורי דרך, כדי שלא יהיה נדמה שהאירוע אבד.
function announceTask(t, verb) {
  const goCal = () => { ui.calAnchor = ui.calView === 'week' ? t.start : `${t.due.slice(0, 7)}-01`; ui.gFilter = 'class'; location.hash = '#/calendar'; render(); };
  const goGantt = () => { ui.scrolled = true; ui.gFilter = 'class'; location.hash = '#/gantt'; render(); setTimeout(() => scrollToDate($app, t.start), 30); };
  toast(`${verb}: "${t.title}" (${fmtD(t.start)} עד ${fmtD(t.due)})`, false, [{ label: 'הצג בלוח השנה', fn: goCal }, { label: 'עבור לתאריך בגאנט', fn: goGantt }]);
}

async function addTaskAndAnnounce(fn, verb) {
  const before = new Set(state.tasks.map((t) => t.id));
  const ok = await run(fn);
  if (!ok) return false;
  const t = state.tasks.find((x) => !before.has(x.id));
  if (t) announceTask(t, verb);
  return true;
}

function newTaskDialog() {
  openDialog(`<h2>משימה חדשה</h2>${taskFormHtml(null)}`, (f) => addTaskAndAnnounce(() => api.addTask(readTaskForm(f)), 'המשימה נוספה'));
}

// הוספת משימה בודדת מהבנק למחזור. בלי להחליף את תוכנית העבודה.
// אם כבר קיימים עותקים של הפריט במחזור, מציגים אותם במפורש כדי שלא ייווצר עותק כפול בטעות.
function bankCopiesNote(it) {
  const st = T.bankStatus(state, it.id);
  if (st.state === 'none') return '';
  const li = (t, label) => `<li>${label}: "${esc(t.title)}", ${fmtD(t.start)} עד ${fmtD(t.due)}</li>`;
  return `<div class="alert"><b>⚠ הפריט כבר קיים במחזור הזה.</b> שמירה כאן תיצור <b>עותק חדש נוסף</b>, לא תפעיל מחדש עותק קיים.
    <ul class="plain">${st.active.map((t) => li(t, 'פעיל')).join('')}${st.inactive.map((t) => li(t, 'לא פעיל')).join('')}</ul>
    ${st.inactive.length ? 'כדי להחזיר עותק לא פעיל, סגור חלון זה ובחר "הפעל מחדש".' : ''}</div>`;
}

function bankAddDialog(preId) {
  const items = T.orderedTemplate(state);
  if (!items.length) { toast('הבנק ריק. אפשר להוסיף פריטים במסך "בנק משימות ותבנית"', true); return; }
  const pick = items.find((x) => x.id === preId) || items[0];
  const defStart = (it) => (state.cycle && state.cycle.start ? T.D.add(state.cycle.start, it.startOffset) : T.D.today());
  openDialog(`<h2>הוספת משימה מהבנק</h2>
    <label>משימה <select name="tpl" id="bankSel">${items.map((x) => `<option value="${esc(x.id)}" ${x.id === pick.id ? 'selected' : ''} data-start="${esc(defStart(x))}" data-dur="${x.duration}">${esc(x.title)} (${kindName(x.kind)}, ${x.duration} ימים)</option>`).join('')}</select></label>
    <label>תאריך התחלה <input type="date" name="start" id="bankStart" value="${esc(defStart(pick))}" required></label>
    <div id="bankCopies">${bankCopiesNote(pick)}</div>
    <p class="muted">המשימה תתווסף למחזור כעותק עצמאי, בלי תלויות, ובלי לשנות את שאר המשימות. עריכה עתידית של הפריט בבנק לא תשנה את העותק הזה.</p>`,
  (f) => addTaskAndAnnounce(() => api.addTaskFromBank(fd(f).tpl, { start: fd(f).start }), 'המשימה נוספה מהבנק'));
}

// חלון פרטי משימה: למורה עריכה מלאה, התקדמות והשלמה וארכות. לתלמיד: צפייה ועדכון התקדמות של עצמו בלבד.
function taskDialog(id) {
  const t = taskById(id);
  if (!t) return;
  ui.openTask = id;
  const isTeacher = session && session.role === 'teacher';
  const sum = T.completionSummary(state, t);
  const unitRows = (isTeacher ? sum.units : sum.units.filter((u) => { const mine = T.unitForStudent(state, t, session.userId); return u.type === mine.type && u.id === mine.id; })).map((u) => `
    <tr><td>${esc(u.name)}</td>
      <td><input type="number" min="0" max="100" step="1" value="${u.percent}" data-prog="${esc(u.id)}" data-utype="${u.type}" aria-label="אחוז התקדמות של ${esc(u.name)}" ${u.completion === 'approved' && !isTeacher ? 'disabled' : ''} style="width:5em">%</td>
      <td><span class="st ${u.completion}">${compl[u.completion]}</span></td>
      <td>${isTeacher
        ? (u.completion === 'approved' ? `<button type="button" class="btn small" data-action="review" data-d="reopen" data-utype="${u.type}" data-unit="${esc(u.id)}" data-task="${esc(t.id)}">פתח מחדש</button>`
          : `<button type="button" class="btn small primary" data-action="review" data-d="approve" data-utype="${u.type}" data-unit="${esc(u.id)}" data-task="${esc(t.id)}">אשר השלמה</button>${u.completion === 'claimed' ? `<button type="button" class="btn small" data-action="review" data-d="reject" data-utype="${u.type}" data-unit="${esc(u.id)}" data-task="${esc(t.id)}">החזר לתיקון</button>` : ''}`)
        : (u.completion === 'approved' || t.requiresSubmission ? (t.requiresSubmission && u.completion !== 'approved' ? '<span class="muted">נשלחת בהגשה</span>' : '') : `<button type="button" class="btn small ${u.completion === 'none' ? 'primary' : ''}" data-action="claim" data-claim="${u.completion === 'none' ? '1' : '0'}" data-utype="${u.type}" data-unit="${esc(u.id)}" data-task="${esc(t.id)}">${u.completion === 'none' ? 'סיימתי, בקשה לאישור המורה' : 'בטל בקשה'}</button>`)}</td></tr>`).join('');
  const progressHtml = `<h3>התקדמות והשלמה ${helpIcon('progress-vs-completion')}</h3>
    <p class="muted">${isTeacher ? 'אחוז ההתקדמות הוא דיווח של התלמיד או הקבוצה. השלמה נחשבת רק אחרי שאישרת אותה.' : `${PROGRESS_EXPLAIN} השלמה נחשבת רק אחרי שהמורה אישר אותה.`}</p>
    <div class="table-wrap"><table><thead><tr><th>${t.kind === 'group' ? 'קבוצה' : 'תלמיד'}</th><th>התקדמות</th><th>סטטוס</th><th></th></tr></thead><tbody>${unitRows || '<tr><td colspan="4" class="muted">אין יחידות</td></tr>'}</tbody></table></div>`;
  if (!isTeacher) {
    const eff = T.effectiveDates(state, t, { studentId: session.userId });
    showDlg(`<div class="form wide"><h2>${esc(t.title)}</h2><p class="muted">${kindName(t.kind)} · ${fmtD(eff.start)} עד ${fmtD(eff.due)}${eff.exception ? ' (ארכה)' : ''} · משקל ${t.weight}%</p>
      ${taskTypeBanner(t)}${t.description ? `<p>${esc(t.description)}</p>` : ''}${linksViewHtml(t.links)}${t.requiresSubmission ? submissionPanelHtml(t, false) + progressHtml : progressHtml}<div class="dlg-actions"><button class="btn" data-action="close-dlg">סגירה</button></div></div>`);
    return;
  }
  const units = sum.units.map((u) => ({ id: u.id, type: u.type, name: u.name }));
  const exc = state.exceptions.filter((e) => e.taskId === t.id).map((e) => {
    const nm = (e.unitType === 'group' ? (state.groups.find((g) => g.id === e.unitId) || {}).name : (state.students.find((s) => s.id === e.unitId) || {}).name) || '';
    return `<tr><td>${esc(nm)}</td><td>${fmtD(e.start)} עד ${fmtD(e.due)}</td><td><button type="button" class="btn small danger" data-action="rm-exc" data-id="${esc(e.id)}">הסרה</button></td></tr>`;
  }).join('');
  const warns = T.isActive(t) ? T.taskWarnings(state, t) : [];
  showDlg(`<form class="form wide" id="taskForm"><h2>${esc(t.title)}</h2>
    ${T.isActive(t) ? '' : '<div class="alert archived-note"><b>💤 משימה לא פעילה.</b> היא אינה בגאנט, בלוח השנה או אצל התלמידים, ואינה נספרת בהתקדמות. כל הפרטים וההתקדמות נשמרים. אינה משימה שהושלמה.</div>'}
    ${warns.map((w) => `<div class="alert w-${w.type}"><b>${w.icon} ${esc(w.label)}</b> ${esc(w.text)}<br><span class="muted">מה לעשות: ${esc(w.help.split('הפעולה הנדרשת: ')[1] || '')}</span></div>`).join('')}
    ${taskFormHtml(t)}
    <div class="dlg-actions"><button type="button" class="btn primary" data-action="save-task" data-id="${esc(t.id)}">שמירת שינויים</button>${T.isActive(t) ? `<button type="button" class="btn" data-action="deactivate" data-id="${esc(t.id)}">הפוך ללא פעילה</button>` : `<button type="button" class="btn primary" data-action="reactivate" data-id="${esc(t.id)}">הפעל מחדש</button>`}<button type="button" class="btn danger" data-action="del-task" data-id="${esc(t.id)}">מחיקה לצמיתות</button><button type="button" class="btn" data-action="close-dlg">ביטול וסגירה</button></div>
    <hr>${progressHtml}
    ${submissionPanelHtml(t, true)}
    <hr><h3>ארכה נקודתית</h3><p class="muted">משנה את מועד ההגשה ליחידה אחת בלבד.</p>
    ${exc ? `<div class="table-wrap"><table><tbody>${exc}</tbody></table></div>` : ''}
    <div class="toolbar"><select id="excUnit" aria-label="יחידה">${units.map((u) => `<option value="${u.type}:${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>
      <input type="date" id="excDue" value="${esc(T.D.add(t.due, 7))}" aria-label="מועד חדש"><button type="button" class="btn small" data-action="add-exc" data-id="${esc(t.id)}">הוספת ארכה</button></div>
  </form>`);
}

// ----- שינוי מועד והשלכות -----
function requestDateChange(id, start, due, revert) {
  const t = taskById(id);
  const imp = T.impactOfChange(state, id, { start, due });
  const deps = T.dependents(state, id);
  const needs = imp.violations.length || imp.vacations.length || imp.exceptions.length || (deps.length && imp.deltaDue !== 0);
  const apply = (opts) => run(() => api.setTaskDates(id, { start, due }, opts), 'התאריכים עודכנו');
  if (!needs) { apply({}); return; }
  ui.openTask = null;
  ui.revertOnClose = revert || null; // כל סגירה בלי אישור (X, ביטול, Esc) מחזירה את הפס למקומו
  showDlg(`<form class="form wide" id="impactForm"><h2>אישור שינוי מועד: ${esc(t.title)}</h2>
    <p>מ-<b>${fmtD(t.start)} עד ${fmtD(t.due)}</b> ל-<b>${fmtD(start)} עד ${fmtD(due)}</b></p>
    ${imp.violations.length ? `<div class="alert"><b>תלויות שיישברו:</b><ul class="plain">${imp.violations.map((v) => `<li>${esc(v.title)} מתחילה לפני שהסתיימה "${esc(v.predecessorTitle)}"</li>`).join('')}</ul></div>` : ''}
    ${imp.vacations.length ? `<div class="alert"><b>חפיפה עם חופשה:</b> ${imp.vacations.map((v) => esc(v.title)).join(', ')}. לא תבוצע הזזה אוטומטית.</div>` : ''}
    ${imp.exceptions.length ? `<div><b>ארכות קיימות</b> <span class="muted">(ברירת מחדל: יוזזו יחד עם השינוי. סמן כדי להשאיר אותן ללא שינוי)</span>${checks('keep', imp.exceptions.map((e) => ({ id: e.id, label: `${(e.unitType === 'group' ? (state.groups.find((g) => g.id === e.unitId) || {}).name : (state.students.find((s) => s.id === e.unitId) || {}).name) || ''}: עד ${fmtD(e.due)}` })), [])}</div>` : ''}
    ${deps.length && imp.deltaDue !== 0 ? `<label class="chk"><input type="checkbox" name="movedeps"> הזז גם את ${deps.length} המשימות התלויות באותו מספר ימים (${imp.deltaDue > 0 ? '+' : ''}${imp.deltaDue})</label>` : ''}
    <div class="dlg-actions"><button class="btn primary" value="ok" id="impOk">אישור השינוי</button><button class="btn" type="button" id="impNo">ביטול</button></div></form>`);
  const form = $dlg.querySelector('#impactForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    ui.revertOnClose = null;
    $dlg.close();
    ui.openTask = null;
    await apply({ keepExceptionIds: f.getAll('keep'), moveDependents: f.get('movedeps') === 'on' });
  });
  $dlg.querySelector('#impNo').addEventListener('click', () => closeDlg());
}

// הפיכת משימה ללא פעילה: אזהרה ברורה על משימות פעילות שתלויות בה. שום משימה אחרת לא משתנה בשקט.
function deactivateDialog(id) {
  const t = taskById(id);
  const deps = T.activeDirectDependents(state, id);
  const sum = T.completionSummary(state, t);
  ui.openTask = null;
  showDlg(`<div class="form"><h2>להפוך ללא פעילה: ${esc(t.title)}?</h2>
    <p>המשימה תיעלם מהגאנט, מלוח השנה, מרשימת המשימות הפעילות ומהתלמידים, ותישמר ברשימת "משימות לא פעילות" של המחזור הזה. אפשר להפעיל אותה מחדש בכל עת, עם כל הפרטים, הקישורים, הארכות וההתקדמות. <b>משימה לא פעילה אינה משימה שהושלמה.</b></p>
    ${deps.length ? `<div class="alert"><b>⚠ ${deps.length} משימות פעילות תלויות במשימה הזו:</b>
      <ul class="plain">${deps.map((d) => `<li>${esc(d.title)}</li>`).join('')}</ul>
      המשימות האלה לא ישונו. כל עוד המשימה לא פעילה, התלות בה לא תיבדק ולא תוצג בגאנט, והיא תחזור לפעול כשתפעיל אותה מחדש.</div>` : ''}
    ${sum.claimed ? `<div class="alert">יש ${sum.claimed} בקשות השלמה ממתינות. הן יישמרו, ולא יוצגו כל עוד המשימה לא פעילה.</div>` : ''}
    <div class="dlg-actions"><button class="btn primary" id="deaOk">הפוך ללא פעילה</button><button class="btn" id="deaNo">ביטול</button></div></div>`);
  $dlg.querySelector('#deaNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#deaOk').addEventListener('click', async () => { $dlg.close(); await run(() => api.setTaskActive(id, false), `"${t.title}" הועברה למשימות לא פעילות. אפשר להפעיל אותה מחדש בלשונית "משימות לא פעילות"`); });
}

async function reactivate(id) {
  const t = taskById(id);
  ui.dirty = false;
  if ($dlg.open) $dlg.close();
  const ok = await run(() => api.setTaskActive(id, true));
  if (ok) toast(`"${t.title}" הופעלה מחדש עם כל פרטיה (${fmtD(t.start)} עד ${fmtD(t.due)})`, false, [{ label: 'הצג בגאנט', fn: () => { ui.gFilter = 'class'; ui.scrolled = true; location.hash = '#/gantt'; render(); setTimeout(() => scrollToDate($app, t.start), 30); } }]);
}

// מחיקה מהבנק המשותף בלבד. עותקים שכבר נוספו למחזורים לא ישתנו ולא יימחקו.
function bankDeleteDialog(id) {
  const it = state.taskTemplate.find((x) => x.id === id);
  const use = (state.bankUsage && state.bankUsage[id]) || [];
  ui.openTask = null;
  showDlg(`<div class="form"><h2>למחוק את "${esc(it.title)}" מבנק המשימות?</h2>
    <p>הפעולה מוחקת את הפריט <b>מהבנק המשותף בלבד</b>, ולא תהיה אפשרות להוסיף ממנו משימות חדשות.</p>
    <p><b>עותקים שכבר נוספו למחזורים לא ישתנו ולא יימחקו</b>, פעילים או לא פעילים.${use.length ? '' : ' כרגע אין עותקים כאלה.'}</p>
    ${use.length ? `<ul class="plain">${use.map((u) => `<li>${esc(u.cycleName)}: ${u.active} פעילים, ${u.inactive} לא פעילים</li>`).join('')}</ul>` : ''}
    <p class="muted">אם רק רצית להוציא משימה מתוכנית העבודה של מחזור, השתמש ב"הפוך ללא פעילה" במסך המשימות.</p>
    <div class="dlg-actions"><button class="btn danger" id="bdOk">מחיקה מהבנק</button><button class="btn" id="bdNo">ביטול</button></div></div>`);
  $dlg.querySelector('#bdNo').addEventListener('click', () => closeDlg());
  $dlg.querySelector('#bdOk').addEventListener('click', async () => { $dlg.close(); await run(() => api.deleteTemplateItem(id), 'הפריט נמחק מהבנק. עותקים במחזורים לא שונו'); });
}

// בשרת אמיתי ההמרה ל-PDF היא בקשה נפרדת אחרי שההגשה כבר נשמרה. כשל כאן אינו מבטל את ההגשה (הסטטוס "נכשלה" ואפשר לנסות שוב או לצרף PDF).
async function convertInBackground(subId) {
  try { state = await api.runConversion(subId); } catch (e) { /* ההגשה נשמרה; ההמרה תנוסה שוב לפי בקשה */ }
  render();
  if (ui.openTask) taskDialog(ui.openTask);
}
// מקור המסמך לתצוגה: קובץ הדמו, או ה-PDF האמיתי שהורד מהשרת (עם בדיקת שלמות)
// הגשות דמה שנזרעו בלי קובץ אמיתי (אין fileKey) נפתחות במסמך הדמו; הגשה עם קובץ אמיתי תמיד נקראת מהשרת, וכשל נראה כשגיאה.
// host: אזור התצוגה, שבו מוצגת התקדמות ההורדה (מסמכים גדולים יכולים להיטען דקה-שתיים)
async function docSource(sub, host) {
  if (!(remoteMode && sub.fileKey)) return `docs/${R.demoDocFor(sub)}.pdf`;
  const el = document.createElement('p'); el.className = 'muted'; el.style.padding = '12px';
  const note = (t) => { el.textContent = t; };
  note('טוען את המסמך...');
  if (host) host.prepend(el);
  try {
    return await downloadFile(api, sub.id, 'pdf', { onProgress: (p) => note(`טוען את המסמך... ${p.done} מתוך ${p.total}. למסמכים גדולים זה יכול לקחת גם דקה-שתיים, המתינו בסבלנות.`) });
  } finally { el.remove(); }
}

// הגשת קובץ על ידי תלמיד. כשל בשמירה/קובץ לא תקין: הודעה ברורה ושום דבר לא נרשם.
async function doSubmit(el) {
  const inp = document.getElementById('subFile');
  const msg = document.getElementById('subMsg');
  if (remoteMode && api.setStatusListener) {
    // כמה תלמידים מגישים יחד: ההגשה ממתינה בתור. הקובץ כבר נשמר, וההצלחה תוצג רק אחרי שההגשה נרשמה בפועל.
    api.setStatusListener((ev) => { if (!msg) return; if (ev.phase === 'queued') { msg.className = 'submsg info'; } if (ev.phase === 'queued') msg.textContent = `הקובץ הועלה, וההגשה ממתינה בתור (${Math.round(ev.waitedMs / 1000)} שניות). עוד מעט תירשם. אל תסגרו את הדף.`; });
  }
  const file = inp && inp.files[0];
  const fail = (m) => { if (msg) { msg.className = 'submsg'; msg.textContent = '⚠ ' + m; } toast(m, true); };
  if (!file) { fail('בחר קובץ להגשה.'); return; }
  try {
    if (remoteMode) {
      // שרת אמיתי: העלאה במקטעים. ההגשה נרשמת רק אחרי שכל הקובץ נשמר ונבדק; ניתוק באמצע אינו יוצר הגשה, והניסיון הבא ממשיך מאותה נקודה.
      const target = { kind: 'source', taskId: el.dataset.task, unitType: el.dataset.utype, unitId: el.dataset.unit };
      state = (await uploadFile(api, target, file, { onProgress: (p) => { if (msg) { msg.className = 'submsg info'; msg.textContent = `מעלה את הקובץ... ${p.done} מתוך ${p.total}`; } } })).state;
    } else state = await api.submitFile(el.dataset.task, el.dataset.utype, el.dataset.unit, { fileName: file.name, size: file.size });
  } catch (e) { fail(e.retryable ? 'ההעלאה נקטעה, ולא נרשמה הגשה. אפשר ללחוץ שוב על אותו קובץ וההעלאה תמשיך מאותה נקודה.' : (e.message || 'ההגשה נכשלה')); return; } finally { if (api.setStatusListener) api.setStatusListener(null); }
  const x = S.latestOf(state, el.dataset.task, el.dataset.utype, el.dataset.unit);
  render();
  if (ui.openTask) taskDialog(ui.openTask);
  if (remoteMode) convertInBackground(x.id);
  toast(x.isCorrection ? `התיקון הוגש ב-${fmtDT(x.uploadedAt)}${x.late ? ' (אחרי מועד התיקון)' : ''}. זו אינה בקשה לבדיקה נוספת. המורה יפתח את הגרסה לבדיקה אם ירצה.` : `ההגשה נקלטה ב-${fmtDT(x.uploadedAt)}${x.late ? ' וסומנה כאיחור' : ''}. ההמרה ל-PDF מתבצעת. גם אם תיכשל, ההגשה והמועד נשמרים.`);
}

async function doAttachPdf(el) {
  const inp = document.getElementById('pdfFile');
  const file = inp && inp.files[0];
  if (!file) { toast('בחר קובץ PDF.', true); return; }
  try {
    state = remoteMode
      ? (await uploadFile(api, { kind: 'pdf', subId: el.dataset.id }, file, { onProgress: (p) => toast(`מעלה PDF... ${p.done} מתוך ${p.total}`) })).state
      : await api.attachPdf(el.dataset.id, { fileName: file.name, size: file.size });
  } catch (e) { toast(e.retryable ? 'ההעלאה נקטעה. אפשר לנסות שוב והיא תמשיך מאותה נקודה.' : e.message, true); return; }
  render();
  if (ui.openTask) taskDialog(ui.openTask);
  toast('ה-PDF צורף להגשה. מועד ההגשה המקורי לא השתנה.');
}

function shiftDialog() {
  const list = T.orderedTasks(state);
  openDialog(`<h2>שינוי מועד כיתתי</h2>
    <p class="muted">מזיז משימה אחת לכל הכיתה (התחלה ומועד הגשה). לפני השמירה יוצגו ההשלכות.</p>
    <label>משימה <select name="task">${list.map((t) => `<option value="${esc(t.id)}">${esc(t.title)} (${fmtD(t.due)})</option>`).join('')}</select></label>
    <label>הזזה בימים <span class="hint">(מספר חיובי דוחה, שלילי מקדים)</span><input type="number" name="days" value="7" step="1" required></label>`,
  (f) => {
    const d = fd(f);
    const t = taskById(d.task);
    const days = Number(d.days);
    if (!t || !Number.isInteger(days) || days === 0) { toast('הזן מספר ימים שלם שאינו אפס', true); return false; }
    setTimeout(() => requestDateChange(t.id, T.D.add(t.start, days), T.D.add(t.due, days), null), 50);
    return true;
  });
}

function vacationDialog() {
  openDialog(`<h2>חופשה או אילוץ</h2>
    <label>שם <input type="text" name="title" required placeholder="למשל: חופשת פסח"></label>
    <div class="row2"><label>מתאריך <input type="date" name="start" required></label><label>עד תאריך <input type="date" name="end" required></label></div>`,
  (f) => run(() => api.addVacation(fd(f)), 'החופשה נוספה'));
}

function adminEventDialog(id) {
  const e = AE.adminEventsOf(state).find((x) => x.id === id);
  if (!e) return;
  openDialog(`<h2>📌 תזכורת מנהלתית</h2>
    <p class="muted adm-note">למורה בלבד. אינה משימה, לא נראית לתלמידים ואינה משפיעה על ציונים.</p>
    <label>כותרת <input type="text" name="title" value="${esc(e.title)}" required></label>
    <div class="row2"><label>תחילת חלון <input type="date" name="start" value="${esc(e.start)}" required></label><label>סוף חלון <input type="date" name="end" value="${esc(e.end)}" required></label></div>
    <label>הערה <input type="text" name="note" value="${esc(e.note || '')}"></label>
    <label class="chk"><input type="checkbox" name="done" ${e.done ? 'checked' : ''}> בוצע</label>
    <button type="button" class="btn small danger" data-action="adm-del" data-id="${esc(e.id)}">מחיקת התזכורת</button>`,
  (f) => { const x = new FormData(f); return run(() => api.updateAdminEvent(id, { title: x.get('title'), start: x.get('start'), end: x.get('end'), note: x.get('note'), done: x.get('done') === 'on' }), 'התזכורת עודכנה'); });
}

function templateDialog(it) {
  const others = T.orderedTemplate(state).filter((x) => !it || x.id !== it.id).map((x) => ({ id: x.id, label: x.title }));
  openDialog(`<h2>${it ? 'עריכת פריט בתבנית' : 'פריט חדש בתבנית'}</h2>
    <label>שם המשימה <input type="text" name="title" value="${esc(it ? it.title : '')}" required></label>
    <div class="row2"><label>סוג <select name="kind"><option value="group" ${!it || it.kind === 'group' ? 'selected' : ''}>קבוצתית</option><option value="personal" ${it && it.kind === 'personal' ? 'selected' : ''}>אישית</option></select></label>
    <label>משקל (%) <input type="number" name="weight" min="0" max="100" value="${it ? it.weight : 0}"></label></div>
    <label>סוג המשימה <select name="requiresSubmission"><option value="0" ${it && it.requiresSubmission ? '' : 'selected'}>אישור ביצוע</option><option value="1" ${it && it.requiresSubmission ? 'selected' : ''}>הגשת תוצר</option></select></label>
    <div class="row2"><label>התחלה (ימים מתחילת המחזור) <input type="number" name="startOffset" min="0" step="1" value="${it ? it.startOffset : 0}" required></label>
    <label>משך (ימים) <input type="number" name="duration" min="1" step="1" value="${it ? it.duration : 14}" required></label></div>
    <div><b>תלויה בפריטים</b>${checks('dep', others, it ? it.dependsOn : [])}</div>
    ${linksEditorHtml(it ? it.links : [])}`,
  (f) => {
    const x = new FormData(f);
    const data = { title: x.get('title'), kind: x.get('kind'), weight: Number(x.get('weight') || 0), startOffset: Number(x.get('startOffset')), duration: Number(x.get('duration')), dependsOn: x.getAll('dep'), links: readLinks(f), requiresSubmission: x.get('requiresSubmission') === '1' };
    return run(() => (it ? api.updateTemplateItem(it.id, data) : api.addTemplateItem(data)), it ? 'הפריט עודכן' : 'הפריט נוסף');
  });
}

function applyTemplateDialog() {
  const has = state.tasks.length > 0;
  openDialog(`<h2>החלת תבנית משימות</h2>
    <p class="muted">יווצרו ${state.taskTemplate.length} משימות לפי התבנית, מתחילת המחזור (${fmtD(state.cycle && state.cycle.start) || 'לא הוגדר'}). אפשר לערוך אותן אחר כך.</p>
    <label class="chk"><input type="radio" name="mode" value="append" ${has ? 'checked' : ''}> הוסף למשימות הקיימות</label>
    <label class="chk"><input type="radio" name="mode" value="replace" ${has ? '' : 'checked'}> החלף את כל המשימות הקיימות ${has ? `(יימחקו ${state.tasks.length} משימות, כולל התקדמות וארכות)` : ''}</label>`,
  (f) => run(() => api.applyTemplate({ mode: fd(f).mode }), 'התבנית הוחלה'));
}

// ---------- אירועים ----------
document.addEventListener('click', async (ev) => {
  // תפריטי "עוד": נסגרים בלחיצה מחוץ להם או על פעולה בתוכם
  document.querySelectorAll('details.more[open]').forEach((d) => { if (!d.contains(ev.target) || ev.target.closest('.menu button')) d.removeAttribute('open'); });
  // קיצורי דרך עם סינון מוגדר מראש (למשל מדד במסך הבית): data-ui="key=value"
  const uiLink = ev.target.closest('[data-ui]');
  if (uiLink) {
    const [k, v] = uiLink.dataset.ui.split('=');
    ui[k] = v;
    if (k === 'taskFilter') ui.taskTab = 'active';
    if (uiLink.getAttribute('href') === location.hash) render();
  }
  const link = ev.target.closest('[data-open-task]');
  if (link) { setTimeout(() => taskDialog(link.dataset.openTask), 80); }
  const rvItem = ev.target.closest('.rv-item');
  if (rvItem && ui.viewer && !ev.target.closest('button, select, textarea, input')) { ui.rvActive = rvItem.dataset.id; if (!ui.rvEdit) rvOpenOnly(rvItem.dataset.id); ui.viewer.activate(rvItem.dataset.id, true); rerenderRvList(); }
  const admEl = ev.target.closest('[data-admin]');
  if (admEl && session && session.role === 'teacher') { adminEventDialog(admEl.dataset.admin); return; }
  const chip = ev.target.closest('.cal-chip');
  if (chip) { taskDialog(chip.dataset.task); return; }
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  const keepOpen = async (fn, msg) => { const ok = await run(fn, msg); if (ok && ui.openTask) taskDialog(ui.openTask); };
  switch (el.dataset.action) {
    case 'login-teacher': session = { role: 'teacher', userId: 'teacher' }; api.setSession(session); state = await api.getState(); ensureQueue(); resetCycleView(); location.hash = '#/home'; render(); break;
    case 'login-student': { const [cid, sid] = document.getElementById('loginStudent').value.split('|'); session = { role: 'student', userId: sid, cycleId: cid }; api.setSession(session); state = await api.getState(); render(); break; }
    case 'logout':
      if (remoteMode) { wq = null; await api.logout(); session = null; state = null; location.hash = ''; ui.scrolled = false; render(); break; }
      session = null; api.setSession(null); state = await api.getState(); location.hash = ''; ui.scrolled = false; render(); break;
    case 'remote-test-login': await finishRemoteLogin(document.getElementById('testCred').value.trim()); break;
    case 'new-cycle': newCycleDialog(); break;
    case 'toggle-archive': {
      const c = state.cycles.find((x) => x.id === id);
      if (c.archived) await run(() => api.setArchived(id, false), 'המחזור הוחזר לפעיל');
      else confirmDialog(`להעביר את "${c.name}" לארכיון? הוא יהפוך לקריאה בלבד, תלמידיו לא יוכלו להיכנס אליו, ואפשר להחזיר אותו בכל עת. לפני כן נשמר גיבוי אוטומטי. אין מחיקה אוטומטית מהארכיון.`, 'העברה לארכיון', () => run(() => api.setArchived(id, true), 'המחזור הועבר לארכיון'));
      break;
    }
    case 'student-cycle': { try { state = await api.switchStudentCycle(el.dataset.cycle); session = api.getSession(); render(); } catch (e) { toast(e.message, true); } break; }
    case 'reset-demo': confirmDialog('לאפס את כל נתוני הדמה למצב ההתחלתי?', 'איפוס', () => run(() => api.resetDemo(), 'הנתונים אופסו')); break;
    case 'close-dlg': case 'x-dlg': closeDlg(); break;
    case 'note-new': if (ui.fabDragged) break; noteDialog(null); break;
    case 'note-edit': noteDialog(vs().notesBook.items.find((n) => n.id === id)); break;
    case 'note-status': ensureQueue(); try { NB.setStatus(vs().notesBook, session, id, el.dataset.v); } catch (e) { toast(e.message, true); break; } wq.enqueue('setNoteStatus', [id, el.dataset.v]); render(); break;
    case 'note-del': ensureQueue(); try { NB.deleteNote(vs().notesBook, session, id); } catch (e) { toast(e.message, true); break; } wq.enqueue('deleteNote', [id]); render(); toast('ה-Note מועבר לסל. אפשר לשחזר אותו משם'); break;
    case 'wq-open': queueDialog(); break;
    case 'wq-retry': if (wq) { wq.retryFailed(id); } queueDialog(); break;
    case 'wq-discard': if (wq) { wq.discardFailed(id); } if (route() === 'review') refreshReview(); else if (route() === 'notes') render(); queueDialog(); break;
    case 'note-restore': await run(() => api.restoreNote(id), 'ה-Note שוחזר מהסל'); break;
    case 'note-purge': confirmDialog('למחוק את ה-Note לצמיתות? אי אפשר לשחזר אותו אחר כך (חוץ מקובץ גיבוי ישן).', 'מחיקה לצמיתות', () => run(() => api.purgeNote(id), 'ה-Note נמחק לצמיתות')); break;
    case 'note-backup': await downloadNotesBackup(); break;
    case 'note-restore-pick': document.getElementById('noteRestoreFile').click(); break;
    case 'note-undo-restore': confirmDialog('לחזור למצב הפנקס שלפני השחזור האחרון? Notes שנוספו או שונו בשחזור יחזרו לקדמותם.', 'חזרה למצב הקודם', () => run(() => api.undoNotesRestore(), 'הפנקס חזר למצב שלפני השחזור')); break;
    case 'bk-export': await downloadCycleBackup(); break;
    case 'bk-pick': document.getElementById('bkFile').click(); break;
    case 'bk-undo': confirmDialog('לחזור למצב המחזור שנשמר בגיבוי האוטומטי הזה? המצב הנוכחי יישמר לפני כן כגיבוי אוטומטי.', 'חזרה למצב הזה', () => run(() => api.undoAutoBackup(id), 'המחזור חזר למצב השמור')); break;
    case 'bk-attach-held': confirmDialog('לצרף את ההגשה השמורה למחזור? היא תופיע כגרסה חדשה של אותה משימה, עם חותמת הזמן המקורית.', 'צרף', () => run(() => api.attachHeld(id), 'ההגשה צורפה למחזור')); break;
    case 'help': helpDialog(el.dataset.h); break;
    case 'nav-toggle': navToggle(id); render(); break;
    case 'cycle-access': await run(() => api.setStudentAccess(id, el.dataset.v === '1'), el.dataset.v === '1' ? 'נפתחה גישת צפייה לתלמידים' : 'גישת התלמידים נסגרה'); break;
    case 'cycle-delete': {
      const c = state.cycles.find((x) => x.id === id);
      openDialog(`<h2>העברת "${esc(c.name)}" לסל</h2><p>המחזור יוסר מהרשימה ותלמידיו לא יוכלו להיכנס אליו. הוא נשמר בסל ואפשר לשחזר אותו, ונשמר גם גיבוי אוטומטי.</p><p class="muted">קובצי ההגשות ב-Drive אינם נמחקים ואינם משתנים בפעולה הזאת.</p><p>כדי לאשר, הקלידו את שם המחזור:</p><label>שם המחזור <input type="text" name="confirm" autocomplete="off" required></label>`,
        async (f) => {
          const ok = await run(() => api.deleteCycle(id, fd(f).confirm), 'המחזור הועבר לסל');
          if (ok) { resetCycleView(); location.hash = '#/home'; render(); }
          return ok;
        }, 'העבר לסל');
      break;
    }
    case 'trash-restore': await run(() => api.restoreTrashed(id), 'המחזור שוחזר מהסל כארכיון. אפשר להחזיר אותו לפעיל'); break;
    case 'trash-purge': openDialog(`<h2>מחיקה לצמיתות של "${esc(el.dataset.name)}"</h2><div class="alert"><b>אי אפשר לבטל.</b> נתוני המחזור במערכת (תלמידים, קבוצות, משימות, הגשות כרשומות, הערות וציונים) יימחקו. (עותק בגיבויים האוטומטיים עשוי להישאר, אבל הוא מוגבל במספר.)</div><div class="alert"><b>קובצי ההגשות ב-Drive אינם נמחקים</b> במסגרת הפעולה הזאת. הם יישארו ב-Drive, ללא קשר למערכת, ואם צריך למחוק אותם יש לעשות זאת בנפרד.</div><p>הקלידו את שם המחזור כדי לאשר:</p><label>שם המחזור <input type="text" name="confirm" autocomplete="off" required></label>`,
      (f) => run(() => api.purgeTrashed(id, fd(f).confirm), 'המחזור נמחק לצמיתות'), 'מחק לצמיתות'); break;
    case 'bk-relink': await run(() => api.relinkFile(id), 'הקובץ קושר מחדש'); break;
    case 'notif-tab': ui.notifTab = el.dataset.v; render(); break;
    case 'notif-maint': await maintenanceManual(); break;
    case 'notif-filter': ui.notifFilter = el.dataset.v; render(); break;
    case 'notif-read': await run(() => api.markNotifRead([id], true)); break;
    case 'notif-unread': await run(() => api.markNotifRead([id], false)); break;
    case 'notif-read-all': await run(() => api.markNotifRead('all', true), 'כל ההתראות סומנו כנקראו. הן ממשיכות להופיע כל עוד הבעיה קיימת'); break;
    case 'notif-open': { const link = el.dataset.link; const ok = await run(() => api.markNotifRead([id], true)); if (ok && link && link !== location.hash) location.hash = link; break; }
    case 'notif-resolve': await run(() => api.resolveNotifEvent(id), 'האירוע נסגר כטופל'); break;
    case 'notif-reopen': await run(() => api.reopenNotifEvent(id), 'האירוע נפתח מחדש'); break;
    case 'rem-task-edit': taskReminderDialog(id); break;
    case 'rem-run': {
      const day = document.getElementById('remDay').value || '';
      ui.remDay = day;
      if (await run(() => api.runReminders(day || undefined))) { const r = api.getLastReminderRun(); toast(r.system || r.email ? `נשלחו ${r.system} הודעות במערכת ו-${r.email} בדוא"ל (דמה)${r.capped ? `, ${r.capped} נחסמו במכסה` : ''}` : 'אין תזכורות חדשות לשלוח בתאריך הזה'); }
      break;
    }
    case 'notif-save-settings': {
      let patch;
      try { patch = readNotifSettings(); } catch (e) { toast(e.message, true); break; }
      await run(() => api.setNotifSettings(patch), 'ההגדרות נשמרו');
      break;
    }
    case 'explain-warnings': warningsHelpDialog(); break;
    case 'bank-add': bankAddDialog(id); break;
    case 'add-link': { const box = el.closest('.links-editor').querySelector('.link-rows'); box.insertAdjacentHTML('beforeend', linkRow()); ui.dirty = true; box.lastElementChild.querySelector('input').focus(); break; }
    case 'rm-link': el.closest('.link-row').remove(); ui.dirty = true; break;
    case 'sort': ui.sort = { key: el.dataset.key, dir: ui.sort.key === el.dataset.key ? -ui.sort.dir : 1 }; render(); break;
    case 'add-student': studentDialog(null); break;
    case 'edit-student': studentDialog(state.students.find((s) => s.id === id)); break;
    case 'history': historyDialog(id); break;
    case 'toggle-active': {
      const st = state.students.find((s) => s.id === id);
      await run(() => api.setStudentActive(id, !st.active), st.active ? 'התלמיד סומן כלא פעיל. הגישה שלו נחסמה' : 'התלמיד הוחזר לפעיל');
      break;
    }
    case 'add-group': groupDialog(null); break;
    case 'edit-group': groupDialog(state.groups.find((g) => g.id === id)); break;
    case 'delete-group': confirmDialog('למחוק את הקבוצה?', 'מחיקה', () => run(() => api.deleteGroup(id), 'הקבוצה נמחקה')); break;
    case 'remove-member': await run(() => api.assignStudent(id, null), 'התלמיד הוצא מהקבוצה'); break;
    // גאנט ולוח שנה
    case 'zoom-in': ui.zoom = Math.min(ZOOMS.length - 1, ui.zoom + 1); render(); break;
    case 'zoom-out': ui.zoom = Math.max(0, ui.zoom - 1); render(); break;
    case 'g-today': scrollToToday($app); break;
    case 'cal-prev': ui.calAnchor = shiftAnchor(ui.calAnchor, ui.calView, -1); render(); break;
    case 'cal-next': ui.calAnchor = shiftAnchor(ui.calAnchor, ui.calView, 1); render(); break;
    case 'cal-today': ui.calAnchor = ui.calView === 'week' ? T.D.today() : T.D.today().slice(0, 8) + '01'; render(); break;
    // משימות
    case 'add-task': newTaskDialog(); break;
    case 'open-task': taskDialog(id); break;
    case 'task-up': await run(() => api.moveTask(id, 'up')); break;
    case 'task-down': await run(() => api.moveTask(id, 'down')); break;
    case 'save-task': await keepOpen(() => api.updateTask(id, readTaskForm(document.getElementById('taskForm'))), 'המשימה נשמרה'); break;
    case 'del-task': confirmDialog('למחוק לצמיתות את המשימה? יימחקו גם ההתקדמות והארכות שלה, ואי אפשר לשחזר. אם רק רצית להוציא אותה מהתוכנית, בחר "הפוך ללא פעילה".', 'מחיקה לצמיתות', () => run(() => api.deleteTask(id), 'המשימה נמחקה לצמיתות')); break;
    case 'shift-class': shiftDialog(); break;
    case 'add-exc': {
      const [type, uid] = document.getElementById('excUnit').value.split(':');
      const t = taskById(id);
      await keepOpen(() => api.setException({ taskId: id, unitType: type, unitId: uid, start: t.start, due: document.getElementById('excDue').value }), 'הארכה נשמרה');
      break;
    }
    case 'rm-exc': await keepOpen(() => api.removeException(id), 'הארכה הוסרה'); break;
    case 'review': await keepOpen(() => api.reviewCompletion(el.dataset.task, el.dataset.utype, el.dataset.unit, el.dataset.d), el.dataset.d === 'approve' ? 'ההשלמה אושרה' : el.dataset.d === 'reject' ? 'הוחזר לתיקון' : 'נפתח מחדש'); break;
    case 'claim': await keepOpen(() => api.claimCompletion(el.dataset.task, el.dataset.utype, el.dataset.unit, el.dataset.claim === '1'), el.dataset.claim === '1' ? 'הבקשה נשלחה למורה. ההשלמה תיחשב רק אחרי אישורו' : 'הבקשה בוטלה'); break;
    // תבנית וחופשות
    case 'tpl-add': templateDialog(null); break;
    case 'tpl-edit': templateDialog(state.taskTemplate.find((t) => t.id === id)); break;
    case 'tpl-del': bankDeleteDialog(id); break;
    case 'deactivate': deactivateDialog(id); break;
    case 'demo-link': ev.preventDefault(); toast('זה קישור דמה ולכן הוא אינו נפתח. במערכת אמיתית יופיע כאן קישור למסמך Google, לקובץ PDF או לאתר.'); break;
    case 'open-review': { ui.reviewSub = id; ui.rvSel = null; $dlg.close(); if (location.hash === '#/review') render(); else location.hash = '#/review'; break; }
    case 'rv-zoom-in': if (ui.viewer) { await ui.viewer.zoom(1.2); document.getElementById('rvZoom').textContent = `${ui.viewer.zoomPercent}%`; } break;
    case 'rv-zoom-out': if (ui.viewer) { await ui.viewer.zoom(1 / 1.2); document.getElementById('rvZoom').textContent = `${ui.viewer.zoomPercent}%`; } break;
    case 'rv-fit': if (ui.viewer) { await ui.viewer.fit(); document.getElementById('rvZoom').textContent = `${ui.viewer.zoomPercent}%`; } break;
    case 'rv-add': await addReviewComment(false); break;
    case 'rv-add-general': await addReviewComment(true); break;
    case 'rv-toggle': { if (ui.rvOpen.has(id)) ui.rvOpen.delete(id); else ui.rvOpen.add(id); rerenderRvList(); break; }
    case 'rv-expand-all': ui.rvOpen = new Set(route() === 'feedback' ? fbComments(fbSubmission()).map((c) => c.id) : R.commentsOf(vs(), ui.reviewSub).map((c) => c.id)); rerenderRvList(); break;
    case 'rv-collapse-all': rvOpenOnly(null); rerenderRvList(); break;
    case 'cat-swatch': { const row = el.closest('.cat-row'); row.querySelector('[data-f="color"]').value = el.dataset.color; row.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === el)); break; }
    case 'rv-edit': ui.rvEdit = id; renderReviewList(); break;
    case 'rv-cancel': ui.rvEdit = null; renderReviewList(); break;
    case 'rv-save': {
      const li = el.closest('.rv-item');
      const f = (k) => li.querySelector(`[data-f="${k}"]`);
      const patch = { text: f('text').value, categoryId: f('cat').value, studentId: f('aud') && f('aud').value ? f('aud').value : null };
      ensureQueue();
      try { R.updateComment(vs(), session, id, patch); } catch (e) { toast(e.message || 'העדכון לא תקין', true); break; }
      wq.enqueue('updateComment', [id, patch]);
      ui.rvEdit = null; refreshReview();
      break;
    }
    case 'rv-del': confirmDialog('למחוק את ההערה? אפשר למחוק רק טיוטה.', 'מחיקה', () => { ensureQueue(); try { R.deleteComment(vs(), session, id); } catch (e) { toast(e.message || 'אי אפשר למחוק', true); return; } wq.enqueue('deleteComment', [id]); refreshReview(); }); break;
    case 'rv-cats': categoriesDialog(); break;
    case 'cat-add': case 'cat-save': {
      const row = el.closest('.cat-row');
      const data = { name: row.querySelector('[data-f="name"]').value, color: row.querySelector('[data-f="color"]').value };
      await catOp(() => (el.dataset.action === 'cat-add' ? api.addCategory(data) : api.updateCategory(id, data)), el.dataset.action === 'cat-add' ? 'הקטגוריה נוספה' : 'הקטגוריה עודכנה');
      break;
    }
    case 'cat-hide': await catOp(() => api.setCategoryArchived(id, true), 'הקטגוריה הוסתרה מהערות חדשות'); break;
    case 'cat-show': await catOp(() => api.setCategoryArchived(id, false), 'הקטגוריה הוחזרה'); break;
    case 'gr-scheme-edit': schemeEditorDialog(); break;
    case 'gr-tpl-save': templateSaveDialog(); break;
    case 'gr-tpl-apply': { const v = document.getElementById('grTplSel').value; if (!v) { toast('בחר תבנית', true); break; } confirmDialog('להחיל את התבנית על המחזור? ערכת הציונים הנוכחית של המחזור תוחלף בעותק עצמאי של התבנית.', 'החל', () => grOp(() => api.applyGradeTemplate(v), 'התבנית הוחלה כעותק עצמאי')); break; }
    case 'gr-tpl-del': { const v = document.getElementById('grTplSel').value; if (!v) { toast('בחר תבנית', true); break; } confirmDialog('למחוק את התבנית? מחזורים שכבר השתמשו בה לא ישתנו.', 'מחיקה', () => grOp(() => api.deleteGradeTemplate(v), 'התבנית נמחקה')); break; }
    case 'gr-exclude': excludeDialog(el.dataset.student || ''); break;
    case 'gr-weights': weightsDialog(el.dataset.student || ''); break;
    case 'gr-include': await grOp(() => api.includeGradeTask(id, { studentId: el.dataset.student || null }), 'המשימה הוחזרה לחישוב'); break;
    case 'gr-pw-clear': { const sid = el.dataset.student; await grOp(() => api.clearPersonalGradeWeights(sid), 'המשקלים האישיים בוטלו', { rerender: false }); render(); studentGradeDialog(sid); break; }
    case 'rv-retract': confirmDialog('לבטל את פרסום ההערה? היא תוסר מהתלמיד, התוכן וההיסטוריה יישמרו, ואפשר לתקן ולפרסם מחדש. אם התלמיד כבר ראה אותה, אי אפשר למחוק זאת.', 'בטל פרסום', () => revOp(() => api.retractComment(id), 'פרסום ההערה בוטל. היא כבר אינה נגישה לתלמיד')); break;
    case 'retract-fb': confirmDialog('לבטל את פרסום כל המשוב של ההגשה? ההערות יוסרו מהתלמידים (ציון המשימה יישאר אם פורסם), התוכן וההיסטוריה יישמרו, ושום דבר לא יתפרסם מחדש אוטומטית.', 'בטל פרסום', () => revOp(() => api.retractSubmissionFeedback(reviewSubmission().id), 'פרסום המשוב בוטל')); break;
    case 'pub-grade': { const sid = el.dataset.student; const c = PB.gradePublishCandidates(state, reviewSubmission().id).find((x) => x.studentId === sid); confirmDialog(`לפרסם ל${studentNameOf(sid)} את ציון המשימה ${c.currentShown}? התלמיד יראה ציון שלם בלבד.`, 'פרסם', () => revOp(() => api.publishTaskGrades(reviewSubmission().taskId, [sid]), 'הציון פורסם')); break; }
    case 'retract-grade': { const sid = el.dataset.student; confirmDialog(`לבטל את פרסום ציון המשימה של ${studentNameOf(sid)}? הציון יוסר מהתלמיד, הציון וההיסטוריה יישמרו, והמשוב הכתוב יישאר גלוי. אם הוא כבר ראה את הציון, אי אפשר למחוק זאת.`, 'בטל פרסום', () => revOp(() => api.retractTaskGrades(reviewSubmission().taskId, [sid]), 'פרסום הציון בוטל')); break; }
    case 'gr-pub-overall': confirmDialog(`לפרסם ל${studentNameOf(id)} את הציון הכולל ${PB.pubStatus(state, 'overall', null, id).currentShown}? התלמיד יראה ציון שלם בלבד.`, 'פרסם', () => grOp(() => api.publishOverallGrades([id]), 'הציון הכולל פורסם')); break;
    case 'gr-retract-overall': confirmDialog(`לבטל את פרסום הציון הכולל של ${studentNameOf(id)}? הוא יוסר מהתלמיד, והציון וההיסטוריה יישמרו. אם התלמיד כבר ראה אותו, אי אפשר למחוק זאת.`, 'בטל פרסום', () => grOp(() => api.retractOverallGrades([id]), 'פרסום הציון הכולל בוטל')); break;
    case 'gr-pub-overall-all': {
      const ids = G.studentsForGrades(state).filter((st) => { const x = PB.pubStatus(state, 'overall', null, st.id); return x.current !== null && ['waiting', 'changed'].includes(x.status); }).map((st) => st.id);
      if (!ids.length) { toast('אין ציון כולל חדש או מעודכן לפרסום (ציון שבוטל פרסומו מפורסם מחדש בנפרד)', true); break; }
      confirmDialog(`לפרסם את הציון הכולל ל-${ids.length} תלמידים? כל תלמיד יראה ציון שלם בלבד. ציונים שבוטל פרסומם לא כלולים.`, 'פרסם', () => grOp(() => api.publishOverallGrades(ids), 'הציון הכולל פורסם'));
      break;
    }
    case 'gr-pub-task': {
      const ids = G.studentsForGrades(state).filter((st) => ['waiting', 'changed'].includes(PB.pubStatus(state, 'task', id, st.id).status)).map((st) => st.id);
      if (!ids.length) { toast('אין ציונים חדשים או מעודכנים לפרסום במשימה הזו', true); break; }
      confirmDialog(`לפרסם את ציון המשימה "${(taskById(id) || {}).title}" ל-${ids.length} תלמידים? כל תלמיד יראה ציון שלם בלבד. ציונים שבוטל פרסומם לא כלולים.`, 'פרסם', () => grOp(() => api.publishTaskGrades(id, ids), 'ציוני המשימה פורסמו'));
      break;
    }
    case 'gr-retract-task': {
      const ids = G.studentsForGrades(state).filter((st) => ['published', 'changed', 'blocked'].includes(PB.pubStatus(state, 'task', id, st.id).status)).map((st) => st.id);
      if (!ids.length) { toast('אין ציונים מפורסמים לביטול במשימה הזו', true); break; }
      confirmDialog(`לבטל את פרסום ציוני המשימה "${(taskById(id) || {}).title}" ל-${ids.length} תלמידים? הם יוסרו מהתלמידים, והציונים וההיסטוריה יישמרו.`, 'בטל פרסום', () => grOp(() => api.retractTaskGrades(id, ids), 'פרסום ציוני המשימה בוטל'));
      break;
    }
    case 'gr-student': studentGradeDialog(id); break;
    case 'gr-group-grade': groupGradeDialog(id, el.dataset.group || ''); break;
    case 'sc-manual-grade': {
      const inp = document.getElementById('scManual');
      const v = inp ? inp.value : '';
      if (v === '') { toast('הזן ציון בין 0 ל-100', true); break; }
      await scOp(() => api.setStudentGrade(el.dataset.id, el.dataset.student, v), (Number((taskById(el.dataset.id) || {}).weight) > 0 ? 'הציון נשמר בטבלת הציונים (פנימי, לא מפורסם)' : 'הציון נשמר (פנימי, לא מפורסם), אבל למשימה אין משקל ולכן היא אינה בטבלת הציונים ואינה נכללת בציון הכולל'));
      renderReviewPublic();
      break;
    }
    case 'sc-setgrade': {
      const sid = reviewSubmission().id;
      const gs = K_gradeStatus(sid);
      if (gs && gs.hasIndividual) { setGradeDialog(sid); break; } // ציון אישי ידני קיים: נדרשת החלטה מפורשת
      await scOp(() => api.setGradeFromSheet(sid, {}), 'ציון המשימה נקבע ונשמר בטבלת הציונים (פנימי, לא מפורסם)');
      renderReviewPublic();
      break;
    }
    case 'rb-new': rubricEditor({ title: 'מחוון חדש', canPickKind: true, onSave: (d) => rbOp(() => api.addBaseRubric(d), 'המחוון נוסף לספרייה') }); break;
    case 'rb-edit': { const r = K.baseRubric(state, id); rubricEditor({ title: 'עריכת מחוון: ' + r.name, name: r.name, kind: r.kind, criteria: r.criteria, note: 'שמירה יוצרת גרסה חדשה של מחוון הבסיס. מחוונים של משימות ובדיקות שכבר התחילו אינם משתנים.', onSave: (d) => rbOp(() => api.updateBaseRubric(id, d), 'המחוון עודכן (גרסה חדשה). בדיקות שהתחילו לא השתנו') }); break; }
    case 'rb-dup': await rbOp(() => api.duplicateBaseRubric(id), 'נוצר עותק של המחוון'); break;
    case 'rb-hide': await rbOp(() => api.setBaseArchived(id, true), 'המחוון הוסתר מבחירה חדשה. משימות ובדיקות קיימות לא השתנו'); break;
    case 'rb-show': await rbOp(() => api.setBaseArchived(id, false), 'המחוון הוחזר'); break;
    case 'rb-task-edit': { const r = K.taskRubricOf(state, id); rubricEditor({ title: 'מחוון המשימה: ' + taskById(id).title, name: r.name, kind: r.kind, criteria: r.criteria, note: 'זה עותק של המחוון עבור המשימה הזו בלבד. הוא אינו משנה את מחוון הבסיס, ובדיקות שכבר התחילו נשארות לפי צילום המצב שלהן.', onSave: (d) => rbOp(() => api.updateTaskRubric(id, d), 'מחוון המשימה עודכן') }); break; }
    case 'rb-task-remove': confirmDialog('להסיר את המחוון מהמשימה? ניקוד שכבר התחיל נשמר.', 'הסרה', () => rbOp(() => api.removeTaskRubric(id), 'המחוון הוסר מהמשימה')); break;
    case 'rb-crit-add': { const kind = $dlg.querySelector('#rbEd').dataset.kind; $dlg.querySelector('#rbCrits').insertAdjacentHTML('beforeend', rbCritHtml({}, kind)); ui.dirty = true; break; }
    case 'rb-crit-del': { if ($dlg.querySelectorAll('.rb-crit').length > 1) { el.closest('.rb-crit').remove(); ui.dirty = true; $dlg.querySelector('#rbEd').dispatchEvent(new Event('input')); } break; }
    case 'ai-toggle': { const sub = reviewSubmission(); ui.aiOpen = true; await aiOp(() => api.setAiEnabled(el.checked), el.checked ? 'תשתית ה-AI הופעלה (ללא ספק אמיתי)' : 'תשתית ה-AI כובתה'); void sub; break; }
    case 'ai-quarantine': { const sub = reviewSubmission(); const r = document.getElementById('aiQReason'); await aiOp(() => api.setAiQuarantine(sub.id, el.dataset.on === '1', { reason: r ? r.value : '' }), el.dataset.on === '1' ? 'המסמך הועבר להסגר ידני' : 'המסמך הוצא מההסגר'); break; }
    case 'ai-scan': { let pages; try { aiReadForm(); pages = aiPages(); } catch (e) { toast(e.message, true); break; } ui.aiScan = P.scanPages(pages); ui.aiOpen = true; if (ui.aiScan.verdict === 'blocked') { await aiOp(() => api.quarantineAiIfSuspicious(reviewSubmission().id, pages), 'זוהה מידע מזהה או חשד ממשי: המסמך הועבר להסגר'); } else renderAi(); break; }
    case 'ai-run': {
      const sub = reviewSubmission();
      aiReadForm();
      let pages; try { pages = aiPages(); } catch (e) { toast(e.message, true); break; }
      const f = ui.aiForm;
      if (await aiOp(() => api.startAiRound(sub.id, { pages, rubric: f.rubric, prompt: f.prompt, oneTime: f.oneTime, provider: f.provider, model: f.model, confirmed: f.confirmed }), null)) {
        const q = A.quarantineOf(state, sub.id);
        if (q && q.auto) { ui.aiOpen = true; toast('זוהה מידע מזהה או חשד ממשי: לא הופעל AI והמסמך הועבר להסגר. אי אפשר לעקוף בנימוק.', true); }
        else toast('הסבב הסתיים. ההצעות ממתינות להחלטה ואינן גלויות לתלמידים');
        ui.aiForm.confirmed = false; renderAi();
      }
      break;
    }
    case 'ai-anchor': { if (!ui.rvSel) { toast('סמן קודם קטע במסמך', true); break; } if (await aiOp(() => api.anchorAiProposal(id, ui.rvSel), 'ההצעה שויכה לקטע שסומן. עכשיו אפשר לאשר')) { if (ui.viewer) ui.viewer.clearSelection(); } break; }
    case 'ai-general': await aiOp(() => api.makeAiProposalGeneral(id), 'ההצעה הפכה להערה כללית (החלטה שלך)'); break;
    case 'ai-approve': { const ta = el.closest('.ai-prop').querySelector('[data-f="aitext"]'); if (await aiOp(() => api.approveAiProposal(id, { text: ta ? ta.value : undefined }), 'ההצעה אושרה ונשמרה כטיוטה. התלמיד לא רואה אותה עד לשליחת משוב')) { if (ui.viewer) ui.viewer.setComments(reviewViewerComments()); renderReviewList(); } break; }
    case 'ai-reject': await aiOp(() => api.rejectAiProposal(id), 'ההצעה נדחתה'); break;
    case 'rv-check': {
      const sub = reviewSubmission();
      const rv = F.reviewOf(state, sub.id);
      const note = document.getElementById('rvNote') ? document.getElementById('rvNote').value : undefined;
      if (await revOp(() => api.setChecked(sub.id, !rv.checked, { note }), rv.checked ? 'הסימון "סיימתי לבדוק" בוטל' : 'סומן "סיימתי לבדוק". זה סימון פנימי, לא נשלח דבר לתלמידים')) renderReviewInternal();
      break;
    }
    case 'rv-note-save': {
      const sub = reviewSubmission();
      if (await revOp(() => api.setChecked(sub.id, F.reviewOf(state, sub.id).checked, { note: document.getElementById('rvNote').value }), 'הערת הטיפול נשמרה (פנימי)')) renderReviewInternal();
      break;
    }
    case 'rv-send': sendDialog(reviewSubmission().id); break;
    case 'fb-batch': batchDialog(); break;
    case 'rv-reply': case 'rv-answer': {
      const li = el.closest('.rv-item');
      const ta = li.querySelector('[data-f="thread"]');
      const answer = el.dataset.action === 'rv-answer';
      if (await revOp(() => api.addThread(id, { kind: answer ? 'answer' : 'reply', text: ta.value, answersId: answer ? el.dataset.q : null }), answer ? 'התשובה נשלחה לתלמידים' : 'התגובה נשלחה')) ta.value = '';
      break;
    }
    case 'open-feedback': { ui.fbSub = id; ui.rvOpen = new Set(); $dlg.close(); if (location.hash === '#/feedback') render(); else location.hash = '#/feedback'; break; }
    case 'fb-back': { ui.fbSub = null; if (ui.viewer) { ui.viewer.destroy(); ui.viewer = null; } location.hash = '#/home'; render(); break; }
    case 'fb-reply': case 'fb-ask': {
      const ta = el.closest('.rv-item').querySelector('[data-f="thread"]');
      const ask = el.dataset.action === 'fb-ask';
      if (await fbOp(() => api.addThread(id, { kind: ask ? 'question' : 'reply', text: ta.value }), ask ? 'השאלה נשלחה למורה. הוא יענה בכתב' : 'התגובה נשלחה')) ta.value = '';
      break;
    }
    case 'student-full': {
      ui.studentFull = !ui.studentFull;
      try { if (ui.studentFull && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {}); else if (!ui.studentFull && document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) { /* התצוגה המורחבת עובדת גם בלי מסך מלא אמיתי */ }
      render(); break;
    }
    case 'sub-dir': ui.subDir = ui.subDir === 'desc' ? 'asc' : 'desc'; render(); break;
    case 'rv-goto-score': { const e2 = document.getElementById('rvScore'); if (e2) e2.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'sub-filter': ui.subStatus = el.dataset.v; render(); break;
    case 'rv-filter': ui.rvFilter = el.dataset.v; renderReviewList(); break;
    case 'open-question': {
      const c = state.comments.find((x) => x.id === id);
      if (!c) { toast('השאלה לא נמצאה', true); break; }
      ui.reviewSub = c.submissionId; ui.rvFocus = id; ui.rvFilter = 'all'; ui.rvSel = null;
      $dlg.close();
      if (location.hash === '#/review') render(); else location.hash = '#/review';
      break;
    }
    case 'rv-return': returnDialog(reviewSubmission().id); break;
    case 'rv-reopen': { if (await revOp(() => api.reopenForReview(id), 'הגרסה המתוקנת נפתחה לבדיקה חוזרת. זה אינו אישור של התיקון')) { renderReviewFix(); renderReviewList(); } break; }
    case 'rv-due-save': { const v = document.getElementById('rvFixDue').value; if (await revOp(() => api.setCorrectionDue(id, v || null), 'מועד התיקון עודכן')) renderReviewFix(); break; }
    case 'reopen-fix': {
      const c = (state.corrections || []).find((x) => x.id === id);
      if (c && await run(() => api.reopenForReview(id), 'הגרסה המתוקנת נפתחה לבדיקה חוזרת')) { ui.reviewSub = c.submittedSubmissionId; ui.rvFocus = null; if (location.hash === '#/review') render(); else location.hash = '#/review'; }
      break;
    }
    case 'sub-versions': versionsDialog(el.dataset.task, el.dataset.utype, el.dataset.unit); break;
    case 'sub-open':
      if (remoteMode) await saveSubmissionFile(id, el.dataset.kind);
      else toast(el.dataset.kind === 'pdf' ? 'בדמו אין קובץ אמיתי. בגרסה האמיתית יורד ה-PDF.' : 'בדמו אין קובץ אמיתי. בגרסה האמיתית יורד קובץ המקור.');
      break;
    case 'sub-retry': await run(async () => { const st0 = await api.retryConversion(id); return remoteMode ? api.runConversion(id) : st0; }, 'ההמרה נשלחה מחדש. מועד ההגשה לא משתנה'); break;
    case 'sub-request-pdf': await run(() => api.requestPdf(id), 'נשלחה בקשה לצרף PDF. מועד ההגשה המקורי לא ישתנה'); break;
    case 'do-submit': await doSubmit(el); break;
    case 'do-attach-pdf': await doAttachPdf(el); break;
    case 'reactivate': await reactivate(id); break;
    case 'task-tab': ui.taskTab = el.dataset.tab; render(); break;
    case 'bank-reactivate': {
      const inact = T.bankStatus(state, id).inactive;
      if (inact.length === 1) await reactivate(inact[0].id);
      else { ui.taskTab = 'inactive'; location.hash = '#/tasks'; render(); toast('יש כמה עותקים לא פעילים. בחר את העותק להפעלה מחדש'); }
      break;
    }
    case 'tpl-up': await run(() => api.moveTemplateItem(id, 'up')); break;
    case 'tpl-down': await run(() => api.moveTemplateItem(id, 'down')); break;
    case 'apply-template': applyTemplateDialog(); break;
    case 'add-vac': vacationDialog(); break;
    case 'adm-done': await run(() => api.updateAdminEvent(id, { done: true }), 'סומן כבוצע'); break;
    case 'adm-add-defaults': await run(() => api.addDefaultAdminEvents(), 'האירועים המנהליים נוספו'); break;
    case 'adm-del': confirmDialog('למחוק את התזכורת? אפשר להחזיר תזכורות ברירת מחדל בכפתור "הוסף אירועים מנהלתיים".', 'מחיקה', () => run(() => api.deleteAdminEvent(id), 'התזכורת נמחקה')); break;
    case 'del-vac': await run(() => api.deleteVacation(id), 'החופשה נמחקה'); break;
    default: break;
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.matches('input[data-grade]')) {
    await grCellOp(() => api.setStudentGrade(t.dataset.grade, t.dataset.student, t.value === '' ? null : t.value), t);
  } else if (t.matches('input[data-item]')) {
    await grCellOp(() => api.setGradeItem(t.dataset.item, t.dataset.student, t.value === '' ? null : t.value), t);
  } else if (t.matches('select[data-action="rb-assign"]')) {
    const cur = K.taskRubricOf(state, t.dataset.id);
    const tid = t.dataset.id; const val = t.value;
    if (!val && cur) { confirmDialog('להסיר את המחוון מהמשימה? ניקוד שכבר התחיל נשמר.', 'הסרה', () => rbOp(() => api.removeTaskRubric(tid), 'המחוון הוסר מהמשימה')); render(); }
    else if (val && cur && cur.baseId !== val) { confirmDialog('להחליף את מחוון המשימה? העריכות שעשית במחוון המשימה יוחלפו בעותק חדש של מחוון הבסיס. ניקוד שכבר התחיל לא ישתנה.', 'החלפה', () => rbOp(() => api.assignRubric(tid, val), 'מחוון המשימה הוחלף')); render(); }
    else if (val && !cur) await rbOp(() => api.assignRubric(tid, val), 'המחוון שויך למשימה (עותק שאפשר לערוך)');
  } else if (t.matches('input[data-score]')) {
    await scOp(() => api.setScorePoints(reviewSubmission().id, t.dataset.score, t.value === '' ? null : t.value));
  } else if (t.matches('select[data-check]')) {
    await scOp(() => api.setScoreCheck(reviewSubmission().id, t.dataset.check, t.value === '' ? null : t.value === '1'));
  } else if (t.matches('input[data-risk]')) {
    await scOp(() => api.setScoreRisk(reviewSubmission().id, t.dataset.risk, t.checked), t.checked ? 'סומן סיכון פסילה. הציון לא השתנה' : 'הסימון בוטל');
  } else if (t.id === 'scNote') {
    await scOp(() => api.setScoreNote(reviewSubmission().id, t.value), 'הערת הניקוד נשמרה (פנימי)');
  } else if (t.matches('select[data-action="assign"]')) {
    await run(() => api.assignStudent(t.dataset.id, t.value || null), 'השיוך עודכן');
  } else if (t.matches('select[data-action="add-to-group"]')) {
    if (t.value) await run(() => api.assignStudent(t.value, t.dataset.group), 'התלמיד נוסף לקבוצה');
  } else if (t.id === 'subFile') {
    const f = t.files[0];
    document.getElementById('subChosen').textContent = f ? `נבחר: ${f.name}` : '';
    document.getElementById('subSend').hidden = !f;
    document.getElementById('subMsg').textContent = '';
  } else if (t.id === 'rvGhost') {
    ui.rvGhost = t.checked;
    const sub = reviewSubmission();
    if (ui.viewer && sub) ui.viewer.setGhosts(t.checked ? prevCommentsFlat(sub).filter((c) => c.anchor).map((c) => ({ id: c.id, anchor: c.anchor, color: R.categoryOf(state, c.categoryId).color })) : []);
    renderReviewPrev();
  } else if (t.id === 'rvTreated') {
    await revOp(() => api.setTreated(reviewSubmission().id, t.checked), t.checked ? 'סומן כטופל (פנימי)' : 'הסימון "טופל" בוטל');
    renderReviewInternal();
  } else if (t.id === 'fbVersion') {
    ui.fbSub = t.value;
    ui.rvOpen = new Set();
    render();
  } else if (t.matches('input[data-fixed]')) {
    await fbOp(() => api.setFixed(t.dataset.fixed, t.checked), t.checked ? 'סומן כתוקן (הסימון משותף לקבוצה)' : 'הסימון בוטל');
  } else if (t.id === 'revVersion') {
    ui.reviewSub = t.value;
    render();
  } else if (t.id === 'bkFile') {
    const file = t.files && t.files[0];
    t.value = '';
    if (file) await pickCycleRestore(file);
  } else if (t.id === 'simWriteFail') {
    api.setSimulation({ failWrite: t.checked });
  } else if (t.id === 'simRestoreFail') {
    api.setSimulation({ failRestore: t.checked });
  } else if (t.id === 'simMissing') {
    api.setSimulation({ missingFileIds: t.checked ? (state.submissions || []).slice(0, 2).map((x) => x.id) : [] });
  } else if (t.id === 'noteRestoreFile') {
    const file = t.files && t.files[0];
    t.value = '';
    if (file) await pickNotesRestore(file);
  } else if (['noteScope', 'noteStatus', 'noteCycle'].includes(t.id)) {
    ui[t.id] = t.value;
    renderNotesList();
  } else if (t.id === 'noteTrash') {
    ui.noteTrash = t.checked;
    renderNotesList();
  } else if (t.id === 'notifType') {
    ui.notifType = t.value;
    render();
  } else if (t.id === 'subTask' || t.id === 'subStatus' || t.id === 'subSort') {
    ui[t.id] = t.value;
    render();
  } else if (t.id === 'simSave' || t.id === 'simConv') {
    api.setSimulation(t.id === 'simSave' ? { failSave: t.checked } : { failConvert: t.checked });
  } else if (t.id === 'cycleSel') {
    await switchCycle(t.value);
  } else if (t.id === 'pendFilter') {
    ui.taskFilter = t.checked ? 'pending' : 'all';
    render();
  } else if (t.id === 'calDetail') {
    ui.calDetail = t.value;
    render();
  } else if (t.id === 'bankSel') {
    const o = t.selectedOptions[0];
    document.getElementById('bankStart').value = o.dataset.start;
    document.getElementById('bankCopies').innerHTML = bankCopiesNote(state.taskTemplate.find((x) => x.id === t.value));
  } else if (t.id === 'flt') {
    ui.filter = t.value;
    render();
  } else if (t.id === 'gFilter') {
    ui.gFilter = t.value;
    ui.scrolled = false;
    render();
  } else if (t.id === 'calView') {
    ui.calView = t.value;
    ui.calAnchor = t.value === 'week' ? T.D.today() : T.D.today().slice(0, 8) + '01';
    render();
  } else if (t.matches('input[data-prog]')) {
    const open = ui.openTask;
    const ok = await run(() => api.setProgress(open, t.dataset.utype, t.dataset.prog, t.value), 'ההתקדמות עודכנה');
    if (open) taskDialog(open);
    return ok;
  } else if (t.id === 'tkKind') {
    // רענון רשימת "למי המשימה" לפי הסוג (ללא שמירה)
    const box = t.closest('form').querySelector('[name="asg"]')?.closest('.checks');
    if (box) {
      const items = t.value === 'group' ? state.groups.map((g) => ({ id: g.id, label: g.name })) : state.students.filter((s) => s.active).map((s) => ({ id: s.id, label: s.name }));
      box.innerHTML = items.map((i) => `<label><input type="checkbox" name="asg" value="${esc(i.id)}"> ${esc(i.label)}</label>`).join('');
    }
  }
});

document.addEventListener('input', (ev) => {
  // סימון "שינויים שלא נשמרו" רק בטפסי עריכה. שדות שנשמרים מיד (התקדמות, ארכה) אינם נחשבים.
  if ($dlg.open && ev.target.closest('#dlgForm, #taskForm') && !ev.target.matches('[data-prog], #excUnit, #excDue')) ui.dirty = true;
  if (ev.target.id === 'noteQ') {
    ui.noteQ = ev.target.value;
    renderNotesList();
  }
  if (ev.target.id === 'q') {
    ui.search = ev.target.value;
    document.getElementById('studentsTable').innerHTML = studentsTable();
  }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id === 'cycleForm') {
    ev.preventDefault();
    await run(() => api.saveCycle(Object.fromEntries(new FormData(ev.target))), 'המחזור נשמר');
  }
});

// Esc: אם יש שינויים שלא נשמרו, מבקשים אישור לפני הסגירה.
// כפתור "חזרה למעלה": מופיע אחרי גלילה, בכל מסך
const $top = document.createElement('button');
$top.type = 'button';
$top.id = 'toTop';
$top.className = 'to-top';
$top.textContent = '⬆ חזרה למעלה';
$top.hidden = true;
document.body.appendChild($top);
$top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
addEventListener('scroll', () => { $top.hidden = window.scrollY < 450; }, { passive: true });
// גובה סרגל הסינון הצמוד, כדי שכותרות הטבלה ייצמדו מתחתיו
const syncStickyTop = () => { const bar = document.querySelector('.sub-bar'); if (bar) document.documentElement.style.setProperty('--sub-top', `${bar.offsetHeight}px`); };
addEventListener('resize', syncStickyTop);

// זוכר אם פאנל "הערות מגרסאות קודמות" פתוח (אירוע toggle אינו בועה)
document.addEventListener('toggle', (ev) => { if (ev.target.classList && ev.target.classList.contains('rv-prev')) ui.rvPrevOpen = ev.target.open; }, true);

$dlg.addEventListener('cancel', (ev) => {
  if (ui.dirty && !window.confirm('יש שינויים שלא נשמרו. לסגור ולבטל אותם?')) ev.preventDefault();
});
$dlg.addEventListener('close', () => {
  ui.openTask = null;
  ui.dirty = false;
  const revert = ui.revertOnClose;
  ui.revertOnClose = null;
  if (revert) revert(); // סגירת חלון ההשלכות בלי אישור מחזירה את הפס למקומו
});
window.addEventListener('hashchange', () => { ui.scrolled = false; render(); });

function render() {
  if (!session) { if (remoteMode || state) renderLogin(); return; }
  if (!state) return;
  if (session.role === 'student') {
    if (route() === 'feedback' && ui.fbSub) { $app.innerHTML = viewStudentFeedback(); initFeedback(); return; }
    if (ui.viewer) { ui.viewer.destroy(); ui.viewer = null; }
    $app.innerHTML = viewStudentHome();
    attachDrag($app, state, { type: 'student', id: session.userId }, { onOpen: (id) => taskDialog(id), onChange: () => {} });
    return;
  }
  const views = { home: viewHome, gantt: viewGantt, calendar: viewCalendar, tasks: viewTasks, template: viewTemplate, vacations: viewVacations, students: viewStudents, groups: viewGroups, cycle: viewCycle, submissions: viewSubmissions, review: viewReview, rubrics: viewRubrics, grades: viewGrades, notifications: viewNotifications, notes: viewNotes, backup: viewBackup };
  $app.innerHTML = (views[route()] || viewHome)();
  afterRender();
}

if (remoteMode && api.getPerfLog) window.__perf = () => { console.table(api.getPerfLog()); return api.getPerfLog(); }; // יומן זמני בקשות (לבדיקות ביצועים)
api.subscribe(async () => {
  state = await api.getState();
  if ($dlg.open) { if (ui.openTask && !ui.dirty) taskDialog(ui.openTask); } else render();
});

(async () => {
  if (remoteMode) {
    // חידוש כניסה בלשונית הקיימת (אם האסימון עדיין תקף); אחרת מסך כניסה
    if (session) { try { state = await api.getState(); ensureQueue(); scheduleMaintenance(); } catch (e) { session = null; state = null; } }
    render();
    return;
  }
  state = await api.getState();
  render();
})();
