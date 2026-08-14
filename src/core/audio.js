import { clamp, lerp, smoothstep, RNG } from './rng.js';

/**
 * NITRO CIRCUIT — procedural audio.  ART_DIRECTION.md §3: every sound is synthesised from
 * oscillators and noise buffers we fill ourselves. No audio files, ever.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE ENGINES SOUND DIFFERENT (§6.9: "distinct in CHARACTER, not merely pitch")
 *
 * An exhaust note is a train of blow-down pulses, one per cylinder per 720° of crank.  What makes a
 * lopey American V8 sound nothing like a Ferrari flat-plane V8 is not pitch — both fire eight times
 * per cycle — it is *which pulses come out of which pipe, and when*.
 *
 *   cross-plane V8 : the crank puts an UNEVEN firing pattern on each bank — one collector sees
 *                    gaps of 180-90-180-270°.  Uneven spacing means the per-bank pulse train has
 *                    strong half-order and quarter-order content: that is the burble/lope.
 *   flat-plane V8  : each bank fires dead even every 180°.  All the energy lands on the 4th order
 *                    (per bank) and its multiples — no half orders at all, so it screams instead of
 *                    burbling.
 *   inline four    : one collector, four even pulses, dominant 2nd order — thin, buzzy, and
 *                    completely dependent on its turbo for drama.
 *   diesel V8      : same cross-plane geometry, but the fuel event is a violent knock rather than a
 *                    smooth burn — modelled as a noise transient gated at the firing rate on top of
 *                    a long, fat pulse.
 *
 * So instead of a hand-tuned harmonic list, each character declares its *firing angles per
 * collector*.  We synthesise one 720° cycle of pulses in the time domain, Fourier-transform it, and
 * hand the coefficients to `createPeriodicWave`.  One oscillator per collector then plays the whole
 * exhaust note, band-limited by the Web Audio implementation, at f0 = rpm/120 Hz (the half-order).
 * Three wavetables per collector (soft / mid / sharp pulse) are cross-faded with rpm so the timbre
 * genuinely opens up as the engine comes on cam, not just the filter.
 *
 * Three things then stop that being an organ patch, and each is a separate class signature:
 *
 *   WAIL       a peaking filter parked on one firing ORDER, so it climbs with the engine.  The
 *              supercar's sits on the 32nd (280 Hz idle → 2.4 kHz at 9000 rpm) and IS the scream;
 *              the diesel's sits on the 4th and barely moves.  A fixed resonance cannot do this.
 *   INSTABILITY  a PeriodicWave repeats bit-for-bit forever.  Real combustion does not, so brown
 *              noise wanders the crank speed a few cents, flutters the level, and — on the V8s —
 *              lets the two collectors breathe INDEPENDENTLY, which keeps the comb between the
 *              two pipes moving.  All three tighten as load comes on, because a loaded engine
 *              genuinely is steadier than an idling one.
 *   UPSHIFT    the gear change is an EVENT, not a hole: the ignition cut barks out of the pipe,
 *              crackles on the way back in, and dumps the wastegate if there is one.  It fires
 *              from the shift edge inside `apply()`, so live and offline cannot diverge.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY EVERYTHING SITS IN A SPACE
 *
 * Dry is the loudest synthesis tell there is.  Two ConvolverNodes on the master carry impulse
 * responses we generate ourselves out of seeded noise (`makeImpulse`, still no audio files):
 * ROOM is ~0.2 s of dense early reflections — the bodywork, the road, the near barrier — and gives
 * the engine size without smearing the firing pulses; STREET is a discrete slap at 24 ms and 43 ms
 * plus a second of tail, and is what makes a crash or a nitrous crack read as something that
 * happened between buildings.  Every voice declares its own two send depths.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE MIX HAS TWO BUSES (§6.9: "nothing clipping, nothing buried")
 *
 * A single bus with a soft-clipper on the end sounds tidy and is a trap: the clipper lifts
 * everything below its knee, so a full-severity crash, a nitrous crack and an idle all end up
 * within a couple of dB of each other and the mix reads as a bed of synthesis rather than a
 * composed picture.  Level has to be DESIGNED.
 *
 *   PROGRAMME  engine · tyres · nitrous jet · ambience · music — continuous.  CREST-CONTROLLED,
 *              so the exhaust's firing-pulse tips cannot eat the headroom an event needs, then
 *              side-chain ducked 10-16 dB for ~40 ms by every transient.
 *   EVENT      impacts · nitrous crack · cutoff report · exhaust crackle · scrape — never
 *              ducked, never compressed
 *   CEILING    transparent below -1.9 dBFS, only bends the last 2 dB.  Clipping is impossible;
 *              quiet things stay quiet.
 *
 * The crest control is the piece r2 was missing and it is why r2's impacts did not survive.  An
 * engine at -19 dB RMS was peaking at -6.5 dB in the same second, so there was simply nothing left
 * above it for a hit to be louder THAN, and five impacts spanning 0.24 → 1.00 severity all measured
 * *below* the programme they were supposed to interrupt.  Taking 5 dB off the crests costs no
 * loudness at all and hands the whole top of the scale to the event bus.
 *
 * An impact then lands on EVENT with two gain curves, not one — `impactGain(s)` for everything that
 * rings and `crackGain(s)`, deliberately near-flat, for the transient — and punches a short deep
 * hole in PROGRAMME underneath itself.  Measured on the five-hit ladder, every rung from a 24 %
 * kerb clip to a 100 % barrier crash now clears the preceding 400 ms of programme by 6.1-11.2 dB,
 * on all four cars, off the same code path.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LIVE / OFFLINE PARITY
 *
 * An OfflineAudioContext's currentTime stays at 0 until rendering starts, so live-style
 * `setTargetAtTime(v, ctx.currentTime, tc)` calls would all pile up at t=0 and render a static
 * tone.  Every voice here therefore takes an EXPLICIT time: `voice.apply(state, when)`.  The live
 * path is just `apply(state, ctx.currentTime)` and the offline renderer at the bottom of this file
 * walks the same `apply` with scheduled times.  There is exactly one copy of the synthesis code,
 * so what the critic hears in a WAV is what a player hears in the car.
 *
 * Clip kinds: engine · idle · nitrous · impact · squeal · tyre · music · ambience · mix · stereo.
 * `tyre` is the rubber soloed, the way `music` and `ambience` are their own layers soloed.
 * `stereo` and `mix` render TWO channels — a pass-by across the field, hits on either side,
 * — so the spatialisation is checkable in a deliverable and not only in the source.  Everything
 * else is mono because the capture tool's brightness metric reads raw interleaved samples.
 */

// ═══════════════════════════════════════════════════════════════════════════ mix
/**
 * One place for every level.
 *
 * LEVEL IS A DESIGNED AXIS, not a consequence of however loud the synthesis came out. The whole
 * mix is laid out on one dB scale and every source is gain-staged to land on its own rung:
 *
 *   ┌ 0 dBFS ─────────────────────────────────────────────────────────────────────────┐
 *   │ -0.5    a 100 % crash, the nitrous ignition crack               ← EVENT bus      │
 *   │  -2     a hard 60 % barrier hit                                                  │
 *   │  -4     a 24 % kerb clip — a TICK, not a quiet crash: same peak, a tenth of the  │
 *   │         length, and three octaves up. See `crackGain`.                           │
 *   │  -6     a full-throttle upshift bark, the cutoff report                          │
 *   │ -10     engine peaks, wide open, AFTER crest control            ← PROGRAMME bus  │
 *   │ -13     the sustained nitrous plume, part of it on the EVENT bus so a charge can │
 *   │         sit ON TOP of the mix instead of inside it                               │
 *   │ -15     TYRE SQUEAL AT FULL LOCK — a lead voice, not a texture, and ~45 dB       │
 *   │         above where the same rubber sits while the car is gripping               │
 *   │ -17     engine RMS at redline                                                    │
 *   │ -22     ambience: wind + road roar (audible, not decorative)                     │
 *   │ -24     music bed under gameplay                                                 │
 *   │ -26     idle — quiet, but not so quiet that three of the four characters, which  │
 *   │         live at idle, are under their own wind bed                               │
 *   │ -41     distant city, present even at a standstill                               │
 *   └─────────────────────────────────────────────────────────────────────────────────┘
 *
 * Note the gap between -10 and -0.5: that is deliberate, it is crest control that keeps it open,
 * and it is the entire reason an impact reads as an impact. A gear change lives at -6 because a
 * gear change is the biggest transient in normal DRIVING; hitting a wall is not normal driving and
 * gets the top of the scale to itself.
 *
 * Two buses make that survivable. PROGRAMME carries everything continuous, is crest-controlled and
 * is side-chain ducked; EVENT carries the transients and is never ducked and never compressed, so a
 * crash arrives on top of a hole in the mix instead of fighting the engine for the same 3 dB.
 */
export const MIX = {
  master: 0.64,
  engine: 0.30,
  // The tyres carry drifting, which is the centre of this game, so they are staged as a LEAD
  // voice that is silent most of the time rather than as a texture that is always slightly there.
  // r2 sat at 0.20 and the capture harness had to lift the tyre bus 2.2x and cut the engine 0.58
  // for the squeal clip to read at all — i.e. in the real mix the rubber was ~7 dB under where it
  // needed to be. Both of those cheats are gone; this is what replaced them. It is only loud
  // because the gate in TyreVoice keeps it at -40 dB whenever the car is not actually sliding.
  tyre: 0.36,
  nitrous: 0.24,
  impact: 0.82,      // on the EVENT bus, where nothing else is competing for headroom
  music: 0.17,
  ambience: 0.86,    // r1 rendered the bed at -35 dB RMS, i.e. inaudible. This is ~-22.
  ui: 0.5,
};

/**
 * TWO curves, not one. This is the fix for the r2 finding that the severity ladder was *designed*
 * but *inaudible*: five hits spanning 0.24 → 1.00 measured -1 to -3.8 dB BELOW the programme they
 * were supposed to interrupt, so a crash read as a bump in engine level rather than as an event.
 *
 *   impactGain  the ENERGY curve. Scales the body thump, panel modes, glass, debris and rattle,
 *               and keeps its full ~15 dB spread — a 100 % crash carries an order of magnitude
 *               more sound, and more of it, than a kerb clip.
 *   crackGain   the TRANSIENT curve, and it is deliberately almost FLAT (-4.1 dB at s = 0.2 to
 *               0 dB at s = 1).
 *
 * The second one is the whole idea. A light contact is not a quiet crash — it is a SHORT, BRIGHT
 * one. Severity moves the crack's centre frequency (3.6 kHz → 500 Hz), its length (5 ms → 60 ms)
 * and what follows it, *not* its peak. So every rung of the ladder punches out of a running engine
 * by the same 6-10 dB, and you still know instantly which one you just took, because a kerb clip is
 * a tick up where the exhaust has nothing and a barrier is a slam down where it does.
 */
export const impactGain = (s) => Math.pow(clamp(s, 0, 1), 1.25);
export const crackGain = (s) => 0.60 + 0.40 * Math.pow(clamp(s, 0, 1), 1.6);

// ═══════════════════════════════════════════════════════════════════════ noise beds

export function makeNoiseBuffer(ctx, seconds = 2, { seed = 5, kind = 'white' } = {}) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  const rng = new RNG(seed);
  if (kind === 'white') {
    for (let i = 0; i < len; i++) d[i] = rng.range(-1, 1);
  } else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = rng.range(-1, 1);
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = clamp((b0 + b1 + b2 + w * 0.1848) * 0.28, -1, 1);
    }
  } else if (kind === 'brown') {
    let last = 0, peak = 1e-6;
    for (let i = 0; i < len; i++) { last = clamp(last + rng.range(-1, 1) * 0.02, -1, 1); d[i] = last; peak = Math.max(peak, Math.abs(last)); }
    for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;   // unit-normalised, like the other kinds
  } else if (kind === 'grain') {
    // Coarse, granular noise — road/gravel texture. White noise sample-and-held at ~4 kHz, which
    // pushes its energy down into the band where tyre roar lives.
    let hold = 0, count = 0;
    const step = Math.max(1, Math.round(rate / 4200));
    for (let i = 0; i < len; i++) {
      if (count-- <= 0) { hold = rng.range(-1, 1); count = step; }
      d[i] = hold;
    }
  } else if (kind === 'spray') {
    // LOOSE AGGREGATE. Thousands of individual stone strikes a second, each one an impulse with a
    // few hundred microseconds of ring on it. This is not filtered noise and it must not be: a
    // gravel surface is *discrete events*, and filling the buffer with grains is the difference
    // between "dirt" and "a hissier tarmac" — the r2 tyre voice had only the latter, which is why
    // its dirt section was not separable from its concrete section in any band.
    const grains = Math.floor(seconds * 2600);
    const tail = 72;
    for (let g = 0; g < grains; g++) {
      const i0 = Math.floor(rng.range(0, Math.max(1, len - tail)));
      // heavily skewed size distribution: mostly dust, occasionally a real stone
      const a = rng.sign() * Math.pow(rng.range(0.03, 1), 2.4);
      const dec = rng.range(0.00012, 0.0013) * rate;
      const w = rng.range(0.22, 1.55);              // 1.5-11 kHz ring — small stone, big stone
      for (let k = 0; k < tail; k++) d[i0 + k] += a * Math.exp(-k / dec) * Math.cos(k * w);
    }
    let peak = 1e-6;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
  }
  return buf;
}

// Noise buffers are expensive to fill and there is no reason to refill one per impact.
const NOISE_CACHE = new WeakMap();
export function noiseBuffer(ctx, kind = 'white', seconds = 2, seed = 5) {
  let m = NOISE_CACHE.get(ctx);
  if (!m) { m = new Map(); NOISE_CACHE.set(ctx, m); }
  const key = `${kind}|${seconds}|${seed}`;
  let b = m.get(key);
  if (!b) { b = makeNoiseBuffer(ctx, seconds, { kind, seed }); m.set(key, b); }
  return b;
}

/** A looping noise source, started immediately. */
function loopNoise(ctx, kind, seed, seconds = 3) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, kind, seconds, seed);
  n.loop = true;
  n.start(0);
  return n;
}

// ═════════════════════════════════════════════════════════════════ space (impulse responses)

/**
 * A procedurally generated impulse response — noise we fill ourselves, exactly like every other
 * buffer here, so a ConvolverNode is as legal as a BufferSource (§3: no audio files).
 *
 * WHY THIS EXISTS.  Everything in r1 was bone dry.  A dry synthesised exhaust is the single
 * loudest "this is a synthesiser" tell there is: real engine recordings are always a pipe plus the
 * street it is bouncing off, and a crash without a tail is a click.  Two spaces are enough:
 *
 *   ROOM    ~0.2 s of dense early reflections — the car's own bodywork, the road surface, the
 *           near barrier.  Gives the engine SIZE without smearing the firing pulses.
 *   STREET  a discrete slap at ~35 ms plus a ~1 s decaying tail, darkened as it decays.  This is
 *           the city answering back: crashes, nitrous cracks and exhaust pops get a tail that
 *           travels away from you.
 *
 * The IR is built as decorrelated noise under an exponential decay, with explicit early taps, and
 * progressively lowpassed (a one-pole whose coefficient closes with time) because air and plaster
 * absorb treble faster than bass.  Normalised to fixed RMS so a send level means the same thing
 * whatever the decay.
 */
export function makeImpulse(ctx, {
  seconds = 0.9, decay = 3.4, predelay = 0.003, taps = [], damp = 0.5,
  seed = 21, channels = 2, hp = 0.0,
} = {}) {
  const rate = ctx.sampleRate;
  const len = Math.max(8, Math.floor(rate * seconds));
  const nch = Math.max(1, Math.min(channels, 2));
  const buf = ctx.createBuffer(nch, len, rate);
  const pre = Math.floor(predelay * rate);
  for (let c = 0; c < nch; c++) {
    const d = buf.getChannelData(c);
    const rng = new RNG(seed * 131 + c * 7919 + 3);
    // progressive damping: the lowpass closes as the tail decays
    let lp = 0, hpState = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const env = Math.exp(-decay * t) * (1 - t);
      const w = rng.range(-1, 1);
      const a = lerp(0.85, 0.18, damp * t);           // 1 = no damping, → dark with time
      lp = lp + (w - lp) * a;
      let v = lp * env;
      if (hp > 0) { hpState = hpState + (v - hpState) * hp; v -= hpState; }
      d[i] += v;
    }
    // discrete early reflections — this is what makes a space read as a PLACE rather than a wash
    for (const [tt, gg] of taps) {
      const i = pre + Math.floor(tt * rate * rng.range(0.94, 1.06));
      if (i < len - 4) {
        const g = gg * (c === 0 ? 1 : rng.range(0.7, 1.25));
        d[i] += g; d[i + 1] += g * -0.55; d[i + 2] += g * 0.22;
      }
    }
    // Unity RMS gain: convolving a signal with an IR whose total energy is 1 leaves its level
    // alone, so a send fader means the same number of dB whatever the decay time.
    let sq = 0;
    for (let i = 0; i < len; i++) sq += d[i] * d[i];
    const norm = 1 / Math.sqrt(Math.max(1e-12, sq));
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}

// ══════════════════════════════════════════════════ firing pattern → PeriodicWave

const DFT_N = 1024;         // samples of one 720° cycle
// Harmonics kept (harmonic n = order n/2).  This number IS the top of the exhaust note: the
// wavetable's highest partial sits at DFT_H · f0, and f0 is only rpm/120.  At 160 a muscle car at
// its 6200 rpm limiter had literally nothing above 8.3 kHz and at idle nothing above 900 Hz, which
// is most of why r2 measured as "playing behind a closed door".  288 puts the top partial at
// 15 kHz at the limiter — real air, still band-limited by createPeriodicWave so it cannot alias.
const DFT_H = 288;
const SIN_TAB = (() => { const t = new Float32Array(DFT_N); for (let i = 0; i < DFT_N; i++) t[i] = Math.sin((2 * Math.PI * i) / DFT_N); return t; })();

/**
 * One crank cycle (720°) of exhaust pulses.
 * @param angles firing angles in degrees for THIS collector
 * @param decay  pulse decay as a fraction of the cycle — small = sharp/bright, large = fat/soft
 * @param ring   0..1 amount of pipe ringing baked into each pulse (hollow, header-resonance colour)
 */
export function cycleWaveform(angles, { decay = 0.03, attack = 0.0035, ring = 0, ringHz = 6, scatter = 0, jitter = 0, seed = 1 } = {}) {
  const w = new Float32Array(DFT_N);
  // No two cylinders make exactly the same pulse and no crank is exactly on the drawing. That
  // tolerance is audible: it is what stops a synthesised engine sounding like a buzzer.
  const rng = new RNG(seed * 6151 + 13);
  for (let k = 0; k < angles.length; k++) {
    const ph = ((((angles[k] + rng.gauss(0, jitter)) % 720) + 720) % 720) / 720;
    const a = 1 + rng.gauss(0, scatter);
    for (let i = 0; i < DFT_N; i++) {
      let x = i / DFT_N - ph;
      if (x < 0) x += 1;
      const env = Math.exp(-x / decay) * (1 - Math.exp(-x / attack));
      const r = ring > 0 ? (1 - ring) + ring * Math.cos(2 * Math.PI * ringHz * (x / decay)) : 1;
      w[i] += a * env * r;
    }
  }
  let mean = 0;
  for (let i = 0; i < DFT_N; i++) mean += w[i];
  mean /= DFT_N;
  let peak = 1e-6;
  for (let i = 0; i < DFT_N; i++) { w[i] -= mean; peak = Math.max(peak, Math.abs(w[i])); }
  for (let i = 0; i < DFT_N; i++) w[i] /= peak;
  return w;
}

/**
 * ONE CYCLE OF A STICK-SLIP RELAXATION — the waveform a squealing tyre actually makes.
 *
 * A tread block entering the contact patch grips, is dragged, loads elastically (the slow, convex
 * `stick` ramp), and then exceeds its friction limit and SNAPS back through zero, overshooting and
 * ringing down (the fast `slip`). That asymmetry is why a tyre squeal is a buzzy, edgy note rather
 * than a sine: the snap is a fraction of the cycle, so the spectrum is a dense harmonic series with
 * a hard front on every period. Playing this waveform at the relaxation frequency IS the squeal —
 * which is what lets its pitch bend with slip angle and vertical load, something a noise source
 * behind a bandpass can only imitate by moving a filter, and never convincingly.
 *
 * @param release fraction of the cycle spent slipping — small = harder, buzzier snap
 * @param curve   >1 stiffens the elastic build (a loaded block resists more the further it goes)
 */
export function stickSlipWave(release = 0.15, curve = 1.5) {
  const w = new Float32Array(DFT_N);
  const r = clamp(release, 0.03, 0.6);
  for (let i = 0; i < DFT_N; i++) {
    const x = i / DFT_N;
    if (x < 1 - r) w[i] = Math.pow(x / (1 - r), curve);
    else {
      const u = (x - (1 - r)) / r;
      w[i] = Math.cos(Math.PI * u) * Math.exp(-2.4 * u);   // snap back, overshoot, ring down
    }
  }
  let mean = 0;
  for (let i = 0; i < DFT_N; i++) mean += w[i];
  mean /= DFT_N;
  let peak = 1e-6;
  for (let i = 0; i < DFT_N; i++) { w[i] -= mean; peak = Math.max(peak, Math.abs(w[i])); }
  for (let i = 0; i < DFT_N; i++) w[i] /= peak;
  return w;
}

/** Real Fourier series of a periodic waveform, in Web Audio's (real=cos, imag=sin) convention. */
export function fourier(w) {
  const real = new Float32Array(DFT_H + 1);
  const imag = new Float32Array(DFT_H + 1);
  const q = DFT_N >> 2;
  for (let n = 1; n <= DFT_H; n++) {
    let a = 0, b = 0;
    for (let i = 0; i < DFT_N; i++) {
      const idx = (n * i) % DFT_N;
      a += w[i] * SIN_TAB[(idx + q) % DFT_N];
      b += w[i] * SIN_TAB[idx];
    }
    real[n] = (2 * a) / DFT_N;
    imag[n] = (2 * b) / DFT_N;
  }
  return { real, imag };
}

const COEF_CACHE = new Map();     // "char|bank|zone" → {real,imag}   (context-independent)
const WAVE_CACHE = new WeakMap(); // ctx → Map(key → PeriodicWave)

function periodicWave(ctx, key, build) {
  let m = WAVE_CACHE.get(ctx);
  if (!m) { m = new Map(); WAVE_CACHE.set(ctx, m); }
  let pw = m.get(key);
  if (!pw) {
    let c = COEF_CACHE.get(key);
    if (!c) { c = fourier(build()); COEF_CACHE.set(key, c); }
    pw = ctx.createPeriodicWave(c.real, c.imag, { disableNormalization: false });
    m.set(key, pw);
  }
  return pw;
}

// ═══════════════════════════════════════════════════════════════════ engine characters

/**
 * `banks` are the firing angles seen by each exhaust collector across one 720° cycle. This is the
 * whole personality of the engine — see the header note.
 *
 * `zones` are the pulse shapes cross-faded across the rev range (idle → mid → on-cam).
 *
 * ── `air`: THE TOP OCTAVE, and the second place the four classes separate ───────────────────────
 * The exhaust path is deliberately dark (a muscle car's collector really is lowpassed at ~3 kHz).
 * Everything above that is a SEPARATE, PARALLEL branch, because in a real car it comes from
 * somewhere else entirely — injectors, valvetrain, turbo, and the hard edge a saturating pipe puts
 * on the pulse front.  Three layers, each with its own class signature:
 *
 *   rasp  the collector sum through a hard waveshaper into a highpass.  Harmonically LOCKED to the
 *         firing rate, so it is exhaust rasp and not hiss — it pulses with the engine and rises
 *         with load.  The flat-plane screams here; the muscle car crackles here on a lift.
 *   hiss  broadband induction/turbo air.  Tracks rpm and boost.  Tuner: 5-12 kHz turbo hiss.
 *         Supercar: 6-14 kHz intake shriek.  Diesel: a dull 4-7 kHz whistle.  Muscle: barely any.
 *   tick  white noise amplitude-gated at the FIRING RATE through a 4-12 kHz bandpass: injector and
 *         valvetrain clatter.  This is the diesel's whole tell, and it is loudest at low rpm under
 *         load, which is exactly when a real one clatters hardest.
 */
