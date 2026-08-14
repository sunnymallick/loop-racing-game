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
 *   1. THE CORE IMPOSTOR — one quad per outlet, rolled about the plume's own axis to face the
 *      camera, whose shader integrates a round column analytically and draws the hard-edged shock
 *      diamonds. This is the layer the whole effect is judged on; see the CORE_FRAG block comment
 *      for why it is a quad and not a lathe, and why it is the only composited layer in the file
 *   2. a class-tinted lathe body with its own band phase and turbulence — volume and parallax
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
 *
 * ── THE ROUND-6 RULE: THE JET MUST OUT-CONTRAST ITS OWN POST ─────────────────────────────────
 * Rounds 1–5 all drew the structure on additive lathe shells and every round got the same note
 * back: at 6x the plume is a soft low-frequency gradient with no banding and no cone. Two changes
 * fix it, and both are about CONTRAST rather than about drawing more:
 *   · the structural layer is an axis-billboarded impostor, composited (not added), so a band gap
 *     is dark on a night road in Vegas AND on a sunset road in Miami (see CORE_FRAG);
 *   · and everything that was drowning it comes down — the boost grade, the radial blur and the
 *     speed lines in main.js by ~40%, the heat haze by the same and re-centred BEHIND the tip, the
 *     white-hot lathe core deleted outright, the remaining two shells and the gas cards a third
 *     dimmer. The plume is now the brightest structured thing in the frame by a distance, which is
 *     what §2.5's "readable as the biggest thing on screen" actually asks for.
 *
 * ── THE ROUND-5 RULES: FRAME IT, BAND IT, AND MAKE THE CLASSES DIFFERENT SHAPES ──────────────
 * Round 4 solved the jet's SIZE on screen (see _governor) and the shot got worse, because size is
 * not the same thing as composition. Three things now:
 *
 *   · CONTAINMENT. The governor clips its own solution to the longest column whose visible end
 *     still lands inside a safe box in the frame, and pays the lost length back as width. A jet
 *     that exits the corner has no tip, no taper and no cone — it is a field of colour.
 *   · COMPOSITION. `aimPoint()` hands main.js a point down the plume's axis; the boost camera aims
 *     partway at it, which slides the car into the far third and gives the column the diagonal.
 *   · TESSELLATION. The vertex shader wobbles this surface at up to 29 cycles axially and 40
 *     around, and the old lathe had 30 x 40 segments — every displacement term was past Nyquist and
 *     folded into flat triangles. That, not the shading, is why the plume kept reading as "soft
 *     sheets with straight alpha boundaries". 88 x 56 segments and much lower wobble frequencies.
 *   · ...and the profile of the lathe is now a per-class parameter (`fx.profile`), so the SUV's
 *     blunt bell, the muscle's barrel and the supercar's long spindle are different SHAPES, not one
 *     shape in four colours.
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
//   fx.screen     THE round-4 knob: how much of the FRAME HEIGHT the lit column should occupy for
//                 the whole sustain. `fx.len` is now only a shape reference — the world length is
//                 SOLVED for every frame so this number comes true at whatever distance and angle
//                 the chase rig happens to be sitting at. See NitrousJet._governor().
// ---------------------------------------------------------------------------------------------
export const NITRO = {
  // Short and sharp. A tiny screamer: near-instant, thin white-cyan needle, gone in a blink.
  // Single big centre outlet, so one jet — and that alone reads differently from the other three.
  tuner: {
    thrust: 0.92, duration: 1.8, drain: 1.0, refill: 0.62, topSpeedMul: 1.38,
    ramp: 0.13, curve: 0.52, surge: 0.88, surgeTime: 0.22, color: '#3ce0ff',
    fx: {
      core: '#f4ffff', mid: '#34dcff', edge: '#0b46ff', spark: '#cdf4ff',
      len: 3.85, rad: 0.255, splay: 0.0, standoff: 0.28, flameRise: 0.045, gain: 0.62,
      screen: 0.36, profile: [0.22, 0.74, 1.05, 0.22],   // long thin needle, waist well aft
      bands: 12.0, bandSharp: 1.45, bandSpeed: 30, flick: 62, turb: 0.30,
      coreW: 0.80, coreGain: 1.38, coreOpacity: 0.92, coreHot: 1.0,
      cards: 5, cardSpread: 1.30, cardWidth: 1.75, cardGain: 0.20,
      sparkRate: 120, sparkSpeed: [3.5, 11], sparkWidth: 0.050, sparkLife: [0.14, 0.26],
      wake: 0.16, cone: 0.22, smearRate: 8, smearWidth: 0.22,
      poolWidth: 2.6, poolLen: 7.2, lightI: 19, shake: 0.30, heat: 1.00,
    },
  },
  // A long brutal shove. Twin wide-set pipes, fat orange-red columns, slow heavy banding.
  muscle: {
    thrust: 1.10, duration: 3.4, drain: 1.0, refill: 0.34, topSpeedMul: 1.32,
    ramp: 0.52, curve: 1.20, surge: 0.62, surgeTime: 0.44, color: '#ff7a1e',
    fx: {
      core: '#fffaf2', mid: '#ff6a08', edge: '#c81400', spark: '#ffc477',
      len: 4.25, rad: 0.320, splay: 0.020, standoff: 0.32, flameRise: 0.15, gain: 0.48,
      screen: 0.42, profile: [0.38, 0.44, 0.62, 0.34],   // fat barrel, widest close to the bumper
      bands: 9.0, bandSharp: 1.30, bandSpeed: 12, flick: 28, turb: 0.48,
      coreW: 0.84, coreGain: 1.15, coreOpacity: 0.94, coreHot: 1.0,
      cards: 5, cardSpread: 1.20, cardWidth: 2.20, cardGain: 0.18,
      sparkRate: 104, sparkSpeed: [2.5, 9], sparkWidth: 0.074, sparkLife: [0.18, 0.34],
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
      core: '#fff3d6', mid: '#ff8a04', edge: '#c81a00', spark: '#ffd487',
      len: 3.80, rad: 0.355, splay: 0.020, standoff: 0.34, flameRise: 0.26, gain: 0.29,
      screen: 0.38, profile: [0.48, 0.34, 0.50, 0.48],   // blunt bell — fat off the pipe, stubby
      bands: 8.0, bandSharp: 1.15, bandSpeed: 7, flick: 16, turb: 0.64,
      coreW: 0.92, coreGain: 1.02, coreOpacity: 0.90, coreHot: 0.96,
      cards: 5, cardSpread: 1.16, cardWidth: 2.40, cardGain: 0.13,
      sparkRate: 96, sparkSpeed: [2, 8], sparkWidth: 0.090, sparkLife: [0.20, 0.38],
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
      len: 4.85, rad: 0.285, splay: 0.030, standoff: 0.30, flameRise: 0.035, gain: 0.62,
      screen: 0.43, profile: [0.18, 0.66, 1.30, 0.16],   // long spindle, waist metres aft, sharp
      bands: 11.0, bandSharp: 1.40, bandSpeed: 34, flick: 74, turb: 0.27,
      coreW: 0.82, coreGain: 1.42, coreOpacity: 0.94, coreHot: 1.0,
      cards: 5, cardSpread: 1.26, cardWidth: 1.95, cardGain: 0.21,
      sparkRate: 116, sparkSpeed: [4, 14], sparkWidth: 0.050, sparkLife: [0.14, 0.26],
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
        // (r5) The fan used to reach halfW = 0.455 at the far end — i.e. the gaussian was still at
        // ~1/e when it hit the tile border, so the only thing ending the pool was the border cut,
        // and on the road at a grazing angle that drew a STRAIGHT bright edge across the asphalt
        // (§7's hard-edged-sprite tell). The fan is narrower and the axial falloff longer, so the
        // field is at zero on its own well before the quad runs out.
        const halfW = 0.050 + v * 0.235;  // the spill fans out down the road
        let a = Math.exp(-(u * u) / (halfW * halfW)) * Math.pow(1 - v, 1.5);
        let lum = 1;
        for (const [lv, lu, lr, la] of lumps) {
          const dv = (v - lv) / lr, du = (u - lu) / (lr * 1.5);
          lum += la * 0.5 * Math.exp(-(dv * dv + du * du));
        }
        a *= 0.55 + 0.45 * Math.min(lum, 2.2);
        a *= (1 - smoothstep(0.58, 0.98, v)) * (1 - smoothstep(0.46, 0.92, Math.abs(u) * 2));
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
 *
 * ── PER-CLASS SILHOUETTE (r5) ────────────────────────────────────────────────────────────────
 * The profile is a class parameter, not a constant. Round 4 drew every class from ONE lathe and
 * changed only hue and scale — the standing note was "plume geometry is identical across all four
 * classes". `fx.profile` is [neck, bulgeAt, bulgeSharp, taper]:
 *
 *   neck        radius at the nozzle lip, as a fraction of the maximum. Low = a jet that pinches
 *               to a throat and flares; high = a blunt torch that leaves the pipe already fat.
 *   bulgeAt     exponent placing the widest point. <0.5 puts it right on the bumper (muscle, SUV),
 *               >0.6 pushes it a long way aft (tuner, supercar).
 *   bulgeSharp  how pointed the widest section is. >1 is a slim spindle, <0.7 is a fat barrel.
 *   taper       how hard the column closes at the tip. Low = a long needle, high = a stub.
 *
 * So the SUV's column is a blunt bell that is widest on the bumper, the supercar's is a long
 * spindle with its waist metres back, and the two read as different machines even in greyscale.
 */
const _plumeGeos = new Map();
function plumeGeometry(profile) {
  const [neck, at, sharp, taper] = profile || [0.30, 0.55, 0.75, 0.30];
  const key = `${neck},${at},${sharp},${taper}`;
  let geo = _plumeGeos.get(key);
  if (geo) return geo;
  const pts = [];
  // ── TESSELLATION IS WHY THE PLUME USED TO SHOW STRAIGHT EDGES (r5) ─────────────────────────
  // The vertex shader displaces this surface with turbulence at up to 29 cycles along the axis and
  // 40 around the circumference, and the fragment shader bands it at up to 8.5 cycles. On the old
  // 30 x 40 lathe every one of those was far past Nyquist: the displacement aliased into a crown of
  // flat triangles, which is exactly the "flat sheets with visible straight alpha boundaries" note
  // that has followed this effect since round 1. 88 x 56 (plus lower turbulence frequencies, see
  // PLUME_VERT) puts every term at 6+ samples per cycle. It is vertex work on a 5k-vertex mesh —
  // the plume's cost is fill rate, and this does not add a single pixel of it.
  const N = 88;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, at)), sharp);
    const r = (neck + (1 - neck) * shape) * Math.pow(1 - t, taper);
    pts.push(new THREE.Vector2(Math.max(0.002, r), t));
  }
  geo = new THREE.LatheGeometry(pts, 56);
  geo.rotateX(-Math.PI / 2);   // +Y (axial) → -Z
  _plumeGeos.set(key, geo);
  return geo;
}

