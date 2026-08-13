import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GradeShader, SpeedShader } from './post.js';

/**
 * Renderer + post stack + camera rig.
 *
 * The post chain is owned by the LIGHTING piece (ART_DIRECTION.md §6.5). Its tunables live in
 * `engine.grade.uniforms` and `engine.bloom`, and each city pushes its own look via
 * `engine.applyLook(look)`.
 */
export class Engine {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,            // SMAA in the composer instead
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // tonemapping happens in GradeShader
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 6000);
    this.camera.position.set(0, 5, 12);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.72);
    this.composer.addPass(this.bloom);

    this.speed = new ShaderPass(SpeedShader);
    this.composer.addPass(this.speed);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.postEnabled = true;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize(w, h) {
    const width = w || this.container.clientWidth || window.innerWidth;
    const height = h || this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
    this.grade.uniforms.uResolution.value.set(width, height);
    this.speed.uniforms.uResolution.value.set(width, height);
  }

  /** A city look: {bloom:{strength,radius,threshold}, grade:{...uniform overrides}} */
  applyLook(look = {}) {
    if (look.bloom) {
      if (look.bloom.strength !== undefined) this.bloom.strength = look.bloom.strength;
      if (look.bloom.radius !== undefined) this.bloom.radius = look.bloom.radius;
      if (look.bloom.threshold !== undefined) this.bloom.threshold = look.bloom.threshold;
    }
    if (look.grade) {
      for (const [k, v] of Object.entries(look.grade)) {
        const u = this.grade.uniforms[k];
        if (!u) continue;
        if (u.value && u.value.isColor) u.value.set(v);
        else if (u.value && u.value.isVector3) u.value.fromArray(v);
        else u.value = v;
      }
    }
  }

  render(dt) {
    this.grade.uniforms.uTime.value += dt;
    this.speed.uniforms.uTime.value += dt;
    if (this.postEnabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.renderer.info.reset();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Recursively free GPU resources for a subtree — required so city swaps don't leak (§3.5). */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
  obj.parent?.remove(obj);
}
