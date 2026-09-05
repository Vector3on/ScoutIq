// plugins/bounty/tried.mjs — the operator-owned "already looked at" journal.
//
// A tried CELL is `${targetKey}::${seamId}::${techId}`: "on this target, at this
// seam, I already looked with this technique." The autonomous loop NEVER writes
// this — tries are human actions, recorded out-of-band (the boundary: the loop
// observes and prioritises, it does not test). Coverage = applicable minus tried;
// the value function and digest never re-surface a tried cell.
//
// File shape (data/tried.json):
//   { note, cells: { "<targetKey>": [ "<seamId>::<techId>"  |  {cell,outcome,note,by,at} ] } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const defaultTriedPath = () => path.join(DIR, 'data/tried.json');

const cellOf = (item) => (typeof item === 'string' ? item : item?.cell);

/**
 * Accepts: a Set (returned as-is), an array of full cell keys, a JSON file path,
 * or an object { cells: { "<targetKey>": ["<seamId>::<techId>" | {cell,...}] }, flat: [full...] }.
 * Default: data/tried.json (or empty if absent). Returns a Set of full cell keys.
 */
export function loadTried(input) {
  if (input instanceof Set) return input;
  let obj = input;
  if (input === undefined || input === null) {
    const p = defaultTriedPath();
    obj = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } else if (typeof input === 'string') {
    obj = JSON.parse(fs.readFileSync(path.isAbsolute(input) ? input : path.join(DIR, input), 'utf8'));
  }
  const out = new Set();
  const addFull = (c) => { if (typeof c === 'string' && c) out.add(c); };
  if (Array.isArray(obj)) { obj.forEach((i) => addFull(cellOf(i))); return out; }
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.flat)) obj.flat.forEach((i) => addFull(cellOf(i)));
    const cells = obj.cells ?? (obj.flat || obj.note ? null : obj); // bare map fallback
    if (Array.isArray(cells)) cells.forEach((i) => addFull(cellOf(i)));
    else if (cells && typeof cells === 'object') {
      for (const [targetKey, list] of Object.entries(cells)) for (const i of list ?? []) { const c = cellOf(i); if (c) addFull(`${targetKey}::${c}`); }
    }
  }
  return out;
}

export function readTriedFile(file = defaultTriedPath()) {
  if (!fs.existsSync(file)) return { note: 'operator-owned; the loop never writes here.', cells: {} };
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.cells = obj.cells ?? {};
  return obj;
}

export function writeTriedFile(obj, file = defaultTriedPath()) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);                                  // atomic replace
}

/**
 * Record (or update) a tried cell in a tried-file object. Idempotent per cell:
 * a repeat updates the entry in place. Returns { obj, cell, existed }.
 */
export function markTriedCell(obj, { targetKey, seamId, techId, outcome, note = '', by = 'operator', at = Date.now() }) {
  obj.cells = obj.cells ?? {};
  const cell = `${seamId}::${techId}`;
  const list = (obj.cells[targetKey] = obj.cells[targetKey] ?? []);
  const idx = list.findIndex((i) => cellOf(i) === cell);
  const entry = { cell, outcome, note, by, at: new Date(at).toISOString() };
  const existed = idx >= 0;
  if (existed) list[idx] = entry; else list.push(entry);
  return { obj, cell, existed };
}
