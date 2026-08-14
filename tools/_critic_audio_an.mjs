// critic-side analysis: read WAVs, do STFT, track f0, report harmonic structure + envelope
import fs from 'node:fs';
import path from 'node:path';

function readWav(file) {
  const b = fs.readFileSync(file);
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24);
  // find data chunk
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; var dataSz = sz; break; }
    off += 8 + sz;
  }
  const n = Math.floor(dataSz / 2 / ch);
  const chans = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) chans[c][i] = b.readInt16LE(off + (i * ch + c) * 2) / 32768;
  return { sr, ch, n, chans };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k), s = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function spectrum(x, start, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    re[i] = (x[start + i] || 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

// autocorrelation f0 on a frame, range 30..500 Hz
function f0(x, start, N, sr) {
  const buf = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) { buf[i] = x[start + i] || 0; mean += buf[i]; }
  mean /= N;
  for (let i = 0; i < N; i++) buf[i] -= mean;
  const minLag = Math.floor(sr / 500), maxLag = Math.floor(sr / 25);
  let best = 0, bestLag = 0, e0 = 0;
  for (let i = 0; i < N; i++) e0 += buf[i] * buf[i];
  for (let lag = minLag; lag <= maxLag && lag < N; lag++) {
    let s = 0;
    for (let i = 0; i < N - lag; i++) s += buf[i] * buf[i + lag];
    s /= (N - lag);
    if (s > best) { best = s; bestLag = lag; }
  }
  const norm = best / (e0 / N + 1e-12);
  return { hz: bestLag ? sr / bestLag : 0, conf: norm };
}

function analyse(file) {
  const { sr, ch, n, chans } = readWav(file);
  const x = chans[0];
  const N = 4096;
  const hop = Math.floor(sr * 0.05);
  const frames = [];
  for (let s = 0; s + N < n; s += hop) {
    let rms = 0;
    for (let i = 0; i < N; i++) rms += x[s + i] * x[s + i];
    rms = Math.sqrt(rms / N);
    const mag = spectrum(x, s, N);
    let sum = 0, wsum = 0, low = 0, mid = 0, high = 0;
    for (let i = 1; i < N / 2; i++) {
      const f = i * sr / N, m = mag[i];
      sum += m; wsum += m * f;
      if (f < 250) low += m; else if (f < 2500) mid += m; else high += m;
    }
    const cent = sum > 0 ? wsum / sum : 0;
    const p = f0(x, s, 2048, sr);
    frames.push({ t: s / sr, rms, cent, f0: p.hz, conf: p.conf, low, mid, high });
  }
  return { sr, ch, n, frames, x, chans };
}

const dir = process.argv[2];
const files = process.argv.slice(3);
for (const f of files) {
  const file = path.join(dir, f);
  const a = analyse(file);
  const fr = a.frames;
  const dbs = fr.map(r => 20 * Math.log10(r.rms + 1e-9));
  console.log(`\n=== ${f}  sr=${a.sr} ch=${a.ch} dur=${(a.n / a.sr).toFixed(2)}s`);
  const rows = fr.filter((_, i) => i % 4 === 0);
  console.log('  t    rmsdB  cent  f0(conf)  lo/mid/hi%');
  for (const r of rows) {
    const tot = r.low + r.mid + r.high + 1e-9;
    console.log(`  ${r.t.toFixed(2)}  ${(20 * Math.log10(r.rms + 1e-9)).toFixed(1).padStart(6)}  ${Math.round(r.cent).toString().padStart(5)}  ${r.f0.toFixed(1).padStart(6)}(${r.conf.toFixed(2)})  ${(100 * r.low / tot).toFixed(0)}/${(100 * r.mid / tot).toFixed(0)}/${(100 * r.high / tot).toFixed(0)}`);
  }
  console.log(`  rms range ${Math.min(...dbs).toFixed(1)} .. ${Math.max(...dbs).toFixed(1)} dB`);
  if (a.ch === 2) {
    // stereo: correlation + per-channel energy over time
    const L = a.chans[0], R = a.chans[1];
    const win = Math.floor(a.sr * 0.25);
    let s = '';
    for (let i = 0; i + win < a.n; i += win) {
      let el = 0, er = 0;
      for (let k = 0; k < win; k++) { el += L[i + k] ** 2; er += R[i + k] ** 2; }
      const bal = (er - el) / (er + el + 1e-9);
      s += `${(i / a.sr).toFixed(1)}:${bal >= 0 ? '+' : ''}${bal.toFixed(2)} `;
    }
    console.log('  L/R balance (-1=L,+1=R): ' + s);
  }
}