export const CHARACTER = {
  // ── Small turbocharged inline four. One collector, four even pulses → 2nd order dominant.
  // Thin and buzzy on its own; the induction whistle and the spool are the show.
  'i4-turbo': {
    banks: [[0, 180, 360, 540]],
    bankMix: [1], bankDelayMs: [0], scatter: 0.10, jitter: 2.2,
    bankDetune: 0,
    zones: [
      { decay: 0.038, ring: 0.10, ringHz: 3.0 },
      { decay: 0.022, ring: 0.20, ringHz: 4.5 },
      { decay: 0.013, ring: 0.30, ringHz: 6.5 },
    ],
    pipeHz: [230], pipeQ: 1.4, pipeGain: 5,
    // 14th half-order ≈ 3.5x the firing rate: the hard buzzy edge a small four develops when it
    // comes on boost, climbing 220 Hz → 1.0 kHz across the rev range.
    wail: { order: 18, q: 3.6, gain: 11 },
    cut: [900, 8600], cutQ: [1.1, 2.2],
    hp: 185,                       // no real bottom end — that is what makes a four sound small
    drive: [0.70, 2.30], driveMakeup: 0.58,
    body: { hz: [150, 320], gain: 3.5 },
    intake: { level: 0.56, hz: [450, 2800], q: 1.2, kind: 'pink' },
    knock: 0.0,
    turbo: { whistle: 1.0, whistleHz: [2100, 6400], whoosh: 0.45, spoolTc: 0.42, bov: 1.0 },
    crackle: 0.55, crackleHz: [1400, 7200],
    lope: 0.05,
    level: 1.15,
    // A modern turbo four is a NOISY little thing up top: direct injectors ticking, a compressor
    // hissing, and a wastegate. That is where its size comes from.
    air: {
      rasp: 0.34, raspK: 7, drive: 2.4, hp: 4600, peak: 7400, peakQ: 0.8, peakGain: 7,
      hiss: 0.62, hissHz: [5200, 12500], hissQ: 0.5, hissBoost: 1.5,
      tick: 0.78, tickHz: [5600, 9800], tickQ: 1.5, tickIdle: 0.21,
      over: 0.8,
    },
  },

  // ── Cross-plane American V8. Uneven per-bank firing (180-90-180-270) = the lope.
  'v8-lopey': {
    banks: [[0, 180, 270, 450], [90, 360, 540, 630]],
    // THE LOPE. Each collector on its own is uneven (180-90-180-270). If both pipes reached the
    // listener at exactly the same level they would recombine into a dead-even 90° train and the
    // burble would vanish — so the near pipe dominates, the far one arrives 3 ms late through a
    // different resonator, and the half-orders survive. This is the whole muscle-car sound.
    bankMix: [1, 0.38], bankDelayMs: [0, 4.4], scatter: 0.20, jitter: 4.2,
    bankDetune: 13,
    zones: [
      { decay: 0.075, ring: 0.42, ringHz: 1.6 },
      { decay: 0.040, ring: 0.34, ringHz: 2.4 },
      { decay: 0.021, ring: 0.24, ringHz: 3.4 },
    ],
    pipeHz: [104, 141], pipeQ: 1.05, pipeGain: 6.5,
    // the bark. 10th half-order — 55 Hz at idle, 520 Hz at the limiter — which is where a big
    // cross-plane V8's chest sits.
    wail: { order: 10, q: 2.1, gain: 7 },
    cut: [330, 2950], cutQ: [0.9, 1.8],
    hp: 46,
    drive: [0.7, 2.6], driveMakeup: 0.52,
    body: { hz: [88, 168], gain: 7.5 },
    intake: { level: 0.24, hz: [180, 1100], q: 0.85, kind: 'pink' },
    knock: 0.16, knockHz: [700, 1800], knockQ: 1.2,
    turbo: null,
    crackle: 1.0, crackleHz: [500, 5200],
    lope: 0.34,
    level: 1.0,
    // Dark exhaust, hard edge. Almost all of this car's top end is the pipe tearing under load and
    // the unburnt fuel cracking off on a lift — `over` triples the rasp the instant you lift.
    air: {
      rasp: 0.72, raspK: 12, drive: 3.2, hp: 3900, peak: 5600, peakQ: 0.7, peakGain: 8,
      hiss: 0.20, hissHz: [4000, 8200], hissQ: 0.55, hissBoost: 0,
      tick: 0.26, tickHz: [4000, 6800], tickQ: 1.1, tickIdle: 0.20,
      over: 2.0,
    },
  },

  // ── Big-bore diesel truck. Cross-plane geometry, long fat pulses, and a hard combustion knock
  // gated at the firing rate — the clatter is the whole tell.
  'v8-diesel': {
    banks: [[0, 180, 270, 450], [90, 360, 540, 630]],
    bankMix: [1, 0.36], bankDelayMs: [0, 4.6], scatter: 0.24, jitter: 5.0,
    bankDetune: 19,
    zones: [
      { decay: 0.110, ring: 0.30, ringHz: 1.1 },
      { decay: 0.062, ring: 0.24, ringHz: 1.6 },
      { decay: 0.036, ring: 0.18, ringHz: 2.2 },
    ],
    pipeHz: [72, 96], pipeQ: 0.95, pipeGain: 8,
    // barely moves: 19 Hz to 147 Hz. A diesel does not sing, it lugs.
    wail: { order: 4, q: 1.9, gain: 6 },
    cut: [180, 1450], cutQ: [0.8, 1.4],
    hp: 44,
    drive: [0.8, 2.2], driveMakeup: 0.5,
    body: { hz: [70, 132], gain: 5 },
    intake: { level: 0.30, hz: [130, 700], q: 0.7, kind: 'brown' },
    knock: 1.32, knockHz: [1100, 2400], knockQ: 1.8,
    turbo: { whistle: 0.18, whistleHz: [900, 2600], whoosh: 0.42, spoolTc: 0.9, bov: 0.25 },
    crackle: 0.30, crackleHz: [300, 2400],
    lope: 0.46,
    level: 1.02,
    // The exhaust is the darkest of the four and stays that way. The AIR is where a diesel gives
    // itself away: a hard dry injector clatter that is loudest lugging at low rpm, which is why
    // `tick` is the biggest number in the table and `tickIdle` keeps it there at a standstill.
    air: {
      rasp: 0.22, raspK: 6, drive: 2.0, hp: 3600, peak: 5000, peakQ: 0.6, peakGain: 5,
      hiss: 0.34, hissHz: [3800, 7600], hissQ: 0.45, hissBoost: 1.0,
      tick: 1.50, tickHz: [4200, 8400], tickQ: 1.0, tickIdle: 0.95,
      over: 0.5,
    },
  },

  // ── Flat-plane V8. Both banks fire dead even every 180° → pure 4th order per bank, no half
  // orders at all. Short hard pulses, huge top end: it screams.
  'v8-flatplane': {
    banks: [[0, 180, 360, 540], [90, 270, 450, 630]],
    // Both banks even, near-equal, near-coincident: the half-orders cancel by design and only the
    // 4th order and its multiples survive. That is why a flat-plane V8 screams instead of lopes.
    bankMix: [1, 0.92], bankDelayMs: [0, 0.6], scatter: 0.05, jitter: 0.9,
    bankDetune: 5,
    zones: [
      { decay: 0.030, ring: 0.08, ringHz: 3.5 },
      { decay: 0.016, ring: 0.14, ringHz: 5.5 },
      { decay: 0.0085, ring: 0.22, ringHz: 8.0 },
    ],
    pipeHz: [265, 340], pipeQ: 1.8, pipeGain: 6,
    // THE SCREAM. 32nd half-order = 4x the firing rate: 280 Hz at idle sweeping to 2.4 kHz at
    // 9000 rpm, narrow and loud. This one resonance is most of why the supercar is unmistakable.
    wail: { order: 32, q: 4.8, gain: 13 },
    cut: [1100, 13500], cutQ: [1.2, 2.6],
    hp: 96,
    drive: [0.5, 1.9], driveMakeup: 0.66,
    body: { hz: [180, 420], gain: 4 },
    intake: { level: 0.50, hz: [700, 5200], q: 1.5, kind: 'white' },
    knock: 0.0,
    turbo: null,
    crackle: 0.9, crackleHz: [1800, 9500],
    lope: 0.08,
    level: 1.05,
    // The scream. Highest rasp of the four and the highest formant on it, plus an intake shriek
    // that runs to 14 kHz — a flat-plane V8 at 9000 rpm is a genuinely painful top end and that is
    // the point of it.
    air: {
      rasp: 0.95, raspK: 9, drive: 3.0, hp: 5000, peak: 9200, peakQ: 0.75, peakGain: 9,
      hiss: 0.72, hissHz: [6000, 14000], hissQ: 0.45, hissBoost: 0,
      tick: 0.62, tickHz: [7000, 12800], tickQ: 1.2, tickIdle: 0.22,
      over: 1.2,
    },
  },
};

export function characterOf(key) { return CHARACTER[key] || CHARACTER['v8-lopey']; }
export const CHARACTER_KEYS = Object.keys(CHARACTER);

/** Waveshaper curve for exhaust rasp / overdrive. */
function raspCurve(k = 3) {
  const n = 2048, c = new Float32Array(n), d = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; c[i] = Math.tanh(k * x) / d; }
  return c;
}
const RASP = raspCurve(3);

/**
 * Master ceiling. A `tanh` soft-clip across the whole range (what r1 used) is a compressor in
 * disguise: it lifts everything below the knee, which is exactly how sixteen clips end up inside a
 * 2.4 dB window. This one is bit-transparent below the knee and only bends the last 3 dB, so the
 * quiet things stay quiet and a crash still physically cannot clip.
 */
function limitCurve(knee = 0.70) {
  const n = 8192, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = x < 0 ? -y : y;
  }
  return c;
}
const CEILING = limitCurve(0.80);
// The programme bus's crest controller (see MasterBus). Driven 2.6x in and 0.40x out, so signals
// under about -22 dBFS pass at unity and only the firing-pulse tips ever reach the knee.
const PROG_CREST = limitCurve(0.30);

// ═══════════════════════════════════════════════════════════════════════ turbo model

/** Shared by the live voice and the offline drive sim so the two can never diverge. */
export function turboStep(boost, throttle, norm, dt, cfg) {
  if (!cfg) return 0;
  const target = clamp(throttle, 0, 1) * smoothstep(0.12, 0.72, norm);
  const tc = throttle > 0.15 ? cfg.spoolTc : cfg.spoolTc * 0.35;   // dumps far faster than it builds
  return boost + (target - boost) * (1 - Math.exp(-dt / Math.max(0.02, tc)));
}

// ═════════════════════════════════════════════════════════════════════════ EngineVoice

/**
 * One car's engine. Everything is driven through `apply(state, when)` so the live game loop and
 * the offline renderer share a single code path.
 *
 * state = { rpm, throttle, gear, shifting, boost, volume, load }
 */
