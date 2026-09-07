// plugins/arxiv-lit/atom.mjs — dependency-free parser for the arXiv API's
// Atom feed (https://info.arxiv.org/help/api/user-manual.html).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, code) => {
    if (code[0] === '#') { const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[code] ?? m;
  });
}
const ws = (s) => unescapeXml(s).replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block); return m ? m[1] : null; };
const attrs = (block, name, attr) => [...block.matchAll(new RegExp(`<${name}\\b[^>]*?\\b${attr}="([^"]*)"[^>]*/?>`, 'g'))].map((m) => unescapeXml(m[1]));

export function parseArxivAtom(xml) {
  const out = { total: null, entries: [] };
  const t = /<opensearch:totalResults[^>]*>(\d+)</.exec(xml);
  if (t) out.total = Number(t[1]);
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const b = m[1];
    const idUrl = ws(tag(b, 'id') ?? '');
    const idm = /abs\/([^\s/]+?)(v(\d+))?$/.exec(idUrl);
    if (!idm) continue;
    const entry = {
      id: idm[1], version: idm[3] ? Number(idm[3]) : 1, idWithVersion: idm[1] + (idm[2] ?? 'v1'),
      updated: Date.parse(ws(tag(b, 'updated') ?? '')) || null,
      published: Date.parse(ws(tag(b, 'published') ?? '')) || null,
      title: ws(tag(b, 'title') ?? ''),
      summary: ws(tag(b, 'summary') ?? ''),
      authors: [...b.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((a) => ws(tag(a[1], 'name') ?? '')).filter(Boolean),
      primary: attrs(b, 'arxiv:primary_category', 'term')[0] ?? null,
      categories: [...new Set(attrs(b, 'category', 'term'))],
      doi: ws(tag(b, 'arxiv:doi') ?? '') || null,
      journalRef: ws(tag(b, 'arxiv:journal_ref') ?? '') || null,
      comment: ws(tag(b, 'arxiv:comment') ?? '') || null,
    };
    if (!entry.primary && entry.categories.length) entry.primary = entry.categories[0];
    if (entry.primary && !entry.categories.includes(entry.primary)) entry.categories.unshift(entry.primary);
    out.entries.push(entry);
  }
  return out;
}

/** Top-level archive of a category (cs.CR → cs, q-bio.QM → q-bio, hep-th → hep-th). */
export const archiveOf = (cat) => (cat.includes('.') ? cat.split('.')[0] : cat);
/** Crude distance between categories: 0 same, 0.4 same archive, 1 different archive. */
export const categoryDistance = (a, b) => (a === b ? 0 : archiveOf(a) === archiveOf(b) ? 0.4 : 1);
