// שכבת נתונים מקומית לדמו (localStorage בדפדפן). הליבה ב-api-core.js; כאן רק האחסון והזהות של הדמו.
// בגרסה האמיתית הממשק מדבר עם השרת (api-remote.js), וההרשאות נאכפות שם.
import * as C from './cycles.js';
import * as NB from './notes.js';
import { buildDemoRoot, DEMO_SEED } from './seed.js';
import { createStore, localBackend, failingBackend } from './store.js';
import { createApi } from './api-core.js';

const KEY = 'gantt-demo-v3';
const SESSION_KEY = 'gantt-demo-session-v1';
const sim = { failWrite: false, failSave: false, failConvert: false, missingFileIds: [], failRestore: false };

// כל כתיבה עוברת דרך store.js: כשל שמירה זורק SaveError, המצב לא משתנה ואין הצלחה מדומה (DEV_PLAN, "כלל חיבור לשרת").
// sim.failWrite (ארגז הבדיקות) מדמה כשל כתיבה ונבדק בכל שמירה.
const store = createStore({
  backend: failingBackend(localBackend(localStorage, KEY), () => sim.failWrite),
  // נתוני דמה מגרסה ישנה (בלי המשימות והגשות החדשות) נבנים מחדש. זה דמו בלבד, אין כאן מידע אמיתי.
  migrate: (parsed) => (parsed.demoSeed === DEMO_SEED ? C.migrate(parsed) : null),
  init: (old) => { const fresh = buildDemoRoot(); if (old && old.notesBook) fresh.notesBook = old.notesBook; return fresh; }, // הפנקס האישי נשמר גם כשנתוני הדמה מתחדשים
});

const session = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } },
  set(s) { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } },
};

export const api = createApi({ store, session, sim, later: (ms, fn) => setTimeout(() => fn(store), ms) });
