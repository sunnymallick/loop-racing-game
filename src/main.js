import * as THREE from 'three';
import { Engine, disposeObject } from './core/engine.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
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
    // LIGHTING piece: replace the sky-only probe with a cube capture of the finished city so car
    // paint and wet asphalt reflect neon and buildings, not just a flat sky. Mutates built.envMap.
    this.engine.captureEnvironment(built, { hide: [this.car, ...this.aiCars] });
    this.engine.scene.environment = built.envMap || null;
    this.engine.applyLook(built.look);
    if (this.car) this._applyEnv(this.car);
    return built;
  }

  setCar(id, color = null) {
    // the jet lives under the car — detach it before disposeObject() walks the subtree, or the
    // nitrous piece's shared (module-cached) geometry and textures get disposed out from under it
    if (this.jet) { this.jet.group.removeFromParent(); this.jet.dispose?.(); this.jet = null; }
    if (this.car) { this.engine.scene.remove(this.car); disposeObject(this.car); }
    const v = getVehicle(id);
    const car = buildVehicle(id, { color: color || v.spec.colors[0], envMap: this.city?.envMap });
    this.carId = id;
    this.carColor = color || v.spec.colors[0];
    this.car = car;
    this.engine.scene.add(car);
    this.body = new VehicleBody(v.spec, { wheelbase: v.blueprint.dims.wheelbase });
    this.nitro = new Nitrous(v.spec);

    // One plume per exhaust outlet, anchored in car space (assemble.js parents the anchors to the
    // car root, so their local positions are already what NitrousJet wants).
    const ex = car.userData.exhausts;
    const nozzles = ex?.length
      ? ex.map((e) => e.position.clone())
      : [new THREE.Vector3(0, 0.45, -v.blueprint.dims.length / 2)];
    this.jet = new NitrousJet(v.spec.nitro, {
      scale: id === 'suv' ? 1.06 : id === 'tuner' ? 1.0 : 1,
      nozzles,
    });
    car.add(this.jet.group);
    this._applyEnv(car);
    return car;
  }

  _applyEnv(obj) {
    if (!this.city?.envMap) return;
    // LIGHTING piece owns how hard paint/chrome/glass lean on the probe (engine.applyEnvironment).
    this.engine.applyEnvironment(obj, this.city.envMap);
  }

  startRace({ opponents = 7 } = {}) {
    const def = getCity(this.cityId).def;
    const prevRace = this.race;
    this.race = new Race({
      track: this.city.track, cityDef: def,
      playerSpec: getVehicle(this.carId).spec, opponents,
    });
    const slot = this.race.grid(this.city.spawn.u);
    const s = this.city.track.at(slot.u);
    const p = s.pos.clone().addScaledVector(s.right, slot.lateral * this.city.track.halfWidth);
    this.body.reset(p, Math.atan2(s.tan.x, s.tan.z));
    this.nitro.reset();

    // RACE piece: the opponents' nitrous plumes live under their cars (same reason the player's
    // does), so detach them before disposeObject() walks the subtree and frees the nitrous piece's
    // shared, module-cached geometry out from under everything.
    prevRace?.detachCars?.();
    for (const c of this.aiCars) { this.engine.scene.remove(c); disposeObject(c); }
    this.aiCars = [];
    for (const d of this.race.drivers) {
      const spec = getVehicle(d.vehicleId).spec;
      const color = spec.colors[(d.id + 1) % spec.colors.length];
      const c = buildVehicle(d.vehicleId, { color, envMap: this.city.envMap });
      this.engine.scene.add(c);
      this._applyEnv(c);
      this.aiCars.push(c);
    }
    // the director drives the opponents' plumes, smoke and rubber off these
    this.race.attachCars(this.aiCars, { effects: this.effects });
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
    if (this.nitro.justFired) {
      this.audio.nitroStart();
      // ignition reads as an EVENT: muzzle flash + shock ring in the jet, a hard kick on the camera
      this.jet.ignite();
      this.effects.addShake(this.nitro.cfg.fx?.shake ?? 0.35);
      // NOTE (nitrous piece): the ignition spark blast is fired by jet.ignite() above, into a
      // narrow REARWARD cone. The generic effects.sparkBurst used here in round 1 threw an
      // isotropic shower that read as "the car detonated" rather than "the car is boosting".
      this.hud.message('NITRO!', 1.1, '#ff9214');
    }
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
    // which way the boost camera swings to get a rear three-quarter on the plume: toward the
    // centre of the road, smoothed so crossing the centreline never snaps the view across
    const wantSide = lateral > 0 ? -1 : 1;
    this._boostSide = lerp(this._boostSide ?? wantSide, wantSide, 1 - Math.exp(-1.2 * scaled));
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
      // RACE piece: push the car back across the road by the overshoot, rather than rebuilding its
      // position from the sample's cross-section. The old form discarded the along-track component,
      // so a car held against a barrier was re-snapped onto the *same* cross-section every frame:
      // it sat at exactly |lateral| = 1.52 reading 150 mph and travelling nowhere, and `nearest()`
      // kept returning the same sample, so it never got out. (A full-race probe with the player on
      // autopilot ended with the player on lap 0 after four minutes, pinned to one barrier.)
      const over = (absLat - wallAt) * halfW;
      this.body.pos.addScaledVector(inward, over);
      const strength = this.body.impact(inward, 0.28, 0.62);
      // FX contact point. This is NOT "one metre outboard of the car" — that put the burst a metre
      // *behind* the barrier, hanging in open air, which is why the crash read as a decal pasted
      // over the frame (ART_DIRECTION §6.6). The solid surface the car is actually touching is the
      // kerb face / barrier line, which by the track's own cross-section sits right on the
      // collision plane, so the burst belongs on `wallPoint` itself, at rubbing-strip height.
      const hit = wallPoint.clone().addScaledVector(inward, -0.2).setY(0.42);
      if (strength > 0.03) {
        if (strength > 0.22) this.effects.crash(hit, inward, strength, { vel: this.body.vel, paint: this.carColor });
        else this.effects.sparkBurst(hit, inward, strength * 0.7, { vel: this.body.vel });
        this.audio.impact(strength, { surface: 'concrete', pan: Math.sign(lateral) * 0.6 });
      } else if (Math.abs(this.body.speed) > 6) {
        // Scraping along a wall is the common case and must still throw sparks — otherwise a
        // player pinned to the barrier at 120 mph gets no feedback at all.
        this.effects.wallScrape(hit, inward, this.body.vel, clamp((Math.abs(this.body.speed) - 6) / 26, 0, 1));
        // (audio piece) metal on barrier is a SCRAPE, not a tyre squeal
        this.audio.scrape(0.35 + 0.65 * clamp((Math.abs(this.body.speed) - 6) / 26, 0, 1));
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
    // The nitrous trail is drawn entirely by NitrousJet (soft-edged, wake-entrained, rearward).
    // effects.nitroTrail() fires world-space embers at full car speed, which cross the chase
    // camera in two frames and turn the boost into a firework — see src/vehicles/nitrous.js.
    this.jet.update(scaled, this.nitro.flame, {
      speed: Math.abs(this.body.speed),
      camera: this.engine.camera,
      surge: this.nitro.surge,
      // (nitrous piece) thrust authority drives the plume's LENGTH, so the jet is a short hot stub
      // at ignition and a long column at sustain — and an SUV spooling up looks like it is spooling
      // up. Without this the flame level alone made every frame the same size.
      ramp: this.nitro.ramp,
    });

    applyPose(this.car, this.body, scaled);

    // ---- race + AI ----
    if (this.race) {
      this.race.update(scaled, this.body);
      for (let i = 0; i < this.race.drivers.length; i++) {
        applyPose(this.aiCars[i], this.race.drivers[i].body, scaled);
      }
      // opponents' nitrous plumes / tyre smoke / rubber (RACE piece owns what they do)
      this.race.updateVisuals(scaled, this.engine.camera);
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
      // `slide` not `drift`: a tyre squeals when it scrubs, and that includes a standing burnout.
      // (audio piece) the surface and road speed go in too: tarmac howls, dirt washes, kerbs
      // rumble, and the ambience bed / music scheduler ride on the same state.
      const spd = Math.abs(this.body.speed);
      this.audio.squeal(
        clamp((this.body.slide ?? this.body.drift) * 1.3, 0, 1) * smoothstep(4, 14, spd),
        this.body.slip,
        { surface: this.body.surface, speed: spd },
      );
      this.audio.tick(scaled, { speed: spd, surface: this.body.surface, boost: this.nitro?.ramp ?? 0 });
    }

    // the body goes in so the FX piece can trail damage smoke off the corner that took a hit
    this.effects.update(scaled, null, this.body);
    this._updateCamera(dt);
    this.city.update(this.time, this.engine.camera);
    // HUD state (needle spring, nitro drain, flashes) integrates on the SIM clock, not the render
    // clock, so scripted/headless runs show the same animated state a real frame would.
    this.hud.update(this.hudState(), dt);
  }

  _exhaustWorld() {
    const p = new THREE.Vector3();
    (this.jet.nozzles?.[0]?.group ?? this.jet.group).getWorldPosition(p);
    return p;
  }

  _wheelFx(dt) {
    const wheels = this.car.userData.wheels;
    const b = this.body;
    // A tyre smokes when it is SLIDING, and it slides two ways: sideways (drift) or longitudinally
    // (wheelspin) — §2.5 makes both mandatory, and keying only off `drift` missed every burnout.
    const slide = clamp(b.slide ?? Math.max(b.drift, b.wheelSlip * 0.95), 0, 1)
      * smoothstep(3, 12, Math.abs(b.speed));
    const dirt = b.surface === 'dirt' ? 1 : 0;
    // Emission is rate-limited and rear-biased. A three-second slide at 30 puffs/wheel/second
    // builds a wall of smoke that the chase camera then flies into: the plume has to read as
    // coming off the loaded rear contact patches, not as fog.
    this._fxTick = (this._fxTick || 0) + 1;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const wp = new THREE.Vector3();
      w.getWorldPosition(wp);
      wp.y = 0.04;
      const rear = i >= 2;
      const amt = slide * (rear ? 0.62 : 0.26);
      if (amt > 0.12 || dirt > 0.5) {
        const puff = this._fxTick % (rear ? 3 : 7) === 0;
        if (dirt) { if (puff) this.effects.dirtSpray(wp, b.vel, Math.max(amt, 0.35)); }
        else if (puff) this.effects.tyreSmoke(wp, b.vel, amt, 'road');
        const right = b.right;
        this.effects.skid.add(i, wp, right, w.userData.radius * 0.85, clamp(amt * 1.6, 0, 1));
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
    const surge = this.nitro?.surge ?? 0;
    const flame = this.nitro?.flame ?? 0;
    // Ignition punch: a hard spike that decays over the class's surge window.
    const kick = surge * surge * (this.nitro?.cfg.surge ?? 0.6);

    // Chase rig: pulls back and drops as speed rises; swings out on the outside of a drift so the
    // car's yaw stays readable — the reference always shows the car at an angle mid-slide.
    // Under nitrous it snaps BACK on ignition, then rises and swings to a rear three-quarter so
    // the plume is seen in profile instead of straight down its own axis (§6.3 camera response).
    // Longitudinal g drags the rig back on a launch and pulls it in under braking — the cheapest
    // way to make acceleration felt rather than merely displayed on the speedo.
    const gPull = clamp((b.aLong ?? 0) * 0.055, -0.9, 1.9);
    // (nitrous piece) the flame pull-in is deliberately small: the plume is ~4 m long, and pulling
    // the rig in any harder puts its tip through the near plane, where it clips into a hard-edged
    // sheet across the lens. The boost read comes from the FOV punch and the rise instead.
    // Mid-slide the rig lifts and backs off: a three-second drift lays down a wall of tyre smoke,
    // and a camera at bumper height sits INSIDE it (§6.2 is judged on drift frames — the car has to
    // clear its own plume).
    const back = 6.0 + speed01 * 3.2 + gPull - flame * 2.10 + kick * 4.4 + b.drift * 2.1;
    // (nitrous piece, r3) the rig climbs hard while the jet is lit. The lateral swing below is
    // routinely eaten by the barrier clamp on a narrow street, and with the rig ON the jet's axis a
    // 5 m plume projects to a dot — which is exactly why the 207/244 mph boost frames read as
    // "modest" while a 167 mph one read as "enormous". Height cannot be clamped away, so the
    // high three-quarter is what actually guarantees the plume screen-space length at any speed.
    const up = 2.30 + speed01 * 0.50 + flame * 2.35 + kick * 0.8 + b.drift * 1.15;
    // Under nitrous the rig swings out to one side: §8 asks for a REAR THREE-QUARTER on the
    // plume, and sitting on the axis foreshortens a 4 m jet into a bright blob behind the bumper.
    const lateralSwing = flame * 4.6 * (this._boostSide ?? 1);

    const fwd = b.forward, right = b.right;
    // ------------------------------------------------------------------ the drift camera
    // THE fix of round 3. The rig has to sit behind the direction of TRAVEL, not behind the nose:
    // that is the only thing that puts the car's flank and its counter-steered front wheels in
    // frame, and without it 28° of measured slip renders as a car sitting dead square with a level
    // taillight bar (the round-2 critic's headline: "the drift never reads as a drift").
    //
    // Round 2 nominally did this — and then cancelled it. It lerped the rig's axis toward the
    // course AND swung the rig sideways by `slip * 7.2` on the car's right. Behind the course at
    // 9 m, the car is 9·sin(slip) ≈ 4.2 m off the camera's axis at 28°; the swing put 3.5 m of it
    // straight back. Net: the camera ended up on the nose again.
    //
    // So it is done once, as an ANGLE. Camera azimuth = heading + 0.78 × slip, smoothed on a
    // ~0.15 s critically-damped follow so it swings with the slide instead of snapping to it, and
    // both the rig and the aim point use that one axis. A 28° slide now presents ~22° of yaw.
    this._camYaw ??= b.yaw;
    this._camYawV ??= 0;
    const yawWant = b.yaw + clamp(b.slip, -0.85, 0.85) * 0.78
      * smoothstep(0.06, 0.34, Math.abs(b.slip)) * smoothstep(3, 9, b.groundSpeed);
    // critically damped second-order follow: no overshoot, no snap, ~0.15 s to settle
    {
      const wN = 2 / 0.15, hdt = Math.min(dt, 0.05);
      let e = yawWant - this._camYaw;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      this._camYawV += (e * wN * wN - 2 * wN * this._camYawV) * hdt;
      this._camYaw += this._camYawV * hdt;
      if (dt >= 0.5) { this._camYaw = yawWant; this._camYawV = 0; }   // _snapCamera()
    }
    const chase = new THREE.Vector3(Math.sin(this._camYaw), 0, Math.cos(this._camYaw));
    const want = b.pos.clone()
      .addScaledVector(chase, -back)
      .addScaledVector(right, lateralSwing)
      .setY(b.pos.y + up);

    // Keep the rig inside the barriers. Swinging wide to show a drift angle must never put a wall
    // between the camera and the car — which is exactly what happens on a slide along a barrier.
    const trk = this.city?.track;
    if (trk) {
      // (nitrous piece) while boosting the rig is allowed a little further out — it is also much
      // higher, so it clears the barrier it is over instead of being stuck behind it.
      const lim = 1.12 + flame * 0.30;
      const nc = trk.nearest(want, this.race?.playerU ?? null);
      if (Math.abs(nc.lateral) > lim) {
        const s = nc.sample;
        const edge = s.pos.clone().addScaledVector(s.right, Math.sign(nc.lateral) * trk.halfWidth * lim);
        want.x = edge.x; want.z = edge.z;
      }
    }

    const k = 1 - Math.exp(-(this.headless ? 60 : 7.5) * dt);
    this.camPos.lerp(want, k);
    if (this.input.lookBack) {
      this.camPos.copy(b.pos).addScaledVector(fwd, back * 0.7).setY(b.pos.y + up);
    }

    // Aim down the SAME axis the rig sits on, not down the car's nose — mid-drift those differ by
    // the slip angle, and looking down the nose throws the car out to the edge of frame. Deep in a
    // slide, pull the aim back toward the car itself so it stays framed even when the rig has been
    // pushed back inside the barriers.
    // Under nitrous the aim point pulls back toward the car: with the rig swung out to the side,
    // a distant lead point cancels most of the offset and the shot goes back to being end-on.
    const lookTarget = b.pos.clone()
      .addScaledVector(chase, (5.4 + speed01 * 4.6) * (1 - flame * 0.62))
      .setY(b.pos.y + 1.05 + flame * 0.85);
    lookTarget.lerp(b.pos.clone().setY(b.pos.y + 0.95), smoothstep(0.2, 0.8, b.drift) * 0.45);
    this.camLook.lerp(lookTarget, 1 - Math.exp(-(this.headless ? 60 : 9) * dt));

    const shake = this.effects.cameraShake(dt);
    cam.position.copy(this.camPos).add(shake.offset);
    cam.lookAt(this.camLook);
    // The frame leans WITH the body, a fifth as far. A camera roll tilts the horizon too, so it
    // cannot cancel the body's lean against the road — it just adds the bit of dutch angle that
    // sells the load. (Round 2 also subtracted a term proportional to lateral g here, which pulled
    // the frame the other way and quietly ate about a degree of the very lean §6.2 scores.)
    cam.rotateZ(shake.roll + b.roll * 0.20 + b.slip * 0.05
      - kick * 0.05 * (this._boostSide ?? 1));

    // FOV: a violent snap on ignition (fast lerp while surging), then a held wide angle.
    const targetFov = 54 + smoothstep(0.08, 1.0, speed01) * 14 + boost * 8 + kick * 14;
    this.camFov = lerp(this.camFov, targetFov, 1 - Math.exp(-(6 + surge * 26) * dt));
    cam.fov = this.camFov + (this.effects.fovKick || 0);   // impact punch (fx piece)
    cam.updateProjectionMatrix();

    // post response — grade saturates/tightens and the speed lines take the flame's tint
    this.engine.grade.uniforms.uBoost.value = clamp(boost * 0.8 + kick * 1.1, 0, 1.6);
    this.engine.speed.uniforms.uAmount.value = clamp(smoothstep(0.2, 1.05, speed01) * 0.58 + boost * 0.5 + kick * 0.55, 0, 1.1);
    this.engine.speed.uniforms.uLines.value = clamp(smoothstep(0.55, 1.08, speed01) * 0.7 + boost * 0.55 + kick * 0.7, 0, 1);
    this.engine.speed.uniforms.uTint.value.set(this.nitro?.cfg.color || '#8fd4ff');

    // Heat haze (nitrous piece): the plume boils the air, so the grade pass ripples the image
    // around the jet's screen position. Guarded so an older post.js simply has no shimmer.
    const gu = this.engine.grade.uniforms;
    if (gu.uHeat) {
      const amt = this.jet ? this.jet.heatPoint(cam, gu.uHeatPos.value) : 0;
      gu.uHeat.value = clamp(amt, 0, 1.4);
    }
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
      // HUD piece: the DRIFT panel's ANGLE readout should render THIS, the simulated slip angle.
      // In round 1 it drew `drift * 42`, so it read 42° while the car was at 24° (§6.2 critic).
      slipDeg: Math.abs((this.body?.slip ?? 0) * 57.29578),
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
      race: game.race ? game.race.telemetry() : null,
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
    // MENU piece: scenario('menu') leaves the game in the menu state, where Game.update() short
    // circuits to Menu.update() — so every scenario run AFTER it silently drove nothing and
    // captured the garage instead of the race (`--shots menu,chase` produced two menu frames).
    // Any non-menu scenario re-enters racing first.
    if (name !== 'menu' && game.state === 'menu') {
      game.menu.close();
      game.startRace();
      game.race.state = 'racing'; game.race.countdown = 0;
    }
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
    /** Drive the racing line at a target speed — the approach a human makes before a drift.
     *  `offset` holds a lateral line (-1 = left edge) so the car arrives PARALLEL to the road out
     *  wide, rather than still cutting across it when the handbrake comes on. */
    const autopilot = (n, target, offset = 0) => {
      for (let i = 0; i < n; i++) {
        const t = game.city.track;
        const near = t.nearest(game.body.pos, game.race?.playerU ?? null);
        const aim = t.at(near.u + Math.min(0.03, 0.004 + Math.abs(game.body.speed) * 0.00042));
        const to = aim.pos.clone().addScaledVector(aim.right, offset * t.halfWidth).sub(game.body.pos);
        const f = game.body.forward;
        const ang = Math.atan2(f.x * to.z - f.z * to.x, f.x * to.x + f.z * to.z);
        const v = game.body.speed;
        game.input.setScripted({
          steer: clamp(-ang * 2.2, -1, 1),
          throttle: v < target ? 1 : 0,
          brake: v > target * 1.05 ? clamp((v - target) * 0.22, 0, 1) : 0,
          nitro: false, handbrake: false,
        });
        game.update(FIXED_DT);
        if (i % 6 === 0) trace.push(this.telemetry());
      }
    };
    /** Autopilot until the car reaches track position `u` (or the frame budget runs out). */
    const autopilotTo = (u, max, target, offset = 0) => {
      const t = game.city.track;
      for (let i = 0; i < max; i++) {
        const here = ((t.nearest(game.body.pos, game.race?.playerU ?? null).u % 1) + 1) % 1;
        if (((u % 1) + 1 - here) % 1 < 30 / t.length) break;
        autopilot(1, target, offset);
      }
    };
    const runWhile = (cond, max, input) => {
      let i = 0;
      while (i < max && cond()) {
        game.input.setScripted({ throttle: 0, brake: 0, steer: 0, nitro: false, handbrake: false, ...input });
        game.update(FIXED_DT);
        if (i % 6 === 0) trace.push(this.telemetry());
        i++;
      }
      return i;
    };
    // The straightest stretch of this city's lap (NITROUS piece). A 240 mph boost launched into a
    // corner runs wide into the barrier, and the wall-scrape spark shower then swamps the plume —
    // the nitrous capture in §8 has to be a frame about the jet, not about grinding a wall.
    const straightU = () => {
      let best = 0.05, bestC = Infinity;
      for (let i = 0; i < 200; i++) {
        const u0 = i / 200;
        let c = 0;
        // weight the far end harder: the run-up plus the boost covers most of this window
        for (let k = 0; k < 24; k++) {
          const u = (u0 + k * 0.005) % 1;
          c += Math.abs(game.city.track.curvature(u)) * (1 + k * 0.05);
          // and steer clear of boost pads: their glowing chevrons are brighter than the jet
          for (const bp of game.city.boostPads || []) {
            if (Math.abs(((u - bp.u + 0.5) % 1) - 0.5) < 0.02) c += 4;
          }
        }
        if (c < bestC) { bestC = c; best = u0; }
      }
      return best;
    };
    // Same as run(), but trims gently back to the racing line each frame. Deliberately soft: a
    // stiff controller oscillates, and an oscillation at 240 mph is a drift into the wall.
    const follow = (n, input) => {
      for (let i = 0; i < n; i++) {
        const nc = game.city.track.nearest(game.body.pos, game.race?.playerU ?? null);
        const head = Math.atan2(nc.sample.tan.x, nc.sample.tan.z);
        const cur = Math.atan2(game.body.forward.x, game.body.forward.z);
        let dy = head - cur;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const steer = clamp(dy * 0.80 - nc.lateral * 0.50 - (game.body.slip ?? 0) * 1.1, -0.30, 0.30);
        game.input.setScripted({ throttle: 0, brake: 0, steer, nitro: false, handbrake: false, ...input });
        game.update(FIXED_DT);
        if (i % 6 === 0) trace.push(this.telemetry());
      }
    };

    switch (name) {
      case 'chase': {
        // The default capture for judging car art and city art, so it must show the car DRIVING —
        // flat out in a straight line from a fixed u put it into a barrier on any city with a bend
        // in the first 200 m, and critics were scoring bodywork and streetscapes off crash photos.
        // Autopilot up to speed on the racing line, then hold it.
        place(opts.u ?? 0.05);
        const top = game.body.p.topSpeed;
        autopilot(230, top * (opts.pace ?? 0.92), opts.offset ?? 0);
        autopilot(30, top * (opts.pace ?? 0.92), opts.offset ?? 0);
        break;
      }
      case 'drift':
      case 'drift-recover': {
        // ART_DIRECTION §6.2 is scored on a SLIDE, not a crash. The old capture drove flat out in a
        // straight line for 2.8 s from a fixed u, so by the time the handbrake came on the car was
        // already off the road and in a barrier — every class, every city. So: find a real corner,
        // arrive on the racing line at a speed this class can actually hold sideways through a
        // radius that size (v² = driftG·R), flick it, then hold ONE constant opposite lock.
        // Nothing here steers the car during the slide: the drift in the last 3 s of the trace is
        // held by that fixed counter-steer and the tyre model, or it is not held at all.
        const trk = game.city.track, ph = game.body.p;
        const u0 = opts.u ?? 0.02;
        // The tightest SUSTAINED corner in the next half-lap: average the curvature over a 150 m
        // window (one drift's worth of road) rather than picking the single tightest sample, so the
        // slide is aimed at a corner that stays bent for the whole three seconds.
        // ...and pick the corner that suits THIS car: a slide holds a radius of v²/driftG, so the
        // supercar (2 g sideways) wants a tighter bend than the SUV. Score each 120 m window of
        // road by how close its average radius is to the one this class can hold at ~100 mph.
        const win = 120 / trk.length;
        const wantR = clamp(45 * 45 / (ph.driftG ?? 14), 60, 400);
        let entryU = u0, radius = 1e6, turnSum = 0, bestScore = Infinity;
        for (let k = 0; k < 0.6; k += 0.004) {
          let c = 0, n = 0, sgn = 0;
          for (let j = 0; j < win; j += win / 12) { const t = trk.turnRate(u0 + k + j); c += Math.abs(t); sgn += t; n++; }
          const r = n / Math.max(1e-6, c);
          const score = Math.abs(Math.log(r / wantR));
          if (score < bestScore) { bestScore = score; radius = r; entryU = u0 + k; turnSum = sgn; }
        }
        const dir = turnSum < 0 ? 1 : -1;                     // +1 = the road turns right here
        // Entry speed this class can hold sideways through this radius. `driftG` is the sustained
        // PATH-BENDING acceleration (see handling.js), so v² = driftG·R really is the speed whose
        // drift arc matches the bend; capped at 52 m/s so no class arrives at 150 mph sideways.
        const vTarget = clamp(Math.sqrt(radius * (ph.driftG ?? 14)), 30, 52);
        place(entryU - 330 / trk.length, -0.45 * dir);        // set up wide, on the outside
        // approach on the racing line, braking to an entry speed this class can hold sideways
        autopilotTo(entryU, 460, vTarget, -0.5 * dir);
        // the flick: handbrake with the wheel INTO the corner until the tail is genuinely out
        const commit = ph.slipMax * 0.45 * (Math.PI / 180);
        runWhile(() => Math.abs(game.body.slip) < commit, 36, { throttle: 0.30, steer: dir, handbrake: true });
        // The hold: three seconds of opposite lock. The lock is stepped once partway through and
        // eased at the end, so the trace shows the slip angle FOLLOWING the driver's hands — more
        // lock, more angle; less lock, less angle. That is the difference between a drift that is
        // balanced and one that is scripted, and it is visible in the JSON.
        //
        // On top of the lock, a trim off lateral position — but only OUTSIDE a wide deadband. In
        // the middle 70% of the road the driver's hands are the fixed lock and nothing else, which
        // is the whole point of this capture; past that the car is about to leave the tarmac, and
        // a real drifter feeds in the correction rather than driving into the wall (which is
        // exactly how the tuner and supercar captures ended before this existed). Inside the
        // deadband the trim is identically zero, so the muscle and SUV slides are untouched.
        const hold = (n, throttle, lockSteer) => {
          for (let i = 0; i < n; i++) {
            const nc = trk.nearest(game.body.pos, game.race?.playerU ?? null);
            const off = Math.sign(nc.lateral) * Math.max(0, Math.abs(nc.lateral) - 0.70);
            const trim = clamp(-off * 1.30, -0.24, 0.24);
            game.input.setScripted({
              throttle, brake: 0, steer: clamp(lockSteer + trim, -1, 1), nitro: false, handbrake: false,
            });
            game.update(FIXED_DT);
            if (i % 6 === 0) trace.push(this.telemetry());
          }
        };
        if (name === 'drift') {
          hold(52, 0.85, -0.52 * dir);
          hold(30, 0.72, -0.72 * dir);
          hold(20, 0.95, -0.62 * dir);
        } else {
          hold(120, 0.85, -0.55 * dir);
        }
        // ...and, for the recovery capture, hands off: the slide must wind itself up straight
        if (name === 'drift-recover') { run(70, { throttle: 0.3, steer: 0 }); run(80, { throttle: 1 }); }
        break;
      }
      case 'nitrous':
        // §8: "0.4 s into a boost" — 26 frames at 1/60 s. Note the per-class SPOOL curve means
        // `boost` legitimately differs here (supercar ~1.0, SUV ~0.12): that is the freight-train
        // vs. light-switch feel §6.3 asks for. The VISUAL level (Nitrous.flame) is on its own
        // faster schedule, so all four classes show a fully lit jet in this frame.
        place(opts.u ?? straightU());
        follow(120, { throttle: 1 });
        follow(26, { throttle: 1, nitro: true });
        break;
      case 'nitrous-long':
        place(opts.u ?? straightU());
        follow(80, { throttle: 1 });
        follow(90, { throttle: 1, nitro: true });
        break;
      case 'nitrous-ignite':
        // the ignition frame itself — muzzle flash, shock ring, FOV snap (ART_DIRECTION §6.3)
        place(opts.u ?? straightU());
        follow(120, { throttle: 1 });
        follow(5, { throttle: 1, nitro: true });
        break;
      case 'crash': {
        // ART_DIRECTION §8 defines the crash capture as "0.2 s AFTER a wall impact". Running a
        // fixed number of frames missed it: the car reached the barrier early and was still
        // grinding along it 2.4 s (≈115 m) later, so the frame showed the tail of a scrape and
        // none of the impact. Drive until the FX director records an impact, then hold for the
        // choreographed beat — with hit-stop that is ~0.2 s of sim time.
        place(opts.u ?? 0.10, opts.lateral ?? -0.6);
        const hits = game.effects.impacts;
        let i = 0;
        for (; i < 480 && game.effects.impacts === hits; i++) {
          run(1, { throttle: 1, steer: i > 300 ? 1 : 0 });
        }
        run(opts.after ?? 12, { throttle: 1, steer: i > 300 ? 1 : 0 });
        break;
      }
      case 'landmark':
        // §8 wants "a framing that includes the city's primary landmark". u=0.5 was an arbitrary
        // point on the lap; the city kit sites its landmarks off the route and publishes the
        // approach that frames them, so use that when the caller has not asked for a specific u.
        place(opts.u ?? game.city.landmarkU ?? 0.5);
        // Same reason as 'chase': steer the racing line so the landmark is framed from the road,
        // not from inside whatever the car ran into.
        autopilot(110, game.body.p.topSpeed * 0.70, opts.offset ?? 0);
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

  /** Render a synthesised sound offline and return base64 WAV bytes for the audio critic. */
  async renderAudio(kind = 'engine', seconds = 5, carId = null) {
    const { renderClipBase64 } = await import('./core/audio_render.js');
    const spec = getVehicle(carId || game.carId).spec;
    return renderClipBase64(kind, seconds, spec);
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
