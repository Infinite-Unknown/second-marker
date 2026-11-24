/**
 * Demo video, step 1 of 2: records the real built app. scripts/video/edit.ts turns the recording into the film.
 *
 * A scripted Chromium session (1440x810 CSS px at device scale 2) is captured frame by frame through the
 * DevTools screencast, at 2880x1620 and up to 60 fps. Against the same clock the script logs:
 *   - scenes, each with its narration, one sentence per audio file (Kokoro, voice af_heart), so camera moves
 *     can be cued to the sentence they belong to;
 *   - camera targets, taken from the real on-screen rectangle of the element in focus (the editor eases a
 *     crop of the 2x capture between them);
 *   - callouts: whenever the narration names something on screen, that element's real bounding box at the
 *     moment the word is heard (the editor draws a spotlight, a ring, and a label or underline there);
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
  const [baseGood, baseFlagged] = g(/precision (\d+)\/(\d+)/);
  if ([found, planted, good, flagged, baseGood, baseFlagged].some((x) => !Number.isFinite(x))) throw new Error('eval output not understood: ' + title);
  return { found, planted, good, flagged, baseGood, baseFlagged };
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
/** A moment in the narration: sentence `line` of the scene, `frac` of the way through it. */
interface At { scene: number; line: number; frac: number }
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
/** Real time at which a word of the current scene's narration is heard (scenes at real speed only). */
function when(line: number, at: string | number): { t: number; at: At } {
  const s = open!;
  const L = s.lines[line];
  let frac = typeof at === 'number' ? at : L.text.indexOf(at) / L.text.length;
  if (frac < 0) throw new Error(`"${at}" is not in: ${L.text}`);
  frac = Math.min(1, frac);
  return { t: s.start + s.lead + s.offsets[line] + frac * Math.max(0, L.dur - 0.15), at: { scene: scenes.length - 1, line, frac } };
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
  invalidate();
  s.end = now();
  open = null;
}

/* ---------- camera: targets from real element rectangles, in CSS px of the viewport ---------- */
/** at: in a sped-up scene, the move is timed to the narration (it ends at that moment) instead of the clock. */
interface Shot { t: number; d: number; cx: number; cy: number; z: number; at?: At }
interface Rect { x: number; y: number; w: number; h: number }
interface CamOpts { z?: number; pad?: number; d?: number; dy?: number; left?: boolean; maxZ?: number; force?: boolean }
const shots: Shot[] = [];
const view = () => {
  const w = W / cam.z, h = H / cam.z;
  const cx = Math.min(W - w / 2, Math.max(w / 2, cam.cx)), cy = Math.min(H - h / 2, Math.max(h / 2, cam.cy));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
};
const cam = {
  z: 1, cx: W / 2, cy: H / 2,
  set(cx: number, cy: number, z: number) { this.cx = cx; this.cy = cy; this.z = z; },
  wide(d = 0.8) { shots.push({ t: now(), d, cx: W / 2, cy: H / 2, z: 1 }); this.set(W / 2, H / 2, 1); return sleep(d * 1000); },
  cut(t: number) { shots.push({ t, d: 0, cx: W / 2, cy: H / 2, z: 1 }); this.set(W / 2, H / 2, 1); },
  /** Eases the camera onto r. Stays put if r is already comfortably in frame at about the right size. */
  to(r: Rect, { z, pad = 1.18, d = 1.0, dy = 0, left = false, maxZ = MAX_Z, force = false }: CamOpts = {}, at?: At) {
    const fit = Math.min(W / (r.w * pad), H / (r.h * pad));
    const zz = Math.max(1, Math.min(maxZ, MAX_Z, z ?? fit));
    const v = view();
    const inside = r.x >= v.x + 8 && r.y >= v.y + 8 && r.x + r.w <= v.x + v.w - 8 && r.y + r.h <= v.y + v.h - 8;
    if (!force && z === undefined && inside && zz <= this.z * 1.4) return Promise.resolve();
    // left: keep the target's left edge in frame (for a line of text in a wide block)
    const cx = left ? r.x - 32 + W / zz / 2 : r.x + r.w / 2;
    shots.push({ t: now(), d, cx, cy: r.y + r.h / 2 + dy, z: zz, at });
    this.set(cx, r.y + r.h / 2 + dy, zz);
    return at ? Promise.resolve() : sleep(d * 1000);
  },
};
/**
 * A selector or locator (its box); or { text } (the box of the text inside it, for wide blocks with short text),
 * optionally only the substring `sub` of that text (a number in a line).
 */
