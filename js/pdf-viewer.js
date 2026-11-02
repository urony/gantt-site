// תצוגת PDF עם סימון קטעים והערות מעוגנות (DOM). מבוסס על המימוש שהוכח בבדיקת היתכנות 4 (pdf.js, שכבת טקסט).
// הערות נשמרות בנפרד מה-PDF; כאן רק מציירים הדגשות לפי עיגון (anchors.js) ומפיקים עיגון מבחירת טקסט.
// נטען בעצלות (import דינמי) כדי שלא להכביד על שאר המסכים.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { makeAnchor, resolveAnchor } from './anchors.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const HEB = /[֐-׿]/;
const layerOf = (pageEl) => pageEl.querySelector('.textLayer');

function textNodes(layer) {
  const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const out = [];
  let n;
  let pos = 0;
  while ((n = w.nextNode())) { out.push({ node: n, start: pos, end: pos + n.data.length }); pos += n.data.length; }
  return out;
}
const pageText = (layer) => textNodes(layer).map((t) => t.node.data).join('');
function pointAt(nodes, off) {
  for (const t of nodes) if (off >= t.start && off <= t.end) return [t.node, off - t.start];
  const l = nodes[nodes.length - 1];
  return [l.node, l.node.data.length];
}
function rangeFor(layer, start, end) {
  const nodes = textNodes(layer);
  const r = document.createRange();
  r.setStart(...pointAt(nodes, start));
  r.setEnd(...pointAt(nodes, end));
  return r;
}
function offsetIn(layer, container, off) {
  const r = document.createRange();
  r.setStart(layer, 0);
  r.setEnd(container, off);
  return r.toString().length;
}

// PDF שהופק מדפדפן שומר טקסט עברי בסדר ויזואלי. מסדרים את ה-spans לפי שורות וכיווניות ומוסיפים רווחים,
// כדי שהבחירה והציטוט יהיו בסדר קריאה לוגי (כפי שהוכח בבדיקה 4).
function normalizeLayer(tl) {
  const spans = [...tl.children].filter((c) => c.tagName === 'SPAN' && c.textContent.length);
  const items = spans.map((el) => { const r = el.getBoundingClientRect(); return { el, l: r.left, r: r.right, cy: (r.top + r.bottom) / 2, h: r.height }; });
  items.sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const it of items) {
    const ln = lines[lines.length - 1];
    if (ln && Math.abs(it.cy - ln.cy) <= 0.6 * Math.max(it.h, ln.h)) { ln.items.push(it); ln.h = Math.max(ln.h, it.h); ln.cy = ln.items.reduce((s, x) => s + x.cy, 0) / ln.items.length; }
    else lines.push({ cy: it.cy, h: it.h, items: [it] });
  }
  const frag = [];
  for (const ln of lines) {
    const rtl = ln.items.some((i) => HEB.test(i.el.textContent));
    ln.items.sort((a, b) => (rtl ? b.r - a.r : a.l - b.l));
    ln.items.forEach((it, k) => {
      const nxt = ln.items[k + 1];
      const t = it.el.textContent;
      const gap = nxt ? (rtl ? it.l - nxt.r : nxt.l - it.r) : Infinity;
      const nextStarts = nxt ? nxt.el.textContent[0] : '';
      if (!/\s$/.test(t) && !/^\s/.test(nextStarts) && (gap > 0.12 * it.h || !nxt)) it.el.firstChild.data = t + ' ';
      frag.push(it.el);
    });
  }
  tl.querySelectorAll('br').forEach((b) => b.remove());
  const end = tl.querySelector('.endOfContent');
  for (const el of frag) tl.insertBefore(el, end);
}

export class PdfReview {
  // host: אלמנט שבתוכו יצוירו העמודים. callbacks: onSelect(anchor|null), onActivate(commentId)
  constructor(host, { onSelect = () => {}, onActivate = () => {} } = {}) {
    this.host = host;
    this.onSelect = onSelect;
    this.onActivate = onActivate;
    this.pdf = null;
    this.scale = 1;
    this.mode = 'fit';
    this.token = 0;
    this.textLen = 0;
    this.comments = [];
    this.ghosts = [];
    this.ghostFound = null;
    this.runtime = new Map();
    this.pending = null;
    this.activeId = null;
    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pdf-pages';
    host.replaceChildren(this.pagesEl);
    this._sel = () => this.#onSelectionChange();
    document.addEventListener('selectionchange', this._sel);
    this._click = (e) => this.#onClick(e);
    this.pagesEl.addEventListener('click', this._click);
    this._resize = () => { clearTimeout(this._rt); this._rt = setTimeout(() => this.mode === 'fit' && this.render(), 150); };
    addEventListener('resize', this._resize);
  }

