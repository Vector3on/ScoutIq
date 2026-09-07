import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './snapshot.mjs';

const executable = fileURLToPath(new URL('./frozen/partition.py', import.meta.url));
export function partition(rows, observed = {}) {
  const receipt = JSON.parse(fs.readFileSync(new URL('./frozen/receipt.json', import.meta.url), 'utf8'));
  if (digest(fs.readFileSync(executable)) !== receipt.sha256) throw new Error('Frozen capsule digest mismatch');
  // Fixed reviewed interpreter only; never target code or a configurable command.
  const result = spawnSync('python3', ['-I', executable], {
    input: JSON.stringify({ rows, observed }), encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  if (result.error || result.status !== 0) throw new Error('Frozen capsule rejected input or exceeded its budget');
  const answer = JSON.parse(result.stdout);
  if (answer.status !== 'ok') throw new Error('Frozen capsule failed');
  return answer.result;
}
