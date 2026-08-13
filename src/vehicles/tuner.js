import { assembleCar } from './assemble.js';

/**
 * KATANA GT-R — compact Japanese tuner. Silvia / Civic Type-R DNA: short overhangs,
 * low nose, big rear wing, aggressive body kit, small light wheels.
 *
 * Handling: nimble, high grip, quick to rotate and quick to catch. Nitrous = short sharp bursts.
 */
export const spec = {
  id: 'tuner',
  name: 'KATANA',
  full: 'KATANA GT-R SPEC-V',
  klass: 'TUNER',
  colors: ['#e8342b', '#1fb6d8', '#f5f2ea', '#7d2ce0', '#1b1d22', '#d8f218'],
  stats: { speed: 0.72, accel: 0.84, traction: 0.88, weight: 0.42 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

export const blueprint = {
  id: 'tuner', spec, colors: spec.colors,
  dims: { length: 4.44, width: 1.80, height: 1.34, wheelbase: 2.62, track: 1.52, rideHeight: 0.11 },
  paint: { metalness: 0.70, roughness: 0.20, clearcoat: 1.0, flake: 0.48 },
  livery: { style: 'racing', stripe: '#101216' },
  sections: [
    { z: -2.22, w: 0.74, yBot: 0.28, ySill: 0.44, yBelt: 0.86, yRoof: 0.92, roofW: 0.66 },
    { z: -2.00, w: 0.86, yBot: 0.23, ySill: 0.42, yBelt: 0.90, yRoof: 0.96, roofW: 0.78 },
    { z: -1.62, w: 0.90, yBot: 0.19, ySill: 0.40, yBelt: 0.93, yRoof: 0.99, roofW: 0.82, flare: 1.03 },
    { z: -1.20, w: 0.90, yBot: 0.17, ySill: 0.39, yBelt: 0.95, yRoof: 1.01, roofW: 0.82, flare: 1.02 },
    { z: -0.70, w: 0.88, yBot: 0.17, ySill: 0.38, yBelt: 0.96, yRoof: 1.02, roofW: 0.81 },
    { z: -0.10, w: 0.875, yBot: 0.17, ySill: 0.37, yBelt: 0.96, yRoof: 1.02, roofW: 0.80 },
    { z: 0.55, w: 0.88, yBot: 0.18, ySill: 0.38, yBelt: 0.95, yRoof: 1.01, roofW: 0.81 },
    { z: 1.10, w: 0.89, yBot: 0.19, ySill: 0.39, yBelt: 0.92, yRoof: 0.97, roofW: 0.82 },
    { z: 1.58, w: 0.90, yBot: 0.20, ySill: 0.40, yBelt: 0.88, yRoof: 0.93, roofW: 0.82, flare: 1.03 },
    { z: 1.96, w: 0.86, yBot: 0.22, ySill: 0.40, yBelt: 0.84, yRoof: 0.89, roofW: 0.78 },
    { z: 2.22, w: 0.72, yBot: 0.26, ySill: 0.42, yBelt: 0.80, yRoof: 0.85, roofW: 0.64 },
  ],
  greenhouse: {
    roofY: 1.34, beltY: 1.02, roofHalfWidth: 0.66, roofLength: 1.28, roofZ: -0.26,
    seatZ: -0.14, interiorColor: 0x22242c, blackPillars: true,
    pillars: [
      { bot: [0.74, 1.00], top: [0.30, 1.34], x: 0.65, w: 0.08, d: 0.10 },
      { bot: [-1.10, 0.99], top: [-0.82, 1.34], x: 0.65, w: 0.10, d: 0.13 },
    ],
    windshield: { w: 1.30, h: 0.68, y: 1.20, z: 0.54, rx: -0.66 },
    backlight: { w: 1.26, h: 0.72, y: 1.18, z: -0.76, rx: 0.62 },
    sideWindows: [{ x: 0.68, y: 1.19, z: -0.14, w: 1.18, h: 0.28 }],
  },
  wheels: {
    style: 'mesh', rimColor: '#b8bec8', caliperColor: '#e0b21c',
    front: { radius: 0.325, width: 0.24, spokes: 6, tireProfile: 0.28 },
    rear: { radius: 0.325, width: 0.27, spokes: 6, tireProfile: 0.28 },
  },
  archThickness: 0.04, blackArches: true,
  lights: {
    head: [{ x: 0.62, y: 0.76, z: 2.16, w: 0.42, h: 0.13, color: '#dfe9ff', intensity: 2.8 }],
    tail: [{ x: 0.60, y: 0.82, z: -2.24, w: 0.40, h: 0.12, color: '#ff2a18', intensity: 2.6 }],
  },
  grille: { w: 1.02, h: 0.22, y: 0.62, z: 2.20, slats: 5 },
  mirrors: { x: 0.80, y: 1.04, z: 0.44, painted: false },
  exhaust: [{ x: 0, y: 0.30, z: -2.26, r: 0.085, mirror: false }],
  trim: [
    { w: 1.70, h: 0.10, d: 0.30, y: 0.28, z: 2.22, mat: 'dark', rx: 0.1 },  // splitter
    { w: 1.64, h: 0.16, d: 0.26, y: 0.30, z: -2.26, mat: 'dark' },          // diffuser
    { x: 0.92, w: 0.10, h: 0.11, d: 2.1, y: 0.36, z: 0, mat: 'dark', mirror: true }, // side skirt
  ],
  wing: { type: 'pedestal', w: 1.52, chord: 0.30, x: 0.58, y: 1.28, z: -2.02, h: 0.30, painted: false },
  extras: [{ type: 'scoop', w: 0.42, d: 0.36, y: 1.00, z: 1.30, painted: true }],
};

export function build(opts) { return assembleCar(blueprint, opts); }