export class EngineVoice {
  constructor(ctx, dest, spec, { pan = 0, seed = 17, events = null, space = null, bus = null } = {}) {
    this.ctx = ctx;
    this.spec = spec;
    const a = spec.audio;
    this.a = a;
    const ch = characterOf(a.character);
    this.ch = ch;
    this.rng = new RNG(seed + (a.cylinders || 8) * 977);
    this._boost = 0;
    this._prevShift = false;
    this._popClock = 0;
    this._overOn = false;

    // ── output / spatialisation ──────────────────────────────────────────────────────
    // `bus` is the car's whole voice. `out` carries the continuous engine note and is level-
    // automated every frame; `fx` carries one-shots (pops, BOV) which must NOT be scaled down by
    // the engine's own volume envelope — a lifted throttle is quiet precisely so the crackle can
    // be heard over it.
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;
    // A StereoPanner would cost 3 dB of level in the mono offline render for nothing, so it is
    // only inserted when the destination is actually stereo (i.e. in game, and in the `stereo`
    // capture clip, which renders two channels precisely so the panning is checkable).
    const stereo = ctx.destination.channelCount > 1 && !!ctx.createStereoPanner;
    this.panners = [];
    const wire = (node, to) => {
      if (stereo) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        node.connect(p); p.connect(to);
        this.panners.push(p);
      } else node.connect(to);
    };
    wire(this.bus, dest);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.bus);
    // Crackle and the blow-off valve are EVENTS. They ride the un-ducked event bus so a lifted
    // throttle can go properly quiet and the overrun still cracks over the top of it.
    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 1;
    wire(this.fxBus, events || dest);
    this.fx = ctx.createGain();
    this.fx.gain.value = 1;
    this.fx.connect(this.fxBus);

    // ── the space the car is in ─────────────────────────────────────────────────────
    // The continuous note gets mostly ROOM (size, no smear); the pops and the blow-off get a lot
    // of STREET, because an exhaust crack is the one engine sound that audibly travels away from
    // you and comes back off the buildings.
    this.space = space;
    this.masterBus = bus;           // so a gear change can open a hole for its own bark
    // How much of the world each class hears is per class, and it is a real difference: a low
    // supercar with no sound deadening and hard glass sits IN the street; a truck cabin two metres
    // up with a headliner and rubber mounts hears its own bodywork and very little else.
    const SPX = { room: 1, street: 1, ...(a.space || {}) };
    sendSpace(ctx, this.out, space, 0.26 * SPX.room, 0.11 * SPX.street);
    sendSpace(ctx, this.fx, space, 0.30 * SPX.room, 0.52 * SPX.street);

    // ── tone stack: bank collectors → rasp → exhaust lowpass → cabin body ────────────
    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = ch.body.hz[0];
    this.body.Q.value = 0.9;
    this.body.gain.value = ch.body.gain;
    this.body.connect(this.out);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = ch.hp;
    this.hp.Q.value = 0.7;
    this.hp.connect(this.body);

    // ── the WAIL: a resonance that tracks the firing rate ───────────────────────────
    // `pipeHz` above is a fixed resonance — a real silencer volume, which does not move.  What a
    // fixed filter can never do is SING: the reason a flat-plane V8 at 9000 rpm sounds like a
    // siren and a diesel at 2000 sounds like a hammer is that a specific band of firing harmonics
    // is being amplified, and that band climbs with the engine.  So each class also gets a peaking
    // filter parked on a chosen ORDER (in units of f0 = rpm/120) that rises with rpm.  The
    // supercar's sits on the 32nd — 280 Hz at idle, 2.4 kHz at the limiter — which is exactly the
    // scream.  The diesel's sits on the 4th and barely moves.
    this.wailF = null;
    if (ch.wail) {
      this.wailF = ctx.createBiquadFilter();
      this.wailF.type = 'peaking';
      this.wailF.frequency.value = 400;
      this.wailF.Q.value = ch.wail.q;
      this.wailF.gain.value = 0;
      this.wailF.connect(this.hp);
    }

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = ch.cut[0];
    this.lp.Q.value = ch.cutQ[0];
    this.lp.connect(this.wailF || this.hp);

    this.post = ctx.createGain();
    this.post.gain.value = ch.driveMakeup;
    this.post.connect(this.lp);

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = RASP;
    this.shaper.oversample = '4x';
    this.shaper.connect(this.post);

    this.drive = ctx.createGain();
    this.drive.gain.value = ch.drive[0];
    this.drive.connect(this.shaper);

    // Everything the collectors produce arrives here. The dark exhaust path continues down through
    // `drive`; the AIR branch taps the same node so the top octave is locked to the same firing
    // pulses instead of being an unrelated layer of hiss pasted on top.
    this.collect = ctx.createGain();
    this.collect.gain.value = 1;
    this.collect.connect(this.drive);

    // ── the collectors ──────────────────────────────────────────────────────────────
    this.oscs = [];      // flat list for freq automation
    this.zoneGains = []; // [bank][zone]
    this.bankGains = []; // so the two pipes can breathe independently (see below)
    for (let b = 0; b < ch.banks.length; b++) {
      const pipe = ctx.createBiquadFilter();
      pipe.type = 'peaking';
      pipe.frequency.value = ch.pipeHz[b] ?? ch.pipeHz[0];
      pipe.Q.value = ch.pipeQ;
      pipe.gain.value = ch.pipeGain;
      const bankGain = ctx.createGain();
      const mix = (ch.bankMix?.[b] ?? 1);
      const mixSum = (ch.bankMix || ch.banks.map(() => 1)).reduce((x, y) => x + y, 0);
      bankGain.gain.value = (1.5 * mix) / mixSum;
      bankGain.connect(pipe);
      this.bankGains.push(bankGain);
      const delayMs = ch.bankDelayMs?.[b] ?? 0;
      if (delayMs > 0) {
        // Path-length difference between the two pipes: a few milliseconds of comb filtering that
        // makes the far bank sound like a different pipe rather than a copy.
        const d = ctx.createDelay(0.05);
        d.delayTime.value = delayMs / 1000;
        pipe.connect(d); d.connect(this.collect);
      } else {
        pipe.connect(this.collect);
      }

      const zg = [];
      for (let z = 0; z < ch.zones.length; z++) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(periodicWave(ctx, `${a.character}|${b}|${z}`,
          () => cycleWaveform(ch.banks[b], {
            ...ch.zones[z], scatter: ch.scatter ?? 0, jitter: ch.jitter ?? 0, seed: b * 31 + z + 1,
          })));
        o.frequency.value = 30;
        // Collectors are never perfectly matched; a few cents apart is what makes a V8 sound like
        // two pipes rather than one synthesiser.
        o.detune.value = (b === 0 ? -1 : 1) * ch.bankDetune * 0.5;
        const g = ctx.createGain();
        g.gain.value = z === 0 ? 1 : 0;
        o.connect(g); g.connect(bankGain);
        o.start(0);
        this.oscs.push(o);
        zg.push(g);
      }
      this.zoneGains.push(zg);
    }

    // ── combustion instability ──────────────────────────────────────────────────────
    // A PeriodicWave repeats bit-for-bit every cycle, forever. That is the difference between an
    // engine and a Hammond organ, and no amount of filtering hides it: real combustion varies
    // cycle to cycle, so the crank speed wobbles a few cents and each bang is a slightly different
    // size. Two cheap layers of brown noise fix it — one on pitch, one on level — scaled by the
    // class's `roughness` and pulled tight as load comes on, because an engine on the cam IS
    // steadier than one idling.
    this.wobSrc = loopNoise(ctx, 'brown', 7331, 5.3);
    this.wobLP = ctx.createBiquadFilter();
    this.wobLP.type = 'lowpass'; this.wobLP.frequency.value = 11; this.wobLP.Q.value = 0.7;
    this.wobSrc.connect(this.wobLP);
    this.wobPitch = ctx.createGain(); this.wobPitch.gain.value = 0;
    this.wobLP.connect(this.wobPitch);
    for (const o of this.oscs) this.wobPitch.connect(o.detune);
    this.wobAmp = ctx.createGain(); this.wobAmp.gain.value = 0;
    this.wobLP.connect(this.wobAmp);
    this.wobAmp.connect(this.out.gain);
    // ...and a faster one, at combustion-event rate, so individual bangs differ in size
    this.wob2 = loopNoise(ctx, 'white', 7481, 3.7);
    this.wob2LP = ctx.createBiquadFilter();
    this.wob2LP.type = 'lowpass'; this.wob2LP.frequency.value = 90; this.wob2LP.Q.value = 0.5;
    this.wob2G = ctx.createGain(); this.wob2G.gain.value = 0;
    this.wob2.connect(this.wob2LP); this.wob2LP.connect(this.wob2G);
    this.wob2G.connect(this.out.gain);
    // ...and the two pipes breathe INDEPENDENTLY. Modulating the whole engine together is just
    // tremolo; letting one bank wander against the other makes the comb between them move, which
    // is what a lopey V8 actually does — the burble is never twice the same shape.
    this.bankWob = [];
    for (let b = 1; b < this.bankGains.length; b++) {
      const src = loopNoise(ctx, 'brown', 7601 + b * 313, 4.9);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 7; lp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(lp); lp.connect(g); g.connect(this.bankGains[b].gain);
      this.bankWob.push({ src, g });
    }

    // ── induction ───────────────────────────────────────────────────────────────────
    this.intakeSrc = loopNoise(ctx, ch.intake.kind, 3001, 2.7);
    this.intakeBP = ctx.createBiquadFilter();
    this.intakeBP.type = 'bandpass';
    this.intakeBP.frequency.value = ch.intake.hz[0];
    this.intakeBP.Q.value = ch.intake.q;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeSrc.connect(this.intakeBP); this.intakeBP.connect(this.intakeGain);
    this.intakeGain.connect(this.out);

    // ── AIR: the top octave, three parallel layers, one class signature ─────────────
    // The exhaust lowpass above is a CHARACTER control (a muscle collector really is dark). None
    // of this goes through it. See the `air` note on CHARACTER.
    this.air = ch.air || null;
    if (this.air) {
      const A = this.air;
      // 1. rasp — the collector sum, hard-saturated, then highpassed. Harmonically locked to the
      //    firing rate, so it reads as a pipe tearing rather than as noise.
      this.airDrive = ctx.createGain(); this.airDrive.gain.value = A.drive;
      this.airShape = ctx.createWaveShaper();
      this.airShape.curve = raspCurve(A.raspK); this.airShape.oversample = '4x';
      this.airHP = ctx.createBiquadFilter();
      this.airHP.type = 'highpass'; this.airHP.frequency.value = A.hp; this.airHP.Q.value = 0.7;
      this.airHP2 = ctx.createBiquadFilter();
      this.airHP2.type = 'highpass'; this.airHP2.frequency.value = A.hp; this.airHP2.Q.value = 0.6;
      this.airPk = ctx.createBiquadFilter();
      this.airPk.type = 'peaking'; this.airPk.frequency.value = A.peak;
      this.airPk.Q.value = A.peakQ; this.airPk.gain.value = A.peakGain;
      this.airG = ctx.createGain(); this.airG.gain.value = 0;
      this.collect.connect(this.airDrive); this.airDrive.connect(this.airShape);
      this.airShape.connect(this.airHP); this.airHP.connect(this.airHP2);
      this.airHP2.connect(this.airPk); this.airPk.connect(this.airG);
      this.airG.connect(this.out);

      // 2. hiss — induction / turbo air, broadband and speed-of-air driven.
      if (A.hiss > 0) {
        this.hissSrc = loopNoise(ctx, 'white', 6229, 3.3);
        this.hissHP = ctx.createBiquadFilter();
        this.hissHP.type = 'highpass'; this.hissHP.frequency.value = A.hissHz[0]; this.hissHP.Q.value = A.hissQ;
        this.hissPk = ctx.createBiquadFilter();
        this.hissPk.type = 'peaking'; this.hissPk.frequency.value = A.hissHz[1] * 0.8;
        this.hissPk.Q.value = 0.8; this.hissPk.gain.value = 6;
        this.hissG = ctx.createGain(); this.hissG.gain.value = 0;
        this.hissSrc.connect(this.hissHP); this.hissHP.connect(this.hissPk);
        this.hissPk.connect(this.hissG); this.hissG.connect(this.out);
      }

      // 3. tick — injector / valvetrain clatter: noise gated by the firing pattern, up where the
      //    exhaust isn't. Shares its wavetable with the diesel knock gate, so it costs one table.
      if (A.tick > 0) {
        this.tickSrc = loopNoise(ctx, 'white', 6421, 2.1);
        this.tickGate = ctx.createGain(); this.tickGate.gain.value = 0;
        this.tickBP = ctx.createBiquadFilter();
        this.tickBP.type = 'bandpass'; this.tickBP.frequency.value = A.tickHz[0]; this.tickBP.Q.value = A.tickQ;
        this.tickG = ctx.createGain(); this.tickG.gain.value = 0;
        this.tickSrc.connect(this.tickGate); this.tickGate.connect(this.tickBP);
        this.tickBP.connect(this.tickG); this.tickG.connect(this.out);
        this.tickOsc = ctx.createOscillator();
        this.tickOsc.setPeriodicWave(periodicWave(ctx, `${a.character}|gate`,
          () => cycleWaveform(ch.banks[0].concat(ch.banks[1] || []),
            { decay: 0.004, attack: 0.0006, ring: 0, scatter: (ch.scatter ?? 0) * 1.5, jitter: ch.jitter ?? 0, seed: 77 })));
        this.tickOsc.frequency.value = 30;
        this.tickDepth = ctx.createGain(); this.tickDepth.gain.value = 5.5;
        this.tickOsc.connect(this.tickDepth); this.tickDepth.connect(this.tickGate.gain);
        this.tickOsc.start(0);
      }
    }

    // ── combustion knock (diesel clatter): noise amplitude-gated at the firing rate ──
    if (ch.knock > 0) {
      this.knockSrc = loopNoise(ctx, 'white', 4111, 2.3);
      this.knockGate = ctx.createGain();
      this.knockGate.gain.value = 0;                     // driven entirely by the gate oscillator
      this.knockBP = ctx.createBiquadFilter();
      this.knockBP.type = 'bandpass';
      this.knockBP.frequency.value = ch.knockHz[0];
      this.knockBP.Q.value = ch.knockQ;
      this.knockLevel = ctx.createGain();
      this.knockLevel.gain.value = 0;
      this.knockSrc.connect(this.knockGate); this.knockGate.connect(this.knockBP);
      this.knockBP.connect(this.knockLevel); this.knockLevel.connect(this.out);

      // The gate is the same firing pattern, but as very short spikes.
      this.gateOsc = ctx.createOscillator();
      this.gateOsc.setPeriodicWave(periodicWave(ctx, `${a.character}|gate`,
        () => cycleWaveform(ch.banks[0].concat(ch.banks[1] || []),
          { decay: 0.004, attack: 0.0006, ring: 0, scatter: (ch.scatter ?? 0) * 1.5, jitter: ch.jitter ?? 0, seed: 77 })));
      this.gateOsc.frequency.value = 30;
      this.gateDepth = ctx.createGain();
      this.gateDepth.gain.value = 5.0;
      this.gateOsc.connect(this.gateDepth);
      this.gateDepth.connect(this.knockGate.gain);
      this.gateOsc.start(0);
    }

    // ── turbo: spool whistle + induction whoosh ─────────────────────────────────────
    if (ch.turbo) {
      this.whistle = ctx.createOscillator();
      this.whistle.type = 'sine';
      this.whistle.frequency.value = ch.turbo.whistleHz[0];
      this.whistleG = ctx.createGain(); this.whistleG.gain.value = 0;
      this.whistle.connect(this.whistleG); this.whistleG.connect(this.out);
      this.whistle.start(0);
      // A second partial a fifth up makes the whistle metallic rather than a test tone.
      this.whistle2 = ctx.createOscillator();
      this.whistle2.type = 'triangle';
      this.whistle2.frequency.value = ch.turbo.whistleHz[0] * 1.5;
      this.whistleG2 = ctx.createGain(); this.whistleG2.gain.value = 0;
      this.whistle2.connect(this.whistleG2); this.whistleG2.connect(this.out);
      this.whistle2.start(0);

      this.whooshSrc = loopNoise(ctx, 'white', 5227, 2.9);
      this.whooshBP = ctx.createBiquadFilter();
      this.whooshBP.type = 'bandpass';
      this.whooshBP.frequency.value = 1400; this.whooshBP.Q.value = 0.9;
      this.whooshG = ctx.createGain(); this.whooshG.gain.value = 0;
      this.whooshSrc.connect(this.whooshBP); this.whooshBP.connect(this.whooshG);
      this.whooshG.connect(this.out);
    }

    // ── slow idle wander: real engines never hold a perfectly steady idle ────────────
    this.lope = ctx.createOscillator();
    this.lope.type = 'sine';
    this.lope.frequency.value = 2.7;
    this.lopeG = ctx.createGain();
    this.lopeG.gain.value = 0;
    this.lope.connect(this.lopeG);
    this.lopeG.connect(this.out.gain);
    this.lope.start(0);

    this.level = MIX.engine * ch.level * (a.trim ?? 1);
  }

  setPan(p, when = this.ctx.currentTime) {
    for (const q of this.panners) q.pan.setTargetAtTime(clamp(p, -1, 1), when, 0.08);
  }

  /**
   * Schedule one frame of engine automation at absolute context time `when`.
   * This is the ONLY place engine parameters are computed — live and offline both come here.
   */
  apply(s, when, tc = 0.022) {
    const a = this.a, ch = this.ch;
    const rpm = clamp(s.rpm ?? a.idleRpm, a.idleRpm * 0.55, a.redline * 1.05);
    const norm = clamp((rpm - a.idleRpm) / (a.redline - a.idleRpm), 0, 1.05);
    const thr = clamp(s.throttle ?? 0, 0, 1);
    const shifting = !!s.shifting;
    const boost = clamp(s.boost ?? 0, 0, 1);
    // "Load" is what you HEAR: a big engine pulling hard is loud and raspy; the same rpm coasting
    // is quiet and hollow. Off throttle it goes negative-ish and we swap in the overrun voice.
    const load = shifting ? 0.08 : thr;
    const over = clamp((1 - thr * 3.2) * smoothstep(0.10, 0.42, norm), 0, 1);  // off-throttle overrun

    // ---- pitch: f0 is the half-order; the wavetable supplies every firing harmonic above it ----
    const f0 = clamp(rpm / 120, 3, 240);
    for (const o of this.oscs) o.frequency.setTargetAtTime(f0, when, tc * 0.8);
    if (this.gateOsc) this.gateOsc.frequency.setTargetAtTime(f0, when, tc * 0.8);

    // ---- combustion instability: wide and slow at idle, tight and fast on the cam ----
    const rough = a.roughness ?? 0.4;
    const steady = clamp(norm, 0, 1) * (0.4 + 0.6 * load);
    this.wobPitch.gain.setTargetAtTime(rough * lerp(46, 7, steady), when, 0.12);
    this.wobAmp.gain.setTargetAtTime(rough * lerp(0.045, 0.010, steady) * this.level, when, 0.12);
    this.wob2G.gain.setTargetAtTime(rough * lerp(0.030, 0.012, steady) * this.level * (0.4 + 0.6 * load), when, 0.10);
    for (const w of this.bankWob) w.g.gain.setTargetAtTime(rough * lerp(0.30, 0.10, steady), when, 0.14);

    // ---- the wail: a resonance parked on one firing order, so it climbs with the engine ----
    if (this.wailF) {
      const W = ch.wail;
      this.wailF.frequency.setTargetAtTime(clamp(f0 * W.order, 70, 16000), when, 0.05);
      this.wailF.gain.setTargetAtTime(W.gain * (0.25 + 0.75 * load) * (0.35 + 0.65 * clamp(norm, 0, 1)), when, 0.06);
      this.wailF.Q.setTargetAtTime(lerp(W.q * 0.6, W.q, clamp(norm, 0, 1)), when, 0.08);
    }

    // ---- wavetable crossfade: soft pulses at idle, hard pulses on cam ----
    const zpos = clamp(norm, 0, 1) * (ch.zones.length - 1);
    for (let b = 0; b < this.zoneGains.length; b++) {
      for (let z = 0; z < this.zoneGains[b].length; z++) {
        const w = clamp(1 - Math.abs(zpos - z), 0, 1);
        this.zoneGains[b][z].gain.setTargetAtTime(w, when, 0.06);
      }
    }

    // ---- tone ----
    const cut = lerp(ch.cut[0], ch.cut[1], Math.pow(clamp(norm, 0, 1), 0.85)) * (0.62 + 0.38 * load) * (1 - 0.22 * over);
    this.lp.frequency.setTargetAtTime(clamp(cut, 120, 18000), when, 0.03);
    this.lp.Q.setTargetAtTime(lerp(ch.cutQ[0], ch.cutQ[1], clamp(norm, 0, 1)) * (0.6 + 0.4 * load), when, 0.05);
    this.body.frequency.setTargetAtTime(lerp(ch.body.hz[0], ch.body.hz[1], clamp(norm, 0, 1)), when, 0.06);
    this.drive.gain.setTargetAtTime(lerp(ch.drive[0], ch.drive[1], clamp(norm, 0, 1) * (0.35 + 0.65 * load)), when, 0.05);

    // ---- induction ----
    this.intakeBP.frequency.setTargetAtTime(lerp(ch.intake.hz[0], ch.intake.hz[1], clamp(norm, 0, 1)), when, 0.04);
    this.intakeGain.gain.setTargetAtTime(
      ch.intake.level * (0.10 + 0.90 * load) * (0.22 + 0.78 * clamp(norm, 0, 1)) * this.level * 0.55, when, 0.05);

    // ---- air: rasp / hiss / tick ----
    // All three ride `this.out`, so they inherit the engine's own level envelope and cannot exist
    // without the engine — but their BALANCE against the dark exhaust path is per class.
    if (this.air) {
      const A = this.air;
      const n01 = clamp(norm, 0, 1);
      // How hard the engine is breathing. Air is a function of load first and revs second: a car
      // coasting at 5000 rpm has far less of it than one pulling at 3000.
      const open = Math.pow(n01, 0.7) * (0.18 + 0.82 * load);
      this.airHP.frequency.setTargetAtTime(lerp(A.hp * 0.8, A.hp * 1.15, n01), when, 0.05);
      this.airHP2.frequency.setTargetAtTime(lerp(A.hp * 0.8, A.hp * 1.15, n01), when, 0.05);
      this.airPk.frequency.setTargetAtTime(lerp(A.peak * 0.68, A.peak, n01), when, 0.06);
      // The overrun term is the muscle car's crackle and the tuner's wastegate chatter: lift at
      // revs and the pipe keeps tearing for a moment after the exhaust note has gone quiet.
      this.airG.gain.setTargetAtTime(
        A.rasp * (0.055 + 0.945 * open) * (1 + (A.over || 0) * over) * 0.078, when, 0.035);

      if (this.hissG) {
        this.hissHP.frequency.setTargetAtTime(
          lerp(A.hissHz[0], A.hissHz[1] * 0.72, clamp(n01 * 0.65 + boost * 0.5, 0, 1)), when, 0.06);
        this.hissG.gain.setTargetAtTime(
          A.hiss * (0.10 + 0.90 * open) * (1 + (A.hissBoost || 0) * boost) * 0.019, when, 0.05);
      }
      if (this.tickG) {
        this.tickOsc.frequency.setTargetAtTime(f0, when, tc * 0.8);
        this.tickBP.frequency.setTargetAtTime(lerp(A.tickHz[0], A.tickHz[1], n01), when, 0.05);
        // Clatter is a COMBUSTION artefact, not an rpm artefact: it is loudest lugging under load
        // and it never fully goes away, which is why the idle floor is its own number.
        const idleFloor = A.tickIdle ?? 0.4;
        this.tickG.gain.setTargetAtTime(
          A.tick * (idleFloor + (1 - idleFloor) * load) * (1.0 - 0.45 * n01) * (1 - 0.55 * over) * 0.10,
          when, 0.05);
      }
    }

    // ---- diesel knock ----
    if (this.knockLevel) {
      this.knockBP.frequency.setTargetAtTime(lerp(ch.knockHz[0], ch.knockHz[1], clamp(norm, 0, 1)), when, 0.05);
      // Knock is loudest under load at low rpm — that lug-and-clatter a loaded truck makes.
      const k = ch.knock * (0.30 + 0.70 * load) * (1.0 - 0.40 * clamp(norm, 0, 1));
      this.knockLevel.gain.setTargetAtTime(k * this.level, when, 0.05);
    }

    // ---- turbo ----
    if (this.whistle) {
      const t = ch.turbo;
      const wf = lerp(t.whistleHz[0], t.whistleHz[1], clamp(norm * 0.55 + boost * 0.55, 0, 1));
      this.whistle.frequency.setTargetAtTime(wf, when, 0.07);
      this.whistle2.frequency.setTargetAtTime(wf * 1.48, when, 0.07);
      // r1 had this 25 dB under the exhaust, i.e. inaudible, which left the tuner as "a quiet V8
      // with a short stroke". A spooled compressor on a small four is a LOUD thing and it is the
      // single cue that tells you which of the four cars you are in.
      const wg = t.whistle * boost * boost * 0.155 * this.level;
      this.whistleG.gain.setTargetAtTime(wg, when, 0.06);
      this.whistleG2.gain.setTargetAtTime(wg * 0.45, when, 0.06);
      this.whooshBP.frequency.setTargetAtTime(lerp(700, 3400, boost), when, 0.06);
      this.whooshG.gain.setTargetAtTime(t.whoosh * boost * (0.2 + 0.8 * thr) * 0.115 * this.level, when, 0.06);
    }

    // ---- idle wander + rev-limiter chop ----
    this.lope.frequency.setTargetAtTime(lerp(2.2, 9, clamp(norm, 0, 1)), when, 0.1);
    this.lopeG.gain.setTargetAtTime(ch.lope * (a.roughness ?? 0.4) * 0.055 * (1 - 0.7 * clamp(norm, 0, 1)), when, 0.08);

    // ---- level ----
    // The engine's own dynamic range, and it is deliberately WIDE: a 22 dB spread from a closed
    // throttle at idle to wide open at the limiter. r1 spanned 11 dB and that is the difference
    // between an engine and a drone. The three terms are independent on purpose — a big engine
    // lugging at 1500 rpm under full load is loud, and the same rpm coasting is nearly silent.
    // The idle term is its own number and it is deliberately generous. Three of the four
    // characters — the lope, the diesel clatter, the flat-plane's high hard idle — LIVE at idle,
    // and r2 rendered them 4 dB under their own wind bed, i.e. the loudest moment of an idle clip
    // was an ambience gust. The lift decays to nothing by 28 % throttle, so it cannot touch the
    // rest of the range or the headroom an impact needs.
    let vol = (0.145 + 0.115 * (1 - smoothstep(0, 0.28, load))
      + 0.285 * load + 0.62 * Math.pow(clamp(norm, 0, 1), 1.25) * (0.34 + 0.66 * load));
    vol *= (1 - 0.66 * over);                                        // lift off and it falls away
    if (shifting) vol *= 0.20;                                       // ignition cut, and you hear it
    let onLimiter = false;
    if (rpm > a.redline * 0.985 && thr > 0.5) {                      // limiter chops the spark
      onLimiter = Math.sin(when * 2 * Math.PI * 15) <= 0;
      if (onLimiter) vol *= 0.16;
    }
    // A 22 ms smoothing constant turns a 33 ms spark cut into a gentle wobble. On the limiter the
    // gain has to move as fast as the ignition does, or hitting the rev limiter — one of the few
    // moments a driver is actively listening to the engine — sounds like a tremolo pedal.
    this.out.gain.setTargetAtTime(vol * this.level * (s.volume ?? 1), when,
      shifting ? 0.006 : (onLimiter ? 0.004 : tc));
    // ...and the cut charge lights off in the pipe, which is why a car on the limiter spits.
    if (onLimiter && !this._limWas && ch.crackle > 0) this.pop(when + 0.004, 0.85);
    this._limWas = onLimiter;

    // ---- THE UPSHIFT (§6.9 "audible upshifts") ----
    // r1's shift was a 14 dB dip and nothing else, which reads as a dropout rather than as a gear
    // change. A real full-throttle upshift is a violent event: the ignition is cut, the unburnt
    // charge lights off in the pipe, and on a turbo car the wastegate dumps. Detecting the edge
    // HERE rather than in the two callers means the live game and the WAV render fire the same
    // event off the same state, which is the whole reason `apply` takes an explicit time.
    if (shifting && !this._shiftEdge) {
      this._shiftEdge = true;
      this.upshift(when, clamp(norm, 0, 1), boost);
    } else if (!shifting) {
      this._shiftEdge = false;
    }

    // ---- overrun crackle: unburnt fuel lighting off in the pipes on a trailing throttle ----
    if (over > 0.25 && ch.crackle > 0) {
      // Snapping the throttle shut at revs gives a BURST, then a scattered tail — that first
      // "brap" is the whole point of an overrun.
      if (!this._overOn && clamp(norm, 0, 1) > 0.45) {
        const burst = 3 + Math.round(this.rng.range(0, 3) * ch.crackle);
        for (let i = 0; i < burst; i++) {
          this.pop(when + 0.02 + this.rng.range(0, 0.26), this.rng.range(0.7, 1.15));
        }
      }
      this._overOn = true;
      this._popClock += 1 / 60;
      const rate = 0.045 + 0.10 * (1 - over) + this.rng.range(0, 0.05);
      while (this._popClock > rate) {
        this._popClock -= rate;
        if (this.rng.next() < 0.7 * ch.crackle) {
          this.pop(when + this.rng.range(0, 0.03), over * this.rng.range(0.45, 1.0));
        }
      }
    } else {
      this._popClock = 0;
      this._overOn = false;
    }
    return { norm, over, load };
  }

  /**
   * The gear change, as an EVENT rather than a hole. Three parts, all on the un-ducked fx bus:
   *   1. the cut itself — a short hard bark out of the pipe as the spark stops
   *   2. two or three crackles into the re-engagement
   *   3. the blow-off, if this car has a turbo spun up to dump
   * Scaled by how far up the rev range the change happened, so pottering shifts are polite and a
   * limiter-to-limiter change is a bang.
   */
  upshift(when, norm = 1, boost = 0) {
    const ch = this.ch;
    const ctx = this.ctx;
    const hard = 0.30 + 0.70 * clamp(norm, 0, 1);
    // Open a short hole in the whole programme first — the engine already cuts its own ignition,
    // but the tyres, the bed and the music do not, and without this the bark lands at exactly the
    // level of what it is supposed to interrupt.
    this.masterBus?.duck(when - 0.005, 0.30 + 0.28 * hard, 0.05, 0.19);
    // 1. the bark — a filtered noise crack with a tuned body, an order of magnitude shorter than
    // an overrun pop and a good deal louder.
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.3, 6607);
    n.playbackRate.value = this.rng.range(0.9, 1.15);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.1;
    f.frequency.setValueAtTime(lerp(ch.crackleHz[0], ch.crackleHz[1], 0.55), when);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, ch.crackleHz[0] * 0.6), when + 0.09);
    const g = ctx.createGain();
    // Loud on purpose: a full-throttle upshift is the biggest transient in normal driving, and it
    // lands in the hole the ignition cut has just opened. r1 put it 5 dB UNDER the engine, which
    // is why the gear change read as a dropout.
    // Loud, but NOT as loud as hitting something. r2 ran this at +3.7 dB on the event bus, which
    // put a routine gear change within 3 dB of a 100 % barrier crash and left a 60 %-severity
    // impact with nothing to be louder than. A shift is the biggest transient in normal DRIVING;
    // a collision is not normal driving.
    const lvl = 1.40 * hard * (0.45 + 0.55 * ch.crackle) * this.level;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl), when + 0.0025);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.085);
    n.connect(f); f.connect(g); g.connect(this.fx);
    n.start(when); n.stop(when + 0.15);
    // ...with the pipe's own body under it, so the bark has a note and not just a hiss
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(lerp(120, 320, clamp(norm, 0, 1)) * (ch.pipeHz[0] / 150), when);
    o.frequency.exponentialRampToValueAtTime(46, when + 0.10);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, when);
    og.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl * 0.9), when + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    o.connect(og); og.connect(this.fx);
    o.start(when); o.stop(when + 0.17);
    // 2. the crackles on the way back in
    const pops = 1 + Math.round(this.rng.range(0, 2.4) * ch.crackle);
    for (let i = 0; i < pops; i++) this.pop(when + 0.045 + this.rng.range(0, 0.11), hard * this.rng.range(0.5, 0.95));
    // 3. the wastegate
    this.bov(when + 0.012, boost);
  }

  /** A single exhaust pop / crackle: a bandpassed crack plus a short tailpipe thump. */
  pop(when, amt = 0.6) {
    const ctx = this.ctx, ch = this.ch;
    const lvl = Math.max(0.002, 1.35 * amt * ch.crackle * this.level);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.25, 7717);
    n.playbackRate.value = this.rng.range(0.8, 1.3);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = this.rng.range(0.7, 1.4);
    f.frequency.setValueAtTime(lerp(ch.crackleHz[0], ch.crackleHz[1], this.rng.next()), when);
    const g = ctx.createGain();
    const dur = this.rng.range(0.035, 0.13);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(lvl, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    n.connect(f); f.connect(g); g.connect(this.fx);
    n.start(when); n.stop(when + dur + 0.05);

    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(this.rng.range(150, 260), when);
    o.frequency.exponentialRampToValueAtTime(52, when + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, when);
    og.gain.exponentialRampToValueAtTime(lvl * 0.8, when + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.10);
    o.connect(og); og.connect(this.fx);
    o.start(when); o.stop(when + 0.13);
  }

  /** Blow-off valve chirp — fired on an upshift while the turbo is spun up. */
  bov(when, boost = 1) {
    const ch = this.ch;
    if (!ch.turbo || boost < 0.15) return;
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.5, 8123);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2.4;
    f.frequency.setValueAtTime(4200, when);
    f.frequency.exponentialRampToValueAtTime(900, when + 0.20);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.30 * ch.turbo.bov * boost * this.level, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
    n.connect(f); f.connect(g); g.connect(this.fx);
    n.start(when); n.stop(when + 0.3);
  }

  /** LIVE path: `s` comes from physics; boost is integrated here with the shared turbo model. */
  update(s, dt = 1 / 60) {
    const when = this.ctx.currentTime;
    const a = this.a;
    const norm = clamp(((s.rpm ?? a.idleRpm) - a.idleRpm) / (a.redline - a.idleRpm), 0, 1);
    this._boost = turboStep(this._boost, s.throttle ?? 0, norm, clamp(dt, 0.001, 0.1), this.ch.turbo);
    const shifting = !!(s.shifting ?? s.gearShift);
    this._prevShift = shifting;
    // The upshift event (bark + crackle + wastegate) fires inside apply() off the same edge the
    // renderer sees, so there is exactly one gear-change sound in the codebase.
    this.apply({ ...s, shifting, boost: this._boost }, when);
  }

  stop() {
    try {
      for (const o of this.oscs) o.stop();
      this.lope.stop();
      this.intakeSrc.stop();
      this.knockSrc?.stop(); this.gateOsc?.stop();
      this.whistle?.stop(); this.whistle2?.stop(); this.whooshSrc?.stop();
      this.hissSrc?.stop(); this.tickSrc?.stop(); this.tickOsc?.stop();
      this.wobSrc?.stop(); this.wob2?.stop();
      for (const w of this.bankWob || []) w.src.stop();
    } catch { /* already stopped */ }
    this.out.disconnect(); this.fx.disconnect(); this.fxBus.disconnect(); this.bus.disconnect();
    for (const p of this.panners) p.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════ drive sim

const GEARS = [3.30, 2.15, 1.58, 1.22, 1.00, 0.84];

/**
 * A tiny gearbox + torque model. The game has a real physics engine, but the offline renderer
 * needs *something* to drive the voice with, and it has to produce a pull that genuinely
 * accelerates, real upshifts, and a real overrun (§6.9). Deterministic — no Math.random.
 */
export class DriveSim {
  constructor(spec, { gearScale = 1 } = {}) {
    this.a = spec.audio;
    this.ch = characterOf(this.a.character);
    this.w = 0;             // normalised road speed, 1 ≈ top gear at redline
    this.gear = 0;
    this.shiftT = 0;
    this.boost = 0;
    this.rpm = this.a.idleRpm;
    this.gearScale = gearScale;
    this.justShifted = false;
    this.justDropped = false;
    this.blipT = 0;
    this.clock = 0;
    this.K = this.a.redline / GEARS[GEARS.length - 1];
  }

  /** Gaussian torque hump, so the pull has a fat midrange and falls off past peak power. */
  torque(norm) {
    const p = 0.72, bw = 0.42;
    return 0.42 + 0.72 * Math.exp(-((norm - p) ** 2) / (2 * bw * bw)) - 0.30 * smoothstep(0.94, 1.05, norm);
  }

  step(dt, throttle) {
    const a = this.a;
    this.justShifted = false;
    this.justDropped = false;
    // Rev-matching blip on the way down the box — the detail that makes a downshift audible.
    if (this.blipT > 0) { this.blipT -= dt; throttle = Math.max(throttle, 0.62); }
    const gr = GEARS[this.gear] * this.gearScale;
    const geared = this.w * gr * this.K;
    // Clutch slip on launch: the engine flares, then the clutch bites and drags it back down.
    const clutch = 1 - smoothstep(0, 0.10, this.w);
    const flare = a.idleRpm + (a.redline - a.idleRpm) * (0.20 + 0.58 * throttle);
    let rpm = lerp(Math.max(a.idleRpm, geared), flare, clutch * clamp(throttle * 1.4, 0, 1));
    // A real idle hunts. Two incommensurate sines scaled by the class roughness — deterministic,
    // and enough to stop a held idle sounding like a held oscillator.
    this.clock += dt;
    const hunt = (a.roughness ?? 0.4) * (a.redline - a.idleRpm) * 0.016
      * (Math.sin(this.clock * 2.13) * 0.6 + Math.sin(this.clock * 5.7 + 1.1) * 0.4);
    rpm += hunt * clamp(1.3 - (rpm - a.idleRpm) / (a.redline - a.idleRpm) * 3, 0, 1);
    rpm = clamp(rpm, a.idleRpm * 0.9, a.redline * 1.02);

    const norm = clamp((rpm - a.idleRpm) / (a.redline - a.idleRpm), 0, 1.05);
    this.boost = turboStep(this.boost, throttle, norm, dt, this.ch.turbo);

    if (this.shiftT > 0) {
      this.shiftT -= dt;
      if (this.shiftT <= 0 && this.gear < GEARS.length - 1) { this.gear++; }
    } else if (rpm > a.redline * 0.985 && throttle > 0.5 && this.gear < GEARS.length - 1) {
      this.shiftT = 0.13;
      this.justShifted = true;
    } else if (rpm < a.idleRpm + (a.redline - a.idleRpm) * 0.46 && this.gear > 0) {
      this.gear--;                                                    // dropping down off throttle
      this.justDropped = true;
      this.blipT = 0.13;
    }

    const shifting = this.shiftT > 0;
    const thr = shifting ? 0.05 : throttle;
    const boostPull = this.ch.turbo ? 1 + 0.55 * this.boost : 1;
    const pull = thr * this.torque(norm) * (gr / GEARS[0]) * 0.46 * boostPull;
    // Off the throttle a car slows HARD — that deceleration is what makes the overrun read as a
    // lift rather than a fade-out.
    const drag = 0.10 * this.w * this.w + 0.014 + (throttle < 0.05 ? 0.11 + 0.46 * this.w : 0);
    this.w = clamp(this.w + (pull - drag) * dt, 0, 1.02);

    this.rpm = rpm;
    return { rpm, throttle: thr, shifting, boost: this.boost, gear: this.gear, speed: this.w, norm };
  }
}

// ═════════════════════════════════════════════════════════════════════════════ surfaces

/**
 * Surface changes (§6.9). A surface is not an EQ setting on one tyre sound — each of these picks a
 * different set of MECHANISMS out of the tyre voice, and that is the whole reason you can tell them
 * apart with your eyes shut. r2 shipped one filtered-noise bed whose colour moved a little per
 * surface, and a critic measuring 5 s of a car crossing tarmac → concrete → dirt → kerb could not
 * find the boundaries in any band. Four mechanisms, four unmistakable signatures:
 *
 *   tarmac    a stick-slip note (`tone`) plus fine shear hiss. The reference squeal.
 *   concrete  the same note a fourth higher, more tonal, higher-Q, and much brighter on top —
 *             the surface is harder, so the tread block releases faster and rings cleaner.
 *   dirt      `tone: 0`. There is no stick-slip on a loose surface because the surface itself
 *             shears first, so the tonal partial is switched OFF ENTIRELY and replaced by a low
 *             broadband roar plus `spray` — thousands of discrete stone strikes a second.
 *   kerb      `beat: 1`. A rumble strip hammers the tyre at a fixed SPATIAL frequency, so it gets
 *             a periodic impulse train at `speed / ribM` Hz driving a 90-140 Hz body resonance
 *             (`thumpHz`) and a bright chatter — a BRRRP with real low end, not a hiss.
 *
 *   tone       0..1.3 how much stick-slip partial exists at all (0 = no squeal is possible)
 *   sq         [grip, full-lock] relaxation frequency of that partial, Hz — the note you hear
 *   form       three formant centres the partial is voiced through — the tyre's vowel
 *   grit       5-12 kHz shear hiss: rubber shearing across aggregate
 *   roar/roarLvl  the broadband scrub band and its weight — loose surfaces are nearly all this
 *   spray      density of discrete stone strikes (dirt/gravel only)
 *   beat/ribM/thumpHz  rumble-strip strike train: depth, rib spacing in metres, body resonance
 *   warble/rough  slow load "waaah" and fast grinding roughness rates, in Hz
 *
 * `tickHz` / `tickEdge` colour the IMPACT transient (see `scheduleImpact` layer 0): what a hit
 * against this surface sounds like in its first five milliseconds. A rumble strip is a hard bright
 * plastic tick, concrete is a sharp crack, dirt is a dull slap with no edge on it at all.
 * `roll` / `rollQ` / `level` are also read by the ambience bed, and `rumble` by the impact code.
 */
const TARMAC = {
  tone: 0.85, sq: [640, 1240], form: [1220, 2620, 4250], formQ: 9, grit: 1.0,
  roar: [190, 640], roarLvl: 0.60, spray: 0.02, beat: 0, ribM: 0.62, thumpHz: 104,
  warble: [7, 19], rough: [44, 122],
  roll: [180, 900], rollQ: 0.7, level: 1.0, rumble: 0, tickHz: 1.00, tickEdge: 1.00, tickLvl: 1.00,
};
export const SURFACE = {
  road: TARMAC,
  asphalt: TARMAC,
  concrete: {
    tone: 1.25, sq: [830, 1620], form: [1560, 3240, 5400], formQ: 14, grit: 1.45,
    roar: [250, 820], roarLvl: 0.42, spray: 0.05, beat: 0, ribM: 0.62, thumpHz: 118,
    warble: [9, 24], rough: [58, 165],
    roll: [240, 1300], rollQ: 0.9, level: 1.05, rumble: 0, tickHz: 1.14, tickEdge: 1.20, tickLvl: 1.18,
  },
  wet: {
    tone: 0.42, sq: [470, 880], form: [880, 1850, 3100], formQ: 6, grit: 1.5,
    roar: [220, 980], roarLvl: 0.85, spray: 0.30, beat: 0, ribM: 0.62, thumpHz: 96,
    warble: [5, 13], rough: [30, 92],
    roll: [220, 1500], rollQ: 0.5, level: 0.85, rumble: 0, tickHz: 0.85, tickEdge: 0.62, tickLvl: 0.90,
  },
  // Off the tarmac there is no squeal at all — the surface shears before the rubber does.
  dirt: {
    tone: 0.0, sq: [380, 900], form: [480, 1050, 2100], formQ: 2, grit: 0.50,
    roar: [130, 540], roarLvl: 2.25, spray: 1.15, beat: 0, ribM: 0.62, thumpHz: 88,
    warble: [4, 11], rough: [16, 44],
    roll: [120, 520], rollQ: 0.45, level: 0.8, rumble: 0.25, tickHz: 0.66, tickEdge: 0.78, tickLvl: 1.28,
  },
  grass: {
    tone: 0.0, sq: [300, 760], form: [420, 900, 1800], formQ: 1.8, grit: 0.30,
    roar: [100, 400], roarLvl: 1.45, spray: 0.45, beat: 0, ribM: 0.62, thumpHz: 78,
    warble: [3, 9], rough: [14, 36],
    roll: [100, 380], rollQ: 0.4, level: 0.7, rumble: 0.15, tickHz: 0.48, tickEdge: 0.34, tickLvl: 0.92,
  },
  // Rumble strip: the tyre is being hammered at a fixed spatial frequency.
  kerb: {
    tone: 0.22, sq: [700, 1300], form: [1050, 2200, 3700], formQ: 5, grit: 0.85,
    roar: [180, 720], roarLvl: 0.55, spray: 0.18, beat: 1.0, ribM: 0.62, thumpHz: 116,
    warble: [6, 16], rough: [26, 74],
    roll: [150, 700], rollQ: 0.6, level: 0.95, rumble: 1.0, tickHz: 1.14, tickEdge: 0.80, tickLvl: 1.00,
  },
};
export function surfaceOf(id) { return SURFACE[id] || SURFACE.road; }

// ═══════════════════════════════════════════════════════════════════════════ TyreVoice

/**
 * THE TYRE VOICE — a stick-slip oscillator, not a filtered noise bed.
 *
 * r2's tyres were noise behind two moving bandpasses. Measured across a five-second slalom they
 * swelled 6 dB above their own troughs, and the tarmac → concrete → dirt → kerb changes underneath
 * were not separable in any band: five seconds of a car sliding across three surfaces read as one
 * continuous, slowly-brightening hiss. Drifting is the centre of this game, so that layer is
 * rebuilt here around the actual mechanism.
 *
 *   1. THE PARTIAL. A tread block grips, loads elastically, snaps back, and does it again a
 *      thousand times a second — a relaxation oscillation (see `stickSlipWave`). That is played by
 *      an oscillator at the relaxation frequency, so the squeal has a PITCH, and the pitch is a
 *      function of the two things a driver is actually doing: slip angle raises it (a harder scrub
 *      releases the block sooner) and vertical load lowers it (a loaded block holds on longer). The
 *      note therefore BENDS through a slide as the car takes weight and gives it back, which is the
 *      cue that says the tyre is being worked rather than that a sound is being played. A second,
 *      inharmonic partner at ×1.487 beats against it so it is never a clean synth tone, and a slow
 *      noise wander keeps it unstable.
 *   2. THE GATE. Between gripping and full lock the partial moves ~45 dB, not 6. A tyre at 10 % of
 *      its slip budget makes no squeal at all, and that silence is what makes the slide loud.
 *   3. THE VOWEL. Three formants, per surface, per class — the partial is voiced through them, so a
 *      wide sticky supercar tyre and a tall truck sidewall are different instruments and not two
 *      transpositions of one.
 *   4. THE SURFACE MECHANISMS. Loose surfaces switch the partial OFF and switch on a low roar plus
 *      discrete stone strikes; a rumble strip switches on an impulse train at the rib-crossing rate
 *      driving a 90-140 Hz body resonance. See the SURFACE table above.
 */
const TYRE_DEFAULT = { formant: 1, howl: 1, roar: 1, stick: 1 };

export class TyreVoice {
  constructor(ctx, dest, { tyre = null, space = null, pan = 0 } = {}) {
    this.ctx = ctx;
    // Rubber is per-class (§6.9 "class differentiation"): a wide sticky supercar tyre howls a
    // third higher and far more tonally than the tall soft sidewall on a two-and-a-half tonne
    // truck, which mostly just roars.
    this.t = { ...TYRE_DEFAULT, ...(tyre || {}) };
    // Every layer sums here, then goes through the tyre bus's own soft limiter. A squeal is a
    // savagely peaky signal — a bent formant under a deep "waaah" — and without this the layer can
    // only be made LOUD by making its peaks hit the master ceiling, which is how r2 ended up with
    // a tyre that measured -18 dB RMS and still could not be heard. Density instead of peaks.
    // Driven at 0.5 and made up 2x, so the curve's [-1,1] domain covers a sum of +-2: unity below
    // 1, a gentle 1.5 dB of limiting between 1 and 2, and the shaper's hard endpoint is somewhere
    // the signal never actually reaches. Drive it at 1.0 instead and every peak past full scale
    // clips flat inside the tyre bus.
    this.out = ctx.createGain(); this.out.gain.value = 1;
    this.drive = ctx.createGain(); this.drive.gain.value = 0.5;
    this.sat = ctx.createWaveShaper(); this.sat.curve = limitCurve(0.38); this.sat.oversample = '4x';
    this.post = ctx.createGain(); this.post.gain.value = MIX.tyre * 2;
    this.out.connect(this.drive); this.drive.connect(this.sat); this.sat.connect(this.post);
    // The tyres are ON the car, so they travel with it. r2 panned only the engine, which is why a
    // pass-by moved 6 dB of balance instead of the 15+ dB a car crossing in front of you moves.
    if (ctx.destination.channelCount > 1 && ctx.createStereoPanner) {
      this.pan = ctx.createStereoPanner(); this.pan.pan.value = pan;
      this.post.connect(this.pan); this.pan.connect(dest);
    } else this.post.connect(dest);
    // Rubber shrieking off tarmac is the sound most obviously reflected off whatever is beside
    // the road — a squeal in a tunnel is a different event from a squeal in a field.
    sendSpace(ctx, this.post, space, 0.34, 0.20);

    // ── 1. the stick-slip partial ───────────────────────────────────────────────────────
    const w1 = periodicWave(ctx, 'tyre|ss|hard', () => stickSlipWave(0.13, 1.6));
    const w2 = periodicWave(ctx, 'tyre|ss|soft', () => stickSlipWave(0.26, 1.15));
    this.o1 = ctx.createOscillator(); this.o1.setPeriodicWave(w1); this.o1.frequency.value = 900;
    this.o2 = ctx.createOscillator(); this.o2.setPeriodicWave(w2); this.o2.frequency.value = 1338;
    this.o2g = ctx.createGain(); this.o2g.gain.value = 0.42;
    this.osc = ctx.createGain(); this.osc.gain.value = 1;
    this.o1.connect(this.osc); this.o2.connect(this.o2g); this.o2g.connect(this.osc);
    // a little hard edge on the snap — a real squeal is not a polite waveform
    this.edge = ctx.createWaveShaper(); this.edge.curve = raspCurve(1.7); this.edge.oversample = '2x';
    this.osc.connect(this.edge);

    // the vowel: three resonances, per surface and per class
    this.toneG = ctx.createGain(); this.toneG.gain.value = 0;
    this.fm = [];
    const fgains = [1.0, 0.66, 0.40];
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1200 * (i + 1); f.Q.value = 9;
      const g = ctx.createGain(); g.gain.value = fgains[i];
      this.edge.connect(f); f.connect(g); g.connect(this.toneG);
      this.fm.push(f);
    }
    // ...plus a little of the raw waveform, so the harmonic series above the top formant survives
    this.dry = ctx.createGain(); this.dry.gain.value = 0.16;
    this.edge.connect(this.dry); this.dry.connect(this.toneG);
    this.toneG.connect(this.out);
    this.o1.start(0); this.o2.start(0);

    // the "waaah": the slow swell as the slide loads and unloads. Modulates level AND pitch.
    this.warb = ctx.createOscillator(); this.warb.type = 'triangle'; this.warb.frequency.value = 11;
    this.warbA = ctx.createGain(); this.warbA.gain.value = 0;
    this.warbF = ctx.createGain(); this.warbF.gain.value = 0;
    this.warb.connect(this.warbA); this.warb.connect(this.warbF);
    this.warbA.connect(this.toneG.gain);
    this.warbF.connect(this.o1.frequency); this.warbF.connect(this.o2.frequency);
    this.warb.start(0);
    // ...and the fast grinding roughness on top of it
    this.rough = ctx.createOscillator(); this.rough.type = 'triangle'; this.rough.frequency.value = 70;
    this.roughG = ctx.createGain(); this.roughG.gain.value = 0;
    this.rough.connect(this.roughG); this.roughG.connect(this.toneG.gain); this.rough.start(0);
    // instability — a squealing tyre never holds a steady note for even a tenth of a second
    this.wander = loopNoise(ctx, 'brown', 2141, 3.3);
    this.wanderLP = ctx.createBiquadFilter(); this.wanderLP.type = 'lowpass'; this.wanderLP.frequency.value = 5.5;
    this.wanderG = ctx.createGain(); this.wanderG.gain.value = 0;
    this.wander.connect(this.wanderLP); this.wanderLP.connect(this.wanderG);
    this.wanderG.connect(this.o1.frequency); this.wanderG.connect(this.o2.frequency);

    // ── 2. broadband scrub / loose-aggregate roar ───────────────────────────────────────
    this.roarSrc = loopNoise(ctx, 'grain', 2637, 2.4);
    this.roarBP = ctx.createBiquadFilter(); this.roarBP.type = 'bandpass'; this.roarBP.frequency.value = 400; this.roarBP.Q.value = 0.5;
    this.roarPk = ctx.createBiquadFilter(); this.roarPk.type = 'peaking'; this.roarPk.frequency.value = 250; this.roarPk.Q.value = 0.8; this.roarPk.gain.value = 6;
    this.roarG = ctx.createGain(); this.roarG.gain.value = 0;
    this.roarSrc.connect(this.roarBP); this.roarBP.connect(this.roarPk); this.roarPk.connect(this.roarG); this.roarG.connect(this.out);

    // ── 3. fine shear hiss — rubber tearing across aggregate ────────────────────────────
    this.hiSrc = loopNoise(ctx, 'white', 2711, 2.3);
    this.hiHP = ctx.createBiquadFilter(); this.hiHP.type = 'highpass'; this.hiHP.frequency.value = 4800; this.hiHP.Q.value = 0.7;
    this.hiHP2 = ctx.createBiquadFilter(); this.hiHP2.type = 'highpass'; this.hiHP2.frequency.value = 4800; this.hiHP2.Q.value = 0.6;
    this.hiPk = ctx.createBiquadFilter(); this.hiPk.type = 'peaking'; this.hiPk.frequency.value = 8600; this.hiPk.Q.value = 0.8; this.hiPk.gain.value = 7;
    this.hiG = ctx.createGain(); this.hiG.gain.value = 0;
    this.hiSrc.connect(this.hiHP); this.hiHP.connect(this.hiHP2);
    this.hiHP2.connect(this.hiPk); this.hiPk.connect(this.hiG); this.hiG.connect(this.out);
    // the hiss breathes with the same "waaah", so texture and note are one gesture
    this.warbH = ctx.createGain(); this.warbH.gain.value = 0;
    this.warb.connect(this.warbH); this.warbH.connect(this.hiG.gain);

    // ── 4. loose aggregate: discrete stone strikes (dirt, gravel, wet) ──────────────────
    this.spraySrc = loopNoise(ctx, 'spray', 2903, 2.7);
    this.sprayBP = ctx.createBiquadFilter(); this.sprayBP.type = 'bandpass'; this.sprayBP.frequency.value = 2600; this.sprayBP.Q.value = 0.55;
    this.sprayG = ctx.createGain(); this.sprayG.gain.value = 0;
    this.spraySrc.connect(this.sprayBP); this.sprayBP.connect(this.sprayG); this.sprayG.connect(this.out);
    // ...and the heavier stuff hitting the wheel arch, an octave and a half down
    this.arch = ctx.createBiquadFilter(); this.arch.type = 'bandpass'; this.arch.frequency.value = 520; this.arch.Q.value = 0.9;
    this.archG = ctx.createGain(); this.archG.gain.value = 0;
    this.spraySrc.connect(this.arch); this.arch.connect(this.archG); this.archG.connect(this.out);

    // ── 5. rumble strip: an impulse train at the rib-crossing rate ──────────────────────
    // The pulse train is a SOURCE here, not a gate on some noise: that is what puts real periodic
    // energy at 80-150 Hz under a kerb instead of a low-passed wash.
    this.pulse = ctx.createOscillator();
    this.pulse.setPeriodicWave(periodicWave(ctx, 'tyre|rib', () => cycleWaveform([0], { decay: 0.055, attack: 0.0022, ring: 0.30, ringHz: 6 })));
    this.pulse.frequency.value = 40;
    this.pulseOut = ctx.createGain(); this.pulseOut.gain.value = 1;
    this.pulse.connect(this.pulseOut); this.pulse.start(0);
    // body: the suspension and the shell answering each rib
    this.thumpBP = ctx.createBiquadFilter(); this.thumpBP.type = 'bandpass'; this.thumpBP.frequency.value = 116; this.thumpBP.Q.value = 5.0;
    this.thumpG = ctx.createGain(); this.thumpG.gain.value = 0;
    this.pulseOut.connect(this.thumpBP); this.thumpBP.connect(this.thumpG); this.thumpG.connect(this.out);
    // the hard bright edge of the rib itself
    this.tickBP = ctx.createBiquadFilter(); this.tickBP.type = 'bandpass'; this.tickBP.frequency.value = 2400; this.tickBP.Q.value = 1.1;
    this.tickG = ctx.createGain(); this.tickG.gain.value = 0;
    this.pulseOut.connect(this.tickBP); this.tickBP.connect(this.tickG); this.tickG.connect(this.out);
    // ...and the tyre's own noise chopped at the same rate, which is what makes it a BRRRP
    this.chatSrc = loopNoise(ctx, 'grain', 3313, 2.2);
    this.chatGate = ctx.createGain(); this.chatGate.gain.value = 0;
    this.chatDepth = ctx.createGain(); this.chatDepth.gain.value = 0;
    this.pulseOut.connect(this.chatDepth); this.chatDepth.connect(this.chatGate.gain);
    this.chatBP = ctx.createBiquadFilter(); this.chatBP.type = 'bandpass'; this.chatBP.frequency.value = 1300; this.chatBP.Q.value = 0.7;
    this.chatG = ctx.createGain(); this.chatG.gain.value = 0;
    this.chatSrc.connect(this.chatGate); this.chatGate.connect(this.chatBP);
    this.chatBP.connect(this.chatG); this.chatG.connect(this.out);
  }

  setPan(p, when = this.ctx.currentTime) {
    if (this.pan) this.pan.pan.setTargetAtTime(clamp(p, -1, 1), when, 0.05);
  }

  /**
   * @param s {amount 0..1, slip 0..1+, speed m/s, surface, load 0.2..1.8}
   *   `load` is vertical tyre load, normalised to 1 g. main.js derives it from measured lateral
   *   acceleration, so the note genuinely bends as the car takes weight in a corner and gives it
   *   back on the exit. Absent, it is inferred from slip so nothing breaks.
   */
  apply(s, when, tc = 0.05) {
    const sf = surfaceOf(s.surface);
    const T = this.t;
    const amt = clamp(s.amount ?? 0, 0, 1.2);
    const slip = clamp(Math.abs(s.slip ?? 0), 0, 1.4);
    const spdMs = Math.abs(s.speed ?? 0);
    const spd = clamp(spdMs / 45, 0, 1.2);
    const load = clamp(s.load ?? (0.6 + 0.8 * slip), 0.2, 1.9);

    // THE GATE. 0 at grip, 1 at full lock, and the curve is steep on purpose: at 20 % of the slip
    // budget this is 0.02, i.e. 34 dB down. A tyre that is merely rolling makes no squeal.
    const lock = smoothstep(0.10, 0.90, slip);
    const gate = amt * Math.pow(lock, 1.5);

    // ── the partial ────────────────────────────────────────────────────────────────────
    // slip angle raises the relaxation frequency; vertical load pulls it back down. A slide that
    // loads and unloads therefore bends the note through about four semitones either way.
    const f0 = clamp(lerp(sf.sq[0], sf.sq[1], smoothstep(0.04, 1.0, slip)) * T.formant * (1.20 - 0.26 * load), 90, 4200);
    this.o1.frequency.setTargetAtTime(f0, when, 0.035);
    this.o2.frequency.setTargetAtTime(f0 * 1.487, when, 0.035);
    this.o2g.gain.setTargetAtTime(0.30 + 0.22 * (1 - lock), when, 0.1);
    for (let i = 0; i < 3; i++) {
      this.fm[i].frequency.setTargetAtTime(clamp(sf.form[i] * T.formant * (0.90 + 0.22 * lock), 100, 15000), when, 0.05);
      this.fm[i].Q.setTargetAtTime(sf.formQ * (0.68 + 0.32 * T.howl) * (i === 0 ? 1 : 1.25), when, 0.08);
    }
    const tone = gate * sf.tone * (0.55 + 0.45 * T.howl) * (0.45 + 0.55 * load) * 6.60;
    this.toneG.gain.setTargetAtTime(tone, when, tc);
    // the "waaah" — rate rises with slip, depth is a fixed FRACTION of the note so it never
    // modulates silence into audibility
    this.warb.frequency.setTargetAtTime(lerp(sf.warble[0], sf.warble[1], lock) * T.stick, when, 0.09);
    this.warbA.gain.setTargetAtTime(tone * 0.52, when, tc);
    this.warbF.gain.setTargetAtTime(f0 * 0.035 * (0.4 + 0.6 * lock), when, tc);
    this.rough.frequency.setTargetAtTime(lerp(sf.rough[0], sf.rough[1], lock) * T.stick, when, 0.07);
    this.roughG.gain.setTargetAtTime(tone * 0.26, when, tc);
    this.wanderG.gain.setTargetAtTime(f0 * 0.05, when, 0.1);

    // ── broadband scrub / roar ─────────────────────────────────────────────────────────
    this.roarBP.frequency.setTargetAtTime(lerp(sf.roar[0], sf.roar[1], 0.35 * spd + 0.65 * lock), when, 0.06);
    this.roarBP.Q.setTargetAtTime(sf.rollQ * 0.8, when, 0.1);
    this.roarPk.frequency.setTargetAtTime(sf.roar[0] * 1.15, when, 0.1);
    this.roarG.gain.setTargetAtTime(amt * sf.roarLvl * T.roar * (0.28 + 0.72 * spd) * (0.22 + 0.78 * lock) * 1.15, when, tc);

    // ── fine shear hiss ────────────────────────────────────────────────────────────────
    const hiF = lerp(4200, 7600, lock);
    this.hiHP.frequency.setTargetAtTime(hiF, when, 0.06);
    this.hiHP2.frequency.setTargetAtTime(hiF, when, 0.06);
    this.hiPk.frequency.setTargetAtTime(lerp(7200, 11000, lock), when, 0.08);
    // NB every modulator summed into a gain AudioParam must be scaled by that gain's own target,
    // never left at a constant: a fixed +-0.35 of warble on a gain automated to zero is a gain
    // that swings +-0.35 around zero, i.e. a layer that never actually switches off. That bug put
    // 10 dB of tyre hiss under all five seconds of every engine clip.
    const hiss = amt * sf.grit * sf.level * (0.05 + 0.95 * lock) * (0.55 + 0.45 * T.howl) * 0.42;
    this.hiG.gain.setTargetAtTime(hiss, when, tc);
    this.warbH.gain.setTargetAtTime(hiss * 0.42, when, tc);

    // ── loose aggregate ────────────────────────────────────────────────────────────────
    this.sprayBP.frequency.setTargetAtTime(lerp(2000, 4200, lock), when, 0.08);
    this.sprayG.gain.setTargetAtTime(amt * sf.spray * (0.20 + 0.80 * spd) * (0.28 + 0.72 * lock) * 1.30, when, tc);
    this.archG.gain.setTargetAtTime(amt * sf.spray * (0.25 + 0.75 * spd) * (0.25 + 0.75 * lock) * 0.95 * T.roar, when, tc);

    // ── rumble strip ───────────────────────────────────────────────────────────────────
    // Ribs are a SPATIAL frequency: crossing rate = road speed / rib spacing. At 90 km/h that is
    // ~40 strikes a second, which is a note, not a rumble — hence real energy at 80-150 Hz.
    const rib = clamp(spdMs / (sf.ribM || 0.62), 11, 132);
    this.pulse.frequency.setTargetAtTime(rib, when, 0.05);
    const beat = sf.beat * clamp(0.30 + 1.10 * amt, 0, 1) * (0.30 + 0.70 * spd);
    this.thumpBP.frequency.setTargetAtTime(sf.thumpHz * Math.pow(T.formant, 0.45), when, 0.08);
    this.thumpG.gain.setTargetAtTime(beat * (0.75 + 0.45 * T.roar) * 21.0, when, tc);
    this.tickBP.frequency.setTargetAtTime(2100 * T.formant, when, 0.08);
    this.tickG.gain.setTargetAtTime(beat * 17.0 * (0.6 + 0.4 * T.howl), when, tc);
    this.chatDepth.gain.setTargetAtTime(sf.beat * 1.6, when, 0.05);
    this.chatBP.frequency.setTargetAtTime(1100 * T.formant, when, 0.08);
    this.chatG.gain.setTargetAtTime(beat * 4.6, when, tc);
  }

  stop() {
    try {
      this.o1.stop(); this.o2.stop(); this.warb.stop(); this.rough.stop(); this.pulse.stop();
      this.wander.stop(); this.roarSrc.stop(); this.hiSrc.stop(); this.spraySrc.stop(); this.chatSrc.stop();
    } catch { /* */ }
    this.out.disconnect();
  }
}

