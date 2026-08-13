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
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE MIX HAS TWO BUSES (§6.9: "nothing clipping, nothing buried")
 *
 * A single bus with a soft-clipper on the end sounds tidy and is a trap: the clipper lifts
 * everything below its knee, so a full-severity crash, a nitrous crack and an idle all end up
 * within a couple of dB of each other and the mix reads as a bed of synthesis rather than a
 * composed picture.  Level has to be DESIGNED.
 *
 *   PROGRAMME  engine · tyres · nitrous jet · ambience · music — continuous, and side-chain
 *              ducked 4-11 dB for ~150 ms by every transient
 *   EVENT      impacts · nitrous crack · cutoff report · exhaust crackle · scrape — never
 *              ducked, never compressed
 *   CEILING    transparent below -1.9 dBFS, only bends the last 2 dB.  Clipping is impossible;
 *              quiet things stay quiet.
 *
 * So an impact is scaled by `impactGain(s)` (≈ -18 dB at s = 0.2, monotonic to 0 dB at s = 1),
 * lands on EVENT, and opens a hole in PROGRAMME underneath itself.  A 24 % kerb clip clears the
 * ducked bed by ~10 dB and a 100 % crash by ~24 dB, off the same code path.
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
 * Clip kinds: engine · idle · nitrous · impact · squeal · music · ambience · mix · stereo.
 * `stereo` renders TWO channels — a pass-by that crosses the field plus hits on alternating sides
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
 *   │  -1     a 100 % crash, the nitrous ignition crack               ← EVENT bus      │
 *   │  -6     a hard 60 % barrier hit, the cutoff report                               │
 *   │ -10     engine peaks at redline, wide open                      ← PROGRAMME bus  │
 *   │ -16     engine RMS at redline · sustained nitrous jet                            │
 *   │ -19     tyre squeal at full slip                                                 │
 *   │ -22     ambience: wind + road roar (audible, not decorative)                     │
 *   │ -24     music bed under gameplay                                                 │
 *   │ -30     idle                                                                     │
 *   └─────────────────────────────────────────────────────────────────────────────────┘
 *
 * Two buses make that survivable. PROGRAMME carries everything continuous and is side-chain
 * ducked; EVENT carries the transients and is never ducked and never compressed, so a crash
 * arrives on top of a hole in the mix instead of fighting the engine for the same 3 dB.
 */
export const MIX = {
  master: 0.72,
  engine: 0.30,
  tyre: 0.20,
  nitrous: 0.20,
  impact: 0.82,      // on the EVENT bus, where nothing else is competing for headroom
  music: 0.17,
  ambience: 0.86,    // r1 rendered the bed at -35 dB RMS, i.e. inaudible. This is ~-22.
  ui: 0.5,
};

/**
 * How loud an impact of strength `s` is, as a designed curve rather than a linear scale:
 * ≈ -18 dB at s = 0.2, monotonic, 0 dB at s = 1. A 20 % kerb clip and a 100 % crash are meant to
 * be two different orders of event, not two takes of the same one.
 */
