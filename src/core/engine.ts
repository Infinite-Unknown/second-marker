import type { Engine } from './pipeline';
import type { NliScores } from './types';

/** The two models the app runs. Both are ONNX conversions served from the Hugging Face hub. */
export const MODELS = {
  embedding: {
    id: 'Xenova/all-MiniLM-L6-v2',
    source: 'sentence-transformers/all-MiniLM-L6-v2',
    licence: 'Apache-2.0',
    dtype: 'q8',
    purpose: 'Sentence embeddings: finds answers that are worded alike.',
  },
  nli: {
    id: 'onnx-community/ModernBERT-base-nli-ONNX',
    source: 'tasksource/ModernBERT-base-nli',
    licence: 'Apache-2.0',
    dtype: 'q8',
    purpose: 'Natural-language inference: checks the two answers actually say the same thing.',
  },
} as const;


// The transformers module type differs between the web and node builds; only these calls are used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transformers = any;

export interface EngineOptions {
  device?: string;
  /** Override the NLI model (used by the model comparison script). */
  nli?: { id: string; dtype: string; labels?: string[] };
  batchSize?: number;
  progress_callback?: (info: unknown) => void;
}

function softmax(row: number[]): number[] {
  const m = Math.max(...row);
  const e = row.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export async function createEngine(T: Transformers, opts: EngineOptions = {}): Promise<Engine> {
  const batchSize = opts.batchSize ?? 8;
  const common = { device: opts.device ?? 'wasm', progress_callback: opts.progress_callback };
  const extractor = await T.pipeline('feature-extraction', MODELS.embedding.id, { ...common, dtype: MODELS.embedding.dtype });
  const nliSpec = opts.nli ?? MODELS.nli;
  const tokenizer = await T.AutoTokenizer.from_pretrained(nliSpec.id, { progress_callback: opts.progress_callback });
  const nliModel = await T.AutoModelForSequenceClassification.from_pretrained(nliSpec.id, {
    ...common,
    dtype: nliSpec.dtype,
  });
  // Label order comes from the model's config (id2label), e.g. contradiction / entailment / neutral.
  const id2label: Record<string, string> = opts.nli?.labels ? { ...opts.nli.labels } : nliModel.config.id2label;
  const labelAt = (j: number) => {
    const l = String(id2label[j] ?? '').toLowerCase();
    if (l.startsWith('entail')) return 'entailment';
    if (l.startsWith('contra')) return 'contradiction';
    return 'neutral';
  };

  return {
    async embed(texts, onProgress) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const t = await extractor(batch, { pooling: 'mean', normalize: true });
        const dim = t.dims[1];
        const data = t.data as Float32Array;
        for (let k = 0; k < batch.length; k++) out.push(data.slice(k * dim, (k + 1) * dim));
        onProgress?.(out.length);
      }
      return out;
    },
    async nli(pairs, onProgress) {
      const out: NliScores[] = [];
      for (let i = 0; i < pairs.length; i += batchSize) {
        const batch = pairs.slice(i, i + batchSize);
        const inputs = tokenizer(
          batch.map((p) => p[0]),
          { text_pair: batch.map((p) => p[1]), padding: true, truncation: true },
        );
        const { logits } = await nliModel(inputs);
        const [n, k] = logits.dims as number[];
        const data = Array.from(logits.data as Float32Array);
        for (let r = 0; r < n; r++) {
          const probs = softmax(data.slice(r * k, (r + 1) * k));
          const s: NliScores = { contradiction: 0, entailment: 0, neutral: 0 };
          probs.forEach((pr, j) => (s[labelAt(j)] += pr));
          out.push(s);
        }
        onProgress?.(out.length);
      }
      return out;
    },
  };
}

/** Wraps an engine with in-memory caches so re-running with new settings does not repeat model calls. */
export function cachedEngine(inner: Engine, embedStore?: EmbedStore): Engine & { clear(): void } {
  const nliCache = new Map<string, NliScores>();
  const embCache = new Map<string, Float32Array>();
  return {
    clear() {
      nliCache.clear();
    },
    async embed(texts, onProgress) {
      const missing = [...new Set(texts.filter((t) => !embCache.has(t)))];
      if (embedStore && missing.length) {
        const stored = await embedStore.getMany(missing);
        stored.forEach((v, i) => v && embCache.set(missing[i], v));
      }
      const still = missing.filter((t) => !embCache.has(t));
      const already = texts.length - still.length;
      if (still.length) {
        const vecs = await inner.embed(still, (d) => onProgress?.(Math.min(texts.length, already + d)));
        still.forEach((t, i) => embCache.set(t, vecs[i]));
        if (embedStore) await embedStore.setMany(still.map((t, i) => [t, vecs[i]]));
      }
      onProgress?.(texts.length);
      return texts.map((t) => embCache.get(t)!);
    },
    async nli(pairs, onProgress) {
      const key = (p: [string, string]) => p[0] + '\u0000' + p[1];
      const missing = pairs.filter((p) => !nliCache.has(key(p)));
      const already = pairs.length - missing.length;
      if (missing.length) {
        const scores = await inner.nli(missing, (d) => onProgress?.(already + d));
        missing.forEach((p, i) => nliCache.set(key(p), scores[i]));
      }
      onProgress?.(pairs.length);
      return pairs.map((p) => nliCache.get(key(p))!);
    },
  };
}

/** Persistent embedding cache (IndexedDB in the browser). Keys are answer texts. */
export interface EmbedStore {
  getMany(texts: string[]): Promise<(Float32Array | undefined)[]>;
  setMany(entries: [string, Float32Array][]): Promise<void>;
}