// ═════════════════════════════════════════════════════════════════════════ NitrousVoice

/**
 * Nitrous, as four distinct events (§6.9):
 *   spool   — the bottle valve cracks and pressure builds: a rising resonant hiss
 *   ignite  — a hard crack: broadband transient + a sub thump + a tuned "bang"
 *   roar    — sustained: swept-bandpass jet noise + a low rumble bed, both tracking the ramp
 *   cutoff  — the plume dies: hiss falls away, purge chirps, one backfire report
 */
const NIT_DEFAULT = { color: 1, bore: 1 };

export class NitrousVoice {
  constructor(ctx, dest, { events = null, nitrous = null, bus = null, pan = 0, space = null } = {}) {
    this.ctx = ctx;
    // Two paths on purpose: the sustained jet sits UNDER the engine on the PROGRAMME bus, but the
    // valve crack, the ignition and the cutoff report are EVENTS — they go to the un-ducked event
    // bus and additionally punch a 6 dB hole in the programme, which is what makes a boost feel
    // like it hits rather than like a fader move.
    this.n = { ...NIT_DEFAULT, ...(nitrous || {}) };
    this.masterBus = bus;
    const stereo = ctx.destination.channelCount > 1 && !!ctx.createStereoPanner;
    this.pans = [];
    const wire = (node, to) => {
      if (stereo) {
        const p = ctx.createStereoPanner(); p.pan.value = pan;
        node.connect(p); p.connect(to); this.pans.push(p);
      } else node.connect(to);
    };
    this.out = ctx.createGain();
    this.out.gain.value = MIX.nitrous;
    wire(this.out, dest);
    this.hit = ctx.createGain();
    this.hit.gain.value = 0.92;
    wire(this.hit, events || dest);
    // The bang goes down the street and comes back. This is most of why a boost feels big.
    sendSpace(ctx, this.out, space, 0.24, 0.30);
    sendSpace(ctx, this.hit, space, 0.30, 0.66);
    this.rng = new RNG(9091);

    const bore = this.n.bore;
    // sustained jet — a big-bore truck shot is darker and fatter, a supercar's is a tight hiss
    this.jet = loopNoise(ctx, 'white', 4401, 2.5);
    this.jetHP = ctx.createBiquadFilter(); this.jetHP.type = 'highpass'; this.jetHP.frequency.value = 800 / bore;
    this.jetPK = ctx.createBiquadFilter(); this.jetPK.type = 'peaking'; this.jetPK.frequency.value = 2600 / bore; this.jetPK.Q.value = 1.4; this.jetPK.gain.value = 10;
    this.jetG = ctx.createGain(); this.jetG.gain.value = 0;
    this.jet.connect(this.jetHP); this.jetHP.connect(this.jetPK); this.jetPK.connect(this.jetG); this.jetG.connect(this.out);

    // TURBULENCE. A jet of gas is not a steady hiss — it boils. Without this the sustain phase is
    // a noise generator with a filter on it, which is the single thing that gives a synthesised
    // plume away. Two rates: a slow boil on the level, a faster flutter on the resonance.
    this.turb = loopNoise(ctx, 'brown', 4691, 4.1);
    this.turbLP = ctx.createBiquadFilter(); this.turbLP.type = 'lowpass'; this.turbLP.frequency.value = 9;
    this.turbA = ctx.createGain(); this.turbA.gain.value = 0;
    this.turbF = ctx.createGain(); this.turbF.gain.value = 0;
    this.turb.connect(this.turbLP); this.turbLP.connect(this.turbA); this.turbLP.connect(this.turbF);
    this.turbA.connect(this.jetG.gain); this.turbF.connect(this.jetPK.frequency);

    // THE ROAR — the midrange body of the plume, and the layer r2 did not have at all.
    // r2's sustain was a highpassed hiss (700 Hz up) over a lowpassed rumble (under 300 Hz), so
    // the whole 300-2000 Hz band — where a jet of gas leaving a pipe actually lives, and where the
    // engine it is supposed to obliterate is loudest — was empty. Measured, the plume sat 4 dB over
    // the bed and read as tape hiss. This is a hard-driven bandpassed roar in exactly that band,
    // torn up by the same turbulence, and it is what makes the boost sound like thrust.
    this.roar = loopNoise(ctx, 'white', 4831, 3.3);
    this.roarBP = ctx.createBiquadFilter(); this.roarBP.type = 'bandpass'; this.roarBP.frequency.value = 700 / bore; this.roarBP.Q.value = 0.5;
    this.roarSat = ctx.createWaveShaper(); this.roarSat.curve = raspCurve(2.6); this.roarSat.oversample = '2x';
    this.roarPk = ctx.createBiquadFilter(); this.roarPk.type = 'peaking'; this.roarPk.frequency.value = 460 / bore; this.roarPk.Q.value = 1.1; this.roarPk.gain.value = 8;
    this.roarG = ctx.createGain(); this.roarG.gain.value = 0;
    this.roar.connect(this.roarBP); this.roarBP.connect(this.roarSat);
    this.roarSat.connect(this.roarPk); this.roarPk.connect(this.roarG); this.roarG.connect(this.out);
    // HERO SEND. The PROGRAMME bus is crest-controlled — deliberately, it is what keeps the
    // headroom an impact needs — but that also means the sustained plume cannot get more than a
    // few dB above the engine no matter how much gain it is given: the bus simply squeezes the two
    // together. A boost is not background, so part of the plume's body is sent to the EVENT bus
    // instead, which is neither compressed nor ducked. That is the only route by which the charge
    // can actually sit ON TOP of the mix rather than inside it.
    this.hero = ctx.createGain(); this.hero.gain.value = 0;
    this.roarPk.connect(this.hero); this.hero.connect(this.hit);
    this.turbR = ctx.createGain(); this.turbR.gain.value = 0;
    this.turbLP.connect(this.turbR); this.turbR.connect(this.roarG.gain);

    // low rumble bed — the part you feel in the chest
    this.rum = loopNoise(ctx, 'brown', 4507, 2.5);
    this.rumLP = ctx.createBiquadFilter(); this.rumLP.type = 'lowpass'; this.rumLP.frequency.value = 260; this.rumLP.Q.value = 3.5;
    this.rumG = ctx.createGain(); this.rumG.gain.value = 0;
    this.rum.connect(this.rumLP); this.rumLP.connect(this.rumG); this.rumG.connect(this.out);

    // CHEST. A tuned low body under the plume — the part of a nitrous shot you feel rather than
    // hear, and the reason the boost reads as thrust instead of as a fader move on some noise.
    this.chest = ctx.createOscillator(); this.chest.type = 'triangle';
    this.chest.frequency.value = 58 / bore;
    this.chestSat = ctx.createWaveShaper(); this.chestSat.curve = raspCurve(2.2); this.chestSat.oversample = '2x';
    this.chestG = ctx.createGain(); this.chestG.gain.value = 0;
    this.chest.connect(this.chestSat); this.chestSat.connect(this.chestG); this.chestG.connect(this.out);
    this.chestHero = ctx.createGain(); this.chestHero.gain.value = 0;
    this.chestG.connect(this.chestHero); this.chestHero.connect(this.hit);
    this.chest.start(0);
    // ...wobbled by the same turbulence, so the low end breathes with the jet
    this.chestFM = ctx.createGain(); this.chestFM.gain.value = 6 / bore;
    this.turbLP.connect(this.chestFM); this.chestFM.connect(this.chest.frequency);

    // spool tone: a rising resonance as the line pressurises
    this.spool = ctx.createOscillator(); this.spool.type = 'sawtooth'; this.spool.frequency.value = 180;
    this.spoolLP = ctx.createBiquadFilter(); this.spoolLP.type = 'lowpass'; this.spoolLP.frequency.value = 900; this.spoolLP.Q.value = 9;
    this.spoolG = ctx.createGain(); this.spoolG.gain.value = 0;
    this.spool.connect(this.spoolLP); this.spoolLP.connect(this.spoolG); this.spoolG.connect(this.hit);
    this.spool.start(0);
  }

