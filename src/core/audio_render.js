import { EngineVoice, makeNoiseBuffer, bufferToWav } from './audio.js';
import { clamp, lerp } from './rng.js';

/**
 * Offline audio rendering for the audio critic (ART_DIRECTION.md §6.9 is judged by LISTENING to
 * captured WAV renders).
 *
 * An OfflineAudioContext's currentTime stays at 0 until rendering begins, so the live code path's
 * `setTargetAtTime(v, ctx.currentTime, tc)` would schedule every update at t=0 and only the last
 * one would survive — the render would be a static tone. Everything here therefore schedules
 * automation at EXPLICIT future times.
 */

/** @returns {Promise<Uint8Array>} WAV bytes */
export async function renderClip(kind, seconds, spec, { sampleRate = 44100 } = {}) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.ceil(sampleRate * seconds), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 24; comp.ratio.value = 5;
  comp.attack.value = 0.004; comp.release.value = 0.22;
  master.connect(comp); comp.connect(ctx.destination);

  if (kind === 'engine' || kind === 'engine-sweep') {
    scheduleEngineSweep(ctx, master, spec, seconds);
  } else if (kind === 'idle') {
    scheduleEngineSweep(ctx, master, spec, seconds, { from: 0, to: 0.06, throttle: 0.12 });
  } else if (kind === 'nitrous') {
    scheduleEngineSweep(ctx, master, spec, seconds, { from: 0.55, to: 1.0 });
    scheduleNitrous(ctx, master, 0.6, seconds - 1.0);
  } else if (kind === 'impact') {
    for (let i = 0; i < 4; i++) scheduleImpact(ctx, master, 0.3 + i * 1.0, 0.25 + i * 0.25);
  } else if (kind === 'squeal') {
    scheduleSqueal(ctx, master, 0.2, seconds - 0.4);
  } else {
    throw new Error(`Unknown audio clip kind "${kind}"`);
  }

  const buf = await ctx.startRendering();
  return bufferToWav(buf);
}

/** A full idle → redline pull, with gear shifts, scheduled across the clip. */
function scheduleEngineSweep(ctx, dest, spec, seconds, { from = 0, to = 1, throttle = 1 } = {}) {
  const v = new EngineVoice(ctx, dest, spec);
  const a = spec.audio;
  const STEPS = Math.max(40, Math.floor(seconds * 40));
  const gears = 6;

  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * seconds;
    const prog = lerp(from, to, i / STEPS);
    // sawtooth within each gear so the pull sounds like shifts, not one long ramp
    const g = Math.min(gears - 1, Math.floor(prog * gears));
    const inGear = (prog * gears) - g;
    const rpm = a.idleRpm + (a.redline - a.idleRpm) * clamp(0.22 + inGear * 0.78, 0, 1);
    const shifting = inGear < 0.06 && g > 0;

    const fire = (rpm / 60) * (a.cylinders / 2);
    const base = clamp(fire, 12, 460);
    for (let h = 0; h < v.oscs.length; h++) {
      v.oscs[h].frequency.setTargetAtTime(base * (h + 1), t, 0.018);
    }
    const norm = (rpm - a.idleRpm) / (a.redline - a.idleRpm);
    const thr = shifting ? 0.15 : throttle;
    v.filter.frequency.setTargetAtTime(v.ch.cutBase + v.ch.cutSpan * clamp(norm, 0, 1) * (0.45 + 0.55 * thr), t, 0.03);
    v.body.frequency.setTargetAtTime(lerp(120, 260, clamp(norm, 0, 1)), t, 0.05);
    v.noiseFilter.frequency.setTargetAtTime(lerp(300, 2600, clamp(norm, 0, 1)), t, 0.04);
    v.noiseGain.gain.setTargetAtTime(v.ch.noise * (0.18 + 0.62 * thr) * (0.35 + 0.65 * clamp(norm, 0, 1)), t, 0.04);
    v.lfo.frequency.setTargetAtTime(lerp(6, 26, clamp(norm, 0, 1)), t, 0.08);
    v.blowGain.gain.setTargetAtTime(v.ch.blow * 0.012 * clamp(norm, 0, 1) * thr, t, 0.05);
    v.blow.frequency.setTargetAtTime(lerp(1600, 5200, clamp(norm, 0, 1)), t, 0.06);
    v.out.gain.setTargetAtTime((0.10 + 0.30 * thr + 0.30 * clamp(norm, 0, 1)) * (shifting ? 0.45 : 1), t, shifting ? 0.012 : 0.05);
  }
  return v;
}

