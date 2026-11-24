/**
 * Demo video, step 1 of 2: records the real built app. scripts/video/edit.ts turns the recording into the film.
 *
 * A scripted Chromium session (1440x810 CSS px at device scale 2) is captured frame by frame through the
 * DevTools screencast, at 2880x1620 and up to 60 fps. Against the same clock the script logs:
 *   - scenes, each with its narration, one sentence per audio file (Kokoro, voice af_heart), so camera moves
 *     can be cued to the sentence they belong to;
 *   - camera targets, taken from the real on-screen rectangle of the element in focus (the editor eases a
 *     crop of the 2x capture between them);
 *   - scenes that wait on the models, which the editor shows faster than real time and labels with the factor.
 * The cursor is drawn into the page and moved along eased paths, so it is part of the capture.
 * Output: .cache/video/timeline.json plus the frames.
 *
 *   npm run build && npx tsx scripts/video/record.ts && npx tsx scripts/video/edit.ts
 *
 * Narration needs a local Kokoro install: KOKORO_PY (python with kokoro-onnx) and KOKORO_TTS (a tts.py taking
 * "text out.wav --voice af_heart"). Lines are cached in .cache/tts by their text.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Locator } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const work = resolve(root, '.cache/video');
const frames = join(work, 'frames');
rmSync(work, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const W = 1440;
const H = 810;
const SCALE = 2;
const MAX_Z = 2.1;

/* ---------- narration ---------- */
const KOKORO_PY = process.env.KOKORO_PY ?? resolve(root, '../../tools/kokoro/.venv/bin/python');
const KOKORO_TTS = process.env.KOKORO_TTS ?? resolve(root, '../../scripts/tts.py');
const ttsDir = resolve(root, '.cache/tts');
mkdirSync(ttsDir, { recursive: true });
const run = promisify(execFile);
const probe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
interface Line { text: string; file: string; dur: number }
const lines = new Map<string, Promise<Line>>();
let queue: Promise<unknown> = Promise.resolve();
/** One sentence of narration, synthesised once (cached by text), one synthesis at a time. */
function voice(text: string): Promise<Line> {
  let p = lines.get(text);
  if (p) return p;
  const file = join(ttsDir, createHash('sha1').update('af_heart\n' + text).digest('hex').slice(0, 16) + '.wav');
  p = (queue = queue.then(async () => {
    if (!existsSync(file)) await run(KOKORO_PY, ['-I', KOKORO_TTS, text, file, '--voice', 'af_heart']);
    return { text, file, dur: probe(file) };
  })) as Promise<Line>;
  lines.set(text, p);
  return p;
}
const GAP = 0.12; // pause between sentences, on top of the short silence each file ends with

/* ---------- numbers for the narration, from the real evaluation output ---------- */
const evalOut = readFileSync(resolve(root, '.cache/eval-out.txt'), 'utf8');
function setStats(title: RegExp) {
  const block = evalOut.replace(/^== /, '').split('\n== ').find((b) => title.test(b)) ?? '';
  const g = (re: RegExp) => (block.match(re) ?? []).slice(1).map(Number);
  const [found, planted] = g(/found\):\s+(\d+)\/(\d+)/);
  const [good, flagged] = g(/planted answer\):\s+(\d+)\/(\d+)/);
  const [, baseFlagged] = g(/precision (\d+)\/(\d+)/);
  if ([found, planted, good, flagged, baseFlagged].some((x) => !Number.isFinite(x))) throw new Error('eval output not understood: ' + title);
  return { found, planted, good, flagged, baseFlagged };
}
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const say = (k: number) => (k < 21 ? words[k] : k < 100 ? tens[Math.floor(k / 10)] + (k % 10 ? '-' + words[k % 10] : '') : String(k));
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const sample = setStats(/^Sample class/);
const held = setStats(/^Held-out set 2/);
const flagLine = (x: ReturnType<typeof setStats>) => (x.good === x.flagged ? 'and every flag was correct' : `and ${say(x.good)} of its ${say(x.flagged)} flags were correct`);

