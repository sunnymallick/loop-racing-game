// scratch probe for the lighting/post builder — inspects env maps + road materials at runtime
import { boot, open, load } from './harness.mjs';

const city = process.argv[2] || 'nyc';
const h = await boot({ width: 800, height: 450 });
try {
  for (let i = 0; i < 5; i++) {
    try {
      await open(h.page, h.url, { city, car: 'supercar' });
      await load(h.page, { city, car: 'supercar' });
      break;
    } catch (e) { console.error('retry', i, e.message.slice(0, 80)); await new Promise((r) => setTimeout(r, 1500)); }
  }
  const out = await h.page.evaluate(() => {
    const g = window.__GAME.game;
    const env = g.city.envMap;
    const seen = new Map();
    let meshes = 0, withEnv = 0, physical = 0;
    g.engine.scene.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.envMap) withEnv++;
        if (m.isMeshPhysicalMaterial) physical++;
        const key = o.name || m.name || m.type;
        if (!seen.has(key)) {
          seen.set(key, {
            name: key, type: m.type,
            rough: m.roughness, metal: m.metalness,
            rmap: !!m.roughnessMap,
            envI: m.envMapIntensity,
            env: m.envMap === env ? 'city' : m.envMap ? 'other' : 'NONE',
            cc: m.clearcoat, ccr: m.clearcoatRoughness,
          });
        }
      }
    });
    return {
      envMap: env ? { mapping: env.mapping, w: env.image?.width, h: env.image?.height, type: env.type } : null,
      sceneEnv: !!g.engine.scene.environment,
      envIntensity: g.engine.scene.environmentIntensity,
      meshes, withEnv, physical,
      grade: Object.fromEntries(Object.entries(g.engine.grade.uniforms).map(([k, v]) => [k, v.value?.isColor ? `#${v.value.getHexString()}` : (typeof v.value === 'number' ? +v.value.toFixed(4) : undefined)]).filter(([, v]) => v !== undefined)),
      bloom: { th: g.engine.bloom.threshold, st: g.engine.bloom.strength, r: g.engine.bloom.radius },
      exposure: g.engine.atmos.uniforms.uExposure.value,
      night: g.engine.night,
      mats: [...seen.values()].filter((m) => /road|asphalt|lane|paint|body|curb|shoulder|mark/i.test(m.name) || m.env === 'city').slice(0, 40),
      errors: window.__ERRORS,
    };
  });
  console.log(JSON.stringify(out, null, 1));
  console.log(h.logs.slice(0, 20).join('\n'));
} finally { await h.close(); }
