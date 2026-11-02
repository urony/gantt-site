// גרסת הפרוטוקול בין האתר (לקוח) לשרת של המורה. האתר מתעדכן מיד אצל כולם, ושרת כל מורה מתעדכן בהדרגה (5%, 25%, 100%),
// ולכן שני הצדדים חייבים להבין זה את זה בטווח גרסאות (COMPATIBILITY_POLICY.md, סעיף 6).
//  * API_VERSION: הגרסה שהבנייה הזאת "מדברת". מעלים אותה רק כשמשתנה חוזה הבקשות/תשובות באופן שגרסה ישנה אינה מבינה.
//  * MIN_CLIENT_API: הלקוח הישן ביותר שהשרת עדיין משרת. לקוח ישן יותר מקבל client_outdated ("לטעון מחדש").
//  * MIN_SERVER_API: השרת הישן ביותר שהלקוח עדיין עובד איתו. שרת ישן יותר מקבל server_outdated ("המורה עדיין לא עודכן").
// חסר מספר (לקוח או שרת מלפני המנגנון) נחשב גרסה 1.
export const API_VERSION = 2;
export const MIN_CLIENT_API = 1;
export const MIN_SERVER_API = 1;
export const LEGACY_API = 1;

export const CLIENT_OUTDATED_MESSAGE = 'גרסת האתר שנטענה אצלך ישנה מדי. יש לרענן את הדף (Ctrl+F5) ואז להיכנס שוב.';
export const SERVER_OUTDATED_MESSAGE = 'המערכת של המורה עדיין לא עודכנה לגרסה החדשה, והעדכון מתפשט בהדרגה. נסו שוב בעוד זמן קצר; אם זה נמשך, פנו למורה.';

export const apiOf = (v) => (Number.isInteger(v) && v >= 1 ? v : LEGACY_API);
