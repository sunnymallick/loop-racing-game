import * as THREE from 'three';

/**
 * Colour grade + tonemap + vignette + chromatic aberration.
 * Owned by the LIGHTING/POST piece. ART_DIRECTION.md §2.1: filmic rolloff, saturation lift,
 * tinted (never crushed) shadows, S-curve contrast, 15–25% corner vignette.
 */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uExposure: { value: 1.05 },
    uSaturation: { value: 1.18 },
    uContrast: { value: 1.08 },
    uLift: { value: new THREE.Color(0x0a0c16) },   // shadow tint — never pure black
    uGain: { value: new THREE.Color(0xfff4e8) },   // highlight tint
    uVignette: { value: 0.22 },
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.022 },
    uBoost: { value: 0.0 },                        // 0..1, driven by nitrous
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uExposure, uSaturation, uContrast, uVignette, uAberration, uGrain, uBoost;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    // ACES-ish filmic curve: highlights roll off instead of clipping flat.
    vec3 aces(vec3 x){
      const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
      return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
    }

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c,c);

      // radial chromatic aberration, stronger under boost
      float ab = uAberration * (1.0 + uBoost*5.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c*ab*1.6).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c*ab*1.6).b;

      col *= uExposure * (1.0 + uBoost*0.14);
      col = aces(col);

      // lift/gain — coloured shadows and highlights
      col = mix(uLift, uGain, col);

      float l = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(l), col, uSaturation * (1.0 + uBoost*0.22));
      col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);

      // vignette, tightened during boost for a tunnel feel
      float vig = 1.0 - uVignette*(1.0+uBoost*1.1) * smoothstep(0.12, 0.85, r2*1.9);
      col *= vig;

      col += (hash(uv*uResolution + uTime) - 0.5) * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Radial speed blur + speed lines. Intensity is driven by velocity and nitrous.
 * Cheap 8-tap radial smear — enough to sell velocity without a velocity buffer.
 */
export const SpeedShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uAmount: { value: 0.0 },   // 0..1 radial blur
    uLines: { value: 0.0 },    // 0..1 streak overlay
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uTint: { value: new THREE.Color(0x8fd4ff) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution, uCenter;
    uniform float uTime, uAmount, uLines;
    uniform vec3 uTint;
    varying vec2 vUv;

    float hash(float n){ return fract(sin(n)*43758.5453); }

    void main(){
      vec2 dir = vUv - uCenter;
      float d = length(dir);
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      if (uAmount > 0.001){
        float w = uAmount * smoothstep(0.10, 0.75, d);
        vec3 acc = vec3(0.0); float tot = 0.0;
        for (int i=0;i<8;i++){
          float t = float(i)/7.0;
          float s = 1.0 - t*w*0.14;
          float wt = 1.0 - t*0.55;
          acc += texture2D(tDiffuse, uCenter + dir*s).rgb * wt;
          tot += wt;
        }
        col = mix(col, acc/tot, smoothstep(0.0,1.0,uAmount));
      }

      if (uLines > 0.001){
        float a = atan(dir.y, dir.x);
        float n = hash(floor(a*46.0));
        float streak = smoothstep(0.80, 1.0, hash(floor(a*46.0)+floor(uTime*24.0)*0.013));
        float mask = smoothstep(0.20, 0.70, d) * streak * uLines;
        col += uTint * mask * (0.55 + 0.45*n);
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
