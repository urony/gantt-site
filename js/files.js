// קבצים אמיתיים: העלאה במקטעים, שמירה, קריאה והמרה ל-PDF. לוגיקה נקייה מעל פורטים (נבדקת ב-app/tests/files.test.mjs):
//   blobs: { put(key, text), get(key), has(key), del(key) } אחסון טקסט לפי מפתח (בשרת המקומי זיכרון, ב-Apps Script קבצי Drive)
//   codec: { head(b64, n), sha256(b64) } פענוח בסיסי של בסיס-64 (לבדיקת סוג הקובץ ולבדיקת שלמות מקטע)
//   rand(): מחרוזת אקראית בלתי ניתנת לניחוש (32 תווי hex); now(): חותמת זמן בשרת
// עקרונות:
//  * הקובץ נשמר כמקטעי בסיס-64 בגודל קבוע, כך שאפשר לשרת ולהרכיב קטעים בלי טעינת הקובץ כולו לזיכרון.
//  * כל מקטע נבדק בקבלה (אורך צפוי, תווים חוקיים, חתימת SHA-256 מהלקוח). שליחה חוזרת של אותו מקטע בטוחה (דורסת אותו ערך).
//  * העלאה שייכת למי שפתח אותה. אחרי "חתימה" (seal) אי אפשר לשנות אותה, כך שהגשה שנקלטה אינה ניתנת לדריסה.
//  * סוג הקובץ נבדק לפי התוכן (חתימת הקובץ) ולא רק לפי הסיומת.
//  * מפתח הקובץ (uploadId) אינו ניתן לניחוש, וההרשאה לקרוא נבדקת תמיד מול ההגשה (ב-api-core), לא לפי המפתח בלבד.
import { MAX_BYTES, validateFile, SubmissionError } from './submissions.js';
import { SaveError } from './store.js';

export const CHUNK_RAW = 3 * 174762; // 524,286 בייט: כפולה של 3, כדי ששרשור בסיס-64 של מקטעים תקף
export const CHUNK_B64 = (CHUNK_RAW / 3) * 4;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const extOf = (name) => (String(name).split('.').length > 1 ? String(name).split('.').pop().toLowerCase() : '');
const MAGIC = {
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  docx: [[0x50, 0x4b, 0x03, 0x04]], // zip
  doc: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE
};
// ניקוי והתראות על העלאות (חלק 5ג). כללים (נבדקים ב-app/tests/maintenance.test.mjs):
//  * לעולם לא נוגעים בקובץ שהגשה כלשהי מפנה אליו (במחזור, בסל, בגיבוי אוטומטי או בהגשה שמורה בצד).
//  * העלאה שפעילה לאחרונה לפני פחות משעה נחשבת "בהעלאה" ואינה נוגעת בה כלל.
//  * העלאה שלא נחתמה והופסקה, או שנחתמה ולא נרשמה: אחרי שעה מדווחים למורה ("ההגשה לא התקבלה"), ואינם נמחקים.
//  * העלאה שלא נחתמה ופעילה לאחרונה לפני 7 ימים ויותר נמחקת. קובץ חתום שאין אליו הפניה נמחק רק אחרי 30 יום (כמו הסל).
//  * מקטעים בלי קובץ מידע, שלא נגעו בהם 7 ימים, נמחקים. כל מחיקה היא שליחה לאשפה של Drive (ניתנת לשחזור שם).
export const UPLOAD_ACTIVE_MS = 60 * 60 * 1000;
export const UNSEALED_ABANDON_MS = 7 * 24 * 3600 * 1000;
export const SEALED_GRACE_MS = 30 * 24 * 3600 * 1000;
export const MAX_DELETES_PER_RUN = 80;

export const chunkCountFor = (size) => Math.ceil(size / CHUNK_RAW);
// אורך בסיס-64 צפוי למקטע (המקטע האחרון קצר יותר)
export function expectedB64Length(size, index) {
  const count = chunkCountFor(size);
  const raw = index < count - 1 ? CHUNK_RAW : size - CHUNK_RAW * (count - 1);
  return Math.ceil(raw / 3) * 4;
}

