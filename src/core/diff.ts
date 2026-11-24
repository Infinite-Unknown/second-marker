/** Word-level comparison of two answers, for highlighting what they share and where they differ. */

export interface Token {
  text: string;
  /** Whitespace that followed the token in the original text. */
  space: string;
  /** True when this word also appears, in order, in the other answer. */
  shared: boolean;
  /** Punctuation is never highlighted on its own. */
  word: boolean;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function tokenize(text: string): Omit<Token, 'shared'>[] {
  const out: Omit<Token, 'shared'>[] = [];
  const re = /(\S+)(\s*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[1], space: m[2], word: norm(m[1]) !== '' });
  return out;
}

/** Longest common subsequence over normalised words; marks tokens in both answers. */
export function compareWords(a: string, b: string): [Token[], Token[]] {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const na = ta.map((t) => norm(t.text));
  const nb = tb.map((t) => norm(t.text));
  const n = na.length;
  const m = nb.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = na[i] !== '' && na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const sa = new Array<boolean>(n).fill(false);
  const sb = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (na[i] !== '' && na[i] === nb[j]) {
      sa[i] = sb[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return [ta.map((t, k) => ({ ...t, shared: sa[k] })), tb.map((t, k) => ({ ...t, shared: sb[k] }))];
}

/** Share of words (in the longer answer) that the two answers have in common. */
export function overlap(a: Token[], b: Token[]): number {
  const wa = a.filter((t) => t.word);
  const wb = b.filter((t) => t.word);
  const shared = wa.filter((t) => t.shared).length;
  return Math.max(wa.length, wb.length) ? shared / Math.max(wa.length, wb.length) : 0;
}
