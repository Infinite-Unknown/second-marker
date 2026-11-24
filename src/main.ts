import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { parseCsv } from './core/csv';
import { applyMapping, FIELDS, guessMapping, type Field, type Mapping } from './core/mapping';
import { compareWords } from './core/diff';
import { anonymise, caseDecision, codeKeyCsv, DECISION_LABEL, reportCsv, setCaseDecision, verdictText, wordingLabel } from './core/report';
import { MODELS } from './core/engine';
import { DEFAULT_SETTINGS, type Analysis, type AnswerRow, type Case, type CaseDecision, type Decision, type PairResult, type Settings } from './core/types';
import { icons } from './icons';
import type { WorkerMessage, WorkerRequest } from './worker';

/* ------------------------------------------------------------------ state */

type Screen = 'load' | 'map' | 'reading' | 'results';
type Tab = 'cases' | 'aside' | 'questions' | 'report';

interface State {
  screen: Screen;
  fileName: string;
  sample: boolean;
  dataKey: string;
  table: string[][];
  mapping: Mapping;
  rows: AnswerRow[];
  skipped: number;
  settings: Settings;
  analysis: Analysis | null;
  decisions: Record<string, CaseDecision>;
  caseIndex: number;
  tab: Tab;
  error: string;
  download: { loaded: number; total: number; cached: boolean | null };
  progress: { embed: [number, number]; nli: [number, number] };
  net: { url: string; bytes: number }[];
  requestId: number;
  arriving: boolean;
  tuning: 'idle' | 'busy';
  tuneOpen: boolean;
  lastRun: { ms: number; threads: number } | null;
}

const state: State = {
  screen: 'load',
  fileName: '',
  sample: false,
  dataKey: '',
  table: [],
  mapping: {} as Mapping,
  rows: [],
  skipped: 0,
  settings: { ...DEFAULT_SETTINGS },
  analysis: null,
  decisions: {},
  caseIndex: 0,
  tab: 'cases',
  error: '',
  download: { loaded: 0, total: 0, cached: null },
  progress: { embed: [0, 0], nli: [0, 0] },
  net: [],
  requestId: 0,
  arriving: false,
  tuning: 'idle',
  tuneOpen: false,
  lastRun: null,
};

const app = document.getElementById('app')!;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ helpers */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtMark = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const mb = (b: number) => (b / 1e6).toFixed(0);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function save(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let toastTimer = 0;
function toast(text: string) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.hidden = true;
    document.body.append(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => (el!.hidden = false));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.hidden = true), 2400);
}

/* Decisions are kept in this browser only, keyed by a hash of the file. */
const decisionsKey = () => `second-marker:decisions:v2:${state.dataKey}`;
function loadDecisions() {
  try {
    state.decisions = JSON.parse(localStorage.getItem(decisionsKey()) ?? '{}');
  } catch {
    state.decisions = {};
  }
}
function storeDecisions() {
  try {
    localStorage.setItem(decisionsKey(), JSON.stringify(state.decisions));
  } catch {
    /* storage blocked: decisions live for this session only */
  }
}

const dec = (c: Case) => caseDecision(state.analysis!, state.decisions, c);

/* ------------------------------------------------------------------ network log */

// Main-thread requests made after a file is opened (the worker reports its own).
let watchingNet = false;
try {
  new PerformanceObserver((list) => {
    if (!watchingNet) return;
    for (const e of list.getEntries() as PerformanceResourceTiming[]) {
      state.net.push({ url: e.name, bytes: e.transferSize || 0 });
    }
    renderNet();
  }).observe({ type: 'resource' });
} catch {
  /* not supported */
}

function netSummary() {
  const hosts = new Map<string, { n: number; bytes: number }>();
  for (const r of state.net) {
    let host = 'this site';
    try {
      const u = new URL(r.url);
      host = u.origin === location.origin ? 'this site' : u.hostname.replace(/^cdn-lfs[^.]*\./, '').replace(/^cas-bridge\.xethub\./, 'xethub.');
    } catch {
      /* keep default */
    }
    const h = hosts.get(host) ?? { n: 0, bytes: 0 };
    h.n++;
    h.bytes += r.bytes;
    hosts.set(host, h);
  }
  return hosts;
}

function netText() {
  const hosts = netSummary();
  if (state.net.length === 0) {
    return `<strong>0 network requests</strong> since your file was opened. Everything is running in this tab.`;
  }
  const list = [...hosts].map(([h, v]) => `${esc(h)} (${v.n})`).join(', ');
  return `<strong>${plural(state.net.length, 'request')}</strong> since your file was opened, all downloads of model and runtime files: ${list}. No request carries your answers.`;
}

function renderNet() {
  const el = document.getElementById('net');
  if (el) el.innerHTML = netText();
}

/* ------------------------------------------------------------------ isolation */

// On static hosts the service worker supplies the isolation headers; it takes effect after one reload.
if (import.meta.env.PROD && !self.crossOriginIsolated && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register(new URL('sw.js', new URL(import.meta.env.BASE_URL, location.href)))
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      let reloaded = false;
      try {
        reloaded = sessionStorage.getItem('second-marker:isolation-reload') === '1';
        sessionStorage.setItem('second-marker:isolation-reload', '1');
      } catch {
        reloaded = true;
      }
      if (!reloaded && state.screen === 'load') location.reload();
    })
    .catch(() => {
      /* runs single-threaded without it */
    });
}

/* ------------------------------------------------------------------ worker */

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: WorkerRequest) => worker.postMessage(m);
send({ type: 'init', baseUrl: new URL(import.meta.env.BASE_URL, location.href).href });

worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const m = ev.data;
  switch (m.type) {
    case 'net':
      if (watchingNet) {
        state.net.push({ url: m.url, bytes: m.bytes });
        renderNet();
      }
      break;
    case 'download':
      state.download = { loaded: m.loaded, total: m.total, cached: m.cached };
      updateReading();
      break;
    case 'progress':
      if (m.id !== state.requestId) return;
      state.progress[m.stage] = [m.done, m.total];
      updateReading();
      if (state.screen === 'results') updateTuneStatus();
      break;
    case 'result':
      if (m.id !== state.requestId) return;
      if (state.screen === 'reading') state.lastRun = { ms: m.ms, threads: m.threads };
      onAnalysis(m.analysis);
      break;
    case 'error':
      if (m.id !== undefined && m.id !== state.requestId) return;
      state.error = friendlyError(m.message);
      if (state.screen === 'reading') {
        state.screen = 'map';
        render();
      } else {
        toast(state.error);
      }
      break;
  }
};

function friendlyError(message: string) {
  if (/fetch|network|Failed to load|NetworkError/i.test(message)) {
    return 'The models could not be downloaded. Check your connection and try again; after one successful run they are cached and work offline.';
  }
  return `The models stopped with an error: ${message}`;
}

/* ------------------------------------------------------------------ flow */

async function openCsv(text: string, name: string, sample: boolean) {
  const table = parseCsv(text);
  state.error = '';
  if (table.length < 2) {
    state.error = `${name} has no rows under its header. Export the marksheet as CSV with one row per answer.`;
    render();
    return;
  }
  state.table = table;
  state.fileName = name;
  state.sample = sample;
  state.dataKey = await sha(text);
  state.mapping = guessMapping(table[0]);
  state.screen = 'map';
  render();
}

async function loadSample() {
  try {
    const res = await fetch(new URL('sample-class.csv', new URL(import.meta.env.BASE_URL, location.href)));
    if (!res.ok) throw new Error(String(res.status));
    await openCsv(await res.text(), 'sample-class.csv', true);
  } catch {
    state.error = 'The sample class could not be loaded from this site. Reload the page and try again.';
    render();
  }
}

function startAnalysis() {
  const res = applyMapping(state.table, state.mapping);
  if (res.errors.length) {
    state.error = res.errors.join(' ');
    render();
    return;
  }
  state.rows = res.rows;
  state.skipped = res.skipped;
  state.error = '';
  state.progress = { embed: [0, res.rows.length], nli: [0, 0] };
  state.net = [];
  watchingNet = true;
  state.screen = 'reading';
  loadDecisions();
  render();
  state.requestId++;
  send({ type: 'analyse', id: state.requestId, rows: state.rows, settings: state.settings });
}

function onAnalysis(analysis: Analysis) {
  const first = state.screen === 'reading';
  state.analysis = analysis;
  state.tuning = 'idle';
  if (first) {
    state.screen = 'results';
    state.tab = 'cases';
    state.caseIndex = Math.max(0, analysis.cases.findIndex((c) => !caseDecision(analysis, state.decisions, c)));
    state.arriving = !reduceMotion.matches;
    render();
    if (state.arriving) setTimeout(() => {
      state.arriving = false;
      document.querySelector('.results')?.classList.remove('is-arriving');
    }, 2000);
  } else {
    state.caseIndex = Math.min(state.caseIndex, Math.max(0, analysis.cases.length - 1));
    renderResultsParts();
    updateTuneStatus();
  }
}

let tuneTimer = 0;
function retune() {
  clearTimeout(tuneTimer);
  tuneTimer = window.setTimeout(() => {
    state.tuning = 'busy';
    updateTuneStatus();
    state.requestId++;
    send({ type: 'analyse', id: state.requestId, rows: state.rows, settings: state.settings });
  }, 160);
}

function startOver() {
  state.screen = 'load';
  state.analysis = null;
  state.table = [];
  state.rows = [];
  state.error = '';
  state.decisions = {};
  watchingNet = false;
  render();
}

/* ------------------------------------------------------------------ render */

function shell(inner: string) {
  const local = `<span class="local-chip">${icons.lock}<span>Runs in this tab<span class="hide-sm">. Nothing is uploaded</span>.</span></span>`;
  return `
    <header class="topbar">
      <button class="wordmark" data-act="home" aria-label="Second Marker, start over">${icons.mark}<span>Second Marker</span></button>
      ${local}
    </header>
    <main class="stage">${inner}</main>
    <footer class="colophon">
      <span>Models run in your browser: ${esc(MODELS.embedding.source)} and ${esc(MODELS.nli.source)} (both Apache-2.0), via Transformers.js and ONNX Runtime Web.</span>
      <span>A person decides every case. The tool never changes a mark.</span>
    </footer>`;
}

function render() {
  const views: Record<Screen, () => string> = { load: viewLoad, map: viewMap, reading: viewReading, results: viewResults };
  app.innerHTML = shell(views[state.screen]());
  if (state.screen === 'results') afterResultsRender();
  if (state.screen === 'reading') updateReading();
}

/* ---------- load ---------- */

