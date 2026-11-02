// ליבת משגר המוצר: הקמת השרת האישי של מורה, בצעדים שנבדקו בניסויים 1 ו-2 (לא נבדק כאן מול Google; ראו launcher/README.md).
// הליבה אינה נוגעת בדפדפן: הפנייה ל-Google (call), ההמתנה (sleep) והאחסון (storage) מוזרקים, ולכן היא נבדקת ב-Node מול תחליף.
// עקרונות:
//  * כל צעד שומר את תוצאתו מיד, ואם משהו נכשל אפשר להמשיך מאותה נקודה בלי ליצור דברים כפולים (פרויקט ענן, פרויקט סקריפט). בניסוי 2 לחיצה כפולה יצרה שני פרויקטים.
//  * הקוד שמועלה למורה נגזר מהתבנית שבבנייה (לא מטקסט שמגיע מהרשת), והערכים שנכנסים אליו נבדקים (shell-render.js).
//  * שום סוד אינו נשמר: האסימון נשאר בזיכרון הדף בלבד, ונשמרים רק מזהים ציבוריים (מזהי פרויקט ופריסה).
import { renderShellText } from './lib/shell-render.js';
import { isDeploymentId, execUrl, appLink } from './lib/server-link.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/cloud-platform', // יצירת פרויקט ענן אישי והפעלת Apps Script API בו (ניסוי 2). זו ההרשאה המפחידה ביותר במסכי ההסכמה
  'https://www.googleapis.com/auth/userinfo.email',
];
// סט צר לניסוי (טרם נבדק מול Google): יצירת פרויקט וההפעלת API בלי cloud-platform הרחבה. מופעל רק בהגדרה narrowScopes, לצורך ניסוי ובקשת אימות.
export const NARROW_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/cloudplatformprojects', // projects.create
  'https://www.googleapis.com/auth/service.management', // services.enable
  'https://www.googleapis.com/auth/userinfo.email',
];
export const STATE_KEY = 'gantt-launcher-state-v1';
const SCRIPT_API = 'https://script.googleapis.com/v1';
const CRM = 'https://cloudresourcemanager.googleapis.com/v3';
const SERVICE_USAGE = 'https://serviceusage.googleapis.com/v1';

// שלבי הקמה אוטומטיים, לפי הסדר. כל אחד מדלג אם כבר בוצע.
export const STEPS = [
  { id: 'cloud', label: 'יוצר פרויקט Google אישי לעדכונים' },
  { id: 'api', label: 'מפעיל את שירות העדכונים בפרויקט' },
  { id: 'script', label: 'יוצר את הסקריפט של המערכת' },
  { id: 'content', label: 'מעלה את קוד המערכת' },
  { id: 'version', label: 'יוצר גרסה' },
  { id: 'deploy', label: 'מפרסם את המערכת בכתובת פרטית' },
];

const rand = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

// הסבר שגיאה בעברית פשוטה, עם סוג שמאפשר לממשק להציע את הפעולה הנכונה
export function explainError(err) {
  const status = err && err.status; const msg = String((err && err.message) || err || '');
  if (status === 403 && /Apps Script API|has not been used|User has not enabled|script\.googleapis\.com/i.test(msg) && !/serviceusage|Service Usage/i.test(msg)) {
    return { kind: 'enable_script_api', title: 'צריך להפעיל את Google Apps Script API', text: 'בחשבון שלכם המתג כבוי. פתחו את ההגדרות, הפעילו את "Google Apps Script API", וחזרו לכאן ללחוץ "נסו שוב". שום דבר שנוצר עד עכשיו לא יאבד.' };
  }
  if (/terms of service|TOS|accept.*terms/i.test(msg)) {
    return { kind: 'cloud_terms', title: 'Google מבקשת שתאשרו את תנאי השימוש של Cloud', text: 'זה קורה לחשבון שמעולם לא נכנס ל-Google Cloud. פתחו את הקישור, אשרו את התנאים (בלי להזין אמצעי תשלום), וחזרו ללחוץ "נסו שוב".' };
  }
  if ((status === 403 || status === 400 || status === 412) && /organization|policy|constraint|resource manager|create.*project|projects\.create/i.test(msg)) {
    return { kind: 'org_blocked', title: 'נראה שהארגון שלכם חוסם יצירת פרויקטים', text: 'בחשבון בית ספרי (Workspace) מנהל המערכת יכול לחסום זאת. נסו עם חשבון Gmail פרטי, או פנו לאורי כדי לבחור דרך אחרת.' };
  }
  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) {
    return { kind: 'quota', title: 'Google מבקשת לחכות', text: 'עברתם מכסה זמנית של בקשות או של פרויקטים. המתינו כמה דקות ולחצו "נסו שוב"; אם זה חוזר, פנו לאורי.' };
  }
  if (err && (err.code === 'package_unavailable' || err.code === 'package_untrusted')) return { kind: err.code, title: err.code === 'package_unavailable' ? 'אי אפשר להוריד את קוד המערכת כרגע' : 'קוד המערכת לא עבר בדיקת אבטחה', text: msg + ' ההתקדמות נשמרה.' };
  if (status === 401) return { kind: 'auth', title: 'ההתחברות פגה', text: 'התחברו שוב עם Google ואז לחצו "נסו שוב". ההתקדמות נשמרה.' };
  return { kind: 'unknown', title: 'משהו השתבש', text: 'אפשר ללחוץ "נסו שוב"; ההתקדמות נשמרה. אם זה חוזר, פנו לאורי ושלחו לו את הפירוט הטכני. פירוט: ' + msg.slice(0, 200) };
}