function scheduleNitrous(ctx, dest, start, dur) {
  const n = ctx.createBufferSource();
  n.buffer = makeNoiseBuffer(ctx, 0.7, { seed: 33, kind: 'white' });
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 2.2;
  f.frequency.setValueAtTime(280, start);
  f.frequency.exponentialRampToValueAtTime(4200, start + 0.18);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.42, start + 0.035);
  g.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
  n.connect(f); f.connect(g); g.connect(dest);
  n.start(start); n.stop(start + 0.7);

  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(120, start);
  o.frequency.exponentialRampToValueAtTime(38, start + 0.30);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.5, start);
  og.gain.exponentialRampToValueAtTime(0.0001, start + 0.40);
  o.connect(og); og.connect(dest);
  o.start(start); o.stop(start + 0.45);

  const roar = ctx.createBufferSource();
  roar.buffer = makeNoiseBuffer(ctx, Math.max(1, dur + 0.5), { seed: 44, kind: 'white' });
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(700, start);
  hp.frequency.linearRampToValueAtTime(2100, start + dur);
  const pk = ctx.createBiquadFilter();
  pk.type = 'peaking'; pk.frequency.value = 2600; pk.Q.value = 1.6; pk.gain.value = 9;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, start);
  rg.gain.linearRampToValueAtTime(0.20, start + 0.12);
  rg.gain.setValueAtTime(0.20, start + dur - 0.15);
  rg.gain.linearRampToValueAtTime(0.0001, start + dur);
  roar.connect(hp); hp.connect(pk); pk.connect(rg); rg.connect(dest);
  roar.start(start); roar.stop(start + dur + 0.2);
}

function scheduleImpact(ctx, dest, t, s) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(90 + 60 * s, t);
  o.frequency.exponentialRampToValueAtTime(32, t + 0.18);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.55 * s, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
  o.connect(og); og.connect(dest);
  o.start(t); o.stop(t + 0.32);

  const n = ctx.createBufferSource();
  n.buffer = makeNoiseBuffer(ctx, 0.45, { seed: 55 + Math.floor(s * 20), kind: 'white' });
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 900 + 2600 * s; f.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.45 * s, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + 0.2 * s);
  n.connect(f); f.connect(g); g.connect(dest);
  n.start(t); n.stop(t + 0.45);
}

function scheduleSqueal(ctx, dest, start, dur) {
  const n = ctx.createBufferSource();
  n.buffer = makeNoiseBuffer(ctx, dur + 0.5, { seed: 21, kind: 'white' });
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 9;
  f.frequency.setValueAtTime(1200, start);
  f.frequency.linearRampToValueAtTime(3200, start + dur * 0.5);
  f.frequency.linearRampToValueAtTime(1500, start + dur);
  const f2 = ctx.createBiquadFilter();
  f2.type = 'bandpass'; f2.frequency.value = 3400; f2.Q.value = 14;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(0.16, start + 0.12);
  g.gain.setValueAtTime(0.16, start + dur - 0.2);
  g.gain.linearRampToValueAtTime(0.0001, start + dur);
  n.connect(f); f.connect(f2); f2.connect(g); g.connect(dest);
  n.start(start); n.stop(start + dur + 0.2);
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