function viewLoad() {
  const cols = FIELDS.map(
    (f) => `<li><span class="label">${esc(f.label)}</span>${f.required ? '' : '<span class="opt">optional</span>'}</li>`,
  ).join('');
  return `
  <section class="sheet enter" aria-labelledby="title">
    <div class="load">
      <div class="enter-stagger">
        <h1 id="title" style="--k:0">Same answer. Different mark.</h1>
        <p class="lead" style="--k:1">Second Marker finds the students who wrote the same answer to a question and got different marks. Drop in a marked spreadsheet: two small language models compare every answer with every other answer, here in your browser, and bring you each pair that disagrees with the evidence. You decide every case.</p>
        <div class="actions" style="--k:2">
          <button class="btn btn--primary" data-act="sample">Try the sample class ${icons.arrowRight}</button>
          <label class="btn" for="file">Choose a CSV file</label>
        </div>
        <p class="meta sample-note" style="--k:3">The sample class is illustrative: 66 short answers to four data-structures questions, written for this demo. It is not real student work.</p>
        ${state.error ? `<p class="error-line" role="alert">${esc(state.error)}</p>` : ''}
      </div>
      <div class="dropbox" id="drop">
        <ul class="form-cols" aria-label="Columns the file needs">${cols}</ul>
        <label class="dropbox__inner" for="file">
          ${icons.upload}
          <strong>Drop a .csv marksheet here</strong>
          <span class="meta">One row per answer. Column names can be anything; you match them next.</span>
        </label>
        <input id="file" class="sr-only" type="file" accept=".csv,.tsv,.txt,text/csv" />
      </div>
    </div>
    <div class="load-foot">
      <div><span class="label">Stays on this computer</span><p>Answers are read in this tab and never sent anywhere. The page shows every network request it makes.</p></div>
      <div><span class="label">Two models, one decision each</span><p>One finds answers worded alike. The second checks each answer implies the other, so "is" and "is not" are not confused.</p></div>
      <div><span class="label">First run</span><p>Downloads the two models once (about 255 MB) from Hugging Face. After that they are cached and it works offline.</p></div>
    </div>
  </section>`;
}

/* ---------- map ---------- */

