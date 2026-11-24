/**
 * Runs the same pipeline the browser runs, in Node, on a labelled class file and prints
 * precision / recall against the planted mis-marks and the look-alike traps.
 *
 *   npm run eval                 -> sample class and held-out set
 *   npm run eval -- --dump       -> also print every candidate pair with its scores
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as T from '@huggingface/transformers';
import { parseCsv } from '../src/core/csv';
import { applyMapping, guessMapping } from '../src/core/mapping';
import { analyse } from '../src/core/pipeline';
import { createEngine } from '../src/core/engine';
import { DEFAULT_SETTINGS, type Analysis } from '../src/core/types';
import { evaluate } from '../src/core/evaluate';

const root = resolve(import.meta.dirname, '..');
const dump = process.argv.includes('--dump');
const sets = [
  { name: 'Sample class (thresholds chosen on this set)', truth: 'eval/sample-truth.json' },
  { name: 'Held-out set 1 (not used for thresholds; seen while comparing models)', truth: 'eval/heldout-truth.json' },
  { name: 'Held-out set 2 (written after every choice was made)', truth: 'eval/heldout2-truth.json' },
];

T.env.cacheDir = resolve(root, '.cache/models');

// NLI_MODEL=<id>:<dtype> overrides the shipped NLI model (for comparisons).
const override = process.env.NLI_MODEL?.split(':');
const engine = await createEngine(T, { device: 'cpu', nli: override ? { id: override[0], dtype: override[1] ?? 'q8' } : undefined });

function printDump(a: Analysis) {
  for (const p of a.pairs) {
    const h = a.rows[p.high];
    const l = a.rows[p.low];
    console.log(
      `  [${p.verdict.padEnd(14)}] sim ${p.similarity.toFixed(2)}  ${h.studentId}(${h.mark}) vs ${l.studentId}(${l.mark})` +
        `  H>L e${p.highToLow.entailment.toFixed(2)} c${p.highToLow.contradiction.toFixed(2)}` +
        `  L>H e${p.lowToHigh.entailment.toFixed(2)} c${p.lowToHigh.contradiction.toFixed(2)}`,
    );
  }
}

for (const set of sets) {
  const truth = JSON.parse(readFileSync(resolve(root, set.truth), 'utf8'));
  const table = parseCsv(readFileSync(resolve(root, truth.file), 'utf8'));
  const { rows } = applyMapping(table, guessMapping(table[0]));
  const t0 = performance.now();
  // MIN_SIM / ENTAIL env vars override the defaults (used to choose them on the sample set).
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(process.env.MIN_SIM ? { minSimilarity: Number(process.env.MIN_SIM) } : {}),
    ...(process.env.ENTAIL ? { entailThreshold: Number(process.env.ENTAIL) } : {}),
  };
  const { analysis } = await analyse(rows, engine, settings);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const r = evaluate(analysis, truth);
  console.log(`\n== ${set.name}`);
  console.log(`   file: ${truth.file}  answers: ${rows.length}  pairs compared: ${[...analysis.questions].reduce((s, q) => s + q.comparedPairs, 0)}  candidates checked by NLI: ${analysis.pairs.length}  time: ${secs}s`);
  console.log(`   flagged pairs: ${r.flaggedPairs}  cases: ${analysis.cases.length}`);
  console.log(`   recall    (planted mis-marks found):        ${r.foundPlanted}/${r.planted}  = ${(100 * r.recall).toFixed(0)}%`);
  console.log(`   precision (flagged pairs with a planted answer): ${r.truePairs}/${r.flaggedPairs} = ${(100 * r.precision).toFixed(0)}%`);
  console.log(`   look-alike traps rejected (not flagged):    ${r.trapsRejected}/${r.traps}`);
  console.log(`   traps reaching the meaning check and marked "opposite": ${r.trapsOpposite}/${r.trapsChecked}`);
  // Baseline: what wording similarity alone would flag (every candidate, no meaning check).
  const base = evaluate({ ...analysis, pairs: analysis.pairs.map((p) => ({ ...p, flagged: true })) }, truth);
  console.log(`   baseline, wording similarity only (no NLI): recall ${base.foundPlanted}/${base.planted}, precision ${base.truePairs}/${base.flaggedPairs} = ${(100 * base.precision).toFixed(0)}%, traps rejected ${base.trapsRejected}/${base.traps}`);
  if (r.missed.length) console.log(`   missed: ${r.missed.join(', ')}`);
  if (r.falsePairs.length) console.log(`   flagged without a planted answer: ${r.falsePairs.join(', ')}`);
  if (dump) printDump(analysis);
}
