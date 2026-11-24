/// <reference lib="webworker" />
/**
 * Runs both models off the main thread. Answers arrive by postMessage and never leave this
 * worker except as numbers (embeddings stay here; only verdicts go back to the page).
 */
import { env, AutoTokenizer, AutoModelForSequenceClassification, pipeline } from '@huggingface/transformers';
import { cachedEngine, createEngine, MODELS, type EmbedStore } from './core/engine';
import { analyse, type Engine } from './core/pipeline';
// The ONNX runtime files are emitted by the build and served from this site, not a CDN.
import ortWasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import type { AnswerRow, Settings } from './core/types';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerRequest =
  | { type: 'init'; baseUrl: string }
  | { type: 'analyse'; id: number; rows: AnswerRow[]; settings: Settings };

export type WorkerMessage =
  | { type: 'download'; loaded: number; total: number; files: number; cached: boolean }
  | { type: 'ready'; device: string; threads: number }
  | { type: 'progress'; id: number; stage: 'embed' | 'nli'; done: number; total: number }
  | { type: 'net'; url: string; bytes: number }
  | { type: 'result'; id: number; analysis: import('./core/types').Analysis; ms: number; timings: Record<string, number>; threads: number }
  | { type: 'error'; id?: number; message: string };

const post = (m: WorkerMessage) => self.postMessage(m);

// Report every network request this worker makes (model files), so the page can show them.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceResourceTiming[]) {
      post({ type: 'net', url: e.name, bytes: e.transferSize || e.encodedBodySize || 0 });
    }
  }).observe({ type: 'resource', buffered: true });
} catch {
  /* PerformanceObserver unavailable: the page shows its own requests only */
}

/** IndexedDB cache of embeddings, keyed by a SHA-256 of model id + answer, so no answer text is stored. */
function idbStore(): EmbedStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  const dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('second-marker', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('embeddings');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const hash = async (t: string) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(MODELS.embedding.id + '\u0000' + t));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  return {
    async getMany(texts) {
      try {
        const db = await dbp;
        const keys = await Promise.all(texts.map(hash));
        const tx = db.transaction('embeddings', 'readonly');
        const store = tx.objectStore('embeddings');
        return await Promise.all(
          keys.map(
            (k) =>
              new Promise<Float32Array | undefined>((res) => {
                const r = store.get(k);
                r.onsuccess = () => res(r.result instanceof Float32Array ? r.result : undefined);
                r.onerror = () => res(undefined);
              }),
          ),
        );
      } catch {
        return texts.map(() => undefined);
      }
    },
    async setMany(entries) {
      try {
        const db = await dbp;
        const keys = await Promise.all(entries.map(([t]) => hash(t)));
        const tx = db.transaction('embeddings', 'readwrite');
        const store = tx.objectStore('embeddings');
        entries.forEach(([, v], i) => store.put(v, keys[i]));
      } catch {
        /* cache is best effort */
      }
    },
  };
}

let enginePromise: Promise<Engine> | null = null;
let threads = 1;

function loadEngine(): Promise<Engine> {
  if (enginePromise) return enginePromise;
  env.allowLocalModels = false;
  const wasm = env.backends.onnx.wasm!;
  // Serve the ONNX runtime from this site instead of a third-party CDN.
  wasm.wasmPaths = {
    mjs: new URL(ortMjsUrl, self.location.href).href,
    wasm: new URL(ortWasmUrl, self.location.href).href,
  };
  // Threads need cross-origin isolation (headers, or the service worker on static hosts).
  wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  threads = wasm.numThreads;

  // Sum download progress across all model files.
  const files = new Map<string, { loaded: number; total: number }>();
  let fromNetwork = false;
  const progress_callback = (info: unknown) => {
    const p = info as { status: string; file?: string; name?: string; loaded?: number; total?: number };
    if (p.status === 'progress' && p.file) {
      fromNetwork = true;
      files.set(p.name + '/' + p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: 'download', loaded, total, files: files.size, cached: false });
    }
  };
  const T = { env, AutoTokenizer, AutoModelForSequenceClassification, pipeline };
  enginePromise = createEngine(T, { device: 'wasm', progress_callback })
    .then((e) => {
      if (!fromNetwork) post({ type: 'download', loaded: 0, total: 0, files: 0, cached: true });
      post({ type: 'ready', device: 'wasm', threads });
      return cachedEngine(e, idbStore());
    })
    .catch((err) => {
      enginePromise = null;
      throw err;
    });
  return enginePromise;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') return;
  if (msg.type === 'analyse') {
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    try {
      const engine = await loadEngine();
      timings.load = performance.now() - t0;
      let last = performance.now();
      let stageNow = '';
      const { analysis } = await analyse(msg.rows, engine, msg.settings, (stage, done, total) => {
        if (stage !== stageNow) {
          const now = performance.now();
          if (stageNow) timings[stageNow] = now - last;
          last = now;
          stageNow = stage;
        }
        post({ type: 'progress', id: msg.id, stage, done, total });
      });
      if (stageNow) timings[stageNow] = performance.now() - last;
      post({ type: 'result', id: msg.id, analysis, ms: performance.now() - t0, timings, threads });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      post({ type: 'error', id: msg.id, message: text });
    }
  }
};