/* The script. Sentences that depend on what the app shows are written at the moment they are known. */
const script = {
  title: ['Two students wrote the same answer.', 'One got five out of five. The other got two.', 'Second Marker finds these cases, before the marks go to the exam board.'],
  landing: ['It runs entirely in your browser.', 'Drop in a marked spreadsheet, or try the sample class: sixty-six short answers to four data-structures questions, written for this demo.'],
  columns: ['Columns are matched from the header, and you can change any of them.', 'Answers are only ever compared with answers to the same question.'],
  reading: [
    'On the first run, two models download once.',
    'The first, all Mini L M, turns every answer into a vector, to find answers worded alike.',
    'The second, a DeBERTa model trained for natural language inference, checks whether each answer implies the other.',
    'Nothing is uploaded, and the page lists every request it makes.',
  ],
  decide: ['A person decides every case.', 'This one needs re-marking.', 'In the next case, the moderator keeps the marks, and records why.'],
  offline: ['Once the models are cached, it works with the network off.', 'Here the browser is offline, and the class is checked again.'],
  report: ['The report swaps every student ID for an anonymous code, and lists each case with its decision.', 'It downloads as a spreadsheet for the exam board.', 'The tool never changes a mark.'],
  measured: [
    'Does it work?',
    'The same pipeline runs on labelled classes with planted mis-marks.',
    `On the sample class, it found ${say(sample.found)} of ${say(sample.planted)}, ${flagLine(sample)}.`,
    `On a held-out class, written after every setting was chosen, it found ${say(held.found)} of ${say(held.planted)}, ${flagLine(held)}.`,
    `Wording similarity alone would have flagged ${say(held.baseFlagged)} pairs there.`,
  ],
  end: ['Second Marker runs two open models in your browser: all Mini L M for wording, and DeBERTa for meaning.', 'It handles short English answers, and its flags are evidence for a person, never verdicts.'],
};
console.log('synthesising narration');
await Promise.all(Object.values(script).flat().map(voice));

/* ---------- static server for dist/ under a sub-path, like GitHub Pages ---------- */
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.csv': 'text/csv', '.woff2': 'font/woff2',
};
const dist = resolve(root, 'dist');
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file: string;
  if (url.pathname.startsWith('/cards/')) file = join(root, 'scripts/video', url.pathname.slice(1));
  else if (url.pathname.startsWith('/font/')) file = join(root, 'node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2');
  else if (url.pathname.startsWith('/second-marker/')) {
    file = join(dist, decodeURIComponent(url.pathname.slice('/second-marker/'.length)) || 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  } else return void res.writeHead(404).end();
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(4318, r));
const base = 'http://localhost:4318/second-marker/';

