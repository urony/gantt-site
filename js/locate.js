// הועתק כמות שהוא מבדיקת היתכנות 5 (feasibility-tests/04-pdf-anchoring/public/locate.js). משמש לעיגון הצעות AI בלבד.
// POC 5: איתור ציטוט של בינה מלאכותית בטקסט ה-PDF. פונקציות טהורות (בלי DOM).
// עיקרון מחייב: אין התאמה חד-משמעית = אין עיגון. התוצאה היא anchored | ambiguous | notfound.
//
// שכבה 1 (exact/context): השוואה אחרי נרמול. מתעלמים מרווחים, מעברי שורה, סימני פיסוק וסוגריים.
//   ספרות, אותיות וסמלים בעלי משמעות (< > = % ± + / ) נשמרים, וכן נקודה/פסיק בין ספרות ומינוס/מקף בין ספרות.
//   כך 7.4% != 74% ו-p<0.05 != p>0.05.
// שכבה 2 (reordered): רק אם שכבה 1 לא מצאה כלום. מתאימה חלון מילים באותו אורך, כאשר המילים העבריות זהות
//   באותו סדר בדיוק, ורק רצפים של מילים לא-עבריות בין מילים עבריות רשאים להיות בסדר שונה (תופעת bidi ב-PDF).
// הקשר (before/after) משמש רק כדי להכריע בין כמה מופעים; אם הוא לא מכריע חד-משמעית, התוצאה ambiguous.

const DROP = /[\s ​-‏‪-‮⁦-⁩֑-ׇ﻿]/;
const KEEP_SYM = new Set(['<', '>', '=', '%', '±', '+', '×', '/', '°']);
const DASH = /[-‐-―−־]/;
const isDigit = (c) => !!c && /\p{N}/u.test(c);
const isLetter = (c) => !!c && /\p{L}/u.test(c);
const isSpace = (c) => !c || DROP.test(c);

// מחזיר מחרוזת מנורמלת + מערך מיפוי: לכל תו מנורמל, האינדקס בטקסט המקורי
export function normalize(text) {
  let out = ''; const map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (DROP.test(c)) continue;
    if (isLetter(c) || isDigit(c)) { out += c.toLowerCase(); map.push(i); continue; }
    if (KEEP_SYM.has(c)) { out += c; map.push(i); continue; }
    if (c === '.' || c === ',') { if (isDigit(text[i - 1]) && isDigit(text[i + 1])) { out += c; map.push(i); } continue; }
    if (DASH.test(c)) {
      if (isDigit(text[i - 1]) && isDigit(text[i + 1])) { out += '-'; map.push(i); }
      else if (isDigit(text[i + 1]) && (isSpace(text[i - 1]) || /[(\[]/.test(text[i - 1]))) { out += '-'; map.push(i); } // מינוס
      continue;
    }
    // כל השאר (סוגריים, גרשיים, נקודתיים, סימני פיסוק): מתעלמים
  }
  return { norm: out, map };
}

function allIndexes(hay, needle) {
  const r = []; let i = -1;
  if (!needle) return r;
  while ((i = hay.indexOf(needle, i + 1)) !== -1) r.push(i);
  return r;
}
const tail = (s, n) => s.slice(Math.max(0, s.length - n));

// בדיקת הקשר: אם הוקשר before/after, כל אחד מהם חייב להתאים (עד 30 תווים מנורמלים, הקרובים למיקום)
function contextOk(item, nText, s, e) {
  const nb = item.before ? normalize(item.before).norm : '', na = item.after ? normalize(item.after).norm : '';
  if (!nb && !na) return null; // אין הקשר
  const b = nb.slice(-30), a = na.slice(0, 30);
  const okB = !b || tail(nText.slice(0, s), b.length) === b;
  const okA = !a || nText.slice(e, e + a.length) === a;
  return okB && okA;
}

// ---- שכבה 2: טוקנים ----
// טווח מספרים ("70-99", "6.1%-9.8%") הוא טוקן אחד: סדר המספרים בתוכו נשמר ("99-70" אינו "70-99")
const TOKEN = /\p{Script=Hebrew}+|\p{N}+(?:[.,]\p{N}+)*%?(?:[-‐-―−]\p{N}+(?:[.,]\p{N}+)*%?)*|[\p{L}\p{N}]+(?:[.,]\p{N}+)*%?|[<>=±+×/%°]/gu;
const isHeb = (t) => /\p{Script=Hebrew}/u.test(t);
function tokenize(text) {
  const r = []; let m; TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) r.push({ sp: m.index > 0 && /\s/.test(text[m.index - 1]), t: m[0].toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[‐-―−]/g, '-'), s: m.index, e: m.index + m[0].length, h: isHeb(m[0]) });
  return r;
}
// מפרק לקטעים לפי מילים עבריות. בכל קטע לא-עברי מחלקים ליחידות (מילים מופרדות ברווח) ומתירים רק סדר זהה
// או היפוך מלא של סדר היחידות (כך נראה רצף לועזי שהפך בחילוץ מ-PDF). כל סידור מחדש אחר נדחה.
function segments(tokens) {
  const hebs = [], segs = [[]];
  for (const k of tokens) { if (k.h) { hebs.push(k.t); segs.push([]); } else segs[segs.length - 1].push(k); }
  const units = segs.map((seg) => { const u = []; seg.forEach((k, i) => { if (i === 0 || k.sp) u.push(k.t); else u[u.length - 1] += k.t; }); return u; });
  return { hebs: hebs.join('|'), units };
}
function sameReordered(q, w) {
  if (q.hebs !== w.hebs || q.units.length !== w.units.length) return false;
  return q.units.every((u, i) => { const a = u.join('|'), b = w.units[i].join('|'); return a === b || a === w.units[i].slice().reverse().join('|'); });
}

