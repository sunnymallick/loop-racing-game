import * as THREE from 'three';
import { buildCity } from './kit.js';
import { roundedBox } from '../vehicles/kit.js';
import { canvas, toTexture, sprite } from '../core/textures.js';
import { drawText } from '../core/font.js';
import { RNG } from '../core/rng.js';

/**
 * NEW YORK CITY — blue-hour canyon run. Tall brick-and-steel walls close on both sides, steam
 * venting from the street, a suspension bridge, an elevated rail crossing overhead, a floodlit
 * spire. Palette: cold slate blue and steel, with taxi-yellow and warm window light as the only
 * warm notes. The street is narrow and hemmed in — the opposite of Miami's open coast.
 */
export const def = {
  id: 'nyc',
  name: 'NEW YORK CITY',
  seed: 404,
  spawnU: 0.0,
  laps: 3,
  record: '2:16:44',
  look: {
    accent: '#ffc21e',
    lampColor: '#ffd2a0',
    wet: 0.55,
    sky: {
      top: '#0a1430', horizon: '#3f5a86', ground: '#171c26',
      haze: '#54709c', sunDir: [-0.3, 0.06, -0.9], sunColor: '#ffb87a', clouds: 0.55, stars: 0.35, seed: 404,
    },
    sun: { color: '#a8c0e8', intensity: 1.9, dir: [-0.30, 0.80, -0.52] },
    ambient: {
      sky: '#6e8fc4', ground: '#2c3038', intensity: 1.45,
      fill: { color: '#ffb060', intensity: 0.45, dir: [0.6, 0.25, 0.5] },
    },
    fog: { color: '#2b3a52', near: 70, far: 1000 },
    ground: { color: '#33363c' },
    grade: {
      uSaturation: 1.16, uExposure: 1.02, uContrast: 1.11,
      uLift: '#0a0e18', uGain: '#eaf0ff', uVignette: 0.28,
    },
    bloom: { strength: 1.05, radius: 0.60, threshold: 0.62 },
  },
  track: {
    width: 9.5,
    surface: { tint: '#202127', lanes: 2, centerLine: 'single-yellow', worn: 0.85 },
    bank: 0.02,
    main: [
      [0, 0], [130, 0], [260, -10], [340, -90], [350, -200], [330, -310],
      [250, -380], [130, -400], [0, -400], [-120, -380], [-200, -310],
      [-230, -200], [-215, -95], [-140, -20], [-60, 5], [0, 0],
    ],
    branches: [
      { kind: 'shortcut', enterU: 0.12, exitU: 0.26, width: 5.5, points: [[330, -50], [345, -140]] },   // alley cut
      { kind: 'shortcut', enterU: 0.44, exitU: 0.56, width: 5.5, points: [[300, -370], [200, -395]] },
      { kind: 'ramp', enterU: 0.68, exitU: 0.76, width: 8, rise: 6, points: [[-170, -350], [-215, -270]] },
    ],
  },
  blocks: {
    spacing: 30, offset: 17, jitter: 4,
    minW: 20, maxW: 42, minH: 70, maxH: 240,
    wallColors: ['#6a5248', '#4a4a52', '#7a6256', '#3e4048', '#5c4a42'],
    glassColors: ['#1a2838', '#243244', '#141e2c'],
    litColors: ['#ffd9a0', '#ffe8c0', '#c8dcff'],
    neonColors: ['#ffc21e', '#ff3a3a', '#3affc8'],
    lowColors: ['#7a6256', '#6a5248'],
    signs: ['DELI', 'PIZZA', 'SUBWAY', 'BAR', '24HR', 'LAUNDRY'],
    litRatio: 0.55, setbackChance: 0.62, accentChance: 0.10,
    style: 'artdeco',
    pick: (r) => (r.bool(0.14) ? 'low' : 'tower'),
  },
  props: {
    lampStyle: 'modern', lampSpacing: 22, lampHeight: 9,
    palms: false,
    barriers: true, barrierGaps: 7,
    billboards: [
      { u: 0.20, side: 1, text: 'BROADWAY', sub: '', color: '#ffc21e', offset: 13 },
      { u: 0.58, side: -1, text: 'EMPIRE', sub: 'MOTORS', color: '#ff3a3a', offset: 13 },
      { u: 0.90, side: 1, text: 'NITRO', sub: 'NYC', color: '#3affc8', offset: 13 },
    ],
    boostPads: [
      { u: 0.05, lateral: 0 }, { u: 0.33, lateral: -0.35 },
      { u: 0.61, lateral: 0.35 }, { u: 0.85, lateral: 0 },
    ],
  },
  skyline: {
    radius: 820, count: 110, minH: 110, maxH: 340, spread: 320,
    palette: ['#39414f', '#2c3340', '#454e5e'], accent: '#ffd08a',
  },
  landmarks({ track, rng, night }) {
    const out = [];
    const r = new RNG(4041);

    // --- suspension bridge across the far straight ---
    const s = track.at(0.50);
    const bridge = new THREE.Group();
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x7a6a5c, roughness: 0.95 });
    const deck = new THREE.Mesh(roundedBox(300, 3, 26, 0.4), new THREE.MeshStandardMaterial({ color: 0x4a4e56, roughness: 0.85 }));
    deck.position.y = 34;
    bridge.add(deck);
    for (const sx of [-1, 1]) {
      const tower = new THREE.Group();
      for (const dz of [-9, 9]) {
        const leg = new THREE.Mesh(roundedBox(7, 78, 7, 0.5), stoneMat);
        leg.position.set(0, 39, dz);
        tower.add(leg);
      }
      for (let a = 0; a < 2; a++) {
        const arch = new THREE.Mesh(new THREE.TorusGeometry(6.5, 1.6, 8, 16, Math.PI), stoneMat);
        arch.position.set(0, 40 + a * 20, 0);
        arch.rotation.y = Math.PI / 2;
        tower.add(arch);
      }
      tower.position.x = sx * 66;
      bridge.add(tower);
      // main cable
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        pts.push(new THREE.Vector3(sx * 66 + (t * 66 * -sx), 78 - Math.sin(t * Math.PI * 0.5) * 40, 0));
      }
      const cable = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.5, 6, false),
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.8, roughness: 0.35 }),
      );
      bridge.add(cable);
    }
    bridge.position.copy(s.pos).setY(0);
    bridge.rotation.y = Math.atan2(s.tan.x, s.tan.z) + Math.PI / 2;
    out.push(bridge);

    // --- elevated rail crossing the route ---
    const s2 = track.at(0.18);
    const el = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x2e3238, metalness: 0.7, roughness: 0.55 });
    const rail = new THREE.Mesh(roundedBox(120, 1.6, 11, 0.2), steel);
    rail.position.y = 13;
    el.add(rail);
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      for (const dz of [-4.5, 4.5]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 13, 8), steel);
        col.position.set(i * 17, 6.5, dz);
        el.add(col);
      }
      const brace = new THREE.Mesh(roundedBox(1.0, 0.6, 11, 0.1), steel);
      brace.position.set(i * 17, 12, 0);
      el.add(brace);
    }
    el.position.copy(s2.pos).setY(0);
    el.rotation.y = Math.atan2(s2.tan.x, s2.tan.z) + Math.PI / 2;
    out.push(el);

    // --- floodlit art-deco spire ---
    const spire = new THREE.Group();
    const body = new THREE.Mesh(roundedBox(34, 190, 34, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x6a6258, roughness: 0.75 }));
    body.position.y = 95;
    spire.add(body);
    for (let i = 0; i < 6; i++) {
      const rr = 16 - i * 2.4;
      const crown = new THREE.Mesh(
        new THREE.CylinderGeometry(rr, rr + 2.4, 7, 16),
        new THREE.MeshStandardMaterial({
          color: 0xb8bcc4, metalness: 0.85, roughness: 0.25,
          emissive: 0xffd08a, emissiveIntensity: night ? 1.1 : 0.35,
        }),
      );
      crown.position.y = 192 + i * 7;
      spire.add(crown);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.6, 40, 8),
      new THREE.MeshStandardMaterial({ color: 0xa8acb4, metalness: 0.9, roughness: 0.3 }));
    mast.position.y = 254;
    spire.add(mast);
    const beacon = new THREE.PointLight(0xffd08a, 40, 200, 2);
    beacon.position.y = 240;
    spire.add(beacon);
    spire.position.set(-420, 0, -560);
    out.push(spire);

    // --- street steam: vertical drifting columns from manhole covers ---
    for (let i = 0; i < 16; i++) {
      const u = r.next();
      const sp = track.at(u);
      const puff = new THREE.Mesh(
        new THREE.PlaneGeometry(7, 12),
        new THREE.MeshBasicMaterial({
          map: sprite({ size: 128, shape: 'smoke', seed: 100 + i, color: '#c8d4e4' }),
          transparent: true, opacity: 0.24, depthWrite: false, blending: THREE.NormalBlending,
        }),
      );
      puff.position.copy(sp.pos).addScaledVector(sp.right, r.range(-0.7, 0.7) * track.halfWidth).setY(5.6);
      puff.name = 'steam';
      puff.userData.phase = r.range(0, 6.28);
      out.push(puff);

      const cover = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 0.06, 14),
        new THREE.MeshStandardMaterial({ color: 0x3a3d44, metalness: 0.7, roughness: 0.6 }),
      );
      cover.position.copy(puff.position).setY(0.045);
      out.push(cover);
    }

    // --- scaffolding over the sidewalk, a very NYC silhouette ---
    for (let k = 0; k < 6; k++) {
      const u = 0.06 + k * 0.15;
      const sp = track.at(u);
      const scaf = new THREE.Group();
      const pipe = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.5 });
      const top = new THREE.Mesh(roundedBox(4.4, 0.3, 24, 0.1), new THREE.MeshStandardMaterial({ color: 0x2a4a86, roughness: 0.8 }));
      top.position.y = 5.2;
      scaf.add(top);
      for (let i = 0; i < 7; i++) {
        for (const sx of [-1.8, 1.8]) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.2, 6), pipe);
          p.position.set(sx, 2.6, -11 + i * 3.6);
          scaf.add(p);
        }
      }
      scaf.position.copy(sp.pos).addScaledVector(sp.right, (k % 2 ? 1 : -1) * (track.halfWidth + 4.0));
      scaf.rotation.y = Math.atan2(sp.tan.x, sp.tan.z);
      out.push(scaf);
    }

    void rng; void canvas; void toTexture; void drawText;
    return out;
  },
};

export function build(opts) { return buildCity(def, opts); }