/* ---------- browser; the cursor is drawn into the page (headless has none) ---------- */
const cursorScript = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.innerHTML = '<svg width="24" height="30" viewBox="0 0 24 30"><path d="M3 2.6v21.6l5.4-5.2 3.7 8.5 4-1.8-3.7-8.3h7.4z" fill="#1f2023" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transform-origin:3px 3px;transition:opacity 180ms;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / .3))';
  document.body.append(c);
  let x = 0, y = 0, s = 1;
  const put = () => { c.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 3) + 'px) scale(' + s + ')'; };
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; c.style.opacity = '1'; put(); }, true);
  addEventListener('mousedown', (e) => {
    s = 0.84; put();
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (e.clientX - 20) + 'px;top:' + (e.clientY - 20) + 'px;width:40px;height:40px;border-radius:50%;border:2px solid #2146d8;background:rgb(33 70 216 / .12);z-index:2147483646;pointer-events:none;transform:scale(.3);opacity:1;transition:transform 520ms cubic-bezier(.23,1,.32,1),opacity 520ms ease-out';
    document.body.append(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  }, true);
  addEventListener('mouseup', () => { s = 1; put(); }, true);
});`;
// --force-device-scale-factor makes the screencast deliver device pixels (2880x1620), not CSS pixels.
const browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic', `--force-device-scale-factor=${SCALE}`] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, acceptDownloads: true });
await context.addInitScript(cursorScript);
const page = await context.newPage();
page.on('pageerror', (e) => console.error('page error', e));

/* ---------- frame capture via the DevTools screencast ---------- */
const cdp = await context.newCDPSession(page);
const captured: { t: number; file: string }[] = [];
let n = 0;
cdp.on('Page.screencastFrame', (async (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
  const file = join(frames, `f${String(n++).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(f.data, 'base64'));
  captured.push({ t: f.metadata.timestamp, file });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
}) as never);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ---------- scenes ---------- */
interface Scene {
  name: string; start: number; end: number; lead: number; fit: boolean;
  caption?: { k: string; t: string }; lines: Line[]; offsets: number[]; total: number;
}
const scenes: Scene[] = [];
let open: Scene | null = null;
/** Starts a scene. fit: the footage is a wait, shown faster so it fits the narration. */
async function scene(name: string, text: string[], opts: { caption?: { k: string; t: string }; fit?: boolean; lead?: number } = {}) {
  const start = now();
  const prev = scenes.at(-1);
  if (prev && start - prev.end > 0.1) cam.cut(start); // a cut: the editor dips through the desk colour
  const ls = await Promise.all(text.map(voice));
  const offsets: number[] = [];
  let t = 0;
  for (const l of ls) { offsets.push(t); t += l.dur + GAP; }
  open = { name, start, end: 0, lead: opts.lead ?? 0.35, fit: !!opts.fit, caption: opts.caption, lines: ls, offsets, total: t - GAP };
  scenes.push(open);
}
/** Waits until sentence i of the current scene is about to be heard. */
async function cue(i: number, early = 0.25) {
  const s = open!;
  await sleep((s.start + s.lead + s.offsets[i] - early - now()) * 1000);
}
/** Waits until the current scene's narration has (nearly) finished. */
async function settle(before = 0.2) {
  const s = open!;
  await sleep((s.start + s.lead + s.total - before - now()) * 1000);
}
/** Ends the scene; by default first holds until its narration is over, plus a short breath. */
async function done({ hold = true, tail = 0.6 } = {}) {
  const s = open!;
  if (hold && !s.fit) await sleep((s.start + s.lead + s.total + tail - now()) * 1000);
  s.end = now();
  open = null;
}

