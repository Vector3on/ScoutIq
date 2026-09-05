#!/usr/bin/env node
// bin/loam.mjs — operator CLI for the Loam substrate.
import './suppress-warnings.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/store.mjs';
import { runOnce } from '../core/worker.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runExperiment, v3Verdicts, v4Verdicts, VARIANT_CONFIGS } from '../core/experiment.mjs';
import { runSeries, liveVerdict, formatSeries } from '../core/metrics.mjs';
import { buildBundle, parseJudgments, ingestJudgments } from '../core/bundle.mjs';
import { project } from '../core/projections.mjs';
import { archiveProjection } from '../core/archive.mjs';
import { Projection } from '../core/projections.mjs';
import { applyProposalEvent, isAutonomousEnv } from '../policy/actions.mjs';
import { Ledger } from '../core/ledger.mjs';
import { Policy } from '../policy/policy.mjs';
import { sync, exportLedger, importLedger } from '../core/sync.mjs';
import { validateManifest } from '../policy/manifest.mjs';
import { memoryProjection } from '../core/memory.mjs';
import { exportTexts, importVectors, readJsonl } from '../core/embedio.mjs';
import { makeVqProjection, vqOccupied } from '../core/vq.mjs';
import { makeFrontierProjection, activeChallenges } from '../core/frontier.mjs';
import { makeValueModelProjection, calibrationMae } from '../core/valuemodel.mjs';
import { makeSentinelProjection, diagnose, interventionEffects } from '../core/sentinel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

function loadConfig(file) {
  const p = file ? path.resolve(file) : path.join(ROOT, 'loam.config.json');
  const cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { domains: {} };
  cfg._file = p;
  cfg.store = cfg.store ?? {};
  cfg.policy = cfg.policy ?? {};
  return cfg;
}

function nodeId(role) {
  const name = (process.env.LOAM_NODE_NAME || os.hostname() || 'local').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'local';
  return `${role}.${name}`;
}

async function openStores(cfg, domain, args) {
  const env = process.env;
  const localDir = path.resolve(ROOT, cfg.store.localDir ?? '.loam');
  const localPath = args.local ?? env.LOAM_LOCAL_DB ?? path.join(localDir, `${domain}.db`);
  const local = await openStore(localPath);
  let hub = null, ledgerDir = null;
  const mode = args.mode ?? cfg.store.mode ?? 'auto';
  if (mode !== 'local' && env.LOAM_DB_URL && mode !== 'ledger') {
    hub = await openStore(env.LOAM_DB_URL, { token: env.LOAM_DB_TOKEN });
  } else if (mode === 'ledger' || (mode === 'auto' && !env.LOAM_DB_URL)) {
    ledgerDir = path.resolve(ROOT, cfg.store.ledgerDir ?? 'ledger', domain);
  }
  return { local, hub, ledgerDir, localPath };
}

function digestSink(cfg, domain) {
  return {
    id: 'digest',
    async emit(findings, { runId, memory, now }) {
      const dir = path.join(ROOT, 'out', domain);
      fs.mkdirSync(dir, { recursive: true });
      const L = [`# Loam digest — ${domain} — run ${runId} — ${new Date(now).toISOString()}`, ''];
      if (!findings.length) L.push('_no novel findings this run_');
      for (const f of findings) {
        L.push(`## ${f.title}`);
        L.push(`- \`${f.entityId}\` · score ${f.score} = value ${f.value} × novelty ${f.novelty} · strategy ${f.strategyId} (cell ${f.cell})`);
        if (f.rationale?.length) L.push(`- why: ${f.rationale.join('; ')}`);
        const a = f.attrs ?? {};
        const sig = Object.entries(a.signals ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
        L.push(`- seen ${a.n ?? '?'}× from ${a.firstSeen ? new Date(a.firstSeen).toISOString().slice(0, 10) : '?'}${sig ? '; ' + sig : ''}`);
        L.push('');
      }
      const text = L.join('\n');
      fs.writeFileSync(path.join(dir, `${runId}.md`), text);
      fs.writeFileSync(path.join(dir, 'latest.md'), text);
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ runId, domain, now, findings }, null, 2));
      if (cfg.publishDigest) {
        const pub = path.join(ROOT, 'digests', domain);
        fs.mkdirSync(pub, { recursive: true });
        fs.writeFileSync(path.join(pub, 'latest.md'), text);
      }
    },
  };
}

const log = (m) => process.stderr.write(`[loam] ${m}\n`);

