// תצוגה אופטימית: המצב מהשרת + פעולות שממתינות (או כשלו) בתור השמירה, באותה לוגיקה טהורה שהשרת מריץ (review.js, notes.js).
// כך המורה רואה מיד את ההערה שהוסיף, עורך אותה ומוחק אותה, גם לפני שהשרת אישר. הערה שעדיין לא נשמרה מסומנת `_pending: true`,
// ושכשלה `_failed: <הודעה>`. התוצאה אינה נשמרת לשום מקום: היא נגזרת מחדש מהמצב ומהתור.
import * as R from './review.js';
import * as NB from './notes.js';

const flag = (obj, f) => Object.assign(obj, f);

export function applyPending(state, session, ops, failed = []) {
  if (!state || (!ops.length && !failed.length)) return state;
  let s = state;
  const pendingIds = new Set(); const failedMsg = new Map();
  const step = (op, mark) => {
    try {
      if (op.action === 'addComment') {
        const d = op.args[0] || {};
        const next = R.addComment(s, session, d);
        if (next !== s) s = next;
        if (d.id) mark(d.id);
      } else if (op.action === 'updateComment') { s = R.updateComment(s, session, op.args[0], op.args[1] || {}); mark(op.args[0]); }
      else if (op.action === 'deleteComment') { s = R.deleteComment(s, session, op.args[0]); }
      else if (op.action === 'addNote' || op.action === 'updateNote' || op.action === 'setNoteStatus' || op.action === 'deleteNote') {
        const book = NB.normalizeBook(s.notesBook);
        let nb = book;
        if (op.action === 'addNote') nb = NB.addNote(book, session, op.args[0]);
        else if (op.action === 'updateNote') nb = NB.updateNote(book, session, op.args[0], op.args[1] || {});
        else if (op.action === 'setNoteStatus') nb = NB.setStatus(book, session, op.args[0], op.args[1]);
        else nb = NB.deleteNote(book, session, op.args[0]);
        s = { ...s, notesBook: nb };
        mark(op.action === 'addNote' ? (op.args[0] || {}).id : op.args[0]);
      }
    } catch (e) { /* פעולה שאינה חלה על המצב (השרת ידחה אותה גם הוא); אין מה להציג */ }
  };
  for (const op of ops) step(op, (id) => pendingIds.add(id));
  for (const op of failed) step(op, (id) => failedMsg.set(id, op.message || 'נכשלה'));
  if (s === state) return state;
  // סימון הפריטים: מעתיקים רק את מה שסומן
  const tag = (list) => list.map((x) => (failedMsg.has(x.id) ? flag({ ...x }, { _failed: failedMsg.get(x.id) }) : pendingIds.has(x.id) ? flag({ ...x }, { _pending: true }) : x));
  const out = { ...s };
  if (s.comments !== state.comments) out.comments = tag(s.comments);
  if (s.notesBook !== state.notesBook) out.notesBook = { ...s.notesBook, items: tag(s.notesBook.items) };
  return out;
}

// האם ההשפעה של פעולה נראית במצב (לאימות אחרי אישור כפול מהשרת)
export function effectVisible(op, state) {
  if (!state) return false;
  if (op.action === 'addComment') { const id = (op.args[0] || {}).id; return !id || (state.comments || []).some((c) => c.id === id); }
  if (op.action === 'addNote') { const id = (op.args[0] || {}).id; return !id || NB.normalizeBook(state.notesBook).items.some((n) => n.id === id); }
  return true;
}
