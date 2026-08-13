import { clamp, lerp, RNG } from './rng.js';

/**
 * Procedural audio. ART_DIRECTION.md §3: every sound is synthesised from oscillators and noise
 * buffers we fill ourselves — no audio files.
 *
 * The engine model is additive: a set of harmonics of the cylinder firing frequency, plus a
 * filtered noise bed for induction/exhaust roar. Class character comes from the harmonic weights,
 * the firing irregularity (a lopey V8 vs a smooth flat-plane), and the filter shape — not from
 * pitch alone (§6.9 requires the four to be distinct in character).
 *
 * Every builder here takes an AudioContext so the same graph can be rendered offline into a WAV
 * for the audio critic.
 */

export function makeNoiseBuffer(ctx, seconds = 2, { seed = 5, kind = 'white' } = {}) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
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
    let last = 0;
    for (let i = 0; i < len; i++) { last = clamp(last + rng.range(-1, 1) * 0.02, -1, 1); d[i] = last * 3.2; }
  }
  return buf;
}

const CHARACTER = {
  'i4-turbo': {
    harmonics: [1, 0.62, 0.44, 0.30, 0.20, 0.13, 0.08],
    types: ['sawtooth', 'square', 'sawtooth', 'sawtooth', 'square', 'sawtooth', 'sawtooth'],
    detune: 5, noise: 0.34, noiseQ: 1.6, cutBase: 520, cutSpan: 4200, growl: 0.10, blow: 0.55,
  },
  'v8-lopey': {
    harmonics: [1, 0.86, 0.52, 0.62, 0.30, 0.22, 0.16],
    types: ['sawtooth', 'sawtooth', 'square', 'sawtooth', 'square', 'sawtooth', 'triangle'],
    detune: 18, noise: 0.46, noiseQ: 0.9, cutBase: 260, cutSpan: 2600, growl: 0.42, blow: 0.10,
  },
  'v8-diesel': {
    harmonics: [1, 0.94, 0.70, 0.46, 0.26, 0.16, 0.10],
    types: ['sawtooth', 'square', 'square', 'sawtooth', 'triangle', 'sawtooth', 'triangle'],
    detune: 24, noise: 0.60, noiseQ: 0.7, cutBase: 180, cutSpan: 1700, growl: 0.58, blow: 0.06,
  },
  'v8-flatplane': {
    harmonics: [1, 0.50, 0.72, 0.40, 0.44, 0.28, 0.22],
    types: ['sawtooth', 'sawtooth', 'sawtooth', 'square', 'sawtooth', 'square', 'sawtooth'],
    detune: 7, noise: 0.30, noiseQ: 2.4, cutBase: 620, cutSpan: 6200, growl: 0.14, blow: 0.20,
  },
};