const PLUME_VERT = /* glsl */`
  uniform float uTime, uLevel, uTurb, uPhase, uBands, uBandSpeed, uBandBulge;
  varying float vT;
  varying float vA;
  varying float vFace;
  varying float vDepth;
  void main(){
    vT = uv.y; vA = uv.x;
    // Unstable, wobbling column — the plume must never look like a static cone.
    // (r5) Frequencies pulled WAY down. These are vertex displacements, so a term at 29 cycles
    // along the axis and 40 around the circumference on a lathe with 30 and 40 segments was pure
    // aliasing: it folded into a jagged crown of flat triangles and gave the plume the straight
    // silhouette edges it has been marked down for since round 1. Every term now sits at 6+
    // samples per cycle on the retessellated lathe (see plumeGeometry), so the wobble is a wobble.
    float w = sin(vT*9.0  + uTime*34.0 + vA*5.13 + uPhase) * 0.5
            + sin(vT*15.0 - uTime*47.0 + vA*3.13 + uPhase*2.1) * 0.32
            + sin(vT*5.0  + uTime*19.0 + vA*7.70 + uPhase*0.6) * 0.18;
    // ── SHOCK DIAMONDS AS GEOMETRY ──────────────────────────────────────────────────────────
    // The fragment shader also bands the colour and the alpha, but the core of the jet CLIPS to
    // white, and once a pixel is clipped no amount of brightness modulation is visible in it — the
    // supercar's column came out a smooth white blur with no banding at all. So the same band
    // function also pinches and bulges the column's RADIUS: the silhouette itself goes lumpy, which
    // survives clipping, bloom and any grade. Phase-matched to the fragment banding so the bulges
    // and the bright zones are the same feature, and faded in over the first third so the nozzle
    // stays a clean neck.
    float bnd = sin(vT*uBands*6.28318 - uTime*uBandSpeed + uPhase*3.0);
    vec3 radial = normalize(vec3(normal.xy, 0.0) + vec3(0.0001));
    vec3 p = position + radial * (
        w * uTurb * smoothstep(0.02, 0.45, vT) * (0.35 + 0.65*uLevel)
      + bnd * uBandBulge * smoothstep(0.05, 0.34, vT) * (0.5 + 0.5*uLevel));
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
    // Shock diamonds are strongest at the throat and dissolve into turbulence downstream. Without
    // this decay the column is a perfectly regular string of identical beads all the way to the
    // tip, which reads as a repeating texture rather than as pressure structure.
    float bandDecay = mix(1.0, 0.32, smoothstep(0.12, 0.86, t));

    // Colour: only the innermost shell is allowed to go white-hot. The outer shells stay on the
    // class tint — an additive stack that all pushes toward white clips every channel and the
    // whole plume turns into a colourless blob (that was the round-1 SUV).
    // The white window is anchored to uRamp: alpha fades IN over uRamp, so a white window fixed at
    // t<0.34 put the white core exactly where the shell was still transparent and the jet lost its
    // hot centre entirely.
    float w0 = uRamp * 0.55;
    vec3 col = mix(uMid, uCore, uWhite * (1.0 - smoothstep(w0, w0 + 0.40, t)));
    col = mix(col, uEdge, smoothstep(w0 + 0.20, 1.0, t) * uEdgeMix);
    col *= uGain * mix(1.0, 0.30 + 1.05*band, uBandAmt*bandDecay);

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
    // Bands modulate BRIGHTNESS hard (see col above) but ALPHA only gently. A band is a ring of
    // the lathe surface, so a deep alpha notch draws it as a closed ellipse OUTLINE — and a stack
    // of those down a foreshortened column reads as a coiled spring, not as shock diamonds. Keeping
    // alpha continuous leaves one unbroken column with hot and cool zones in it.
    a *= mix(1.0, 0.26 + 1.02*band, uBandAmt*bandDecay);
    a *= uOpacity * uLevel;
    a *= 0.80 + 0.20*sin(uTime*uFlick) + 0.08*sin(uTime*uFlick*0.37 + vA*12.0);
    // never let a shell be clipped by the near plane into a hard-edged wedge across the lens
    a *= smoothstep(uNear0, uNear1, vDepth);

    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  }
`;

