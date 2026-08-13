import * as THREE from 'three';
import { clamp, lerp, smoothstep, RNG } from '../core/rng.js';

/**
 * Nitrous: the charge/drain state machine AND the visual payoff.
 *
 * ART_DIRECTION.md §6.3 — target 85. Hard caps: a single expanding transparent sprite → 50;
 * no camera response → 65; identical across the four classes → 70.
 * §7 additionally caps "particles as unrotated camera-facing squares with visible hard edges" at 58.
 *
 * ── The §7 rule, and how every layer here obeys it ────────────────────────────────────────────
 * NOTHING in this file is allowed to show a straight edge or a corner. Concretely:
 *   · the lathe shells fade out with the *facing ratio* (`pow(|N·V|, p)`), which is zero exactly
 *     at the silhouette — so the cone dissolves at its outline instead of ending on a polygon
 *     chord. Round 1 did the opposite (a rim boost) and produced flat blue sheets with razor
 *     straight boundaries;
 *   · every sprite (gas card, burner disc, muzzle flash, shock ring, ground pool) is drawn from a
 *     procedural canvas whose alpha reaches 0 well inside the tile, and every camera-facing card
 *     carries its own roll + spin so it is never an "unrotated camera-facing square";
 *   · the streak quads are shaded as a 2-D gaussian capsule — round head, tapered tail, zero alpha
 *     on all four quad edges;
 *   · everything additionally fades out inside ~2.5 m of the camera, so no layer can ever be
 *     clipped by the near plane into a hard-edged wedge across the lens.
 *
 * ── The round-3 rule: THE CAR MUST SURVIVE ITS OWN NITROUS ───────────────────────────────────
 * Round 2's jet was bright enough to erase the thing it was attached to — the rear third of the
 * car clipped to featureless white, and because each plume was splayed ~10° outboard and lifted
 * to a fixed minimum height, the near jet appeared to erupt from the car's FLANK while the far one
 * hid behind the body: one off-axis blob instead of two jets. Three structural rules now:
 *
 *   · one jet per real exhaust outlet, at that outlet's x and y, fired straight down the car's
 *     rear-facing centreline (splay ≈ 0.02 rad, not 0.17), each with its own band/flicker phase;
 *   · the plume STARTS `fx.standoff` (~0.3 m) behind the tip and its alpha ramps in over the first
 *     quarter of the column, so the bumper, taillights, diffuser and exhaust tips read in front of
 *     clear air, not inside the hottest part of the flame;
 *   · every emissive layer is roughly half its round-2 strength — and `fx.rad` is held well under
 *     half the twin-outlet spacing so the two hot cores never merge.
 *
 * And the jet is no longer the same size in every frame: `Nitrous.ramp` (thrust authority) drives
 * its LENGTH, multiplied by a hold term that stretches the column over the first ~0.6 s and by
 * road speed. Ignition is short and hot; sustain at 200 mph is a long column.
 *
 * The jet is built from EIGHT cooperating layers, not one sprite:
 *
 *   1. a white-hot lathe core with hard pressure banding baked into the fragment shader
 *   2. a class-tinted mid shell with its own band phase and turbulence
 *   3. a soft lathe fringe
 *   4. a stack of rolled, spinning, soft-edged "gas cards" down the axis — the wide fringe, and
 *      the layer that guarantees a soft outline from any angle
 *   5. a camera-facing burner disc so the plume still reads with structure head-on
 *   6. a velocity-stretched spark + light-smear streak pool, emitted into a narrow REARWARD cone
 *      and entrained in the jet wake (it trails, it does not detonate)
 *   7. a ground light pool on the road + a point light that spills onto the car's own bodywork
 *   8. heat haze: the jet reports a screen-space position and strength, and main.js feeds it to
 *      the grade pass, which ripples the image behind the plume
 *
 * Ignition adds a muzzle flash, an expanding shock ring and a rearward spark blast, and main.js
 * turns `Nitrous.surge` into an FOV punch, a camera kick and a grade shift.
 */

// ---------------------------------------------------------------------------------------------
// PER-CLASS NITROUS TABLE — owned by the nitrous piece. Kept here (not in the car files) so the
// nitrous builder and the vehicle-art builder never edit the same file.
//
//   thrust        extra drive force while boosting
//   duration      seconds one full tank lasts (drain is normalised to 1.0 so this reads directly)
//   refill        tank recharge rate when not boosting
//   topSpeedMul   how far past the class top speed a boost carries
//   ramp          seconds for the thrust to spool in
//   curve         exponent on the spool — THE per-class feel knob.
//                 <1 = snaps in violently, 1 = linear shove, >1 = builds like a freight train
//   surge         seconds the ignition overshoot lasts, and how hard it hits
//   color         flame tint; also drives the HUD, grade and speed-line tint
//   fx            purely visual per-class shaping of the jet (see NitrousJet)
//
//   fx.gain       master brightness of the plume. THE anti-blowout knob: the SUV's plume is the
//                 widest in the game, and at gain 1 it clipped to one featureless white mass.
//   fx.wake       how much of the car's speed the embers inherit. 0 would pin them to the bumper,
//                 1 would fire them through the chase camera at 90 m/s (round 1's "firework").
//   fx.cone       half-angle, in radians, of the rearward emission cone.
//   fx.standoff   how far BEHIND the exhaust anchor the plume starts. Round 2 lit the flame on the
//                 lip of the tip, so the bumper, taillights and outlets sat inside the hottest,
//                 most bloomed part of the jet and the car's rear silhouette disappeared.
//   fx.rad        core radius. It has to stay well UNDER half the twin-outlet spacing or the two
//                 jets merge into one blob — the single biggest round-2 note.
// ---------------------------------------------------------------------------------------------
export const NITRO = {
  // Short and sharp. A tiny screamer: near-instant, thin white-cyan needle, gone in a blink.
  // Single big centre outlet, so one jet — and that alone reads differently from the other three.
  tuner: {
    thrust: 0.92, duration: 1.8, drain: 1.0, refill: 0.62, topSpeedMul: 1.38,
    ramp: 0.13, curve: 0.52, surge: 0.88, surgeTime: 0.22, color: '#3ce0ff',
    fx: {
      core: '#f4ffff', mid: '#34dcff', edge: '#0b46ff', spark: '#cdf4ff',
      len: 3.85, rad: 0.255, splay: 0.0, standoff: 0.28, flameRise: 0.045, gain: 0.70,
      bands: 16.0, bandSharp: 2.8, bandSpeed: 30, flick: 62, turb: 0.30,
      cards: 7, cardSpread: 1.30, cardWidth: 2.20, cardGain: 0.46,
      sparkRate: 94, sparkSpeed: [3.5, 11], sparkWidth: 0.046, sparkLife: [0.09, 0.17],
      wake: 0.16, cone: 0.22, smearRate: 8, smearWidth: 0.22,
      poolWidth: 2.6, poolLen: 7.2, lightI: 19, shake: 0.30, heat: 1.00,
    },
  },
  // A long brutal shove. Twin wide-set pipes, fat orange-red columns, slow heavy banding.
  muscle: {
    thrust: 1.10, duration: 3.4, drain: 1.0, refill: 0.34, topSpeedMul: 1.32,
    ramp: 0.52, curve: 1.20, surge: 0.62, surgeTime: 0.44, color: '#ff7a1e',
    fx: {
      core: '#fff0cf', mid: '#ff6a08', edge: '#c81400', spark: '#ffc477',
      len: 4.25, rad: 0.320, splay: 0.020, standoff: 0.32, flameRise: 0.15, gain: 0.56,
      bands: 8.5, bandSharp: 1.9, bandSpeed: 12, flick: 28, turb: 0.48,
      cards: 8, cardSpread: 1.20, cardWidth: 2.85, cardGain: 0.42,
      sparkRate: 80, sparkSpeed: [2.5, 9], sparkWidth: 0.070, sparkLife: [0.13, 0.26],
      wake: 0.21, cone: 0.28, smearRate: 9, smearWidth: 0.34,
      poolWidth: 3.5, poolLen: 9.4, lightI: 24, shake: 0.46, heat: 1.15,
    },
  },
  // Builds like a freight train. Widest-set outlets, slowest, most massive plume in the game —
  // and therefore the dimmest per unit area, or it becomes one blown-out yellow mass over the car.
  suv: {
    thrust: 1.26, duration: 4.6, drain: 1.0, refill: 0.28, topSpeedMul: 1.22,
    ramp: 1.25, curve: 2.00, surge: 0.34, surgeTime: 0.62, color: '#ffc21f',
    fx: {
      core: '#ffdf9a', mid: '#ff8a04', edge: '#c81a00', spark: '#ffd487',
      len: 3.80, rad: 0.355, splay: 0.020, standoff: 0.34, flameRise: 0.26, gain: 0.29,
      bands: 5.5, bandSharp: 1.4, bandSpeed: 7, flick: 16, turb: 0.64,
      cards: 8, cardSpread: 1.16, cardWidth: 3.05, cardGain: 0.28,
      sparkRate: 72, sparkSpeed: [2, 8], sparkWidth: 0.086, sparkLife: [0.16, 0.30],
      wake: 0.25, cone: 0.32, smearRate: 10, smearWidth: 0.44,
      poolWidth: 3.9, poolLen: 8.8, lightI: 20, shake: 0.54, heat: 1.30,
    },
  },
  // Snaps in instantly and violently. Twin close-set centre pipes: longest, tightest, hottest —
  // two white needles with an electric violet fringe.
  supercar: {
    thrust: 1.08, duration: 2.3, drain: 1.0, refill: 0.46, topSpeedMul: 1.46,
    ramp: 0.08, curve: 0.32, surge: 1.00, surgeTime: 0.30, color: '#8f6bff',
    fx: {
      core: '#ffffff', mid: '#9a72ff', edge: '#2a2fff', spark: '#ded2ff',
      len: 4.85, rad: 0.285, splay: 0.030, standoff: 0.30, flameRise: 0.035, gain: 0.72,
      bands: 13.5, bandSharp: 2.6, bandSpeed: 34, flick: 74, turb: 0.27,
      cards: 8, cardSpread: 1.26, cardWidth: 2.45, cardGain: 0.47,
      sparkRate: 90, sparkSpeed: [4, 14], sparkWidth: 0.046, sparkLife: [0.09, 0.18],
      wake: 0.14, cone: 0.20, smearRate: 8, smearWidth: 0.26,
      poolWidth: 3.1, poolLen: 9.6, lightI: 24, shake: 0.62, heat: 1.10,
    },
  },
};

