/**
 * Records the demo video from the real built app: a scripted browser session is captured frame by
 * frame, cut into scenes, given a spoken narration (macOS `say`) and burned-in captions, and joined
 * into assets/demo.mp4. Title, terminal and end cards are separate HTML pages in scripts/video/.
 *
 *   npm run build && npx tsx scripts/video/record.ts
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const work = resolve(root, '.cache/video');
const frames = join(work, 'frames');
rmSync(work, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const W = 1440;
const H = 900;
const FPS = 30;

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

/* ---------- browser with a visible cursor drawn into the page (headless has none) ---------- */
const browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, acceptDownloads: true });
await context.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2l0 19 5-5 3.5 8 3-1.4-3.5-7.6 7 0z" fill="#1f2023" stroke="#fff" stroke-width="1.5"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999', pointerEvents: 'none', transform: 'translate(-100px,-100px)' });
    document.body.append(c);
    addEventListener('mousemove', (e: MouseEvent) => (c.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 2}px)`), true);
    addEventListener('mousedown', (e: MouseEvent) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: e.clientX - 18 + 'px', top: e.clientY - 18 + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '2px solid #2146d8', zIndex: '99998', pointerEvents: 'none', transition: 'transform 400ms ease-out, opacity 400ms ease-out' });
      document.body.append(r);
      requestAnimationFrame(() => Object.assign(r.style, { transform: 'scale(1.6)', opacity: '0' }));
      setTimeout(() => r.remove(), 450);
    }, true);
  });
});
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
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const now = () => Date.now() / 1000;
// Keep frames flowing while the page is static (the screencast only sends changes).
const ticker = setInterval(() => page.evaluate(() => document.body.style.setProperty('--tick', String(Math.random()))).catch(() => {}), 100);

interface Scene { name: string; start: number; end: number; say: string; caption?: string; speed?: number; aiff: string; voice: number }
const scenes: Scene[] = [];
let open: Scene | null = null;
const dur = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
/** Starts a scene. The narration is synthesised first so the scene can be held until it is spoken. */
function scene(name: string, say: string, opts: { caption?: string; speed?: number } = {}) {
  // The scene starts before the narration is synthesised, so an animation already running is not cut.
  const start = now();
  const aiff = join(work, `v-${name}.aiff`);
  execFileSync('say', ['-v', 'Samantha', '-r', '178', '-o', aiff, say]);
  open = { name, start, end: 0, say, ...opts, aiff, voice: dur(aiff) };
  scenes.push(open);
}
/**
 * Holds the current scene until its narration fits, then ends it (footage after this is not used).
 * hold: false ends it now; the assembler fits the footage to the narration instead.
 */
async function done({ hold = true } = {}) {
  if (!open) return;
  const need = (open.voice + 0.9) * (open.speed ?? 1);
  const left = need - (now() - open.start);
  if (hold && left > 0) await page.waitForTimeout(left * 1000);
  open.end = now();
  open = null;
}
const wait = (ms: number) => page.waitForTimeout(ms);
async function moveTo(p: Page, selector: string, steps = 18) {
  const box = await p.locator(selector).first().boundingBox();
  if (!box) throw new Error('not visible: ' + selector);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}
async function click(selector: string) {
  await moveTo(page, selector);
  await wait(250);
  await page.locator(selector).first().click();
}

const evalOut = readFileSync(resolve(root, '.cache/eval-out.txt'), 'utf8');
const testOut = readFileSync(resolve(root, '.cache/test-out.txt'), 'utf8');
// Numbers for the narration come from the real eval output shown on screen.
function setStats(title: RegExp) {
  const block = evalOut.replace(/^== /, '').split('\n== ').find((b) => title.test(b)) ?? '';
  const g = (re: RegExp) => (block.match(re) ?? []).slice(1).map(Number);
  const [found, planted] = g(/found\):\s+(\d+)\/(\d+)/);
  const [good, flagged] = g(/planted answer\):\s+(\d+)\/(\d+)/);
  const [, baseFlagged] = g(/precision (\d+)\/(\d+)/);
  return { found, planted, good, flagged, baseFlagged };
}
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const say = (k: number) => words[k] ?? String(k);
const sample = setStats(/^Sample class/);
const held = setStats(/^Held-out set 2/);
const flagLine = (x: ReturnType<typeof setStats>) => (x.good === x.flagged ? 'and every flag was correct' : `and ${say(x.good)} of its ${say(x.flagged)} flags were correct`);

try {
  /* 1. Title card */
  await page.goto('http://localhost:4318/cards/title.html');
  await wait(300);
  scene('title', 'Two students wrote the same answer. One got full marks. The other got two out of five. Second Marker finds these cases before the marks go to the exam board.');
  await wait(1000);

  await done();

  /* 2. Landing */
  await page.goto(base);
  await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('heading', { name: 'Same answer. Different mark.' }).waitFor();
  await page.mouse.move(700, 500);
  await wait(400);
  scene('landing', 'It runs in the browser. Drop in a marked spreadsheet, or try the sample class: sixty-six short answers to four data structures questions, written for this demo.', {
    caption: 'The sample class is illustrative, not real student work.',
  });
  await wait(1500);
  await moveTo(page, '#drop', 22);
  await wait(1800);
  await click('[data-act="sample"]');
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await wait(1500);

  await done();

  /* 3. Columns */
  scene('columns', 'Columns are matched from the header and can be changed. Answers are only ever compared with answers to the same question.');
  await moveTo(page, '.fields', 20);
  await wait(3500);
  await click('[data-act="analyse"]');

  await done();

  /* 4. Reading (first run: models download) */
  scene('reading', 'On the first run the two models download once. Every answer becomes a meaning vector, and each similar pair with different marks goes to a second model, which checks whether each answer implies the other. Nothing is uploaded. The page lists every request it makes.', {
    caption: 'First run, including the one-time model download.',
    speed: 2,
  });
  await page.locator('.finding h1').waitFor({ timeout: 600000 });

  // End the sped-up scene the moment results appear, so the arrival plays at real speed in the next scene.
  await done({ hold: false });

  /* 5. Arrival */
  const nCases = Number(((await page.locator('.finding h1').innerText()).match(/(\d+) case/) ?? [])[1] ?? 0);
  const marks = await page.$$eval('.scale', (els) => els.map((e) => (e.getAttribute('aria-label') ?? '').match(/Mark (\S+)/)?.[1] ?? '?'));
  scene('arrival', `${say(nCases)[0].toUpperCase() + say(nCases).slice(1)} cases. In the first, these two answers say the same thing. One was marked ${marks[0]}, the other ${marks[1]}.`);
  await wait(2600);
  await page.mouse.move(820, 980 - 100, { steps: 25 });
  await wait(3000);

  await done();

  /* 6. Review */
  scene('review', 'Words the answers share are underlined. The wording score comes from the first model, the meaning check from the second. A person decides every case. This one needs re-marking. In the next, the moderator keeps the marks and records why.');
  await page.mouse.wheel(0, 380);
  await wait(1800);
  await click('[data-decide="remark"]');
  await wait(2200);
  await page.mouse.wheel(0, 380);
  await wait(800);
  await click('[data-decide="right"]');
  await wait(600);
  await page.locator('#reason').pressSequentially('Discussed with Marker A: keep marks, note for the exam board.', { delay: 28 });
  await wait(1200);

  await done();

  /* 7. Set aside */
  await page.mouse.wheel(0, -2000);
  await wait(600);
  scene('aside', 'Similar words are not the same meaning. A stack is LIFO, and a stack is FIFO, look almost identical. The meaning check finds the contradiction, so their different marks are not flagged.');
  await click('[data-tab="aside"]');
  await wait(800);
  const trap = page.locator('.aside-item', { hasText: 'A stack is FIFO and a queue is LIFO.' }).first();
  await trap.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await wait(400);
  const tb = await trap.boundingBox();
  if (tb) await page.mouse.move(tb.x + 260, tb.y + 90, { steps: 25 });
  await wait(6000);

  await done();

  /* 8. Offline */
  await page.mouse.wheel(0, -4000);
  await click('[data-act="home"]');
  await click('[data-act="sample"]');
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await context.setOffline(true);
  scene('offline', 'Once the models are cached, it works with the network off. Here the browser is set to offline, and the class is checked again.', {
    caption: 'Browser set to offline mode for this run.',
  });
  await wait(1200);
  await click('[data-act="analyse"]');
  await page.locator('.finding h1').waitFor({ timeout: 120000 });
  await wait(3500);
  await context.setOffline(false);

  await done();

  /* 9. Report */
  scene('report', 'The report replaces student ids with anonymous codes, lists every case with its decision, and downloads as a spreadsheet for the exam board. The tool never changes a mark.');
  await click('[data-tab="report"]');
  await wait(1500);
  await page.mouse.wheel(0, 500);
  await wait(2500);
  await page.mouse.wheel(0, -500);
  await wait(600);
  const [dl] = await Promise.all([page.waitForEvent('download'), click('[data-act="csv"]')]);
  await dl.saveAs(join(work, 'report.csv'));
  await wait(3000);

  await done();

  /* 10. Measured */
  const term = `$ npm test\n${testOut.trim()}\n\n$ npm run eval\n${evalOut.trim()}`;
  await page.goto('http://localhost:4318/cards/terminal.html');
  await page.evaluate((t) => (document.getElementById('out')!.textContent = t), term);
  await wait(300);
  scene('measured', `Is it right? The same pipeline runs against labelled classes with planted mis-marks. On the sample class it found ${say(sample.found)} of ${say(sample.planted)}, ${flagLine(sample)}. On a held-out class written after every setting was chosen, it found ${say(held.found)} of ${say(held.planted)}, ${flagLine(held)}. Wording similarity alone would have flagged ${held.baseFlagged} pairs there, not ${say(held.flagged)}.`, {
    caption: 'Real output. Browser runs score slightly differently; see the README.',
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(3000);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 120);
    await wait(900);
  }
  await wait(4000);

  await done();

  /* 11. End card */
  await page.goto('http://localhost:4318/cards/end.html');
  await wait(300);
  scene('end', 'Second Marker runs two open models in the browser: all MiniLM for wording, and a DeBERTa model trained for natural language inference, for meaning. It handles short English answers, and its flags are evidence for a person, not verdicts.');
  await wait(6000);
  await done();
} finally {
  clearInterval(ticker);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();
  server.close();
}

/* ---------- assemble ---------- */
writeFileSync(join(work, 'scenes.json'), JSON.stringify(scenes, null, 2));
// Constant frame rate video from the timestamped frames.
const lines: string[] = [];
for (let i = 0; i < captured.length; i++) {
  // The screencast only sends frames on change, so the last frame lasts until the last scene ends.
  const lastEnd = Math.max(...scenes.map((x) => x.end)) + 0.5;
  const d = (captured[i + 1]?.t ?? Math.max(lastEnd, captured[i].t + 0.5)) - captured[i].t;
  lines.push(`file '${captured[i].file}'`, `duration ${Math.max(0.001, d).toFixed(4)}`);
}
lines.push(`file '${captured[captured.length - 1].file}'`);
writeFileSync(join(work, 'frames.txt'), lines.join('\n'));
const t0 = captured[0].t;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
ff(['-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'), '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', join(work, 'raw.mp4')]);

// Caption images, rendered in the app's type.
const cap = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });
const cpage = await cap.newPage({ viewport: { width: W, height: 120 } });
const server2 = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'font/woff2' });
  createReadStream(join(root, 'node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2')).pipe(res);
});
await new Promise<void>((r) => server2.listen(4319, r));

const parts: string[] = [];
for (const [i, s] of scenes.entries()) {
  const aiff = s.aiff;
  const voice = s.voice;
  // A sped-up scene (waiting on the model download) is fitted to its narration; the caption states the factor.
  const real = s.end - s.start;
  const speed = s.speed ? Math.max(1, real / (voice + 1.2)) : 1;
  const footage = real / speed;
  const length = Math.max(voice + 0.8, footage);
  const capText = s.speed && speed > 1.05 ? `${s.caption ?? ''} Sped up ${speed.toFixed(1)}x.` : (s.caption ?? '');
  const capPng = join(work, `c${i}.png`);
  await cpage.setContent(`<html><head><style>
    @font-face { font-family: A; src: url(http://localhost:4319/a.woff2) format('woff2'); font-stretch: 62% 125%; font-weight: 100 900; }
    html,body{margin:0;background:transparent}
    .c{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);max-width:1100px;font:500 22px/30px A,system-ui;color:#fff;background:rgba(31,32,35,.86);padding:10px 20px;border-radius:4px;text-align:center}
    .k{display:block;font-size:15px;line-height:20px;color:#f5b7ab;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-stretch:75%;margin-bottom:2px}
  </style></head><body>${capText ? `<div class="c"><span class="k">Note</span>${capText.replace(/</g, '&lt;')}</div>` : ''}</body></html>`);
  await cpage.waitForTimeout(150);
  await cpage.screenshot({ path: capPng, omitBackground: true });
  const out = join(work, `p${i}.mp4`);
  const ss = (s.start - t0).toFixed(3);
  const tt = (s.end - s.start).toFixed(3);
  const vf = `setpts=(PTS-STARTPTS)/${speed},tpad=stop_mode=clone:stop_duration=${Math.max(0, length - footage + 0.1).toFixed(2)},trim=duration=${length.toFixed(2)},fps=${FPS}`;
  ff([
    '-ss', ss, '-t', tt, '-i', join(work, 'raw.mp4'), '-i', capPng, '-i', aiff,
    '-filter_complex', `[0:v]${vf}[v];[v][1:v]overlay=0:${H - 120}[vo];[2:a]aresample=48000,apad,atrim=duration=${length.toFixed(2)}[a]`,
    '-map', '[vo]', '-map', '[a]', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', out,
  ]);
  parts.push(out);
  console.log(`scene ${s.name}: footage ${footage.toFixed(1)}s, voice ${voice.toFixed(1)}s -> ${length.toFixed(1)}s`);
}
await cap.close();
server2.close();
writeFileSync(join(work, 'parts.txt'), parts.map((p) => `file '${p}'`).join('\n'));
mkdirSync(resolve(root, 'assets'), { recursive: true });
ff(['-f', 'concat', '-safe', '0', '-i', join(work, 'parts.txt'), '-c', 'copy', '-movflags', '+faststart', resolve(root, 'assets/demo.mp4')]);
console.log('wrote assets/demo.mp4', dur(resolve(root, 'assets/demo.mp4')).toFixed(1), 's');
