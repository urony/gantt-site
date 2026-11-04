// כתובת מדריך המורה. ברירת מחדל: תיקיית guide/ באותו אתר שממנו נטענת האפליקציה (כתובת קבועה, ללא כתובת מקומית שרירותית).
// אפשר להגדיר כתובת אחרת ב-config: window.GANTT_CONFIG = { guideUrl: 'https://...' } (רק http/https).
// הקישור מוצג במסכי המורה בלבד. האתר סטטי, ולכן הדף עצמו אינו מוגן בסיסמה: אין בו מידע אישי, והוא מסומן שלא יאונדקס.
export const GUIDE_PATH = 'guide/';

export function resolveGuideUrl(cfg, pageUrl) {
  const custom = cfg && typeof cfg.guideUrl === 'string' ? cfg.guideUrl.trim() : '';
  if (custom) {
    if (!/^https?:\/\/[^\s/]+/i.test(custom)) return '';
    return custom;
  }
  try {
    const u = new URL(pageUrl);
    u.search = ''; u.hash = '';
    return new URL(GUIDE_PATH, u.href).href;
  } catch (e) { return ''; }
}