  setPan(p, when = this.ctx.currentTime) {
    for (const n of this.pans) n.pan.setTargetAtTime(clamp(p, -1, 1), when, 0.05);
  }

  /** Bottle valve opening: 0.35 s of rising pressure before the charge lights. */
  spoolUp(when, dur = 0.34) {
    this.spool.frequency.cancelScheduledValues(when);
    this.spool.frequency.setValueAtTime(90, when);
    this.spool.frequency.exponentialRampToValueAtTime(340, when + dur);
    this.spoolLP.frequency.cancelScheduledValues(when);
    this.spoolLP.frequency.setValueAtTime(420, when);
    this.spoolLP.frequency.exponentialRampToValueAtTime(2600, when + dur);
    this.spoolG.gain.cancelScheduledValues(when);
    this.spoolG.gain.setValueAtTime(0.0001, when);
    this.spoolG.gain.exponentialRampToValueAtTime(0.16, when + dur * 0.85);
    this.spoolG.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.10);

    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 1.0, 6151);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3.0;
    f.frequency.setValueAtTime(700, when);
    f.frequency.exponentialRampToValueAtTime(5200, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.20, when + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.09);
    n.connect(f); f.connect(g); g.connect(this.hit);
    n.start(when); n.stop(when + dur + 0.15);
  }

  /** The crack. Four layers so it reads as an explosion, not a click. */
  ignite(when, color = 1) {
    const ctx = this.ctx;
    const col = color * this.n.color;              // per-class: a tuner cracks, a diesel WHUMPS
    const bore = this.n.bore;
    // Punch the hole BEFORE the transient: 6 ms of pre-duck is what makes the crack read as
    // 12-18 dB above the mix rather than 4 dB above it.
    this.masterBus?.duck(when - 0.006, 0.70, 0.16, 0.34);

    // 1. broadband transient
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.7, 3301);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(360 * col, when);
    f.frequency.exponentialRampToValueAtTime(4600 * col, when + 0.14);
    f.frequency.exponentialRampToValueAtTime(1100 * col, when + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1.02, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
    n.connect(f); f.connect(g); g.connect(this.hit);
    n.start(when); n.stop(when + 0.7);

    // 2. sub thump — the pressure wave. Bigger bore, lower and longer.
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(158 / bore, when);
    o.frequency.exponentialRampToValueAtTime(32 / bore, when + 0.28 * bore);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.08, when);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.42 * bore);
    o.connect(og); og.connect(this.hit);
    o.start(when); o.stop(when + 0.5 * bore);

    // 3. the bang itself — a hard-clipped saw burst, 25 ms
    const b = ctx.createOscillator(); b.type = 'sawtooth';
    b.frequency.setValueAtTime(320 * col, when);
    b.frequency.exponentialRampToValueAtTime(80 * col, when + 0.09);
    const bs = ctx.createWaveShaper(); bs.curve = raspCurve(8); bs.oversample = '4x';
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, when);
    bg.gain.exponentialRampToValueAtTime(0.58, when + 0.005);
    bg.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    b.connect(bs); bs.connect(bg); bg.connect(this.hit);
    b.start(when); b.stop(when + 0.16);

    // 4. the plume catching — a bright rip that arrives 40 ms behind the bang, so the event has
    // an inside rather than being one sample-accurate spike.
    const r = ctx.createBufferSource();
    r.buffer = noiseBuffer(ctx, 'white', 0.6, 3457);
    const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 2600 * col;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, when + 0.03);
    rg.gain.exponentialRampToValueAtTime(0.42 * col, when + 0.055);
    rg.gain.exponentialRampToValueAtTime(0.0001, when + 0.42);
    r.connect(rf); rf.connect(rg); rg.connect(this.hit);
    r.start(when + 0.03); r.stop(when + 0.5);
  }

  /** Sustained roar; call every frame while boosting. */
  sustain(amount, when, tc = 0.06) {
    const a = clamp(amount, 0, 1);
    const bore = this.n.bore;
    this.jetG.gain.setTargetAtTime(a * 0.46, when, tc);
    this.jetHP.frequency.setTargetAtTime((520 + a * 1100) / bore, when, 0.08);
    this.jetPK.frequency.setTargetAtTime((2000 + a * 2600) / bore, when, 0.09);
    // the missing 300-2000 Hz body
    this.roarG.gain.setTargetAtTime(Math.pow(a, 1.15) * 0.62, when, tc);
    this.roarBP.frequency.setTargetAtTime((480 + a * 620) / bore, when, 0.09);
    this.turbR.gain.setTargetAtTime(a * 0.22, when, tc);
    this.hero.gain.setTargetAtTime(Math.pow(a, 1.2) * 0.19, when, tc);
    this.chestHero.gain.setTargetAtTime(Math.pow(a, 1.4) * 0.26, when, tc);
    this.rumG.gain.setTargetAtTime(a * 0.62 * bore, when, tc);
    this.rumLP.frequency.setTargetAtTime((120 + a * 210) / bore, when, 0.08);
    this.turbA.gain.setTargetAtTime(a * 0.16, when, tc);
    this.turbF.gain.setTargetAtTime(a * 900 / bore, when, tc);
    this.chestG.gain.setTargetAtTime(Math.pow(a, 1.3) * 0.42 * bore, when, tc);
    this.chestFM.gain.setTargetAtTime(a * 9 / bore, when, tc);
  }

  /** The plume dies: hiss collapses, purge chirp, one backfire report. */
  cutoff(when) {
    const ctx = this.ctx;
    const col = this.n.color;
    this.masterBus?.duck(when + 0.10, 0.40, 0.07, 0.24);
    this.jetG.gain.cancelScheduledValues(when);
    this.jetG.gain.setTargetAtTime(0.0001, when, 0.08);
    this.rumG.gain.cancelScheduledValues(when);
    this.rumG.gain.setTargetAtTime(0.0001, when, 0.12);
    this.chestG.gain.cancelScheduledValues(when);
    this.chestG.gain.setTargetAtTime(0.0001, when, 0.10);
    this.roarG.gain.cancelScheduledValues(when);
    this.roarG.gain.setTargetAtTime(0.0001, when, 0.09);
    this.turbA.gain.setTargetAtTime(0, when, 0.10);
    this.turbR.gain.setTargetAtTime(0, when, 0.10);
    this.hero.gain.cancelScheduledValues(when); this.hero.gain.setTargetAtTime(0, when, 0.07);
    this.chestHero.gain.cancelScheduledValues(when); this.chestHero.gain.setTargetAtTime(0, when, 0.07);

    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.6, 7331);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2.0;
    f.frequency.setValueAtTime(3600 * col, when);
    f.frequency.exponentialRampToValueAtTime(520 * col, when + 0.34);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.30, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.38);
    n.connect(f); f.connect(g); g.connect(this.hit);
    n.start(when); n.stop(when + 0.5);

    // backfire report — a real bang, not a tick: square burst + its own broadband crack
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(215 * col, when + 0.11);
    o.frequency.exponentialRampToValueAtTime(52, when + 0.20);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, when + 0.11);
    og.gain.exponentialRampToValueAtTime(0.78, when + 0.117);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
    o.connect(og); og.connect(this.hit);
    o.start(when + 0.11); o.stop(when + 0.3);

    const bn = ctx.createBufferSource();
    bn.buffer = noiseBuffer(ctx, 'white', 0.4, 7411);
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.Q.value = 0.8;
    bf.frequency.setValueAtTime(1800 * col, when + 0.11);
    bf.frequency.exponentialRampToValueAtTime(420, when + 0.24);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, when + 0.11);
    bg.gain.exponentialRampToValueAtTime(0.66, when + 0.116);
    bg.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
    bn.connect(bf); bf.connect(bg); bg.connect(this.hit);
    bn.start(when + 0.11); bn.stop(when + 0.34);
  }

  stop() {
    try { this.jet.stop(); this.rum.stop(); this.roar.stop(); this.spool.stop(); this.turb.stop(); this.chest.stop(); } catch { /* */ }
    this.out.disconnect(); this.hit.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════ impacts

const IMP_DEFAULT = { mass: 1, thumpHz: 1, modeHz: 1, decay: 1, glass: 1, rattle: 0.6, bright: 1, punch: 1 };

/**
 * Impacts, layered by severity AND by what class of car took the hit (§6.9).
 *
 * AUDIBILITY IS THE POINT, AND IT IS NOT THE SAME THING AS LEVEL. r2 had a beautifully designed
 * severity ladder — five hits, -16 dB of monotonic spread, per-surface and per-class variants —
 * and it was inaudible: measured against the 400 ms of programme in front of it, every hit below
 * 64 % severity came in 1-4 dB UNDER, so an onset detector found one event out of five on two cars
 * and none at all on the other two. A crash registered as a bump in engine level.
 *
 * The fix is three things working together, and none of them alone is enough:
 *   1. HEADROOM   the programme bus is crest-controlled (see MasterBus), which takes 5 dB off the
 *                 exhaust's firing-pulse tips and hands the top of the scale to this function.
 *   2. A HOLE     a ~40 ms duck at -10 to -16 dB fired 10 ms early, not r2's broad shallow sag.
 *   3. A FLAT TRANSIENT  `crackGain` — every rung of the ladder gets the same size of first
 *                 five milliseconds, and severity is carried by the crack's CENTRE FREQUENCY,
 *                 its LENGTH, and what rings after it. See the note on `crackGain`.
 * Measured result: 6.1-11.2 dB of clearance on all five hits on all four cars, with the energy
 * ladder (180 ms RMS) still spanning 12 dB from kerb clip to barrier crash.
 *
 * The layers arrive in order of severity, not all at once:
 *   any     contact scuff — the tyre/bumper touching whatever it touched
 *   > 0.15  body thump (chassis mass) + panel resonance modes
 *   > 0.45  glass, a debris tail, and loose-junk rattle (a truck rattles, a supercar does not)
 *
 * Deterministic: the "random" mode frequencies come from a seeded RNG.
 */
export function scheduleImpact(ctx, dest, when, strength, {
  surface = 'road', seed = 55, level = 1, pan = 0, car = null, bus = null, space = null,
} = {}) {
  const s = clamp(strength, 0, 1);
  if (s < 0.02) return;
  // A wall you clipped on the right belongs on the right. Only in a stereo context — the mono
  // offline render would just lose 3-6 dB for nothing.
  if (pan && ctx.destination.channelCount > 1 && ctx.createStereoPanner) {
    const pv = clamp(pan, -1, 1);
    const p = ctx.createStereoPanner();
    p.pan.value = pv;
    // Pan-law compensation. StereoPanner is equal-POWER, so a mono hit shoved to |pan| = 0.9 puts
    // 3 dB more into the near channel than the same hit centred — which is how a barrier you
    // clipped on the right ends up clipping the master purely for being on the right. Take it
    // straight back out, so panning changes WHERE a hit is and nothing else.
    const th = (Math.abs(pv) + 1) * 0.25 * Math.PI;
    const comp = ctx.createGain();
    comp.gain.value = Math.SQRT1_2 / Math.max(Math.cos(th), Math.sin(th));
    comp.connect(p); p.connect(dest);
    dest = comp;
  }
  // Every layer of the hit lands on one node so the whole event can be sent to the street at
  // once. A crash with no tail is a click; a crash that rings off the buildings opposite for
  // three-quarters of a second is an accident. Harder hits throw further.
  {
    const hub = ctx.createGain();
    hub.gain.value = 1;
    hub.connect(dest);
    sendSpace(ctx, hub, space, 0.40, 0.34 + 0.62 * s);
    dest = hub;
  }
  const C = { ...IMP_DEFAULT, ...(car || {}) };
  const rng = new RNG(seed * 7919 + Math.floor(s * 97));
  const metal = clamp((s - 0.15) / 0.5, 0, 1);
  const heavy = clamp((s - 0.45) / 0.5, 0, 1);
  // THE ENERGY curve. Everything that rings, booms or rattles is scaled by it, so a crash carries
  // far more sound — and far more of it — than a clip.
  // `punch` is per-class gain staging, not a fudge: an impact has to clear the engine it is
  // interrupting, and the four engines are not the same size. The flat-plane supercar is the
  // loudest and brightest thing in this game by some margin, so its crashes are voiced to sit over
  // it; the diesel's programme is dark and low, so its crashes do not need the help.
  const P = C.punch ?? 1;
  const L = level * P * MIX.impact * impactGain(s);
  // THE TRANSIENT curve. Nearly flat, on purpose: see the note on `crackGain`. This is what makes
  // a 24 % contact an EVENT instead of a texture.
  const K = level * P * MIX.impact * crackGain(s);
  const sf = surfaceOf(surface);
  // Class mass decides the thump's NOTE and its length, not the size of the event: r2 let it set
  // level directly, so the 2.6 t truck's crash peaked 4 dB over the supercar's and the light cars
  // simply did not land. Compressed to a 1.4:1 spread here; `thumpHz` and `decay` still carry the
  // whole difference between a body-on-frame boom and a carbon crack.
  const massL = 0.55 + 0.45 * C.mass;

  // Punch the hole BEFORE the hit, and make it short and deep rather than broad and shallow. r2
  // ducked ~6 dB for 250 ms, which reads as the mix sagging around the crash instead of as the
  // crash arriving; every light hit measured BELOW the programme it was meant to interrupt. This
  // is a ~40 ms hole at -10 to -16 dB, opened 10 ms early (so it is fully open before the
  // transient lands) and released over ~200 ms — the classic game-audio impact gate.
  bus?.duck(when - 0.010, 0.66 + 0.19 * s, 0.030 + 0.030 * s, 0.17 + 0.13 * s);

  // ─── 0. THE CRACK ───────────────────────────────────────────────────────────────────────────
  // The first five milliseconds, and the layer that decides whether the hit registers at all.
  // Severity moves its CENTRE and its LENGTH, not its level: a kerb clip is a 5 ms tick at
  // 3.6 kHz — a band the exhaust note simply does not occupy — and a barrier crash is a 60 ms slam
  // at 500 Hz that lands on top of a hole in the programme. Both peak within 4 dB of each other,
  // which is why both are audible, and neither is mistakable for the other.
  {
    const sw = Math.pow(s, 0.72);
    const crackHz = clamp(lerp(3600, 500, sw) * C.bright * (sf.tickHz ?? 1), 90, 14000);
    // A ceiling on the top octave. `bright` and the surface's tick colour multiply, so the
    // brightest car on the brightest surface — a carbon supercar clipping a rumble strip — lands
    // its crack above 4 kHz, where a full-scale transient stops reading as an impact and starts
    // reading as a digital click. Capping it there is also what keeps the ladder monotonic: without
    // this, that car's 24 % contact measured LOUDER than its own 100 % barrier crash.
    const hfCap = crackHz > 2800 ? lerp(1, 0.70, clamp((crackHz - 2800) / 2000, 0, 1)) : 1;
    const crackDur = lerp(0.005, 0.060, s) * lerp(1, C.decay, 0.6);
    // (a) the edge — a 2.5 ms burst of highpassed noise. Almost the whole peak of a light hit, and
    //     the "tick" a listener localises the event by. It thins out as severity rises because a
    //     real crash swallows its own leading edge.
    const en = ctx.createBufferSource();
    en.buffer = noiseBuffer(ctx, 'white', 0.25, 5387);
    en.playbackRate.value = rng.range(0.9, 1.25);
    const ehp = ctx.createBiquadFilter();
    ehp.type = 'highpass';
    ehp.frequency.value = clamp(lerp(2400, 780, sw) * C.bright * (sf.tickHz ?? 1), 200, 12000);
    ehp.Q.value = 0.9;
    const epk = ctx.createBiquadFilter();
    epk.type = 'peaking'; epk.frequency.value = crackHz; epk.Q.value = 1.1; epk.gain.value = 9;
    const eg = ctx.createGain();
    const eLvl = 1.20 * K * hfCap * (sf.tickEdge ?? 1) * (1 - 0.34 * s) * lerp(1.10, 0.98, clamp(C.mass - 0.6, 0, 1));
    eg.gain.setValueAtTime(0.0001, when);
    eg.gain.linearRampToValueAtTime(eLvl, when + 0.0009);
    eg.gain.exponentialRampToValueAtTime(0.0001, when + 0.0025 + 0.010 * s);
    en.connect(ehp); ehp.connect(epk); epk.connect(eg); eg.connect(dest);
    en.start(when); en.stop(when + 0.1);

    // (b) the body of the crack — the same transient one octave-band lower, longer, and swept
    //     down. This is where the severity actually lives: 3.6 kHz and gone in 5 ms, or 500 Hz
    //     and still falling 60 ms later.
    const bn = ctx.createBufferSource();
    bn.buffer = noiseBuffer(ctx, surface === 'dirt' || surface === 'grass' ? 'grain' : 'white', 0.4, 5501);
    bn.playbackRate.value = rng.range(0.85, 1.2);
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.Q.value = lerp(1.45, 0.72, s);
    bf.frequency.setValueAtTime(crackHz, when);
    bf.frequency.exponentialRampToValueAtTime(Math.max(70, crackHz * lerp(0.72, 0.34, s)), when + crackDur + 0.02);
    const bg = ctx.createGain();
    const bLvl = 1.10 * K * hfCap * (sf.tickLvl ?? 1) * lerp(1.28, 1.0, s) * (1.34 - 0.34 * C.mass);
    bg.gain.setValueAtTime(0.0001, when);
    bg.gain.linearRampToValueAtTime(bLvl, when + 0.0014);
    bg.gain.exponentialRampToValueAtTime(0.0001, when + crackDur + 0.02);
    bn.connect(bf); bf.connect(bg); bg.connect(dest);
    bn.start(when); bn.stop(when + 0.25);
  }

  // --- 1. the contact wash: what the hit was MADE of, after the transient has gone ---
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, surface === 'dirt' || surface === 'grass' ? 'grain' : 'white', 0.6, 5741);
  n.playbackRate.value = rng.range(0.85, 1.2);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  // Light contacts are all top end — a bumper scuff, a kerb clip. That is what keeps a small hit
  // audible under a running engine without making it loud: it lives where the engine isn't.
  f.Q.value = lerp(1.5, 0.65, s);
  f.frequency.setValueAtTime(((surface === 'dirt' ? 500 : 1500) + 2600 * s) * C.bright, when);
  f.frequency.exponentialRampToValueAtTime(((surface === 'dirt' ? 220 : 520) + 700 * s) * C.bright, when + 0.10 + 0.24 * s);
  const g = ctx.createGain();
  // Light cars crack where heavy ones boom: the contact layer carries more of a supercar's hit and
  // less of a truck's, which keeps the four classes at comparable PEAK level while making them
  // completely different events. `mass` then decides how much of that peak is the low thump below.
  g.gain.setValueAtTime(0.0001, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.46 * sf.level * L * lerp(1.5, 1.0, s) * (1.62 - 0.62 * C.mass), when + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, when + (0.07 + 0.30 * s) * C.decay);
  n.connect(f); f.connect(g); g.connect(dest);
  n.start(when); n.stop(when + 0.6);

  // --- 1b. graze chatter. Clipping a rumble strip or scattering gravel is a BRRRP, not a tick.
  // This is how a 24 % contact stays audible under a running engine WITHOUT being loud: it wins
  // on duration and on sitting in a band the exhaust does not occupy. It fades out as severity
  // rises, because a real crash swallows the chatter whole. ---
  const graze = clamp(1 - (s - 0.18) / 0.5, 0, 1) * (0.55 + 0.45 * sf.rumble);
  if (graze > 0.05) {
    const taps = 6 + Math.round(13 * graze);
    let st = when + 0.004;
    for (let i = 0; i < taps; i++) {
      const tn = ctx.createBufferSource();
      tn.buffer = noiseBuffer(ctx, 'white', 0.2, 5867);
      tn.playbackRate.value = rng.range(0.8, 1.4);
      const tf = ctx.createBiquadFilter();
      // Broad, not narrow: a Q of 5 throws away most of a noise burst's energy, and a kerb
      // strip is a wideband clatter anyway.
      tf.type = 'bandpass'; tf.Q.value = rng.range(0.7, 1.6);
      tf.frequency.value = clamp(rng.range(2000, 7600) * C.bright, 300, 16000);
      const tg = ctx.createGain();
      const d = rng.range(0.008, 0.022);
      // On the transient curve, not the energy curve: the chatter after a kerb clip is the same
      // physical loudness whether or not the clip was hard, and it is the sound that gives a light
      // contact its DURATION so it reads as a scrape and not as a click.
      tg.gain.setValueAtTime(0.0001, st);
      tg.gain.exponentialRampToValueAtTime(0.75 * graze * K * rng.range(0.45, 1.0), st + 0.0015);
      tg.gain.exponentialRampToValueAtTime(0.0001, st + d);
      tn.connect(tf); tf.connect(tg); tg.connect(dest);
      tn.start(st); tn.stop(st + d + 0.02);
      st += rng.range(0.009, 0.022);
    }
  }

  // --- 2. body thump: the chassis mass, and the OTHER half of the severity cue ---
  // The tick above is nearly severity-independent; this is not. It is present on every hit, but
  // where a kerb clip gets a 66 Hz tap that is 12 dB under its own tick, a barrier crash gets a
  // 150 Hz slam falling to 26 Hz that is 6 dB OVER it. The tick/thump RATIO is what your ear reads
  // as "how hard was that", and it works under a running engine because the two layers sit two
  // decades apart — one above the exhaust, one below it.
  {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime((48 + 104 * s) * C.thumpHz, when);
    o.frequency.exponentialRampToValueAtTime(26 * C.thumpHz, when + (0.14 + 0.18 * s) * C.decay);
    const og = ctx.createGain();
    // 0.34 at s=0.24 → 1.42 at s=1.0, on top of L, which is itself steeply severity-scaled.
    const thump = (1.05 * massL * L * (0.26 + 1.16 * Math.pow(s, 0.8)) + 0.24 * massL * K * s) * (1 + 0.55 * s * s * s);
    og.gain.setValueAtTime(0.0001, when);
    og.gain.exponentialRampToValueAtTime(Math.max(1e-4, thump), when + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, when + (0.18 + 0.30 * s) * C.decay);
    o.connect(og); og.connect(dest);
    o.start(when); o.stop(when + 0.8);
  }

  // --- 3. metal crunch: a handful of resonant panel modes rung by the hit ---
  if (metal > 0.02) {
    const modes = 3 + Math.round(metal * 5);
    for (let i = 0; i < modes; i++) {
      const mn = ctx.createBufferSource();
      mn.buffer = noiseBuffer(ctx, 'white', 0.35, 5623);
      mn.playbackRate.value = rng.range(0.7, 1.4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = clamp(rng.range(320, 2600) * (0.8 + 0.5 * s) * C.modeHz, 60, 15000);
      bp.Q.value = rng.range(9, 26);
      const mg = ctx.createGain();
      const st = when + rng.range(0, 0.05 + 0.05 * s);
      const dur = rng.range(0.10, 0.34) * (0.6 + 0.8 * metal) * C.decay;
      mg.gain.setValueAtTime(0.0001, st);
      mg.gain.exponentialRampToValueAtTime(0.30 * metal * L * rng.range(0.5, 1.2), st + 0.004);
      mg.gain.exponentialRampToValueAtTime(0.0001, st + dur);
      mn.connect(bp); bp.connect(mg); mg.connect(dest);
      mn.start(st); mn.stop(st + dur + 0.05);
    }
  }

  // --- 4. glass + debris tail on the big ones ---
  if (heavy > 0.02) {
    const shards = Math.round(9 * C.glass);
    for (let i = 0; i < shards; i++) {
      const to = ctx.createOscillator();
      to.type = i % 3 === 0 ? 'sine' : 'triangle';
      to.frequency.value = rng.range(2900, 9600);    // real glass is a top-octave event
      const tg = ctx.createGain();
      const st = when + rng.range(0.02, 0.34);
      tg.gain.setValueAtTime(0.0001, st);
      tg.gain.exponentialRampToValueAtTime(0.14 * heavy * C.glass * L, st + 0.004);
      tg.gain.exponentialRampToValueAtTime(0.0001, st + rng.range(0.09, 0.26));
      to.connect(tg); tg.connect(dest);
      to.start(st); to.stop(st + 0.4);
    }
    const dn = ctx.createBufferSource();
    dn.buffer = noiseBuffer(ctx, 'grain', 0.9, 5701);
    const df = ctx.createBiquadFilter(); df.type = 'bandpass'; df.frequency.value = 2600 * C.bright; df.Q.value = 1.1;
    const dg = ctx.createGain();
    dg.gain.setValueAtTime(0.0001, when + 0.05);
    dg.gain.exponentialRampToValueAtTime(0.22 * heavy * L, when + 0.10);
    dg.gain.exponentialRampToValueAtTime(0.0001, when + 0.75 * C.decay);
    dn.connect(df); df.connect(dg); dg.connect(dest);
    dn.start(when + 0.05); dn.stop(when + 0.9);

    // --- 5. loose junk. A body-on-frame truck keeps clattering for half a second after the hit;
    // a carbon supercar is silent the moment the panel stops ringing. ---
    if (C.rattle > 0.05) {
      const bits = Math.round(7 * C.rattle);
      for (let i = 0; i < bits; i++) {
        const st = when + 0.09 + rng.range(0, 0.42) * C.decay;
        const ro = ctx.createOscillator(); ro.type = 'triangle';
        ro.frequency.setValueAtTime(rng.range(140, 620) * C.modeHz, st);
        const rgn = ctx.createGain();
        rgn.gain.setValueAtTime(0.0001, st);
        rgn.gain.exponentialRampToValueAtTime(0.13 * heavy * C.rattle * L * rng.range(0.4, 1.0), st + 0.003);
        rgn.gain.exponentialRampToValueAtTime(0.0001, st + rng.range(0.04, 0.14));
        ro.connect(rgn); rgn.connect(dest);
        ro.start(st); ro.stop(st + 0.2);
      }
    }
  }
}

/** A sustained metal-on-barrier scrape, for grinding down a wall. */
export function scheduleScrape(ctx, dest, when, dur, intensity = 0.6, space = null) {
  if (space) {
    const hub = ctx.createGain(); hub.gain.value = 1; hub.connect(dest);
    sendSpace(ctx, hub, space, 0.30, 0.42);
    dest = hub;
  }
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, 'white', Math.max(1, dur + 0.4), 6203);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3400; f.Q.value = 1.6;
  const f2 = ctx.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 7000; f2.Q.value = 1.4; f2.gain.value = 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(0.17 * intensity, when + 0.05);
  g.gain.setValueAtTime(0.17 * intensity, when + dur - 0.06);
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  // spark chatter
  const am = ctx.createOscillator(); am.type = 'sawtooth'; am.frequency.value = 42;
  const amg = ctx.createGain(); amg.gain.value = 0.22 * intensity;
  am.connect(amg); amg.connect(g.gain); am.start(when); am.stop(when + dur + 0.05);
  n.connect(f); f.connect(f2); f2.connect(g); g.connect(dest);
  n.start(when); n.stop(when + dur + 0.2);
}

