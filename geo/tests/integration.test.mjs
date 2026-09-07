import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadPlugin} from '../../substrate/core/plugins.mjs';
import {openStore} from '../../substrate/core/store.mjs';
import {runOnce} from '../../substrate/core/worker.mjs';
import {project} from '../../substrate/core/projections.mjs';
import {memoryProjection} from '../../substrate/core/memory.mjs';
import {qdProjection} from '../../substrate/core/qd.mjs';
import {nextProbes} from '../attention.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

test('all imported Loam files and Melt runtime are byte-identical to upstream',()=>{
  const lock=JSON.parse(fs.readFileSync(path.join(ROOT,'geo/upstream-lock.json')));
  for(const f of [...lock.loamFiles,lock.meltRuntime]){
    const bytes=fs.readFileSync(path.join(ROOT,f.path));
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),f.sha,f.path);
  }
});

test('real pilot passes createPlugin, Loam event ingestion, QD and idempotent replay',async()=>{
  const plugin=await loadPlugin(path.join(ROOT,'substrate/plugins/geo/index.mjs'));
  assert.equal(plugin.id,'geo');
  const store=await openStore(':memory:');
  try {
    const now=Date.parse('2026-09-07T20:00:00Z');
    const opts={store,plugin,domain:'geo',node:'geo.test',env:{LOAM_AUTONOMOUS:'1'},seed:42,
      config:{budgetSeconds:8,randomGenomes:8,k:4,affineCalibration:false,descriptor:'both'}};
    const first=await runOnce({...opts,now});
    assert.equal(first.summary.requests,0);
    assert.equal(first.summary.newObservations,3);
    assert.ok(first.summary.archiveCells>0);
    assert.ok(first.findings.length>0);
    const second=await runOnce({...opts,now:now+1000});
    assert.equal(second.summary.newObservations,0);
    const mem=(await project(store,memoryProjection,{domain:'geo',useSnapshot:false})).state;
    assert.equal(mem.byType.get('query').size,3);
    assert.ok(mem.byType.get('source').size>0);
    const qd=(await project(store,qdProjection,{domain:'geo',useSnapshot:false})).state;
    assert.ok(qd.cells.size>0);
    assert.ok((await store.readAll({domain:'geo',kinds:['strategy.evaluated']})).length>0);
  } finally {await store.close();}
});

test('attention uses actual evidence, ranks unique prompts, and quarantines blocked engines',async()=>{
  const p=await loadPlugin(path.join(ROOT,'substrate/plugins/geo/index.mjs'));
  const record={...p.analysis.records[0],id:'block-test',engine:'perplexity-consumer',status:'blocked'};
  const next=nextProbes({...p.analysis,records:[...p.analysis.records,record]},p.config);
  assert.ok(next.blocked.length);
  assert.ok(next.probes.every(p=>p.engine!=='perplexity-consumer'));
  assert.ok(next.probes.every(p=>Number.isFinite(p.information_gain_nats)&&p.information_gain_nats>0));
  assert.equal(new Set(next.probes.map(p=>`${p.query_id}:${p.engine}`)).size,next.probes.length);
  const duplicated=nextProbes({...p.analysis,records:[...p.analysis.records,...p.analysis.records]},p.config);
  assert.deepEqual(duplicated,nextProbes(p.analysis,p.config));
});
