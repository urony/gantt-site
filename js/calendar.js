// לוח שנה שבועי וחודשי (מימין לשמאל, שבוע מתחיל ביום ראשון). מציג משימות לפי תאריכי התחלה וסיום, וחופשות.
import { escapeHtml as esc } from './logic.js';
import * as T from './tasks.js';
import { buildRows } from './gantt.js';
import { adminEventsOnDay } from './admin-events.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const dow = (d) => new Date(T.D.parse(d)).getUTCDay(); // 0 = ראשון
export const startOfWeek = (d) => T.D.add(d, -dow(d));

export function shiftAnchor(anchor, view, dir) {
  if (view === 'week') return T.D.add(anchor, 7 * dir);
  const [y, m] = anchor.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + dir, 1));
  return T.D.fmt(d.getTime());
}

export function renderCalendar(state, { filter, view, anchor, detail = 'points' }) {
  const rows = buildRows(state, filter);
  let first;
  let count;
  let title;
  if (view === 'week') {
    first = startOfWeek(anchor);
    count = 7;
    title = `שבוע ${first} עד ${T.D.add(first, 6)}`;
  } else {
    const [y, m] = anchor.split('-').map(Number);
    const m1 = `${y}-${String(m).padStart(2, '0')}-01`;
    first = startOfWeek(m1);
    const last = new Date(Date.UTC(y, m, 0));
    count = Math.ceil((T.D.diff(T.D.fmt(last.getTime()), first) + 1) / 7) * 7;
    title = `${MONTHS[m - 1]} ${y}`;
  }
  const month = view === 'week' ? null : anchor.slice(0, 7);
  const today = T.D.today();
  const cells = [];
  for (let i = 0; i < count; i++) {
    const day = T.D.add(first, i);
    const vacs = T.vacationsOnDay(state, day);
    // ברירת מחדל ("points"): רק מועדי הגשה וסיום. "full": כל יום שבו המשימה פעילה.
    const items = rows.filter((r) => (detail === 'full' ? r.start <= day && day <= r.due : r.due === day));
    const max = view === 'week' ? 40 : 4;
    const chips = items.slice(0, max).map((r) => {
      const edge = r.start === day ? 'start' : r.due === day ? 'due' : '';
      const mark = r.due === day ? '⏰ ' : r.start === day ? '▶ ' : '';
      const tip = r.due === day ? 'מועד הגשה' : r.start === day ? 'תחילת משימה' : 'משימה פעילה';
      return `<button class="cal-chip k-${r.task.kind} ${edge}" data-task="${esc(r.task.id)}" style="${r.color ? `--bc:${esc(r.color)}` : ''}" title="${esc(`${r.task.title} (${tip})`)}">${mark}${esc(r.task.title)}</button>`;
    }).join('');
    const more = items.length > max ? `<span class="muted cal-more">ועוד ${items.length - max}</span>` : '';
    // תזכורות מנהלתיות (למורה בלבד, בתצוגת כל הכיתה): צ'יפ בתחילת החלון ובסופו, והצללה עדינה לאורך החלון
    const adm = filter.type === 'class' ? adminEventsOnDay(state, day) : [];
    const admChips = adm.filter((e) => e.start === day || e.end === day).map((e) => {
      const mark = e.start === e.end ? '' : e.start === day ? 'תחילת חלון: ' : 'סוף חלון: ';
      return `<button class="cal-chip cal-admin${e.done ? ' done' : ''}" data-admin="${esc(e.id)}" title="${esc(`${e.title} (${e.start} עד ${e.end}). תזכורת למורה בלבד`)}">📌 ${e.done ? '✔ ' : ''}${mark}${esc(e.title)}</button>`;
    }).join('');
    cells.push(`<div class="cal-cell ${month && day.slice(0, 7) !== month ? 'out' : ''} ${day === today ? 'today' : ''} ${vacs.length ? 'vac' : ''} ${adm.length ? 'adm' : ''}">
      <div class="cal-day">${Number(day.slice(8))}${day.slice(8) === '01' || i === 0 ? ` ${MONTHS[Number(day.slice(5, 7)) - 1]}` : ''}</div>
      ${vacs.map((v) => `<div class="cal-vac">${esc(v.title)}</div>`).join('')}${admChips}${chips}${more}</div>`);
  }
  return { title, html: `<div class="cal" data-view="${view}">${DAYS.map((d) => `<div class="cal-head">${d}</div>`).join('')}${cells.join('')}</div>` };
}
