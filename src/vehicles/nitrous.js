import * as THREE from 'three';
import { clamp, lerp, RNG } from '../core/rng.js';
import { sprite } from '../core/textures.js';

/**
 * Nitrous: the charge/drain state machine AND the visual payoff.
 *
 * ART_DIRECTION.md §6.3 — target 85. Hard caps: a single expanding transparent sprite → 50;
 * no camera response → 65; identical across the four classes → 70. So each class differs in
 * ramp, duration, thrust, top-speed multiplier AND flame colour, and the effect is built from
 * layers: a banded cone core, a fringe, sparks, ground light spill, and a grade/FOV response.
 */

/**
 * PER-CLASS NITROUS TABLE — owned by the nitrous piece. Kept here (not in the car files) so the
 * nitrous builder and the vehicle-art builder never edit the same file.
 *
 *   thrust        extra drive force while boosting
 *   duration      seconds one full tank lasts
 *   drain/refill  tank consumption and recharge rates
 *   topSpeedMul   how far past the class top speed a boost carries
 *   ramp          seconds to spool in — THE per-class feel knob.
 *                 supercar ≈ instant, SUV ≈ a freight train building
 *   color         flame tint; also drives the HUD, grade and speed-line tint
 */
export const NITRO = {
  tuner: { thrust: 0.88, duration: 2.0, drain: 1.5, refill: 0.55, topSpeedMul: 1.36, color: '#38e0ff', ramp: 0.18 },
  muscle: { thrust: 1.00, duration: 3.4, drain: 1.0, refill: 0.30, topSpeedMul: 1.30, color: '#ff8a2a', ramp: 0.55 },
  suv: { thrust: 1.15, duration: 4.6, drain: 0.75, refill: 0.26, topSpeedMul: 1.24, color: '#ffd24a', ramp: 1.10 },
  supercar: { thrust: 1.05, duration: 2.6, drain: 1.25, refill: 0.42, topSpeedMul: 1.42, color: '#b06cff', ramp: 0.10 },
};

export function getNitro(id) {
  const n = NITRO[id];
  if (!n) throw new Error(`No nitrous profile for vehicle "${id}"`);
  return n;
}

export class Nitrous {
  constructor(spec) {
    this.spec = spec;
    this.cfg = spec.nitro;
    this.charge = 1.0;         // 0..1 tank
    this.tanks = 3;            // discrete tanks, like the reference's "NITRO X3" badge
    this.active = false;
    this.ramp = 0;             // 0..1 how far the boost has spooled in
    this.t = 0;
    this.justFired = false;
    this.justEnded = false;
    this._wasActive = false;
  }

  get thrust() { return this.ramp * this.cfg.thrust * 30; }
  get strength() { return this.ramp; }

  /** @param want boolean — the player is holding the nitro button */
  update(dt, want, { moving = true } = {}) {
    this.justFired = false; this.justEnded = false;
    const canFire = this.charge > 0.02 && this.tanks > 0 && moving;

    if (want && canFire) {
      if (!this.active) { this.active = true; this.justFired = true; this.t = 0; }
      this.charge -= dt * this.cfg.drain / this.cfg.duration;
      if (this.charge <= 0) { this.charge = 0; this.tanks = Math.max(0, this.tanks - 1); this.active = false; }
    } else {
      if (this.active) this.justEnded = true;
      this.active = false;
      // Refill only when not boosting. Class refill rates are part of how they feel different.
      if (this.tanks > 0 || this.charge < 1) {
        this.charge = Math.min(1, this.charge + dt * this.cfg.refill * 0.30);
      }
    }

    // Ramp shape is the per-class "feel": the supercar hits instantly, the SUV builds like a train.
    const rampRate = this.active ? 1 / Math.max(0.04, this.cfg.ramp) : 3.2;
    this.ramp += ((this.active ? 1 : 0) - this.ramp) * (1 - Math.exp(-rampRate * dt));
    this.ramp = clamp(this.ramp, 0, 1);
    this.t += dt;
    this._wasActive = this.active;
    return this.ramp;
  }

  addTank() { this.tanks = Math.min(3, this.tanks + 1); this.charge = 1; }
  reset() { this.charge = 1; this.tanks = 3; this.active = false; this.ramp = 0; }
}

