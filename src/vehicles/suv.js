import { assembleCar } from './assemble.js';

/**
 * BRUTUS H2 — high-clearance off-road SUV, Hummer silhouette: square jaw, flat slab sides,
 * near-vertical windscreen, huge fender flares, roof rack, light bar, snorkel, knobbly tyres.
 *
 * Handling: heavy, high centre of gravity, lots of body roll, unbothered by kerbs and dirt.
 * Nitrous = slow-building freight-train push that keeps pulling at the top end.
 */
export const spec = {
  id: 'suv',
  name: 'BRUTUS',
  full: 'BRUTUS H2 OVERLAND',
  klass: 'OFF-ROAD',
  colors: ['#3f4a2e', '#c8a038', '#2b2f36', '#8c3520', '#d8d3c6', '#1d3b5c'],
  stats: { speed: 0.62, accel: 0.58, traction: 0.74, weight: 1.0 },
  // physics → handling.js · nitrous → nitrous.js NITRO · engine voicing → audio_tuning.js
  // (merged in by vehicles/index.js — do not add them back here)
};

export const blueprint = {
  id: 'suv', spec, colors: spec.colors,
  dims: { length: 4.92, width: 2.18, height: 2.02, wheelbase: 3.05, track: 1.86, rideHeight: 0.34 },
  paint: { metalness: 0.42, roughness: 0.44, clearcoat: 0.45, flake: 0.30 },
  livery: { style: 'twotone', stripe: '#22252b' },
  sections: [
    { z: -2.46, w: 1.02, yBot: 0.52, ySill: 0.72, yBelt: 1.34, yRoof: 1.42, roofW: 0.96, floor: 0.7 },
    { z: -2.30, w: 1.06, yBot: 0.48, ySill: 0.70, yBelt: 1.36, yRoof: 1.44, roofW: 1.00, floor: 0.7 },
    { z: -1.86, w: 1.09, yBot: 0.44, ySill: 0.68, yBelt: 1.38, yRoof: 1.46, roofW: 1.02, flare: 1.04, floor: 0.72 },
    { z: -1.30, w: 1.07, yBot: 0.42, ySill: 0.66, yBelt: 1.38, yRoof: 1.46, roofW: 1.02, floor: 0.72 },
    { z: -0.50, w: 1.06, yBot: 0.42, ySill: 0.65, yBelt: 1.38, yRoof: 1.46, roofW: 1.01, floor: 0.72 },
    { z: 0.40, w: 1.06, yBot: 0.42, ySill: 0.65, yBelt: 1.38, yRoof: 1.46, roofW: 1.01, floor: 0.72 },
    { z: 1.02, w: 1.07, yBot: 0.43, ySill: 0.66, yBelt: 1.36, yRoof: 1.44, roofW: 1.02, floor: 0.72 },
    { z: 1.62, w: 1.09, yBot: 0.44, ySill: 0.66, yBelt: 1.30, yRoof: 1.38, roofW: 1.02, flare: 1.04, floor: 0.72 },
    { z: 2.16, w: 1.06, yBot: 0.46, ySill: 0.68, yBelt: 1.26, yRoof: 1.34, roofW: 1.00, floor: 0.7 },
    { z: 2.40, w: 1.00, yBot: 0.50, ySill: 0.72, yBelt: 1.24, yRoof: 1.32, roofW: 0.94, floor: 0.7 },
    { z: 2.46, w: 0.92, yBot: 0.54, ySill: 0.76, yBelt: 1.22, yRoof: 1.30, roofW: 0.86, floor: 0.7 },
  ],
  greenhouse: {
    roofY: 2.02, beltY: 1.46, roofHalfWidth: 0.96, roofLength: 2.10, roofZ: -0.62,
    seatZ: 0.10, interiorColor: 0x2a2620, blackPillars: true,
    pillars: [
      { bot: [1.06, 1.44], top: [0.82, 2.02], x: 0.94, w: 0.12, d: 0.14 },   // A — near vertical
      { bot: [-0.10, 1.44], top: [-0.10, 2.02], x: 0.94, w: 0.10, d: 0.12 }, // B
      { bot: [-1.70, 1.44], top: [-1.72, 2.02], x: 0.94, w: 0.14, d: 0.16 }, // D
    ],
    windshield: { w: 1.86, h: 0.66, y: 1.74, z: 0.96, rx: -0.22 },
    backlight: { w: 1.84, h: 0.58, y: 1.74, z: -1.78, rx: 0.12 },
    sideWindows: [
      { x: 1.00, y: 1.74, z: 0.30, w: 1.06, h: 0.52 },
      { x: 1.00, y: 1.74, z: -0.98, w: 1.20, h: 0.52 },
    ],
  },
  wheels: {
    style: 'offroad', rimColor: '#8b9099', caliperColor: '#3a3f47',
    front: { radius: 0.475, width: 0.36, spokes: 6, tireProfile: 0.44 },
    rear: { radius: 0.475, width: 0.36, spokes: 6, tireProfile: 0.44 },
  },
  archThickness: 0.085, blackArches: true, archInset: 1.02,
  lights: {
    head: [{ x: 0.72, y: 1.12, z: 2.44, w: 0.30, h: 0.26, shape: 'round', color: '#f2f6ff', intensity: 3.0 }],
    tail: [{ x: 0.92, y: 1.14, z: -2.48, w: 0.16, h: 0.44, color: '#ff2a14', intensity: 2.4 }],
  },
  grille: { w: 1.36, h: 0.44, y: 1.10, z: 2.44, slats: 7 },
  mirrors: { x: 1.10, y: 1.58, z: 0.92, painted: false },
  exhaust: [{ x: 0.72, y: 0.48, z: -2.50, r: 0.07 }],
  trim: [
    { w: 2.06, h: 0.24, d: 0.26, y: 0.74, z: 2.48, mat: 'dark' },   // bull bar / bumper
    { w: 2.02, h: 0.22, d: 0.24, y: 0.72, z: -2.52, mat: 'dark' },
    { x: 1.12, w: 0.12, h: 0.16, d: 2.6, y: 0.66, z: 0, mat: 'dark', mirror: true },  // rock slider
    { w: 1.30, h: 0.10, d: 0.60, y: 0.44, z: 2.10, mat: 'dark' },   // skid plate
  ],
  extras: [
    { type: 'rack', w: 1.72, d: 1.90, y: 2.06, z: -0.62 },
    { type: 'lightbar', w: 1.50, count: 7, y: 2.16, z: 0.34 },
    { type: 'snorkel', x: 1.02, y: 1.62, z: 1.30 },
  ],
};

export function build(opts) { return assembleCar(blueprint, opts); }
