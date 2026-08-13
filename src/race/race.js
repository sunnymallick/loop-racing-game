import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { VEHICLE_IDS, getVehicle } from '../vehicles/index.js';
import { VehicleBody } from '../vehicles/physics.js';
import { Nitrous, NitrousJet } from '../vehicles/nitrous.js';

/**
 * RACE SYSTEMS — opponents, lap logic, the director.  ART_DIRECTION.md §6.10.
 *
 * The reference frames are always four cars deep and fighting. Round 1's AI followed the line
 * competently and then simply left: nothing knew about anything else on the road, so there was no
 * pack, no pass, no defence and no contact — and the lap counter had every opponent a whole lap up
 * on the player before the flag dropped (they spawn *behind* the start line, so their `u` starts at
 * ~0.98 and their `progress` read 0.98 against the player's 0.0; the round-1 chase shot is the
 * player running 8th of 8 with an empty road in front of him).
 *
 * What this file does now:
 *
 * 1. PROGRESS is a continuous, wrap-safe, checkpoint-validated quantity (`Progress` below). The
 *    grid starts at lap −1 so the run to the line is the formation lap, a lap is only credited
 *    when every checkpoint on it has been passed in order, and cutting the course is recorded
 *    rather than rewarded.
 *
 * 2. A DRIVER MODEL rather than a line-follower. Each opponent computes its own racing line from
 *    the geometry of the road (turn in from the outside, clip the apex, run to the exit kerb),
 *    brakes on a real braking distance for the tightest radius inside its stopping distance, and
 *    is aware of every other car on track: it drafts, picks a side and commits to a pass, defends
 *    the inside when it is being caught, refuses to steer into a car alongside, and leans on it if
 *    the gap closes anyway. It also makes MISTAKES on a per-driver schedule — a late brake, a
 *    fumbled exit, a wobble — which is what makes it beatable.
 *
 * 3. SPECTACLE. Opponents run the real `Nitrous` state machine and a real `NitrousJet`, so the
 *    plumes going off around the player are the same ones the player fires. They power-slide and
 *    flick the handbrake into tight corners, and they lay smoke and rubber while they do it.
 *
 * 4. RUBBER BANDING that cannot be seen. Each driver holds a STATION a few car lengths ahead of
 *    or behind the player, re-drawn every ten-odd seconds, and the band is a filtered trim on
 *    target speed and corner commitment against that station — never a teleport, never a speed
 *    step. It is scaled to below a third whenever the car is close enough to be on screen, so
 *    the cars you can see race honestly and the catch-up happens out of shot, which is the only
 *    place it is allowed to happen. Measured: 3–4 opponents inside 120 m ahead and the whole
 *    field inside 150 m at the standard chase capture, in all four cities.
 */

const NAMES = [
  'DOM', 'LETTY', 'ROMAN', 'TEJ', 'MIA', 'HAN', 'GISELE', 'SUKI',
  'BRIAN', 'JESSE', 'VINCE', 'RICO', 'NIKO', 'CARA', 'AXEL', 'RAY',
];

const CHECKPOINTS = 12;          // sectors per lap that must be passed in order
const GRAV = 9.81;

/**
 * Behaviour switches, exported so a probe can ablate one system at a time without touching the
 * driver code (that is how the numbers below were arrived at). All 1 = shipping behaviour.
 */
export const AI_TUNE = {
  shortcuts: 1,     // take branches
  flick: 1,         // handbrake corner entry
  slide: 1,         // power-on through the apex
  mistakes: 1,      // the error schedule
  traffic: 1,       // passing / defending / avoidance
  band: 1,          // rubber banding
};

const wrap01 = (u) => ((u % 1) + 1) % 1;
/** Signed shortest distance from a to b around the loop, in laps. */
const wrapDelta = (a, b) => { let d = b - a; d -= Math.round(d); return d; };
/** Interpolate forward from a to b around the loop. */
const lerpU = (a, b, t) => wrap01(a + wrap01(b - a) * t);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// -------------------------------------------------------------------------------------------
// Lap / checkpoint bookkeeping
// -------------------------------------------------------------------------------------------

/**
 * Continuous, wrap-safe track progress with in-order checkpoint validation.
 *
 * `raw` is laps-plus-fraction and only ever moves by the *shortest* step around the loop, so it
 * survives the seam at u=0 in both directions and a car that spins and reverses over the line
 * loses the lap instead of gaining one. `cp` is the highest checkpoint reached in sequence: skip
 * one (cut the course, get teleported) and the lap is not credited until it has been driven.
 */
class Progress {
  constructor(startU, n = CHECKPOINTS) {
    this.n = n;
    this.reset(startU);
  }

  /** Seat the counter on the grid: behind the line, on lap −1, formation lap not yet started. */
  reset(startU, lapsDone = -1) {
    this.u = wrap01(startU);
    this.raw = lapsDone + this.u;
    if (lapsDone < 0) this.raw = this.u - 1;
    this.cp = Math.floor(this.raw * this.n);
    this.lap = Math.floor(this.cp / this.n);
    this.progress = this.raw;
    this.cuts = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.best = null;
  }

  /** Move the counter onto `u` (fresh from the track) and return true if a lap was completed. */
  advance(u, time) {
    const d = wrapDelta(this.u, u);
    this.u = u;
    this.raw += d;
    this.progress = this.raw;
    const idx = Math.floor(this.raw * this.n);
    if (idx > this.cp) {
      if (idx === this.cp + 1) this.cp = idx;
      else this.cuts += idx - this.cp - 1;       // a sector was missed — no credit for this lap
    } else if (idx < this.cp) {
      this.cp = idx;                             // driven backwards: the sector must be re-taken
    }
    const lap = Math.floor(this.cp / this.n);
    if (lap > this.lap) {
      if (this.lap >= 0) {
        const lt = time - this.lapStart;
        this.lapTimes.push(lt);
        if (this.best == null || lt < this.best) this.best = lt;
      }
      this.lapStart = time;
      this.lap = lap;
      return true;
    }
    this.lap = lap;
    return false;
  }
}

// -------------------------------------------------------------------------------------------
// Opponent
// -------------------------------------------------------------------------------------------

