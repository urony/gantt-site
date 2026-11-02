// תשתית ל-AI, ללא ספק אמיתי. לוגיקה טהורה (נבדקת ב-app/tests). אין כאן רשת, מפתחות או שליחת נתונים החוצה.
// עקרונות מחייבים (החלטות המורה):
//  * הצעות AI נשמרות בנפרד מההערות (aiProposals) ולכן לעולם אינן גלויות לתלמיד. רק הערה אמיתית (comments) יכולה להיות גלויה.
//  * אישור הצעה יוצר הערת טיוטה רגילה של המורה. פרסום דורש "שליחת משוב" מפורשת, כמו לכל טיוטה.
//  * סבב בדיקה שומר עותק קבוע (תוכן, לא רק מזהה) של המחוון, הפרומפט וההוראה החד-פעמית. שינוי עתידי אינו משפיע על סבבים קודמים.
//  * ציון מוצע נשמר בנפרד מציון תקף. כרגע שניהם ריקים: אין ציון אוטומטי ואין פרסום ציון.
//  * שער פרטיות יחיד (evaluateGate). מידע מזהה ברור או חשד ממשי (ראו privacy.js) חוסם והמסמך עובר להסגר אוטומטי. אין עקיפה בנימוק.
//    ממצאים חלשים אינם חוסמים. "לא זוהה" אינו "בטוח", והמורה חייב לאשר ידנית. הסגר ידני חוסם הכול.
//  * הצעה מקומית שלא נמצא לה מיקום חד-משמעי היא "עיגון נכשל": אי אפשר לאשר אותה עד שהמורה משייך ידנית או הופך אותה במפורש לכללית.
import { newId } from './logic.js';
import { scanPages } from './privacy.js';
import { locate } from './locate.js';
import { makeAnchor } from './anchors.js';
import { addComment } from './review.js';

const clone = (s) => structuredClone(s);
const nowIso = () => new Date().toISOString();
export const MAX_RUBRIC = 8000;
export const MAX_PROMPT = 8000;
export const MAX_ONE_TIME = 1000;
export const MAX_REASON = 500;

const teacherOnly = (session, what = 'הפעולה') => { if (!session || session.role !== 'teacher') throw new Error(`${what} מותרת רק למורה`); };
const sub = (state, id) => {
  const x = (state.submissions || []).find((y) => y.id === id);
  if (!x) throw new Error('ההגשה לא נמצאה');
  return x;
};

