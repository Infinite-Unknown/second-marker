import { defineConfig } from 'vite';

// Cross-origin isolation lets the ONNX runtime use several threads.
// Static hosts (GitHub Pages) cannot send these headers; public/sw.js adds them there.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Relative base so the built site works from any sub-path (GitHub Pages project sites).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