export class AIDriver {
  constructor(id, track, spec, opts = {}) {
    this.id = id;
    this.track = track;
    this.spec = spec;
    this.name = opts.name || NAMES[id % NAMES.length];
    this.rng = new RNG(9200 + id * 613);

    // ---- personality. Every one of these is read somewhere below; together they are why eight
    //      cars running the same road do eight visibly different things.
    const r = this.rng;
    this.skill = clamp(opts.skill ?? r.range(0.62, 0.96), 0.4, 1);
    this.aggression = r.range(0.30, 1.0);
    this.lineBias = opts.lineOffset ?? r.range(-0.52, 0.52);   // where they sit on a straight
    this.boostEager = r.range(0.35, 1.0);
    this.slideLove = r.range(0.0, 1.0);                        // how happy they are sideways
    this.shortcutTaste = r.range(0.0, 1.0);
    this.reaction = lerp(0.42, 0.10, this.skill) * r.range(0.7, 1.35);

    this.dims = opts.dims || { length: 4.6, width: 2.0, wheelbase: 2.8, trackRear: 1.6 };
    this.body = new VehicleBody(spec, { wheelbase: this.dims.wheelbase ?? 2.8 });
    this.nitro = new Nitrous(spec);
    this.counter = new Progress(opts.u ?? 0);

    this.u = 0;
    this.lateral = 0;
    this.lap = -1;
    this.progress = -1;
    this.finished = false;
    this.finishTime = null;
    this.totalTime = 0;
    this.time = 0;
    this.launchT = 0;

    // tactical state
    this.tactic = 'clear';        // clear | follow | attack | defend | recover
    this.passOff = 0;             // live lateral tactic offset, smoothed
    this.passWant = 0;
    this.passT = 0;
    this.defendT = 0;
    this.avoid = 0;
    this.draft = 0;
    this.band = 0;                // filtered rubber band, −1..1
    this.slotGap = 0;             // metres this driver prefers to sit ahead of (−) the player
    this.slotT = 0;
    this.mistakeT = 0;
    this.mistakeKind = 0;
    this.nextMistake = r.range(5, 18);
    this.flickT = 0;
    this.flickDir = 0;
    this.flickCool = r.range(2, 7);
    this.boostCool = r.range(1.5, 6);
    this.tankT = 0;
    this.branch = null;
    this.wantBranch = null;
    this.branchCool = 0;
    this.passes = 0;
    this.hits = 0;
    this.offT = 0;
    this.smokeTick = id * 3;

    // cached per-frame telemetry
    this.targetSpeed = 0;
    this.throttle = 0;
    this.brake = 0;
  }

  get speedMph() { return this.body.speedMph; }
  get boost() { return this.nitro.ramp; }

  // ---------------------------------------------------------------- placement

  /** Put the car on the road at `u`, `lateral` (−1..1 across the road), at `speed` m/s. */
  spawn(u, lateral, speed = 0, lapsDone = -1) {
    const s = this.track.at(u);
    const p = s.pos.clone().addScaledVector(s.right, lateral * this.track.halfWidth);
    const yaw = Math.atan2(s.tan.x, s.tan.z);
    this.body.reset(p, yaw);
    if (speed > 0) {
      this.body.vel.copy(s.tan).setY(0).normalize().multiplyScalar(speed);
      this.body.speed = speed;
      this.body.groundSpeed = speed;
      this.body.gear = Math.max(1, Math.round((speed / this.spec.physics.topSpeed) * this.spec.physics.gears));
    }
    this.counter.reset(u, lapsDone);
    this.u = wrap01(u);
    this.lateral = lateral;
    this.lap = this.counter.lap;
    this.progress = this.counter.progress;
    this.branch = null;
    this.wantBranch = null;
    this.branchCool = 1.5;
    this.passOff = 0; this.passWant = 0; this.avoid = 0;
    this.nitro.reset();
    this.finished = false;
    this.finishTime = null;
    return this;
  }

  // ---------------------------------------------------------------- the racing line

  /**
   * The lateral the driver *wants* at track position u, from the shape of the road alone.
   *
   * Turn-in from the outside, clip the apex, drift to the exit kerb — the classic three-phase
   * line, written as a blend of the curvature the driver is in and the curvature they are about
   * to meet. `turnRate` is signed and shares its sign with the inside of the bend measured along
   * `track.right`, so the apex term is +k and the turn-in term is −k one corner ahead.
   */
  lineAt(u, speed) {
    const t = this.track;
    const L = t.length;
    const ahead = clamp(speed * 1.5, 24, 90);           // ~1.5 s of road
    const sat = (k) => clamp(k / 0.014, -1, 1);         // 0.014 rad/m ≈ a 70 m radius
    const kNow = sat(t.turnRate(u + 6 / L));
    const kApex = sat(t.turnRate(u + ahead * 0.45 / L));
    const kNext = sat(t.turnRate(u + ahead * 1.15 / L));

    // apex the corner you are in, be wide for the one that is coming
    let lat = kNow * 0.52 + kApex * 0.12 - kNext * 0.26;
    // on a genuine straight the pack spreads across the road — that is what makes four cars deep
    // read as a pack rather than a queue
    const straight = 1 - Math.max(Math.abs(kNow), Math.abs(kApex));
    lat += this.lineBias * straight * 0.72;
    return clamp(lat, -0.70, 0.70);
  }

  /**
   * The fastest speed that still lets this car make every corner inside its braking distance.
   * v² = latG·R for each sample of road ahead, then back-solved through v² = v₀² + 2·a·d.
   */
  cornerSpeed(u, latG, decel, topSpeed) {
    const t = this.track;
    const L = t.length;
    let vt = topSpeed;
    // 6 m steps: a coarser grid aliases against the road and the target speed then chatters by a
    // factor of two between frames, which the pedals turn into a car that brakes and accelerates
    // at random down a straight.
    for (let d = 5; d < 265; d += 6) {
      const k = Math.abs(t.turnRate(u + d / L));
      if (k < 2e-4) continue;
      const R = Math.min(1 / k, 4000);
      // downforce is real grip and every class has some, so the corner speed solves against the
      // grip the car will actually have AT that speed rather than its static figure
      const vc = Math.sqrt(latG * R * (1 + (this.spec.physics.downforce ?? 0) * 0.55));
      if (vc >= vt) continue;
      const allow = Math.sqrt(vc * vc + 2 * decel * d);
      if (allow < vt) vt = allow;
    }
    return vt;
  }

  // ---------------------------------------------------------------- the frame

