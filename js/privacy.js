// סורק פרטיות בסיסי. לוגיקה טהורה (נבדקת ב-app/tests), ללא רשת.
// שתי רמות בלבד (החלטת המורה, פשוט בכוונה):
//  * חוסם: מידע מזהה ברור (מספר זהות תקין, טלפון, דוא"ל, תווית מזהה כמו "שם המטופל"), או צירוף של לפחות שני סוגי פרטים חלשים
//    שיוצר חשד ממשי (תאריך לידה, מספר 9 ספרות לא תקין, ביטוי כמו "מתגורר ב"). חוסם = המסמך עובר להסגר. אין עקיפה בנימוק.
//  * חלש: גיל בלבד, תאריך בלבד, מספר שאינו זהות תקינה, תיאור רפואי כללי. מוצג כהערה בלבד ואינו חוסם.
// מגבלה מחייבת: הסורק מאתר דפוסים מוכרים בלבד. הוא לא מזהה שם פרטי בודד, תיאור מקרה ייחודי או מידע שנכתב בצורה לא צפויה.
// לכן "לא זוהה" אינו "בטוח" ואינו תחליף לבדיקת הפרטיות המלאה (בדיקה 0.1), שתבוצע לפני חיבור לספק חיצוני.
// הערכים האפשריים: blocked, not-scannable, not-detected (ו-weak-only כשיש רק הערות חלשות). אין ערך שמשמעותו "בטוח".

export const NOT_A_SAFETY_CHECK = 'בדיקה בסיסית לדפוסים מוכרים בלבד. היא אינה מבטיחה שהמסמך נקי ממידע מזהה, ואינה תחליף להסגר המלא (בדיקה 0.1).';
export const NOT_DETECTED_TEXT = 'לא זוהה מידע רגיש בבדיקה בסיסית. זה לא אומר שהמסמך בטוח.';
export const STUDENT_PRIVACY_NOTICE = 'אין לכלול במסמך פרטים מזהים של מטופלים אמיתיים: שם, מספר זהות, טלפון, כתובת, תאריך לידה או מספר תיק. אם תיארתם מקרה, שנו או השמיטו כל פרט שיכול לזהות אדם.';

const KIND_LABEL = {
  id: 'מספר זהות אפשרי',
  phone: 'מספר טלפון',
  email: 'כתובת דוא"ל',
  birthdate: 'תאריך לידה',
  age: 'גיל',
  patient: 'ביטוי שעלול לחשוף מטופל',
  combo: 'צירוף פרטים שיוצר חשד לזיהוי מטופל',
};

// תוויות שמצביעות ישירות על פרטי מטופל: חוסמות
const STRONG_PHRASES = [
  'שם המטופל', 'שם המטופלת', 'שם החולה', 'שמו של המטופל', 'שמה של המטופלת',
  'מספר תיק רפואי', 'תיק רפואי מספר', 'מספר מטופל', 'כתובת המטופל', 'כתובת המגורים',
  'ת.ז. של', 'תעודת זהות של',
];
// ביטויים נפוצים גם בתיאורי מקרה כלליים: חלשים. רק צירוף שלהם עם פרט חלש מסוג אחר חוסם.
const WEAK_PHRASES = [
  'מתגורר ב', 'מתגוררת ב', 'אושפז ב', 'אושפזה ב', 'מאושפז ב', 'מאושפזת ב', 'נולד ב', 'נולדה ב', 'תאריך לידה',
  'המטופל שלי', 'המטופלת שלי', 'החולה שלי', 'סבא שלי', 'סבתא שלי', 'אבא שלי', 'אמא שלי', 'אחותי',
  'בן משפחה שלי', 'קרוב משפחה שלי', 'השכן שלי', 'השכנה שלי', 'ביקרתי את', 'פגשתי את',
];
const AGE_RE = /(?:^|[\s,.(])(?:בן|בת)\s+\d{1,3}(?=[\s,.)]|$)/g;

const stripSeps = (s) => s.replace(/[\s-]/g, '');

function idChecksumOk(d) {
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) { let v = Number(d[i]) * (i % 2 === 0 ? 1 : 2); if (v > 9) v -= 9; sum += v; }
  return sum % 10 === 0;
}

