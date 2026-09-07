import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './engine.mjs';

const { values } = parseArgs({ options: {
  manifest: { type: 'string', default: 'organism/examples/snapshot.json' },
  state: { type: 'string', default: 'organism/state/memory.db' },
  out: { type: 'string', default: 'organism/out/report.json' },
  budget: { type: 'string', default: '32' },
  'no-growth': { type: 'boolean', default: false },
  'no-transfer': { type: 'boolean', default: false },
} });
try {
  const result = await run({ manifestPath: values.manifest, db: values.state, budget: Number(values.budget),
    allowGrowth: !values['no-growth'], reuseArchive: !values['no-transfer'] });
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: values.out, ...result.stats, coverage: result.coverage }));
} catch (error) {
  console.error(`Observation stopped: ${error.message}`); process.exitCode = 1;
}
