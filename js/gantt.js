// גאנט חזותי ואינטראקטיבי. הציר זורם מימין לשמאל (מוקדם מימין), בהתאם לעברית.
// הקובץ אחראי על המודל, הציור וגרירת פסים. שינוי מועד אינו נשמר כאן: הוא מדווח החוצה לאישור המורה.
import { escapeHtml as esc } from './logic.js';
import * as T from './tasks.js';

const ROW_H = 38;
const HEAD_H = 46;
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const ZOOMS = [2, 3, 4, 6, 9, 14, 22];

// filter: {type:'class'} | {type:'group', id} | {type:'student', id}
export function buildRows(state, filter) {
  let tasks = T.orderedTasks(state);
  if (filter.type === 'group') tasks = tasks.filter((t) => t.kind === 'group' && (!t.assignees.length || t.assignees.includes(filter.id)));
  if (filter.type === 'student') tasks = T.tasksForStudent(state, filter.id);
  return tasks.map((t) => {
    let eff = { start: t.start, due: t.due, exception: null };
    let percent = 0;
    let completion = 'none';
    let detail = '';
    if (filter.type === 'class') {
      const sum = T.completionSummary(state, t);
      percent = sum.avgPercent;
      completion = sum.total && sum.approved === sum.total ? 'approved' : sum.claimed ? 'claimed' : 'none';
      detail = `${sum.approved} מתוך ${sum.total} אושרו${sum.claimed ? `, ${sum.claimed} ממתינים לאישור` : ''}`;
    } else {
      const unit = filter.type === 'group' ? { type: 'group', id: filter.id } : T.unitForStudent(state, t, filter.id);
      eff = T.effectiveDates(state, t, filter.type === 'group' ? { groupId: filter.id } : { studentId: filter.id });
      const p = T.getProgress(state, t.id, unit.type, unit.id);
      percent = p.percent;
      completion = p.completion;
      detail = completion === 'approved' ? 'ההשלמה אושרה' : completion === 'claimed' ? 'ממתין לאישור המורה' : '';
    }
    const vac = T.vacationOverlaps(state, { start: eff.start, due: eff.due });
    const depViol = T.dependencyViolations(state).some((v) => v.taskId === t.id);
    const warnings = T.taskWarnings(state, t, eff).filter((w) => filter.type === 'class' || w.type !== 'pending');
    return { task: t, start: eff.start, due: eff.due, exception: eff.exception, percent, completion, detail, vac, depViol, warnings, color: filter.type === 'group' ? (state.groups.find((g) => g.id === filter.id) || {}).color : null };
  });
}

function range(state, rows, adm = []) {
  const dates = rows.flatMap((r) => [r.start, r.due]);
  if (state.cycle && T.D.valid(state.cycle.start)) dates.push(state.cycle.start);
  if (state.cycle && T.D.valid(state.cycle.end)) dates.push(state.cycle.end);
  state.vacations.forEach((v) => dates.push(v.start, v.end));
  adm.forEach((e) => dates.push(e.start, e.end));
  if (!dates.length) { const t = T.D.today(); return { min: T.D.add(t, -14), max: T.D.add(t, 120) }; }
  const sorted = dates.sort();
  return { min: T.D.add(sorted[0], -7), max: T.D.add(sorted[sorted.length - 1], 14) };
}