function viewMap() {
  const header = state.table[0];
  const body = state.table.slice(1);
  const options = (sel: number, required: boolean) =>
    `${required ? '' : `<option value="-1"${sel < 0 ? ' selected' : ''}>Not in file</option>`}${
      required && sel < 0 ? '<option value="-1" selected disabled>Choose a column</option>' : ''
    }${header.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}`;
  const fields = FIELDS.map(
    (f) => `
    <label class="field${f.required && state.mapping[f.key] < 0 ? ' is-missing' : ''}">
      <span class="label">${esc(f.label)}${f.required ? '' : ' <span class="meta">(optional)</span>'}</span>
      <select data-field="${f.key}">${options(state.mapping[f.key], f.required)}</select>
    </label>`,
  ).join('');
  const fieldOf = (i: number) => FIELDS.find((f) => state.mapping[f.key] === i);
  const head = header
    .map((h, i) => {
      const f = fieldOf(i);
      return `<th${f && (f.key === 'mark' || f.key === 'maxMark') ? ' class="num"' : ''}>${esc(h || `Column ${i + 1}`)}${
        f ? `<span class="label tag">${esc(f.label)}</span>` : '<span class="meta tag">not used</span>'
      }</th>`;
    })
    .join('');
  const rows = body
    .slice(0, 6)
    .map(
      (r) =>
        `<tr>${header
          .map((_, i) => {
            const f = fieldOf(i);
            const cls = f?.key === 'answer' ? ' class="answer-cell"' : f && (f.key === 'mark' || f.key === 'maxMark') ? ' class="num"' : '';
            return `<td${cls}>${esc(r[i] ?? '')}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const questions = state.mapping.question >= 0 ? new Set(body.map((r) => r[state.mapping.question])).size : 0;
  return `
  <section class="sheet enter" aria-labelledby="maptitle">
    <div class="screen-head">
      <h2 id="maptitle">Match the columns</h2>
      <p>${esc(state.fileName)}: ${plural(body.length, 'row')}${questions ? `, ${plural(questions, 'question')}` : ''}. Check which column holds what. Answers are only compared with other answers to the same question.</p>
    </div>
    <div class="fields">${fields}</div>
    <div class="preview" tabindex="0" aria-label="First rows of the file"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    ${state.error ? `<p class="error-line" role="alert">${esc(state.error)}</p>` : ''}
    <div class="row-actions">
      <button class="btn btn--ghost" data-act="home">${icons.arrowLeft} Choose another file</button>
      <button class="btn btn--primary" data-act="analyse">Compare answers ${icons.arrowRight}</button>
    </div>
  </section>`;
}

/* ---------- reading ---------- */

function viewReading() {
  const byQ = new Map<string, number[]>();
  state.rows.forEach((r, i) => byQ.set(r.question, [...(byQ.get(r.question) ?? []), i]));
  const maxLen = Math.max(...state.rows.map((r) => r.answer.length), 1);
  const groups = [...byQ]
    .map(
      ([q, idx]) => `
      <div class="scan-group">
        <span class="label">${esc(q)}</span>
        <div class="scan-lines">${idx
          .map((i) => `<div class="scan-line" data-i="${i}" style="width:${Math.max(12, Math.round((100 * state.rows[i].answer.length) / maxLen))}%"><i></i></div>`)
          .join('')}</div>
      </div>`,
    )
    .join('');
  return `
  <section class="sheet enter" aria-labelledby="readtitle">
    <div class="reading">
      <div>
        <div class="screen-head">
          <h2 id="readtitle">Reading ${plural(state.rows.length, 'answer')}</h2>
          <p>Each line is one student's answer. Nothing leaves this tab while it is read.</p>
        </div>
        <div class="scan-sheet" id="scansheet" style="margin-top:var(--s-5)">
          ${groups}
          <div class="scan-light" aria-hidden="true"></div>
        </div>
      </div>
      <div>
        <ol class="stages" aria-live="polite">
          <li class="stage-item" id="st-model"><div class="row"><span class="name">Models</span><span class="meta" data-v></span></div><div class="bar"><i></i></div><span class="meta" data-n></span></li>
          <li class="stage-item is-waiting" id="st-embed"><div class="row"><span class="name">Wording</span><span class="meta" data-v></span></div><div class="bar"><i></i></div><span class="meta">Every answer turned into a meaning vector, so similar answers can be found.</span></li>
          <li class="stage-item is-waiting" id="st-nli"><div class="row"><span class="name">Meaning check</span><span class="meta" data-v></span></div><div class="bar"><i></i></div><span class="meta">Similar pairs with different marks: does each answer imply the other?</span></li>
        </ol>
        <p class="netbox" id="net">${netText()}</p>
      </div>
    </div>
  </section>`;
}

function setStage(id: string, p: number, value: string, status: 'waiting' | 'active' | 'done', note?: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('is-waiting', status === 'waiting');
  el.classList.toggle('is-active', status === 'active');
  el.querySelector<HTMLElement>('.bar > i')!.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
  el.querySelector('[data-v]')!.textContent = value;
  if (note !== undefined) {
    const n = el.querySelector('[data-n]');
    if (n) n.textContent = note;
  }
}

function updateReading() {
  if (state.screen !== 'reading') return;
  const d = state.download;
  const [ed, et] = state.progress.embed;
  const [nd, nt] = state.progress.nli;
  const modelsDone = d.cached === true || ed > 0 || (d.total > 0 && d.loaded >= d.total);
  if (d.cached) setStage('st-model', 1, 'Ready', 'done', 'Loaded from this browser’s cache. No download needed.');
  else if (d.total > 0)
    setStage('st-model', d.loaded / d.total, `${mb(d.loaded)} of ${mb(d.total)} MB`, modelsDone ? 'done' : 'active', 'First run only: the two models download once, then stay cached.');
  else setStage('st-model', 0.02, 'Starting', 'active', 'Preparing the models.');
  setStage('st-embed', et ? ed / et : 0, et ? `${ed} of ${et}` : '', !modelsDone ? 'waiting' : ed >= et && et > 0 ? 'done' : 'active');
  setStage('st-nli', nt ? nd / nt : 0, nt ? `${nd} of ${plural(nt, 'pair')}` : '', ed < et || et === 0 ? 'waiting' : 'active');
  document.querySelectorAll<HTMLElement>('.scan-line').forEach((l) => l.classList.toggle('is-read', Number(l.dataset.i) < ed));
  const sheet = document.getElementById('scansheet');
  if (sheet) sheet.style.setProperty('--sheet-h', sheet.offsetHeight + 'px');
}

/* ---------- results ---------- */

function findingHtml() {
  const a = state.analysis!;
  const n = a.cases.length;
  return n
    ? `<span class="n">${plural(n, 'case')}</span> where students wrote the same answer and got different marks.`
    : 'No answers that say the same thing got different marks.';
}

function findingMeta() {
  const a = state.analysis!;
  const n = a.cases.length;
  const compared = a.questions.reduce((s, q) => s + q.comparedPairs, 0);
  const aside = a.pairs.filter((p) => p.verdict === 'opposite').length;
  const decided = a.cases.filter((c) => dec(c)).length;
  const facts = [
    plural(a.rows.length, 'answer'),
    plural(a.questions.length, 'question'),
    `${compared.toLocaleString()} pairs compared`,
    `${a.pairs.length} checked for meaning`,
    `${plural(aside, 'look-alike')} set aside`,
    n ? `${decided} of ${n} decided` : '',
    state.lastRun ? `done in ${Math.max(1, Math.round(state.lastRun.ms / 1000))} s on this device` : '',
    state.sample ? 'illustrative sample class' : '',
  ].filter(Boolean);
  // Each fact stays whole; lines break between facts, never inside one.
  return facts.map((f) => `<span class="fact">${esc(f)}</span>`).join(' · ');
}

function tabsHtml() {
  const a = state.analysis!;
  const aside = a.pairs.filter((p) => p.verdict === 'opposite').length;
  const tab = (id: Tab, label: string, count?: number) =>
    `<button class="tab" role="tab" id="tab-${id}" aria-controls="panel" aria-selected="${state.tab === id}" tabindex="${state.tab === id ? 0 : -1}" data-tab="${id}">${label}${count !== undefined ? `<span class="count">${count}</span>` : ''}</button>`;
  return `${tab('cases', 'Cases', a.cases.length)}${tab('aside', 'Set aside', aside)}${tab('questions', 'By question')}${tab('report', 'Report')}`;
}

function panelHtml() {
  return { cases: viewCases, aside: viewAside, questions: viewQuestions, report: viewReport }[state.tab]();
}

/** Re-renders the parts of the results sheet that depend on the analysis, leaving the sliders alone. */
function renderResultsParts() {
  const h = document.getElementById('finding');
  if (!h) return render();
  h.innerHTML = findingHtml();
  document.getElementById('findingmeta')!.innerHTML = findingMeta();
  document.getElementById('tablist')!.innerHTML = tabsHtml();
  const panel = document.getElementById('panel')!;
  panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  panel.innerHTML = panelHtml();
  document.querySelector('.results')?.classList.toggle('is-arriving', state.arriving);
  drawBracket(false);
}

function viewResults() {
  return `
  <section class="sheet results${state.arriving ? ' is-arriving' : ''}" aria-labelledby="finding">
    <div class="sweep" aria-hidden="true"></div>
    <div class="finding">
      <div>
        <h1 id="finding" aria-live="polite">${findingHtml()}</h1>
        <p class="meta" id="findingmeta">${findingMeta()}</p>
      </div>
      <div class="tune">
        <button class="btn btn--ghost btn--small" data-act="tune" aria-expanded="${state.tuneOpen}" aria-controls="tunepanel">${icons.sliders} Sensitivity</button>
      </div>
    </div>
    <div class="tune-panel" id="tunepanel"${state.tuneOpen ? '' : ' hidden'}>
      <label class="slider"><span class="row"><span class="label">Wording similarity at least</span><output id="o-sim">${state.settings.minSimilarity.toFixed(2)}</output></span>
        <input type="range" min="0.4" max="0.95" step="0.01" value="${state.settings.minSimilarity}" data-set="minSimilarity" /></label>
      <label class="slider"><span class="row"><span class="label">Marks differ by at least</span><output id="o-gap">${Math.round(state.settings.minGapFraction * 100)}% of max</output></span>
        <input type="range" min="0.1" max="0.8" step="0.05" value="${state.settings.minGapFraction}" data-set="minGapFraction" /></label>
      <span class="tune-status" id="tunestatus" aria-live="polite">Cases update as you drag.</span>
    </div>
    <div class="tabs" role="tablist" aria-label="Results" id="tablist">${tabsHtml()}</div>
    <div id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${panelHtml()}</div>
  </section>`;
}

function updateTuneStatus() {
  const el = document.getElementById('tunestatus');
  if (!el) return;
  if (state.tuning === 'busy') {
    const [nd, nt] = state.progress.nli;
    el.textContent = nt ? `Checking ${nt} pairs… ${nd}/${nt}` : 'Re-checking…';
  } else el.textContent = 'Cases update as you drag.';
}

/* Words: shared words underlined, words only in one answer highlighted. */
function wordsHtml(tokens: ReturnType<typeof compareWords>[0]) {
  let k = 0;
  return tokens
    .map((t) => {
      const cls = !t.word ? '' : t.shared ? 'w same' : 'w diff';
      const html = cls ? `<span class="${cls}" style="--i:${Math.min(k++, 40)}">${esc(t.text)}</span>` : esc(t.text);
      return html + esc(t.space);
    })
    .join('');
}

function scaleHtml(max: number, mark: number) {
  const steps = Math.max(1, Math.round(max));
  const rows: string[] = [];
  for (let v = steps; v >= 0; v--) {
    const filled = Math.round(mark) === v;
    rows.push(`<span class="bubble${filled ? ' is-filled' : ''}" data-v="${v}"><span>${v}</span></span>`);
  }
  return `<div class="scale" role="img" aria-label="Mark ${fmtMark(mark)} out of ${fmtMark(max)}">${rows.join('')}</div>`;
}

function ticksHtml(a: Analysis) {
  return a.cases
    .map((c, k) => {
      const d = dec(c)?.decision;
      return `<button class="tick${d ? ' is-' + d : ''}${k === state.caseIndex ? ' is-current' : ''}" data-case="${k}" aria-label="Case ${k + 1}${d ? ': ' + DECISION_LABEL[d] : ''}"${k === state.caseIndex ? ' aria-current="true"' : ''}></button>`;
    })
    .join('');
}

function viewCases() {
  const a = state.analysis!;
  if (!a.cases.length) {
    const aside = a.pairs.filter((p) => p.verdict === 'opposite').length;
    return `<div class="empty">
      <h2>Nothing to moderate at these settings</h2>
      <p>${a.pairs.length} similar pairs with different marks were checked for meaning: ${aside} said opposite things and the rest did not say the same thing. Lower the wording similarity or the mark gap under Sensitivity to look wider.</p>
      <button class="btn" data-act="tune">${icons.sliders} Open sensitivity</button>
    </div>`;
  }
  return `<div class="casewrap">
    <nav class="track" aria-label="Cases">${ticksHtml(a)}</nav>
    <div class="case-sheet" id="case">${caseHtml(a.cases[state.caseIndex], state.caseIndex)}</div>
  </div>`;
}

function caseHtml(c: Case, k: number) {
  const a = state.analysis!;
  const top = c.pairs[0];
  const hi = a.rows[top.high];
  const lo = a.rows[top.low];
  const [th, tl] = compareWords(hi.answer, lo.answer);
  const d = dec(c);
  const gap = Math.abs(hi.mark - lo.mark);
  const max = Math.max(hi.maxMark, lo.maxMark);
  const others = c.rows.filter((r) => r !== top.high && r !== top.low);
  const who = (r: AnswerRow) =>
    `<div class="who"><strong>${esc(r.studentId)}</strong><span class="meta">${r.marker ? esc(r.marker) + ' · ' : ''}${fmtMark(r.mark)} / ${fmtMark(r.maxMark)}</span></div>`;
  const minE = Math.min(top.highToLow.entailment, top.lowToHigh.entailment);
  const meaning = top.verdict === 'same' ? (minE >= 0.8 ? 'Same meaning' : 'Probably the same meaning') : 'Lower mark, says at least as much';
  return `<div class="case-body" id="casebody">
    <div class="case-head">
      <span class="label"><span class="pos">Case ${k + 1} of ${a.cases.length}</span> · ${plural(c.rows.length, 'answer')}</span>
      <div class="case-nav">
        <button class="btn btn--ghost btn--small" data-act="prev" ${k === 0 ? 'disabled' : ''} aria-label="Previous case">${icons.arrowLeft}</button>
        <button class="btn btn--ghost btn--small" data-act="next" ${k === a.cases.length - 1 ? 'disabled' : ''} aria-label="Next case">${icons.arrowRight}</button>
      </div>
    </div>
    <h2 class="case-question">${esc(c.question)}</h2>
    <div class="pair">
      <div class="answer answer--a">${who(hi)}<blockquote>${wordsHtml(th)}</blockquote></div>
      <div class="rail">
        <span class="label">Marks</span>
        <div class="scales">
          ${scaleHtml(hi.maxMark, hi.mark)}
          ${scaleHtml(lo.maxMark, lo.mark)}
          <svg class="bracket" aria-hidden="true"><path d=""/></svg>
        </div>
        <p class="gap-label">${fmtMark(gap)} ${gap === 1 ? 'mark' : 'marks'} apart<span>${Math.round((100 * gap) / max)}% of the scale</span></p>
      </div>
      <div class="answer answer--b">${who(lo)}<blockquote>${wordsHtml(tl)}</blockquote></div>
    </div>
    <div class="evidence">
      <div><span class="label">Wording · ${top.similarity.toFixed(2)}</span><p>${esc(wordingLabel(top.similarity)[0].toUpperCase() + wordingLabel(top.similarity).slice(1))}, found by the first model.</p>
        <div class="key"><span class="key-same">underlined words appear in both answers</span></div></div>
      <div><span class="label">Meaning · ${esc(meaning)}</span><p>${esc(verdictText(top))}</p></div>
    </div>
    <div class="decide" role="group" aria-label="Decision for this case">
      <button class="btn choice choice--remark" data-decide="remark" aria-pressed="${d?.decision === 'remark'}"><span class="bubble"></span><span class="txt">Needs re-mark</span> <kbd>R</kbd></button>
      <button class="btn choice choice--right" data-decide="right" aria-pressed="${d?.decision === 'right'}"><span class="bubble"></span><span class="txt">Marks stand</span> <kbd>A</kbd></button>
      <span class="spacer"></span>
      <button class="btn btn--ghost" data-decide="skip">Skip for now <kbd>→</kbd></button>
    </div>
    ${
      d?.decision === 'right'
        ? `<label class="reason"><span class="label">Why the marks differ (optional, goes in the report)</span><input id="reason" type="text" maxlength="240" value="${esc(d.reason ?? '')}" placeholder="e.g. the higher answer was marked against the full rubric" /></label>`
        : ''
    }
    ${
      others.length
        ? `<div class="others"><span class="label">Also in this case</span><ul>${others
            .map((r) => {
              const row = a.rows[r];
              return `<li><b>${esc(row.studentId)}</b><span>${fmtMark(row.mark)} / ${fmtMark(row.maxMark)}</span><span>${esc(row.answer)}</span></li>`;
            })
            .join('')}</ul></div>`
        : ''
    }
  </div>`;
}

/** Draws the bracket between the two filled bubbles on the rail. */
function drawBracket(animate: boolean) {
  const svg = document.querySelector<SVGSVGElement>('.bracket');
  const scales = svg?.parentElement;
  if (!svg || !scales) return;
  const [a, b] = scales.querySelectorAll<HTMLElement>('.scale .bubble.is-filled');
  if (!a || !b) return;
  const box = scales.getBoundingClientRect();
  const ya = a.getBoundingClientRect().top + a.offsetHeight / 2 - box.top;
  const yb = b.getBoundingClientRect().top + b.offsetHeight / 2 - box.top;
  const path = svg.querySelector('path')!;
  path.setAttribute('d', `M2 ${ya} C 20 ${ya}, 20 ${yb}, 38 ${yb}`);
  const len = Math.ceil(path.getTotalLength());
  path.style.setProperty('--len', String(len));
  path.classList.toggle('is-drawn', animate && !state.arriving && !reduceMotion.matches);
}

function afterResultsRender() {
  const sheet = document.querySelector<HTMLElement>('.results');
  if (sheet) sheet.style.setProperty('--sweep-h', sheet.offsetHeight + 'px');
  drawBracket(false);
}

function goCase(k: number, how: 'mouse' | 'key') {
  const a = state.analysis!;
  if (k < 0 || k >= a.cases.length || k === state.caseIndex) return;
  const dir = k > state.caseIndex ? 1 : -1;
  state.caseIndex = k;
  state.arriving = false;
  document.querySelector('.results')?.classList.remove('is-arriving');
  const host = document.getElementById('case');
  const track = document.querySelector('.track');
  if (track) track.innerHTML = ticksHtml(a);
  if (!host) return render();
  const swap = () => {
    host.innerHTML = caseHtml(a.cases[k], k);
    const body = document.getElementById('casebody')!;
    body.style.setProperty('--dir', String(dir));
    if (!reduceMotion.matches) body.classList.add(how === 'key' ? 'is-entering-quick' : 'is-entering');
    drawBracket(how === 'mouse');
  };
  const current = document.getElementById('casebody');
  if (how === 'mouse' && current && !reduceMotion.matches) {
    current.style.setProperty('--dir', String(dir));
    current.classList.add('is-leaving');
    setTimeout(swap, 150);
  } else swap();
}

function decide(decision: Decision, how: 'mouse' | 'key') {
  const a = state.analysis!;
  const c = a.cases[state.caseIndex];
  if (!c) return;
  if (decision === 'skip') {
    if (state.caseIndex < a.cases.length - 1) goCase(state.caseIndex + 1, how);
    return;
  }
  const prev = dec(c);
  setCaseDecision(a, state.decisions, c, { decision, reason: decision === 'right' ? prev?.reason : undefined, at: new Date().toISOString() });
  storeDecisions();
  // Update in place: the pressed bubble fills, the timing mark fills with it.
  const host = document.getElementById('case');
  if (host) {
    host.innerHTML = caseHtml(c, state.caseIndex);
    drawBracket(false);
  }
  const track = document.querySelector('.track');
  if (track) track.innerHTML = ticksHtml(a);
  updateFindingMeta();
  if (decision === 'right') {
    document.getElementById('reason')?.focus();
    return;
  }
  const next = nextUndecided(state.caseIndex);
  if (next >= 0) setTimeout(() => goCase(next, how), how === 'key' ? 0 : 420);
  else if (a.cases.every((x) => dec(x))) toast('Every case has a decision. The report is ready.');
}

function updateFindingMeta() {
  const meta = document.getElementById('findingmeta');
  if (meta && state.analysis) meta.innerHTML = findingMeta();
}

function viewAside() {
  const a = state.analysis!;
  const aside = a.pairs.filter((p) => p.verdict === 'opposite').sort((x, y) => y.similarity - x.similarity);
  const fair = a.pairs.filter((p) => p.verdict === 'higherSaysMore').length;
  const unrelated = a.pairs.filter((p) => p.verdict === 'unrelated').length;
  const item = (p: PairResult) => {
    const hi = a.rows[p.high];
    const lo = a.rows[p.low];
    const [th, tl] = compareWords(hi.answer, lo.answer);
    return `<article class="aside-item">
      <span class="label">Wording ${p.similarity.toFixed(2)} · marks ${fmtMark(hi.mark)} and ${fmtMark(lo.mark)}</span>
      <h3>${esc(p.question)}</h3>
      <div class="aside-pair">
        <div><span class="meta">${esc(hi.studentId)} · ${fmtMark(hi.mark)} / ${fmtMark(hi.maxMark)}</span><p>${wordsHtml(th)}</p></div>
        <div><span class="meta">${esc(lo.studentId)} · ${fmtMark(lo.mark)} / ${fmtMark(lo.maxMark)}</span><p>${wordsHtml(tl)}</p></div>
      </div>
      <p class="aside-why">${esc(verdictText(p))} Not flagged.</p>
    </article>`;
  };
  return `<div class="screen-head" style="margin-top:var(--s-5)">
      <p>These answers look alike but the meaning check found they say opposite things, so their different marks are not flagged. ${fair} other similar pairs were set aside because the higher-marked answer says more, and ${unrelated} because neither answer implies the other.</p>
    </div>
    <div class="aside-list">${aside.length ? aside.map(item).join('') : '<p class="meta">No look-alikes at these settings.</p>'}</div>`;
}

function viewQuestions() {
  const a = state.analysis!;
  const rows = a.questions
    .map((q) => {
      const cases = a.cases.filter((c) => c.question === q.question);
      const remark = cases.filter((c) => dec(c)?.decision === 'remark').length;
      return `<tr>
        <td>${esc(q.question)}</td>
        <td class="num">${q.answers}</td>
        <td class="num">${q.comparedPairs}</td>
        <td class="num">${q.candidatePairs}</td>
        <td class="num">${q.rejectedLookalikes}</td>
        <td class="num">${cases.length}</td>
        <td class="num">${remark}</td>
        <td class="num"><span class="consistency"><span>${Math.round(q.consistency * 100)}%</span><span class="bar" aria-hidden="true"><i style="--p:${q.consistency}"></i></span></span></td>
      </tr>`;
    })
    .join('');
  return `<div class="preview" style="margin-top:var(--s-5)" tabindex="0"><table class="qtable">
    <thead><tr><th>Question</th><th class="num">Answers</th><th class="num">Pairs compared</th><th class="num">Checked for meaning</th><th class="num">Look-alikes</th><th class="num">Cases</th><th class="num">Re-mark</th><th class="num">Answers not in a case</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="meta" style="margin-top:var(--s-3)">"Answers not in a case" is the share of a question's answers that no flagged case involves. It is a prompt for where to look, not a grade for the marker.</p>`;
}

function viewReport() {
  const a = state.analysis!;
  const codes = anonymise(a);
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const counts = { remark: 0, right: 0, none: 0 };
  a.cases.forEach((c) => {
    const d = dec(c)?.decision;
    if (d === 'remark') counts.remark++;
    else if (d === 'right') counts.right++;
    else counts.none++;
  });
  const caseRows = a.cases
    .map((c, k) => {
      const d = dec(c);
      const cls = d?.decision === 'remark' ? 'remark' : d?.decision === 'right' ? 'right' : 'none';
      const label = d && d.decision !== 'skip' ? DECISION_LABEL[d.decision] : 'Not reviewed';
      return `<div class="report-case">
        <div><span class="label">C-${String(k + 1).padStart(2, '0')}</span> <span class="status status--${cls}">${label}</span>${d?.reason ? ` · ${esc(d.reason)}` : ''}</div>
        <p class="q">${esc(c.question)}</p>
        <ul>${c.rows.map((r) => `<li>${esc(codes.get(a.rows[r].studentId))}: ${fmtMark(a.rows[r].mark)} / ${fmtMark(a.rows[r].maxMark)}${a.rows[r].marker ? ` (${esc(a.rows[r].marker)})` : ''}</li>`).join('')}</ul>
        <p class="meta">${esc(verdictText(c.pairs[0]))} Wording ${c.pairs[0].similarity.toFixed(2)}.</p>
      </div>`;
    })
    .join('');
  return `
    <div class="report-actions no-print" style="margin-top:var(--s-5)">
      <button class="btn btn--primary" data-act="csv">${icons.download} Download report CSV</button>
      <button class="btn" data-act="print">${icons.printer} Print report</button>
      <span class="spacer"></span>
      <button class="btn btn--ghost" data-act="key" title="Maps codes back to student ids. Keep it private.">${icons.key} Download code key</button>
    </div>
    <article class="report">
      <h2>Moderation report</h2>
      <p class="meta settings-line">${esc(state.fileName)}${state.sample ? ' (illustrative sample class, not real student work)' : ''} · generated ${esc(date)} · students shown as anonymous codes</p>
      <p style="margin-top:var(--s-4)">${plural(a.cases.length, 'case')} of equal answers with unequal marks: ${counts.remark} ${counts.remark === 1 ? 'needs' : 'need'} re-marking, ${counts.right} ${counts.right === 1 ? 'keeps its marks' : 'keep their marks'}, ${counts.none} not reviewed.</p>
      <p class="meta" style="margin-top:var(--s-2)">Settings: wording similarity ≥ ${state.settings.minSimilarity.toFixed(2)}, mark gap ≥ ${Math.round(state.settings.minGapFraction * 100)}% of max, entailment ≥ ${state.settings.entailThreshold}, contradiction ≥ ${state.settings.contradictionThreshold}. Models: ${esc(MODELS.embedding.source)}, ${esc(MODELS.nli.source)}. Flags are evidence for a person to review, not findings about any student.</p>
      <h3>Cases</h3>
      ${caseRows || '<p class="meta">No cases at these settings.</p>'}
    </article>`;
}

/* ------------------------------------------------------------------ events */
/* One delegated listener per event type on #app, so re-rendered parts never need rebinding. */

function nextUndecided(from: number) {
  const a = state.analysis!;
  return a.cases.findIndex((x, i) => i > from && !dec(x));
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act], [data-tab], [data-decide], [data-case]');
  if (!el) return;
  const how: 'mouse' | 'key' = (e as MouseEvent).detail === 0 ? 'key' : 'mouse';
  if (el.dataset.decide) return decide(el.dataset.decide as Decision, how);
  if (el.dataset.case) return goCase(Number(el.dataset.case), 'mouse');
  if (el.dataset.tab) {
    state.tab = el.dataset.tab as Tab;
    state.arriving = false;
    renderResultsParts();
    document.getElementById(`tab-${state.tab}`)?.focus();
    return;
  }
  switch (el.dataset.act) {
    case 'home':
      return startOver();
    case 'sample':
      return void loadSample();
    case 'analyse':
      return startAnalysis();
    case 'prev':
      return goCase(state.caseIndex - 1, 'mouse');
    case 'next':
      return goCase(state.caseIndex + 1, 'mouse');
    case 'tune': {
      state.tuneOpen = !state.tuneOpen;
      const panel = document.getElementById('tunepanel')!;
      panel.hidden = !state.tuneOpen;
      document.querySelector('.finding [data-act="tune"]')?.setAttribute('aria-expanded', String(state.tuneOpen));
      if (state.tuneOpen) panel.querySelector('input')?.focus();
      return;
    }
    case 'csv':
      save(`moderation-report-${state.fileName.replace(/\.\w+$/, '')}.csv`, reportCsv(state.analysis!, state.decisions));
      return toast('Report saved with anonymous codes.');
    case 'key':
      save(`code-key-${state.fileName.replace(/\.\w+$/, '')}.csv`, codeKeyCsv(state.analysis!));
      return toast('Code key saved. It names students: keep it private.');
    case 'print':
      return window.print();
  }
});