// קיצור מזהה בלבד: מאפשר להבחין ששני סבבים השתמשו באותו טקסט. אינו קריפטוגרפי ואינו מחליף את העותק המלא.
export function textFingerprint(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ---------- מתג ----------
export const isAiEnabled = (state) => !!state.aiEnabled;
export function setAiEnabled(state, session, enabled) {
  teacherOnly(session, 'שינוי הגדרת AI');
  const s = clone(state);
  s.aiEnabled = !!enabled;
  return s;
}

// ---------- הסגר ידני ----------
export const quarantineOf = (state, submissionId) => (state.aiQuarantine || []).find((q) => q.submissionId === submissionId) || null;
export function setQuarantine(state, session, submissionId, on, { reason = '', now = nowIso() } = {}) {
  teacherOnly(session, 'הסגר ידני');
  sub(state, submissionId);
  const s = clone(state);
  s.aiQuarantine = (s.aiQuarantine || []).filter((q) => q.submissionId !== submissionId);
  if (on) s.aiQuarantine.push({ submissionId, reason: String(reason || '').slice(0, MAX_REASON), at: now });
  return s;
}

// ---------- שער פרטיות (יחיד) ----------
// מחזיר { ok, blockers[], scan }. כל ניסיון להעביר מסמך לעיבוד AI חייב לעבור כאן.
// ok נדרש: מתג פעיל, אין הסגר, ההגשה ניתנת לבדיקה, הסורק לא חסם, ואישור ידני מפורש של המורה. אין נתיב עקיפה בנימוק.
export function evaluateGate(state, submissionId, pages, { confirmed = false } = {}) {
  const blockers = [];
  const s0 = sub(state, submissionId);
  const scan = scanPages(pages || []);
  if (!isAiEnabled(state)) blockers.push('תשתית ה-AI כבויה');
  if (quarantineOf(state, submissionId)) blockers.push('המסמך בהסגר');
  if (!s0.conversion || s0.conversion.status !== 'done') blockers.push('המסמך עוד לא הומר ל-PDF');
  if (scan.verdict === 'blocked') blockers.push('זוהה מידע מזהה או חשד ממשי לזיהוי מטופל: אי אפשר להפעיל AI על המסמך, ואין עקיפה בנימוק');
  if (scan.verdict === 'not-scannable') blockers.push('לא נמצא טקסט לבדיקה: הסורק לא יכול לבדוק את המסמך');
  if (!confirmed) blockers.push('נדרש אישור ידני של המורה שהמסמך נבדק ואינו כולל מידע מזהה');
  return { ok: !blockers.length, blockers, scan };
}

// סורק חסם: המסמך עובר להסגר (פעם אחת). ההסגר נשאר גם אם המורה מוציא אותו ומריץ שוב, כי הסריקה תחסום שוב.
export function quarantineIfSuspicious(state, session, submissionId, pages, { now = nowIso() } = {}) {
  teacherOnly(session, 'בדיקת פרטיות');
  sub(state, submissionId);
  const scan = scanPages(pages || []);
  if (scan.verdict !== 'blocked' || quarantineOf(state, submissionId)) return state;
  const s = clone(state);
  s.aiQuarantine = (s.aiQuarantine || []).filter((q) => q.submissionId !== submissionId);
  s.aiQuarantine.push({ submissionId, reason: 'סורק פרטיות: חשד למידע מזהה (' + scan.blocking.map((f) => f.label).filter((v, i, arr) => arr.indexOf(v) === i).join(', ') + ')', auto: true, at: now });
  return s;
}

// ---------- מתאם ספק (נקודת חיבור יחידה) ----------
// request: { pages, rubric, prompt, oneTime, model } . מחזיר { proposals:[{ intent:'local'|'general', quote, before, after, text, categoryName }], proposedGrade:null }
// "ללא ספק" דוחה. "מדומה" דטרמיניסטי ומקומי: בונה הצעות מטקסט המסמך עצמו כדי לבדוק עיגון. אין רשת.
export const PROVIDERS = {
  none: { label: 'ללא ספק', run() { throw new Error('לא הוגדר ספק AI. אפשר להשתמש בספק המדומה לבדיקת התשתית.'); } },
  mock: { label: 'ספק מדומה (מקומי, לבדיקות)', run: mockProvider },
};
export function callProvider(providerId, request) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('ספק לא מוכר');
  return p.run(request);
}