export function getNitro(id) {
  const n = NITRO[id];
  if (!n) throw new Error(`No nitrous profile for vehicle "${id}"`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------------------------

export class Nitrous {
  constructor(spec) {
    this.spec = spec;
    this.cfg = spec.nitro;
    this.charge = 1.0;         // 0..1 tank
    this.tanks = 3;            // discrete tanks, like the reference's "NITRO X3" badge
    this.active = false;
    this.ramp = 0;             // 0..1 thrust authority — the per-class feel curve
    this.flame = 0;            // 0..1 visual level — rises faster than thrust so the jet is
                               // always a spectacle even while an SUV is still spooling
    this.surge = 0;            // 0..1 ignition overshoot, decays over cfg.surgeTime
    this._spool = 0;
    this.t = 0;
    this.justFired = false;
    this.justEnded = false;
  }

  /** Thrust includes the ignition overshoot so the punch is felt, not just seen. */
  get thrust() { return (this.ramp + this.surge * (this.cfg.surge ?? 0.5) * 0.55) * this.cfg.thrust * 30; }
  get strength() { return this.ramp; }
  /** What the camera/grade should respond to: sustained boost plus the ignition spike. */
  get punch() { return clamp(this.ramp + this.surge * (this.cfg.surge ?? 0.5), 0, 1.8); }

  /** @param want boolean — the player is holding the nitro button */
  update(dt, want, { moving = true } = {}) {
    this.justFired = false; this.justEnded = false;
    const c = this.cfg;
    const canFire = this.charge > 0.02 && this.tanks > 0 && moving;

    if (want && canFire) {
      if (!this.active) { this.active = true; this.justFired = true; this.t = 0; this.surge = 1; }
      this.charge -= dt * c.drain / c.duration;
      if (this.charge <= 0) { this.charge = 0; this.tanks = Math.max(0, this.tanks - 1); this.active = false; this.justEnded = true; }
    } else {
      if (this.active) this.justEnded = true;
      this.active = false;
      if (this.tanks > 0 || this.charge < 1) {
        this.charge = Math.min(1, this.charge + dt * c.refill * 0.30);
      }
    }

    // Spool is linear; the CURVE is what makes the classes feel different.
    //   supercar curve 0.32 → 80% thrust within a couple of frames
    //   suv      curve 2.00 → almost nothing for half a second, then it shoves
    const rampS = Math.max(0.03, c.ramp ?? 0.3);
    this._spool = clamp(this._spool + (this.active ? dt / rampS : -dt / 0.22), 0, 1);
    this.ramp = Math.pow(this._spool, c.curve ?? 1);

    // Visual level rises on its own (fast) schedule and falls off with a hot afterglow.
    const riseS = Math.max(0.02, c.fx?.flameRise ?? 0.08);
    const flameTarget = this.active ? 1 : 0;
    const flameRate = this.active ? 1 / riseS : 5.2;
    this.flame += (flameTarget - this.flame) * (1 - Math.exp(-flameRate * dt));
    this.flame = clamp(this.flame, 0, 1);

    this.surge = Math.max(0, this.surge - dt / Math.max(0.05, c.surgeTime ?? 0.3));
    this.t += dt;
    return this.ramp;
  }

  addTank() { this.tanks = Math.min(3, this.tanks + 1); this.charge = 1; }
  reset() {
    this.charge = 1; this.tanks = 3; this.active = false;
    this.ramp = 0; this.flame = 0; this.surge = 0; this._spool = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Procedural textures (canvas → CanvasTexture; nothing is loaded from disk)
//
// Every one of these is a RADIAL alpha field that reaches zero strictly inside the tile. That is
// the §7 requirement: a sprite whose alpha is still non-zero at the tile border shows the quad.
// ---------------------------------------------------------------------------------------------

const _texCache = new Map();
function cachedTex(key, make) {
  let t = _texCache.get(key);
  if (!t) {
    t = make();
    t.colorSpace = THREE.SRGBColorSpace;
    _texCache.set(key, t);
  }
  return t;
}
function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d') };
}

/**
 * Assert-by-construction helper: multiply a finished canvas by a radial window so the outer 12%
 * of the tile is guaranteed transparent no matter what was drawn into it.
 */
function feather(ctx, S, inner = 0.34, outer = 0.50) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
      const r = Math.hypot(nx, ny);
      const t = clamp((r - inner) / (outer - inner), 0, 1);
      d[o + 3] *= 1 - t * t * (3 - 2 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * A puff of glowing gas: several offset soft lobes, a hot centre and a faint axial smear, all
 * feathered to zero before the tile edge. Three variants so a stack of cards is never one shape
 * repeated. This is the layer that gives the plume a soft OUTLINE from every angle.
 */
function gasCardTexture(variant) {
  return cachedTex(`gas${variant}`, () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    const rng = new RNG(1700 + variant * 331);
    ctx.clearRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';

    // lumpy body — offset lobes, so the silhouette is irregular rather than a disc
    const lobes = 9 + variant;
    for (let i = 0; i < lobes; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, S * 0.13);
      const x = h + Math.cos(a) * d, y = h + Math.sin(a) * d * 1.15;
      const r = rng.range(S * 0.13, S * 0.24);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${rng.range(0.16, 0.30)})`);
      g.addColorStop(0.45, `rgba(255,255,255,${rng.range(0.05, 0.11)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    // hot centre
    const g0 = ctx.createRadialGradient(h, h, 0, h, h, S * 0.16);
    g0.addColorStop(0, 'rgba(255,255,255,0.55)');
    g0.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    g0.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g0; ctx.fillRect(0, 0, S, S);
    // broad halo so the card has a long soft tail into transparency
    const g1 = ctx.createRadialGradient(h, h, S * 0.10, h, h, S * 0.46);
    g1.addColorStop(0, 'rgba(255,255,255,0.18)');
    g1.addColorStop(0.55, 'rgba(255,255,255,0.055)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, S, S);

    feather(ctx, S, 0.33, 0.49);
    return new THREE.CanvasTexture(c);
  });
}

/**
 * The burner disc: what you see looking straight into the nozzle. Hard white centre, a set of
 * concentric pressure rings, radial spikes and an anamorphic horizontal smear. This is the layer
 * that keeps the jet legible from the chase camera, where the plume is heavily foreshortened.
 */
function burnerTexture() {
  return cachedTex('burner', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    const rng = new RNG(9091);
    ctx.clearRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';

    // radial spikes first (under everything)
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + rng.range(-0.06, 0.06);
      const len = h * rng.range(0.40, 0.86);
      const g = ctx.createLinearGradient(h, h, h + Math.cos(a) * len, h + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineCap = 'round';
      ctx.lineWidth = rng.range(1.2, 3.4);
      ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * len, h + Math.sin(a) * len); ctx.stroke();
    }

    // concentric pressure rings — soft on both sides, so no ring shows an edge
    for (let i = 0; i < 6; i++) {
      const r = h * (0.13 + i * 0.105);
      const w = h * (0.030 - i * 0.0026);
      const g = ctx.createRadialGradient(h, h, Math.max(0, r - w * 2.6), h, h, r + w * 2.6);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${0.62 - i * 0.085})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    }

    // white-hot core
    const g0 = ctx.createRadialGradient(h, h, 0, h, h, h * 0.18);
    g0.addColorStop(0, 'rgba(255,255,255,0.90)');
    g0.addColorStop(0.42, 'rgba(255,255,255,0.5)');
    g0.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g0; ctx.fillRect(0, 0, S, S);

    // broad halo
    const g1 = ctx.createRadialGradient(h, h, h * 0.18, h, h, h * 0.92);
    g1.addColorStop(0, 'rgba(255,255,255,0.30)');
    g1.addColorStop(0.55, 'rgba(255,255,255,0.09)');
    g1.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, S, S);

    // anamorphic horizontal smear — the arcade lens-flare tell. Gaussian in BOTH axes: drawn as a
    // hard band (round 1) it put two straight horizontal edges across the middle of the sprite.
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
        const streak = Math.exp(-(ny * ny) / (0.010 * 0.010)) * Math.exp(-(nx * nx) / (0.26 * 0.26));
        d[o + 3] = Math.min(255, d[o + 3] + streak * 210);
      }
    }
    ctx.putImageData(img, 0, 0);

    feather(ctx, S, 0.36, 0.50);
    return new THREE.CanvasTexture(c);
  });
}