export const impactGain = (s) => Math.pow(clamp(s, 0, 1), 1.25);

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
    cut: [900, 8600], cutQ: [1.1, 2.2],
    hp: 135,                       // no real bottom end — that is what makes a four sound small
    drive: [0.55, 1.55], driveMakeup: 0.72,
    body: { hz: [150, 320], gain: 3.5 },
    intake: { level: 0.42, hz: [400, 2400], q: 1.3, kind: 'pink' },
    knock: 0.0,
    turbo: { whistle: 0.95, whistleHz: [2300, 9000], whoosh: 0.40, spoolTc: 0.42, bov: 1.0 },
    crackle: 0.55, crackleHz: [1400, 7200],
    lope: 0.05,
    level: 1.15,
    // A modern turbo four is a NOISY little thing up top: direct injectors ticking, a compressor
    // hissing, and a wastegate. That is where its size comes from.
    air: {
      rasp: 0.34, raspK: 7, drive: 2.4, hp: 4600, peak: 7400, peakQ: 0.8, peakGain: 7,
      hiss: 0.62, hissHz: [5200, 12500], hissQ: 0.5, hissBoost: 1.5,
      tick: 0.95, tickHz: [5600, 9800], tickQ: 1.5, tickIdle: 0.55,
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
    bankMix: [1, 0.42], bankDelayMs: [0, 3.1], scatter: 0.16, jitter: 3.4,
    bankDetune: 11,
    zones: [
      { decay: 0.075, ring: 0.42, ringHz: 1.6 },
      { decay: 0.040, ring: 0.34, ringHz: 2.4 },
      { decay: 0.021, ring: 0.24, ringHz: 3.4 },
    ],
    pipeHz: [104, 141], pipeQ: 1.05, pipeGain: 5.5,
    cut: [330, 3400], cutQ: [0.9, 1.8],
    hp: 46,
    drive: [0.7, 2.6], driveMakeup: 0.52,
    body: { hz: [88, 168], gain: 6 },
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
      tick: 0.26, tickHz: [4000, 6800], tickQ: 1.1, tickIdle: 0.45,
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
    cut: [180, 1450], cutQ: [0.8, 1.4],
    hp: 44,
    drive: [0.8, 2.2], driveMakeup: 0.5,
    body: { hz: [70, 132], gain: 5 },
    intake: { level: 0.30, hz: [130, 700], q: 0.7, kind: 'brown' },
    knock: 1.15, knockHz: [1100, 2400], knockQ: 1.8,
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
    cut: [900, 13500], cutQ: [1.2, 2.6],
    hp: 82,
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
      tick: 0.62, tickHz: [7000, 12800], tickQ: 1.2, tickIdle: 0.40,
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
  constructor(ctx, dest, spec, { pan = 0, seed = 17, events = null } = {}) {
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

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = ch.cut[0];
    this.lp.Q.value = ch.cutQ[0];
    this.lp.connect(this.hp);

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
        A.rasp * (0.22 + 0.78 * open) * (1 + (A.over || 0) * over) * 0.072, when, 0.035);

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
      const wg = t.whistle * boost * boost * 0.055 * this.level;
      this.whistleG.gain.setTargetAtTime(wg, when, 0.06);
      this.whistleG2.gain.setTargetAtTime(wg * 0.45, when, 0.06);
      this.whooshBP.frequency.setTargetAtTime(lerp(700, 3400, boost), when, 0.06);
      this.whooshG.gain.setTargetAtTime(t.whoosh * boost * (0.2 + 0.8 * thr) * 0.075 * this.level, when, 0.06);
    }

    // ---- idle wander + rev-limiter chop ----
    this.lope.frequency.setTargetAtTime(lerp(2.2, 9, clamp(norm, 0, 1)), when, 0.1);
    this.lopeG.gain.setTargetAtTime(ch.lope * (a.roughness ?? 0.4) * 0.055 * (1 - 0.7 * clamp(norm, 0, 1)), when, 0.08);

    // ---- level ----
    // The engine's own dynamic range, and it is deliberately WIDE: a 22 dB spread from a closed
    // throttle at idle to wide open at the limiter. r1 spanned 11 dB and that is the difference
    // between an engine and a drone. The three terms are independent on purpose — a big engine
    // lugging at 1500 rpm under full load is loud, and the same rpm coasting is nearly silent.
    let vol = (0.085 + 0.30 * load + 0.68 * Math.pow(clamp(norm, 0, 1), 1.25) * (0.34 + 0.66 * load));
    vol *= (1 - 0.66 * over);                                        // lift off and it falls away
    if (shifting) vol *= 0.20;                                       // ignition cut, and you hear it
    if (rpm > a.redline * 0.985 && thr > 0.5) {                      // limiter chops the spark
      vol *= Math.sin(when * 2 * Math.PI * 15) > 0 ? 1 : 0.22;
    }
    this.out.gain.setTargetAtTime(vol * this.level * (s.volume ?? 1), when, shifting ? 0.006 : tc);

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
    if (shifting && !this._prevShift) this.bov(when, this._boost);
    this._prevShift = shifting;
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
 * Surface changes (§6.9). Each surface changes the squeal formants, how much broadband scrub
 * there is, the stick-slip rate, and the rolling roar under the car.
 *
 * `hi` is how much 5-12 kHz SCRUB the surface throws off — the fine hiss of rubber shearing on
 * aggregate. It is the single biggest tell between hot tarmac and a grass verge, and it is what a
 * skid actually sounds like from inside the car.
 */
export const SURFACE = {
  road: { squeal: [1150, 3550], q: [11, 15], scrub: 0.35, stick: [46, 130], roll: [180, 900], rollQ: 0.7, grain: 'pink', level: 1.0, rumble: 0, hi: 1.0 },
  asphalt: { squeal: [1150, 3550], q: [11, 15], scrub: 0.35, stick: [46, 130], roll: [180, 900], rollQ: 0.7, grain: 'pink', level: 1.0, rumble: 0, hi: 1.0 },
  concrete: { squeal: [1420, 4300], q: [14, 19], scrub: 0.28, stick: [58, 165], roll: [240, 1300], rollQ: 0.9, grain: 'pink', level: 1.05, rumble: 0, hi: 1.25 },
  wet: { squeal: [900, 2600], q: [7, 9], scrub: 0.55, stick: [30, 90], roll: [220, 1500], rollQ: 0.5, grain: 'white', level: 0.85, rumble: 0, hi: 1.4 },
  // Off the tarmac there is no squeal at all — just a huge wash of grit thrown at the arches.
  dirt: { squeal: [380, 980], q: [2.0, 2.6], scrub: 1.25, stick: [18, 46], roll: [120, 520], rollQ: 0.45, grain: 'grain', level: 0.8, rumble: 0.25, hi: 0.62 },
  grass: { squeal: [300, 760], q: [1.6, 2.0], scrub: 1.0, stick: [14, 36], roll: [100, 380], rollQ: 0.4, grain: 'brown', level: 0.7, rumble: 0.15, hi: 0.40 },
  // Rumble strip: the tyre is being hammered at a fixed spatial frequency.
  kerb: { squeal: [700, 1900], q: [4, 6], scrub: 0.85, stick: [24, 70], roll: [150, 700], rollQ: 0.6, grain: 'grain', level: 0.95, rumble: 1.0, hi: 0.95 },
};
export function surfaceOf(id) { return SURFACE[id] || SURFACE.road; }

// ═══════════════════════════════════════════════════════════════════════════ TyreVoice

/**
 * Tyre noise. Three layers, all live at once:
 *   · a two-formant resonant squeal whose pitch tracks slip ANGLE (not speed) — a tyre howls
 *     higher the harder you ask it to scrub;
 *   · stick-slip amplitude modulation, the "waaah" that separates a tyre from a kettle;
 *   · a broadband scrub bed whose colour comes from the surface table.
 * Plus a gated rumble layer for kerbs and gravel.
 */
