import type { Analysis } from './types';

export interface Truth {
  planted: [question: string, studentId: string][];
  traps: [question: string, a: string, b: string][];
}

/** Scores an analysis against planted mis-marks and look-alike traps. */
export function evaluate(a: Analysis, truth: Truth) {
  const key = (q: string, s: string) => q + '\u0000' + s;
  const planted = new Set(truth.planted.map(([q, s]) => key(q, s)));
  const flagged = a.pairs.filter((p) => p.flagged);
  const inFlagged = new Set(flagged.flatMap((p) => [a.rows[p.high], a.rows[p.low]].map((r) => key(r.question, r.studentId))));

  const isTrue = (p: (typeof flagged)[number]) =>
    planted.has(key(p.question, a.rows[p.high].studentId)) || planted.has(key(p.question, a.rows[p.low].studentId));
  const truePairs = flagged.filter(isTrue).length;
  const foundPlanted = [...planted].filter((k) => inFlagged.has(k)).length;

  const pairOf = (q: string, x: string, y: string) =>
    a.pairs.find(
      (p) =>
        p.question === q &&
        ((a.rows[p.high].studentId === x && a.rows[p.low].studentId === y) ||
          (a.rows[p.high].studentId === y && a.rows[p.low].studentId === x)),
    );
  let trapsRejected = 0;
  let trapsChecked = 0;
  let trapsOpposite = 0;
  for (const [q, x, y] of truth.traps) {
    const p = pairOf(q, x, y);
    if (!p || !p.flagged) trapsRejected++;
    if (p) {
      trapsChecked++;
      if (p.verdict === 'opposite') trapsOpposite++;
    }
  }
  const label = (p: (typeof flagged)[number]) => `${a.rows[p.high].studentId}/${a.rows[p.low].studentId} (${p.question.slice(0, 24)}…)`;
  return {
    planted: planted.size,
    foundPlanted,
    recall: planted.size ? foundPlanted / planted.size : 1,
    flaggedPairs: flagged.length,
    truePairs,
    precision: flagged.length ? truePairs / flagged.length : 1,
    traps: truth.traps.length,
    trapsRejected,
    trapsChecked,
    trapsOpposite,
    missed: truth.planted.filter(([q, s]) => !inFlagged.has(key(q, s))).map(([q, s]) => `${s} (${q.slice(0, 24)}…)`),
    falsePairs: flagged.filter((p) => !isTrue(p)).map(label),
  };
}
