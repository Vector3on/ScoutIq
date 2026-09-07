// GEO is a domain plugin; all Loam core files are imported byte-for-byte.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shortHash } from '../../core/events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function createPlugin(options = {}) {
  const configPath = path.resolve(options.configPath ?? path.join(ROOT, 'geo/target.json'));
  const capturesPath = path.resolve(options.capturesPath ?? path.join(ROOT, 'geo/evidence/captures.jsonl'));
  // One frozen implementation owns validation and metrics, also usable in Colab.
  const proc = spawnSync(options.python ?? 'python3', [path.join(ROOT, 'geo/audit.py'), 'analyze',
    '--config', configPath, '--captures', capturesPath, '--json'], {encoding:'utf8', maxBuffer:32*1024*1024});
  if (proc.error || proc.status !== 0) throw new Error(`GEO evidence validation failed: ${proc.error?.message ?? proc.stderr}`);
  const analysis = JSON.parse(proc.stdout);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const revision = shortHash(analysis.records);
  const schema = {
    entityTypes: ['query', 'brand', 'category', 'engine', 'source', 'hypothesis'], primaryType:'query',
    relations: [
      {rel:'in_category',from:'query',to:'category'}, {rel:'measured_on',from:'query',to:'engine'},
      {rel:'mentions',from:'query',to:'brand'}, {rel:'cites',from:'query',to:'source'},
      {rel:'about',from:'hypothesis',to:'query'}, {rel:'targets',from:'query',to:'brand'},
    ],
    signals: ['opportunity','visibility','samples','intent','sourceCount','competitorVoice'].map(name=>({name,type:'query'})),
  };
  const rows = analysis.opportunity_queue.filter(r=>r.n > 0);
  const sensor = {
    id:'geo-answer-import',
    manifest:{id:'geo-answer-import', version:'1', description:'Validated local captures of public brand answers',
      dataClasses:['public-metadata','text'], endpoints:[], scale:{maxRequestsPerRun:0}},
    propose({limit=12}) {
      return rows.slice(0,limit).map(row=>({params:{id:row.id}, paramsKey:`${row.id}:${revision}`,
        estSeconds:0.05, features:{query:row.query_id, engine:row.engine, samples:Math.log1p(row.n),
          gap:1-row.metrics[analysis.brand].visibility, framing:row.framing}}));
    },
    poll({id}) {
      const row = rows.find(r=>r.id===id);
      if (!row) throw new Error('Unknown GEO query stratum');
      const records = analysis.records.filter(r=>row.evidence_ids.includes(r.id));
      const observedAt = Math.max(...records.map(r=>Date.parse(r.observed_at)));
      const metrics = row.metrics[analysis.brand];
      const key = row.id;
      const entities = [
        {type:'query',key,text:row.prompt,attrs:{queryId:row.query_id,engine:row.engine,evidenceIds:row.evidence_ids.join(','),scoreKind:row.score_kind},
          signals:{opportunity:row.opportunity_score/100,visibility:metrics.visibility,samples:row.n,intent:row.intent_prior,
            sourceCount:row.source_urls.length,competitorVoice:Math.max(0,...Object.entries(row.metrics).filter(([b])=>b!==analysis.brand).map(([,m])=>m.share_of_voice??0))}},
        {type:'category',key:analysis.category}, {type:'engine',key:row.engine},
        ...config.brands.map(b=>({type:'brand',key:b.name,text:b.name})),
        ...row.source_urls.map(url=>({type:'source',key:url,text:url,attrs:{authority:'unassessed'}})),
      ];
      const relations = [
        {from:`query:${key}`,rel:'in_category',to:`category:${analysis.category}`},
        {from:`query:${key}`,rel:'measured_on',to:`engine:${row.engine}`},
        {from:`query:${key}`,rel:'targets',to:`brand:${analysis.brand}`},
        ...Object.entries(row.metrics).filter(([,m])=>m.mentions>0).map(([b])=>({from:`query:${key}`,rel:'mentions',to:`brand:${b}`})),
        ...row.source_urls.map(url=>({from:`query:${key}`,rel:'cites',to:`source:${url}`})),
      ];
      for (const h of analysis.hypotheses.filter(h=>h.id.startsWith(row.id))) {
        entities.push({type:'hypothesis',key:h.id,text:h.action,attrs:{status:h.status,mechanism:h.mechanism}});
        relations.push({from:`hypothesis:${h.id}`,rel:'about',to:`query:${key}`});
      }
      return {observations:[{externalId:`${key}:${revision}`,observedAt,text:row.prompt,entities,relations}]};
    },
  };
  return {id:'geo',version:'1',description:'Evidence-first AI visibility and opportunity intelligence',schema,sensors:[sensor],
    value:{score(entity,{helpers}) {return entity.type==='query' ? helpers.latestSignal(entity,'opportunity')??0 : 0;}},
    sinks:[], analysis, config,
  };
}
export default createPlugin;
