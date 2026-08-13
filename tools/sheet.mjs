#!/usr/bin/env node
/**
 * Contact sheet. Composites a directory of captures into one labelled grid PNG.
 *
 * Coherence is the one thing you cannot judge one screenshot at a time — "do these four cities feel
 * like one game?" and "is the grade consistent?" are questions about the SET. This makes the set
 * viewable in a single look.
 *
 *   node tools/sheet.mjs shots/wave2 --out shots/wave2/sheet.png
 *   node tools/sheet.mjs shots/wave2 --cols 4 --cell 520
 *
 * Rendered in a headless browser (no native image library needed), so it inherits the same
 * dependency set as the rest of the harness.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const dir = path.resolve(ROOT, argv.find((a) => !a.startsWith('--')) || 'shots/latest');
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const COLS = Number(arg('cols', 4));
const CELL = Number(arg('cell', 520));
const OUT = path.resolve(ROOT, arg('out', path.join(dir, 'sheet.png')));

async function main() {
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.png') && !f.startsWith('sheet'))
    .sort();
  if (!files.length) { console.error(`No PNGs in ${dir}`); process.exit(1); }

  const cellH = Math.round(CELL * 9 / 16);
  const rows = Math.ceil(files.length / COLS);
  const W = COLS * CELL;
  const H = rows * (cellH + 26);

  const cells = files.map((f) => `
    <figure>
      <img src="${path.join(dir, f).replace(/'/g, '%27')}">
      <figcaption>${f.replace(/\.png$/, '')}</figcaption>
    </figure>`).join('');

  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0b0d12;display:grid;grid-template-columns:repeat(${COLS},${CELL}px);width:${W}px}
    figure{position:relative;border:1px solid #1c2130}
    img{display:block;width:${CELL}px;height:${cellH}px;object-fit:cover}
    figcaption{height:26px;line-height:26px;padding:0 8px;background:#11151d;color:#8fa6bd;
      font:12px ui-monospace,monospace;white-space:nowrap;overflow:hidden}
  </style><body>${cells}</body>`;

  const tmp = path.join(dir, '.sheet.html');
  await fs.writeFile(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: Math.min(H, 30000) }, deviceScaleFactor: 1 });
  await page.goto(`file://${tmp}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  await fs.unlink(tmp).catch(() => {});
  console.log(`${files.length} shots → ${path.relative(process.cwd(), OUT)}  (${W}x${H})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