const maskMatch = (s) => {
  const t = String(s).trim();
  if (t.length <= 4) return '••••';
  return t.slice(0, 2) + '•'.repeat(Math.min(6, t.length - 4)) + t.slice(-2);
};

function pushAll(out, kind, text, re, pageNo, transform) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const f = transform ? transform(m) : { start: m.index, end: m.index + m[0].length, text: m[0], level: 'block' };
    if (!f) continue;
    out.push({ kind, label: KIND_LABEL[kind], page: pageNo, start: f.start, end: f.end, preview: kind === 'patient' ? f.text : maskMatch(f.text), level: f.level });
  }
}

// ממצאים בעמוד אחד. level: 'block' | 'weak'
export function scanText(text, pageNo = 1) {
  const out = [];
  const t = String(text || '');
  pushAll(out, 'id', t, /(?<![\d.,])(\d[\d\s-]{7,12}\d)(?![\d])/g, pageNo, (m) => {
    const d = stripSeps(m[1]);
    if (d.length !== 9) return null;
    return { start: m.index, end: m.index + m[0].length, text: m[1], level: idChecksumOk(d) ? 'block' : 'weak' };
  });
  pushAll(out, 'phone', t, /(?<![\d])(?:\+?972[\s-]?|0)(?:5\d|[2-4689]|7\d)[\s-]?\d{3}[\s-]?\d{4}(?![\d])/g, pageNo);
  pushAll(out, 'email', t, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, pageNo);
  pushAll(out, 'birthdate', t, /(?<![\d])(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}(?![\d])/g, pageNo, (m) => ({ start: m.index, end: m.index + m[0].length, text: m[0], level: 'weak' }));
  for (const [list, level] of [[STRONG_PHRASES, 'block'], [WEAK_PHRASES, 'weak']]) {
    for (const p of list) {
      let i = -1;
      while ((i = t.indexOf(p, i + 1)) !== -1) {
        const prev = t[i - 1];
        if (prev && /\p{L}/u.test(prev) && !/[הוולבכלמש]/.test(prev)) continue;
        out.push({ kind: 'patient', label: KIND_LABEL.patient, page: pageNo, start: i, end: i + p.length, preview: p, level });
      }
    }
  }
  pushAll(out, 'age', t, AGE_RE, pageNo, (m) => ({ start: m.index, end: m.index + m[0].length, text: m[0].trim(), level: 'weak' }));
  return out.sort((a, b) => a.page - b.page || a.start - b.start);
}

// סוגי פרטים חלשים שנספרים לצירוף. גיל בלבד אינו נספר: הוא נפוץ בתיאורי מקרה כלליים.
const COMBO_KINDS = new Set(['id', 'birthdate', 'patient']);

export function scanPages(pages) {
  const all = pages.flatMap((p, i) => scanText(p, i + 1));
  const weakKinds = new Set(all.filter((f) => f.level === 'weak' && COMBO_KINDS.has(f.kind)).map((f) => f.kind));
  const blocking = all.filter((f) => f.level === 'block');
  if (weakKinds.size >= 2) blocking.push({ kind: 'combo', label: KIND_LABEL.combo, page: 0, start: 0, end: 0, preview: [...weakKinds].map((k) => KIND_LABEL[k]).join(' + '), level: 'block' });
  const weak = all.filter((f) => f.level === 'weak');
  const chars = pages.reduce((n, p) => n + String(p || '').length, 0);
  const blind = chars < 20;
  const verdict = blocking.length ? 'blocked' : blind ? 'not-scannable' : weak.length ? 'weak-only' : 'not-detected';
  const headline = verdict === 'blocked' ? `זוהה מידע מזהה או חשד ממשי לזיהוי (${blocking.length}): ההפעלה נחסמה והמסמך הועבר להסגר`
    : verdict === 'not-scannable' ? 'לא נמצא טקסט לבדיקה (ייתכן שהמסמך סרוק כתמונה). הסורק לא בדק דבר.'
      : verdict === 'weak-only' ? `לא זוהה מידע מזהה ברור. יש ${weak.length} פרטים חלשים לתשומת לב (אינם חוסמים). ${NOT_DETECTED_TEXT}`
        : NOT_DETECTED_TEXT;
  return { verdict, blocking, weak, findings: [...blocking, ...weak], headline, caveat: NOT_A_SAFETY_CHECK, scannedPages: pages.length, scannedChars: chars };
}
