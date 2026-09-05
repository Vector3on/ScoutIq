#!/usr/bin/env node
// plugins/bounty/journal.mjs — the operator's tried-journal + judgment feedback.
//
//   node plugins/bounty/journal.mjs mark <targetKey> <seamId> <techId> <outcome> [--note "..."] [--by name]
//   node plugins/bounty/journal.mjs list
//
// `mark` does two things atomically-ish: (1) appends the (target,seam,technique)
// cell to data/tried.json with its outcome, so the queue never re-surfaces it;
// (2) emits a Loam judgment.recorded on the target, valued by the outcome, so the
// value model calibrates toward the anatomy/EV profiles that actually pay.
//
// The loop never runs this — a "try" is a human action, outside the observe-only
// boundary. Outcomes come from what the human learned in THEIR authorized test
// environment; this tool only records the result and feeds it back.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/store.mjs';
import { Ledger } from '../../core/ledger.mjs';
import { Policy } from '../../policy/policy.mjs';
import { project } from '../../core/projections.mjs';
import { archiveProjection } from '../../core/archive.mjs';
import { sync, importLedger, exportLedger } from '../../core/sync.mjs';
import { readTriedFile, writeTriedFile, markTriedCell, defaultTriedPath } from './tried.mjs';
import { outcomeInfo, OUTCOME_KEYS } from './outcomes.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');

/** Emit the judgment for a tried cell's outcome onto its target. Testable in isolation. */
export async function emitOutcomeJudgment(ledger, { targetKey, seamId, techId, outcome, note = '', by = 'operator', ts = Date.now() }) {
  const info = outcomeInfo(outcome);
  const entityId = `target:${targetKey}`;
  const body = { findingId: null, entityId, value: info.value, note: `${outcome} @ ${seamId}::${techId}${note ? ` — ${note}` : ''}`.slice(0, 500), by, ts };
  await ledger.emit('judgment.recorded', body);
  return { entityId, value: info.value, polarity: info.polarity };
}

function loadConfig() {
  const p = path.join(ROOT, 'loam.config.json');
  const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  cfg.store = cfg.store ?? {}; cfg.policy = cfg.policy ?? {};
  return cfg;
}

async function openBountyStore(cfg, domain, env) {
  const localDir = path.resolve(ROOT, cfg.store.localDir ?? '.loam');
  const localPath = env.LOAM_LOCAL_DB ?? path.join(localDir, `${domain}.db`);
  const local = await openStore(localPath);
  let hub = null, ledgerDir = null;
  const mode = cfg.store.mode ?? 'auto';
  if (mode !== 'local' && env.LOAM_DB_URL && mode !== 'ledger') hub = await openStore(env.LOAM_DB_URL, { token: env.LOAM_DB_TOKEN });
  else if (mode === 'ledger' || (mode === 'auto' && !env.LOAM_DB_URL)) ledgerDir = path.resolve(ROOT, cfg.store.ledgerDir ?? 'ledger', domain);
  return { local, hub, ledgerDir };
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const [k, v] = t.slice(2).split('='); a[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); }
    else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const domain = args.domain ?? 'bounty';
  const triedPath = args.tried ? path.resolve(args.tried) : defaultTriedPath();

  if (cmd === 'list') {
    const obj = readTriedFile(triedPath);
    const targets = Object.entries(obj.cells ?? {});
    if (!targets.length) { console.log('no tried cells yet'); return; }
    for (const [tk, list] of targets) {
      console.log(`\n${tk}`);
      for (const it of list) { const c = typeof it === 'string' ? { cell: it } : it; console.log(`  ${c.cell}  ${c.outcome ?? ''}${c.note ? `  — ${c.note}` : ''}${c.by ? `  (${c.by})` : ''}`); }
    }
    return;
  }

  if (cmd === 'mark') {
    const [targetKey, seamId, techId, outcome] = args._.slice(1);
    if (!targetKey || !seamId || !techId || !outcome) throw new Error('usage: journal mark <targetKey> <seamId> <techId> <outcome> [--note "..."]');
    outcomeInfo(outcome); // validates or throws with the vocabulary
    // 1. tried.json (atomic)
    const obj = readTriedFile(triedPath);
    const { cell, existed } = markTriedCell(obj, { targetKey, seamId, techId, outcome, note: args.note ?? '', by: args.by ?? 'operator' });
    writeTriedFile(obj, triedPath);
    // 2. judgment feedback into the value model
    const cfg = loadConfig();
    const { local, hub, ledgerDir } = await openBountyStore(cfg, domain, process.env);
    if (hub) await sync(local, hub, {});
    if (ledgerDir) await importLedger(local, ledgerDir);
    const policy = new Policy(cfg.policy, { env: process.env });
    const ledger = await new Ledger({ store: local, node: 'operator.journal', policy, domain }).init();
    const j = await emitOutcomeJudgment(ledger, { targetKey, seamId, techId, outcome, note: args.note ?? '', by: args.by ?? 'operator' });
    if (hub) await sync(local, hub, {});
    if (ledgerDir) await exportLedger(local, ledgerDir);
    await local.close();
    console.log(`${existed ? 'updated' : 'marked'} tried: ${targetKey} · ${cell} · ${outcome}`);
    console.log(`  → judgment ${j.value} (${j.polarity}) on ${j.entityId}; the value model will fold it on the next run`);
    console.log(`  → this cell will not re-appear in the queue`);
    return;
  }

  console.log(`bounty journal — tried-cell record + judgment feedback
  node plugins/bounty/journal.mjs mark <targetKey> <seamId> <techId> <outcome> [--note "..."] [--by name]
  node plugins/bounty/journal.mjs list
outcomes: ${OUTCOME_KEYS.join(', ')}`);
  if (cmd) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
}
