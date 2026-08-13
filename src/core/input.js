// Unified input. Supports keyboard, gamepad, and a SCRIPTED source used by the headless
// screenshot/functional-test harness (tools/shot.mjs, tools/functest.mjs).
//
// Contract — every consumer reads only these normalized fields:
//   throttle 0..1, brake 0..1, steer -1..1, nitro bool, handbrake bool, lookBack bool
//   plus edge-triggered: menuUp/menuDown/menuLeft/menuRight/confirm/cancel/restart

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  nitro: ['ShiftLeft', 'ShiftRight', 'KeyN'],
  handbrake: ['Space'],
  lookBack: ['KeyC'],
  confirm: ['Enter', 'KeyE'],
  cancel: ['Escape', 'KeyQ'],
  restart: ['KeyR'],
  camera: ['KeyV'],
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.prev = new Set();
    this.scripted = null;          // when set, overrides all hardware input
    this.throttle = 0; this.brake = 0; this.steer = 0;
    this.nitro = false; this.handbrake = false; this.lookBack = false;
    this._steerSmooth = 0;
    this._attached = false;
  }

  attach(target = window) {
    if (this._attached) return;
    this._attached = true;
    this._onDown = (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._onUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    target.addEventListener('keydown', this._onDown);
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
  }

  /** Harness entry point: feed a frame of synthetic input. */
  setScripted(state) { this.scripted = state; }
  clearScripted() { this.scripted = null; }

  any(list) { return list.some((k) => this.keys.has(k)); }
  pressed(action) {
    const list = KEYMAP[action] || [];
    return list.some((k) => this.keys.has(k) && !this.prev.has(k));
  }

  update(dt) {
    if (this.scripted) {
      const s = this.scripted;
      this.throttle = s.throttle || 0;
      this.brake = s.brake || 0;
      this.nitro = !!s.nitro;
      this.handbrake = !!s.handbrake;
      this.lookBack = !!s.lookBack;
      // scripted steer is applied raw so tests are exactly reproducible
      this.steer = s.steer || 0;
      this._steerSmooth = this.steer;
      this.prev = new Set(this.keys);
      return;
    }

    const pad = this._gamepad();
    let rawSteer = 0, thr = 0, brk = 0, nit = false, hb = false;

    if (this.any(KEYMAP.left)) rawSteer -= 1;
    if (this.any(KEYMAP.right)) rawSteer += 1;
    if (this.any(KEYMAP.throttle)) thr = 1;
    if (this.any(KEYMAP.brake)) brk = 1;
    if (this.any(KEYMAP.nitro)) nit = true;
    if (this.any(KEYMAP.handbrake)) hb = true;

    if (pad) {
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.12) rawSteer = ax;
      thr = Math.max(thr, pad.buttons[7]?.value || 0);
      brk = Math.max(brk, pad.buttons[6]?.value || 0);
      nit = nit || !!pad.buttons[0]?.pressed;
      hb = hb || !!pad.buttons[1]?.pressed;
    }

    // Steering ramps in; it snaps back to center faster than it moves out, which is what
    // makes arcade counter-steer feel crisp rather than mushy.
    const toward = rawSteer;
    const rate = Math.abs(toward) > Math.abs(this._steerSmooth) ? 6.5 : 11.0;
    this._steerSmooth += (toward - this._steerSmooth) * Math.min(1, rate * dt);
    if (Math.abs(this._steerSmooth) < 0.002) this._steerSmooth = 0;

    this.steer = this._steerSmooth;
    this.throttle = thr; this.brake = brk;
    this.nitro = nit; this.handbrake = hb;
    this.lookBack = this.any(KEYMAP.lookBack);

    this.prev = new Set(this.keys);
  }

  _gamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }
}

export const KEY_HELP = KEYMAP;