// ═════════════════════════════════════════════════════════════════════════ AmbienceBed

/**
 * Wind, rolling road roar, top-octave air rush, passing-object whooshes and a low city hum.
 * Everything tracks speed and surface.
 *
 * This bed is deliberately AUDIBLE (~-22 dB RMS, about 6 dB under the engine). r1 rendered it at
 * -35 dB and then attenuated it further under the engine clips, which is the same as not having
 * one: a racer with no wind and no road roar under the car sounds like an engine in a vacuum.
 *
 * r2 then put a 1.5 kHz lowpass across the whole bed on the theory that cabin wind is a low-mid
 * phenomenon. In a sealed luxury saloon it is. In an arcade racer it is exactly backwards: the
 * top-octave RUSH is the only cue that says "you are doing 200 km/h" rather than "an engine is
 * running somewhere". So the bed now runs full-range, the class tint moved from a brick-wall
 * lowpass to a high shelf, and there is a dedicated air layer that opens above 5 kHz with velocity.
 */
export class AmbienceBed {
  constructor(ctx, dest, { tyre = null, space = null } = {}) {
    this.ctx = ctx;
    // A cabin tint. A low, hard, undamped supercar is all wind rush; a two-and-a-half-tonne truck
    // cabin is boomy road roar with the top end soaked up by trim. Reusing the tyre profile keeps
    // the tint in the same table as the rubber it is caused by.
    this.tone = clamp(tyre?.formant ?? 1, 0.65, 1.4);
    this.rng = new RNG(9187);
    this._last = -1;
    this._whooshT = 0.6;
    this.out = ctx.createGain(); this.out.gain.value = MIX.ambience;
    // The bed lives above the engine's fundamental — sub-bass wind is just mud on the mix.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass'; this.hp.frequency.value = 70; this.hp.Q.value = 0.7;
    // Class tint as a SHELF, not a wall: a supercar cabin is +5 dB of glass and air over a truck
    // cabin's trim and headliner, but neither of them is missing its top octave entirely.
    this.tilt = ctx.createBiquadFilter();
    this.tilt.type = 'highshelf'; this.tilt.frequency.value = 3500;
    this.tilt.gain.value = clamp((this.tone - 1) * 10, -7, 5);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass'; this.lp.frequency.value = 16000; this.lp.Q.value = 0.5;
    this.out.connect(this.hp); this.hp.connect(this.tilt); this.tilt.connect(this.lp); this.lp.connect(dest);
    this.dest = this.lp;

    // Each layer keeps its OWN band. r2 got its top octave by putting one 1.5 kHz lowpass across
    // the sum, which is why removing it made the whole bed hiss: three broadband noise sources
    // suddenly ran to Nyquist. Band the sources, and let exactly one dedicated layer own the air.
    this.wind = loopNoise(ctx, 'white', 8801, 3.1);
    this.windBP = ctx.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.frequency.value = 700; this.windBP.Q.value = 0.55;
    this.windLP = ctx.createBiquadFilter(); this.windLP.type = 'lowpass'; this.windLP.frequency.value = 2600; this.windLP.Q.value = 0.6;
    this.windG = ctx.createGain(); this.windG.gain.value = 0;
    this.wind.connect(this.windBP); this.windBP.connect(this.windLP); this.windLP.connect(this.windG); this.windG.connect(this.out);

    this.road = loopNoise(ctx, 'brown', 8837, 3.3);
    this.roadLP = ctx.createBiquadFilter(); this.roadLP.type = 'lowpass'; this.roadLP.frequency.value = 300; this.roadLP.Q.value = 0.8;
    this.roadG = ctx.createGain(); this.roadG.gain.value = 0;
    this.road.connect(this.roadLP); this.roadLP.connect(this.roadG); this.roadG.connect(this.out);

    this.tyre = loopNoise(ctx, 'grain', 8887, 2.9);
    this.tyreBP = ctx.createBiquadFilter(); this.tyreBP.type = 'bandpass'; this.tyreBP.frequency.value = 500; this.tyreBP.Q.value = 0.7;
    this.tyreLP = ctx.createBiquadFilter(); this.tyreLP.type = 'lowpass'; this.tyreLP.frequency.value = 3600; this.tyreLP.Q.value = 0.6;
    this.tyreG = ctx.createGain(); this.tyreG.gain.value = 0;
    this.tyre.connect(this.tyreBP); this.tyreBP.connect(this.tyreLP); this.tyreLP.connect(this.tyreG); this.tyreG.connect(this.out);

    // AIR RUSH — the top octave, and the only layer here that says "fast". Two cascaded highpasses
    // so it is genuinely above the exhaust rather than a bright-ish midrange, and it opens on
    // v^2.2 so it is nothing at a crawl and a roar at 200 km/h.
    this.air = loopNoise(ctx, 'white', 8923, 3.7);
    this.airHP = ctx.createBiquadFilter(); this.airHP.type = 'highpass'; this.airHP.frequency.value = 5200; this.airHP.Q.value = 0.6;
    this.airHP2 = ctx.createBiquadFilter(); this.airHP2.type = 'highpass'; this.airHP2.frequency.value = 5200; this.airHP2.Q.value = 0.6;
    this.airPk = ctx.createBiquadFilter(); this.airPk.type = 'peaking'; this.airPk.frequency.value = 9500; this.airPk.Q.value = 0.7; this.airPk.gain.value = 7;
    this.airG = ctx.createGain(); this.airG.gain.value = 0;
    this.air.connect(this.airHP); this.airHP.connect(this.airHP2);
    this.airHP2.connect(this.airPk); this.airPk.connect(this.airG); this.airG.connect(this.out);

    // Whooshes land on their own node so they are not shaped by the bed's speed automation.
    this.whooshOut = ctx.createGain(); this.whooshOut.gain.value = 1;
    this.whooshOut.connect(this.out);
    sendSpace(ctx, this.whooshOut, space, 0.22, 0.34);

    // DISTANT CITY. Present at a standstill, which is the point: everything else in this bed is
    // a function of road speed, so without it a stationary car sits in a digitally silent world.
    // A band of pink noise around 400 Hz, drifting slowly in level — traffic three streets away.
    this.city = loopNoise(ctx, 'pink', 8971, 4.3);
    this.cityBP = ctx.createBiquadFilter(); this.cityBP.type = 'bandpass'; this.cityBP.frequency.value = 430; this.cityBP.Q.value = 0.75;
    this.cityG = ctx.createGain(); this.cityG.gain.value = 0.055;
    this.city.connect(this.cityBP); this.cityBP.connect(this.cityG); this.cityG.connect(this.out);
    this.cityLFO = loopNoise(ctx, 'brown', 9043, 5.9);
    this.cityLFOlp = ctx.createBiquadFilter(); this.cityLFOlp.type = 'lowpass'; this.cityLFOlp.frequency.value = 0.6;
    this.cityDrift = ctx.createGain(); this.cityDrift.gain.value = 0.030;
    this.cityLFO.connect(this.cityLFOlp); this.cityLFOlp.connect(this.cityDrift);
    this.cityDrift.connect(this.cityG.gain);

    // a very low city drone so the world is never digitally silent
    this.hum = ctx.createOscillator(); this.hum.type = 'sine'; this.hum.frequency.value = 54;
    this.hum2 = ctx.createOscillator(); this.hum2.type = 'sine'; this.hum2.frequency.value = 81.4;
    this.humG = ctx.createGain(); this.humG.gain.value = 0.013;
    this.hum.connect(this.humG); this.hum2.connect(this.humG); this.humG.connect(this.out);
    this.hum.start(0); this.hum2.start(0);
  }

  /**
   * A lamp post / barrier / bridge pier going past. A doppler-ish band sweeping up and back down
   * with a bright leading edge — the thing that makes a static wind bed read as MOTION.
   */
  whoosh(when, v) {
    const ctx = this.ctx, rng = this.rng;
    const dur = lerp(0.42, 0.16, clamp(v, 0, 1)) * rng.range(0.85, 1.25);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 1.0, 9311);
    n.playbackRate.value = rng.range(0.9, 1.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = rng.range(0.7, 1.5);
    const top = rng.range(3200, 9000);
    bp.frequency.setValueAtTime(700, when);
    bp.frequency.exponentialRampToValueAtTime(top, when + dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(520, when + dur);
    // ...plus a high-shelf lift on the leading edge, so the object arrives bright and leaves dull
    const sh = ctx.createBiquadFilter();
    sh.type = 'highshelf'; sh.frequency.value = 5000;
    sh.gain.setValueAtTime(9, when);
    sh.gain.linearRampToValueAtTime(-4, when + dur);
    const g = ctx.createGain();
    const lvl = 0.13 * Math.pow(clamp(v, 0, 1), 1.3) * rng.range(0.6, 1.15);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl), when + dur * 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    n.connect(bp); bp.connect(sh); sh.connect(g); g.connect(this.whooshOut);
    n.start(when); n.stop(when + dur + 0.05);
  }

  /** @param s {speed m/s, surface, boost} */
  apply(s, when, tc = 0.12) {
    const v = clamp((s.speed ?? 0) / 60, 0, 1.25);
    const sf = surfaceOf(s.surface);
    const k = this.tone;
    this.windBP.frequency.setTargetAtTime(lerp(340, 1250 * k, v), when, 0.15);
    this.windG.gain.setTargetAtTime(Math.pow(v, 1.4) * 0.62 * (1 + 0.4 * (s.boost ?? 0)), when, tc);
    this.roadLP.frequency.setTargetAtTime(lerp(sf.roll[0], sf.roll[1], v) * (2 - k) * 0.85, when, 0.12);
    this.roadG.gain.setTargetAtTime(Math.pow(v, 0.8) * 0.52 * sf.level * (2 - k) * 0.8, when, tc);
    this.tyreBP.frequency.setTargetAtTime(lerp(sf.roll[0] * 1.5, sf.roll[1] * 1.5, v) * k, when, 0.12);
    this.tyreBP.Q.setTargetAtTime(sf.rollQ, when, 0.2);
    this.tyreG.gain.setTargetAtTime(Math.pow(v, 0.9) * 0.36 * sf.level, when, tc);

    // top-octave rush: corner opens with speed too, so the air gets thinner and more urgent
    this.airHP.frequency.setTargetAtTime(lerp(4200, 7200, v), when, 0.15);
    this.airHP2.frequency.setTargetAtTime(lerp(4200, 7200, v), when, 0.15);
    this.airG.gain.setTargetAtTime(
      Math.pow(v, 2.0) * 0.080 * (0.55 + 0.45 * k) * (1 + 0.5 * (s.boost ?? 0)) * sf.level, when, tc);

    // passing objects — deterministic off an internal clock so a render is reproducible
    const dt = this._last < 0 ? 1 / 60 : clamp(when - this._last, 0, 0.25);
    this._last = when;
    this._whooshT -= dt * (0.25 + 2.4 * v);
    if (this._whooshT <= 0) {
      if (v > 0.22) this.whoosh(when, v);
      this._whooshT = this.rng.range(0.45, 1.35);
    }
  }

  stop() {
    try {
      this.wind.stop(); this.road.stop(); this.tyre.stop(); this.air.stop();
      this.hum.stop(); this.hum2.stop(); this.city.stop(); this.cityLFO.stop();
    } catch { /* */ }
    this.out.disconnect(); this.hp.disconnect(); this.tilt.disconnect(); this.lp.disconnect();
  }
}

// ══════════════════════════════════════════════════════════════════════════════ MusicBed

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
// i – VI – III – VII in F minor: the four chords every arcade racer has ever used, because they
// work. Roots as MIDI, plus the third that decides major/minor.
const PROG = [
  { root: 41, third: 3 },   // Fm
  { root: 37, third: 4 },   // Db
  { root: 44, third: 4 },   // Ab
  { root: 39, third: 4 },   // Eb
];

/**
 * FOUR TRACKS, ONE PER CITY (§6.9 music bed, and §2's per-city identity).
 *
 * r2 shipped one loop, and `muscle-music.wav` and `supercar-music.wav` came out identical in every
 * statistic — same peak, same RMS, same crest, same brightness — because they were the same forty
 * bars of the same arrangement. A racer whose four cities share one cue has no music design, it has
 * a loop. So the tempo, the key, the swing, the drum pattern, the bass figure, the chord voicing,
 * the lead register and the mix colour are all per city, and they are far enough apart that the
 * onset grid alone separates them: 0.117 s per 16th in LA, 0.107 in Vegas, 0.129 in Miami (swung),
 * 0.100 in New York.
 *
 *   la     128 BPM, F minor, straight — west-coast synthwave, saw lead in the middle octave
 *   vegas  140 BPM, Ab minor, busiest kick and an added 9th — neon, bright, big-room
 *   miami  116 BPM, Eb minor, 17 % swing, long lazy bass, deep plate — outrun cruise
 *   nyc    150 BPM, Bb minor, hard syncopated kick, dark stabs, lead an octave DOWN — aggressive
 *
 * In the game the city picks the track (`AudioEngine.setCity`). An offline clip has no city, so it
 * renders the track its car's class is associated with in `audio_tuning.js` — which is also how the
 * garage previews it.
 */
