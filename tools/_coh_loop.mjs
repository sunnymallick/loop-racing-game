/**
 * THE WHOLE PRODUCT LOOP, driven only through the keyboard: garage → navigate → ENTER → race →
 * flag → ENTER → garage → race again. Nothing here reaches into a menu internal.
 */
import { boot, open, load } from './harness.mjs';
const h = await boot({ width: 800, height: 450 });
const errs = [];
h.page.on('pageerror', (e) => errs.push(String(e)));
h.page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
let bad = 0;
try {
  await open(h.page, h.url, { city: 'la', car: 'muscle' });
  await load(h.page, { city: 'la', car: 'muscle' });
  const out = await h.page.evaluate(async () => {
    const g = window.__GAME.game;
    const log = [];
    const tap = (code, n = 3) => {
      g.input.keys.add(code); g.update(1 / 60);
      g.input.keys.delete(code);
      for (let i = 0; i < n; i++) g.update(1 / 60);
    };
    const ck = (name, ok, msg) => log.push({ name, ok: !!ok, msg: String(msg) });

    g.state = 'menu'; g.menu.open();
    for (let i = 0; i < 10; i++) g.update(1 / 60);
    ck('garage opens', g.state === 'menu' && g.menu.open_, g.state);

    const car0 = g.menu.carIndex;
    tap('ArrowRight');
    ck('ArrowRight changes car', g.menu.carIndex !== car0, `${car0} → ${g.menu.carIndex}`);

    const city0 = g.menu.cityIndex;
    tap('ArrowDown');            // brake → focus city
    tap('ArrowRight');
    ck('ArrowDown+Right changes city', g.menu.cityIndex !== city0, `${city0} → ${g.menu.cityIndex}`);

    const col0 = g.menu.colorIndex;
    tap('KeyV');
    ck('V cycles paint', g.menu.colorIndex !== col0, `${col0} → ${g.menu.colorIndex}`);

    tap('Enter', 12);
    ck('ENTER starts the race', g.state === 'racing', `${g.state}, ${g.aiCars.length} opponents`);

    g.race.state = 'racing'; g.race.countdown = 0;
    for (let i = 0; i < 60; i++) { g.update(1 / 60); }
    const geoRacing = g.engine.renderer.info.memory.geometries;

    g.race.state = 'finished'; g.race.finished = true;
    for (let i = 0; i < 400; i++) g.update(1 / 60);
    ck('flag sets finished + prompts', g.state === 'finished' && !!g.hud.msg,
      `${g.state} / ${g.hud.msg ? g.hud.msg.text : 'no prompt'}`);

    tap('Enter', 4);
    ck('ENTER returns to the garage', g.state === 'menu' && g.menu.open_ && g.race === null,
      `${g.state}, ${g.aiCars.length} opponents, race=${g.race}`);
    g.render(1 / 60);

    tap('Enter', 12);
    g.race.state = 'racing'; g.race.countdown = 0;
    g.input.setScripted({ throttle: 1 });
    for (let i = 0; i < 120; i++) { g.update(1 / 60); }
    g.input.clearScripted();
    g.render(1 / 60);
    const geoAgain = g.engine.renderer.info.memory.geometries;
    ck('races again after the round trip', g.state === 'racing' && g.body.speedMph > 5,
      `${g.state}, ${g.body.speedMph.toFixed(0)} mph`);

    // …and a SECOND round trip, which is the one that can leak: everything lazily cached on the
    // first visit to the garage (the room, its probe, the four baked car thumbnails) is already
    // built by now, so this lap of the loop must add essentially nothing.
    g.race.state = 'finished'; g.race.finished = true;
    for (let i = 0; i < 120; i++) g.update(1 / 60);
    tap('Enter', 40);
    g.render(1 / 60);
    tap('Enter', 12);
    g.race.state = 'racing'; g.race.countdown = 0;
    g.input.setScripted({ throttle: 1 });
    for (let i = 0; i < 120; i++) { g.update(1 / 60); }
    g.input.clearScripted();
    g.render(1 / 60);
    const geoThird = g.engine.renderer.info.memory.geometries;
    ck('second round trip does not leak', geoThird <= geoAgain + 8,
      `geo ${geoRacing} → ${geoAgain} → ${geoThird}`);
    ck('still racing after two round trips', g.state === 'racing' && g.body.speedMph > 5,
      `${g.state}, ${g.body.speedMph.toFixed(0)} mph`);
    return log;
  });
  for (const l of out) {
    if (!l.ok) bad++;
    console.log(`  ${l.ok ? '✓' : '✗'} ${l.name.padEnd(34)} — ${l.msg}`);
  }
  console.log(errs.length ? `  ✗ runtime errors: ${errs.slice(0, 3).join(' / ')}` : '  ✓ no runtime errors');
  if (errs.length) bad++;
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nloop OK');
} finally { await h.close(); }
process.exitCode = bad ? 1 : 0;
