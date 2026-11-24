import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../src/core/csv';
import { applyMapping, guessMapping } from '../src/core/mapping';
import { compareWords } from '../src/core/diff';
import { analyse, groupCases, judge, type Engine } from '../src/core/pipeline';
import { anonymise, caseDecision, reportCsv, setCaseDecision } from '../src/core/report';
import { DEFAULT_SETTINGS, type AnswerRow, type NliScores, type PairResult } from '../src/core/types';

describe('csv', () => {
  it('reads quotes, escaped quotes, embedded newlines and CRLF', () => {
    const t = parseCsv('a,b\r\n"x, y","he said ""hi""\nthen left"\r\n');
    expect(t).toEqual([['a', 'b'], ['x, y', 'he said "hi"\nthen left']]);
  });
  it('detects semicolon files and strips a BOM', () => {
    expect(parseCsv('﻿q;mark\nQ1;3,5\n')).toEqual([['q', 'mark'], ['Q1', '3,5']]);
  });
  it('round-trips through toCsv', () => {
    const rows = [['a', 'b,c', 'd"e']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('column mapping', () => {
  const table = parseCsv('Question,Student ID,Response,Score,Out of,Grader\nQ1,s1,An answer,3,5,A\nQ1,s2,,4,5,B\nQ1,s3,Another,x,5,A\nQ1,s4,Third,2.5,5,\n');
  it('guesses columns from common header names', () => {
    expect(guessMapping(table[0])).toEqual({ question: 0, studentId: 1, answer: 2, mark: 3, maxMark: 4, marker: 5 });
  });
  it('skips rows with no answer or an unreadable mark', () => {
    const r = applyMapping(table, guessMapping(table[0]));
    expect(r.rows.map((x) => x.studentId)).toEqual(['s1', 's4']);
    expect(r.skipped).toBe(2);
    expect(r.rows[1].mark).toBe(2.5);
    expect(r.rows[1].marker).toBeUndefined();
  });
  it('reports missing required columns', () => {
    const m = { ...guessMapping(table[0]), answer: -1 };
    expect(applyMapping(table, m).errors[0]).toMatch(/Answer/);
  });
});

describe('word comparison', () => {
  it('marks shared words in order and leaves the rest', () => {
    const [a, b] = compareWords('A stack is LIFO.', 'A stack is FIFO.');
    expect(a.map((t) => t.shared)).toEqual([true, true, true, false]);
    expect(b.find((t) => t.text === 'FIFO.')?.shared).toBe(false);
  });
});

const s = (entailment: number, contradiction = 0): NliScores => ({ entailment, contradiction, neutral: 1 - entailment - contradiction });

describe('verdicts', () => {
  it('flags mutual implication, and a lower answer that says more', () => {
    expect(judge(s(0.9), s(0.8), DEFAULT_SETTINGS)).toBe('same');
    expect(judge(s(0.1), s(0.9), DEFAULT_SETTINGS)).toBe('lowerSaysMore');
  });
  it('explains a gap when the higher answer says more, and rejects contradictions', () => {
    expect(judge(s(0.9), s(0.1), DEFAULT_SETTINGS)).toBe('higherSaysMore');
    expect(judge(s(0.6, 0.3), s(0.1, 0.8), DEFAULT_SETTINGS)).toBe('opposite');
    expect(judge(s(0.2), s(0.2), DEFAULT_SETTINGS)).toBe('unrelated');
  });
});

const row = (i: number, question: string, answer: string, mark: number): AnswerRow => ({ index: i, question, studentId: `s${i}`, answer, mark, maxMark: 5 });

/** Fake engine: embeddings from a lookup, NLI from a rule (texts sharing a tag imply each other). */
function fakeEngine(vecs: Record<string, number[]>, implies: (p: string, h: string) => NliScores): Engine {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = Float32Array.from(vecs[t]);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
    async nli(pairs) {
      return pairs.map(([p, h]) => implies(p, h));
    },
  };
}

describe('pipeline', () => {
  const rows = [
    row(0, 'Q1', 'stack is LIFO', 5),
    row(1, 'Q1', 'stack is last in first out', 1),
    row(2, 'Q1', 'stack is FIFO', 0),
    row(3, 'Q1', 'something else', 0),
    row(4, 'Q2', 'stack is LIFO', 1),
  ];
  const vecs = {
    'stack is LIFO': [1, 0.1, 0],
    'stack is last in first out': [1, 0.15, 0],
    'stack is FIFO': [1, 0.12, 0.05],
    'something else': [0, 0, 1],
  };
  const engine = fakeEngine(vecs, (p, h) => {
    const lifo = (t: string) => /LIFO|last in/.test(t);
    if (lifo(p) && lifo(h)) return s(0.95);
    if (lifo(p) !== lifo(h) && (/FIFO/.test(p) || /FIFO/.test(h))) return s(0.02, 0.95);
    return s(0.05);
  });

  it('flags the paraphrase pair, rejects the look-alike, never compares across questions', async () => {
    const { analysis } = await analyse(rows, engine, DEFAULT_SETTINGS);
    const flagged = analysis.pairs.filter((p) => p.flagged).map((p) => [p.high, p.low]);
    expect(flagged).toEqual([[0, 1]]);
    expect(analysis.pairs.find((p) => p.high === 0 && p.low === 2)?.verdict).toBe('opposite');
    expect(analysis.pairs.some((p) => rows[p.high].question !== rows[p.low].question)).toBe(false);
    expect(analysis.cases).toHaveLength(1);
    expect(analysis.questions.find((q) => q.question === 'Q1')?.consistency).toBe(0.5);
  });

  it('skips the reverse meaning check when the first direction already contradicts', async () => {
    let calls = 0;
    const counting: Engine = { embed: engine.embed, nli: async (pairs) => ((calls += pairs.length), engine.nli(pairs)) };
    const { analysis } = await analyse(rows, counting, DEFAULT_SETTINGS);
    expect(calls).toBe(analysis.pairs.length * 2 - analysis.pairs.filter((p) => p.verdict === 'opposite').length);
  });

  it('groups pairs that share an answer into one case', () => {
    const r = [row(0, 'Q', 'a', 5), row(1, 'Q', 'b', 1), row(2, 'Q', 'c', 0)];
    const p = (high: number, low: number, score: number): PairResult => ({
      question: 'Q', high, low, similarity: 0.9, highToLow: s(0.9), lowToHigh: s(0.9), verdict: 'same', flagged: true, gap: 0.8, score,
    });
    const cases = groupCases([p(0, 1, 0.5), p(0, 2, 0.7)], r);
    expect(cases).toHaveLength(1);
    expect(cases[0].rows).toEqual([0, 1, 2]);
    expect(cases[0].pairs[0].low).toBe(2);
  });
});

describe('report', () => {
  it('uses anonymous codes and keeps decisions when cases regroup', async () => {
    const rows = [row(0, 'Q', 'x', 5), row(1, 'Q', 'x', 1)];
    const engine = fakeEngine({ x: [1, 0] }, () => s(0.99));
    const { analysis } = await analyse(rows, engine, DEFAULT_SETTINGS);
    expect([...anonymise(analysis).values()]).toEqual(['S-01', 'S-02']);
    const decisions = {};
    setCaseDecision(analysis, decisions, analysis.cases[0], { decision: 'remark', at: 'now' });
    const regrouped = await analyse(rows, engine, { ...DEFAULT_SETTINGS, minSimilarity: 0.5 });
    expect(caseDecision(regrouped.analysis, decisions, regrouped.analysis.cases[0])?.decision).toBe('remark');
    const csv = reportCsv(analysis, decisions);
    expect(csv).toContain('S-01');
    expect(csv).not.toContain('s0');
    expect(csv).toContain('Needs re-mark');
  });
});
