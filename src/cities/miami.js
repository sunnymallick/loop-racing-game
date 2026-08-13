import * as THREE from 'three';
import { buildCity } from './kit.js';
import { roundedBox } from '../vehicles/kit.js';
import { canvas, toTexture } from '../core/textures.js';
import { drawText } from '../core/font.js';

/**
 * MIAMI — late-afternoon into dusk on the ocean drive. Art-deco pastels (flamingo pink, mint,
 * cream) with neon underlighting, turquoise water on one side, palms everywhere, a causeway
 * bridge and a cruise ship on the horizon. Palette: pink / turquoise / cream.
 */
export const def = {
  id: 'miami',
  name: 'MIAMI',
  seed: 303,
  spawnU: 0.0,
  laps: 3,
  record: '2:08:15',
  look: {
    accent: '#ff4fa8',
    lampColor: '#ffd6c0',
    wet: 0.18,
    sky: {
      top: '#2b4fd0', horizon: '#ff9ec0', ground: '#2a3a48',
      haze: '#ffc8d8', sunDir: [0.82, 0.12, -0.2], sunColor: '#fff0d8', clouds: 0.42, seed: 303,
    },
    sun: { color: '#ffd6b0', intensity: 3.1, dir: [0.64, 0.70, -0.22] },
    ambient: {
      sky: '#8fdcff', ground: '#5a6a70', intensity: 1.60,
      fill: { color: '#ff8fc8', intensity: 0.55, dir: [-0.5, 0.4, 0.5] },
    },
    fog: { color: '#ffc0cf', near: 140, far: 1600 },
    ground: { color: '#a89a86' },
    grade: {
      uSaturation: 1.30, uExposure: 1.06, uContrast: 1.06,
      uLift: '#120e18', uGain: '#fff0f4', uVignette: 0.20,
    },
    bloom: { strength: 0.95, radius: 0.66, threshold: 0.68 },
  },
  track: {
    width: 11,
    surface: { tint: '#26272d', lanes: 2, centerLine: 'double-yellow', worn: 0.55 },
    bank: 0.05,
    main: [
      [0, 0], [170, 20], [320, -20], [420, -120], [430, -250], [360, -350],
      [230, -400], [80, -410], [-60, -380], [-170, -300], [-230, -190],
      [-215, -80], [-140, -10], [-60, 20], [0, 0],
    ],
    branches: [
      { kind: 'shortcut', enterU: 0.22, exitU: 0.36, width: 7, points: [[420, -200], [370, -290]] },
      { kind: 'ramp', enterU: 0.52, exitU: 0.60, width: 9, rise: 8, points: [[150, -410], [70, -415]] },
      { kind: 'shortcut', enterU: 0.76, exitU: 0.88, width: 6.5, points: [[-215, -140], [-160, -50]] },
    ],
  },
  blocks: {
    spacing: 40, offset: 24, jitter: 8,
    minW: 14, maxW: 28, minH: 14, maxH: 62,
    wallColors: ['#ffd9e2', '#d8f0ea', '#fff2d8', '#c8e8ff', '#ffe0c8'],
    glassColors: ['#2a5a72', '#356a80', '#1e4a60'],
    litColors: ['#ffd0e8', '#c0f0ff', '#fff0c0'],
    neonColors: ['#ff4fa8', '#2fe8d0', '#ffd83a', '#7f5fff'],
    lowColors: ['#ffd9e2', '#d8f0ea', '#fff2d8'],
    signs: ['OCEAN', 'DECO', 'CAFE', 'SURF', 'PALMS', 'CLUB'],
    litRatio: 0.42, setbackChance: 0.5, accentChance: 0.55,
    style: 'artdeco',
    pick: (r, s, side) => (side < 0 ? (r.bool(0.7) ? 'low' : 'tower') : (r.bool(0.35) ? 'low' : 'none')),
  },
  props: {
    lampStyle: 'colonial', lampSpacing: 24, lampHeight: 7,
    palms: true, palmSpacing: 16,
    barriers: false,
    billboards: [
      { u: 0.14, side: -1, text: 'OCEAN', sub: 'DRIVE', color: '#ff4fa8', offset: 20 },
      { u: 0.48, side: -1, text: 'MIAMI', sub: 'BEACH', color: '#2fe8d0', offset: 22 },
      { u: 0.82, side: -1, text: 'NEON', sub: 'NIGHTS', color: '#ffd83a', offset: 18 },
    ],
    gates: [{ u: 0.34, color: '#ff4fa8' }, { u: 0.68, color: '#2fe8d0' }],
    boostPads: [
      { u: 0.09, lateral: 0 }, { u: 0.31, lateral: 0.4 },
      { u: 0.55, lateral: -0.4 }, { u: 0.79, lateral: 0 },
    ],
  },
  skyline: {
    radius: 1100, count: 55, minH: 60, maxH: 210, spread: 260,
    palette: ['#cfd8e4', '#e8dfe0', '#b8c8d8'], accent: '#ff9ad0',
  },
  landmarks({ track, rng, night }) {
    const out = [];

    // --- the ocean: a big turquoise plane with a moving specular sheen ---
    const ocean = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 2200, 1, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0x1fa8b8, roughness: 0.08, metalness: 0.0,
        transmission: 0.0, envMapIntensity: 2.6, clearcoat: 1, clearcoatRoughness: 0.05,
      }),
    );
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.set(900, -1.2, -200);
    out.push(ocean);

    // --- beach strip between road and water ---
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 1400),
      new THREE.MeshStandardMaterial({ color: 0xe8d8b0, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(560, -0.5, -180);
    sand.receiveShadow = true;
    out.push(sand);

    // --- causeway bridge arcing over the far end of the circuit ---
    const s = track.at(0.44);
    const bridge = new THREE.Group();
    const deck = new THREE.Mesh(
      roundedBox(180, 2.6, 20, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.9 }),
    );
    deck.position.y = 26;
    bridge.add(deck);
    for (let i = -2; i <= 2; i++) {
      const pier = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 26, 12),
        new THREE.MeshStandardMaterial({ color: 0xc8c2b6, roughness: 0.95 }));
      pier.position.set(i * 40, 13, 0);
      bridge.add(pier);
    }
    // cable stays
    for (const sx of [-1, 1]) {
      const pylon = new THREE.Mesh(roundedBox(3, 44, 3, 0.4), new THREE.MeshStandardMaterial({ color: 0xe0dad0, roughness: 0.8 }));
      pylon.position.set(sx * 22, 46, 0);
      bridge.add(pylon);
      for (let k = 1; k <= 6; k++) {
        const len = k * 12;
        const cable = new THREE.Mesh(
          new THREE.CylinderGeometry(0.10, 0.10, Math.hypot(len, 40), 5),
          new THREE.MeshStandardMaterial({ color: 0xb8b2a8, metalness: 0.6, roughness: 0.4 }),
        );
        cable.position.set(sx * 22 + sx * len / 2, 46, 0);
        cable.rotation.z = sx * Math.atan2(len, 40);
        bridge.add(cable);
      }
    }
    bridge.position.copy(s.pos).setY(0);
    bridge.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2;
    out.push(bridge);

    // --- cruise ship on the horizon ---
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(roundedBox(240, 26, 42, 3), new THREE.MeshStandardMaterial({ color: 0x1a2a44, roughness: 0.6 }));
    hull.position.y = 13;
    ship.add(hull);
    const sup = new THREE.Mesh(roundedBox(180, 34, 34, 2), new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: 0.5 }));
    sup.position.y = 43;
    ship.add(sup);
    for (let i = 0; i < 3; i++) {
      const fun = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 18, 12), new THREE.MeshStandardMaterial({ color: 0xd8342a, roughness: 0.6 }));
      fun.position.set(-30 + i * 30, 69, 0);
      ship.add(fun);
    }
    ship.position.set(1180, 0, -520);
    ship.rotation.y = 0.4;
    out.push(ship);

    // --- deco neon strip under the buildings on the inside of the circuit ---
    for (let i = 0; i < 26; i++) {
      const u = i / 26;
      const sp = track.at(u);
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.35, 22),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(['#ff4fa8', '#2fe8d0', '#ffd83a'][i % 3]) }),
      );
      strip.position.copy(sp.pos).addScaledVector(sp.right, -(track.halfWidth + 15)).setY(6.5);
      strip.rotation.y = Math.atan2(sp.tan.x, sp.tan.z);
      out.push(strip);
    }

    // --- lifeguard towers on the sand ---
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Group();
      const hut = new THREE.Mesh(roundedBox(5, 4, 5, 0.3),
        new THREE.MeshStandardMaterial({ color: ['#ff4fa8', '#2fe8d0', '#ffd83a', '#7f5fff'][i], roughness: 0.7 }));
      hut.position.y = 5;
      t.add(hut);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.4, 2.4, 4),
        new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.8 }));
      roof.position.y = 8.2; roof.rotation.y = Math.PI / 4;
      t.add(roof);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 6), new THREE.MeshStandardMaterial({ color: 0xb8a888 }));
        leg.position.set(sx * 2, 3, sz * 2);
        t.add(leg);
      }
      t.position.set(540, 0, -600 + i * 260);
      out.push(t);
    }

    void rng; void night; void canvas; void toTexture; void drawText;
    return out;
  },
};

export function build(opts) { return buildCity(def, opts); }