type Target = string | Locator | { text: Locator; sub?: string };
const loc = (t: string | Locator) => (typeof t === 'string' ? page.locator(t).first() : t);
async function rectOf(targets: Target[]): Promise<Rect> {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of targets) {
    const b = typeof t === 'object' && 'text' in t
      ? await t.text.evaluate((el, sub) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          if (sub) {
            const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              const i = (n.textContent ?? '').indexOf(sub);
              if (i >= 0) { r.setStart(n, i); r.setEnd(n, i + sub.length); break; }
            }
          }
          const q = r.getBoundingClientRect();
          return { x: q.x, y: q.y, width: q.width, height: q.height };
        }, t.sub ?? '', { timeout: 5000 })
      : await loc(t).boundingBox({ timeout: 5000 });
    if (!b) throw new Error('not visible: ' + String(t));
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
async function scrollToY(y: number, ms = 800) {
  invalidate();
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
/** Scrolls (camera pulled back first) so the box is in view; returns the box as it is now. */
async function inView(targets: Target[], grow = 0, top = 90): Promise<Rect> {
  let r = await rectOf(targets);
  if (r.y - grow < top || r.y + r.h + grow > H - 24) {
    if (cam.z > 1.01) await cam.wide(0.7);
    const y = await page.evaluate(() => scrollY);
    const want = r.h > H - top - 40 ? y + r.y - top : y + r.y + r.h / 2 - (H + top) / 2;
    await scrollToY(want, 750);
    await sleep(120);
    r = await rectOf(targets);
  }
  return r;
}
/** Puts the camera on the targets (pull back, scroll, push in when they are out of view). */
async function focus(targets: Target[], opts: CamOpts & { top?: number } = {}) {
  await cam.to(await inView(targets, 0, opts.top), opts);
}

/* ---------- callouts: spotlight + ring (+ label and arrow, + underline for numbers), synced to the voice ---------- */
interface Callout { t: number; at: At; rect: Rect; label?: string; num: boolean; valid?: number }
const callouts: Callout[] = [];
/** The page under the callouts changed (scroll, click, new screen): callouts shown so far end here. */
function invalidate() {
  const t = now();
  for (const c of callouts) if (c.valid === undefined) c.valid = t;
}
/**
 * Shows a callout on the targets when the narration reaches `at` (a word of sentence `line`, or a fraction of it).
 * The camera starts moving just before, so it has arrived when the word is heard. In a sped-up scene everything is
 * logged against the narration and placed by the editor; the page must not scroll there.
 */
async function show(line: number, at: string | number, targets: Target[], o: { label?: string; num?: boolean; cam?: CamOpts | false } = {}) {
  const s = open!;
  const w = when(line, at);
  const d = o.cam === false ? 0 : (o.cam?.d ?? 0.8);
  const room = o.label ? 64 : 18;
  if (!s.fit) await sleep((w.t - d - now()) * 1000);
  let r = s.fit ? await rectOf(targets) : await inView(targets, room);
  if (s.fit) r = { x: r.x, y: Math.max(0, r.y), w: r.w, h: Math.min(H - 6, r.y + r.h) - Math.max(0, r.y) };
  if (o.cam !== false) {
    const box = { x: r.x - 16, y: r.y - room, w: r.w + 32, h: r.h + 2 * room };
    void cam.to(box, { pad: 1.06, maxZ: 1.9, ...o.cam, d }, s.fit ? w.at : undefined);
  }
  if (!s.fit) {
    await sleep((w.t - now()) * 1000);
    r = await rectOf(targets);
  }
  callouts.push({ t: now(), at: w.at, rect: r, label: o.label, num: !!o.num });
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
  await show(0, 0, ['.pair'], { cam: false });
  await show(1, 0, [{ text: page.locator('.m.hi') }], { num: true, label: '5 out of 5', cam: { z: 1.6, d: 0.9 } });
  await show(1, 'The other', [{ text: page.locator('.m.lo') }], { num: true, label: '2 out of 5' });
  await show(2, 0, ['h1'], { cam: { z: 1, force: true, d: 0.9 } });
  await done({ tail: 0.4 });

  /* 2. Landing */
  await page.goto(base);
  await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('heading', { name: 'Same answer. Different mark.' }).waitFor();
  await sleep(500);
  await showCursor();
  await scene('landing', script.landing, { caption: { k: 'Sample class', t: 'Illustrative: written for this demo, not real student work.' } });
  await show(0, 0, ['.local-chip'], { label: 'Nothing is uploaded', cam: { z: 1.7, d: 0.7 } });
  await show(1, 'Drop in', ['#drop'], { cam: { pad: 1.04 } });
  void pointAt('#drop', 900, 0.5, 0.62);
  await show(1, 'or try', ['[data-act="sample"]'], { label: 'Sample class', cam: { pad: 1.04 } });
  await pointAt('[data-act="sample"]', 700);
  await show(1, 'sixty-six', [{ text: page.locator('.sample-note') }], { label: 'Illustrative, not real students' });
  await settle(0.4);
  await press('[data-act="sample"]', 300);
  invalidate();
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await cam.wide(0.7);
  await done({ hold: false });

  /* 3. Columns */
  await scene('columns', script.columns, { caption: { k: 'Columns', t: 'Matched from the header. Any of them can be changed.' } });
  await show(0, 0, ['.fields'], { label: 'Matched from the header' });
  void pointAt('.fields select >> nth=2', 900);
  await show(0, 'you can change', ['.fields select >> nth=2'], { label: 'Change any column' });
  const qcol = [0, 1, 2, 3, 4].map((k) => page.locator('.preview tr > :first-child').nth(k));
  await show(1, 0, qcol, { label: 'Compared within a question' });
  await settle(0.6);
  await focus(['[data-act="analyse"]'], { z: 1.6, d: 0.7 });
  await press('[data-act="analyse"]', 600);
  invalidate();
  await done({ hold: false });

  /* 4. Reading: first run, models download; shown faster, labelled with the real factor */
  await scene('reading', script.reading, { fit: true, lead: 1.2, caption: { k: 'First run', t: 'Includes the one-time model download.' } });
  // The new screen keeps the scroll position of the columns screen: back to the top before anything is measured.
  await cam.wide(0.5);
  await scrollToY(0, 450);
  await sleep(150);
  await show(0, 0, ['#st-model'], { label: 'One-time download', cam: { d: 0.9 } });
  await show(1, 0, ['#st-embed'], { label: 'all-MiniLM-L6-v2' });
  await show(1, 'turns every', ['#scansheet'], { label: 'Scanner: one line per answer', cam: { pad: 1.02 } });
  await show(2, 0, ['#st-nli'], { label: 'deberta-base-long-nli' });
  await show(3, 0, ['#net'], { label: 'Every request listed' });
  void cam.to({ x: 0, y: 0, w: W, h: H }, { z: 1, force: true, d: 0.8 }, { scene: scenes.length - 1, line: 3, frac: 1 });
  await page.locator('.finding h1').waitFor({ timeout: 600000 });
  // End the sped-up scene the moment results appear, so the arrival plays at real speed.
  await done({ hold: false });

  /* 5. Arrival (the signature moment) */
  const finding = await page.locator('.finding h1').innerText();
  const nCases = Number((finding.match(/(\d+) case/) ?? [])[1] ?? 0);
  const marks = await page.$$eval('.case-sheet .scale', (els) => els.map((e) => (e.getAttribute('aria-label') ?? '').match(/Mark (\S+)/)?.[1] ?? '?'));
  await scene('arrival', [`${cap(say(nCases))} cases.`, 'In the first, these two answers say the same thing.', `One was marked ${say(Number(marks[0]))}. The other, ${say(Number(marks[1]))}.`], {
    lead: 0.9,
    caption: { k: 'Case 1', t: `Same meaning, marked ${marks[0]} and ${marks[1]}.` },
  });
  await show(0, 0, [{ text: page.locator('.finding h1 .n') }], { num: true, cam: false });
  await sleep(1200);
  await show(1, 0, ['.case-sheet .answer--a', '.case-sheet .answer--b'], { cam: { pad: 1.04, d: 1.0 } });
  const bubble = (k: number) => page.locator('.case-sheet .scale').nth(k).locator('.bubble.is-filled');
  await show(2, 0, [bubble(0)], { num: true, label: `Marked ${marks[0]}`, cam: { z: 1.8, d: 0.9 } });
  await show(2, 'The other', [bubble(1)], { num: true, label: `Marked ${marks[1]}` });
  await done({ tail: 0.5 });

  /* 6. Evidence */
  const ev = (k: number) => page.locator('.case-sheet .evidence > div').nth(k);
  const meaning = (await ev(1).innerText()).replace(/\s+/g, ' ');
  const evidence = ['Words the two answers share are underlined.', 'The wording score comes from the first model; the meaning check, from the second.'];
  const both = meaning.match(/\(\d+% and \d+%\)/)?.[0];
  if (/each answer implies the other/i.test(meaning) && both) evidence.push('Here, each answer implies the other.');
  await scene('evidence', evidence, { caption: { k: 'Evidence', t: 'Shared words underlined. Wording from the first model, meaning from the second.' } });
  await show(0, 0, ['.case-sheet .answer--b blockquote'], { label: 'Shared words underlined', cam: { pad: 1.04 } });
  await show(1, 0, [{ text: ev(0).locator('.label') }], { num: true, label: 'Wording score' });
  await show(1, 'the meaning check', [{ text: ev(1).locator('.label') }], { label: 'Meaning check' });
  if (evidence.length > 2) await show(2, 0, [{ text: ev(1).locator('p'), sub: both }], { num: true, label: 'Implies both ways' });
  await done({ tail: 0.4 });

  /* 7. Decisions */
  await scene('decide', script.decide, { caption: { k: 'Decision', t: 'A person decides every case. The tool never changes a mark.' } });
  await show(0, 0, ['[data-decide="remark"]', '[data-decide="right"]'], { cam: { z: 1.8, d: 0.9 } });
  void pointAt('[data-decide="right"]', 800);
  await show(1, 0, ['[data-decide="remark"]'], { label: 'Needs re-mark' });
  await press('[data-decide="remark"]', 450);
  invalidate();
  await sleep(1100); // the bubble fills, then the next case slides in
  await show(2, 0, ['[data-decide="right"]'], { label: 'Marks stand', cam: { z: 1.8, d: 0.8 } });
  await press('[data-decide="right"]', 600);
  invalidate();
  await page.locator('#reason').waitFor();
  await show(2, 'records why', ['#reason'], { label: 'The reason goes in the report', cam: { pad: 1.04, d: 0.7 } });
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
  const why = hasTrap2 ? trap2 : trap;
  const pct = ((await why.locator('.aside-why').innerText()).match(/contradiction \((\d+%)\)/) ?? [])[1];
  await scene('aside', aside, { caption: { k: 'Set aside', t: 'Look-alikes that say the opposite are not flagged.' } });
  const textOf = (item: Locator) => [{ text: item.locator('.label').first() }, { text: item.locator('.aside-pair p').nth(0) }, { text: item.locator('.aside-pair p').nth(1) }];
  await show(0, 0, [{ text: page.locator('.screen-head p', { hasText: 'These answers look alike' }) }], { label: 'Look-alikes, set aside' });
  await show(1, 0, textOf(trap).slice(1), { label: 'Opposite meanings' });
  if (sim) await show(1, 'score', [{ text: trap.locator('.label').first(), sub: `Wording ${sim}` }], { num: true, label: `Wording ${sim}` });
  if (hasTrap2) await show(2, 0, textOf(trap2).slice(1), { label: 'Needs it / does not need it' });
  await show(aside.length - 1, 0, [{ text: why.locator('.aside-why'), sub: pct ? `contradiction (${pct})` : undefined }], { num: true, label: pct ? `Contradiction ${pct}` : 'Contradiction', cam: { z: 1.7, left: true } });
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
  await scene('offline', script.offline, { caption: { k: 'Offline', t: 'Browser set to offline mode for this run.' } });
  await press('[data-act="analyse"]', 500);
  invalidate();
  // With the models cached the check is quick; the reading screen may already be gone by the time it is named.
  await show(0, 'cached', ['#st-model'], { label: 'Loaded from the cache', cam: { d: 0.7 } }).catch(() => {});
  await page.locator('.finding h1').waitFor({ timeout: 180000 });
  invalidate();
  if (cam.z > 1.01) void cam.wide(0.7);
  const again = Number(((await page.locator('.finding h1').innerText()).match(/(\d+) case/) ?? [])[1] ?? 0);
  await show(1, 'checked again', [{ text: page.locator('.finding h1 .n') }], {
    num: true, label: again === nCases ? `Same ${again} cases, offline` : `${again} cases, offline`, cam: { z: 1.6, d: 0.8 },
  });
  await done({ tail: 0.6 });
  await context.setOffline(false);

  /* 10. Report */
  await scene('report', script.report, { lead: 1.4, caption: { k: 'Report', t: 'Anonymous codes. A spreadsheet for the exam board.' } });
  await pointAt('[data-tab="report"]', 700);
  await press('[data-tab="report"]', 150);
  invalidate();
  await sleep(300);
  const firstCase = page.locator('.report-case').first();
  const code = ((await firstCase.locator('li').first().innerText()).split(':')[0] ?? '').trim();
  await show(0, 0, [{ text: firstCase.locator('li').first(), sub: code }], { num: true, label: 'Anonymous code' });
  await show(0, 'lists each case', [firstCase.locator('.status')], { label: 'Decision' });
  await show(1, 0, ['.report-actions [data-act="csv"]'], { label: 'Spreadsheet export' });
  const [dl] = await Promise.all([page.waitForEvent('download'), press('.report-actions [data-act="csv"]', 600)]);
  await dl.saveAs(join(work, 'report.csv'));
  await show(2, 0, [{ text: firstCase.locator('ul') }], { label: 'Marks as given' });
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
  const ln = (i: number) => page.locator(`.ln[data-i="${i}"]`);
  const num = (i: number, sub: string) => ({ text: ln(i), sub });
  const sB = lineAt(/^== Sample class/), hB = lineAt(/^== Held-out set 2/);
  await scene('measured', script.measured, { caption: { k: 'Measured', t: 'Real output of npm run eval. Browser scores differ slightly; see the README.' } });
  await show(0, 0, [{ text: ln(0) }], { label: 'Real output', cam: { z: 1.5 } });
  await show(1, 'planted', [{ text: ln(sB) }], { label: 'Labelled class' });
  await show(2, 'found', [num(lineAt(/recall/, sB), `${sample.found}/${sample.planted}`)], { num: true, label: `${sample.found} of ${sample.planted} found` });
  await show(2, 'and ', [num(lineAt(/precision \(flagged/, sB), `${sample.good}/${sample.flagged}`)], { num: true, label: `${sample.good} of ${sample.flagged} flags correct` });
  await show(3, 0, [{ text: ln(hB) }], { label: 'Held-out class' });
  await show(3, 'it found', [num(lineAt(/recall/, hB), `${held.found}/${held.planted}`)], { num: true, label: `${held.found} of ${held.planted} found` });
  await show(3, 'and ', [num(lineAt(/precision \(flagged/, hB), `${held.good}/${held.flagged}`)], { num: true, label: `${held.good} of ${held.flagged} flags correct` });
  await show(4, 0, [num(lineAt(/baseline/, hB), `${held.baseGood}/${held.baseFlagged}`)], { num: true, label: `Wording alone: ${held.baseFlagged} flagged` });
  await done({ tail: 0.4 });

  /* 12. End card */
  await page.goto('http://localhost:4318/cards/end.html');
  await page.evaluate(() => document.fonts.ready);
  await scene('end', script.end, { lead: 0.5 });
  await show(0, 0, ['.flow'], { cam: { pad: 1.04, d: 1.0 } });
  await show(0, 'all Mini', ['.flow > div >> nth=1'], { label: 'Wording' });
  await show(0, 'DeBERTa', ['.flow > div >> nth=2'], { label: 'Meaning' });
  await show(1, 0, [{ text: page.locator('.limits') }], { cam: { z: 1, force: true, d: 1.0 } });
  await done({ tail: 1.6 });
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();
  server.close();
}

writeFileSync(join(work, 'timeline.json'), JSON.stringify({ W, H, scale: SCALE, maxZ: MAX_Z, frames: captured, scenes, shots, callouts }, null, 1));
console.log(`recorded ${captured.length} frames over ${(captured.at(-1)!.t - captured[0].t).toFixed(1)} s; ${scenes.length} scenes, ${shots.length} camera moves, ${callouts.length} callouts`);
