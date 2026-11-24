import type { Analysis, AnswerRow, Case, NliScores, PairResult, QuestionSummary, Settings, Verdict } from './types';

/**
 * The two model calls the pipeline needs. The browser worker and the Node evaluation
 * script both implement this with the same models, so they run the same pipeline.
 */
export interface Engine {
  /** L2-normalised sentence embeddings, one per text. */
  embed(texts: string[], onProgress?: (done: number) => void): Promise<Float32Array[]>;
  /** NLI scores for (premise, hypothesis) pairs. */
  nli(pairs: [string, string][], onProgress?: (done: number) => void): Promise<NliScores[]>;
}

export type Stage = 'embed' | 'nli';
export type ProgressFn = (stage: Stage, done: number, total: number) => void;

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function groupByQuestion(rows: AnswerRow[]): Map<string, number[]> {
  const byQ = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byQ.get(r.question) ?? [];
    list.push(i);
    byQ.set(r.question, list);
  });
  return byQ;
}

export interface Candidate {
  question: string;
  high: number;
  low: number;
  similarity: number;
  gap: number;
}

/** Same question, wording similar enough, marks far enough apart. */
export function findCandidates(rows: AnswerRow[], embeddings: Float32Array[], settings: Settings) {
  const candidates: Candidate[] = [];
  const compared = new Map<string, number>();
  for (const [question, idx] of groupByQuestion(rows)) {
    let n = 0;
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        n++;
        const i = idx[a];
        const j = idx[b];
        const ri = rows[i];
        const rj = rows[j];
        const max = Math.max(ri.maxMark, rj.maxMark, 1e-9);
        const gap = Math.abs(ri.mark - rj.mark) / max;
        if (gap + 1e-9 < settings.minGapFraction || ri.mark === rj.mark) continue;
        const similarity = dot(embeddings[i], embeddings[j]);
        if (similarity < settings.minSimilarity) continue;
        const [high, low] = ri.mark > rj.mark ? [i, j] : [j, i];
        candidates.push({ question, high, low, similarity, gap });
      }
    }
    compared.set(question, n);
  }
  return { candidates, compared };
}

/** Turns the two NLI directions into a verdict. */
export function judge(highToLow: NliScores, lowToHigh: NliScores, settings: Settings): Verdict {
  const t = settings.entailThreshold;
  if (Math.max(highToLow.contradiction, lowToHigh.contradiction) >= settings.contradictionThreshold) {
    return 'opposite';
  }
  const hl = highToLow.entailment >= t;
  const lh = lowToHigh.entailment >= t;
  if (hl && lh) return 'same';
  if (lh) return 'lowerSaysMore';
  if (hl) return 'higherSaysMore';
  return 'unrelated';
}

export function isFlagged(v: Verdict): boolean {
  return v === 'same' || v === 'lowerSaysMore';
}

export function scorePair(p: { gap: number; similarity: number; verdict: Verdict; highToLow: NliScores; lowToHigh: NliScores }) {
  // Mutual implication is stronger evidence than one-way implication, so it ranks first.
  // Confidence is squared so a confident 3-mark gap outranks a doubtful 5-mark one.
  const meaning = p.verdict === 'same'
    ? Math.min(p.highToLow.entailment, p.lowToHigh.entailment)
    : 0.5 * p.lowToHigh.entailment;
  return p.gap * p.similarity * meaning * meaning;
}

/** Pairs that share an answer are one case: union-find over flagged pairs, per question. */
export function groupCases(pairs: PairResult[], rows: AnswerRow[]): Case[] {
  const flagged = pairs.filter((p) => p.flagged);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of flagged) union(p.high, p.low);

  const groups = new Map<number, PairResult[]>();
  for (const p of flagged) {
    const root = find(p.high);
    const g = groups.get(root) ?? [];
    g.push(p);
    groups.set(root, g);
  }
  const cases: Case[] = [];
  for (const g of groups.values()) {
    const members = [...new Set(g.flatMap((p) => [p.high, p.low]))].sort(
      (a, b) => rows[b].mark - rows[a].mark || rows[a].index - rows[b].index,
    );
    g.sort((a, b) => b.score - a.score);
    const id = 'case-' + members.map((m) => rows[m].index).sort((a, b) => a - b).join('-');
    cases.push({ id, question: g[0].question, rows: members, pairs: g, score: g[0].score });
  }
  return cases.sort((a, b) => b.score - a.score);
}

export function summarise(rows: AnswerRow[], pairs: PairResult[], cases: Case[], compared: Map<string, number>): QuestionSummary[] {
  const out: QuestionSummary[] = [];
  for (const [question, idx] of groupByQuestion(rows)) {
    const qp = pairs.filter((p) => p.question === question);
    const inCases = new Set(cases.filter((c) => c.question === question).flatMap((c) => c.rows));
    out.push({
      question,
      answers: idx.length,
      maxMark: Math.max(...idx.map((i) => rows[i].maxMark)),
      comparedPairs: compared.get(question) ?? 0,
      candidatePairs: qp.length,
      flaggedPairs: qp.filter((p) => p.flagged).length,
      rejectedLookalikes: qp.filter((p) => p.verdict === 'opposite').length,
      answersInCases: inCases.size,
      consistency: idx.length ? 1 - inCases.size / idx.length : 1,
    });
  }
  return out;
}

/** Full run: embed every answer, pick candidates, check meaning in both directions, group into cases. */
export async function analyse(rows: AnswerRow[], engine: Engine, settings: Settings, onProgress?: ProgressFn) {
  const texts = rows.map((r) => r.answer);
  onProgress?.('embed', 0, texts.length);
  const embeddings = await engine.embed(texts, (d) => onProgress?.('embed', d, texts.length));
  onProgress?.('embed', texts.length, texts.length);

  const { candidates, compared } = findCandidates(rows, embeddings, settings);
  // Pass 1: higher-marked answer as premise. Pass 2 (the reverse) is skipped when pass 1 already
  // found a contradiction, because that alone makes the verdict "opposite".
  let total = candidates.length * 2;
  onProgress?.('nli', 0, total);
  const forward = await engine.nli(
    candidates.map((c) => [rows[c.high].answer, rows[c.low].answer] as [string, string]),
    (d) => onProgress?.('nli', d, total),
  );
  const needReverse = candidates.map((_, k) => forward[k].contradiction < settings.contradictionThreshold);
  const reverseIdx = candidates.map((_, k) => k).filter((k) => needReverse[k]);
  total = candidates.length + reverseIdx.length;
  const reverseScores = await engine.nli(
    reverseIdx.map((k) => [rows[candidates[k].low].answer, rows[candidates[k].high].answer] as [string, string]),
    (d) => onProgress?.('nli', candidates.length + d, total),
  );
  onProgress?.('nli', total, total);
  const reverse = new Map(reverseIdx.map((k, i) => [k, reverseScores[i]]));
  const notRun: NliScores = { entailment: 0, contradiction: 0, neutral: 1 };
  const scores = candidates.flatMap((_, k) => [forward[k], reverse.get(k) ?? notRun]);

  const scored: PairResult[] = candidates.map((c, k) => {
    const highToLow = scores[2 * k];
    const lowToHigh = scores[2 * k + 1];
    const verdict = judge(highToLow, lowToHigh, settings);
    const p = { ...c, highToLow, lowToHigh, verdict, flagged: isFlagged(verdict), score: 0 };
    p.score = scorePair(p);
    return p;
  });
  const cases = groupCases(scored, rows);
  return {
    analysis: { rows, settings, pairs: scored, cases, questions: summarise(rows, scored, cases, compared) } as Analysis,
    embeddings,
    compared,
  };
}
