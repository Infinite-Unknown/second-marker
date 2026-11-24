/**
 * Demo video, step 2 of 2: turns the recording from record.ts into assets/demo.mp4.
 *
 *  - Each scene becomes a 60 fps segment cut from the 2880x1620 capture. Scenes that wait on the models are
 *    shown faster, by the factor that fits them to their narration, and their caption states that factor.
 *  - The camera is a per-frame crop of the 2x capture (ffmpeg perspective, cubic, sub-pixel), eased with an
 *    ease-in-out cubic between targets that came from real element rectangles, then scaled to 1920x1080.
 *  - Callouts: whenever the narration names something on screen, a spotlight dims the rest of the frame, a ring
 *    draws on around the element's recorded bounding box, numbers get an underline, small things a label and an
 *    arrow. They are drawn in capture space before the camera, so they stay on the element while the camera moves.
 *    One at a time; each ends when the narration moves on.
 *  - Captions are rendered in the app's typeface and fade and rise in.
 *  - Narration sentences are placed at the times the recorder cued them, mixed, and normalised to -16 LUFS.
 *  - A second, smaller file (assets/demo-upload.mp4, under 9.5 MB) is made for upload forms with a size limit.
 *
 *   npx tsx scripts/video/edit.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const work = resolve(root, '.cache/video');
const out = resolve(root, 'assets/demo.mp4');
const outSmall = resolve(root, 'assets/demo-upload.mp4');
const FPS = 60;
const OW = 1920;
const OH = 1080;
const DESK = '0xE5E8E3';
const DIP = 0.25; // fade through the desk colour at a cut, each side

interface Line { text: string; file: string; dur: number }
interface Scene {
  name: string; start: number; end: number; lead: number; fit: boolean;
  caption?: { k: string; t: string }; lines: Line[]; offsets: number[]; total: number;
}
interface At { scene: number; line: number; frac: number }
interface Shot { t: number; d: number; cx: number; cy: number; z: number; at?: At }
interface Rect { x: number; y: number; w: number; h: number }
interface Callout { t: number; at: At; rect: Rect; label?: string; num: boolean; valid?: number }
const tl = JSON.parse(readFileSync(join(work, 'timeline.json'), 'utf8')) as {
  W: number; H: number; scale: number; maxZ: number; frames: { t: number; file: string }[]; scenes: Scene[]; shots: Shot[]; callouts: Callout[];
};
const CW = tl.W * tl.scale;
const CH = tl.H * tl.scale;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const probe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

/* ---------- plan: output start, length and speed of every scene ---------- */
const plan = tl.scenes.map((s, i) => {
  const real = s.end - s.start;
  const need = s.lead + s.total + 0.6;
  // Below 5% the wait is shown at real speed (and padded) rather than sped up by an amount not worth a label.
  const factor = s.fit && real / need > 1.05 ? real / need : 1;
  const len = Math.max(real / factor, s.lead + s.total + 0.3);
  const cutIn = i > 0 && s.start - tl.scenes[i - 1].end > 0.1;
  return { s, real, factor, len, cutIn, outStart: 0 };
});
let acc = 0;
for (const p of plan) { p.outStart = acc; acc += p.len; }
const total = acc;
for (const p of plan) {
  console.log(`${p.s.name.padEnd(9)} at ${p.outStart.toFixed(1).padStart(6)} s  ${p.len.toFixed(1).padStart(5)} s  real ${p.real.toFixed(1)} s${p.factor > 1.001 ? `  sped up ${p.factor.toFixed(2)}x` : ''}${p.cutIn ? '  (cut)' : ''}`);
}
console.log(`total ${total.toFixed(1)} s`);
const speedLabel = (f: number) => `Sped up ${f.toFixed(1)}×.`;

