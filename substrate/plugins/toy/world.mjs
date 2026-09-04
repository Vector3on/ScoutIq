// plugins/toy/world.mjs — a deterministic synthetic world with HIDDEN ground
// truth, used to falsify the substrate's claims. Nothing here touches the
// network. The world is a pure function of (seed, day): the same days are
// regenerated identically whether or not the substrate remembers anything.
//
// Value is deliberately concentrated in structure that REQUIRES history:
//   * habitual vs emerging topic pairs — a bridge is valuable only in the days
//     BEFORE its pair becomes hot; with one day of memory every cross-topic
//     document looks "new", with history the habitual pairs are recognisable;
//   * author migrations — an author's first burst in a new topic is valuable,
//     which needs the author's past;
//   * rising terms — rare, then common; needs corpus statistics;
//   * more feeds than a run can poll, with drifting yields — attention must learn.
import { makeRng } from '../../core/events.mjs';

export const DAY_MS = 86400000;
export const EPOCH = Date.UTC(2026, 0, 1);

export class ToyWorld {
  constructor(seed = 7, { topics = 12, authors = 80, docsPerDay = 60, vocabPerTopic = 40, horizon = 60, history = 40 } = {}) {
    this.seed = seed;
    this.T = topics; this.A = authors; this.docsPerDay = docsPerDay; this.horizon = horizon; this.history = history;
    const rng = makeRng(`toy:${seed}`);
    this.topics = Array.from({ length: topics }, (_, i) => ({ id: `t${i}`, vocab: Array.from({ length: vocabPerTopic }, (_, j) => `w${i}x${j}`) }));
    this.authors = Array.from({ length: authors }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, home: rng.int(topics), migrations: [] }));
    for (const a of this.authors) if (rng() < 0.9) { let to = rng.int(topics); if (to === a.home) to = (to + 1) % topics; a.migrations.push({ day: -Math.floor(history / 2) + rng.int(horizon + Math.floor(history / 2) - 3), to }); }
    // habitual pairs: background cross-topic structure with no value
    this.habitualPairs = [];
    for (let k = 0; k < Math.floor(topics / 2); k++) { const i = rng.int(topics); let j = rng.int(topics); if (j === i) j = (j + 1) % topics; this.habitualPairs.push([Math.min(i, j), Math.max(i, j)]); }
    // hot pairs: emerging pairs; bridging them BEFORE the rise is the prize
    this.hotPairs = [];
    for (let k = 0; k < Math.max(4, Math.floor(horizon / 5)); k++) {
      const i = rng.int(topics); let j = rng.int(topics); if (j === i) j = (j + 1) % topics;
      this.hotPairs.push({ pair: [Math.min(i, j), Math.max(i, j)], rise: 2 + rng.int(horizon - 4), duration: 4 + rng.int(4) });
    }
    this.emergingTerms = Array.from({ length: Math.max(6, Math.floor(horizon / 4)) }, (_, k) => ({ token: `emerg${k}q`, rise: 2 + rng.int(horizon - 4), topic: rng.int(topics) }));
    this.heat = new Map();
    let h = Array.from({ length: topics }, () => 0.3 + rng() * 0.4);
    const hr = makeRng(`toy:${seed}:heat`);
    for (let d = -history; d <= horizon + 5; d++) {
      h = h.map((x) => Math.max(0.05, Math.min(1, x + hr.gauss() * 0.07 + 0.1 * (0.45 - x))));
      const row = h.slice();
      for (const hp of this.hotPairs) if (d >= hp.rise && d < hp.rise + hp.duration) { row[hp.pair[0]] = Math.min(1, row[hp.pair[0]] + 0.35); row[hp.pair[1]] = Math.min(1, row[hp.pair[1]] + 0.35); }
      this.heat.set(d, row);
    }
    this._days = new Map();
  }

  heatRow(day) { return this.heat.get(Math.max(-this.history, Math.min(this.horizon + 5, day))); }
  heatOf(topic, day) { return this.heatRow(day)[topic]; }
  currentTopic(author, day) { let t = author.home; for (const m of author.migrations) if (m.day <= day) t = m.to; return t; }
  migrationBurst(author, day) { return author.migrations.find((m) => day >= m.day && day <= m.day + 2) ?? null; }

  docsForDay(day) {
    if (day < -this.history) return [];
    if (this._days.has(day)) return this._days.get(day);
    const rng = makeRng(`toy:${this.seed}:day:${day}`);
    const docs = [];
    const heat = this.heatRow(day);
    const weights = heat.map((x) => 0.2 + x);
    const wsum = weights.reduce((s, x) => s + x, 0);
    const zipf = (vocab) => vocab[Math.min(vocab.length - 1, Math.floor(Math.pow(rng(), 2.2) * vocab.length))];
    const make = (topic, author) => {
      const topics = [topic];
      if (rng() < 0.35) {
        const pre = this.hotPairs.filter((hp) => hp.pair.includes(topic) && day >= hp.rise - 5 && day < hp.rise + hp.duration);
        const hab = this.habitualPairs.filter((p) => p.includes(topic));
        if (pre.length && rng() < 0.7) { const hp = rng.pick(pre); topics.push(hp.pair[0] === topic ? hp.pair[1] : hp.pair[0]); }
        else if (hab.length && rng() < 0.75) { const p = rng.pick(hab); topics.push(p[0] === topic ? p[1] : p[0]); }
        else { let o = rng.int(this.T); if (o === topic) o = (o + 1) % this.T; topics.push(o); }
      }
      const tokens = [];
      for (let k = 0; k < 6; k++) tokens.push(zipf(this.topics[topics[0]].vocab));
      if (topics.length > 1) for (let k = 0; k < 3; k++) tokens.push(zipf(this.topics[topics[1]].vocab));
      const emerging = [];
      for (const et of this.emergingTerms) {
        if (!topics.includes(et.topic)) continue;
        const p = day < et.rise - 6 ? 0.03 : day < et.rise ? 0.5 : day < et.rise + 8 ? 0.7 : 0.3;
        if (rng() < p) { tokens.push(et.token); emerging.push(et.token); }
      }
      const id = `d${day < 0 ? 'm' + (-day) : day}-${docs.length}`;
      docs.push({ id, day, author: author.id, topics: topics.map((t) => `t${t}`), topicIdx: topics, tokens, emerging, title: tokens.join(' ') });
    };
    for (let i = 0; i < this.docsPerDay; i++) {
      let r = rng() * wsum, topic = 0;
      while (r > weights[topic]) { r -= weights[topic]; topic++; }
      const candidates = this.authors.filter((a) => this.currentTopic(a, day) === topic);
      const author = candidates.length && rng() < 0.85 ? rng.pick(candidates) : rng.pick(this.authors);
      make(topic, author);
    }
    // migration bursts: two extra documents per day in the new topic for three days
    for (const a of this.authors) { const m = this.migrationBurst(a, day); if (m) { make(m.to, a); make(m.to, a); } }
    this._days.set(day, docs);
    return docs;
  }

  /** Hidden ground truth in [0,1]. */
  trueValue(doc) {
    let v = 0;
    if (doc.topicIdx.length > 1) {
      const [a, b] = [Math.min(...doc.topicIdx), Math.max(...doc.topicIdx)];
      for (const hp of this.hotPairs) {
        if (hp.pair[0] !== a || hp.pair[1] !== b) continue;
        if (doc.day >= hp.rise - 5 && doc.day < hp.rise) v += 0.45;
        else if (doc.day < hp.rise + 2) v += 0.15;
      }
    }
    const author = this.authors.find((x) => x.id === doc.author);
    for (const m of author.migrations) if (m.to === doc.topicIdx[0] && doc.day >= m.day && doc.day <= m.day + 3) v += 0.35;
    for (const tok of doc.emerging) { const et = this.emergingTerms.find((x) => x.token === tok); if (et && doc.day >= et.rise - 6 && doc.day < et.rise) v += 0.2; }
    v += 0.05 * this.heatOf(doc.topicIdx[0], doc.day);
    return Math.min(1, v);
  }

  /** Truth for an author entity on a given day: a migration burst in progress. */
  authorValue(authorId, day) {
    const a = this.authors.find((x) => x.id === authorId);
    if (!a) return 0;
    return a.migrations.some((m) => day >= m.day && day <= m.day + 3) ? 0.35 : 0;
  }

  docById(id) {
    const m = /^d(m?)(\d+)-(\d+)$/.exec(id);
    if (!m) return null;
    const day = (m[1] ? -1 : 1) * Number(m[2]);
    return this.docsForDay(day)[Number(m[3])] ?? null;
  }
}

export const dayOf = (now, epoch = EPOCH) => Math.floor((now - epoch) / DAY_MS);
