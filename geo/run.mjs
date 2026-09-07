#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadPlugin} from '../substrate/core/plugins.mjs';
import {openStore} from '../substrate/core/store.mjs';
import {runOnce} from '../substrate/core/worker.mjs';
import {project} from '../substrate/core/projections.mjs';
import {qdProjection} from '../substrate/core/qd.mjs';
import {nextProbes} from './attention.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function option(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
const configPath=path.resolve(option('--config',path.join(root,'geo/target.json')));
const capturesPath=path.resolve(option('--captures',path.join(root,'geo/evidence/captures.jsonl')));
const out=path.resolve(option('--out',path.join(root,'geo/output')));
const accessPath=option('--access',null);
const access=accessPath?JSON.parse(fs.readFileSync(path.resolve(accessPath),'utf8')):[];
fs.mkdirSync(out,{recursive:true});
const py=spawnSync('python3',[path.join(root,'geo/audit.py'),'analyze','--config',configPath,'--captures',capturesPath,'--out',out],{encoding:'utf8'});
if(py.status!==0)throw new Error(py.stderr);
const plugin=await loadPlugin(path.join(root,'substrate/plugins/geo/index.mjs'),{configPath,capturesPath});
const store=await openStore(path.join(out,'loam.sqlite'));
try {
  const result=await runOnce({store,plugin,domain:'geo',node:'geo.local',env:{LOAM_AUTONOMOUS:'1'},seed:'geo-pilot-v1',
    outDir:out,ledgerDir:path.join(out,'ledger'),config:{budgetSeconds:8,maxFindings:8,k:4,randomGenomes:8,
      maxProposalsPerSensor:100,descriptor:'both',sentinel:'observe',affineCalibration:false},log:()=>{}});
  const qd=(await project(store,qdProjection,{domain:'geo'})).state;
  const write=(name,data)=>fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n');
  write('loam-run.json',result);
  write('strategy-archive.json',{meaning:'Evolved ways to find opportunity hypotheses; NOT proven marketing interventions',
    cells:[...qd.cells].map(([cell,elite])=>({cell,...elite}))});
  write('next-probes.json',nextProbes(plugin.analysis,plugin.config,{access}));
  console.log(JSON.stringify({out,answers:plugin.analysis.records.filter(r=>r.status==='ok').length,
    measuredQueueRows:plugin.analysis.opportunity_queue.filter(r=>r.n).length,
    archiveCells:qd.cells.size,findings:result.findings.length}));
} finally {await store.close();}