async function cmdRun(args, cfg) {
  const domain = args.domain ?? 'toy';
  const d = cfg.domains?.[domain];
  if (!d) throw new Error(`domain ${domain} not in ${cfg._file}`);
  const role = args.role ?? (process.env.GITHUB_ACTIONS ? 'cron' : process.env.COLAB_RELEASE_TAG ? 'colab' : 'local');
  const plugin = await loadPlugin(d.plugin, d.options ?? {}, { baseDir: ROOT, env: process.env });
  plugin.sinks = [...(plugin.sinks ?? []), digestSink(cfg, domain)];
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  const config = { ...(cfg.planner ?? {}), ...(cfg.qd ?? {}), ...(cfg.output ?? {}), ...(cfg.v3 ?? {}), ...(d.config ?? {}), budgetSeconds: Number(args.budget ?? d.budgetSeconds ?? cfg.budgetSeconds ?? 60) };
  const policyConfig = { ...cfg.policy, authorizedTokens: { ...(cfg.policy.authorizedTokens ?? {}), ...(d.authorizedTokens ?? {}) } };
  log(`run domain=${domain} node=${nodeId(role)} store=${hub ? hub.label : ledgerDir ? 'ledger:' + ledgerDir : 'local'} budget=${config.budgetSeconds}s`);
  const res = await runOnce({ store: local, hub, ledgerDir, plugin, domain, node: nodeId(role), role, config, policyConfig, log, now: args.now ? Number(args.now) : undefined, seed: args.seed, outDir: path.join(ROOT, 'out', domain) });
  const s = res.summary;
  log(`done: ${s.findings} findings (novel value ${s.novelValue}), ${s.newObservations} new obs, ${s.evaluations} evals, coverage ${s.coverage}, ${s.requests} requests, ${s.denials} denials, ${s.elapsedMs}ms`);
  if (res.blocks.length) log(`active blocks: ${res.blocks.map((b) => `${b.host} (${b.reason} until ${new Date(b.until).toISOString()})`).join(', ')}`);
  if (args.json) console.log(JSON.stringify(res.summary, null, 2));
  else for (const f of res.findings) console.log(`${String(f.score).padEnd(6)} ${f.entityId}  ${f.rationale?.[0] ?? ''}`);
  await local.close();
}

async function cmdExperiment(args) {
  const runs = Number(args.runs ?? 10), budget = Number(args.budget ?? 8);
  const seeds = String(args.seeds ?? '7,11,23').split(',').map(Number);
  const variants = String(args.variants ?? 'memory,memoryless,single-cell').split(',');
  for (const v of variants) if (!(v in VARIANT_CONFIGS)) throw new Error(`unknown variant ${v}; known: ${Object.keys(VARIANT_CONFIGS).join(', ')}`);
  const judgmentsPerRun = Number(args.judgments ?? 0);
  const config = { ...(args.window ? { windowDays: Number(args.window) } : {}), ...(args.config ? JSON.parse(args.config) : {}) };
  const all = [];
  for (const seed of seeds) {
    const r = await runExperiment({ runs, budgetSeconds: budget, seed, variants, log: args.verbose ? log : () => {}, judgmentsPerRun, config });
    r.v3 = v3Verdicts(r.results, runs);
    r.v4 = v4Verdicts(r.results, runs);
    all.push({ seed, ...r });
    if (!args.json) {
      console.log(`\n== seed ${seed}`);
      for (const v of variants) console.log(`${v.padEnd(16)} trueValue/run: ${r.results[v].map((x) => x.trueValue.toFixed(2)).join(' ')}   cum→${r.results[v][runs - 1].cumTrue}  coverage→${r.results[v][runs - 1].coverage}  entropy→${r.results[v][runs - 1].entropy}${r.results[v][runs - 1].vqCells !== null ? `  learnedCells→${r.results[v][runs - 1].vqCells}` : ''}`);
      console.log('verdicts:', JSON.stringify(r.verdicts));
      if (Object.keys(r.v3.ceiling ?? {}).length || Object.keys(r.v3.ablations ?? {}).length || r.v3.isolated) console.log('v3:', JSON.stringify(r.v3));
      if (r.v4.ceiling || Object.keys(r.v4.isolated).length || Object.keys(r.v4.ablations).length) console.log('v4:', JSON.stringify(r.v4));
    }
  }
  const agg = aggregate(all, variants, runs);
  if (args.json) console.log(JSON.stringify({ seeds: all, aggregate: agg }, null, 2));
  else { console.log('\n== aggregate over seeds'); console.log(JSON.stringify(agg, null, 2)); }
}