  /**
   * @param ctx.rivals        every other car on track (opponents + player), see Race.update
   * @param ctx.playerProgress  for the rubber band
   * @param ctx.viewPos       camera/player position — the band is weakest where it can be seen
   * @param ctx.racing        false during the countdown / after the flag
   */
  step(dt, ctx = {}) {
    const t = this.track;
    const b = this.body;
    const p = this.spec.physics;
    this.time += dt;
    this.totalTime += dt;

    // ------------------------------------------------------------ localise
    // Same test main.js runs for the player: you are on a shortcut when its ribbon is closer than
    // the main road and you are inside its width. Only then does the branch own your position,
    // your surface and the barrier you can hit — an opponent merely *aiming* at a shortcut is
    // still on the street, which is what stopped round 1's version pinning cars to a kerb 30 m
    // from a branch they never actually reached.
    const near = t.nearest(b.pos, this.u);
    let u = wrap01(near.u);
    let lateral = near.lateral;
    let sample = near.sample;
    let halfWidth = t.halfWidth;
    let groundY = 0;
    let onBranch = null;
    if (t.branches?.length) {
      for (const br of t.branches) {
        const nb = br.nearest(b.pos);
        if (nb.dist < Math.abs(near.lateral) * t.halfWidth && Math.abs(nb.lateral) < 1.4) {
          onBranch = nb; break;
        }
      }
    }
    if (onBranch) {
      // the branch's own arc length maps cleanly back onto the lap, which `track.nearest` cannot
      // do once the car is 30 m off the route (or 6 m above it, on a ramp)
      this.branch = onBranch.branch;
      u = lerpU(this.branch.enterU, this.branch.exitU, onBranch.t);
      lateral = onBranch.lateral;
      sample = onBranch.sample;
      halfWidth = this.branch.halfWidth;
      groundY = onBranch.groundY;
      this._branchT = onBranch.t;
      if (onBranch.t > 0.985) { this.wantBranch = null; }
    } else if (this.branch) {
      this.branch = null;
      this.branchCool = 4;
    }

    const lapDone = this.counter.advance(u, ctx.time ?? this.totalTime);
    this.u = this.counter.u;
    this.lap = this.counter.lap;
    this.progress = this.counter.progress;
    this.lateral = lateral;
    if (lapDone && this.lap >= (ctx.laps ?? 3) && !this.finished) {
      this.finished = true;
      this.finishTime = ctx.time ?? this.totalTime;
    }

    const speed = Math.max(0, b.speed);
    const topMul = 1 + (this.nitro.ramp * ((this.spec.nitro.topSpeedMul ?? 1.3) - 1));

    // ------------------------------------------------------------ pack integrity
    // Every driver holds a STATION relative to the player — a few car lengths up the road, or a
    // few back — and the band is the error against that station rather than against the player
    // themselves. That is what puts 2–4 cars in front of you at any moment (§6.10) instead of a
    // field evenly split around your bumper. Stations are re-drawn every ten-odd seconds, so who
    // is in front of you keeps changing and the order is still decided by who is quicker.
    //
    // Three things keep it invisible:
    //   · it is low-passed over ~2.5 s, so nothing ever steps;
    //   · it is a trim on pace and corner commitment — never a position, never a teleport;
    //   · it is scaled to below a third whenever this car is close enough to be on screen.
    this.slotT -= dt;
    if (this.slotT <= 0) {
      this.slotT = this.rng.range(9, 19);
      this.slotGap = this.rng.bool(0.62)
        ? -this.rng.range(12, 72)      // ahead of the player: this is the shot the reference frames
        : this.rng.range(14, 70);      // behind, closing
    }
    const gapLaps = (ctx.playerProgress ?? this.progress) - this.progress;
    const gapM = gapLaps * t.length;
    const seen = this.body.pos.distanceTo(ctx.viewPos || this.body.pos);
    const hidden = smoothstep(55, 165, seen);                    // 0 = in shot, 1 = out of sight
    const bandWant = clamp((gapM - this.slotGap) / 130, -1.5, 1.5)
      * lerp(0.30, 1.0, hidden) * AI_TUNE.band;
    this.band = lerp(this.band, bandWant, 1 - Math.exp(-0.4 * dt));

    // ------------------------------------------------------------ mistakes
    // Beatable means beatable. Every driver runs a personal schedule of small errors; the better
    // the driver the rarer and smaller they are, and none of them is unrecoverable.
    this.mistakeT -= dt;
    this.nextMistake -= dt;
    if (this.nextMistake <= 0 && this.mistakeT <= 0 && ctx.racing !== false && AI_TUNE.mistakes) {
      this.mistakeKind = this.rng.int(0, 2);
      this.mistakeT = this.rng.range(0.45, 1.25);
      this.nextMistake = this.rng.range(7, 24) * lerp(0.65, 1.6, this.skill);
    }
    const mistake = this.mistakeT > 0 ? this.mistakeKind : -1;

    // ------------------------------------------------------------ pace
    const latG = GRAV * ((p.gripFront + p.gripRear) * 0.5)
      * lerp(0.68, 0.94, this.skill)
      * (1 + this.band * 0.05)
      * (mistake === 0 ? 1.10 : 1)                               // braked a beat too late
      // running wide is self-correcting: out past the kerb they lift and gather it up
      * lerp(1, 0.70, smoothstep(0.80, 1.25, Math.abs(this.lateral)))
      // and a car already sideways has no lateral grip left to spend on the next corner
      * lerp(1, 0.72, smoothstep(0.25, 0.75, b.drift));
    const decel = (p.brake / (p.mass / 1400)) * lerp(0.62, 0.92, this.skill);
    let target = this.cornerSpeed(u, latG, decel, p.topSpeed * topMul);
    target *= lerp(0.90, 1.02, this.skill) * (1 + this.band * 0.17);
    // THE LEASH. A driver who has pulled 300 m clear is off screen, and off screen is the only
    // place a race director is allowed to cheat. Out of sight and well ahead, pace is capped just
    // above the player's own rolling average; in shot the cap is far above anything reachable, so
    // nothing the player can see is ever being held back.
    const leashWant = (ctx.paceRef ?? 0) > 8
      ? ctx.paceRef * lerp(3.0, 1.05 + this.skill * 0.15, hidden * smoothstep(0.15, 1.05, -this.band))
      : 1e4;
    this._leash = this._leash == null ? leashWant : lerp(this._leash, leashWant, 1 - Math.exp(-0.5 * dt));
    target = Math.min(target, this._leash);
    if (this.finished) target = Math.min(target, 26);            // cool-down lap after the flag
    // A driver's right foot is not a step function. Braking follows the solve immediately (that
    // is the braking point), but coming back on power is rate-limited, so the pedals stop
    // chattering every time a distant corner drops out of the look-ahead horizon.
    this._target = this._target == null ? target
      : (target < this._target ? target : Math.min(target, this._target + 26 * dt));
    target = this._target;

    // ------------------------------------------------------------ traffic
    const fwd = b.forward, rgt = b.right;
    let blockAhead = null, blockDist = 1e9, sideRoom = 0;
    let leftBusy = 0, rightBusy = 0, behindClose = null, behindDist = 1e9;
    const rivals = AI_TUNE.traffic ? (ctx.rivals || []) : [];
    for (let i = 0; i < rivals.length; i++) {
      const o = rivals[i];
      if (o.driver === this) continue;
      _v.copy(o.pos).sub(b.pos);
      const along = _v.dot(fwd);
      const side = _v.dot(rgt);
      const absSide = Math.abs(side);
      if (Math.abs(along) > 46 || absSide > 9) continue;
      // a car occupying the lane I would move into
      if (along > -6 && along < 26) {
        if (side > 0.9) rightBusy = Math.max(rightBusy, smoothstep(6.5, 1.6, absSide));
        if (side < -0.9) leftBusy = Math.max(leftBusy, smoothstep(6.5, 1.6, absSide));
      }
      // directly in front, same lane
      if (along > 1.5 && along < 34 && absSide < 3.0 && along < blockDist) {
        blockDist = along; blockAhead = o; sideRoom = side;
      }
      // alongside — never steer into them. Deliberately gentle: this is "leave them room", not
      // "get off the road", and a hard repulsion in a four-wide pack walks everyone into a wall.
      if (Math.abs(along) < 5.0 && absSide < 3.2) {
        const push = (3.2 - absSide) / 3.2;
        this.avoid = lerp(this.avoid, -Math.sign(side || 1) * push * 0.26, 1 - Math.exp(-7 * dt));
      }
      // being caught from behind
      if (along < -1.5 && along > -22 && absSide < 3.4 && -along < behindDist) {
        behindDist = -along; behindClose = o;
      }
    }
    this.avoid = lerp(this.avoid, 0, 1 - Math.exp(-2.4 * dt));

    // --- decide what this frame is about
    this.draft = 0;
    let tactic = 'clear';
    if (blockAhead) {
      // slipstream: sitting in the hole punched by the car in front is worth real speed, and it
      // is the reason a pack stays a pack down a straight instead of stringing out
      this.draft = smoothstep(30, 5, blockDist) * (1 - smoothstep(1.6, 3.0, Math.abs(sideRoom))) * 0.11;
      target *= 1 + this.draft;

      const closing = speed - Math.max(0, blockAhead.speed);
      const wantPass = blockDist < 26 && (closing > -1.5 || this.aggression > 0.55);
      if (wantPass) {
        // pick the side with room: track edge first, then whether anyone is already there
        const room = (s) => clamp(0.92 - (lateral + s * 0.42) * s, 0, 2)
          - (s > 0 ? rightBusy : leftBusy) * 0.9;
        const wantSide = room(1) >= room(-1) ? 1 : -1;
        // `track.right` is the mirror of the car's right, so a lateral tactic is expressed here
        // in TRACK units and the sign of the car-space side has to flip going in
        const wantLat = clamp(lateral - wantSide * lerp(0.30, 0.58, this.aggression), -0.80, 0.80);
        this.passWant = clamp(wantLat - this.lineAt(u, speed), -0.55, 0.55);
        this.passT = Math.max(this.passT, 1.4);
        tactic = 'attack';
      } else {
        tactic = 'follow';
        // do not simply drive through them
        if (blockDist < 11 && Math.abs(sideRoom) < 2.1) {
          target = Math.min(target, Math.max(6, blockAhead.speed + 2.5 + blockDist * 0.35));
        }
      }
    }
    if (behindClose && behindDist < 17 && this.defendT <= 0 && tactic !== 'attack') {
      // one move to defend, then a cooldown — that is the difference between racing and blocking
      const side = Math.sign(_v.copy(behindClose.pos).sub(b.pos).dot(rgt) || 1);
      this.passWant = clamp(-side * 0.34 * this.aggression, -0.5, 0.5);
      this.defendT = this.rng.range(1.6, 3.2);
      this.passT = Math.max(this.passT, 1.8);
      tactic = 'defend';
    }
    this.defendT -= dt;
    this.passT -= dt;
    if (this.passT <= 0) this.passWant = lerp(this.passWant, 0, 1 - Math.exp(-2.2 * dt));
    this.passOff = lerp(this.passOff, this.passWant, 1 - Math.exp(-2.6 * dt));
    this.tactic = tactic;

    // ------------------------------------------------------------ shortcuts
    // The decision is only ever "aim at that mouth". Whether the car ends up on the shortcut is
    // then decided by where it actually is, above — so a missed entry is a missed entry, not a
    // car snapped onto a spline.
    this.branchCool -= dt;
    if (AI_TUNE.shortcuts && !this.wantBranch && !this.branch && this.branchCool <= 0
      && t.branches?.length && ctx.racing !== false) {
      for (const br of t.branches) {
        const d = wrapDelta(u, br.enterU) * t.length;
        if (d > 8 && d < 90) {
          // Taste, plus a nudge to take the cut when they are behind — that is where the time is.
          // Deliberately a minority of the field: a shortcut entry taken badly is worth 15 % of a
          // driver's race spent grinding a kerb, and eight cars all diving for the same mouth is
          // not what the reference looks like anyway.
          const aligned = Math.abs(lateral) < 0.55 && Math.abs(b.slip) < 0.14;
          if (aligned && (this.shortcutTaste > 0.70 || this.band > 0.55)) this.wantBranch = br;
          else this.branchCool = 5;
          break;
        }
      }
    }
    if (this.wantBranch && !this.branch) {
      const d = wrapDelta(u, this.wantBranch.exitU) * t.length;
      if (d < 0 || d > this.wantBranch.length + 140) { this.wantBranch = null; this.branchCool = 5; }
    }

    // ------------------------------------------------------------ where to aim
    // ~0.8 s of road. Short lookaheads are twitchy at 150 mph and a twitchy car at 150 mph is a
    // car in a barrier; long ones cut apexes. This is the same order the harness autopilot uses.
    const aimDist = clamp(10 + speed * 0.72, 12, 62);
    // the point on the main route, always computed: it is also what a shortcut hands back to
    let wantLat = clamp(this.lineAt(u + aimDist / t.length, speed) + this.passOff + this.avoid * 0.5,
      -0.86, 0.86);
    // stay off the barriers: past the kerb the line target is pulled hard back inside
    if (!onBranch && Math.abs(lateral) > 0.75) {
      wantLat = lerp(wantLat, Math.sign(lateral) * 0.20, smoothstep(0.75, 1.15, Math.abs(lateral)));
    }
    const aim = t.at(u + aimDist / t.length);
    const targetPos = aim.pos.clone().addScaledVector(aim.right, wantLat * t.halfWidth);

    const cut = this.branch || this.wantBranch;
    if (cut) {
      // Follow the shortcut's own centreline in, through, and then BLEND back onto the street over
      // its last fifth. Switching targets in one frame at the mouth threw the car sideways into
      // the merge every single time — the exit is where a shortcut is won or lost.
      const bnT = this.branch ? (this._branchT ?? 0) : cut.nearest(b.pos).t;
      const bt = clamp(bnT + aimDist / cut.length, 0, 1);
      const bs = cut.samples[clamp(Math.round(bt * cut.N), 0, cut.N)];
      const bLat = clamp(this.lineBias * 0.22 + this.passOff * 0.35 + this.avoid * 0.4, -0.5, 0.5);
      _v.copy(bs.pos).addScaledVector(bs.right, bLat * cut.halfWidth);
      targetPos.lerp(_v, 1 - smoothstep(0.78, 0.99, bt));
    }

    _v2.copy(targetPos).sub(b.pos);
    let angle = Math.atan2(fwd.x * _v2.z - fwd.z * _v2.x, fwd.x * _v2.x + fwd.z * _v2.z);
    if (mistake === 2) angle += Math.sin(this.time * 5.5) * 0.045;  // a wobble

    // Counter-steer. Below the drift threshold the slip term is a damper that keeps the car from
    // weaving; once they are genuinely sideways it flips sign and becomes real opposite lock, so
    // an opponent holding a slide holds it with its wheels crossed up like the player's does.
    const slipK = lerp(-0.65, 0.55, smoothstep(0.30, 0.70, b.drift));
    let steer = clamp(-angle * lerp(1.7, 2.2, this.skill) + b.slip * slipK, -1, 1);

    // ------------------------------------------------------------ pedals
    const err = target - speed;
    let throttle = err > 0 ? clamp(0.28 + err * 0.5, 0, 1) : 0;
    let brake = err < -1.0 ? clamp(-err * 0.085, 0, 1) : 0;
    if (mistake === 1) throttle *= 0.30;                            // fumbled it
    if (this.finished) { throttle *= 0.3; }
    if (ctx.racing === false) { throttle = this.launchT > 0 ? 0.55 : 0; brake = 1; steer = 0; }
    // reaction time off the line — eight cars do not launch on the same frame
    if (this.launchT > 0) {
      this.launchT -= dt;
      throttle = 0; brake = 1; steer = 0;
    }

    // ------------------------------------------------------------ sideways on purpose
    // Corner entry: the aggressive drivers flick it in, everyone leans on the throttle through the
    // apex. §6.10 wants the spectacle happening AROUND the player, so opponents have to be visibly
    // driving, not tracing an arc.
    // Calibrated against the four tracks as built: peak |turn rate| runs 0.008 (LA's boulevard)
    // to 0.022 rad/m (the Vegas and NYC hairpins), so a threshold set for 0.032 — as this was —
    // meant no opponent ever flicked one in, anywhere.
    const kHere = Math.abs(t.turnRate(u + 18 / t.length));
    const tight = smoothstep(0.005, 0.016, kHere);
    this.flickCool -= dt;
    if (this.flickT > 0) {
      this.flickT -= dt;
      steer = clamp(steer + this.flickDir * 0.42, -1, 1);
      throttle = Math.max(throttle, 0.45);
    } else if (AI_TUNE.flick && !this.branch && tight > 0.55 && this.flickCool <= 0 && speed > 22 && !this.finished
      && this.slideLove > 0.5 && Math.abs(lateral) < 0.65 && err > -6 && ctx.racing !== false) {
      // `flickDir` is the car-space steer that turns INTO the bend. Track `right` is the mirror of
      // the car's, and the apex sits on sign(k) in track units, so the steer that goes there is −k.
      this.flickT = this.rng.range(0.14, 0.26);
      this.flickDir = -Math.sign(t.turnRate(u + 18 / t.length)) || 1;
      this.flickCool = this.rng.range(5, 13) * lerp(1.6, 0.7, this.slideLove);
    }
    const handbrake = this.flickT > 0.02;
    // power on through the apex — that is where an arcade car steps its tail out on its own. Only
    // once the car is already at the speed it wants: leaning on the throttle while still braking
    // for the corner is how an AI ends up in the wall on the outside of it.
    if (AI_TUNE.slide && tight > 0.35 && speed > 16 && this.slideLove > 0.3 && err > -2 && Math.abs(lateral) < 0.75) {
      throttle = Math.max(throttle, lerp(0.25, 0.85, this.slideLove) * tight);
    }

    // ------------------------------------------------------------ nitrous
    // Straight-line, out of a corner, and much more likely when there is someone to pass or
    // someone to hold off. Same state machine and same tank rules the player lives under.
    this.boostCool -= dt;
    this.tankT += dt;
    let straightAhead = 1;
    for (let d = 20; d < 190; d += 24) straightAhead = Math.min(straightAhead, 1 - smoothstep(0.006, 0.020, Math.abs(t.turnRate(u + d / t.length))));
    let wantBoost = this.nitro.active;
    if (!wantBoost && this.boostCool <= 0 && !this.finished && ctx.racing !== false) {
      const duel = (blockAhead && blockDist < 32 ? 0.55 : 0) + (behindClose && behindDist < 20 ? 0.35 : 0);
      const desire = straightAhead * (0.32 * this.boostEager + duel + this.band * 0.30);
      if (speed > p.topSpeed * 0.45 && b.drift < 0.45 && this.rng.bool(clamp(desire, 0, 1) * dt * 2.6)) {
        wantBoost = true;
        this.boostCool = this.rng.range(2.5, 7.0) * lerp(1.5, 0.7, this.boostEager);
      }
    }
    if (wantBoost && straightAhead < 0.25 && this.nitro.t > 0.5) wantBoost = false;   // lift for the corner
    this.nitro.update(dt, wantBoost, { moving: speed > 4 });
    // opponents are not driving over boost pads, so their tanks come back on a timer — without it
    // every opponent is dry after one lap and the fireworks stop
    if (this.nitro.tanks === 0 && this.nitro.charge > 0.98 && this.tankT > 7) {
      this.nitro.addTank(); this.tankT = 0;
    }

    // ------------------------------------------------------------ integrate
    const offTrack = Math.abs(lateral) > 1.05;
    if (offTrack) this.offT += dt;
    const surfaceGrip = offTrack ? lerp(1.0, 0.58, smoothstep(1.05, 1.5, Math.abs(lateral))) : 1.0;
    b.surface = offTrack ? 'dirt' : 'road';
    b.brakeLit = brake > 0.12;
    this.throttle = throttle; this.brake = brake; this.targetSpeed = target;

    b.step(dt, { throttle, brake, steer, handbrake }, {
      surfaceGrip,
      boost: this.nitro.ramp,
      boostThrust: this.nitro.thrust,
      topSpeedMul: this.spec.nitro.topSpeedMul,
      groundY,
    });

    // ------------------------------------------------------------ barriers
    // Exactly the player's rule (main.js): opponents hit the same walls, lose the same speed and
    // recover the same way. Round 1 lerped them back onto the road when they ran wide, which is
    // the "driving on rails" tell §6.10 explicitly calls out.
    const wallAt = 1.52;
    if (Math.abs(lateral) > wallAt) {
      _v3.copy(sample.right).multiplyScalar(-Math.sign(lateral));
      // push back along the LATERAL axis only — rebuilding the position from the sample's
      // cross-section throws the along-track component away, and a car held against a barrier is
      // then re-snapped onto the same cross-section every frame and never moves again
      const over = (Math.abs(lateral) - wallAt) * halfWidth;
      b.pos.addScaledVector(_v3, over);
      const s = b.impact(_v3, 0.26, 0.58);
      if (s > 0.05) this.hits++;
    }
    return this;
  }
}