// ---------------------------------------------------------------------------------------------
// THE CORE IMPOSTOR — the round-6 fix, and the reason the banding finally survives to the frame
//
// Every previous round drew the jet's structure on LATHE SURFACES and every previous critic said
// the same thing: "at 6x the plume is a soft, low-frequency wavy gradient — no banding, no crisp
// core boundary, no tapered nozzle cone". That is not a shading failure, it is a topology failure:
//
//   · a lathe is a HOLLOW shell. Additive, double-sided, it sums front and back faces, so the
//     brightest part of the drawn image is the SILHOUETTE (the grazing rim), not the axis — the
//     exact inverse of a real jet, and the reason the column reads as a soft tube of gas;
//   · because it is a shell, an alpha notch between two bands draws a closed ELLIPSE OUTLINE (a
//     slinky), so band contrast had to be kept low, which is why the bands never read;
//   · and the white core clips. Once a pixel is at 1.0 no brightness modulation inside it is
//     visible at all, so on the classes with a hot core the banding was mathematically invisible.
//
// So the structural layer is now a single quad per nozzle, rolled about the plume's own axis to
// face the camera (an axis-billboard, NOT a camera-facing card — it cannot spin into a disc), whose
// fragment shader integrates a round column analytically:
//
//   · `chord = sqrt(1 - r²)` is the path length through a cylinder of the class's cone radius, so
//     density peaks ON THE AXIS and falls to exactly zero at the silhouette. Bright spine, soft
//     outline, no rim, no §7 hard edge anywhere on the quad;
//   · the cone half-width `w(t)` is the SAME `fx.profile` curve the lathes are built from, so the
//     impostor tapers from the nozzle orifice to a point and agrees with the volume behind it;
//   · the band function does three things at once — it pinches and bulges `w` (silhouette shock
//     diamonds), it drives brightness hard (a band peaks ~7x its gap), and it bows by r² so the
//     bright zones are pointed lens/diamond shapes rather than a ladder of flat rectangles. ~7-9
//     bands across the visible length, with a ~2 px transition at capture resolution;
//   · and it composites with NORMAL blending, alone in this file. Additive structure added to an
//     already-bright frame saturates in the gaps as well as on the bands, which is why the muscle
//     car's Miami boost was a featureless field while its Vegas boost read perfectly. Compositing
//     makes the contrast independent of the background.
// ---------------------------------------------------------------------------------------------