function aggregate(all, variants, runs) {
  const half = Math.floor(runs / 2);
  const late = (v) => all.map((a) => a.results[v].slice(half).reduce((s, r) => s + r.trueValue, 0) / (runs - half));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const out = { runs, seeds: all.map((a) => a.seed) };
  for (const v of variants) out[`lateTrueValue.${v}`] = Number(mean(late(v)).toFixed(3));
  if (variants.includes('memory') && variants.includes('memoryless')) out.memoryOverMemoryless = Number((out['lateTrueValue.memory'] / Math.max(1e-6, out['lateTrueValue.memoryless'])).toFixed(3));
  if (variants.includes('memory') && variants.includes('single-cell')) out.memoryOverSingleCell = Number((out['lateTrueValue.memory'] / Math.max(1e-6, out['lateTrueValue.single-cell'])).toFixed(3));
  out.trend = Number(mean(all.map((a) => a.verdicts.trend ?? 0)).toFixed(3));
  out.compoundingVerdicts = all.map((a) => !!a.verdicts.compounding);
  out.openEndedVerdicts = all.map((a) => !!a.verdicts.openEnded);
  return out;
}

async function cmdReport(args, cfg) {
  const domain = args.domain ?? 'toy';
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await importLedger(local, ledgerDir);
  const series = await runSeries(local, domain);
  const last = Number(args.last ?? 30);
  console.log(formatSeries(series.slice(-last)));
  console.log('\nverdict:', JSON.stringify(liveVerdict(series), null, 2));
  // v3 projections (present only if the addons ran)
  const [vq, fr, vm, se] = await Promise.all([
    project(local, makeVqProjection(), { domain, saveSnapshot: false }), project(local, makeFrontierProjection(), { domain, saveSnapshot: false }),
    project(local, makeValueModelProjection(), { domain, saveSnapshot: false }), project(local, makeSentinelProjection(), { domain, saveSnapshot: false }),
  ]);
  const v3 = {};
  if (vq.state.evaluations) v3.learnedArchive = { cells: vqOccupied(vq.state), centroids: vq.state.centroids.length, tau: Number(vq.state.tau.toFixed(3)), evaluations: vq.state.evaluations };
  if (fr.state.created) v3.frontier = { active: activeChallenges(fr.state).length, created: fr.state.created, solved: fr.state.solved, retired: fr.state.retired, transfers: fr.state.transfers };
  if (vm.state.trained) v3.valueModel = { judgments: vm.state.trained, calibrationMae: Number((calibrationMae(vm.state) ?? 0).toFixed(4)) };
  if (se.state.runs.length) v3.sentinel = { diagnosis: diagnose(se.state), interventions: interventionEffects(se.state) };
  if (Object.keys(v3).length) console.log('\nv3:', JSON.stringify(v3, null, 2));
  await local.close();
}

async function cmdEmbed(args, cfg, direction) {
  const domain = args.domain ?? 'toy';
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await importLedger(local, ledgerDir);
  const mem = (await project(local, memoryProjection, { domain, saveSnapshot: false })).state;
  if (direction === 'export') {
    const rows = exportTexts(mem, { embedder: args.embedder ?? null, limit: Number(args.limit ?? 5000) });
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    if (args.out) { fs.writeFileSync(args.out, text); log(`wrote ${rows.length} texts to ${args.out}`); } else process.stdout.write(text);
  } else {
    const file = args._[1];
    if (!file || !args.embedder) throw new Error('usage: loam embed <vectors.jsonl> --embedder <name> --domain <d>');
    const policy = new Policy(cfg.policy, { env: process.env });
    const ledger = await new Ledger({ store: local, node: nodeId('embedder'), policy, domain }).init();
    const r = await importVectors(ledger, readJsonl(file), { embedder: args.embedder, memory: mem });
    if (hub) await sync(local, hub, { log });
    if (ledgerDir) await exportLedger(local, ledgerDir);
    log(`imported ${r.imported} vectors (dim ${r.dim}), skipped ${r.skipped}, bad ${r.bad}`);
  }
  await local.close();
}

async function cmdBundle(args, cfg) {
  const domain = args.domain ?? 'toy';
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await importLedger(local, ledgerDir);
  const md = await buildBundle(local, { domain, top: Number(args.top ?? 15), uncertain: Number(args.uncertain ?? 6), runs: Number(args.runs ?? 3) });
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, md); log(`wrote ${args.out}`); }
  else console.log(md);
  await local.close();
}

