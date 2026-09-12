#!/usr/bin/env node
/**
 * check-budget.mjs — CI gate on shipped byte size.
 *
 * The whole product promise is "instant, free, works on a phone on a rural connection",
 * and the only way to keep that promise is to fail the build when a change makes the
 * download bigger. A budget that is merely reported is a budget that will be exceeded.
 *
 * Budgets live in site/budget.json (committed) so a change is a visible, reviewable diff
 * rather than a silent number in a log. Run with --update after deliberately resizing.
 *
 * Two things are measured:
 *   app   — the JS/CSS the browser must parse before anything renders
 *   data  — the packed dataset, split because stations.bin is on the critical path to
 *           first paint while graph.bin loads in a worker afterwards
 * gzip sizes are what matter, since Pages serves gzip and that is what the user downloads.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const BUDGET_FILE = join(ROOT, 'budget.json');
const UPDATE = process.argv.includes('--update');

const DEFAULT_BUDGET = {
  'app.js.gzip': 22000,
  'app.css.gzip': 5000,
  'worker.js.gzip': 16000,
  'total.js.gzip': 45000,
  'data/stations.bin.gzip': 122880,   // 120 KB — the first-paint budget from PLAN.md
  'data/graph.bin.gzip': 921600,      // 900 KB
  'total.gzip': 1024000,              // 1 MB everything, first visit
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function gz(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

if (!existsSync(DIST)) {
  console.error(`check-budget: ${DIST} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

const files = walk(DIST).map((p) => ({ abs: p, rel: relative(DIST, p).split('\\').join('/') }));

const measure = {};
const js = files.filter((f) => f.rel.endsWith('.js') && !f.rel.includes('router') && !f.rel.includes('inline'));
const worker = files.filter((f) => f.rel.endsWith('.js') && (f.rel.includes('router') || f.rel.includes('inline')));
const css = files.filter((f) => f.rel.endsWith('.css'));

measure['app.js.gzip'] = js.reduce((n, f) => n + gz(f.abs), 0);
measure['app.css.gzip'] = css.reduce((n, f) => n + gz(f.abs), 0);
measure['worker.js.gzip'] = worker.reduce((n, f) => n + gz(f.abs), 0);
measure['total.js.gzip'] = measure['app.js.gzip'] + measure['worker.js.gzip'];

for (const f of ['data/stations.bin', 'data/graph.bin']) {
  const hit = files.find((x) => x.rel === f);
  if (!hit) {
    console.error(`check-budget: ${f} is missing from dist/. The packed dataset must ship with the site.`);
    process.exit(1);
  }
  measure[`${f}.gzip`] = gz(hit.abs);
}
measure['total.gzip'] = files.reduce((n, f) => n + gz(f.abs), 0);

const budget = existsSync(BUDGET_FILE)
  ? { ...DEFAULT_BUDGET, ...JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) }
  : { ...DEFAULT_BUDGET };

if (UPDATE) {
  writeFileSync(BUDGET_FILE, JSON.stringify(measure, null, 2) + '\n');
  console.log('check-budget: wrote current sizes to budget.json');
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const rows = Object.keys(measure).sort();
const width = Math.max(...rows.map((r) => r.length));
let failures = 0;

console.log('\n' + '='.repeat(76));
console.log('BUNDLE BUDGET');
console.log('='.repeat(76));
for (const key of rows) {
  const actual = measure[key];
  const limit = budget[key];
  if (limit === undefined) { console.log(`  ${key.padEnd(width)}  ${kb(actual).padStart(10)}   (no budget)`); continue; }
  const pct = (actual / limit) * 100;
  const over = actual > limit;
  if (over) failures++;
  console.log(
    `  ${over ? 'OVER' : ' ok '} ${key.padEnd(width)}  ${kb(actual).padStart(10)} / ${kb(limit).padStart(10)}` +
    `  ${pct.toFixed(0).padStart(4)}%  ${over ? `+${kb(actual - limit)}` : `${kb(limit - actual)} spare`}`,
  );
}
console.log('-'.repeat(76));
console.log(`  ${failures === 0 ? 'all sizes within budget' : `${failures} size regression(s)`}` +
  (failures ? '  — raise the budget explicitly with `npm run budget -- --update` and justify it in the PR' : ''));
console.log('='.repeat(76));
process.exit(failures === 0 ? 0 : 1);
