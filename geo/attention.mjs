// Reuse Loam's exact linear-Gaussian information gain, not a lookalike bonus.
import { LinearModel, featurize } from '../substrate/core/attention.mjs';

export function nextProbes(analysis, config, {limit=6,access=[]}={}) {
  const model = new LinearModel({dim:64,forgetting:1});
  const features = (q,engine,brand)=>({query:q,engine,brand});
  const seen = new Set();
  for (const r of analysis.records) {
    if (r.status!=='ok' || seen.has(r.id)) continue;
    seen.add(r.id);
    // Existence of the fact is derived by the frozen evidence extractor.
    for (const b of config.brands) {
      const present=analysis.facts.some(f=>f.capture_id===r.id && f.entity===b.name && f.predicate==='mentioned');
      model.update(featurize(features(r.query_id,r.engine,b.name),64),present?0:1);
    }
  }
  const blocked = new Set(analysis.records.filter(r=>r.status==='blocked').map(r=>r.engine));
  for(const state of access) if(state.status==='blocked') blocked.add(state.engine);
  const candidates=[];
  for (const q of config.queries) for (const engine of config.engines) for (const b of config.brands) {
    const phi=featurize(features(q.id,engine,b.name),64);
    const ig=model.infoGain(phi);
    const estimatedAbsence=Math.max(0,Math.min(1,model.mean(phi)));
    candidates.push({query_id:q.id,engine,focus_brand:b.name,prompt:q.prompt,information_gain_nats:ig,
      posterior_absence_proxy:estimatedAbsence,priority:q.intent*(0.3*ig+q.fixability*estimatedAbsence),
      status:blocked.has(engine)?'blocked-needs-access':'ready-for-operator',
      note:'One answer measures all tracked brands; focus is the uncertainty target, never added to the prompt.'});
  }
  candidates.sort((a,b)=>b.priority-a.priority || `${a.query_id}:${a.engine}:${a.focus_brand}`.localeCompare(`${b.query_id}:${b.engine}:${b.focus_brand}`));
  // Avoid spending multiple prompts to learn different brands from the same answer.
  const taken=new Set();
  const ranked=candidates.filter(c=>{const k=`${c.query_id}:${c.engine}`;if(taken.has(k))return false;taken.add(k);return true;});
  return {method:'Loam LinearModel posterior mean + exact parameter IG; working Gaussian approximation to binary absence',
    warning:'Model IG is not a consumer visibility confidence interval. Adaptive answers must remain separate from fixed-battery trend estimates.',
    calibration:'Reserve every fifth collection for a pre-registered fixed-battery query, independent of this ranking.',
    probes:ranked.filter(c=>c.status==='ready-for-operator').slice(0,limit),blocked:ranked.filter(c=>c.status!=='ready-for-operator')};
}
