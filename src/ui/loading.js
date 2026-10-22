import { drawText, measure, gradientFill } from '../core/font.js';

/**
 * THE LOADING SCREEN — a full-frame plate over everything while a build runs.
 *
 * It owns its own canvas and its own rAF loop rather than borrowing the HUD's layer or the game's
 * loop, for one reason: it has to be on screen BEFORE either exists. `boot.js` puts it up from a
 * chunk that imports nothing but the glyph tables, so the player sees the lockup and a bar within a
 * frame of the page arriving, while the two-megabyte game module is still downloading behind it.
 *
 * Its loop only gets to run when the main thread is free, which is what core/steps.js arranges: a
 * build hands back a frame at every step boundary, and the shader compile polls once a frame, so
 * the bar moves while programs link. Between steps it simply holds its last frame.
 *
 * The bar is honest. Until a step has reported anything it is INDETERMINATE (the garage's barber
 * pole — the same pattern the old in-panel SPOOLING bar used), because there is no number to show
 * for a module download; after that it shows the step's own `p`, eased but never ahead of it.
 *
 * All type is ours (§3.4): font.js glyphs only, never `ctx.font`.
 */

const BG = '#05060c';
const GOLD = '#ffc23a';
const GOLD_HOT = '#ffe9a8';
const CYAN = '#39d7f2';
const ORANGE = '#ff9214';
const LABEL = 'rgba(176,199,220,0.86)';
const SHEAR = 0.16;              // the one slant, shared with the HUD and the garage

function plate(ctx, x, y, w, h, skew = SHEAR) {
  const s = h * skew;
  ctx.beginPath();
  ctx.moveTo(x + s, y); ctx.lineTo(x + w + s, y);
  ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
  ctx.closePath();
}

export class LoadingScreen {
  constructor() {
    this.canvas = null;
    this.visible = false;
    this.alpha = 0;
    this.fading = false;
    this.p = 0;                  // what the build has reported
    this.shown = 0;              // what the bar draws — chases `p`, never passes it
    this.known = false;          // has any step reported a number yet?
    this.label = 'LOADING';
    this.info = {};
    this.t = 0;
    this._last = 0;
    this._raf = 0;
    this._onResize = () => this._resize();
  }