const TYRE_DEFAULT = { formant: 1, howl: 1, roar: 1, stick: 1 };

export class TyreVoice {
  constructor(ctx, dest, { tyre = null } = {}) {
    this.ctx = ctx;
    // Rubber is per-class (§6.9 "class differentiation"): a wide sticky supercar tyre howls a
    // third higher and far more tonally than the tall soft sidewall on a two-and-a-half tonne
    // truck, which mostly just roars.
    this.t = { ...TYRE_DEFAULT, ...(tyre || {}) };
    this.out = ctx.createGain();
    this.out.gain.value = MIX.tyre;
    this.out.connect(dest);

    // --- squeal ---
    this.src = loopNoise(ctx, 'white', 2101, 2.6);
    this.f1 = ctx.createBiquadFilter(); this.f1.type = 'bandpass'; this.f1.frequency.value = 1600; this.f1.Q.value = 11;
    this.f2 = ctx.createBiquadFilter(); this.f2.type = 'bandpass'; this.f2.frequency.value = 3400; this.f2.Q.value = 15;
    this.f2g = ctx.createGain(); this.f2g.gain.value = 0.7;
    this.sq = ctx.createGain(); this.sq.gain.value = 0;
    this.src.connect(this.f1); this.f1.connect(this.sq);
    this.src.connect(this.f2); this.f2.connect(this.f2g); this.f2g.connect(this.sq);
    // tonal carcass resonance, half the first formant so its 2nd and ~5th harmonics sit right in
    // the two bandpasses — this is the part you can hum, and it tracks slip angle exactly
    this.tone = ctx.createOscillator(); this.tone.type = 'sawtooth'; this.tone.frequency.value = 800;
    this.toneG = ctx.createGain(); this.toneG.gain.value = 0;
    this.tone.connect(this.toneG); this.toneG.connect(this.f1); this.toneG.connect(this.f2);
    this.tone.start(0);
    // stick-slip AM
    this.am = ctx.createOscillator(); this.am.type = 'triangle'; this.am.frequency.value = 60;
    this.amG = ctx.createGain(); this.amG.gain.value = 0;
    this.am.connect(this.amG); this.amG.connect(this.sq.gain); this.am.start(0);
    this.sq.connect(this.out);

    // --- broadband scrub ---
    this.scrubSrc = loopNoise(ctx, 'grain', 2637, 2.4);
    this.scrubBP = ctx.createBiquadFilter(); this.scrubBP.type = 'bandpass'; this.scrubBP.frequency.value = 900; this.scrubBP.Q.value = 0.6;
    this.scrubG = ctx.createGain(); this.scrubG.gain.value = 0;
    this.scrubSrc.connect(this.scrubBP); this.scrubBP.connect(this.scrubG); this.scrubG.connect(this.out);

    // --- HF scrub: the fine hiss of rubber shearing across aggregate ---
    // The two formants above are the tyre's VOICE; this is its texture, and it lives an octave and
    // a half higher than anything else in the tyre voice. Without it a slide is a tone with no
    // surface under it, which is exactly what r2's squeal clips were.
    this.hiSrc = loopNoise(ctx, 'white', 2711, 2.3);
    this.hiHP = ctx.createBiquadFilter(); this.hiHP.type = 'highpass'; this.hiHP.frequency.value = 4800; this.hiHP.Q.value = 0.7;
    this.hiHP2 = ctx.createBiquadFilter(); this.hiHP2.type = 'highpass'; this.hiHP2.frequency.value = 4800; this.hiHP2.Q.value = 0.6;
    this.hiPk = ctx.createBiquadFilter(); this.hiPk.type = 'peaking'; this.hiPk.frequency.value = 8600; this.hiPk.Q.value = 0.8; this.hiPk.gain.value = 7;
    this.hiG = ctx.createGain(); this.hiG.gain.value = 0;
    this.hiSrc.connect(this.hiHP); this.hiHP.connect(this.hiHP2);
    this.hiHP2.connect(this.hiPk); this.hiPk.connect(this.hiG); this.hiG.connect(this.out);
    // ...and it stick-slips with the rest of the tyre, so the texture pulses instead of sitting
    // there as a flat band of noise.
    this.amG.connect(this.hiG.gain);

    // --- kerb / gravel rumble: noise gated by a low square ---
    this.rumSrc = loopNoise(ctx, 'brown', 3313, 2.2);
    this.rumGate = ctx.createGain(); this.rumGate.gain.value = 0;
    this.rumOsc = ctx.createOscillator(); this.rumOsc.type = 'square'; this.rumOsc.frequency.value = 34;
    this.rumDepth = ctx.createGain(); this.rumDepth.gain.value = 0;
    this.rumOsc.connect(this.rumDepth); this.rumDepth.connect(this.rumGate.gain); this.rumOsc.start(0);
    this.rumLP = ctx.createBiquadFilter(); this.rumLP.type = 'lowpass'; this.rumLP.frequency.value = 420;
    this.rumG = ctx.createGain(); this.rumG.gain.value = 0;
    this.rumSrc.connect(this.rumGate); this.rumGate.connect(this.rumLP); this.rumLP.connect(this.rumG);
    this.rumG.connect(this.out);
  }