async function cmdIngest(args, cfg) {
  const domain = args.domain ?? 'toy';
  const file = args._[1];
  if (!file) throw new Error('usage: loam ingest-judgment <reply.md> --domain X [--by name]');
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseJudgments(text);
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await importLedger(local, ledgerDir);
  const arch = await project(local, archiveProjection, { domain, saveSnapshot: false });
  const policy = new Policy(cfg.policy, { env: process.env });
  const ledger = await new Ledger({ store: local, node: nodeId('operator'), policy, domain }).init();
  const n = await ingestJudgments(ledger, parsed, { archive: arch.state, by: args.by ?? 'human' });
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await exportLedger(local, ledgerDir);
  log(`ingested ${n} items (${parsed.judgments.length} judgments, ${parsed.strategies.length} strategies, ${parsed.notes.length} notes); ${parsed.errors.length} errors`);
  for (const e of parsed.errors) log(`  ! ${e}`);
  await local.close();
}

const proposalsProjection = new Projection({ name: 'proposals', version: 1, kinds: ['proposal.created', 'proposal.approved', 'proposal.rejected', 'proposal.executed'], init: () => new Map(), apply: applyProposalEvent, dehydrate: (m) => [...m.entries()], hydrate: (a) => new Map(a) });

async function cmdProposals(args, cfg) {
  const domain = args.domain ?? 'toy';
  const sub = args._[1] ?? 'list';
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) await sync(local, hub, { log });
  if (ledgerDir) await importLedger(local, ledgerDir);
  const { state: proposals } = await project(local, proposalsProjection, { domain, saveSnapshot: false });
  if (sub === 'list') {
    for (const p of proposals.values()) console.log(`${p.proposalId}  ${p.status.padEnd(9)} ${p.kind} → ${p.target}\n    ${p.rationale}`);
    if (!proposals.size) console.log('no proposals');
  } else if (sub === 'approve' || sub === 'reject') {
    const id = args._[2];
    if (!proposals.has(id)) throw new Error(`unknown proposal ${id}`);
    if (isAutonomousEnv(process.env)) throw new Error('approval is a human action; refuse in CI/cron');
    const policy = new Policy(cfg.policy, { env: process.env });
    const ledger = await new Ledger({ store: local, node: nodeId('operator'), policy, domain }).init();
    policy.emit = (k, b) => ledger.emit(k, b);
    policy.actions.emit = policy.emit;
    if (sub === 'approve') await policy.actions.approve(id, { by: args.by ?? 'operator', note: args.note ?? '' });
    else await policy.actions.reject(id, { by: args.by ?? 'operator', note: args.note ?? '' });
    if (hub) await sync(local, hub, { log });
    if (ledgerDir) await exportLedger(local, ledgerDir);
    log(`${sub}d ${id}`);
  }
  await local.close();
}

async function cmdSync(args, cfg) {
  const domain = args.domain ?? 'toy';
  const { local, hub, ledgerDir } = await openStores(cfg, domain, args);
  if (hub) { const r = await sync(local, hub, { log }); log(`hub: pulled ${r.pulled}, pushed ${r.pushed}`); }
  if (ledgerDir) { const i = await importLedger(local, ledgerDir); const e = await exportLedger(local, ledgerDir); log(`ledger: imported ${i.imported}, exported ${e.written}`); }
  log(`local events: ${await local.count()}`);
  await local.close();
}

