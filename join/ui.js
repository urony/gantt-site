// ממשק משגר המוצר (עברית). הלוגיקה בפועל נמצאת ב-flow.js (נבדקת בבדיקות); כאן רק תצוגה, חיבור ל-Google Identity ופעולות הדפדפן.
// האסימון נשמר בזיכרון הדף בלבד. באחסון המקומי נשמרים רק מזהים ציבוריים ושני סימוני "קראתי / הפעלתי".
import { createSetupFlow, STEPS, SCOPES as FULL_SCOPES, NARROW_SCOPES } from './flow.js';
import { createDemoGoogle } from './demo-google.js';
import { loadVerifiedPackage } from './lib/package-loader.js';
import { sha512 } from './lib/sha512.js';

const cfg = window.LAUNCHER_CONFIG;
const SCOPES = cfg && cfg.narrowScopes ? NARROW_SCOPES : FULL_SCOPES;
const $ = (id) => document.getElementById(id);
const UI_KEY = 'gantt-launcher-ui-v1';
let token = null;
let ui = {};
try { ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch (e) { ui = {}; }
const saveUi = (patch) => { ui = { ...ui, ...patch }; try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ללא שמירה */ } };

if (!cfg) {
  document.querySelector('main').innerHTML = '<section><h2>המשגר אינו מוגדר</h2><p>חסר הקובץ product-config.js. הקובץ נוצר בבנייה (node tools/build-product.mjs launcher ...).</p></section>';
  throw new Error('missing LAUNCHER_CONFIG');
}
const demo = cfg.demo ? createDemoGoogle() : null;
if (cfg.testMode || demo) $('testBanner').hidden = false;
if (demo) {
  $('testBanner').innerHTML = 'מצב הדגמה: אין חיבור אמיתי ל-Google ושום דבר לא נוצר. ההדגמה מאפשרת לעבור את כל המסכים. <button id="resetDemo" class="secondary">התחלה מחדש</button>';
  document.getElementById('resetDemo').addEventListener('click', () => { try { localStorage.clear(); } catch (e) { /* ignore */ } location.reload(); });
}

// ----- פנייה ל-Google עם אסימון הכניסה -----
async function call(method, url, body) {
  if (!token) { const e = new Error('לא מחוברים'); e.status = 401; throw e; }
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) { /* לא JSON */ }
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}
// חבילת קוד המערכת: מורדת מכתובת העדכונים של האתר ונבדקת (חתימה, hash, מבנה) לפני שמועלה לחשבון המורה
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const loadPackage = () => loadVerifiedPackage({
  updatesUrl: cfg.updatesUrl, publicKey: cfg.publicKey,
  fetchText: async (url) => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); },
  sha256Hex: async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))),
  deps: { sha512, b64decode: (s) => Array.from(atob(s), (c) => c.charCodeAt(0)), utf8: (s) => Array.from(new TextEncoder().encode(s)) },
});
const flow = createSetupFlow({ call: demo ? demo.call : call, storage: localStorage, config: { ...cfg, loadPackage: demo ? demo.loadPackage : loadPackage } });

// ----- תצוגה -----
const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6'];
function currentStep() {
  const s = flow.state();
  if (s.initialized || s.authorized) return 6;
  if (s.provisioned) return 5;
  if (!ui.ack) return 1;
  if (!ui.apiAck && !s.projectNumber) return 2;
  return token ? 4 : 3; // התקדמות שמורה בלי כניסה (טעינה מחדש): נכנסים שוב, וההקמה ממשיכה מאותה נקודה
}
function render() {
  const n = currentStep(); const s = flow.state();
  SECTIONS.forEach((id, i) => { $(id).hidden = i + 1 !== n; });
  document.querySelectorAll('#stepper li').forEach((li) => { const i = Number(li.dataset.i); li.className = i < n || s.initialized ? 'done' : i === n ? 'now' : ''; });
  if (n === 5 && s.execUrl) $('openApp').href = s.execUrl;
  if (n === 6) {
    $('s6init').hidden = !!s.initialized; $('s6done').hidden = !s.initialized;
    if (!s.initialized) $('openInit').href = flow.initUrl();
    else { const link = flow.appLink(); $('appLink').textContent = link; $('openMine').href = link; }
  }
  if (n === 4) renderProgress();
}
function renderProgress(active, failed) {
  const s = flow.state(); const doneFlags = { cloud: !!s.projectNumber, api: !!s.apiEnabled, script: !!s.scriptId, content: !!s.contentUploaded, version: !!s.version, deploy: !!s.deploymentId };
  $('progress').innerHTML = STEPS.map((st) => `<li class="${failed === st.id ? 'fail' : doneFlags[st.id] ? 'ok' : active === st.id ? 'run' : ''}">${st.label}</li>`).join('');
}

// ----- שלבים -----
$('ack').addEventListener('change', () => { $('go1').disabled = !$('ack').checked; });
$('go1').addEventListener('click', () => { saveUi({ ack: true }); render(); });
$('go2').addEventListener('click', () => { saveUi({ apiAck: true }); render(); });

