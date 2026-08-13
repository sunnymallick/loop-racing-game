import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { VEHICLE_IDS, buildVehicle, getVehicle } from '../vehicles/index.js';
import { VehicleBody, applyPose } from '../vehicles/physics.js';

const NAMES = [
  'DOM', 'LETTY', 'ROMAN', 'TEJ', 'MIA', 'HAN', 'GISELE', 'SUKI',
  'BRIAN', 'JESSE', 'VINCE', 'RICO', 'NIKO', 'CARA', 'AXEL', 'RAY',
];

/**
 * Opponent AI. Follows the racing line with a per-driver lateral offset and skill, brakes for
 * curvature, uses nitrous on straights, and rubber-bands gently toward the player so the pack
 * stays close (the reference is always four cars deep in frame) without being obviously unfair.
 */
export class AIDriver {
  constructor(id, track, spec, opts = {}) {
    this.id = id;
    this.track = track;
    this.spec = spec;
    this.name = opts.name || NAMES[id % NAMES.length];
    this.rng = new RNG(1000 + id * 37);
    this.skill = opts.skill ?? this.rng.range(0.72, 0.98);
    this.lineOffset = opts.lineOffset ?? this.rng.range(-0.55, 0.55);
    this.body = new VehicleBody(spec, { wheelbase: opts.wheelbase ?? 2.8 });
    this.u = opts.u ?? 0;
    this.lap = 0;
    this.finished = false;
    this.totalTime = 0;
    this.boostT = 0;
    this.progress = 0;
  }

  spawn(u, lateral) {
    const s = this.track.at(u);
    const p = s.pos.clone().addScaledVector(s.right, lateral * this.track.halfWidth);
    this.body.reset(p, Math.atan2(s.tan.x, s.tan.z));
    this.u = u;
    this.progress = u;
  }

  step(dt, { playerProgress = 0, playerSpeed = 0 } = {}) {
    const t = this.track;
    const near = t.nearest(this.body.pos, this.u);
    // wrap-aware progress
    const prevU = this.u;
    this.u = ((near.u % 1) + 1) % 1;
    if (prevU > 0.85 && this.u < 0.15) this.lap++;
    this.progress = this.lap + this.u;

    // --- look ahead and steer toward the line ---
    const lookAhead = clamp(0.006 + Math.abs(this.body.speed) * 0.00045, 0.006, 0.035);
    const aim = t.at(this.u + lookAhead);
    const target = aim.pos.clone().addScaledVector(aim.right, this.lineOffset * t.halfWidth * 0.8);
    const toTarget = target.clone().sub(this.body.pos);
    const fwd = this.body.forward;
    const angle = Math.atan2(
      fwd.x * toTarget.z - fwd.z * toTarget.x,
      fwd.x * toTarget.x + fwd.z * toTarget.z,
    );
    const steer = clamp(-angle * 1.9, -1, 1);

    // --- speed target from upcoming curvature ---
    const curveAhead = Math.max(
      Math.abs(t.curvature(this.u + 0.012)),
      Math.abs(t.curvature(this.u + 0.028)),
    );
    const corner = smoothstep(0.004, 0.05, curveAhead);
    let targetSpeed = lerp(this.spec.physics.topSpeed, this.spec.physics.topSpeed * 0.42, corner);
    targetSpeed *= lerp(0.80, 1.03, this.skill);

    // rubber band: behind the player they get a small boost, ahead a small trim
    const gap = playerProgress - this.progress;
    targetSpeed *= clamp(1 + gap * 0.55, 0.90, 1.14);
    void playerSpeed;

    const throttle = this.body.speed < targetSpeed ? 1 : 0;
    const brake = this.body.speed > targetSpeed * 1.14 ? clamp((this.body.speed - targetSpeed) * 0.16, 0, 1) : 0;

    // --- nitrous on straights ---
    this.boostT -= dt;
    let boost = 0;
    if (corner < 0.16 && this.boostT < -2.5 && this.rng.bool(0.4 * dt * 60 * 0.02)) this.boostT = 1.6;
    if (this.boostT > 0) boost = clamp(this.boostT / 0.5, 0, 1);

    // off-track penalty
    const offTrack = Math.abs(near.lateral) > 1.15;
    const surfaceGrip = offTrack ? 0.62 : 1.0;

    this.body.step(dt, { throttle, brake, steer, handbrake: false }, {
      surfaceGrip, boost,
      boostThrust: this.spec.nitro.thrust * 26,
      topSpeedMul: this.spec.nitro.topSpeedMul,
      groundY: 0,
    });

    // keep AI on the road — they nudge back rather than crashing out, which keeps the pack tight
    if (Math.abs(near.lateral) > 1.35) {
      const s = t.at(this.u);
      const want = s.pos.clone().addScaledVector(s.right, Math.sign(near.lateral) * t.halfWidth * 1.1);
      this.body.pos.lerp(want, 1 - Math.exp(-4 * dt));
    }
    this.totalTime += dt;
    return this;
  }
}