function sentencesOf(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 25);
}
function mockProvider({ pages }) {
  const all = pages.flatMap((t, i) => sentencesOf(t).map((q) => ({ page: i + 1, q })));
  const unique = all.filter((a) => all.filter((b) => b.q === a.q).length === 1);
  const out = [];
  // 1. הצעה מקומית שאפשר לעגן (ציטוט מדויק, ייחודי)
  if (unique[0]) out.push({ intent: 'local', quote: unique[0].q, before: '', after: '', text: 'הצעה (מדומה): כדאי לחדד ולנמק את הקביעה הזו.', categoryName: 'הבהרה' });
  // 2. הצעה מקומית נוספת מעמוד אחר אם יש
  const other = unique.find((u) => unique[0] && u.page !== unique[0].page) || unique[1];
  if (other) out.push({ intent: 'local', quote: other.q, before: '', after: '', text: 'הצעה (מדומה): חסר כאן מקור או הפניה.', categoryName: 'מקורות' });
  // 3. הצעה מקומית שהציטוט שלה אינו קיים במסמך: העיגון חייב להיכשל
  out.push({ intent: 'local', quote: 'משפט שאינו מופיע בשום מקום במסמך הזה בכלל', before: '', after: '', text: 'הצעה (מדומה) עם ציטוט שאינו קיים: בודקת שהעיגון נכשל.', categoryName: 'הבהרה' });
  // 4. הצעה מקומית דו-משמעית: מילה/ביטוי שחוזר (אם יש); אחרת ציטוט קצר גנרי
  const rep = repeatedPhrase(pages);
  if (rep) out.push({ intent: 'local', quote: rep, before: '', after: '', text: 'הצעה (מדומה) על ביטוי שחוזר כמה פעמים: אין מיקום חד-משמעי.', categoryName: 'ניסוח' });
  // 5. הצעה כללית מכוונת (אין צורך במיקום)
  out.push({ intent: 'general', quote: '', before: '', after: '', text: 'הצעה כללית (מדומה): מומלץ לסכם בסוף כל פרק את המסקנה העיקרית.', categoryName: 'כללי' });
  return { proposals: out, proposedGrade: null };
}
function repeatedPhrase(pages) {
  const words = pages.join(' ').split(/\s+/).filter(Boolean);
  const seen = new Map();
  for (let i = 0; i + 2 < words.length; i++) {
    const g = words.slice(i, i + 3).join(' ');
    if (g.length >= 8) seen.set(g, (seen.get(g) || 0) + 1);
  }
  const best = [...seen].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// ---------- סבבי בדיקה (צילום מצב קבוע) ----------
export const roundsOf = (state, submissionId) => (state.aiRounds || []).filter((r) => r.submissionId === submissionId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
export const proposalsOf = (state, submissionId) => (state.aiProposals || []).filter((p) => p.submissionId === submissionId);
export const proposalsOfRound = (state, roundId) => (state.aiProposals || []).filter((p) => p.roundId === roundId);

function categoryIdFor(state, name) {
  const act = state.commentCategories.filter((c) => !c.archived);
  const hit = act.find((c) => c.name === name);
  return (hit || act[0] || {}).id || null;
}

// אין כאן קריאה אסינכרונית: ספק אמיתי עתידי יחליף את callProvider בגרסה אסינכרונית דרך שרת המורה.
export function startRound(state, session, submissionId, { pages, rubric = '', prompt = '', oneTime = '', provider = 'mock', model = '', confirmed = false, now = nowIso() } = {}) {
  teacherOnly(session, 'הפעלת סבב בדיקה');
  const s0 = sub(state, submissionId);
  if (String(rubric).length > MAX_RUBRIC) throw new Error(`המחוון ארוך מדי (עד ${MAX_RUBRIC} תווים)`);
  if (String(prompt).length > MAX_PROMPT) throw new Error(`הפרומפט ארוך מדי (עד ${MAX_PROMPT} תווים)`);
  if (String(oneTime).length > MAX_ONE_TIME) throw new Error(`ההוראה החד-פעמית ארוכה מדי (עד ${MAX_ONE_TIME} תווים)`);
  const gate = evaluateGate(state, submissionId, pages, { confirmed });
  // חשד: אין סבב, והמסמך עובר להסגר. מחזירים את המצב עם ההסגר (לא זורקים, כדי שההסגר יישמר).
  if (gate.scan.verdict === 'blocked' && isAiEnabled(state)) return quarantineIfSuspicious(state, session, submissionId, pages, { now });
  if (!gate.ok) throw new Error(`הסבב נחסם בשער הפרטיות: ${gate.blockers.join('; ')}`);
  const result = callProvider(provider, { pages, rubric, prompt, oneTime, model });
  const s = clone(state);
  s.aiRounds = s.aiRounds || [];
  s.aiProposals = s.aiProposals || [];
  const roundId = newId('rnd');
  s.aiRounds.push({
    id: roundId, submissionId, taskId: s0.taskId, unitType: s0.unitType, unitId: s0.unitId,
    submissionVersion: s0.version, submissionRef: { id: s0.id, version: s0.version, fileName: s0.fileName || null },
    // עותקים קבועים של התוכן ששימש בפועל
    rubric: { text: String(rubric), fingerprint: textFingerprint(rubric) },
    prompt: { text: String(prompt), fingerprint: textFingerprint(prompt) },
    oneTime: String(oneTime),
    provider, model: String(model || ''),
    // ציון מוצע נפרד מציון תקף. שניהם ריקים בשלב זה ואין דרך מילוי אוטומטי של התקף.
    proposedGrade: result.proposedGrade ?? null, validGrade: null,
    privacy: {
      scan: { verdict: gate.scan.verdict, weakCount: gate.scan.weak.length, scannedPages: gate.scan.scannedPages },
      confirmedByTeacher: true,
    },
    createdAt: now,
  });
  for (const p of result.proposals) {
    const base = {
      id: newId('prp'), roundId, submissionId, taskId: s0.taskId, unitType: s0.unitType, unitId: s0.unitId,
      source: 'ai', aiState: 'proposed', intent: p.intent === 'general' ? 'general' : 'local',
      categoryId: categoryIdFor(s, p.categoryName), text: String(p.text || ''), studentId: null,
      commentId: null, decidedAt: null, createdAt: now,
    };
    if (base.intent === 'general') {
      s.aiProposals.push({ ...base, quote: '', anchor: null, anchorStatus: 'general', anchorNote: '' });
      continue;
    }
    const r = locate(pages, { quote: p.quote, before: p.before, after: p.after });
    if (r.status === 'anchored') {
      s.aiProposals.push({ ...base, quote: p.quote, anchor: makeAnchor(r.page, pages[r.page - 1], r.start, r.end), anchorStatus: 'anchored', anchorNote: '' });
    } else {
      // עיגון נכשל: הצעה מקומית ללא מיקום חד-משמעי. אינה כללית מכוונת ואינה ניתנת לאישור כמות שהיא.
      s.aiProposals.push({ ...base, quote: String(p.quote || ''), anchor: null, anchorStatus: 'failed', anchorNote: r.status === 'ambiguous' ? 'הציטוט מופיע במקומות אחדים' : 'הציטוט לא נמצא במסמך' });
    }
  }
  return s;
}

// ---------- החלטות המורה על הצעות ----------
const prp = (state, id) => {
  const p = (state.aiProposals || []).find((x) => x.id === id);
  if (!p) throw new Error('ההצעה לא נמצאה');
  return p;
};
export const needsAnchorCheck = (p) => p.aiState === 'proposed' && p.intent === 'local' && p.anchorStatus === 'failed';

// המורה משייך ידנית את ההצעה המקומית לקטע שסימן במסמך
export function anchorProposal(state, session, id, anchor) {
  teacherOnly(session, 'שיוך הצעה');
  const cur = prp(state, id);
  if (cur.aiState !== 'proposed') throw new Error('ההצעה כבר טופלה');
  if (!(anchor && anchor.quote && anchor.page >= 1)) throw new Error('לא סומן קטע');
  const s = clone(state);
  const p = prp(s, id);
  Object.assign(p, { anchor: clone(anchor), quote: anchor.quote, anchorStatus: 'manual', anchorNote: 'שויכה ידנית על ידי המורה' });
  return s;
}
// הפיכה מפורשת להערה כללית (החלטה של המורה, לא ברירת מחדל)
export function makeProposalGeneral(state, session, id) {
  teacherOnly(session, 'שינוי הצעה להערה כללית');
  const cur = prp(state, id);
  if (cur.aiState !== 'proposed') throw new Error('ההצעה כבר טופלה');
  const s = clone(state);
  const p = prp(s, id);
  Object.assign(p, { intent: 'general', anchor: null, anchorStatus: 'general', anchorNote: 'הומרה להערה כללית על ידי המורה' });
  return s;
}

// אישור: יוצר הערת טיוטה רגילה של המורה (לא מפורסמת). מקור ההצעה נשמר בסימון origin.
export function approveProposal(state, session, id, { text, categoryId } = {}) {
  teacherOnly(session, 'אישור הצעה');
  const p = prp(state, id);
  if (p.aiState !== 'proposed') throw new Error('ההצעה כבר טופלה');
  if (needsAnchorCheck(p)) throw new Error('העיגון נכשל: צריך לשייך את ההצעה לקטע במסמך, או להפוך אותה במפורש להערה כללית, לפני אישור');
  const withComment = addComment(state, session, {
    submissionId: p.submissionId, scope: p.intent === 'general' ? 'general' : 'local', anchor: p.anchor,
    categoryId: categoryId || p.categoryId, text: text === undefined ? p.text : text, studentId: p.studentId,
  });
  const s = clone(withComment);
  const made = s.comments[s.comments.length - 1];
  made.origin = 'ai-approved';
  made.proposalId = p.id;
  made.aiState = 'approved';
  const q = prp(s, id);
  q.aiState = 'approved';
  q.commentId = made.id;
  q.decidedAt = nowIso();
  return s;
}
export function rejectProposal(state, session, id) {
  teacherOnly(session, 'דחיית הצעה');
  const p = prp(state, id);
  if (p.aiState !== 'proposed') throw new Error('ההצעה כבר טופלה');
  const s = clone(state);
  const q = prp(s, id);
  q.aiState = 'rejected';
  q.decidedAt = nowIso();
  return s;
}

// סיכום להצגה: כמה הצעות, כמה דורשות בדיקת עיגון
export function proposalSummary(state, submissionId) {
  const list = proposalsOf(state, submissionId);
  const open = list.filter((p) => p.aiState === 'proposed');
  return {
    total: list.length, open: open.length, approved: list.filter((p) => p.aiState === 'approved').length, rejected: list.filter((p) => p.aiState === 'rejected').length,
    needAnchor: open.filter(needsAnchorCheck).length,
  };
}

// אזהרת עיגון להערות רגילות: הערה מקומית שנשמרה עם עיגון, אך במסמך הנוכחי לא נמצא לה מיקום חד-משמעי (unresolved).
// הערה כללית מכוונת (בלי עיגון) אינה "נכשלה". resolved: סטטוס מ-resolveAnchor.
export function anchorProblem(comment, resolvedStatus) {
  if (comment.scope === 'general' || !comment.anchor) return 'intentional-general';
  return resolvedStatus === 'unresolved' ? 'failed' : null;
}