async function cmdDoctor(args, cfg) {
  const env = process.env;
  const [maj, min] = process.versions.node.split('.').map(Number);
  console.log(`node ${process.versions.node} ${maj > 22 || (maj === 22 && min >= 13) ? 'OK' : 'TOO OLD (need >= 22.13)'}`);
  try { process.getBuiltinModule('node:sqlite'); console.log('node:sqlite OK'); } catch { console.log('node:sqlite MISSING'); }
  console.log(`config ${cfg._file} ${fs.existsSync(cfg._file) ? 'OK' : 'missing (defaults)'}`);
  console.log(`store mode: ${env.LOAM_DB_URL ? 'turso hub (LOAM_DB_URL set)' : 'git ledger / local (no LOAM_DB_URL)'}; token ${env.LOAM_DB_TOKEN ? 'present' : 'absent'}`);
  console.log(`pseudonym salt: ${env.LOAM_PSEUDONYM_SALT && env.LOAM_PSEUDONYM_SALT.length >= 8 ? 'present' : 'ABSENT (person-data plug-ins will refuse to load)'}`);
  console.log(`autonomous context: ${isAutonomousEnv(env)} (proposals cannot be approved/executed here)`);
  const policy = new Policy(cfg.policy, { env });
  for (const [name, d] of Object.entries(cfg.domains ?? {})) {
    try {
      const plugin = await loadPlugin(d.plugin, d.options ?? {}, { baseDir: ROOT, env });
      const lines = [];
      for (const s of plugin.sensors) {
        try { const m = validateManifest(s.manifest, { limits: { maxRequestsPerRun: policy.config.maxRequestsPerRun, maxRequestsPerHostPerDay: policy.config.maxRequestsPerHostPerDay }, localServices: policy.config.localServices, hasSalt: policy.hasSalt }); lines.push(`    ${s.id}: OK (${m.endpoints.map((e) => `${e.methods.join('/')} ${e.host}${e.pathPrefix} ≤${e.dailyCap}/day`).join('; ') || 'no network'}; auth ${m.auth}${m.tokenEnv ? ' via env:' + m.tokenEnv + (env[m.tokenEnv] ? ' (set)' : ' (unset)') : ''})`); }
        catch (e) { lines.push(`    ${s.id}: REFUSED — ${e.message}`); }
      }
      console.log(`domain ${name} (${d.enabled === false ? 'disabled' : 'enabled'}): plugin ${plugin.id} loads OK\n${lines.join('\n')}`);
    } catch (e) { console.log(`domain ${name}: FAILED — ${e.message}`); }
  }
  if (env.LOAM_DB_URL) {
    try { const hub = await openStore(env.LOAM_DB_URL, { token: env.LOAM_DB_TOKEN }); console.log(`hub ${hub.label}: ${await hub.count()} events`); }
    catch (e) { console.log(`hub: FAILED — ${e.message}`); }
  }
}

async function cmdLedger(args, cfg, direction) {
  const domain = args.domain ?? 'toy';
  const { local } = await openStores(cfg, domain, { ...args, mode: 'local' });
  const dir = path.resolve(ROOT, cfg.store.ledgerDir ?? 'ledger', domain);
  if (direction === 'export') { const r = await exportLedger(local, dir); log(`exported ${r.written} events to ${dir}`); }
  else { const r = await importLedger(local, dir); log(`imported ${r.imported} events from ${r.files} files`); }
  await local.close();
}

const HELP = `loam — compounding intelligence substrate

  loam run --domain <d> [--budget sec] [--role r] [--mode auto|local|ledger] [--json]
  loam experiment [--runs 10] [--seeds 7,11,23] [--budget 8] [--variants memory,memoryless,single-cell] [--judgments 0] [--window 30] [--json]
                  v3 variants: v3 (shipping defaults), v3-all, v3-descriptor, v3-learned, v3-frontier, v3-value, v3-credit, v3-sentinel, v3-no-<addon>
                  v4 variants: v4 (shipping defaults), v4-all, v4-hindsight, v4-discovery, v4-discovery-judgments, v4-obsops, v4-curriculum, v4-no-<addon>, v4-fixed, v4-progress
  loam report --domain <d> [--last 30]
  loam bundle --domain <d> [--out file.md] [--top 15] [--uncertain 6] [--runs 3]
  loam ingest-judgment <reply.md> --domain <d> [--by name]
  loam proposals [list|approve <id>|reject <id>] --domain <d>
  loam sync --domain <d>
  loam export-ledger / import-ledger --domain <d>
  loam doctor
  loam embed-export --domain <d> [--out texts.jsonl]      texts lacking an external vector (for a Colab/local encoder)
  loam embed <vectors.jsonl> --embedder <name> --domain <d>

env: LOAM_DB_URL, LOAM_DB_TOKEN (Turso hub) · LOAM_PSEUDONYM_SALT · LOAM_NODE_NAME · LOAM_LOCAL_DB
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const cfg = loadConfig(args.config);
  switch (cmd) {
    case 'run': return cmdRun(args, cfg);
    case 'experiment': return cmdExperiment(args, cfg);
    case 'report': return cmdReport(args, cfg);
    case 'bundle': return cmdBundle(args, cfg);
    case 'ingest-judgment': return cmdIngest(args, cfg);
    case 'proposals': return cmdProposals(args, cfg);
    case 'sync': return cmdSync(args, cfg);
    case 'export-ledger': return cmdLedger(args, cfg, 'export');
    case 'import-ledger': return cmdLedger(args, cfg, 'import');
    case 'doctor': return cmdDoctor(args, cfg);
    case 'embed': return cmdEmbed(args, cfg, 'import');
    case 'embed-export': return cmdEmbed(args, cfg, 'export');
    default: console.log(HELP); return cmd ? process.exit(1) : undefined;
  }
}

main().catch((e) => { log(`error: ${e.stack ?? e.message}`); process.exit(1); });
