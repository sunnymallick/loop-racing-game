// Crop/zoom helper for looking at screenshots closely (builder tool, not shipped code).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const [inFile, x, y, w, h, scale = 2, outFile] = process.argv.slice(2);
const buf = await fs.readFile(path.resolve(inFile));
const b64 = buf.toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.round(w * scale), height: Math.round(h * scale) } });
await page.setContent(`<body style="margin:0"><canvas id=c width=${Math.round(w * scale)} height=${Math.round(h * scale)}></canvas>
<script>
const img = new Image();
img.onload = () => { const c = document.getElementById('c').getContext('2d'); c.imageSmoothingEnabled = false;
c.drawImage(img, ${x}, ${y}, ${w}, ${h}, 0, 0, ${Math.round(w * scale)}, ${Math.round(h * scale)}); window.__done = 1; };
img.src = 'data:image/png;base64,${b64}';
</script></body>`);
await page.waitForFunction('window.__done === 1');
await page.screenshot({ path: path.resolve(outFile || 'crop.png') });
await browser.close();