  /** @param s {amount 0..1, slip 0..1+, speed m/s, surface} */
  apply(s, when, tc = 0.05) {
    const sf = surfaceOf(s.surface);
    const T = this.t;
    const amt = clamp(s.amount ?? 0, 0, 1.2);
    const slip = clamp(Math.abs(s.slip ?? 0), 0, 1.4);
    const spd = clamp((s.speed ?? 0) / 45, 0, 1.2);

    const f1 = lerp(sf.squeal[0], sf.squeal[1], clamp(slip, 0, 1)) * T.formant;
    this.f1.frequency.setTargetAtTime(clamp(f1, 120, 12000), when, 0.05);
    this.f2.frequency.setTargetAtTime(clamp(f1 * 2.3 + 260, 200, 16000), when, 0.05);
    this.f1.Q.setTargetAtTime(lerp(sf.q[0], sf.q[1], clamp(slip, 0, 1)) * (0.7 + 0.3 * T.howl), when, 0.08);
    this.f2.Q.setTargetAtTime(lerp(sf.q[0], sf.q[1], clamp(slip, 0, 1)) * 1.3 * (0.7 + 0.3 * T.howl), when, 0.08);
    // Squeal is an EVENT-ish layer within the programme: it has to swing hard with slip, not sit
    // at a polite constant. ^1.6 on slip means a light scrub is genuinely quiet.
    this.sq.gain.setTargetAtTime(amt * sf.level * 3.0 * (0.10 + 0.90 * Math.pow(clamp(slip, 0, 1), 1.6)), when, tc);
    // Loose surfaces do not howl, they wash — so the tonal layer only exists on hard ones.
    this.tone.frequency.setTargetAtTime(clamp(f1 * 0.5, 60, 6000), when, 0.04);
    this.toneG.gain.setTargetAtTime(amt * Math.pow(clamp(slip, 0, 1), 1.4) * T.howl * (sf.squeal[1] > 2000 ? 0.34 : 0.05), when, tc);

    // Stick-slip: faster and deeper the harder the tyre is being scrubbed.
    this.am.frequency.setTargetAtTime(lerp(sf.stick[0], sf.stick[1], clamp(slip, 0, 1)) * T.stick, when, 0.07);
    this.amG.gain.setTargetAtTime(amt * 0.45 * sf.level, when, tc);

    this.scrubBP.frequency.setTargetAtTime(lerp(sf.roll[0], sf.roll[1], clamp(spd, 0, 1)), when, 0.06);
    this.scrubBP.Q.setTargetAtTime(sf.rollQ, when, 0.1);
    this.scrubG.gain.setTargetAtTime(sf.scrub * T.roar * amt * (0.25 + 0.75 * spd) * 0.6, when, tc);

    // HF scrub. Tracks slip like the squeal does, but it is also there at zero slip whenever the
    // tyre is doing any work at all — rolling rubber on aggregate always hisses.
    const hiF = lerp(4200, 7600, clamp(slip, 0, 1));
    this.hiHP.frequency.setTargetAtTime(hiF, when, 0.06);
    this.hiHP2.frequency.setTargetAtTime(hiF, when, 0.06);
    this.hiPk.frequency.setTargetAtTime(lerp(7200, 11000, clamp(slip, 0, 1)), when, 0.08);
    this.hiG.gain.setTargetAtTime(
      amt * (sf.hi ?? 1) * sf.level * (0.14 + 0.86 * Math.pow(clamp(slip, 0, 1), 1.2))
      * (0.55 + 0.45 * T.howl) * 0.105, when, tc);

    // Kerb strips beat at a spatial frequency, so their rate rises with road speed.
    this.rumOsc.frequency.setTargetAtTime(clamp(14 + 46 * spd, 8, 90), when, 0.06);
    this.rumDepth.gain.setTargetAtTime(sf.rumble > 0 ? 1.1 : 0, when, 0.05);
    this.rumG.gain.setTargetAtTime(sf.rumble * (0.25 + 0.75 * spd) * clamp(0.35 + amt, 0, 1) * 0.9, when, tc);
  }

