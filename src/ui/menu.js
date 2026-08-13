import * as THREE from 'three';
import { drawText, measure, gradientFill } from '../core/font.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';
import { VEHICLE_IDS, getVehicle } from '../vehicles/index.js';
import { CITY_IDS, getCity } from '../cities/index.js';
import { recolor } from '../vehicles/assemble.js';

/**
 * Garage / car select. ART_DIRECTION.md §6.8, target 80.
 *
 * Reference layout (f&f4): a staged hero car under dedicated lighting, a radial fan of angled
 * parallelogram tiles around it, three gradient stat bars bottom-left, the car's full name set
 * large in beveled metallic italic caps, and a control hint bar along the bottom.
 */

const ORANGE = '#ff9214';
const CYAN = '#39d7f2';
const GOLD = '#ffc93a';

function plate(ctx, x, y, w, h, skew = 0.16) {
  const s = h * skew;
  ctx.beginPath();
  ctx.moveTo(x + s, y); ctx.lineTo(x + w + s, y);
  ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
  ctx.closePath();
}

export class Menu {
  constructor(game) {
    this.game = game;
    this.ctx = document.getElementById('ui').getContext('2d');
    this.carIndex = 0;
    this.colorIndex = 0;
    this.cityIndex = 0;
    this.focus = 'car';        // car | city
    this.t = 0;
    this.orbit = 0;
    this.open_ = false;
    this.stage = null;
  }

  open() {
    this.open_ = true;
    this.carIndex = Math.max(0, VEHICLE_IDS.indexOf(this.game.carId));
    this.cityIndex = Math.max(0, CITY_IDS.indexOf(this.game.cityId));
    this._stageCar();
  }

  close() { this.open_ = false; }

  _stageCar() {
    const g = this.game;
    // park the hero car on the start line and orbit it
    const s = g.city.track.at(g.city.spawn.u);
    g.body.reset(s.pos.clone(), Math.atan2(s.tan.x, s.tan.z));
  }

  update(dt, input) {
    this.t += dt;
    this.orbit += dt * 0.32;
    const g = this.game;

    // hold the car still and light it
    g.body.vel.set(0, 0, 0);
    g.body.speed = 0;
    if (g.car) {
      g.car.position.copy(g.body.pos);
      g.car.rotation.y = g.body.yaw;
      g.car.userData.wheels.forEach((w) => { w.rotation.y = 0; });
    }

    // orbit camera around the car
    const r = 8.2, h = 2.5;
    const a = this.orbit;
    const cam = g.engine.camera;
    const target = g.body.pos.clone().setY(0.9);
    cam.position.set(
      target.x + Math.cos(a) * r,
      target.y + h + Math.sin(this.t * 0.4) * 0.4,
      target.z + Math.sin(a) * r,
    );
    cam.lookAt(target);
    cam.fov = 40;
    cam.updateProjectionMatrix();
    g.engine.grade.uniforms.uBoost.value = 0;
    g.engine.speed.uniforms.uAmount.value = 0;
    g.engine.speed.uniforms.uLines.value = 0;
    g.effects.update(dt);

    // ---- input ----
    if (input.pressed('left')) this._move(-1);
    if (input.pressed('right')) this._move(1);
    if (input.pressed('throttle')) { this.focus = 'car'; g.audio.ui('move'); }
    if (input.pressed('brake')) { this.focus = 'city'; g.audio.ui('move'); }
    if (input.pressed('camera')) this._cycleColor();
    if (input.pressed('confirm')) this._start();
  }

  _move(d) {
    const g = this.game;
    g.audio.init(); g.audio.ui('move');
    if (this.focus === 'car') {
      this.carIndex = (this.carIndex + d + VEHICLE_IDS.length) % VEHICLE_IDS.length;
      this.colorIndex = 0;
      g.setCar(VEHICLE_IDS[this.carIndex]);
      this._stageCar();
    } else {
      this.cityIndex = (this.cityIndex + d + CITY_IDS.length) % CITY_IDS.length;
      g.setCity(CITY_IDS[this.cityIndex]).then(() => this._stageCar());
    }
  }

  _cycleColor() {
    const g = this.game;
    const spec = getVehicle(VEHICLE_IDS[this.carIndex]).spec;
    this.colorIndex = (this.colorIndex + 1) % spec.colors.length;
    recolor(g.car, spec.colors[this.colorIndex]);
    g.audio.ui('move');
  }

  _start() {
    const g = this.game;
    g.audio.init(); g.audio.ui('confirm');
    this.close();
    g.startRace();
  }

