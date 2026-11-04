// טעינת לוחות החופשות של משרד החינוך (קבצי JSON מובנים באתר, app/data/moe-vacations/). לקוח בלבד (fetch).
// הלוחות מגיעים למורים בעדכון האתר: אין העלאת קבצים ואין פנייה לאתר משרד החינוך בזמן אמת.
const DIR = 'data/moe-vacations/';

export async function loadCatalog(fetchImpl = (...a) => fetch(...a), base = (typeof document !== 'undefined' ? document.baseURI : '')) {
  const get = async (name) => {
    const r = await fetchImpl(new URL(DIR + name, base).href, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`טעינת ${name} נכשלה (${r.status})`);
    return r.json();
  };
  const index = await get('index.json');
  const calendars = {};
  for (const y of (index.years || [])) {
    if (y.status !== 'verified' || !y.file) continue;
    try { calendars[y.id] = await get(y.file); } catch (e) { /* שנה שנכשלה נטענת כ"לא נטען" ומוצגת הודעה */ }
  }
  return { index, calendars };
}
