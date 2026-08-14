/**
 * HF-air probe for the audio piece (round 3).  The r2 critic's single named gap was
 * "every source in the game is lowpassed — no air above ~5 kHz".  Their metric was
 * "energy above 10 kHz, in dB relative to full-band energy", measured per clip.
 * This reproduces that metric plus a per-octave breakdown so a change is measurable.
 *
 *   node tools/_audio_hf.mjs shots/audio-r3/*.wav
 */
import fs from 'node:fs';
import path from 'node:path';

function readWav(file) {
  const b = fs.readFileSync(file);
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24);
  let off = 12, dataSz = 0;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4); const sz = b.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; dataSz = sz; break; }
    off += 8 + sz;
  }
  const n = Math.floor(dataSz / 2 / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + i * ch * 2) / 32768;
  return { sr, ch, n, x };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const c = Math.cos(ang * k), s = Math.sin(ang * k);
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
      const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
    }
  }
}

const BANDS = [[0, 200], [200, 1200], [1200, 5000], [5000, 10000], [10000, 22050]];
const rows = [];
for (const file of process.argv.slice(2)) {
  const { sr, n, x } = readWav(file);
  const N = 4096, hop = 2048;
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N < n; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = x[s + i] * w; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
  }
  const be = BANDS.map(([a, b]) => {
    let t = 0;
    for (let i = Math.round((a * N) / sr); i < Math.min(N / 2, Math.round((b * N) / sr)); i++) t += acc[i];
    return t;
  });
  const tot = be.reduce((p, q) => p + q, 0) + 1e-18;
  const db = (v) => (10 * Math.log10(v / tot)).toFixed(1);
  // frames whose 5k+ share exceeds 2% — "does it ever have air", not just on average
  let airyFrames = 0;
  for (let s = 0; s + N < n; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = x[s + i] * w; }
    fft(re, im);
    let hi = 0, all = 0;
    for (let i = 1; i < N / 2; i++) { const p = re[i] * re[i] + im[i] * im[i]; all += p; if ((i * sr) / N > 5000) hi += p; }
    if (hi / (all + 1e-18) > 0.02) airyFrames++;
  }
  rows.push({
    name: path.basename(file, '.wav'),
    lo: db(be[0]), mid: db(be[1]), pres: db(be[2]), hi5: db(be[3]), hi10: db(be[4]),
    airy: `${Math.round((100 * airyFrames) / Math.max(1, frames))}%`,
  });
}
const hdr = ['clip', '0-200', '.2-1.2k', '1.2-5k', '5-10k', '>10k', 'airy'];
const w = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
console.log(hdr.map((h, i) => h.padEnd(w[i])).join('  '));
for (const r of rows) console.log(Object.values(r).map((v, i) => String(v).padEnd(w[i])).join('  '));