  draw(dt) {
    const ctx = this.ctx;
    const hud = this.game.hud;
    const dpr = hud.dpr;
    const W = window.innerWidth, H = window.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const k = Math.min(W / 1600, H / 900);
    ctx.save(); ctx.scale(k, k);
    const VW = W / k, VH = H / k;

    const spec = getVehicle(VEHICLE_IDS[this.carIndex]).spec;

    // ---- vignette frame so the 3D car reads as "staged" ----
    const vg = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.3, VW / 2, VH / 2, VH * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,4,10,0.72)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, VW, VH);

    // ---- title ----
    drawText(ctx, 'NITRO CIRCUIT', {
      x: VW / 2, y: 74, size: 54, weight: 0.20, italic: 0.24, align: 'center',
      color: gradientFill([[0, '#ffffff'], [0.5, '#ffd8a0'], [1, ORANGE]]),
      bevel: true, tracking: 0.14, glow: { color: ORANGE, blur: 26 },
    });

    // ---- car tiles fanned across the top ----
    const n = VEHICLE_IDS.length;
    const tw = 150, th = 92;
    for (let i = 0; i < n; i++) {
      const sel = i === this.carIndex && this.focus === 'car';
      const cx = VW / 2 + (i - (n - 1) / 2) * (tw + 22);
      const y = 118 + (sel ? -8 : 0);
      const s2 = getVehicle(VEHICLE_IDS[i]).spec;
      plate(ctx, cx - tw / 2, y, tw, th, 0.16);
      ctx.fillStyle = sel ? 'rgba(30,22,10,0.92)' : 'rgba(8,10,16,0.80)';
      ctx.fill();
      ctx.strokeStyle = sel ? GOLD : 'rgba(150,170,190,0.30)';
      ctx.lineWidth = sel ? 3 : 1.4;
      if (sel) { ctx.shadowBlur = 22; ctx.shadowColor = GOLD; }
      ctx.stroke(); ctx.shadowBlur = 0;
      // colour swatch bar
      plate(ctx, cx - tw / 2 + 10, y + th - 16, tw - 20, 7, 0.16);
      ctx.fillStyle = s2.colors[0]; ctx.fill();
      drawText(ctx, s2.name, {
        x: cx, y: y + 40, size: 24, weight: 0.19, italic: 0.20, align: 'center',
        color: sel ? '#fff4dc' : '#c8d4e2',
      });
      drawText(ctx, s2.klass, {
        x: cx, y: y + 62, size: 13, weight: 0.16, italic: 0.20, align: 'center',
        color: sel ? GOLD : 'rgba(160,180,200,0.8)', tracking: 0.18,
      });
    }

    // ---- big car name ----
    drawText(ctx, spec.full, {
      x: VW / 2, y: VH - 132, size: 48, weight: 0.20, italic: 0.24, align: 'center',
      color: gradientFill([[0, '#ffffff'], [0.45, '#dfe8f2'], [0.55, '#93a4b8'], [1, '#e8eef6']]),
      bevel: true, tracking: 0.10,
    });

    // ---- stat bars ----
    const stats = [['SPEED', spec.stats.speed, '#ff3a6a'], ['TRACTION', spec.stats.traction, '#c445ff'], ['ACCELERATION', spec.stats.accel, '#2fb6ff']];
    stats.forEach(([label, v, col], i) => {
      const x = 40, y = VH - 190 + i * 34;
      drawText(ctx, label, { x, y: y + 13, size: 14, weight: 0.17, italic: 0.18, color: '#dbe6f2', tracking: 0.12 });
      const bx = x + 132, bw = 210, bh = 12;
      plate(ctx, bx, y + 2, bw, bh, 0.30);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
      plate(ctx, bx, y + 2, bw * clamp(v, 0, 1), bh, 0.30);
      const g2 = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g2.addColorStop(0, col); g2.addColorStop(1, '#ffffff');
      ctx.fillStyle = g2; ctx.shadowBlur = 10; ctx.shadowColor = col; ctx.fill(); ctx.shadowBlur = 0;
    });

    // ---- city list ----
    const cityFocus = this.focus === 'city';
    const cw = 236;
    plate(ctx, VW - cw - 30, 200, cw, 32 + CITY_IDS.length * 34, 0.10);
    ctx.fillStyle = 'rgba(6,9,15,0.80)'; ctx.fill();
    ctx.strokeStyle = cityFocus ? CYAN : 'rgba(120,150,180,0.3)';
    ctx.lineWidth = cityFocus ? 2.4 : 1.3; ctx.stroke();
    drawText(ctx, 'DESTINATION', {
      x: VW - cw - 12, y: 226, size: 16, weight: 0.17, italic: 0.16, color: cityFocus ? CYAN : '#9fb4c8', tracking: 0.16,
    });
    CITY_IDS.forEach((id, i) => {
      const sel = i === this.cityIndex;
      const def = getCity(id).def;
      const y = 258 + i * 34;
      if (sel) {
        plate(ctx, VW - cw - 22, y - 20, cw - 16, 28, 0.10);
        ctx.fillStyle = cityFocus ? 'rgba(57,215,242,0.20)' : 'rgba(255,255,255,0.07)'; ctx.fill();
      }
      drawText(ctx, def.name, {
        x: VW - cw - 12, y, size: 19, weight: 0.17, italic: 0.16,
        color: sel ? (cityFocus ? CYAN : '#ffffff') : '#a8bccc',
      });
    });

    // ---- control hints ----
    plate(ctx, 0, VH - 52, VW, 52, 0);
    ctx.fillStyle = 'rgba(4,6,12,0.86)'; ctx.fill();
    const hints = [['◄ ►', 'SELECT'], ['W / S', 'CAR / CITY'], ['V', 'COLOUR'], ['ENTER', 'RACE']];
    let hx = 44;
    for (const [key, label] of hints) {
      drawText(ctx, key, { x: hx, y: VH - 20, size: 17, weight: 0.19, italic: 0.20, color: GOLD });
      const kw = measure(key, { size: 17 }).width;
      drawText(ctx, label, { x: hx + kw + 12, y: VH - 20, size: 15, weight: 0.16, italic: 0.20, color: '#c4d2e0', tracking: 0.12 });
      hx += kw + measure(label, { size: 15, tracking: 0.12 }).width + 52;
    }

    ctx.restore();
    void dt; void smoothstep; void lerp; void THREE;
  }
}
