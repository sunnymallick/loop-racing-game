import { assembleCar } from './assemble.js';

/**
 * VIPERA SV — mid-engine supercar. Ford GT / 488 DNA: a cab-forward wedge with the cabin pushed
 * onto the front axle, a nose that is almost on the floor, huge side intakes feeding the engine,
 * flying buttresses running from the roof to the rear haunches, a vented engine cover, round
 * taillights (reference f&f3) and a full-width diffuser.
 *
 * Silhouette test (§2.3): lowest car in the game, with the peak of the roof forward of centre and
 * the rear deck HIGHER than the bonnet — that inversion is what says "mid-engine".
 *
 * Handling: enormous grip, sharp turn-in, snappy but catchable at the limit.
 * Nitrous = instant violent kick with the highest top-speed multiplier.
 */
export const spec = {
  id: 'supercar',
  name: 'VIPERA',
  full: 'VIPERA SV COMPETIZIONE',
  klass: 'SUPERCAR',
  colors: ['#e01a2c', '#f7cd14', '#1a44b8', '#eef0f4', '#1b2028', '#00cfa0'],
  stats: { speed: 1.0, accel: 0.96, traction: 0.92, weight: 0.5 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

const V = (z) => (z + 2.31) / 4.62;

export const blueprint = {
  id: 'supercar', spec, colors: spec.colors,
  // Round 1's 1.70 front track left the front tyre 11 cm inboard of the fender, sitting in an open
  // cavity — the exact §6.1 hard cap. The tub is 1.045 / 1.085 half-wide at the arches; match it.
  // Rear track and tail width are set against each other so the rear tyres stand 24 cm outboard of
  // the tail panel on each side — from a straight-on chase view the wheels break the silhouette
  // instead of hiding behind a full-width diffuser (§6.1 round-2 gap).
  dims: { length: 4.62, width: 2.32, height: 1.25, wheelbase: 2.68, track: 1.820, trackRear: 1.906, rideHeight: 0.11 },
  // the glossiest car in the game: show-car clearcoat over metallic red
  paint: { metalness: 0.55, roughness: 0.22, clearcoat: 1.0, clearcoatRoughness: 0.042, flake: 0.58, envIntensity: 1.28 },
  livery: {
    style: 'gt', stripe: '#eef1f5', accent: '#14171c',
    panels: {
      doors: [V(0.94), V(-0.52)],
      hood: [V(1.02), V(2.10)],
      boot: [V(-2.14), V(-0.80)],
      arches: [V(1.34), V(-1.34)],
    },
  },
  // see muscle.js — 0.74 made the cabin a §7 black void behind the wraparound screen
  glass: { tint: '#0c131a', opacity: 0.62 },

  /**
   * ROUND-4 SURFACING PASS ON THE WINGS.
   *
   * Round-2 note, verbatim: "a pale untextured shelf polygon at the top of the supercar's fenders
   * that reads as stray geometry". It was not stray — it was the top of the wing — but it was
   * authored with 10-12 mm of crown across an 850 mm half-panel, i.e. dead flat, so it presented
   * one horizontal plane straight at the sky, took one constant value off the reflection, and read
   * as a bright rectangle sitting on the car rather than as part of it. Every wing station (front
   * and rear) now carries 30-44 mm of crown over a narrower flat, so the panel rolls from the arch
   * up to the bonnet/engine-deck line and the sky reflection SWEEPS across it instead of filling it.
   */
  body: [
    { z: -2.31, w: 0.790, y0: 0.25, floor: 0.58, rocker: 0.95, ySill: 0.36, yBelt: 0.82, belt: 0.96, yDeck: 0.855, deck: 0.93, crown: 0.004 },
    { z: -2.24, w: 0.882, y0: 0.22, floor: 0.62, rocker: 0.94, ySill: 0.33, yBelt: 0.86, belt: 0.955, yDeck: 0.895, deck: 0.90, crown: 0.006 },
    { z: -2.05, w: 0.930, y0: 0.19, rocker: 0.925, ySill: 0.31, yBelt: 0.90, belt: 0.95, yDeck: 0.945, deck: 0.84, crown: 0.026, flare: 1.01 },
    { z: -1.70, w: 0.990, y0: 0.17, rocker: 0.915, ySill: 0.295, yBelt: 0.938, belt: 0.945, yDeck: 0.968, deck: 0.80, crown: 0.040, flare: 1.052 },
    { z: -1.34, w: 1.000, y0: 0.16, rocker: 0.905, ySill: 0.29, yBelt: 0.948, belt: 0.945, yDeck: 0.980, deck: 0.79, crown: 0.044, flare: 1.085 },
    { z: -1.00, w: 0.994, y0: 0.158, rocker: 0.90, ySill: 0.285, yBelt: 0.938, belt: 0.945, yDeck: 0.968, deck: 0.79, crown: 0.042, flare: 1.032 },
    { z: -0.86, w: 0.994, y0: 0.158, rocker: 0.900, ySill: 0.285, yBelt: 0.930, belt: 0.945, yDeck: 0.950, deck: 0.80, crown: 0.036 },
    { z: -0.80, w: 0.992, y0: 0.158, rocker: 0.899, ySill: 0.284, yBelt: 0.926, belt: 0.945, yDeck: 0.672, deck: 0.83, crown: 0.006 },
    { z: -0.52, w: 0.985, y0: 0.156, rocker: 0.895, ySill: 0.282, yBelt: 0.916, belt: 0.945, yDeck: 0.660, deck: 0.83, crown: 0.006 },
    { z: -0.20, w: 0.980, y0: 0.154, rocker: 0.89, ySill: 0.278, yBelt: 0.900, belt: 0.945, yDeck: 0.640, deck: 0.83, crown: 0.006 },
    { z: 0.42, w: 0.976, y0: 0.152, rocker: 0.885, ySill: 0.275, yBelt: 0.876, belt: 0.945, yDeck: 0.640, deck: 0.83, crown: 0.006 },
    { z: 0.86, w: 0.978, y0: 0.152, rocker: 0.885, ySill: 0.276, yBelt: 0.848, belt: 0.945, yDeck: 0.660, deck: 0.84, crown: 0.006 },
    { z: 0.94, w: 0.979, y0: 0.152, rocker: 0.885, ySill: 0.276, yBelt: 0.845, belt: 0.945, yDeck: 0.828, deck: 0.86, crown: 0.010 },
    { z: 1.10, w: 0.983, y0: 0.152, rocker: 0.888, ySill: 0.274, yBelt: 0.822, belt: 0.945, yDeck: 0.790, deck: 0.80, crown: 0.038, flare: 1.026 },
    { z: 1.34, w: 0.990, y0: 0.154, rocker: 0.892, ySill: 0.272, yBelt: 0.784, belt: 0.945, yDeck: 0.748, deck: 0.79, crown: 0.042, flare: 1.055 },
    { z: 1.62, w: 0.985, y0: 0.156, rocker: 0.895, ySill: 0.270, yBelt: 0.742, belt: 0.945, yDeck: 0.710, deck: 0.80, crown: 0.040, flare: 1.048 },
    { z: 1.94, w: 0.966, y0: 0.160, rocker: 0.905, ySill: 0.272, yBelt: 0.692, belt: 0.95, yDeck: 0.666, deck: 0.83, crown: 0.030, flare: 1.012 },
    { z: 2.16, w: 0.930, y0: 0.170, rocker: 0.92, ySill: 0.282, yBelt: 0.648, belt: 0.955, yDeck: 0.636, deck: 0.89, crown: 0.008 },
    { z: 2.28, w: 0.870, y0: 0.185, floor: 0.60, rocker: 0.94, ySill: 0.295, yBelt: 0.612, belt: 0.96, yDeck: 0.602, deck: 0.91, crown: 0.005 },
    { z: 2.31, w: 0.775, y0: 0.205, floor: 0.55, rocker: 0.95, ySill: 0.315, yBelt: 0.588, belt: 0.965, yDeck: 0.580, deck: 0.92, crown: 0.004 },
  ],

  cabin: {
    stations: [
      { z: 0.92, hw: 0.900, rw: 0.858, yBelt: 0.842, yRoof: 0.860 },
      { z: 0.88, hw: 0.904, rw: 0.812, yBelt: 0.845, yRoof: 0.940 },
      { z: 0.56, hw: 0.914, rw: 0.706, yBelt: 0.864, yRoof: 1.118 },
      { z: 0.30, hw: 0.920, rw: 0.648, yBelt: 0.876, yRoof: 1.222 },
      { z: -0.10, hw: 0.924, rw: 0.636, yBelt: 0.892, yRoof: 1.240 },
      { z: -0.42, hw: 0.926, rw: 0.652, yBelt: 0.906, yRoof: 1.196 },
      { z: -0.66, hw: 0.928, rw: 0.712, yBelt: 0.916, yRoof: 1.086 },
      { z: -0.80, hw: 0.928, rw: 0.804, yBelt: 0.921, yRoof: 0.972 },
    ],
    roof: { z0: -0.50, z1: 0.26, a: 5, offset: 0.013 },
    pillars: [
      { z0: 0.30, z1: 0.92, a: 2, b: 5, mat: 'dark', steps: 5 },      // A-pillar
      { z0: -0.40, z1: -0.80, a: 2, b: 5, mat: 'paint', steps: 5 },   // buttress root
    ],
    beltZ0: -0.44, beltZ1: 0.34, beltMat: 'dark',
    // Two seats and an engine bulkhead — no rear shelf humps on a mid-engine car (rearHeads:false),
    // the roll hoops do that job. Alcantara grey with the car's own red on the bolsters.
    interior: { seat: 0x4a4f5a, trim: 0x33373f, accent: 0xc9202f, floorY: 0.655, headY: 1.095, dashY: 0.875, wheelY: 0.915, shelfY: 0.895, seatZ: 0.04, dashZ: 0.70, dashW: 1.30, seatX: 0.34, shelfZ: 0.60, shelfD: 0.28, rearHeads: false, rollBar: true, clusterColor: '#ffd166' },
  },

  wheels: {
    // dark forged turbofan on semi-slick rubber — near-solid tread, four fine grooves
    style: 'turbofan', rimColor: '#262a32', caliperColor: '#f0c419', lipColor: '#8a919c', tire: 'slick',
    capColor: '#f0c419',
    front: { radius: 0.350, width: 0.30, spokes: 10, tireProfile: 0.215 },
    rear: { radius: 0.390, width: 0.42, spokes: 10, tireProfile: 0.210 },
  },
  archThickness: 0.050, archGap: 1.042, archFlare: 0.030, archSpan: 1.04,

  lights: {
    head: [
      { x: 0.64, y: 0.545, z: 2.245, w: 0.36, h: 0.10, shape: 'strip', color: '#e6efff', intensity: 3.4 },
      { x: 0.62, y: 0.415, z: 2.235, w: 0.22, h: 0.06, shape: 'strip', color: '#4fd8ff', intensity: 2.6, glow: 0.5 },
    ],
    // the twin round lamp rings of f&f3 — clear of the carbon blade above them so they read whole
    tail: [
      { x: 0.40, y: 0.870, z: -2.360, w: 0.22, h: 0.22, shape: 'round', color: '#ff2410', intensity: 2.3 },
      { x: 0.71, y: 0.870, z: -2.360, w: 0.22, h: 0.22, shape: 'round', color: '#ff2410', intensity: 2.3 },
      // high-mount stop lamp in the carbon tail blade; shares the round lamps' bank
      { x: 0, y: 0.995, z: -2.398, w: 0.30, h: 0.042, shape: 'strip', color: '#ff2410', intensity: 2.3, mirror: false, bezel: false },
    ],
    reverse: [{ x: 0.0, y: 0.585, z: -2.365, w: 0.16, h: 0.08, color: '#fff2d8', intensity: 1.6, glow: 0.3, mirror: false }],
  },

  grilles: [
    { w: 0.84, h: 0.16, d: 0.14, y: 0.345, z: 2.285, slats: 4, mesh: true, frame: 'dark' },
    { x: 0.60, w: 0.34, h: 0.13, d: 0.12, y: 0.375, z: 2.205, slats: 3, mesh: true, frame: 'dark', mirror: true },
    { x: 0.912, w: 0.44, h: 0.26, d: 0.16, y: 0.635, z: -0.98, slats: 4, mesh: true, frame: 'dark', ry: 1.5708, mirror: true }, // side intakes
    { w: 1.16, h: 0.28, d: 0.13, y: 0.685, z: -2.325, slats: 6, mesh: true, frame: 'dark' },                      // rear extractor grille
  ],
  vents: [
    { x: 0.42, y: 0.995, z: -1.30, w: 0.44, h: 0.30, fins: 5, angle: 0.55, rx: -1.5708 },   // engine cover louvres
    { x: 0.30, y: 0.70, z: 2.14, w: 0.30, h: 0.14, fins: 3, angle: 0.6, rx: -1.4 },          // bonnet extractors
  ],
  mirrors: { x: 0.90, y: 0.90, z: 0.62, painted: true },
  handles: [{ x: 0.965, y: 0.80, z: -0.10, mat: 'paint' }],

  trim: [
    { w: 1.74, h: 0.08, d: 0.40, y: 0.170, z: 2.20, mat: 'carbon', rx: 0.07, r: 0.03 },      // front splitter
    { x: 0.815, w: 0.26, h: 0.02, d: 0.22, y: 0.285, z: 2.03, mat: 'carbon', rz: 0.14, mirror: true, r: 0.008 },  // dive planes
    { x: 0.985, w: 0.10, h: 0.12, d: 1.90, y: 0.275, z: -0.10, mat: 'carbon', mirror: true, r: 0.03 },  // side sill
    // a painted blade capping the sill, and a polished one under it: the carbon between them then
    // reads as a channel with a top and a bottom edge instead of a black stripe down the car
    { x: 0.978, w: 0.055, h: 0.030, d: 1.86, y: 0.344, z: -0.10, mat: 'paint', mirror: true, r: 0.011 },
    { x: 0.992, w: 0.040, h: 0.026, d: 1.80, y: 0.216, z: -0.10, mat: 'chrome', mirror: true, r: 0.010 },
    // rear valance blade above the diffuser
    { w: 1.28, h: 0.048, d: 0.09, y: 0.478, z: -2.318, mat: 'chrome', r: 0.016 },
    { w: 1.30, h: 0.075, d: 0.10, y: 0.585, z: 2.268, mat: 'dark', r: 0.028 },   // nose blade under the lamps
    { w: 1.46, h: 0.075, d: 0.10, y: 0.995, z: -2.345, mat: 'carbon', r: 0.025 },   // tail blade, above the lamps
    { w: 0.46, h: 0.15, d: 0.04, y: 0.615, z: -2.352, mat: 'dark', r: 0.02 },       // number-plate recess
  ],
  // swan-neck: the blade hangs UNDER its mounts and the endplates are the full chord. Nothing
  // like the tuner's tall twin-element pedestal wing (§6.1 round-2: the two shared one wing).
  wing: { type: 'swan', w: 1.66, chord: 0.36, x: 0.60, y: 1.075, z: -2.03, h: 0.20, mat: 'carbon', postMat: 'chrome', aoa: -0.16 },
  // 1.20 m wide on a 2.28 m car and lifted to 0.36: the rear tyres are what fills the corners now
  diffuser: { w: 1.20, h: 0.26, d: 0.34, y: 0.355, z: -2.235, strakes: 5, rx: 0.34, mat: 'carbon' },
  exhaust: [{ x: 0.235, y: 0.545, z: -2.36, r: 0.072, len: 0.22 }],
  extras: [
    // Round 2 stood a 280 mm PAINTED blade on each side of the engine deck: from any side view it
    // read as a red dorsal fin the height of the roof and the rear of the car became a heap of
    // slabs. These are now low carbon deck strakes flanking the louvred engine cover.
    { type: 'buttress', x: 0.615, y: 0.985, z: -1.14, h: 0.135, d: 0.88, rx: 0.09, painted: false },
    // the hoops used to float 340 mm above the deck they are supposed to be bolted to
    { type: 'rollhoop', x: 0.325, y: 0.655, z: -0.50, r: 0.165 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