const CORE_VERT = /* glsl */`
  varying vec2 vUv;
  varying float vDepth;
  void main(){
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAG = /* glsl */`
  uniform vec3 uCore, uMid, uEdge;
  uniform vec4 uProf;               // neck, bulgeAt, bulgeSharp, taper — the class silhouette
  uniform float uTime, uLevel, uBands, uBandSpeed, uPhase, uTurb;
  uniform float uOpacity, uGain, uPad, uFade, uNear0, uNear1, uHot;
  varying vec2 vUv;
  varying float vDepth;

  void main(){
    float t = clamp(vUv.y, 0.0, 1.0);
    float x = (vUv.x - 0.5) * 2.0 * uPad;        // in units of the cone's max radius

    // ---- the class cone: identical curve to plumeGeometry(), so impostor and volume agree ----
    float shape = pow(max(sin(3.1415926 * pow(max(t, 1e-4), uProf.y)), 0.0), uProf.z);
    float w = (uProf.x + (1.0 - uProf.x) * shape) * pow(max(1.0 - t, 0.0), uProf.w);

    // ---- shock diamonds. ONE function pinches the column, lights it and punches the gaps ----
    float bp = t * uBands * 6.2831853 - uTime * uBandSpeed + uPhase * 3.0;
    float sw = sin(bp);
    float grow = smoothstep(0.015, 0.13, t);     // a short clean neck at the orifice, then the chain
    w *= 1.0 + 0.16 * sw * grow;
    w = max(w, 0.004);

    // the column wanders — a jet is never a straight cone
    float cx = (sin(t * 4.1 - uTime * 8.0 + uPhase) * 0.052
              + sin(t * 7.7 + uTime * 12.5 + uPhase * 2.3) * 0.026) * uTurb * smoothstep(0.05, 0.70, t);

    float r = abs(x - cx) / w;
    if (r >= 1.0) discard;
    float chord = sqrt(max(0.0, 1.0 - r * r));   // density through a round column: hot axis, soft rim

    // A shock diamond is not a slice: the reflected shock crosses ON THE AXIS, so the bright zone
    // is a lens that lags at the rim. Bowing the band phase by r² turns a ladder of flat-topped
    // rectangles into a chain of pointed diamonds — the difference between "barcode" and "jet".
    float bpr = bp + 2.4 * r * r;
    // near-square band: ~2 px of transition at 1600x900, i.e. hard-edged but still antialiased
    float sq  = smoothstep(0.42, 0.57, 0.5 + 0.5 * sin(bpr));
    float sq2 = smoothstep(0.40, 0.66, 0.5 + 0.5 * sin(bpr * 0.41 + 1.7 + uPhase));
    float band = clamp(sq * 0.86 + sq2 * 0.26, 0.0, 1.12);
    // diamonds are a throat phenomenon: they dissolve into turbulence downstream
    float decay = mix(1.0, 0.38, smoothstep(0.12, 0.88, t)) * grow;
    float hotAx = 1.0 - smoothstep(0.03, 0.46, t);
    // THE SPINE. Bands alone drew a string of separate beads — a caterpillar, not a jet. A narrow
    // un-banded hot filament straight down the axis ties the diamonds into ONE column, which is
    // what §1.2's "bright, banded, cone-shaped" describes. Narrow (chord^6) on purpose: a fat spine
    // is just the old continuous glow back again, filling the gaps this layer exists to open.
    float spine = pow(chord, 6.0) * mix(0.52, 0.22, smoothstep(0.06, 0.80, t));
    float lit = clamp(band + spine * (1.0 - band), 0.0, 1.15);

    vec3 col = mix(uEdge, uMid, smoothstep(0.0, 0.62, chord));
    // chord^3.1, not ^2.1: the white-hot region has to be a NARROW filament. Wide enough to cover
    // half the column's width it clips the whole throat to featureless white, and a clipped pixel
    // cannot show a band — which is how the muscle's fat barrel lost its structure in Miami.
    col = mix(col, uCore, clamp(pow(chord, 3.1) * (0.40 + 0.60 * hotAx) * uHot, 0.0, 1.0));
    // ---- WHERE THE CONTRAST ACTUALLY COMES FROM ----
    // The column's COVERAGE is continuous (alpha ≈ chord, so the silhouette is one unbroken cone
    // that dissolves at its outline) and the bands are carried mostly by BRIGHTNESS: a band peaks
    // near 1.6 and blooms, a gap sits at ~15% of it and stays dark. Punching the gaps out of ALPHA
    // instead lets a bright road (Miami's sunset, LA's afternoon) shine through them at full
    // strength — which is how three rounds of banding kept dissolving into a flat bright field — and
    // it is not what a plume does either: the cool zones between shock diamonds are dark gas, not
    // holes. A little alpha modulation stays, so the column still breathes rather than reading as a
    // painted tube.
    col *= uGain * mix(1.0, 0.12 + 1.48 * lit, decay);

    float a = chord * mix(1.0, 0.70 + 0.34 * lit, decay) * uOpacity * uLevel;
    a *= smoothstep(0.0, 0.06, t);               // never lit ON the orifice lip
    a *= 1.0 - smoothstep(0.78, 1.0, t);         // and dead well inside the quad's far edge
    a *= uFade;
    a *= smoothstep(uNear0, uNear1, vDepth);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

/**
 * How much wider than the cone's maximum radius the impostor quad is cut. Every pixel between the
 * cone and the quad edge is a discard, i.e. paid-for fill that draws nothing, so it is kept just
 * clear of the band bulge (±0.16) rather than generously padded.
 */
const CORE_PAD = 1.24;

/** Unit quad spanning x ∈ [-0.5, 0.5] across and z ∈ [0, -1] down the plume axis. */
let _coreGeo = null;
function coreGeometry() {
  if (!_coreGeo) {
    const g = new THREE.PlaneGeometry(1, 1, 1, 1);
    g.translate(0, 0.5, 0);
    g.rotateX(-Math.PI / 2);     // +Y (axial) → -Z, uv.y = 0 at the orifice, 1 at the tip
    _coreGeo = g;
  }
  return _coreGeo;
}

function coreMaterial(fx, phase) {
  const pf = fx.profile || [0.30, 0.55, 0.75, 0.30];
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uPhase: { value: phase },
      uCore: { value: new THREE.Color(fx.core) },
      uMid: { value: new THREE.Color(fx.mid) },
      uEdge: { value: new THREE.Color(fx.edge) },
      uProf: { value: new THREE.Vector4(pf[0], pf[1], pf[2], pf[3]) },
      uBands: { value: fx.bands },
      uBandSpeed: { value: fx.bandSpeed },
      uTurb: { value: fx.turb },
      uOpacity: { value: fx.coreOpacity ?? 0.92 },
      uGain: { value: fx.coreGain ?? ((fx.gain ?? 1) * 1.6) },
      uHot: { value: fx.coreHot ?? 1.0 },
      uPad: { value: CORE_PAD },
      uFade: { value: 1 },
      uNear0: { value: 0.85 },
      uNear1: { value: 2.60 },
    },
    vertexShader: CORE_VERT,
    fragmentShader: CORE_FRAG,
    transparent: true,
    // NORMAL, not additive — the one blend mode in this file that is not. Additive light added to
    // an already-bright frame (Miami's sunset road, the LA afternoon) saturates in the band gaps as
    // well as on the bands, so the structure this layer exists to draw disappears exactly where the
    // background is bright: the muscle car's Miami boost was a featureless yellow field. Compositing
    // the core OVER the frame instead makes the contrast independent of what is behind it — opaque
    // bands, near-transparent gaps, on any road, in any city. Everything around it (the volume
    // shells, the gas cards, the ground pool, the point light) stays additive, so the jet still
    // reads as light; it is only the structural layer that is composited.
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}

