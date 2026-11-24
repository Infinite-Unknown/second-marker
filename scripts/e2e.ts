/**
 * End-to-end check of the built site, the way a judge would use it.
 * Builds are served from a sub-path (like GitHub Pages), the sample class is run,
 * a decision is made with the keyboard, every tab is opened, the report is downloaded,
 * then the analysis is repeated offline from cached models.
 *
 *   npm run build && npm run e2e            (add --shots to save screenshots to assets/)
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { evaluate } from '../src/core/evaluate';
import type { Analysis } from '../src/core/types';

const root = resolve(import.meta.dirname, '..');
const shots = process.argv.includes('--shots');
const port = 4317;
const base = `http://localhost:${port}/second-marker/`;
const out = resolve(root, 'assets');
mkdirSync(out, { recursive: true });

// A plain static server with no special headers, like GitHub Pages, serving dist/ under a sub-path.
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.csv': 'text/csv', '.woff2': 'font/woff2', '.json': 'application/json',
};
const dist = resolve(root, 'dist');
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith('/second-marker/')) return void res.writeHead(404).end();
  let file = join(dist, decodeURIComponent(url.pathname.slice('/second-marker/'.length)) || 'index.html');
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(port, r));

const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, info?: string) => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
};

// Mock keychain flags: never touch the macOS keychain from automation.
const browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (name: string, full = false) => shots && page.screenshot({ path: resolve(out, name), fullPage: full });

try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Same answer. Different mark.' }).waitFor();
  // The service worker reloads the page once to turn on cross-origin isolation (threads).
  await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('heading', { name: 'Same answer. Different mark.' }).waitFor();
  check('cross-origin isolation on a header-less static host', await page.evaluate(() => self.crossOriginIsolated));
  await page.waitForTimeout(600);
  await shot('01-load.png');
  check('landing page renders from a sub-path', true);

  await page.getByRole('button', { name: /Try the sample class/ }).click();
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  const mapped = await page.$$eval('select[data-field]', (s) => s.map((x) => (x as HTMLSelectElement).value));
  check('all six columns guessed from the header', mapped.every((v) => v !== '-1'), mapped.join(','));
  await page.waitForTimeout(400);
  await shot('02-columns.png');

  const t0 = Date.now();
  await page.getByRole('button', { name: /Compare answers/ }).click();
  await page.getByRole('heading', { name: /Reading 66 answers/ }).waitFor();
  // Catch the reading screen mid-way for a screenshot.
  await page.waitForFunction(() => document.querySelectorAll('.scan-line.is-read').length > 10 || !!document.querySelector('.finding'), null, { timeout: 600000 }).catch(() => {});
  if (await page.$('.scan-sheet')) await shot('03-reading.png');
  await page.locator('.finding h1').waitFor({ timeout: 600000 });
  const firstRunS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('      ' + (await page.locator('#findingmeta').innerText()));
  const headline = (await page.locator('.finding h1').innerText()).replace(/\s+/g, ' ');
  check('analysis finishes and reports cases', /\d+ cases? where students/.test(headline), `${headline} (${firstRunS}s incl. first model download)`);
  await page.waitForTimeout(2300); // let the arrival animation settle
  await shot('04-case.png');

  // Score the in-browser run against the sample's planted mis-marks (same truth file as npm run eval).
  const truth = JSON.parse(readFileSync(resolve(root, 'eval/sample-truth.json'), 'utf8'));
  const browserAnalysis = (await page.evaluate(() => (window as unknown as { __secondMarker: () => { analysis: unknown } }).__secondMarker().analysis)) as Analysis;
  const score = evaluate(browserAnalysis, truth);
  if (process.argv.includes('--dump')) {
    mkdirSync(resolve(root, '.cache'), { recursive: true });
    writeFileSync(resolve(root, '.cache/browser-analysis.json'), JSON.stringify(browserAnalysis));
  }
  check('in-browser run finds the planted mis-marks', score.recall >= 0.8,
    `recall ${score.foundPlanted}/${score.planted}, precision ${score.truePairs}/${score.flaggedPairs}, traps rejected ${score.trapsRejected}/${score.traps}`);
  const firstCase = await page.locator('.case-question').innerText();
  const marks = await page.$$eval('.scale', (s) => s.map((x) => x.getAttribute('aria-label')));
  check('first case shows a question and two marks', !!firstCase && marks.length === 2, `${firstCase} | ${marks.join(' vs ')}`);
  const shared = await page.locator('.answer .w.same').count();
  const diff = await page.locator('.answer .w.diff').count();
  check('shared and differing words are marked', shared > 0, `${shared} shared, ${diff} differing`);

  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  check('R records "Needs re-mark" on the timing track', (await page.locator('.tick.is-remark').count()) === 1);
  await page.waitForTimeout(400);
  await page.keyboard.press('a');
  await page.waitForTimeout(200);
  check('A records "Marks stand" and asks for a reason', (await page.locator('#reason').count()) === 1);
  await page.locator('#reason').fill('Higher answer named both operations; rubric gives credit for that.');
  await page.locator('#reason').press('Enter');
  await page.waitForTimeout(500);
  await shot('05-decisions.png');

  // Sensitivity: a stricter similarity threshold should not increase the number of cases.
  const before = Number((headline.match(/(\d+) cases?/) ?? [])[1]);
  await page.getByRole('button', { name: /Sensitivity/ }).click();
  const slider = page.locator('input[data-set="minSimilarity"]');
  const initial = await slider.inputValue();
  await slider.fill('0.85');
  await page.waitForFunction((b) => {
    const m = document.querySelector('.finding h1')?.textContent?.match(/(\d+) cases?/);
    return !m || Number(m[1]) !== b;
  }, before, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);
  const strictHead = (await page.locator('.finding h1').innerText()).replace(/\s+/g, ' ');
  const after = Number((strictHead.match(/(\d+) cases?/) ?? [0, 0])[1]);
  check('sensitivity slider re-judges cases live', after <= before, `${before} cases at ${initial}, ${after} at 0.85`);
  check('sensitivity panel stays open while results update', await page.locator('#tunepanel').isVisible());
  await slider.fill(initial);
  await page.waitForFunction((b) => document.querySelector('.finding h1')?.textContent?.includes(`${b} case`), before, { timeout: 60000 });
  await page.getByRole('button', { name: /Sensitivity/ }).click();

  await page.getByRole('tab', { name: /Set aside/ }).click();
  const asideCount = await page.locator('.aside-item').count();
  check('look-alikes are listed with a reason', asideCount > 0, `${asideCount} look-alike pairs`);
  await shot('06-set-aside.png');

  await page.getByRole('tab', { name: /By question/ }).click();
  check('per-question table has a row per question', (await page.locator('.qtable tbody tr').count()) === 4);
  await shot('07-by-question.png');

  await page.getByRole('tab', { name: /Report/ }).click();
  await shot('08-report.png', true);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download report CSV/ }).click()]);
  const csvPath = resolve(out, '.report-check.csv');
  await download.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf8');
  check('report CSV uses anonymous codes, not student ids', /S-\d\d/.test(csv) && !/S10\d\d/.test(csv), csv.split('\r\n')[1]);
  check('decisions survive a sensitivity change and reach the report CSV', csv.includes('Needs re-mark') && csv.includes('Marks stand') && csv.includes('rubric gives credit'));

  // Mobile layout of a case.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('tab', { name: /Cases/ }).click();
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal scroll at 375 px', overflow <= 0, `overflow ${overflow}px`);
  await shot('09-mobile-case.png', true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Second run, offline: the page is loaded, then the network is cut before comparing.
  await page.goto(base);
  await page.getByRole('button', { name: /Try the sample class/ }).click();
  await page.getByRole('heading', { name: 'Match the columns' }).waitFor();
  await context.setOffline(true);
  const t1 = Date.now();
  await page.getByRole('button', { name: /Compare answers/ }).click();
  await page.locator('.finding h1').waitFor({ timeout: 120000 });
  const offlineHead = (await page.locator('.finding h1').innerText()).replace(/\s+/g, ' ');
  check('runs offline from cached models', offlineHead === headline, `${offlineHead} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  await page.waitForTimeout(2300);
  await context.setOffline(false);
  await page.getByRole('tab', { name: /Cases/ }).click();

  // Score the in-browser pipeline on every labelled file, loaded through the file picker like a user would.
  for (const tf of ['eval/sample-truth.json', 'eval/heldout-truth.json', 'eval/heldout2-truth.json']) {
    const t = JSON.parse(readFileSync(resolve(root, tf), 'utf8'));
    await page.goto(base);
    await page.locator('#file').setInputFiles(resolve(root, t.file));
    await page.getByRole('button', { name: /Compare answers/ }).click();
    await page.locator('.finding h1').waitFor({ timeout: 300000 });
    const an = (await page.evaluate(() => (window as unknown as { __secondMarker: () => { analysis: unknown } }).__secondMarker().analysis)) as Analysis;
    const sc = evaluate(an, t);
    console.log(`SCORE ${t.file}: recall ${sc.foundPlanted}/${sc.planted}, precision ${sc.truePairs}/${sc.flaggedPairs}, traps rejected ${sc.trapsRejected}/${sc.traps}, cases ${an.cases.length}`);
  }

  const real = errors.filter((e) => !/favicon/i.test(e));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  check('unexpected failure', false, String(e));
  await page.screenshot({ path: resolve(out, '.e2e-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