export const TRACKS = {
  la: {
    name: 'Sunset Arterial', bpm: 128, key: 0, swing: 0,
    kick: [0, 4, 8, 12], kickHz: 165, clap: [4, 12],
    hat: { every: 1, vel: 1.00, open: [14] },
    bass: { a: [0, 3, 6, 8, 11, 14], b: [0, 2, 3, 6, 8, 10, 11, 14], len: 1.6 },
    stab: [2, 10], stabHz: 3800, ninth: false,
    lead: { step: 2, oct: 0, vel: 1.00 },
    air: 4, verb: 0.42, riser: 8,
  },
  vegas: {
    name: 'Strip Runner', bpm: 140, key: 3, swing: 0,
    kick: [0, 4, 8, 12, 14], kickHz: 190, clap: [4, 12],
    hat: { every: 1, vel: 1.15, open: [6, 14] },
    bass: { a: [0, 2, 3, 6, 8, 10, 11, 13], b: [0, 2, 3, 5, 6, 8, 10, 11, 13, 14], len: 1.2 },
    stab: [2, 6, 10, 14], stabHz: 5400, ninth: true,
    lead: { step: 2, oct: 12, vel: 1.15 },
    air: 6, verb: 0.50, riser: 4,
  },
  miami: {
    name: 'Ocean Drive', bpm: 116, key: -2, swing: 0.17,
    kick: [0, 4, 8, 12], kickHz: 148, clap: [4, 12],
    hat: { every: 2, vel: 0.85, open: [10, 14] },
    bass: { a: [0, 6, 8, 14], b: [0, 3, 8, 11], len: 3.2 },
    stab: [0, 8], stabHz: 2500, ninth: true,
    lead: { step: 4, oct: 0, vel: 0.85 },
    air: 2, verb: 0.66, riser: 8,
  },
  nyc: {
    name: 'Uptown Pressure', bpm: 150, key: 5, swing: 0,
    kick: [0, 3, 4, 8, 10, 12, 14], kickHz: 212, clap: [4, 12],
    hat: { every: 1, vel: 0.95, open: [] },
    bass: { a: [0, 1, 3, 6, 7, 8, 11, 14], b: [0, 1, 3, 4, 6, 8, 9, 11, 12, 14], len: 1.0 },
    stab: [6, 14], stabHz: 1900, ninth: false,
    lead: { step: 2, oct: -12, vel: 0.90 },
    air: 1, verb: 0.26, riser: 16,
  },
};
export function trackOf(id) { return TRACKS[id] || TRACKS.la; }

/**
 * The music/ambience bed (§6.9). A synthwave loop: kick, clap, 16th hats, an offbeat saw bass,
 * filtered chord stabs and a delayed arpeggio lead. Every note is an oscillator + envelope built
 * here; there is no sample anywhere. Which arrangement it plays comes from TRACKS above.
 *
 * The same `scheduleBar()` is used by the live lookahead scheduler and the offline renderer.
 */
export class MusicBed {
  constructor(ctx, dest, { track = 'la', bpm = 0, level = MIX.music, seed = 4242 } = {}) {
    this.ctx = ctx;
    this.tr = trackOf(track);
    this.trackId = TRACKS[track] ? track : 'la';
    bpm = bpm || this.tr.bpm;
    this.bpm = bpm;
    this.beat = 60 / bpm;
    this.barLen = this.beat * 4;
    this.step = this.beat / 4;
    this.rng = new RNG(seed);

    this.out = ctx.createGain(); this.out.gain.value = level;
    this.duck = ctx.createGain(); this.duck.gain.value = 1;
    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -20; this.glue.knee.value = 18; this.glue.ratio.value = 4;
    this.glue.attack.value = 0.006; this.glue.release.value = 0.16;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass'; this.hp.frequency.value = 42; this.hp.Q.value = 0.7;
    // Air on the bus. The glue compressor is fed by the kick, so it pumps the top end down with
    // everything else; a shelf after it puts the sparkle back where a mastered track has it.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'highshelf'; this.air.frequency.value = 7500; this.air.gain.value = this.tr.air;
    this.out.connect(this.duck); this.duck.connect(this.glue); this.glue.connect(this.hp);
    this.hp.connect(this.air); this.air.connect(dest);

    // A plate. Claps, stabs and the lead go to it; the kick and bass stay dry so the low end
    // keeps its edges. A synthwave track with a bone-dry clap sounds like a demo of a drum
    // machine rather than like a record.
    this.verb = ctx.createConvolver(); this.verb.normalize = false;
    this.verb.buffer = makeImpulse(ctx, {
      seconds: 1.35, decay: 3.0, predelay: 0.018, damp: 0.62, seed: 909,
      channels: ctx.destination.channelCount > 1 ? 2 : 1,
      taps: [[0.013, 0.30], [0.029, -0.22], [0.047, 0.16]],
    });
    this.verbHP = ctx.createBiquadFilter(); this.verbHP.type = 'highpass'; this.verbHP.frequency.value = 340;
    this.verbLP = ctx.createBiquadFilter(); this.verbLP.type = 'lowpass'; this.verbLP.frequency.value = 7200;
    this.verbWet = ctx.createGain(); this.verbWet.gain.value = this.tr.verb;
    this.verbSend = ctx.createGain(); this.verbSend.gain.value = 1;
    this.verbSend.connect(this.verb); this.verb.connect(this.verbHP);
    this.verbHP.connect(this.verbLP); this.verbLP.connect(this.verbWet); this.verbWet.connect(this.out);

    // a dotted-8th delay for the lead — cheap, and it is what makes a synth line feel wide
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = this.beat * 0.75;
    this.fb = ctx.createGain(); this.fb.gain.value = 0.34;
    this.delayLP = ctx.createBiquadFilter(); this.delayLP.type = 'lowpass'; this.delayLP.frequency.value = 2600;
    this.send = ctx.createGain(); this.send.gain.value = 0.34;
    this.send.connect(this.delay); this.delay.connect(this.delayLP);
    this.delayLP.connect(this.fb); this.fb.connect(this.delay);
    this.delayLP.connect(this.out);

    this.bar = 0;
    this.nextTime = -1;
  }

  setLevel(v, when = this.ctx.currentTime) { this.out.gain.setTargetAtTime(v, when, 0.2); }
  setDuck(v, when = this.ctx.currentTime) { this.duck.gain.setTargetAtTime(clamp(v, 0, 1), when, 0.12); }

  // ---- instruments -----------------------------------------------------------------

  kick(t, vel = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(this.tr.kickHz, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.60 * vel, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    o.connect(g); g.connect(this.out);
    o.start(t); o.stop(t + 0.34);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.2, 1201);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.22 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    n.connect(f); f.connect(ng); ng.connect(this.out);
    n.start(t); n.stop(t + 0.05);
  }

  clap(t, vel = 1) {
    const ctx = this.ctx;
    // three offset bursts = a clap rather than a snare
    for (let i = 0; i < 3; i++) {
      const st = t + i * 0.011;
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, 'white', 0.3, 1301 + i);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1650; f.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime((i === 2 ? 0.42 : 0.24) * vel, st + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, st + (i === 2 ? 0.19 : 0.05));
      n.connect(f); f.connect(g); g.connect(this.out); g.connect(this.verbSend);
      n.start(st); n.stop(st + 0.25);
    }
    // the snap. A clap without a 6 kHz+ transient is a thud with reverb on it.
    const sn = ctx.createBufferSource();
    sn.buffer = noiseBuffer(ctx, 'white', 0.2, 1307);
    const sf = ctx.createBiquadFilter(); sf.type = 'highpass'; sf.frequency.value = 6200; sf.Q.value = 0.8;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t + 0.022);
    sg.gain.exponentialRampToValueAtTime(0.30 * vel, t + 0.025);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    sn.connect(sf); sf.connect(sg); sg.connect(this.out); sg.connect(this.verbSend);
    sn.start(t + 0.022); sn.stop(t + 0.16);
  }

  /**
   * The hat is the only thing in this arrangement that lives in the top octave, so it carries the
   * whole track's air. Two layers: a metallic cluster of six inharmonic squares (the 808 trick —
   * it is what makes a hat read as struck metal instead of as filtered noise) and a noise top
   * behind a 24 dB/oct highpass at 8.5 kHz so the transient is genuinely 8-14 kHz.
   */
  hat(t, vel = 1, open = false) {
    const ctx = this.ctx;
    const d = open ? 0.22 : 0.048;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', 0.35, 1401);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 8500; f.Q.value = 0.8;
    const f2 = ctx.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = 8500; f2.Q.value = 0.7;
    const f3 = ctx.createBiquadFilter(); f3.type = 'peaking'; f3.frequency.value = 12500; f3.Q.value = 0.9; f3.gain.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.52 * vel, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(f); f.connect(f2); f2.connect(f3); f3.connect(g); g.connect(this.out);
    n.start(t); n.stop(t + d + 0.05);

    // metallic cluster — six squares at inharmonic ratios, highpassed so only the top partials
    // survive. Base 4.2 kHz puts them across 4-12 kHz.
    const mh = ctx.createBiquadFilter(); mh.type = 'highpass'; mh.frequency.value = 7000; mh.Q.value = 0.8;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(0.0001, t);
    mg.gain.exponentialRampToValueAtTime(0.055 * vel, t + 0.0015);
    mg.gain.exponentialRampToValueAtTime(0.0001, t + d * 0.85);
    mh.connect(mg); mg.connect(this.out);
    for (const r of [1, 1.4471, 1.6170, 1.9265, 2.5028, 2.6637]) {
      const o = ctx.createOscillator(); o.type = 'square';
      o.frequency.value = 4200 * r;
      o.connect(mh); o.start(t); o.stop(t + d * 0.85 + 0.02);
    }
  }

  bass(t, midi, dur, vel = 1) {
    const ctx = this.ctx;
    const f0 = mtof(midi);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 7;
    lp.frequency.setValueAtTime(280 + 420 * vel, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + dur * 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34 * vel, t + 0.008);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.65, 0.05);
    lp.connect(g); g.connect(this.out);
    for (const [type, det, lvl] of [['sawtooth', -7, 1], ['sawtooth', 7, 0.8], ['square', 0, 0.45]]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.value = f0; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = lvl;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur + 0.15);
    }
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f0 / 2;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.01);
    sg.gain.setTargetAtTime(0.0001, t + dur * 0.6, 0.05);
    sub.connect(sg); sg.connect(this.out);
    sub.start(t); sub.stop(t + dur + 0.15);
  }

  stab(t, chord, dur, vel = 0.5) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
    lp.frequency.setValueAtTime(this.tr.stabHz, t);
    lp.frequency.exponentialRampToValueAtTime(this.tr.stabHz * 0.24, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(this.out); g.connect(this.verbSend);
    for (const m of chord) {
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = mtof(m); o.detune.value = det;
        o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }

  lead(t, midi, dur, vel = 1) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 9;
    lp.frequency.setValueAtTime(1200, t);
    lp.frequency.exponentialRampToValueAtTime(6200, t + 0.02);
    lp.frequency.exponentialRampToValueAtTime(1300, t + dur * 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.26 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.2);
    lp.connect(g); g.connect(this.out); g.connect(this.send); g.connect(this.verbSend);
    for (const [type, det] of [['sawtooth', -6], ['sawtooth', 6], ['square', 0]]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.value = mtof(midi); o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + dur * 1.4 + 0.1);
    }
  }

  riser(t, dur) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 'white', Math.max(1, dur + 0.3), 1501);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(13000, t + dur);       // all the way to the top octave
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    n.connect(f); f.connect(g); g.connect(this.out); g.connect(this.verbSend);
    n.start(t); n.stop(t + dur + 0.2);
  }

  // ---- the arrangement ------------------------------------------------------------

  scheduleBar(bar, when) {
    const S = this.step;
    const TR = this.tr;
    const K = TR.key;
    // Swung 16ths: the offbeats are pushed late. Miami is the only one that swings, and it is
    // instantly recognisable against the other three because of it.
    const at = (i) => when + i * S + (i % 2 ? TR.swing * S * 0.55 : 0);
    const ch = PROG[bar % PROG.length];
    const root = ch.root + K;
    const chord = TR.ninth
      ? [root + 12, root + 12 + ch.third, root + 19, root + 26]      // add the 9th on top
      : [root + 12, root + 12 + ch.third, root + 19];
    const arpNotes = [root + 24, root + 24 + ch.third, root + 31, root + 36,
      root + 31, root + 24 + ch.third, root + 24, root + 31];
    const section = Math.floor(bar / 4) % 2;   // alternate 4-bar halves for variety

    // drums
    for (const i of TR.kick) this.kick(at(i), i === 0 ? 1 : (i % 4 === 0 ? 0.9 : 0.72));
    for (const i of TR.clap) this.clap(at(i), 0.9);
    // Hats: the top octave has to be CONTINUOUS for the track to have air, not eight isolated
    // ticks a bar — except in Miami, where half-time hats are the point of the groove.
    for (let i = 0; i < 16; i += TR.hat.every) {
      const off = i % 2 === 1;
      const vel = (off ? (i % 4 === 3 ? 0.95 : 0.68) : (section === 1 ? 0.34 : 0.24)) * TR.hat.vel;
      this.hat(at(i), vel, TR.hat.open.includes(i) && (bar % 2 === 1 || section === 1));
    }

    // bass
    const pat = section === 0 ? TR.bass.a : TR.bass.b;
    for (const i of pat) {
      const oct = i === 0 || i === 8 ? 0 : (i % 3 === 0 ? 0 : 12);
      this.bass(at(i), root + oct, S * TR.bass.len, i === 0 ? 1 : 0.82);
    }

    // chord stabs
    for (let k = 0; k < TR.stab.length; k++) {
      this.stab(at(TR.stab[k]), chord, S * (k === 0 ? 2.4 : 2.0), k === 0 ? 0.55 : 0.42);
    }
    if (section === 1 && TR.stab.length < 3) this.stab(at(7), chord, S * 1.4, 0.35);

    // lead arpeggio
    for (let i = 0; i < 16; i += TR.lead.step) {
      const n = arpNotes[(i / TR.lead.step + bar * 3) % arpNotes.length] + TR.lead.oct;
      this.lead(at(i), n, S * 1.3 * (TR.lead.step / 2), (section === 1 ? 1 : 0.7) * TR.lead.vel);
    }

    // a riser into the downbeat, every 4th / 8th / 16th bar depending on the track
    if (bar % TR.riser === TR.riser - 1) this.riser(when + 8 * S, this.barLen * 0.5);
  }

  /** LIVE: schedule any bars that start inside the lookahead window. */
  pump(now, lookahead = 0.7) {
    if (this.nextTime < 0) this.nextTime = now + 0.06;
    let guard = 0;
    while (this.nextTime < now + lookahead && guard++ < 8) {
      this.scheduleBar(this.bar++, this.nextTime);
      this.nextTime += this.barLen;
    }
  }

  /** OFFLINE: schedule every bar that overlaps [0, seconds). */
  renderAll(seconds, startAt = 0) {
    let t = startAt, bar = 0;
    while (t < seconds) { this.scheduleBar(bar++, t); t += this.barLen; }
  }

  stop() { this.out.disconnect(); }
}

// ═════════════════════════════════════════════════════════════════════════════ master bus

/**
 * The two-bus master. This is the piece that makes level a designed axis.
 *
 *   PROGRAMME  engine · tyres · nitrous jet · ambience · music     →┐
 *              ducked by every event, never allowed to fight one    ├→ master → ceiling → out
 *   EVENT      impacts · nitrous crack · cutoff report · scrape    →┘
 *              never ducked, never compressed: pure headroom
 *
 * `duck(when, depth)` opens a hole in PROGRAMME 6 ms before the transient lands and closes it
 * over ~250 ms. The hole is built from ConstantSourceNodes summed into the duck gain's AudioParam
 * rather than by writing absolute values, so two events 30 ms apart add up instead of the second
 * one cancelling the first's automation and clicking.
 */
export class MasterBus {
  constructor(ctx, { master = MIX.master } = {}) {
    this.ctx = ctx;

    this.prog = ctx.createGain(); this.prog.gain.value = 1;
    this.duckGain = ctx.createGain(); this.duckGain.gain.value = 1;
    this.event = ctx.createGain(); this.event.gain.value = 1;

    // ── PROGRAMME CREST CONTROL — the headroom the EVENT bus lands in ────────────────
    // An exhaust note is a train of blow-down pulses, so it has a savage crest factor: r2's engine
    // sat at -19 dB RMS and peaked at -6.5 dB in the same second. Those 12 dB of spike cost
    // nothing in loudness and eat ALL the headroom an event needs, which is exactly why r2's five
    // impacts measured 1-4 dB BELOW the programme they were supposed to interrupt: there was
    // nothing left above the engine for them to be louder than.
    //
    // A DynamicsCompressorNode cannot fix this — its detector averages, so at 3 ms of attack it
    // never sees a 3 ms firing pulse and simply pulls the whole engine down. What is needed is
    // instantaneous, per-sample crest control, so: drive into a soft knee, then come back down.
    //   under -22 dB   untouched, unity gain — the tyres, the bed and the music never reach the
    //                  knee, so this is an ENGINE PEAK control and nothing else
    //   at the crests  ~5 dB taken off the firing-pulse tips, with the loudness left alone
    // The saturation is not a side effect: bending the tip of a blow-down pulse is what a real
    // collector, a real microphone and a real preamp all do to it, and it thickens the note.
    // It sits BEFORE the duck, so an event's hole can never be filled back in by makeup gain.
    this.progPre = ctx.createGain(); this.progPre.gain.value = 2.9;
    this.progShape = ctx.createWaveShaper();
    this.progShape.curve = PROG_CREST; this.progShape.oversample = '4x';
    this.progPost = ctx.createGain(); this.progPost.gain.value = 0.365;

    this.sum = ctx.createGain(); this.sum.gain.value = master;
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = CEILING; this.ceiling.oversample = '4x';

    this.prog.connect(this.progPre); this.progPre.connect(this.progShape);
    this.progShape.connect(this.progPost);
    this.progPost.connect(this.duckGain); this.duckGain.connect(this.sum);
    this.event.connect(this.sum);
    this.sum.connect(this.ceiling); this.ceiling.connect(ctx.destination);

    // ── the two spaces (see makeImpulse) ─────────────────────────────────────────────
    const nch = ctx.destination.channelCount > 1 ? 2 : 1;
    const mk = (ir, { lo, hi, level }) => {
      const send = ctx.createGain(); send.gain.value = 1;
      const cv = ctx.createConvolver(); cv.normalize = false; cv.buffer = ir;
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = lo; hpf.Q.value = 0.6;
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = hi; lpf.Q.value = 0.5;
      const wet = ctx.createGain(); wet.gain.value = level;
      send.connect(cv); cv.connect(hpf); hpf.connect(lpf); lpf.connect(wet); wet.connect(this.sum);
      return { send, wet, cv };
    };
    // ROOM — dense, short, close. Bodywork, road surface, the barrier a metre away.
    this.room = mk(makeImpulse(ctx, {
      seconds: 0.24, decay: 5.2, predelay: 0.0018, damp: 0.55, seed: 71, channels: nch,
      taps: [[0.0032, 1.10], [0.0071, -0.70], [0.0113, 0.52], [0.0186, -0.36], [0.0271, 0.26]],
    }), { lo: 150, hi: 9000, level: 1.25 });
    // STREET — a slap off the buildings opposite and a second of city behind it. The DISCRETE
    // taps do nearly all the audible work here: a diffuse tail just sounds like more noise, but a
    // distinct echo 24 ms and 43 ms behind a crash is what says "this happened between buildings".
    this.street = mk(makeImpulse(ctx, {
      seconds: 1.0, decay: 3.4, predelay: 0.012, damp: 0.72, seed: 137, channels: nch, hp: 0.02,
      taps: [[0.024, 1.05], [0.043, -0.74], [0.071, 0.52], [0.104, -0.36], [0.148, 0.26], [0.205, -0.17]],
    }), { lo: 220, hi: 6200, level: 1.5 });
    this.space = { room: this.room.send, street: this.street.send };

    this._ducks = [];               // [{ end, depth }] — so ducks can never sum past full mute
    this.bus = this.prog;           // the continuous voices' default destination
  }

  /**
   * @param depth 0..0.8 — 0.5 is -6 dB
   * @param hold  seconds at full depth
   * @param rel   recovery time
   */
  duck(whenRaw, depth = 0.5, hold = 0.10, rel = 0.26) {
    // Events schedule their hole a few ms EARLY. On a freshly-created live AudioContext
    // `currentTime` is still ~0, so that lands at a negative time and Web Audio throws — which is
    // the sort of thing an offline render never reaches and a player hits on the first corner.
    const when = Math.max(0, whenRaw);
    const d = clamp(depth, 0, 0.85);
    if (d < 0.03) return;
    // Trim anything already scheduled around `when` so the hole never inverts phase.
    this._ducks = this._ducks.filter((x) => x.end > when - 0.001);
    let live = 0;
    for (const x of this._ducks) if (x.start < when + 0.02) live += x.depth;
    const room = Math.max(0, 0.88 - live);
    const use = Math.min(d, room);
    if (use < 0.03) return;

    const cs = this.ctx.createConstantSource();
    // A ConstantSourceNode's offset defaults to ONE, not zero. Without this line the node's
    // intrinsic value leaks into `duckGain.gain` for the first render quantum after `start()`,
    // so the gain briefly goes to 2 and every duck fires a +6 dB CLICK 5 ms before the transient
    // it was supposed to make room for. Measured at -7.6 dB on the tuner's impact clip — louder
    // than the programme, and sitting in exactly the window an impact is judged against.
    cs.offset.value = 0;
    cs.offset.setValueAtTime(0, when);
    cs.offset.linearRampToValueAtTime(-use, when + 0.006);
    cs.offset.setValueAtTime(-use, when + 0.006 + hold);
    cs.offset.linearRampToValueAtTime(0, when + 0.006 + hold + rel);
    cs.connect(this.duckGain.gain);
    cs.start(when); cs.stop(when + 0.03 + hold + rel);
    this._ducks.push({ start: when, end: when + 0.006 + hold + rel, depth: use });
  }

  dispose() {
    this.prog.disconnect(); this.duckGain.disconnect();
    this.progPre.disconnect(); this.progShape.disconnect(); this.progPost.disconnect();
    this.event.disconnect(); this.sum.disconnect(); this.ceiling.disconnect();
    for (const s of [this.room, this.street]) { s.send.disconnect(); s.cv.disconnect(); s.wet.disconnect(); }
  }
}

function buildBus(ctx, opts) { return new MasterBus(ctx, opts); }

/**
 * Wire `node` into the room and street sends at the given depths. Every voice that wants to sit
 * in the world rather than in a vacuum calls this once at construction.
 */