  /**
   * Put the plate up (or retitle it if it is already up).
   * @param info.kicker  small cyan line above the title, e.g. 'NEXT STOP'
   * @param info.title   e.g. the destination's name. Omitted at boot: the lockup is the title.
   * @param info.accent  the destination's own colour, for the title rule and the bar
   */
  show(info = {}) {
    this.info = info;
    this.p = 0; this.shown = 0; this.known = false;
    this.label = info.label || 'LOADING';
    this.fading = false;
    if (!this.canvas) {
      const c = document.createElement('canvas');
      c.id = 'loading';
      c.style.cssText = `position:fixed;inset:0;width:100%;height:100%;z-index:10;background:${BG};`;
      document.body.appendChild(c);
      this.canvas = c;
      this.ctx = c.getContext('2d');
      window.addEventListener('resize', this._onResize);
    }
    this.canvas.style.display = 'block';
    this._resize();
    if (!this.visible) {
      this.visible = true;
      this.alpha = info.instant ? 1 : Math.max(this.alpha, 0.0001);
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._frame);
    }
    this.draw();
  }

  /** Report a step: `p` in 0..1 and what is happening now. Progress only ever moves forward. */
  set(p, label) {
    if (Number.isFinite(p)) { this.p = Math.max(this.p, Math.min(1, p)); this.known = true; }
    if (label) this.label = label;
  }

  /** Fill the bar, then fade out over whatever has been drawn underneath. */
  hide() {
    if (!this.visible) return;
    this.set(1);
    this.fading = true;
  }

  /** True while the plate covers the frame (used to keep the game from drawing under it). */
  get covering() { return this.visible && !this.fading; }

  _resize() {
    if (!this.canvas) return;
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr; this.W = W; this.H = H;
    const bw = Math.floor(W * dpr), bh = Math.floor(H * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
    this._static = null;          // the cached lockup was rasterised for the old size
    if (this.visible) this.draw();
  }

  _frame = (now) => {
    const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.t += dt;
    // ease toward the reported value; once it is filled and fading, run the fade
    this.shown += (this.p - this.shown) * (1 - Math.exp(-dt * (this.fading ? 16 : 7)));
    if (this.p - this.shown < 0.002) this.shown = this.p;
    if (this.fading) {
      if (this.shown >= 0.999) this.alpha -= dt / 0.35;
    } else {
      this.alpha = Math.min(1, this.alpha + dt / 0.18);
    }
    if (this.alpha <= 0) {
      this.visible = false; this.fading = false; this.alpha = 0;
      this.canvas.style.display = 'none';
      return;
    }
    this.draw();
    this._raf = requestAnimationFrame(this._frame);
  };

  /** The lockup and backdrop never change while the plate is up, so they are drawn once per size. */
  _drawStatic() {
    const { W, H, dpr } = this;
    const c = this._static || document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    const k = Math.min(W / 1600, H / 900);
    const VW = W / k, VH = H / k;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, VW, VH);
    // a cool pool behind the lockup and the bar, falling off to the edge of the frame
    const g = ctx.createRadialGradient(VW / 2, VH * 0.46, 40, VW / 2, VH * 0.46, Math.max(VW, VH) * 0.62);
    g.addColorStop(0, 'rgba(26,44,66,0.55)');
    g.addColorStop(0.55, 'rgba(10,16,28,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, VH);

    const cx = VW / 2, by = VH / 2 - 64;
    const nSize = 104, cSize = 72;
    const gap = nSize * 0.24 * 0.62 + 22;
    const nw = measure('NITRO', { size: nSize, tracking: 0.10 }).width;
    const cw = measure('CIRCUIT', { size: cSize, tracking: 0.30, face: 'geo' }).width;
    const lx = cx - (nw + gap + cw) / 2;
    drawText(ctx, 'NITRO', {
      x: lx, y: by, size: nSize, weight: 0.21, italic: 0.24, tracking: 0.10,
      color: gradientFill([[0, '#ffffff'], [0.55, '#ffd9a2'], [1, ORANGE]]),
      bevel: true, glow: { color: ORANGE, blur: 16 },
    });
    drawText(ctx, 'CIRCUIT', {
      x: lx + nw + gap, y: by, size: cSize, weight: 0.14, tracking: 0.30, color: CYAN, face: 'geo',
    });
    this._static = c;
    this._layout = { k, VW, VH, cx, by };
  }

  draw() {
    if (!this.canvas || !this.visible) return;
    if (!this._static) this._drawStatic();
    const ctx = this.ctx;
    const { dpr } = this;
    const { k, VW, VH, cx, by } = this._layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = Math.max(0, Math.min(1, this.alpha));
    ctx.drawImage(this._static, 0, 0);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);

    const accent = this.info.accent || GOLD;
    const barW = 720, barH = 18;
    const bx = cx - barW / 2;
    let barY = by + 92;

    // ---- the destination, when there is one --------------------------------------------------
    if (this.info.title) {
      if (this.info.kicker) {
        drawText(ctx, this.info.kicker, {
          x: cx, y: by + 70, size: 15, weight: 0.15, tracking: 0.40, align: 'center', color: CYAN, face: 'geo',
        });
      }
      drawText(ctx, this.info.title, {
        x: cx, y: by + 122, size: 40, weight: 0.20, italic: 0.20, tracking: 0.13, align: 'center',
        color: '#ffffff', shadow: { color: 'rgba(0,0,0,0.8)', dy: 2, blur: 4 },
      });
      const tw = Math.min(barW, measure(this.info.title, { size: 40, tracking: 0.13 }).width + 40);
      ctx.fillStyle = accent;
      plate(ctx, cx - tw / 2, by + 136, tw, 3); ctx.fill();
      barY = by + 184;
    }

    // ---- the bar -----------------------------------------------------------------------------
    plate(ctx, bx, barY, barW, barH);
    ctx.fillStyle = 'rgba(4,8,14,0.92)'; ctx.fill();
    ctx.save();
    plate(ctx, bx, barY, barW, barH); ctx.clip();
    if (this.known) {
      const fw = barW * this.shown + barH * SHEAR;
      const fill = ctx.createLinearGradient(bx, 0, bx + barW, 0);
      fill.addColorStop(0, ORANGE);
      fill.addColorStop(1, accent);
      ctx.fillStyle = fill;
      plate(ctx, bx - barH * SHEAR, barY, fw, barH); ctx.fill();
      // a sheen running along the filled part, so a bar waiting on one long step still reads as alive
      const sx = bx + ((this.t * 0.55) % 1.3 - 0.15) * fw;
      const sh = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
      sh.addColorStop(0, 'rgba(255,255,255,0)');
      sh.addColorStop(0.5, 'rgba(255,248,226,0.45)');
      sh.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh;
      plate(ctx, bx - barH * SHEAR, barY, fw, barH); ctx.fill();
    } else {
      // indeterminate: the barber pole, travelling
      const phz = (this.t * 96) % 26;
      ctx.fillStyle = 'rgba(57,215,242,0.55)';
      for (let x = bx - 26 + phz; x < bx + barW + 26; x += 26) {
        ctx.beginPath();
        ctx.moveTo(x, barY + barH); ctx.lineTo(x + 11, barY + barH);
        ctx.lineTo(x + 11 + barH, barY); ctx.lineTo(x + barH, barY);
        ctx.closePath(); ctx.fill();
      }
    }
    // the leading-edge rail every plate in this game carries, on the bar's own slanted edge
    ctx.fillStyle = GOLD;
    plate(ctx, bx, barY, 4, barH); ctx.fill();
    ctx.restore();
    plate(ctx, bx, barY, barW, barH);
    ctx.strokeStyle = 'rgba(150,190,220,0.42)'; ctx.lineWidth = 1.3; ctx.stroke();

    // ---- what is happening, and how far along -------------------------------------------------
    drawText(ctx, this.label, {
      x: bx, y: barY + barH + 30, size: 14, weight: 0.15, tracking: 0.24, color: LABEL, face: 'geo',
    });
    if (this.known) {
      drawText(ctx, `${Math.floor(this.shown * 100)}%`, {
        x: bx + barW + barH * SHEAR, y: barY + barH + 32, size: 20, weight: 0.17, tracking: 0.12,
        align: 'right', color: GOLD_HOT, face: 'geo',
      });
    }
    drawText(ctx, 'EVERY CITY IS GENERATED ON YOUR MACHINE', {
      x: cx, y: VH - 54, size: 12, weight: 0.14, tracking: 0.34, align: 'center',
      color: 'rgba(150,175,200,0.55)', face: 'geo',
    });
  }
}

/** The one plate. boot.js puts it up; main.js drives it; the menu borrows it for builds. */
export const loading = new LoadingScreen();