$('login').addEventListener('click', () => {
  const msg = $('loginMsg'); msg.hidden = true;
  if (demo) { token = 'demo'; render(); startRun(); return; }
  if (!window.google || !google.accounts) { msg.hidden = false; msg.textContent = 'ספריית ההתחברות של Google לא נטענה. בדקו חיבור לאינטרנט, רעננו את הדף ונסו שוב.'; return; }
  google.accounts.oauth2.initTokenClient({
    client_id: cfg.clientId, scope: SCOPES.join(' '),
    callback: (resp) => {
      if (resp.error) { msg.hidden = false; msg.textContent = 'ההתחברות לא הושלמה (' + resp.error + '). נסו שוב ואשרו את כל ההרשאות.'; return; }
      // כל ההרשאות חייבות להיות מאושרות; אחרת ההקמה תיכשל באמצע
      const granted = String(resp.scope || '');
      const missing = SCOPES.filter((sc) => !granted.includes(sc.split('/').pop()));
      if (missing.length) { msg.hidden = false; msg.textContent = 'לא סומנו כל ההרשאות. לחצו שוב על "התחברות עם Google" וסמנו את כל התיבות.'; return; }
      token = resp.access_token; render(); startRun();
    },
    error_callback: () => { msg.hidden = false; msg.textContent = 'חלון ההתחברות נסגר או נחסם. אם הדפדפן חסם חלונות קופצים, אפשרו אותם לאתר הזה ונסו שוב.'; },
  }).requestAccessToken();
});

flow.onProgress((ev) => { if (ev.phase === 'start') renderProgress(ev.step); else if (ev.phase === 'error') renderProgress(null, ev.step); else renderProgress(); });
const LINKS = { enable_script_api: ['פתיחת ההגדרות', 'https://script.google.com/home/usersettings'], cloud_terms: ['פתיחת Google Cloud', 'https://console.cloud.google.com/'] };
async function startRun() {
  $('runError').hidden = true; renderProgress();
  const r = await flow.run();
  if (r.busy) return;
  if (r.ok) { render(); return; }
  $('runError').hidden = false;
  $('errTitle').textContent = r.error.title;
  // פירוט טכני תמיד מוצג (קטוע), כדי שמורה יוכל לשלוח אותו לאורי; הטקסט מגיע מ-Google ואינו מכיל אסימונים
  $('errText').textContent = r.error.text + (r.raw ? ' פירוט טכני: ' + String(r.raw).slice(0, 300) : '');
  const l = LINKS[r.error.kind]; $('errLink').hidden = !l;
  if (l) { $('errLink').textContent = l[0]; $('errLink').href = l[1]; }
  if (r.error.kind === 'auth') token = null;
}
$('retry').addEventListener('click', () => { if (!token) { render(); return; } startRun(); });

async function fetchJson(url) { if (demo) return demo.fetchJson(url); const r = await fetch(url, { redirect: 'follow' }); return r.json(); }
$('authDone').addEventListener('click', async () => {
  const m = $('authMsg'); m.hidden = false; m.textContent = 'בודק…';
  const v = await flow.verify(fetchJson);
  if (v.reachable) { flow.markAuthorized(); m.hidden = true; render(); } else { m.textContent = 'המערכת עוד לא עונה. סיימו את מסכי האישור בלשונית שנפתחה (כולל "מתקדם" ו"בחירת הכול"), ואז לחצו שוב. אם הלשונית הראתה שגיאה, פתחו אותה מחדש.'; }
});
$('openInit').addEventListener('click', (ev) => { flow.markInitOpened(); if (demo) { ev.preventDefault(); demo.server.initialized = true; } });
$('openApp').addEventListener('click', (ev) => { if (demo) { ev.preventDefault(); demo.server.authorized = true; } });
$('initDone').addEventListener('click', async () => {
  const m = $('initMsg'); m.hidden = false; m.textContent = 'בודק…';
  const v = await flow.verify(fetchJson);
  if (v.initialized) { m.hidden = true; render(); } else { m.textContent = v.reachable ? 'ההקמה עוד לא הושלמה. ודאו שבלשונית שנפתחה כתוב "ההקמה הושלמה". אם כתוב שגיאה, לחצו שוב על "הקמת תיקיית הנתונים".' : 'המערכת לא עונה כרגע. נסו שוב בעוד רגע.'; }
});
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('appLink').textContent); $('copy').textContent = 'הועתק ✓'; } catch (e) { $('copy').textContent = 'סמנו את הקישור והעתיקו ידנית'; } });
$('restoreBtn').addEventListener('click', () => {
  const m = $('restoreMsg'); m.hidden = true;
  try { flow.restoreFromUrl($('restoreUrl').value); saveUi({ ack: true, apiAck: true }); render(); } catch (e) { m.hidden = false; m.textContent = e.message; }
});

render();