export function renderGantt(state, { filter, zoom, editable }) {
  const rows = buildRows(state, filter);
  if (!rows.length) return '<div class="empty">אין משימות להצגה. אפשר להוסיף משימה או להחיל את תבנית המשימות.</div>';
  // תזכורות מנהלתיות (למורה בלבד, בתצוגת כל הכיתה): שורות נפרדות מתחת למשימות, מובדלות בצבע, סמל וקו מקווקו
  const adm = filter.type === 'class' ? [...(state.adminEvents || [])].sort((a, b) => (a.start < b.start ? -1 : 1)) : [];
  const { min, max } = range(state, rows, adm);
  const px = zoom;
  const days = T.D.diff(max, min) + 1;
  const width = days * px;
  const height = (rows.length + adm.length) * ROW_H;
  const R = (d) => T.D.diff(d, min) * px;

  // כותרת חודשים
  let months = '';
  let cur = min.slice(0, 7) + '-01';
  while (cur <= max) {
    const [y, m] = cur.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const a = cur < min ? min : cur;
    const b = T.D.add(next, -1) > max ? max : T.D.add(next, -1);
    const w = (T.D.diff(b, a) + 1) * px;
    months += `<div class="g-month" style="right:${R(a)}px;width:${w}px">${w > 46 ? `${MONTHS[m - 1]}${m === 1 || a === min ? ' ' + y : ''}` : ''}</div>`;
    cur = next;
  }
  const vacs = state.vacations.map((v) => `<div class="g-vac" title="${esc(v.title)}: ${esc(v.start)} עד ${esc(v.end)}" style="right:${R(v.start)}px;width:${(T.D.diff(v.end, v.start) + 1) * px}px"><span>${(T.D.diff(v.end, v.start) + 1) * px > 60 ? esc(v.title) : ''}</span></div>`).join('');
  const today = T.D.today();
  const todayLine = today >= min && today <= max ? `<div class="g-today" style="right:${R(today)}px" title="היום"></div>` : '';

  // פסים ושורות
  const idx = new Map(rows.map((r, i) => [r.task.id, i]));
  const bars = rows.map((r, i) => {
    const x = R(r.start);
    const w = (T.D.diff(r.due, r.start) + 1) * px;
    const cls = ['g-bar', r.task.kind === 'personal' ? 'k-personal' : 'k-group', r.completion, r.exception ? 'exc' : '', r.depViol ? 'viol' : ''].join(' ');
    const bg = r.color ? `--bc:${esc(r.color)};` : '';
    const mark = r.completion === 'approved' ? '✔' : r.completion === 'claimed' ? '⏳' : '';
    const warn = (r.vac.length ? T.WARNING_KINDS.vacation.icon : '') + (r.depViol ? T.WARNING_KINDS.plan.icon : '');
    const title = `${r.task.title}\n${r.start} עד ${r.due}${r.exception ? ' (ארכה נקודתית)' : ''}\nהתקדמות: ${r.percent}%${r.detail ? '\n' + r.detail : ''}${r.warnings.map((w) => `\n${w.icon} ${w.label}: ${w.text}`).join('')}`;
    return `<div class="g-row" style="top:${i * ROW_H}px"></div>
      <div class="${cls}" data-task="${esc(r.task.id)}" style="${bg}right:${x}px;width:${w}px;top:${i * ROW_H + 7}px" title="${esc(title)}">
        <div class="g-fill" style="width:${r.percent}%"></div>
        ${editable ? '<i class="g-h hs" data-h="start"></i><i class="g-h he" data-h="end"></i>' : ''}
        <span class="g-txt">${mark} ${warn} ${w > 70 ? esc(r.task.title) : ''}</span>
      </div>`;
  }).join('');

  const admBars = adm.map((e, k) => {
    const i = rows.length + k;
    const w = (T.D.diff(e.end, e.start) + 1) * px;
    const tip = [e.title, `${e.start} עד ${e.end}`, 'תזכורת למורה בלבד. אינה משפיעה על משימות או ציונים.', e.note, e.done ? 'בוצע' : ''].filter(Boolean).join('\n');
    return `<div class="g-row" style="top:${i * ROW_H}px"></div>
      <div class="g-admin${e.done ? ' done' : ''}" data-admin="${esc(e.id)}" style="right:${R(e.start)}px;width:${w}px;top:${i * ROW_H + 7}px" title="${esc(tip)}"><span class="g-txt">📌 ${e.done ? '✔ ' : ''}${w > 90 ? esc(e.title) : ''}</span></div>`;
  }).join('');

  // חיצי תלויות
  let arrows = '';
  rows.forEach((r, i) => {
    (r.task.dependsOn || []).forEach((pid) => {
      const j = idx.get(pid);
      if (j === undefined) return;
      const p = rows[j];
      const xe = width - R(p.start) - (T.D.diff(p.due, p.start) + 1) * px; // קצה שמאלי של הקודמת
      const xs = width - R(r.start); // קצה ימני של התלויה
      const y1 = j * ROW_H + ROW_H / 2;
      const y2 = i * ROW_H + ROW_H / 2;
      const bad = r.start <= p.due;
      const xm = xs < xe - 12 ? xe - 6 : xe + 6;
      arrows += `<path d="M${xe},${y1} H${xm} V${y2} H${xs}" class="g-arrow${bad ? ' bad' : ''}" marker-end="url(#arr${bad ? 'b' : ''})"/>`;
    });
  });

  const labels = rows.map((r, i) => `<div class="g-label" data-task="${esc(r.task.id)}" style="top:${i * ROW_H}px;height:${ROW_H}px" title="${esc(r.task.title)}">
      <span>${r.task.kind === 'personal' ? '👤' : '👥'}</span>${r.task.requiresSubmission ? '<span title="משימה שמחייבת הגשת תוצר">📥</span>' : ''}<b>${esc(r.task.title)}</b>${r.warnings.map((w) => `<span title="${esc(w.label + ': ' + w.text)}">${w.icon}</span>`).join('')}</div>`).join('');
  const admLabels = adm.map((e, k) => `<div class="g-label g-label-admin" data-admin="${esc(e.id)}" style="top:${(rows.length + k) * ROW_H}px;height:${ROW_H}px" title="${esc(e.title)}"><span>📌</span><b>${esc(e.title)}</b></div>`).join('');

  return `<div class="gantt" data-px="${px}" data-min="${esc(min)}" data-width="${width}">
    <div class="g-labels" style="height:${height + HEAD_H}px"><div class="g-label-head" style="height:${HEAD_H}px">משימה</div><div style="position:relative;height:${height}px">${labels}${admLabels}</div></div>
    <div class="g-scroll" id="gScroll"><div class="g-time" style="width:${width}px;height:${height + HEAD_H}px">
      <div class="g-head" style="height:${HEAD_H}px">${months}</div>
      <div class="g-body" style="top:${HEAD_H}px;height:${height}px">${vacs}${todayLine}${bars}${admBars}
        <svg class="g-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
          <defs><marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#66708a"/></marker>
          <marker id="arrb" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#c92a3a"/></marker></defs>
          ${arrows}
        </svg>
      </div>
    </div></div>
  </div>`;
}

