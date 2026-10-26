import * as THREE from 'three';

// A violet haze in the mirrored waiting room on dream circuits: thickest on
// the floor and thinning upward, lit from the stage light over the double
// chair, drifting slowly. It is a volume, not a screen effect: each pixel takes
// the part of its line of sight that crosses the room (a box) and the haze
// along it, so the room seen from the corridor is full of it too. Added to
// three.js's own fog step, so every fogged material shares it; each material
// gets the shared values through `createHaze`.

const PARS_VERTEX = `
#ifdef USE_FOG
  varying vec3 vHazeWorld;
#endif
`;
// Back from view space: the view matrix is rigid, its inverse rotation its transpose.
const VERTEX = `
#ifdef USE_FOG
  vHazeWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`;
const PARS_FRAGMENT = `
#ifdef USE_FOG
  uniform vec3 hazeMin;
  uniform vec3 hazeMax;
  uniform vec3 hazeColor;
  uniform vec3 hazeLight;
  uniform float hazeStrength;
  uniform float hazeTime;
  varying vec3 vHazeWorld;
  float hazeHash(vec2 p){p=fract(p*vec2(0.1031,0.1030));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x);}
  float hazeNoise(vec2 x){
    vec2 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
    return mix(mix(hazeHash(i),hazeHash(i+vec2(1,0)),f.x),mix(hazeHash(i+vec2(0,1)),hazeHash(i+vec2(1,1)),f.x),f.y);
  }
  vec3 applyHaze(vec3 color){
    if(hazeStrength<0.001)return color;
    vec3 ray=vHazeWorld-cameraPosition;
    // Where the line of sight enters and leaves the room, as fractions of it.
    vec3 inverse=1.0/(ray+vec3(equal(ray,vec3(0.0)))*1e-6);
    vec3 a=(hazeMin-cameraPosition)*inverse,b=(hazeMax-cameraPosition)*inverse;
    vec3 near=min(a,b),far=max(a,b);
    float enter=max(max(near.x,near.y),max(near.z,0.0)),leave=min(min(far.x,far.y),min(far.z,1.0));
    if(leave<=enter)return color;
    vec3 from=cameraPosition+ray*enter,to=cameraPosition+ray*leave;
    // Thick on the floor, thinning upward: exp(-height / 0.6 m), averaged along the way.
    float rise=to.y-from.y;
    float low=abs(rise)>1e-3?0.6*(exp(-from.y/0.6)-exp(-to.y/0.6))/rise:exp(-from.y/0.6);
    vec2 middle=(from.xz+to.xz)*0.5;
    float drift=0.65+0.7*hazeNoise(middle*0.4+vec2(hazeTime*0.03,-hazeTime*0.017));
    float pool=0.6+0.9*hazeNoise(to.xz*0.9+vec2(-hazeTime*0.045,hazeTime*0.028));
    float span=(leave-enter)*length(ray);
    float depth=span*(0.016+0.24*low*pool)*drift*hazeStrength;
    // The stage light's column over the double chair: a soft-edged shaft the
    // haze shows as smoke shows a spotlight, dissolving upward into the dark.
    // The line of sight crosses it for the length of its chord, shortened at
    // the edges.
    vec2 sweep=to.xz-from.xz;
    float t=clamp(dot(hazeLight.xy-from.xz,sweep)/max(dot(sweep,sweep),1e-6),0.0,1.0);
    float miss=length(from.xz+sweep*t-hazeLight.xy),radius=sqrt(hazeLight.z)*0.6;
    float chord=2.0*sqrt(max(radius*radius-miss*miss,0.0))*length(ray)/max(length(ray.xz),1e-3);
    float height=from.y+(to.y-from.y)*t;
    float shaft=min(chord,span)*0.05*exp(-miss*miss/(radius*radius))*smoothstep(6.5,2.0,height)*hazeStrength;
    float through=exp(-depth-shaft);
    // Brighter where the line of sight passes under the light, and higher up.
    vec2 off=middle-hazeLight.xy;
    float glow=exp(-dot(off,off)/hazeLight.z)*(0.6+0.4*smoothstep(0.0,2.5,max(from.y,to.y)));
    vec3 lit=(depth*hazeColor*(0.22+1.8*glow)+shaft*(hazeColor*2.4+vec3(0.02)))/max(depth+shaft,1e-5);
    return color*through+lit*(1.0-through);
  }
#endif
`;
const FRAGMENT = `
#ifdef USE_FOG
  gl_FragColor.rgb = applyHaze(gl_FragColor.rgb);
#endif
`;

let installed = false;
// Must run before the first material compiles.
export function installHaze() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex += PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex += VERTEX;
  THREE.ShaderChunk.fog_pars_fragment += PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment += FRAGMENT;
}

// `box` is the room [[minX, minZ], [maxX, maxZ]] up to `height`, `light` the
// stage light's [x, z] and the spread of its glow in square metres.
export function createHaze(scene, { box = [[-11.8, 16.6], [-2.2, 25]], height = 7.5, light = [-7, 22.5, 5], color = [0.3, 0.09, 0.46] } = {}) {
  const uniforms = {
    hazeMin: { value: new THREE.Vector3(box[0][0], 0, box[0][1]) },
    hazeMax: { value: new THREE.Vector3(box[1][0], height, box[1][1]) },
    hazeColor: { value: new THREE.Vector3(...color) },
    hazeLight: { value: new THREE.Vector3(...light) },
    hazeStrength: { value: 0 },
    hazeTime: { value: 0 },
  };
  // Every fogged material in the scene takes the shared values.
  const done = new WeakSet();
  scene.traverse(object => {
    for (const material of [object.material].flat()) {
      if (!material?.fog || done.has(material)) continue;
      done.add(material);
      const own = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile') ? material.onBeforeCompile : null;
      material.onBeforeCompile = (shader, renderer) => { own?.call(material, shader, renderer); Object.assign(shader.uniforms, uniforms); };
      const key = material.customProgramCacheKey.bind(material);
      material.customProgramCacheKey = () => `${key()}|haze`;
      material.needsUpdate = true;
    }
  });
  let target = 0;
  return {
    uniforms,
    // In with a dream circuit, out with an ordinary one.
    setDream(dream, { now = false } = {}) {
      target = dream ? 1 : 0;
      if (now) uniforms.hazeStrength.value = target;
    },
    update(dt, seconds) {
      uniforms.hazeTime.value = seconds;
      uniforms.hazeStrength.value += (target - uniforms.hazeStrength.value) * (1 - Math.exp(-Math.max(0, dt) / 0.8));
    },
    inspect: () => ({ strength: uniforms.hazeStrength.value, target }),
  };
}
