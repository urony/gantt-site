// הרכבת קובץ ה-Shell של שרת המורה מהתבנית (gas/shell.gs) ושל המניפסט של הפרויקט. לוגיקה טהורה, בלי תלות ב-Node, כדי ששני הצדדים ישתמשו באותו קוד:
// כלי הבנייה (tools/) והמשגר שרץ בדפדפן של המורה (launcher/). הערכים נכנסים לקוד שיורץ אצל המורה, ולכן הקלט נבדק.
export const SERVER_SCOPES = [
  'https://www.googleapis.com/auth/drive', // שמירת כל הנתונים והקבצים בתיקיית המערכת של המורה
  'https://www.googleapis.com/auth/script.external_request', // פנייה ל-Google לאימות תעודת זהות, ול-GitHub Pages לעדכונים
  'https://www.googleapis.com/auth/userinfo.email', // זיהוי בעל הסקריפט (המורה)
];
export const SHELL_EXTRA_SCOPES = [
  'https://www.googleapis.com/auth/script.projects', // קריאה וכתיבה של קבצי הפרויקט (עדכון עצמי של הקוד)
  'https://www.googleapis.com/auth/script.deployments', // פריסה מחדש לאותה כתובת
  'https://www.googleapis.com/auth/script.scriptapp', // טריגר מתוזמן לבדיקת עדכון
];

export function renderShellText(template, { updatesUrl, quotaProject, triggerEveryMin = 0, publicKey } = {}) {
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]*[/=]latest\.json$/.test(String(updatesUrl || ''))) throw new Error('כתובת העדכונים לא תקינה (אמורה להסתיים ב-latest.json)');
  if (!/^\d{6,15}$/.test(String(quotaProject || ''))) throw new Error('מספר פרויקט ענן לא תקין');
  if (![0, 1, 5, 10, 15, 30].includes(Number(triggerEveryMin))) throw new Error('תדירות טריגר לא תקינה');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(publicKey || ''))) throw new Error('מפתח ציבורי לא תקין');
  if (typeof template !== 'string' || !template.includes('__UPDATES_URL__')) throw new Error('תבנית המעטפת לא תקינה');
  return template.split('__UPDATES_URL__').join(updatesUrl).split('__QUOTA_PROJECT__').join(String(quotaProject)).split('__TRIGGER_EVERY_MIN__').join(String(Number(triggerEveryMin))).split('__PUBLIC_KEY__').join(publicKey);
}

// מניפסט של שרת עצמאי: בלי ספרייה חיצונית. כל הקוד נמצא בפרויקט של המורה.
export function standaloneManifest() {
  return {
    timeZone: 'Asia/Jerusalem', runtimeVersion: 'V8', exceptionLogging: 'STACKDRIVER',
    dependencies: { enabledAdvancedServices: [{ userSymbol: 'Drive', serviceId: 'drive', version: 'v3' }] },
    webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
    oauthScopes: [...SERVER_SCOPES, ...SHELL_EXTRA_SCOPES],
  };
}