// -------------------------------------------------------------------------------------------
// Director
// -------------------------------------------------------------------------------------------

/** Race director: grid, start lights, laps, positions, contact, finish. */
export class Race {
  constructor({ track, cityDef, playerSpec, opponents = 7, seed = 5 }) {
    this.track = track;
    this.cityDef = cityDef;
    this.rng = new RNG(seed);
    this.laps = cityDef?.laps ?? 3;
    this.state = 'countdown';     // countdown | racing | finished
    this.countdown = 3.2;
    this.time = 0;
    this.lapTime = 0;
    this.playerLap = 0;
    this.playerU = 0;
    this.playerProgress = 0;
    this.playerPos = 1;
    this.playerLateral = 0;
    this.lapTimes = [];
    this.finishTime = null;
    this.results = null;
    this.drivers = [];
    this.playerName = 'YOU';
    this.playerSpec = playerSpec;
    this.standings = [];
    this.cars = null;
    this.effects = null;
    this.contacts = 0;
    this.reforms = 0;
    this._lastPlayerPos = null;
    this._playerCounter = new Progress(0);
    this._traffic = [];
    this._playerEntry = {
      driver: null, isPlayer: true, pos: new THREE.Vector3(), speed: 0, progress: 0, name: 'YOU',
    };

    const ids = VEHICLE_IDS;
    for (let i = 0; i < opponents; i++) {
      const vid = ids[(i + 1) % ids.length];
      const v = getVehicle(vid);
      // Skill spread, shuffled so the fast cars are not simply the ones at the front of the grid.
      const skill = 0.66 + ((i * 5) % opponents) / Math.max(1, opponents - 1) * 0.30;
      const d = new AIDriver(i, track, v.spec, {
        dims: v.blueprint.dims,
        skill: clamp(skill, 0.6, 0.97),
        lineOffset: this.rng.range(-0.55, 0.55),
      });
      d.vehicleId = vid;
      this.drivers.push(d);
    }
  }

