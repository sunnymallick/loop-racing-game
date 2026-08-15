#!/usr/bin/env node
/**
 * INDEPENDENT watertightness probe for the menu hero car.
 * Casts one ray per 2 px from the live menu camera at the hero car's meshes only, and counts
 * MISSES that are enclosed by HITS on both axes — i.e. background visible THROUGH the bodywork.
 * Also reports the luminance distribution over the car's own ray mask from the real framebuffer.
 */
import { boot, open, scenario } from './harness.mjs';

const h = await boot({ gpu: false, width: 1600, height: 900 });
try {
  for (const car of ['tuner', 'muscle', 'suv', 'supercar']) {
    await open(h.page, h.url, { city: 'la', car });
    await scenario(h.page, 'menu');
    await h.page.evaluate(([w, hh]) => window.__GAME.setSize(w, hh), [1600, 900]);
    await h.page.evaluate(() => window.__GAME.render());
    const r = await h.page.evaluate(async () => {
      const src = await (await fetch('/src/main.js')).text();
      const m = src.match(/from\s+"([^"]*three[^"]*)"/) || src.match(/from\s+'([^']*three[^']*)'/);
      const THREE = await import(m[1]);
      const g = window.__GAME.game;
      const cam = g.engine.camera;
      const hero = g.car;
      hero.updateWorldMatrix(true, true);
      const meshes = [];
      hero.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
      const rc = new THREE.Raycaster();
      const W = 1600, H = 900, STEP = 2;
      // screen-space bbox of the car, so we only cast where it can possibly be
      const bb = new THREE.Box3().setFromObject(hero);
      let sx0 = 1e9, sy0 = 1e9, sx1 = -1e9, sy1 = -1e9;
      const pv = new THREE.Vector3();
      for (let k = 0; k < 8; k++) {
        pv.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z);
        pv.project(cam);
        const px2 = (pv.x + 1) / 2 * W, py2 = (1 - pv.y) / 2 * H;
        sx0 = Math.min(sx0, px2); sx1 = Math.max(sx1, px2);
        sy0 = Math.min(sy0, py2); sy1 = Math.max(sy1, py2);
      }
      const I0 = Math.max(0, Math.floor(sx0 / STEP) - 2), I1 = Math.min(Math.floor(W / STEP), Math.ceil(sx1 / STEP) + 2);
      const J0 = Math.max(0, Math.floor(sy0 / STEP) - 2), J1 = Math.min(Math.floor(H / STEP), Math.ceil(sy1 / STEP) + 2);
      const cols = I1 - I0, rows = J1 - J0;
      const hit = new Uint8Array(cols * rows);
      const v2 = new THREE.Vector2();
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          v2.set(((i + I0) * STEP / W) * 2 - 1, -(((j + J0) * STEP / H) * 2 - 1));
          rc.setFromCamera(v2, cam);
          hit[j * cols + i] = rc.intersectObjects(meshes, false).length ? 1 : 0;
        }
      }
      let carPx = 0;
      const rowL = new Int32Array(rows).fill(-1), rowR = new Int32Array(rows).fill(-1);
      const colT = new Int32Array(cols).fill(-1), colB = new Int32Array(cols).fill(-1);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (hit[j * cols + i]) {
        if (rowL[j] < 0) rowL[j] = i; rowR[j] = i;
        if (colT[i] < 0) colT[i] = j; colB[i] = j;
        carPx++;
      }
      const holes = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (hit[j * cols + i]) continue;
        if (i > rowL[j] && i < rowR[j] && j > colT[i] && j < colB[i]) holes.push([i, j]);
      }
      const set = new Set(holes.map(([x, y]) => y * cols + x));
      const seen = new Set(); const clusters = [];
      for (const [x, y] of holes) {
        const k0 = y * cols + x;
        if (seen.has(k0)) continue;
        const stack = [k0]; seen.add(k0);
        let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
        while (stack.length) {
          const k = stack.pop(); n++;
          const cx = k % cols, cy = (k - cx) / cols;
          if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
          if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
          for (const nk of [k + 1, k - 1, k + cols, k - cols]) {
            if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
          }
        }
        clusters.push({ px: n * STEP * STEP, box: [(x0 + I0) * STEP, (y0 + J0) * STEP, (x1 - x0) * STEP, (y1 - y0) * STEP] });
      }
      clusters.sort((a, b) => b.px - a.px);

      const cv = g.engine.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      let n = 0, d8 = 0, d30 = 0, sum = 0;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (!hit[j * cols + i]) continue;
        const o = (((j + J0) * STEP) * W + (i + I0) * STEP) * 4;
        const L = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
        n++; sum += L; if (L < 8) d8++; if (L < 30) d30++;
      }
      return {
        carPx: carPx * STEP * STEP,
        seeThroughPx: holes.length * STEP * STEP,
        pct: +(100 * holes.length / Math.max(1, carPx)).toFixed(2),
        topClusters: clusters.slice(0, 6),
        meanL: +(sum / Math.max(1, n)).toFixed(1),
        pctDark8: +(100 * d8 / Math.max(1, n)).toFixed(2),
        pctDark30: +(100 * d30 / Math.max(1, n)).toFixed(2),
      };
    });
    console.log(car, JSON.stringify(r));
  }
} finally { await h.close(); }
