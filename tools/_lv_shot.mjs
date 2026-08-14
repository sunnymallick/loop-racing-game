// Builder tool (not shipped): tools/shot.mjs with a longer boot timeout, because ten agents
// capturing at once puts this machine past the 120 s default in harness.open().
//   node tools/_lv_shot.mjs --city vegas --cars muscle,supercar --shots chase,landmark --out shots/x
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, scenario, load, capture, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const OUT = path.resolve(ROOT, arg('out', 'shots/latest'));
const SHOTS = String(arg('shots', 'chase,landmark')).split(',').map((s) => s.trim()).filter(Boolean);
const cities = String(arg('cities', arg('city', 'vegas'))).split(',');
const cars = String(arg('cars', arg('car', 'muscle'))).split(',');
const TIMEOUT = Number(arg('timeout', 600000));

await fs.mkdir(OUT, { recursive: true });
const h = await boot({ width: WIDTH, height: HEIGHT });
try {
  await open(h.page, h.url, { city: cities[0], car: cars[0], timeout: TIMEOUT });
  for (const city of cities) {
    for (const car of cars) {
      await load(h.page, { city, car });
      for (const shot of SHOTS) {
        await scenario(h.page, shot, {});
        await capture(h.page, path.join(OUT, `${city}-${car}-${shot}.png`), { width: WIDTH, height: HEIGHT });
        console.log(`  ok ${city}-${car}-${shot}.png`);
      }
    }
  }
  const errs = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errs.length) { console.log('CONSOLE ERRORS:'); for (const e of errs.slice(0, 10)) console.log('  ' + e); }
} finally {
  await h.close();
}
