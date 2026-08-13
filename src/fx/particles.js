import * as THREE from 'three';
import { RNG, clamp, lerp } from '../core/rng.js';

/**
 * Pooled particle system.
 *
 * ART_DIRECTION.md §7 caps "particles as unrotated camera-facing squares with visible hard edges"
 * at 58, so every particle carries its own rotation and rotation speed, and the fragment shader
 * rotates gl_PointCoord accordingly. Sizes are in world units and attenuate with distance.
 */

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aRot;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vRot;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uPixelRatio;
  uniform float uHeight;
  void main(){
    vRot = aRot; vAlpha = aAlpha; vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uHeight * uPixelRatio / max(0.001, -mv.z);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying float vRot;
  varying float vAlpha;
  varying vec3 vColor;
  void main(){
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = mat2(c, -s, s, c) * uv + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    vec4 t = texture2D(uMap, uv);
    gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

export class ParticleSystem {
  constructor({
    texture, max = 900, blending = THREE.AdditiveBlending, depthWrite = false,
    gravity = 0, drag = 0.8, renderOrder = 5,
  } = {}) {
    this.max = max;
    this.gravity = gravity;
    this.drag = drag;
    this.count = 0;

    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.active = new Uint8Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uHeight: { value: 540 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite, blending, depthTest: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this._c = new THREE.Color();
  }

  setViewportHeight(h) { this.material.uniforms.uHeight.value = h * 0.5; }

  emit({
    pos, vel = [0, 0, 0], life = 1, size = 1, grow = 0, rot = 0, rotV = 0,
    color = '#ffffff', alpha = 1,
  }) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.pos[i * 3] = pos[0] ?? pos.x; this.pos[i * 3 + 1] = pos[1] ?? pos.y; this.pos[i * 3 + 2] = pos[2] ?? pos.z;
    this.vel[i * 3] = vel[0] ?? vel.x ?? 0; this.vel[i * 3 + 1] = vel[1] ?? vel.y ?? 0; this.vel[i * 3 + 2] = vel[2] ?? vel.z ?? 0;
    this.life[i] = this.life0[i] = life;
    this.size[i] = this.size0[i] = size;
    this.grow[i] = grow;
    this.rot[i] = rot; this.rotV[i] = rotV;
    this.alpha[i] = this.alpha0[i] = alpha;
    if (typeof color === 'string') this._c.set(color); else this._c.copy(color);
    this.color[i * 3] = this._c.r; this.color[i * 3 + 1] = this._c.g; this.color[i * 3 + 2] = this._c.b;
    this.active[i] = 1;
    this.count = Math.max(this.count, i + 1);
    return i;
  }

  update(dt, wind = null) {
    const g = this.gravity * dt;
    const dragK = Math.exp(-this.drag * dt);
    let maxI = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.active[i]) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.active[i] = 0; this.alpha[i] = 0; this.size[i] = 0;
        this.free.push(i);
        continue;
      }
      const b = i * 3;
      this.vel[b + 1] += g;
      if (wind) { this.vel[b] += wind[0] * dt; this.vel[b + 1] += wind[1] * dt; this.vel[b + 2] += wind[2] * dt; }
      this.vel[b] *= dragK; this.vel[b + 1] *= dragK; this.vel[b + 2] *= dragK;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += this.vel[b + 2] * dt;
      this.rot[i] += this.rotV[i] * dt;
      const t = 1 - this.life[i] / this.life0[i];
      this.size[i] = this.size0[i] * (1 + this.grow[i] * t);
      // ease-out fade so particles don't blink off
      this.alpha[i] = this.alpha0[i] * (1 - t * t);
      maxI = i + 1;
    }
    this.count = maxI;
    this.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aRot.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
    }
  }

  clear() {
    this.free.length = 0;
    for (let i = this.max - 1; i >= 0; i--) { this.free.push(i); this.active[i] = 0; this.alpha[i] = 0; }
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

/**
 * Skid marks / tyre trails laid into the world as a growing ribbon.
 * The reference has black rubber arcs baked into the road behind every drifting pack.
 */
export class SkidTrails {
  constructor({ max = 4000, color = 0x0a0a0c, opacity = 0.55 } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.uv = new Float32Array(max * 2);
    this.alpha = new Float32Array(max);
    this.i = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
      vertexShader: `
        attribute float aAlpha; varying float vA; varying vec2 vUv;
        void main(){ vA = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity; varying float vA; varying vec2 vUv;
        void main(){
          float edge = smoothstep(0.0,0.22,vUv.x)*smoothstep(1.0,0.78,vUv.x);
          gl_FragColor = vec4(uColor, vA*uOpacity*edge);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this._last = new Map();
  }

  /** Append a quad segment for one wheel. `key` keeps each wheel's ribbon continuous. */
  add(key, pos, right, width, intensity) {
    const prev = this._last.get(key);
    const l = pos.clone().addScaledVector(right, -width * 0.5);
    const r = pos.clone().addScaledVector(right, width * 0.5);
    if (prev) {
      const verts = [prev.l, prev.r, l, prev.r, r, l];
      const uvs = [[0, 0], [1, 0], [0, 1], [1, 0], [1, 1], [0, 1]];
      for (let k = 0; k < 6; k++) {
        const i = this.i % this.max;
        this.pos[i * 3] = verts[k].x; this.pos[i * 3 + 1] = verts[k].y + 0.015; this.pos[i * 3 + 2] = verts[k].z;
        this.uv[i * 2] = uvs[k][0]; this.uv[i * 2 + 1] = uvs[k][1];
        this.alpha[i] = intensity;
        this.i++;
      }
      this.geometry.setDrawRange(0, Math.min(this.i, this.max));
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.uv.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
    }
    this._last.set(key, { l, r });
  }

  break(key) { this._last.delete(key); }
  clear() { this.i = 0; this._last.clear(); this.geometry.setDrawRange(0, 0); }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
