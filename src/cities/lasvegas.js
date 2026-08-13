import * as THREE from 'three';
import { buildCity, neonGate } from './kit.js';
import { roundedBox } from '../vehicles/kit.js';
import { drawText } from '../core/font.js';
import { canvas, toTexture, sprite } from '../core/textures.js';

/**
 * LAS VEGAS — night on the Strip. Black desert sky, a wall of neon on both sides, a glass
 * pyramid firing a light beam straight up, a replica tower, wet-look asphalt reflecting
 * everything. Palette: magenta / gold / cyan on near-black.
 */
export const def = {
  id: 'vegas',
  name: 'LAS VEGAS',
  seed: 202,
  spawnU: 0.0,
  laps: 3,
  record: '2:11:20',
  night: true,
  look: {
    accent: '#ff2fd0',
    lampColor: '#ffd8a0',
    wet: 0.72,
    sky: {
      top: '#04060f', horizon: '#241a3a', ground: '#0a0812',
      haze: '#3a2450', sunDir: [0.2, -0.3, 0.9], sunColor: '#241830', clouds: 0.10, stars: 1.0, seed: 202,
    },
    sun: { color: '#7f92e0', intensity: 0.70, dir: [0.3, 0.85, -0.4] },
    ambient: {
      sky: '#4a3a70', ground: '#241634', intensity: 1.05,
      fill: { color: '#ff2fd0', intensity: 0.42, dir: [-0.5, 0.3, 0.6] },
    },
    fog: { color: '#150e22', near: 90, far: 1300 },
    ground: { color: '#26222c' },
    grade: {
      uSaturation: 1.34, uExposure: 1.02, uContrast: 1.12,
      uLift: '#0b0716', uGain: '#ffe8ff', uVignette: 0.30,
    },
    bloom: { strength: 1.35, radius: 0.72, threshold: 0.56 },
  },
  track: {
    width: 11.5,
    surface: { tint: '#1c1c22', lanes: 3, centerLine: 'white', worn: 0.5 },
    bank: 0.04,
    main: [
      [0, 0], [160, 10], [310, -30], [420, -130], [450, -270], [400, -390],
      [270, -450], [120, -450], [-30, -420], [-150, -350], [-220, -240],
      [-230, -120], [-170, -30], [-70, 20], [0, 0],
    ],
    branches: [
      { kind: 'shortcut', enterU: 0.30, exitU: 0.44, width: 7, points: [[400, -300], [340, -370]] },
      { kind: 'shortcut', enterU: 0.70, exitU: 0.82, width: 6.5, points: [[-215, -180], [-185, -80]] },
      { kind: 'ramp', enterU: 0.10, exitU: 0.17, width: 9, rise: 9, points: [[350, -70], [400, -140]] },
    ],
  },
  blocks: {
    spacing: 38, offset: 26, jitter: 8,
    minW: 18, maxW: 40, minH: 34, maxH: 150,
    wallColors: ['#2a2632', '#38304a', '#1e1c28', '#4a3a58'],
    glassColors: ['#12203a', '#1a1030', '#251840'],
    litColors: ['#ffdca0', '#ff9ad8', '#9adcff'],
    neonColors: ['#ff2fd0', '#ffc21e', '#2fe0ff', '#8a2fff', '#2fff9a'],
    lowColors: ['#3a3040', '#2a2432'],
    signs: ['CASINO', 'JACKPOT', 'DINER', '24 HRS', 'LUCKY', 'CHAPEL', 'SLOTS'],
    litRatio: 0.72, setbackChance: 0.28, accentChance: 0.62,
    pick: (r) => (r.bool(0.28) ? 'low' : 'tower'),
  },
  props: {
    lampStyle: 'modern', lampSpacing: 26, lampHeight: 10,
    palms: true, palmSpacing: 30,
    barriers: false,
    billboards: [
      { u: 0.06, side: 1, text: 'JACKPOT', sub: 'MEGA', color: '#ffc21e', offset: 18 },
      { u: 0.26, side: -1, text: 'VIVA', sub: 'NITRO', color: '#ff2fd0', offset: 20 },
      { u: 0.52, side: 1, text: 'ROYALE', sub: 'CASINO', color: '#2fe0ff', offset: 22 },
      { u: 0.86, side: -1, text: 'ALL IN', sub: '', color: '#8a2fff', offset: 18 },
    ],
    gates: [
      { u: 0.20, color: '#2fff9a' }, { u: 0.48, color: '#ff2fd0' }, { u: 0.75, color: '#2fe0ff' },
    ],
    boostPads: [
      { u: 0.13, lateral: 0 }, { u: 0.40, lateral: -0.45 },
      { u: 0.58, lateral: 0.4 }, { u: 0.92, lateral: 0 },
    ],
  },
  skyline: {
    radius: 1000, count: 80, minH: 50, maxH: 220, spread: 340,
    palette: ['#181428', '#221a34', '#120e1e'], accent: '#ff2fd0',
  },
  landmarks({ track, rng, night }) {
    const out = [];

    // --- glass pyramid with a sky beam ---
    const pyr = new THREE.Mesh(
      new THREE.ConeGeometry(78, 118, 4),
      new THREE.MeshPhysicalMaterial({
        color: 0x0a0f18, metalness: 0.9, roughness: 0.10,
        emissive: 0x1a2a44, emissiveIntensity: 0.9, envMapIntensity: 2.4,
      }),
    );
    pyr.rotation.y = Math.PI / 4;
    pyr.position.set(-430, 58, -560);
    pyr.castShadow = true;
    out.push(pyr);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(3.0, 9.0, 900, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xdff2ff, transparent: true, opacity: 0.14,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.set(-430, 118 + 450, -560);
    out.push(beam);
    const beamLight = new THREE.PointLight(0xbfe4ff, 80, 320, 2);
    beamLight.position.set(-430, 130, -560);
    out.push(beamLight);

    // --- observation tower ---
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x33303c, roughness: 0.6, metalness: 0.4 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(6, 11, 180, 14), towerMat);
    shaft.position.set(520, 90, -180);
    out.push(shaft);
    const pod = new THREE.Mesh(
      new THREE.CylinderGeometry(19, 15, 22, 18),
      new THREE.MeshStandardMaterial({ color: 0x2a2a34, emissive: 0xffc21e, emissiveIntensity: night ? 1.6 : 0.2, roughness: 0.4 }),
    );
    pod.position.set(520, 186, -180);
    out.push(pod);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3, 60, 10), towerMat);
    spire.position.set(520, 226, -180);
    out.push(spire);

    // --- the big animated marquee arch over the start line ---
    const s = track.at(0.02);
    const marquee = new THREE.Group();
    const { c, ctx } = canvas(1024, 256);
    const g = ctx.createLinearGradient(0, 0, 1024, 0);
    g.addColorStop(0, '#1a0a2a'); g.addColorStop(0.5, '#2a0f3a'); g.addColorStop(1, '#1a0a2a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 256);
    ctx.strokeStyle = '#ffc21e'; ctx.lineWidth = 10; ctx.strokeRect(14, 14, 996, 228);
    drawText(ctx, 'WELCOME TO', { x: 512, y: 92, size: 46, weight: 0.18, italic: 0.16, align: 'center', color: '#ffc21e', tracking: 0.18, glow: { color: '#ffc21e', blur: 22 } });
    drawText(ctx, 'LAS VEGAS', { x: 512, y: 190, size: 82, weight: 0.21, italic: 0.22, align: 'center', color: '#ff2fd0', tracking: 0.10, glow: { color: '#ff2fd0', blur: 30 } });
    const tex = toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 10),
      new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 2.6, side: THREE.DoubleSide, roughness: 0.5 }),
    );
    panel.position.y = 15;
    marquee.add(panel);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 15, 10), towerMat);
      post.position.set(sx * 19, 7.5, 0);
      marquee.add(post);
    }
    const ml = new THREE.PointLight(0xff2fd0, 40, 90, 2);
    ml.position.y = 13;
    marquee.add(ml);
    marquee.position.copy(s.pos);
    marquee.rotation.y = Math.atan2(s.tan.x, s.tan.z);
    out.push(marquee);

    // --- fountain plaza with light columns ---
    const s3 = track.at(0.62);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.6, 26, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(['#2fe0ff', '#ff2fd0', '#ffc21e'][i % 3]),
          transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      col.position.copy(s3.pos)
        .addScaledVector(s3.right, Math.cos(a) * 44)
        .addScaledVector(s3.tan, Math.sin(a) * 44)
        .setY(13);
      out.push(col);
    }

    void rng; void neonGate; void sprite; void roundedBox;
    return out;
  },
};

export function build(opts) { return buildCity(def, { ...opts, night: true }); }
