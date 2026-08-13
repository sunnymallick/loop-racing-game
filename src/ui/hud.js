import { drawText, drawSevenSeg, measure, gradientFill } from '../core/font.js';
import { clamp, lerp, smoothstep } from '../core/rng.js';

/**
 * HUD — drawn to a 2D overlay canvas. ART_DIRECTION.md §6.7, target 85.
 *
 * Layout follows the reference exactly: angled parallelogram plates, heavy italic caps, a cyan
 * lap timer, a red seven-segment countdown centre-top, a named-location banner top-right, an
 * 8-entry leaderboard top-left, and a large circular speedometer bottom-right with a nitro badge.
 *
 * Hard caps to respect: a system font is a project-level fail; unstyled rectangles cap at 50;
 * a HUD with no animated state caps at 65; aliased edges cap at 68 (so everything is drawn at
 * devicePixelRatio and stroked with round joins).
 */

const CYAN = '#39d7f2';
const ORANGE = '#ff9214';
const RED = '#ff2e2e';
const INK = 'rgba(6,8,14,0.82)';

/** Angled parallelogram plate — the signature HUD shape of the reference. */
function plate(ctx, x, y, w, h, skew = 0.18, r = 3) {
  const s = h * skew;
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.lineTo(x + w + s, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  void r;
}

function fillPlate(ctx, x, y, w, h, {
  fill = INK, edge = null, edgeW = 2, skew = 0.18, accent = null, accentW = 6,
} = {}) {
  plate(ctx, x, y, w, h, skew);
  ctx.fillStyle = fill; ctx.fill();
  if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = edgeW; ctx.stroke(); }
  if (accent) {
    plate(ctx, x, y, accentW, h, skew);
    ctx.fillStyle = accent; ctx.fill();
  }
}