app.addEventListener('change', async (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.id === 'file') {
    const f = t.files?.[0];
    if (f) await openCsv(await f.text(), f.name, false);
  } else if (t instanceof HTMLSelectElement && t.dataset.field) {
    state.mapping[t.dataset.field as Field] = Number(t.value);
    state.error = '';
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    document.querySelector<HTMLSelectElement>(`select[data-field="${t.dataset.field}"]`)?.focus();
  }
});

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.set) {
    const key = t.dataset.set as 'minSimilarity' | 'minGapFraction';
    state.settings = { ...state.settings, [key]: Number(t.value) };
    document.getElementById('o-sim')!.textContent = state.settings.minSimilarity.toFixed(2);
    document.getElementById('o-gap')!.textContent = `${Math.round(state.settings.minGapFraction * 100)}% of max`;
    retune();
  } else if (t.id === 'reason') {
    const c = state.analysis!.cases[state.caseIndex];
    const d = dec(c);
    if (d) {
      setCaseDecision(state.analysis!, state.decisions, c, { ...d, reason: t.value.trim() || undefined });
      storeDecisions();
    }
  }
});

app.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'reason' && e.key === 'Enter') {
    (t as HTMLInputElement).blur();
    const next = nextUndecided(state.caseIndex);
    if (next >= 0) goCase(next, 'key');
  }
});

