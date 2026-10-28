/**
 * Graphics quality — one table, read by the engine, the HUD and the city builder.
 *
 * The game was tuned on an M1 Pro, where it holds 60 fps with every pass at full cost. On an
 * ordinary laptop the same frame is dominated by work that scales with PIXELS, not with the scene:
 *
 *   · the WebGL backbuffer at devicePixelRatio 2 (a Retina window is 4x the pixels of the same
 *     window at 1x), and every full-screen post pass — atmosphere with its 9 wet-road and 20 shaft
 *     taps per pixel, bloom, light spill, speed blur, grade, three SMAA passes — paid on all of them
 *   · the HUD's 2D canvas, supersampled 3x per CSS pixel: a 9.2 Mpx canvas cleared, drawn and
 *     high-quality downscaled every frame
 *
 * So the presets below mostly trade PIXELS, which is where the cost is and where the eye notices
 * least at speed, and leave the scene itself — the cities, cars, lighting and grade — exactly as
 * authored. HIGH is the original build, unchanged.
 *
 * On top of the preset, `AdaptiveResolution` watches real frame times and scales the 3D render
 * resolution down (to the preset's floor) when the machine cannot hold its frame rate, and back up
 * when it can. The HUD stays sharp because it is a separate canvas.
 *
 * Choose with the G key in game (cycles LOW → MEDIUM → HIGH, remembered between visits), or with
 * `?quality=low|medium|high` in the URL. `?quality=…&adaptive=0` pins the resolution.
 */

export const QUALITY_LEVELS = ['low', 'medium', 'high'];

export const QUALITY = {
  low: {
    label: 'LOW',
    maxPixelRatio: 1,       // never render above 1 device pixel per CSS pixel
    minScale: 0.6,          // adaptive resolution may drop the 3D image to 60% per axis
    shadowMapSize: 1024,
    smaa: false,
    spill: false,           // night-city emissive spill (4 quarter-res passes + a composite)
    wetTaps: 4,             // atmosphere: wet-road reflection taps per pixel (HIGH: 9)
    shaftSamples: 8,        // atmosphere: light-shaft taps per pixel (HIGH: 20)
    speedTaps: 4,           // speed blur taps per pixel (HIGH: 8)
    hudSS: 1,               // HUD canvas samples per CSS pixel (HIGH: 3)
    lightBudget: 3,         // real point lights in the city's light bank (HIGH: 6) — next city load
    city: 'low',            // buildCity's own quality switch (sky texture size) — next city load
  },
  medium: {
    label: 'MEDIUM',
    maxPixelRatio: 1.25,
    minScale: 0.7,
    shadowMapSize: 2048,
    smaa: true,
    spill: true,
    wetTaps: 6,
    shaftSamples: 12,
    speedTaps: 6,
    hudSS: 1.5,
    lightBudget: 4,
    city: 'high',
  },
  high: {
    label: 'HIGH',
    maxPixelRatio: 2,
    minScale: 0.85,
    shadowMapSize: 2048,
    smaa: true,
    spill: true,
    wetTaps: 9,
    shaftSamples: 20,
    speedTaps: 8,
    hudSS: 3,
    lightBudget: 6,
    city: 'high',
  },
};

const STORE_KEY = 'nitro-circuit.quality';

function params() {
  try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
}

/** The level to start with: URL beats the remembered choice beats MEDIUM. */
export function initialQuality() {
  const q = params().get('quality');
  if (q && QUALITY[q]) return q;
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (s && QUALITY[s]) return s;
  } catch { /* storage blocked: fall through */ }
  return 'medium';
}

export function rememberQuality(level) {
  try { localStorage.setItem(STORE_KEY, level); } catch { /* storage blocked */ }
}

export function nextQuality(level) {
  const i = QUALITY_LEVELS.indexOf(level);
  return QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length];
}

/**
 * Dynamic resolution. Measures the wall-clock time between frames (not the clamped game dt) and
 * nudges the render scale:
 *
 *   · down 10% when the last second averaged slower than ~55 fps
 *   · up 5% after three good seconds in a row (faster than ~70 fps, or a steady vsync-locked 60
 *     with no slow frames) — and that wait doubles every time the scale has had to come down
 *
 * Changes are rare and stepped (a resize reallocates the post-processing targets, so it must not
 * happen every frame), long hitches (a tab switch, a city build) are ignored, and the scale is held
 * between the preset's floor and 1.
 */
export class AdaptiveResolution {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled && params().get('adaptive') !== '0';
    this.scale = 1;
    this.min = 0.7;
    this._last = 0;
    this._acc = 0; this._n = 0; this._slow = 0;
    this._good = 0;
    this._cool = 0;
    this._raiseNeed = 3;     // good seconds before stepping up; doubles after every drop
  }

  setFloor(min) {
    this.min = min;
    if (this.scale < min) this.scale = min;
  }

  reset(scale = 1) {
    this.scale = Math.max(this.min, Math.min(1, scale));
    this._acc = 0; this._n = 0; this._slow = 0; this._good = 0; this._cool = 1.5;
  }

  /**
   * Feed one frame. Returns the new scale when it changed, otherwise null.
   * @param now performance.now() of this frame
   */
  sample(now) {
    const ms = this._last ? now - this._last : 0;
    this._last = now;
    if (!this.enabled || ms <= 0 || ms > 120) return null;      // hitch or first frame: ignore
    this._acc += ms; this._n++;
    if (ms > 22) this._slow++;
    if (this._cool > 0) { this._cool -= ms / 1000; }
    if (this._acc < 1000) return null;

    const avg = this._acc / this._n;
    const slowFrac = this._slow / this._n;
    this._acc = 0; this._n = 0; this._slow = 0;
    if (this._cool > 0) return null;

    let next = this.scale;
    if (avg > 18.2 || slowFrac > 0.12) {
      this._good = 0;
      next = Math.max(this.min, this.scale - 0.1);
      // A machine that just failed at a scale has to prove itself for longer before it gets that
      // scale back, so a frame rate sitting on the line does not ping-pong (and reallocate) forever.
      if (next < this.scale) this._raiseNeed = Math.min(24, this._raiseNeed * 2);
    } else if (avg < 14.3 || (avg < 17.2 && slowFrac < 0.01)) {
      this._good++;
      if (this._good >= this._raiseNeed) { this._good = 0; next = Math.min(1, this.scale + 0.05); }
    } else {
      this._good = 0;
    }
    if (Math.abs(next - this.scale) < 1e-3) return null;
    this.scale = next;
    this._cool = 1.0;
    return next;
  }
}
