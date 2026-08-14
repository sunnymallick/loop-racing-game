// Builder-local capture for the Las Vegas piece. Identical to tools/shot.mjs except that the
// boot timeout is generous — seven agents share this machine and a cold page.goto regularly
// takes longer than shot.mjs's 120 s when several headless Chromiums are compiling shaders.
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, scenario, load, ROOT, errors } from './harness.mjs';

// Same as harness.capture() but with a screenshot timeout that survives a machine running seven
// agents' headless Chromiums at once (the shared helper allows 30 s and loses the frame).
async function capture(page, file, { width = 1600, height = 900 } = {}) {
  await page.evaluate(([w, h]) => window.__GAME.setSize(w, h), [width, height]);
  await page.evaluate(() => window.__GAME.render());
  await page.evaluate(() => window.__GAME.render());
  await page.screenshot({ path: file, type: 'png', timeout: 300000 });
  return file;
}

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/vegas'));
const SHOTS = String(arg('shots', 'landmark,chase')).split(',').map((s) => s.trim()).filter(Boolean);
const CARS = String(arg('cars', 'muscle')).split(',');
const U = arg('u', null);
const CITY = String(arg('city', 'vegas'));

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const h = await boot({ width: 1600, height: 900 });
  try {
    await open(h.page, h.url, { city: CITY, car: CARS[0], timeout: 480000 });
    for (const car of CARS) {
      await load(h.page, { city: CITY, car });
      for (const shot of SHOTS) {
        const opts = U != null ? { u: Number(U) } : {};
        const trace = await scenario(h.page, shot, opts);
        const file = path.join(OUT, `${CITY}-${car}-${shot}.png`);
        await capture(h.page, file, { width: 1600, height: 900 });
        const last = trace[trace.length - 1];
        console.log(`  ✓ ${CITY}-${car}-${shot}.png  ${last.mph?.toFixed?.(0) ?? '?'} mph`);
        if (argv.includes('--telemetry')) {
          await fs.writeFile(path.join(OUT, `${CITY}-${car}-${shot}.json`), JSON.stringify(trace));
          console.log('    ', trace.map((t) => `${(t.race?.playerU ?? 0).toFixed(3)}:${(t.mph ?? 0).toFixed(0)}`).join(' '));
          console.log('     pos', trace.map((t) => `${t.x},${t.z}|${t.surface}`).join(' '));
        }
      }
    }
    const errs = await errors(h.page);
    if (errs.length) { console.log('⚠ runtime errors:'); for (const e of errs.slice(0, 10)) console.log('  ', e); }
    const ce = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (ce.length) { console.log('⚠ console:'); for (const e of ce.slice(0, 10)) console.log('  ', e); }
  } finally {
    await h.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
