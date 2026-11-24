/**
 * Compares NLI models on both labelled sets (development tool; the app ships one model).
 *   npx tsx scripts/compare-nli.ts <model-id>:<dtype> ...
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as T from '@huggingface/transformers';
import { parseCsv } from '../src/core/csv';
import { applyMapping, guessMapping } from '../src/core/mapping';
import { analyse } from '../src/core/pipeline';
import { createEngine } from '../src/core/engine';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { evaluate } from '../src/core/evaluate';

const root = resolve(import.meta.dirname, '..');
T.env.cacheDir = resolve(root, '.cache/models');
const truths = ['eval/sample-truth.json', 'eval/heldout-truth.json'].map((f) => JSON.parse(readFileSync(resolve(root, f), 'utf8')));
const specs = process.argv.slice(2);
for (const spec of specs) {
  const [id, dtype, labels] = spec.split(':');
  const engine = await createEngine(T, { device: 'cpu', nli: { id, dtype: dtype ?? 'q8', labels: labels?.split(',') } });
  const line: string[] = [];
  for (const truth of truths) {
    const table = parseCsv(readFileSync(resolve(root, truth.file), 'utf8'));
    const { rows } = applyMapping(table, guessMapping(table[0]));
    const t0 = performance.now();
    const { analysis } = await analyse(rows, engine, DEFAULT_SETTINGS);
    const ms = performance.now() - t0;
    const r = evaluate(analysis, truth);
    line.push(`recall ${r.foundPlanted}/${r.planted} prec ${r.truePairs}/${r.flaggedPairs} traps ${r.trapsRejected}/${r.traps} (${(ms / 1000).toFixed(1)}s)`);
  }
  console.log(spec.padEnd(52), line.join('  |  '));
}
