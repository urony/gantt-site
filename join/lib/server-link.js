// קישור לשרת של מורה מסוים. בפריסה מרובת מורים כל מורה מקבל שרת משלו (Apps Script), והאתר המשותף יודע לאיזה שרת לפנות לפי הקישור
// שהמורה מעביר לתלמידיו: <כתובת האתר>/?s=<מזהה הפריסה>. כתובת השרת נבנית תמיד מהמזהה על גבי script.google.com בלבד
// (לעולם לא כתובת חופשית מהקישור), והתכונה כבויה אלא אם ההגדרה allowServerParam דלוקה.
// סיכון ידוע שנשאר להחלטת אורי: מי שמפעיל סקריפט משלו ב-Apps Script יכול ליצור קישור לשרת "מתחזה". ראו PROJECT_STATUS.md.
export const SERVER_PARAM = 's';
export const isDeploymentId = (s) => /^[A-Za-z0-9_-]{20,200}$/.test(String(s || ''));
export const execUrl = (id) => `https://script.google.com/macros/s/${id}/exec`;

// כתובת השרת לשימוש האתר: remoteUrl מפורש בהגדרה קודם (בדיקות, שרת בודד); אחרת, אם מותר, מזהה מהקישור. אחרת null = מצב דמו.
export function resolveRemoteUrl(cfg, search = '') {
  if (!cfg) return null;
  if (cfg.remoteUrl) return cfg.remoteUrl;
  if (cfg.allowServerParam) {
    const id = new URLSearchParams(search).get(SERVER_PARAM);
    if (isDeploymentId(id)) return execUrl(id);
  }
  return null;
}

// הקישור שהמורה נותן לתלמידים ולעצמו
export function appLink(appUrl, deploymentId) {
  if (!isDeploymentId(deploymentId)) throw new Error('מזהה פריסה לא תקין');
  const u = new URL(String(appUrl));
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('כתובת האתר חייבת להיות מאובטחת (https)');
  u.search = ''; u.hash = '';
  u.searchParams.set(SERVER_PARAM, deploymentId);
  return u.toString();
}
