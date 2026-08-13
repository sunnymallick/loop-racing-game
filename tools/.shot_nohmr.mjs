#!/usr/bin/env node
/**
 * Screenshot harness.
 *
 * ART_DIRECTION.md §5: critics score screenshots from the REAL running build, never a builder's
 * summary or a builder-supplied image. This tool is how they get them.
 *
 *   node tools/shot.mjs --city la --car muscle --shots chase,drift,nitrous --out shots/la-r1
 *   node tools/shot.mjs --all --out shots/wave1              # every city x every car, key shots
 *   node tools/shot.mjs --city vegas --shots landmark --u 0.5 --out shots/x
 *
 * Options:
 *   --city   la|vegas|miami|nyc            (default la)
 *   --car    tuner|muscle|suv|supercar     (default muscle)
 *   --shots  comma list of scenarios       (default chase,drift,nitrous,crash,landmark)
 *   --out    output directory              (default shots/latest)
 *   --width  --height                      (default 1600x900)
 *   --u      track position for the shot   (scenario-dependent)
 *   --all    sweep all cities x all cars
 *   --cities / --cars   comma lists to sweep
 *   --telemetry  also write <name>.json with the trace
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, scenario, load, capture, ROOT, errors } from './.harness_nohmr.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (k) => argv.includes(`--${k}`);

const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const OUT = path.resolve(ROOT, arg('out', 'shots/latest'));
const SHOTS = String(arg('shots', 'chase,drift,nitrous,crash,landmark')).split(',').map((s) => s.trim()).filter(Boolean);
const U = arg('u', null);

const ALL_CITIES = ['la', 'vegas', 'miami', 'nyc'];
const ALL_CARS = ['tuner', 'muscle', 'suv', 'supercar'];

let cities = String(arg('cities', arg('city', 'la'))).split(',');
let cars = String(arg('cars', arg('car', 'muscle'))).split(',');
if (has('all')) { cities = ALL_CITIES; cars = ALL_CARS; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const h = await boot({ width: WIDTH, height: HEIGHT });
  const manifest = [];
  try {
    await open(h.page, h.url, { city: cities[0], car: cars[0] });

    for (const city of cities) {
      for (const car of cars) {
        await load(h.page, { city, car });
        for (const shot of SHOTS) {
          const opts = U != null ? { u: Number(U) } : {};
          const trace = await scenario(h.page, shot, opts);
          const name = `${city}-${car}-${shot}`;
          const file = path.join(OUT, `${name}.png`);
          await capture(h.page, file, { width: WIDTH, height: HEIGHT });
          const last = trace[trace.length - 1];
          manifest.push({ name, file: path.relative(ROOT, file), city, car, shot, telemetry: last });
          if (has('telemetry')) {
            await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify(trace, null, 2));
          }
          console.log(`  ✓ ${name}.png   ${last.mph?.toFixed?.(0) ?? '?'} mph  drift=${last.drift}  boost=${last.nitro?.ramp ?? 0}`);
        }
      }
    }

    const errs = await errors(h.page);
    if (errs.length) {
      console.log(`\n⚠ ${errs.length} runtime error(s):`);
      for (const e of errs.slice(0, 12)) console.log(`   ${e}`);
    }
    const consoleErrs = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (consoleErrs.length) {
      console.log(`\n⚠ ${consoleErrs.length} console error(s):`);
      for (const e of consoleErrs.slice(0, 12)) console.log(`   ${e}`);
    }
    await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({
      created: new Date().toISOString(), width: WIDTH, height: HEIGHT,
      shots: manifest, runtimeErrors: errs, consoleErrors: consoleErrs,
    }, null, 2));
    console.log(`\n${manifest.length} screenshot(s) → ${path.relative(process.cwd(), OUT)}`);
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
