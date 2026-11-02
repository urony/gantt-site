// אימות זהות בעל השרת לפני שתלמיד מתחבר. השרת מחזיר הוכחת זהות חתומה של Google (ScriptApp.getIdentityToken על חשבון הבעלים);
// האתר מאמת את החתימה מול מפתחות Google ומציג לתלמיד את דוא"ל הבעלים לאישור. אין פנקס מרכזי.
// מגבלה ידועה (מתועדת): ההוכחה אינה קשורה לשרת מסוים ותקפה עד שעה, ולכן שרת מתחזה שקיבל הוכחה משרת אמיתי יכול להציגה.
// ההגנות: טריות (עד 10 דקות), הגבלת קצב בשרת, אישור התלמיד, וזכירת הדוא"ל המאושר בדפדפן (שינוי = אזהרה).
// לוגיקה טהורה: fetch, אחסון, זמן ו-WebCrypto מוזרקים, ולכן נבדקת ב-Node.
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const MAX_AGE_SEC = 600;
export const TRUST_KEY = 'gantt-trusted-teachers-v1';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

const b64uToBytes = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };
const parseJson = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

// מחזיר { ok, email } או { ok:false, reason }. jwks = { keys: [...] } של Google.
export async function verifyIdentityToken(token, { jwks, now = () => Date.now(), subtle = globalThis.crypto && globalThis.crypto.subtle, maxAgeSec = MAX_AGE_SEC } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'format' };
    const header = parseJson(b64uToBytes(parts[0])); const payload = parseJson(b64uToBytes(parts[1]));
    if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
    const jwk = ((jwks && jwks.keys) || []).find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return { ok: false, reason: 'key' };
    const key = await subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!good) return { ok: false, reason: 'signature' };
    const t = Math.floor(now() / 1000);
    if (!ISSUERS.includes(payload.iss)) return { ok: false, reason: 'issuer' };
    if (!(payload.exp > t)) return { ok: false, reason: 'expired' };
    if (!(payload.iat <= t + 60) || t - payload.iat > maxAgeSec) return { ok: false, reason: 'stale' };
    if (payload.email_verified !== true && payload.email_verified !== 'true') return { ok: false, reason: 'unverified_email' };
    const email = String(payload.email || '').trim().toLowerCase();
    if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) || email.length > 120) return { ok: false, reason: 'email' };
    return { ok: true, email };
  } catch (e) { return { ok: false, reason: 'error' }; }
}

// זכירת אישור: מפתח = כתובת השרת, ערך = הדוא"ל שהתלמיד אישר
export function getTrusted(storage, serverUrl) {
  try { const m = JSON.parse(storage.getItem(TRUST_KEY) || '{}'); return typeof m[serverUrl] === 'string' ? m[serverUrl] : null; } catch (e) { return null; }
}
export function setTrusted(storage, serverUrl, email) {
  try { const m = JSON.parse(storage.getItem(TRUST_KEY) || '{}'); m[serverUrl] = email; storage.setItem(TRUST_KEY, JSON.stringify(m)); return true; } catch (e) { return false; }
}

// מביא הוכחה מהשרת ומאמת. מחזיר אחד מהמצבים:
//  trusted (כבר אושר ואותו דוא"ל: כניסה ישירה) | confirm (חדש: להציג מסך אישור) | changed (הדוא"ל שונה מזה שאושר: אזהרה) | failed (אין הוכחה תקינה: לא נכנסים)
export async function checkServerIdentity({ serverUrl, fetchImpl = (...a) => fetch(...a), storage = null, now, subtle }) {
  try {
    const r = await fetchImpl(serverUrl + '?action=identity');
    const out = await r.json();
    if (!out || out.ok !== true || typeof out.token !== 'string') return { state: 'failed', reason: 'no_token' };
    const jr = await fetchImpl(JWKS_URL);
    const v = await verifyIdentityToken(out.token, { jwks: await jr.json(), now, subtle });
    if (!v.ok) return { state: 'failed', reason: v.reason };
    const known = storage ? getTrusted(storage, serverUrl) : null;
    if (known === null) return { state: 'confirm', email: v.email };
    return known === v.email ? { state: 'trusted', email: v.email } : { state: 'changed', email: v.email, previous: known };
  } catch (e) { return { state: 'failed', reason: 'network' }; }
}
