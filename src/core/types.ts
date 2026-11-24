/** One marked answer, after column mapping. */
export interface AnswerRow {
  /** Index of the row in the uploaded file (0-based, header excluded). */
  index: number;
  question: string;
  studentId: string;
  answer: string;
  mark: number;
  maxMark: number;
  marker?: string;
}

export interface Settings {
  /** Cosine similarity (0..1) two answers need before the meaning check runs. */
  minSimilarity: number;
  /** Minimum mark gap, as a fraction of the question's max mark. */
  minGapFraction: number;
  /** Entailment probability that counts as "says it". */
  entailThreshold: number;
  /** Contradiction probability that counts as "says the opposite". */
  contradictionThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  minSimilarity: 0.6,
  minGapFraction: 0.3,
  entailThreshold: 0.6,
  contradictionThreshold: 0.5,
};

export interface NliScores {
  entailment: number;
  contradiction: number;
  neutral: number;
}

/**
 * The verdict on one similar-looking pair:
 * - same: both answers entail each other. Flagged.
 * - lowerSaysMore: the lower-marked answer entails the higher one, not the reverse. Flagged.
 * - higherSaysMore: the higher-marked answer covers more. The gap is explained, not flagged.
 * - opposite: one contradicts the other (look-alike). Rejected.
 * - unrelated: neither entails the other. Not flagged.
 */
export type Verdict = 'same' | 'lowerSaysMore' | 'higherSaysMore' | 'opposite' | 'unrelated';

export interface PairResult {
  question: string;
  /** Row index of the higher-marked answer. */
  high: number;
  /** Row index of the lower-marked answer. */
  low: number;
  similarity: number;
  /** high -> low (premise high, hypothesis low). */
  highToLow: NliScores;
  /** low -> high. */
  lowToHigh: NliScores;
  verdict: Verdict;
  flagged: boolean;
  /** Mark gap as a fraction of max mark. */
  gap: number;
  /** Ranking score, higher means look first. */
  score: number;
}

export interface Case {
  id: string;
  question: string;
  /** Row indexes in this case, sorted by mark descending. */
  rows: number[];
  pairs: PairResult[];
  score: number;
}

export interface QuestionSummary {
  question: string;
  answers: number;
  maxMark: number;
  comparedPairs: number;
  candidatePairs: number;
  flaggedPairs: number;
  rejectedLookalikes: number;
  answersInCases: number;
  /** Share of answers not involved in any flagged case. */
  consistency: number;
}

export interface Analysis {
  rows: AnswerRow[];
  settings: Settings;
  pairs: PairResult[];
  cases: Case[];
  questions: QuestionSummary[];
}

export type Decision = 'right' | 'remark' | 'skip';

export interface CaseDecision {
  decision: Decision;
  reason?: string;
  at: string;
}