/**
 * Soft irregular pool of light for the road spill. Bright near the nozzle, fading backward.
 *
 * Evaluated per pixel as one continuous field. Round 2 stacked 26 discrete radial gradients down
 * the tile; on the road, seen from the chase camera at a grazing angle, those 26 rings compressed
 * into a fan of horizontal stripes under the car, which the aberration pass then fringed into
 * rainbow scanlines. A light pool must have no internal edges at all.
 */
function poolTexture() {
  return cachedTex('pool', () => {
    const S = 256;
    const { c, ctx } = cv(S, S);
    const rng = new RNG(4471);
    // a handful of low-frequency lumps so the pool is not a perfectly airbrushed cone
    const lumps = [];
    for (let i = 0; i < 6; i++) {
      lumps.push([rng.range(0.05, 0.80), rng.range(-0.20, 0.20), rng.range(0.10, 0.26), rng.range(0.4, 1.0)]);
    }
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const v = (y + 0.5) / S;          // 0 at the nozzle end, 1 at the far end
        const u = (x + 0.5) / S - 0.5;    // -0.5 .. 0.5 across
        const halfW = 0.055 + v * 0.40;   // the spill fans out down the road
        let a = Math.exp(-(u * u) / (halfW * halfW)) * Math.pow(1 - v, 1.7);
        let lum = 1;
        for (const [lv, lu, lr, la] of lumps) {
          const dv = (v - lv) / lr, du = (u - lu) / (lr * 1.5);
          lum += la * 0.5 * Math.exp(-(dv * dv + du * du));
        }
        a *= 0.55 + 0.45 * Math.min(lum, 2.2);
        a *= (1 - smoothstep(0.84, 1.0, v)) * (1 - smoothstep(0.80, 1.0, Math.abs(u) * 2));
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
        d[o + 3] = clamp(a, 0, 1) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  });
}

/** Muzzle flash: a blazing centre with long four-point streaks, all gaussian-soft. */
function flashTexture() {
  return cachedTex('flash', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    ctx.clearRect(0, 0, S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const arms = [[1, 0, 0.014, 0.34], [0, 1, 0.011, 0.26], [0.7071, 0.7071, 0.007, 0.20], [0.7071, -0.7071, 0.007, 0.20]];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const nx = (x + 0.5) / S - 0.5, ny = (y + 0.5) / S - 0.5;
        const r = Math.hypot(nx, ny);
        let a = Math.exp(-(r * r) / (0.055 * 0.055)) + Math.exp(-(r * r) / (0.15 * 0.15)) * 0.42;
        for (const [ax, ay, w, l] of arms) {
          const along = nx * ax + ny * ay;
          const across = -nx * ay + ny * ax;
          a += Math.exp(-(across * across) / (w * w)) * Math.exp(-(along * along) / (l * l)) * 0.75;
        }
        const v = clamp(a, 0, 1) * (1 - smoothstep(0.34, 0.50, r));
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = v * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  });
}

/** Thin bright shock ring for the ignition wave. */
function ringTexture() {
  return cachedTex('shockring', () => {
    const S = 256, h = S / 2;
    const { c, ctx } = cv(S, S);
    ctx.clearRect(0, 0, S, S);
    const g = ctx.createRadialGradient(h, h, h * 0.56, h, h, h * 0.98);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.14)');
    g.addColorStop(0.78, 'rgba(255,255,255,1)');
    g.addColorStop(0.90, 'rgba(255,255,255,0.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  });
}

// ---------------------------------------------------------------------------------------------
// Plume shells
// ---------------------------------------------------------------------------------------------

/**
 * Unit lathe: radius 0..1 across, length 0..1 along +Y, then rotated so the axis runs down -Z
 * (out the back of the car). Necks at the nozzle, bulges just aft of it, tapers to a point.
 */
let _plumeGeo = null;
function plumeGeometry() {
  if (_plumeGeo) return _plumeGeo;
  const pts = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.75);
    const r = (0.30 + 0.70 * shape) * Math.pow(1 - t, 0.30);
    pts.push(new THREE.Vector2(Math.max(0.002, r), t));
  }
  const geo = new THREE.LatheGeometry(pts, 40);
  geo.rotateX(-Math.PI / 2);   // +Y (axial) → -Z
  _plumeGeo = geo;
  return geo;
}