/** Output time of a recorder timestamp. */
function outTime(t: number) {
  for (const p of plan) {
    if (t < p.s.start) return p.outStart; // in a gap before this scene: the cut
    if (t <= p.s.end) return p.outStart + (t - p.s.start) / p.factor;
  }
  return total;
}
/** Output time of a moment in the narration. */
function atTime(a: At) {
  const p = plan[a.scene];
  const L = p.s.lines[a.line];
  return p.outStart + p.s.lead + p.s.offsets[a.line] + a.frac * Math.max(0, L.dur - 0.15);
}

const fontServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*' });
  createReadStream(join(root, 'node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2')).pipe(res);
});
await new Promise<void>((r) => fontServer.listen(4319, r));
const browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });

/* ---------- 0. callouts: when each is on screen, and its frames ---------- */
interface Win { c: Callout; scene: number; a: number; b: number; dir: string }
const wins: Win[] = tl.callouts
  .map((c) => ({ c, scene: c.at.scene, a: plan[c.at.scene].s.fit ? atTime(c.at) : outTime(c.t), b: 0, dir: '' }))
  .sort((x, y) => x.a - y.a);
for (const [j, w] of wins.entries()) {
  const p = plan[w.scene];
  const next = wins.slice(j + 1).find((x) => x.scene === w.scene);
  let b = Math.min(atTime({ ...w.c.at, frac: 1 }) + 0.35, p.outStart + p.len - 0.1);
  if (next && next.a - b < 0.8) b = next.a; // hand over directly rather than leave a short gap
  if (next) b = Math.min(b, next.a);
  if (w.c.valid !== undefined) b = Math.min(b, outTime(w.c.valid));
  w.b = b;
}
const shown = wins.filter((w) => w.b - w.a >= 0.4);
console.log(`callouts: ${shown.length} of ${wins.length} shown`);
const CO_FRAMES = 10; // draw-on frames at 30 fps: 0.33 s
const copage = await browser.newPage({ viewport: { width: tl.W, height: tl.H }, deviceScaleFactor: tl.scale });
await copage.setContent(`<html><head><style>
  @font-face { font-family: A; src: url(http://localhost:4319/a.woff2) format('woff2'); font-stretch: 62% 125%; font-weight: 100 900; }
  html, body { margin: 0; background: transparent; width: ${tl.W}px; height: ${tl.H}px; overflow: hidden; }
  svg { position: absolute; left: 0; top: 0; }
  #lab { position: absolute; left: 0; top: 0; font: 600 15px/20px A, system-ui; color: #fff; background: #2146d8; padding: 6px 11px 7px;
         border-radius: 5px; white-space: nowrap; box-shadow: 0 6px 18px -6px rgb(16 30 90 / .55); opacity: 0; font-variant-numeric: tabular-nums; }
</style></head><body>
<svg width="${tl.W}" height="${tl.H}" viewBox="0 0 ${tl.W} ${tl.H}">
  <defs>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${tl.W}" height="${tl.H}">
      <rect width="${tl.W}" height="${tl.H}" fill="#fff"/><rect id="hole" rx="14" fill="#000" filter="url(#soft)"/>
    </mask>
  </defs>
  <rect id="dim" width="${tl.W}" height="${tl.H}" fill="#121418" mask="url(#m)" opacity="0"/>
  <rect id="halo" rx="9" fill="none" stroke="#fff" stroke-width="7" stroke-opacity=".9" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/>
  <rect id="ring" rx="9" fill="none" stroke="#2146d8" stroke-width="3" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/>
  <line id="ul" stroke="#2146d8" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/>
  <path id="arrow" fill="none" stroke="#2146d8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
</svg><div id="lab"></div>
<script>
  const $ = (id) => document.getElementById(id);
  const set = (el, a) => { for (const k in a) el.setAttribute(k, a[k]); };
  let dir = 1;
  window.setup = (c) => {
    const W = ${tl.W}, H = ${tl.H}, r = c.rect;
    const ring = { x: r.x - 6, y: r.y - 5, w: r.w + 12, h: r.h + 10 };
    set($('hole'), { x: r.x - 14, y: r.y - 12, width: r.w + 28, height: r.h + 24 });
    for (const id of ['halo', 'ring']) set($(id), { x: ring.x, y: ring.y, width: ring.w, height: ring.h });
    const ul = $('ul');
    ul.style.display = c.num ? '' : 'none';
    set(ul, { x1: r.x, y1: r.y + r.h + 1, x2: r.x + r.w, y2: r.y + r.h + 1 });
    const lab = $('lab'), arrow = $('arrow');
    lab.style.display = arrow.style.display = c.label ? '' : 'none';
    if (!c.label) return;
    lab.textContent = c.label;
    const lw = lab.offsetWidth, lh = lab.offsetHeight, gap = 30;
    const above = ring.y - gap - lh > 8;
    dir = above ? 1 : -1;
    const cx = Math.min(W - lw / 2 - 10, Math.max(lw / 2 + 10, ring.x + ring.w / 2));
    const ly = above ? ring.y - gap - lh : ring.y + ring.h + gap;
    lab.style.left = cx - lw / 2 + 'px';
    lab.style.top = ly + 'px';
    const ax = Math.min(ring.x + ring.w - 14, Math.max(ring.x + 14, cx));
    const y0 = above ? ly + lh + 3 : ly - 3, y1 = above ? ring.y - 5 : ring.y + ring.h + 5;
    const hx = 5, hy = above ? -7 : 7;
    arrow.setAttribute('d', 'M' + cx + ' ' + y0 + ' L' + ax + ' ' + y1 + ' M' + (ax - hx) + ' ' + (y1 + hy) + ' L' + ax + ' ' + y1 + ' L' + (ax + hx) + ' ' + (y1 + hy));
  };
  window.frame = (p) => {
    const e = 1 - Math.pow(1 - p, 3), cl = (v) => Math.max(0, Math.min(1, v));
    $('dim').setAttribute('opacity', String(0.6 * cl(p * 1.6)));
    for (const id of ['halo', 'ring']) $(id).setAttribute('stroke-dashoffset', String(100 * (1 - e)));
    $('ul').setAttribute('stroke-dashoffset', String(100 * (1 - cl((p - 0.3) / 0.7))));
    const q = cl((p - 0.4) / 0.6);
    $('lab').style.opacity = String(q);
    $('lab').style.transform = 'translateY(' + (1 - q) * 6 * dir + 'px)';
    $('arrow').setAttribute('opacity', String(q));
  };
</script></body></html>`);
await copage.evaluate(() => document.fonts.ready);
const coDir = join(work, 'callouts');
rmSync(coDir, { recursive: true, force: true });
mkdirSync(coDir, { recursive: true });
for (const [j, w] of shown.entries()) {
  w.dir = join(coDir, `c${String(j).padStart(2, '0')}`);
  mkdirSync(w.dir, { recursive: true });
  await copage.evaluate((c) => (window as unknown as { setup: (c: unknown) => void }).setup(c), w.c);
  for (let k = 0; k < CO_FRAMES; k++) {
    await copage.evaluate((p) => (window as unknown as { frame: (p: number) => void }).frame(p), k / (CO_FRAMES - 1));
    await copage.screenshot({ path: join(w.dir, `f${String(k).padStart(2, '0')}.png`), omitBackground: true });
  }
}
await copage.close();
console.log('callout frames rendered');

