import path from 'node:path';

export const WORKERS = ['structure', 'contracts', 'dependencies', 'symbols', 'operations', 'documents'];
const methods = new Set(['get','post','put','patch','delete','head','options','trace']);
export function extract(worker, artifact) {
  const facts = [], lines = artifact.text.split('\n');
  const evidence = (start = 1, end = /\.json$/i.test(artifact.path) ? lines.length : start) => [{ artifact: artifact.id, start, end }];
  const fact = (entity, layer, predicate, value, line = 1, status = 'observed') => facts.push({ entity, layer, predicate, value, status, evidence: evidence(line), producer: worker });
  const file = `file:${artifact.path}`;
  let json = null;
  if (/\.json$/i.test(artifact.path)) { try { json = JSON.parse(artifact.text); } catch { /* handled as unknown below */ } }
  if (worker === 'structure') {
    fact(file, 'surface', 'path', artifact.path);
    fact(file, 'surface', 'extension', path.extname(artifact.path) || '(none)');
    fact(file, 'surface', 'lineCount', lines.length);
    fact(file, 'surface', 'redacted', artifact.meta.redacted);
    const dir = path.posix.dirname(artifact.path);
    fact(file, 'structure', 'containedBy', `directory:${dir}`);
    if (json !== null) {
      let count = 0;
      const walk = (value, pointer = '', depth = 0) => {
        if (++count > 1500 || depth > 12) return;
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        fact(`${file}#${pointer}`, 'data', 'type', type);
        if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value).slice(0, 100)) {
            const childPath = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
            fact(`${file}#${childPath}`, 'data', 'parent', `${file}#${pointer}`);
            walk(child, childPath, depth + 1);
          }
        }
      };
      walk(json);
      fact(file, 'data', 'schemaTraversal', { maxNodes: 1500, maxDepth: 12, maxChildren: 100, representation: 'bounded shape, not all values' });
    } else if (/\.json$/i.test(artifact.path)) fact(file, 'data', 'parseError', 'JSON could not be parsed', 1, 'unknown');
  }
  if (worker === 'dependencies') {
    if (json && /(?:^|\/)package\.json$/.test(artifact.path)) {
      for (const group of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) {
        for (const [name, version] of Object.entries(json[group] || {})) fact(file, 'dependencies', group, { name, version });
      }
      for (const [name, command] of Object.entries(json.scripts || {})) fact(file, 'operations', 'script', { name, command, executed: false });
    }
    lines.forEach((line, i) => {
      const imports = [...line.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)];
      for (const m of imports) fact(file, 'dependencies', 'imports', m[1], i + 1);
      const py = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(line);
      if (/\.py$/.test(artifact.path) && py) fact(file, 'dependencies', 'imports', py[1] || py[2], i + 1);
      if (/(?:go\.mod|requirements[^/]*\.txt|Cargo\.toml|pyproject\.toml)$/.test(artifact.path) && line.trim()) fact(file, 'dependencies', 'manifestLine', line.trim().slice(0, 500), i + 1);
    });
  }
  if (worker === 'contracts') {
    if (json?.paths && (json.openapi || json.swagger)) {
      for (const [route, operations] of Object.entries(json.paths)) {
        for (const [method, operation] of Object.entries(operations || {})) {
          if (!methods.has(method)) continue;
          fact(`route:${method.toUpperCase()}:${route}`, 'contracts', 'route', { method: method.toUpperCase(), path: route, declaredResponses: Object.keys(operation?.responses || {}), operationId: operation?.operationId ?? null, source: artifact.path });
        }
      }
    }
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:app|router|server|route)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/g)) fact(`route:${m[1].toUpperCase()}:${m[2]}`, 'contracts', 'route', { method: m[1].toUpperCase(), path: m[2], source: artifact.path }, i + 1, 'inferred');
      const sql = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)/i.exec(line);
      if (sql) fact(`table:${sql[1]}`, 'data', 'declaration', line.trim().slice(0, 500), i + 1, 'inferred');
      const env = /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g;
      for (const m of line.matchAll(env)) fact(file, 'operations', 'environmentVariable', m[1], i + 1);
    });
  }
  if (worker === 'symbols') lines.forEach((line, i) => {
    const m = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\*?\s*|class\s+|def\s+|async\s+def\s+|(?:pub\s+)?fn\s+)([\w$]+)/.exec(line);
    if (m) fact(`symbol:${artifact.path}:${m[1]}`, 'implementation', 'declaration', { name: m[1], file: artifact.path, line: i + 1 }, i + 1, 'inferred');
  });
  if (worker === 'operations') lines.forEach((line, i) => {
    if (/(?:Dockerfile|compose.*\.ya?ml|\.github\/workflows\/.*\.ya?ml|\.tf|\.ya?ml)$/.test(artifact.path)) {
      const m = /^\s*(FROM|EXPOSE|ENTRYPOINT|CMD|image:|ports:|uses:|run:|permissions:|resource\s|provider\s)\s*(.*)/.exec(line);
      if (m) fact(file, 'operations', m[1].replace(/[:\s]/g, '').toLowerCase(), m[2].slice(0, 500), i + 1, 'inferred');
    }
    if (/\b(?:authenticate|authorize|permission|tenant|session|middleware|validate|serialize|deserialize)\b/i.test(line)) fact(file, 'seams', 'boundaryCandidate', { excerpt: line.trim().slice(0, 350), meaning: 'lexical signal; trust boundary not verified' }, i + 1, 'inferred');
  });
  if (worker === 'documents') {
    if (/\.(?:md|txt|html?)$/i.test(artifact.path)) lines.forEach((line, i) => {
      const title = /^#{1,6}\s+(.+)/.exec(line) || /<h[1-6][^>]*>(.*?)<\/h[1-6]>/i.exec(line);
      if (title) fact(file, 'documentation', 'heading', title[1].replace(/<[^>]*>/g, '').slice(0, 500), i + 1);
      for (const m of line.matchAll(/(?:href|src)=["']([^"']+)["']/g)) fact(file, 'surface', 'reference', m[1].slice(0, 1000), i + 1);
    });
  }
  return facts;
}

export function workersFor(a) {
  const names = ['structure'];
  if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|c|cpp|h)$/.test(a.path)) names.push('symbols','dependencies','contracts','operations');
  if (/(?:\.json|\.sql)$/.test(a.path)) names.push('contracts','dependencies');
  if (/(?:Dockerfile|\.ya?ml|\.tf)$/.test(a.path)) names.push('operations');
  if (/(?:\.toml|go\.mod|requirements[^/]*\.txt)$/.test(a.path)) names.push('dependencies');
  if (/\.(?:md|txt|html?)$/.test(a.path)) names.push('documents');
  return [...new Set(names)];
}

export function linkImports(facts, artifacts) {
  const files = new Map(artifacts.map(a => [a.path, a]));
  const out = [];
  for (const f of facts.filter(f => f.predicate === 'imports' && typeof f.value === 'string' && f.value.startsWith('.'))) {
    const source = f.entity.slice(5), base = path.posix.normalize(path.posix.join(path.posix.dirname(source), f.value));
    const found = [base, ...['.mjs','.js','.ts','.tsx','.jsx','.py','/index.mjs','/index.js','/index.ts'].map(e => base + e)].find(p => files.has(p));
    out.push({ entity: f.entity, layer: 'structure', predicate: found ? 'dependsOn' : 'unresolvedImport', value: found ? `file:${found}` : f.value, status: found ? 'inferred' : 'unknown', evidence: f.evidence, producer: 'linker' });
  }
  return out;
}