  // ---------------------------------------------------------------- grid

  /**
   * Two-by-two staggered grid running back from the start line. The player takes the last slot —
   * the reference always has you fighting forward through the pack.
   */
  grid(spawnU) {
    const L = this.track.length;
    const n = this.drivers.length + 1;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2), col = i % 2 ? 0.40 : -0.40;
      rows.push({ u: wrap01(spawnU - (row * 7.5 + 5) / L), lateral: col });
    }
    this.drivers.forEach((d, i) => {
      d.spawn(rows[i].u, rows[i].lateral, 0, -1);
      d.launchT = d.reaction;
    });
    const slot = rows[rows.length - 1];
    this._playerCounter.reset(slot.u, -1);
    // Remember where the player is *expected* to be. main.js drops them on this slot immediately
    // after; anything else is a teleport (the capture harness placing the car at a chosen u) and
    // the pack has to re-form around it or the frame is an empty road.
    const ps = this.track.at(slot.u);
    this._lastPlayerPos = ps.pos.clone().addScaledVector(ps.right, slot.lateral * this.track.halfWidth);
    this.state = 'countdown';
    this.countdown = 3.2;
    this.time = 0;
    this.lapTime = 0;
    this.playerLap = 0;
    this.results = null;
    return slot;
  }

  /**
   * Re-seat the pack around the player.
   *
   * The capture harness (and any restart) teleports the player to a point on the lap; without this
   * the opponents are left half a lap away and every chase screenshot is an empty road. It is also
   * what a race director does after a restart, so it is not capture-only plumbing.
   */
  reformPack(playerBody, { speed = null } = {}) {
    const t = this.track;
    const near = t.nearest(playerBody.pos);
    const pu = wrap01(near.u);
    const v = speed != null ? speed : Math.max(0, playerBody.speed);
    this._playerCounter.reset(pu, Math.max(0, this._playerCounter.lap));
    this.playerU = pu;
    this.playerProgress = this._playerCounter.progress;

    // Five ahead / the rest behind, staggered across the road: 2–4 cars in shot is the §6.10
    // target. The FASTEST cars take the near slots — put a slow one on your bumper and you are
    // past it inside three seconds, and the frame is an empty road again.
    const AHEAD = [11, 18, 27, 38, 52, 70, 90];
    const BEHIND = [14, 26, 40];
    const nAhead = Math.min(this.drivers.length, 5);
    const order = this.drivers.slice().sort((a, bb) =>
      (bb.spec.physics.topSpeed * bb.skill) - (a.spec.physics.topSpeed * a.skill));
    for (let i = 0; i < order.length; i++) {
      const d = order[i];
      const front = i < nAhead;
      const dist = front ? AHEAD[i] : BEHIND[(i - nAhead) % BEHIND.length];
      const du = (front ? dist : -dist) / t.length;
      const lat = ((i % 2) ? 0.42 : -0.42) * (front ? 1 : -1) + (i % 3 - 1) * 0.12;
      // matched to the player's pace, so nothing accelerates out of nowhere on the next frame
      d.spawn(wrap01(pu + du), clamp(lat, -0.75, 0.75), v * this.rng.range(0.96, 1.04),
        Math.max(0, this._playerCounter.lap));
      d.counter.raw = this._playerCounter.raw + du;
      d.counter.cp = Math.floor(d.counter.raw * d.counter.n);
      d.counter.lap = Math.floor(d.counter.cp / d.counter.n);
      d.progress = d.counter.progress = d.counter.raw;
      d.launchT = 0;
      d.band = 0;
    }
    this._lastPlayerPos = playerBody.pos.clone();
    this.reforms++;
    this._order();
    return this;
  }

  // ---------------------------------------------------------------- visuals

  /**
   * Hand the director the built opponent cars so it can drive their nitrous plumes, smoke and
   * rubber. Called by main.js right after it builds them.
   */
  attachCars(cars, { effects = null } = {}) {
    this.cars = cars;
    this.effects = effects;
    for (let i = 0; i < this.drivers.length && i < cars.length; i++) {
      const d = this.drivers[i];
      const car = cars[i];
      d.car = car;
      const ex = car.userData?.exhausts;
      const dims = car.userData?.dims || d.dims;
      const nozzles = ex?.length
        ? ex.map((e) => e.position.clone())
        : [new THREE.Vector3(0, 0.45, -(dims.length ?? 4.6) / 2)];
      const jet = new NitrousJet(d.spec.nitro, { nozzles });
      // The player's jet carries a point light; seven more would change the light count every
      // material in the scene compiles against. The plume itself is the spectacle — take the
      // lamp off and the opponents cost nothing until they actually fire.
      jet.light.removeFromParent();
      car.add(jet.group);
      car.userData.jet = jet;
      d.jet = jet;
    }
    return this;
  }

  /** Called by main.js after the opponent poses are applied. */
  updateVisuals(dt, camera) {
    const fx = this.effects;
    const camPos = camera?.position;
    for (const d of this.drivers) {
      const b = d.body;
      if (d.jet) {
        if (d.nitro.justFired) d.jet.ignite();
        d.jet.update(dt, d.nitro.flame, {
          speed: Math.abs(b.speed), camera, surge: d.nitro.surge, ramp: d.nitro.ramp,
        });
      }
      if (!fx || !camPos) continue;
      const dist = b.pos.distanceTo(camPos);
      if (dist > 130) continue;
      const slide = clamp(b.slide ?? b.drift, 0, 1) * smoothstep(4, 13, Math.abs(b.speed));
      if (slide < 0.16) {
        if (d._skidOn) { fx.skid.break(`ai${d.id}L`); fx.skid.break(`ai${d.id}R`); d._skidOn = false; }
        continue;
      }
      // rear contact patches, from the body pose — no dependency on when applyPose ran
      const rear = d.dims.wheelbase ? d.dims.wheelbase * 0.5 : 1.4;
      const half = (d.dims.trackRear ?? d.dims.track ?? 1.6) * 0.5;
      const fwd = b.forward, rgt = b.right;
      d.smokeTick++;
      const near = smoothstep(130, 30, dist);
      for (let s = -1; s <= 1; s += 2) {
        _v.copy(b.pos).addScaledVector(fwd, -rear).addScaledVector(rgt, s * half).setY(0.04);
        fx.skid.add(`ai${d.id}${s < 0 ? 'L' : 'R'}`, _v, rgt, 0.30, clamp(slide * 1.5, 0, 1));
        if (d.smokeTick % 5 === 0 && slide > 0.3) {
          fx.tyreSmoke(_v, b.vel, slide * 0.5 * (0.35 + 0.65 * near), b.surface === 'dirt' ? 'dirt' : 'road');
        }
      }
      d._skidOn = true;
    }
  }

  /** Release the plumes before main.js disposes the opponent cars. */
  detachCars() {
    if (!this.cars) return;
    for (const c of this.cars) {
      if (!c?.userData?.jet) continue;
      c.userData.jet.group.removeFromParent();
      c.userData.jet.dispose();
      c.userData.jet = null;
    }
    this.cars = null;
  }

  // ---------------------------------------------------------------- the frame

  update(dt, playerBody) {
    const t = this.track;

    // -------------------------------------------------- start sequence
    if (this.state === 'countdown') {
      this.countdown -= dt;
      // the pack revs on the line: brake hard, blip the throttle
      for (const d of this.drivers) {
        d.step(dt, { racing: false, rivals: this._traffic, time: this.time, laps: this.laps });
        d.body.brakeLit = true;
      }
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = 'racing';
        for (const d of this.drivers) d.launchT = d.reaction;
      }
      this._lastPlayerPos = this._lastPlayerPos || playerBody.pos.clone();
      this._lastPlayerPos.copy(playerBody.pos);
      this._order();
      return;
    }

    this.time += dt;
    this.lapTime += dt;

    // -------------------------------------------------- player progress
    // A teleport (the harness placing the car, a restart) is a position step no car can make in
    // one frame at 60 Hz. Rebase the lap counter rather than crediting a lap, and re-form the pack
    // around the new position so a race is still a race from wherever it resumes.
    const jumped = this._lastPlayerPos ? playerBody.pos.distanceTo(this._lastPlayerPos) : 0;
    if (jumped > 30) {
      this.reformPack(playerBody);
    } else {
      const near = t.nearest(playerBody.pos, this.playerU);
      this.playerLateral = near.lateral;
      const done = this._playerCounter.advance(wrap01(near.u), this.time);
      this.playerU = this._playerCounter.u;
      this.playerProgress = this._playerCounter.progress;
      if (done) {
        // lap −1 → 0 is the run from the grid to the line, not a lap
        if (this._playerCounter.lap >= 1) this.lapTimes.push(this.lapTime);
        this.lapTime = 0;
        if (this._playerCounter.lap >= this.laps && this.state === 'racing') {
          this.state = 'finished';
          this.finishTime = this.time;
          this._finish();
        }
      }
    }
    this.playerLap = Math.max(0, this._playerCounter.lap);
    if (!this._lastPlayerPos) this._lastPlayerPos = playerBody.pos.clone();
    else this._lastPlayerPos.copy(playerBody.pos);

    // -------------------------------------------------- traffic table (one build per frame)
    const traffic = this._traffic;
    traffic.length = 0;
    const pe = this._playerEntry;
    pe.pos.copy(playerBody.pos);
    pe.speed = Math.max(0, playerBody.speed);
    pe.progress = this.playerProgress;
    pe.body = playerBody;
    traffic.push(pe);
    for (const d of this.drivers) {
      d._entry = d._entry || { driver: d, isPlayer: false, pos: new THREE.Vector3(), speed: 0, progress: 0, body: d.body };
      d._entry.pos.copy(d.body.pos);
      d._entry.speed = Math.max(0, d.body.speed);
      d._entry.progress = d.progress;
      traffic.push(d._entry);
    }

    // -------------------------------------------------- drive
    // the player's own rolling pace — what the leash on a runaway leader is measured against
    this.paceRef = lerp(this.paceRef ?? Math.abs(playerBody.speed), Math.abs(playerBody.groundSpeed),
      1 - Math.exp(-0.18 * dt));
    const ctx = {
      rivals: traffic,
      playerProgress: this.playerProgress,
      viewPos: playerBody.pos,
      paceRef: this.paceRef,
      time: this.time,
      laps: this.laps,
      racing: this.state !== 'countdown',
    };
    for (const d of this.drivers) d.step(dt, ctx);
    this._recover(playerBody, dt);

    this._separate(playerBody, dt);
    this._order();
  }

  /**
   * A driver who has genuinely lost it — stopped, or beached against a barrier for seconds — is
   * put back on the road facing the right way, exactly as every arcade racer does. It only ever
   * fires well out of the player's sight, so it is never something you watch happen; without it a
   * single bad corner takes a car out of the race for good and the field thins over three laps.
   */
  _recover(playerBody, dt) {
    for (const d of this.drivers) {
      const stuck = Math.abs(d.body.speed) < 6 || Math.abs(d.lateral) > 1.42;
      d.stuckT = stuck ? (d.stuckT || 0) + dt : 0;
      if (d.stuckT < 3.5) continue;
      if (d.body.pos.distanceTo(playerBody.pos) < 110) continue;    // never in shot
      const s = this.track.at(d.u);
      const p = s.pos.clone().addScaledVector(s.right, this.rng.range(-0.4, 0.4) * this.track.halfWidth);
      const keep = d.counter.raw;
      d.body.reset(p, Math.atan2(s.tan.x, s.tan.z));
      d.body.vel.copy(s.tan).setY(0).normalize().multiplyScalar(22);
      d.body.speed = d.body.groundSpeed = 22;
      d.counter.raw = keep;                                        // no free progress
      d.counter.u = d.u;
      d.stuckT = 0;
      d.branch = null; d.wantBranch = null; d.branchCool = 4;
      d.recoveries = (d.recoveries || 0) + 1;
    }
  }

  /**
   * Car-to-car contact. Two capsule points per car (front and rear axle), resolved as a soft
   * push plus a real impulse when the closing speed is worth one. Without this the pack drives
   * *through* itself, which is the single most obvious tell that nothing on track is aware of
   * anything else.
   */
  _separate(playerBody, dt) {
    const bodies = this._bodies || (this._bodies = []);
    bodies.length = 0;
    bodies.push({ b: playerBody, d: null, r: 1.04, len: 1.35, px: 0, pz: 0 });
    for (const d of this.drivers) {
      bodies.push({ b: d.body, d, r: 1.00, len: (d.dims.wheelbase ?? 2.8) * 0.5, px: 0, pz: 0 });
    }
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      const af = A.b.forward;
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];
        if (A.b.pos.distanceToSquared(B.b.pos) > 64) continue;
        const bf = B.b.forward;
        let bestPen = 0, nx = 0, nz = 0;
        for (let a = -1; a <= 1; a += 2) {
          for (let c = -1; c <= 1; c += 2) {
            const ax = A.b.pos.x + af.x * A.len * a, az = A.b.pos.z + af.z * A.len * a;
            const bx = B.b.pos.x + bf.x * B.len * c, bz = B.b.pos.z + bf.z * B.len * c;
            const dx = bx - ax, dz = bz - az;
            const dist = Math.hypot(dx, dz) || 1e-4;
            const pen = (A.r + B.r) - dist;
            if (pen > bestPen) { bestPen = pen; nx = dx / dist; nz = dz / dist; }
          }
        }
        if (bestPen <= 0) continue;
        // Rate-limited push. Resolving the whole overlap every frame is a 16 m/s teleport apart
        // while two cars are rubbing down a straight, and that walks the whole pack into the
        // barriers. Cap it at a separation speed you could believe from two touching cars.
        const push = Math.min(bestPen * 0.5, 3.2 * dt);
        const wA = A.d ? 1 : 0.4, wB = B.d ? 1 : 0.4;      // the player is barely shoved
        A.px -= nx * push * wA; A.pz -= nz * push * wA;
        B.px += nx * push * wB; B.pz += nz * push * wB;
        // Closing velocity along the contact normal, exchanged as a RELATIVE impulse. `impact()`
        // is a wall solver — it works on absolute velocity, so using it here shoved the car being
        // rear-ended backwards down the road (a 120 mph opponent reading −10 mph in front of the
        // player, which is exactly what it looks like: broken). Between two cars only the closing
        // rate exists: the chaser loses it, the car in front is punted along by it.
        const rvx = B.b.vel.x - A.b.vel.x, rvz = B.b.vel.z - A.b.vel.z;
        const closing = rvx * nx + rvz * nz;
        if (closing < -1.8) {
          const j = Math.min(-closing * 0.40, 7.5);
          const wA = A.d ? 1 : 0.40, wB = B.d ? 1 : 0.40;
          A.b.vel.x -= nx * j * wA; A.b.vel.z -= nz * j * wA;
          B.b.vel.x += nx * j * wB; B.b.vel.z += nz * j * wB;
          // a nudge of rotation off a glancing blow, and a stability window so nobody spins out
          const twist = clamp(j * 0.045, 0, 0.5);
          const sideA = Math.sign(A.b.forward.x * nz - A.b.forward.z * nx) || 1;
          A.b.yawRate = clamp(A.b.yawRate + sideA * twist * 0.5, -3.4, 3.4);
          B.b.yawRate = clamp(B.b.yawRate - sideA * twist * 0.5, -3.4, 3.4);
          A.b.recover = Math.max(A.b.recover, 0.35);
          B.b.recover = Math.max(B.b.recover, 0.35);
          const s = clamp(-closing / 26, 0, 1);
          A.b.impactImpulse = Math.max(A.b.impactImpulse, s * 0.7);
          B.b.impactImpulse = Math.max(B.b.impactImpulse, s * 0.7);
          if (s > 0.06) this.contacts++;       // a knock, not every frame of a rub
          if (this.effects && (!A.d || !B.d) && s > 0.05) {
            _v2.copy(A.b.pos).add(B.b.pos).multiplyScalar(0.5).setY(0.55);
            _v3.set(nx, 0, nz);
            this.effects.sparkBurst(_v2, _v3, clamp(s * 0.9, 0.08, 0.5), { vel: A.b.vel });
          }
        }
      }
    }
    // One clamped displacement per car per frame, whatever it is touching — and opponents are
    // never allowed to shovel the PLAYER off the road. Leaning on you is racing; putting you in a
    // barrier because three of them arrived at the same corner is the "unfair" §6.10 rules out.
    for (const A of bodies) {
      const m = Math.hypot(A.px, A.pz);
      if (m < 1e-5) continue;
      const k = Math.min(1, ((A.d ? 4.5 : 1.6) * dt) / m);
      let px = A.px * k, pz = A.pz * k;
      if (!A.d) {
        const lat = this.playerLateral ?? 0;
        const s = this.track.nearest(A.b.pos, this.playerU).sample;
        const out = px * s.right.x + pz * s.right.z;              // component across the road
        if (Math.sign(out || 1) === Math.sign(lat || 1) && Math.abs(lat) > 0.85) {
          const trim = out * (1 - lerp(1, 0.1, smoothstep(0.85, 1.25, Math.abs(lat))));
          px -= s.right.x * trim; pz -= s.right.z * trim;
        }
      }
      A.b.pos.x += px; A.b.pos.z += pz;
    }
  }

  // ---------------------------------------------------------------- standings

  _order() {
    const t = this.track;
    const all = [{
      name: this.playerName, progress: this.playerProgress, you: true,
      lap: Math.max(0, this._playerCounter.lap), finished: this.state === 'finished',
      finishTime: this.finishTime, speed: 0, car: null,
    }];
    for (const d of this.drivers) {
      all.push({
        name: d.name, progress: d.progress, you: false, lap: Math.max(0, d.lap),
        finished: d.finished, finishTime: d.finishTime,
        speed: Math.abs(d.body.speedMph), car: d.vehicleId, boost: d.nitro.ramp, tactic: d.tactic,
      });
    }
    all.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
      return b.progress - a.progress;
    });
    const lead = all[0].progress;
    for (let i = 0; i < all.length; i++) {
      all[i].pos = i + 1;
      all[i].gapM = (lead - all[i].progress) * t.length;
      all[i].gap = all[i].gapM / Math.max(16, Math.abs(all[i].speed) * 0.447 || 30);
    }
    this.standings = all;
    this.playerPos = all.findIndex((x) => x.you) + 1;
  }

  _finish() {
    this.results = this.standings.map((s) => ({ ...s }));
  }

  // ---------------------------------------------------------------- telemetry

  /** What the race looks like from the outside — the harness prints this next to the screenshot. */
  telemetry() {
    const t = this.track;
    let ahead = 0, within = 0;
    const rows = [];
    for (const d of this.drivers) {
      const gapM = (d.progress - this.playerProgress) * t.length;
      if (gapM > 0 && gapM < 120) ahead++;
      if (Math.abs(gapM) < 150) within++;
      rows.push({
        name: d.name, car: d.vehicleId, gapM: +gapM.toFixed(1),
        mph: +d.body.speedMph.toFixed(0), drift: +d.body.drift.toFixed(2),
        boost: +d.nitro.ramp.toFixed(2), tactic: d.tactic, lap: d.lap,
        off: +d.offT.toFixed(1), hits: d.hits, cuts: d.counter.cuts,
      });
    }
    rows.sort((a, b) => b.gapM - a.gapM);
    return {
      pos: this.playerPos, lap: this.playerLap, laps: this.laps,
      u: +this.playerU.toFixed(4), state: this.state, time: +this.time.toFixed(2),
      packAhead: ahead, packWithin: within, contacts: this.contacts, reforms: this.reforms,
      cuts: this._playerCounter.cuts,
      field: rows,
    };
  }

  get lateralOffTrack() { return Math.abs(this.playerLateral) > 1; }
}

export { NAMES, Progress };
