import * as THREE from 'three';
import { ParticleSystem, SkidTrails } from './particles.js';
import { sprite } from '../core/textures.js';
import { RNG, clamp, lerp } from '../core/rng.js';

/**
 * FX director. Owns every particle pool and the camera-shake state, and exposes one call per
 * game event. Systems that need FX ask this — nothing else allocates particles.
 */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.rng = new RNG(77);

    this.smoke = new ParticleSystem({
      texture: sprite({ size: 128, shape: 'smoke', seed: 11 }),
      max: 700, blending: THREE.NormalBlending, gravity: 1.4, drag: 1.5, renderOrder: 4,
    });
    this.sparks = new ParticleSystem({
      texture: sprite({ size: 128, shape: 'spark', seed: 12 }),
      max: 900, blending: THREE.AdditiveBlending, gravity: -16, drag: 0.9, renderOrder: 6,
    });
    this.glow = new ParticleSystem({
      texture: sprite({ size: 128, shape: 'glow', seed: 13 }),
      max: 500, blending: THREE.AdditiveBlending, gravity: 0.5, drag: 2.2, renderOrder: 6,
    });
    this.debris = new ParticleSystem({
      texture: sprite({ size: 64, shape: 'ring', seed: 14 }),
      max: 300, blending: THREE.NormalBlending, gravity: -22, drag: 0.4, renderOrder: 5,
    });
    this.skid = new SkidTrails({});

    for (const s of [this.smoke, this.sparks, this.glow, this.debris]) scene.add(s.points);
    scene.add(this.skid.mesh);

    this.shake = 0;
    this.shakeDecay = 3.2;
    this.timeScale = 1;
    this._timeScaleTarget = 1;
    this._shakeOff = new THREE.Vector3();
    this._shakeRot = 0;
  }

  setViewportHeight(h) {
    for (const s of [this.smoke, this.sparks, this.glow, this.debris]) s.setViewportHeight(h);
  }

  // ---------------------------------------------------------------- events

  /** Tyre smoke from a sliding wheel. `amount` 0..1. */
  tyreSmoke(pos, vel, amount, surface = 'road') {
    if (amount < 0.08) return;
    const n = amount > 0.6 ? 3 : amount > 0.3 ? 2 : 1;
    const col = surface === 'dirt' ? '#b09a76' : '#d8dae0';
    for (let i = 0; i < n; i++) {
      this.smoke.emit({
        pos: [pos.x + this.rng.range(-0.2, 0.2), pos.y + 0.10, pos.z + this.rng.range(-0.2, 0.2)],
        vel: [vel.x * 0.14 + this.rng.range(-1.1, 1.1), this.rng.range(0.7, 2.4), vel.z * 0.14 + this.rng.range(-1.1, 1.1)],
        life: this.rng.range(0.7, 1.5) * (0.6 + amount),
        size: this.rng.range(0.7, 1.3), grow: this.rng.range(2.4, 4.2),
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-1.4, 1.4),
        color: col, alpha: 0.30 * amount + 0.06,
      });
    }
  }

  /** Sparks — wall scrapes, bottoming out, crashes. `dir` is the surface normal. */
  sparkBurst(pos, dir, strength, { color = '#ffd27a', count = null } = {}) {
    const n = count ?? Math.floor(6 + strength * 34);
    for (let i = 0; i < n; i++) {
      const spread = 0.9;
      const v = new THREE.Vector3(
        dir.x + this.rng.range(-spread, spread),
        Math.abs(dir.y) + this.rng.range(0.1, 1.0),
        dir.z + this.rng.range(-spread, spread),
      ).normalize().multiplyScalar(this.rng.range(4, 15) * (0.5 + strength));
      this.sparks.emit({
        pos: [pos.x, pos.y, pos.z], vel: [v.x, v.y, v.z],
        life: this.rng.range(0.25, 0.75),
        size: this.rng.range(0.10, 0.26), grow: -0.5,
        rot: Math.atan2(v.z, v.x), rotV: this.rng.range(-2, 2),
        color: this.rng.bool(0.25) ? '#ffffff' : color, alpha: 1,
      });
    }
  }

  /** Nitrous trail — heat streaks and embers left in the air behind the jet. */
  nitroTrail(pos, back, strength, color) {
    if (strength < 0.05) return;
    const n = strength > 0.7 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      this.glow.emit({
        pos: [pos.x + this.rng.range(-0.14, 0.14), pos.y + this.rng.range(-0.08, 0.14), pos.z + this.rng.range(-0.14, 0.14)],
        vel: [back.x * this.rng.range(2, 7), this.rng.range(0.3, 1.6), back.z * this.rng.range(2, 7)],
        life: this.rng.range(0.22, 0.55),
        size: this.rng.range(0.22, 0.55), grow: 2.2,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-3, 3),
        color, alpha: 0.55 * strength,
      });
    }
    if (this.rng.bool(0.5 * strength)) {
      this.sparks.emit({
        pos: [pos.x, pos.y, pos.z],
        vel: [back.x * this.rng.range(6, 16) + this.rng.range(-2, 2), this.rng.range(0.5, 3), back.z * this.rng.range(6, 16) + this.rng.range(-2, 2)],
        life: this.rng.range(0.3, 0.7), size: this.rng.range(0.08, 0.18), grow: -0.3,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-4, 4),
        color: '#ffffff', alpha: 0.9,
      });
    }
  }

  /** Exhaust backfire pop. */
  backfire(pos, back, color = '#ff9a2a') {
    for (let i = 0; i < 7; i++) {
      this.glow.emit({
        pos: [pos.x, pos.y, pos.z],
        vel: [back.x * this.rng.range(3, 10) + this.rng.range(-1.6, 1.6), this.rng.range(0.4, 2.2), back.z * this.rng.range(3, 10) + this.rng.range(-1.6, 1.6)],
        life: this.rng.range(0.12, 0.3), size: this.rng.range(0.24, 0.55), grow: 1.6,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-5, 5),
        color: i < 3 ? '#ffffff' : color, alpha: 0.9,
      });
    }
    this.addShake(0.10);
  }

  /**
   * Full crash spectacle: sparks, debris, smoke, shake and a beat of time dilation.
   * §6.6 caps a collision with no FX at 40 and no screen shake at 65.
   */
  crash(pos, normal, strength, { color = '#ffd27a' } = {}) {
    const s = clamp(strength, 0, 1);
    this.sparkBurst(pos, normal, s, { color, count: Math.floor(20 + s * 70) });
    for (let i = 0; i < Math.floor(4 + s * 16); i++) {
      const v = new THREE.Vector3(
        normal.x * this.rng.range(1, 5) + this.rng.range(-4, 4),
        this.rng.range(2, 9) * (0.5 + s),
        normal.z * this.rng.range(1, 5) + this.rng.range(-4, 4),
      );
      this.debris.emit({
        pos: [pos.x, pos.y + 0.3, pos.z], vel: [v.x, v.y, v.z],
        life: this.rng.range(0.8, 1.8), size: this.rng.range(0.09, 0.22), grow: 0,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-9, 9),
        color: this.rng.pick(['#4a4d55', '#8a8f98', '#2a2c31']), alpha: 1,
      });
    }
    for (let i = 0; i < Math.floor(3 + s * 10); i++) {
      this.smoke.emit({
        pos: [pos.x, pos.y + 0.2, pos.z],
        vel: [normal.x * this.rng.range(0.5, 3) + this.rng.range(-2, 2), this.rng.range(1, 4), normal.z * this.rng.range(0.5, 3) + this.rng.range(-2, 2)],
        life: this.rng.range(0.9, 2.0), size: this.rng.range(0.8, 1.6), grow: 3.4,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-1, 1),
        color: '#8f9199', alpha: 0.34,
      });
    }
    this.glow.emit({
      pos: [pos.x, pos.y + 0.2, pos.z], vel: [0, 1, 0],
      life: 0.22, size: 1.4 + s * 2.4, grow: 2.4, color: '#fff0c0', alpha: 0.85 * s,
    });
    this.addShake(0.35 + s * 0.85);
    if (s > 0.45) this.hitStop(0.06 + s * 0.07);
  }

  /** Dust/dirt kicked up off-road. */
  dirtSpray(pos, vel, amount) {
    if (amount < 0.05) return;
    for (let i = 0; i < 2; i++) {
      this.smoke.emit({
        pos: [pos.x + this.rng.range(-0.2, 0.2), pos.y + 0.05, pos.z + this.rng.range(-0.2, 0.2)],
        vel: [-vel.x * 0.20 + this.rng.range(-1.5, 1.5), this.rng.range(1.0, 3.2), -vel.z * 0.20 + this.rng.range(-1.5, 1.5)],
        life: this.rng.range(0.6, 1.3), size: this.rng.range(0.6, 1.2), grow: 3.0,
        rot: this.rng.range(0, 6.28), rotV: this.rng.range(-2, 2),
        color: '#a8865c', alpha: 0.42 * amount,
      });
    }
  }

  /** Boost-pad pickup: a ring of upward sparks (reference f&f1). */
  boostPad(pos, color = '#ffb020') {
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      this.sparks.emit({
        pos: [pos.x + Math.cos(a) * 1.6, pos.y + 0.1, pos.z + Math.sin(a) * 1.6],
        vel: [Math.cos(a) * 2.2, this.rng.range(6, 13), Math.sin(a) * 2.2],
        life: this.rng.range(0.4, 0.9), size: this.rng.range(0.12, 0.26), grow: -0.4,
        rot: a, rotV: this.rng.range(-2, 2), color, alpha: 1,
      });
    }
    this.addShake(0.18);
  }

  // ---------------------------------------------------------------- camera

  /** `shakePeak` never decays until clear() — the functional harness samples too coarsely to
   *  catch the instantaneous value of a 0.3s shake. */
  addShake(a) {
    this.shake = Math.min(1.6, this.shake + a);
    this.shakePeak = Math.max(this.shakePeak || 0, this.shake);
  }
  hitStop(d) { this._hitStop = Math.max(this._hitStop || 0, d); }

  /** Returns {offset:Vector3, roll:number} to add to the camera this frame. */
  cameraShake(dt) {
    this.shake = Math.max(0, this.shake - this.shakeDecay * dt * (0.4 + this.shake));
    const s = this.shake * this.shake;
    const t = performance.now() * 0.001;
    this._shakeOff.set(
      Math.sin(t * 57.3) * 0.34 + Math.sin(t * 23.1) * 0.18,
      Math.sin(t * 71.7) * 0.26 + Math.sin(t * 31.9) * 0.14,
      Math.sin(t * 43.3) * 0.16,
    ).multiplyScalar(s);
    this._shakeRot = Math.sin(t * 39.7) * 0.045 * s;
    return { offset: this._shakeOff, roll: this._shakeRot };
  }

  update(dt, wind = null) {
    this.smoke.update(dt, wind);
    this.sparks.update(dt, wind);
    this.glow.update(dt, wind);
    this.debris.update(dt, wind);
    if (this._hitStop > 0) {
      this._hitStop -= dt;
      this._timeScaleTarget = 0.30;
    } else {
      this._timeScaleTarget = 1;
    }
    this.timeScale = lerp(this.timeScale, this._timeScaleTarget, 1 - Math.exp(-14 * dt));
  }

  clear() {
    this.smoke.clear(); this.sparks.clear(); this.glow.clear(); this.debris.clear(); this.skid.clear();
    this.shake = 0; this.shakePeak = 0; this.timeScale = 1; this._hitStop = 0;
  }

  dispose() {
    for (const s of [this.smoke, this.sparks, this.glow, this.debris]) { s.points.removeFromParent(); s.dispose(); }
    this.skid.mesh.removeFromParent(); this.skid.dispose();
  }
}