/* ---------- 1. one segment per scene, from the timestamped frames ---------- */
const frames = tl.frames;
const segs: string[] = [];
for (const [i, p] of plan.entries()) {
  const { s, factor, len } = p;
  let k = frames.findLastIndex((f) => f.t <= s.start);
  if (k < 0) k = 0;
  const list: string[] = [];
  for (; k < frames.length && frames[k].t < s.end; k++) {
    const a = Math.max(frames[k].t, s.start);
    const b = Math.min(frames[k + 1]?.t ?? s.end, s.end);
    list.push(`file '${frames[k].file}'`, `duration ${Math.max(0.0005, (b - a) / factor).toFixed(5)}`);
  }
  list.push(list.at(-2)!);
  writeFileSync(join(work, `s${i}.txt`), list.join('\n'));
  const fades: string[] = [];
  if (i === 0) fades.push(`fade=t=in:st=0:d=0.3:color=${DESK}`);
  if (p.cutIn) fades.push(`fade=t=in:st=0:d=${DIP}:color=${DESK}`);
  if (plan[i + 1]?.cutIn) fades.push(`fade=t=out:st=${(len - DIP).toFixed(3)}:d=${DIP}:color=${DESK}`);
  if (i === plan.length - 1) fades.push(`fade=t=out:st=${(len - 0.7).toFixed(3)}:d=0.7:color=${DESK}`);
  const inputs = ['-f', 'concat', '-safe', '0', '-i', join(work, `s${i}.txt`)];
  const g = [`[0:v]scale=${CW}:${CH}:flags=lanczos,fps=${FPS},tpad=stop_mode=clone:stop_duration=${len.toFixed(3)},trim=duration=${len.toFixed(4)},setpts=PTS-STARTPTS[b0]`];
  const mine = shown.filter((w) => w.scene === i);
  mine.forEach((w, k) => {
    inputs.push('-framerate', '30', '-i', join(w.dir, 'f%02d.png'));
    const rel = w.a - p.outStart, dur = w.b - w.a;
    g.push(`[${k + 1}:v]format=rgba,fps=${FPS},tpad=stop_mode=clone:stop_duration=${dur.toFixed(3)},trim=duration=${dur.toFixed(3)},fade=t=out:st=${Math.max(0, dur - 0.25).toFixed(3)}:d=0.25:alpha=1,setpts=PTS-STARTPTS+${rel.toFixed(4)}/TB[o${k}]`);
    g.push(`[b${k}][o${k}]overlay=0:0:eof_action=pass:enable='between(t,${rel.toFixed(4)},${(rel + dur).toFixed(4)})'[b${k + 1}]`);
  });
  g.push(`[b${mine.length}]${[...fades, 'format=yuv420p'].join(',')}[v]`);
  const seg = join(work, `seg${i}.mp4`);
  ff([...inputs, '-filter_complex', g.join(';'), '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', '-an', seg]);
  segs.push(seg);
}
writeFileSync(join(work, 'segs.txt'), segs.map((f) => `file '${f}'`).join('\n'));
const body = join(work, 'body.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', join(work, 'segs.txt'), '-c', 'copy', body]);

