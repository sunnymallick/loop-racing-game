// Unified input. Supports keyboard, gamepad, and a SCRIPTED source used by the headless
// screenshot/functional-test harness (tools/shot.mjs, tools/functest.mjs).
//
// Contract — every consumer reads only these normalized fields:
//   throttle 0..1, brake 0..1, steer -1..1, nitro bool, handbrake bool, lookBack bool
//   plus edge-triggered: menuUp/menuDown/menuLeft/menuRight/confirm/cancel/restart
//
// `steer` is in ENGINE sign, not screen sign: positive steer yaws the car toward +X, which is the
// driver's LEFT. See the STEERING SIGN note above the keyboard accumulation for why the world is
// mirrored and why the hardware mapping — not the physics — is what reconciles it.

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
  quality: ['KeyG'],    // cycle graphics quality (core/quality.js)
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
    // EDGE DETECTION. `prev` has to hold the PREVIOUS frame's key set for the whole of this frame,
    // because every consumer — the garage (`menu.update`), the finish prompt — is called by
    // Game.update() *after* this method. Both branches used to end with `prev = new Set(keys)`,
    // which snapshots the key set that pressed() is about to be compared against: keys and prev
    // were then identical for the rest of the frame and `pressed()` could never return true for
    // anything. The garage did not respond to the keyboard at all — no navigate, no colour, no
    // ENTER to start — and nothing caught it, because functest drives the menu by calling
    // `menu._move()` / `menu._start()` directly rather than through a key. So the snapshot is
    // promoted at the TOP of the frame instead, and the new one taken alongside it.
    this.prev = this._pending || new Set();
    this._pending = new Set(this.keys);

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
      return;
    }

    const pad = this._gamepad();
    let rawSteer = 0, thr = 0, brk = 0, nit = false, hb = false;

    // STEERING SIGN. The world is mirrored, and this is the one place allowed to know it.
    //
    // ARCHITECTURE.md's "+Z is forward, +X right, +Y up" cannot be true as stated: in a
    // right-handed Y-up scene the driver's right is `forward x up`, and Z x Y = -X. +X is the
    // driver's LEFT and renders on the LEFT of the screen. Measured three ways that agree
    // exactly — the chase camera's matrixWorld column 0 (screen right) dotted with `forward x up`
    // is +1, and dotted with the body's own `get right()` (physics.js) is -1.
    //
    // Everything downstream is consistent with the mistake: body.right, track.right, the FL/FR
    // wheel names, the signed track lateral, race.js's "track right is the mirror of the car's".
    // 157 uses across 11 files, so the convention stays. Positive yaw is a LEFT turn, and
    // `steerVisual > 0` points the front wheels LEFT (applyPose in physics.js).
    //
    // That leaves exactly one boundary where a human-meaningful "right" meets the engine's sign,
    // and it is here: RIGHT must produce steer < 0. The wheel angle and the yaw moment come off
    // the same number, so this single sign turns the car and its front wheels together rather
    // than fixing one and leaving the other mirrored. The model has no absolute-sign term (the
    // gate measures L/R symmetry at ratio 1.00), so mirroring the input is exactly feel-neutral.
    //
    // Do not "correct" these two lines back. Do not swap the KEYMAP arrays instead, either —
    // menu.js drives the garage carousel off pressed('left')/pressed('right') and would silently
    // reverse, and the menu gate check passes either way so nothing would catch it.
    if (this.any(KEYMAP.left)) rawSteer += 1;
    if (this.any(KEYMAP.right)) rawSteer -= 1;
    if (this.any(KEYMAP.throttle)) thr = 1;
    if (this.any(KEYMAP.brake)) brk = 1;
    if (this.any(KEYMAP.nitro)) nit = true;
    if (this.any(KEYMAP.handbrake)) hb = true;

    if (pad) {
      const ax = pad.axes[0] || 0;
      // Axis 0 positive = stick pushed right — a hardware fact, so it takes the same negation the
      // arrow keys take above. Leaving it unnegated would make the pad steer opposite to the keys.
      if (Math.abs(ax) > 0.12) rawSteer = -ax;
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
  }

  _gamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }
}

export const KEY_HELP = KEYMAP;