/** Race director: grid, countdown, laps, positions, finish. */
export class Race {
  constructor({ track, cityDef, playerSpec, opponents = 7, seed = 5 }) {
    this.track = track;
    this.cityDef = cityDef;
    this.rng = new RNG(seed);
    this.laps = cityDef.laps ?? 3;
    this.state = 'countdown';     // countdown | racing | finished
    this.countdown = 3.2;
    this.time = 0;
    this.lapTime = 0;
    this.playerLap = 0;
    this.playerU = 0;
    this.playerProgress = 0;
    this.playerPos = 1;
    this.lapTimes = [];
    this.finishTime = null;
    this.drivers = [];
    this.playerName = 'YOU';
    this.playerSpec = playerSpec;

    const ids = VEHICLE_IDS;
    for (let i = 0; i < opponents; i++) {
      const vid = ids[(i + 1) % ids.length];
      const spec = getVehicle(vid).spec;
      const d = new AIDriver(i, track, spec, {
        wheelbase: getVehicle(vid).blueprint.dims.wheelbase,
        skill: 0.74 + (i / opponents) * 0.24,
        lineOffset: this.rng.range(-0.6, 0.6),
      });
      d.vehicleId = vid;
      this.drivers.push(d);
    }
  }

  /** Grid positions: staggered rows behind the start line. */
  grid(spawnU) {
    const rows = [];
    const n = this.drivers.length + 1;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2), col = i % 2 ? 0.42 : -0.42;
      rows.push({ u: spawnU - (row * 8 + 4) / this.track.length, lateral: col });
    }
    // player starts at the back — the reference always has you fighting forward
    const playerSlot = rows[rows.length - 1];
    this.drivers.forEach((d, i) => d.spawn(rows[i].u, rows[i].lateral));
    return playerSlot;
  }

  update(dt, playerBody) {
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.countdown = 0; this.state = 'racing'; }
      for (const d of this.drivers) d.body.step(dt, { throttle: 0, brake: 1, steer: 0 }, {});
      return;
    }
    if (this.state === 'finished') return;

    this.time += dt;
    this.lapTime += dt;

    const near = this.track.nearest(playerBody.pos, this.playerU);
    const prevU = this.playerU;
    this.playerU = ((near.u % 1) + 1) % 1;
    if (prevU > 0.85 && this.playerU < 0.15) {
      this.playerLap++;
      this.lapTimes.push(this.lapTime);
      this.lapTime = 0;
      if (this.playerLap >= this.laps) {
        this.state = 'finished';
        this.finishTime = this.time;
      }
    }
    this.playerProgress = this.playerLap + this.playerU;

    for (const d of this.drivers) {
      d.step(dt, { playerProgress: this.playerProgress, playerSpeed: playerBody.speed });
    }

    // positions
    const all = [
      { name: this.playerName, progress: this.playerProgress, you: true },
      ...this.drivers.map((d) => ({ name: d.name, progress: d.progress, you: false })),
    ].sort((a, b) => b.progress - a.progress);
    this.standings = all;
    this.playerPos = all.findIndex((x) => x.you) + 1;
  }

  get lateralOffTrack() { return this._off; }
}

export { NAMES };
