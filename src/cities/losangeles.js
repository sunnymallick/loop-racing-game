import * as THREE from 'three';
import { buildCity, building, billboard } from './kit.js';
import { roundedBox } from '../vehicles/kit.js';
import { drawText } from '../core/font.js';
import { canvas, toTexture } from '../core/textures.js';

/**
 * LOS ANGELES — golden hour. Warm low sun raking down a palm-lined boulevard, hazy pink-orange
 * sky, hills with a hillside sign, downtown towers glinting in the distance, a freeway overpass.
 * Palette: sunset orange / hot pink / turquoise shadow.
 */
export const def = {
  id: 'la',
  name: 'LOS ANGELES',
  seed: 101,
  spawnU: 0.0,
  laps: 3,
  record: '2:04:60',
  look: {
    accent: '#ff8a1e',
    lampColor: '#ffd08a',
    wet: 0,
    sky: {
      top: '#1e63c8', horizon: '#ffb36b', ground: '#3a2a26',
      haze: '#ffd0a0', sunDir: [-0.75, 0.16, 0.32], sunColor: '#fff0c8', clouds: 0.32, seed: 101,
    },
    sun: { color: '#ffd39a', intensity: 3.4, dir: [-0.62, 0.74, 0.30] },
    ambient: {
      sky: '#9fd0ff', ground: '#7a5740', intensity: 1.55,
      fill: { color: '#5f92cc', intensity: 0.70, dir: [0.6, 0.5, -0.4] },
    },
    fog: { color: '#e8b98a', near: 120, far: 1500 },
    ground: { color: '#6a5a4c' },
    grade: {
      uSaturation: 1.24, uExposure: 1.08, uContrast: 1.07,
      uLift: '#160f12', uGain: '#fff0dc', uVignette: 0.22,
    },
    bloom: { strength: 0.78, radius: 0.62, threshold: 0.74 },
  },
  track: {
    width: 10.5,
    surface: { tint: '#2a2b30', lanes: 2, centerLine: 'double-yellow', worn: 0.7 },
    bank: 0.06,
    main: [
      [0, 0], [140, -18], [270, -70], [350, -170], [355, -290], [300, -380],
      [190, -430], [60, -430], [-70, -400], [-170, -330], [-230, -230],
      [-250, -120], [-200, -30], [-100, 20], [0, 0],
    ],
    branches: [
      { kind: 'shortcut', enterU: 0.16, exitU: 0.30, width: 6.5, points: [[330, -120], [345, -190], [320, -250]] },
      { kind: 'ramp', enterU: 0.58, exitU: 0.66, width: 8, rise: 7, points: [[15, -430], [-40, -418]] },
    ],
  },
  blocks: {
    spacing: 44, offset: 24, jitter: 10,
    minW: 14, maxW: 32, minH: 18, maxH: 90,
    wallColors: ['#c8b39a', '#e0d2bd', '#8f7f70', '#b8a48c', '#6f6257'],
    glassColors: ['#2a4257', '#1e3448', '#3a5a70'],
    litColors: ['#ffd9a0', '#ffc478'],
    neonColors: ['#ff2f6d', '#ffb020', '#2fd8e0'],
    lowColors: ['#e8d9c0', '#d8b89a', '#c8a888'],
    signs: ['DINER', 'MOTEL', 'TACOS', 'LIQUOR', 'DONUTS', 'SUNSET'],
    litRatio: 0.3, setbackChance: 0.34, accentChance: 0.12,
    pick: (r) => (r.bool(0.46) ? 'low' : 'tower'),
  },
  props: {
    lampStyle: 'modern', lampSpacing: 36, lampHeight: 9,
    palms: true, palmSpacing: 22,
    barriers: false,
    billboards: [
      { u: 0.10, side: 1, text: 'SUNSET', sub: 'BLVD', color: '#ff2f6d', offset: 20 },
      { u: 0.44, side: -1, text: 'NITRO', sub: 'CIRCUIT', color: '#ffb020', offset: 22 },
      { u: 0.78, side: 1, text: 'HOLLYWOOD', sub: '', color: '#2fd8e0', offset: 18 },
    ],
    boostPads: [
      { u: 0.07, lateral: 0 }, { u: 0.35, lateral: -0.4 },
      { u: 0.62, lateral: 0.35 }, { u: 0.88, lateral: 0 },
    ],
  },
  skyline: {
    radius: 1050, count: 70, minH: 70, maxH: 300, spread: 300,
    palette: ['#5b6b80', '#4a5a70', '#6b7a90'], accent: '#ffb070',
  },
  landmarks({ track, rng, night }) {
    const out = [];

    // --- hillside letters on a ridge ---
    const hill = new THREE.Mesh(
      new THREE.SphereGeometry(340, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x6f6247, roughness: 1.0 }),
    );
    hill.scale.set(1.6, 0.42, 1.0);
    hill.position.set(520, -80, -560);
    hill.receiveShadow = true;
    out.push(hill);

    const word = 'HOLLYWOOD';
    for (let i = 0; i < word.length; i++) {
      const { c, ctx } = canvas(128, 160);
      drawText(ctx, word[i], { x: 64, y: 132, size: 120, weight: 0.22, align: 'center', color: '#f2ece0' });
      const t = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(26, 33),
        new THREE.MeshStandardMaterial({ map: t, transparent: true, side: THREE.DoubleSide, roughness: 0.9, emissive: night ? 0x888888 : 0x000000, emissiveIntensity: night ? 0.6 : 0 }),
      );
      m.position.set(360 + i * 30, 108, -520 + i * 8);
      m.rotation.y = -0.5;
      out.push(m);
    }

    // --- freeway overpass crossing the route ---
    const s = track.at(0.24);
    const deck = new THREE.Mesh(
      roundedBox(150, 2.2, 22, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.92 }),
    );
    deck.position.copy(s.pos).setY(15);
    deck.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2;
    deck.castShadow = true; deck.receiveShadow = true;
    out.push(deck);
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      const pier = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.6, 15, 12),
        new THREE.MeshStandardMaterial({ color: 0x8d8880, roughness: 0.95 }),
      );
      pier.position.copy(s.pos).addScaledVector(s.right, i * 26).setY(7.5);
      pier.castShadow = true;
      out.push(pier);
    }

    // --- palm-lined median with a giant sun-flare arch ---
    const s2 = track.at(0.70);
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(20, 0.9, 10, 32, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xff8a1e }),
    );
    arch.position.copy(s2.pos).setY(2);
    arch.rotation.y = Math.atan2(s2.tan.x, s2.tan.z);
    out.push(arch);
    const archLight = new THREE.PointLight(0xff8a1e, 24, 70, 2);
    archLight.position.copy(s2.pos).setY(14);
    out.push(archLight);

    void rng;
    return out;
  },
};

export function build(opts) { return buildCity(def, opts); }
