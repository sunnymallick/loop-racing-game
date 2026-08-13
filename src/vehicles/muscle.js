import { assembleCar } from './assemble.js';

/**
 * VELOCE DOMINATOR — American muscle. 1970 Charger / Mustang fastback DNA:
 * long hood, short deck, high beltline, huge rear haunches, four round taillights,
 * a supercharger through the hood.
 *
 * Handling: heavy, torque-rich, tail-happy. Nitrous = brutal sustained shove.
 */
export const spec = {
  id: 'muscle',
  name: 'DOMINATOR',
  full: '1970 DOMINATOR 440',
  klass: 'MUSCLE',
  colors: ['#1f7a5e', '#8e1c1c', '#20304f', '#e0a11c', '#141519', '#5d2a7a'],
  stats: { speed: 0.86, accel: 0.78, traction: 0.55, weight: 0.92 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

export const blueprint = {
  id: 'muscle', spec, colors: spec.colors,
  dims: { length: 5.16, width: 1.96, height: 1.42, wheelbase: 2.98, track: 1.60, rideHeight: 0.16 },
  paint: { metalness: 0.78, roughness: 0.22, clearcoat: 1.0, flake: 0.62 },
  livery: { style: 'stripes', stripe: '#f2f2ee' },
  sections: [
    { z: -2.58, w: 0.78, yBot: 0.36, ySill: 0.52, yBelt: 0.86, yRoof: 0.92, roofW: 0.70 },
    { z: -2.34, w: 0.90, yBot: 0.30, ySill: 0.50, yBelt: 0.92, yRoof: 0.98, roofW: 0.82 },
    { z: -1.95, w: 0.96, yBot: 0.25, ySill: 0.47, yBelt: 0.95, yRoof: 1.01, roofW: 0.87, flare: 1.02 },
    { z: -1.50, w: 0.98, yBot: 0.22, ySill: 0.45, yBelt: 0.96, yRoof: 1.03, roofW: 0.88, flare: 1.03 },
    { z: -1.05, w: 0.96, yBot: 0.22, ySill: 0.45, yBelt: 0.98, yRoof: 1.05, roofW: 0.87 },
    { z: -0.45, w: 0.955, yBot: 0.23, ySill: 0.44, yBelt: 1.00, yRoof: 1.07, roofW: 0.86 },
    { z: 0.30, w: 0.95, yBot: 0.23, ySill: 0.44, yBelt: 1.00, yRoof: 1.07, roofW: 0.86 },
    { z: 0.98, w: 0.955, yBot: 0.24, ySill: 0.45, yBelt: 0.99, yRoof: 1.05, roofW: 0.88 },
    { z: 1.52, w: 0.96, yBot: 0.25, ySill: 0.46, yBelt: 0.96, yRoof: 1.02, roofW: 0.88 },
    { z: 2.00, w: 0.98, yBot: 0.26, ySill: 0.46, yBelt: 0.94, yRoof: 1.00, roofW: 0.88, flare: 1.02 },
    { z: 2.40, w: 0.92, yBot: 0.30, ySill: 0.48, yBelt: 0.90, yRoof: 0.96, roofW: 0.84 },
    { z: 2.58, w: 0.80, yBot: 0.36, ySill: 0.52, yBelt: 0.86, yRoof: 0.92, roofW: 0.72 },
  ],
  greenhouse: {
    roofY: 1.42, beltY: 1.07, roofHalfWidth: 0.71, roofLength: 1.44, roofZ: -0.34,
    seatZ: -0.20, interiorColor: 0x191b21, blackPillars: false,
    pillars: [
      { bot: [0.96, 1.05], top: [0.44, 1.42], x: 0.70, w: 0.10, d: 0.12 },     // A
      { bot: [-1.32, 1.02], top: [-0.98, 1.42], x: 0.70, w: 0.13, d: 0.16 },   // C (fastback sail)
    ],
    windshield: { w: 1.40, h: 0.76, y: 1.26, z: 0.72, rx: -0.60 },
    backlight: { w: 1.36, h: 0.92, y: 1.24, z: -0.90, rx: 0.52 },
    sideWindows: [{ x: 0.735, y: 1.25, z: -0.18, w: 1.34, h: 0.31 }],
  },
  wheels: {
    style: 'fivespoke', rimColor: '#d7dbe0', caliperColor: '#b81c1c',
    front: { radius: 0.355, width: 0.26, spokes: 5, tireProfile: 0.36 },
    rear: { radius: 0.375, width: 0.34, spokes: 5, tireProfile: 0.38 },
  },
  archThickness: 0.055, archInset: 0.99,
  lights: {
    head: [{ x: 0.62, y: 0.80, z: 2.52, w: 0.30, h: 0.22, shape: 'round', color: '#eef4ff', intensity: 2.4 }],
    tail: [
      { x: 0.38, y: 0.82, z: -2.60, w: 0.20, h: 0.20, shape: 'round', color: '#ff1e10', intensity: 2.8 },
      { x: 0.66, y: 0.82, z: -2.60, w: 0.20, h: 0.20, shape: 'round', color: '#ff1e10', intensity: 2.8 },
    ],
  },
  grille: { w: 1.52, h: 0.30, y: 0.80, z: 2.545, slats: 9 },
  mirrors: { x: 0.86, y: 1.10, z: 0.60, painted: true },
  exhaust: [{ x: 0.52, y: 0.34, z: -2.62, r: 0.055 }],
  trim: [
    { w: 1.86, h: 0.10, d: 0.16, y: 0.72, z: 2.56, mat: 'chrome' },   // front bumper
    { w: 1.80, h: 0.10, d: 0.16, y: 0.70, z: -2.62, mat: 'chrome' },  // rear bumper
    { x: 0.99, w: 0.06, h: 0.09, d: 2.4, y: 0.44, z: 0, mat: 'dark', mirror: true }, // rocker
  ],
  wing: { type: 'lip', w: 1.62, chord: 0.26, y: 1.06, z: -2.28 },
  extras: [{ type: 'blower', y: 1.20, z: 1.62 }],
};

export function build(opts) { return assembleCar(blueprint, opts); }