export function createSetupFlow({ call, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), storage = null, config, now = () => Date.now(), pollMs = 2000, maxPolls = 60 }) {
  for (const k of ['updatesUrl', 'publicKey', 'loadPackage', 'appUrl']) if (config[k] === undefined || config[k] === '') throw new Error('חסרה הגדרה במשגר: ' + k);
  let state = { startedAt: now() };
  try { const raw = storage && storage.getItem(STATE_KEY); if (raw) state = { ...state, ...JSON.parse(raw) }; } catch (e) { /* ללא שחזור */ }
  let running = false; let listener = () => {};
  const save = () => { try { storage && storage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ללא שמירה */ } };
  const set = (patch) => { state = { ...state, ...patch }; save(); };
  const emit = (ev) => { try { listener(ev); } catch (e) { /* הממשק אינו מכשיל את ההקמה */ } };

  async function waitOp(base, name) {
    for (let i = 0; i < maxPolls; i++) {
      const op = await call('GET', `${base}/${name}`);
      if (op.done) { if (op.error) { const e = new Error(op.error.message || 'הפעולה נכשלה'); e.status = op.error.code === 7 ? 403 : op.error.code === 9 ? 412 : 400; throw e; } return op; }
      await sleep(pollMs);
    }
    throw new Error('הפעולה לא הסתיימה בזמן. נסו שוב בעוד רגע.');
  }

  const doStep = {
    async cloud() {
      if (state.projectNumber) return;
      const projectId = state.projectId || ('gantt-' + rand(8) + '-' + String(now()).slice(-5));
      set({ projectId }); // נשמר לפני הקריאה: ניסיון חוזר ישתמש באותו מזהה ולא ייצור פרויקט נוסף
      let number;
      try {
        const op = await call('POST', `${CRM}/projects`, { projectId, displayName: 'Gantt teacher system' });
        const done = await waitOp(CRM, op.name);
        number = String((done.response && done.response.name) || '').replace('projects/', '');
      } catch (e) {
        if (e && e.status === 409) { const p = await call('GET', `${CRM}/projects/${projectId}`); number = String(p.name || '').replace('projects/', ''); } else throw e;
      }
      if (!/^\d{6,15}$/.test(number)) throw new Error('לא התקבל מספר פרויקט תקין מ-Google');
      set({ projectNumber: number });
    },
    async api() {
      if (state.apiEnabled) return;
      const op = await call('POST', `${SERVICE_USAGE}/projects/${state.projectNumber}/services/script.googleapis.com:enable`, {});
      await waitOp(SERVICE_USAGE, op.name);
      set({ apiEnabled: true });
    },
    async script() {
      if (state.scriptId) return;
      const p = await call('POST', `${SCRIPT_API}/projects`, { title: config.title || 'מערכת ליווי פרויקט גמר' });
      if (!p || !/^[A-Za-z0-9_-]{20,120}$/.test(String(p.scriptId || ''))) throw new Error('לא התקבל מזהה סקריפט תקין');
      set({ scriptId: p.scriptId });
    },
    async content() {
      if (state.contentUploaded) return;
      // השרת של המורה מקבל עותק מלא של הקוד (בלי ספרייה חיצונית). החבילה נבדקת לפני כל כתיבה: חתימה, hash ומבנה (package-loader.js).
      const { payload, pkg } = await config.loadPackage();
      const files = pkg.files.map((f) => ({ name: f.name, type: f.type, source: f.name === 'Shell' ? renderShellText(f.source, { updatesUrl: config.updatesUrl, quotaProject: state.projectNumber, triggerEveryMin: config.triggerEveryMin || 0, publicKey: config.publicKey }) : f.source }));
      await call('PUT', `${SCRIPT_API}/projects/${state.scriptId}/content`, { files });
      set({ contentUploaded: true, installedVersion: payload.version });
    },
    async version() {
      if (state.version) return;
      const v = await call('POST', `${SCRIPT_API}/projects/${state.scriptId}/versions`, { description: 'הקמה ראשונית' });
      if (!Number.isInteger(v && v.versionNumber)) throw new Error('לא התקבלה גרסה תקינה');
      set({ version: v.versionNumber });
    },
    async deploy() {
      if (state.deploymentId) return;
      const d = await call('POST', `${SCRIPT_API}/projects/${state.scriptId}/deployments`, { versionNumber: state.version, manifestFileName: 'appsscript', description: 'מערכת ליווי' });
      const ep = ((d && d.entryPoints) || []).find((e) => e.entryPointType === 'WEB_APP');
      const url = ep && ep.webApp && ep.webApp.url;
      // מקבלים רק כתובת שרת אמיתית של Apps Script, ומזהה פריסה תקין
      if (!isDeploymentId(d && d.deploymentId) || url !== execUrl(d.deploymentId)) throw new Error('התקבלה כתובת שרת לא צפויה. לא ממשיכים.');
      set({ deploymentId: d.deploymentId, execUrl: url });
    },
  };

  return {
    state: () => ({ ...state }),
    onProgress(fn) { listener = fn || (() => {}); },
    reset() { state = { startedAt: now() }; save(); },
    // מריץ את כל הצעדים שנותרו. קריאה בזמן ריצה (לחיצה כפולה) מחזירה מיד ואינה יוצרת דבר.
    async run() {
      if (running) return { ok: false, busy: true };
      running = true;
      try {
        for (const s of STEPS) {
          emit({ step: s.id, phase: 'start' });
          try { await doStep[s.id](); } catch (e) { emit({ step: s.id, phase: 'error' }); return { ok: false, failedStep: s.id, error: explainError(e), raw: String((e && e.message) || e) }; }
          emit({ step: s.id, phase: 'done' });
        }
        set({ provisioned: true });
        return { ok: true, execUrl: state.execUrl };
      } finally { running = false; }
    },
    // שחזור ידני כשהמצב נאבד (למשל חלון גלישה בסתר): הדבקת כתובת השרת
    restoreFromUrl(url) {
      const m = /^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]{20,200})\/exec$/.exec(String(url || '').trim());
      if (!m) throw new Error('זו לא כתובת שרת תקינה. היא אמורה להתחיל ב-https://script.google.com/macros/s/ ולהסתיים ב-/exec');
      set({ deploymentId: m[1], execUrl: execUrl(m[1]), provisioned: true });
      return { ...state };
    },
    markAuthorized() { set({ authorized: true }); },
    markInitOpened() { set({ initOpened: true }); },
    // בדיקה ציבורית (ללא התחברות): האם השרת עונה, ואם ההקמה הושלמה
    async verify(fetchJson) {
      if (!state.execUrl) throw new Error('עדיין אין כתובת שרת');
      let r;
      try { r = await fetchJson(state.execUrl + '?action=ping'); } catch (e) { return { reachable: false, initialized: false, reason: 'network' }; }
      if (!r || r.ok !== true) return { reachable: false, initialized: false, reason: 'not_json' };
      if (r.initialized) set({ initialized: true });
      return { reachable: true, initialized: !!r.initialized, build: r.build };
    },
    initUrl: () => `${state.execUrl}?action=init&page=1`,
    appLink: () => appLink(config.appUrl, state.deploymentId),
  };
}