/** One car's engine. `spec.audio` selects the character. */
export class EngineVoice {
  constructor(ctx, dest, spec) {
    this.ctx = ctx;
    this.spec = spec;
    const ch = CHARACTER[spec.audio.character] || CHARACTER['v8-lopey'];
    this.ch = ch;

    this.out = ctx.createGain();
    this.out.gain.value = 0.0;
    this.out.connect(dest);

    // ---- tone stack ----
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 1.2;
    this.filter.connect(this.out);

    this.body = ctx.createBiquadFilter();      // cabin resonance
    this.body.type = 'peaking';
    this.body.frequency.value = 190;
    this.body.Q.value = 1.1;
    this.body.gain.value = 6;
    this.body.connect(this.filter);

    this.oscs = [];
    this.gains = [];
    for (let i = 0; i < ch.harmonics.length; i++) {
      const o = ctx.createOscillator();
      o.type = ch.types[i] || 'sawtooth';
      o.detune.value = (i % 2 ? 1 : -1) * ch.detune * (0.5 + i * 0.2);
      const g = ctx.createGain();
      g.gain.value = ch.harmonics[i] * 0.10;
      o.connect(g); g.connect(this.body);
      o.start();
      this.oscs.push(o); this.gains.push(g);
    }

    // ---- induction / exhaust noise ----
    this.noise = ctx.createBufferSource();
    this.noise.buffer = makeNoiseBuffer(ctx, 2.5, { seed: 9, kind: 'pink' });
    this.noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = ch.noiseQ;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseFilter); this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);
    this.noise.start();

    // ---- lope: a slow amplitude wobble that makes a big V8 sound uneven at idle ----
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'triangle';
    this.lfo.frequency.value = 7;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = ch.growl * 0.06;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.out.gain);
    this.lfo.start();

    // ---- turbo whistle (tuner only, but harmless elsewhere) ----
    this.blow = ctx.createOscillator();
    this.blow.type = 'sine';
    this.blow.frequency.value = 2400;
    this.blowGain = ctx.createGain();
    this.blowGain.gain.value = 0;
    this.blow.connect(this.blowGain); this.blowGain.connect(this.filter);
    this.blow.start();

    this.volume = 0.0;
  }

  /** @param s {rpm, throttle, load, gearShift, volume} */
  update(s, dt = 1 / 60) {
    const ctx = this.ctx, t = ctx.currentTime;
    const a = this.spec.audio;
    const rpm = clamp(s.rpm, a.idleRpm * 0.6, a.redline * 1.06);
    // 4-stroke: firing events per second = rpm/60 * cylinders/2
    const fire = (rpm / 60) * (a.cylinders / 2);
    const base = clamp(fire, 12, 460);

    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(base * (i + 1), t, 0.020);
    }
    const norm = (rpm - a.idleRpm) / (a.redline - a.idleRpm);
    const cut = this.ch.cutBase + this.ch.cutSpan * clamp(norm, 0, 1) * (0.45 + 0.55 * s.throttle);
    this.filter.frequency.setTargetAtTime(cut, t, 0.03);
    this.body.frequency.setTargetAtTime(lerp(120, 260, clamp(norm, 0, 1)), t, 0.05);

    this.noiseFilter.frequency.setTargetAtTime(lerp(300, 2600, clamp(norm, 0, 1)), t, 0.04);
    this.noiseGain.gain.setTargetAtTime(this.ch.noise * (0.18 + 0.62 * s.throttle) * (0.35 + 0.65 * clamp(norm, 0, 1)), t, 0.04);

    this.lfo.frequency.setTargetAtTime(lerp(6, 26, clamp(norm, 0, 1)), t, 0.08);
    this.blowGain.gain.setTargetAtTime(this.ch.blow * 0.012 * clamp(norm, 0, 1) * s.throttle, t, 0.05);
    this.blow.frequency.setTargetAtTime(lerp(1600, 5200, clamp(norm, 0, 1)), t, 0.06);

    const vol = (s.volume ?? 1) * (0.10 + 0.30 * s.throttle + 0.30 * clamp(norm, 0, 1)) * (s.gearShift ? 0.45 : 1);
    this.out.gain.setTargetAtTime(vol, t, s.gearShift ? 0.01 : 0.05);
  }

  stop() {
    try {
      for (const o of this.oscs) o.stop();
      this.noise.stop(); this.lfo.stop(); this.blow.stop();
    } catch { /* already stopped */ }
    this.out.disconnect();
  }
}