/* ---------- camera: targets from real element rectangles, in CSS px of the viewport ---------- */
interface Shot { t: number; d: number; cx: number; cy: number; z: number }
const shots: Shot[] = [];
const cam = {
  z: 1,
  wide(d = 0.8) { shots.push({ t: now(), d, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; return sleep(d * 1000); },
  cut(t: number) { shots.push({ t, d: 0, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; },
  to(r: Rect, { z, pad = 1.18, d = 1.0, dy = 0, left = false }: CamOpts = {}) {
    const fit = Math.min(W / (r.w * pad), H / (r.h * pad));
    const zz = Math.max(1, Math.min(MAX_Z, z ?? fit));
    // left: keep the target's left edge in frame (for a line of text in a wide block)
    const cx = left ? r.x - 32 + W / zz / 2 : r.x + r.w / 2;
    shots.push({ t: now(), d, cx, cy: r.y + r.h / 2 + dy, z: zz });
    this.z = zz;
    return sleep(d * 1000);
  },
};
interface Rect { x: number; y: number; w: number; h: number }
interface CamOpts { z?: number; pad?: number; d?: number; dy?: number; left?: boolean }
/** A selector or locator (its box), or { text } (the box of the text inside it, for wide blocks with short text). */
type Target = string | Locator | { text: Locator };
const loc = (t: string | Locator) => (typeof t === 'string' ? page.locator(t).first() : t);
async function rectOf(targets: Target[]): Promise<Rect> {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of targets) {
    const b = typeof t === 'object' && 'text' in t
      ? await t.text.evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const q = r.getBoundingClientRect();
          return { x: q.x, y: q.y, width: q.width, height: q.height };
        }, null, { timeout: 5000 })
      : await loc(t).boundingBox({ timeout: 5000 });
    if (!b) throw new Error('not visible: ' + String(t));
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
async function scrollToY(y: number, ms = 800) {
  await page.evaluate(`new Promise((done) => {
    const s = scrollY, d = Math.max(0, Math.min(${y}, document.documentElement.scrollHeight - innerHeight)) - s, t0 = performance.now();
    if (Math.abs(d) < 2) return done();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ${ms});
      const e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      scrollTo(0, s + d * e);
      p < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  })`);
}
/**
 * Puts the camera on the targets. If they are not fully in view, the camera pulls back, the page scrolls,
 * and the camera pushes in again (it never scrolls the page under a zoomed camera).
 */
async function focus(targets: Target[], opts: CamOpts & { top?: number } = {}) {
  let r = await rectOf(targets);
  const top = opts.top ?? 90;
  if (r.y < top || r.y + r.h > H - 24) {
    if (cam.z > 1.01) await cam.wide(0.7);
    const y = await page.evaluate(() => scrollY);
    const want = r.h > H - top - 40 ? y + r.y - top : y + r.y + r.h / 2 - (H + top) / 2;
    await scrollToY(want, 750);
    await sleep(120);
    r = await rectOf(targets);
  }
  await cam.to(r, opts);
}

/* ---------- cursor: eased, slightly curved paths ---------- */
let mx = W * 0.62, my = H * 0.72;
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
async function glide(x: number, y: number, ms?: number) {
  const dx = x - mx, dy = y - my, dist = Math.hypot(dx, dy);
  const T = ms ?? Math.min(1150, 420 + dist * 0.6);
  const steps = Math.max(2, Math.round(T / 16));
  const bow = Math.min(50, dist * 0.08) * (dx > 0 ? 1 : -1);
  const qx = mx + dx / 2 - (dy / (dist || 1)) * bow, qy = my + dy / 2 + (dx / (dist || 1)) * bow;
  const sx = mx, sy = my, t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const p = ease(i / steps);
    const px = (1 - p) * (1 - p) * sx + 2 * (1 - p) * p * qx + p * p * x;
    const py = (1 - p) * (1 - p) * sy + 2 * (1 - p) * p * qy + p * p * y;
    await page.mouse.move(px, py);
    await sleep(t0 + (i * T) / steps - Date.now());
  }
  mx = x; my = y;
}
async function pointAt(t: string | Locator, ms?: number, fx = 0.5, fy = 0.5) {
  const b = await loc(t).boundingBox();
  if (!b) throw new Error('not visible: ' + String(t));
  await glide(b.x + b.width * fx, b.y + b.height * fy, ms);
}
async function press(t: string | Locator, ms?: number) {
  await pointAt(t, ms);
  await sleep(140);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
const showCursor = () => page.mouse.move(mx, my);

try {
  /* 1. Title card: the hook is the result itself */
  await page.goto('http://localhost:4318/cards/title.html');
  await page.evaluate(() => document.fonts.ready);
  await scene('title', script.title, { lead: 0.3 });
  await sleep(700);
  await cue(1, 0.6);
  await focus(['.pair'], { pad: 1.06, d: 1.1 });
  await cue(2, 0.3);
  await cam.wide(1.0);
  await done({ tail: 0.4 });

  /* 2. Landing */
  await page.goto(base);
  await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('heading', { name: 'Same answer. Different mark.' }).waitFor();
  await sleep(500);
  await showCursor();
  await scene('landing', script.landing, { caption: { k: 'Sample class', t: 'Illustrative: written for this demo, not real student work.' } });
  await sleep(900);
  await pointAt('#drop', 1000, 0.5, 0.62);
  await cue(1, 0.1);
  await focus(['.load .enter-stagger'], { pad: 1.08, d: 1.0 });
  await pointAt('[data-act="sample"]', 900);
  await settle(0.5);
  await press('[data-act="sample"]', 300);
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await cam.wide(0.8);
  await done({ hold: false });

  /* 3. Columns */
  await scene('columns', script.columns, { caption: { k: 'Columns', t: 'Matched from the header. Any of them can be changed.' } });
  await sleep(300);
  await focus(['.fields'], { pad: 1.12, d: 1.0 });
  await pointAt('.fields select >> nth=2', 900);
  await cue(1, 0.2);
  await focus(['.preview'], { pad: 1.05, d: 1.0 });
  await settle(0.9);
  await focus(['[data-act="analyse"]'], { z: 1.7, d: 0.8 });
  await press('[data-act="analyse"]', 700);
  await done({ hold: false });

  /* 4. Reading: first run, models download; shown faster, labelled with the real factor */
  await scene('reading', script.reading, { fit: true, caption: { k: 'First run', t: 'Includes the one-time model download.' } });
  await sleep(400);
  await focus(['.stages', '#net'], { z: 1.75, d: 1.0 });
  await page.waitForFunction(() => !document.querySelector('#st-embed')?.classList.contains('is-waiting'), null, { timeout: 600000 });
  await focus(['#scansheet'], { pad: 1.02, d: 1.0, top: 0 }).catch(() => cam.wide());
  await page.waitForFunction(() => !document.querySelector('#st-nli')?.classList.contains('is-waiting'), null, { timeout: 600000 });
  await cam.wide(1.0);
  await scrollToY(0, 700);
  await page.locator('.finding h1').waitFor({ timeout: 600000 });
  // End the sped-up scene the moment results appear, so the arrival plays at real speed.
  await done({ hold: false });

  /* 5. Arrival (the signature moment) */
  const finding = await page.locator('.finding h1').innerText();
  const nCases = Number((finding.match(/(\d+) case/) ?? [])[1] ?? 0);
  const marks = await page.$$eval('.case-sheet .scale', (els) => els.map((e) => (e.getAttribute('aria-label') ?? '').match(/Mark (\S+)/)?.[1] ?? '?'));
  await scene('arrival', [`${cap(say(nCases))} cases.`, 'In the first, these two answers say the same thing.', `One was marked ${say(Number(marks[0]))}. The other, ${say(Number(marks[1]))}.`], {
    lead: 0.5,
    caption: { k: 'Case 1', t: `Same meaning, marked ${marks[0]} and ${marks[1]}.` },
  });
  await sleep(2100);
  await cue(1, 0.2);
  await focus(['.pair'], { pad: 1.05, d: 1.1 });
  await cue(2, 0.1);
  await focus(['.rail'], { z: 1.9, d: 1.0 });
  await done({ tail: 0.5 });

  /* 6. Evidence */
  const meaning = (await page.locator('.evidence > div >> nth=1').innerText()).toLowerCase();
  const evidence = ['Words the two answers share are underlined.', 'The wording score comes from the first model; the meaning check, from the second.'];
  if (/each answer implies the other/.test(meaning)) evidence.push('Here, each answer implies the other.');
  await scene('evidence', evidence, { caption: { k: 'Evidence', t: 'Shared words underlined. Wording from the first model, meaning from the second.' } });
  await focus(['.answer--b blockquote'], { z: 1.9, d: 1.0 });
  await cue(1, 0.2);
  await focus(['.evidence'], { pad: 1.08, d: 1.0 });
  await done({ tail: 0.4 });

  /* 7. Decisions */
  await scene('decide', script.decide, { caption: { k: 'Decision', t: 'A person decides every case. The tool never changes a mark.' } });
  await focus(['[data-decide="remark"]', '[data-decide="right"]'], { z: 1.85, d: 0.9 });
  await pointAt('[data-decide="right"]', 800);
  await cue(1, 0.5);
  await press('[data-decide="remark"]', 550);
  await sleep(1300); // the bubble fills, then the next case slides in
  await cue(2, 0.3);
  await focus(['.case-sheet .pair', '[data-decide="right"]'], { pad: 1.04, d: 0.9 });
  await focus(['[data-decide="remark"]', '[data-decide="right"]'], { z: 1.85, d: 0.9 });
  await press('[data-decide="right"]', 650);
  await page.locator('#reason').waitFor();
  await focus(['[data-decide="remark"]', '#reason'], { pad: 1.1, d: 0.8 });
  await page.keyboard.type('Discussed with Marker A: keep marks, note for the exam board.', { delay: 30 });
  await done({ tail: 0.8 });

  /* 8. Set aside: similar words, opposite meaning */
  const trap = page.locator('.aside-item', { hasText: 'A stack is LIFO and a queue is FIFO.' }).filter({ hasText: 'A stack is FIFO and a queue is LIFO.' }).first();
  const trap2 = page.locator('.aside-item', { hasText: 'Binary search does not need the array to be sorted' }).first();
  await cam.wide(0.7);
  await scrollToY(0, 700);
  await pointAt('[data-tab="aside"]', 900);
  await press('[data-tab="aside"]', 200);
  await sleep(500);
  const sim = ((await trap.locator('.label').first().innerText()).match(/Wording (\d\.\d+)/i) ?? [])[1] ?? '';
  const simWords = sim ? sim.replace('0.', 'nought point ').replace(/(\d)(\d)$/, (_m, a, b) => `${say(+a)} ${say(+b)}`) : '';
  const aside = ['Similar words are not the same meaning.', `"A stack is lie-foe", and "a stack is fie-foe"${simWords ? `, score ${simWords} on wording` : ', look almost identical'}.`];
  const hasTrap2 = (await trap2.count()) > 0;
  if (hasTrap2) aside.push('"It needs order", and "it does not need to be sorted", look alike too.');
  aside.push('The meaning check finds the contradiction, so these are set aside, not flagged.');
  await scene('aside', aside, { caption: { k: 'Set aside', t: 'Look-alikes that say the opposite are not flagged.' } });
  const textOf = (item: Locator) => [{ text: item.locator('.label').first() }, { text: item.locator('.aside-pair p').nth(0) }, { text: item.locator('.aside-pair p').nth(1) }];
  await focus(textOf(trap), { pad: 1.12, d: 1.0 });
  await pointAt(trap.locator('.aside-why'), 900, 0.2, 0.5);
  if (hasTrap2) {
    await cue(2, 0.4);
    await focus(textOf(trap2), { pad: 1.1, d: 1.0 });
  }
  await cue(aside.length - 1, 0.3);
  await focus([{ text: (hasTrap2 ? trap2 : trap).locator('.aside-why') }], { z: 1.8, d: 0.9, left: true });
  await done({ tail: 0.5 });

  /* 9. Offline: a second run with the network off, from the cached models */
  await cam.wide(0.6);
  await scrollToY(0, 600);
  await press('[data-act="home"]', 700);
  await press('[data-act="sample"]', 700);
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await context.setOffline(true);
  await page.locator('[data-act="analyse"]').scrollIntoViewIfNeeded();
  await sleep(200);
  await press('[data-act="analyse"]', 700);
  await scene('offline', script.offline, { fit: true, caption: { k: 'Offline', t: 'Browser set to offline mode for this run.' } });
  await sleep(300);
  await focus(['.stages', '#net'], { z: 1.75, d: 1.0 }).catch(() => {});
  await page.locator('.finding h1').waitFor({ timeout: 180000 });
  await cam.wide(0.8);
  await sleep(1600);
  await done({ hold: false });
  await context.setOffline(false);

  /* 10. Report */
  await scene('report', script.report, { caption: { k: 'Report', t: 'Anonymous codes. A spreadsheet for the exam board.' } });
  await pointAt('[data-tab="report"]', 900);
  await press('[data-tab="report"]', 200);
  await sleep(600);
  await focus(['.report-case >> nth=0', '.report-case >> nth=1'], { pad: 1.1, d: 1.0 });
  await cue(1, 0.6);
  await focus(['.report-actions [data-act="csv"]'], { z: 1.85, d: 0.9 });
  const [dl] = await Promise.all([page.waitForEvent('download'), press('.report-actions [data-act="csv"]', 700)]);
  await dl.saveAs(join(work, 'report.csv'));
  await cue(2, 0.4);
  await cam.wide(1.0);
  await done({ tail: 0.6 });

  /* 11. Measured: the real evaluation output */
  await page.goto('http://localhost:4318/cards/terminal.html');
  const term = `$ npm run eval\n${evalOut.trim()}`.split('\n');
  await page.evaluate((ls) => {
    const out = document.getElementById('out')!;
    ls.forEach((l, i) => {
      const s = document.createElement('span');
      s.className = 'ln';
      s.dataset.i = String(i);
      s.textContent = l || ' ';
      out.append(s);
    });
  }, term);
  await page.evaluate(() => document.fonts.ready);
  const lineAt = (re: RegExp, after = 0) => {
    const i = term.findIndex((l, k) => k >= after && re.test(l));
    if (i < 0) throw new Error('line not found ' + re);
    return i;
  };
  const sBlock = lineAt(/^== Sample class/);
  const hBlock = lineAt(/^== Held-out set 2/);
  const sLines = [lineAt(/recall/, sBlock), lineAt(/precision \(flagged/, sBlock)];
  const hLines = [lineAt(/recall/, hBlock), lineAt(/precision \(flagged/, hBlock), lineAt(/baseline/, hBlock)];
  const ln = (i: number) => page.locator(`.ln[data-i="${i}"]`);
  const mark = (is: number[]) => page.evaluate((xs) => {
    document.querySelectorAll('.ln.hl').forEach((e) => e.classList.remove('hl'));
    xs.forEach((i) => document.querySelector(`.ln[data-i="${i}"]`)!.classList.add('hl'));
  }, is);
  await scene('measured', script.measured, { caption: { k: 'Measured', t: 'Real output of npm run eval. Browser scores differ slightly; see the README.' } });
  await cue(2, 0.6);
  await mark([sBlock, ...sLines]);
  await focus([ln(sBlock), ...sLines.map(ln)], { pad: 1.12, d: 1.0, top: 0 });
  await cue(3, 0.6);
  await mark([hBlock, ...hLines.slice(0, 2)]);
  await focus([ln(hBlock), ...hLines.slice(0, 2).map(ln)], { pad: 1.12, d: 1.0, top: 0 });
  await cue(4, 0.3);
  await mark([hLines[2]]);
  await focus([ln(hLines[2])], { pad: 1.06, d: 0.9, top: 0 });
  await done({ tail: 0.4 });

  /* 12. End card */
  await page.goto('http://localhost:4318/cards/end.html');
  await page.evaluate(() => document.fonts.ready);
  await scene('end', script.end, { lead: 0.5 });
  await sleep(1400);
  await focus(['.flow'], { pad: 1.06, d: 1.1 });
  await cue(1, 0.3);
  await cam.wide(1.1);
  await done({ tail: 1.6 });
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();
  server.close();
}

writeFileSync(join(work, 'timeline.json'), JSON.stringify({ W, H, scale: SCALE, maxZ: MAX_Z, frames: captured, scenes, shots }, null, 1));
console.log(`recorded ${captured.length} frames over ${(captured.at(-1)!.t - captured[0].t).toFixed(1)} s; ${scenes.length} scenes, ${shots.length} camera moves`);
