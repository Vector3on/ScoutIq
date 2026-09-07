// core/metrics.mjs — the measurements that could show the thesis is wrong.
//
//   Compounding : value-per-budget rises with run count (Spearman > 0) and the
//                 last third beats the first third; on the toy, persistent
//                 state must beat the memoryless ablation on hidden truth.
//   Open-ended  : archive coverage keeps growing, every run still delivers
//                 findings, mean novelty stays high, and strategy entropy of
//                 delivered findings stays ≥ 1 bit (no collapse to one way of looking).
import { spearman } from './experiment.mjs';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export async function runSeries(store, domain) {
  const evs = await store.readAll({ domain, kinds: ['run.completed'] });
  return evs.map((e) => e.body).filter((b) => b.domain === domain).sort((a, b) => a.startedAt - b.startedAt);
}

export function liveVerdict(series) {
  const n = series.length;
  if (n < 4) return { runs: n, note: 'need ≥ 4 runs for a verdict' };
  const third = Math.max(2, Math.floor(n / 3));
  const vps = series.map((r) => r.valuePerSecond ?? 0);
  const trend = spearman(series.map((_, i) => i), vps);
  const early = mean(vps.slice(0, third)), late = mean(vps.slice(-third));
  const coverage = series.map((r) => r.coverage ?? 0);
  const withFindings = series.filter((r) => (r.findings ?? 0) > 0).length / n;
  const lateEntropy = mean(series.slice(-third).map((r) => r.strategyEntropy ?? 0));
  const lateNovelty = mean(series.slice(-third).map((r) => r.meanNovelty ?? 0));
  return {
    runs: n,
    compounding: { trend: r3(trend), earlyValuePerSecond: r3(early), lateValuePerSecond: r3(late), ratio: r3(late / Math.max(1e-9, early)), verdict: trend > 0 && late > early * 1.1 },
    openEnded: { coverageStart: r3(coverage[0]), coverageEnd: r3(coverage[n - 1]), coverageGrowth: r3(coverage[n - 1] - coverage[0]), runsWithFindings: r3(withFindings), lateEntropyBits: r3(lateEntropy), lateNovelty: r3(lateNovelty), verdict: coverage[n - 1] > coverage[0] && withFindings >= 0.75 && lateEntropy >= 1 && lateNovelty >= 0.3 },
  };
}

export function formatSeries(series) {
  const cols = ['run', 'started', 'findings', 'novelValue', 'valuePerSec', 'newObs', 'entities', 'evals', 'cells', 'coverage', 'entropy', 'requests', 'denials', 'elapsedMs'];
  const rows = series.map((r, i) => [i, new Date(r.startedAt).toISOString().slice(0, 16), r.findings, r.novelValue, r.valuePerSecond, r.newObservations, r.entities, r.evaluations, r.archiveCells, r.coverage, r.strategyEntropy, r.requests, r.denials, r.elapsedMs]);
  const widths = cols.map((c, j) => Math.max(c.length, ...rows.map((r) => String(r[j] ?? '').length)));
  const line = (r) => r.map((v, j) => String(v ?? '').padStart(widths[j])).join('  ');
  return [line(cols), ...rows.map(line)].join('\n');
}

const r3 = (x) => Number(Number(x).toFixed(3));