function reorderedHits(pages, quote) {
  const q = tokenize(quote); const N = q.length;
  if (N < 4 || q.filter((k) => k.h).length < 1) return [];
  const key = segments(q); const hits = [];
  pages.forEach((text, pi) => {
    const P = tokenize(text);
    for (let i = 0; i + N <= P.length; i++) {
      const w = P.slice(i, i + N);
      if (sameReordered(key, segments(w))) hits.push({ page: pi + 1, start: w[0].s, end: w[N - 1].e, via: 'reordered' });
    }
  });
  return hits;
}

// pages: טקסט כל עמוד (כפי שנמצא בשכבת הטקסט). item: {quote, before?, after?}
export function locate(pages, item) {
  const nq = normalize(item.quote || '').norm;
  if (nq.length < 4) return { status: 'notfound', reason: 'quote-too-short-or-empty' };
  let hits = [];
  pages.forEach((text, pi) => {
    const { norm, map } = normalize(text);
    for (const i of allIndexes(norm, nq)) {
      const s = map[i], e = map[i + nq.length - 1] + 1;
      hits.push({ page: pi + 1, start: s, end: e, via: 'exact', _n: norm, _ns: i, _ne: i + nq.length });
    }
  });
  if (!hits.length) hits = reorderedHits(pages, item.quote);
  if (!hits.length) return { status: 'notfound', reason: 'no-match' };
  const strip = (h) => ({ page: h.page, start: h.start, end: h.end, via: h.via });
  if (hits.length === 1) return { status: 'anchored', ...strip(hits[0]) };
  // כמה מופעים: מנסים להכריע לפי הקשר, ורק אם בדיוק מופע אחד מתאים
  const withCtx = hits.map((h) => {
    const text = pages[h.page - 1]; const { norm } = normalize(text);
    // ממפים את h.start/h.end לאינדקסים מנורמלים
    const ns = normalize(text.slice(0, h.start)).norm.length, ne = normalize(text.slice(0, h.end)).norm.length;
    return { h, ok: contextOk(item, norm, ns, ne) };
  });
  if (withCtx.every((x) => x.ok === null)) return { status: 'ambiguous', reason: 'multiple-no-context', candidates: hits.map(strip) };
  const good = withCtx.filter((x) => x.ok === true);
  if (good.length === 1) return { status: 'anchored', ...strip(good[0].h), via: good[0].h.via === 'exact' ? 'context' : 'reordered+context' };
  return { status: 'ambiguous', reason: good.length ? 'context-not-decisive' : 'context-matches-none', candidates: hits.map(strip) };
}