  stop() {
    try { this.src.stop(); this.am.stop(); this.tone.stop(); this.scrubSrc.stop(); this.hiSrc.stop(); this.rumSrc.stop(); this.rumOsc.stop(); } catch { /* */ }
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
  constructor(ctx, dest, { events = null, nitrous = null, bus = null, pan = 0 } = {}) {
    this.ctx = ctx;
    // Two paths on purpose: the sustained jet sits UNDER the engine on the PROGRAMME bus, but the
    // valve crack, the ignition and the cutoff report are EVENTS — they go to the un-ducked event
    // bus and additionally punch a 6 dB hole in the programme, which is what makes a boost feel
    // like it hits rather than like a fader move.
    this.n = { ...NIT_DEFAULT, ...(nitrous || {}) };
    this.masterBus = bus;
    const stereo = ctx.destination.channelCount > 1 && !!ctx.createStereoPanner;
    const wire = (node, to) => {
      if (stereo) { const p = ctx.createStereoPanner(); p.pan.value = pan; node.connect(p); p.connect(to); }
      else node.connect(to);
    };
    this.out = ctx.createGain();
    this.out.gain.value = MIX.nitrous;
    wire(this.out, dest);
    this.hit = ctx.createGain();
    this.hit.gain.value = 0.92;
    wire(this.hit, events || dest);
    this.rng = new RNG(9091);

    const bore = this.n.bore;
    // sustained jet — a big-bore truck shot is darker and fatter, a supercar's is a tight hiss
    this.jet = loopNoise(ctx, 'white', 4401, 2.5);
    this.jetHP = ctx.createBiquadFilter(); this.jetHP.type = 'highpass'; this.jetHP.frequency.value = 800 / bore;
    this.jetPK = ctx.createBiquadFilter(); this.jetPK.type = 'peaking'; this.jetPK.frequency.value = 2600 / bore; this.jetPK.Q.value = 1.4; this.jetPK.gain.value = 10;
    this.jetG = ctx.createGain(); this.jetG.gain.value = 0;
    this.jet.connect(this.jetHP); this.jetHP.connect(this.jetPK); this.jetPK.connect(this.jetG); this.jetG.connect(this.out);

    // low rumble bed — the part you feel in the chest
    this.rum = loopNoise(ctx, 'brown', 4507, 2.5);
    this.rumLP = ctx.createBiquadFilter(); this.rumLP.type = 'lowpass'; this.rumLP.frequency.value = 260; this.rumLP.Q.value = 3.5;
    this.rumG = ctx.createGain(); this.rumG.gain.value = 0;
    this.rum.connect(this.rumLP); this.rumLP.connect(this.rumG); this.rumG.connect(this.out);

    // spool tone: a rising resonance as the line pressurises
    this.spool = ctx.createOscillator(); this.spool.type = 'sawtooth'; this.spool.frequency.value = 180;
    this.spoolLP = ctx.createBiquadFilter(); this.spoolLP.type = 'lowpass'; this.spoolLP.frequency.value = 900; this.spoolLP.Q.value = 9;
    this.spoolG = ctx.createGain(); this.spoolG.gain.value = 0;
    this.spool.connect(this.spoolLP); this.spoolLP.connect(this.spoolG); this.spoolG.connect(this.hit);
    this.spool.start(0);
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
    this.jetG.gain.setTargetAtTime(a * 0.34, when, tc);
    this.jetHP.frequency.setTargetAtTime((700 + a * 1500) / bore, when, 0.08);
    this.jetPK.frequency.setTargetAtTime((2000 + a * 2600) / bore, when, 0.09);
    this.rumG.gain.setTargetAtTime(a * 0.46 * bore, when, tc);
    this.rumLP.frequency.setTargetAtTime((120 + a * 210) / bore, when, 0.08);
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
    try { this.jet.stop(); this.rum.stop(); this.spool.stop(); } catch { /* */ }
    this.out.disconnect(); this.hit.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════ impacts

const IMP_DEFAULT = { mass: 1, thumpHz: 1, modeHz: 1, decay: 1, glass: 1, rattle: 0.6, bright: 1 };

/**
 * Impacts, layered by severity AND by what class of car took the hit (§6.9).
 *
 * LEVEL IS THE POINT. The whole event is scaled by `impactGain(s)` — a curve, roughly -18 dB at
 * s = 0.2 climbing monotonically to 0 dB at s = 1 — and it lands on the un-ducked EVENT bus while
 * punching a hole in the programme underneath, so a 24 % kerb clip is a small tick you can still
 * hear and a 100 % crash is the loudest thing in the game by 12-18 dB. r1 put every hit inside a
 * 2 dB window, which is why nothing had weight.
 *
 * The layers arrive in order of severity, not all at once:
 *   any     contact scuff — the tyre/bumper touching whatever it touched
 *   > 0.15  body thump (chassis mass) + panel resonance modes
 *   > 0.45  glass, a debris tail, and loose-junk rattle (a truck rattles, a supercar does not)
 *
 * Deterministic: the "random" mode frequencies come from a seeded RNG.
 */
export function scheduleImpact(ctx, dest, when, strength, {
  surface = 'road', seed = 55, level = 1, pan = 0, car = null, bus = null,
} = {}) {
  const s = clamp(strength, 0, 1);
  if (s < 0.02) return;
  // A wall you clipped on the right belongs on the right. Only in a stereo context — the mono
  // offline render would just lose 3-6 dB for nothing.
  if (pan && ctx.destination.channelCount > 1 && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(dest);
    dest = p;
  }
  const C = { ...IMP_DEFAULT, ...(car || {}) };
  const rng = new RNG(seed * 7919 + Math.floor(s * 97));
  const metal = clamp((s - 0.15) / 0.5, 0, 1);
  const heavy = clamp((s - 0.45) / 0.5, 0, 1);
  // THE curve. Everything below is scaled by it, so severity is audible as loudness first and
  // as spectrum second.
  const L = level * MIX.impact * impactGain(s);
  const sf = surfaceOf(surface);

  // Duck the programme so the hit lands in a hole. Depth follows severity too: a light contact
  // takes ~6 dB out of the mix, a crash ~11 dB for 150 ms. Without this a 24 % kerb clip is
  // simply inaudible under a running engine no matter how it is voiced.
  bus?.duck(when - 0.005, 0.42 + 0.30 * s, 0.09 + 0.07 * s, 0.22 + 0.16 * s);

  // --- 1. the contact: broadband, coloured by what was hit and by how hard ---
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, surface === 'dirt' || surface === 'grass' ? 'grain' : 'white', 0.6, 5501);
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
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.62 * sf.level * L * lerp(1.5, 1.0, s) * (1.62 - 0.62 * C.mass), when + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, when + (0.07 + 0.30 * s) * C.decay);
  n.connect(f); f.connect(g); g.connect(dest);
  n.start(when); n.stop(when + 0.6);

  // --- 1b. graze chatter. Clipping a rumble strip or scattering gravel is a BRRRP, not a tick.
  // This is how a 24 % contact stays audible under a running engine WITHOUT being loud: it wins
  // on duration and on sitting in a band the exhaust does not occupy. It fades out as severity
  // rises, because a real crash swallows the chatter whole. ---
  const graze = clamp(1 - (s - 0.18) / 0.5, 0, 1) * (0.55 + 0.45 * sf.rumble);
  if (graze > 0.05) {
    const taps = 5 + Math.round(9 * graze);
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
      tg.gain.setValueAtTime(0.0001, st);
      tg.gain.exponentialRampToValueAtTime(3.2 * graze * L * rng.range(0.45, 1.0), st + 0.0015);
      tg.gain.exponentialRampToValueAtTime(0.0001, st + d);
      tn.connect(tf); tf.connect(tg); tg.connect(dest);
      tn.start(st); tn.stop(st + d + 0.02);
      st += rng.range(0.010, 0.026);
    }
  }

