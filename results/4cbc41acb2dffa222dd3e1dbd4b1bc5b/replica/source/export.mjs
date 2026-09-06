import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './config.mjs';
import { modelTask } from './llm.mjs';

export function exportRun(store, runId, out, { replica = false } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const facts = store.facts(runId), artifacts = store.artifacts(runId), run = store.run(runId);
  const summary = run?.summary ? JSON.parse(run.summary) : {};
  const write = (name, value) => fs.writeFileSync(path.join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  write('anatomy.json', { run: { ...run, summary }, artifacts: artifacts.map(({ text, ...a }) => a), facts });
  write('facts.jsonl', facts.map(f => JSON.stringify(f)).join('\n') + '\n');
  write('attributes.json', store.db.prepare('SELECT * FROM bs_entity_attributes WHERE run_id=?').all(runId).map(r => ({ entity: r.entity, attributes: JSON.parse(r.attributes) })));
  const layers = Object.fromEntries([...new Set(facts.map(f => f.layer))].map(layer => [layer, facts.filter(f => f.layer === layer).length]));
  write('coverage.json', summary);
  const routeFacts = facts.filter(f => f.layer === 'contracts' && f.predicate === 'route' && f.producer !== 'llm');
  const routes = [...new Map(routeFacts.map(f => [`${f.value.method} ${f.value.path}`, { ...f.value, evidence: f.evidence, status: f.status }])).values()];
  write('contracts.json', { fidelity: 'declarations only; no runtime behavior verified', routes });
  const edges = facts.filter(f => ['dependsOn','containedBy','parent'].includes(f.predicate)).map(f => ({ from: f.entity, to: f.value, relation: f.predicate, evidence: f.evidence }));
  write('graph.json', { nodes: [...new Set([...facts.map(f => f.entity), ...edges.map(e => e.to)])], edges });
  write('model-tasks.jsonl', artifacts.slice(0, 30).map(a => JSON.stringify(modelTask(a))).join('\n') + '\n');
  write('REPORT.md', `# Blindsight anatomy\n\nStatus: **${run.status}**.\n\n${artifacts.length} readable artifacts; ${facts.length} evidence-linked facts.\n\n` +
    Object.entries(layers).map(([l, n]) => `- ${l}: ${n}`).join('\n') +
    `\n\n## Coverage limits\n\n${JSON.stringify(summary, null, 2)}\n\n` +
    '## Interpretation\n\nObserved means directly extracted from the captured source. Inferred means heuristic or model-derived, not a verified runtime fact. Unknowns are deliberately retained. Evidence line numbers address sanitized captured text. File omissions and budget exhaustion are in coverage.json. No target code was installed or executed.\n\n' +
    '## Replica fidelity\n\nA source snapshot is a sanitized subset, with file hashes in the manifest. Contracts are declarations. The generated mock returns 501 for known routes and 404 otherwise; it does not reproduce business logic, credentials, hidden services, or runtime state.\n');
  if (replica) {
    const root = path.join(out, 'replica', 'source'); fs.mkdirSync(root, { recursive: true });
    for (const a of artifacts) {
      if (!safePath(a.path)) throw Error('Unsafe replica path');
      const dest = path.join(root, a.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, a.text);
    }
    const replicaDir = path.join(out, 'replica');
    fs.writeFileSync(path.join(replicaDir, 'manifest.json'), JSON.stringify({ fidelity: 'sanitized captured source subset; not behaviorally equivalent', revision: summary.revision ?? null, files: artifacts.map(a => ({ path: a.path, digest: a.digest, redacted: a.meta.redacted })) }, null, 2));
    fs.writeFileSync(path.join(replicaDir, 'contracts.json'), JSON.stringify(routes, null, 2));
    fs.writeFileSync(path.join(replicaDir, 'mock.mjs'), `// Contract scaffold only. Bind to loopback; never execute captured source.\nimport http from 'node:http';\nimport fs from 'node:fs';\nconst routes = JSON.parse(fs.readFileSync(new URL('./contracts.json', import.meta.url)));\nexport function routeMatches(pattern, pathname) {\n  const a=pattern.split('/'),b=pathname.split('/');\n  return a.length===b.length && a.every((v,i)=>v===b[i] || /^:[\\w]+$/.test(v) || /^\\{[^}]+\\}$/.test(v));\n}\nexport function respond(method, pathname) {\n  const known=routes.some(r=>r.method===method && routeMatches(r.path,pathname));\n  return {status:known?501:404, body:{mock:true, implemented:false, message:known?'Contract known; behavior unimplemented':'No captured contract'}};\n}\nif(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {\n  http.createServer((req,res)=>{const r=respond(req.method,new URL(req.url,'http://localhost').pathname);res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify(r.body));}).listen(Number(process.env.PORT||8788),'[REDACTED:ipv4]');\n}\n`);
  }
  return { out, facts: facts.length, artifacts: artifacts.length, routes: routes.length };
}
