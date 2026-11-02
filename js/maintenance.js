// תחזוקה (חלק 5ג): אילו קבצים בדרייב "בשימוש" ואילו נחשבים יתומים. לוגיקה טהורה, נבדקת ב-app/tests/maintenance.test.mjs.
// קובץ בשימוש = מפנה אליו הגשה כלשהי במחזור, בסל המחזורים, בגיבוי אוטומטי (כדי שאפשר יהיה לחזור אחורה) או בהגשה ששמורה בצד.
const ids = (subs, into) => {
  for (const s of subs || []) {
    if (s && s.fileKey) into.add(s.fileKey);
    if (s && s.conversion && s.conversion.pdfKey) into.add(s.conversion.pdfKey);
  }
};

export function referencedUploadIds(root) {
  const set = new Set();
  for (const c of root.cycles || []) ids(c.data && c.data.submissions, set);
  for (const t of root.trashCycles || []) ids(t.cycle && t.cycle.data && t.cycle.data.submissions, set);
  for (const a of root.autoBackups || []) ids(a.backup && a.backup.data && a.backup.data.submissions, set);
  for (const h of root.heldSubmissions || []) ids([h.sub], set);
  return set;
}

// זמן בתוך טקסט התראה: הלקוח מציג אותו בשעה המקומית של המורה ({{t:ISO}}), כך שהטקסט השמור אינו תלוי באזור זמן.
const tt = (at) => (at ? ` (הועלה {{t:${at}}})` : '');

// שורת התראה למורה על העלאה שלא הושלמה. ההגשה לא נקלטה, והנוסח אומר זאת במפורש.
export function incompleteText({ who, fileName, taskTitle, sealed, at }) {
  const t = taskTitle ? `ל"${taskTitle}"` : '';
  return sealed
    ? `ההגשה ${t} של ${who} לא נקלטה: הקובץ "${fileName}"${tt(at)} הועלה אך לא נרשם כהגשה. אין הגשה עד שהתלמיד ילחץ שוב על "שלח את ההגשה".`
    : `ההגשה ${t} של ${who} לא נקלטה: ההעלאה של "${fileName}"${tt(at)} נקטעה ולא הושלמה. אין הגשה עד שהתלמיד יעלה את הקובץ שוב.`;
}

// התראה אחת מסכמת לכל מחזור במקום התראה לכל העלאה (בכיתה, או אחרי בדיקות, היו נערמות עשרות).
export const SUMMARY_KEY = 'incomplete:summary';
const SHOWN = 8;
export function incompleteSummaryText(items) {
  if (items.length === 1) return incompleteText(items[0]);
  const rows = items.slice(0, SHOWN).map((x) => `• ${x.who}${x.taskTitle ? ` · ${x.taskTitle}` : ''} · ${x.fileName}${tt(x.at)}`);
  const more = items.length > SHOWN ? `\nועוד ${items.length - SHOWN}.` : '';
  return `${items.length} העלאות לא הושלמו ולא נקלטו כהגשה. אין הגשה עד שהתלמיד יעלה שוב:\n${rows.join('\n')}${more}`;
}

// העלאה שאחריה התלמיד (או הקבוצה) הגישו בהצלחה באותה משימה אינה דורשת טיפול: התלמיד הצליח בסוף.
export function supersededBy(subs, meta) {
  const b = (meta && meta.bind) || {};
  const at = Date.parse(meta && meta.startedAt) || 0;
  return (subs || []).some((s) => s.taskId === b.taskId && s.unitType === b.unitType && s.unitId === b.unitId && Date.parse(s.uploadedAt) >= at);
}