export class FileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function createFileService({ blobs: rawBlobs, codec, rand, now = () => new Date().toISOString(), converter = null, maxBytes = MAX_BYTES }) {
  // כל כשל באחסון (Drive לא זמין, מכסה, זמן ריצה) מוחזר כשגיאת שמירה שניתנת לניסיון חוזר, ולא כדחייה של הבקשה.
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw new SaveError(e && e.message); } };
  const blobs = { put: guard(rawBlobs.put), get: guard(rawBlobs.get), has: guard(rawBlobs.has), del: guard(rawBlobs.del), list: guard(rawBlobs.list || (async () => [])) };
  const key = (id, part) => `f/${id}/${part}`;
  const readMeta = async (id) => {
    if (!/^[a-f0-9]{32}$/.test(String(id))) throw new FileError('upload', 'העלאה לא נמצאה.');
    const raw = await blobs.get(key(id, 'meta'));
    if (!raw) throw new FileError('upload', 'העלאה לא נמצאה.');
    return JSON.parse(raw);
  };
  const writeMeta = (id, meta) => blobs.put(key(id, 'meta'), JSON.stringify(meta));
  const own = (meta, userId) => { if (!userId || meta.userId !== userId) throw new FileError('upload', 'העלאה לא נמצאה.'); };

  return {
    converterAvailable: () => !!converter,

    // פתיחת העלאה. הקובץ עצמו עדיין לא קיים. לא נוצרת הגשה.
    // bind: לְמה ההעלאה מיועדת (משימה/יחידה/הגשה). נקבע בשרת בפתיחה ואינו נלקח מהלקוח בסיום.
    async begin({ userId, purpose, fileName, size, bind = {} }) {
      const v = validateFile({ fileName, size }, purpose === 'pdf' ? ['pdf'] : undefined);
      if (!v.ok) throw new SubmissionError(v.code, v.message);
      if (Number(size) > maxBytes) throw new SubmissionError('size', 'הקובץ גדול מדי.');
      const id = rand();
      const meta = { id, userId, purpose, bind, fileName: String(fileName).trim(), size: Number(size), chunks: chunkCountFor(Number(size)), startedAt: now(), sealed: false };
      await writeMeta(id, meta);
      return { uploadId: id, chunks: meta.chunks, chunkBytes: CHUNK_RAW };
    },

    async putChunk({ userId, uploadId, index, data, sha256 }) {
      const meta = await readMeta(uploadId);
      own(meta, userId);
      if (meta.sealed) throw new FileError('sealed', 'ההעלאה כבר הסתיימה.');
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) throw new FileError('chunk', 'מקטע לא תקין.');
      if (typeof data !== 'string' || data.length !== expectedB64Length(meta.size, index) || !B64_RE.test(data)) throw new FileError('chunk', 'המקטע אינו תקין (אורך או תוכן).');
      if (index < meta.chunks - 1 && data.includes('=')) throw new FileError('chunk', 'המקטע אינו תקין.');
      if (typeof sha256 !== 'string' || (await codec.sha256(data)) !== sha256.toLowerCase()) throw new FileError('integrity', 'המקטע הגיע פגום. נסו שוב.');
      await blobs.put(key(uploadId, index), data);
      return { received: index };
    },

    // בדיקת שלמות סופית, חתימה (אין שינוי אחריה). נקרא לפני רישום ההגשה. בטוח לקרוא שוב (אחרי כשל בשמירת הרישום).
    async seal({ userId, uploadId }) {
      const meta = await readMeta(uploadId);
      own(meta, userId);
      if (meta.sealed) return { ...meta }; // חתומה: המקטעים כבר נבדקו ואינם ניתנים לשינוי
      for (let i = 0; i < meta.chunks; i++) if (!(await blobs.has(key(uploadId, i)))) throw new FileError('incomplete', `ההעלאה לא הושלמה (חסר מקטע ${i + 1} מתוך ${meta.chunks}). אפשר להמשיך מאותה נקודה.`);
      const head = await codec.head(await blobs.get(key(uploadId, 0)), 8);
      const kind = extOf(meta.fileName);
      const ok = (MAGIC[kind] || []).some((sig) => sig.every((b, i) => head[i] === b));
      if (!ok) throw new FileError('content', 'תוכן הקובץ אינו תואם לסוג שלו. ודא שזה קובץ Word או PDF תקין.');
      if (!meta.sealed) await writeMeta(uploadId, { ...meta, sealed: true, sealedAt: now() });
      return { ...meta, sealed: true };
    },

    async meta(uploadId) { return readMeta(uploadId); },

    // סריקת כל ההעלאות באחסון (קריאת רשימה אחת) והחלטה מה לדווח ומה לנקות. referenced = מזהי העלאות שהגשה כלשהי מפנה אליהן.
    async scanUploads({ referenced, nowMs = Date.now(), maxDeletes = MAX_DELETES_PER_RUN, dryRun = false }) {
      const all = await blobs.list();
      const groups = new Map();
      for (const { key: k, updatedAt } of all) {
        const m = /^f\/([a-f0-9]{32})\/(meta|\d+)$/.exec(k);
        if (!m) continue;
        const g = groups.get(m[1]) || { id: m[1], keys: [], metaAt: null, lastAt: 0 };
        g.keys.push(k); g.lastAt = Math.max(g.lastAt, updatedAt || 0);
        if (m[2] === 'meta') g.metaAt = updatedAt || 0;
        groups.set(m[1], g);
      }
      const out = { scanned: groups.size, referenced: 0, active: 0, incomplete: [], deleted: [], keptGrace: 0, capped: false };
      let ops = 0;
      const remove = async (g, why) => {
        if (ops + g.keys.length > maxDeletes && ops > 0) { out.capped = true; return; }
        if (!dryRun) { for (const k of g.keys.filter((x) => !x.endsWith('/meta'))) await rawBlobs.del(k); await rawBlobs.del(key(g.id, 'meta')); }
        ops += g.keys.length; out.deleted.push({ id: g.id, why, files: g.keys.length });
      };
      for (const g of groups.values()) {
        if (referenced.has(g.id)) { out.referenced++; continue; }
        const idle = nowMs - g.lastAt;
        if (g.metaAt === null) { if (idle >= UNSEALED_ABANDON_MS) await remove(g, 'chunks-without-info'); else out.active++; continue; }
        if (idle < UPLOAD_ACTIVE_MS) { out.active++; continue; }
        let meta; try { meta = await readMeta(g.id); } catch (e) { continue; }
        if (!meta.sealed && idle >= UNSEALED_ABANDON_MS) { await remove(g, 'abandoned'); continue; }
        if (meta.sealed && idle >= SEALED_GRACE_MS) { await remove(g, 'unregistered-old'); continue; }
        if (meta.sealed) out.keptGrace++;
        if (idle < UNSEALED_ABANDON_MS) out.incomplete.push({ uploadId: g.id, userId: meta.userId, fileName: meta.fileName, size: meta.size, purpose: meta.purpose, bind: meta.bind, startedAt: meta.startedAt, sealed: !!meta.sealed, idleMs: idle });
      }
      return out;
    },

    // האם הקבצים של הגשה קיימים באחסון בפועל (לשחזור): קובץ המקור במלואו, וה-PDF לפחות במקטע הראשון. לפי רשימת קבצים אחת.
    async existenceChecker() {
      const names = new Set((await blobs.list()).map((x) => x.key));
      const has = (id, n) => names.has(key(id, 'meta')) && Array.from({ length: n }, (_, i) => names.has(key(id, i))).every(Boolean);
      return (sub) => {
        if (!sub) return false;
        if (!sub.fileKey) return true; // הגשת דמו בלי קובץ: אין מה לבדוק (בשרת אמיתי לכל הגשה יש קובץ)
        if (!has(sub.fileKey, Math.max(1, chunkCountFor(Number(sub.size) || 1)))) return false;
        const c = sub.conversion || {};
        return c.status === 'done' && c.pdfKey && c.pdfKey !== sub.fileKey ? has(c.pdfKey, 1) : true;
      };
    },

    // קריאת מקטע: ההרשאה נבדקת בקורא (api-core) מול ההגשה.
    async readChunk(fileKey, index) {
      const meta = await readMeta(fileKey);
      if (!meta.sealed) throw new FileError('upload', 'הקובץ אינו זמין.');
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) throw new FileError('chunk', 'מקטע לא תקין.');
      const data = await blobs.get(key(fileKey, index));
      if (data == null) throw new FileError('missing', 'הקובץ חסר באחסון. פנו למורה.');
      return { data, index, chunks: meta.chunks, size: meta.size, fileName: meta.fileName, sha256: await codec.sha256(data) };
    },

    async readWhole(fileKey) {
      const meta = await readMeta(fileKey);
      let out = '';
      for (let i = 0; i < meta.chunks; i++) out += await blobs.get(key(fileKey, i));
      return { data: out, meta };
    },

    async remove(fileKey) {
      let meta; try { meta = await readMeta(fileKey); } catch (e) { return; }
      for (let i = 0; i < meta.chunks; i++) await blobs.del(key(fileKey, i));
      await blobs.del(key(fileKey, 'meta'));
    },

    // המרה ל-PDF. מחזיר { ok, pdfKey, pdfName, pdfSource } או { ok:false, error }. אינו זורק על כשל המרה (ההגשה נשמרת בכל מקרה).
    async convert({ fileKey, fileName, userId }) {
      let outId = null; let written = 0;
      try {
        if (extOf(fileName) === 'pdf') return { ok: true, pdfKey: fileKey, pdfName: fileName, pdfSource: 'source' };
        if (!converter) return { ok: false, error: 'ההמרה האוטומטית אינה פעילה בסביבה הזו. אפשר לצרף PDF.' };
        const { data } = await this.readWhole(fileKey);
        const pdfB64 = await converter.toPdf({ data, ext: extOf(fileName), name: fileName });
        if (typeof pdfB64 !== 'string' || !B64_RE.test(pdfB64) || pdfB64.length < 8) throw new Error('תוצאת המרה ריקה');
        const head = await codec.head(pdfB64, 5);
        if (!MAGIC.pdf[0].every((b, i) => head[i] === b)) throw new Error('תוצאת ההמרה אינה PDF');
        const raw = Math.floor((pdfB64.length / 4) * 3) - (pdfB64.endsWith('==') ? 2 : pdfB64.endsWith('=') ? 1 : 0);
        const id = rand(); outId = id;
        const chunks = Math.ceil(pdfB64.length / CHUNK_B64);
        for (let i = 0; i < chunks; i++) { await blobs.put(key(id, i), pdfB64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64)); written = i + 1; }
        const pdfName = String(fileName).replace(/\.[^.]+$/, '') + '.pdf';
        await writeMeta(id, { id, userId, purpose: 'converted', fileName: pdfName, size: raw, chunks, startedAt: now(), sealed: true, sealedAt: now() });
        return { ok: true, pdfKey: id, pdfName, pdfSource: 'converted' };
      } catch (e) {
        // כשל באמצע כתיבת ה-PDF: מנקים את המקטעים שנכתבו, כדי שלא יישארו קבצים יתומים
        if (outId) { for (let i = 0; i < written + 1; i++) { try { await rawBlobs.del(key(outId, i)); } catch (e2) { /* ינוקה בסריקה */ } } try { await rawBlobs.del(key(outId, 'meta')); } catch (e2) { /* אין meta */ } }
        return { ok: false, error: 'ההמרה ל-PDF נכשלה' };
      }
    },
  };
}