app.addEventListener('dragover', (e) => {
  const drop = (e.target as HTMLElement).closest('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('is-over');
});
app.addEventListener('dragleave', (e) => (e.target as HTMLElement).closest('#drop')?.classList.remove('is-over'));
app.addEventListener('drop', async (e) => {
  const drop = (e.target as HTMLElement).closest('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('is-over');
  const f = e.dataTransfer?.files?.[0];
  if (f) await openCsv(await f.text(), f.name, false);
});

document.addEventListener('keydown', (e) => {
  const tabEl = (e.target as HTMLElement).closest?.('.tab');
  if (tabEl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const order: Tab[] = ['cases', 'aside', 'questions', 'report'];
    const i = order.indexOf(state.tab) + (e.key === 'ArrowRight' ? 1 : -1);
    state.tab = order[(i + order.length) % order.length];
    renderResultsParts();
    document.getElementById(`tab-${state.tab}`)?.focus();
    e.preventDefault();
    return;
  }
  if (state.screen !== 'results' || state.tab !== 'cases' || !state.analysis?.cases.length) return;
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') decide('remark', 'key');
  else if (k === 'a') decide('right', 'key');
  else if (e.key === 'ArrowRight') goCase(state.caseIndex + 1, 'key');
  else if (e.key === 'ArrowLeft') goCase(state.caseIndex - 1, 'key');
  else return;
  e.preventDefault();
});

window.addEventListener('resize', () => {
  if (state.screen === 'results') drawBracket(false);
});

render();

// Read-only handle used by the end-to-end test to score the in-browser run.
(window as unknown as { __secondMarker: () => unknown }).__secondMarker = () => ({ analysis: state.analysis, decisions: state.decisions });