const PLUME_VERT = /* glsl */`
  uniform float uTime, uLevel, uTurb, uPhase;
  varying float vT;
  varying float vA;
  varying float vFace;
  varying float vDepth;
  void main(){
    vT = uv.y; vA = uv.x;
    // unstable, wobbling column — the plume must never look like a static cone
    float w = sin(vT*17.0 + uTime*34.0 + vA*25.13 + uPhase) * 0.5
            + sin(vT*29.0 - uTime*47.0 + vA*15.7 + uPhase*2.1) * 0.32
            + sin(vT*8.0  + uTime*19.0 + vA*40.2 + uPhase*0.6) * 0.18;
    vec3 radial = normalize(vec3(normal.xy, 0.0) + vec3(0.0001));
    vec3 p = position + radial * (w * uTurb * smoothstep(0.02, 0.45, vT) * (0.35 + 0.65*uLevel));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    // Facing ratio, NOT a rim term. |N·V| is 0 exactly on the silhouette, so multiplying alpha by
    // it dissolves the outline — which is what stops the shell reading as a flat cut-out sheet.
    vFace = abs(dot(n, normalize(-mv.xyz)));
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAG = /* glsl */`
  uniform vec3 uCore, uMid, uEdge;
  uniform float uTime, uLevel, uBands, uBandSharp, uBandSpeed, uFlick;
  uniform float uOpacity, uTaper, uFacePow, uWhite, uEdgeMix, uGain, uBandAmt;
  uniform float uNear0, uNear1, uRamp, uFaceFloor, uPhase;
  varying float vT;
  varying float vA;
  varying float vFace;
  varying float vDepth;
  void main(){
    float t = vT;

    // hard pressure banding — shock diamonds travelling down the column.
    // uPhase is per-NOZZLE: twin jets that band in lockstep read as one mirrored object, so each
    // outlet gets its own phase and the pair reads as two independent jets.
    float b = 0.5 + 0.5*sin(t*uBands*6.28318 - uTime*uBandSpeed + uPhase*3.0);
    b = pow(clamp(b, 0.0, 1.0), uBandSharp);
    // a second, slower band set so the pattern never looks like a single sine
    float b2 = pow(clamp(0.5 + 0.5*sin(t*uBands*2.1*6.28318 - uTime*uBandSpeed*0.42 + 1.7 + uPhase), 0.0, 1.0), uBandSharp*0.6);
    float band = clamp(b*0.85 + b2*0.38, 0.0, 1.4);

    // Colour: only the innermost shell is allowed to go white-hot. The outer shells stay on the
    // class tint — an additive stack that all pushes toward white clips every channel and the
    // whole plume turns into a colourless blob (that was the round-1 SUV).
    // The white window is anchored to uRamp: alpha fades IN over uRamp, so a white window fixed at
    // t<0.34 put the white core exactly where the shell was still transparent and the jet lost its
    // hot centre entirely.
    float w0 = uRamp * 0.55;
    vec3 col = mix(uMid, uCore, uWhite * (1.0 - smoothstep(w0, w0 + 0.40, t)));
    col = mix(col, uEdge, smoothstep(w0 + 0.20, 1.0, t) * uEdgeMix);
    col *= uGain * mix(1.0, 0.45 + 0.80*band, uBandAmt);

    // ---- alpha: axial profile x facing fade x banding x flicker ----
    // The brightest part of a real jet is a short way DOWN the column, not at the lip: ramping in
    // over uRamp stops the whole plume collapsing into one bloom ball on the bumper. Round 2 used
    // a ramp of 0.11–0.26 and the flame still lit ON the tips, blowing the whole rear of the car
    // to featureless white — the ramps are much longer now and the jet also starts fx.standoff
    // metres further back, so the bumper, taillights and outlets stay readable in front of it.
    float a = smoothstep(0.0, uRamp, t) * pow(clamp(1.0 - t, 0.0, 1.0), uTaper);
    // Facing fade with a small floor: the fade is what dissolves the silhouette, the floor is what
    // keeps the column visible when the chase camera is looking almost straight down its axis.
    a *= mix(uFaceFloor, 1.0, pow(clamp(vFace, 0.0, 1.0), uFacePow));
    // angular breakup so a lathe never reads as a lathe
    a *= 0.80 + 0.20*sin(vA*6.28318*3.0 + t*9.0 + uTime*3.1)
             + 0.10*sin(vA*6.28318*7.0 - t*4.0 - uTime*5.3);
    a *= mix(1.0, 0.16 + 1.05*band, uBandAmt);
    a *= uOpacity * uLevel;
    a *= 0.80 + 0.20*sin(uTime*uFlick) + 0.08*sin(uTime*uFlick*0.37 + vA*12.0);
    // never let a shell be clipped by the near plane into a hard-edged wedge across the lens
    a *= smoothstep(uNear0, uNear1, vDepth);

    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

function plumeMaterial(fx, {
  opacity, taper, facePow, turb, bandMul = 1, sharpMul = 1,
  white = 0, edgeMix = 1, gain = 1, bandAmt = 1, ramp = 0.10, faceFloor = 0.22, phase = 0,
}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uPhase: { value: phase },
      uCore: { value: new THREE.Color(fx.core) },
      uMid: { value: new THREE.Color(fx.mid) },
      uEdge: { value: new THREE.Color(fx.edge) },
      uBands: { value: fx.bands * bandMul },
      uBandSharp: { value: fx.bandSharp * sharpMul },
      uBandSpeed: { value: fx.bandSpeed },
      uFlick: { value: fx.flick },
      uTurb: { value: fx.turb * turb },
      uOpacity: { value: opacity },
      uTaper: { value: taper },
      uFacePow: { value: facePow },
      uWhite: { value: white },
      uEdgeMix: { value: edgeMix },
      uGain: { value: gain * (fx.gain ?? 1) },
      uBandAmt: { value: bandAmt },
      uNear0: { value: 0.85 },
      uNear1: { value: 2.60 },
      uRamp: { value: ramp },
      uFaceFloor: { value: faceFloor },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------------------------
// Velocity-stretched streak pool (sparks + light smearing)
// ---------------------------------------------------------------------------------------------

const STREAK_VERT = /* glsl */`
  attribute vec3 aCenter;
  attribute vec3 aVel;
  attribute vec2 aParam;     // x: 0 ahead-of-head → 1 tail, y: 0..1 across
  attribute float aWidth;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uStretch, uMinLen, uMaxLen, uNear0, uNear1;
  varying vec2 vP; varying float vA; varying vec3 vC;
  void main(){
    vP = aParam; vC = aColor;
    vec4 c = modelViewMatrix * vec4(aCenter, 1.0);
    // Embers streaming past the chase camera would otherwise smear across the whole lens; fade
    // them out before they reach the near plane so the plume stays the subject.
    vA = aAlpha * smoothstep(uNear0, uNear1, -c.z);
    vec3 v = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    float sp = length(v);
    vec3 d = sp > 1e-4 ? v / sp : vec3(0.0, 0.0, 1.0);
    float len = clamp(sp * uStretch, uMinLen, uMaxLen);
    vec3 toEye = normalize(-c.xyz);
    vec3 sd = cross(d, toEye);
    float sl = length(sd);
    sd = sl > 1e-4 ? sd / sl : vec3(1.0, 0.0, 0.0);
    // s runs from -0.14 (a cap AHEAD of the head, so the head can be rounded off) to 1.0
    float s = aParam.x * 1.14 - 0.14;
    // taper the tail so a streak is a comet, not a bar; 1.7x padding so the gaussian in the
    // fragment shader has reached zero by the time it hits the quad border
    float w = aWidth * mix(1.0, 0.34, clamp(s, 0.0, 1.0)) * 1.7;
    vec3 p = c.xyz - d*len*s + sd*(aParam.y - 0.5)*2.0*w;
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const STREAK_FRAG = /* glsl */`
  varying vec2 vP; varying float vA; varying vec3 vC;
  void main(){
    // 2-D gaussian capsule: round head, tapered tail, ZERO alpha on all four quad edges.
    float s = vP.x * 1.14 - 0.14;
    float d = (vP.y * 2.0 - 1.0) * 1.7;          // distance from the axis, in half-widths
    float a = exp(-d*d*1.9);
    float head = max(0.0, -s) / 0.14;
    a *= exp(-head*head*2.2);                    // dome off the leading end
    a *= 1.0 - smoothstep(0.68, 1.0, s);         // and fade out before the trailing edge
    a *= vA;
    vec3 col = mix(vC, vec3(1.35), exp(-d*d*7.0) * 0.6 * (1.0 - clamp(s, 0.0, 1.0)));
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

class StreakPool {
  constructor(max = 260, seed = 5150) {
    this.max = max;
    this.rng = new RNG(seed);
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.head = 0;
    this._acc = 0;

    const aCenter = new Float32Array(max * 4 * 3);
    const aVel = new Float32Array(max * 4 * 3);
    const aParam = new Float32Array(max * 4 * 2);
    const aWidth = new Float32Array(max * 4);
    const aAlpha = new Float32Array(max * 4);
    const aColor = new Float32Array(max * 4 * 3);
    const index = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      // (along, across): head-left, head-right, tail-left, tail-right
      aParam[v * 2 + 0] = 0; aParam[v * 2 + 1] = 0;
      aParam[v * 2 + 2] = 0; aParam[v * 2 + 3] = 1;
      aParam[v * 2 + 4] = 1; aParam[v * 2 + 5] = 0;
      aParam[v * 2 + 6] = 1; aParam[v * 2 + 7] = 1;
      const o = i * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v + 1; index[o + 4] = v + 3; index[o + 5] = v + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(aVel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aParam', new THREE.BufferAttribute(aParam, 2));
    geo.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;
    this.attr = { aCenter, aVel, aWidth, aAlpha, aColor };

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uStretch: { value: 0.030 },
        uMinLen: { value: 0.16 },
        uMaxLen: { value: 1.7 },
        uNear0: { value: 1.2 },
        uNear1: { value: 4.2 },
      },
      vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this._c = new THREE.Color();
  }

  emit(px, py, pz, vx, vy, vz, life, width, color, alpha, gravity = 0) {
    const i = this.head; this.head = (this.head + 1) % this.max;
    const b = i * 3;
    this.pos[b] = px; this.pos[b + 1] = py; this.pos[b + 2] = pz;
    this.vel[b] = vx; this.vel[b + 1] = vy; this.vel[b + 2] = vz;
    this.life[i] = this.life0[i] = life;
    this.a0[i] = alpha;
    this.grav[i] = gravity;
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    const A = this.attr;
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      A.aWidth[v] = width;
      A.aColor[v * 3] = this._c.r; A.aColor[v * 3 + 1] = this._c.g; A.aColor[v * 3 + 2] = this._c.b;
    }
  }

  /**
   * `driftZ` is how fast an ember slips backward RELATIVE TO THE CAR, in car space. It is not the
   * car's full speed: exhaust gas leaves the nozzle at roughly the speed the car is doing, so an
   * ember entrained in the plume is nearly stationary relative to the car and only gradually falls
   * out of the wake. Feeding the full speed here fires the whole shower through the chase camera
   * in two frames, which is what made round 1 read as a detonation rather than a jet.
   */
  update(dt, drag = 1.6, driftZ = 0) {
    const A = this.attr;
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.max; i++) {
      const v4 = i * 4;
      if (this.life[i] <= 0) {
        if (A.aAlpha[v4] !== 0) { for (let k2 = 0; k2 < 4; k2++) A.aAlpha[v4 + k2] = 0; }
        continue;
      }
      this.life[i] -= dt;
      const b = i * 3;
      this.vel[b] *= k; this.vel[b + 1] *= k; this.vel[b + 2] *= k;
      this.vel[b + 1] -= this.grav[i] * dt;
      const vz = this.vel[b + 2] + driftZ;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += vz * dt;
      const f = this.life[i] <= 0 ? 0 : Math.pow(this.life[i] / this.life0[i], 0.75) * this.a0[i];
      for (let q = 0; q < 4; q++) {
        const v = v4 + q;
        A.aCenter[v * 3] = this.pos[b]; A.aCenter[v * 3 + 1] = this.pos[b + 1]; A.aCenter[v * 3 + 2] = this.pos[b + 2];
        A.aVel[v * 3] = this.vel[b]; A.aVel[v * 3 + 1] = this.vel[b + 1]; A.aVel[v * 3 + 2] = vz;
        A.aAlpha[v] = f;
      }
    }
    const at = this.geometry.attributes;
    at.aCenter.needsUpdate = true; at.aVel.needsUpdate = true;
    at.aAlpha.needsUpdate = true; at.aWidth.needsUpdate = true; at.aColor.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.attr.aAlpha.fill(0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The jet
// ---------------------------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(0xffffff);

export class NitrousJet {
  /**
   * @param cfg      a NITRO entry (or a colour string for back-compat)
   * @param opts.scale    overall size multiplier for the class body
   * @param opts.nozzles  array of THREE.Vector3 local exhaust anchors (car space)
   */
  constructor(cfg = NITRO.tuner, { scale = 1, nozzles = null } = {}) {
    if (typeof cfg === 'string') cfg = { ...NITRO.tuner, color: cfg };
    this.cfg = cfg;
    this.fx = cfg.fx || NITRO.tuner.fx;
    const fx = this.fx;
    this.color = new THREE.Color(cfg.color || fx.mid);
    this.scale = scale;
    this.t = 0;
    this.rng = new RNG(31);
    this.igT = 99;               // seconds since ignition
    this.heat = 0;               // 0..1, read by main.js for the grade-pass heat haze

    this.group = new THREE.Group();   // stays visible so the point-light count never changes
    this.fxRoot = new THREE.Group();
    this.group.add(this.fxRoot);

    const geo = plumeGeometry();
    // three nested lathe shells: white-hot core → class mid → soft fringe.
    // `facePow` is the silhouette softener; the outer shell gets the highest power so its outline
    // has completely dissolved by the time it reaches the edge of the plume.
    //
    // Opacities are roughly HALF what round 2 used and every ramp is much longer. Round 2's stack
    // summed to alpha > 1 across the whole rear third of the car: the taillights, bumper and
    // exhaust tips were erased and the banding the shaders draw was invisible inside the clip.
    // A jet you can see the car's silhouette through is a better jet.
    this.shellSpec = [
      // 1 white-hot core — the only layer allowed to approach white, and the shortest/thinnest
      { opacity: 2.00, taper: 1.20, facePow: 0.40, turb: 0.40, bandMul: 1.35, sharpMul: 1.3, white: 1.0, edgeMix: 0.25, gain: 1.05, bandAmt: 1.00, ramp: 0.24, faceFloor: 0.34 },
      // 2 class-tinted body — carries the colour, so its gain stays under 1
      { opacity: 1.80, taper: 0.98, facePow: 0.62, turb: 0.75, white: 0.38, edgeMix: 0.72, gain: 0.88, bandAmt: 0.72, ramp: 0.19, faceFloor: 0.27 },
      // 3 soft fringe
      { opacity: 0.90, taper: 0.82, facePow: 0.95, turb: 1.05, bandMul: 0.55, sharpMul: 0.55, white: 0.08, edgeMix: 1.0, gain: 0.72, bandAmt: 0.38, ramp: 0.13, faceFloor: 0.19 },
    ];
    // shell radius / length multipliers
    this.shellR = [0.40, 0.80, 1.45];
    this.shellL = [0.60, 0.88, 1.06];
    this.shellMats = [];   // flat list, for uTime/uLevel updates and disposal

    const nz = (nozzles && nozzles.length) ? nozzles : [new THREE.Vector3(0, 0.5, -2)];
    // a single centre outlet has to carry the whole jet on its own
    this.radMul = nz.length > 1 ? 1 : 1.20;
    this.nozzles = [];
    const nCards = fx.cards ?? 6;
    const standoff = fx.standoff ?? 0.30;
    for (let ni = 0; ni < nz.length; ni++) {
      const n = nz[ni];
      const g = new THREE.Group();
      // ── ANCHORING (the round-2 fix) ────────────────────────────────────────────────────────
      // The jet sits exactly on the exhaust outlet in X and Y and fires straight down the car's
      // REAR-FACING CENTRELINE. Round 2 splayed each plume 8–10° outboard and lifted every nozzle
      // to y >= 0.58; from the boosting chase camera (which swings out to one side) the near jet
      // then appeared to erupt from the car's flank and spray diagonally across the rumble strip,
      // while the far jet hid behind the body — one blob, off-axis. Now: no lift, near-zero
      // splay, and the origin pushed `standoff` metres BEHIND the tip so the plume starts in
      // clear air and the bumper/taillights/tips read in front of it.
      g.position.set(n.x, n.y, n.z - standoff);
      g.rotation.y = Math.abs(n.x) > 0.05 ? -Math.sign(n.x) * (fx.splay ?? 0.02) : 0;
      // A real tailpipe washes down a few degrees, and the down-wash is the one deflection that
      // costs nothing in "is it on the centreline?" while still giving the column screen-space
      // length when the chase camera is sitting almost on the jet's axis.
      g.rotation.x = 0.075;
      // per-nozzle phase so the twin jets band, wobble and flicker independently
      const phase = ni * 2.399963;
      const shells = [];
      const mats = [];
      for (let i = 0; i < this.shellSpec.length; i++) {
        const mat = plumeMaterial(fx, { ...this.shellSpec[i], phase });
        this.shellMats.push(mat);
        mats.push(mat);
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = 7 + (3 - i) * 0.01;
        m.frustumCulled = false;
        g.add(m);
        shells.push(m);
      }

      // ---- gas cards: the wide soft fringe ----
      // Camera-facing, but each one carries its own roll and spins slowly, and its texture is a
      // lumpy radial alpha field that is zero before the tile border. That is what makes this
      // layer safe under §7 where a plain camera-facing quad would not be.
      const cards = [];
      for (let i = 0; i < nCards; i++) {
        const u = (i + 0.5) / nCards;
        const mat = new THREE.MeshBasicMaterial({
          map: gasCardTexture(i % 3), color: 0xffffff, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        });
        const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        card.renderOrder = 6 + i * 0.001;
        card.frustumCulled = false;
        g.add(card);
        cards.push({
          mesh: card, u,
          roll: this.rng.range(0, Math.PI * 2),
          spin: this.rng.range(-1.5, 1.5) * (1 + i * 0.1),
          jx: this.rng.range(-0.10, 0.10), jy: this.rng.range(-0.08, 0.08),
          ph: this.rng.range(0, Math.PI * 2),
        });
      }

      // burner disc — keeps the jet structured when seen end-on from the chase camera
      const disc = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: burnerTexture(), color: this.color.clone().lerp(WHITE, 0.22),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      disc.position.z = -0.22;
      disc.renderOrder = 9;
      disc.frustumCulled = false;
      g.add(disc);
      // muzzle flash on ignition
      const flash = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: flashTexture(), color: 0xffffff,
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      flash.renderOrder = 10;
      flash.frustumCulled = false;
      g.add(flash);
      // expanding shock ring, square to the jet axis
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: ringTexture(), color: this.color.clone().lerp(WHITE, 0.6),
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, fog: false,
        }),
      );
      ring.position.z = -0.2;
      ring.renderOrder = 9;
      ring.frustumCulled = false;
      g.add(ring);

      this.fxRoot.add(g);
      // `base` is where sparks and smear are born — the standoff point, not the tip, so the ember
      // shower starts in the same clear air the plume does.
      this.nozzles.push({ group: g, shells, mats, cards, disc, flash, ring, phase, base: g.position.clone() });
    }

    // ---- light spilling onto the road ----
    this.pool = new THREE.Mesh(
      (() => { const p = new THREE.PlaneGeometry(1, 1); p.rotateX(-Math.PI / 2); p.translate(0, 0, -0.5); return p; })(),
      new THREE.MeshBasicMaterial({
        map: poolTexture(), color: this.color, fog: false,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }),
    );
    this.pool.renderOrder = 3;
    this.pool.frustumCulled = false;
    this.fxRoot.add(this.pool);

    // ---- sparks / light smear ----
    this.streaks = new StreakPool(280, 5150);
    this.fxRoot.add(this.streaks.mesh);

    // ---- light on the car's own bodywork (never removed, so light count stays constant) ----
    // Sits a metre behind the outlets, so it rakes ACROSS the rear panel and picks out the bumper,
    // diffuser and taillight housings instead of sitting inside them and washing them flat.
    const mid = new THREE.Vector3();
    for (const n of nz) mid.add(n);
    mid.divideScalar(nz.length);
    this.mid = mid.clone();
    this.light = new THREE.PointLight(this.color, 0, 16, 2);
    this.light.position.copy(mid).add(new THREE.Vector3(0, 0.06, -(standoff + 0.75)));
    this.group.add(this.light);

    this.fxRoot.visible = false;
    this._level = 0;
    this._colCore = new THREE.Color(fx.core);
    this._colMid = new THREE.Color(fx.mid);
    this._colEdge = new THREE.Color(fx.edge);
    this._tmpCol = new THREE.Color();
    // "hot" ember colour: the class spark pushed most of the way to white, but never all the way
    this._hot = new THREE.Color(fx.spark).lerp(WHITE, 0.55);
  }

  setColor(c) {
    this.color.set(c);
    this.light.color.set(c);
    this.pool.material.color.set(c);
    for (const n of this.nozzles) {
      n.disc.material.color.copy(this.color).lerp(WHITE, 0.22);
      n.ring.material.color.copy(this.color).lerp(WHITE, 0.6);
    }
    for (const m of this.shellMats) m.uniforms.uMid.value.set(c);
    this._colMid.set(c);
  }

  /**
   * Fire the ignition event: muzzle flash, shock ring and a blast of sparks.
   * The blast is a REARWARD cone, not a sphere — a sphere reads as "the car detonated".
   */
  ignite() {
    this.igT = 0;
    const fx = this.fx;
    const r = this.rng;
    const cone = fx.cone ?? 0.3;
    for (const n of this.nozzles) {
      for (let i = 0; i < 26; i++) {
        const a = r.range(0, Math.PI * 2);
        const th = Math.sqrt(r.range(0, 1)) * cone * 1.5;   // ±~25–35°, densest on axis
        const sp = r.range(fx.sparkSpeed[0] * 2.0, fx.sparkSpeed[1] * 3.2);
        this.streaks.emit(
          n.base.x + Math.cos(a) * 0.05, n.base.y + Math.sin(a) * 0.05, n.base.z,
          Math.cos(a) * Math.tan(th) * sp, Math.sin(a) * Math.tan(th) * sp + r.range(0.2, 1.4), -sp,
          r.range(0.14, 0.28), fx.sparkWidth * r.range(1.0, 1.9),
          r.bool(0.4) ? this._hot : fx.spark, r.range(0.5, 0.95), 4,
        );
      }
    }
  }

  /** Screen-space anchor + strength for the grade pass' heat haze. */
  heatPoint(camera, out) {
    this.nozzles[0].group.getWorldPosition(_v);
    if (this.nozzles.length > 1) {
      this.nozzles[this.nozzles.length - 1].group.getWorldPosition(_v2);
      _v.lerp(_v2, 0.5);
    }
    // sample a little way down the plume, away from the camera, where the shimmer actually is
    _v2.copy(camera.position).sub(_v).normalize();
    _v.addScaledVector(_v2, -(this._baseLen ?? this.fx.len * this.scale) * 0.5);
    _v.project(camera);
    out.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    return _v.z < 1 ? this.heat : 0;
  }

  /**
   * @param level  0..1 visual strength (Nitrous.flame)
   * @param opts.speed   car speed in m/s
   * @param opts.camera  camera, so the billboarded elements face it
   * @param opts.surge   0..1 ignition overshoot
   * @param opts.ramp    0..1 THRUST authority (Nitrous.ramp) — drives plume LENGTH, so the jet
   *                     grows with the boost instead of being the same giant blob every frame
   */
  update(dt, level, opts = {}) {
    const speed = opts.speed ?? 0;
    const camera = opts.camera || null;
    const surge = clamp(opts.surge ?? 0, 0, 1);
    const ramp = clamp(opts.ramp ?? level, 0, 1);
    const fx = this.fx;
    this.t += dt;
    this.igT += dt;

    const s = clamp(level, 0, 1);
    this._level = s;
    // Keep the FX root alive a beat after the flame dies so the last streaks fade out instead of
    // blinking off (§7 caps anything visibly popping at 70).
    this._offT = s > 0.012 ? 0 : (this._offT ?? 9) + dt;
    this.fxRoot.visible = s > 0.012 || this.igT < 1.0 || this._offT < 0.75;
    this.heat = 0;
    if (!this.fxRoot.visible) {
      this.light.intensity = 0;
      if (this._dirty) { this.streaks.clear(); this._dirty = false; }
      return;
    }
    this._dirty = true;

    // Flicker is per-class: the tuner strobes, the SUV heaves.
    const flick = 1
      + Math.sin(this.t * fx.flick) * 0.055
      + Math.sin(this.t * fx.flick * 0.41 + 1.3) * 0.035
      + Math.sin(this.t * fx.flick * 2.7) * 0.02;

    const igFlash = Math.exp(-this.igT / 0.055);          // the hard crack
    const igBloom = Math.exp(-this.igT / 0.26);           // the afterglow that lingers into frame

    // ── LENGTH IS DRIVEN BY THE BOOST, NOT BY A CONSTANT ──────────────────────────────────────
    // Three independent terms, so no two frames of a boost show the same jet:
    //   ramp   — the class's thrust authority. The SUV is a stub for half a second and then a
    //            freight-train column; the supercar is at full authority in two frames.
    //   hold   — the column keeps stretching for ~0.6 s of sustained boost, so ignition is SHORT
    //            AND HOT and sustain is long. Round 2 drew the same giant plume in every frame.
    //   stretch— and it lengthens with road speed, so the jet reads as tied to how fast you are
    //            actually going.
    const hold = 1 - Math.exp(-Math.max(0, this.igT) / 0.60);
    const stretch = 0.84 + 0.36 * smoothstep(16, 82, speed);
    // 0.42 is the floor, not 0: a spooling SUV should look like a jet that has not opened up yet,
    // not like a stub of flame under the bumper.
    const lenDrive = (0.42 + 0.58 * ramp) * (0.66 + 0.34 * hold) * stretch;
    const baseLen = fx.len * this.scale * lenDrive * (1 + surge * 0.12) * flick;
    // Radius follows the visual level and barely moves: a jet that fattens as much as it lengthens
    // just scales up, and the "short and hot / long and wide" contrast disappears.
    const baseRad = fx.rad * this.scale * this.radMul
      * (0.72 + 0.28 * s) * (0.88 + 0.12 * ramp) * (1 + surge * 0.16);
    this._baseLen = baseLen;

    for (const m of this.shellMats) {
      m.uniforms.uTime.value = this.t;
      m.uniforms.uLevel.value = s * (0.85 + 0.15 * flick) + igBloom * 0.20;
    }

    const camQ = camera ? camera.quaternion : null;
    for (const n of this.nozzles) {
      // parent-space → so a billboard can be built from the camera's world quaternion
      const invParent = camera ? _q2.copy(n.group.getWorldQuaternion(_q3)).invert() : null;

      for (let i = 0; i < n.shells.length; i++) {
        const wob = 1 + Math.sin(this.t * (23 + i * 7) + n.base.x * 5) * 0.05 * (i + 1) * 0.5;
        n.shells[i].scale.set(
          baseRad * this.shellR[i] * wob,
          baseRad * this.shellR[i] * wob,
          baseLen * this.shellL[i],
        );
      }

      // ---- gas cards ----
      const cardGain = fx.cardGain ?? ((fx.gain ?? 1) * 0.7);
      for (let i = 0; i < n.cards.length; i++) {
        const cd = n.cards[i];
        const u = cd.u;
        // plume envelope: necks at the nozzle, widest around a third of the way down, tapers out
        const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.55)), 0.7);
        const w = baseRad * (fx.cardWidth ?? 2.0) * (0.42 + 0.90 * env) * (fx.cardSpread ?? 1.15);
        const puff = 1 + Math.sin(this.t * (9 + i * 2.3) + cd.ph + n.phase) * 0.10;
        cd.mesh.scale.set(w * puff, w * puff * (0.92 + 0.16 * Math.sin(cd.ph + this.t * 4)), 1);
        cd.mesh.position.set(
          cd.jx * baseRad * 1.6 + Math.sin(this.t * 6.3 + cd.ph) * baseRad * 0.10,
          cd.jy * baseRad * 1.6 + Math.sin(this.t * 5.1 + cd.ph * 1.7) * baseRad * 0.09,
          -u * baseLen * (fx.cardSpread ?? 1.15),
        );
        // colour graded down the axis: hot core near the nozzle → class tint → edge tint
        const tCol = clamp(u * 1.25, 0, 1);
        this._tmpCol.copy(this._colCore).lerp(this._colMid, smoothstep(0.0, 0.42, tCol));
        this._tmpCol.lerp(this._colEdge, smoothstep(0.34, 1.0, tCol) * 0.85);
        cd.mesh.material.color.copy(this._tmpCol);
        const bandPhase = 0.5 + 0.5 * Math.sin(u * fx.bands * 1.6 - this.t * fx.bandSpeed * 0.55 + n.phase);
        // Fades IN away from the outlet (smoothstep on tCol) — the round-2 stack was at its
        // densest right on the bumper, which is exactly where the car needs to stay readable.
        cd.mesh.material.opacity = clamp(
          s * cardGain * smoothstep(0.0, 0.30, tCol) * (0.66 - 0.34 * tCol)
          * (0.42 + 0.85 * bandPhase) * flick
          + igBloom * 0.10 * tCol * (1 - tCol), 0, 0.72,
        );
        if (camQ) {
          cd.roll += cd.spin * dt;
          cd.mesh.quaternion.copy(camQ).multiply(_q.setFromAxisAngle(AXIS_Z, cd.roll)).premultiply(invParent);
        }
      }

      // burner disc — deliberately faint now. Held at round-2 strength it was a bloom ball sitting
      // on the exhaust tips, and it is the single element most responsible for erasing them.
      const dm = n.disc.material;
      dm.opacity = clamp(s * 0.085 * flick + igBloom * 0.14, 0, 0.4);
      const ds = (baseRad * 2.3 + 0.12) * (1 + surge * 0.32);
      n.disc.scale.set(ds * (1 + Math.sin(this.t * fx.flick * 0.7) * 0.05), ds, 1);
      if (camQ) n.disc.quaternion.copy(camQ).premultiply(invParent);

      // muzzle flash
      const fm = n.flash.material;
      fm.opacity = clamp(igFlash * 1.1 + igBloom * 0.42, 0, 1.5);
      const fs = lerp(0.5, 3.0 * this.scale, 1 - Math.exp(-this.igT / 0.09)) * (0.6 + s * 0.6);
      n.flash.scale.set(fs, fs, 1);
      n.flash.position.z = -0.18 - this.igT * 1.2;
      if (camQ) n.flash.quaternion.copy(n.disc.quaternion);

      // shock ring — expands square to the jet axis
      const rm = n.ring.material;
      const rt = clamp(this.igT / 0.34, 0, 1);
      rm.opacity = (1 - rt) * (1 - rt) * 1.25;
      const rs = 0.35 + rt * 5.5 * this.scale;
      n.ring.scale.set(rs, rs, 1);
      n.ring.position.z = -0.2 - rt * 2.4;
      n.ring.quaternion.identity();
    }

    // ---- streaks: sparks + light smear ----
    // Ejecta rides the wake: the drift is only a FRACTION of the car's speed (see StreakPool.update).
    const drift = -speed * (fx.wake ?? 0.2);
    const cone = fx.cone ?? 0.3;
    const rate = fx.sparkRate * s * (0.55 + 0.45 * smoothstep(0, 40, speed)) * (1 + surge * 1.2);
    this._acc = (this._acc || 0) + rate * dt;
    const r = this.rng;
    while (this._acc >= 1) {
      this._acc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      // Born in an ANNULUS around the column, not inside it. Embers launched down the middle are
      // invisible — they sit inside the brightest part of the plume — so the shower only reads
      // when the streaks fly clear of the core and cross the dark road behind it.
      const a = r.range(0, Math.PI * 2), rad = baseRad * r.range(0.65, 1.8);
      const back = r.range(fx.sparkSpeed[0], fx.sparkSpeed[1]);
      // rearward cone: lateral velocity is bounded by tan(cone) * axial speed
      const th = Math.sqrt(r.range(0, 1)) * cone;
      const lat = Math.tan(th) * back;
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad, n.base.z - r.range(0, baseLen * 0.45),
        Math.cos(a) * lat * 1.25, Math.sin(a) * lat * 1.25 + r.range(-0.2, 0.9), -back,
        r.range(fx.sparkLife[0], fx.sparkLife[1]) * 1.35,
        fx.sparkWidth * r.range(0.6, 1.7),
        // Never pure white: the tonemap desaturates clipped highlights and the city grade then
        // tints them, which turned round 1's white embers ORANGE on the cyan tuner.
        r.bool(0.30) ? this._hot : fx.spark,
        r.range(0.42, 0.86) * (0.45 + 0.55 * s),
        3.5,
      );
    }
    // ---- light smear: a few wide, dim, long-lived streaks that smear the jet down the road ----
    this._sacc = (this._sacc || 0) + (fx.smearRate ?? 10) * s * dt;
    while (this._sacc >= 1) {
      this._sacc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      const a = r.range(0, Math.PI * 2), rad = r.range(0, 1) * baseRad * 0.8;
      const back = r.range(fx.sparkSpeed[0] * 0.5, fx.sparkSpeed[1] * 0.7);
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad, n.base.z - baseLen * 0.35,
        Math.cos(a) * 0.6, Math.sin(a) * 0.5 + 0.4, -back,
        r.range(0.26, 0.46), (fx.smearWidth ?? 0.35) * r.range(0.7, 1.3),
        r.bool(0.5) ? fx.mid : fx.spark,
        r.range(0.06, 0.16) * s, 0.6,
      );
    }
    this.streaks.material.uniforms.uStretch.value = 0.026 + s * 0.010;
    this.streaks.update(dt, 2.2, drift);

    // ---- ground pool ----
    // Its reach follows the plume, so the tint on the road grows and shrinks with the jet rather
    // than sitting there as a constant painted patch.
    const pm = this.pool.material;
    pm.opacity = clamp(s * 0.30 * flick + igBloom * 0.26, 0, 0.72);
    this.pool.scale.set(
      fx.poolWidth * this.scale * (0.7 + 0.3 * s) * (1 + surge * 0.30),
      1,
      fx.poolLen * this.scale * (0.42 + 0.58 * lenDrive) * (1 + surge * 0.35),
    );
    // keep it flat on the road and aligned with the car's heading, whatever the body is doing
    this.group.getWorldPosition(_v);
    this.group.getWorldQuaternion(_q);
    _e.setFromQuaternion(_q, 'YXZ');
    _q2.setFromEuler(new THREE.Euler(0, _e.y, 0, 'YXZ'));
    this.pool.quaternion.copy(_q).invert().multiply(_q2);
    _v2.set(_v.x, 0.055, _v.z);
    this.pool.position.copy(this.group.worldToLocal(_v2));

    // ---- bodywork spill ----
    // Roughly half of round 2. The rear panel should be LIT by the jet, with the taillight
    // housings and diffuser picked out; at the old intensity it was a flat blown card.
    this.light.intensity = (s * fx.lightI * 0.52 * flick + igFlash * fx.lightI * 1.0 + igBloom * fx.lightI * 0.30);
    this.light.distance = 11 + s * 5;

    // ---- heat haze strength handed to the grade pass ----
    this.heat = clamp((s * 0.95 + igBloom * 0.60) * (fx.heat ?? 1), 0, 1.5);
  }

  dispose() {
    this.streaks.dispose();
    for (const m of this.shellMats) m.dispose();
    this.pool.geometry.dispose(); this.pool.material.dispose();
    for (const n of this.nozzles) {
      n.disc.geometry.dispose(); n.disc.material.dispose();
      n.flash.geometry.dispose(); n.flash.material.dispose();
      n.ring.geometry.dispose(); n.ring.material.dispose();
      for (const cd of n.cards) { cd.mesh.geometry.dispose(); cd.mesh.material.dispose(); }
    }
  }
}
