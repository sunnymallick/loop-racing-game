#!/usr/bin/env node
/**
 * Audio capture harness. ART_DIRECTION.md §6.9 is judged by LISTENING to rendered clips, so this
 * writes real .wav files the audio critic can play, plus a numeric summary (peak, RMS, clipping,
 * spectral centroid) so a critic can also reason about the mix without ears.
 *
 *   node tools/audio.mjs --out shots/audio
 *   node tools/audio.mjs --cars muscle,supercar --kinds engine,nitrous --out shots/audio
 *
 * kinds: engine | idle | nitrous | impact | squeal
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boot, open, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1]; };

const OUT = path.resolve(ROOT, arg('out', 'shots/audio'));
const CARS = String(arg('cars', 'tuner,muscle,suv,supercar')).split(',');
const KINDS = String(arg('kinds', 'engine,nitrous,impact,squeal')).split(',');
const SECONDS = Number(arg('seconds', 5));

/** Decode a 16-bit PCM WAV and report the numbers a mix critic cares about. */
function analyse(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const n = (bytes.length - 44) / 2;
  let peak = 0, sumSq = 0, clipped = 0, zc = 0, prev = 0;
  let weighted = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(44 + i * 2, true) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a > 0.997) clipped++;
    sumSq += s * s;
    if ((s >= 0) !== (prev >= 0)) zc++;
    prev = s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  // zero-crossing rate is a cheap proxy for brightness / spectral centroid
  const zcr = (zc / Math.max(1, n)) * sampleRate * 0.5;
  void weighted; void total;
  return {
    seconds: +(n / sampleRate).toFixed(2),
    peak: +peak.toFixed(4),
    rms: +rms.toFixed(4),
    peakDb: +(20 * Math.log10(Math.max(1e-6, peak))).toFixed(1),
    rmsDb: +(20 * Math.log10(Math.max(1e-6, rms))).toFixed(1),
    crestDb: +(20 * Math.log10(Math.max(1e-6, peak / Math.max(1e-6, rms)))).toFixed(1),
    clippedSamples: clipped,
    brightnessHz: Math.round(zcr),
  };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const h = await boot({ width: 800, height: 450 });
  const report = [];
  try {
    await open(h.page, h.url, { city: 'la', car: CARS[0] });
    for (const car of CARS) {
      for (const kind of KINDS) {
        const b64 = await h.page.evaluate(
          ([k, s, c]) => window.__GAME.renderAudio(k, s, c),
          [kind, SECONDS, car],
        );
        const bytes = Buffer.from(b64, 'base64');
        const file = path.join(OUT, `${car}-${kind}.wav`);
        await fs.writeFile(file, bytes);
        const stats = analyse(new Uint8Array(bytes));
        report.push({ car, kind, file: path.relative(ROOT, file), ...stats });
        console.log(`  ✓ ${car}-${kind}.wav  peak ${stats.peakDb}dB  rms ${stats.rmsDb}dB  crest ${stats.crestDb}dB  bright ${stats.brightnessHz}Hz${stats.clippedSamples ? `  ⚠ ${stats.clippedSamples} CLIPPED` : ''}`);
      }
    }
    await fs.writeFile(path.join(OUT, 'audio-report.json'), JSON.stringify(report, null, 2));

    // cross-class comparison — §6.9 wants the four audibly distinct in CHARACTER, not just pitch
    const eng = report.filter((r) => r.kind === 'engine');
    if (eng.length > 1) {
      const bright = eng.map((r) => r.brightnessHz);
      const spread = Math.max(...bright) - Math.min(...bright);
      console.log(`\nengine brightness spread across classes: ${spread} Hz  [${eng.map((r) => `${r.car} ${r.brightnessHz}`).join(', ')}]`);
      console.log(spread > 250 ? '  → classes are spectrally distinct' : '  ⚠ classes sound too similar');
    }
    console.log(`\n${report.length} clip(s) → ${path.relative(process.cwd(), OUT)}`);
  } finally {
    await h.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
