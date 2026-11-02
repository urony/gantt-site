// בחירת מקור הנתונים של הממשק: דמו מקומי (localStorage), או שרת (Apps Script / שרת בדיקה) כשמוגדר `window.GANTT_CONFIG.remoteUrl`.
// ההגדרה נטענת מ-config.js (ברירת מחדל: דמו) ומ-config.local.js (אופציונלי, אינו נשמר ב-Git).
// בשרת ההרשאות נאכפות בשרת בלבד; הלקוח רק מציג.
import { resolveRemoteUrl } from './server-link.js';
const cfg = (typeof window !== 'undefined' && window.GANTT_CONFIG) || null;
// כתובת השרת: מההגדרה, או (בפריסה מרובת מורים, כשמותר) ממזהה השרת בקישור. ראו server-link.js.
const remoteUrl = resolveRemoteUrl(cfg, typeof location !== 'undefined' ? location.search : '');
export const remoteMode = !!remoteUrl;
export const serverUrl = remoteUrl;
export const config = cfg || {};

async function makeRemote() {
  const { createRemoteApi } = await import('./api-remote.js');
  const remote = createRemoteApi({ url: remoteUrl, storage: typeof sessionStorage !== 'undefined' ? sessionStorage : null });
  // פעולות הדמו אינן קיימות מול שרת: תחליפים שקטים כדי שהממשק לא ייפול
  return Object.assign(remote, {
    getSimulation: () => ({ failWrite: false, failSave: false, failConvert: false, failRestore: false, missingFileIds: [] }),
    setSimulation() {},
    subscribe: () => () => {},
    setSession() {},
  });
}

export const api = remoteMode ? await makeRemote() : (await import('./api-local.js')).api;
