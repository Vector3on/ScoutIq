// plugins/bounty/tried.mjs — the operator-owned "already looked at" set.
//
// A tried CELL is `${targetKey}::${seamId}::${techId}`: "on this target, at this
// seam, I already looked with this technique." The autonomous loop NEVER writes
// this — tries are human actions, recorded out-of-band (the boundary: the loop
// observes and prioritises, it does not test). Coverage = applicable minus tried;
// the value function and digest never re-surface a tried cell.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Accepts: a Set (returned as-is), an array of full cell keys, a JSON file path,
 * or an object { cells: { "<targetKey>": ["<seamId>::<techId>", ...] }, flat: [full...] }.
 * Default: data/tried.json (or empty if absent). Returns a Set of full cell keys.
 */
export function loadTried(input) {
  if (input instanceof Set) return input;
  let obj = input;
  if (input === undefined || input === null) {
    const p = path.join(DIR, 'data/tried.json');
    obj = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } else if (typeof input === 'string') {
    obj = JSON.parse(fs.readFileSync(path.isAbsolute(input) ? input : path.join(DIR, input), 'utf8'));
  }
  const out = new Set();
  const addFull = (c) => { if (typeof c === 'string' && c) out.add(c); };
  if (Array.isArray(obj)) { obj.forEach(addFull); return out; }
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.flat)) obj.flat.forEach(addFull);
    const cells = obj.cells ?? (obj.flat || obj.note ? null : obj); // bare map fallback
    if (Array.isArray(cells)) cells.forEach(addFull);
    else if (cells && typeof cells === 'object') {
      for (const [targetKey, list] of Object.entries(cells)) for (const c of list ?? []) addFull(`${targetKey}::${c}`);
    }
  }
  return out;
}
