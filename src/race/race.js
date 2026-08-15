import * as THREE from 'three';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';
import { VEHICLE_IDS, getVehicle } from '../vehicles/index.js';
import { VehicleBody } from '../vehicles/physics.js';
import { Nitrous, NitrousJet } from '../vehicles/nitrous.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvas, toTexture, grain } from '../core/textures.js';
import { drawText } from '../core/font.js';

/**
 * RACE SYSTEMS — opponents, lap logic, the director.  ART_DIRECTION.md §6.10.
 *
 * The reference frames are always four cars deep and fighting.
 *
 * ROUND 4 OF THIS FILE, and the round that made the result real. Round 3 built the pack, the band
 * and the flag — and every number it reported about WHO WON was fabricated, because the two
 * clocks it stamped finishing times from were 4.4 s apart. The five things fixed here, all
 * reproducible with `tools/_race_verify.mjs` (full race from the grid; independently timestamps
 * every car's last lap on ONE clock and prints that order against `race.results`),
 * `tools/_race_camnear.mjs` (closest approach of opponent bodywork to the chase camera) and
 * `tools/_race_cuts.mjs` (is a shortcut actually shorter?):
 *
 *   A. THE CLASSIFICATION WAS FICTION. Opponents were stamped from `wall`, which starts on the
 *      GRID, and the player from `time`, which starts on the GREEN — a COUNTDOWN (4.4 s) offset,
 *      always in the player's favour. Measured in LA: seven opponents crossed the line between
 *      190.0 s and 192.2 s, the player at 194.3 s, and the results table read YOU 1st with all
 *      seven behind. Position, laps and the whole standings deck were decoration and the game
 *      could not be lost. There is now one CLASSIFICATION clock (`raceTime`) and everybody is
 *      stamped from it — verified: 8/8 places correct in all four cities, and the player finishes
 *      P8 driving badly, P4 driving well.
 *   B. THE RACE COULD NOT END WITHOUT THE PLAYER. `_deadline()` — the flag falls FINISH_WINDOW
 *      after the winner, and the player is classified DNF where they actually are. An idle-player
 *      race now ends at 235.6 s (winner 175.6 + 60) with a results table, instead of still saying
 *      'racing' at 300 s.
 *   C. THE RECORD HAD NO OTHER SIDE. §6.7's TIME TO BEAT counted past zero into nothing; the
 *      director now owns the record, calls it when it goes, and puts `recordBeaten` in the
 *      results (NEW RECORD is a banner).
 *   D. ONE CLASS WAS NOT IN THE RACE. See the corner solve and `REF_LAT_G`: cornering was
 *      normalised by an index that the tyre ceiling then threw away again for the only class that
 *      needed it. With the band ablated the field's lap times spread 10.4 s (tuner 50.7, SUV
 *      61.1); they now spread under 3 s, the SUV finishes 2–3 s off the winner instead of 822 m,
 *      and it changes places 6–19 times a race instead of never.
 *   E. THE CAMERA DROVE THROUGH PEOPLE. BEHIND_SLOTS put the nearest car behind the player at
 *      exactly the chase rig's own distance; `_lensClear` and the driver-side `lensAvoid` keep
 *      bodywork out of the lens. Measured worst approach across 16 city × car chase captures:
 *      0.04 m with 7 frames inside the 0.30 m near plane → 0.32 m and none.
 *
 * Everything below that quotes an older number came off `tools/_race_r2.mjs`, which drives a full
 * three-lap race from the grid with a nitrous-using racing-line autopilot and prints pack density,
 * band saturation, off-track seconds, rank strobing and the finishing spread. Do not trust a claim
 * here that you cannot reproduce with one of these probes.
 *
 * 1. PROGRESS is a continuous, wrap-safe, checkpoint-validated quantity (`Progress` below). The
 *    grid starts at lap −1 so the run to the line is the formation lap, a lap is only credited
 *    when every checkpoint on it has been passed in order, and cutting the course is recorded
 *    rather than rewarded. `tools/_race_logic.mjs` asserts all of that, plus the race ending on
 *    the right lap, the finishing order freezing at the flag, and the results table matching.
 *
 * 2. A DRIVER MODEL rather than a line-follower. Each opponent computes its own racing line from
 *    the geometry of the road (turn in from the outside, clip the apex, run to the exit kerb),
 *    brakes on a real braking distance for the tightest radius inside its stopping distance, and
 *    is aware of every other car on track: it drafts, picks a side and commits to a pass IF THERE
 *    IS ROOM, defends the inside when it is being caught, and lifts rather than leaning on a
 *    barrier when it runs out of road. It also makes MISTAKES on a per-driver schedule — a late
 *    brake, a fumbled exit, a wobble — which is what makes it beatable.
 *
 * 3. THE SHAPE OF THE PACK is a property of the director. Every driver is handed a STATION by
 *    current rank (AHEAD_SLOTS: 9 m, 18, 29, 43 …) and the band is the filtered error against it.
 *    Measured over a full three-lap LA race from the grid against a nitrous-using racing-line
 *    autopilot (`tools/_race_r2.mjs`): at least one opponent ahead and in shot on 99 % of samples
 *    and at least two on 93 %, mean 2.8 cars inside 60 m, the longest stretch of empty road ahead
 *    1.5 s and the longest with nothing within 60 m 3.5 s. Round 2, same probe: 93 % / 63 %, 1.4
 *    cars inside 60 m, and 7.0 s / 11.3 s of nobody. `tools/_race_spect.mjs` counts what is
 *    actually happening in those frames: an opponent is in shot for 97 % of the race (LA) or 83 %
 *    (NYC), a rival's nitrous plume is lit in 50 % / 28 % of frames, and a rival is sideways past
 *    0.45 of drift in 36 % / 21 % — 158 separate slides and 177 separate boosts in one LA race,
 *    with a rival scraping a barrier in shot 0 % of the time.
 *
 * 4. RUBBER BANDING THAT CANNOT BE SEEN — the round-3 rewrite. Round 2 ran ONE authority for the
 *    whole field (±13 % rising to ±30 % with distance) and it was wrong at both ends: far too much
 *    on a car two lengths off the player's bumper, where 8–10 % of pace reads plainly as the field
 *    waiting, and far too little on one 300 m up the road, where it pinned at its bound for whole
 *    laps and still lost ground. It is now an ENVELOPE in distance:
 *
 *      · inside 65 m, or anywhere in the player's field of view, ≤1.5 % of pace — a fifth of what
 *        a draft is worth and under the frame-to-frame noise of a corner. Nothing you can see is
 *        being helped or held.
 *      · beyond 260 m and out of shot, up to 34 %, which is enough to close 300 m over one lap.
 *        A dozen pixels through the windscreen is where a director is allowed to work.
 *
 *    And it is SPLIT: the trim's authority over the corner solve is 40 % of its authority over
 *    straight-line speed. Feeding the whole trim into grip is what made round 2's field spend
 *    9–22 s a race in the scenery — a car told to carry 30 % more speed while braking for the grip
 *    it actually has arrives at every apex 30 % too fast.
 *
 *    It stays ONE-SIDED in shot: past 0.25 of `onScreen` — which is everything inside ~150 m — the
 *    trim is clamped at or below zero, so a car you can see can be held back but NEVER helped, and
 *    a pass is never taken back by the director. Measured over the LA race, the largest trim on any
 *    car the player could see was 0.164, on a car most of a straight away, and the field pace
 *    (Race._pace) spent the whole race between 0.820 and 0.966 — off both of its rails, where round
 *    2 sat welded to one of them for 55–70 % of a race.
 *
 * 5. NO CHEATING. Opponents hit the same barriers on the same rule as the player and throw the
 *    same sparks off them; they refill nitrous from the same boost pads on the same rule; nobody
 *    is ever repositioned inside 110 m of the player; and the field is held stationary on the grid
 *    until the lights go out.
 *
 * 6. THE ORDER DOES NOT STROBE. Raw progress swaps several times a second between two cars running
 *    wheel to wheel — measured, 75 displayed position changes in a three-lap race, 17 of them
 *    inside three seconds — and the HUD ordinal, the standings deck and the position flash all
 *    strobed with it. `_order()` now carries the previous order forward and only swaps a pair when
 *    the car behind is genuinely clear by ORDER_HYST metres AND has stayed clear for 0.3 s, so
 *    side-by-side running holds a stable order and a pass reads as an event. Both live in the
 *    ORDER, not on the readout, so the big ordinal and the standings deck cannot disagree.
 *    Measured: worst three-second window went from 18 changes to 4, in a race where seven cars
 *    finish inside 162 m of each other.
 *
 * 7. A REAL FLAG, AND A REAL RESULT. There is start/finish line geometry in the world
 *    (`buildStartLine`, a chequered strip across the road plus a gantry, built here because no
 *    city owns one), the race clock STOPS at the flag, the classification freezes, and the player
 *    is brought down off racing speed over the next few seconds instead of driving on at 116 mph
 *    under a text banner. The RESULT itself — who is in front of whom — is stamped from one clock
 *    for everybody (A above), the flag falls on a deadline whether or not the player is home
 *    (B), and the record is a thing that can be won or lost rather than a number that scrolls
 *    past (C).
 */

const NAMES = [
  'DOM', 'LETTY', 'ROMAN', 'TEJ', 'MIA', 'HAN', 'GISELE', 'SUKI',
  'BRIAN', 'JESSE', 'VINCE', 'RICO', 'NIKO', 'CARA', 'AXEL', 'RAY',
];

const CHECKPOINTS = 12;          // sectors per lap that must be passed in order
const GRAV = 9.81;
const COUNTDOWN = 4.4;           // grid hold + three lights + GO

/**
 * HOW LONG THE FLAG WAITS. Once the winner is home the race has a result; everybody still out on
 * the road is running for a place, not for the win, and a race that waits for them forever is not
 * a race — it is a simulation left running. Round 3 had NO termination path except the player
 * crossing the line: an idle-player probe had all seven opponents home by t = 201 s and was still
 * in state 'racing' at t = 260 s with no flag, no results, no DNF and no timeout, quietly counting
 * opponent-to-opponent contacts past 129. A minute is long enough to finish a lap you have half
 * driven after a bad crash, and short enough that "nothing is happening" never becomes a state
 * the game can sit in.
 */
const FINISH_WINDOW = 60;

/**
 * THE CORNER EVERY CLASS IS ASKED FOR, in G. See the corner solve in AIDriver.step: the four
 * classes are 57 % apart on real cornering ability once aero is counted (supercar 1.89 G, SUV
 * 1.20 G) and on a street circuit that is most of lap time, so an un-normalised field is a
 * procession however hard the band pulls. Every driver is asked for a figure close to this one,
 * tilted only slightly toward its own car, and is then hard-capped at what its own tyres actually
 * have — so nobody is ever driving on grip it does not possess.
 */
const REF_LAT_G = 1.34;
/** …and the same idea for braking, m/s². Nobody is asked for more than their own brakes give. */
const REF_DECEL = 18.0;

/** '2:52:40' (m:ss:cc) or a number of seconds → seconds. Mirrors the HUD's own clock parser. */
function parseRecord(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const p = String(v).split(/[:.]/).map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length >= 3) return p[0] * 60 + p[1] + p[2] / 100;
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}
// Where the field's pace starts before Race._pace has measured anybody. Deliberately a little
// under the AI's own physical ability: an opponent that is quicker than the player from the first
// corner is 300 m up the road by the end of lap one, and no invisible band can pull that back.
const START_PACE = 0.95;

/**
 * The shape of the pack, in metres of track, as a function of RANK relative to the player. The
 * nearest car ahead sits ~9 m up the road, the next ~18, then 29, 43 … so a player anywhere but
 * the lead has three or four cars inside 50 m in front of them — §6.10's "usually 2–4 cars visible
 * ahead", made a property of the director rather than a hope. Nothing teleports to these numbers:
 * they are the set-point of a filtered trim on pace (AIDriver.trim), and they are assigned by
 * CURRENT ORDER, so passing the car in front promotes the next one into the near slot and the
 * field closes up around a player who is driving well instead of receding from them.
 *
 * Round 2's ladder ran out to 150 m ahead and 200 m behind, which is a director asking for a
 * strung-out field: the tail cars sat inside the deadband of a 200 m set-point, the band therefore
 * asked them for nothing, and they finished 108–340 m adrift with the road behind the player empty
 * for eleven seconds at a stretch. The whole field now lives inside 122 m of the player, which is
 * about four seconds of road — close enough that every car is a car you are actually racing.
 */
const AHEAD_SLOTS = [9, 18, 29, 43, 62, 88, 122];
/**
 * …and BEHIND. The first slot is 17 m, not 9, and the reason is the CAMERA. The chase rig sits
 * `6.0 + speed01·3.2` metres behind the player — 8–9 m at racing speed — with a 0.30 m near
 * plane, so a station of 9 m parked the closest car behind the player exactly where the lens is:
 * measured over the chase capture in all four cities, the closest an opponent's bodywork came to
 * the camera was 1.27 m, and any dive under braking or contact from that puts the rig inside the
 * car, which is the sliced-open bodywork with a detached wheel the critic photographed. Nothing
 * is lost by moving it: the chase camera has no mirror, so the difference between 9 m and 17 m
 * behind is invisible until that car comes past. (`_lensClear` below is the backstop for the
 * transient — this is the fix for the steady state.)
 */
const BEHIND_SLOTS = [17, 26, 38, 54, 75, 102, 138];

/**
 * …and the last resort. A car whose bodywork comes inside this radius of the camera is not
 * "close racing" any more: the near plane cuts it open and the frame gets a lit interior, a
 * detached wheel and a slab of backfaces where a car should be. At that distance it is filling a
 * corner of frame with garbage, so it is simply not drawn for the few frames it is there — the
 * same near-plane cull every game applies to the car the camera is riding. It is deliberately
 * larger than the 0.30 m near plane: the plane clips on VIEW DEPTH, not on radius, so bodywork
 * 0.6 m away and 60° off the axis is only 0.3 m deep and gets sliced anyway.
 */
const LENS_CULL = 0.85;

/**
 * Nothing drives through the lens. The chase rig's near plane is 0.30 m; this is how close, in
 * metres, opponent BODYWORK is allowed to the camera itself before the director eases the car
 * away — see `_lensClear`. The margin over the near plane is deliberate: the box this is measured
 * against is the blueprint's `dims`, and the real mesh has wings, mirrors and wheels outside it,
 * so 0.4 m of nominal clearance is already a wheel through the front element.
 */
const LENS_CLEAR = 2.20;

/**
 * Order hysteresis, metres. Two cars running wheel to wheel cross and re-cross on raw progress
 * several times a second; below this margin the previous order is kept, so the HUD ordinal, the
 * standings deck and the PASSED banner all stop strobing during exactly the side-by-side moments
 * that matter. A car length and a half — a pass you can see is a pass the deck shows.
 */
