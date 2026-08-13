import * as THREE from 'three';
import { Engine, disposeObject } from './core/engine.js';
import { Input } from './core/input.js';
import { AudioEngine, bufferToWav } from './core/audio.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Effects } from './fx/effects.js';
import { buildVehicle, getVehicle, VEHICLE_IDS } from './vehicles/index.js';
import { VehicleBody, applyPose } from './vehicles/physics.js';
import { Nitrous, NitrousJet } from './vehicles/nitrous.js';
import { buildCityById, getCity, CITY_IDS } from './cities/index.js';
import { Race } from './race/race.js';
import { clamp, lerp, smoothstep, RNG } from './core/rng.js';

const FIXED_DT = 1 / 60;

/**
 * NITRO CIRCUIT — game shell.
 *
 * Everything the headless harness needs is exposed on window.__GAME (see tools/shot.mjs and
 * tools/functest.mjs). Screenshots must come from the REAL running build (ART_DIRECTION.md §5),
 * so the harness drives this exact code path with scripted input and a fixed timestep.
 */
class Game {
  constructor() {
    this.container = document.getElementById('app');
    this.engine = new Engine(this.container);
    this.input = new Input();
    this.input.attach(window);
    this.audio = new AudioEngine();
    this.hud = new HUD(document.getElementById('ui'));
    this.effects = new Effects(this.engine.scene);
    this.effects.setViewportHeight(this.container.clientHeight || 900);

    this.city = null;
    this.cityId = null;
    this.car = null;
    this.carId = null;
    this.carColor = null;
    this.body = null;
    this.nitro = null;
    this.jet = null;
    this.race = null;
    this.aiCars = [];

    this.state = 'menu';       // menu | racing | finished
    this.time = 0;
    this.camMode = 'chase';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camFov = 62;
    this.headless = new URLSearchParams(location.search).has('shot');
    this.menu = new Menu(this);
    this.rng = new RNG(4242);
    this._lastBoostPad = -1;
    this._skidOn = [false, false, false, false];

    window.addEventListener('resize', () => {
      this.hud.resize();
      this.effects.setViewportHeight(this.container.clientHeight);
    });
    // first interaction unlocks WebAudio
    const unlock = () => { this.audio.init(); this.audio.resume(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ---------------------------------------------------------------- loading

  async setCity(id) {
    if (this.city) {
      this.engine.scene.remove(this.city.group);
      disposeObject(this.city.group);
      this.city = null;
    }
    const built = buildCityById(id, { renderer: this.engine.renderer, quality: 'high' });
    this.cityId = id;
    this.city = built;
    this.engine.scene.add(built.group);
    this.engine.scene.fog = built.fog;
    this.engine.scene.environment = built.envMap || null;
    this.engine.applyLook(built.look);
    if (this.car) this._applyEnv(this.car);
    return built;
  }

  setCar(id, color = null) {
    if (this.car) { this.engine.scene.remove(this.car); disposeObject(this.car); }
    const v = getVehicle(id);
    const car = buildVehicle(id, { color: color || v.spec.colors[0], envMap: this.city?.envMap });
    this.carId = id;
    this.carColor = color || v.spec.colors[0];
    this.car = car;
    this.engine.scene.add(car);
    this.body = new VehicleBody(v.spec, { wheelbase: v.blueprint.dims.wheelbase });
    this.nitro = new Nitrous(v.spec);

    if (this.jet) { this.jet.group.removeFromParent(); }
    this.jet = new NitrousJet(v.spec.nitro.color, { scale: id === 'suv' ? 1.25 : id === 'tuner' ? 0.85 : 1 });
    car.add(this.jet.group);
    const ex = car.userData.exhausts;
    if (ex?.length) {
      const mid = ex.reduce((a, e) => a.add(e.position), new THREE.Vector3()).divideScalar(ex.length);
      this.jet.group.position.copy(mid);
    } else {
      this.jet.group.position.set(0, 0.5, -v.blueprint.dims.length / 2);
    }
    this._applyEnv(car);
    return car;
  }

  _applyEnv(obj) {
    if (!this.city?.envMap) return;
    obj.traverse((o) => {
      if (o.isMesh && o.material && 'envMap' in o.material) {
        o.material.envMap = this.city.envMap;
        o.material.needsUpdate = true;
      }
    });
  }

  startRace({ opponents = 7 } = {}) {
    const def = getCity(this.cityId).def;
    this.race = new Race({
      track: this.city.track, cityDef: def,
      playerSpec: getVehicle(this.carId).spec, opponents,
    });
    const slot = this.race.grid(this.city.spawn.u);
    const s = this.city.track.at(slot.u);
    const p = s.pos.clone().addScaledVector(s.right, slot.lateral * this.city.track.halfWidth);
    this.body.reset(p, Math.atan2(s.tan.x, s.tan.z));
    this.nitro.reset();

    for (const c of this.aiCars) { this.engine.scene.remove(c); disposeObject(c); }
    this.aiCars = [];
    for (const d of this.race.drivers) {
      const spec = getVehicle(d.vehicleId).spec;
      const color = spec.colors[(d.id + 1) % spec.colors.length];
      const c = buildVehicle(d.vehicleId, { color, envMap: this.city.envMap });
      this.engine.scene.add(c);
      this.aiCars.push(c);
    }
    this.effects.clear();
    this.state = 'racing';
    this.time = 0;
    this._snapCamera();
    return this;
  }

  // ---------------------------------------------------------------- simulation

  update(dt) {
    this.time += dt;
    this.input.update(dt);

    if (this.state === 'menu') {
      this.menu.update(dt, this.input);
      return;
    }

    const scaled = dt * this.effects.timeScale;
    const racing = this.race && this.race.state === 'racing';
    const inp = {
      throttle: racing ? this.input.throttle : 0,
      brake: racing ? this.input.brake : (this.race?.state === 'countdown' ? 1 : 0),
      steer: racing ? this.input.steer : 0,
      handbrake: this.input.handbrake,
    };

    // ---- nitrous ----
    const wasActive = this.nitro.active;
    this.nitro.update(scaled, racing && this.input.nitro, { moving: this.body.speed > 1.5 });
    if (this.nitro.justFired) { this.audio.nitroStart(); this.effects.addShake(0.35); this.hud.message('NITRO!', 1.1, '#ff9214'); }
    if (this.nitro.justEnded) this.effects.backfire(this._exhaustWorld(), this.body.forward.clone().negate(), this.nitro.cfg.color);
    this.audio.nitroSustain(this.nitro.ramp);
    void wasActive;

    // ---- surface / walls ----
    const t = this.city.track;
    const nearMain = t.nearest(this.body.pos, this.race?.playerU ?? null);
    let lateral = nearMain.lateral, groundY = 0, onBranch = null;
    for (const b of t.branches) {
      const nb = b.nearest(this.body.pos);
      if (nb.dist < Math.abs(nearMain.lateral) * t.halfWidth && Math.abs(nb.lateral) < 1.4) {
        onBranch = nb; lateral = nb.lateral; groundY = nb.groundY;
        break;
      }
    }
    const absLat = Math.abs(lateral);
    const surfaceGrip = absLat > 1.02 ? lerp(1.0, 0.58, smoothstep(1.02, 1.5, absLat)) : 1.0;
    this.body.surface = absLat > 1.02 ? 'dirt' : 'road';

    this.body.brakeLit = inp.brake > 0.1;
    this.body.step(scaled, inp, {
      surfaceGrip,
      boost: this.nitro.ramp,
      boostThrust: this.nitro.thrust,
      topSpeedMul: this.nitro.cfg.topSpeedMul,
      groundY,
    });

    // ---- wall collision ----
    const wallAt = 1.52;
    if (absLat > wallAt) {
      const s = onBranch ? onBranch.sample : nearMain.sample;
      const inward = s.right.clone().multiplyScalar(-Math.sign(lateral));
      const halfW = onBranch ? onBranch.branch.halfWidth : t.halfWidth;
      const wallPoint = s.pos.clone().addScaledVector(s.right, Math.sign(lateral) * halfW * wallAt);
      this.body.pos.x = wallPoint.x; this.body.pos.z = wallPoint.z;
      const strength = this.body.impact(inward, 0.28, 0.62);
      const hit = this.body.pos.clone().addScaledVector(inward, -1.0).setY(0.55);
      if (strength > 0.03) {
        if (strength > 0.22) this.effects.crash(hit, inward, strength);
        else this.effects.sparkBurst(hit, inward, strength * 0.7);
        this.audio.impact(strength);
      } else if (Math.abs(this.body.speed) > 8) {
        // Scraping along a wall is the common case and must still throw sparks — otherwise a
        // player pinned to the barrier at 120 mph gets no feedback at all.
        this.effects.sparkBurst(hit, inward, 0.28, { count: 5 });
        this.effects.addShake(0.035);
        this.audio.squeal(0.5, 0.6);
      }
    }

    // ---- boost pads ----
    if (this.city.boostPads?.length && this.race) {
      for (let i = 0; i < this.city.boostPads.length; i++) {
        const bp = this.city.boostPads[i];
        const du = Math.abs(((this.race.playerU - bp.u + 0.5) % 1) - 0.5);
        if (du < 0.006 && Math.abs(lateral - (bp.lateral ?? 0)) < 0.5 && this._lastBoostPad !== i) {
          this._lastBoostPad = i;
          this.nitro.addTank();
          this.effects.boostPad(this.body.pos.clone().setY(0.15), this.city.look.accent);
          this.hud.message('BOOST', 0.9, '#ffd24a');
          setTimeout(() => { if (this._lastBoostPad === i) this._lastBoostPad = -1; }, 1500);
        }
      }
    }

    // ---- FX driven by physics ----
    this._wheelFx(scaled);
    if (this.nitro.ramp > 0.02) {
      const back = this.body.forward.clone().negate();
      this.effects.nitroTrail(this._exhaustWorld(), back, this.nitro.ramp, this.nitro.cfg.color);
    }
    this.jet.update(scaled, this.nitro.ramp, clamp(this.body.speed / this.body.p.topSpeed, 0, 1));
    this.jet.flash.quaternion.copy(this.engine.camera.quaternion);

    applyPose(this.car, this.body, scaled);

    // ---- race + AI ----
    if (this.race) {
      this.race.update(scaled, this.body);
      for (let i = 0; i < this.race.drivers.length; i++) {
        applyPose(this.aiCars[i], this.race.drivers[i].body, scaled);
      }
      if (this.race.state === 'finished' && this.state !== 'finished') {
        this.state = 'finished';
        this.hud.message(this.race.playerPos === 1 ? 'WINNER!' : `FINISHED ${this.race.playerPos}${['st', 'nd', 'rd'][this.race.playerPos - 1] || 'th'}`, 4, '#ffd24a');
      }
    }

    // ---- audio ----
    if (this.audio.enabled) {
      const v = this.audio.engine('player', getVehicle(this.carId).spec);
      v?.update({
        rpm: this.body.rpm, throttle: inp.throttle,
        gearShift: this.body.gearShiftT > 0, volume: 1,
      }, scaled);
      this.audio.squeal(clamp(this.body.drift * 1.3, 0, 1) * smoothstep(4, 14, Math.abs(this.body.speed)), this.body.slip);
    }

    this.effects.update(scaled, null);
    this._updateCamera(dt);
    this.city.update(this.time, this.engine.camera);
  }

  _exhaustWorld() {
    const p = new THREE.Vector3();
    this.jet.group.getWorldPosition(p);
    return p;
  }

  _wheelFx(dt) {
    const wheels = this.car.userData.wheels;
    const slide = clamp(this.body.drift * 1.15, 0, 1) * smoothstep(3, 12, Math.abs(this.body.speed));
    const dirt = this.body.surface === 'dirt' ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const wp = new THREE.Vector3();
      w.getWorldPosition(wp);
      wp.y = 0.04;
      const rear = i >= 2;
      const amt = slide * (rear ? 1 : 0.55);
      if (amt > 0.12 || dirt > 0.5) {
        if (dirt) this.effects.dirtSpray(wp, this.body.vel, Math.max(amt, 0.35));
        else this.effects.tyreSmoke(wp, this.body.vel, amt, 'road');
        const right = this.body.right;
        this.effects.skid.add(i, wp, right, w.userData.radius * 0.85, clamp(amt * 1.4, 0, 1));
        this._skidOn[i] = true;
      } else if (this._skidOn[i]) {
        this.effects.skid.break(i);
        this._skidOn[i] = false;
      }
    }
    void dt;
  }

  _snapCamera() {
    this._updateCamera(1);
    this.engine.camera.position.copy(this.camPos);
  }

  _updateCamera(dt) {
    const cam = this.engine.camera;
    const b = this.body;
    const speed01 = clamp(Math.abs(b.speed) / b.p.topSpeed, 0, 1.2);
    const boost = this.nitro?.ramp ?? 0;

    // Chase rig: pulls back and drops as speed rises; swings out on the outside of a drift so the
    // car's yaw stays readable — the reference always shows the car at an angle mid-slide.
    const back = 7.4 + speed01 * 3.4 + boost * 1.6;
    const up = 2.6 + speed01 * 0.9;
    const lateralSwing = -b.slip * 3.0 * smoothstep(0.1, 0.7, b.drift);

    const fwd = b.forward, right = b.right;
    const want = b.pos.clone()
      .addScaledVector(fwd, -back)
      .addScaledVector(right, lateralSwing)
      .setY(b.pos.y + up);

    const k = 1 - Math.exp(-(this.headless ? 60 : 7.5) * dt);
    this.camPos.lerp(want, k);
    if (this.input.lookBack) {
      this.camPos.copy(b.pos).addScaledVector(fwd, back * 0.7).setY(b.pos.y + up);
    }

    const lookTarget = b.pos.clone().addScaledVector(fwd, 6 + speed01 * 5).setY(b.pos.y + 1.1);
    this.camLook.lerp(lookTarget, 1 - Math.exp(-(this.headless ? 60 : 9) * dt));

    const shake = this.effects.cameraShake(dt);
    cam.position.copy(this.camPos).add(shake.offset);
    cam.lookAt(this.camLook);
    cam.rotateZ(shake.roll + b.roll * 0.35 + b.slip * 0.06);

    const targetFov = 62 + speed01 * 8 + boost * 12;
    this.camFov = lerp(this.camFov, targetFov, 1 - Math.exp(-6 * dt));
    cam.fov = this.camFov;
    cam.updateProjectionMatrix();

    // post response
    this.engine.grade.uniforms.uBoost.value = boost;
    this.engine.speed.uniforms.uAmount.value = clamp(speed01 * 0.55 + boost * 0.75, 0, 1.1);
    this.engine.speed.uniforms.uLines.value = clamp((speed01 - 0.55) * 0.9 + boost * 0.85, 0, 1);
    this.engine.speed.uniforms.uTint.value.set(this.nitro?.cfg.color || '#8fd4ff');
  }

  // ---------------------------------------------------------------- render

  render(dt) {
    this.engine.render(dt);
    if (this.state === 'menu') this.menu.draw(dt);
    else this.hud.draw(this.hudState(), dt);
  }

  hudState() {
    const r = this.race;
    return {
      position: r?.playerPos ?? 1,
      totalRacers: (r?.drivers.length ?? 7) + 1,
      raceTime: r?.time ?? 0,
      lap: (r?.playerLap ?? 0) + 1,
      laps: r?.laps ?? 3,
      standings: r?.standings ?? [],
      mph: this.body ? Math.abs(this.body.speedMph) : 0,
      gear: this.body?.gear ?? 1,
      nitroCharge: this.nitro?.charge ?? 0,
      nitroTanks: this.nitro?.tanks ?? 0,
      nitroActive: (this.nitro?.ramp ?? 0) > 0.1,
      drift: this.body?.drift ?? 0,
      driftScore: (this.body?.drift ?? 0) * Math.abs(this.body?.speedMph ?? 0) * 0.6,
      cityName: this.city?.name,
      record: getCity(this.cityId)?.def.record,
      countdown: r?.state === 'countdown' ? r.countdown : (r ? r.time : null),
      state: r?.state,
    };
  }

  frame = (now) => {
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    this.update(dt || FIXED_DT);
    this.render(dt || FIXED_DT);
    requestAnimationFrame(this.frame);
  };

  start() {
    this._last = performance.now();
    requestAnimationFrame(this.frame);
  }
}

// ---------------------------------------------------------------- boot + harness

const game = new Game();
const params = new URLSearchParams(location.search);

const ready = (async () => {
  await game.setCity(params.get('city') || 'la');
  game.setCar(params.get('car') || 'muscle', params.get('color'));
  if (params.get('mode') === 'race' || params.has('shot')) {
    game.startRace();
    if (game.race && params.get('go') !== '0') { game.race.state = 'racing'; game.race.countdown = 0; }
  } else {
    game.state = 'menu';
    game.menu.open();
  }
  if (!params.has('shot')) game.start();
  return game;
})();

/**
 * Headless harness API. tools/shot.mjs and tools/functest.mjs drive the game through this.
 * Everything is deterministic: fixed timestep, seeded RNG, scripted input.
 */
window.__GAME = {
  ready,
  get game() { return game; },

  async load({ city, car, color } = {}) {
    if (city && city !== game.cityId) await game.setCity(city);
    if (car && (car !== game.carId || color !== game.carColor)) game.setCar(car, color);
    game.startRace();
    game.race.state = 'racing'; game.race.countdown = 0;
    return true;
  },

  setSize(w, h) {
    game.container.style.width = `${w}px`;
    game.container.style.height = `${h}px`;
    game.engine.resize(w, h);
    game.hud.resize(w, h);
    game.effects.setViewportHeight(h);
  },

  /** Advance the sim by n fixed steps with a constant scripted input. */
  step(n = 1, input = {}) {
    game.input.setScripted({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, ...input });
    for (let i = 0; i < n; i++) game.update(FIXED_DT);
    return game.body?.telemetry();
  },

  render() { game.render(FIXED_DT); },

  telemetry() {
    return {
      ...game.body.telemetry(),
      nitro: { charge: +game.nitro.charge.toFixed(3), tanks: game.nitro.tanks, ramp: +game.nitro.ramp.toFixed(3), active: game.nitro.active },
      race: game.race ? { pos: game.race.playerPos, lap: game.race.playerLap, u: +game.race.playerU.toFixed(4), state: game.race.state, time: +game.race.time.toFixed(2) } : null,
      fx: {
        shake: +game.effects.shake.toFixed(3),
        shakePeak: +(game.effects.shakePeak || 0).toFixed(3),
        timeScale: +game.effects.timeScale.toFixed(3),
      },
      city: game.cityId, car: game.carId, state: game.state,
      camera: { fov: +game.engine.camera.fov.toFixed(2) },
    };
  },

  /**
   * Named deterministic scenarios. Each returns a telemetry trace; the last frame is what the
   * screenshot captures. These are the standard captures listed in ART_DIRECTION.md §8.
   */
  async scenario(name, opts = {}) {
    const trace = [];
    const run = (n, input) => {
      for (let i = 0; i < n; i++) {
        game.input.setScripted({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, ...input });
        game.update(FIXED_DT);
        if (i % 6 === 0) trace.push(this.telemetry());
      }
    };
    const place = (u, lateral = 0) => {
      const s = game.city.track.at(u);
      game.body.reset(s.pos.clone().addScaledVector(s.right, lateral * game.city.track.halfWidth), Math.atan2(s.tan.x, s.tan.z));
      if (game.race) game.race.playerU = u;
      game._snapCamera();
    };

    switch (name) {
      case 'chase':
        place(opts.u ?? 0.05);
        run(240, { throttle: 1 });
        break;
      case 'drift':
        place(opts.u ?? 0.14);
        run(170, { throttle: 1 });
        run(46, { throttle: 1, steer: 1, handbrake: true });
        run(30, { throttle: 1, steer: 0.55 });
        break;
      case 'nitrous':
        place(opts.u ?? 0.05);
        run(200, { throttle: 1 });
        run(26, { throttle: 1, nitro: true });
        break;
      case 'nitrous-long':
        place(opts.u ?? 0.05);
        run(200, { throttle: 1 });
        run(90, { throttle: 1, nitro: true });
        break;
      case 'crash':
        // Build real speed first, then turn HARD into the wall — a gentle graze produces a scrape,
        // not the crash spectacle §6.6 is scored on.
        place(opts.u ?? 0.10, opts.lateral ?? -0.6);
        run(300, { throttle: 1 });
        run(30, { throttle: 1, steer: 1 });
        run(10, { throttle: 1, steer: 1 });
        break;
      case 'landmark':
        place(opts.u ?? 0.5);
        run(90, { throttle: 1 });
        break;
      case 'still':
        place(opts.u ?? 0.05);
        run(4, { throttle: 0 });
        break;
      case 'menu':
        game.state = 'menu';
        game.menu.open();
        run(60, {});
        break;
      default:
        throw new Error(`Unknown scenario "${name}"`);
    }
    game.input.clearScripted();
    trace.push(this.telemetry());
    return trace;
  },

  /** Render a synthesised sound offline and return WAV bytes for the audio critic. */
  async renderAudio(kind = 'engine', seconds = 4, carId = null) {
    const { AudioEngine: AE } = await import('./core/audio.js');
    const spec = getVehicle(carId || game.carId).spec;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, Math.floor(44100 * seconds), 44100);
    const { EngineVoice } = await import('./core/audio.js');
    const master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
    if (kind === 'engine') {
      const v = new EngineVoice(ctx, master, spec);
      const steps = 60;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const rpm = spec.audio.idleRpm + (spec.audio.redline - spec.audio.idleRpm) * Math.min(1, t * 1.3);
        // schedule by stepping currentTime is not possible offline; approximate with ramps
        v.update({ rpm, throttle: t < 0.05 ? 0.2 : 1, gearShift: false, volume: 1 });
      }
    }
    const buf = await ctx.startRendering();
    const bytes = bufferToWav(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
    void AE;
  },

  info() {
    return {
      cities: CITY_IDS,
      cars: VEHICLE_IDS,
      renderer: game.engine.renderer.info,
      errors: window.__ERRORS,
    };
  },
};

window.__ERRORS = [];
window.addEventListener('error', (e) => window.__ERRORS.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => window.__ERRORS.push(String(e.reason)));

ready.then(() => { window.__READY = true; }).catch((e) => {
  window.__ERRORS.push(`BOOT: ${e?.stack || e}`);
  window.__READY = 'error';
});
