#!/usr/bin/env node
/**
 * Functional checks. A still screenshot cannot catch a control bug, a stuck menu, or a crash —
 * this can. Run alongside every visual critic.
 *
 *   node tools/functest.mjs                 # everything
 *   node tools/functest.mjs --quick         # one city, all cars
 *   node tools/functest.mjs --json out.json
 *
 * Exit code 0 = all pass, 1 = any failure.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, load, scenario, telemetry, errors, measureFps, ROOT } from './.harness_nohmr.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };

const CITIES = has('quick') ? ['la'] : ['la', 'vegas', 'miami', 'nyc'];
const CARS = ['tuner', 'muscle', 'suv', 'supercar'];

const results = [];
let failures = 0;

function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  if (!pass) failures++;
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  return pass;
}

async function main() {
  const h = await boot({ width: 1280, height: 720 });
  try {
    console.log('\n── boot ──');
    await open(h.page, h.url, { city: 'la', car: 'muscle' });
    check('game boots without error', true);

    // ---------------------------------------------------------------- cities
    console.log('\n── cities load ──');
    for (const city of CITIES) {
      const t0 = Date.now();
      let ok = true, msg = '';
      try {
        await load(h.page, { city, car: 'muscle' });
        const t = await telemetry(h.page);
        ok = t.city === city;
        msg = `${Date.now() - t0}ms`;
      } catch (e) { ok = false; msg = String(e.message).slice(0, 120); }
      check(`city "${city}" loads`, ok, msg);
    }

    // ---------------------------------------------------------------- per-car controls
    console.log('\n── vehicle controls ──');
    await load(h.page, { city: 'la', car: 'muscle' });
    const perCar = {};
    for (const car of CARS) {
      await load(h.page, { city: 'la', car });

      // throttle
      const accel = await scenario(h.page, 'chase');
      const top = Math.max(...accel.map((t) => t.mph));
      check(`${car}: responds to throttle`, top > 25, `${top.toFixed(0)} mph`);

      // steering both directions
      const steerTest = await h.page.evaluate(() => {
        const G = window.__GAME;
        G.step(120, { throttle: 1 });
        const y0 = G.game.body.yaw;
        G.step(45, { throttle: 1, steer: 1 });
        const y1 = G.game.body.yaw;
        G.step(90, { throttle: 1, steer: -1 });
        const y2 = G.game.body.yaw;
        return { y0, y1, y2 };
      });
      const rightTurn = steerTest.y1 - steerTest.y0;
      const leftTurn = steerTest.y2 - steerTest.y1;
      check(`${car}: steers right`, Math.abs(rightTurn) > 0.05, `Δyaw ${rightTurn.toFixed(3)}`);
      check(`${car}: steers left`, Math.sign(leftTurn) !== Math.sign(rightTurn) && Math.abs(leftTurn) > 0.05, `Δyaw ${leftTurn.toFixed(3)}`);

      // brakes
      const brakeTest = await h.page.evaluate(() => {
        const G = window.__GAME;
        G.step(150, { throttle: 1 });
        const before = G.game.body.speed;
        G.step(60, { brake: 1 });
        return { before, after: G.game.body.speed };
      });
      check(`${car}: brakes`, brakeTest.after < brakeTest.before * 0.75, `${brakeTest.before.toFixed(1)} → ${brakeTest.after.toFixed(1)} m/s`);

      // drift reachable and recoverable
      const drift = await scenario(h.page, 'drift');
      const maxSlip = Math.max(...drift.map((t) => Math.abs(t.slipDeg)));
      const maxDrift = Math.max(...drift.map((t) => t.drift));
      const endSlip = Math.abs(drift[drift.length - 1].slipDeg);
      check(`${car}: can drift`, maxDrift > 0.35 && maxSlip > 8, `slip ${maxSlip.toFixed(1)}° drift ${maxDrift.toFixed(2)}`);
      check(`${car}: recovers from drift (no spin-out)`, maxSlip < 88, `peak slip ${maxSlip.toFixed(1)}°, end ${endSlip.toFixed(1)}°`);

      // nitrous actually fires and adds speed
      const nitro = await h.page.evaluate(() => {
        const G = window.__GAME;
        G.game.nitro.reset();
        G.step(260, { throttle: 1 });
        const base = G.game.body.speed;
        G.step(70, { throttle: 1, nitro: true });
        const t = G.telemetry();
        return { base, boosted: G.game.body.speed, ramp: t.nitro.ramp, charge: t.nitro.charge, active: t.nitro.active };
      });
      check(`${car}: nitrous triggers`, nitro.ramp > 0.5, `ramp ${nitro.ramp.toFixed(2)}`);
      check(`${car}: nitrous adds speed`, nitro.boosted > nitro.base * 1.03, `${nitro.base.toFixed(1)} → ${nitro.boosted.toFixed(1)} m/s`);
      check(`${car}: nitrous drains charge`, nitro.charge < 0.999, `charge ${nitro.charge.toFixed(2)}`);

      perCar[car] = { top, maxSlip, maxDrift, boostGain: nitro.boosted / nitro.base };
    }

    // ---------------------------------------------------------------- classes are distinct
    console.log('\n── class differentiation ──');
    const tops = CARS.map((c) => perCar[c].top);
    const spread = Math.max(...tops) - Math.min(...tops);
    check('top speeds differ across classes', spread > 12, `spread ${spread.toFixed(1)} mph  [${tops.map((t) => t.toFixed(0)).join(', ')}]`);
    const gains = CARS.map((c) => perCar[c].boostGain);
    check('nitrous behaves differently per class', Math.max(...gains) - Math.min(...gains) > 0.02,
      gains.map((g, i) => `${CARS[i]} ×${g.toFixed(3)}`).join('  '));

    // ---------------------------------------------------------------- collisions
    console.log('\n── collision ──');
    await load(h.page, { city: 'nyc', car: 'muscle' });
    await h.page.evaluate(() => { window.__GAME.game.effects.shakePeak = 0; });
    const crash = await scenario(h.page, 'crash');
    const shook = Math.max(...crash.map((t) => t.fx.shakePeak ?? 0));
    check('wall impact produces screen shake', shook > 0.1, `peak shake ${shook.toFixed(2)}`);
    const recovered = await h.page.evaluate(() => {
      const G = window.__GAME;
      G.step(180, { throttle: 1 });
      return G.game.body.speed;
    });
    check('car recovers and drives after a crash', recovered > 8, `${recovered.toFixed(1)} m/s`);

    const inBounds = await h.page.evaluate(() => {
      const G = window.__GAME;
      const t = G.game.city.track;
      const n = t.nearest(G.game.body.pos, null);
      return Math.abs(n.lateral);
    });
    check('car cannot escape the track bounds', inBounds < 2.0, `|lateral| ${inBounds.toFixed(2)}`);

    // ---------------------------------------------------------------- every car in every city
    console.log('\n── car × city matrix ──');
    for (const city of CITIES) {
      for (const car of CARS) {
        let ok = true, msg = '';
        try {
          await load(h.page, { city, car });
          const tr = await scenario(h.page, 'chase');
          const mph = tr[tr.length - 1].mph;
          ok = mph > 20 && Number.isFinite(mph);
          msg = `${mph.toFixed(0)} mph`;
        } catch (e) { ok = false; msg = String(e.message).slice(0, 90); }
        check(`${city} × ${car}`, ok, msg);
      }
    }

    // ---------------------------------------------------------------- menu
    console.log('\n── menu ──');
    const menu = await h.page.evaluate(async () => {
      const G = window.__GAME;
      await G.scenario('menu');
      const opened = G.game.state === 'menu' && G.game.menu.open_;
      const before = G.game.menu.carIndex;
      G.game.menu._move(1);
      const moved = G.game.menu.carIndex !== before;
      G.game.menu._cycleColor();
      G.game.menu._start();
      const started = G.game.state === 'racing';
      return { opened, moved, started };
    });
    check('menu opens', menu.opened);
    check('menu navigates between cars', menu.moved);
    check('menu starts a race (no dead end)', menu.started);

    // ---------------------------------------------------------------- performance
    console.log('\n── performance ──');
    await load(h.page, { city: 'vegas', car: 'supercar' });
    await scenario(h.page, 'chase');
    // Headless Chromium falls back to SwiftShader (CPU rasterisation), which is 30-100x slower
    // than the real GPU — this cannot verify the §3.5 "50 fps at 1600x900" bar. It runs at a small
    // viewport purely as a REGRESSION tracker: a sudden drop here means someone added something
    // pathologically expensive. Real frame rate must be measured on the GPU (pnpm dev).
    await h.page.evaluate(() => window.__GAME.setSize(640, 360));
    const fps = await measureFps(h.page, 40);
    check('software-GL render throughput (regression tracker only)', fps.fps > 1.5,
      `${fps.fps.toFixed(1)} fps @640x360 swiftshader — NOT the real-GPU number`);
    await h.page.evaluate(() => window.__GAME.setSize(1280, 720));

    // ---------------------------------------------------------------- leaks
    console.log('\n── memory ──');
    const leak = await h.page.evaluate(async () => {
      const G = window.__GAME;
      const info = () => G.game.engine.renderer.info.memory;
      await G.load({ city: 'la', car: 'muscle' });
      const a = { ...info() };
      for (const c of ['vegas', 'miami', 'nyc', 'la']) await G.load({ city: c, car: 'muscle' });
      const b = { ...info() };
      return { a, b };
    });
    const growth = leak.b.geometries / Math.max(1, leak.a.geometries);
    check('city swaps do not leak geometry', growth < 2.2,
      `geometries ${leak.a.geometries} → ${leak.b.geometries} (×${growth.toFixed(2)})`);

    // ---------------------------------------------------------------- errors
    console.log('\n── runtime errors ──');
    const errs = await errors(h.page);
    const consoleErrs = h.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    check('no uncaught runtime errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    check('no console errors', consoleErrs.length === 0, consoleErrs.slice(0, 3).join(' | '));

  } finally {
    await h.close();
  }

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${pass}/${results.length} checks passed${failures ? `  — ${failures} FAILURE(S)` : '  — ALL GREEN'}`);
  console.log('='.repeat(60));

  const jsonPath = arg('json');
  if (jsonPath) {
    await fs.writeFile(path.resolve(ROOT, jsonPath), JSON.stringify({ results, failures, pass, total: results.length }, null, 2));
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\nFATAL:', e); process.exit(1); });
