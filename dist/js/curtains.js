import * as THREE from 'three';
import {prepareCurtainSurfaces} from './curtain-surfaces.js';
import {createCurtainMotion} from './curtain-motion.js';

const PULSES=6;
// Metres of sway at the free hem; the summed waves stay within about 1 cm.
const BREATH=.0055;

// The baked velvet stays on the original mesh. A handful of local impulses
// deform it on the GPU; no extra render passes or per-frame vertex uploads.
export function createCurtainInteraction(models,{reducedMotion=false}={}) {
  const {panels,meshes}=prepareCurtainSurfaces(models);
  const motion=createCurtainMotion(panels,{maxImpulses:PULSES});
  const positions=Array.from({length:PULSES},()=>new THREE.Vector4(0,0,0,-1));
  const impulses=Array.from({length:PULSES},()=>new THREE.Vector4());
  const time={value:0},breath={value:reducedMotion?0:BREATH};
  const activePanels=new Set();
  const dream=new Set();
  models.dreamCurtains?.traverse(object=>dream.add(object));
  for(const mesh of meshes){
    const material=mesh.material.clone();
    const inverse=new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
    // The violet dream curtains keep their authored colour.
    const red=!dream.has(mesh);
    material.customProgramCacheKey=()=> red?'local-velvet-response-v2|red':'local-velvet-response-v2|dream';
    material.onBeforeCompile=shader=>{
      shader.uniforms.uCurtainPosition={value:positions};
      shader.uniforms.uCurtainImpulse={value:impulses};
      shader.uniforms.uCurtainWorldToLocal={value:inverse};
      shader.uniforms.uCurtainTime=time;
      shader.uniforms.uCurtainBreath=breath;
      shader.vertexShader=`
        attribute vec4 curtainSurface;
        uniform vec4 uCurtainPosition[${PULSES}];
        uniform vec4 uCurtainImpulse[${PULSES}];
        uniform mat3 uCurtainWorldToLocal;
        uniform float uCurtainTime;
        uniform float uCurtainBreath;
        varying float vCurtainBend;
      `+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        vec3 clothWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
        float bend=0.0;
        for(int i=0;i<${PULSES};i++){
          if(abs(curtainSurface.w-uCurtainPosition[i].w)<0.25 && uCurtainImpulse[i].z>0.0){
            float distanceXZ=length(clothWorld.xz-uCurtainPosition[i].xz);
            float support=1.0-smoothstep(0.12,1.15,distanceXZ);
            float heightDistance=abs(clothWorld.y-uCurtainPosition[i].y);
            float age=max(0.0,uCurtainImpulse[i].w-heightDistance*0.085-distanceXZ*0.12);
            float envelope=sin(age*7.8)*exp(-age*1.6);
            float heightFalloff=0.4+0.6*(1.0-smoothstep(0.2,2.0,heightDistance));
            bend+=dot(curtainSurface.xy,uCurtainImpulse[i].xy)*
              uCurtainImpulse[i].z*envelope*support*heightFalloff;
          }
        }
        // Soft saturation prevents overlapping pushes stretching the curtain.
        bend=(0.18*bend/(0.18+abs(bend)))*curtainSurface.z;
        // The room breathes: two slow waves travel along the folds (periods of
        // about 9 s and 5.6 s), largest at the free hem, zero where pinned.
        float breath=(sin(dot(clothWorld.xz,vec2(0.83,0.56))*1.7-uCurtainTime*0.71)
          +0.6*sin(dot(clothWorld.xz,vec2(-0.47,0.88))*2.9-uCurtainTime*1.13+1.7))*uCurtainBreath*curtainSurface.z;
        transformed+=uCurtainWorldToLocal*vec3(curtainSurface.x*(bend+breath),0.0,curtainSurface.y*(bend+breath));
        vCurtainBend=bend+breath*4.0;
      `);
      shader.fragmentShader='varying float vCurtainBend;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        ${red?`
          // The 1991 velvet is a pure, deep red. Pull the baked green / blue
          // spill out and add a little contrast around the mid-tones.
          diffuseColor.rgb*=1.44*pow(max(diffuseColor.r,1e-4),0.3);
          diffuseColor.g=min(diffuseColor.g,diffuseColor.r)*0.16;
          diffuseColor.b=min(diffuseColor.b,diffuseColor.r)*0.14;
        `:''}
        diffuseColor.rgb*=1.0+vCurtainBend*0.7;
      `);
    };
    mesh.material=material;
  }
  function visible(mesh){
    for(let object=mesh;object;object=object.parent)if(!object.visible)return false;
    return true;
  }
  function syncUniforms(){
    for(let i=0;i<PULSES;i++){
      const pulse=motion.impulses[i];
      if(pulse?.active){
        positions[i].set(pulse.position.x,pulse.position.y,pulse.position.z,pulse.panelId);
        impulses[i].set(pulse.direction.x,pulse.direction.z,pulse.strength,pulse.age);
      }else{
        positions[i].w=-1;
        impulses[i].set(0,0,0,0);
      }
    }
  }
  return {
    panels,meshes,motion,
    update(dt,sources){
      if(Number.isFinite(dt)&&dt>0)time.value+=dt;
      activePanels.clear();
      for(const panel of panels)if(visible(panel.mesh))activePanels.add(panel.id);
      motion.update(dt,sources,activePanels);
      syncUniforms();
    },
    // Contact waves stop; the ambient breathing keeps its own clock.
    reset(){motion.reset();syncUniforms();},
    inspect(){return {...motion.inspect(),meshes:meshes.length,panels:activePanels.size,breath:breath.value,breathTime:time.value,extraDrawCalls:0};},
  };
}
