import { assembleCar } from './assemble.js';

/**
 * VIPERA SV — mid-engine supercar. Ford GT / 488 DNA: cab-forward wedge, dramatic side intakes,
 * flying buttresses, huge rear diffuser, round taillights (reference f&f3), engine cover with vents.
 *
 * Handling: enormous grip, sharp turn-in, snappy but catchable at the limit.
 * Nitrous = instant violent kick with the highest top-speed multiplier.
 */
export const spec = {
  id: 'supercar',
  name: 'VIPERA',
  full: 'VIPERA SV COMPETIZIONE',
  klass: 'SUPERCAR',
  colors: ['#a5121f', '#f2c400', '#0e2f8c', '#e8e9ec', '#12161b', '#00b489'],
  stats: { speed: 1.0, accel: 0.96, traction: 0.92, weight: 0.5 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

export const blueprint = {
  id: 'supercar', spec, colors: spec.colors,
  dims: { length: 4.62, width: 2.00, height: 1.17, wheelbase: 2.68, track: 1.70, rideHeight: 0.09 },
  paint: { metalness: 0.80, roughness: 0.16, clearcoat: 1.0, flake: 0.58 },
  sections: [
    { z: -2.31, w: 0.86, yBot: 0.24, ySill: 0.40, yBelt: 0.86, yRoof: 0.94, roofW: 0.80 },
    { z: -2.10, w: 0.96, yBot: 0.20, ySill: 0.38, yBelt: 0.90, yRoof: 0.98, roofW: 0.88 },
    { z: -1.70, w: 1.00, yBot: 0.16, ySill: 0.36, yBelt: 0.92, yRoof: 1.00, roofW: 0.90, flare: 1.02 },
    { z: -1.24, w: 1.00, yBot: 0.14, ySill: 0.34, yBelt: 0.94, yRoof: 1.02, roofW: 0.88, flare: 1.02 },
    { z: -0.70, w: 0.97, yBot: 0.13, ySill: 0.32, yBelt: 0.92, yRoof: 1.00, roofW: 0.84 },
    { z: -0.15, w: 0.95, yBot: 0.12, ySill: 0.30, yBelt: 0.88, yRoof: 0.96, roofW: 0.80 },
    { z: 0.45, w: 0.94, yBot: 0.12, ySill: 0.29, yBelt: 0.82, yRoof: 0.90, roofW: 0.80 },
    { z: 1.05, w: 0.94, yBot: 0.12, ySill: 0.29, yBelt: 0.74, yRoof: 0.80, roofW: 0.82 },
    { z: 1.60, w: 0.96, yBot: 0.13, ySill: 0.30, yBelt: 0.66, yRoof: 0.72, roofW: 0.84, flare: 1.02 },
    { z: 2.06, w: 0.92, yBot: 0.15, ySill: 0.31, yBelt: 0.60, yRoof: 0.66, roofW: 0.80 },
    { z: 2.31, w: 0.78, yBot: 0.18, ySill: 0.33, yBelt: 0.56, yRoof: 0.62, roofW: 0.66 },
  ],
  greenhouse: {
    roofY: 1.17, beltY: 0.96, roofHalfWidth: 0.62, roofLength: 0.92, roofZ: -0.10,
    seatZ: 0.02, interiorColor: 0x1c1f26, blackPillars: true,
    pillars: [
      { bot: [0.52, 0.94], top: [0.30, 1.17], x: 0.60, w: 0.08, d: 0.10 },
      { bot: [-0.72, 0.98], top: [-0.54, 1.17], x: 0.60, w: 0.11, d: 0.14 },   // flying buttress
    ],
    windshield: { w: 1.20, h: 0.66, y: 1.06, z: 0.44, rx: -0.86 },
    backlight: { w: 1.10, h: 0.42, y: 1.06, z: -0.62, rx: 0.72 },
    sideWindows: [{ x: 0.64, y: 1.06, z: -0.06, w: 0.80, h: 0.20 }],
  },
  wheels: {
    style: 'turbofan', rimColor: '#2c3037', caliperColor: '#f0c419',
    front: { radius: 0.345, width: 0.28, spokes: 10, tireProfile: 0.26 },
    rear: { radius: 0.365, width: 0.36, spokes: 10, tireProfile: 0.26 },
  },
  archThickness: 0.05, archInset: 0.995,
  lights: {
    head: [{ x: 0.66, y: 0.58, z: 2.24, w: 0.36, h: 0.11, color: '#e6efff', intensity: 3.2 }],
    tail: [
      { x: 0.40, y: 0.86, z: -2.33, w: 0.19, h: 0.19, shape: 'round', color: '#ff2410', intensity: 3.2 },
      { x: 0.70, y: 0.86, z: -2.33, w: 0.19, h: 0.19, shape: 'round', color: '#ff2410', intensity: 3.2 },
    ],
  },
  grille: { w: 0.86, h: 0.20, y: 0.42, z: 2.28, slats: 4 },
  mirrors: { x: 0.92, y: 0.98, z: 0.52, painted: true },
  exhaust: [{ x: 0.30, y: 0.44, z: -2.34, r: 0.06 }],
  trim: [
    { w: 1.72, h: 0.08, d: 0.34, y: 0.16, z: 2.24, mat: 'dark', rx: 0.08 },  // front splitter
    { w: 1.76, h: 0.30, d: 0.34, y: 0.28, z: -2.30, mat: 'dark' },           // rear diffuser
    { x: 0.98, w: 0.09, h: 0.13, d: 2.0, y: 0.28, z: -0.2, mat: 'dark', mirror: true }, // side sill
    { x: 0.86, w: 0.22, h: 0.34, d: 0.70, y: 0.72, z: -0.85, mat: 'dark', mirror: true }, // side intake
  ],
  wing: { type: 'pedestal', w: 1.62, chord: 0.34, x: 0.62, y: 1.10, z: -2.06, h: 0.22, painted: false },
  extras: [{ type: 'scoop', w: 0.90, d: 0.70, y: 1.00, z: -1.10, painted: false }],  // engine cover vent
};

export function build(opts) { return assembleCar(blueprint, opts); }
