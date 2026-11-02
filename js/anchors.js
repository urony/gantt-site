// עיגון הערה לקטע טקסט ב-PDF: פונקציות טהורות (בלי DOM), מבוססות על השיטה שהוכחה בבדיקת היתכנות 4.
// הערה נשמרת עם עמוד, מיקום בטקסט העמוד, ציטוט מילולי והקשר קצר לפני ואחרי. בפתיחה מחדש:
//  1. אם במיקום המקורי עדיין נמצא אותו ציטוט: עיגון מדויק.
//  2. אחרת מחפשים את הציטוט בעמוד: מופע יחיד מאותר מחדש; כמה מופעים מוכרעים לפי ההקשר, ורק אם בדיוק אחד מתאים.
//  3. אחרת אין עיגון (unresolved): ההערה מוצגת כהערה כללית מסומנת. לעולם לא מנחשים מיקום.
export const CONTEXT_LEN = 24;

export function makeAnchor(page, text, start, end) {
  return {
    page, start, end, quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: text.slice(end, end + CONTEXT_LEN),
  };
}

export function resolveAnchor(a, text) {
  if (!a || !a.quote) return { status: 'unresolved', reason: 'noanchor' };
  if (text.slice(a.start, a.end) === a.quote) return { status: 'exact', start: a.start, end: a.end };
  const hits = [];
  let i = -1;
  while ((i = text.indexOf(a.quote, i + 1)) !== -1) hits.push(i);
  if (hits.length === 1) return { status: 'relocated', start: hits[0], end: hits[0] + a.quote.length };
  const ctx = hits.filter((h) => text.slice(Math.max(0, h - (a.prefix || '').length), h) === (a.prefix || '')
    && text.slice(h + a.quote.length, h + a.quote.length + (a.suffix || '').length) === (a.suffix || ''));
  if (ctx.length === 1) return { status: 'relocated', start: ctx[0], end: ctx[0] + a.quote.length };
  return { status: 'unresolved', reason: hits.length ? 'ambiguous' : 'missing' };
}