  // --- 2. body thump: the chassis mass. A 2.6 t truck and a 1.2 t coupe are not the same note. ---
  if (metal > 0.02) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime((80 + 74 * s) * C.thumpHz, when);
    o.frequency.exponentialRampToValueAtTime(28 * C.thumpHz, when + (0.16 + 0.16 * s) * C.decay);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, when);
    og.gain.exponentialRampToValueAtTime(1.15 * C.mass * L, when + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, when + (0.22 + 0.26 * s) * C.decay);
    o.connect(og); og.connect(dest);
    o.start(when); o.stop(when + 0.7);
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
export function scheduleScrape(ctx, dest, when, dur, intensity = 0.6) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, 'white', Math.max(1, dur + 0.4), 6203);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3400; f.Q.value = 1.6;
  const f2 = ctx.createBiquadFilter(); f2.type = 'peaking'; f2.frequency.value = 7000; f2.Q.value = 1.4; f2.gain.value = 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(0.30 * intensity, when + 0.05);
  g.gain.setValueAtTime(0.30 * intensity, when + dur - 0.06);
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  // spark chatter
  const am = ctx.createOscillator(); am.type = 'sawtooth'; am.frequency.value = 42;
  const amg = ctx.createGain(); amg.gain.value = 0.4 * intensity;
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
  constructor(ctx, dest, { tyre = null } = {}) {
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
    try { this.wind.stop(); this.road.stop(); this.tyre.stop(); this.air.stop(); this.hum.stop(); this.hum2.stop(); } catch { /* */ }
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
 * The music/ambience bed (§6.9). A four-on-the-floor synthwave loop at 132 BPM: kick, clap,
 * 16th hats, an offbeat saw bass, filtered chord stabs and a delayed arpeggio lead. Every note is
 * an oscillator + envelope built here; there is no sample anywhere.
 *
 * The same `scheduleBar()` is used by the live lookahead scheduler and the offline renderer.
 */
export class MusicBed {
  constructor(ctx, dest, { bpm = 132, level = MIX.music, seed = 4242 } = {}) {
    this.ctx = ctx;
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
    this.air.type = 'highshelf'; this.air.frequency.value = 7500; this.air.gain.value = 4;
    this.out.connect(this.duck); this.duck.connect(this.glue); this.glue.connect(this.hp);
    this.hp.connect(this.air); this.air.connect(dest);

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
    o.frequency.setValueAtTime(165, t);
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
      n.connect(f); f.connect(g); g.connect(this.out);
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
    sn.connect(sf); sf.connect(sg); sg.connect(this.out);
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
    lp.frequency.setValueAtTime(3800, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(this.out);
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
    lp.connect(g); g.connect(this.out); g.connect(this.send);
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
    n.connect(f); f.connect(g); g.connect(this.out);
    n.start(t); n.stop(t + dur + 0.2);
  }

  // ---- the arrangement ------------------------------------------------------------

  scheduleBar(bar, when) {
    const S = this.step;
    const ch = PROG[bar % PROG.length];
    const chord = [ch.root + 12, ch.root + 12 + ch.third, ch.root + 19];
    const arpNotes = [ch.root + 24, ch.root + 24 + ch.third, ch.root + 31, ch.root + 36,
      ch.root + 31, ch.root + 24 + ch.third, ch.root + 24, ch.root + 31];
    const section = Math.floor(bar / 4) % 2;   // alternate 4-bar halves for variety

    // drums
    for (let b = 0; b < 4; b++) this.kick(when + b * this.beat, b === 0 ? 1 : 0.9);
    if (bar % 4 === 3) this.kick(when + 14 * S, 0.75);
    this.clap(when + 1 * this.beat, 0.9);
    this.clap(when + 3 * this.beat, 0.9);
    // Hats on all sixteen, accented on the offbeats: the top octave has to be CONTINUOUS for the
    // track to have air, not eight isolated ticks a bar.
    for (let i = 0; i < 16; i++) {
      const off = i % 2 === 1;
      const vel = off ? (i % 4 === 3 ? 0.95 : 0.68) : (section === 1 ? 0.34 : 0.24);
      this.hat(when + i * S, vel, (i === 14 && bar % 2 === 1) || (i === 6 && section === 1));
    }

    // bass — offbeat driving pattern
    const pat = section === 0 ? [0, 3, 6, 8, 11, 14] : [0, 2, 3, 6, 8, 10, 11, 14];
    for (const i of pat) {
      const oct = i === 0 || i === 8 ? 0 : (i % 3 === 0 ? 0 : 12);
      this.bass(when + i * S, ch.root + oct, S * 1.6, i === 0 ? 1 : 0.82);
    }

    // chord stabs on the offbeats
    this.stab(when + 2 * S, chord, S * 2.4, 0.55);
    this.stab(when + 10 * S, chord, S * 2.0, 0.45);
    if (section === 1) this.stab(when + 7 * S, chord, S * 1.4, 0.35);

    // lead arpeggio
    for (let i = 0; i < 16; i += 2) {
      const n = arpNotes[(i / 2 + bar * 3) % arpNotes.length];
      this.lead(when + i * S, n, S * 1.3, section === 1 ? 1 : 0.7);
    }

    // an 8-bar riser into the downbeat
    if (bar % 8 === 7) this.riser(when + 8 * S, this.barLen * 0.5);
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

    this.sum = ctx.createGain(); this.sum.gain.value = master;
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = CEILING; this.ceiling.oversample = '4x';

    this.prog.connect(this.duckGain); this.duckGain.connect(this.sum);
    this.event.connect(this.sum);
    this.sum.connect(this.ceiling); this.ceiling.connect(ctx.destination);

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
    this.event.disconnect(); this.sum.disconnect(); this.ceiling.disconnect();
  }
}

function buildBus(ctx, opts) { return new MasterBus(ctx, opts); }

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

    this.sfx = this.ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.events);
    this.tyres = new TyreVoice(this.ctx, this.master, { tyre: this._carAudio?.tyre });
    this.nitro = new NitrousVoice(this.ctx, this.master, { events: this.events, bus: b });
    this.ambience = new AmbienceBed(this.ctx, this.master, { tyre: this._carAudio?.tyre });
    this.music = new MusicBed(this.ctx, this.master);

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
      this.voices.set(id, new EngineVoice(this.ctx, this.master, spec, { events: this.events, ...opts }));
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
    this.tyres = new TyreVoice(this.ctx, this.master, { tyre: a.tyre });
    this.nitro?.stop();
    this.nitro = new NitrousVoice(this.ctx, this.master, { events: this.events, bus: this.busses, nitrous: a.nitrous });
    this.ambience?.stop();
    this.ambience = new AmbienceBed(this.ctx, this.master, { tyre: a.tyre });
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
    scheduleScrape(this.ctx, this.sfx, t, dur, intensity);
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

/** Throttle scripts. Each clip is a little scene, not a test tone. */
const SCRIPTS = {
  // idle → wide open through four upshifts → lift for a real overrun → back on it
  engine: (t, T) => {
    if (t < 0.30) return 0.0;              // idle — where the lope / clatter lives
    if (t < 0.44) return 0.75;             // a blip, so the character is unmistakable
    if (t < 0.62) return 0.0;
    if (t < T * 0.72) return 1.0;          // wide open, three or four upshifts
    if (t < T * 0.88) return 0.0;          // lift: overrun, crackle, a downshift
    return 1.0;                             // and back on it
  },
  idle: (t) => (t % 1.6 < 0.14 ? 0.55 : 0.0),
  // Part throttle, THEN the bottle. A boost fired while already flat out has nothing to be louder
  // than — the crack has to land on a quiet bed for the event to read as an event.
  nitrous: (t, T) => (t < 0.85 ? 0.30 : t < T - 0.9 ? 1.0 : 0.22),
  // A slalom is a THROTTLE scene as much as a slip scene: you lift to load the nose into the
  // slide and get back on it as the car straightens. That also uncovers the tyres at the exact
  // moment they are working hardest, which is what a drift is supposed to sound like.
  squeal: (t, T) => {
    if (t < T * 0.10) return 1.0;                                  // the launch chirp
    if (t > T * 0.90) return 0.04;                                 // ...and the car straightens up
    const w = Math.abs(Math.sin((t / T) * Math.PI * 3.1));
    return clamp(0.95 - 0.74 * w, 0.06, 1);
  },
  mix: (t, T) => (t < 0.3 ? 0 : t < T * 0.75 ? 1 : 0.2),
  stereo: (t, T) => (t < T * 0.55 ? 1.0 : t < T * 0.75 ? 0.0 : 0.9),
  // A crash makes you lift — but 250 ms LATER, the way a driver actually reacts. That also keeps
  // the overrun crackle out of the hit's own decay so the severity curve stays legible.
  impact: (t) => (t > 3.20 && t < 3.72 ? 0 : t > 1.40 && t < 1.66 ? 0 : 0.55),
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
  const channels = kind === 'stereo' ? 2 : 1;
  const ctx = new OAC(channels, Math.ceil(sampleRate * seconds), sampleRate);
  const M = buildBus(ctx);
  const bus = M.prog, ev = M.event;
  const T = seconds;
  const DT = 1 / 60;
  const A = spec.audio || {};

  const script = SCRIPTS[kind] || SCRIPTS.engine;
  // The impact clip is a SCENE, not four hits in a vacuum: the car is moving and the engine is
  // running, because "nothing buried" is judged against the mix the player actually hears.
  const wantEngine = kind !== 'music' && kind !== 'ambience';
  const wantMusic = kind === 'nitrous' || kind === 'squeal' || kind === 'music' || kind === 'mix' || kind === 'stereo';
  const wantAmbience = kind !== 'music';

  const voice = wantEngine ? new EngineVoice(ctx, bus, spec, { events: ev }) : null;
  const tyres = new TyreVoice(ctx, bus, { tyre: A.tyre });
  if (kind === 'squeal') tyres.out.gain.value = MIX.tyre * 2.2;   // the tyres are the subject here
  if (voice && kind === 'squeal') voice.level *= 0.58;
  const amb = wantAmbience ? new AmbienceBed(ctx, bus, { tyre: A.tyre }) : null;
  // On the character clips the bed steps back a little — the engine is the subject — but it stays
  // clearly audible. r1 buried it 27 dB under programme, which is the same as not having one.
  if (amb && (kind === 'engine' || kind === 'idle')) amb.out.gain.value = MIX.ambience * 0.85;
  const nitro = new NitrousVoice(ctx, bus, { events: ev, bus: M, nitrous: A.nitrous });
  const sim = new DriveSim(spec);

  let bed = null;
  if (wantMusic) {
    bed = new MusicBed(ctx, bus, {
      // Under gameplay the bed is a bed. On the music-only clip it is the whole point.
      level: kind === 'music' ? MIX.music * 2.2 : MIX.music * (kind === 'nitrous' ? 0.85 : 1.0),
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
  if (kind === 'squeal') { sim.w = 0.34; sim.gear = 2; }
  if (kind === 'mix') { sim.w = 0.12; sim.gear = 1; }
  if (kind === 'impact') { sim.w = 0.42; sim.gear = 3; }
  if (kind === 'stereo') { sim.w = 0.26; sim.gear = 2; }

  // ── impact scene: five hits, rising severity, different surfaces + a wall scrape ──
  // The severities are chosen to make the LEVEL CURVE legible: 0.24 → 1.00 is -16 dB of designed
  // spread, monotonic, and each hit is on a different thing.
  if (kind === 'impact') {
    const hits = [
      { t: 0.30, s: 0.24, surface: 'kerb' },
      { t: 1.15, s: 0.40, surface: 'road' },
      { t: 2.00, s: 0.64, surface: 'concrete' },
      { t: 2.95, s: 1.00, surface: 'concrete' },
      { t: 4.20, s: 0.46, surface: 'dirt' },
    ];
    for (const h of hits) {
      if (h.t < T) scheduleImpact(ctx, ev, h.t, h.s, { surface: h.surface, seed: Math.round(h.t * 100), car: A.impact, bus: M });
    }
    if (T > 3.7) scheduleScrape(ctx, ev, 3.35, 0.55, 0.8);
  }

  // ── stereo scene: a car goes past left→right, clipping a barrier on each side ─────
  if (kind === 'stereo') {
    scheduleImpact(ctx, ev, 1.60, 0.55, { surface: 'concrete', seed: 160, car: A.impact, bus: M, pan: -0.9 });
    scheduleImpact(ctx, ev, 2.90, 0.85, { surface: 'concrete', seed: 290, car: A.impact, bus: M, pan: 0.9 });
    nitro.spoolUp(3.60, 0.30); nitro.ignite(3.90, 1.0); nitro.cutoff(T - 0.35);
  }

  // ── the frame loop: identical to the live one, just with explicit times ───────────
  let boostRamp = 0;
  for (let i = 0; i * DT < T; i++) {
    const t = i * DT;
    const thr = script(t, T);
    const st = sim.step(DT, thr);

    // nitrous ramp shape (matches Nitrous's attack/decay feel)
    if (kind === 'nitrous' || kind === 'stereo') {
      const fire = kind === 'stereo' ? 3.90 : NIT_FIRE, end = kind === 'stereo' ? T - 0.35 : NIT_END;
      const target = t > fire && t < end ? 1 : 0;
      boostRamp += (target - boostRamp) * (1 - Math.exp(-DT / (target ? 0.10 : 0.16)));
      nitro.sustain(boostRamp, t);
      // the charge pulls the engine well past where the gearbox alone would take it
      st.rpm = Math.min(spec.audio.redline * 1.0, st.rpm * (1 + 0.10 * boostRamp));
    }

    if (voice) {
      if (st.shifting && !voice._prevShift) voice.bov(t, st.boost);
      voice._prevShift = st.shifting;
      voice.apply(st, t);
      // a pass-by: the car crosses the stereo field, which is what the panners are for
      if (kind === 'stereo') voice.setPan(clamp(-1 + 2 * (t / T), -1, 1), t);
    }

    // ---- tyres ----
    let squeal = 0, slip = 0, surface = 'road';
    if (kind === 'squeal') {
      // a slalom: three slides of growing angle, then off onto dirt, then over a kerb
      const p = t / T;
      const wave = Math.abs(Math.sin(p * Math.PI * 3.1));
      slip = wave * (0.35 + 0.65 * p);
      squeal = smoothstep(0.06, 0.30, wave) * (0.55 + 0.45 * p);
      surface = p < 0.42 ? 'road' : p < 0.62 ? 'concrete' : p < 0.82 ? 'dirt' : 'kerb';
      // ...and back onto clean tarmac, straight, off the throttle: the clip needs somewhere to
      // land or it is five seconds of the same busy texture and reads as one flat event.
      if (p > 0.90) { slip = 0; squeal = 0; surface = 'road'; }
    } else if (kind === 'nitrous' || kind === 'mix' || kind === 'stereo') {
      squeal = clamp(0.55 - st.speed * 1.4, 0, 1) * (thr > 0.5 ? 1 : 0);   // wheelspin off the line
      slip = 0.5;
    } else if (kind === 'engine') {
      squeal = clamp(0.42 - st.speed * 2.2, 0, 1);                          // launch chirp only
      slip = 0.35;
    }
    tyres.apply({ amount: squeal, slip, speed: st.speed * 62, surface }, t);
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
