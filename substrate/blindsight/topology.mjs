// Strongly connected components expose cycles and module clusters, without
// pretending directory names establish runtime service boundaries.
export function topology(facts) {
  const edges = facts.filter(f => f.predicate === 'dependsOn');
  const graph = new Map();
  for (const e of edges) { if (!graph.has(e.entity)) graph.set(e.entity, []); if (!graph.has(e.value)) graph.set(e.value, []); graph.get(e.entity).push(e.value); }
  // Iterative Kosaraju avoids call-stack failure on long import chains.
  const visited = new Set(), order = [];
  for (const start of graph.keys()) {
    if (visited.has(start)) continue;
    const stack = [[start, false]];
    while (stack.length) {
      const [node, exit] = stack.pop();
      if (exit) { order.push(node); continue; }
      if (visited.has(node)) continue;
      visited.add(node); stack.push([node, true]);
      for (const next of graph.get(node)) if (!visited.has(next)) stack.push([next, false]);
    }
  }
  const reverse = new Map([...graph.keys()].map(k => [k, []]));
  for (const [a, targets] of graph) for (const b of targets) reverse.get(b).push(a);
  visited.clear(); const components = [];
  for (const start of order.reverse()) {
    if (visited.has(start)) continue;
    const group = [], stack = [start];
    while (stack.length) {
      const n = stack.pop(); if (visited.has(n)) continue;
      visited.add(n); group.push(n);
      for (const next of reverse.get(n)) if (!visited.has(next)) stack.push(next);
    }
    components.push(group.sort());
  }
  return components.filter(g => g.length > 1 || graph.get(g[0]).includes(g[0])).map(group => ({ entity: `cycle:${group.join('|')}`, layer: 'structure', predicate: 'importCycle', value: group, status: 'inferred', evidence: edges.filter(e => group.includes(e.entity) && group.includes(e.value)).flatMap(e => e.evidence).slice(0, 20), producer: 'topology' }));
}

export function attention(facts, artifacts, count) {
  const score = new Map(artifacts.map(a => [a.id, 1]));
  for (const f of facts) for (const e of f.evidence) score.set(e.artifact, (score.get(e.artifact) || 0) + (f.status === 'unknown' ? 5 : f.layer === 'seams' ? 4 : f.layer === 'contracts' ? 2 : 0));
  return artifacts.slice().sort((a, b) => (score.get(b.id) - score.get(a.id)) || a.path.localeCompare(b.path)).slice(0, count);
}
