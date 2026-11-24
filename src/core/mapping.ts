import type { AnswerRow } from './types';

export type Field = 'question' | 'studentId' | 'answer' | 'mark' | 'maxMark' | 'marker';

export const FIELDS: { key: Field; label: string; required: boolean }[] = [
  { key: 'question', label: 'Question', required: true },
  { key: 'studentId', label: 'Student id', required: true },
  { key: 'answer', label: 'Answer', required: true },
  { key: 'mark', label: 'Mark', required: true },
  { key: 'maxMark', label: 'Max mark', required: false },
  { key: 'marker', label: 'Marker', required: false },
];

/** Column index per field; -1 means not mapped. */
export type Mapping = Record<Field, number>;

const HINTS: Record<Field, RegExp> = {
  question: /^(question|q|item|question[ _-]?(id|text|no|number))$/i,
  studentId: /^(student|student[ _-]?(id|no|number|code)|id|candidate|learner)$/i,
  answer: /^(answer|response|student[ _-]?answer|text)$/i,
  mark: /^(mark|marks|score|grade|points|awarded)$/i,
  maxMark: /^(max|max[ _-]?(mark|marks|score|points)|out[ _-]?of|total)$/i,
  marker: /^(marker|grader|examiner|assessor|marked[ _-]?by|tutor)$/i,
};

export function guessMapping(header: string[]): Mapping {
  const mapping = {} as Mapping;
  const used = new Set<number>();
  for (const { key } of FIELDS) {
    const idx = header.findIndex((h, i) => !used.has(i) && HINTS[key].test(h.trim()));
    mapping[key] = idx;
    if (idx >= 0) used.add(idx);
  }
  return mapping;
}

export interface MappingResult {
  rows: AnswerRow[];
  errors: string[];
  /** Rows skipped because the answer was empty or the mark unreadable. */
  skipped: number;
}

export function applyMapping(table: string[][], mapping: Mapping, defaultMax?: number): MappingResult {
  const errors: string[] = [];
  for (const f of FIELDS) {
    if (f.required && mapping[f.key] < 0) errors.push(`Choose a column for "${f.label}".`);
  }
  if (errors.length) return { rows: [], errors, skipped: 0 };

  const body = table.slice(1);
  const rows: AnswerRow[] = [];
  let skipped = 0;
  // Max mark per question: from the column if mapped, otherwise the highest mark seen (or defaultMax).
  const seenMax = new Map<string, number>();
  body.forEach((r) => {
    const q = (r[mapping.question] ?? '').trim();
    const m = parseFloat((r[mapping.mark] ?? '').replace(',', '.'));
    if (q && Number.isFinite(m)) seenMax.set(q, Math.max(seenMax.get(q) ?? 0, m));
  });

  body.forEach((r, index) => {
    const question = (r[mapping.question] ?? '').trim();
    const answer = (r[mapping.answer] ?? '').trim();
    const mark = parseFloat((r[mapping.mark] ?? '').replace(',', '.'));
    if (!question || !answer || !Number.isFinite(mark)) {
      skipped++;
      return;
    }
    let maxMark = mapping.maxMark >= 0 ? parseFloat((r[mapping.maxMark] ?? '').replace(',', '.')) : NaN;
    if (!Number.isFinite(maxMark) || maxMark <= 0) maxMark = defaultMax ?? Math.max(seenMax.get(question) ?? 1, 1);
    rows.push({
      index,
      question,
      studentId: (r[mapping.studentId] ?? '').trim() || `row-${index + 1}`,
      answer,
      mark,
      maxMark,
      marker: mapping.marker >= 0 ? (r[mapping.marker] ?? '').trim() || undefined : undefined,
    });
  });
  if (rows.length === 0) errors.push('No usable rows: every row was missing a question, an answer or a numeric mark.');
  return { rows, errors, skipped };
}