export function scrollToToday(root) { scrollToDate(root, T.D.today()); }

export function scrollToDate(root, date) {
  const g = root.querySelector('.gantt');
  const sc = root.querySelector('#gScroll');
  if (!g || !sc) return;
  const px = Number(g.dataset.px);
  const min = g.dataset.min;
  const x = T.D.diff(date, min) * px;
  const target = Math.max(0, x - sc.clientWidth / 2);
  sc.scrollLeft = -target; // בכיוון RTL גלילה שלילית
}

// גרירת פסים: הזזה, שינוי התחלה (ידית ימנית) ושינוי סיום (ידית שמאלית). onChange(taskId, start, due) מופעל בשחרור.
export function attachDrag(root, state, filter, { onChange, onOpen }) {
  const g = root.querySelector('.gantt');
  if (!g) return;
  const px = Number(g.dataset.px);
  const rows = new Map(buildRows(state, filter).map((r) => [r.task.id, r]));

  g.addEventListener('click', (ev) => {
    if (g.dataset.justDragged) { delete g.dataset.justDragged; return; }
    const el = ev.target.closest('[data-task]');
    if (el) onOpen(el.dataset.task);
  });

  g.addEventListener('pointerdown', (ev) => {
    const bar = ev.target.closest('.g-bar');
    if (!bar || !bar.querySelector('.g-h') || ev.button !== 0) return;
    const r = rows.get(bar.dataset.task);
    const mode = ev.target.dataset.h || 'move';
    const startX = ev.clientX;
    const x0 = parseFloat(bar.style.right);
    const w0 = parseFloat(bar.style.width);
    let days = 0;
    const len = Math.round(w0 / px);
    // הציר מימין (מוקדם) לשמאל (מאוחר): גרירה שמאלה = מאוחר יותר, וגם הפס עצמו זז שמאלה.
    // dates(days) מחשב את התאריכים החדשים, והציור נגזר מהם כדי שהתצוגה והתוצאה תמיד יתאימו.
    const dates = (n) => {
      if (mode === 'move') return { ns: T.D.add(r.start, n), nd: T.D.add(r.due, n) };
      if (mode === 'start') return { ns: T.D.add(r.start, Math.min(n, len - 1)), nd: r.due };
      return { ns: r.start, nd: T.D.add(r.due, Math.max(n, -(len - 1))) };
    };
    const tip = document.createElement('div');
    tip.className = 'g-tip';
    document.body.appendChild(tip);
    const fmtD = (d) => d.split('-').reverse().join('.');
    try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* ממשיכים בלי לכידה */ }
    bar.classList.add('dragging');
    const move = (e) => {
      days = Math.round(-(e.clientX - startX) / px);
      const { ns, nd } = dates(days);
      bar.style.right = `${x0 + T.D.diff(ns, r.start) * px}px`;
      bar.style.width = `${(T.D.diff(nd, ns) + 1) * px}px`;
      tip.textContent = `${fmtD(ns)} עד ${fmtD(nd)}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY - 34}px`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      bar.classList.remove('dragging');
      tip.remove();
      const { ns, nd } = dates(days);
      if (ns === r.start && nd === r.due) { bar.style.right = `${x0}px`; bar.style.width = `${w0}px`; return; }
      g.dataset.justDragged = '1';
      setTimeout(() => delete g.dataset.justDragged, 0);
      onChange(r.task.id, ns, nd, () => { bar.style.right = `${x0}px`; bar.style.width = `${w0}px`; });
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
    ev.preventDefault();
  });
}
