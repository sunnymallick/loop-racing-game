import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/rng.js';

/**
 * Arcade driving model. ART_DIRECTION.md §6.2: the four classes must be measurably distinct, a
 * drift must be *held* with counter-steer rather than spinning out, and weight transfer must be
 * visible. Realism is explicitly not the goal — controllability at 150 mph is.
 *
 * The core is a heading/velocity split: steering rotates the HEADING, and grip decides how fast
 * the VELOCITY vector realigns to it. High grip = the car goes where it points. Low rear grip =
 * the velocity lags behind the heading, which is a drift. Counter-steering reduces the heading
 * error and lets grip catch the slide instead of the car spinning.
 */

const UP = new THREE.Vector3(0, 1, 0);

export class VehicleBody {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.p = { ...spec.physics };
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawRate = 0;
    this.speed = 0;              // signed forward speed, m/s
    this.slip = 0;               // radians between heading and velocity
    this.drift = 0;              // 0..1 how committed the slide is
    this.grounded = true;
    this.airborne = 0;
    this.vy = 0;                 // vertical velocity for ramps/jumps
    this.y = 0;
    this.wheelSpin = 0;
    this.steerAngle = 0;
    this.rpm = spec.audio.idleRpm;
    this.gear = 1;
    this.gearShiftT = 0;
    this.boost = 0;              // 0..1 nitrous strength currently applied
    this.surface = 'road';       // 'road' | 'dirt' | 'kerb'
    this.lastImpact = 0;
    this.impactImpulse = 0;
    this.odo = 0;
    this.opts = opts;
    // visual pose, consumed by the renderer (body roll / pitch / squat)
    this.roll = 0; this.pitch = 0; this.heave = 0;
  }

  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  get right() { return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  get speedKmh() { return this.speed * 3.6; }
  get speedMph() { return this.speed * 2.23694; }

  reset(pos, yaw) {
    this.pos.copy(pos); this.yaw = yaw;
    this.vel.set(0, 0, 0); this.yawRate = 0; this.speed = 0;
    this.drift = 0; this.slip = 0; this.vy = 0; this.y = pos.y; this.boost = 0;
  }

  /**
   * @param input {throttle, brake, steer, handbrake}
   * @param env   {gravity, groundY, surfaceGrip, boost, boostThrust, topSpeedMul}
   */
  step(dt, input, env = {}) {
    const p = this.p;
    const fwd = this.forward, rgt = this.right;

    // ---- decompose velocity ----
    let vLong = this.vel.dot(fwd);
    let vLat = this.vel.dot(rgt);
    const sp = Math.hypot(vLong, vLat);
    this.speed = vLong;

    const surfaceGrip = env.surfaceGrip ?? 1.0;
    const boost = env.boost ?? 0;
    this.boost = boost;
    // Top speed lerps toward the class's nitrous multiplier as boost ramps in.
    const vMax = lerp(p.topSpeed, p.topSpeed * (env.topSpeedMul ?? 1.3), boost);

    // ---- engine ----
    // Torque falls off as a fraction of top speed so acceleration has a shape rather than a ramp.
    const sn = clamp(Math.abs(vLong) / vMax, 0, 1.4);
    const torqueCurve = 1.12 - 0.72 * sn * sn;
    let drive = input.throttle * p.power * Math.max(0.06, torqueCurve);
    drive += boost * (env.boostThrust ?? 0) ;
    if (input.brake > 0 && vLong > 0.4) drive -= input.brake * p.brake;
    else if (input.brake > 0) drive -= input.brake * p.brake * 0.35;   // reverse
    // Aero drag is deliberately light: top speed is set by the vMax clamp below, not by drag.
    // (Tuning drag to define top speed made every class top out around 45 mph.)
    const drag = 0.00085 * vLong * Math.abs(vLong);
    drive -= drag;
    if (input.throttle < 0.05 && input.brake < 0.05) drive -= Math.sign(vLong) * 2.6;

    vLong += (drive / (p.mass / 1400)) * dt;
    if (vLong > vMax) vLong = lerp(vLong, vMax, 1 - Math.exp(-3 * dt));
    if (vLong < -12) vLong = -12;

    // ---- steering ----
    // Steering authority falls with speed so the car isn't twitchy flat out, but never to zero.
    const speedF = 1 / (1 + Math.abs(vLong) * 0.030);
    const steerMax = p.steerMax * lerp(0.55, 1.0, speedF);
    this.steerAngle = lerp(this.steerAngle, input.steer * steerMax, 1 - Math.exp(-16 * dt));

    // ---- drift state ----
    const slipAngle = Math.atan2(vLat, Math.max(1.2, Math.abs(vLong)));
    this.slip = slipAngle;
    const speedForDrift = smoothstep(6, 18, Math.abs(vLong));

    // Enter a drift from: handbrake, or a big steering input carried at speed with throttle on.
    const provoke =
      (input.handbrake ? 1.0 : 0) +
      Math.abs(input.steer) * input.throttle * 0.55 * p.driftEase +
      Math.abs(slipAngle) * 0.9;
    const wantDrift = clamp(provoke * speedForDrift, 0, 1);

    // Counter-steering (steering INTO the slide) is what holds a drift and then recovers it.
    const counter = -Math.sign(slipAngle || 1) * input.steer;
    const counterAmt = clamp(counter, 0, 1);

    const decay = (0.9 + counterAmt * 1.5) * (1 / Math.max(0.4, p.driftHold));
    this.drift += (wantDrift - this.drift) * (1 - Math.exp(-(wantDrift > this.drift ? 5.2 : decay * 2.4) * dt));
    this.drift = clamp(this.drift, 0, 1);

    // ---- yaw ----
    // Grip steering yaw from the bicycle model, plus extra rotation while drifting.
    const wheelbase = this.opts.wheelbase ?? 2.8;
    const gripYaw = (vLong * Math.tan(this.steerAngle)) / wheelbase;
    const driftYaw = this.steerAngle * Math.abs(vLong) * 0.30 * this.drift * p.driftEase;
    const hbYaw = input.handbrake ? this.steerAngle * Math.abs(vLong) * 0.16 : 0;
    const targetYawRate = (gripYaw + driftYaw + hbYaw) * surfaceGrip;

    // Yaw inertia: heavy cars take longer to rotate and longer to stop rotating.
    const yawResponse = 9.0 / p.yawInertia;
    this.yawRate += (targetYawRate - this.yawRate) * (1 - Math.exp(-yawResponse * dt));

    // Spin protection — §6.2 caps an uncontrollable car at 45. Past ~55° of slip the rear grip
    // is forced back up, so the car snaps straight instead of pirouetting.
    const slipDeg = Math.abs(slipAngle) * 57.2958;
    const spinGuard = smoothstep(52, 78, slipDeg);
    this.yawRate *= 1 - spinGuard * 0.55 * dt * 12;

    this.yaw += this.yawRate * dt;

    // ---- lateral grip ----
    const rearGrip = lerp(p.gripRear, p.gripRear * 0.28, this.drift) * surfaceGrip;
    const frontGrip = p.gripFront * surfaceGrip * lerp(1, 1.15, counterAmt);
    const grip = (rearGrip * 0.62 + frontGrip * 0.38) + spinGuard * 1.6;
    const downforce = 1 + p.downforce * clamp(Math.abs(vLong) / p.topSpeed, 0, 1.2);
    const lateralDecay = 1 - Math.exp(-grip * downforce * 7.5 * dt);
    vLat -= vLat * lateralDecay;

    // Drifting scrubs speed — that's the trade the player is making.
    vLong -= Math.abs(vLat) * 0.16 * this.drift * dt * 6;

    // ---- integrate ----
    this.vel.copy(fwd).multiplyScalar(vLong).addScaledVector(rgt, vLat);
    this.pos.addScaledVector(this.vel, dt);
    this.odo += Math.abs(vLong) * dt;

    // ---- vertical (ramps, jumps) ----
    const groundY = env.groundY ?? 0;
    this.vy -= (env.gravity ?? 22) * dt;
    this.y += this.vy * dt;
    if (this.y <= groundY + 1e-3) {
      if (!this.grounded && this.vy < -6) this.impactImpulse = Math.min(1, -this.vy / 20);
      this.y = groundY; this.vy = 0; this.grounded = true; this.airborne = 0;
    } else {
      this.grounded = false; this.airborne += dt;
    }
    this.pos.y = this.y;

    // ---- drivetrain readout for audio/HUD ----
    const gearCount = 6;
    const norm = clamp(Math.abs(vLong) / p.topSpeed, 0, 1.1);
    const g = clamp(Math.floor(norm * gearCount) + 1, 1, gearCount);
    if (g !== this.gear) { this.gear = g; this.gearShiftT = 0.14; }
    this.gearShiftT = Math.max(0, this.gearShiftT - dt);
    const inGear = (norm * gearCount) % 1;
    const idle = this.spec.audio.idleRpm, red = this.spec.audio.redline;
    let targetRpm = idle + (red - idle) * clamp(inGear * 0.82 + 0.18 * norm + input.throttle * 0.10, 0, 1);
    if (this.drift > 0.3 || (input.throttle > 0.5 && Math.abs(vLong) < 3)) targetRpm = lerp(targetRpm, red * 0.92, 0.5);
    if (this.gearShiftT > 0) targetRpm *= 0.74;
    this.rpm = lerp(this.rpm, targetRpm, 1 - Math.exp(-9 * dt));
    this.wheelSpin += (vLong / 0.35) * dt;

    // ---- visual weight transfer (§6.2: 65 cap with no body roll) ----
    const latAccel = -this.yawRate * vLong;
    const longAccel = drive / (p.mass / 1400);
    const rollT = clamp(latAccel * 0.0075 / Math.max(0.25, p.rollStiff), -0.13, 0.13);
    const pitchT = clamp(-longAccel * 0.0026 / Math.max(0.25, p.rollStiff), -0.055, 0.055);
    this.roll += (rollT - this.roll) * (1 - Math.exp(-7 * dt));
    this.pitch += (pitchT - this.pitch) * (1 - Math.exp(-6 * dt));
    this.heave += ((this.grounded ? 0 : 0.03) - this.heave) * (1 - Math.exp(-8 * dt));

    return this;
  }

  /** Wall/car impact. `normal` points away from the surface. Returns the impact strength 0..1. */
  impact(normal, restitution = 0.35, friction = 0.55) {
    const vn = this.vel.dot(normal);
    if (vn >= 0) return 0;
    const strength = clamp(-vn / 26, 0, 1);
    this.vel.addScaledVector(normal, -vn * (1 + restitution));
    // scrub along the wall
    const tangent = new THREE.Vector3().crossVectors(UP, normal).normalize();
    const vt = this.vel.dot(tangent);
    this.vel.addScaledVector(tangent, -vt * friction * strength);
    // a glancing blow kicks the nose; a square hit mostly just stops you
    const side = Math.sign(new THREE.Vector3().crossVectors(this.forward, normal).y || 1);
    this.yawRate += side * strength * 1.5;
    this.drift = Math.min(1, this.drift + strength * 0.5);
    this.impactImpulse = Math.max(this.impactImpulse, strength);
    this.lastImpact = 0;
    return strength;
  }

  /** Launch off a ramp. */
  launch(vy) { this.vy = Math.max(this.vy, vy); this.grounded = false; }

  /** Telemetry row for the functional harness (§6.2 is judged on traces, not one still). */
  telemetry() {
    return {
      speed: +this.speed.toFixed(3),
      mph: +this.speedMph.toFixed(1),
      yaw: +this.yaw.toFixed(4),
      yawRate: +this.yawRate.toFixed(4),
      slipDeg: +(this.slip * 57.2958).toFixed(2),
      drift: +this.drift.toFixed(3),
      rpm: Math.round(this.rpm),
      gear: this.gear,
      roll: +this.roll.toFixed(4),
      pitch: +this.pitch.toFixed(4),
      boost: +this.boost.toFixed(3),
      grounded: this.grounded,
      x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2), y: +this.pos.y.toFixed(2),
    };
  }
}

/** Apply the physics pose to a car scene graph built by assemble.js. */
export function applyPose(car, body, dt) {
  car.position.copy(body.pos);
  car.rotation.set(0, body.yaw, 0);
  const bg = car.userData.body;
  if (bg) {
    bg.rotation.z = body.roll;
    bg.rotation.x = body.pitch;
    bg.position.y = body.heave;
  }
  const steer = body.steerAngle * 1.1 + body.drift * body.slip * -0.6;
  for (const w of car.userData.steerWheels) w.rotation.y = clamp(steer, -0.7, 0.7);
  for (const w of car.userData.wheels) {
    if (w.userData.spin) w.userData.spin.rotation.x = body.wheelSpin;
    w.position.y = w.userData.radius + body.heave * 0.3;
  }
  // brake lights
  const lit = body.brakeLit;
  for (const l of car.userData.lights.brake) {
    const lens = l.children[0];
    if (lens?.material) lens.material.emissiveIntensity = lit ? 6.5 : 2.4;
    const glow = l.getObjectByName('glow');
    if (glow) glow.material.opacity = lit ? 1.0 : 0.55;
  }
}
