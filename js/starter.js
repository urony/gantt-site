// נתוני התחלה למורה חדש (הקמה אמיתית): בלי תלמידים, בלי קבוצות ובלי נתוני דמה.
// מכיל מחזור ראשון ריק (המורה מגדיר לו שם ותאריכים) ואת בנק המשימות הסטנדרטי, שהמורה יכול לערוך הכול בו.
// קישורי הדמה של תבנית הדמו לא נכללים. אין החלה אוטומטית של הבנק על המחזור, כי תאריכי המחזור עוד לא הוגדרו.
import * as C from './cycles.js';
import * as T from './tasks.js';
import { TEMPLATE } from './seed.js';

export const STARTER_CYCLE_NAME = 'המחזור שלי';

export function buildStarterRoot() {
  let root = C.addCycle(C.emptyRoot(), { name: STARTER_CYCLE_NAME });
  root = C.applyToCycle(root, root.activeCycleId, (s) => {
    const ids = {};
    for (const it of TEMPLATE) {
      s = T.addTemplateItem(s, { title: it.title, kind: it.kind, startOffset: it.startOffset, duration: it.duration, weight: it.weight, dependsOn: it.dep ? [ids[it.dep]] : [], links: [], requiresSubmission: !!it.sub });
      ids[it.key] = s.taskTemplate[s.taskTemplate.length - 1].id;
    }
    return s;
  });
  return root;
}
