import { boot, open, load, scenario } from './harness.mjs';

const W = 1600, H = 900, N = 90;
const h = await boot({ gpu: true, width: W, height: H });
try {
  await open(h.page, h.url, { city: 'la', car: 'supercar' });
  for (const city of ['la', 'vegas']) {
    await load(h.page, { city, car: 'supercar' });
    await scenario(h.page, 'chase');
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [W, H]);
    const r = await h.page.evaluate(async (n) => {
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const g = window.__GAME.game;
      const out = {};
      async function loop(label, fn) {
        const t = []; let last = performance.now();
        for (let i = 0; i < n; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          const now = performance.now();
          if (i > 15) t.push(now - last);
          last = now; fn();
        }
        out[label] = { ms: +mean(t).toFixed(2), fps: +(1000 / mean(t)).toFixed(1) };
      }
      const hud = g.hud;
      out.hudInfo = {
        scale: hud.scale, dpr: hud.dpr,
        visible: [hud.canvas.width, hud.canvas.height],
        buf: hud.buf ? [hud.buf.width, hud.buf.height] : null,
        bufMPx: hud.buf ? +((hud.buf.width * hud.buf.height) / 1e6).toFixed(2) : 0,
      };
      g.input.setScripted({ throttle: 1, steer: 0.06, nitro: true });

      await loop('full_game_frame', () => { g.update(1 / 60); g.render(1 / 60); });
      await loop('engine_only_no_hud', () => { g.update(1 / 60); g.engine.render(1 / 60); });

      // HUD without the supersample buffer (draw straight to the visible canvas)
      const savedBuf = hud.buf, savedBctx = hud.bctx;
      hud.buf = null; hud.bctx = null;
      await loop('hud_no_supersample', () => { g.update(1 / 60); g.render(1 / 60); });
      hud.buf = savedBuf; hud.bctx = savedBctx;

      // only the supersampled composite, no HUD vector drawing
      const savedDraw = hud.draw;
      hud.draw = function (s, dt) {
        if (this.bctx) {
          const out2 = this.ctx;
          out2.setTransform(1, 0, 0, 1, 0, 0);
          out2.clearRect(0, 0, this.canvas.width, this.canvas.height);
          out2.imageSmoothingEnabled = true; out2.imageSmoothingQuality = 'high';
          out2.drawImage(this.buf, 0, 0, this.buf.width, this.buf.height, 0, 0, this.canvas.width, this.canvas.height);
        }
      };
      await loop('hud_composite_only', () => { g.update(1 / 60); g.render(1 / 60); });
      hud.draw = savedDraw;

      await loop('back_to_full', () => { g.update(1 / 60); g.render(1 / 60); });
      g.input.clearScripted();
      return out;
    }, N);
    console.log(city, JSON.stringify(r, null, 1));
  }
} finally { await h.close(); }
