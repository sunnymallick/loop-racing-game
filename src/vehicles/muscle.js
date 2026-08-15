import { assembleCar } from './assemble.js';

/**
 * VELOCE DOMINATOR — American muscle. 1970 Charger / Mustang fastback DNA:
 * a very long bonnet, a short deck, a high beltline with a coke-bottle kink, enormous rear
 * haunches over the back wheels, a fastback roof that runs all the way to the tail panel,
 * four round taillights and a supercharger through the bonnet.
 *
 * Silhouette test (§2.3): the outline must read long-hood / short-deck with the cabin pushed
 * right to the back axle. Every station below is placed for that.
 *
 * Handling: heavy, torque-rich, tail-happy. Nitrous = brutal sustained shove.
 */
export const spec = {
  id: 'muscle',
  name: 'DOMINATOR',
  full: '1970 DOMINATOR 440',
  klass: 'MUSCLE',
  // The reference hero (f&f1) is a MINT-TEAL fastback with twin white stripes. Round 3's #1d7f60
  // was a bottle green that went black in three of the four cities and is most of why the hero car
  // "reads small and dark in almost every frame" — a hero colour has to hold value under a night
  // grade, not just under a studio light.
  colors: ['#16a984', '#b32222', '#2a4272', '#f0ae1e', '#1b1d23', '#7b39a0'],
  stats: { speed: 0.86, accel: 0.78, traction: 0.55, weight: 0.92 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

/**
 * z runs -2.58 (tail) … +2.48 (nose). v in the paint texture = (z + 2.58) / 5.06.
 *
 * ROUND-2: the nose came back 100 mm. The verdict — "at 3x its front overhang ahead of the front
 * wheel is enormous and the nose is a flat vertical slab, reading as a 70s land-yacht rather than
 * long-hood/short-deck fastback" — was measuring 1.09 m of car ahead of the front wheel centre, on
 * a 2.98 m wheelbase. A '70 fastback runs about 0.95-1.00 there; 1.09 is a Continental. It is now
 * 0.99, and the last two stations rake the nose down and tuck the valance under it, so the front
 * is a wedge with a leading edge instead of a wall.
 */
const V = (z) => (z + 2.58) / 5.06;

export const blueprint = {
  id: 'muscle', spec, colors: spec.colors,
  // Track and tail are set against each other so the REAR TYRES BREAK THE SILHOUETTE from a
  // straight-on chase view (§6.1 round-2: the wheels were invisible in every harness frame). The
  // rear tyre's outer sidewall sits at 1.085 while the tail panel tucks in to 0.914 — 17 cm of
  // haunch and rubber outboard of the bodywork on each side.
  dims: { length: 5.06, width: 2.24, height: 1.42, wheelbase: 2.98, track: 1.740, trackRear: 1.846, rideHeight: 0.16 },
  // see paintMaterial(): metalness carries the environment into the paint, and the environment is
  // the only light on the back of a car in a chase frame. Deep metallic teal with a hard clearcoat.
  paint: { metalness: 0.52, roughness: 0.25, clearcoat: 0.95, clearcoatRoughness: 0.058, flake: 0.62, envIntensity: 1.20 },
  livery: {
    style: 'stripes', stripe: '#f2efe6',
    panels: {
      stripeWidth: 0.038, stripeGap: 0.026,
      doors: [V(0.62), V(-1.02)],
      hood: [V(0.74), V(2.32)],
      boot: [V(-2.44), V(-1.92)],
      arches: [V(1.49), V(-1.49)],
      fuelCap: [0.30, V(-2.10)],
    },
  },
  // opacity 0.70 let only 30% of the cabin through, and 30% of a dark interior is black — §7's
  // "empty black void through the glass" caps this piece at 72, below its target, so the glass had
  // to give some of itself back. 0.58 still carries a full env reflection on the screen and the
  // backlight; it just no longer erases what is behind it.
  glass: { tint: '#0e151d', opacity: 0.58 },

  // ---- the tub: ground → beltline, with the bonnet, the cabin recess and the boot lid ----
  body: [
    { z: -2.58, w: 0.790, y0: 0.50, floor: 0.55, rocker: 0.95, ySill: 0.62, yBelt: 0.90, belt: 0.96, yDeck: 0.90, deck: 0.92, crown: 0.005 },
    { z: -2.50, w: 0.865, y0: 0.42, floor: 0.58, rocker: 0.95, ySill: 0.56, yBelt: 0.95, belt: 0.96, yDeck: 0.95, deck: 0.90, crown: 0.01 },
    { z: -2.30, w: 0.905, y0: 0.33, rocker: 0.93, ySill: 0.50, yBelt: 0.99, belt: 0.95, yDeck: 0.98, deck: 0.88, crown: 0.015, flare: 1.01 },
    { z: -2.12, w: 0.932, y0: 0.30, rocker: 0.925, ySill: 0.485, yBelt: 0.995, belt: 0.95, yDeck: 0.985, deck: 0.875, crown: 0.015, flare: 1.02 },
    { z: -2.00, w: 0.950, y0: 0.28, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.99, deck: 0.87, crown: 0.015, flare: 1.045 },
    { z: -1.94, w: 0.958, y0: 0.27, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.99, deck: 0.87, crown: 0.015, flare: 1.058 },
    // — cabin recess begins: the deck drops below the belt so the interior is a real hole —
    { z: -1.88, w: 0.962, y0: 0.27, rocker: 0.92, ySill: 0.47, yBelt: 1.00, belt: 0.95, yDeck: 0.79, deck: 0.86, crown: 0.01, flare: 1.068 },
    { z: -1.60, w: 0.980, y0: 0.26, rocker: 0.91, ySill: 0.465, yBelt: 1.00, belt: 0.945, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.086 },
    { z: -1.30, w: 0.976, y0: 0.255, rocker: 0.90, ySill: 0.46, yBelt: 1.005, belt: 0.945, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.075 },
    { z: -0.95, w: 0.958, y0: 0.25, rocker: 0.885, ySill: 0.455, yBelt: 1.01, belt: 0.94, yDeck: 0.79, deck: 0.85, crown: 0.01, flare: 1.012 },
    { z: -0.35, w: 0.948, y0: 0.25, rocker: 0.875, ySill: 0.45, yBelt: 1.015, belt: 0.94, yDeck: 0.78, deck: 0.85, crown: 0.01 },
    { z: 0.25, w: 0.950, y0: 0.25, rocker: 0.875, ySill: 0.45, yBelt: 1.015, belt: 0.94, yDeck: 0.78, deck: 0.85, crown: 0.01 },
    { z: 0.66, w: 0.955, y0: 0.255, rocker: 0.88, ySill: 0.455, yBelt: 1.015, belt: 0.94, yDeck: 0.79, deck: 0.85, crown: 0.01 },
    // — cowl: the deck steps back up to bonnet height, which reads as the base of the screen —
    { z: 0.74, w: 0.956, y0: 0.255, rocker: 0.88, ySill: 0.455, yBelt: 1.015, belt: 0.945, yDeck: 1.005, deck: 0.86, crown: 0.012 },
    { z: 1.05, w: 0.960, y0: 0.255, rocker: 0.885, ySill: 0.455, yBelt: 1.015, belt: 0.945, yDeck: 1.00, deck: 0.86, crown: 0.015, flare: 1.005 },
    { z: 1.42, w: 0.968, y0: 0.26, rocker: 0.89, ySill: 0.46, yBelt: 1.015, belt: 0.945, yDeck: 0.995, deck: 0.86, crown: 0.02, flare: 1.030 },
    { z: 1.80, w: 0.966, y0: 0.27, rocker: 0.895, ySill: 0.47, yBelt: 1.01, belt: 0.945, yDeck: 0.99, deck: 0.86, crown: 0.02, flare: 1.022 },
    { z: 2.12, w: 0.958, y0: 0.30, rocker: 0.90, ySill: 0.49, yBelt: 1.00, belt: 0.95, yDeck: 0.985, deck: 0.87, crown: 0.02, flare: 1.008 },
    { z: 2.36, w: 0.935, y0: 0.38, rocker: 0.93, ySill: 0.545, yBelt: 0.962, belt: 0.96, yDeck: 0.958, deck: 0.90, crown: 0.012 },
    { z: 2.45, w: 0.892, y0: 0.455, floor: 0.60, rocker: 0.95, ySill: 0.60, yBelt: 0.928, belt: 0.97, yDeck: 0.926, deck: 0.92, crown: 0.006 },
    { z: 2.48, w: 0.815, y0: 0.545, floor: 0.55, rocker: 0.96, ySill: 0.665, yBelt: 0.898, belt: 0.97, yDeck: 0.896, deck: 0.93, crown: 0.004 },
  ],

  // ---- the glasshouse: one continuous piece of glass, with paint bands laid over it ----
  cabin: {
    stations: [
      { z: 0.74, hw: 0.855, rw: 0.800, yBelt: 1.015, yRoof: 1.035 },
      { z: 0.60, hw: 0.858, rw: 0.780, yBelt: 1.015, yRoof: 1.115 },
      { z: 0.32, hw: 0.866, rw: 0.735, yBelt: 1.015, yRoof: 1.290 },
      { z: 0.08, hw: 0.872, rw: 0.712, yBelt: 1.015, yRoof: 1.400 },
      { z: -0.30, hw: 0.878, rw: 0.708, yBelt: 1.015, yRoof: 1.420 },
      { z: -0.80, hw: 0.876, rw: 0.706, yBelt: 1.012, yRoof: 1.412 },
      { z: -1.12, hw: 0.872, rw: 0.712, yBelt: 1.010, yRoof: 1.372 },
      { z: -1.45, hw: 0.885, rw: 0.760, yBelt: 1.005, yRoof: 1.245 },
      { z: -1.72, hw: 0.885, rw: 0.820, yBelt: 1.000, yRoof: 1.090 },
      { z: -1.88, hw: 0.875, rw: 0.850, yBelt: 1.000, yRoof: 1.010 },
    ],
    roof: { z0: -1.34, z1: 0.06, a: 5, offset: 0.015 },
    pillars: [
      { z0: 0.10, z1: 0.74, a: 2, b: 5, mat: 'paint', steps: 5 },     // A-pillar / cowl side
      { z0: -0.30, z1: -0.16, a: 2, b: 5, mat: 'paint', steps: 2 },   // B-pillar
      { z0: -1.32, z1: -1.88, a: 2, b: 5, mat: 'paint', steps: 6 },   // fastback sail
    ],
    beltZ0: -1.36, beltZ1: 0.14, beltMat: 'chrome',
    // Oxblood-and-charcoal cabin. The seats/dash/shelf are authored 3x lighter than round 3 (which
    // had them at 0x14–0x2a) because a cabin is lit by nothing but sky bounce and then hidden
    // behind glass; see buildInterior(). shelfZ pushes the parcel shelf back under the fastback
    // backlight so the rear head restraints sit in the chase camera's line of sight.
    interior: { seat: 0x5c6069, trim: 0x3d414a, accent: 0x8f3038, floorY: 0.80, headY: 1.235, dashY: 1.005, wheelY: 1.045, shelfY: 1.015, seatZ: -0.34, dashZ: 0.90, dashW: 1.44, seatX: 0.36, shelfZ: 0.84, shelfD: 0.56, clusterColor: '#ffb347' },
  },

  wheels: {
    // polished deep-dish chrome five-spoke on raised-sidewall white-letter street rubber, with a
    // staggered rear: 380 mm section on a 405 mm carcass is what fills those haunches.
    style: 'fivespoke', rimColor: '#b6bdc7', caliperColor: '#b81c1c', lipColor: '#dee3ea', tire: 'muscle',
    capColor: '#b81c1c',
    front: { radius: 0.365, width: 0.30, spokes: 5, tireProfile: 0.320 },
    rear: { radius: 0.405, width: 0.38, spokes: 5, tireProfile: 0.325 },
  },
  // The arch is cut into the tub (kit.js `loftTub`). archFlare is wide because the haunch over a
  // Charger's back wheel is a long, slow draw from the door to the widest point of the car — that
  // swell IS the silhouette, and it is what the rear tyre now sits inside instead of beside.
  archGap: 1.100, archFlare: 0.185, archLip: 0.016, archProud: 0.012, archInset: 0.056,
  archDepth: 0.13, archSpan: 1.02,

  lights: {
    head: [
      { x: 0.40, y: 0.845, z: 2.445, w: 0.22, h: 0.22, shape: 'round', color: '#f2f6ff', intensity: 2.8 },
      { x: 0.68, y: 0.845, z: 2.445, w: 0.22, h: 0.22, shape: 'round', color: '#f2f6ff', intensity: 2.8 },
    ],
    // the four round lamps stand PROUD of the blacked-out tail panel (z −2.585) — round 1 buried
    // them inside it and the signature Charger tail read as one plain black slab
    tail: [
      { x: 0.29, y: 0.865, z: -2.615, w: 0.225, h: 0.225, shape: 'round', color: '#ff1e10', intensity: 2.2 },
      { x: 0.575, y: 0.865, z: -2.615, w: 0.225, h: 0.225, shape: 'round', color: '#ff1e10', intensity: 2.2 },
    ],
    reverse: [{ x: 0.16, y: 0.665, z: -2.615, w: 0.17, h: 0.085, color: '#fff2d8', intensity: 1.4, glow: 0.3 }],
  },

  grilles: [{ w: 1.50, h: 0.30, d: 0.18, y: 0.845, z: 2.405, slats: 11, vertical: true, frame: 'chrome' }],
  vents: [
    { x: 0.48, y: 1.005, z: 1.02, w: 0.30, h: 0.16, fins: 3, angle: 0.55, rx: -1.5708 },  // bonnet extractors
    { x: 0.86, y: 0.74, z: 1.02, w: 0.26, h: 0.18, fins: 3, angle: 0.4, ry: 1.5708 },     // fender gill
  ],
  mirrors: { x: 0.86, y: 1.06, z: 0.60, painted: true },
  handles: [{ x: 0.955, y: 0.94, z: -0.20 }],

  trim: [
    // The bumper WRAPS the nose: a centre bar plus two swept end sections that land on the flank.
    // Round 1 ran one straight bar wider than the body, which read as a slab bolted onto air.
    { w: 1.30, h: 0.135, d: 0.22, y: 0.66, z: 2.455, mat: 'chrome', r: 0.055 },
    { x: 0.68, w: 0.44, h: 0.135, d: 0.20, y: 0.66, z: 2.370, mat: 'chrome', ry: 0.42, mirror: true, r: 0.05 },
    { w: 1.20, h: 0.135, d: 0.22, y: 0.66, z: -2.585, mat: 'chrome', r: 0.055 },
    { x: 0.635, w: 0.42, h: 0.135, d: 0.20, y: 0.66, z: -2.505, mat: 'chrome', ry: -0.42, mirror: true, r: 0.05 },
    { w: 1.44, h: 0.30, d: 0.05, y: 0.865, z: -2.578, mat: 'dark', r: 0.03 },   // tail panel blackout
    // Ribbed chrome slats across the blackout panel. A '70 tail panel is a RIBBED surface between
    // the lamps; ours was one flat dark rectangle 1.44 m wide sitting dead centre of every chase
    // frame, which is a large share of why the back of the car read as a black cutout. Chrome is
    // already on this car, so the ribs merge into an existing bucket and cost nothing.
    { w: 1.40, h: 0.022, d: 0.055, y: 0.985, z: -2.588, mat: 'chrome', r: 0.008 },
    { w: 1.40, h: 0.022, d: 0.055, y: 0.925, z: -2.588, mat: 'chrome', r: 0.008 },
    { w: 1.40, h: 0.022, d: 0.055, y: 0.805, z: -2.588, mat: 'chrome', r: 0.008 },
    { w: 1.40, h: 0.022, d: 0.055, y: 0.745, z: -2.588, mat: 'chrome', r: 0.008 },
    // number plate in the gap between the inner lamps — the tail panel's centre was a black hole
    { w: 0.40, h: 0.155, d: 0.035, y: 0.865, z: -2.605, mat: 'chrome', r: 0.012 },
    { w: 0.46, h: 0.205, d: 0.03, y: 0.865, z: -2.598, mat: 'dark', r: 0.014 },
    { w: 1.48, h: 0.045, d: 0.05, y: 1.020, z: -2.576, mat: 'chrome', r: 0.014 }, // tail panel top edge
    { x: 0.862, w: 0.062, h: 0.125, d: 2.30, y: 0.470, z: -0.10, mat: 'dark', mirror: true, r: 0.025 },  // rocker
    // chrome sill blade under the rocker: the bright bottom edge every 70s coupe wears, and the
    // line that stops the lower flank fading into the contact shadow
    { x: 0.880, w: 0.028, h: 0.022, d: 2.20, y: 0.402, z: -0.10, mat: 'chrome', mirror: true, r: 0.008 },
    { x: 0.950, w: 0.045, h: 0.035, d: 2.10, y: 0.665, z: -0.10, mat: 'chrome', mirror: true, r: 0.014 }, // side spear
    { w: 1.50, h: 0.09, d: 0.30, y: 0.44, z: 2.40, mat: 'dark', rx: 0.10, r: 0.03 },      // front valance
    // Rear valance: deliberately 1.16 m across a 2.19 m car and lifted clear of the road, so the
    // rear tyres stand outboard of it and the road shows underneath (§6.1 round-2 gap).
    { w: 1.16, h: 0.17, d: 0.26, y: 0.415, z: -2.505, mat: 'dark', rx: -0.12, r: 0.045 },
    { w: 1.24, h: 0.045, d: 0.22, y: 0.336, z: -2.500, mat: 'chrome', r: 0.016 },
  ],
  wing: { type: 'ducktail', w: 1.50, chord: 0.30, y: 1.015, z: -2.26, mat: 'paint', aoa: -0.34 },
  exhaust: [{ x: 0.50, y: 0.435, z: -2.585, r: 0.070, len: 0.26 }],
  extras: [
    { type: 'blower', y: 1.19, z: 1.58 },
    /**
     * Period rear-window slat kit — but only across the LOWER third of the backlight now.
     *
     * At d 0.50 centred on z -1.60 it covered two thirds of the glass, and since the cabin behind
     * it was black the critic's read of the whole backlight was "a solid black rectangle with only
     * dotted defroster lines". The slats are a real Mopar detail and worth keeping; they just have
     * to leave the part of the glass the parcel shelf and head restraints are visible through.
     */
    { type: 'louvre', w: 1.26, d: 0.20, count: 4, y: 1.150, z: -1.80, rx: -0.576 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
