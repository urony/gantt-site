// הורדה ואימות של חבילת ההתקנה/העדכון הנוכחית מכתובת העדכונים (GitHub Pages), עבור המשגר. הלוגיקה של האימות משותפת עם השרת (update-package.js).
// fetchText(url) ו-sha256Hex(text) מוזרקים (בדפדפן: fetch ו-crypto.subtle). שום דבר לא נכתב: מחזיר { payload, pkg } מאומתים, או זורק שגיאה בעברית.
import { parseRelease, validatePackage } from './update-package.js';

const fail = (code, text) => { const e = new Error(text); e.code = code; return e; };

export async function loadVerifiedPackage({ updatesUrl, publicKey, fetchText, sha256Hex, deps }) {
  let latest;
  try { latest = await fetchText(updatesUrl); } catch (e) { throw fail('package_unavailable', 'לא הצלחנו להגיע לשרת העדכונים. בדקו חיבור לאינטרנט ונסו שוב.'); }
  const rel = parseRelease(latest, publicKey, deps);
  if (!rel.ok) throw fail('package_untrusted', 'קובץ הגרסאות לא עבר אימות חתימה (' + rel.reason + '). מטעמי בטיחות לא ממשיכים. פנו לאורי.');
  const p = rel.payload;
  let text;
  try { text = await fetchText(updatesUrl.replace(/latest\.json$/, p.pkg)); } catch (e) { throw fail('package_unavailable', 'לא הצלחנו להוריד את קוד המערכת. נסו שוב בעוד רגע.'); }
  if ((await sha256Hex(text)) !== p.sha256) throw fail('package_untrusted', 'קוד המערכת שהורד אינו תואם לחתימה. מטעמי בטיחות לא ממשיכים. פנו לאורי.');
  let pkg;
  try { pkg = JSON.parse(text); } catch (e) { throw fail('package_untrusted', 'קוד המערכת פגום. פנו לאורי.'); }
  const problems = validatePackage(pkg, p, null);
  if (problems.length) throw fail('package_untrusted', 'חבילת המערכת אינה תקינה: ' + problems[0]);
  return { payload: p, pkg };
}