/**
 * The visible jet. Built from stacked cone shells with an additive banded texture so it reads as
 * a pressurised flame rather than a soft blob, plus a spark burst and a light that spills onto
 * the road behind the car.
 */
export class NitrousJet {
  constructor(color = '#38e0ff', { scale = 1 } = {}) {
    this.group = new THREE.Group();
    this.color = new THREE.Color(color);
    this.scale = scale;
    this.t = 0;

    const mkCone = (len, rad, col, op, band) => {
      const geo = new THREE.ConeGeometry(rad, len, 18, 6, true);
      geo.rotateX(Math.PI / 2);       // point along -Z (out the back)
      geo.translate(0, 0, -len / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: op,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        map: band ? bandTexture() : null,
      });
      const m = new THREE.Mesh(geo, mat);
      return m;
    };

    // white-hot core → class-tinted mid → wide soft fringe
    this.core = mkCone(1.15, 0.085, 0xffffff, 0.95, true);
    this.mid = mkCone(2.0, 0.16, this.color, 0.62, true);
    this.fringe = mkCone(3.1, 0.28, this.color.clone().offsetHSL(0.02, -0.1, -0.1), 0.26, true);
    this.group.add(this.fringe, this.mid, this.core);

    // shock diamonds — the give-away that this is a jet and not a gradient
    this.diamonds = [];
    for (let i = 0; i < 4; i++) {
      const d = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      d.position.z = -0.32 - i * 0.42;
      this.group.add(d);
      this.diamonds.push(d);
    }

    // muzzle flash card
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({
        map: sprite({ size: 128, shape: 'glow', color: '#ffffff', seed: 8 }),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
      }),
    );
    this.group.add(this.flash);

    // ground spill
    this.light = new THREE.PointLight(this.color, 0, 9, 2);
    this.light.position.z = -1.0;
    this.group.add(this.light);

    this.group.visible = false;
    this.rng = new RNG(31);
  }

  setColor(c) {
    this.color.set(c);
    this.mid.material.color.set(c);
    this.fringe.material.color.copy(this.color.clone().offsetHSL(0.02, -0.1, -0.1));
    this.light.color.set(c);
  }

  update(dt, strength, speed01 = 0) {
    this.t += dt;
    const s = clamp(strength, 0, 1);
    this.group.visible = s > 0.01;
    if (!this.group.visible) { this.light.intensity = 0; return; }

    const flick = 1 + Math.sin(this.t * 61) * 0.06 + Math.sin(this.t * 137) * 0.035;
    const len = (0.55 + s * 1.35 + speed01 * 0.45) * flick * this.scale;

    this.core.scale.set(0.9 + s * 0.35, 0.9 + s * 0.35, len * 0.85);
    this.mid.scale.set(0.85 + s * 0.45, 0.85 + s * 0.45, len);
    this.fringe.scale.set(0.8 + s * 0.6, 0.8 + s * 0.6, len * 1.25);

    this.core.material.opacity = 0.75 * s + 0.2;
    this.mid.material.opacity = 0.5 * s + 0.12;
    this.fringe.material.opacity = 0.22 * s;

    for (let i = 0; i < this.diamonds.length; i++) {
      const d = this.diamonds[i];
      d.position.z = (-0.30 - i * 0.40) * len;
      const k = 1 - i / this.diamonds.length;
      d.scale.setScalar((0.7 + k * 0.7) * s * flick);
      d.material.opacity = 0.65 * s * k;
    }

    // muzzle flash pulses hard on ignition then settles
    this.flash.material.opacity = clamp(s * 0.55 * (1 + Math.sin(this.t * 44) * 0.3), 0, 1);
    this.flash.scale.setScalar(0.7 + s * 0.7);
    this.flash.lookAtCamera = true;

    this.light.intensity = s * 14 * flick;
    this.light.distance = 8 + s * 8;
  }
}

let _band = null;
function bandTexture() {
  if (_band) return _band;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 128);
  // pressure bands
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.18 + (i / 7) * 0.30;
    ctx.fillRect(0, 10 + i * 16, 64, 4);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  _band = new THREE.CanvasTexture(c);
  _band.colorSpace = THREE.SRGBColorSpace;
  _band.wrapS = _band.wrapT = THREE.RepeatWrapping;
  return _band;
}
