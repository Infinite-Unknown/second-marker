import { toCsv } from './csv';
import type { Analysis, Case, CaseDecision, PairResult } from './types';

/**
 * Decisions are stored per answer pair, not per case, so they survive a change of sensitivity
 * that regroups cases. A case's decision is the first one found among its pairs.
 */
export const pairKey = (a: Analysis, p: PairResult) => `${a.rows[p.high].index}-${a.rows[p.low].index}`;

export function caseDecision(a: Analysis, decisions: Record<string, CaseDecision>, c: Case): CaseDecision | undefined {
  for (const p of c.pairs) {
    const d = decisions[pairKey(a, p)];
    if (d) return d;
  }
  return undefined;
}

export function setCaseDecision(a: Analysis, decisions: Record<string, CaseDecision>, c: Case, d: CaseDecision) {
  for (const p of c.pairs) decisions[pairKey(a, p)] = { ...d };
}

/**
 * Anonymous codes for the report: S-01, S-02, ... in order of first appearance in the file.
 * The mapping stays in the browser; only codes go into exports unless the user asks for the key.
 */
export function anonymise(a: Analysis): Map<string, string> {
  const codes = new Map<string, string>();
  const width = String(new Set(a.rows.map((r) => r.studentId)).size).length;
  for (const r of a.rows) {
    if (!codes.has(r.studentId)) codes.set(r.studentId, 'S-' + String(codes.size + 1).padStart(Math.max(2, width), '0'));
  }
  return codes;
}

export function wordingLabel(similarity: number): string {
  if (similarity >= 0.85) return 'very close wording';
  if (similarity >= 0.72) return 'close wording';
  return 'related wording';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Plain-words reason for a pair's verdict. */
export function verdictText(p: PairResult): string {
  switch (p.verdict) {
    case 'same':
      return `Each answer implies the other (${pct(p.highToLow.entailment)} and ${pct(p.lowToHigh.entailment)}).`;
    case 'lowerSaysMore':
      return `The lower-marked answer implies the higher-marked one (${pct(p.lowToHigh.entailment)}): it says at least as much.`;
    case 'higherSaysMore':
      return `The higher-marked answer says more (${pct(p.highToLow.entailment)} one way, ${pct(p.lowToHigh.entailment)} the other). The gap may be fair.`;
    case 'opposite':
      return `Similar words, opposite meaning: the meaning check found a contradiction (${pct(Math.max(p.highToLow.contradiction, p.lowToHigh.contradiction))}).`;
    default:
      return 'Similar words, but neither answer implies the other.';
  }
}

export const DECISION_LABEL: Record<string, string> = {
  remark: 'Needs re-mark',
  right: 'Marks stand',
  skip: 'Skipped',
};

export function reportCsv(a: Analysis, decisions: Record<string, CaseDecision>, withIds = false): string {
  const codes = anonymise(a);
  const rows: unknown[][] = [
    ['case', 'question', withIds ? 'student_id' : 'student_code', 'mark', 'max_mark', 'marker', 'decision', 'reason', 'wording_similarity', 'meaning_check'],
  ];
  a.cases.forEach((c, k) => {
    const d = caseDecision(a, decisions, c);
    const top = c.pairs[0];
    for (const idx of c.rows) {
      const r = a.rows[idx];
      rows.push([
        `C-${String(k + 1).padStart(2, '0')}`,
        r.question,
        withIds ? r.studentId : codes.get(r.studentId),
        r.mark,
        r.maxMark,
        r.marker ?? '',
        d ? DECISION_LABEL[d.decision] : 'Not reviewed',
        d?.reason ?? '',
        top.similarity.toFixed(2),
        verdictText(top),
      ]);
    }
  });
  return toCsv(rows);
}

export function codeKeyCsv(a: Analysis): string {
  const codes = anonymise(a);
  return toCsv([['student_code', 'student_id'], ...[...codes].map(([id, code]) => [code, id])]);
}