  destroy() {
    document.removeEventListener('selectionchange', this._sel);
    removeEventListener('resize', this._resize);
    this.token++;
    if (this.pdf) { try { this.pdf.destroy(); } catch (e) { /* ignore */ } }
  }

  // source: כתובת (קובץ דמו) או Uint8Array (קובץ אמיתי שהורד מהשרת)
  async load(source) {
    // משאבי pdf.js (גופנים, צבעים, wasm) נשמרים מקומית לצד הספרייה, כדי שהתצוגה לא תלויה באינטרנט
    const base = new URL('../vendor/pdfjs/', import.meta.url).href;
    const src = source instanceof Uint8Array ? { data: source } : { url: source };
    this.pdf = await pdfjsLib.getDocument({ ...src, wasmUrl: `${base}wasm/`, standardFontDataUrl: `${base}standard_fonts/`, iccUrl: `${base}iccs/` }).promise;
    await this.render();
  }

  get hasText() { return this.textLen > 30; }

  async render() {
    const token = ++this.token;
    this.pagesEl.innerHTML = '';
    if (!this.pdf) return;
    if (this.mode === 'fit') {
      const p1 = await this.pdf.getPage(1);
      const w = p1.getViewport({ scale: 1 }).width;
      this.scale = Math.min(3, Math.max(0.4, (this.host.clientWidth - 40) / w));
    }
    let total = 0;
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const page = await this.pdf.getPage(n);
      if (token !== this.token) return;
      const vp = page.getViewport({ scale: this.scale });
      const el = document.createElement('div');
      el.className = 'pdf-page page';
      el.dataset.page = n;
      el.style.width = `${vp.width}px`;
      el.style.height = `${vp.height}px`;
      el.style.setProperty('--scale-factor', vp.scale);
      el.style.setProperty('--total-scale-factor', vp.scale);
      el.style.setProperty('--user-unit', 1);
      const dpr = window.devicePixelRatio || 1;
      const cv = document.createElement('canvas');
      cv.width = vp.width * dpr;
      cv.height = vp.height * dpr;
      cv.style.width = `${vp.width}px`;
      cv.style.height = `${vp.height}px`;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      const hl = document.createElement('div');
      hl.className = 'hl-layer';
      el.append(cv, tl, hl);
      this.pagesEl.append(el);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      const layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await layer.render();
      if (token !== this.token) return;
      normalizeLayer(tl);
      total += pageText(tl).trim().length;
    }
    this.textLen = total;
    this.draw();
    this.onRendered?.();
  }

  pageEl(n) { return this.pagesEl.querySelector(`.page[data-page="${n}"]`); }

  // comments: [{id, anchor|null, color}]. מצייר הדגשות ומחזיר מצב כל הערה: general | exact | relocated | unresolved.
  setComments(list) {
    this.comments = list;
    this.draw();
    return this.runtime;
  }

  draw() {
    this.pagesEl.querySelectorAll('.hl-layer').forEach((l) => { l.innerHTML = ''; });
    this.runtime = new Map();
    for (const c of this.comments) {
      if (!c.anchor) { this.runtime.set(c.id, { status: 'general' }); continue; }
      const pageEl = this.pageEl(c.anchor.page);
      if (!pageEl) { this.runtime.set(c.id, { status: 'unresolved', reason: 'nopage' }); continue; }
      if (!this.hasText) { this.runtime.set(c.id, { status: 'unresolved', reason: 'notext' }); continue; }
      const layer = layerOf(pageEl);
      const r = resolveAnchor(c.anchor, pageText(layer));
      if (r.status === 'unresolved') { this.runtime.set(c.id, r); continue; }
      const pr = pageEl.getBoundingClientRect();
      const hl = pageEl.querySelector('.hl-layer');
      const rects = [];
      for (const t of textNodes(layer)) {
        const s = Math.max(r.start, t.start);
        const e = Math.min(r.end, t.end);
        if (s >= e) continue;
        const rg = document.createRange();
        rg.setStart(t.node, s - t.start);
        rg.setEnd(t.node, e - t.start);
        for (const q of rg.getClientRects()) if (q.width > 0.5) rects.push(q);
      }
      this.runtime.set(c.id, { ...r, rects: rects.map((q) => ({ x: (q.left - pr.left) / pr.width, y: (q.top - pr.top) / pr.height, w: q.width / pr.width, h: q.height / pr.height })) });
      for (const q of rects) {
        const d = document.createElement('div');
        d.className = `hl${c.id === this.activeId ? ' flash' : ''}`;
        d.dataset.id = c.id;
        d.style.cssText = `left:${q.left - pr.left}px;top:${q.top - pr.top}px;width:${q.width}px;height:${q.height}px;background:${c.color}`;
        hl.append(d);
      }
    }
    // שכבה מקווקוות: קטעים שסומנו בגרסאות קודמות, כפי שהם נמצאים בטקסט של הגרסה הנוכחית (לעיון בלבד, לא הערות של הגרסה הזו)
    let found = 0;
    for (const g of this.ghosts) {
      const pageEl = this.pageEl(g.anchor.page);
      if (!pageEl || !this.hasText) continue;
      const layer = layerOf(pageEl);
      const r = resolveAnchor(g.anchor, pageText(layer));
      if (r.status === 'unresolved') continue;
      found++;
      const pr = pageEl.getBoundingClientRect();
      const hl = pageEl.querySelector('.hl-layer');
      for (const t of textNodes(layer)) {
        const s = Math.max(r.start, t.start);
        const e = Math.min(r.end, t.end);
        if (s >= e) continue;
        const rg = document.createRange();
        rg.setStart(t.node, s - t.start);
        rg.setEnd(t.node, e - t.start);
        for (const q of rg.getClientRects()) {
          if (q.width <= 0.5) continue;
          const d = document.createElement('div');
          d.className = 'hl ghost';
          d.title = 'קטע שסומן בגרסה קודמת';
          d.style.cssText = `left:${q.left - pr.left}px;top:${q.top - pr.top}px;width:${q.width}px;height:${q.height}px;border-color:${g.color}`;
          hl.append(d);
        }
      }
    }
    this.ghostFound = this.ghosts.length ? { found, total: this.ghosts.length } : null;
    this.onDrawn?.(this.runtime);
  }

  setGhosts(list) { this.ghosts = list; this.draw(); }

  activate(id, scroll) {
    this.activeId = id;
    this.pagesEl.querySelectorAll('.hl').forEach((h) => h.classList.toggle('flash', h.dataset.id === id));
    if (scroll) this.pagesEl.querySelector(`.hl[data-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // הקטע שנבחר כעת במסמך, כעיגון (או null)
  get selection() { return this.pending; }
  clearSelection() { getSelection().removeAllRanges(); this.pending = null; this.onSelect(null); }

  #anchorFromRange(range) {
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const startPage = start && start.closest('.page');
    if (!startPage || !this.pagesEl.contains(startPage)) return null;
    const layer = layerOf(startPage);
    const text = pageText(layer);
    let s = offsetIn(layer, range.startContainer, range.startOffset);
    let e = startPage.contains(range.endContainer) ? offsetIn(layer, range.endContainer, range.endOffset) : text.length;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (s >= e) return null;
    return makeAnchor(Number(startPage.dataset.page), text, s, e);
  }

  #onSelectionChange() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!(this.pagesEl.contains(r.commonAncestorContainer) || this.pagesEl === r.commonAncestorContainer)) return;
    this.pending = sel.isCollapsed ? null : this.#anchorFromRange(r);
    this.onSelect(this.pending);
  }

  // לחיצה על טקסט מסומן מפעילה את ההערה (ההדגשות שקופות לעכבר כדי שאפשר יהיה לבחור טקסט מעליהן)
  #onClick(e) {
    if (!getSelection().isCollapsed) return;
    const pg = e.target.closest('.page');
    if (!pg) return;
    const pr = pg.getBoundingClientRect();
    const x = (e.clientX - pr.left) / pr.width;
    const y = (e.clientY - pr.top) / pr.height;
    const hit = this.comments.find((c) => c.anchor && c.anchor.page === Number(pg.dataset.page)
      && (this.runtime.get(c.id)?.rects || []).some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
    if (hit) { this.activate(hit.id, false); this.onActivate(hit.id); }
  }

  zoom(factor) { this.mode = 'manual'; this.scale = Math.min(4, Math.max(0.3, this.scale * factor)); return this.render(); }
  fit() { this.mode = 'fit'; return this.render(); }
  get zoomPercent() { return Math.round(this.scale * 100); }

  // לבדיקות אוטומטיות: בחירת ציטוט בטקסט העמוד כמו גרירה של המורה
  selectQuote(pageNum, quote, nth = 0) {
    const layer = layerOf(this.pageEl(pageNum));
    const t = pageText(layer);
    let i = -1;
    for (let k = 0; k <= nth; k++) i = t.indexOf(quote, i + 1);
    if (i < 0) return false;
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(rangeFor(layer, i, i + quote.length));
    return true;
  }
  pageTexts() { return [...this.pagesEl.querySelectorAll('.page')].map((p) => pageText(layerOf(p))); }
}
