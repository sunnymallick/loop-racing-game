#!/usr/bin/env node
/**
 * Zoomed crop of a capture. §7's defects — geometry seams, z-fighting, open backfaces, repeated
 * props — are invisible at 1:1 and obvious at 8x, and several rounds of this project were scored
 * wrongly because they were judged from full frames or contact sheets.
 *
 *   node tools/crop.mjs shots/x/la-tuner-menu.png --rect 480,380,340,200 --scale 6 --out crop.png
 *   node tools/crop.mjs a.png b.png --rect 500,400,300,180 --scale 6 --out cmp.png   (stacked)
 *
 * Nearest-neighbour by default so you see actual pixels rather than an interpolation of them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };
const files = argv.filter((a) => !a.startsWith('--') && /\.png$/i.test(a));
const prev = (i) => argv[i - 1];
const inputs = files.filter((f, i) => prev(argv.indexOf(f)) !== '--out');

const [rx, ry, rw, rh] = String(arg('rect', '0,0,400,300')).split(',').map(Number);
const SCALE = Number(arg('scale', 6));
const SMOOTH = argv.includes('--smooth');
const OUT = path.resolve(ROOT, arg('out', 'shots/crop.png'));

async function main() {
  if (!inputs.length) { console.error('need at least one .png'); process.exit(1); }
  const cells = await Promise.all(inputs.map(async (f) => {
    const abs = path.resolve(ROOT, f);
    const b64 = (await fs.readFile(abs)).toString('base64');
    return { label: path.basename(f), src: `data:image/png;base64,${b64}` };
  }));

  const W = rw * SCALE, H = rh * SCALE;
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0b0d12;width:${W}px}
    .cell{position:relative;width:${W}px;height:${H + 22}px;border-bottom:1px solid #1c2130}
    .win{width:${W}px;height:${H}px;overflow:hidden;position:relative}
    img{position:absolute;left:${-rx * SCALE}px;top:${-ry * SCALE}px;
        transform-origin:0 0;transform:scale(${SCALE});
        image-rendering:${SMOOTH ? 'auto' : 'pixelated'}}
    .lab{height:22px;line-height:22px;padding:0 8px;background:#11151d;color:#8fa6bd;
         font:12px ui-monospace,monospace}
  </style><body>${cells.map((c) => `
    <div class="cell"><div class="win"><img src="${c.src}"></div>
    <div class="lab">${c.label} — rect ${rx},${ry} ${rw}x${rh} @${SCALE}x</div></div>`).join('')}</body>`;

  const tmp = path.join(path.dirname(OUT), '.crop.html');
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(tmp, html);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: Math.min((H + 23) * cells.length, 30000) }, deviceScaleFactor: 1 });
  await page.goto(`file://${tmp}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  await fs.unlink(tmp).catch(() => {});
  console.log(`${cells.length} crop(s) @${SCALE}x → ${path.relative(process.cwd(), OUT)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
