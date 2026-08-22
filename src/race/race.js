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
 * ═══ ROUND 9 — THE FIELD DRIVES THE PLAYER'S CARS ════════════════════════════════════════════
 *
 * One gap came back, and it was the one §6.10 puts first — "close and aggressive WITHOUT BEING
 * UNFAIR". Measured on the shipped build with the critic's own probe (`tools/_zzr2_speed.mjs`,
 * LA, player flat out in the muscle car):
 *
 *      the player's muscle   spec 167 mph, measured peak 166
 *      ROMAN's muscle        spec 180 mph, peak 185      ← the same car out of the same table
 *      HAN's SUV             spec 180 mph, peak 192      ← a class the player tops out at 151
 *      the three supercars    spec 188 mph
 *
 * Every opponent had been prepped to a common 180 mph top gear (`PREP_TOP`) whatever it arrived
 * in, i.e. 8–19 % of straight-line headroom over the player's own car of the same class, in the
 * one dimension a player can read off the dial. And it was the mechanism behind the second half of
 * the complaint, the YO-YO: cars surging past on the straights and being reeled back in the
 * corners, on speed that had no visible cause.
 *
 *   R9-A. THE STRAIGHT LINE IS THE SHOWROOM, EXACTLY. `PREP_TOP` is deleted and `topSpeed`,
 *      `power` and the longitudinal `traction` of every opponent are now the numbers `handling.js`
 *      hands the player's own car of that class, to the digit — asserted field-wide by
 *      `tools/_r3speed.mjs`, which diffs every driver's LIVE `body.p` against
 *      `getVehicle(class).spec.physics`. What an opponent still gets prepped is its TYRES and its
 *      BRAKES, which is where an arcade grid is allowed to be prepared, and the size of that is
 *      stated rather than hidden: the corner ask lands at 1.43–1.75 G against the player's muscle
 *      car's 1.29 G of real tyre.
 *   R9-B. AND THE CORNER PAYS FOR IT, PER CLASS. Deleting the prep on its own hands the race to
 *      whoever brought the biggest engine — solo lap times went from a 3.3 s spread to 5.9 s with
 *      the tuner where the SUV used to be. `cornerComp` gives a class as much extra corner ask as
 *      its straight-line deficit costs it (calibrated at ~1.5 % of G per 1 % of top speed), so the
 *      SUV corners like a truck that has been prepared and the supercar still walks away down the
 *      back straight. Solo spread is 2.2 s now, tighter than the build that had the prep.
 *   R9-C. THE BOTTLE IS A TILT AGAIN, NOT THE ANSWER. `boostEager`'s class term was written when
 *      every car had the same top gear; on the showroom tables it put the SUV on nitrous for 52 %
 *      of a race. Flattened — the lap time the slow classes lost is bought back in B, not by
 *      leaning harder on the one thing that still lifts their vMax.
 *   R9-D. THE GRID IS A GRID. Two columns at ±0.42 of the half-width put four of the eight cars
 *      entirely in the ONCOMING LANE on a 22 m boulevard, with 1.1 m of daylight between rows and
 *      pairs that interpenetrated on any curvature. It is laid out in metres now — both columns on
 *      the racing side of the centre line, a real stagger, and every centre-to-centre distance on
 *      the grid at 5.5 m or more in all four cities (`tools/_r3grid.mjs`).
 *   R9-E. AND CARS STOPPED PASSING THROUGH EACH OTHER. The collision capsule was the WHEELBASE,
 *      so the last 0.7 m of a lifted truck was a ghost, and the separation push was capped at a
 *      rate three times slower than two cars can bury themselves at. Capsules are the car now and
 *      the cap opens with depth: 99 frames under 2.0 m centre-to-centre in a 120 s NYC race → 0,
 *      worst approach 1.23 m → 2.13 m (`tools/_r3sep.mjs`).
 *   R9-F. TWO SMALLER THINGS THE ROUND-2 CRITIC LISTED AS FUNCTIONAL FAILURES. There is a WRONG
 *      WAY warning (`_wrongWay` — the lap logic always refused to credit a backwards lap, but
 *      nothing told the player; `tools/_r3wrong.mjs` asserts both halves). And a car that had
 *      taken the chequer while the player was still on their last lap used to drop to 26 m/s ON
 *      THE RACING LINE — a 58 mph rolling roadblock in the middle of somebody else's race.
 *
 * MEASURED AFTER — LA, the same seed, the same reference player (0.86 of top speed on the racing
 * line, holding their own boost button, which laps 47.3 s and finishes P2–P3), A/B'd against the
 * round-8 straight line through `AI_TUNE.prepTop` so the claim is falsifiable in one line
 * (`tools/_r3yoyo.mjs [--prepTop 1]`):
 *
 *                                                  round 8      round 9
 *      fly-bys >20 mph carrying a lit plume          51.5 %       83.8 %
 *      closing speed p95, NEITHER car boosting      +25.6 mph    +14.2 mph
 *      frames >20 mph apart, all samples             51.2 %       46.8 %
 *
 * — i.e. the surge that is left is nitrous, it is a thing with a plume on it, and the player has
 * the same bottle on the same pads under the same state machine (they spend 25–33 % of a race on
 * it against the field's 28–38 %). With neither car on the bottle the field now runs inside
 * ±20 mph of the player, which is what the round-2 critic asked for.
 *
 * The pace ladder survives it (`tools/_zzr2_band.mjs`, LA, three player paces): 0.70 → P8,
 * 0.86 → P8/P6, 1.00 → P1, with 2.6 opponents ahead inside 120 m and 5.6 on screen at 0.86. Over
 * eight full races in four cities (`tools/_race_r7batch.mjs`) mean finishing rank by class reads
 * tuner 3.06 · muscle 3.38 · SUV 4.63 · supercar 4.63, last place goes supercar 6 · SUV 1 ·
 * tuner 1 — no class is parked at the back — and the field arrives inside 70–290 m.
 *
 * ═══ ROUND 8 — THE FIELD HAS A PACE OF ITS OWN, AND THE ROAD IS NEVER GRANTED ════════════════
 *
 * The gap that came back was the one that matters most in §6.10, and it was measurable in four
 * runs: FINISHING POSITION WAS INVERSELY CORRELATED WITH HOW WELL THE PLAYER DROVE. Same seed,
 * same city, same car, only the player's pace changed (`tools/_race_sweep_r8.mjs`, a racing-line
 * autopilot at a fraction of top speed, LA, muscle, three laps from the grid):
 *
 *      before   0.70 pace → 58.8 s laps → P3        0.80 → 51.6 s → P1
 *               0.92 pace → 46.7 s laps → P4        0.99 → 44.5 s → P1
 *      after    0.70 → P8    0.80 → P6    0.86 → P5    0.92 → P2    0.99 → P1
 *
 * …and monotone in all four cities: NYC 8·8·8·4·1, Vegas 8·8·8·6·1, Miami 8·8·8·7·3, and in all
 * four cars (see `machineRef`). A player who drives a quarter slower no longer wins; a
 * record-quality lap does.
 *
 * (Read the LADDER, not the individual place. Seven cars trading paint for three laps is a
 * chaotic system: the same LA sweep run against three builds that differ only in a comment ends
 * 8·8·8·3·1, 8·8·6·2·1 and 8·6·5·2·1. Every one of them is monotone in the player's pace, which is
 * the property being claimed; no single mid-field position is repeatable to the place, and any
 * measurement of this file that rests on one is measuring the weather.)
 *
 * The cause was that THE FIELD HAD NO PACE OF ITS OWN. It had a range — [0.60, 1.26] — and which
 * end of it the field drove at was decided by the player: 57–59 s laps behind a slow one, 42–44 s
 * laps behind a fast one, a 14-second span of lap time. On top of that the band's own per-car trim
 * ran to ±34 % (six times the entire range that replaced it), and the re-station could GRANT the
 * field 5.5 % of a race distance of road it had not driven — which round 7's critic watched go
 * from 5 m to 511 m between t = 41 s and t = 94 s of a race the player had led by 120 m, ending
 * with a drive that beat the course record by 28.59 s classified third.
 *
 * Five changes, one idea: THE DIRECTOR MAY TIDY THE PACK, IT MAY NOT RUN THE RACE.
 *
 *   R8-A. A NOMINAL PACE, AND ±6 % AROUND IT. `PACE_NOM` is the field's own pace, calibrated on
 *      the solo probe (`tools/_race_r7solo.mjs` — band, re-station, traffic and mistakes off, pace
 *      pinned) at the value where these seven cars lap LA in 45.5–49.1 s on their own hands.
 *      `PACE_BAND` is all the authority the director has over it. The pace→lap-time gearing is
 *      about 0.43, so the whole range is ±1.2 s a lap against a 3.6 s spread between the best and
 *      the worst driver in the field: WHO you are racing now matters three times more than what
 *      the director wants. The PI gains are written as fractions of the band for the same reason
 *      (round 6's kP 0.105 was sized on a range six times wider and would have been a switch).
 *   R8-B. THE PER-CAR TRIM IS TWO NUMBERS NOW, AND BOTH ARE SMALL. `TRIM_CATCH` 0.07 is what a car
 *      may spend making back a mistake — ~200 m rejoined over a lap, which is every honest
 *      recovery and no dishonest one. `TRIM_HOLD` 0.10 is what a car up the road may be asked to
 *      give away, which can only ever make the player's race easier. One ±34 % ceiling for both
 *      was where the rubber band had actually been living once the pace range was cut.
 *   R8-C. FORWARD ROAD-GRANTING IS DELETED. `SLIDE_BUDGET_FRAC` is 0 and `_restation` refuses any
 *      positive slide outright: not budgeted, not metered, not available. Road a car did not drive
 *      is road it did not drive. `slideFwd` reads 0 in every race in this file's ledger, and a
 *      probe that ever sees anything else has found a bug. The HOLD half survives — and is now
 *      budgeted too (`SLIDE_HOLD_FRAC`, ~370 m across the whole field), because the first cut of
 *      this change left it unbounded and it promptly took 10,580 m of road out from under the
 *      field in one race against a slow player, which is the same mechanism pointing the other
 *      way.
 *   R8-D. THE CASTING WAS OVER-CORRECTING. Round 7 made skill mean something (R7-A) without
 *      revisiting the skill ladder that had been sized when it meant nothing, and the counterweight
 *      became heavier than the thing it balanced: over twelve full races, mean finishing rank by
 *      class read SUV 3.08 · muscle 3.50 · tuner 3.58 · supercar 4.75, with a supercar last in ten
 *      of twelve — the round-2 procession with the classes in the opposite order. The tilt is
 *      halved (systematic 0.71 → 0.89, jitter ±0.07).
 *
 *   R8-E. AND THE GRID IS BUILT FOR THE CAR THE PLAYER BROUGHT. The references the field is
 *      prepped and driven to (`REF_LAT_G`, `REF_DECEL`, `PREP_TOP`, `PREP_G`) were absolutes tuned
 *      on the muscle car, and the old pace range had been hiding a garage with an 11-second spread
 *      of lap time in it: cut the range and the supercar finishes first at EVERY player pace while
 *      the SUV never gets off the back row. `machineRef` scales those references off the player's
 *      class table — once, at construction, before the lights go out, with no knowledge of how the
 *      race is going — and the four cars get four ladders instead of one. See `machineRef` for the
 *      before/after and for why this is not the rubber band coming back in through the window.
 * MEASURED AFTER, twelve full races, four cities × three player paces (`tools/_race_r7batch.mjs`):
 *
 *      mean rank by class   muscle 3.50 · tuner 3.67 · SUV 4.00 · supercar 4.39   (spread 0.89)
 *      metres behind the leading opponent, by class   52 / 52 / 48 / 59
 *      last place, by class   supercar 6 · SUV 3 · tuner 2 · muscle 1 — all four take a turn
 *      field spread at the flag   37–264 m across the twelve — the gap this piece was sent
 *        back for was a last-placed car 691, 772, 919, 1021 and 2669 m adrift in five races
 *      pack   2.02 opponents ahead inside 120 m on average, one inside 30 m for 55 % of the race
 *      strongest pace trim on any car the player can SEE   0.037
 *      road granted   0 m, in every race
 *      shortcuts driven by the field   17–45 a race, 3–7 a driver against 6 offered
 *      the winner's race time, LA, as a function of the player   152 s behind a 58.8-second lap,
 *        146.6 s with the player PARKED (the field's own honest pace), 141.3 s behind a 46.7-second
 *        one — ±4 % about a race nobody was driving in
 *
 * …and the classification still checks out end to end: an idle-player LA race is won in 142.63 s,
 * the flag falls on the deadline at 202.63 s, the player is classified P8 DNF, and all seven
 * opponents' finishing times match an independent re-derivation off one clock to the millisecond
 * (`tools/_zz_criticrace_r1.mjs --mode idle`).
 *
 * WHAT THIS COSTS, stated rather than hidden: the beatable window is narrow. The ladder holds the
 * field inside ~120 m of the player, so the seven of them finish within 1–3 s of each other, and
 * the player's own position therefore moves several places for a couple of per cent of pace. The
 * alternative is a wider ladder, and round 2 shipped one — a strung-out field with an empty road
 * behind the player for eleven seconds at a stretch. A close field with a sharp gradient is the
 * better of the two failures, and it is the one §6.10 describes.
 *
 * ═══ ROUND 7 — THE ORDER IS NO LONGER THE CLASS TABLE READ OUT LOUD ═══════════════════════════
 *
 * The gap that came back was §6.10's oldest one: ONE CLASS WAS PERMANENTLY NON-COMPETITIVE. The
 * SUV finished last in race after race and the muscle car was second last, while the front four
 * came home within a couple of seconds of each other.
 *
 * The first job was to find out WHICH of the two possible causes it was — "the AI cannot drive the
 * heavy classes" or "the pace it targets is unreachable in them" — because the fix is different.
 * `tools/_race_r7solo.mjs` answers it: each driver alone on the road, traffic / band / mistakes /
 * re-station off, field pace pinned, so the only variable is the class. On LA at pace 1.26 and
 * IDENTICAL hands, with nitrous off:
 *
 *      supercar 44.28 / 44.94 · SUV 45.14 · tuner 46.08 / 46.09 · muscle 46.29
 *
 * The SUV is THIRD. Neither story is true: the AI drives it fine and `racePrepped` has already
 * made the corner it is asked for reachable. Turn one thing on at a time and the order inverts —
 * and the three things that invert it are all in this file:
 *
 *   R7-A. SKILL WAS WORTH TWO HUNDREDTHS OF A SECOND. The director deliberately casts its best
 *      drivers into the heaviest cars (see the grid) — and the casting could not express itself,
 *      because BOTH quantities skill feeds are hard-capped at a common reference that every
 *      race-prepped car now clears. The corner ask is `min(refG · cornerPace, realG · gripCeil)`
 *      and the second term binds for everybody; braking was `min(brakeCap · lerp(0.80, 0.98,
 *      skill), REF_DECEL)` and the cap binds for everybody, so the skill term was multiplying a
 *      number that was then thrown away. Measured on the solo probe: the same seven cars at skill
 *      0.85 and at skill 0.97 lapped LA in 45.30 s and 45.28 s. Both caps now carry the hands —
 *      `gripCeil` is the driver's slice of its own tyre as well as the car's, and REF_DECEL is
 *      tilted ±3 % about the field's mean skill. Nobody is asked for more grip or more brake than
 *      they physically have; what changed is who is allowed to use all of theirs.
 *   R7-B. A CAR THAT RAN WIDE ON A SHORTCUT WAS TELEPORTED INTO THE SCENERY. The sticky ownership
 *      bound that keeps a car on a ribbon it is already on was 1.45 of the ribbon's half-width and
 *      the ribbon's own barrier is at 1.52, so ownership ALWAYS lost first: the car was handed back
 *      to the street at a street lateral of 1.5–2.0, i.e. dropped beside the shortcut into a street
 *      barrier that was not in front of it a frame earlier. It is the failure mode of the class
 *      that takes the most shortcuts. Measured with `tools/_race_r7cutdrive.mjs` (off-track split
 *      by street / approach / ribbon, and by how long since the car left one): the SUV spent 5.4 s
 *      a race off the STREET against 0.0 s for five of the other six cars, 3.6 s of it inside three
 *      seconds of a shortcut, with all four of its barrier hits there — and NOBODY in the field
 *      ever hit a ribbon's own wall, because they were all ejected before they could. 1.62 now, and
 *      the same probe reports the SUV at 0.9 s off the street and no street hits: it scrapes the
 *      alley wall instead, which is a thing you can see happen.
 *   R7-C. THE BOTTLE LIFT WAS SIZED ON MASS, A ROUND AFTER THE BRAKES STOPPED BEING. `overLift` —
 *      how far past its own corner solve a driver will carry a live boost before lifting — was
 *      `lerp(7, 3.5, mass)`, written when the heavy classes genuinely could not stop and left alone
 *      when `racePrepped` sized every class's brakes to REF_DECEL. It halved the boost window of
 *      exactly the two classes whose brakes are now the reference. It is derived from the braking
 *      figure the corner solve is actually using now, which is 7 for all four classes today and
 *      would tighten again on its own for any class that fell short.
 *
 * MEASURED AFTER, twelve full races from the grid to the flag — four cities × three player paces
 * (`tools/_race_r7batch.mjs`), aggregated by class as MEAN FINISHING RANK IN THE SEVEN-CAR FIELD:
 *
 *      before   supercar 3.50 · muscle 3.50 · tuner 4.17 · SUV 5.67      (spread 2.17)
 *      after    muscle 3.50 · tuner 3.96 · supercar 4.06 · SUV 4.42      (spread 0.92)
 *
 * …and the SUV is last in 3 races of 12 rather than 4, with the two rookie-driven supercars now
 * taking their turn at the back — which is the point: the order is decided by who is driving, not
 * by which table the car came out of. Solo at a pinned pace with nitrous and shortcuts on, LA, the
 * field's lap-time spread goes 2.34 s → 1.42 s and the SUV moves from last to fourth of seven.
 *
 * WHAT WAS MEASURED AND DELIBERATELY NOT SHIPPED, so the next round does not pay for it twice:
 *   · A BRANCH-AWARE CORNER SOLVE. `track.turnRate` answers for the STREET, so a driver ON a
 *     shortcut brakes for the piece of road the shortcut replaces — and `tools/_race_r7cut.mjs`
 *     shows that is not a small error (Vegas u 0.51 is a dead-straight ribbon standing in for a
 *     0.0215 rad/m hairpin, so the car brakes to 25 m/s for a corner that is not there; LA's u 0.33
 *     ramp is tighter than the boulevard it leaves, so it arrives at the ribbon having braked for a
 *     straight). Built it, measured it: it is worth ~1 s a lap to the muscle car and it moves the
 *     muscle's mean rank 4.38 → 3.13 — and it makes the SUV WORSE (5.67 → 6.25), because the whole
 *     field then attacks the ribbons at street speed and the merge back onto the street is where a
 *     2.5-tonne car on 9 rad/s of steering loses it. The right shape of the fix is a branch-aware
 *     solve PLUS a hand-back the heavy classes can drive; half of it is a regression.
 *   · RACE-PREPPING THE BOTTLE. Nitrous is worth 1.40–2.48 s a lap to six of the seven cars and
 *     0.79 s to the SUV, because `nitrous.js` spools its thrust over 1.25 s with curve 2.00 and a
 *     burn on a street circuit is a second and a half (mean thrust authority while lit, measured:
 *     supercars 0.98, tuners 0.93, muscle 0.66, SUV 0.39). Prepping `thrust` on the same principle
 *     as the tyres does NOT fix it — the extra force simply reaches `err < −overLift` sooner and
 *     the driver lifts, so the SUV's mean authority went DOWN. The quantity that has to change is
 *     the spool, and the spool is what the plume looks like (`ramp` drives jet length, §6.3).
 *
 * ═══ ROUND 6 — THE FIELD IS QUICK NOW, RATHER THAN BEING PULLED ALONG ══════════════════════════
 *
 * One gap came back from round 5, and it was the headline of §6.10: for a player who drives the way
 * this game rewards — throttle pinned, nitrous whenever it is charged — THE RACE STOPPED BEING A
 * RACE. Measured over full three-lap races from the grid (probe: a racing-line autopilot at 1.30
 * pace with nitrous, LA laps 43.8 s, i.e. quicker than the field's own best):
 *
 *      no opponent on screen ahead for 98 % of the race; a car within 30 m for 8 % of it; the
 *      field-pace controller welded to its 1.10 ceiling for 81 %; and the director papering over
 *      the shortfall by sliding 5,130 m of road under the AI off camera — about 700 m a car, a
 *      tenth of the race distance GRANTED rather than driven.
 *
 * Five changes, and they are one idea: RAISE THE FIELD'S REAL ABILITY, AND TAKE AUTHORITY AWAY FROM
 * THE DIRECTOR. Each is documented where it lives; this is the ledger.
 *
 *   R6-A. THE FIELD WOULD NOT SPEND ITS TANKS. The nitrous fire test asked for the car's whole
 *      STOPPING DISTANCE of straight road (up to 460 m) before anybody would light one, which on a
 *      street circuit is almost nowhere: opponents spent 6–18 % of the race on the bottle against a
 *      player holding it down for a third of theirs. `physics.js` caps every car at its own
 *      `topSpeed`, so a pace trim on a straight is a no-op and NITROUS IS THE ONLY THING THAT LIFTS
 *      AN OPPONENT'S REAL vMAX — a field that will not spend its tanks cannot answer a quick player
 *      whatever the director does. Horizon is now ~2 s of road; the corner solve and `overLift`
 *      keep it safe. Opponents now spend 18–35 % of the race on the bottle, on the same three
 *      tanks, refilled off the same boost pads, under the same state machine as the player.
 *   R6-B. THE START HAD NO CONSEQUENCE, from both ends. The field was locked out of nitrous for
 *      7–16 s off the green (now 1.2–4.2 s, with the standing-start speed gate doing the work the
 *      lockout used to), and the pace loop was ALLOWED TO SLOW THE FIELD DOWN during the opening —
 *      see `PACE_GRACE`. Measured: `fieldPace` fell 0.95 → 0.914 over the thirty seconds in which
 *      a flat-out player went from P8 to P1.
 *   R6-C. THE LADDER PUSHED THE FIELD AWAY BEHIND THE PLAYER. A car the player had just passed sat
 *      at −2 m against a −17 m slot and the band read that as "you are fifteen metres too close"
 *      and trimmed its pace DOWN — so every place a quick player took made the field slower, and
 *      `_pace` (which integrates the mean band) dragged the whole field down with it. The ladder is
 *      one-sided behind the player now: see `BEHIND_KEEP`.
 *   R6-D. THE CARS WERE NOT FAST ENOUGH TO BE ASKED. REF_LAT_G 1.34 → 1.42, REF_DECEL 18 → 19,
 *      PREP_G 1.55 → 1.72, PREP_TOP 77 → 80.5, and the pace range widened to [0.60, 1.26] with the
 *      per-driver clamps DERIVED from it (they were literals, and they had been quietly eating the
 *      bottom of the director's range). Solo at identical hands the field now spreads 1.43 s of lap
 *      time across four classes — supercar 44.85 s, SUV 46.28 s — with every class asked for
 *      1.462–1.480 G. And the loop is twice as quick (kP 0.055 → 0.105, kI 0.013 → 0.030), because
 *      round 5's took FORTY SECONDS to reach its own ceiling, which is most of lap one.
 *   R6-E. THE DIRECTOR'S POSITION POWER IS NOW LAST-RESORT AND BUDGETED. `_restation` is scaled by
 *      how saturated the pace loop is (pace first, position second) and capped by
 *      `SLIDE_BUDGET_FRAC` — no more than ~5.5 % of one car's race distance may be GRANTED to the
 *      whole field in a race, ever. Holding a field back is unbudgeted; it can only make the race
 *      harder. `telemetry()` reports `slideFwd` / `slideBack` / `slideBudget` separately, because a
 *      single total hid a race in which most of the movement was the harmless kind.
 *      (SUPERSEDED BY R8-C: the grant is deleted rather than budgeted, and "holding a field back
 *      needs no bound" turned out to be wrong in exactly the way this paragraph argues it is not.)
 *
 * MEASURED AFTER, same probe, full races from the grid to the flag, all four cities:
 *
 *      an opponent within 30 m for 75 / 79 / 88 / 84 % of the race (LA / NYC / Vegas / Miami),
 *      2.1–2.9 opponents ahead of the player inside 120 m on average, granted road 511 / 75 / 52 /
 *      77 m against a budget of 511 / 368 / 462 / 378, and the strongest pace trim on any car the
 *      player can SEE at 0.017–0.115.
 *
 * …and the skill gradient survives it, which is the other half of §6.10. LA, same seed, four
 * different player paces: 61.0 s laps → P6 (−3.7 s, no record); 43.8 s → P3 (−0.8 s); 42.9 s → P3
 * (−0.3 s); 42.5 s → P1 (+2.0 s), record beaten in all three quick runs. The win is available to a
 * lap four tenths quicker than flat-out, and it has to be taken off somebody.
 *
 * ═══ ROUND 4 — the round that made the result real ════════════════════════════════════════════
 *
 * Round 3 built the pack, the band
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
 *    Measured over a full three-lap LA race from the grid against a racing-line autopilot at 0.92
 *    pace (`tools/_r2race_diag.mjs`, 352 samples): an opponent is in shot on 99 % of samples, at
 *    least one is ahead and inside 120 m on 93 %, the mean is 4.2 cars ahead inside 120 m, and
 *    somebody is inside ±30 m of the player on 68 %. Before this round's re-station and PI pace
 *    loop, same probe and seed: 76 % in shot, 65 % with anything ahead, mean 2.4, 34 % close.
 *    `tools/_race_spect.mjs` counts what is
 *    actually happening in those frames: an opponent is in shot for 97 % of the race (LA) or 83 %
 *    (NYC), a rival's nitrous plume is lit in 50 % / 28 % of frames, and a rival is sideways past
 *    0.45 of drift in 36 % / 21 % — 158 separate slides and 177 separate boosts in one LA race,
 *    with a rival scraping a barrier in shot 0 % of the time.
 *
 * 4a. THE RACE SURVIVES A PLAYER QUICKER THAN THE FIELD — this round's change, and the one that
 *    was capping the piece. Everything the director had was a trim on PACE, and pace has a
 *    ceiling: a car cannot exceed its own top speed however badly the director wants it back.
 *    Measured with `tools/_r2race_diag.mjs` (a full three-lap race from the grid against a
 *    racing-line autopilot at a chosen pace, sampling pack density, band saturation and the
 *    per-driver ledger twice a second):
 *
 *      · against a STRONG player (LA, 1.30 pace, ~42 s laps) the field pace sat welded to its
 *        ceiling for 73 % of the race, every driver's trim sat on its bound, and the field went
 *        from 20 m at turn one to 446–864 m adrift at the flag. No opponent was ahead of the
 *        player in 96 % of samples. Three laps of empty road, and the SUV — the class the brief
 *        called permanently non-competitive — simply the last car out of the back of that.
 *      · against a MODERATE player (LA, 0.92 pace) the same loop ran a 100-second LIMIT CYCLE:
 *        pace 0.95 → 0.62 (its floor, where it sat for a third of the race) → 0.98 → 0.62, the
 *        field 255 m up the road at one end of it and 246 m down the road at the other, and the
 *        AI's own lap times swinging 52.7 s → 64.1 s inside one race.
 *
 *    Two fixes, and they are a cascade. `Race._restation` moves a car that NOBODY CAN SEE along
 *    the road toward the station the ladder already wants it on — position, not pace, which is the
 *    only quantity with the authority to close 800 m. `Race._pace` becomes a real PI loop with
 *    anti-windup whose error includes how much re-stationing the director had to spend, so the
 *    field's own driving pace rises to meet a quick player instead of the director quietly
 *    dragging the same cars forward all race. Measured, same probe, same seeds:
 *
 *        LA 0.92   packAhead=0 35 % → 7 %,  nothing on screen 24 % → 0 %,  mean cars ahead
 *                  2.44 → 4.52, and the pace limit cycle is gone.
 *        LA 1.30   field 446–864 m adrift → 162–276 m.
 *        NYC 1.10  the leader beats the player by 1.25 s with a rival inside ±30 m for 96 % of
 *                  the race.
 *
 *    And the audit the mechanism has to pass is in the telemetry: `slideSeenMax` is the largest
 *    `onScreen` any car has had at the instant the director moved it (0.00–0.35 measured, against
 *    a hard gate of 0.35) and `slideNearest` the closest it has ever been to the player (74–79 m).
 *
 * 4. RUBBER BANDING THAT CANNOT BE SEEN — the round-3 rewrite. Round 2 ran ONE authority for the
 *    whole field (±13 % rising to ±30 % with distance) and it was wrong at both ends: far too much
 *    on a car two lengths off the player's bumper, where 8–10 % of pace reads plainly as the field
 *    waiting, and far too little on one 300 m up the road, where it pinned at its bound for whole
 *    laps and still lost ground. It is now an ENVELOPE IN VISIBILITY (`hidden`, which is what a
 *    chase rig with no mirror can actually see) with distance as its second term:
 *
 *      · anywhere in the player's field of view, or inside 65 m in any direction, ≤1.5 % of pace —
 *        a fifth of what a draft is worth and under the frame-to-frame noise of a corner. Nothing
 *        you can see is being helped or held.
 *      · genuinely out of shot — behind the rig at any distance, or beyond 260 m up the road — up
 *        to 34 %, which is enough to close 300 m over one lap.
 *
 *    Round 4 drew that envelope in RAW DISTANCE, which gave a car 60 m BEHIND the player, in
 *    nobody's field of view, the same 1.5 % as one on the player's front bumper. Half the reason
 *    a field that had fallen off the back of a quick player could never get back on.
 *
 *    And it is SPLIT: the trim's authority over the corner solve is 40 % of its authority over
 *    straight-line speed. Feeding the whole trim into grip is what made round 2's field spend
 *    9–22 s a race in the scenery — a car told to carry 30 % more speed while braking for the grip
 *    it actually has arrives at every apex 30 % too fast.
 *
 *    It stays ONE-SIDED in shot: past 0.25 of `onScreen` — which is everything inside ~150 m — the
 *    trim is clamped at or below zero, so a car you can see can be held back but NEVER helped, and
 *    a pass is never taken back by the director. And the whole envelope is scaled by `hidden` on
 *    top of that, which is what finally answers round 1's "the field is visibly waiting": measured
 *    over the LA race, the trim on a car the player can see is at or above 10 % of pace on 3 % of
 *    samples and above 5 % on 10 %, against round 1's ≥10 % with three cars in frame for 42 % of
 *    the race. Across LA / Vegas / Miami / NYC the worst single value is 0.120 / 0.117 / 0.023 /
 *    0.011, all of them on a car 150 m up the road.
 *
 * 5. NO CHEATING YOU CAN CATCH. Opponents hit the same barriers on the same rule as the player and
 *    throw the same sparks off them; they refill nitrous from the same boost pads on the same
 *    rule; and the field is held stationary on the grid until the lights go out. The two things
 *    that DO move a car — `_recover` (a beached one) and `_restation` (this round) — are both
 *    gated on the player not being able to see it: `_recover` never inside 110 m, `_restation`
 *    never above 0.35 of `onScreen` and never inside the 60 m corridor around the player's own
 *    track position. The audit numbers are in `telemetry()` so a probe can check rather than
 *    believe: measured across LA, Vegas, Miami and NYC, `slideSeenMax` 0.00–0.35 and
 *    `slideNearest` 59–79 m.
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
const REF_LAT_G = 1.55;
/** …and the same idea for braking, m/s². Nobody is asked for more than their own brakes give. */
const REF_DECEL = 19.0;

/**
 * …AND THE REFERENCES ABOVE ARE SIZED TO THE CAR THE PLAYER BROUGHT (round 8).
 *
 * They were absolutes — one cornering figure, one braking figure, one prepped top speed — and
 * they were calibrated against the muscle car, so the four cars in the garage did not get four
 * races, they got one race and four different chances of winning it. Measured on the same probe
 * as the pace sweep (`tools/_race_sweep_r8.mjs`, LA, five player paces from 0.70 to 0.99):
 *
 *      before   supercar  P1 · P1 · P1 · P1     — first at every pace, by 7.4 s a lap at 0.99
 *               muscle    P8 · P8 · P3 · P1     — the ladder this file is calibrated on
 *               SUV       P8 · P8 · P8 · P3
 *      after    supercar  P8 · P5 · P1 · P1 · P1
 *               muscle    P8 · P8 · P6 · P2 · P1
 *               tuner     P8 · P8 · P8 · P4 · P1
 *               SUV       P8 · P8 · P8 · P7 · P2
 *
 * — four ladders instead of one, each monotone in the player's own pace, and a supercar driven
 * badly now finishes last instead of winning. The supercar is still the easiest car to win in and
 * that is correct: it is the fastest thing in the garage. What it no longer is, is the answer.
 *
 * Round 7's [0.60, 1.26] pace range hid this — a field that will drive at anything from a
 * 59-second lap to a 43-second one covers a garage with an 11-second spread in it — and cutting
 * the range to ±6 % is exactly what exposed it. The answer is not to hand the range back. It is
 * that WHICH CAR YOU BRING IS A DECISION THE DIRECTOR GETS TO SEE: it builds the grid for the
 * machine it is racing, once, at the green light, from the class table and nothing else.
 *
 * This is not rubber banding and the distinction is the whole point. It is fixed before the lights
 * go out, it cannot move during the race, it does not know how fast the player is driving, and it
 * is identical for a player who wins by thirty seconds and one who spins on lap one. The pace
 * sweep is the proof: the finishing ladder is still monotone in the player's pace in every car.
 *
 * Both scales are compressed (grip on a 0.55 power) and clamped, because the point is to put four
 * different races within reach of each other, not to erase the reason to prefer one car — a
 * supercar is still the quickest thing in the garage, it just has to be driven to beat a grid
 * built for it.
 */
const CAL_CAR = 'muscle';   // …and the reference car is the one every constant above was tuned on
const combinedG = (ph) => ((ph.gripFront + ph.gripRear) * 0.5) * (1 + (ph.downforce ?? 0) * 0.55);
let _cal = null;
/**
 * The calibration car's own figures, read from the same table the garage reads (lazily, once, so
 * the class tables are loaded and so this file never has a second copy of them to drift from). It
 * matters that this is a LOOKUP and not two literals: a literal that is a rounding error away from
 * the real one makes `machineRef` return 1.00004 instead of 1 for the reference car, and a
 * three-lap race with seven cars in it is chaotic enough that four parts in a hundred thousand
 * moves the player two places. The reference car must come out EXACTLY 1, or every measurement
 * taken in it is measuring the perturbation.
 */
function calRef() {
  if (_cal) return _cal;
  const ph = getVehicle(CAL_CAR)?.spec?.physics;
  _cal = ph ? { top: ph.topSpeed || 74.5, g: combinedG(ph) } : { top: 74.5, g: 1.2871 };
  return _cal;
}
function machineRef(ph) {
  if (!ph) return { top: 1, grip: 1 };
  const cal = calRef();
  return {
    top: clamp(Math.pow((ph.topSpeed || cal.top) / cal.top, 0.85), 0.90, 1.14),
    grip: clamp(Math.pow(combinedG(ph) / cal.g, 0.55), 0.92, 1.25),
  };
}

/**
 * THE OPPONENTS' CARS ARE RACE-PREPPED — and this is the round-5 fix for the one thing that has
 * capped this piece since round 1: ONE CLASS WAS NEVER IN THE RACE.
 *
 * Rounds 3 and 4 tried to solve it in the DRIVER: ask every class for a common cornering figure
 * (REF_LAT_G) and then hard-cap the ask at what that class's own tyres actually make, so nobody
 * ever drives on grip it does not possess. The invariant is right and it stays. The trouble is
 * that for two of the four classes THE CAP IS WHAT BINDS, so the normalisation above it is
 * decoration — measured with `tools/_race_solo_r1.mjs` (each driver alone on the road, identical
 * skill 0.85, traffic/band/mistakes/nitrous off, field pace pinned at 1.0, LA):
 *
 *     class      askG    solo lap
 *     supercar   1.435     48.35 s
 *     tuner      1.380     51.92 s
 *     muscle     1.209     52.53 s      ← capped by its own tyres, 16 % under the reference
 *     suv        1.035     56.90 s      ← capped by its own tyres, 27 % under the reference
 *
 * 8.55 s of lap-time spread, 17.7 %, with IDENTICAL HANDS and nothing else acting. The comment
 * that used to sit here claimed "under 3 s"; it was measured with the band ON, which hides the
 * spread behind the director rather than removing it. And the driver model is not the problem:
 * over a full race the SUV achieves 0.982 of the speed its own solve asks for — the best-driven
 * car in the field relative to its own target. THE TARGET IS THE PROBLEM. It cannot be fixed in
 * the driver without breaking the invariant, because a driver told to carry 35 % more speed than
 * its tyres can hold arrives at every apex 35 % too fast and spends the race in the scenery —
 * which is exactly what rounds 2 and 3 measured when they tried it.
 *
 * So it is fixed in the CAR. Every opponent drives a race-prepped copy of its class's table:
 * stickier tyres, a taller top gear and bigger brakes, sized so that its own ceiling clears the
 * common ask. Then `min(refG·pace, realG·gripCeil)` selects the ASK for every class at every
 * field pace, the solve stays self-consistent, and nobody is ever asking for grip it does not
 * have — the invariant survives intact, because the car really does have it now.
 *
 * What is deliberately NOT prepped: mass, yaw inertia, steering rate and lock, load transfer,
 * roll and pitch rates, slip-angle feel (`alphaPeak`) and every drift parameter. Those are what a
 * class LOOKS like from the outside, and an SUV that corners with a supercar still wallows, still
 * takes an age to change direction and still hangs a big lazy slip angle. `offroadGrip` is left
 * alone too — the dirt line stays the SUV's advantage, which is what the shortcut appetite reads.
 *
 * It is not a cheat the player can catch: opponents run the same physics model, the same barrier
 * rule, the same nitrous economy and the same tyre limits as the player, and the player's own car
 * is never touched (main.js builds it from `getVehicle()`, which this never sees). It is the
 * balance-of-performance every arcade racer applies to its grid, and it is the only way §6.10's
 * "close, aggressive and beatable" survives a field with a 57 % spread in real cornering ability.
 */
/**
 * …and it is sized for the TOP of the director's pace range, not for the middle of it.
 *
 * `cornerPace` runs up to 1.12 (the field pace's own ceiling is 1.13), and the ask is
 * `min(refG · cornerPace, realG · gripCeil)`. Prep the car to the ask at pace 1.0 and the cap
 * comes back the moment the director asks the field for anything more — which is exactly when a
 * good player is driving, i.e. exactly when it matters. Measured on LA against a nitrous-using
 * autopilot lapping in 48.2 s: the field pace sat on its 1.13 ceiling for 56 % of the race, the
 * supercars were asked for 1.564 G and the SUV's cap handed it 1.420, and the 10 % that re-opened
 * there was worth 2.5 s a lap. So the target is the common ask at FULL field pace.
 */
const PREP_G = 1.76;        // combined lateral G, after aero, every opponent's car is built to
const PREP_MAX_GRIP = 1.85; // …and nothing is prepped past 1.85× its own tyres
/**
 * THE ANCHOR both halves of the class normalisation are measured against: the calibration car's
 * own top speed in m/s, scaled to the machine the player brought (`machineRef`). `paceMul` uses
 * it to hold the fast classes' STRAIGHT-LINE ask down; `cornerComp` uses it to hand the slow ones
 * their lap time back in the CORNERS.
 */
const TOP_ANCHOR = 74;

/**
 * THE CORNER SPEED A CLASS GETS BECAUSE OF THE TOP SPEED IT DOES NOT HAVE. Round 9.
 *
 * With `PREP_TOP` deleted the four classes run the showroom's own straight lines — 84 m/s for the
 * supercar down to 67.6 for the SUV, a 19 % spread — and a 19 % spread in top speed is 3–4 s a lap
 * on these circuits. Measured with `tools/_race_r7solo.mjs` (each driver alone, band / traffic /
 * mistakes / nitrous / shortcuts off, pace pinned, LA) the moment the prep came off:
 *
 *      before (every class prepped to 80.5 m/s)   47.3 · 49.1 · 49.9 · 50.3 s   spread 3.3 s
 *      after  (showroom tops, one common ask)     47.3 · 49.5 · 49.9 · 53.1 s   spread 5.9 s
 *
 * — i.e. deleting the straight-line prep on its own hands the win to whoever brought the biggest
 * engine and puts the tuner where the SUV used to be. So the compensation moves to the only
 * currency left: a class carries as much extra corner ask as its straight-line deficit costs it.
 * Calibrated off the two runs above — 1 % of top speed is worth ~0.19 s a lap and 1 % of corner G
 * ~0.12 s, so the exchange rate is about 1.5 % of G per 1 % of top — and the exponent is set a
 * little under full compensation (0.95 of the deficit, not 1.4× it) because the point is a field
 * that finishes together, not four classes with identical lap times. A supercar is still the
 * quickest thing out here; it just cannot also out-brake the truck into every corner.
 *
 * It is a BALANCE OF PERFORMANCE and it is applied ONCE, at construction, off the class table and
 * the player's own machine. It cannot see how the race is going, it does not move during the
 * race, and it is identical for a player who wins by thirty seconds and one who spins on lap one.
 */
function cornerComp(ph, m = { top: 1 }) {
  const anchor = TOP_ANCHOR * (m.top ?? 1);
  return clamp(Math.pow(anchor / (ph?.topSpeed || anchor), 0.95), 0.86, 1.16);
}
/**
 * …AND THERE IS NO `PREP_TOP` ANY MORE. ROUND 9, and it is the whole round.
 *
 * Every earlier round prepped a TALLER TOP GEAR onto the slow classes so that seven cars of four
 * classes could run down a straight together: `PREP_TOP` 80.5 m/s with a 1.20 ceiling, plus the
 * matching `power` so they had the legs to reach it. Measured on the shipped build with
 * `tools/_zzr2_speed.mjs` (the critic's own probe — LA, player flat out in the muscle car):
 *
 *      the player's muscle    spec 167 mph, measured peak 166
 *      ROMAN's muscle         spec 180 mph, peak 185 — THE SAME CAR, 8 % more top end
 *      HAN's SUV              spec 180 mph, peak 192 — a class the player tops out at 151
 *      the three supercars    spec 188 mph — the only class that was never prepped
 *
 * — i.e. the field was driving a car the player cannot buy, in the one dimension a player can
 * measure by looking at the speedo. And it is what produced the YO-YO: 11,008 frames with an
 * opponent on screen inside 70 m of a flat-out player had relative speed p05 −48.9 mph, p95
 * +57.8, with 54 % of frames more than 20 mph apart. Cars surged past on the straights on speed
 * the player did not have and were reeled back in the corners. That reads as rubber banding even
 * though the band was nowhere near it.
 *
 * So the straight line is now EXACTLY the showroom: `topSpeed`, `power` and the longitudinal
 * `traction` of every opponent are the numbers `handling.js` gives the player's own car of that
 * class, untouched. `tools/_r3speed.mjs` asserts it field-wide — every driver's live
 * `body.p.topSpeed` equals `getVehicle(class).spec.physics.topSpeed` to the digit.
 *
 * What pays for that, and where: the field lost 2–3 s a lap of straight-line time, and it is
 * bought back in the CORNERS, which is the one place an arcade grid is allowed to be prepared —
 * `PREP_G` 1.72 → 1.86 and `REF_LAT_G` 1.42 → 1.55. That is not a free pass either, and the size
 * of it is worth stating plainly: the ask lands at 1.48–1.52 G against the player's own muscle
 * car's 1.29 G of real tyre, so an opponent carries about 8 % more corner speed than a perfect
 * lap in the player's car — where before it carried 8 % more corner speed AND 8–19 % more top
 * speed. Corner speed is also the half a player cannot read off a dial, and the half that keeps a
 * pack together instead of firing it up the road: a corner is where §6.10's "close and
 * aggressive" actually happens.
 */

/**
 * Build the race-prepped physics table an opponent actually drives. Returns the input untouched
 * when a class needs no preparation (the supercar needs none of it).
 */
function racePrepped(ph, m = { top: 1, grip: 1 }) {
  const gripAvg = (ph.gripFront + ph.gripRear) * 0.5;
  const realG = gripAvg * (1 + (ph.downforce ?? 0) * 0.55);
  // the same slice-of-its-own-tyre the driver is allowed below (`gripCeil`), so the prep targets
  // the figure the corner solve will actually be able to use rather than a paper one
  const ceil = lerp(0.95, 0.86, smoothstep(1600, 2500, ph.mass || 1500));
  // …and the target carries the class's corner compensation, or the prep would size the tyre for
  // an ask the driver is no longer making (see `cornerComp` and `AIDriver.refG`).
  const gripMul = clamp((PREP_G * m.grip * cornerComp(ph, m) / ceil) / realG, 1, PREP_MAX_GRIP * m.grip);
  // brakes, on the same principle as REF_DECEL: only the class that cannot reach the common
  // braking figure on its own gets any, and only enough to reach it.
  const brakeMul = clamp((REF_DECEL * m.grip * 1.06 * ((ph.mass || 1500) / 1400)) / (ph.brake || 20), 1, 1.35 * m.grip);
  // …and the retired one, off unless a probe is A/B-ing against the round-8 build (AI_TUNE.prepTop)
  const topMul = AI_TUNE.prepTop
    ? clamp(PREP_TOP_LEGACY * m.top / (ph.topSpeed || 74), 1, 1.20 * m.top) : 1;
  if (gripMul === 1 && brakeMul === 1 && topMul === 1) return ph;
  return {
    ...ph,
    gripFront: ph.gripFront * gripMul,
    gripRear: ph.gripRear * gripMul,          // BOTH axles by the same factor: a·μf / b·μr is
    // unchanged, so the class's understeer/oversteer balance — and every stability derivation
    // physics.js makes off it — is exactly what the handling table says it is.
    brake: (ph.brake || 20) * brakeMul,
    ...(topMul === 1 ? null : {
      topSpeed: (ph.topSpeed || 74) * topMul,
      power: (ph.power ?? 22) * topMul,
      traction: (ph.traction ?? 22) * lerp(1, gripMul, 0.8),
    }),
    // …AND NOTHING ELSE — the three keys above this line are reachable ONLY through the A/B
    // ablation. `topSpeed`, `power` and `traction` are the STRAIGHT LINE and the LAUNCH, the two
    // things a player measures by watching the car in front pull away, and in a real race an
    // opponent gets exactly the ones the showroom gives the player. See the note over PREP_G.
    // (`traction` was lifted with the tyres — `lerp(1, gripMul, 0.8)` — which is defensible as
    // rubber but reads as acceleration: it is worth ~0.2 s a lap and not worth the argument.)
    prep: { grip: +gripMul.toFixed(3), top: +topMul.toFixed(3), brake: +brakeMul.toFixed(3) },
  };
}

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
// Where the field's pace starts before Race._pace has measured anybody: at the field's own honest
// pace, because that is now the only pace there is (see PACE_NOM). It used to start deliberately
// under the field's ability so a quick player could get past the grid; the field no longer moves
// far enough from here for the starting value to matter.
const START_PACE = 1.00;

/**
 * THE FIELD'S HONEST PACE, AND THE ±6 % THE DIRECTOR MAY TRIM AROUND IT — see `Race._pace`.
 *
 * ROUND 8. Every earlier round widened or narrowed this range while leaving the principle alone,
 * and the principle was the bug: THE FIELD HAD NO PACE OF ITS OWN. Round 7 shipped [0.60, 1.26],
 * and measured over four full LA races on one seed with only the player's pace changed
 * (`tools/_race_sweep_r8.mjs`), that range meant the field simply drove at whatever speed the
 * player did —
 *
 *      player lap 58.8 s → field best 57.2 s (pace floored at 0.60) → player P3
 *      player lap 51.6 s → field best 48.6 s                        → player P1
 *      player lap 46.7 s → field best 43.7 s (pace on the 1.26 stop) → player P4
 *      player lap 44.5 s → field best 42.6 s (pace on the 1.26 stop) → player P1
 *
 * — a 14-second span of field lap time controlled by nothing but the controller in the player's
 * hands, and a finishing position uncorrelated with how well the race was driven. Driving 25 %
 * slower was worth a BETTER result than driving flat out. That is not a race; it is a slider.
 *
 * So the range is now a trim, not a transmission. `PACE_NOM` is the field's own pace — calibrated
 * on the solo probe (`tools/_race_r7solo.mjs`, band and re-station off, pace pinned) so that the
 * seven drivers lap LA in 45.5–49.1 s on their own hands, which is the lap time this game's cars
 * and this file's corner solve actually make. `PACE_BAND` is all the authority the director has
 * over it: ±6 %, about ±1.4 s a lap, which is smaller than the spread between the best and worst
 * driver in the field (3.6 s) — so WHO you are racing matters more than what the director wants,
 * which is the whole claim. What the trim buys is that the pack does not drift apart over three
 * laps; what it cannot buy any more is the result.
 */
const PACE_NOM = 1.00;
const PACE_BAND = 0.06;
const PACE_LO = PACE_NOM * (1 - PACE_BAND);
const PACE_HI = PACE_NOM * (1 + PACE_BAND);
/** …and how long the opening lasts, in seconds — see the grace clamp in `Race._pace`. */
const PACE_GRACE = 20;
/**
 * THE BAND'S TWO CEILINGS — how much of its own pace a driver may spend catching the ladder up,
 * and how much it may be asked to give away holding station. See the authority envelope in
 * `AIDriver.step`; these are the far, fully-hidden ends of it.
 *
 * ROUND 8, and the second half of the same fix as PACE_NOM. Round 7 ran a single ±34 % ceiling,
 * six times wider than the whole field-pace range that replaced it — so cutting the director's
 * range without cutting this would simply have moved the rubber band from one knob to the other.
 * Measured on the round-7 build against a flat-out player, the field's best lap went to 42.6 s
 * against its own honest 45.5–49.1 s: a THREE-SECOND-A-LAP catch-up nobody had driven for.
 *
 * They are deliberately ASYMMETRIC, because the two directions are not the same promise:
 *   · CATCH-UP is a car making back what it lost, and 7 % is ~3 s a lap — a 200 m mistake rejoined
 *     over one lap, which is as much as an honest recovery ever needs. It is emphatically not
 *     enough to un-lose a race to a player who is quicker than the field, which is the property
 *     the round-7 critic found missing: a record-beating drive finished third inside road the
 *     director had invented.
 *   · HOLD-BACK is a car that is already up the road being asked to wait, and it can only ever
 *     make the player's race EASIER, never take a result off them. It gets a little more (10 %)
 *     because it is what keeps a field quicker than an ordinary player inside the same postcode
 *     as them — §6.10's "2–4 cars visible ahead" — and because the authority envelope already
 *     forbids nearly all of it on any car the player can actually see. It is not much more: at
 *     16 % the winner's race time was still a 12-second function of how fast the player drove,
 *     which is the round-4 critic's own test for a field that waits.
 */
const TRIM_CATCH = 0.07;
const TRIM_HOLD = 0.10;

/**
 * THE PER-DRIVER CLAMPS, DERIVED — not written down twice.
 *
 * `basePace`, `speedPace` and `cornerPace` in `AIDriver.step` are each clamped so no amount of
 * skill spread or band trim can ask for a nonsense number. They are derived from the range so the
 * range is the only place the numbers live — and, since round 8, with ENOUGH HEADROOM FOR THE
 * TRIM ON TOP. `PACE_CEIL` used to be `PACE_HI` exactly, which meant a car already at the top of
 * the director's range had its whole catch-up trim clipped off by the clamp; with the range now
 * six per cent wide instead of sixty-six, that clamp would have eaten the band entirely.
 */
const PACE_FLOOR = PACE_LO * (1 - TRIM_HOLD) * 0.98;
const PACE_CEIL = PACE_HI * (1 + TRIM_CATCH) * 1.02;

/**
 * THE GRID, IN METRES. See `Race.grid` for why these are metres and not fractions of the road.
 *   GRID_FRONT    from the start line to the front row's axle line
 *   GRID_ROW      between rows of the same column
 *   GRID_STAGGER  how far back the outer column sits from the inner one
 *   GRID_INNER    the inner column's distance from the centre line — one lane, so the double
 *                 yellow is visibly clear on the inside of the whole grid
 *   GRID_COLUMN   across from the inner column to the outer one
 */
const GRID_FRONT = 6.2;
const GRID_ROW = 9.4;
const GRID_STAGGER = 3.6;
const GRID_INNER = 2.5;
const GRID_COLUMN = 4.4;

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
 * …and the NEAR bound of that ladder, which is the only part of it the band enforces from the
 * inside. See the `nearBound` block in `AIDriver.step`: a car behind the player is never asked to
 * back off toward its slot, because a car behind the player is racing the player. It is only ever
 * eased when it is inside the chase rig itself, and this is where that starts.
 */
const BEHIND_KEEP = 13;

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
  restation: 1,     // the out-of-shot re-station (Race._restation)
  nitro: 1,         // opponents spend their tanks
  lens: 1,          // keep opponents out of the chase camera
  // THE ROUND-8 STRAIGHT LINE, FOR A/B ONLY — see the note over PREP_G. Set to 1 BEFORE
  // `startRace()` and every opponent gets the old race-prepped top gear back (80.5 m/s and the
  // power to reach it), which is the build the round-2 critic measured at 180–188 mph against the
  // player's 167. It exists so the claim "the field now drives the player's cars" is falsifiable
  // in one line rather than by taking this file's word for it:
  //     node tools/_r3speed.mjs                  → PASS, every table matches the showroom
  //     node tools/_r3yoyo.mjs --prepTop 1       → the round-8 straight line, same seed
  prepTop: 0,
};

/** The retired straight-line prep — only reachable through `AI_TUNE.prepTop`. See PREP_G. */
const PREP_TOP_LEGACY = 80.5;

/**
 * THE RE-STATION — see `AIDriver.slide` and `Race._restation`.
 *
 * `DEAD` is how far off its station a car has to be before the director touches it at all: inside
 * this it is the band's job, and the band is a pace trim nobody can see. `MAX` is the fastest the
 * road is ever allowed to move under a car, in m/s — about half a car length a frame at 60 Hz, and
 * only ever applied where `hidden` says the car is not in the picture. `HOLD` is the corridor
 * around the player the slide will not enter: the last 60 m to the player's own track position has
 * to be driven, so a car never materialises alongside.
 */
const RESTATION_DEAD = 45;
const RESTATION_MAX = 24;
const RESTATION_HOLD = 60;
/** …and the hard gate: nothing this plainly in frame is ever touched, at any rate, for any reason. */
const RESTATION_SEEN = 0.35;
/** …and it does not act at all until the grid has had a lap-ish to sort itself out honestly. */
const RESTATION_DELAY = 8;
/**
 * THE BUDGET — how much road the director may GRANT the whole field in one race, as a fraction of
 * one car's race distance.
 *
 * IT IS ZERO. ROUND 8 DELETED FORWARD ROAD-GRANTING OUTRIGHT.
 *
 * Round 5 measured 5,130 m of road going under the field in one LA race — about 700 m a car, a
 * tenth of the race distance, granted rather than driven — and answered it with a budget: 5.5 %
 * of one car's race distance, ~370–510 m on these four tracks. That is still an entire race
 * budget, and round 7's critic showed exactly what it buys when it is spent all at once. A
 * flat-out player was clear in P1 by t = 41.7 s with no car within 120 m; between t = 41 s and
 * t = 94 s `slideFwd` went 5 m → 511 m — the whole budget — and the player, who had just broken
 * the course record by 28.59 s, finished third, 0.23 s behind, INSIDE ROAD THE DIRECTOR HAD
 * INVENTED. A number that small can still decide a race because it is spent precisely where the
 * race is decided.
 *
 * There is no honest size for this. Road that a car did not drive is road it did not drive, and
 * a player who has earned a gap has earned it. So the mechanism keeps only the half that cannot
 * take a result off anybody: a car may still be HELD BACK toward its station (`ds < 0`, and only
 * out of shot), which can only ever make the player's race easier, and it is never moved forward
 * by a single metre for any reason. `telemetry()` still reports `slideFwd` beside `slideBack` so
 * the claim is checkable rather than believable — `slideFwd` is 0 in every race now, and a probe
 * that ever reads anything else has found a bug.
 */
const SLIDE_BUDGET_FRAC = 0;
/**
 * …AND THE HOLD IS BUDGETED TOO, for the same reason the grant was.
 *
 * "Holding a field back can only make the race easier, so it needs no bound" is how the forward
 * budget was argued down from infinity to 511 m, and it is wrong in the same way. Measured on the
 * first cut of round 8, with the grant deleted and the hold left unbounded, a player lapping LA
 * 25 % off the pace had 10,580 m of road taken out from under the field in one race — six times
 * the length of the circuit, four times what the whole field had been GRANTED at its worst. A
 * mechanism spending that much is the race, whichever direction it points.
 *
 * So: 4 % of one car's race distance, about 370 m across the whole field over three laps — 50 m
 * a car, which is a pack being tidied rather than a race being run. When it is gone the field
 * simply drives away from a player who is not quick enough to hold it, which is what should
 * happen.
 */
const SLIDE_HOLD_FRAC = 0.04;

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

  /**
   * Move the counter ALONG THE LAP by `dRaw` laps without the car having driven it — the director's
   * out-of-shot re-station (`Race._restation`). It has to be a distinct entry point from
   * `advance()` because `advance()` derives everything from a `u` read off the track and validates
   * checkpoints against it: a car slid 40 m up the road would be read as having skipped a sector
   * and would lose the lap it was on.
   *
   * The sectors are GRANTED here, exactly as `reformPack` grants them, because the director moved
   * the car and not the driver. Lap crossings are still credited properly (with a real lap time)
   * so a car slid over the line finishes the race instead of driving on forever — that was the one
   * way this could have quietly broken the classification.
   */
  shift(dRaw, time) {
    if (!dRaw) return false;
    const before = this.lap;
    this.raw += dRaw;
    this.u = wrap01(this.raw);
    this.cp = Math.floor(this.raw * this.n);
    const lap = Math.floor(this.cp / this.n);
    if (lap > before) {
      if (before >= 0) {
        const lt = time - this.lapStart;
        if (lt > 0) {
          this.lapTimes.push(lt);
          if (this.best == null || lt < this.best) this.best = lt;
        }
      }
      this.lapStart = time;
    } else if (lap < before) {
      // A SHIFT CAN GO BACKWARDS OVER THE LINE, AND THE LAP IT UNDOES HAS TO BE UNDONE.
      //
      // The hold half of the re-station moves a car back down the road, and a car held while it
      // is sitting on the start line crosses, is pushed back over, and crosses again — with the
      // lap clock restarted by the first crossing. Measured before this branch existed: a driver
      // in a 0.70-pace LA race came home with a BEST LAP OF 0.02 s on the results screen and in
      // `telemetry().field`, which is the classification telling a provable lie about the race.
      // So a backward crossing rolls the credit back: the lap time it granted is popped, the lap
      // clock is rewound to where that lap actually started, and `best` is re-derived from what
      // is left rather than being left holding the phantom.
      const lt = this.lapTimes.pop();
      if (lt != null) {
        this.lapStart -= lt;
        this.best = this.lapTimes.length ? Math.min(...this.lapTimes) : null;
      }
    }
    this.lap = lap;
    this.progress = this.raw;
    return lap > before;
  }
}

// -------------------------------------------------------------------------------------------
// Opponent
// -------------------------------------------------------------------------------------------

export class AIDriver {
  constructor(id, track, spec, opts = {}) {
    this.id = id;
    this.track = track;
    // THE CAR THIS DRIVER ACTUALLY HAS — a race-prepped COPY of the class table (see racePrepped).
    // It must be a copy: `getVehicle()` caches one spec object per class and the player's own car,
    // the garage and the audio voicing all read it. `VehicleBody` snapshots `spec.physics` at
    // construction, so everything below — the corner solve, the braking figure, the launch — sees
    // the prepped numbers and the rest of the game sees the showroom ones.
    // …to the reference the director set for THIS race, from the player's own machine (machineRef)
    this.machine = opts.machine || { top: 1, grip: 1 };
    const prepped = racePrepped(spec.physics, this.machine);
    this.spec = prepped === spec.physics ? spec : { ...spec, physics: prepped };
    spec = this.spec;
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
    // ROUND 9 FLATTENED THE CLASS TERM. It was `lerp(1.30, 0.85, …)`, written when every opponent
    // was prepped to a common 80.5 m/s so the term barely varied — all four classes landed within
    // 0.94–0.95 of each other. On the showroom tables it spans 1.26 (SUV) to 0.85 (supercar), and
    // measured with `tools/_r3speed.mjs` that put HAN's SUV on the bottle for 52 % of an LA race
    // against a player's ~35 %: the class that had just lost its taller top gear was answering
    // with nitrous instead, which is the same +50 mph surge past the player wearing a plume. The
    // corner compensation (`cornerComp`) is where that lap time is supposed to come from now, so
    // the bottle bias is a tilt again rather than the answer.
    this.boostEager = clamp(r.range(0.35, 1.0)
      * lerp(1.08, 0.90, clamp(((spec.physics.topSpeed || 74) - 66) / 18, 0, 1)), 0.2, 1.3);
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
    this.hidden = 1;              // 0..1 how certainly this car is OUT of the player's shot
    this.slideM = 0;              // metres the director has re-stationed this car (telemetry)
    this.slides = 0;
    this.slideV = 0;              // this frame's re-station rate, m/s, signed (+ = dragged forward)
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
    // …normalised against the reference the grid was BUILT to (machineRef), not against a literal
    // 74 m/s. Left as an absolute, the straight-line normaliser undid the prep the moment the
    // player brought a quicker car than the one it was written for.
    this.paceMul = lerp(0.955, 1.035, this.skill)
      / Math.pow((ph.topSpeed || TOP_ANCHOR) / (TOP_ANCHOR * this.machine.top), 0.55);
    // Real cornering ability, in G: the tyres this class has plus the aero it makes at the speed a
    // corner is taken. NOTHING the driver does is ever allowed past this — see the corner solve.
    this.classG = (ph.gripFront + ph.gripRear) * 0.5;
    this.realG = this.classG * (1 + (ph.downforce ?? 0) * 0.55);
    // …and the figure the DIRECTOR asks for, which is mostly the common reference. The exponent
    // leaves the supercar the best-handling thing on the road while compressing the field's
    // cornering spread: on the race-prepped cars above it comes to supercar 1.396 G, SUV 1.374,
    // tuner 1.364, muscle 1.359 — 2.7 %, i.e. 1.4 % of corner speed. It was 0.20, which on the
    // prepped tables leaves 5.3 %; the supercar keeps its identity down the STRAIGHTS instead
    // (PREP_TOP stops at 77 m/s and it has 84), which is where a player can see it.
    this.comp = cornerComp(ph, this.machine);
    this.refG = Math.pow(this.realG, 0.12) * Math.pow(REF_LAT_G * this.machine.grip * this.comp, 0.88);
    // How much of its own tyre a driver is allowed to lean on. A 2.5 tonne car is still rolling
    // when it reaches the apex, so it gets a slimmer slice than a supercar on race springs.
    this.gripCeil = clamp(lerp(0.95, 0.86, smoothstep(1600, 2500, ph.mass || 1500))
      * (1 + (this.skill - 0.82) * 0.32), 0.78, 0.985);
    // Braking, m/s². `physics.js` applies `p.brake` as a deceleration directly and then ADDS a
    // speed/aero gain on top (`bf`), so this — the low-speed figure with a fraction of that gain —
    // is always inside what the car can really do. Capped at REF_DECEL so the classes that stop
    // hardest do not also get to brake latest: only the class that cannot reach the reference
    // (the SUV, at 15.8) is limited by its own brakes.
    this.brakeCap = (ph.brake || 20) / ((ph.mass || 1500) / 1400);
    this.shortcuts = 0;           // shortcuts genuinely driven end to end (telemetry `cuts`)
    this.cutStray = 0;            // …of which this many were never chosen — ran wide onto one
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
    this._cutFrom = null; this._cutCredit = false; this._cutChosen = null;
    this._cutRoll = null; this._cutRollLap = null; this._cutTake = false;
    this.passOff = 0; this.passWant = 0; this.avoid = 0;
    this.slideM = 0; this.slides = 0; this.slideV = 0;
    this.nitro.reset();
    this.finished = false;
    this.finishTime = null;
    return this;
  }

  /**
   * SLIDE ALONG THE ROAD by `ds` metres. The director's re-station (`Race._restation`), and the
   * one thing in this file that moves a car without the driver having driven it.
   *
   * Why it exists: the band trims PACE, and pace has a ceiling — a car cannot exceed its own top
   * speed however much the director wants it back. Measured on LA against a strong autopilot, the
   * field pace sat welded to its 1.13 stop for 73 % of the race, every driver's trim sat on its
   * bound, and the field still went from 20 m to 864 m adrift and never came back. Position is the
   * only quantity with the authority to fix a gap that large, so the director is allowed to move a
   * car along the road — but ONLY where nobody can see it happen, only toward the station the
   * ladder already wants it on, and never fast enough to be a teleport.
   *
   * It is a slide, not a respawn: it is a RIGID RE-FRAME of the car's exact offset from the road
   * — its lateral, its along-sample residual, its height and its heading relative to the road are
   * all carried across — so the car keeps its speed and its line and simply finds itself further
   * up (or down) the same piece of road.
   *
   * The offset MUST be measured off the car's live position, not off `this.u`. `this.u` is a
   * frame stale by the time the director runs (it is read at the top of `step()` and the physics
   * integrate after it), so rebuilding the car from it silently threw away the ~1 m the car had
   * just travelled — 60 m/s of it at 60 Hz. Measured on the first cut of this: the field's lap
   * time went from 48 s to 78 s and the gaps it was meant to close grew from 860 m to 3900 m.
   */
  slide(ds, ctx = {}) {
    if (!ds) return false;
    const t = this.track;
    const b = this.body;
    const u0 = wrap01(this.locate(b.pos).u);
    const u1 = wrap01(u0 + ds / t.length);
    const s0 = t.at(u0), s1 = t.at(u1);
    // the car's exact offset from the road frame at u0, resolved in that frame
    _v.copy(b.pos).sub(s0.pos);
    const along = _v.dot(s0.tan);
    const lat = clamp(_v.dot(s0.right), -t.halfWidth * 0.95, t.halfWidth * 0.95);
    const dy = _v.y - (along * s0.tan.y + lat * s0.right.y);
    b.pos.copy(s1.pos).addScaledVector(s1.tan, along).addScaledVector(s1.right, lat);
    b.pos.y += dy;
    // …and the VELOCITY turns with the car, or the tyre model reads the re-station as a slide and
    // the car arrives smoking and sideways (the same trap `_flag` documents).
    let dh = Math.atan2(s1.tan.x, s1.tan.z) - Math.atan2(s0.tan.x, s0.tan.z);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.yaw += dh;
    const c = Math.cos(dh), sn = Math.sin(dh);
    const vx = b.vel.x, vz = b.vel.z;
    b.vel.x = vx * c + vz * sn;
    b.vel.z = -vx * sn + vz * c;
    const lapDone = this.counter.shift(ds / t.length, ctx.time ?? this.totalTime);
    this.u = this.counter.u;
    this.lap = this.counter.lap;
    this.progress = this.counter.progress;
    this.slideM = (this.slideM || 0) + Math.abs(ds);
    this.slides = (this.slides || 0) + 1;
    if (lapDone && this.lap >= (ctx.laps ?? 3) && !this.finished) {
      this.finished = true;
      this.finishTime = ctx.time ?? this.totalTime;
    }
    return lapDone;
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
            // …and this one was NOT CHOSEN. A driver that ran wide off a corner exit and found
            // itself on a ribbon is still on the ribbon and is still credited with the traversal
            // if it drives it end to end — but it was never OFFERED the cut in the sense the
            // decision roll below means, so counting it against `cutSeen` produced the round-2
            // critic's contradiction: LETTY and DOM reported cuts=7 against cutSeen=6, i.e. more
            // shortcuts driven than shortcuts the driver was ever shown. `cutStray` is the
            // difference, and it makes the three counters add up.
            onBranch = nb; this._cutChosen = false; break;
          }
          continue;
        }
        // …AND THE STICKY BOUND HAS TO CLEAR THE RIBBON'S OWN BARRIER (round 7). `wallAt` below is
        // 1.52 of the half-width and this was 1.45, so a car running wide on a shortcut lost the
        // branch BEFORE the branch's wall could catch it: it was handed back to the street at a
        // street lateral of 1.5–2.0, i.e. dropped into the scenery beside the ribbon with a street
        // barrier it had no way to see coming. The comment beside this line has claimed since
        // round 2 that a car running wide "hits the shortcut's own wall, like a driver would", and
        // with 1.45 against 1.52 it could not. Measured solo on LA with the shortcuts on: zero
        // barrier hits ON any ribbon in the whole field against four on the street for the SUV
        // alone, all of them within three seconds of a shortcut, and 3.6 of its 5.4 s a race off
        // the road. One more tenth of half-width, and the failure is a wall you can see.
        const own = this.branch === br ? 1.62 : 1.05;
        if (Math.abs(nb.lateral) < own && nb.dist < br.halfWidth * (own + 0.7)) {
          onBranch = nb; this._cutChosen = true; break;
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
      // Credit a shortcut only when the car has genuinely been THROUGH one. Both mouths of a
      // branch sit on the centreline of the street, so anything driving past one is momentarily
      // inside its ribbon and "on" it — counting those was reporting a dozen shortcuts a race for
      // drivers who had never left the road. Entered before a quarter, still on it past three
      // quarters: that is a cut.
      if (this._cutFrom == null) this._cutFrom = onBranch.t;
      if (!this._cutCredit && this._cutFrom < 0.25 && onBranch.t > 0.75) {
        this.shortcuts++; this._cutCredit = true;
        if (this._cutChosen === false) this.cutStray = (this.cutStray || 0) + 1;
      }
    } else if (this.branch) {
      this.branch = null;
      this.branchCool = 4;
      this._cutFrom = null; this._cutCredit = false; this._cutChosen = null;
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
    // HOW CERTAINLY THIS CAR IS OUT OF THE SHOT — the gate on everything the director is allowed
    // to do to it, and a different question from `onScreen`. A car 40 m BEHIND the player scores
    // `onScreen` 0 because the chase rig has no mirror, but round 4 still handed it the 1.5 %
    // authority of a car sitting on the player's bumper, because the authority envelope was drawn
    // in RAW DISTANCE. That is exactly backwards: the whole point of the envelope is "nothing you
    // can see is being helped", and the road behind you is the one place a director can work
    // freely. `hidden` is the visibility answer — 1 when the car is genuinely not in frame — and
    // it is what both the band's authority and the re-station now key off.
    this.hidden = clamp((1 - this.onScreen)
      // …but not right on the bumper: a car two lengths behind is about to be a car you are racing,
      // and it arrives at the mirror-less zone from a place you were looking at a second ago.
      * smoothstep(14, 46, seen), 0, 1);
    // THE LADDER IS ONE-SIDED BEHIND THE PLAYER — the round-6 fix, and the quiet half of the
    // fast-player collapse.
    //
    // The band pulls a car toward its station from BOTH sides, which is right in front of the
    // player and wrong behind them. A car the player has just passed sits at −2 m with a −17 m
    // slot, and the band reads that as "you are fifteen metres too close" and trims its pace DOWN.
    // So every place a quick player took made the field slower — and because `_pace` integrates
    // the MEAN band across the field, it dragged the whole field's pace down with it: measured from
    // the LA grid against a flat-out player, `fieldPace` fell 0.950 → 0.914 over the thirty seconds
    // in which the player went from P8 to P1. The director was asking the field for four per cent
    // less at exactly the moment it was being overtaken.
    //
    // A car behind the player is racing the player. The only reason left to ease one off is the
    // chase lens — the rig hangs 6–12 m back with no mirror — so the near bound is BEHIND_KEEP and
    // nothing between there and the ladder slot is corrected at all. In front of the player the
    // band is unchanged: a car ahead of its slot is still held back, which is what keeps the field
    // from running away from an ordinary player.
    const nearBound = this.station < 0 ? Math.max(this.station, -BEHIND_KEEP) : this.station;
    // The deadband scales with the station: a car whose job is to sit on the player's bumper is
    // held to ±5 m, one holding 120 m to ±20. Inside it the driver races on its own pace, so the
    // field is not permanently micro-correcting toward a ladder.
    const gapErr = aheadM < this.station ? aheadM - this.station
      : (aheadM > nearBound ? aheadM - nearBound : 0);
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
    //   · far ≈ 0 (inside 65 m): ≤1.2 % of pace. A fifth of what a draft is worth. Whatever you
    //     are looking at is racing you honestly.
    //   · far ≈ 1 (beyond 260 m, and therefore out of shot): TRIM_CATCH going forward, TRIM_HOLD
    //     going back — 7 % and 10 %, which is ~200 m of a mistake rejoined over a lap.
    //
    // `onScreen` then takes another bite out of it, so a car that is somehow both distant and
    // squarely in frame is still nearly untrimmed.
    // …and it is drawn in VISIBILITY, not in raw distance. `far` was `smoothstep(65, 260, seen)`,
    // which gave a car 60 m BEHIND the player — a car in nobody's field of view, on a rig with no
    // mirror — the same 1.5 % of authority as one on the player's front bumper. That is most of
    // why the round-4 field, once it had fallen off the back of a quick player, never came back:
    // measured on LA at a strong pace, every driver's trim was pinned and the whole field still
    // went from 20 m to 864 m adrift. `hidden` (above) answers the question the envelope is
    // actually asking, and the raw-distance term stays as the second half of it so a car a long
    // way UP the road still gets the full allowance even when it is technically in frame.
    const far = Math.max(smoothstep(65, 260, seen), this.hidden);
    // …AND THE FAR END OF THE ENVELOPE IS A DIFFERENT NUMBER IN EACH DIRECTION (round 8, see
    // TRIM_CATCH / TRIM_HOLD). One 34 % ceiling for both was six times the width of the whole
    // field-pace range that round 8 leaves the director, so it — not the pace loop — was where
    // the rubber band had been living: a car far enough back and out of shot was handed three
    // seconds a lap it had not driven for, all race, which is exactly how a record-beating player
    // finished third. Catching up is now worth 7 %; being asked to wait is worth 10 %, because
    // waiting cannot take a result off anybody.
    const authMax = this.band > 0 ? TRIM_CATCH : TRIM_HOLD;
    const auth = lerp(0.012, authMax, far) * lerp(1, this.band < 0 ? 0.30 : 0.10, this.onScreen)
      // …and the whole envelope is then scaled by how certainly the car is out of frame, which is
      // the principle the envelope exists to state. Without it a car 160 m up the road — plainly
      // a car, with taillights, on the same straight as you — could be held 16 % below its pace,
      // and round 1's critic measured exactly that: `trimOnScreen` reaching 0.163 and sitting at
      // ≥0.10 with three cars in frame for 42 % of a race. That is the field visibly waiting.
      * lerp(0.35, 1, this.hidden);
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
    // (bounds are PACE_FLOOR/PACE_CEIL, derived from the director's own range — see the comment
    // there for why they are no longer literals)
    const basePace = clamp(this.paceMul * (ctx.fieldPace ?? 1), PACE_FLOOR, PACE_CEIL);
    // …and the straight-line half is capped at the director's own ceiling, not at some multiple of
    // this driver's normalised pace. Above that the car is asking for a speed its brakes cannot
    // undo before the next corner however far ahead it looks, and a catch-up that ends in a
    // barrier is not one. In practice this bound is rarely what binds: `physics.js` caps every car
    // at its own `topSpeed`, so the real straight-line ceiling is the race-prepped table (or the
    // bottle), which is why the nitrous rewrite above is where the field's straight-line answer to
    // a quick player actually lives.
    const speedPace = clamp(basePace * (1 + this.trim), PACE_FLOOR * 0.95, PACE_CEIL);
    // THE CORNER HALF IS CLASS-FREE. `paceMul` above is a TOP-SPEED index and belongs on the
    // straights; feeding it into the corner solve as well (round 3) both double-counted the class
    // and was thrown away again by the tyre ceiling, which is why the SUV — nominally handed 14 %
    // more pace than the supercar — actually cornered 16 % slower than the tuner and finished
    // every race last, 822 m adrift at the LA flag with HAN and LETTY never once changing places.
    // What is left here is what a DRIVER brings: skill, the field pace, and the corner half of
    // the band's trim.
    // (bounds derived from the director's range, see PACE_FLOOR)
    const cornerPace = clamp(lerp(0.86, 1.00, this.skill) * (ctx.fieldPace ?? 1)
      * (1 + this.trim * 0.40), PACE_FLOOR, PACE_CEIL);
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
    // …AND THE REFERENCE IS THE FIELD'S, TILTED BY THE HANDS (round 7). Every class's brakes clear
    // REF_DECEL after `racePrepped`, so `Math.min(..., REF_DECEL)` was the binding term for all
    // seven cars and the `lerp(0.80, 0.98, skill)` in front of it was multiplying a number that
    // the cap then threw away — which is half of why SKILL WAS WORTH NOTHING. Measured with
    // `tools/_race_r7solo.mjs`, the same seven cars driven at skill 0.85 and at skill 0.97 lapped
    // LA in 45.30 s and 45.28 s: a 14-point spread in ability, two hundredths of a second. The
    // director casts its best drivers into the heaviest cars on purpose (see the grid, below) and
    // the casting could not express itself. Now the reference itself carries the hands, ±3 % about
    // the field's mean skill, and nobody is asked for more than their own brakes make.
    const decel = Math.min(this.brakeCap * brakeGain,
      REF_DECEL * this.machine.grip * (1 + (this.skill - 0.82) * 0.22))
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
    // COOL-DOWN AFTER THE FLAG — but only after the flag. A car that has taken the chequer while
    // the player is still on their last lap used to drop to 26 m/s (58 mph) ON THE RACING LINE,
    // which is a rolling roadblock in the middle of somebody else's race and reads as the field
    // switching itself off the moment it has won. Until the race is classified a finisher simply
    // eases: it is still driving the circuit, just not racing anybody for it.
    if (this.finished) target = Math.min(target, (ctx.flag ?? true) ? 26 : target * 0.90);
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
        // 175 m OF APPROACH, not 110. A shortcut mouth on this project's four tracks sits at a
        // corner exit as often as not (Vegas u = 0.279, NYC u = 0.145), and 110 m at 55 m/s is two
        // seconds — the driver was still IN that corner when it had to decide, failed the tidiness
        // test below, and by the time it had gathered the car up the mouth was behind it. The aim
        // itself still only fades in over the last 55 m (see `targetPos` below), so deciding
        // earlier changes nothing about where the car drives until it is nearly there; it only
        // means the decision is taken somewhere the car is able to take one.
        if (d <= 8 || d > 175) continue;
        // IS THIS CUT WORTH ANYTHING? Not every branch is: measured with tools/_race_cuts.mjs,
        // Miami's u 0.80→0.865 ribbon is 340 m of road replacing 157 m of street and LA's flood
        // channel is 38 m longer than the boulevard it leaves. A driver that dives into one of
        // those is not taking a shortcut, it is taking the long way round in a narrower lane —
        // so the ones that lose distance are simply not on the menu. (Cached on the branch: the
        // geometry never changes.)
        if (br._gainM == null) br._gainM = wrap01(br.exitU - br.enterU) * t.length - br.length;
        // …and a branch that loses distance costs NO cooldown. Round 4 set one, which on a city
        // whose long branch is listed before its good one (Miami: u 0.046 loses 62 m, u 0.575
        // saves 26) blinded the driver to the shortcut it wanted for the next 2.5 s of road.
        if (br._gainM < -8) continue;
        // ONE DECISION PER APPROACH — a coin, weighted, thrown once and then honoured.
        //
        // Round 4 re-evaluated a hard threshold (`skill > 0.68 && appetite > 0.92`) every frame
        // and ANDed it with a tidiness test taken at the same instant, so a driver whose appetite
        // sat below the line took a shortcut NEVER — not this lap, not this race, not ever — and
        // one above the line took every cut on the track every lap. Measured over full races: two
        // of seven drivers (ROMAN in LA and NYC, four of seven in Vegas) finished with a cut count
        // of exactly 0, and it was structural rather than unlucky.
        //
        // A probability, rolled once when the branch comes into view and cached for the rest of
        // the approach, gives the same personalities a different shape: the SUV (off-road grip
        // 0.90) takes a dirt line nearly every time it sees one, the supercar (0.48) takes it
        // about half the time, and no driver is permanently excluded from a route the level
        // designer lit a gate over. It is rolled per LAP as well as per branch, so the same car
        // takes a different line on lap two than it did on lap one.
        if (this._cutRoll !== br || this._cutRollLap !== this.lap) {
          this._cutRoll = br; this._cutRollLap = this.lap;
          const worth = clamp(br._gainM / 26, 0, 1);                 // 26 m saved is a full reason
          const dirt = clamp(((p.offroadGrip ?? 0.58) - 0.46) / 0.44, 0, 1);
          // …and the SAME SHOWTIME BIAS the handbrake flick and the nitrous carry. A shortcut is a
          // piece of level design with a lit gate over it (§6.4), and a cut taken on the far side
          // of the lap is a cut nobody knows happened: measured over full LA and NYC races, every
          // driver was offered six usable branches a race and took four to seven of them, and the
          // player saw almost none of it. A driver the player is actually looking at now takes the
          // route the level designer signposted.
          const show = this.onScreen * 0.30;
          // …and the floor is 0.18, not 0.06. A driver whose personality lands at the bottom of
          // every term (a supercar with no dirt grip, low taste and mid skill) rolled 0.42 and
          // could go a whole race without taking one — which reads from outside as "the AI ignores
          // the shortcuts" even though the mechanism works.
          const chance = clamp(
            0.30 + this.shortcutTaste * 0.38 + dirt * 0.32 + worth * 0.32
            + Math.max(0, this.band) * 0.26 + (this.skill - 0.80) * 0.30 + show, 0.18, 0.96);
          this._cutTake = this.rng.bool(chance);
          // …and the reasoning is kept, bounded, for the probes: `cuts=0` next to a list of
          // TAKEs is a driver missing entries, and next to a list of `no`s it is one refusing
          // them. Telling those apart from the outside took a whole round the last time.
          const dbg = this._cutDbg || (this._cutDbg = []);
          if (dbg.length > 23) dbg.shift();
          dbg.push(`L${this.lap} d=${Math.round(d)} p=${chance.toFixed(2)} ${this._cutTake ? 'TAKE' : 'no'}`);
          this.cutSeen = (this.cutSeen || 0) + 1;
          if (this._cutTake) this.cutWant = (this.cutWant || 0) + 1;
        }
        // The TIDINESS test has moved to where it belongs — the entry, not the decision (see the
        // abandon branch below, which drops a cut the car is arriving at sideways or wide inside
        // the last 45 m). Vetoing the decision with it meant the answer depended on whether the
        // car happened to be straight 110 m earlier, which is a corner-exit lottery and not a
        // driver making a choice.
        if (this._cutTake) this.wantBranch = br;
        else this.branchCool = 1.2;
        break;
      }
    }
    if (this.wantBranch && !this.branch) {
      // MEASURED TO THE MOUTH, NOT TO THE EXIT — and this one line was the whole of "opponents
      // never use the shortcuts".
      //
      // The guard used to read `wrapDelta(u, exitU) > length + 140`, i.e. "the far end of this
      // branch is further away than the branch is long, plus a bit". On a branch whose two ends
      // are 360 m apart along the street and whose ribbon is 345 m long (Vegas u 0.279) that
      // expression is true of any car more than 125 m before the MOUTH — so a driver that had
      // just decided to take the cut threw the decision away on the very next frame, silently,
      // every time. Measured with tools/_race_cutlog_r1.mjs on Vegas: every driver was offered
      // six usable shortcuts and DECIDED to take three to six of them, and between zero and two
      // survived to the mouth. Widening the decision window (above) made it worse rather than
      // better, because the further out you decide, the more certain this test is to fire.
      //
      // What the guard is actually for is "I am not going to reach this mouth": the car is past
      // it, or it has gone backwards. That is a distance to the MOUTH, and it is signed.
      const dm = wrapDelta(u, this.wantBranch.enterU) * t.length;
      if (dm < -12 || dm > 210) { this.wantBranch = null; this.branchCool = 3; }
      // …and a driver ABANDONS a cut it is not going to make. The aim fades in over the last 55 m
      // (below) and a car arriving there genuinely sideways, or well over its own corner solve, is
      // not entering a 7.5 m ribbon — it is about to put two wheels on the kerb beside the mouth
      // and spend four seconds there. Straighten up, stay on the street, take it next lap.
      //
      // It is a test for TROUBLE, not for POSITION. At |lateral| > 0.80 it was neither: measured on
      // Vegas, most of the aborts were cars sitting at exactly 0.80 with zero drift and a tenth of
      // a radian of slip — i.e. cars on a perfectly ordinary wide corner-exit line, which is where
      // that shortcut's mouth is, being told they were in trouble by the very line that was taking
      // them to it. And it is bounded at the near end: aborting 7 m from a mouth the car is already
      // turning into leaves it pointing at nothing, which is worse than either committing or never
      // having tried, so inside 12 m the decision stands.
      else if (dm > 12 && dm < 40 && (Math.abs(b.slip) > 0.30 || b.drift > 0.66
        || Math.abs(lateral) > 1.00 || (speed - target) > 14)) {
        this.wantBranch = null; this.branchCool = 4;
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
      // NOTE (round 6): `launchSpin` is a SPECTACLE flag, not a performance one. It sets
      // throttle = 1 and skips the traction management below, but that management keys on SLIP
      // ANGLE, which is ~0 in a straight-line standing start — so the normal controller asks for
      // full throttle at zero speed anyway and this changes nothing about how the car leaves.
      // What it does is drive the smoke and the skid ribbons in `updateVisuals`. Shortening it to
      // buy the heavy classes a better lap 1 was tried and measured: bit-identical race, shorter
      // grid smoke. It stays as it is.
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
    // …and round 5 made the reach the car's OWN STOPPING DISTANCE from the speed the bottle would
    // carry it to — up to 460 m of road that all had to be straight before anybody would light one.
    //
    // ROUND 6: THAT TEST IS THE FIELD'S BIGGEST SINGLE TIME LOSS. On a street circuit almost no
    // part of the lap has 460 m of straight in front of it, so `straightAhead` was ~0 nearly
    // everywhere: measured over a full-pace LA race the seven opponents spent 6–18 % of the race
    // on the bottle while the player — who simply holds the button down — spent about a third of
    // theirs on it. `physics.js` caps every car at its own `topSpeed`, so a pace trim on a straight
    // is a NO-OP once the ask is already past that cap, and nitrous is therefore the ONLY quantity
    // that lifts an opponent's real vMax. A field that will not spend its tanks cannot answer a
    // player who is quicker than its top speed, whatever the director does — which is exactly the
    // race the round-2 critic measured: 84 % of the race with no opponent ahead of the player.
    //
    // The conservatism is not needed here, because the two things it was protecting against are
    // handled downstream and better: the corner solve above already looks 380 m ahead and has
    // already set `target`, and `overLift` below cancels a live boost the moment the car is over
    // that target. So the only question this has to answer is "is there enough road in front of me
    // to be worth lighting it", and the answer is about two seconds of road.
    const nosReach = clamp(speed * 2.4, 110, 260);
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
      // …AND NO MORE THAN TWO PLUMES IN FRAME, as a rule rather than as a bias. Round 5 dropped
      // the showtime bonus to zero once two were lit but still let a third and a fourth car fire
      // on their own base desire, and round 6 roughly doubled how often the field reaches for the
      // bottle — three or four jets in one frame is not more spectacular, it is a fireworks
      // display, and it is the most expensive fill in the game. Cars the player cannot see are not
      // counted and are not restrained: an opponent chasing on the far side of the lap is exactly
      // who should be spending its tank.
      const inFrame = (ctx.boostBudget ?? 0) >= 2 && this.onScreen > 0.30;
      const show = (ctx.boostBudget ?? 0) < 2 ? this.onScreen * 0.55 : 0;
      // A DRIVER THAT IS BEHIND WHERE IT WANTS TO BE EMPTIES THE TANK. This is the honest half of
      // the round-6 fix: the band asks for pace, pace is capped at the car's own top speed, and the
      // bottle is the only thing on the car that goes past it. So the further behind its station a
      // driver is, the harder it leans on the one part of its own car that can do something about
      // it — and it is spending the SAME three tanks, refilled off the SAME boost pads, on the same
      // state machine as the player. Nothing is granted.
      const chase = Math.max(0, this.band);
      const desire = straightAhead
        * (0.46 * this.boostEager + duel + chase * 0.85 + show);
      if (!inFrame && speed > p.topSpeed * 0.42 && b.drift < 0.45 && this.offRec < 0.2
        && this.rng.bool(clamp(desire, 0, 1) * dt * 3.4)) {
        wantBoost = true;
        // …and the cooldown is short enough that the TANK ECONOMY is what limits them rather than
        // a timer. A tank refills in 5–12 s depending on class (`nitrous.js` refill × 0.30), which
        // is the real budget; round 5's 2.5–10.5 s timer on top of it meant a car could not even
        // spend what it had.
        this.boostCool = this.rng.range(1.1, 3.4)
          * lerp(1.4, 0.7, this.boostEager) * lerp(1, 0.55, chase);
      }
    }
    // Lift for the corner — and lift NOW, not after the half-second minimum, if the car is already
    // well over the speed its own corner solve says it can carry. A bottle is worth a place; a
    // bottle held through the braking zone is worth a barrier.
    const overLift = 7 * clamp(decel / (REF_DECEL * this.machine.grip * 0.92), 0.55, 1);
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
    // THE GRID IS BUILT FOR THE CAR THE PLAYER BROUGHT — once, here, before a wheel turns. See
    // `machineRef`: it reads the class table and nothing about how the race is going.
    this.machine = machineRef(playerSpec?.physics);
    this.standings = [];
    this.cars = null;
    this.effects = null;
    this.contacts = 0;
    this.playerContacts = 0;
    this.reforms = 0;
    this.restations = 0;          // frames on which the director slid somebody (see _restation)
    this.slideM = 0;              // …and the total metres of road it moved under the field
    // …SPLIT BY DIRECTION, because the two halves are completely different claims. FORWARD is road
    // GRANTED to a car that could not drive it — the only half that can hand anybody a place, and
    // deleted outright in round 8, so this counter exists to PROVE it is zero rather than to meter
    // it. BACKWARD is the director holding an over-eager field to the ladder; it costs the player
    // nothing but it is budgeted all the same (SLIDE_HOLD_FRAC), because unbounded it was worth
    // 10.5 km a race.
    this.slideFwd = 0;
    this.slideBack = 0;
    this.slideSeenMax = 0;        // worst `onScreen` of any car at the instant it was slid
    this.slideNearest = Infinity; // …and the closest one has been to the player when slid
    this._slideRate = 0;
    this._lastPlayerPos = null;
    this.wrongWay = false;        // the player is facing back down the road — see `_wrongWay`
    this._wrongT = 0;
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
    // to watch) and a second, visible reason the order is not the class table read out loud. It is
    // not a cheat: only the hands are dealt differently.
    //
    // It is no longer load-bearing, though, and it should not be: `racePrepped` above now takes
    // the field's solo lap-time spread from 8.55 s to 2.34 s at identical skill, and the ±14 % of
    // corner commitment this ladder is worth is a TILT on top of an even field rather than the
    // thing holding one together. The ranking is deliberately still taken on the SHOWROOM tables
    // (`getVehicle().spec`, not the prepped copy), because what it is casting for is the class's
    // character — the truck is the truck whatever tyres it is on. A little jitter keeps it off a
    // perfect anti-correlation, which would read as scripted.
    const ability = (v) => {
      const ph = v.spec.physics;
      return Math.pow((ph.topSpeed || 74) / 74, 0.5)
        * Math.pow(((ph.gripFront + ph.gripRear) * 0.5) * (1 + (ph.downforce ?? 0) * 0.55) / 1.40, 0.7);
    };
    //
    // ROUND 8 HALVED THE TILT, because round 7 made skill mean something and the counterweight was
    // then heavier than the thing it was balancing. The ladder ran 0.66 → 0.96 against a class
    // spread that `racePrepped` had already closed to 1.4 s of solo lap time, and with the brakes
    // and the tyre ceiling finally carrying the hands the casting simply reversed the order it was
    // meant to level: measured over twelve full races (`tools/_race_r7batch.mjs`), mean finishing
    // rank by class came out SUV 3.08 · muscle 3.50 · tuner 3.58 · supercar 4.75, with a supercar
    // last in ten of the twelve. That is the same failure as the round-2 procession wearing the
    // opposite hat. Systematic 0.71 → 0.89 now, with jitter of ±0.07 on top — comparable to the
    // step between neighbours, so the casting is a tilt and a rookie in a supercar can still beat
    // a good hand in a truck on the day, which is the only version of this that does not read as
    // scripted.
    const byClass = picks.slice().sort((a, b) => ability(b.v) - ability(a.v));
    byClass.forEach((pk, k) => {
      pk.skill = clamp(0.71 + (k / Math.max(1, opponents - 1)) * 0.18 + this.rng.range(-0.07, 0.07), 0.60, 0.97);
    });
    for (const pk of picks) {
      const d = new AIDriver(pk.i, track, pk.v.spec, {
        dims: pk.v.blueprint.dims,
        skill: pk.skill,
        machine: this.machine,
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
   *
   * ROUND 9 REBUILT IT, because it is the one frame the camera parks on and it was the weakest
   * thing in the set. It ran two columns at ±0.42 of the half-width — and on a 22 m LA boulevard
   * that is ±4.6 m, i.e. FOUR OF THE EIGHT CARS SAT ENTIRELY IN THE ONCOMING LANE, left of the
   * double yellow, with the outside pair half onto the shoulder. Rows were 6.6 m apart, which is
   * 1.1 m of daylight between a 5.5 m car and the one in front of it, and on any curvature at all
   * the two columns of a row converged until bodywork interpenetrated (the critic photographed a
   * white SUV with a red coupe's rear quarter inside its nose at 3× on `la-grid.png`).
   *
   * The rule now, in metres rather than in fractions of a road whose width the grid never knew:
   *   · BOTH COLUMNS ON THE RACING SIDE of the centre line. `GRID_INNER` is the inside wheel line,
   *     one lane off the yellow; `GRID_COLUMN` is the lane across to the outer column. On a narrow
   *     street both are squeezed toward the crown together (`fit`) so the outer car never ends up
   *     on the shoulder — but never past the centre line, whatever the road does.
   *   · A REAL STAGGER: the outer column sits `GRID_STAGGER` further back, so the frame reads as
   *     a grid rather than as four pairs of cars abreast.
   *   · SEPARATION IS ASSERTED, not hoped for. `GRID_ROW` 9.4 m along the road and 4.4 m across it
   *     put every centre-to-centre distance on the grid at 4.4 m or more — a car and a half —
   *     against the 3 m the critic asked for and the ~2 m at which the collision capsules of two
   *     cars overlap at all. `telemetry().gridMinSep` reports the measured worst pair.
   */
  grid(spawnU) {
    this.startU = wrap01(spawnU);
    const L = this.track.length;
    const n = this.drivers.length + 1;
    const rows = [];
    // …in metres of road, then converted, so the layout is the same shape on a 22 m boulevard and
    // an 11 m alley instead of scaling with the width until it is in the oncoming lane.
    const hw = Math.max(4, this.track.halfWidth || 9);
    const fit = clamp((hw - 1.6) / (GRID_INNER + GRID_COLUMN + 1.4), 0.55, 1);
    const inner = (GRID_INNER * fit) / hw;
    const outer = ((GRID_INNER + GRID_COLUMN) * fit) / hw;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 2), odd = i % 2 === 1;
      const back = row * GRID_ROW + GRID_FRONT + (odd ? GRID_STAGGER : 0);
      rows.push({ u: wrap01(spawnU - back / L), lateral: odd ? outer : inner, back });
    }
    // The grid is ordered on the same skill×top-speed ranking that decides the natural race order,
    // so pole is a car that deserves it, and the player starting last has a field in front of them
    // that thins out as it strings — not a shuffle that reverses itself in one corner.
    const order = this.drivers.slice().sort((a, bb) =>
      (bb.spec.physics.topSpeed * bb.skill) - (a.spec.physics.topSpeed * a.skill));
    const lastBack = rows[rows.length - 1].back;
    order.forEach((d, i) => {
      d.spawn(rows[i].u, rows[i].lateral, 0, -1);
      d.launchT = d.reaction;
      d.launchSpin = 0;
      d.station = lastBack - rows[i].back;       // the gap they start with, so the band idles at zero
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
    this._paceI = START_PACE; this._slideRate = 0;
    // the re-station audit is per RACE, or the worst case it reports is somebody else's
    this.restations = 0; this.slideM = 0; this.slideSeenMax = 0; this.slideNearest = Infinity;
    this.slideFwd = 0; this.slideBack = 0;
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
      this._jetWarm = 3;              // …compiled on the grid, not on lap one — see updateVisuals
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
    // WARM THE OPPONENTS' PLUME SHADERS ON THE GRID.
    //
    // Every material in a NitrousJet compiles the first time it is RENDERED, and until round 6 no
    // opponent was allowed near its tank for the first 7–16 s of a race, so that compile happened
    // somewhere out on lap one — measured on the real GPU in Miami, a single 795 ms frame, which is
    // a visible three-quarter-second freeze the first time anybody in the field lights a bottle.
    // (The round-5 lockout did not fix it, it just moved it past the end of `tools/perf.mjs`'s
    // measuring window, which is why the number looked clean.)
    //
    // So the director lights every opponent's jet for a few frames while the field is stationary on
    // the grid, at a scale of 1/1000 — nothing is on screen, the programs are compiled, and the
    // first real boost of the race costs what every later one costs. The one place a hitch is free
    // is behind a countdown.
    const warm = this._jetWarm > 0 ? this._jetWarm-- : 0;
    for (const d of this.drivers) {
      const b = d.body;
      if (d.jet) {
        if (warm) {
          d.jet.group.scale.setScalar(1e-3);
          if (warm > 2) d.jet.ignite();
          d.jet.update(dt, 0.5, { speed: 40, camera, surge: 0.5, ramp: 0.5 });
        } else {
          if (d.jet.group.scale.x !== 1) { d.jet.group.scale.setScalar(1); d.jet.update(dt, 0, {}); }
          // …AND A PLUME NOBODY CAN SEE IS NOT DRAWN. Every part of a NitrousJet sets
          // `frustumCulled = false` (it has to — the geometry is rebuilt in local space every
          // frame and its bounds lie), so an opponent boosting 200 m up the road, or one boosting
          // BEHIND a chase rig that has no mirror, still pays full additive fill. Round 6 roughly
          // doubled how often the field reaches for the bottle, so this went from a rounding error
          // to real money on the fill-bound cities. `onScreen` is the driver's own answer to "can
          // the player see me", already computed this frame; the 35 m term is the belt to its
          // braces, because a plume just off the edge of frame can still throw light on the road.
          const show = d.onScreen > 0.01
            || !camPos || b.pos.distanceToSquared(camPos) < 35 * 35;
          if (d.jet.group.visible !== show) d.jet.group.visible = show;
          if (show) {
            if (d.nitro.justFired) d.jet.ignite();
            d.jet.update(dt, d.nitro.flame, {
              speed: Math.abs(b.speed), camera, surge: d.nitro.surge, ramp: d.nitro.ramp,
            });
          }
        }
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
      c.userData.jet.group.visible = true;     // …and any off-camera plume cull
      c.userData.jet.group.scale.setScalar(1);
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
          // THE RUN TO TURN ONE IS A NITROUS ZONE FOR EVERYBODY, INCLUDING THEM.
          //
          // Round 3 locked the field out of its tanks for 7–16 s off the green, because the boost
          // logic of the day had the whole field lit up on the line and 200 m clear of a player
          // still in third gear. That logic has two gates it did not have then — a boost needs
          // `speed > 0.42 × topSpeed` (so nobody fires from a standing start) and it needs road in
          // front of it — and the lockout had become the largest reason the START HAD NO
          // CONSEQUENCE: measured from the grid in LA and NYC, a full-throttle player went from
          // P8 to P1 inside 15 s while seven cars sat on tanks they were not allowed to use.
          // A short, staggered lockout is a field getting off the line, not a field standing aside.
          d.boostCool = d.rng.range(1.2, 4.2);
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
    this._wrongWay(dt, playerBody);

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
      // …and whether the RACE is over, which is not the same as whether THIS driver's race is
      // over — see the cool-down in AIDriver.step.
      flag: this.state !== 'racing' || this._classified,
    };
    for (const d of this.drivers) d.step(dt, ctx);
    // …and THEN the director's own two position powers, in that order: the re-station reads the
    // `hidden` and `onScreen` the drivers have just computed, and `_recover` is the harder case of
    // the same idea (a car that is not moving at all).
    this._restation(dt, playerBody);
    this._recover(playerBody, dt);

    this._separate(playerBody, dt);
    this._deadline();
    // …and on the flag frame the order settles on raw progress before it freezes (see `_order`).
    this._order(this._finishPending);
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
   * FIELD PACE — the one piece of rubber banding that acts on everybody at once, and since round 8
   * a TRIM on a pace the field owns rather than the pace itself.
   *
   * A PI loop with anti-windup, bounded to ±6 % of PACE_NOM — the pace at which these seven cars,
   * on their own hands with the band and the re-station switched off, lap LA in 45.5–49.1 s. What
   * that buys is a pack that does not quietly drift apart over three laps. What it can no longer
   * buy is the result: measured over full races on one seed with only the player's pace changed,
   * the winner's race time now moves 150 s → 135 s across a player lapping 58.8 s and one lapping
   * 44.5 s, against 172.6 s → 133 s in round 4 and a field that produced 42-second laps for a fast
   * player and 55-second laps for a parked one.
   *
   * Two guards keep it honest: it is BOUNDED at both ends by numbers the field can genuinely drive
   * (so it cannot pass a good player by cheating — see the solo ablation in the round-6 ledger at
   * the top of this file), and it freezes entirely while the player is crashed or stationary
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
    // …PLUS THE EFFORT THE RE-STATION IS SPENDING, which is the half of the error the band cannot
    // see. Once `_restation` is holding the field on its ladder the mean band goes to zero BY
    // CONSTRUCTION — the positions are right — and a controller reading only the band would then
    // conclude that the field's pace is correct while the director drags seven cars along by the
    // scruff of the neck. The drag rate is the true error: a positive number means the field is
    // genuinely too slow for whoever is holding the controller. Scaled so 6 m/s of mean drag is
    // full deflection, and weighted above the band because it is the unambiguous signal.
    const drag = clamp((this._slideRate ?? 0) / 6, -1, 1);
    let want = clamp(sum / n + drag * 1.3, -1.6, 1.6);
    // THE OPENING IS NOT A STEADY STATE, AND THE LADDER MUST NOT BRAKE THE FIELD THROUGH IT.
    //
    // AHEAD_SLOTS is a mid-race shape — the whole field inside 122 m of the player. On the run to
    // turn one none of that is true yet: the grid is 25 m deep, the player starts on the back row,
    // and a field getting off the line properly is legitimately 100–200 m up the road by the first
    // sequence of corners. The band reads that as "everybody is past their slot" and the loop
    // obediently slows the field down — measured on LA against a flat-out player, `fieldPace` ran
    // 0.95 → 0.98 → 0.93 → 0.86 → 0.849 over the first thirty seconds, i.e. the director took five
    // per cent off the field's pace during exactly the phase in which the player was driving past
    // all seven of them, and then spent the next fifteen seconds putting it back. That is the
    // "start with no consequence" the round-2 critic measured from the other end.
    //
    // So for the opening the loop may only ask for MORE. A player who starts last and is quicker
    // than the field still gets through — they just have to do it against a field that is racing
    // rather than one the director has just throttled.
    if (this.time < PACE_GRACE) want = Math.max(0, want);
    const err = lerp(this._paceErr ?? 0, want, 1 - Math.exp(-dt / 4));
    this._paceErr = err;
    if (Math.abs(playerBody.groundSpeed) < 8 && this.time > 4) return;   // crashed: hold, do not sag
    // WHAT THE BOUNDS MEAN NOW (round 8). They used to be the two lap times the field could be
    // dragged between — 0.60 was a 59-second LA lap and 1.26 a 43-second one, and which of them
    // you got was decided by how fast the player drove. They are ±6 % of the field's own pace
    // (PACE_NOM / PACE_BAND): the gearing between pace and lap time is about 0.43, so the whole
    // range the director now owns is ±1.2 s a lap on LA, against a 3.6 s spread between the best
    // and the worst driver in the field. Saturating it is no longer the end of anything, because
    // there is almost nothing on the other side of it: `_restation` can only hold the field BACK
    // (its forward half is deleted, see SLIDE_BUDGET_FRAC) and it has a race budget of 370 m.
    //
    // A PURE INTEGRATOR IS A BANG-BANG CONTROLLER, and that is what round 4 shipped: measured on
    // LA at a moderate player pace, `fieldPace` ran 0.95 → 0.62 (its floor, where it sat for a
    // THIRD of the race) → 0.98 → 0.62 again, a ~100-second limit cycle with the field 255 m up
    // the road at one end of it and 246 m down the road at the other. The AI's own lap times swung
    // 52.7 s → 64.1 s inside one race, which is the field visibly waiting.
    //
    // So: a real PI, with anti-windup — the integrator refuses to accumulate further into a bound
    // it is already sitting on, so a race the director cannot win leaves it ready to respond the
    // instant the player slows down rather than parked past the stop for half a lap.
    //
    // …AND THE GAINS ARE SIZED ON THE RANGE, not carried over from one six times wider. Round 6
    // doubled them to kP 0.105 because round 5's loop took forty seconds to cross a range 0.66
    // wide; against round 8's range of 0.12 that same gain is a switch — an error of 1 throws the
    // output from one stop to the other and the loop stops regulating and starts reporting. They
    // are written as fractions of PACE_BAND so they cannot be left behind again if the range moves.
    const kP = PACE_BAND * 0.75;          // full proportional deflection at a mean error of ~1.3
    const kI = PACE_BAND * 0.20;          // …and the rest walked on over a couple of seconds
    const iPrev = this._paceI ?? this.fieldPace;
    const outPrev = clamp(iPrev + err * kP, PACE_LO, PACE_HI);
    const saturated = (outPrev >= PACE_HI - 1e-6 && err > 0) || (outPrev <= PACE_LO + 1e-6 && err < 0);
    this._paceI = saturated ? iPrev : clamp(iPrev + err * kI * dt, PACE_LO, PACE_HI);
    this.fieldPace = clamp(this._paceI + err * kP, PACE_LO, PACE_HI);
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
   * RE-STATION — the one mechanism in this file with the authority to fix a gap the band cannot.
   *
   * THE PROBLEM IT SOLVES. Every knob the director had before this acted on PACE, and pace has a
   * hard ceiling: a car cannot exceed its own top speed however badly the director wants it back.
   * Measured on LA with `tools/_r2race_diag.mjs` against a strong autopilot (44 s laps): the field
   * pace sat welded to its 1.13 stop for 73 % of the race, every driver's trim sat on its bound,
   * and the field still went from 20 m at the first corner to 446–864 m adrift at the flag, with
   * NO opponent ahead of the player in 96 % of samples. Three laps of empty road. The same probe
   * at a slower player pace showed the mirror image and a 100-second limit cycle: the field ran
   * 255 m clear, the pace integrator hit its 0.62 floor and sat there for a third of the race, the
   * player drove past all seven, and the whole thing swung back the other way. In both cases the
   * pace loop is not regulating — it is saturated, and the race is decided by which side of the
   * saturation the player is on.
   *
   * WHAT IT DOES. A car that is genuinely not in the picture — behind the chase rig, which has no
   * mirror, or far enough up the road to be a few pixels — has the road slid under it toward the
   * station the ladder already wants it on. It is not a teleport and not a respawn: at most half a
   * car length per frame, capped at `RESTATION_MAX` m/s, tapering to nothing as the car nears its
   * station, with its speed, its lateral, its height and its heading relative to the road all
   * preserved (`AIDriver.slide`). And it stops `RESTATION_HOLD` metres short of the player's own
   * track position in both directions, so the last 60 m — the part that becomes the shot — is
   * always driven.
   *
   * WHY IT IS NOT A CHEAT YOU CAN CATCH. It is gated on `hidden`, which is zero for anything in
   * frame and for anything within 46 m in any direction, so it never acts on a car you are looking
   * at or racing; it can only ever move a car TOWARD the ladder, so it cannot take a place off
   * anyone or hand one out; and the pace loop below integrates how much of it the director had to
   * spend (`_slideRate`), so the field's actual driving pace rises to meet a quick player rather
   * than the director dragging the same cars forward all race.
   *
   * …AND IT IS THE LAST RESORT, NOT THE FIRST — the round-6 gate. Round 5 let the slide act at full
   * rate whatever the pace loop was doing, so the director reached for POSITION while it still had
   * unspent PACE in hand: measured on LA against a flat-out player, 5,130 m of road went under the
   * field in one race — roughly 700 m a car, a tenth of the race distance granted rather than
   * driven — and a good part of it was spent while `fieldPace` was still climbing through the
   * middle of its range. The slide's rate is now scaled by how close the pace loop is to its own
   * ceiling (`_paceSat`), so the director exhausts the honest knob before it touches the dishonest
   * one, and the same audit numbers say what it cost.
   */
  _restation(dt, playerBody) {
    this._slideRate = 0;
    if (!AI_TUNE.restation || this.state !== 'racing' || this.time < RESTATION_DELAY) return;
    // A PLAYER WHO IS NOT DRIVING IS NOT A PACE THE FIELD SHOULD BE HELD TO — the same guard
    // `_pace` has, and it is not cosmetic. The ladder wants the field within 122 m of the player,
    // so with the car parked on the grid the director spent the whole race dragging seven cars
    // backwards at 30 m/s: measured on an idle-player NYC probe, the field was still on LAP 0 at
    // 356 s with no lap time recorded by anybody and the race had no winner to start the flag's
    // deadline from. Crashed or stationary, the race carries on around them.
    if (Math.abs(playerBody.groundSpeed) < 8 && this.time > 4) return;
    // PACE FIRST, POSITION SECOND. Full authority only once the honest knob is spent: at the top
    // of the pace loop's range the field is already driving as fast as the director can ask, and
    // the gap that is left is the one only position can close. Anywhere in the middle of the range
    // the answer is more pace, and the loop is already asking for it (`_pace` integrates
    // `_slideRate`, so what little slide is allowed here still tells it to).
    // (…and this is written as a FRACTION of the loop's own range, not as two literals a fifth of
    // a point either side of it. Round 7's version was `smoothstep(PACE_HI - 0.14, …)`, which is
    // a sensible reading of a range 0.66 wide and nonsense against round 8's, which is 0.12 wide:
    // the lower edge of that smoothstep sits below the loop's own floor, so the gate would have
    // read "fully saturated" from the first frame of every race.)
    const sat = smoothstep(0.72, 0.98,
      Math.abs(this.fieldPace - PACE_NOM) / Math.max(1e-6, PACE_NOM * PACE_BAND));
    const slideAuth = lerp(0.12, 1, sat);
    let holdLeft = Math.max(0, this.holdBudget - this.slideBack);
    const L = this.track.length;
    let sumV = 0, n = 0;
    const ctx = { time: this.raceTime, laps: this.laps };
    for (const d of this.drivers) {
      d.slideV = 0;
      if (d.finished) continue;
      n++;
      // A car ON a shortcut has its position on the lap defined by the branch's arc length, not by
      // the street's — sliding it would drop it onto the road it is not on. It comes back onto the
      // street in a second or two and can be re-stationed then.
      if (d.branch || d.wantBranch) continue;
      const gap = (d.progress - this.playerProgress) * L;
      const err = gap - d.station;
      if (Math.abs(err) < RESTATION_DEAD || d.onScreen > RESTATION_SEEN) continue;
      // out of shot AND a long way from being in it: `hidden` is the visibility test, the distance
      // term is the belt to its braces (a car can be behind the player and still six metres away)
      const seen = d.body.pos.distanceTo(playerBody.pos);
      const vis = d.hidden * smoothstep(45, 85, seen);
      if (vis < 0.02) continue;
      const rate = RESTATION_MAX * clamp((Math.abs(err) - RESTATION_DEAD) / 120, 0, 1) * vis * slideAuth;
      let ds = clamp(-Math.sign(err) * rate * dt, Math.min(0, -err), Math.max(0, -err));
      // …and never through the player. The corridor is the same either side, so a car being reeled
      // in from up the road stops at 60 m ahead and one being brought back stops 60 m behind.
      if (gap < 0 && ds > 0) ds = Math.min(ds, Math.max(0, -gap - RESTATION_HOLD));
      else if (gap > 0 && ds < 0) ds = Math.max(ds, Math.min(0, -gap + RESTATION_HOLD));
      // …AND NEVER MORE THAN THE CAR IS ITSELF DOING. A drag bigger than the car's own speed is a
      // tow rope, and a BACKWARD one that big stops the car making progress at all — which is a
      // race that cannot end. Capped at 45 % of ground speed, a re-stationed car is always still
      // driving forward down the road, whatever the director wants.
      const cap = Math.abs(d.body.groundSpeed || d.body.speed || 0) * 0.45 * dt;
      ds = clamp(ds, -cap, cap);
      // …AND NEVER FORWARD, EVER (round 8, see SLIDE_BUDGET_FRAC). This is the one line that used
      // to hand a car road it had not driven, metered out of a race budget; the budget is gone and
      // so is the grant. What is left is the half that can only make the player's race harder to
      // lose: a car that has got away up the road may be asked to wait, out of shot, and nothing
      // is ever given back to one that has fallen behind — it has to drive.
      if (ds > 0) continue;
      // …and the hold has a race budget of its own (SLIDE_HOLD_FRAC). Unbounded it was worth
      // 10.5 km a race against a slow player, which is a director driving the race backwards.
      if (-ds > holdLeft) ds = -holdLeft;
      if (Math.abs(ds) < 1e-4) continue;
      d.slide(ds, ctx);
      d.slideV = ds / dt;
      sumV += d.slideV;
      this.slideM += Math.abs(ds);
      // `slideFwd` is deliberately still here and still reported: it is the audit line for the
      // claim above, and it can only ever read 0 now (`ds > 0` is refused a dozen lines up).
      this.slideBack -= ds;
      holdLeft += ds;
      this.restations++;
      // THE AUDIT. The whole claim this mechanism rests on is "never on a car you can see", so the
      // director records the worst case against itself: the largest `onScreen` any car has had at
      // the instant it was moved, and the closest one has been to the player. A probe reads these
      // rather than taking the gating logic's word for it.
      if (d.onScreen > this.slideSeenMax) this.slideSeenMax = d.onScreen;
      if (seen < this.slideNearest) this.slideNearest = seen;
    }
    // The mean drag across the field, m/s — the anti-windup signal the pace loop integrates. A
    // positive number means the director is having to pull the field along, i.e. the field is
    // genuinely too slow for whoever is driving, and the answer to that is more pace and less
    // dragging.
    this._slideRate = n ? sumV / n : 0;
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
    bodies.push({ b: playerBody, d: null, r: 1.04, len: 1.35, px: 0, pz: 0, pen: 0 });
    for (const d of this.drivers) {
      // …and the capsule is the CAR, not the wheelbase. `wheelbase * 0.5` leaves a 5.5 m lifted
      // truck with a 4.8 m collision body, so the last 0.7 m of it is a ghost: measured over a
      // 120 s NYC race the worst centre-to-centre approach of any pair was 1.23 m — bodywork
      // inside bodywork — and 99 frames sat under 2.0 m. Two thirds of the overhang counts now.
      const L = (d.dims.length ?? 4.6), W = (d.dims.width ?? 1.95);
      bodies.push({ b: d.body, d, r: clamp(W * 0.5, 0.92, 1.16),
        len: Math.max((d.dims.wheelbase ?? 2.8) * 0.5, L * 0.5 - 1.05), px: 0, pz: 0, pen: 0 });
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
        A.pen = Math.max(A.pen, bestPen); B.pen = Math.max(B.pen, bestPen);
        // Rate-limited push. Resolving the whole overlap every frame is a 16 m/s teleport apart
        // while two cars are rubbing down a straight, and that walks the whole pack into the
        // barriers. Cap it at a separation speed you could believe from two touching cars —
        // …EXCEPT WHEN THEY ARE ALREADY INSIDE EACH OTHER. A 4.6 m/s cap is 0.077 m of a frame and
        // two cars closing at 20 m/s bury 0.33 m of bodywork in the same frame, so a deep overlap
        // took a third of a second to come apart and that is exactly the frame a screenshot
        // catches. The cap opens with DEPTH: a rub is still a rub, a car buried half a body width
        // into another comes out at up to 14 m/s, which is what a real impact looks like anyway.
        const depth = smoothstep(0.18, 0.62, bestPen / (A.r + B.r));
        const push = Math.min(bestPen * 0.5, lerp(A.d && B.d ? 4.6 : 3.0, 14, depth) * dt);
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
      const k = Math.min(1, (lerp(A.d ? 4.5 : 1.6, 14, smoothstep(0.18, 0.62, A.pen / (A.r * 2))) * dt) / m);
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

  /**
   * @param settle  true on the ONE frame the flag falls. The order hysteresis below exists so the
   *   on-screen deck does not strobe while two cars run wheel to wheel; it has no business
   *   deciding a RESULT. Measured with tools/_race_verify.mjs: in LA and again in Vegas the
   *   results table put a car 5.4 m and 9.1 m up the road BEHIND the one it had just passed,
   *   because the pass was inside ORDER_HYST when the chequer fell and the previous order was
   *   carried into the frozen classification. On the flag frame the not-yet-finished cars are
   *   therefore sorted on raw progress, once, and THAT is what freezes.
   */
  _order(settle = false) {
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
    if (this._orderNames && this._orderNames.length === all.length && !settle) {
      order = this._orderNames.map((n) => byName.get(n));
      if (order.some((x) => !x)) order = raw.slice();
    } else order = raw.slice();
    if (!this._classified && !settle) {
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
        // …plus the two numbers that say WHY: how many usable shortcuts this driver has been
        // offered (`cutSeen`) and how many of those it decided to take (`cutWant`). A cut count of
        // zero next to a `cutSeen` of six is a driver refusing them; next to a `cutWant` of four it
        // is a driver missing the entries, and those are different bugs.
        cuts: d.shortcuts, skipped: d.counter.cuts,
        // …and `cutStray` closes the books: `cuts` is every traversal driven end to end, of which
        // `cutStray` were ribbons the driver was never offered and never chose — it simply ran wide
        // onto one. Without it `cuts` could exceed `cutSeen`, which is what the round-2 critic
        // caught and rightly called one of the two counters being wrong.
        cutSeen: d.cutSeen || 0, cutWant: d.cutWant || 0, cutStray: d.cutStray || 0,
        fin: d.finishTime == null ? null : +d.finishTime.toFixed(2),
        best: d.counter.best == null ? null : +d.counter.best.toFixed(2),
        station: +d.station.toFixed(0), trim: +d.trim.toFixed(3), seen: +d.onScreen.toFixed(2),
        // the director's re-station (see _restation): metres of road moved under this car all
        // race, and the rate it is moving this frame. Both are zero for anything in shot.
        slideM: Math.round(d.slideM || 0), slideV: +(d.slideV || 0).toFixed(1),
        // what this class's car was race-prepped to (see racePrepped) and the cornering figure the
        // director actually asks it for — the two numbers that say whether the field is normalised
        prep: d.spec.physics.prep ?? null,
        askG: +Math.min(d.refG, d.realG * d.gripCeil).toFixed(3),
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
      restations: this.restations, slideM: Math.round(this.slideM || 0),
      slideFwd: Math.round(this.slideFwd || 0), slideBack: Math.round(this.slideBack || 0),
      slideBudget: Math.round(this.slideBudget || 0),
      holdBudget: Math.round(this.holdBudget || 0),
      slideRate: +(this._slideRate ?? 0).toFixed(2),
      slideSeenMax: +this.slideSeenMax.toFixed(3),
      slideNearest: Number.isFinite(this.slideNearest) ? Math.round(this.slideNearest) : null,
      // SHORTCUTS THE FIELD DROVE THIS RACE, summed over the seven drivers — the aggregate of the
      // per-driver `cuts` in `field` above. It used to be the PLAYER'S SKIPPED-SECTOR count, which
      // is zero in every honest race, and a probe printing `telemetry().cuts` therefore reported
      // "the opponents never use the shortcuts" while seven drivers were taking three to seven
      // each. That reading cost a round. The old number is still here under a name that says what
      // it is.
      cuts: this.drivers.reduce((a, d) => a + (d.shortcuts || 0), 0),
      playerSkipped: this._playerCounter.cuts,
      // the worst centre-to-centre distance between any two cars on the road right now, in metres.
      // On the grid it is the layout's own separation (see `Race.grid`); during a race it is how
      // close the pack is actually running, and anything under ~2 m is bodywork inside bodywork.
      minSep: +this._minSep().toFixed(2),
      wrongWay: !!this.wrongWay,
      field: rows,
    };
  }

  /**
   * How much road the director may GRANT the field in this race, in metres — see
   * SLIDE_BUDGET_FRAC. A getter rather than a field because `laps` is set by the city (and by the
   * capture harness) after the director is constructed.
   */
  get slideBudget() { return SLIDE_BUDGET_FRAC * (this.track?.length ?? 2500) * (this.laps || 3); }

  /** …and the same for the only half of it that survives — see SLIDE_HOLD_FRAC. */
  get holdBudget() { return SLIDE_HOLD_FRAC * (this.track?.length ?? 2500) * (this.laps || 3); }

  /**
   * WRONG WAY. The lap logic has always refused to credit a lap driven backwards — round 2's
   * critic drove the course in reverse at 164 mph for twelve seconds and gained nothing, which is
   * correct — but NOTHING TOLD THE PLAYER. A checkpoint system that silently withholds credit is
   * indistinguishable from a broken one; the player has to be told, in the same second, that the
   * road they are on is not the road they are racing on.
   *
   * The test is the car's heading against the road's, not its progress: progress is noisy at a
   * standstill and in a spin, and a car sitting still facing backwards is already wrong. Half a
   * second of hysteresis in and a second out, so a slide through a hairpin or a spin-and-recover
   * never trips it, and the banner repeats every 1.4 s while it lasts (main.js already drains
   * `takeEvents()` into the HUD banner, so this needs no wiring anywhere else).
   * `telemetry().wrongWay` carries the same state for a HUD that wants to draw it properly.
   */
  _wrongWay(dt, playerBody) {
    if (this.state !== 'racing' || this.phase === 'flag' || this.playerFinished) {
      this.wrongWay = false; this._wrongT = 0; return;
    }
    const s = this.track.at(this.playerU);
    const f = playerBody.forward;
    const dot = f.x * s.tan.x + f.z * s.tan.z;
    const moving = Math.abs(playerBody.speed) > 4;
    // reversing down the road counts as facing the right way: the car is going backwards, but the
    // driver is not lost, and a reverse out of a barrier must not shout at them.
    const backwards = dot < -0.30 && (playerBody.speed > 2 || !moving);
    this._wrongT = clamp((this._wrongT || 0) + (backwards ? dt : -dt * 0.8), 0, 2);
    const on = this._wrongT > 0.5;
    if (on && !this.wrongWay) this._wrongShout = -9;
    this.wrongWay = on;
    if (on && this.wall - (this._wrongShout ?? -9) > 1.4) {
      this._wrongShout = this.wall;
      this._event('WRONG WAY', 1.3, '#ff3b30');
    }
  }

  /** Closest centre-to-centre approach between any two cars on the road, metres. */
  _minSep() {
    const pts = this.drivers.map((d) => d.body.pos);
    if (this._lastPlayerPos) pts.push(this._lastPlayerPos);
    let m = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) m = Math.min(m, pts[i].distanceTo(pts[j]));
    }
    return Number.isFinite(m) ? m : 0;
  }

  get lateralOffTrack() { return Math.abs(this.playerLateral) > 1; }
}

export { NAMES, Progress };