/* ---------- 2. camera: shots mapped to output time, eased one after another ---------- */
interface Move { t0: number; d: number; from: [number, number, number]; to: [number, number, number] }
const clampCam = (cx: number, cy: number, z: number): [number, number, number] => {
  const w = CW / Math.min(tl.maxZ, Math.max(1, z));
  const h = (w * CH) / CW;
  const x = Math.min(CW - w / 2, Math.max(w / 2, cx * tl.scale));
  const y = Math.min(CH - h / 2, Math.max(h / 2, cy * tl.scale));
  return [x, y, w];
};
const moves: Move[] = [];
let cur: [number, number, number] = [CW / 2, CH / 2, CW];
let free = 0;
for (const sh of tl.shots.map((x) => ({ ...x, o: x.at ? Math.max(0, atTime(x.at) - x.d) : outTime(x.t) })).sort((a, b) => a.o - b.o)) {
  const to = clampCam(sh.cx, sh.cy, sh.z);
  const t0 = Math.max(sh.o, free);
  const d = Math.max(0.001, sh.d);
  if (to.every((v, k) => Math.abs(v - cur[k]) < 0.5)) continue;
  moves.push({ t0, d, from: cur, to });
  cur = to;
  free = t0 + d;
}
const term = (m: Move, k: number) => {
  const delta = m.to[k] - m.from[k];
  if (Math.abs(delta) < 0.01) return '';
  return `+(${delta.toFixed(3)})*(st(0,clip((in/${FPS}-${m.t0.toFixed(4)})/${m.d.toFixed(4)},0,1));if(lt(ld(0),0.5),4*ld(0)^3,1-(2-2*ld(0))^3/2))`;
};
const sum = (k: number) => `${[CW / 2, CH / 2, CW][k]}${moves.map((m) => term(m, k)).join('')}`;
const pre = `st(1,${sum(0)});st(2,${sum(1)});st(3,${sum(2)});st(4,ld(3)*${CH}/${CW});`;
const X0 = `${pre}ld(1)-ld(3)/2`, X1 = `${pre}ld(1)+ld(3)/2`, Y0 = `${pre}ld(2)-ld(4)/2`, Y1 = `${pre}ld(2)+ld(4)/2`;
const camera = `perspective=x0='${X0}':y0='${Y0}':x1='${X1}':y1='${Y0}':x2='${X0}':y2='${Y1}':x3='${X1}':y3='${Y1}':interpolation=cubic:sense=source:eval=frame`;
writeFileSync(join(work, 'moves.json'), JSON.stringify(moves, null, 1));

