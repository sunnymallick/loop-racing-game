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
  const chans = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) chans[c][i] = b.readInt16LE(off + (i * ch + c) * 2) / 32768;
  return { sr, ch, n, chans };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(ang * k), s = Math.sin(ang * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s; const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
}
function mags(x, start, N) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = (x[start + i] || 0) * w; } fft(re, im); const m = new Float64Array(N / 2); for (let i = 0; i < N / 2; i++) m[i] = Math.hypot(re[i], im[i]); return m; }

for (const file of process.argv.slice(2)) {
  const { sr, ch, n, chans } = readWav(file);
  const x = chans[0];
  const N = 4096, hop = Math.floor(sr * 0.04);
  console.log(`\n=== ${path.basename(file)} ch=${ch} ${(n / sr).toFixed(2)}s`);
  let line = '';
  const bandsDef = [[0, 200], [200, 1200], [1200, 5000], [5000, 20000]];
  for (let s = 0; s + N < n; s += hop) {
    let r = 0; for (let i = 0; i < N; i++) r += x[s + i] ** 2; r = Math.sqrt(r / N);
    const m = mags(x, s, N);
    // peak freq above 60 Hz
    let pk = 0, pkf = 0;
    for (let i = Math.round(60 * N / sr); i < m.length; i++) if (m[i] > pk) { pk = m[i]; pkf = i * sr / N; }
    const be = bandsDef.map(([a, b2]) => { let t = 0; for (let i = Math.round(a * N / sr); i < Math.round(b2 * N / sr) && i < m.length; i++) t += m[i] * m[i]; return t; });
    const tot = be.reduce((p, q) => p + q, 0) + 1e-12;
    line += `${(s / sr).toFixed(2)}|${(20 * Math.log10(r + 1e-9)).toFixed(0)}dB|${Math.round(pkf)}Hz|${be.map(v => Math.round(100 * v / tot)).join('/')}  `;
  }
  console.log('  t|rms|peakF|band%(0-200/200-1.2k/1.2-5k/5k+)');
  console.log('  ' + line.replace(/(.{200})/g, '$1\n  '));
  if (ch === 2) {
    const L = chans[0], R = chans[1], win = Math.floor(sr * 0.2);
    let s2 = '';
    for (let i = 0; i + win < n; i += win) { let el = 0, er = 0; for (let k = 0; k < win; k++) { el += L[i + k] ** 2; er += R[i + k] ** 2; } s2 += `${(i / sr).toFixed(1)}:${((er - el) / (er + el + 1e-9)).toFixed(2)} `; }
    console.log('  L/R bal: ' + s2);
  }
}