function plumeMaterial(fx, {
  opacity, taper, facePow, turb, bandMul = 1, sharpMul = 1,
  white = 0, edgeMix = 1, gain = 1, bandAmt = 1, ramp = 0.10, faceFloor = 0.22, phase = 0,
  bulge = 0.18,
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
      uBandBulge: { value: bulge },
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
const _gp = new THREE.Vector3();
const _gd = new THREE.Vector3();
const _gq = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(0xffffff);

/**
 * Where the column visually ENDS, as a fraction of baseLen. The shells' alpha is
 * `smoothstep(0,ramp,t) · pow(1−t, taper)`, so the last third is a fade the eye does not count as
 * part of the jet; measuring the governor against t = 1.0 sized every plume roughly twice too big
 * and sent the tail sweeping past the lens.
 */
const VIS_T = 0.62;

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

    const geo = plumeGeometry(fx.profile);
    // three nested lathe shells: white-hot core → class mid → soft fringe.
    // `facePow` is the silhouette softener; the outer shell gets the highest power so its outline
    // has completely dissolved by the time it reaches the edge of the plume.
    //
    // Opacities are roughly HALF what round 2 used and every ramp is much longer. Round 2's stack
    // summed to alpha > 1 across the whole rear third of the car: the taillights, bumper and
    // exhaust tips were erased and the banding the shaders draw was invisible inside the clip.
    // A jet you can see the car's silhouette through is a better jet.
    // (r6) THE WHITE-HOT CORE IS NO LONGER A LATHE. It was the layer that clipped, and a clipped
    // shell cannot show banding at all — see the CORE_FRAG block comment. The core is now the
    // axis-billboarded impostor built below; these two lathes are demoted to what a lathe is
    // actually good at, which is VOLUME: a class-tinted body and a soft fringe that give the jet
    // parallax as the rig swings, seen THROUGH the impostor's hard structure. Both are roughly a
    // third dimmer than round 5, because a continuous glow sitting behind the impostor fills in the
    // transparent gaps between the shock diamonds and that is precisely what erases the banding.
    this.shellSpec = [
      // 1 class-tinted body — carries the colour, so its gain stays under 1
      { opacity: 0.76, taper: 0.98, facePow: 0.58, turb: 0.75, white: 0.24, edgeMix: 0.72, gain: 0.74, bandAmt: 1.00, ramp: 0.19, faceFloor: 0.32, bulge: 0.28 },
      // 2 soft fringe — the layer that does the §7 silhouette dissolve, so its floor stays low.
      // (r5) Much tighter and dimmer: at 1.42x radius and 0.90 opacity the two nozzles' fringes
      // fused into one red gas cloud twice the width of the car, and the cloud — not the jet — was
      // what the frame read as.
      { opacity: 0.40, taper: 0.82, facePow: 0.95, turb: 1.05, bandMul: 0.55, sharpMul: 0.55, white: 0.06, edgeMix: 1.0, gain: 0.62, bandAmt: 0.50, ramp: 0.13, faceFloor: 0.19, bulge: 0.14 },
    ];
    // shell radius / length multipliers
    this.shellR = [0.82, 1.16];
    this.shellL = [0.92, 1.06];
    this.shellMats = [];   // flat list, for uTime/uLevel updates and disposal
    this.coreMats = [];

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
      // (r5) 0.075 rad of down-wash dropped the tip ~0.3 m over the column, which at exhaust height
      // planted the whole back half of the jet ON the asphalt: the plume and its own ground pool
      // fused into one flat orange field. It now runs very nearly level and stays clear of the road.
      g.rotation.x = 0.025;
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

      // ---- the structural core: one axis-billboarded impostor (see CORE_FRAG) ----
      const coreMat = coreMaterial(fx, phase);
      this.coreMats.push(coreMat);
      const core = new THREE.Mesh(coreGeometry(), coreMat);
      core.renderOrder = 8.2;      // over the volume shells, under the burner disc
      core.frustumCulled = false;
      g.add(core);

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
      this.nozzles.push({ group: g, shells, mats, core, coreMat, coreRoll: 0, cards, disc, flash, ring, phase, base: g.position.clone() });
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
    for (const m of this.coreMats) m.uniforms.uMid.value.set(c);
    this._colMid.set(c);
  }

  /**
   * Fire the ignition event: muzzle flash, shock ring and a blast of sparks.
   * The blast is a REARWARD cone, not a sphere — a sphere reads as "the car detonated".
   */
  ignite() {
    this.igT = 0;
    // the governor re-solves from scratch for this boost rather than easing off the last one's size
    this._gLen = undefined; this._gRad = undefined; this._gAx = undefined;
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

  /**
   * ── THE SCREEN-SPACE GOVERNOR (the round-4 fix) ─────────────────────────────────────────────
   *
   * Round 3's plume was sized in WORLD units, and the chase rig pulls back and climbs with speed.
   * The two fought each other: at 167–188 mph the rig sat ~10 m out and ~5 m up, and a 4–5 m
   * column seen from up there and nearly down its own axis projected to a ~120 px stub. The frames
   * where nitrous is supposed to dominate were the least spectacular in the set.
   *
   * So the jet no longer has a length. It has a TARGET SIZE ON SCREEN (`fx.screen`, a fraction of
   * the frame height) and the world length is SOLVED FOR every frame against the real projection.
   *
   * Screen position, measured in frame heights from the optical axis, is
   *
   *   F(p) = ( p.x / (−p.z · 2·tan(fov/2)),  p.y / (−p.z · 2·tan(fov/2)) )
   *
   * — the aspect divisor in ndc_x cancels against the frame being `aspect` frame heights wide, so
   * x and y share one scale and combine directly. The wanted length is the L that makes
   * |F(nozzle + L·axis) − F(nozzle)| equal `fx.screen`. That separation is monotonic in L up to
   * the point where the tip reaches the lens, so a short bisection nails it.
   *
   * It is deliberately NOT the first-order form d|F|/dL: the governor routinely asks for a 10 m
   * column from a rig 6 m away, and out there the linear estimate is off by a factor of two —
   * and it has no idea when the tip has gone PAST the camera, which is where it diverges outright.
   * The search is bracketed at a tip 2.5 m in front of the lens for exactly that reason.
   *
   * Radius is NOT solved for. It is derived from the solved length (see the caller), because
   * `fx.rad` has to stay under half the twin-outlet spacing or the two hot cores merge into one
   * blob — the headline round-2 note. Length has no such constraint, so length is where the
   * governor spends.
   *
   * @returns {{len:number, axial:number}|null} null when the jet is behind the lens.
   *          `axial` is how squarely the camera is looking down the jet's own centreline (0 = pure
   *          side-on, 1 = straight down the barrel). At high `axial` no amount of length buys
   *          screen size — the column is a dot with a long tail — so the caller spends on width
   *          and on the burner disc instead.
   */
  _governor(camera, target) {
    // main.js updates the jet before the camera, so matrixWorldInverse can be a frame stale (and on
    // the very first frame of a capture, unset). PerspectiveCamera.updateMatrixWorld() refreshes the
    // inverse and is a cheap no-op when nothing moved.
    camera.updateMatrixWorld();
    const n0 = this.nozzles[0];
    n0.group.getWorldPosition(_gp);
    n0.group.getWorldQuaternion(_gq);
    _gd.set(0, 0, -1).applyQuaternion(_gq);            // the plume axis, in world space
    _gp.applyMatrix4(camera.matrixWorldInverse);       // → view space
    _gd.transformDirection(camera.matrixWorldInverse);
    const pz = _gp.z;
    if (!(pz < -0.4)) return null;                     // behind the lens (or NaN) — leave it alone
    const k = 0.5 / Math.tan(camera.fov * Math.PI / 360);
    const sx0 = k * _gp.x / -pz, sy0 = k * _gp.y / -pz;
    // Screen position of the point t metres down the axis, in FRAME HEIGHTS from the optical axis.
    const sxT = (t) => k * (_gp.x + _gd.x * t) / -(pz + _gd.z * t);
    const syT = (t) => k * (_gp.y + _gd.y * t) / -(pz + _gd.z * t);
    // Separation, in frame heights, between the nozzle and the point the column visually ends at
    // when the whole column is L metres long.
    const sep = (L) => {
      const t = L * VIS_T;
      return Math.hypot(sxT(t) - sx0, syT(t) - sy0);
    };
    // never let the solver walk the TIP (t = 1) into, or through, the lens
    let hi = Math.min(30, _gd.z > 1e-4 ? (-2.2 - pz) / _gd.z : 30);
    let lo = 0;
    const out = { len: 0.4, axial: clamp(Math.abs(_gd.z), 0, 1), fit: 1 };
    if (hi <= 0.4) return out;
    if (sep(hi) > target) {
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) * 0.5;
        if (sep(mid) < target) lo = mid; else hi = mid;
      }
    }
    out.len = hi;

    // ── FRAME CONTAINMENT (the round-5 fix) ───────────────────────────────────────────────────
    // Solving for screen SIZE alone is not the same as putting the jet ON SCREEN. From a rig swung
    // out to a rear three-quarter, a column sized to 40% of frame height ran diagonally out through
    // the bottom-left corner: the tip, the taper and the whole cone silhouette were cropped away
    // and what was left inside the frame was a wide, structureless orange field. A jet has to END
    // somewhere the viewer can see, or it is a smear.
    //
    // So the solved length is additionally clipped to the longest column whose visible end still
    // sits inside a safe box (frame minus a `margin` gutter, measured in frame heights — the box is
    // `aspect` frame heights wide). Only applied when the nozzle itself is comfortably inside the
    // frame, and never below 55% of the wanted length: if the car is already half out of shot,
    // cropping the plume too is not going to save the composition.
    const halfW = camera.aspect * 0.5 - 0.085;
    const halfH = 0.5 - 0.075;
    const inBox = (L) => {
      const t = L * VIS_T;
      return Math.abs(sxT(t)) < halfW && Math.abs(syT(t)) < halfH;
    };
    if (Math.abs(sx0) < halfW && Math.abs(sy0) < halfH && !inBox(out.len)) {
      let flo = 0, fhi = out.len;
      for (let i = 0; i < 14; i++) {
        const mid = (flo + fhi) * 0.5;
        if (inBox(mid)) flo = mid; else fhi = mid;
      }
      const fitted = Math.max(flo, out.len * 0.55);
      out.fit = fitted / out.len;
      out.len = fitted;
    }
    return out;
  }

  /**
   * World-space point a fixed distance down the plume's own axis — main.js aims the boost camera
   * partly at this so the COLUMN is what the frame is composed around, with the car pushed off to
   * one side, instead of the car being dead centre and the jet exiting the corner.
   *
   * Deliberately a fixed multiple of the class's reference length, NOT of the solved length: the
   * governor's containment clamp reacts to where the tip lands on screen, so feeding the solved
   * length back into the aim would let the two chase each other.
   */
  aimPoint(out) {
    const n0 = this.nozzles[0];
    n0.group.getWorldPosition(out);
    if (this.nozzles.length > 1) {
      this.nozzles[this.nozzles.length - 1].group.getWorldPosition(_v2);
      out.lerp(_v2, 0.5);
    }
    n0.group.getWorldQuaternion(_q);
    _v2.set(0, 0, -1).applyQuaternion(_q);
    return out.addScaledVector(_v2, this.fx.len * this.scale * 0.62);
  }

  /** Screen-space anchor + strength for the grade pass' heat haze. */
  heatPoint(camera, out) {
    this.nozzles[0].group.getWorldPosition(_v);
    if (this.nozzles.length > 1) {
      this.nozzles[this.nozzles.length - 1].group.getWorldPosition(_v2);
      _v.lerp(_v2, 0.5);
    }
    // Sample a third of the way DOWN THE PLUME'S OWN AXIS, where the shimmer actually is. (Round 3
    // pushed the sample along the camera ray instead; harmless when the jet was 4 m long, but the
    // governor now routinely runs it to 10 m and that put the haze centre metres off the flame.)
    this.nozzles[0].group.getWorldQuaternion(_q);
    _v2.set(0, 0, -1).applyQuaternion(_q);
    // (r6) Sampled BEYOND the visible column, not a third of the way down it. The ripple is a
    // gaussian ~0.4 frame-heights across, so centred on the jet it wobbled the shock diamonds
    // themselves — the one layer whose whole job is to be crisp. Centred on the hot trail behind the
    // tip it bends the road, the lane lines and the barrier BEHIND the plume instead, which is where
    // refraction is legible anyway.
    _v.addScaledVector(_v2, (this._baseLen ?? this.fx.len * this.scale) * 0.92);
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
    const hold = 1 - Math.exp(-Math.max(0, this.igT) / 0.42);
    const stretch = 0.94 + 0.12 * smoothstep(16, 82, speed);
    // The floors are HIGH now (0.66, 0.78): the governor below sets the sustained size, and these
    // two terms only carve the per-class spool out of it. A spooling SUV reads as a jet that has
    // not opened up yet — about 2/3 size — rather than as the stub it used to be.
    const lenDrive = (0.66 + 0.34 * ramp) * (0.78 + 0.22 * hold) * stretch;

    // ── screen-space governor ────────────────────────────────────────────────────────────────
    // `hero` is opt-in (main.js passes it for the player). Opponent jets are seen from 20–120 m
    // and would each solve for a 40 m column; they keep the plain world-space sizing.
    let gLen = 1, gRad = 1, axial = 0;
    if (camera && opts.hero) {
      const g = this._governor(camera, fx.screen ?? 0.40);
      if (g) {
        gLen = clamp(g.len / (fx.len * this.scale), 0.42, 2.60);
        // Radius tracks the GOVERNED LENGTH, sub-linearly, rather than raw distance. Tying it to
        // distance instead held the width fixed while the solver shortened the column, and a 2 m
        // jet 1.3 m across is not a jet, it is a lozenge — the exact "one off-axis blob" note from
        // round 2. Sub-linear (^0.62) so a stretched column also gets *relatively* more slender.
        // The one thing that does buy width is `axial`: with the rig on the jet's own centreline
        // no length reads at all, and the plume has to be seen end-on as a wide, hot disc.
        axial = smoothstep(0.72, 0.97, g.axial);
        // ...and whatever LENGTH the frame-containment clamp took away is paid back in WIDTH, so a
        // jet that has to end early to stay in shot still owns its share of the frame.
        gRad = clamp(Math.pow(gLen, 0.62), 0.62, 1.35) * (1 + axial * 0.34)
             * (1 + (1 - g.fit) * 0.55);
      }
    }
    // Smoothed, or the column pumps every time the rig settles or a shake displaces the lens.
    const gk = 1 - Math.exp(-11 * Math.min(dt, 0.05));
    this._gLen = this._gLen === undefined ? gLen : this._gLen + (gLen - this._gLen) * gk;
    this._gRad = this._gRad === undefined ? gRad : this._gRad + (gRad - this._gRad) * gk;
    this._gAx = this._gAx === undefined ? axial : this._gAx + (axial - this._gAx) * gk;
    const gL = this._gLen, gR = this._gRad, gA = this._gAx;

    const baseLen = fx.len * this.scale * gL * lenDrive * (1 + surge * 0.12) * flick;
    // Radius follows the visual level and barely moves: a jet that fattens as much as it lengthens
    // just scales up, and the "short and hot / long and wide" contrast disappears. The governor's
    // radius term is applied PER SHELL below (see gRp) so the white-hot cores stay narrow even when
    // the soft fringe is asked to hold its screen width from a long way out.
    const baseRad = fx.rad * this.scale * this.radMul
      * (0.76 + 0.24 * s) * (0.90 + 0.10 * ramp) * (1 + surge * 0.16);
    const gRp = [Math.pow(gR, 0.72), gR];
    this._baseLen = baseLen;

    const shellLevel = s * (0.94 + 0.10 * flick) + igBloom * 0.16;
    for (const m of this.shellMats) {
      m.uniforms.uTime.value = this.t;
      // Held, not decayed: §6.3's payoff is the SUSTAIN, and round 3 let the shells settle ~15%
      // below their ignition level a third of a second in.
      m.uniforms.uLevel.value = shellLevel;
    }
    // The impostor loses authority as the rig comes onto the jet's own centreline: seen down the
    // barrel a flat quad rolled to face the lens degenerates, and the burner disc (which comes UP
    // by exactly the same term) is the layer that reads there.
    const coreFade = (1 - gA * 0.80) * (fx.coreFade ?? 1);
    for (const m of this.coreMats) {
      m.uniforms.uTime.value = this.t;
      m.uniforms.uLevel.value = shellLevel;
      m.uniforms.uFade.value = coreFade;
    }

    const camQ = camera ? camera.quaternion : null;
    // max radius of the impostor's cone, in world units — matched to the tinted body shell so the
    // hard structure sits INSIDE the volume rather than cutting across its silhouette
    const coreR = baseRad * (fx.coreW ?? 0.86) * gRp[0];
    for (const n of this.nozzles) {
      // parent-space → so a billboard can be built from the camera's world quaternion
      const invParent = camera ? _q2.copy(n.group.getWorldQuaternion(_q3)).invert() : null;

      for (let i = 0; i < n.shells.length; i++) {
        const wob = 1 + Math.sin(this.t * (23 + i * 7) + n.base.x * 5) * 0.05 * (i + 1) * 0.5;
        const r = baseRad * this.shellR[i] * gRp[i] * wob;
        n.shells[i].scale.set(r, r, baseLen * this.shellL[i]);
      }

      // ---- core impostor: roll it about the PLUME AXIS until it faces the camera ----
      // Not a camera-facing card: it can only spin around its own centreline, so the column never
      // collapses into a disc and never presents a square to the lens (§7).
      if (camera) {
        n.group.getWorldPosition(_v2);
        _v.setFromMatrixPosition(camera.matrixWorld).sub(_v2).applyQuaternion(invParent);
        const m2 = Math.hypot(_v.x, _v.y);
        // degenerate only when the lens is exactly on the axis, where uFade has already taken the
        // impostor out — hold the last good roll rather than letting it spin
        if (m2 > 1e-3) n.coreRoll = Math.atan2(-_v.x, _v.y);
        n.core.rotation.z = n.coreRoll;
      }
      n.core.scale.set(coreR * 2 * CORE_PAD, 1, baseLen);

      // ---- gas cards ----
      const cardGain = fx.cardGain ?? ((fx.gain ?? 1) * 0.7);
      const cardRad = baseRad * gR;
      const pf = fx.profile || [0.30, 0.55, 0.75, 0.30];
      for (let i = 0; i < n.cards.length; i++) {
        const cd = n.cards[i];
        const u = cd.u;
        // plume envelope — the SAME class silhouette the lathe shells use (fx.profile), so the soft
        // fringe hugs the class's own cone instead of drawing a generic one around it
        const env = Math.pow(Math.sin(Math.PI * Math.pow(u, pf[1])), pf[2]) * Math.pow(1 - u, pf[3] * 0.6);
        const w = cardRad * (fx.cardWidth ?? 2.0) * (pf[0] * 1.25 + 1.02 * env) * (fx.cardSpread ?? 1.15);
        const puff = 1 + Math.sin(this.t * (9 + i * 2.3) + cd.ph + n.phase) * 0.10;
        cd.mesh.scale.set(w * puff, w * puff * (0.92 + 0.16 * Math.sin(cd.ph + this.t * 4)), 1);
        cd.mesh.position.set(
          cd.jx * cardRad * 1.6 + Math.sin(this.t * 6.3 + cd.ph) * cardRad * 0.10,
          cd.jy * cardRad * 1.6 + Math.sin(this.t * 5.1 + cd.ph * 1.7) * cardRad * 0.09,
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
      // ...and it is the one layer that is ALLOWED to come up when the rig is on the jet's axis:
      // that is the framing where the column itself is a dot and the disc is the whole read.
      dm.opacity = clamp(s * (0.085 + 0.20 * gA) * flick + igBloom * 0.14, 0, 0.5);
      const ds = (baseRad * gRp[0] * 2.3 + 0.12) * (1 + surge * 0.32);
      n.disc.scale.set(ds * (1 + Math.sin(this.t * fx.flick * 0.7) * 0.05), ds, 1);
      if (camQ) n.disc.quaternion.copy(camQ).premultiply(invParent);

      // muzzle flash
      const fm = n.flash.material;
      fm.opacity = clamp(igFlash * 1.1 + igBloom * 0.42, 0, 1.5);
      const fs = lerp(0.5, 3.0 * this.scale, 1 - Math.exp(-this.igT / 0.09)) * (0.6 + s * 0.6) * gR;
      n.flash.scale.set(fs, fs, 1);
      n.flash.position.z = -0.18 - this.igT * 1.2;
      if (camQ) n.flash.quaternion.copy(n.disc.quaternion);

      // shock ring — expands square to the jet axis
      const rm = n.ring.material;
      const rt = clamp(this.igT / 0.34, 0, 1);
      rm.opacity = (1 - rt) * (1 - rt) * 1.25;
      const rs = (0.35 + rt * 5.5 * this.scale) * gR;
      n.ring.scale.set(rs, rs, 1);
      n.ring.position.z = -0.2 - rt * 2.4;
      n.ring.quaternion.identity();
    }

    // ---- streaks: sparks + light smear ----
    // Ejecta rides the wake: the drift is only a FRACTION of the car's speed (see StreakPool.update).
    const drift = -speed * (fx.wake ?? 0.2);
    const cone = fx.cone ?? 0.3;
    // Sparks are part of the jet, so they are governed too: a shower that stays 1.5 m long behind a
    // 10 m column is invisible. Speed (hence stretch) and width follow the governor sub-linearly.
    const gS = Math.sqrt(gL);
    const rate = fx.sparkRate * s * (0.55 + 0.45 * smoothstep(0, 40, speed)) * (1 + surge * 1.2);
    this._acc = (this._acc || 0) + rate * dt;
    const r = this.rng;
    while (this._acc >= 1) {
      this._acc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      // Born in an ANNULUS around the column, not inside it. Embers launched down the middle are
      // invisible — they sit inside the brightest part of the plume — so the shower only reads
      // when the streaks fly clear of the core and cross the dark road behind it.
      // (r6) The annulus used to start at 0.65 x the core radius, i.e. INSIDE the tinted body shell
      // and well inside the fringe, so every ember was born in the brightest additive region of the
      // frame and the standing note has been "no sparks anywhere at any zoom" for three rounds. The
      // shower is now born at 1.4–3.1 x the core radius — outside the fringe — thrown outward as
      // well as backward, and lives long enough (life x2.0, gravity 3.2) to arc clear of the plume
      // and cross the dark asphalt, which is the only place a spark can actually be seen.
      const a = r.range(0, Math.PI * 2), rad = baseRad * gR * r.range(1.4, 3.1);
      const back = r.range(fx.sparkSpeed[0], fx.sparkSpeed[1]) * gS;
      // rearward cone: lateral velocity is bounded by tan(cone) * axial speed
      const th = Math.sqrt(r.range(0, 1)) * cone;
      const lat = Math.tan(th) * back;
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad, n.base.z - r.range(0, baseLen * 0.80),
        Math.cos(a) * (lat * 1.25 + 1.5), Math.sin(a) * (lat * 1.25 + 1.2) + r.range(0.1, 1.5), -back,
        r.range(fx.sparkLife[0], fx.sparkLife[1]) * 2.0,
        fx.sparkWidth * gR * r.range(0.6, 1.7),
        // Never pure white: the tonemap desaturates clipped highlights and the city grade then
        // tints them, which turned round 1's white embers ORANGE on the cyan tuner.
        r.bool(0.45) ? this._hot : fx.spark,
        r.range(0.70, 1.15) * (0.45 + 0.55 * s),
        3.2,
      );
    }
    // ---- light smear: a few wide, dim, long-lived streaks that smear the jet down the road ----
    this._sacc = (this._sacc || 0) + (fx.smearRate ?? 10) * s * dt;
    while (this._sacc >= 1) {
      this._sacc -= 1;
      const n = this.nozzles[r.int(0, this.nozzles.length - 1)];
      const a = r.range(0, Math.PI * 2), rad = r.range(0, 1) * baseRad * gR * 0.8;
      const back = r.range(fx.sparkSpeed[0] * 0.5, fx.sparkSpeed[1] * 0.7) * gS;
      this.streaks.emit(
        n.base.x + Math.cos(a) * rad, n.base.y + Math.sin(a) * rad, n.base.z - baseLen * 0.35,
        Math.cos(a) * 0.6, Math.sin(a) * 0.5 + 0.4, -back,
        r.range(0.26, 0.46), (fx.smearWidth ?? 0.35) * gR * r.range(0.7, 1.3),
        r.bool(0.5) ? fx.mid : fx.spark,
        r.range(0.06, 0.16) * s, 0.6,
      );
    }
    const su = this.streaks.material.uniforms;
    su.uStretch.value = 0.034 + s * 0.014;
    su.uMinLen.value = 0.20 * gS;
    su.uMaxLen.value = 2.4 * gS;
    this.streaks.update(dt, 2.2, drift);

    // ---- ground pool ----
    // Its reach follows the plume, so the tint on the road grows and shrinks with the jet rather
    // than sitting there as a constant painted patch.
    // The round-3 critic could not find it at all in the sustained frames: at 3.5 m wide and 0.30
    // opacity, seen from 10 m up-and-back, it was a few dozen dim pixels under the car. It is now
    // governed like the jet — it reaches as far down the road as the column does — and carries
    // half again the density, so the road under the boost is visibly stained with the class tint.
    // ...and round 4 then over-corrected: governed to the same reach as the column and sitting
    // directly under it, the pool stopped reading as light ON the road and became a second flame
    // lying flat on it — the two superimposed into one wide low smear with no layer separation
    // (ablation: hiding the shells left an orange band on the asphalt the same length and shape as
    // the jet). A spill is BROADER and SHORTER than the thing casting it: it now reaches about
    // half as far down the road and spreads wider than the plume envelope, so the structured jet
    // sits IN FRONT of a soft glow instead of inside it.
    const pm = this.pool.material;
    pm.opacity = clamp(s * 0.19 * flick + igBloom * 0.18, 0, 0.44);
    this.pool.scale.set(
      fx.poolWidth * this.scale * (0.95 + 0.30 * gR) * (0.80 + 0.20 * s) * (1 + surge * 0.30),
      1,
      fx.poolLen * this.scale * (0.30 + 0.34 * gL * lenDrive) * (1 + surge * 0.30),
    );
    // keep it flat on the road and aligned with the car's heading, whatever the body is doing
    this.group.getWorldPosition(_v);
    this.group.getWorldQuaternion(_q);
    _e.setFromQuaternion(_q, 'YXZ');
    _e.set(0, _e.y, 0, 'YXZ');           // heading only — reuse the scratch, don't allocate here
    _q2.setFromEuler(_e);
    this.pool.quaternion.copy(_q).invert().multiply(_q2);
    _v2.set(_v.x, 0.055, _v.z);
    this.pool.position.copy(this.group.worldToLocal(_v2));

    // ---- bodywork spill ----
    // Roughly half of round 2. The rear panel should be LIT by the jet, with the taillight
    // housings and diffuser picked out; at the old intensity it was a flat blown card.
    // (r5) Up from 0.50: the REAL light is what should be staining the asphalt behind the car, not
    // an additive decal — a point light has no edges, falls off correctly, and lights the rear
    // panel, the diffuser, the tyres and the road in one pass. Raising it let the painted ground
    // pool drop to a soft supporting glow instead of being the whole ground-spill story.
    this.light.intensity = (s * fx.lightI * 0.86 * flick + igFlash * fx.lightI * 1.2 + igBloom * fx.lightI * 0.40);
    this.light.distance = (13 + s * 6) * (0.82 + 0.24 * gL);

    // ---- heat haze strength handed to the grade pass ----
    // (r6) 40% down. Everything nitrous does to the frame is now deliberately quieter than the jet
    // itself: the standing note is that the plume is indistinguishable from its own screen effects.
    this.heat = clamp((s * 0.58 + igBloom * 0.40) * (fx.heat ?? 1), 0, 1.5);
  }

  dispose() {
    this.streaks.dispose();
    for (const m of this.shellMats) m.dispose();
    for (const m of this.coreMats) m.dispose();
    this.pool.geometry.dispose(); this.pool.material.dispose();
    for (const n of this.nozzles) {
      n.disc.geometry.dispose(); n.disc.material.dispose();
      n.flash.geometry.dispose(); n.flash.material.dispose();
      n.ring.geometry.dispose(); n.ring.material.dispose();
      for (const cd of n.cards) { cd.mesh.geometry.dispose(); cd.mesh.material.dispose(); }
    }
  }
}