export class HUD {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0;
    this.needle = 0;
    this.posFlash = 0;
    this.lastPos = 1;
    this.lapFlash = 0;
    this.boostPulse = 0;
    this.messages = [];
    this.t = 0;
    this.resize();
  }

  resize(w, h) {
    const W = w || window.innerWidth, H = h || window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(W * this.dpr);
    this.canvas.height = Math.floor(H * this.dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.w = W; this.h = H;
  }

  message(text, dur = 2.2, color = ORANGE) { this.messages.push({ text, t: 0, dur, color }); }

  /**
   * @param s {
   *   position, totalRacers, raceTime, lapTime, lap, laps, standings:[{name,you}],
   *   mph, rpm, redline, gear, nitroCharge, nitroTanks, nitroActive, drift, driftScore,
   *   cityName, record, countdown, boostStrength, state
   * }
   */
  draw(s, dt) {
    const ctx = this.ctx;
    this.t += dt;
    const W = this.w, H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // scale the whole HUD against a 1600x900 design so layout holds at any resolution
    const k = Math.min(W / 1600, H / 900);
    ctx.save();
    ctx.scale(k, k);
    const VW = W / k, VH = H / k;

    if (s.position !== this.lastPos) { this.posFlash = 1; this.lastPos = s.position; }
    this.posFlash = Math.max(0, this.posFlash - dt * 1.6);
    this.boostPulse = s.nitroActive ? Math.min(1, this.boostPulse + dt * 6) : Math.max(0, this.boostPulse - dt * 3);

    this._drawPosition(ctx, s, 26, 22);
    this._drawTimer(ctx, s, 26, 96);
    this._drawStandings(ctx, s, 26, 142);
    this._drawCityBanner(ctx, s, VW - 26, 22);
    if (s.countdown != null) this._drawCountdown(ctx, s, VW / 2, 30);
    this._drawSpeedo(ctx, s, VW - 172, VH - 168, 132);
    this._drawNitro(ctx, s, VW - 172, VH - 26);
    this._drawDrift(ctx, s, VW / 2, VH - 150);
    this._drawMessages(ctx, VW / 2, VH * 0.34, dt);
    if (s.state === 'countdown' && s.countdown != null) this._drawStartLights(ctx, VW / 2, VH * 0.28, s.countdown);

    ctx.restore();
  }

  // ---------------------------------------------------------------- pieces

  _drawPosition(ctx, s, x, y) {
    const w = 176, h = 62;
    const pop = 1 + this.posFlash * 0.10;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    fillPlate(ctx, 0, 0, w, h, { fill: 'rgba(8,10,16,0.86)', accent: ORANGE, accentW: 9, edge: 'rgba(255,255,255,0.14)' });
    const ord = ordinal(s.position || 1);
    const num = ord.slice(0, -2), suf = ord.slice(-2);
    drawText(ctx, num, {
      x: 34, y: h - 13, size: 46, weight: 0.20, italic: 0.24, align: 'left',
      color: gradientFill([[0, '#ffffff'], [0.55, '#e9eef5'], [1, '#9fb0c4']]),
      bevel: true, glow: this.posFlash > 0.02 ? { color: ORANGE, blur: 22 * this.posFlash } : null,
    });
    const nw = measure(num, { size: 46 }).width;
    drawText(ctx, suf, { x: 40 + nw, y: h - 26, size: 22, weight: 0.20, italic: 0.24, color: ORANGE });
    drawText(ctx, `/ ${s.totalRacers || 8}`, { x: w - 6, y: h - 14, size: 15, weight: 0.15, italic: 0.24, align: 'right', color: 'rgba(200,214,230,0.7)' });
    ctx.restore();
  }

  _drawTimer(ctx, s, x, y) {
    const w = 176, h = 38;
    fillPlate(ctx, x, y, w, h, { fill: 'rgba(4,10,16,0.86)', edge: CYAN, edgeW: 1.6 });
    drawSevenSeg(ctx, fmtTime(s.raceTime || 0), {
      x: x + w / 2 + 4, y: y + h - 9, size: 24, color: CYAN, align: 'center', glow: 9, italic: 0.16,
    });
  }

  _drawStandings(ctx, s, x, y) {
    const rows = s.standings || [];
    const n = Math.min(8, rows.length);
    const rh = 25, w = 176;
    fillPlate(ctx, x, y, w, n * rh + 10, { fill: 'rgba(6,9,15,0.72)', edge: 'rgba(90,180,220,0.35)', edgeW: 1.4, skew: 0.10 });
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ry = y + 8 + i * rh + rh - 8;
      const you = r.you;
      drawText(ctx, String(i + 1), {
        x: x + 14 + (n * rh + 10 - (i * rh)) * 0.0, y: ry, size: 15, weight: 0.16, italic: 0.14,
        color: you ? ORANGE : 'rgba(150,170,190,0.85)',
      });
      drawText(ctx, r.name, {
        x: x + 36, y: ry, size: 16, weight: 0.16, italic: 0.14,
        color: you ? ORANGE : '#e6edf5',
        glow: you ? { color: ORANGE, blur: 10 } : null,
      });
    }
  }

  _drawCityBanner(ctx, s, xRight, y) {
    if (!s.cityName) return;
    const size = 22;
    const tw = measure(s.cityName, { size, tracking: 0.12 }).width;
    const w = Math.max(200, tw + 46), h = 36;
    const x = xRight - w;
    fillPlate(ctx, x, y, w, h, { fill: '#12161f', skew: -0.20 });
    plate(ctx, x, y, w, h, -0.20);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#ff7a0d'); g.addColorStop(1, '#ffc23d');
    ctx.fillStyle = g; ctx.fill();
    drawText(ctx, s.cityName, {
      x: x + w / 2, y: y + h - 10, size, weight: 0.19, italic: 0.20, align: 'center',
      color: '#1a1108', tracking: 0.12,
    });
    if (s.record) {
      const h2 = 26;
      fillPlate(ctx, x + 16, y + h + 4, w - 16, h2, { fill: 'rgba(8,10,16,0.85)', skew: -0.20 });
      drawText(ctx, `RECORD ${s.record}`, {
        x: x + w / 2, y: y + h + h2 - 4, size: 14, weight: 0.16, italic: 0.20, align: 'center', color: '#c9d6e4',
      });
    }
  }

  _drawCountdown(ctx, s, cx, y) {
    const w = 176, h = 46;
    fillPlate(ctx, cx - w / 2, y, w, h, { fill: 'rgba(4,4,6,0.88)', edge: 'rgba(255,60,60,0.4)', edgeW: 1.5, skew: 0.10 });
    drawSevenSeg(ctx, fmtCountdown(s.countdown), {
      x: cx + 4, y: y + h - 10, size: 30, color: RED, align: 'center', glow: 14, italic: 0.10,
    });
  }

  _drawSpeedo(ctx, s, cx, cy, R) {
    const mph = Math.max(0, s.mph || 0);
    const maxMph = 220;
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.30;   // sweep
    this.needle = lerp(this.needle, clamp(mph / maxMph, 0, 1.04), 0.22);

    ctx.save();
    ctx.translate(cx, cy);

    // dial body
    const bg = ctx.createRadialGradient(0, -R * 0.2, R * 0.1, 0, 0, R);
    bg.addColorStop(0, 'rgba(16,26,36,0.90)');
    bg.addColorStop(0.75, 'rgba(8,12,20,0.88)');
    bg.addColorStop(1, 'rgba(4,6,10,0.94)');
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fillStyle = bg; ctx.fill();

    // outer bezel
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7);
    ctx.strokeStyle = 'rgba(180,210,230,0.30)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R - 6, 0, 7);
    ctx.strokeStyle = 'rgba(120,180,210,0.16)'; ctx.lineWidth = 1.5; ctx.stroke();

    // danger arc
    ctx.beginPath();
    ctx.arc(0, 0, R - 15, lerp(a0, a1, 0.80), a1);
    ctx.strokeStyle = 'rgba(255,46,46,0.85)'; ctx.lineWidth = 7; ctx.stroke();

    // filled progress arc
    ctx.beginPath();
    ctx.arc(0, 0, R - 15, a0, lerp(a0, a1, clamp(this.needle, 0, 1)));
    const ag = ctx.createLinearGradient(-R, 0, R, 0);
    ag.addColorStop(0, CYAN); ag.addColorStop(1, s.nitroActive ? '#fff0a0' : '#8fe9ff');
    ctx.strokeStyle = ag; ctx.lineWidth = 7;
    ctx.shadowBlur = 14; ctx.shadowColor = CYAN;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ticks + numerals (0..220 in 20s, labelled 0..11 like the reference's abbreviated dial)
    for (let i = 0; i <= 22; i++) {
      const t = i / 22;
      const a = lerp(a0, a1, t);
      const major = i % 2 === 0;
      const r0 = R - (major ? 30 : 24), r1 = R - 17;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.strokeStyle = t > 0.80 ? 'rgba(255,110,110,0.95)' : 'rgba(210,232,245,0.85)';
      ctx.lineWidth = major ? 2.6 : 1.3;
      ctx.stroke();
      if (major && i % 4 === 0) {
        const rr = R - 44;
        drawText(ctx, String(i / 2), {
          x: Math.cos(a) * rr, y: Math.sin(a) * rr + 6, size: 15, weight: 0.16,
          align: 'center', color: 'rgba(225,240,250,0.9)',
        });
      }
    }

    // needle
    const na = lerp(a0, a1, clamp(this.needle, 0, 1.04));
    ctx.save();
    ctx.rotate(na);
    ctx.beginPath();
    ctx.moveTo(-R * 0.12, -3.4); ctx.lineTo(R - 22, -1.3);
    ctx.lineTo(R - 22, 1.3); ctx.lineTo(-R * 0.12, 3.4);
    ctx.closePath();
    ctx.fillStyle = '#ff3a2a';
    ctx.shadowBlur = 10; ctx.shadowColor = '#ff3a2a';
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7);
    ctx.fillStyle = '#c9d6e2'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, 7);
    ctx.fillStyle = '#2a3038'; ctx.fill();

    // readout
    drawText(ctx, String(Math.round(mph)), {
      x: 0, y: R * 0.52, size: 44, weight: 0.19, italic: 0.10, align: 'center',
      color: gradientFill([[0, '#ffffff'], [1, '#b9cbdc']]), bevel: true,
    });
    drawText(ctx, 'MPH', { x: 0, y: R * 0.72, size: 14, weight: 0.18, align: 'center', color: 'rgba(190,212,230,0.85)', tracking: 0.22 });

    // gear
    drawText(ctx, String(s.gear || 1), {
      x: -R * 0.52, y: R * 0.30, size: 22, weight: 0.20, italic: 0.16, align: 'center',
      color: s.nitroActive ? ORANGE : 'rgba(210,230,245,0.9)',
    });
    ctx.restore();
  }

  _drawNitro(ctx, s, cx, yBottom) {
    const w = 168, h = 30;
    const x = cx - w / 2, y = yBottom - h;
    const active = s.nitroActive;
    fillPlate(ctx, x, y, w, h, {
      fill: active ? 'rgba(40,16,4,0.9)' : 'rgba(8,10,16,0.85)',
      edge: active ? ORANGE : 'rgba(140,160,180,0.35)', edgeW: active ? 2 : 1.3, skew: 0.22,
    });
    // charge bar
    const bw = (w - 74) * clamp(s.nitroCharge ?? 0, 0, 1);
    if (bw > 1) {
      plate(ctx, x + 10, y + 8, bw, h - 16, 0.22);
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, active ? '#fff2c0' : '#2fd0ff');
      g.addColorStop(1, active ? ORANGE : '#0d7fae');
      ctx.fillStyle = g;
      ctx.shadowBlur = active ? 16 : 6; ctx.shadowColor = active ? ORANGE : CYAN;
      ctx.fill(); ctx.shadowBlur = 0;
    }
    drawText(ctx, `NITRO ×${s.nitroTanks ?? 0}`, {
      x: x + w - 10, y: y + h - 9, size: 15, weight: 0.18, italic: 0.22, align: 'right',
      color: active ? '#ffe6a8' : 'rgba(200,218,235,0.9)',
      glow: active ? { color: ORANGE, blur: 12 } : null,
    });
  }

  _drawDrift(ctx, s, cx, y) {
    const d = s.drift || 0;
    if (d < 0.12) return;
    const a = smoothstep(0.12, 0.45, d);
    drawText(ctx, 'DRIFT', {
      x: cx, y, size: 26, weight: 0.19, italic: 0.24, align: 'center',
      color: '#ffd24a', alpha: a, glow: { color: '#ff8a1e', blur: 18 }, tracking: 0.20,
    });
    if (s.driftScore > 0) {
      drawText(ctx, String(Math.round(s.driftScore)), {
        x: cx, y: y + 30, size: 20, weight: 0.18, italic: 0.20, align: 'center',
        color: '#ffffff', alpha: a, glow: { color: '#ff8a1e', blur: 10 },
      });
    }
  }

  _drawMessages(ctx, cx, cy, dt) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      m.t += dt;
      if (m.t > m.dur) { this.messages.splice(i, 1); continue; }
      const t = m.t / m.dur;
      const a = smoothstep(0, 0.12, t) * (1 - smoothstep(0.72, 1, t));
      const sc = 1 + (1 - smoothstep(0, 0.25, t)) * 0.25;
      ctx.save();
      ctx.translate(cx, cy - i * 54);
      ctx.scale(sc, sc);
      drawText(ctx, m.text, {
        x: 0, y: 0, size: 46, weight: 0.20, italic: 0.24, align: 'center',
        color: m.color, alpha: a, glow: { color: m.color, blur: 26 },
        outline: { color: 'rgba(0,0,0,0.55)', width: 3 }, tracking: 0.10,
      });
      ctx.restore();
    }
  }

  _drawStartLights(ctx, cx, cy, countdown) {
    const lit = countdown <= 3 ? 4 - Math.ceil(countdown) : 0;
    for (let i = 0; i < 3; i++) {
      const x = cx - 74 + i * 74;
      const on = i < lit;
      ctx.beginPath(); ctx.arc(x, cy, 24, 0, 7);
      ctx.fillStyle = on ? (countdown <= 0.02 ? '#2bff62' : '#ff2e2e') : 'rgba(30,34,42,0.85)';
      if (on) { ctx.shadowBlur = 30; ctx.shadowColor = ctx.fillStyle; }
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(200,220,235,0.5)'; ctx.lineWidth = 2.4; ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- helpers

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

export function fmtCountdown(t) {
  const sec = Math.max(0, Math.floor(t));
  const cs = Math.max(0, Math.floor((t % 1) * 100));
  return `${String(sec).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}
