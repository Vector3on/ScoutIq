// core/plugins.mjs — plug-in loading and shape validation. The core never
// imports a domain; a plug-in is a module exporting createPlugin(options, env)
// returning { id, description, schema, sensors, value, sinks?, debug? }.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PolicyError } from '../policy/data.mjs';

export function validatePlugin(p) {
  const fail = (m) => { throw new PolicyError('plugin-shape', m); };
  if (!p || typeof p !== 'object') fail('plugin must be an object');
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(p.id)) fail('plugin.id invalid');
  if (!p.schema || !Array.isArray(p.schema.entityTypes) || !p.schema.entityTypes.length) fail(`${p.id}: schema.entityTypes required`);
  p.schema.relations = p.schema.relations ?? [];
  p.schema.signals = p.schema.signals ?? [];
  for (const r of p.schema.relations) if (!r.rel || !r.from || !r.to) fail(`${p.id}: relation needs rel/from/to`);
  for (const s of p.schema.signals) if (!s.name) fail(`${p.id}: signal needs name`);
  if (!Array.isArray(p.sensors)) fail(`${p.id}: sensors must be an array`);
  for (const s of p.sensors) {
    if (typeof s.id !== 'string') fail(`${p.id}: sensor.id required`);
    if (!s.manifest || typeof s.manifest !== 'object') fail(`${p.id}/${s.id}: manifest required`);
    if (s.manifest.id !== s.id) fail(`${p.id}/${s.id}: manifest.id must equal sensor.id`);
    if (typeof s.propose !== 'function' || typeof s.poll !== 'function') fail(`${p.id}/${s.id}: propose() and poll() required`);
  }
  if (!p.value || typeof p.value.score !== 'function') fail(`${p.id}: value.score(entity, ctx) required`);
  p.sinks = p.sinks ?? [];
  for (const s of p.sinks) if (typeof s.emit !== 'function' || typeof s.id !== 'string') fail(`${p.id}: sink needs id and emit()`);
  return p;
}

export async function loadPlugin(spec, options = {}, env = {}) {
  const file = path.isAbsolute(spec) ? spec : path.resolve(env.baseDir ?? process.cwd(), spec);
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.createPlugin ?? mod.default;
  if (typeof factory !== 'function') throw new PolicyError('plugin-shape', `${spec}: export createPlugin(options, env)`);
  const plugin = await factory(options, env);
  return validatePlugin(plugin);
}