/** Master audio bus + one-shot sound effects. */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.master = null;
    this.voices = new Map();
    this.muted = false;
  }

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.75;
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 24; this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004; this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);
    this.enabled = true;
    return this.ctx;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.75; }

  engine(id, spec) {
    if (!this.ctx) return null;
    if (!this.voices.has(id)) this.voices.set(id, new EngineVoice(this.ctx, this.master, spec));
    return this.voices.get(id);
  }

  dropEngine(id) {
    const v = this.voices.get(id);
    if (v) { v.stop(); this.voices.delete(id); }
  }

  // ---------------------------------------------------------------- one-shots

  /** Tyre squeal — resonant band-passed noise, pitch tracks slip angle. */
  squeal(amount, slip) {
    if (!this.ctx || amount < 0.05) return;
    if (!this._squeal) {
      const n = this.ctx.createBufferSource();
      n.buffer = makeNoiseBuffer(this.ctx, 2, { seed: 21, kind: 'white' });
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 9;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'bandpass'; f2.frequency.value = 3400; f2.Q.value = 14;
      const g = this.ctx.createGain(); g.gain.value = 0;
      n.connect(f); f.connect(f2); f2.connect(g); g.connect(this.master);
      n.start();
      this._squeal = { g, f, f2 };
    }
    const t = this.ctx.currentTime;
    this._squeal.g.gain.setTargetAtTime(amount * 0.16, t, 0.05);
    this._squeal.f.frequency.setTargetAtTime(1200 + Math.abs(slip) * 2600, t, 0.06);
    this._squeal.f2.frequency.setTargetAtTime(2800 + Math.abs(slip) * 3200, t, 0.06);
  }

  /** Nitrous: a hiss that swells, an ignition crack, then a sustained roar. */
  nitroStart(color = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // crack
    const n = this.ctx.createBufferSource();
    n.buffer = makeNoiseBuffer(this.ctx, 0.6, { seed: 33, kind: 'white' });
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2.2;
    f.frequency.setValueAtTime(280, t);
    f.frequency.exponentialRampToValueAtTime(4200 * color, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.6);
    // sub thump
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.30);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.40);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.45);
  }

  nitroSustain(amount) {
    if (!this.ctx) return;
    if (!this._nitro) {
      const n = this.ctx.createBufferSource();
      n.buffer = makeNoiseBuffer(this.ctx, 2, { seed: 44, kind: 'white' });
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 900;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'peaking'; f2.frequency.value = 2600; f2.Q.value = 1.6; f2.gain.value = 9;
      const g = this.ctx.createGain(); g.gain.value = 0;
      n.connect(f); f.connect(f2); f2.connect(g); g.connect(this.master);
      n.start();
      this._nitro = { g, f };
    }
    const t = this.ctx.currentTime;
    this._nitro.g.gain.setTargetAtTime(amount * 0.20, t, 0.06);
    this._nitro.f.frequency.setTargetAtTime(700 + amount * 1400, t, 0.08);
  }

  /** Impact — layered by severity: a body thump, a metal crunch, a glass tinkle. */
  impact(strength) {
    if (!this.ctx || strength < 0.03) return;
    const t = this.ctx.currentTime;
    const s = clamp(strength, 0, 1);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90 + 60 * s, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.18);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.55 * s, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.32);

    const n = this.ctx.createBufferSource();
    n.buffer = makeNoiseBuffer(this.ctx, 0.4, { seed: 55 + Math.floor(s * 20), kind: 'white' });
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900 + 2600 * s; f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45 * s, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + 0.2 * s);
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.4);

    if (s > 0.5) {
      for (let i = 0; i < 6; i++) {
        const to = this.ctx.createOscillator();
        to.type = 'triangle';
        to.frequency.value = 2600 + Math.random() * 3400;
        const tg = this.ctx.createGain();
        const st = t + 0.02 + Math.random() * 0.18;
        tg.gain.setValueAtTime(0.0001, st);
        tg.gain.exponentialRampToValueAtTime(0.06 * s, st + 0.005);
        tg.gain.exponentialRampToValueAtTime(0.0001, st + 0.16);
        to.connect(tg); tg.connect(this.master);
        to.start(st); to.stop(st + 0.2);
      }
    }
  }

  /** UI blip. */
  ui(kind = 'move') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = kind === 'confirm' ? 'square' : 'triangle';
    const f0 = kind === 'confirm' ? 520 : kind === 'back' ? 340 : 780;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(kind === 'back' ? f0 * 0.6 : f0 * 1.6, t + 0.09);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.16);
  }

  /** Race countdown beep / start horn. */
  countdown(final = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = final ? 880 : 440;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.setValueAtTime(0.2, t + (final ? 0.5 : 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.9 : 0.22));
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 1.0);
  }

  dispose() {
    for (const [id] of this.voices) this.dropEngine(id);
    this._squeal = null; this._nitro = null;
    this.ctx?.close();
    this.ctx = null; this.enabled = false;
  }
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
