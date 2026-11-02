// פורמט חבילת העדכון וכללי ההחלטה. לוגיקה טהורה, בלי Node ובלי דפדפן, כדי שאותו קוד בדיוק ירוץ בשלושה מקומות:
// בכלי השחרור של אורי (חתימה ובדיקה), במשגר (התקנה ראשונה) ובשרת של כל מורה (עדכון עצמי).
// כל התלות בסביבה מוזרקת (deps): sha512, b64decode ו-utf8, כולן מחזירות/מקבלות מערכי בתים 0..255.
//
// שני קבצים מתפרסמים ב-GitHub Pages:
//   latest.json   = { format: 1, payload: "<מחרוזת JSON>", sig: "<חתימה Ed25519 על בתי ה-UTF-8 של המחרוזת, base64>" }
//   pkg-<גרסה>.json = { format: 1, version, files: [ { name, type, source } ] }
// payload: { seq, version, percent, urgent, hold, pkg, sha256 }. seq עולה בכל פרסום (גם בחזרה לאחור) ומונע שימוש חוזר בחתימה ישנה.
// החבילה עצמה אינה חתומה: sha256 שלה נמצא בתוך ה-payload החתום, ולכן כל שינוי בה מתגלה.
import { ed25519Verify } from './ed25519.js';

export const PACKAGE_FILES = ['Code', 'Shell', 'appsscript'];
export const MAX_VERSION = 100000;
export const MAX_PACKAGE_BYTES = 6000000;
const isInt = (n, a, b) => typeof n === 'number' && n % 1 === 0 && n >= a && n <= b;

// פותח ומאמת מעטפת חתומה. מחזיר { ok: true, payload } או { ok: false, reason }.
export function parseRelease(text, publicKeyB64, deps) {
  let env;
  try { env = JSON.parse(text); } catch (e) { return { ok: false, reason: 'not_json' }; }
  if (!env || env.format !== 1 || typeof env.payload !== 'string' || typeof env.sig !== 'string' || env.payload.length > 4000) return { ok: false, reason: 'bad_envelope' };
  let sig; let pub;
  try { sig = deps.b64decode(env.sig); pub = deps.b64decode(publicKeyB64); } catch (e) { return { ok: false, reason: 'bad_base64' }; }
  if (!ed25519Verify(sig, deps.utf8(env.payload), pub, deps.sha512)) return { ok: false, reason: 'bad_signature' };
  let p;
  try { p = JSON.parse(env.payload); } catch (e) { return { ok: false, reason: 'payload_not_json' }; }
  if (!p || !isInt(p.seq, 1, 1e12) || !isInt(p.version, 1, MAX_VERSION) || !isInt(p.percent, 0, 100) || typeof p.urgent !== 'boolean' || typeof p.hold !== 'boolean'
    || !/^pkg-\d{1,6}\.json$/.test(String(p.pkg)) || !/^[0-9a-f]{64}$/.test(String(p.sha256))) return { ok: false, reason: 'bad_payload' };
  return { ok: true, payload: { seq: p.seq, version: p.version, percent: p.percent, urgent: p.urgent, hold: p.hold, pkg: p.pkg, sha256: p.sha256 } };
}

// בודק את מבנה החבילה אחרי שה-sha256 שלה אומת. מחזיר רשימת בעיות (ריקה = תקין).
// installedScopes: ההרשאות במניפסט הנוכחי של הפרויקט (null בהתקנה ראשונה). הרשאה חדשה דורשת אישור מחדש של המורה ולכן אסורה בעדכון שקט.
export function validatePackage(pkg, payload, installedScopes) {
  const problems = [];
  if (!pkg || pkg.format !== 1 || pkg.version !== payload.version || !Array.isArray(pkg.files)) return ['מבנה חבילה לא תקין או גרסה שאינה תואמת'];
  const names = pkg.files.map((f) => f && f.name);
  if (names.length !== PACKAGE_FILES.length || !PACKAGE_FILES.every((n) => names.indexOf(n) >= 0)) problems.push('קבצי החבילה אינם הקבצים המותרים: ' + names.join(','));
  let total = 0;
  for (const f of pkg.files) {
    if (!f || typeof f.source !== 'string' || f.source.length < 2) { problems.push('קובץ ריק או פגום: ' + (f && f.name)); continue; }
    if (f.type !== (f.name === 'appsscript' ? 'JSON' : 'SERVER_JS')) problems.push('סוג קובץ לא צפוי: ' + f.name);
    total += f.source.length;
  }
  if (total > MAX_PACKAGE_BYTES) problems.push('החבילה גדולה מדי');
  const mf = pkg.files.find((f) => f && f.name === 'appsscript');
  if (mf) {
    let m = null;
    try { m = JSON.parse(mf.source); } catch (e) { problems.push('המניפסט אינו JSON'); }
    if (m) {
      if (m.dependencies && m.dependencies.libraries && m.dependencies.libraries.length) problems.push('החבילה אינה יכולה להסתמך על ספרייה חיצונית');
      if (!m.webapp || m.webapp.executeAs !== 'USER_DEPLOYING' || m.webapp.access !== 'ANYONE_ANONYMOUS') problems.push('הגדרת האפליקציה במניפסט שונה מהמצופה');
      const scopes = Array.isArray(m.oauthScopes) ? m.oauthScopes : [];
      if (installedScopes) { const extra = scopes.filter((s) => installedScopes.indexOf(s) < 0); if (extra.length) problems.push('הרשאה חדשה דורשת אישור מחדש של המורה: ' + extra.join(',')); }
    }
  }
  return problems;
}

// החלטת עדכון. state: { installed (מספר או null), storedSeq, bucket (0..99), uploadActive, failed: { version, count } | null }
// מחזיר { action: 'update' | 'none', reason, seq } . seq מוחזר כדי שהשרת ירשום אותו כשהחתימה תקפה (גם בלי עדכון).
export function decide(payload, state) {
  const base = { seq: payload.seq };
  if (payload.seq < (state.storedSeq || 0)) return { ...base, action: 'none', reason: 'old_seq', seq: state.storedSeq };
  if (payload.hold) return { ...base, action: 'none', reason: 'hold' };
  if (state.installed === payload.version) return { ...base, action: 'none', reason: 'up_to_date' };
  if (state.failed && state.failed.version === payload.version && state.failed.count >= 3) return { ...base, action: 'none', reason: 'failed_before' };
  if (!payload.urgent && state.bucket >= payload.percent) return { ...base, action: 'none', reason: 'not_in_bucket' };
  if (state.uploadActive) return { ...base, action: 'none', reason: 'upload_active' };
  return { ...base, action: 'update', reason: 'update' };
}