/* ---------- 3. captions, rendered in the app's type ---------- */
const cpage = await browser.newPage({ viewport: { width: OW, height: OH }, deviceScaleFactor: 1 });
interface Cap { file: string; a: number; b: number; h: number }
const caps: Cap[] = [];
for (const [i, p] of plan.entries()) {
  const c = p.s.caption;
  if (!c) continue;
  const text = p.factor > 1 ? `${c.t} ${speedLabel(p.factor)}` : c.t;
  await cpage.setContent(`<html><head><style>
    @font-face { font-family: A; src: url(http://localhost:4319/a.woff2) format('woff2'); font-stretch: 62% 125%; font-weight: 100 900; }
    html, body { margin: 0; background: transparent; }
    .c { position: absolute; left: 0; top: 0; max-width: 880px; font: 500 24px/32px A, system-ui; color: #fff; background: rgb(31 32 35 / .9);
         padding: 14px 22px 15px; border-radius: 4px; font-variant-numeric: tabular-nums; }
    .k { display: block; font-size: 15px; line-height: 20px; color: #f5b7ab; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; font-stretch: 75%; margin-bottom: 3px; }
  </style></head><body><div class="c"><span class="k">${c.k.replace(/</g, '&lt;')}</span>${text.replace(/</g, '&lt;')}</div></body></html>`);
  await cpage.evaluate(() => document.fonts.ready);
  const el = cpage.locator('.c');
  const file = join(work, `cap${i}.png`);
  await el.screenshot({ path: file, omitBackground: true });
  const box = (await el.boundingBox())!;
  const a = p.outStart + Math.min(0.7, p.len * 0.15);
  const b = p.outStart + p.len - (p.cutIn || plan[i + 1]?.cutIn ? 0.45 : 0.3);
  caps.push({ file, a, b, h: Math.round(box.height) });
}
await browser.close();
fontServer.close();

