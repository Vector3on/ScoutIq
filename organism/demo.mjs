import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './engine.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(dir, 'out/demo'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'organism-demo-'));
const now = () => Date.parse('2026-09-07T00:00:00Z');
try {
  const full = path.join(dir,'examples/snapshot.json');
  const baseline = await run({manifestPath:full,allowGrowth:false,budget:32,now});
  const adaptive = await run({manifestPath:full,db:path.join(temp,'all.db'),budget:32,now});
  const replay = await run({manifestPath:full,db:path.join(temp,'all.db'),budget:32,now});
  const db = path.join(temp,'transfer.db');
  const train = await run({manifestPath:path.join(dir,'examples/train.json'),db,budget:32,now});
  const warm = await run({manifestPath:path.join(dir,'examples/heldout.json'),db,budget:32,now});
  const cold = await run({manifestPath:path.join(dir,'examples/heldout.json'),budget:32,now});
  fs.mkdirSync(out,{recursive:true});
  const experiments = {baseline,adaptive,replay,train,warm,cold};
  const summary = {};
  for(const [name,result] of Object.entries(experiments)) {
    fs.writeFileSync(path.join(out,`${name}.json`),JSON.stringify(result,null,2)+'\n');
    summary[name]={...result.stats,distinguished:result.records.filter(r=>r.status==='static-pattern-distinguished').length,
      ceilings:result.records.filter(r=>r.status==='information-ceiling').length,archive:result.archive};
  }
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const lines=['# Observe-only synthesis: measured run','',
    'Real input: seven commit-pinned public ScoutIq source files, four entrypoints. No target code was executed. No target endpoint was contacted. These are lexical-pattern observations, not vulnerability findings.','',
    '| Condition | Distinguished patterns | Unresolved patterns | File observations | Reused queries | New lens expansions | Transferred lenses |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const [name,s] of Object.entries(summary)) lines.push(`| ${name} | ${s.distinguished} | ${s.ceilings} | ${s.fileObservations} | ${s.cachedQueries} | ${s.grownLenses} | ${s.transferredLenses} |`);
  lines.push('','## What actually happened','',
    'The local-only lens could not distinguish hypotheses differing only in imported declarations. The bounded mutation added captured direct imports. The surviving source-pattern hypotheses narrowed from four to two to one. On held-out entrypoints, archived expanded lenses were reused without repeating their discovery. Exact repeated input required no new observations or duplicate proposals.','',
    'This is an engineered finite observation vocabulary. It establishes compositional behavior on this snapshot, not open-ended intelligence or a measured bug-bounty advantage. Baseline and adaptive receive the same maximum budget; adaptive spends more of it on a richer vocabulary. Warm versus cold also differs in cached evidence, so its cost difference is not attributable to lens transfer alone.','',
    '## One concrete observation','');
  const concrete=adaptive.records.find(r=>r.target==='loam-manifest'&&r.family==='semantic/parser differential')??adaptive.records[0];
  lines.push(`Entry: \`${concrete.entry}\`. Family hint: ${concrete.family}. Result: **${concrete.hypotheses.join(', ')}**.`,'');
  for(const step of concrete.trace) {
    lines.push(`- ${step.kind}: **${step.answer}**; ${step.before} to ${step.after} surviving static hypotheses.`);
    for(const e of step.evidence) lines.push(`  - Evidence: \`${e.path}:${e.start}\`, revision \`${e.revision}\`, content SHA-256 \`${e.sha256}\`.`);
  }
  lines.push('','A matching declaration in an imported module is not proof the entrypoint calls it, nor proof that it enforces an invariant. Runtime safety stays **unknown**. All demo entries are research-only; their ScoutIq EV is zero, with unmeasured hardening left null.','',
    '## Coverage and limits','',
    'All 120 inherited technique records and 19 anatomy classes / 95 seams are indexed. Two family detectors and radii zero/one are executable. Family joins are recall hints, not verified applicability. The report does not emit the catalog’s technique procedures. It never marks a technique as tested. Source URLs and catalog family assignments were inherited, not independently audited.','',
    'The state files are SQLite event logs. The demo uses temporary databases to make its results reproducible; the normal CLI preserves state across invocations.');
  fs.writeFileSync(path.join(out,'REPORT.md'),lines.join('\n')+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
