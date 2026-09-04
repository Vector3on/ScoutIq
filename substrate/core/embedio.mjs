// core/embedio.mjs — external embeddings in, texts out (v3).
//
// A heavier worker (Colab with a real sentence encoder, or a local model on a
// laptop) computes vectors for entities that carry text and hands them back as
// JSONL; this module turns them into `entity.embedded` events (existing kind)
// through the ledger, deduplicated by content. The memory projection already
// stores them; MemoryVectors picks the dominant space (core/memory.mjs).
import fs from 'node:fs';
import { shortHash } from './events.mjs';

/** Entities with text but no external vector yet → JSONL lines { entityId, text }. */
export function exportTexts(memory, { embedder = null, limit = 5000 } = {}) {
  const out = [];
  for (const e of memory.entities.values()) {
    if (!e.text) continue;
    const ext = memory.extVecs.get(e.id);
    if (ext && (!embedder || ext.embedder === embedder)) continue;
    out.push({ entityId: e.id, text: e.text });
    if (out.length >= limit) break;
  }
  return out;
}

/** Parse JSONL of { entityId|id, vec|embedding } and emit entity.embedded events. */
export async function importVectors(ledger, lines, { embedder, memory = null, maxDim = 4096 } = {}) {
  if (!embedder || typeof embedder !== 'string') throw new Error('embedder name required (e.g. minilm-l6-v2-384)');
  let dim = null, imported = 0, skipped = 0, bad = 0;
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : raw;
    if (!line) continue;
    let o;
    try { o = typeof line === 'string' ? JSON.parse(line) : line; } catch { bad++; continue; }
    const id = o.entityId ?? o.id, vec = o.vec ?? o.embedding;
    if (typeof id !== 'string' || !Array.isArray(vec) || !vec.length || vec.length > maxDim || !vec.every((x) => Number.isFinite(x))) { bad++; continue; }
    if (dim === null) dim = vec.length;
    if (vec.length !== dim) { bad++; continue; }
    if (memory && !memory.entities.has(id)) { skipped++; continue; }
    // L2-normalise so cosine is a dot product, round to keep events small
    let n = 0; for (const x of vec) n += x * x; n = Math.sqrt(n) || 1;
    const v = vec.map((x) => Number((x / n).toFixed(5)));
    const ev = await ledger.emit('entity.embedded', { entityId: id, embedder, vec: v }, { dedupKey: `emb:${embedder}:${id}:${shortHash(v).slice(0, 12)}`, skipIfDedupKeyExists: true });
    if (ev) imported++; else skipped++;
  }
  return { imported, skipped, bad, dim };
}

export function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
}