const ORDER_HYST = 10.0;

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
  nitro: 1,         // opponents spend their tanks
  lens: 1,          // keep opponents out of the chase camera
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
    // …and the slow classes lean on the bottle harder, because it is the ONLY thing that lifts
    // their `vMax`: `physics.js` caps every car at its own top speed, so an SUV on 67.6 m/s can
    // never see an 84 m/s supercar's numbers down a straight without lighting the bottle — and it
    // happens to carry the longest one in the table (4.6 s against the supercar's 1.8).
    // This is only safe with the two gates below it: the boost look-ahead is now the car's OWN
    // stopping distance and a heavy car lifts 3.5 m/s over its corner solve rather than 7. With a
    // flat look-ahead the same bias took the SUV's off-track time from 9.7 s to 18.1 s a race.
    this.boostEager = clamp(r.range(0.35, 1.0)
      * lerp(1.30, 0.85, clamp(((spec.physics.topSpeed || 74) - 66) / 18, 0, 1)), 0.2, 1.3);
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
    this.yieldT = 0;
    this.draft = 0;
    this.band = 0;                // filtered rubber band, −1..1
    this.station = 0;             // metres ahead of (−: behind) the player the director wants
    this.stationJit = r.range(0.86, 1.18);
    this.stationT = r.range(4, 12);
    this.onScreen = 0;            // 0..1 how plainly the player can see this car right now
    this.trim = 0;                // the band's actual authority this frame, for telemetry
    // THE STRAIGHT-LINE HALF of the class normalisation. Skill is most of the spread; the rest
    // holds the fast classes back down the straights so a mixed field is a race rather than a
    // procession. Round 3 built this index out of top speed AND grip and then fed the whole thing
    // into the corner solve as well, which double-counted cornering and — because the corner solve
    // has a hard ceiling at the car's own tyres — threw the compensation away again for exactly
    // the class that needed it. Cornering is now normalised on its own terms below (REF_LAT_G),
    // and this index is TOP SPEED ONLY, which is the only thing it can actually trim.
    //
    // What it does, measured: the supercar's 84 m/s is held to ~73, the muscle car's 74.5 to ~72,
    // and the tuner and the SUV — which are 70.0 and 67.6 — are simply asked for everything they
    // have. `physics.js` caps every car at its own `topSpeed`, so asking a slow class for more
    // than that is a no-op; the whole authority of this number is in slowing the fast ones down.
    const ph = spec.physics;
    this.paceMul = lerp(0.955, 1.035, this.skill) / Math.pow((ph.topSpeed || 74) / 74, 0.55);
    // Real cornering ability, in G: the tyres this class has plus the aero it makes at the speed a
    // corner is taken. NOTHING the driver does is ever allowed past this — see the corner solve.
    this.classG = (ph.gripFront + ph.gripRear) * 0.5;
    this.realG = this.classG * (1 + (ph.downforce ?? 0) * 0.55);
    // …and the figure the DIRECTOR asks for, which is mostly the common reference. The 0.20
    // exponent leaves the supercar the best-handling thing on the road (1.44 G of reference
    // against the SUV's 1.31) while taking the field's cornering spread from 57 % to 10 %.
    this.refG = Math.pow(this.realG, 0.20) * Math.pow(REF_LAT_G, 0.80);
    // How much of its own tyre a driver is allowed to lean on. A 2.5 tonne car is still rolling
    // when it reaches the apex, so it gets a slimmer slice than a supercar on race springs.
    this.gripCeil = lerp(0.95, 0.86, smoothstep(1600, 2500, ph.mass || 1500));
    // Braking, m/s². `physics.js` applies `p.brake` as a deceleration directly and then ADDS a
    // speed/aero gain on top (`bf`), so this — the low-speed figure with a fraction of that gain —
    // is always inside what the car can really do. Capped at REF_DECEL so the classes that stop
    // hardest do not also get to brake latest: only the class that cannot reach the reference
    // (the SUV, at 15.8) is limited by its own brakes.
    this.brakeCap = (ph.brake || 20) / ((ph.mass || 1500) / 1400);
    this.shortcuts = 0;           // shortcuts genuinely driven end to end (telemetry `cuts`)
    this.launchSpin = 0;          // seconds of standing-start wheelspin left
    this.revPhase = r.range(0, 6.3);
    this.wallHit = 0;             // strength of a barrier hit this frame (updateVisuals draws it)
    this.wallPt = new THREE.Vector3();
    this.wallN = new THREE.Vector3();
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
    this.gridPos = p.clone();
    this.gridYaw = yaw;
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
    this._cutFrom = null; this._cutCredit = false;
    this.passOff = 0; this.passWant = 0; this.avoid = 0;
    this.nitro.reset();
    this.finished = false;
    this.finishTime = null;
    return this;
  }

  /**
   * Where this car is on the lap. Identical arithmetic to `track.nearest()`, searched in a ±11
   * sample window around the u this driver already holds — a car moves under 2 m a frame and the
   * samples are 3 m apart, so that window cannot be jumped. `track.nearest`'s own hinted search
   * scans ±6 % of the lap (±60 samples on a long track) and it is called for every opponent every
   * frame; this is a seventh of the work and buys back the frame budget the pack logic spends.
   * Falls back to the exact search whenever the winner lands on the edge of the window, which is
   * the only case where a local search can be wrong.
   */
  locate(p) {
    const t = this.track, S = t.samples, N = t.N;
    const c = Math.round(this.u * N);
    const span = 11;
    let bi = -1, bd = Infinity, bk = 0;
    for (let k = -span; k <= span; k++) {
      const i = ((c + k) % N + N) % N;
      const d = S[i].pos.distanceToSquared(p);
      if (d < bd) { bd = d; bi = i; bk = k; }
    }
    if (bi < 0 || bk === -span || bk === span) return t.nearest(p);
    const s = S[bi];
    const ox = p.x - s.pos.x, oy = p.y - s.pos.y, oz = p.z - s.pos.z;
    return {
      u: s.u + (ox * s.tan.x + oy * s.tan.y + oz * s.tan.z) / t.length,
      lateral: (ox * s.right.x + oy * s.right.y + oz * s.right.z) / t.halfWidth,
      dist: Math.sqrt(bd), sample: s,
    };
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
  cornerSpeed(u, latG, decel, topSpeed, v = 0) {
    const t = this.track;
    const L = t.length;
    let vt = topSpeed;
    // THE HORIZON IS THE CAR'S OWN STOPPING DISTANCE, not a constant.
    //
    // Round 2 looked 265 m ahead whatever the car was doing. At 60 m/s that is comfortably more
    // than a stopping distance; at 88 m/s — a nitrous run, or an SUV the band has let off the
    // leash on a straight — the stopping distance is over 400 m, so the driver physically cannot
    // see the corner it has to brake for. It arrives 25 m/s too fast, runs wide, and the whole
    // hard-won trim gets thrown away in the scenery: measured, the three cars with the strongest
    // trims were the three spending 12–25 s a race off the road, and this was why.
    // …and it is a CONSTANT, not a function of the car's current speed. Deriving the horizon from
    // speed closes a loop through the target: the horizon extends, finds a corner, the target
    // drops, the car slows, the horizon shrinks, the corner disappears, the target rises — a limit
    // cycle that parks the car below its own pace all race. A distant corner cannot over-restrain
    // anything anyway, because the braking solve (v² = v₀² + 2·a·d) makes 380 m of road worth
    // 100 m/s of allowance on its own.
    const reach = 380;
    // 6 m steps out to 170 m — a coarser grid aliases against the road and the target speed then
    // chatters by a factor of two between frames — then 14 m, where the braking solve is
    // insensitive to where exactly the corner is.
    for (let d = 5; d < reach; d += (d < 170 ? 6 : 14)) {
      const k = Math.abs(t.turnRate(u + d / L));
      if (k < 2e-4) continue;
      const R = Math.min(1 / k, 4000);
      // `latG` already carries this class's aero (see `realG` in the constructor and the corner
      // solve in step()) — multiplying by downforce again here was where the supercar quietly got
      // a 14 % corner-speed advantage back after the normalisation had just taken it away.
      const vc = Math.sqrt(latG * R);
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
    const near = this.locate(b.pos);
    let u = wrap01(near.u);
    let lateral = near.lateral;
    let sample = near.sample;
    let halfWidth = t.halfWidth;
    let groundY = 0;
    let onBranch = null;
    let junction = false;          // inside a shortcut mouth or its merge: no street barrier here
    if (t.branches?.length) {
      for (const br of t.branches) {
        // only the branch whose mouth is within reach can possibly own this car — a full
        // nearest-point scan of every shortcut for every opponent every frame is not free
        const rel = wrapDelta(this.u, br.enterU) * t.length;
        const relX = wrapDelta(this.u, br.exitU) * t.length;
        if (rel > 34 || rel < -(br.length + 80)) continue;
        const nb = br.nearest(b.pos);
        // A junction is a GAP in the barrier, and only where the shortcut actually meets the
        // street: within 30 m of the mouth or the merge AND within a couple of ribbon widths of
        // the shortcut itself. Everywhere else on the street the wall is exactly the player's.
        if ((Math.abs(rel) < 30 || Math.abs(relX) < 30) && nb.dist < br.halfWidth * 2.2) junction = true;
        if (rel > 12) continue;
        // Round 1's test was "closer to the shortcut's centreline than to the street's", which is
        // false for the whole of the entry — the two ribbons diverge slowly, so a car committed to
        // the mouth was still being localised on the STREET, with a street lateral of 1.2 and a
        // street barrier at 1.52 that is not there. That, and not the driving, was where the
        // field's off-track time and half its barrier hits came from (measured by ablation: with
        // shortcuts off, off-track collapses from 12–19 s a race to under 5).
        // WHO OWNS THIS CAR. Round 2 also accepted "the shortcut's centreline happens to be
        // closer than the street's" as ownership, and near a mouth that is true of any car merely
        // running a little wide on the STREET: it was silently transferred onto the shortcut, given
        // the shortcut's surface and — because the shortcut ribbon is a third the width — a barrier
        // at 1.52 of a much smaller half-width, which then shoved it. Measured on NYC, that single
        // test produced excursions of 1.4–1.9 s with a street lateral reaching 5.7 (forty metres
        // off the road) and it accounted for nearly all of the two SUVs' 8–12 s a race off-track.
        //
        // Ownership is now: inside the ribbon, or aiming at it and nearly inside, or ALREADY on it
        // (sticky, so running wide on a narrow shortcut does not eject the car into a street
        // barrier that is not there — it hits the shortcut's own wall, like a driver would).
        // The stickiness is deliberately small. A branch owns the car's POSITION ON THE LAP as well
        // as its surface (u is remapped through the branch's arc length), so a car that stays
        // "on" a shortcut it has actually left stops making progress entirely: at a sticky 2.4 the
        // whole field ended a three-lap race still on lap 0 with 83–103 s off-track apiece.
        const aiming = this.wantBranch === br || this.branch === br;
        if (!aiming) {
          // A CAR THAT DID NOT CHOOSE THIS CUT. Both mouths of a branch sit on the centreline of
          // the street, so "inside the ribbon" is true of anything driving straight past one —
          // and round 3 handed those cars to the branch, which then steered them down it. Every
          // driver therefore took every shortcut on the lap whether it wanted to or not (measured:
          // 1–4 completed traversals a race even with `AI_TUNE.shortcuts` OFF), the whole
          // decision below was decoration, and cars that wanted the street were being pulled onto
          // a ribbon a third its width. A car that has not chosen the cut is only on it once it is
          // genuinely off the street: closer to the ribbon than to the road by a clear margin.
          if (nb.dist + 1.5 < Math.abs(near.lateral) * t.halfWidth && Math.abs(nb.lateral) < 0.75) {
            onBranch = nb; break;
          }
          continue;
        }
        const own = this.branch === br ? 1.45 : 1.05;
        if (Math.abs(nb.lateral) < own && nb.dist < br.halfWidth * (own + 0.7)) { onBranch = nb; break; }
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
      // Credit a shortcut only when the car has genuinely been THROUGH one. Both mouths of a
      // branch sit on the centreline of the street, so anything driving past one is momentarily
      // inside its ribbon and "on" it — counting those was reporting a dozen shortcuts a race for
      // drivers who had never left the road. Entered before a quarter, still on it past three
      // quarters: that is a cut.
      if (this._cutFrom == null) this._cutFrom = onBranch.t;
      if (!this._cutCredit && this._cutFrom < 0.25 && onBranch.t > 0.75) {
        this.shortcuts++; this._cutCredit = true;
      }
    } else if (this.branch) {
      this.branch = null;
      this.branchCool = 4;
      this._cutFrom = null; this._cutCredit = false;
    }

    const lapDone = this.counter.advance(u, ctx.time ?? this.totalTime);
    this.u = this.counter.u;
    this.lap = this.counter.lap;
    this.progress = this.counter.progress;
    this.lateral = lateral;
    this.sample = sample;
    if (lapDone && this.lap >= (ctx.laps ?? 3) && !this.finished) {
      this.finished = true;
      this.finishTime = ctx.time ?? this.totalTime;
    }

    const speed = Math.max(0, b.speed);
    const topMul = 1 + (this.nitro.ramp * ((this.spec.nitro.topSpeedMul ?? 1.3) - 1));

    // ------------------------------------------------------------ pack integrity
    // Every driver holds a STATION: the gap, in metres, the director wants between this car and
    // the player. The director hands them out by CURRENT ORDER (Race._stations) — nearest car
    // ahead gets 9 m, next 18, then 29, 43 … — so holding station is a small correction for
    // everybody and the composition of the shot is guaranteed rather than hoped for: whenever the
    // player is not leading there are three or four cars inside 60 m up the road (§6.10).
    //
    // The band is the error against that station, and four things keep it invisible:
    //   · it is low-passed over 1.6 s, so no pace ever steps;
    //   · it is a trim on pace and corner commitment — never a position, never a teleport;
    //   · its authority is an envelope in DISTANCE (below): ≤1.5 % of pace inside 65 m or anywhere
    //     in shot, opening to 34 % only past 260 m, where a car is a dozen pixels;
    //   · and even then only 40 % of it reaches the corner solve. A car cannot out-drive the field
    //     on the band; it can only stop losing touch with it down a straight nobody is watching.
    const aheadM = (this.progress - (ctx.playerProgress ?? this.progress)) * t.length;
    _v.copy(b.pos).sub(ctx.viewPos || b.pos);
    const seen = _v.length();
    // "on screen" is the chase camera's cone: in front of the player, or alongside, and close
    // enough to read. Behind them is a mirror they do not have.
    const facing = seen > 1e-3 && ctx.viewFwd
      ? (_v.x * ctx.viewFwd.x + _v.z * ctx.viewFwd.z) / seen : 1;
    this.onScreen = smoothstep(235, 115, seen) * smoothstep(-0.35, 0.1, facing);
    // The deadband scales with the station: a car whose job is to sit on the player's bumper is
    // held to ±5 m, one holding 120 m to ±20. Inside it the driver races on its own pace, so the
    // field is not permanently micro-correcting toward a ladder.
    const gapErr = aheadM - this.station;
    const dead = clamp(Math.abs(this.station) * 0.30, 5, 20);
    // The error is normalised on the station's OWN scale — the front of the pack, which is what
    // the shot is made of, is the tightest-held part of it.
    const gapScale = Math.max(55, Math.abs(this.station) * 1.05);
    const bandWant = clamp(-(gapErr - clamp(gapErr, -dead, dead)) / gapScale, -1, 1) * AI_TUNE.band;
    // 1.6 s rather than round 2's 2.2: the filter has to be slower than a corner and faster than a
    // straight, and at 2.2 s a car that lost 80 m in one mistake was still winding its trim up two
    // corners later, by which time the player had gone.
    this.band = lerp(this.band, bandWant, 1 - Math.exp(-dt / 1.6));
    // AUTHORITY IS AN ENVELOPE IN DISTANCE, not a constant. Round 2 ran ±13 % rising to ±30 %
    // everywhere and it was wrong at both ends at once: measured, the strongest trim on a car the
    // player could SEE was 8–10 % for a whole race (the field visibly waiting) while five drivers
    // sat pinned at the +30 % bound for whole laps and still lost 20 m/s of ground.
    //
    //   · far ≈ 0 (inside 65 m): ≤1.5 % of pace. A fifth of what a draft is worth. Whatever you
    //     are looking at is racing you honestly.
    //   · far ≈ 1 (beyond 260 m, and therefore out of shot): 34 %, which closes ~300 m over a lap.
    //
    // `onScreen` then takes another bite out of it, so a car that is somehow both distant and
    // squarely in frame is still nearly untrimmed.
    const far = smoothstep(65, 260, seen);
    const auth = lerp(0.015, 0.34, far) * lerp(1, this.band < 0 ? 0.30 : 0.10, this.onScreen);
    this.trim = clamp(this.band, -1, 1) * auth;
    // THE BAND NEVER RUNS AWAY FROM YOU. A car the player can see is only ever allowed to be
    // trimmed DOWN. Two-sided, the ladder would put its foot down the instant the player closed
    // on the car in front — which is both the most obvious form of rubber banding there is and
    // the thing that makes a pass feel like it was decided by the game rather than by you.
    if (this.onScreen > 0.25) this.trim = Math.min(this.trim, 0);

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
    // Three knobs, and a race director is allowed all three: the driver's own skill spread, the
    // FIELD PACE (Race._pace) and the station band (above).
    //
    // They go into the corner solve rather than onto its answer. Scaling the SOLVED target was
    // the round-1 form and it is quietly wrong: a car told to carry 5 % more speed while still
    // braking for the grip it had is a car that arrives at the apex 5 % too fast, every corner,
    // for the whole race — measured, three of the seven were spending 12–18 s a lap off the road
    // with half a dozen barrier hits each. Fed in as grip and braking, the solve stays
    // self-consistent: a quicker driver brakes later AND turns harder, like a quicker driver.
    // The grip fraction is capped at 0.95 of the tyre's real figure, so no amount of trim can ask
    // for grip that is not there.
    //
    // AND THE TRIM IS SPLIT. Its authority over the CORNER solve is 30 % of its authority over
    // straight-line speed. This is the single change that stopped the field losing the race to
    // itself: a car handed +30 % of pace into the grip solve brakes for a corner it is arriving at
    // 30 % too fast for, every corner, and round 2's back markers were spending 12–18 s a race off
    // the road doing exactly that. The time a catching car is allowed to make up is on the
    // straights, where being 30 % quick costs nobody anything and nobody can see it happen.
    const basePace = clamp(this.paceMul * (ctx.fieldPace ?? 1), 0.60, 1.10);
    // …and the straight-line half is capped at 1.24 of the CLASS figure, not of this driver's own
    // normalised pace. Above that the car is asking for a speed its brakes cannot undo before the
    // next corner however far ahead it looks, and a catch-up that ends in a barrier is not one.
    const speedPace = clamp(basePace * (1 + this.trim), 0.52, 1.20);
    // THE CORNER HALF IS CLASS-FREE. `paceMul` above is a TOP-SPEED index and belongs on the
    // straights; feeding it into the corner solve as well (round 3) both double-counted the class
    // and was thrown away again by the tyre ceiling, which is why the SUV — nominally handed 14 %
    // more pace than the supercar — actually cornered 16 % slower than the tuner and finished
    // every race last, 822 m adrift at the LA flag with HAN and LETTY never once changing places.
    // What is left here is what a DRIVER brings: skill, the field pace, and the corner half of
    // the band's trim.
    const cornerPace = clamp(lerp(0.86, 1.00, this.skill) * (ctx.fieldPace ?? 1)
      * (1 + this.trim * 0.40), 0.58, 1.12);
    this.pace = cornerPace;
    // THE CORNER ASK. Every class is asked for the same reference figure (REF_LAT_G), tilted a
    // fifth of the way toward its own real ability so the supercar is still the best-handling car
    // on the road, and then HARD-CAPPED at what its own tyres and its own aero actually make.
    // Nobody is ever driving on grip it does not have — an SUV asked for 1.31 G simply gets the
    // 1.08 its ceiling allows and brakes for that. Measured over a three-lap LA race with the band
    // ablated, this takes the field's lap-time spread from 10.4 s (tuner 50.7, SUV 61.1) to under
    // 3 s, which is the difference between a procession and §6.10's "close and beatable".
    const tyreG = GRAV * Math.min(this.refG * cornerPace, this.realG * this.gripCeil);
    const latG = tyreG
      * (mistake === 0 ? 1.10 : 1)                               // braked a beat too late
      // running wide is self-correcting: out past the kerb they lift and gather it up
      * lerp(1, 0.66, smoothstep(0.72, 1.15, Math.abs(this.lateral)))
      // and a car already sideways has no lateral grip left to spend on the next corner
      * lerp(1, 0.72, smoothstep(0.25, 0.75, b.drift));
    // Braking, and normalised on the same principle as the corner ask. `physics.js` applies
    // `p.brake` as a force divided by mass/1400 and then adds a speed/aero gain (`bf`) on top, so
    // `brakeCap` plus a third of that gain is always inside what the car really does. The classes
    // that stop hardest are then held to REF_DECEL — the supercar's 23 m/s² is worth nothing to
    // the racing if it simply means braking 40 m later than everybody else every corner — while
    // the one class that cannot reach the reference (the SUV, 15.8) is limited by its own brakes
    // and by nothing else. Round 3 asked the SUV for 14.4 and the supercar for 19.6.
    const brakeGain = 1 + 0.12 * clamp(speed / (p.topSpeed || 70), 0, 1.3);
    const decel = Math.min(this.brakeCap * brakeGain * lerp(0.80, 0.98, this.skill), REF_DECEL)
      * clamp(cornerPace, 0.75, 1.08);
    // …and the wide half of the trim caps the straight-line speed, so the knob has its authority
    // where it is safe (down a straight, out of shot) and almost none where it is not (mid-corner).
    this.natural = this.cornerSpeed(u, latG, decel, p.topSpeed * topMul * speedPace, speed);
    let target = this.natural;
    // TRACK LIMITS. A driver with a wheel over the kerb has exactly one job, and round 2's version
    // — a 14 % lift at 1.2 of the half-width — was not enough of a job: the field averaged 8 s a
    // car off the road and the worst spent 17.7 s of a 172 s race in the scenery, which is where
    // the race was actually being lost. `offRec` ramps in over ~0.4 s of running wide and is read
    // three more times below: it shortens the look-ahead, sharpens the steering and cancels the
    // showboating, so a car that has run wide gathers it up like a driver instead of cruising
    // along the barrier at 90 % throttle.
    const offAmt = Math.abs(this.lateral);
    this.offRec = clamp((this.offRec ?? 0) + (offAmt > 0.80 ? dt : -dt * 1.8) * 2.5, 0, 1);
    // …and HOW MUCH a driver lifts with a wheel over the line is a property of the CAR. A supercar
    // on 0.48 off-road grip is on ice out there; the SUV keeps 0.90 of its grip and the handling
    // table says in as many words that this is its whole reason to exist. A flat 0.60 for
    // everybody threw that away — which is half of why the one class built to use the dirt was
    // also the one class that never used it.
    const offKeep = lerp(0.55, 0.78, clamp(((p.offroadGrip ?? 0.58) - 0.48) / 0.42, 0, 1));
    if (offAmt > 0.78) target *= lerp(1, offKeep, smoothstep(0.78, 1.20, offAmt));
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
        const push = (3.2 - absSide) / 3.2 * (o.isPlayer ? 1.7 : 1.3);
        // …and when there is no road left on my side, a driver LIFTS instead of leaning on the
        // barrier. `track.right` is the mirror of the car's, so a rival on my car-right sits at a
        // lower track lateral and moving away from it takes me further out. Without this the
        // outside car in every four-wide corner ended up scrubbing the wall: measured, the back
        // half of the field was spending 11–14 s a race off the road with 3–8 barrier hits each.
        if (Math.abs(lateral) > 0.60 && Math.sign(side || 1) === Math.sign(lateral || 1)) {
          this.yieldT = Math.max(this.yieldT, 0.55);
        } else {
          this.avoid = lerp(this.avoid, -Math.sign(side || 1) * push * 0.26, 1 - Math.exp(-7 * dt));
        }
      }
      // being caught from behind
      if (along < -1.5 && along > -22 && absSide < 3.4 && -along < behindDist) {
        behindDist = -along; behindClose = o;
      }
    }
    // DON'T SIT IN THE LENS. The chase rig hangs 6–12 m behind the player at roughly roof height,
    // and a driver holding station in that pocket is a car the camera drives through: measured
    // over the chase capture, an SUV's roof (2.44 m on the real mesh) passes 0.32 m under a rig
    // that sits at 2.30–2.80 m, and at anything below racing speed that is negative. So the
    // driver treats the rig as one more thing on the road it does not want to touch — it eases
    // off its line rather than being shoved off it, which is both earlier and invisible.
    // (`Race._lensClear` is the hard backstop for whatever this does not catch.)
    this.lensAvoid = 0;
    if (ctx.lensPos && AI_TUNE.lens && sample) {
      _v.copy(ctx.lensPos).sub(b.pos);
      const lFlat = Math.hypot(_v.x, _v.z);
      if (lFlat < 12) {
        const k = smoothstep(12, 3.0, lFlat);
        // decided in TRACK space, where the line target lives, so there is no sign to get wrong:
        // +lensLat means the rig is toward track-right of me, so I want less track lateral.
        const lensLat = _v.x * sample.right.x + _v.z * sample.right.z;
        this.lensAvoid = -Math.sign(lensLat || 1) * 0.45 * k;
        // …and BREATHE OFF. Sideways is not the only way out of the rig's way and on a narrow
        // street it is the worst one — the track limits pull the car straight back in. The rig is
        // behind the player and travelling forward relative to a car it is passing, so a lift
        // ends the encounter faster than any amount of steering, and a lift is invisible on a car
        // that is level with the lens.
        target *= lerp(1, 0.82, k);
      }
    }
    this.avoid = lerp(this.avoid, 0, 1 - Math.exp(-2.4 * dt));
    this.yieldT = Math.max(0, this.yieldT - dt);
    if (this.yieldT > 0) target *= 0.93;          // out of room: give it back and re-take it later

    // --- decide what this frame is about
    this.draft = 0;
    let tactic = 'clear';
    if (blockAhead) {
      // slipstream: sitting in the hole punched by the car in front is worth real speed, and it
      // is the reason a pack stays a pack down a straight instead of stringing out
      this.draft = smoothstep(30, 5, blockDist) * (1 - smoothstep(1.6, 3.0, Math.abs(sideRoom))) * 0.11;
      target *= 1 + this.draft;

      const closing = speed - Math.max(0, blockAhead.speed);
      // A pass needs somewhere to put the car. Attacking into a lane that is already occupied is
      // how a four-wide pack turns into a demolition derby — measured, 535 knocks in a three-lap
      // race, 72 of them on the player, before this line existed.
      const lane = 1 - Math.min(1, Math.min(leftBusy, rightBusy));
      const wantPass = blockDist < 26 && lane > 0.35 && (closing > -1.5 || this.aggression > 0.55);
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
        // A following distance, not a following SPEED: inside the gap they want, the target has
        // to drop BELOW the car in front or they close on it forever, touch, get pushed back and
        // close again — which is what a rear-ender every half second looks like in the contact log.
        if (blockDist < 13 && Math.abs(sideRoom) < 2.1) {
          // P on the gap, D on the closing rate. Proportional alone is an undamped spring: the
          // queue behind a slow car oscillates into itself and the contact log fills with rubs.
          target = Math.min(target, Math.max(6,
            blockAhead.speed + (blockDist - 7) * 0.45 - Math.max(0, closing) * 0.55));
        }
      }
      // …and NEVER rear-end the player, whatever the tactic says. Racing them side by side is the
      // point; punting them down the road from behind because they braked earlier than the AI
      // expected is the "unfair" §6.10 rules out, and on a narrow street circuit (NYC) it was
      // happening 37 times a race. They go round, or they wait.
      if (blockAhead.isPlayer && blockDist < 16 && Math.abs(sideRoom) < 2.4) {
        target = Math.min(target, Math.max(6,
          blockAhead.speed + (blockDist - 9) * 0.5 - Math.max(0, closing) * 0.6));
      }
    }
    // DEFENDING. Round 3 required `tactic !== 'attack'`, and in a pack held nine metres apart
    // almost every car has somebody in front of it, so almost every car was attacking and
    // `defend` fired in 2 of ~2000 tactic samples — a whole limb of the driver model that never
    // ran. A driver with a mirror full of somebody closer than the car it is chasing covers the
    // inside first: that is what a racing driver does, and it is what the standings deck's tactic
    // readout is there to show.
    if (behindClose && behindDist < 17 && this.defendT <= 0 && !this.finished && tactic !== 'attack') {
      // one move to defend, then a cooldown — that is the difference between racing and blocking
      const side = Math.sign(_v.copy(behindClose.pos).sub(b.pos).dot(rgt) || 1);
      // …and the move is only as big as the road left on that side. Covering the inside by a third
      // of the half-width is a racing driver on a boulevard and a car in the wall on a Vegas
      // hairpin: with the size fixed, the field's off-track time on Vegas went from 0–7 s a car to
      // 4–18 and its barrier hits from 0–2 to 2–9.
      const room = clamp(0.86 - lateral * -side, 0, 1);
      this.passWant = clamp(-side * 0.34 * this.aggression * room, -0.5, 0.5);
      this.defendT = this.rng.range(1.6, 3.2);
      this.passT = Math.max(this.passT, 1.8);
      tactic = 'defend';
    }
    this.defendT -= dt;
    // …and a driver holding a defensive line IS defending, for as long as it holds it. The
    // decision above is a one-shot — it fires on a single frame and then sits out its cooldown —
    // so the tactic read 'defend' for exactly one frame per move and the standings deck's tactic
    // column, and every probe that samples it, reported 2 defends in ~2000 samples for a field
    // that was covering the inside line all race. `passWant` is still pinned across this whole
    // window; this makes the label agree with the car.
    if (this.defendT > 0 && tactic !== 'attack') tactic = 'defend';
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
      && t.branches?.length && ctx.racing !== false && !this.finished) {
      for (const br of t.branches) {
        const d = wrapDelta(u, br.enterU) * t.length;
        if (d <= 6 || d > 110) continue;
        // IS THIS CUT WORTH ANYTHING? Not every branch is: measured with tools/_race_cuts.mjs,
        // Miami's u 0.80→0.865 ribbon is 340 m of road replacing 157 m of street and LA's flood
        // channel is 38 m longer than the boulevard it leaves. A driver that dives into one of
        // those is not taking a shortcut, it is taking the long way round in a narrower lane —
        // so the ones that lose distance are simply not on the menu. (Cached on the branch: the
        // geometry never changes.)
        if (br._gainM == null) br._gainM = wrap01(br.exitU - br.enterU) * t.length - br.length;
        if (br._gainM < -8) { this.branchCool = 2.5; continue; }
        // Round 3 gated this on `skill > 0.72 && (taste > 0.76 || band > 0.60)` and then put a
        // 5 s cooldown on every rejection, which came to a field that took a signposted shortcut
        // roughly never — including NYC, where the lit SHORTCUT gate is in frame in the chase
        // capture. The appetite now has the thing the design has been asking for all along in it:
        // the CLASS's own off-road grip, so the SUV (0.90) is the car that always takes the dirt
        // line and the supercar (0.48) is the one that mostly stays on the tarmac.
        // …and a driver good enough and TIDY enough to make the entry. A fumbled mouth is worth
        // 7–14 s of a race spent grinding the kerb beside it — measured on Vegas's u = 0.279
        // shortcut, a muscle car that should not have been trying it went off at the mouth twice
        // in one race and sat against the barrier for 3.9 s each time.
        const aligned = Math.abs(lateral) < 0.50 && Math.abs(b.slip) < 0.12 && this.offRec < 0.15;
        const appetite = this.shortcutTaste * 0.70 + (p.offroadGrip ?? 0.58) * 0.80
          + Math.max(0, this.band) * 0.40 + clamp(br._gainM / 40, -0.2, 0.30);
        const wants = this.skill > 0.68 && appetite > 0.92;
        if (wants && aligned) { this.wantBranch = br; this.branchCool = 0; }
        // A driver that WANTS the cut and is merely still tidying up looks again in a quarter of
        // a second, not in three. One rejection used to cost 80–190 m of the approach, which on a
        // city whose mouth sits at the exit of a corner (Vegas, u = 0.279) meant the whole field
        // drove past every shortcut it had every intention of taking.
        else this.branchCool = wants ? this.rng.range(0.25, 0.6) : this.rng.range(2.5, 5.0);
        break;
      }
    }
    if (this.wantBranch && !this.branch) {
      const d = wrapDelta(u, this.wantBranch.exitU) * t.length;
      if (d < 0 || d > this.wantBranch.length + 140) { this.wantBranch = null; this.branchCool = 5; }
      // …and a driver ABANDONS a cut it is not going to make. The aim fades in over the last 55 m
      // (below) and a car arriving there sideways, wide, or well over its own corner solve is not
      // entering a 7.5 m ribbon — it is about to put two wheels on the kerb beside the mouth and
      // spend four seconds there. Straighten up, stay on the street, take it next lap.
      else if (Math.abs(b.slip) > 0.26 || b.drift > 0.62 || Math.abs(lateral) > 0.80
        || (speed - target) > 12) {
        const dm = wrapDelta(u, this.wantBranch.enterU) * t.length;
        if (dm < 45) { this.wantBranch = null; this.branchCool = 4; }
      }
    }

    // ------------------------------------------------------------ where to aim
    // ~0.8 s of road. Short lookaheads are twitchy at 150 mph and a twitchy car at 150 mph is a
    // car in a barrier; long ones cut apexes. This is the same order the harness autopilot uses.
    // …and it shortens as the car runs wide. A 62 m look-ahead turns a full car width of lateral
    // error into six degrees of steering, which is a car that takes four seconds to come back onto
    // the road; at half that distance it comes back in one.
    // …and it shortens as the car runs wide. A 62 m look-ahead turns a full car width of lateral
    // error into six degrees of steering, which is a car that takes four seconds to come back onto
    // the road. Only to 0.68 of it, though: at half the look-ahead a heavy car at 55 m/s snaps
    // into oversteer trying to obey, and then it is off the road on the OTHER side.
    const aimDist = clamp(10 + speed * 0.72, 12, 62) * lerp(1, 0.68, this.offRec);
    // the point on the main route, always computed: it is also what a shortcut hands back to
    let wantLat = clamp(this.lineAt(u + aimDist / t.length, speed) + this.passOff + this.avoid * 0.5
      + (this.lensAvoid || 0), -0.80, 0.80);
    // Stay off the barriers: past the kerb the line target is pulled hard back inside. This
    // starts at 0.58 rather than 0.75 of the half-width because by the time a car at 70 m/s has
    // NOTICED it is at 0.75 it has already put two wheels on the kerb — measured, the field was
    // spending 5–13 s a race off the road and collecting three or four barrier hits each.
    if (!onBranch && Math.abs(lateral) > 0.58) {
      wantLat = lerp(wantLat, Math.sign(lateral) * 0.08, smoothstep(0.58, 1.00, Math.abs(lateral)));
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
      let bLat = clamp(this.lineBias * 0.22 + this.passOff * 0.35 + this.avoid * 0.4, -0.5, 0.5);
      // …and the same track-limits correction the street gets. A shortcut ribbon is a third the
      // width of the road, so a car that is 0.6 of the way to its edge is about to be in the wall.
      if (this.branch && Math.abs(lateral) > 0.42) {
        bLat = lerp(bLat, 0, smoothstep(0.42, 0.95, Math.abs(lateral)));
      }
      _v.copy(bs.pos).addScaledVector(bs.right, bLat * cut.halfWidth);
      let w = 1 - smoothstep(0.78, 0.99, bt);
      if (!this.branch) {
        // STILL ON THE STREET. The shortcut is a line to aim at only once it is close enough to
        // reach without leaving the road. Round 2 aimed at the ribbon the moment the decision was
        // taken — up to 90 m out — and because the mouth sits off to one side of the street that
        // meant driving off the street to get to it. Measured with tools/_race_off.mjs: the worst
        // offender's three longest excursions of the race were all 1.3–2.6 s at the same two
        // shortcut mouths, all with `wantBranch` set and `branch` still null, and together they
        // were 60 % of the field's entire off-track time. Fade the aim in over the last 55 m.
        const dm = wrapDelta(u, cut.enterU) * t.length;
        w *= smoothstep(55, 8, dm);
      }
      targetPos.lerp(_v, clamp(w, 0, 1));
    }

    _v2.copy(targetPos).sub(b.pos);
    let angle = Math.atan2(fwd.x * _v2.z - fwd.z * _v2.x, fwd.x * _v2.x + fwd.z * _v2.z);
    if (mistake === 2) angle += Math.sin(this.time * 5.5) * 0.045;  // a wobble

    // Counter-steer. Below the drift threshold the slip term is a damper that keeps the car from
    // weaving; once they are genuinely sideways it flips sign and becomes real opposite lock, so
    // an opponent holding a slide holds it with its wheels crossed up like the player's does.
    // …and the opposite lock now arrives while the slide is still catchable. At round 2's
    // threshold (0.30–0.70 of drift) a car sitting at 0.48 had almost no counter-steer at all: it
    // simply scrubbed sideways down the road at 14° of slip, which is both slow and the "nobody is
    // really driving" read §6.10 rules out.
    const slipK = lerp(-0.65, 0.75, smoothstep(0.18, 0.55, b.drift));
    let steer = clamp(-angle * lerp(1.7, 2.2, this.skill) * lerp(1, 1.18, this.offRec)
      + b.slip * slipK, -1, 1);

    // ------------------------------------------------------------ pedals
    const err = target - speed;
    let throttle = err > 0 ? clamp(0.28 + err * 0.5, 0, 1) : 0;
    let brake = err < -1.0 ? clamp(-err * 0.085, 0, 1) : 0;
    // TRACTION MANAGEMENT — a driver in a car that is stepping its tail out LIFTS.
    //
    // Round 2's driver did not, and on the drift-happy classes that produced a runaway: below
    // target → full throttle → power oversteer → 28 % less lateral grip (the drift term in latG
    // above) → further below target → more throttle. Measured over a three-lap NYC race, the two
    // muscle cars ran a mean drift of 0.48 and a mean slip angle of 14° for the ENTIRE race at
    // 0.67 mean throttle, averaging 106 mph against their own 121 mph target, and lapped in 50 s
    // against the supercars' 38. The supercars, which do not power-oversteer, sat exactly on
    // target. This one line is the largest single reason the field used to string out over half a
    // lap, and it costs the spectacle nothing: the deliberate slides below (`flick`, the power-on
    // apex) are applied afterwards with Math.max, so a driver showing off still shows off.
    // The signal is `body.drift`, NOT the raw slip angle. Slip is not comparable between classes:
    // the muscle car's tyres make their peak grip at 0.155 rad and the SUV's at 0.195, so a fixed
    // threshold in radians throttles the muscle back to 37 % while it is merely cornering properly
    // (measured: mean throttle 0.40, mean speed 114 mph against its own 123 mph target, 45 s laps
    // against the supercars' 40). `drift` is already normalised per class by driftOn/driftFull in
    // handling.js, so 0.22 means "past the point where this particular car is sliding" for all four.
    // The threshold is a fraction of the class's own peak-grip slip angle (`alphaPeak` in
    // handling.js — 0.100 rad for the supercar, 0.195 for the SUV), because slip is not comparable
    // between classes: an absolute threshold either throttles the lazy-tyred cars back while they
    // are merely cornering properly, or lets the twitchy ones spin their rears up unchecked. Both
    // were measured; this is the version that puts the muscle cars on 44 s laps instead of 49.
    const aPeak = p.alphaPeak || 0.15;
    // …and HOW MUCH a good driver is allowed to leave the traction management alone is a property
    // of the CAR as well as the hands. A supercar at 97 % skill holding a few degrees of slip is
    // driving; 2.5 tonnes at 97 % skill holding the same slip is a truck on its way to the
    // scenery — measured, the SUV was throwing 20 s of a 163 s race away off the road with eight
    // barrier hits, more than the rest of the field put together, and this was most of it.
    const tcSkill = this.skill * lerp(1, 0.55, smoothstep(1600, 2500, p.mass || 1500));
    const tc = 1 - smoothstep(aPeak * 0.55, aPeak * 1.8, Math.abs(b.slip)) * lerp(0.88, 0.62, tcSkill);
    throttle *= tc;
    if (mistake === 1) throttle *= 0.30;                            // fumbled it
    if (this.finished) { throttle *= 0.3; }
    // ---- the start. On the grid the field sits on the brakes and BLIPS the throttle: eight
    // engines at different points in their own rev cycle is what a start line sounds and looks
    // like, and the round-1 version stood in silence with the reaction timer already ticking, so
    // by the time the lights went out every reaction had expired and all eight launched on the
    // same frame.
    if (ctx.racing === false) {
      const rev = 0.5 + 0.42 * Math.sin(this.time * (5.5 + this.aggression * 3) + this.revPhase);
      throttle = (ctx.countdown ?? 9) < 2.6 ? rev : rev * 0.45;
      brake = 1; steer = 0;
    } else if (this.launchT > 0) {
      // reaction time off the line — eight cars do not leave on the same frame
      this.launchT -= dt;
      throttle = 0.62; brake = 1; steer = 0;
      if (this.launchT <= 0) this.launchSpin = this.rng.range(0.5, 1.1);
    } else if (this.launchSpin > 0) {
      // and they leave it lit: full throttle out of the box, which the tyre model turns into
      // wheelspin, smoke and a squirming car for the first second of the race
      this.launchSpin -= dt;
      throttle = 1; brake = 0;
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
    } else if (AI_TUNE.flick && !this.branch && tight > 0.55 && this.flickCool <= this.onScreen * 4.5
      && speed > 22 && speed < 42 && !this.finished && this.offRec < 0.15
      && this.slideLove > 0.35 && Math.abs(lateral) < 0.50 && err > -3 && ctx.racing !== false) {
      // SHOWTIME: the cooldown is discounted by however plainly the player can see this car, so a
      // driver who would have flicked one in somewhere out on the far side of the lap does it
      // HERE, two lengths off the player's bumper, where §6.10 wants the spectacle.
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
    if (AI_TUNE.slide && tight > 0.35 && speed > 16 && this.slideLove > 0.3 && err > -2
      && this.offRec < 0.2 && Math.abs(lateral) < 0.5 && b.drift < 0.55) {
      // the same showtime bias again: a car the player is watching leans on it harder
      throttle = Math.max(throttle, lerp(0.25, 0.85, this.slideLove + this.onScreen * 0.35) * tight * tc);
    }

    // ------------------------------------------------------------ nitrous
    // Straight-line, out of a corner, and much more likely when there is someone to pass or
    // someone to hold off. Same state machine and same tank rules the player lives under.
    this.boostCool -= dt;
    this.tankT += dt;
    // How much clear road there is, measured over the distance the BOOST will actually cover.
    // Round 2 looked a flat 190 m ahead, which is 2.0 s at 95 m/s — and 95 m/s is exactly what a
    // 2.5 tonne SUV reaches on a bottle. It lit the nitrous, could not see the corner at the end
    // of the straight, and arrived at it 30 m/s too fast: the two SUVs were the only cars in the
    // field with double-digit off-track times (16–24 s a race, 7–10 barrier hits) and every one of
    // their excursions was at the end of a boost.
    // …and the reach is now the car's OWN stopping distance from the speed the bottle will carry
    // it to, not a flat multiple of current speed. Those are the same number for a supercar and
    // very different ones for a 2.5 tonne car with the weakest brakes in the field: measured, the
    // SUV's off-track time was 9.7 s with the opponents' nitrous ablated and 19.7 s with it on,
    // and every one of the excursions was at the end of a boost.
    const vBoost = speed * 1.30;
    const nosReach = clamp(70 + (vBoost * vBoost) / (2 * Math.max(6, decel)), 180, 460);
    let straightAhead = 1;
    for (let d = 20; d < nosReach; d += nosReach / 9) {
      straightAhead = Math.min(straightAhead, 1 - smoothstep(0.006, 0.020, Math.abs(t.turnRate(u + d / t.length))));
    }
    let wantBoost = this.nitro.active;
    if (!wantBoost && this.boostCool <= 0 && !this.finished && ctx.racing !== false && AI_TUNE.nitro) {
      const duel = (blockAhead && blockDist < 32 ? 0.55 : 0) + (behindClose && behindDist < 20 ? 0.35 : 0);
      // and the same showtime bias as the handbrake: a bottle fired on the far side of the lap is
      // spent, a bottle fired in front of the player is the reference frame
      // …but only two plumes are ever lit in shot at once. Three or four cars boosting in the same
      // frame is not more spectacular, it is a fireworks display, and it costs ~5 fps of fill.
      const show = (ctx.boostBudget ?? 0) < 2 ? this.onScreen * 0.55 : 0;
      const desire = straightAhead
        * (0.30 * this.boostEager + duel + Math.max(0, this.band) * 0.30 + show);
      if (speed > p.topSpeed * 0.45 && b.drift < 0.45 && this.offRec < 0.2
        && this.rng.bool(clamp(desire, 0, 1) * dt * 2.6)) {
        wantBoost = true;
        this.boostCool = this.rng.range(2.5, 7.0) * lerp(1.5, 0.7, this.boostEager);
      }
    }
    // Lift for the corner — and lift NOW, not after the half-second minimum, if the car is already
    // well over the speed its own corner solve says it can carry. A bottle is worth a place; a
    // bottle held through the braking zone is worth a barrier.
    // …and a heavy car lifts sooner: 7 m/s over its own corner solve is a supercar still inside
    // its brakes and an SUV already past them.
    const overLift = lerp(7, 3.5, smoothstep(1600, 2500, p.mass || 1500));
    if (wantBoost && ((straightAhead < 0.30 && this.nitro.t > 0.4) || err < -overLift)) wantBoost = false;
    this.nitro.update(dt, wantBoost, { moving: speed > 4 });
    // THE SAME NITROUS ECONOMY THE PLAYER LIVES UNDER. Opponents refill their tanks by driving
    // over the city's boost pads, on exactly main.js's rule — same u window, same lateral window,
    // same one-tank-per-pass. Round 1 handed them a tank every seven seconds on a timer, which is
    // both unlimited nitrous and (measured) a large part of why a reference-quality lap finished
    // dead last: an opponent was spending eight bottles a lap against the player's three.
    if (ctx.pads) {
      for (let i = 0; i < ctx.pads.length; i++) {
        const bp = ctx.pads[i];
        if (Math.abs(((u - bp.u + 0.5) % 1) - 0.5) > 0.006) continue;
        if (Math.abs(lateral - (bp.lateral ?? 0)) > 0.5) continue;
        if (this._padI === i && this.tankT < 3) continue;
        this._padI = i; this.tankT = 0;
        this.nitro.addTank();
        break;
      }
    } else if (this.nitro.tanks === 0 && this.nitro.charge > 0.98 && this.tankT > 26) {
      this.nitro.addTank(); this.tankT = 0;      // a city with no pads at all: a slow trickle
    }

    // ------------------------------------------------------------ integrate
    const offTrack = Math.abs(lateral) > 1.05 && !junction;
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

    // A CAR ON A GRID DOES NOT MOVE. The brake is a force, and a force cannot hold a stationary
    // car on a slope, so a field left to the physics for four seconds of countdown rolls: measured
    // on the LA grid, the pack had crept 60–80 m up the road before the lights went out and the
    // start was a photograph of an empty box. Held here, on the slot they were placed on, so the
    // engines can blip and the launch is still a launch.
    if (ctx.racing === false && this.gridPos) {
      b.pos.copy(this.gridPos);
      b.vel.set(0, 0, 0);
      b.speed = 0; b.groundSpeed = 0; b.yawRate = 0; b.yaw = this.gridYaw;
      b.drift = 0; b.slide = 0; b.slip = 0;
    }

    // ------------------------------------------------------------ barriers
    // Exactly the player's rule (main.js): opponents hit the same walls, lose the same speed and
    // recover the same way. Round 1 lerped them back onto the road when they ran wide, which is
    // the "driving on rails" tell §6.10 explicitly calls out.
    const wallAt = 1.52;
    this.wallHit = 0;
    if (Math.abs(lateral) > wallAt && !junction) {
      _v3.copy(sample.right).multiplyScalar(-Math.sign(lateral));
      // push back along the LATERAL axis only — rebuilding the position from the sample's
      // cross-section throws the along-track component away, and a car held against a barrier is
      // then re-snapped onto the same cross-section every frame and never moves again
      const over = (Math.abs(lateral) - wallAt) * halfWidth;
      b.pos.addScaledVector(_v3, over);
      const s = b.impact(_v3, 0.26, 0.58);
      if (s > 0.05) this.hits++;
      // hand the contact to updateVisuals: an opponent grinding a barrier in front of the player
      // has to throw the same shower the player's car does, or the world has two rule sets
      this.wallHit = Math.max(s, speed > 7 ? 0.02 : 0);
      this.wallN.copy(_v3);
      this.wallPt.copy(sample.pos)
        .addScaledVector(sample.right, Math.sign(lateral) * halfWidth * wallAt)
        .addScaledVector(_v3, -0.2).setY(0.42);
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
    this.countdown = COUNTDOWN;
    this.phase = 'grid';          // grid | set | go | racing | final | flag
    this.events = [];             // race announcements; main.js pumps these into the HUD banner
    this.fieldPace = START_PACE;  // the invisible slow hand on the whole field — see _pace()
    this.finalLap = false;
    this.playerFinishPos = null;
    // THREE CLOCKS, and every one of them exists because the other two cannot do its job.
    //
    //   time     the RACE clock — what the HUD shows and what the record is measured against. It
    //            STOPS at the chequered flag, so it is useless for stamping anybody who finishes
    //            after the player.
    //   raceTime the CLASSIFICATION clock — zero on the green, never stops. Every finishing time
    //            in the results, the player's and all seven opponents', is stamped from this one.
    //   wall     the monotonic sim clock, zero on the GRID. It runs through the countdown, so it
    //            is right for internal cooldowns (the per-pair contact timer, the order dwell) and
    //            wrong for anything anybody is ever shown.
    //
    // Round 3 stamped the opponents from `wall` and the player from `time`, and the two are
    // COUNTDOWN (4.4 s) apart. Every opponent's finishing time was therefore 4.4 s later than the
    // player's for the same moment on the road, `_order()` sorts finishers by finishing time, and
    // so the player was classified ahead of every car that had actually beaten them: measured in
    // LA, seven opponents crossed between 190.0 s and 192.2 s, the player at 194.3 s, and the
    // results table read YOU 1st. The game could not be lost. This is that bug's fix.
    this.time = 0;
    this.raceTime = 0;
    this.wall = 0;
    this.playerFinished = false;  // the player has completed the distance (NOT "the race is over")
    this.dnf = false;             // the flag fell with the player still out on the road
    this.winnerTime = null;       // raceTime at which the first car completed the distance
    // The record, and whether it is still live. §6.7's TIME TO BEAT counts down against this; the
    // director owns the consequence of it reaching zero.
    this.record = parseRecord(cityDef?.record);
    this.overRecord = false;
    this.recordBeaten = null;
    // Backstop: if NOBODY finishes — every car beached, the player parked — the race still ends.
    // Roughly four times a very slow lap, so it can never fire on a race anyone is still driving.
    this.timeout = 60 + this.laps * clamp((track?.length ?? 2500) / 18, 60, 220);
    this.flagT = 0;               // seconds since the chequer
    this._classified = false;     // once true the standings order is the frozen classification
    this._orderNames = null;      // last frame's displayed order, for the hysteresis in _order()
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
    this.playerContacts = 0;
    this.reforms = 0;
    this._lastPlayerPos = null;
    this._playerCounter = new Progress(0);
    this._traffic = [];
    this._pairT = new Map();      // per-pair contact cooldown, so a rub is one knock not sixty
    this._viewFwd = new THREE.Vector3(0, 0, 1);
    this._paceErr = 0;            // filtered mean station error of the field — see _pace()
    this._lastRank = null;
    this._playerEntry = {
      driver: null, isPlayer: true, pos: new THREE.Vector3(), speed: 0, progress: 0, name: 'YOU',
    };

    // THE FIELD'S COMPOSITION IS A DIRECTOR'S DECISION, not a round-robin. Round 2 dealt the four
    // classes out in order, which put TWO 2.5-tonne SUVs in a seven-car field: measured over full
    // races in LA and NYC they lapped 6–8 s off the supercars and spent 13–17 s a race off the
    // road, and they were most of the reason the back of the field was half a lap adrift with an
    // empty road behind the player. One is a lifted truck in the pack — which is exactly what the
    // reference has (§1.2). Two is a procession. All four classes are still on the grid.
    const ids = ['supercar', 'tuner', 'muscle', 'supercar', 'tuner', 'suv', 'supercar'];
    const picks = [];
    for (let i = 0; i < opponents; i++) {
      const vid = ids[i % ids.length] && VEHICLE_IDS.includes(ids[i % ids.length])
        ? ids[i % ids.length] : VEHICLE_IDS[(i + 1) % VEHICLE_IDS.length];
      picks.push({ i, vid, v: getVehicle(vid) });
    }
    // WHO IS DRIVING WHAT. Round 3 dealt the skill ladder out on grid index, which put its two
    // best drivers (0.91 and 0.96) in the tuners — the quickest thing round a street circuit —
    // and left the lifted truck with a mid-field one. Ability compounded: HAN finished last in
    // every race, 822 m adrift at the LA flag, and never changed places with anybody all race.
    //
    // A race director casts the other way round. The heavy, low-grip cars get the BEST drivers and
    // the fast ones get the rookies, which is both a better story (the guy in the truck is the one
    // to watch) and the thing that turns four classes with a 5 s-a-lap spread into a field that
    // finishes within a few seconds of each other. It is not a cheat: every car still drives on
    // its own tyres, brakes and top speed — only the hands are dealt differently. A little jitter
    // keeps it off a perfect anti-correlation, which would read as scripted.
    const ability = (v) => {
      const ph = v.spec.physics;
      return Math.pow((ph.topSpeed || 74) / 74, 0.5)
        * Math.pow(((ph.gripFront + ph.gripRear) * 0.5) * (1 + (ph.downforce ?? 0) * 0.55) / 1.40, 0.7);
    };
    const byClass = picks.slice().sort((a, b) => ability(b.v) - ability(a.v));
    byClass.forEach((pk, k) => {
      pk.skill = clamp(0.66 + (k / Math.max(1, opponents - 1)) * 0.30 + this.rng.range(-0.04, 0.04), 0.60, 0.97);
    });
    for (const pk of picks) {
      const d = new AIDriver(pk.i, track, pk.v.spec, {
        dims: pk.v.blueprint.dims,
        skill: pk.skill,
        lineOffset: this.rng.range(-0.55, 0.55),
      });
      d.vehicleId = pk.vid;
      this.drivers.push(d);
    }
  }

  // ---------------------------------------------------------------- grid

  /**
   * Two-by-two staggered grid running back from the start line. The player takes the last slot —
   * the reference always has you fighting forward through the pack.
   */
  grid(spawnU) {
    this.startU = wrap01(spawnU);
    const L = this.track.length;
    const n = this.drivers.length + 1;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2), col = i % 2 ? 0.42 : -0.42;
      rows.push({ u: wrap01(spawnU - (row * 6.6 + 5.5) / L), lateral: col });
    }
    // The grid is ordered on the same skill×top-speed ranking that decides the natural race order,
    // so pole is a car that deserves it, and the player starting last has a field in front of them
    // that thins out as it strings — not a shuffle that reverses itself in one corner.
    const order = this.drivers.slice().sort((a, bb) =>
      (bb.spec.physics.topSpeed * bb.skill) - (a.spec.physics.topSpeed * a.skill));
    order.forEach((d, i) => {
      d.spawn(rows[i].u, rows[i].lateral, 0, -1);
      d.launchT = d.reaction;
      d.launchSpin = 0;
      d.station = (rows.length - 1 - i) * 6.6;   // the gap they start with, so the band idles at zero
    });
    const slot = rows[rows.length - 1];
    this._playerCounter.reset(slot.u, -1);
    this.playerU = this._playerCounter.u;
    this.playerProgress = this._playerCounter.progress;
    this._holdP = null;
    // Remember where the player is *expected* to be. main.js drops them on this slot immediately
    // after; anything else is a teleport (the capture harness placing the car at a chosen u) and
    // the pack has to re-form around it or the frame is an empty road.
    const ps = this.track.at(slot.u);
    this._lastPlayerPos = ps.pos.clone().addScaledVector(ps.right, slot.lateral * this.track.halfWidth);
    this.state = 'countdown';
    this.countdown = COUNTDOWN;
    this.phase = 'grid';
    this.time = 0;
    this.raceTime = 0;
    this.wall = 0;
    this.flagT = 0;
    this._classified = false;
    this._orderNames = null;
    this.lapTime = 0;
    this.playerLap = 0;
    this.results = null;
    this.finalLap = false;
    this.playerFinishPos = null;
    this.playerFinished = false;
    this.dnf = false;
    this.winnerTime = null;
    this.overRecord = false;
    this.recordBeaten = null;
    this._finishPending = false;
    this.finishTime = null;
    this.lapTimes = [];
    this.events.length = 0;
    this.fieldPace = START_PACE;
    this._paceErr = 0; this._lastRank = null; this._heldRank = null; this._shoutRank = null;
    this._order();
    return slot;
  }

  /** Queue a race announcement. main.js hands these to the HUD banner. */
  _event(text, hold = 1.6, color = '#ffd24a') {
    if (this.events.length > 3) this.events.shift();
    this.events.push({ text, hold, color });
  }

  /** main.js drains this once a frame. */
  takeEvents() {
    if (!this.events.length) return null;
    const e = this.events.slice();
    this.events.length = 0;
    return e;
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

    // The pack re-forms ONTO ITS STATIONS — the same numbers the band holds during a race — so a
    // resumed race is already in equilibrium and nothing is quietly closing or dropping away in
    // the seconds after it. Five ahead, the rest behind, staggered across the road. The FASTEST
    // cars take the near slots: put a slow one on your bumper and you are past it inside three
    // seconds and the frame is an empty road again.
    const nAhead = Math.min(this.drivers.length, 5);
    const order = this.drivers.slice().sort((a, bb) =>
      (bb.spec.physics.topSpeed * bb.skill) - (a.spec.physics.topSpeed * a.skill));
    for (let i = 0; i < order.length; i++) {
      const d = order[i];
      const front = i < nAhead;
      const dist = front ? AHEAD_SLOTS[i] : BEHIND_SLOTS[(i - nAhead) % BEHIND_SLOTS.length];
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
      d.launchSpin = 0;
      d.band = 0;
      d.trim = 0;
      d.station = front ? dist : -dist;
    }
    this._lastPlayerPos = playerBody.pos.clone();
    this.reforms++;
    // a resumed race is a race again: the classification is not frozen and the order restarts from
    // the new geometry rather than dragging last race's hysteresis through the teleport
    this._classified = false;
    this._orderNames = null;
    // …and nobody has finished it yet. `spawn()` above has already cleared every driver's finish
    // flag; leaving the director's copies set would flag the resumed race on its first frame.
    this.playerFinished = false;
    this.dnf = false;
    this.winnerTime = null;
    this._finishPending = false;
    this._order();
    return this;
  }

  // ---------------------------------------------------------------- visuals

  /**
   * Hand the director the built opponent cars so it can drive their nitrous plumes, smoke and
   * rubber. Called by main.js right after it builds them.
   */
  attachCars(cars, { effects = null, scene = null } = {}) {
    this.cars = cars;
    this.effects = effects;
    if (scene) this.buildStartLine(scene);
    const box = new THREE.Box3();
    for (let i = 0; i < this.drivers.length && i < cars.length; i++) {
      const d = this.drivers[i];
      const car = cars[i];
      d.car = car;
      // THE CAR'S REAL HULL, measured off the built mesh before the plume is hung on it. The
      // blueprint `dims` are the design envelope and the bodywork is not inside them: a supercar
      // whose `dims.height` says 1.25 has its roof at 1.51 and the SUV's says 2.08 against a real
      // 2.44. `_lensClear` is a test against a 0.30 m near plane — it has to use the geometry
      // that actually gets clipped, and using `dims` is exactly how a car with 0.21 m of real
      // clearance measured as having 0.47 m and was left alone.
      car.updateMatrixWorld(true);
      box.setFromObject(car);
      const bd = car.userData?.dims || d.dims;
      if (box.isEmpty()) d.hull = null;
      else {
        d.hull = {
          // …clamped in plan to the blueprint plus a margin, because the group also carries the
          // car's contact-shadow plane and that is wider than the car. The ROOF is taken straight
          // off the mesh: that is the dimension the lens actually meets, and the one `dims` lies
          // about (supercar 1.25 declared, 1.51 real; SUV 2.08 declared, 2.44 real).
          hl: Math.min(Math.max(1.5, (box.max.z - box.min.z) * 0.5), (bd.length ?? 4.6) * 0.5 + 0.8),
          hw: Math.min(Math.max(0.7, (box.max.x - box.min.x) * 0.5), (bd.width ?? 2.0) * 0.5 + 0.8),
          top: Math.max(0.9, box.max.y - car.position.y),
        };
      }
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
    // WHERE THE LENS IS, kept as an OFFSET FROM THE PLAYER rather than as a world position.
    // main.js runs the chase rig at the end of its frame, after the race, so a world position read
    // here is two frames stale — 1.4 m of road at 42 m/s, which is more than the whole clearance
    // `_lensClear` is trying to hold and enough to send its push the wrong way. The rig rides the
    // player, so the OFFSET is what is slowly varying and the player's own position is exact.
    if (camPos) {
      (this._camPos || (this._camPos = new THREE.Vector3())).copy(camPos);
      // `camPos` is the rig as it stood at the END of the PREVIOUS frame, so the offset has to be
      // taken against the player position of that same frame — subtracting THIS frame's player
      // position gives back the stale world position with extra steps, which is exactly the bug
      // this was meant to fix (the guard then reads a metre of clearance on the frame the car is
      // actually inside the lens).
      if (this._camPlayerPrev) {
        (this._camOff || (this._camOff = new THREE.Vector3())).copy(camPos).sub(this._camPlayerPrev);
      }
      (this._camPlayerPrev || (this._camPlayerPrev = new THREE.Vector3()))
        .copy(this._lastPlayerPos || camPos);
    }
    for (const d of this.drivers) {
      const b = d.body;
      if (d.jet) {
        if (d.nitro.justFired) d.jet.ignite();
        d.jet.update(dt, d.nitro.flame, {
          speed: Math.abs(b.speed), camera, surge: d.nitro.surge, ramp: d.nitro.ramp,
        });
      }
      if (!camPos) continue;
      // NEAR-PLANE CULL — see LENS_CULL. `_lensClear` keeps this from happening at all in almost
      // every frame; this is what stops the one it cannot win (a car being lapped as the rig
      // sweeps over it) from rendering inside out.
      if (d.hull) {
        const px = camPos.x - b.pos.x, py = camPos.y - b.pos.y, pz = camPos.z - b.pos.z;
        const f = b.forward, r = b.right;
        const lz = px * f.x + pz * f.z, lx = px * r.x + pz * r.z;
        const ex = Math.max(0, Math.abs(lx) - d.hull.hw);
        const ez = Math.max(0, Math.abs(lz) - d.hull.hl);
        const ey = Math.max(0, Math.max(-py, py - d.hull.top));
        const want = Math.hypot(ex, ey, ez) >= LENS_CULL;
        if (d.car && d.car.visible !== want) d.car.visible = want;
      }
      if (!fx) continue;
      const dist = b.pos.distanceTo(camPos);
      if (dist > 130) continue;
      // An opponent grinding a barrier throws the same shower the player's car does. Without it
      // the world has two rule sets — one where hitting a wall is an event and one where a car
      // silently slides along it — and the second one is the "driving on rails" read (§6.10).
      if (d.wallHit > 0.015) {
        if (d.wallHit > 0.24) fx.crash(d.wallPt, d.wallN, d.wallHit * 0.8, { vel: b.vel });
        else if (d.wallHit > 0.05) fx.sparkBurst(d.wallPt, d.wallN, d.wallHit * 0.6, { vel: b.vel });
        else fx.wallScrape(d.wallPt, d.wallN, b.vel, clamp((Math.abs(b.speed) - 6) / 26, 0, 1) * 0.8);
      }
      const slide = clamp(b.slide ?? b.drift, 0, 1) * smoothstep(4, 13, Math.abs(b.speed));
      // a standing start is the one time a car is sliding at walking pace, and the smoke off the
      // line is half of what a grid start looks like
      const launch = d.launchSpin > 0 ? 0.85 : 0;
      if (slide < 0.16 && !launch) {
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
        fx.skid.add(`ai${d.id}${s < 0 ? 'L' : 'R'}`, _v, rgt, 0.30, clamp(Math.max(slide, launch) * 1.5, 0, 1));
        if (d.smokeTick % 5 === 0 && Math.max(slide, launch) > 0.3) {
          fx.tyreSmoke(_v, b.vel, Math.max(slide, launch) * 0.5 * (0.35 + 0.65 * near),
            b.surface === 'dirt' ? 'dirt' : 'road');
        }
      }
      d._skidOn = true;
    }
  }

  /** Release the plumes and the start/finish line before main.js disposes the opponent cars. */
  detachCars() {
    if (this.lineGroup) {
      this.lineGroup.removeFromParent();
      for (const o of this._lineJunk) o.dispose?.();
      this.lineGroup = null;
      this._lineJunk = null;
      this._lineAnim = null;
    }
    if (!this.cars) return;
    for (const c of this.cars) {
      if (c) c.visible = true;                 // undo any near-plane cull before handing them back
      if (!c?.userData?.jet) continue;
      c.userData.jet.group.removeFromParent();
      c.userData.jet.dispose();
      c.userData.jet = null;
    }
    this.cars = null;
  }

  // ---------------------------------------------------------------- the start/finish line
  //
  // §6.10 wants "a real start and finish sequence". Round 2 had the state machine and the HUD for
  // one, and NOTHING IN THE WORLD: no line on the road, no gantry, no chequer — a grep of all four
  // cities turned up no start/finish geometry at all, so the frame in which the race began and the
  // frame in which it ended were the same photograph of an anonymous street. It lives here rather
  // than in a city because every city needs exactly one and none of them owns the concept.
  //
  // Everything is generated: the chequer is a canvas, the lettering is the project's own vector
  // font, the steel is boxes and cylinders. It is one draw call for the road strip, one for the
  // steelwork and a handful for the lit parts.

  /** Build the chequered line, its gantry and its light tree at the grid's start position. */
  buildStartLine(scene) {
    if (!scene || this.lineGroup) return this;
    const t = this.track;
    const L = t.length;
    const u0 = this.startU ?? 0;
    const half = t.halfWidth;
    const g = new THREE.Group();
    const junk = [];
    const anims = [];
    const keep = (x) => { junk.push(x); return x; };

    // ---- chequer canvas, shared by the road strip, the gantry banner and the marshals' flags
    const chq = keep(this._chequerTexture(2));

    // ---- the line itself, built from track samples so it lies in the road's own cross-section
    //      on a bend or a crown instead of floating as a flat quad.
    {
      const segs = 12, depth = 5.0;
      const pos = [], nrm = [], uv = [], idx = [];
      // one TILE is a 2×2 chequer, so this is half the cell count across the road. ~1.15 m cells:
      // finer than that and the strip reads as a grey band at any distance.
      const cells = Math.max(4, Math.round((half * 2.06) / 2.3));
      for (let i = 0; i <= segs; i++) {
        const s = t.at(wrap01(u0 + (-depth * 0.5 + (i / segs) * depth) / L));
        for (let k = 0; k <= 1; k++) {
          const lat = k ? 1.03 : -1.03;
          _v.copy(s.pos).addScaledVector(s.right, lat * half);
          // 14 mm of lift plus a polygon offset. Either alone leaves a chequer that shimmers
          // against the asphalt at distance, which is the §7 z-fighting tell.
          pos.push(_v.x, _v.y + 0.014, _v.z);
          nrm.push(0, 1, 0);
          uv.push(k * cells, (i / segs) * 2);
        }
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const geo = keep(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      // A painted line under a night grade goes to mud. A LOW emissive — well under the ~0.6 bloom
      // threshold, so it does not glow — keeps the white reading as white in every city's light
      // without turning the road marking into a light source.
      const mat = keep(new THREE.MeshStandardMaterial({
        map: chq, emissiveMap: chq, emissive: 0xffffff, emissiveIntensity: 0.34,
        roughness: 0.42, metalness: 0.0, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      g.add(new THREE.Mesh(geo, mat));
    }

    // ---- the gantry. Local space: +Z down the road, +X to track right.
    const s0 = t.at(u0);
    const post = half + 1.9;
    const H = 7.4;
    const steelGeo = [];
    const box = (w, h, d, x, y, z, rz = 0) => {
      const bg = new THREE.BoxGeometry(w, h, d);
      bg.rotateZ(rz); bg.translate(x, y, z);
      steelGeo.push(bg);
    };
    for (const sx of [-1, 1]) {
      const cg = new THREE.CylinderGeometry(0.24, 0.34, H, 10);
      cg.translate(sx * post, H / 2, 0);
      steelGeo.push(cg);
      box(1.7, 0.36, 1.7, sx * post, 0.18, 0);
      box(0.9, 0.26, 0.9, sx * post, H - 0.5, 0);
    }
    box(post * 2 + 1.0, 0.46, 0.5, 0, H, 0);
    box(post * 2 + 0.7, 0.18, 0.18, 0, H - 0.95, 0);
    for (let i = -5; i <= 5; i++) box(0.13, 0.95, 0.13, i * (post / 5.2), H - 0.48, 0, i % 2 ? 0.52 : -0.52);
    // …plus every other static steel part of the structure: the three lamp hoods and the two flag
    // brackets. They share one material and never move, so they belong in the same merge — the
    // whole gantry is 6 draw calls (steel, banner ×2, 3 lamp lenses) plus 5 moving/lit parts, on a
    // frame that spends about a thousand.
    for (let i = 0; i < 3; i++) {
      const hg = new THREE.CylinderGeometry(0.56, 0.56, 0.30, 12, 1, true);
      hg.rotateX(Math.PI / 2);
      hg.translate((i - 1) * 1.55, H - 1.9, 0.05);
      steelGeo.push(hg);
    }
    for (const sx of [-1, 1]) box(0.5, 0.14, 0.14, sx * (post + 0.14), H * 0.60, 0.35);
    const steel = keep(mergeGeometries(steelGeo, false));
    for (const sg of steelGeo) sg.dispose();
    const steelMat = keep(new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.52, metalness: 0.78 }));
    g.add(new THREE.Mesh(steel, steelMat));

    // ---- the banner across the beam: chequer bands top and bottom, the words between them
    {
      const w = 1024, h = 224;
      const { c, ctx } = canvas(w, h);
      ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, w, h);
      const cell = 28;
      for (const bandY of [0, h - cell]) {
        for (let x = 0; x < w; x += cell) {
          ctx.fillStyle = ((x / cell) & 1) ? '#f2f5fb' : '#12151c';
          ctx.fillRect(x, bandY, cell, cell);
        }
      }
      ctx.strokeStyle = '#ff9214'; ctx.lineWidth = 5;
      ctx.strokeRect(6, cell + 6, w - 12, h - 2 * cell - 12);
      // ONE line of type. The first cut set START at the left, FINISH at the right and the city
      // name across the middle, and on a 22 m board seen from ten metres away in a chase camera
      // the three collided into "STARLOS A...NISH". The city is already named on the HUD.
      // (A middle dot is not in font.js's glyph table and renders as a zero — the slash is.)
      drawText(ctx, 'START / FINISH', {
        x: w * 0.5, y: h * 0.70, size: 96, weight: 0.20, italic: 0.20, align: 'center',
        color: '#f6fbff', tracking: 0.13, glow: { color: '#ffb020', blur: 26 },
      });
      grain(ctx, w, h, 5, this.rng);
      const tex = keep(toTexture(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping }));
      const bw = post * 1.25;
      const bg = keep(new THREE.PlaneGeometry(bw, bw * (h / w)));
      const bm = keep(new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.15,
        roughness: 0.55, side: THREE.FrontSide,
      }));
      // two single-sided faces back to back: a DoubleSide sign reads mirrored from behind
      for (const face of [0, Math.PI]) {
        const m = new THREE.Mesh(bg, bm);
        m.position.set(0, H + 0.35 + bw * 0.5 * (h / w), face ? -0.06 : 0.06);
        m.rotation.y = face;
        g.add(m);
      }
      this._bannerMat = bm;
    }

    // ---- the light tree: three lenses that go out one at a time on the countdown and turn green
    //      on the green. The HUD draws its own tree; this is the one in the world, and it is what
    //      makes the grid frame read as a START rather than as eight cars parked in a street.
    const lampGeo = keep(new THREE.SphereGeometry(0.46, 14, 10));
    const lampMats = [];
    for (let i = 0; i < 3; i++) {
      const m = keep(new THREE.MeshStandardMaterial({
        color: 0x2a0a0a, emissive: new THREE.Color(0xff2a1e), emissiveIntensity: 0.15, roughness: 0.35,
      }));
      lampMats.push(m);
      const lamp = new THREE.Mesh(lampGeo, m);
      lamp.position.set((i - 1) * 1.55, H - 1.9, 0.30);
      g.add(lamp);
    }
    this._lampMats = lampMats;

    // ---- marshals' flags on the posts. They hang still all race and are WAVED at the chequer,
    //      which is the moment §6.10 asks for and the one thing round 2 had nothing at all for.
    // Round 2's first cut hung the cloth off a 55 mm dark pole against a dark street and the flags
    // read as two checkerboards floating in mid-air. Now: a bright chromed pole with a visible
    // bracket back to the gantry leg, and the cloth on the end of it.
    const flagGeo = keep(new THREE.PlaneGeometry(1.9, 1.15, 8, 4));
    // three tiles across, two down — one 2×2 tile stretched over a whole flag reads as a white
    // plate with a corner missing, not as a chequer. (The texture itself is shared with the road
    // strip, whose UVs are baked, so the repeat has to live in the geometry.)
    {
      const uvA = flagGeo.attributes.uv;
      for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * 3, uvA.getY(i) * 2);
      uvA.needsUpdate = true;
    }
    const flagMat = keep(new THREE.MeshStandardMaterial({
      map: chq, roughness: 0.62, side: THREE.DoubleSide,
      emissiveMap: chq, emissive: 0xffffff, emissiveIntensity: 0.30,
    }));
    const chrome = keep(new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.30, metalness: 0.85 }));
    const poleGeo = keep(new THREE.CylinderGeometry(0.085, 0.085, 2.6, 8));
    const flags = [];
    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * (post + 0.30), H * 0.60, 0.35);
      const pole = new THREE.Mesh(poleGeo, chrome);
      pole.position.set(sx * 0.95, 0, 0);
      pole.rotation.z = Math.PI / 2;                     // the staff lies across, cloth hangs off it
      pivot.add(pole);
      const f = new THREE.Mesh(flagGeo, flagMat);
      f.position.set(sx * 1.9, -0.30, 0.02);
      pivot.add(f);
      g.add(pivot);
      flags.push({ pivot, sx, base: 0 });
    }
    this._flagMat = flagMat;

    // ---- beacons on the posts
    const beaconMat = keep(new THREE.MeshStandardMaterial({
      color: 0x3a2408, emissive: new THREE.Color(0xffb020), emissiveIntensity: 2.2, roughness: 0.4,
    }));
    const beaconGeo = keep(mergeGeometries([-1, 1].map((sx) => {
      const bg = new THREE.SphereGeometry(0.30, 10, 8);
      bg.translate(sx * post, H + 0.55, 0);
      return bg;
    }), false));
    g.add(new THREE.Mesh(beaconGeo, beaconMat));
    this._beaconMat = beaconMat;

    anims.push((time, st) => {
      // countdown: three lights come ON one at a time, then all three snap green on the green
      const cd = st.countdown;
      for (let i = 0; i < 3; i++) {
        const m = lampMats[i];
        if (st.state === 'countdown') {
          const lit = cd < (3.0 - i * 0.9);
          m.emissive.setHex(0xff2a1e);
          m.emissiveIntensity = lit ? 3.6 : 0.38;
        } else {
          m.emissive.setHex(0x3cff7a);
          // hold green bright for the first seconds of the race, then idle
          m.emissiveIntensity = st.state === 'finished'
            ? 0.5 + 2.9 * (0.5 + 0.5 * Math.sin(time * 9 + i * 1.1))
            : lerp(3.6, 0.55, smoothstep(0, 6, st.time));
        }
      }
      const flagging = st.state === 'finished';
      this._beaconMat.emissiveIntensity = flagging
        ? 1.2 + 3.6 * (0.5 + 0.5 * Math.sin(time * 11))
        : 1.4 + 1.0 * (0.5 + 0.5 * Math.sin(time * 2.2));
      this._flagMat.emissiveIntensity = flagging ? 0.9 + 0.9 * (0.5 + 0.5 * Math.sin(time * 8)) : 0.22;
      for (const f of flags) {
        const wave = flagging ? Math.sin(time * 7.5 + f.sx) * 0.85 : Math.sin(time * 0.9 + f.sx) * 0.05;
        f.pivot.rotation.z = f.base + wave;
        f.pivot.rotation.x = flagging ? Math.sin(time * 5.1 + f.sx * 2) * 0.35 : 0;
      }
    });

    g.position.copy(s0.pos);
    g.rotation.y = Math.atan2(s0.tan.x, s0.tan.z);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    scene.add(g);
    this.lineGroup = g;
    this._lineJunk = junk;
    this._lineAnim = anims;
    this._lineT = 0;
    return this;
  }

  /** A black/white chequer, `n`×`n` cells per tile, with a touch of dirt so it is not a plot. */
  _chequerTexture(n = 2) {
    const px = 128;
    const { c, ctx } = canvas(px * n, px * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = ((x + y) & 1) ? '#eef2f8' : '#14171d';
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
    grain(ctx, px * n, px * n, 16, new RNG(77));
    const tx = toTexture(c, { srgb: true, repeat: [1, 1] });
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    return tx;
  }

  /** Drive the gantry's lights and flags. Called once a frame from update(). */
  _animateLine(dt) {
    if (!this._lineAnim) return;
    this._lineT += dt;
    for (const a of this._lineAnim) {
      a(this._lineT, {
        state: this.state, phase: this.phase, countdown: this.countdown, time: this.time,
      });
    }
  }

  // ---------------------------------------------------------------- the frame

  update(dt, playerBody) {
    const t = this.track;

    // The chase camera's axis. Everything the band does is gated on whether the player can see
    // the car it is doing it to, and the camera is behind and aligned with the car, so the car's
    // own heading is the axis — one frame earlier than the rig, which does not matter at 60 Hz.
    this._viewFwd.copy(playerBody.forward);

    // -------------------------------------------------- start sequence
    // grid (1.4 s, engines idling and blipping) → lights (3 s, the HUD's tree) → GO. Each driver
    // then leaves on its own reaction time and lights the tyres up for the first second, so the
    // start is eight separate launches with smoke rather than one synchronised step.
    if (this.state === 'countdown') {
      this.wall += dt;
      this.countdown -= dt;
      const phase = this.countdown > 3.0 ? 'grid' : 'set';
      if (phase !== this.phase && phase === 'set') this._event('GET READY', 1.0, '#7ee7ff');
      this.phase = phase;
      // The player is held on their slot for the same reason the field is (see AIDriver.step):
      // main.js pins the brake during the countdown, but a brake is a force and the car still
      // rolls down the crown of the road. Left alone, the LA grid had the player doing 27 mph
      // before the lights had gone out.
      if (!this._holdP) this._holdP = playerBody.pos.clone();
      playerBody.pos.copy(this._holdP);
      playerBody.vel.set(0, 0, 0);
      playerBody.speed = 0; playerBody.groundSpeed = 0; playerBody.yawRate = 0;
      // …and localise them, so the position deck reads the grid order from the first frame rather
      // than showing the car at the back of the grid running first of eight
      const pn = t.nearest(playerBody.pos, this.playerU || null);
      this.playerLateral = pn.lateral;
      this._playerCounter.advance(wrap01(pn.u), 0);
      this.playerU = this._playerCounter.u;
      this.playerProgress = this._playerCounter.progress;
      for (const d of this.drivers) {
        d.step(dt, {
          racing: false, rivals: this._traffic, time: this.raceTime, laps: this.laps,
          countdown: this.countdown, viewPos: playerBody.pos, viewFwd: this._viewFwd,
        });
        d.body.brakeLit = true;
      }
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = 'racing';
        this.phase = 'go';
        this._holdP = null;
        for (const d of this.drivers) {
          d.launchT = d.reaction; d.launchSpin = 0; d.gridPos = null;
          // NOBODY SPENDS A BOTTLE ON THE RUN TO TURN ONE. Left to the general boost logic the
          // whole field lit up on the green — seven cars through 240 mph inside six seconds, 200 m
          // clear of a player still in third gear, and a first lap with an empty road in it. They
          // save it for the open road, on their own staggered timers.
          d.boostCool = d.rng.range(7, 16);
        }
      }
      this._lastPlayerPos = this._lastPlayerPos || playerBody.pos.clone();
      this._lastPlayerPos.copy(playerBody.pos);
      this._order();
      this._animateLine(dt);        // the gantry's light tree IS the countdown
      return;
    }

    // THE CLOCKS — see the constructor. `time` stops at the flag (it is the HUD's, and the
    // record's); `raceTime` is the classification datum and never stops; `wall` includes the
    // countdown and is internal only.
    this.wall += dt;
    this.raceTime += dt;
    if (this.state === 'racing') {
      this.time += dt;
      this.lapTime += dt;
      // THE RECORD IS A THING THAT CAN BE LOST. §6.7's clock counts down to it and then counts up
      // past it, and round 3 had nothing on the other side of zero — no state change, no
      // announcement, no line in the results. Now the moment it goes, it is called, and the
      // results carry whether it was beaten.
      if (this.record > 0 && !this.overRecord && this.time >= this.record) {
        this.overRecord = true;
        this.recordBeaten = false;
        this._event('RECORD GONE', 2.2, '#ff5a4a');
      }
    }
    // the harness starts races mid-flight (state forced to 'racing' with no countdown), so the
    // phase has to be able to join the sequence late as well as run it from the grid
    if (this.phase === 'grid' || this.phase === 'set') this.phase = 'go';
    if (this.phase === 'go' && this.time > 3) this.phase = 'racing';

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
          this.phase = 'flag';
          this.playerFinished = true;
          // stamped from the CLASSIFICATION clock, the same one every opponent is stamped from
          this.finishTime = this.raceTime;
          this.playerFinishPos = null;       // filled by _order() below, then frozen
          this._finishPending = true;
        } else if (this._playerCounter.lap === this.laps - 1 && !this.finalLap) {
          this.finalLap = true;
          this.phase = 'final';
          this._event('FINAL LAP', 2.4, '#ff9214');
        } else if (this._playerCounter.lap >= 1) {
          this._event(`LAP ${this._playerCounter.lap + 1}`, 1.2, '#7ee7ff');
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
    this._stations(dt);
    if (this.state === 'racing') this._pace(dt, playerBody);
    let lit = 0;
    for (const d of this.drivers) if (d.nitro.active && d.onScreen > 0.3) lit++;
    const ctx = {
      boostBudget: lit,
      rivals: traffic,
      playerProgress: this.playerProgress,
      viewPos: playerBody.pos,
      viewFwd: this._viewFwd,
      pads: this.cityDef?.props?.boostPads,
      fieldPace: this.fieldPace,
      // where the chase rig is about to be — the drivers steer around it (see AIDriver.step)
      lensPos: this._camAhead || this._camPos,
      // the CLASSIFICATION clock, not `wall` — this is what stamps an opponent's finishing time
      time: this.raceTime,
      laps: this.laps,
      racing: this.state !== 'countdown',
    };
    for (const d of this.drivers) d.step(dt, ctx);
    this._recover(playerBody, dt);

    this._separate(playerBody, dt);
    this._deadline();
    this._order();
    if (this._finishPending) {
      // the results table is the standings AFTER this frame's ordering — snapshotting it inside
      // the lap-completion branch captured the previous frame, so the winner's own results row
      // read one lap short of the lap they had just finished
      this.playerFinishPos = this.playerPos;
      this.results = this.standings.map((s) => ({ ...s }));
      // `_order()` ran a line above with `_classified` still false, so the rows it built cannot
      // carry the retirement flag yet — stamp it here, on the snapshot that becomes the results
      // table. (Every later frame's standings get it from `_order()` itself.)
      if (this.dnf) this.results.forEach((r) => { r.dnf = !r.finished; });
      this._finishPending = false;
      this._classified = true;        // the order on the deck is now the classification, frozen
      this.flagT = 0;
      if (this.dnf) {
        this._event('RACE OVER', 1.6, '#f4f7ff');
        this._event('DID NOT FINISH', 4.0, '#ff5a4a');
      } else {
        this._event('FINISH', 1.5, '#f4f7ff');
        this._event(this.playerPos === 1 ? 'WINNER' : `FINISHED P${this.playerPos}`, 4.0, '#ffd24a');
        if (this.record > 0 && this.finishTime != null) {
          this.recordBeaten = this.finishTime < this.record;
          if (this.recordBeaten) this._event('NEW RECORD', 3.2, '#8ef58a');
        }
      }
    }
    if (this.state === 'finished') this._flag(dt, playerBody);
    this._animateLine(dt);
  }

  /**
   * THE OTHER WAY A RACE CAN END.
   *
   * Round 3 had exactly ONE path out of state 'racing': the player crossing the line. Anything
   * else and the race simply never ended — an idle-player probe had all seven opponents home by
   * t = 201 s and was still 'racing' at t = 260 s with no flag, no results, no DNF and no timeout,
   * with the contact counter climbing past 129 as the finished field milled about on its
   * cool-down lap. A race that cannot end is a race that cannot be lost, which is the same bug as
   * the fabricated results wearing a different hat.
   *
   * So: the moment the WINNER is home the flag has a deadline on it. The player gets
   * FINISH_WINDOW seconds — a full slow lap, enough to finish one you were halfway round when you
   * crashed — and then the chequer falls whatever they are doing. They are classified where they
   * actually are: behind everybody who completed the distance, ahead of anybody who did not, and
   * marked DNF. `this.timeout` is the backstop for the case where nobody at all finishes.
   */
  _deadline() {
    if (this.state !== 'racing') return;
    if (this.winnerTime == null) {
      let best = null;
      for (const d of this.drivers) {
        if (d.finished && d.finishTime != null && (best == null || d.finishTime < best)) best = d.finishTime;
      }
      if (best != null) {
        this.winnerTime = best;
        // the one announcement that tells a player the clock is now running on them
        this._event('LEADER HOME', 1.8, '#7ee7ff');
      }
    }
    const overdue = (this.winnerTime != null && this.raceTime > this.winnerTime + FINISH_WINDOW)
      || this.raceTime > this.timeout;
    if (!overdue) return;
    this.state = 'finished';
    this.phase = 'flag';
    this.dnf = true;
    this.finishTime = null;          // there is no time for a distance that was not completed
    this.recordBeaten = false;
    this.playerFinishPos = null;     // filled by _order() on this same frame, then frozen
    this._finishPending = true;
  }

  /**
   * THE FLAG. Round 2's finish was a state change and a text banner: the clock ran on, the record
   * countdown kept ticking, the standings kept listing unfinished cars, and the player was still
   * doing 116 mph three seconds after crossing the line with no chequer, no line on the road and
   * no change of any kind on screen.
   *
   * What happens now: the clock has already stopped (see update()), the classification is frozen
   * (`_classified`), the start/finish gantry lights its chequer and its beacons (`_animateLine`),
   * and the player is brought down off racing speed here. main.js stops feeding input the moment
   * the state leaves 'racing', so without this the car simply coasts — the director owns the
   * slowing-down lap, exactly as it owns the opponents' (`if (this.finished) target = 26`).
   */
  _flag(dt, playerBody) {
    this.flagT += dt;
    const v = playerBody.vel;
    // an eased brake rather than a wall: firm for the first second and a half, then trailing off
    // into a cruise, which is what a driver does after the line
    const k = 1 - Math.exp(-dt * lerp(1.35, 0.55, smoothstep(0.0, 3.0, this.flagT)));
    const before = Math.hypot(v.x, v.z);
    if (before > 8) {
      v.x -= v.x * k; v.z -= v.z * k;
      const after = Math.hypot(v.x, v.z) / Math.max(1e-4, before);
      playerBody.speed *= after;
      playerBody.groundSpeed *= after;
      playerBody.brakeLit = true;
    }
    // …and the slowing-down lap is driven, not abandoned. main.js stops feeding steering the moment
    // the state leaves 'racing', so left alone the car simply carries its last yaw and ends up
    // parked on a pavement under a WINNER banner. Gently line it back up with the road.
    const s = this.track.at(this.playerU);
    const lat = this.playerLateral ?? 0;
    // aim slightly across the road when off-line, so the car DRIVES itself back to the middle on
    // the slowing-down lap instead of being shoved there
    const want = Math.atan2(s.tan.x, s.tan.z) - clamp(lat, -1, 1) * 0.22;
    let dy = want - playerBody.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const aim = 1 - Math.exp(-dt * 1.6);
    const turn = dy * aim;
    playerBody.yaw += turn;
    playerBody.yawRate *= 1 - aim;
    // the VELOCITY turns with the car. Rotating the body alone would manufacture a slip angle out
    // of nothing and the tyre model would read the cool-down lap as a drift — smoke, squeal and a
    // DRIFT panel counting up under a WINNER banner. (+Z forward, so a yaw of θ is atan2(x, z).)
    {
      const c = Math.cos(turn), sn = Math.sin(turn);
      const vx = playerBody.vel.x, vz = playerBody.vel.z;
      playerBody.vel.x = vx * c + vz * sn;
      playerBody.vel.z = -vx * sn + vz * c;
    }
    if (Math.abs(lat) > 0.15) {
      const pull = clamp(-lat, -1, 1) * Math.min(2.4, 0.9 + Math.abs(playerBody.speed) * 0.09) * dt;
      playerBody.pos.addScaledVector(s.right, pull);
    }
  }

  /**
   * FIELD PACE — the one piece of rubber banding that acts on everybody at once, and the reason
   * the race is a race whoever is holding the controller.
   *
   * A slow integrator, bounded to 0.82–1.13 of the field's own ability and moving at up to 1.6 %
   * of pace per second — far under what anybody can perceive on a car they are racing. What it
   * buys is that a driver 15 % off the pace still has a race in front of them, and one quicker
   * than the field still has to earn the win: the previous pass had a fixed pace, and a
   * reference-quality lap finished DEAD LAST, 230 m behind, in every city.
   *
   * Two guards keep it honest: it never speeds the field up by more than 13 % (so it cannot pass a
   * good player by cheating), and it freezes entirely while the player is crashed or stationary
   * rather than collapsing the whole field to a crawl behind them.
   */
  _pace(dt, playerBody) {
    // The control variable is the MEAN STATION ERROR of the whole field, filtered over four
    // seconds — is the pack sitting further up the road than the ladder wants, or further back?
    //
    // Everything else that was tried here is worse. Matching the player's SPEED ignores that an
    // opponent apexing properly (or taking the shortcut) covers a lap faster at the same
    // speedometer reading, and it left the field a comfortable 150 m clear while reporting that
    // everything was matched. Matching PROGRESS RATE with any offset at all winds the integrator
    // into its own end stop, because a field that is holding station is by definition progressing
    // at exactly the player's rate and the offset is unreachable. Mean band has its equilibrium
    // exactly where the director wants the pack, which is the definition of the right variable.
    let sum = 0, n = 0;
    for (const d of this.drivers) { if (!d.finished) { sum += d.band; n++; } }
    if (!n) return;
    const err = lerp(this._paceErr ?? 0, sum / n, 1 - Math.exp(-dt / 4));
    this._paceErr = err;
    if (Math.abs(playerBody.groundSpeed) < 8 && this.time > 4) return;   // crashed: hold, do not sag
    // Full deflection means the entire field is ~100 m off station, and even then it is 1.6 % of
    // pace a second. Deliberately narrow bounds: wider and the loop oscillates on a one-lap
    // period — the field escapes on lap one, the director over-corrects, and the player drives
    // past all seven of them on lap two, which is worse racing than either end of the swing.
    // Round 2 held this to 0.80–1.06 at 1.2 %/s and it spent whole races welded to a bound, which
    // is a controller that is not regulating. With the per-car authority above doing the real work
    // the field pace only has to trim the whole grid's ability toward the driver holding the
    // controller, but it still needs somewhere to go: 0.82–1.13 at 1.6 %/s.
    this.fieldPace = clamp(this.fieldPace + err * 0.016 * dt, 0.82, 1.13);
  }

  /**
   * Hand every driver the gap it should be holding to the player, by CURRENT ORDER: the car
   * actually nearest in front takes the 9 m slot, the next 18 m, and so on down AHEAD_SLOTS.
   * Assigning by order rather than by identity means nobody is ever asked to make a big
   * correction — the set-point closest to where a car already is, is the one it gets — and it is
   * what guarantees the composition of the shot instead of leaving it to luck.
   */
  _stations(dt) {
    const L = this.track.length;
    const arr = this._stationBuf || (this._stationBuf = []);
    arr.length = 0;
    for (const d of this.drivers) arr.push(d);
    arr.sort((a, b) => a.progress - b.progress);      // most-behind first, leader last
    let nBehind = 0;
    for (const d of arr) if (d.progress < this.playerProgress) nBehind++;
    let ai = 0, bi = 0;
    for (const d of arr) {
      if (d.progress >= this.playerProgress) {
        // walking forward through the sorted field, the first car ahead is the CLOSEST one
        d.station = AHEAD_SLOTS[Math.min(ai++, AHEAD_SLOTS.length - 1)] * d.stationJit;
      } else {
        // …and the first car behind is the FURTHEST back, so its slot is read from the end
        const k = clamp(nBehind - 1 - bi++, 0, BEHIND_SLOTS.length - 1);
        d.station = -BEHIND_SLOTS[k] * d.stationJit;
      }
      // the jitter is re-drawn on a slow personal timer, so the pack breathes in and out over a
      // lap instead of locking into a fixed ladder
      d.stationT -= dt;
      if (d.stationT <= 0) { d.stationT = d.rng.range(7, 16); d.stationJit = d.rng.range(0.82, 1.24); }
    }
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
        const push = Math.min(bestPen * 0.5, (A.d && B.d ? 4.6 : 3.0) * dt);
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
          // NOTE the name. Round 2 called this `j` inside a loop whose pair index is also `j`, so
          // the dedupe key below keyed on the IMPULSE MAGNITUDE instead of the pair of cars, the
          // half-second rate limit never applied to anything, and `race.contacts` reported 311–449
          // "contacts" in a three-lap race — a number that told nobody anything.
          const imp = Math.min(-closing * 0.40, 7.5);
          const wA = A.d ? 1 : 0.40, wB = B.d ? 1 : 0.40;
          A.b.vel.x -= nx * imp * wA; A.b.vel.z -= nz * imp * wA;
          B.b.vel.x += nx * imp * wB; B.b.vel.z += nz * imp * wB;
          // a nudge of rotation off a glancing blow, and a stability window so nobody spins out
          const twist = clamp(imp * 0.045, 0, 0.5);
          const sideA = Math.sign(A.b.forward.x * nz - A.b.forward.z * nx) || 1;
          A.b.yawRate = clamp(A.b.yawRate + sideA * twist * 0.5, -3.4, 3.4);
          B.b.yawRate = clamp(B.b.yawRate - sideA * twist * 0.5, -3.4, 3.4);
          A.b.recover = Math.max(A.b.recover, 0.35);
          B.b.recover = Math.max(B.b.recover, 0.35);
          const s = clamp(-closing / 26, 0, 1);
          A.b.impactImpulse = Math.max(A.b.impactImpulse, s * 0.7);
          B.b.impactImpulse = Math.max(B.b.impactImpulse, s * 0.7);
          // One knock per pair per half-second. Two cars rubbing down a straight satisfy the
          // closing test on most frames, so counting every one of them reported 231 "contacts" in
          // a two-lap race and told nobody anything about how physical the racing actually was.
          const key = i * 64 + j;
          if (s > 0.06 && this.wall - (this._pairT.get(key) ?? -9) > 0.5) {
            this._pairT.set(key, this.wall);
            this.contacts++;
            if (!A.d || !B.d) this.playerContacts++;
          }
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
      // NOBODY GETS SHOVELLED OFF THE ROAD — not the player (leaning on you is racing; putting you
      // in a barrier because three of them arrived at the same corner is the "unfair" §6.10 rules
      // out) and not an opponent either, because a pack that walks its outside car into the wall
      // every corner is a pack that spends the race in the scenery. The OUTWARD component of the
      // push is what gets trimmed; along the road and back toward the middle are untouched.
      const lat = A.d ? A.d.lateral : (this.playerLateral ?? 0);
      const s = A.d ? A.d.sample : this.track.nearest(A.b.pos, this.playerU).sample;
      if (s && Math.abs(lat) > 0.82) {
        const out = px * s.right.x + pz * s.right.z;              // component across the road
        if (Math.sign(out || 1) === Math.sign(lat || 1)) {
          const trim = out * (1 - lerp(1, 0.1, smoothstep(0.82, 1.25, Math.abs(lat))));
          px -= s.right.x * trim; pz -= s.right.z * trim;
        }
      }
      A.b.pos.x += px; A.b.pos.z += pz;
    }
    this._lensClear(dt, playerBody);
  }

  /**
   * NOTHING DRIVES THROUGH THE LENS.
   *
   * The chase rig sits 6–12 m behind the player at bumper-to-roof height with a 0.30 m near
   * plane, and an opponent that arrives in that volume is not "close racing", it is a car sliced
   * open across the bottom of frame with its interior and a detached wheel on show — which is
   * exactly what the critic photographed in two of two chase captures. BEHIND_SLOTS above moves
   * the steady state out of the way; this is the backstop for the transient: a car diving under
   * braking, a contact, a driver squeezing down the inside as the rig swings.
   *
   * It is a lateral nudge, rate-limited to the same order as the car-to-car separation above, and
   * it only ever acts INSIDE 2.4 m, which is well under a car length — so it cannot move anybody
   * anywhere they were not already about to be, and it can never take a place off anyone.
   */
  _lensClear(dt, playerBody) {
    if (!this._camPos || !AI_TUNE.lens) return;
    // WHERE THE LENS IS ABOUT TO BE. main.js runs the chase rig at the END of its frame, after the
    // race, so `_camPos` is the rig as it stood two frames ago — 1.4 m of road at 42 m/s. Measured,
    // that lag was the whole of this guard: the director read 1.3 m of clearance on the frame the
    // car actually came inside 0.6 m and never pushed at all. The rig rides the player, so
    // carrying it forward on the player's own velocity puts it within centimetres of where it will
    // be when the frame is drawn.
    const cam = this._camAhead || (this._camAhead = new THREE.Vector3());
    if (this._camOff && playerBody) cam.copy(playerBody.pos).add(this._camOff);
    else cam.copy(this._camPos);
    for (const d of this.drivers) {
      const b = d.body;
      const dims = d.car?.userData?.dims || d.dims;
      const hull = d.hull;
      const hl = hull ? hull.hl : (dims.length ?? 4.6) * 0.5;
      const hw = hull ? hull.hw : (dims.width ?? 2.0) * 0.5;
      const roof = hull ? hull.top : (dims.height ?? 1.55);
      // distance from the lens to this car's BODYWORK, not to its origin — an origin 2.4 m away
      // is a nose 0.1 m away, which is the whole failure.
      const px = cam.x - b.pos.x, py = cam.y - b.pos.y, pz = cam.z - b.pos.z;
      const f = b.forward, r = b.right;
      const lz = px * f.x + pz * f.z;          // along the car
      const lx = px * r.x + pz * r.z;          // across it
      // The lens is only ever in danger from a car it is LEVEL WITH — over the roof by half a
      // metre and the near plane cannot reach it however close the car is in plan. So the test is
      // a HORIZONTAL clearance, gated on height, rather than a 3D box distance: measured on the
      // Miami capture, a 3D distance of 0.22 m read as "0.32 m of gap" because the vertical term
      // flattered it, the guard pushed at a third of the rate it needed to, and the frame came
      // back with the SUV sliced open across the bottom of it.
      if (py > roof + 0.7 || py < -1.0) continue;             // clear over the top, or underneath
      const ez = Math.max(0, Math.abs(lz) - hl);
      const ex = Math.max(0, Math.abs(lx) - hw);
      const gap = Math.hypot(ex, ez);
      const need = LENS_CLEAR * (1 - smoothstep(0.35, 1.1, Math.max(0, py - roof)));
      if (gap >= need || need < 0.02) continue;
      // push the CAR away from the lens in the road plane (moving it vertically would fly it),
      // rate-limited to the same order as the car-to-car separation above
      let dx = b.pos.x - cam.x, dz = b.pos.z - cam.z;
      let flat = Math.hypot(dx, dz);
      if (flat < 0.05) { dx = r.x; dz = r.z; flat = 1; }      // lens directly overhead: go sideways
      // …and the deeper the intrusion the harder the nudge. A whole encounter — a car coming past
      // the rig at a few metres a second — lasts about ten frames, so a rate that reads as gentle
      // at the edge of the guard has to become firm at the middle of it or it never arrives.
      const deep = 1 - gap / Math.max(0.05, need);
      const push = Math.min((need - gap) * 0.6, lerp(1.8, 17.0, deep * deep) * dt);
      b.pos.x += (dx / flat) * push;
      b.pos.z += (dz / flat) * push;
      d.lensPushes = (d.lensPushes || 0) + 1;
    }
  }

  // ---------------------------------------------------------------- standings

  _order() {
    const t = this.track;
    // `finished` here means COMPLETED THE DISTANCE, not "the race is over". Round 3 wrote
    // `this.state === 'finished'` — which is also true when the flag falls on a player who never
    // finished — and the comparator sorts finishers first by finishing time, with a null time
    // reading as 0. A DNF would therefore have been classified the winner.
    const all = [{
      name: this.playerName, progress: this.playerProgress, you: true,
      lap: Math.max(0, this._playerCounter.lap), finished: this.playerFinished,
      finishTime: this.finishTime, speed: 0, car: null,
    }];
    for (const d of this.drivers) {
      all.push({
        name: d.name, progress: d.progress, you: false, lap: Math.max(0, d.lap),
        finished: d.finished, finishTime: d.finishTime,
        speed: Math.abs(d.body.speedMph), car: d.vehicleId, boost: d.nitro.ramp, tactic: d.tactic,
      });
    }
    // A car that completed the distance is classified ahead of one that did not, and two that did
    // are separated by WHEN — on the one clock both are stamped from (see the constructor). A
    // missing stamp sorts LAST among finishers, never first: `?? 0` would have made a null time
    // the winning time.
    const cmp = (a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return (a.finishTime ?? Infinity) - (b.finishTime ?? Infinity);
      return b.progress - a.progress;
    };
    const raw = all.slice().sort(cmp);
    this._rawPos = raw.findIndex((x) => x.you) + 1;

    // ---- ORDER HYSTERESIS.  Two cars running wheel to wheel cross and re-cross on raw progress
    // several times a second: measured on a three-lap LA race, 75 displayed position changes with
    // 17 of them inside three seconds, so the big ordinal, the standings deck and the position
    // flash all strobed during exactly the side-by-side moments they exist to dramatise. Only the
    // PASSED announcement was debounced.
    //
    // The fix is not a timer on the readout — that just lags the truth. It is to carry LAST
    // FRAME'S ORDER forward and only let a pair swap when the car behind is genuinely clear by
    // ORDER_HYST metres. Inside that margin the order is whatever it already was, which is both
    // stable and honest: nobody is shown a place they have not taken by a car's length.
    let order;
    const byName = this._byName || (this._byName = new Map());
    byName.clear();
    for (const x of all) byName.set(x.name, x);
    if (this._orderNames && this._orderNames.length === all.length) {
      order = this._orderNames.map((n) => byName.get(n));
      if (order.some((x) => !x)) order = raw.slice();
    } else order = raw.slice();
    if (!this._classified) {
      const H = ORDER_HYST / t.length;
      const swapT = this._swapT || (this._swapT = new Map());
      const jumps = (A, B) => {                       // does B belong in front of A?
        if (A.finished !== B.finished) return B.finished;
        if (A.finished && B.finished) return (B.finishTime ?? Infinity) < (A.finishTime ?? Infinity);
        const clear = B.progress - A.progress > H;
        // …and it has to STAY clear. Eight metres of margin kills the sub-frame chatter; a fifth
        // of a second on top of it kills the rest, because a place held for three frames in the
        // middle of a corner was a wheel alongside, not a pass. Both live here rather than on the
        // readout so the big ordinal, the standings deck and the position flash cannot disagree —
        // a dwell applied only to the ordinal shows "5th" over a deck that says you are 4th.
        const key = A.name < B.name ? `${A.name}|${B.name}` : `${B.name}|${A.name}`;
        if (!clear) { swapT.delete(key); return false; }
        const t0 = swapT.get(key);
        if (t0 == null) { swapT.set(key, this.wall); return false; }
        return this.wall - t0 >= 0.30;
      };
      for (let pass = 0; pass < order.length; pass++) {
        let moved = false;
        for (let i = 0; i + 1 < order.length; i++) {
          if (jumps(order[i], order[i + 1])) {
            const tmp = order[i]; order[i] = order[i + 1]; order[i + 1] = tmp;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    this._orderNames = order.map((x) => x.name);
    all.length = 0;
    for (const x of order) all.push(x);
    const lead = all[0].progress;
    for (let i = 0; i < all.length; i++) {
      all[i].pos = i + 1;
      // DNF means THE FLAG FELL AND YOU WERE STILL OUT THERE — which only happens on the
      // deadline (`_deadline`). When the player finishes normally the race is classified at that
      // moment and the cars a second or two behind them are simply behind them, not retired.
      all[i].dnf = this._classified && this.dnf && !all[i].finished;
      all[i].gapM = (lead - all[i].progress) * t.length;
      all[i].gap = all[i].gapM / Math.max(16, Math.abs(all[i].speed) * 0.447 || 30);
      // gap to the car directly in front, which is the number a driver actually races against
      all[i].gapAheadM = i ? (all[i - 1].progress - all[i].progress) * t.length : 0;
    }
    this.standings = all;
    const pos = all.findIndex((x) => x.you) + 1;
    // An overtake is a race EVENT and the reference HUD shouts about them. Only gains: losing a
    // place is already written on the position deck, and two banners in one corner is noise.
    //
    // It has to be a pass that STUCK, though. Two cars running wheel to wheel swap the order
    // several times a second on raw progress, and the unfiltered version fired the banner
    // twenty-odd times a race, twice in the same corner. So: the new position has to hold for a
    // second and a half, and there is a four-second lockout after each announcement.
    if (this.state === 'racing' && this.time > 3 && this._lastRank != null) {
      if (pos !== this._heldRank) { this._heldRank = pos; this._heldT = this.time; }
      const stuck = this.time - (this._heldT ?? 0) > 1.5;
      if (stuck && pos < (this._shoutRank ?? this._lastRank) && this.time - (this._shoutT ?? -9) > 4) {
        const behind = all[pos];
        if (behind && !behind.you) this._event(`PASSED ${behind.name}`, 1.25, '#8ef58a');
        this._shoutT = this.time;
      }
      if (stuck) this._shoutRank = pos;
    }
    this._lastRank = pos;
    this.playerPos = pos;
  }

  // ---------------------------------------------------------------- telemetry

  /** What the race looks like from the outside — the harness prints this next to the screenshot. */
  telemetry() {
    const t = this.track;
    let ahead = 0, within = 0, onScreen = 0, maxTrim = 0, close = 0;
    const rows = [];
    for (const d of this.drivers) {
      const gapM = (d.progress - this.playerProgress) * t.length;
      if (gapM > 0 && gapM < 120) ahead++;
      if (Math.abs(gapM) < 150) within++;
      if (Math.abs(gapM) < 30) close++;              // inside ~6 car lengths, either side
      if (d.onScreen > 0.4 && gapM > 0) onScreen++;
      if (d.onScreen > 0.4) maxTrim = Math.max(maxTrim, Math.abs(d.trim));
      rows.push({
        name: d.name, car: d.vehicleId, gapM: +gapM.toFixed(1),
        mph: +d.body.speedMph.toFixed(0), drift: +d.body.drift.toFixed(2),
        boost: +d.nitro.ramp.toFixed(2), tactic: d.tactic, lap: d.lap,
        off: +d.offT.toFixed(1), hits: d.hits,
        // `cuts` is SHORTCUTS DRIVEN END TO END. It used to be `counter.cuts`, the count of lap
        // sectors missed, which is a different thing entirely and reads as zero on a driver
        // taking every shortcut on the lap — that number is `skipped` now.
        cuts: d.shortcuts, skipped: d.counter.cuts,
        fin: d.finishTime == null ? null : +d.finishTime.toFixed(2),
        best: d.counter.best == null ? null : +d.counter.best.toFixed(2),
        station: +d.station.toFixed(0), trim: +d.trim.toFixed(3), seen: +d.onScreen.toFixed(2),
      });
    }
    rows.sort((a, b) => b.gapM - a.gapM);
    return {
      pos: this.playerPos, rawPos: this._rawPos ?? this.playerPos,
      lap: this.playerLap, laps: this.laps,
      u: +this.playerU.toFixed(4), state: this.state, phase: this.phase,
      time: +this.time.toFixed(2), raceTime: +this.raceTime.toFixed(2),
      wall: +this.wall.toFixed(2), flagT: +this.flagT.toFixed(2),
      // the classification, and the two things that end a race other than the player finishing
      finished: this.playerFinished, dnf: this.dnf,
      finishTime: this.finishTime == null ? null : +this.finishTime.toFixed(2),
      winnerTime: this.winnerTime == null ? null : +this.winnerTime.toFixed(2),
      deadline: this.winnerTime == null ? null : +(this.winnerTime + FINISH_WINDOW).toFixed(1),
      record: this.record, overRecord: this.overRecord, recordBeaten: this.recordBeaten,
      recordLeft: this.record > 0 ? +(this.record - this.time).toFixed(2) : null,
      packAhead: ahead, packWithin: within, packOnScreen: onScreen, packClose: close,
      // the two numbers that say whether the rubber banding is visible: the strongest pace trim
      // on any car the player can see, and where the whole-field pace has drifted to
      trimOnScreen: +maxTrim.toFixed(3), fieldPace: +this.fieldPace.toFixed(3),
      contacts: this.contacts, playerContacts: this.playerContacts, reforms: this.reforms,
      cuts: this._playerCounter.cuts,
      field: rows,
    };
  }

  get lateralOffTrack() { return Math.abs(this.playerLateral) > 1; }
}

export { NAMES, Progress };
