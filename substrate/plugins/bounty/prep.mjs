#!/usr/bin/env node
// plugins/bounty/prep.mjs — the investigation-prep driver.
//
//   node plugins/bounty/prep.mjs [--top 8] [--budget 4] [--resolve-revisions] [--dir <prepDir>]
//
// Reads the latest alpha queue from the store, and for each top lead builds a
// bounded-question investigation record, walking it to a terminal state
// (ready_for_human_test or rejected). Every record is journalled and every lead is
// claimed atomically, so the run resumes cleanly after an interruption. It STOPS at
// ready_for_human_test: the active test is the human's, in their authorized
// environment, in scope. There is no autonomous testing step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/store.mjs';
import { project } from '../../core/projections.mjs';
import { memoryProjection } from '../../core/memory.mjs';
import { archiveProjection } from '../../core/archive.mjs';
import { importLedger } from '../../core/sync.mjs';
import { buildSpine } from './spine.mjs';
import { loadTried } from './tried.mjs';
import { collectLead, advanceToTerminal, renderInvestigation } from './investigation.mjs';
import { Prepstore } from './prepstore.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');
const CLAIM_TTL = 30 * 60 * 1000;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) { const [k, v] = t.slice(2).split('='); a[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); } else a._.push(t); }
  return a;
}

/** Observe-only public-source revision resolver: reads a public GitHub repo's HEAD. */
async function githubRevision(assetUrl) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(String(assetUrl));
  if (!m) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'loam-bounty-prep (observe-only)' };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: h });
    if (!r.ok) return { source: 'github', asset: assetUrl, repo, revision: 'unresolved', note: `public GitHub API ${r.status}` };
    const j = await r.json();
    const branch = j.default_branch;
    const c = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, { headers: h });
    const cj = c.ok ? await c.json() : null;
    return { source: 'github', asset: assetUrl, repo, branch, revision: cj?.sha ?? 'unresolved', committedAt: cj?.commit?.committer?.date ?? null, note: 'public repo HEAD (read-only OSINT; not a test of the target)' };
  } catch (e) { return { source: 'github', asset: assetUrl, repo, revision: 'unresolved', note: `resolver error: ${e.message}` }; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = args.domain ?? 'bounty';
  const top = Number(args.top ?? 8);
  const budget = Number(args.budget ?? 4);
  const prepDir = path.resolve(args.dir ? args.dir : path.join(ROOT, '.loam', `${domain}-prep`));
  const node = `prep.${os.hostname().replace(/[^a-z0-9]/gi, '')}.${process.pid}`;

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'loam.config.json'), 'utf8'));
  const localPath = process.env.LOAM_LOCAL_DB ?? path.join(ROOT, cfg.store?.localDir ?? '.loam', `${domain}.db`);
  const store = await openStore(localPath);
  const ledgerDir = path.resolve(ROOT, cfg.store?.ledgerDir ?? 'ledger', domain);
  if (fs.existsSync(ledgerDir)) await importLedger(store, ledgerDir);

  const [mem, arch] = await Promise.all([
    project(store, memoryProjection, { domain, saveSnapshot: false }),
    project(store, archiveProjection, { domain, saveSnapshot: false }),
  ]);
  const memory = mem.state;
  // latest queue: recent findings, deduped by entity, best score first
  const byEntity = new Map();
  for (const f of arch.state.recent) if (f.entityType === 'target' || String(f.entityId).startsWith('target:')) { if (!byEntity.has(f.entityId) || byEntity.get(f.entityId).score < f.score) byEntity.set(f.entityId, f); }
  const leads = [...byEntity.values()].sort((a, b) => b.score - a.score).slice(0, top);
  if (!leads.length) { console.log('no queued target findings in the store — run `loam run --domain bounty` first'); await store.close(); return; }

  const spine = buildSpine();
  const tried = loadTried();
  const prepstore = new Prepstore(prepDir);
  const resolver = args['resolve-revisions'] ? githubRevision : null;

  const results = [];
  for (const f of leads) {
    const entity = memory.entities.get(f.entityId);
    if (!entity) continue;
    const rec0 = collectLead(entity, { spine, tried, budget });
    if (!rec0) continue;
    if (!prepstore.claim(rec0.leadId, node, CLAIM_TTL)) { results.push({ leadId: rec0.leadId, state: 'skipped-claimed-elsewhere' }); continue; }
    try {
      const rec = await advanceToTerminal(rec0, { revisionResolver: resolver });
      prepstore.saveRecord(rec);
      results.push(rec);
    } finally { prepstore.release(rec0.leadId); }
  }

  const ready = results.filter((r) => r.state === 'ready_for_human_test');
  const rejected = results.filter((r) => r.state === 'rejected');
  console.log(`\nprep: ${results.length} leads → ${ready.length} ready_for_human_test, ${rejected.length} rejected  (journal: ${path.relative(ROOT, prepstore.journalPath)})\n`);
  for (const r of results) {
    if (r.state === 'skipped-claimed-elsewhere') { console.log(`  · ${r.leadId} — skipped (claimed elsewhere)`); continue; }
    const tag = r.state === 'ready_for_human_test' ? 'READY ' : 'reject';
    const why = r.outcome?.kind === 'ready' ? r.questions.candidateTechnique?.title ?? '' : r.outcome?.reason ?? '';
    console.log(`  ${tag} ${r.classId}.${r.seamId.padEnd(9)} ${r.targetKey.slice(0, 52).padEnd(52)} ${why}`);
  }
  const showId = args.print ? results.find((r) => r.leadId === args.print) : null;
  const one = showId ?? ready[0] ?? rejected[0];
  if (one && one.questions) { console.log('\n' + '='.repeat(72) + '\nONE FULL INVESTIGATION RECORD\n' + '='.repeat(72) + '\n'); console.log(renderInvestigation(one)); }
  await store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { process.stderr.write(`error: ${e.stack ?? e.message}\n`); process.exit(1); });
