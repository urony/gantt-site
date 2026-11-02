// מצב הדגמה של המשגר (cfg.demo): תחליף מקומי ל-Google, כדי לראות ולנסות את כל מסכי ההצטרפות בלי חשבון, בלי רשת ובלי ליצור דבר אצל Google.
// לא משמש בייצור. הבנייה (tools/build-product.mjs launcher --demo) היא שמדליקה אותו.
import { execUrl } from './lib/server-link.js';

const DEP = 'AKfycbDEMO' + 'x'.repeat(34);
const SCRIPT = 'DEMOSCRIPT' + 'S'.repeat(34);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDemoGoogle({ delay = 700 } = {}) {
  let version = 1;
  async function call(method, url) {
    await wait(delay);
    if (method === 'POST' && url === 'https://cloudresourcemanager.googleapis.com/v3/projects') return { name: 'operations/demo-create' };
    if (method === 'GET' && url.endsWith('/operations/demo-create')) return { done: true, response: { name: 'projects/123456789012' } };
    if (method === 'POST' && url.endsWith(':enable')) return { name: 'operations/demo-enable' };
    if (method === 'GET' && url.endsWith('/operations/demo-enable')) return { done: true };
    if (method === 'POST' && url === 'https://script.googleapis.com/v1/projects') return { scriptId: SCRIPT };
    if (method === 'PUT' && url.endsWith('/content')) return {};
    if (method === 'POST' && url.endsWith('/versions')) return { versionNumber: version++ };
    if (method === 'POST' && url.endsWith('/deployments')) return { deploymentId: DEP, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: execUrl(DEP) } }] };
    throw new Error('קריאה לא צפויה בהדגמה: ' + method + ' ' + url);
  }
  // חבילת הדגמה (לא חתומה): מדלגת על האימות בהדגמה בלבד, כי אין בהדגמה מפתח אמיתי
  const loadPackage = async () => ({ payload: { version: 1 }, pkg: { format: 1, version: 1, files: [{ name: 'Code', type: 'SERVER_JS', source: '// demo' }, { name: 'Shell', type: 'SERVER_JS', source: "var UPDATES_URL = '__UPDATES_URL__'; var QUOTA_PROJECT = '__QUOTA_PROJECT__'; var PUBLIC_KEY = '__PUBLIC_KEY__'; var TRIGGER_EVERY_MIN = __TRIGGER_EVERY_MIN__;" }, { name: 'appsscript', type: 'JSON', source: '{}' }] } });
  const server = { authorized: false, initialized: false };
  const fetchJson = async () => { await wait(delay / 2); if (!server.authorized) throw new Error('consent page'); return { ok: true, build: 'DEMO', initialized: server.initialized }; };
  return { call, fetchJson, loadPackage, server };
}
