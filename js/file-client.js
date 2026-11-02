// צד הלקוח של קבצים אמיתיים: העלאה במקטעים (עם המשך מאותה נקודה) והורדה. עובד מול api (remote). נבדק ב-app/tests/file-client.test.mjs.
// סדר ההגשה: פתיחה (בדיקות מראש בשרת), מקטעים עם חתימת SHA-256 לכל מקטע, סיום (השרת בודק, חותם ורק אז רושם את ההגשה), ואז המרה בנפרד.
// ניתוק או כשל באמצע: ההגשה אינה נרשמת. בניסיון חוזר עם אותו קובץ ממשיכים מהמקטע הבא בלי להעלות מחדש מה שכבר הועלה.
export const CHUNK_RAW = 3 * 174762; // חייב להיות זהה לשרת (files.js). השרת מחזיר את הערך הנכון בפתיחה, וכאן משמש רק כברירת מחדל.

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const sha256 = async (u8) => toHex(await crypto.subtle.digest('SHA-256', u8));

// העלאות פתוחות שנקטעו, לפי הקובץ (שם, גודל, תאריך שינוי) והיעד, כדי להמשיך אותן
const open = new Map();
const keyOf = (file, target) => [target, file.name, file.size, file.lastModified || 0].join('|');

// target: { kind: 'source', taskId, unitType, unitId } או { kind: 'pdf', subId }
// מחזיר { uploadId, state } אחרי שהסיום אושר. onProgress({ done, total }) מדווח התקדמות.
// מקטעים נשלחים במקביל (עד concurrency): בשרת Apps Script כל בקשה לוקחת כמה שניות, והמקטעים עצמאיים (קבצים נפרדים, ללא נעילה).
export async function runPool(items, limit, worker) {
  let next = 0; let failure = null;
  const lane = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (e) { if (!failure) failure = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure) throw failure;
}

export async function uploadFile(api, target, file, { onProgress = () => {}, concurrency = 4 } = {}) {
  const k = keyOf(file, JSON.stringify(target));
  let up = open.get(k);
  if (!up) {
    const b = target.kind === 'pdf'
      ? await api.beginPdfUpload(target.subId, { fileName: file.name, size: file.size })
      : await api.beginUpload(target.taskId, target.unitType, target.unitId, { fileName: file.name, size: file.size });
    up = { uploadId: b.uploadId, chunks: b.chunks, chunkBytes: b.chunkBytes || CHUNK_RAW, done: new Set() };
    open.set(k, up);
  }
  onProgress({ done: up.done.size, total: up.chunks });
  try {
    const todo = []; for (let i = 0; i < up.chunks; i++) if (!up.done.has(i)) todo.push(i);
    await runPool(todo, concurrency, async (i) => {
      const part = new Uint8Array(await file.slice(i * up.chunkBytes, (i + 1) * up.chunkBytes).arrayBuffer());
      await api.uploadChunk(up.uploadId, i, toBase64(part), await sha256(part)); // כשל זמני: ההעלאה נשארת פתוחה וממשיכים ממנה
      up.done.add(i);
      onProgress({ done: up.done.size, total: up.chunks });
    });
    await api.sealUpload(up.uploadId); // הבדיקה הכבדה, מחוץ לנעילה
    const state = await api.finishUpload(up.uploadId); // רישום קצר בלבד
    open.delete(k);
    return { uploadId: up.uploadId, state };
  } catch (e) {
    if (!e || !e.retryable) open.delete(k); // כשל קבוע (קובץ לא תקין, ההעלאה אינה קיימת): הניסיון הבא מתחיל מחדש
    throw e;
  }
}
export const abandonUploads = () => open.clear();

// הורדת קובץ של הגשה (kind: 'source' | 'pdf') כ-Uint8Array, עם בדיקת שלמות לכל מקטע. המקטע הראשון קובע את מספר המקטעים, השאר במקביל.
export async function downloadFile(api, subId, kind, { onProgress = () => {}, concurrency = 4 } = {}) {
  const first = await api.readFileChunk(subId, kind, 0);
  const total = first.chunks; const parts = new Array(total); let done = 0;
  const take = async (i, r) => {
    const u = fromBase64(r.data);
    if (r.sha256 && (await sha256(u)) !== r.sha256) throw new Error('הקובץ הורד פגום. נסו שוב.');
    parts[i] = u; onProgress({ done: ++done, total });
  };
  await take(0, first);
  const rest = []; for (let i = 1; i < total; i++) rest.push(i);
  await runPool(rest, concurrency, async (i) => take(i, await api.readFileChunk(subId, kind, i)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