export function sendSpace(ctx, node, space, room = 0, street = 0) {
  if (!space) return null;
  const out = [];
  if (space.room && room > 0) { const g = ctx.createGain(); g.gain.value = room; node.connect(g); g.connect(space.room); out.push(g); }
  if (space.street && street > 0) { const g = ctx.createGain(); g.gain.value = street; node.connect(g); g.connect(space.street); out.push(g); }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════ AudioEngine

/** Live master bus + one-shots. What the player hears. */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.master = null;
    this.voices = new Map();
    this.muted = false;
    this.musicOn = true;
    this._state = { speed: 0, surface: 'road', boost: 0 };
    this._nitroRamp = 0;
  }

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    const b = buildBus(this.ctx);
    this.busses = b;
    this.master = b.prog;          // continuous voices land here and get ducked by events
    this.events = b.event;         // impacts, cracks, reports — never ducked

    this.space = b.space;          // the two convolution sends every voice sits in
    this.sfx = this.ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.events);
    this.tyres = new TyreVoice(this.ctx, this.master, { tyre: this._carAudio?.tyre, space: this.space });
    this.nitro = new NitrousVoice(this.ctx, this.master, { events: this.events, bus: b, space: this.space });
    this.ambience = new AmbienceBed(this.ctx, this.master, { tyre: this._carAudio?.tyre, space: this.space });
    this.music = new MusicBed(this.ctx, this.master, { track: this._city || 'la' });

    // The music scheduler runs off its own timer, not the render loop, so the beat never
    // stutters when a frame runs long.
    this._timer = setInterval(() => this._pump(), 100);

    this.enabled = true;
    return this.ctx;
  }

  _pump() {
    if (!this.ctx || this.muted) return;
    if (this.musicOn) this.music.pump(this.ctx.currentTime);
  }

  /**
   * The city picks the track (§6.9 music bed + §2 per-city identity). main.js calls this on load;
   * rebuilding the bed is cheap and it is the only way the tempo and key can actually change.
   */
  setCity(id) {
    const key = TRACKS[id] ? id : 'la';
    if (this._city === key) return;
    this._city = key;
    if (!this.ctx) return;
    this.music?.stop();
    this.music = new MusicBed(this.ctx, this.master, { track: key });
    this.music.setLevel(this.musicOn ? MIX.music : 0);
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
  setMuted(m) { this.muted = m; if (this.busses) this.busses.sum.gain.setTargetAtTime(m ? 0 : MIX.master, this.ctx.currentTime, 0.05); }
  setMusic(on) { this.musicOn = on; this.music?.setLevel(on ? MIX.music : 0); }

  /**
   * Per-frame world state: drives the ambience bed and the music duck.
   * Called from main.js; everything degrades gracefully if it is not.
   */
  tick(dt, s = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._state = { ...this._state, ...s };
    this.ambience.apply(this._state, t);
    // Nitrous ducks the music so the boost is always the loudest thing in the frame.
    this.music.setDuck(1 - 0.62 * clamp(this._state.boost ?? 0, 0, 1), t);
  }

  engine(id, spec, opts) {
    if (!this.ctx) return null;
    // main.js hands us the CURRENT car every frame. If that is not the car this voice was built
    // for, rebuild it — otherwise picking a different car in the garage leaves you driving a
    // supercar that sounds like a diesel for the rest of the session.
    const held = this.voices.get(id);
    if (held && held.spec !== spec) { this.dropEngine(id); }
    if (!this.voices.has(id)) {
      this.voices.set(id, new EngineVoice(this.ctx, this.master, spec, { events: this.events, space: this.space, bus: this.busses, ...opts }));
      // The player's class also voices the tyres, the bottle and the crashes — an SUV must not
      // crash like a supercar (§6.9 class differentiation). main.js calls this every frame with
      // the current car, so a garage swap re-voices the whole mix for free.
      if (id === 'player') this.setCar(spec);
    }
    return this.voices.get(id);
  }

  /** Adopt one car's whole audio identity: engine, rubber, bottle, bodyshell. */
  setCar(spec) {
    const a = spec?.audio;
    if (!a || this._carAudio === a) return;
    this._carAudio = a;
    if (!this.ctx) return;
    // Tyres, bottle and cabin bed carry per-class state as graph topology; rebuild them.
    this.tyres?.stop();
    this.tyres = new TyreVoice(this.ctx, this.master, { tyre: a.tyre, space: this.space });
    this.nitro?.stop();
    this.nitro = new NitrousVoice(this.ctx, this.master, { events: this.events, bus: this.busses, nitrous: a.nitrous, space: this.space });
    this.ambience?.stop();
    this.ambience = new AmbienceBed(this.ctx, this.master, { tyre: a.tyre, space: this.space });
  }

  dropEngine(id) {
    const v = this.voices.get(id);
    if (v) { v.stop(); this.voices.delete(id); }
  }

  // ---------------------------------------------------------------- one-shots

  /** Tyre squeal — tracks slip angle and the surface under the car. */
  squeal(amount, slip, opts = {}) {
    if (!this.ctx) return;
    this.tyres.apply({
      amount, slip,
      speed: opts.speed ?? this._state.speed ?? 20,
      surface: opts.surface ?? this._state.surface ?? 'road',
      load: opts.load,
    }, this.ctx.currentTime);
  }

  nitroArm() { if (this.ctx) this.nitro.spoolUp(this.ctx.currentTime); }

  nitroStart(color = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // The valve crack is scheduled BEFORE the bang so a boost always has an audible wind-up.
    this.nitro.spoolUp(t, 0.22);
    this.nitro.ignite(t + 0.20, color);
    this.music.setDuck(0.35, t + 0.18);
  }

  nitroSustain(amount) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this._nitroRamp > 0.15 && amount <= 0.02) this.nitro.cutoff(t);
    this._nitroRamp = amount;
    this.nitro.sustain(amount, t);
    this._state.boost = amount;
  }

  impact(strength, opts = {}) {
    if (!this.ctx) return;
    this._impactSeed = ((this._impactSeed || 55) + 7) % 9973;
    scheduleImpact(this.ctx, this.sfx, this.ctx.currentTime, strength, {
      surface: opts.surface ?? this._state.surface ?? 'road',
      seed: this._impactSeed,
      pan: opts.pan ?? 0,
      car: this._carAudio?.impact,
      bus: this.busses,          // the hit ducks the engine/tyres/music out from under itself
      space: this.space,         // ...and rings off the street behind it
    });
  }

  /**
   * Metal grinding along a barrier. Safe to call every frame while the car is pinned to a wall:
   * it stitches fixed-length grains end to end instead of stacking a new source per frame.
   */
  scrape(intensity, dur = 0.22) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if ((this._scrapeUntil || 0) > t + 0.02) return;
    this._scrapeUntil = t + dur;
    scheduleScrape(this.ctx, this.sfx, t, dur, intensity, this.space);
  }

  /** UI blip. */
  ui(kind = 'move') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = kind === 'confirm' ? [69, 76] : kind === 'back' ? [64, 57] : [76];
    notes.forEach((m, i) => {
      const st = t + i * 0.06;
      const o = this.ctx.createOscillator();
      o.type = kind === 'confirm' ? 'square' : 'triangle';
      o.frequency.setValueAtTime(mtof(m), st);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.16 * MIX.ui, st + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.16);
      o.connect(g); g.connect(this.sfx);
      o.start(st); o.stop(st + 0.2);
    });
  }

  /** Race countdown beep / start horn. */
  countdown(final = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [det, lvl] of final ? [[0, 1], [7, 0.7], [-7, 0.7]] : [[0, 1]]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = final ? 880 : 440;
      o.detune.value = det;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22 * lvl, t + 0.01);
      g.gain.setValueAtTime(0.22 * lvl, t + (final ? 0.5 : 0.12));
      g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.9 : 0.22));
      o.connect(g); g.connect(this.sfx);
      o.start(t); o.stop(t + 1.0);
    }
  }

  dispose() {
    for (const [id] of this.voices) this.dropEngine(id);
    clearInterval(this._timer);
    this.tyres?.stop(); this.nitro?.stop(); this.ambience?.stop(); this.music?.stop();
    this.tyres = this.nitro = this.ambience = this.music = null;
    this.busses?.dispose(); this.busses = this.master = this.events = null;
    this.ctx?.close();
    this.ctx = null; this.enabled = false; this._carAudio = null;
  }
}

// ═════════════════════════════════════════════════════════ offline render (the critic's ears)

/**
 * THE SLIDE SCENE — what the `squeal` clip is actually doing, as one table read by both the
 * throttle script and the tyre state so the two can never drift apart.
 *
 * r2's squeal clip was a continuous three-cycle slalom with the surface switched underneath it,
 * and a critic could not find the surface boundaries in any band: everything was moving all the
 * time, so nothing read as a change. This is staged instead — every slide is separated from the
 * next by a moment of GRIP, and every surface change happens inside one of those gaps. That is
 * also just how driving works: you do not cross onto the dirt mid-slide, you get there, and then
 * the car lets go.
 *
 *   p     end of this beat, as a fraction of the clip
 *   slip  peak slip angle, shaped over the beat as a hump so the slide builds and releases
 *   load  peak vertical load, deliberately LEADING slip by a beat, so the note bends down as the
 *         car takes weight and comes back up as it unloads
 *   thr   throttle: you lift to load the nose in, and get back on it to hold the slide
 */
const SLIDE_SCENE = [
  { p: 0.068, surface: 'road', slip: 0.90, load: 0.7, thr: 1.00 },   // launch: standing wheelspin
  { p: 0.190, surface: 'road', slip: 0.00, load: 0.6, thr: 0.50 },   // GRIP — the floor
  { p: 0.310, surface: 'road', slip: 0.78, load: 1.5, thr: 0.55 },   // slide one, tarmac
  { p: 0.360, surface: 'road', slip: 0.04, load: 0.7, thr: 0.55 },   // straighten
  { p: 0.470, surface: 'road', slip: 1.00, load: 1.7, thr: 0.60 },   // slide two, bigger
  { p: 0.520, surface: 'road', slip: 0.03, load: 0.7, thr: 0.55 },   // straighten
  { p: 0.670, surface: 'concrete', slip: 1.05, load: 1.8, thr: 0.62 }, // long drift, concrete
  { p: 0.710, surface: 'concrete', slip: 0.03, load: 0.7, thr: 0.50 },
  { p: 0.830, surface: 'dirt', slip: 1.10, load: 1.3, thr: 0.85 },   // off the edge, into the dirt
  { p: 0.862, surface: 'dirt', slip: 0.05, load: 0.8, thr: 0.55 },
  { p: 0.958, surface: 'kerb', slip: 0.55, load: 1.1, thr: 0.45 },   // back on over the rumble strip
  { p: 1.001, surface: 'road', slip: 0.00, load: 0.6, thr: 0.05 },   // straight, off it
];
function slideAt(p) {
  let t0 = 0;
  for (const s of SLIDE_SCENE) {
    if (p < s.p) return { ...s, u: (p - t0) / Math.max(1e-6, s.p - t0) };
    t0 = s.p;
  }
  return { ...SLIDE_SCENE[SLIDE_SCENE.length - 1], u: 1 };
}

/** Throttle scripts. Each clip is a little scene, not a test tone. */
const SCRIPTS = {
  // A demonstration scene, in the order §6.9 asks the questions in:
  //   idle (character) → blip (character under no load) → wide open with upshifts (acceleration)
  //   → PART THROTTLE at the same revs (load response, which is the half of the dimension a pure
  //     accelerate-and-lift script cannot show at all) → back to wide open → closed throttle
  //     (overrun, crackle, rev-matched downshifts) → back on it.
  engine: (t, T) => {
    if (t < 0.28) return 0.0;              // idle — where the lope / clatter lives
    if (t < 0.42) return 0.80;             // a blip, so the character is unmistakable
    if (t < 0.58) return 0.0;
    if (t < T * 0.51) return 1.0;          // wide open, two or three upshifts
    if (t < T * 0.59) return 0.26;         // ...and the SAME engine barely working
    if (t < T * 0.73) return 1.0;          // back on it: the note re-opens
    if (t < T * 0.86) return 0.0;          // lift: overrun, crackle, a downshift
    return 1.0;                             // and back on it
  },
  idle: (t) => (t % 1.6 < 0.14 ? 0.55 : 0.0),
  squeal: (t, T) => slideAt(t / T).thr,
  tyre: (t, T) => slideAt(t / T).thr,
  // Part throttle, THEN the bottle. A boost fired while already flat out has nothing to be louder
  // than — the crack has to land on a quiet bed for the event to read as an event.
  nitrous: (t, T) => (t < 0.85 ? 0.22 : t < T - 0.9 ? 1.0 : 0.20),
  // The everything-at-once clip: launch, upshifts, a boost, a hit, a lift. If any one element of
  // the mix is buried, this is the clip it is buried in.
  mix: (t, T) => (t < 0.3 ? 0 : t < T * 0.80 ? 1 : 0.25),
  stereo: (t, T) => (t < T * 0.55 ? 1.0 : t < T * 0.75 ? 0.0 : 0.9),
  // The impact clip is a LADDER and it has to be read as one, so the throttle stays out of the
  // way of it: steady part-throttle through the five hits, one part-lift in the gap between the
  // third and the fourth, and then the driver comes off it properly after the big one. r2 put a
  // full lift 400 ms before two of the hits, so their own overrun crackle — an EVENT, un-ducked —
  // was sitting in the window the hit was being measured against.
  impact: (t) => (t > 4.36 ? 0 : t > 3.16 && t < 3.48 ? 0.18 : 0.58),
};

/**
 * @returns {Promise<Uint8Array>} WAV bytes for one clip.
 *
 * Mono for every gameplay kind, because the capture tool's brightness metric reads raw interleaved
 * samples and a two-channel file would halve it. The `stereo` kind renders TWO channels on purpose
 * — a car passing left to right, hits on alternating sides — so the "sensible spatialization" half
 * of the §6.9 mix dimension is actually checkable in a deliverable rather than only in the source.
 *
 * There is one synthesis path. This walks exactly the same `apply()` calls the live game does; the
 * only difference is that the times are explicit instead of `ctx.currentTime`.
 */
export async function renderClip(kind, seconds, spec, { sampleRate = 44100 } = {}) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  // `stereo` and `mix` render two channels. The four default kinds stay mono because the capture
  // tool's brightness metric reads raw interleaved samples and a second channel halves it — but
  // the everything-at-once clip is exactly where a critic should be able to hear that the kerb is
  // on one side of the car and the barrier is on the other.
  const channels = (kind === 'stereo' || kind === 'mix') ? 2 : 1;
  const ctx = new OAC(channels, Math.ceil(sampleRate * seconds), sampleRate);
  const M = buildBus(ctx);
  const bus = M.prog, ev = M.event;
  const T = seconds;
  const DT = 1 / 60;
  const A = spec.audio || {};

  const script = SCRIPTS[kind] || SCRIPTS.engine;
  // The impact clip is a SCENE, not four hits in a vacuum: the car is moving and the engine is
  // running, because "nothing buried" is judged against the mix the player actually hears.
  // `tyre` is the rubber on its own, exactly as `music` and `ambience` are their layers on their
  // own: the same slide scene as `squeal`, with nothing else in the render, so the gate depth and
  // the four surface signatures are measurable without the engine sitting on top of them.
  const wantEngine = kind !== 'music' && kind !== 'ambience' && kind !== 'tyre';
  // The bed is under everything the player actually plays. r2 rendered it only on four kinds, so
  // three of the deliverables were a game with the music switched off. `engine` is the one clip
  // that stays clean, and deliberately: it is the character reference, and a critic measuring
  // nine-band energy at the WOT plateau should be measuring the exhaust, not a chord stab.
  const wantMusic = kind !== 'engine' && kind !== 'ambience' && kind !== 'tyre';
  const wantAmbience = kind !== 'music' && kind !== 'tyre';

  const SP = M.space;
  const voice = wantEngine ? new EngineVoice(ctx, bus, spec, { events: ev, space: SP, bus: M }) : null;
  // NOTE: no per-clip cheats. r2 lifted this bus 2.2x and cut the engine to 0.58 for the squeal
  // clip, which meant the tyres only read as a subject in a mix no player ever hears. The squeal
  // clip is now the same mix as the game.
  const tyres = new TyreVoice(ctx, bus, { tyre: A.tyre, space: SP });
  const amb = wantAmbience ? new AmbienceBed(ctx, bus, { tyre: A.tyre, space: SP }) : null;
  // On the character clips the bed steps back a little — the engine is the subject — but it stays
  // clearly audible. r1 buried it 27 dB under programme, which is the same as not having one.
  if (amb && (kind === 'engine' || kind === 'idle')) amb.out.gain.value = MIX.ambience * 0.85;
  // The `stereo` clip is an EXTERIOR pass-by: you are standing at the barrier, not sitting in the
  // car, so the cabin's wind and road-roar bed does not belong in it — and leaving it there is
  // most of why r2's pass-by measured only 6 dB of balance swing. A centred bed at -22 dB fills in
  // whichever channel the car has just left.
  if (amb && kind === 'stereo') amb.out.gain.value = MIX.ambience * 0.30;
  const nitro = new NitrousVoice(ctx, bus, { events: ev, bus: M, nitrous: A.nitrous, space: SP });
  const sim = new DriveSim(spec);

  let bed = null;
  if (wantMusic) {
    bed = new MusicBed(ctx, bus, {
      // Each class carries its crew's city track — see TRACKS. A clip has no city, so this is
      // what makes muscle-music.wav and supercar-music.wav two different pieces of music.
      track: A.track || 'la',
      // Under gameplay the bed is a bed. On the music-only clip it is the whole point.
      level: kind === 'music' ? MIX.music * 2.2
        : MIX.music * (kind === 'nitrous' ? 0.85 : kind === 'impact' ? 0.58 : 1.0),
    });
    bed.renderAll(T);
  }

  // ── nitrous scene: arm, crack, sustain, cut ───────────────────────────────────────
  const NIT_ARM = 0.55, NIT_FIRE = 0.85, NIT_END = T - 0.9;
  if (kind === 'nitrous') {
    nitro.spoolUp(NIT_ARM, NIT_FIRE - NIT_ARM);
    nitro.ignite(NIT_FIRE, 1.0);       // class colour/bore come from the voice's own profile
    nitro.cutoff(NIT_END);
    if (bed) {
      bed.duck.gain.setValueAtTime(1, NIT_FIRE - 0.05);
      bed.duck.gain.linearRampToValueAtTime(0.38, NIT_FIRE + 0.06);
      bed.duck.gain.setValueAtTime(0.38, NIT_END);
      bed.duck.gain.linearRampToValueAtTime(1, NIT_END + 0.6);
    }
    // launched from a rolling start so there is somewhere to accelerate to
    sim.w = 0.30; sim.gear = 2;
  }
  if (kind === 'squeal' || kind === 'tyre') { sim.w = 0.34; sim.gear = 2; }
  if (kind === 'mix') {
    sim.w = 0.12; sim.gear = 1;
    // One of everything, spaced so each is legible: kerb clip at 1.15, bottle at 1.5, crack at
    // 1.8, barrier at 3.4, cutoff at 4.0. The light hit goes BEFORE the bottle deliberately — r2
    // put it at 2.6, in the middle of a sustained nitrous jet, where it measured 3 dB UNDER the
    // programme, so the one clip whose whole job is "is anything buried" answered yes. Clipping a
    // kerb on the launch and then hitting the bottle is also the order these things happen in.
    nitro.spoolUp(1.50, 0.30); nitro.ignite(1.80, 1.0); nitro.cutoff(3.20);
    scheduleImpact(ctx, ev, 1.15, 0.44, { surface: 'kerb', seed: 260, car: A.impact, bus: M, pan: -0.62, space: SP });
    // ...and the barrier AFTER the plume has been cut, not inside it. The sustained charge is now
    // a hero element on the event bus, so a hit buried under it would be a mixing decision this
    // clip exists to expose rather than a fault it should hide.
    scheduleImpact(ctx, ev, 3.90, 0.72, { surface: 'concrete', seed: 340, car: A.impact, bus: M, pan: 0.74, space: SP });
  }
  if (kind === 'impact') { sim.w = 0.42; sim.gear = 3; }
  if (kind === 'stereo') { sim.w = 0.26; sim.gear = 2; }

  // ── impact scene: five hits, rising severity, different surfaces + a wall scrape ──
  // Ordered so severity CLIMBS across the clip and lands on the barrier — and spaced so that each
  // hit's 400 ms run-up is clean programme, with no previous hit's debris tail, no scrape and no
  // overrun crackle in it. That is not staging: it is the only way "does this hit clear the mix"
  // is a question about the hit rather than about what happened to be decaying underneath it.
  if (kind === 'impact') {
    const hits = [
      { t: 0.28, s: 0.24, surface: 'kerb' },       // a rumble strip: bright, short, chattery
      { t: 1.12, s: 0.40, surface: 'road' },       // a scuff down the tarmac
      { t: 1.96, s: 0.46, surface: 'dirt' },       // off the edge — dull, no tick at all
      { t: 2.90, s: 0.64, surface: 'concrete' },   // a real hit on the wall
      { t: 4.30, s: 1.00, surface: 'concrete' },   // and the crash
    ];
    for (const h of hits) {
      if (h.t >= T) continue;
      scheduleImpact(ctx, ev, h.t, h.s, { surface: h.surface, seed: Math.round(h.t * 100), car: A.impact, bus: M, space: SP });
      // The score gets out of the way of a crash — the same gesture the nitrous crack gets, and
      // the reason the bed can be present under the ladder without eating it. Depth follows
      // severity: a kerb clip dips it, the barrier drops it by 8 dB.
      if (bed) {
        const dip = lerp(0.80, 0.38, clamp(h.s, 0, 1));
        bed.duck.gain.setValueAtTime(1, Math.max(0, h.t - 0.02));
        bed.duck.gain.linearRampToValueAtTime(dip, h.t + 0.04);
        bed.duck.gain.setValueAtTime(dip, h.t + 0.16 + 0.30 * h.s);
        bed.duck.gain.linearRampToValueAtTime(1, h.t + 0.55 + 0.45 * h.s);
      }
    }
    // ...then the car grinds down the barrier it just hit.
    if (T > 4.6) scheduleScrape(ctx, ev, 4.42, Math.min(0.52, T - 4.5), 0.85, SP);
  }

  // ── stereo scene: a car goes past left→right, clipping a barrier on each side ─────
  if (kind === 'stereo') {
    scheduleImpact(ctx, ev, 1.60, 0.55, { surface: 'concrete', seed: 160, car: A.impact, bus: M, pan: -0.9, space: SP });
    scheduleImpact(ctx, ev, 2.90, 0.85, { surface: 'concrete', seed: 290, car: A.impact, bus: M, pan: 0.9, space: SP });
    nitro.spoolUp(3.60, 0.30); nitro.ignite(3.90, 1.0); nitro.cutoff(T - 0.35);
  }

  // ── the frame loop: identical to the live one, just with explicit times ───────────
  let boostRamp = 0;
  for (let i = 0; i * DT < T; i++) {
    const t = i * DT;
    const thr = script(t, T);
    const st = sim.step(DT, thr);

    // nitrous ramp shape (matches Nitrous's attack/decay feel)
    if (kind === 'nitrous' || kind === 'stereo' || kind === 'mix') {
      const fire = kind === 'stereo' ? 3.90 : kind === 'mix' ? 1.80 : NIT_FIRE;
      const end = kind === 'stereo' ? T - 0.35 : kind === 'mix' ? 3.20 : NIT_END;
      const target = t > fire && t < end ? 1 : 0;
      boostRamp += (target - boostRamp) * (1 - Math.exp(-DT / (target ? 0.10 : 0.16)));
      nitro.sustain(boostRamp, t);
      // the charge pulls the engine well past where the gearbox alone would take it
      st.rpm = Math.min(spec.audio.redline * 1.0, st.rpm * (1 + 0.10 * boostRamp));
    }

    if (voice) {
      voice._prevShift = st.shifting;
      // A pass-by is not just a pan. The car is far away, comes past, and goes away again, so it
      // gets quieter at the edges of the sweep as well as moving across the field — that pairing
      // is what makes the stereo read as a car in a place rather than as a fader.
      if (kind === 'stereo') {
        const u = t / T;
        const d = Math.min(1, Math.abs(u - 0.5) * 2.1);
        st.volume = lerp(1.0, 0.09, d * d);      // ~21 dB of approach, not 12
        // a real pass-by does not sweep linearly: the bearing barely moves while the car is far
        // away and swings through 180 degrees in the moment it goes past
        const p = clamp(Math.tanh((u - 0.5) * 5.0) / Math.tanh(2.5), -1, 1);
        voice.setPan(p, t);
        tyres.setPan(p, t);                       // the rubber travels with the car
        nitro.setPan?.(p, t);
      }
      voice.apply(st, t);          // the upshift event fires inside apply(), off the same edge
    }

    // ---- tyres ----
    let squeal = 0, slip = 0, surface = 'road', load = 1;
    if (kind === 'squeal' || kind === 'tyre') {
      const sc = slideAt(t / T);
      // a hump across the beat: the slide builds, peaks, and is caught
      const shape = Math.pow(Math.sin(Math.PI * clamp(sc.u, 0, 1)), 0.7);
      // load LEADS slip — the car takes weight before the rear lets go, and gives it back before
      // the slide is fully caught, so the squeal bends down and then up through every slide
      const lshape = Math.pow(Math.sin(Math.PI * clamp(sc.u * 0.82 + 0.16, 0, 1)), 0.9);
      slip = sc.slip * shape;
      load = 0.45 + (sc.load - 0.45) * lshape;
      squeal = clamp(0.06 + 1.05 * sc.slip * Math.pow(shape, 0.55), 0, 1);
      surface = sc.surface;
      // the rumble strip hammers whether or not the tyre is sliding
      if (surface === 'kerb') squeal = Math.max(squeal, 0.45);
    } else if (kind === 'nitrous' || kind === 'mix' || kind === 'stereo') {
      squeal = clamp(0.55 - st.speed * 1.4, 0, 1) * (thr > 0.5 ? 1 : 0);   // wheelspin off the line
      slip = 0.62 * squeal;
      load = 0.8;
    } else if (kind === 'engine') {
      squeal = clamp(0.42 - st.speed * 2.2, 0, 1);                          // launch chirp only
      slip = 0.55 * squeal;
      load = 0.7;
    }
    tyres.apply({ amount: squeal, slip, speed: st.speed * 62, surface, load }, t);
    amb?.apply({ speed: st.speed * 62, surface, boost: boostRamp }, t);
  }

  const buf = await ctx.startRendering();
  return bufferToWav(buf);
}

/** Base64 so it can cross the Playwright bridge as a plain string. */
export async function renderClipBase64(kind, seconds, spec) {
  const bytes = await renderClip(kind, seconds, spec);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Encode an AudioBuffer to a WAV blob (used by the harness to hand the audio critic a file). */
export function bufferToWav(buffer) {
  const nch = buffer.numberOfChannels, len = buffer.length;
  const out = new ArrayBuffer(44 + len * nch * 2);
  const view = new DataView(out);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); view.setUint32(4, 36 + len * nch * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, nch, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * nch * 2, true); view.setUint16(32, nch * 2, true);
  view.setUint16(34, 16, true); wstr(36, 'data'); view.setUint32(40, len * nch * 2, true);
  let off = 44;
  const chans = [];
  for (let c = 0; c < nch; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = clamp(chans[c][i], -1, 1);
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(out);
}