/* ---------- 4. narration: sentences at their cued times, normalised to -16 LUFS ---------- */
const voiceIn: string[] = [];
const voiceF: string[] = [];
let vi = 0;
for (const p of plan) {
  for (const [j, l] of p.s.lines.entries()) {
    const at = Math.round((p.outStart + p.s.lead + p.s.offsets[j]) * 1000);
    voiceIn.push('-i', l.file);
    voiceF.push(`[${vi}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${at}:all=1[a${vi}]`);
    vi++;
  }
}
const mix = `${voiceF.join(';')};${Array.from({ length: vi }, (_, k) => `[a${k}]`).join('')}amix=inputs=${vi}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=duration=${total.toFixed(3)}`;
const rawVoice = join(work, 'voice-raw.wav');
ff([...voiceIn, '-filter_complex', mix + '[a]', '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s16le', rawVoice]);
const meas = spawnSync('ffmpeg', ['-hide_banner', '-i', rawVoice, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const m = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1)) as Record<string, string>;
const voiceWav = join(work, 'voice.wav');
ff(['-i', rawVoice, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', voiceWav]);

/* ---------- 5. picture: camera, scale, captions; then the two files ---------- */
const inputs = ['-i', body, '-i', voiceWav];
const graph: string[] = [`[0:v]${camera},scale=${OW}:${OH}:flags=lanczos,setsar=1[v0]`];
caps.forEach((c, k) => {
  inputs.push('-loop', '1', '-framerate', String(FPS), '-t', (c.b + 0.1).toFixed(3), '-i', c.file);
  const y0 = OH - 56 - c.h;
  graph.push(`[${k + 2}:v]format=rgba,fade=t=in:st=${c.a.toFixed(3)}:d=0.4:alpha=1,fade=t=out:st=${(c.b - 0.4).toFixed(3)}:d=0.4:alpha=1[c${k}]`);
  graph.push(`[v${k}][c${k}]overlay=x=56:y='${y0}+14*pow(1-clip((t-${c.a.toFixed(3)})/0.5,0,1),3)':eval=frame:eof_action=pass:enable='between(t,${c.a.toFixed(3)},${c.b.toFixed(3)})'[v${k + 1}]`);
});
graph.push(`[v${caps.length}]format=yuv420p[v]`);
const graphFile = join(work, 'graph.txt');
writeFileSync(graphFile, graph.join(';\n'));
mkdirSync(resolve(root, 'assets'), { recursive: true });
const master = join(work, 'master.mkv');
console.log('rendering camera and captions');
ff([...inputs, '-/filter_complex', graphFile, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-r', String(FPS), '-c:a', 'pcm_s16le', '-t', total.toFixed(3), master]);
console.log('encoding assets/demo.mp4');
ff(['-i', master, '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);

// Upload copy under 9.5 MB: two-pass at a computed bitrate.
const LIMIT = 9.5e6;
const dur = probe(master);
const audioK = 96;
const tryRes = (h: number, fps: number) => {
  const kbps = Math.floor(((LIMIT * 0.95 * 8) / dur / 1000) - audioK - 4);
  const common = ['-i', master, '-vf', `scale=-2:${h}:flags=lanczos,fps=${fps}`, '-c:v', 'libx264', '-preset', 'veryslow', '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 4}k`, '-pix_fmt', 'yuv420p'];
  const passlog = join(work, 'pass');
  ff([...common, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'mp4', '/dev/null']);
  ff([...common, '-pass', '2', '-passlogfile', passlog, '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', outSmall]);
  return kbps;
};
const smallH = Number(process.env.UPLOAD_HEIGHT ?? 1080);
const kbps = tryRes(smallH, 30);
console.log(`upload copy: ${smallH}p30 at ${kbps} kb/s, ${(statSync(outSmall).size / 1e6).toFixed(2)} MB`);
if (statSync(outSmall).size >= LIMIT) throw new Error('upload copy is over the limit');

/* ---------- 6. stills from zoomed moments, for checking ---------- */
const grabs = join(work, 'grabs');
rmSync(grabs, { recursive: true, force: true });
mkdirSync(grabs, { recursive: true });
for (const w of shown) {
  if (!w.c.label) continue;
  const slug = w.c.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  ff(['-ss', Math.min(w.a + 0.9, w.b - 0.3).toFixed(3), '-i', out, '-frames:v', '1', join(grabs, `${plan[w.scene].s.name}-${slug}.png`)]);
}
console.log(`wrote assets/demo.mp4 ${probe(out).toFixed(1)} s, ${(statSync(out).size / 1e6).toFixed(1)} MB; stills in .cache/video/grabs`);
