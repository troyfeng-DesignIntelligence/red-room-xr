import * as THREE from 'three';
import {prepareCurtainSurfaces} from './curtain-surfaces.js';
import {createCurtainMotion} from './curtain-motion.js';

const PULSES=6;
// Metres of sway at the free hem; the summed waves stay within about 1 cm.
const BREATH=.0055;
const VELVET_VARYINGS=`
  varying vec3 vCurtainWorld;
  varying vec3 vCurtainNormal;
  varying vec4 vCurtainFrame;
  varying float vCurtainPanel;
  varying float vCurtainCorner;
`;
const VELVET_FUNCTIONS=`
  float velvetHash(vec2 p){p=fract(p*vec2(0.1031,0.1030));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x);}
  float velvetNoise(vec2 x){
    vec2 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
    return mix(mix(velvetHash(i),velvetHash(i+vec2(1,0)),f.x),mix(velvetHash(i+vec2(0,1)),velvetHash(i+vec2(1,1)),f.x),f.y);
  }
`;
// The cloth's own shape and touch, evaluated in the vertex shader: a value
// noise for unevenness, and every push on the cloth (contact waves and a
// visitor standing close) at a world point, softly limited to about 32 cm.
const CLOTH_FUNCTIONS=`
  float clothHash(vec2 p){p=fract(p*vec2(0.1031,0.1030));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x);}
  float clothNoise(vec2 x){
    vec2 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
    return mix(mix(clothHash(i),clothHash(i+vec2(1,0)),f.x),mix(clothHash(i+vec2(0,1)),clothHash(i+vec2(1,1)),f.x),f.y);
  }
  // Someone walking behind the cloth, close against it: where their figure
  // presses (x, 0-1) - shoulders about 50 cm across up to 1.45 m, a head above
  // them - and where the cloth it draws in gathers around it (y). Measured
  // along the cloth from the body, so only the curtain they walk behind feels it.
  vec2 clothPress(vec3 p,vec2 outward){
    if(uCurtainWalker.w<=0.0)return vec2(0.0);
    vec2 rel=p.xz-uCurtainWalker.xz;
    float depth=dot(rel,outward),along=sqrt(max(dot(rel,rel)-depth*depth,0.0));
    float near=1.0-smoothstep(0.35,0.6,abs(depth));
    float torso=(1.0-smoothstep(0.17,0.29,along))*smoothstep(0.12,0.4,p.y)*(1.0-smoothstep(1.36,1.5,p.y));
    float head=1.0-smoothstep(0.08,0.135,length(vec2(along,p.y-1.62)));
    float gather=smoothstep(0.22,0.36,along)*(1.0-smoothstep(0.42,0.7,along))*(1.0-smoothstep(1.45,1.85,p.y));
    return uCurtainWalker.w*near*vec2(max(torso,head),gather);
  }
  float clothPush(vec3 p,vec2 outward,float panel){
    float push=0.0;
    for(int i=0;i<${PULSES};i++){
      if(abs(panel-uCurtainPosition[i].w)<0.25&&uCurtainImpulse[i].z>0.0){
        float distanceXZ=length(p.xz-uCurtainPosition[i].xz);
        float support=1.0-smoothstep(0.15,1.5,distanceXZ);
        float heightDistance=abs(p.y-uCurtainPosition[i].y);
        float age=max(0.0,uCurtainImpulse[i].w-heightDistance*0.085-distanceXZ*0.12);
        float envelope=sin(age*6.6)*exp(-age*1.15);
        float heightFalloff=0.4+0.6*(1.0-smoothstep(0.2,2.2,heightDistance));
        push+=dot(outward,uCurtainImpulse[i].xy)*uCurtainImpulse[i].z*envelope*support*heightFalloff;
      }
    }
    // Someone standing close: the cloth bows slowly away from them.
    if(uCurtainPresence.w>0.0){
      vec2 away=p.xz-uCurtainPresence.xz;
      float reach=1.0-smoothstep(0.0,1.4,length(away));
      float height=1.0-smoothstep(0.3,1.6,abs(p.y-uCurtainPresence.y));
      push+=(dot(outward,away)<0.0?-1.0:1.0)*0.16*uCurtainPresence.w*reach*reach*height;
    }
    // Someone walking behind it: pressed out of the cloth, away from them.
    if(uCurtainWalker.w>0.0)push+=(dot(outward,p.xz-uCurtainWalker.xz)<0.0?-1.0:1.0)*0.6*clothPress(p,outward).x;
    return 0.32*push/(0.32+abs(push));
  }
`;
// Relights the baked velvet at the scale of its folds. The lights hang above
// the curtains on the viewer's side: crests catch them and glint, troughs fall
// into shadow, grazing fold sides take on the velvet sheen, and each pool of
// light ends in an arc, so the lower dark band is scalloped as in 1991.
const VELVET_LIGHT=`
  vec3 velvetEye=cameraPosition-vCurtainWorld;
  vec3 velvetV=normalize(velvetEye);
  float velvetSide=dot(vCurtainFrame.xy,velvetEye.xz)<0.0?-1.0:1.0;
  vec2 velvetOut=vCurtainFrame.xy*velvetSide;
  vec3 velvetN=normalize(vCurtainNormal);
  velvetN*=dot(velvetN,velvetV)<0.0?-1.0:1.0;
  // Within a few metres, soft creases run down each fold and break up its face.
  vec2 velvetCreaseUV=vec2(vCurtainFrame.w*24.0,vCurtainWorld.y*1.6)+vCurtainPanel*5.0;
  float velvetCrease=velvetNoise(velvetCreaseUV+vec2(0.15,0.0))-velvetNoise(velvetCreaseUV-vec2(0.15,0.0));
  velvetN=normalize(velvetN+vec3(vCurtainFrame.y,0.0,-vCurtainFrame.x)*velvetCrease*0.9*(1.0-smoothstep(0.004,0.02,fwidth(vCurtainFrame.w))));
  vec3 velvetL=normalize(vec3(velvetOut.x*0.6,1.0,velvetOut.y*0.6));
  // Fold detail fades out once a fold is only a few pixels wide.
  float velvetDetail=1.0-smoothstep(0.02,0.06,fwidth(vCurtainFrame.w));
  float velvetCrest=clamp(vCurtainFrame.z*velvetSide/0.09,-1.0,1.0)*velvetDetail;
  // One pool of light every 1.45 m, brightest down its centre, where its arc
  // also reaches lowest.
  float velvetPool=vCurtainFrame.w/1.45+fract(vCurtainPanel*0.618);
  float velvetAcross=fract(velvetPool)*2.0-1.0;
  float velvetArc=sqrt(max(0.0,1.0-velvetAcross*velvetAcross));
  float velvetDepth=0.24+0.18*fract(sin(floor(velvetPool)*12.9898+vCurtainPanel*78.233)*43758.5453);
  float velvetLit=smoothstep(-0.07,0.07,vCurtainWorld.y-(1.34-velvetDepth*velvetArc));
  float velvetFacing=clamp((dot(velvetN,velvetL)+0.4)/1.4,0.0,1.0)/0.65;
  // The bake leaves corners in deep shadow; lift them a little so the cloth
  // gathered there shows its folds.
  float velvetShade=mix(0.62,1.22,smoothstep(-0.9,0.9,velvetCrest))
    *mix(1.0,velvetFacing,0.6*velvetDetail)*mix(0.78,1.12*mix(0.86,1.14,velvetArc),velvetLit)*(1.0+vCurtainCorner*vCurtainCorner);
  float velvetGlint=pow(max(dot(velvetN,normalize(velvetL+velvetV)),0.0),24.0)*smoothstep(0.1,0.8,velvetCrest);
  float velvetSheen=pow(1.0-max(dot(velvetN,velvetV),0.0),3.0)*velvetDetail;
  // Within arm's reach the pile shows as fine vertical streaks, gone by ~2 m.
  float velvetFibre=vCurtainFrame.w*260.0+vCurtainWorld.y*1.7;
  float velvetSeed=floor(velvetFibre)*91.7+vCurtainPanel*3.1;
  float velvetPile=mix(fract(sin(velvetSeed)*43758.5453),fract(sin(velvetSeed+91.7)*43758.5453),smoothstep(0.0,1.0,fract(velvetFibre)));
  float velvetNear=1.0-smoothstep(0.002,0.008,fwidth(vCurtainFrame.w));
  // Crushed velvet: the pressed pile turns irregular patches toward or away
  // from the light, so the cloth reads mottled from across the room as on the
  // 1991 set. Patches are taller than wide; each octave fades before it aliases.
  vec2 velvetCrushUV=vec2(vCurtainFrame.w*38.0,vCurtainWorld.y*16.0)+vCurtainPanel*17.0;
  float velvetSpan=fwidth(vCurtainFrame.w);
  float velvetCrush=(velvetNoise(velvetCrushUV+velvetNoise(velvetCrushUV*0.37)*2.0)-0.5)*(1.0-smoothstep(0.012,0.035,velvetSpan))*0.7
    +(velvetNoise(velvetCrushUV*2.3+5.1)-0.5)*(1.0-smoothstep(0.004,0.012,velvetSpan))*0.3;
  diffuseColor.rgb*=(velvetShade+(velvetGlint*0.9+velvetSheen*0.35*(1.0+velvetCrush*1.6))*velvetLit)
    *(1.0+velvetCrush*0.32)*(1.0+(velvetPile-0.5)*0.12*velvetNear);
`;

// The baked velvet stays on the original mesh. A handful of local impulses
// deform it on the GPU; no extra render passes or per-frame vertex uploads.
export function createCurtainInteraction(models,{reducedMotion=false}={}) {
  const {panels,meshes}=prepareCurtainSurfaces(models);
  const motion=createCurtainMotion(panels,{maxImpulses:PULSES});
  const positions=Array.from({length:PULSES},()=>new THREE.Vector4(0,0,0,-1));
  const impulses=Array.from({length:PULSES},()=>new THREE.Vector4());
  const time={value:0},breath={value:reducedMotion?0:BREATH},presence={value:new THREE.Vector4(0,0,0,0)},active={value:0};
  const walker={value:new THREE.Vector4(0,0,0,0)};
  const activePanels=new Set();
  const dream=new Set();
  models.dreamCurtains?.traverse(object=>dream.add(object));
  for(const mesh of meshes){
    // The export drops normals for its unlit material; the 3 cm fold columns
    // are fine enough to recover them for relighting the velvet.
    if(!mesh.geometry.getAttribute('normal'))mesh.geometry.computeVertexNormals();
    const material=mesh.material.clone();
    const inverse=new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
    // The violet dream curtains keep their authored colour.
    const red=!dream.has(mesh);
    material.customProgramCacheKey=()=> red?'local-velvet-response-v11|red':'local-velvet-response-v11|dream';
    material.onBeforeCompile=shader=>{
      shader.uniforms.uCurtainPosition={value:positions};
      shader.uniforms.uCurtainImpulse={value:impulses};
      shader.uniforms.uCurtainWorldToLocal={value:inverse};
      shader.uniforms.uCurtainTime=time;
      shader.uniforms.uCurtainBreath=breath;
      shader.uniforms.uCurtainPresence=presence;
      shader.uniforms.uCurtainWalker=walker;
      shader.uniforms.uCurtainActive=active;
      shader.vertexShader=`
        attribute vec4 curtainSurface;
        attribute vec2 curtainFold;
        attribute vec4 curtainShape;
        attribute float curtainHeight;
        uniform vec4 uCurtainPosition[${PULSES}];
        uniform vec4 uCurtainImpulse[${PULSES}];
        uniform vec4 uCurtainPresence;
        uniform vec4 uCurtainWalker;
        uniform mat3 uCurtainWorldToLocal;
        uniform float uCurtainTime;
        uniform float uCurtainBreath;
        uniform float uCurtainActive;
        varying float vCurtainBend;
        varying vec2 vCurtainPress;
        ${VELVET_VARYINGS}
        ${CLOTH_FUNCTIONS}
      `+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        vec3 clothOut=vec3(curtainSurface.x,0.0,curtainSurface.y),clothAlong=vec3(curtainSurface.y,0.0,-curtainSurface.x);
        float clothPleat=curtainShape.x,clothCorner=curtainShape.w;
        // The pleats open and deepen toward the hem, unevenly from one to the
        // next, and gather deeper at corners, where the sharp turn of the
        // hanging line is rounded off.
        float clothVariety=0.7+0.6*clothNoise(vec2(curtainFold.y*1.6+curtainSurface.w*7.0,curtainHeight*1.3));
        float clothGain=mix(1.9,1.2,smoothstep(0.0,0.9,curtainHeight))*clothVariety*(1.0+0.6*clothCorner);
        float clothRound=1.0-0.85*clothCorner;
        // Where a body presses from behind, the cloth is drawn taut over it and
        // its folds flatten; around it they gather deeper.
        vec2 clothPressed=uCurtainActive>0.5?clothPress((modelMatrix*vec4(transformed,1.0)).xyz,curtainSurface.xy):vec2(0.0);
        float clothTaut=1.0-0.9*clothPressed.x+0.7*clothPressed.y;
        float clothOffset=(clothPleat*clothGain+(curtainFold.x-clothPleat)*clothRound)*clothTaut;
        float clothSlope=(curtainShape.y*clothGain+(curtainShape.z-curtainShape.y)*clothRound)*clothTaut;
        vec3 clothWorld=(modelMatrix*vec4(transformed,1.0)).xyz+clothOut*(clothOffset-curtainFold.x);
        // Contact and nearness push along the outward line; their slope along
        // and down the cloth tilts its shading with the movement. With nothing
        // touching the cloth, none of it is evaluated.
        float push=0.0,pushAlong=0.0,pushDown=0.0;
        if(uCurtainActive>0.5){
          push=clothPush(clothWorld,curtainSurface.xy,curtainSurface.w);
          pushAlong=(clothPush(clothWorld+clothAlong*0.06,curtainSurface.xy,curtainSurface.w)-push)/0.06*curtainSurface.z;
          pushDown=(clothPush(clothWorld+vec3(0.0,0.06,0.0),curtainSurface.xy,curtainSurface.w)-push)/0.06*curtainSurface.z;
          push*=curtainSurface.z;
        }
        // The room breathes: two slow waves travel along the folds (periods of
        // about 9 s and 5.6 s), largest at the free hem, zero where pinned.
        float breath=(sin(dot(clothWorld.xz,vec2(0.83,0.56))*1.7-uCurtainTime*0.71)
          +0.6*sin(dot(clothWorld.xz,vec2(-0.47,0.88))*2.9-uCurtainTime*1.13+1.7))*uCurtainBreath*curtainSurface.z;
        transformed+=uCurtainWorldToLocal*(clothOut*(clothOffset-curtainFold.x+push+breath));
        vCurtainBend=push+breath*4.0;
        vCurtainPress=clothPressed;
        vCurtainWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
        vCurtainNormal=normalize(clothOut-clothAlong*(clothSlope+pushAlong)-vec3(0.0,pushDown,0.0));
        vCurtainFrame=vec4(curtainSurface.xy,clothOffset,curtainFold.y);
        vCurtainPanel=curtainSurface.w;
        vCurtainCorner=clothCorner;
      `);
      shader.fragmentShader=`varying float vCurtainBend;\nvarying vec2 vCurtainPress;\n${VELVET_VARYINGS}\n${VELVET_FUNCTIONS}\n`+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        ${red?`
          // The 1991 velvet is a pure, deep red. Pull the baked green / blue
          // spill out and add a little contrast around the mid-tones.
          diffuseColor.rgb*=1.44*pow(max(diffuseColor.r,1e-4),0.3);
          diffuseColor.g=min(diffuseColor.g,diffuseColor.r)*0.16;
          diffuseColor.b=min(diffuseColor.b,diffuseColor.r)*0.14;
        `:''}
        ${VELVET_LIGHT}
        diffuseColor.rgb*=1.0+vCurtainBend*0.35;
        // Velvet stretched over a body opens its pile to the light, most over
        // the head and shoulders, nearest the lamps above; the folds gathered
        // around it fall into shadow. So the figure shows even head-on.
        diffuseColor.rgb*=1.0+vCurtainPress.x*mix(0.7,1.4,smoothstep(0.6,1.5,vCurtainWorld.y))-vCurtainPress.y*0.5;
        // Where the hem meets the floor the cloth shades itself, so it rests on
        // the linoleum instead of hovering over it.
        diffuseColor.rgb*=mix(0.5,1.0,smoothstep(0.0,0.06,vCurtainWorld.y));
      `);
    };
    mesh.material=material;
  }
  function visible(mesh){
    for(let object=mesh;object;object=object.parent)if(!object.visible)return false;
    return true;
  }
  function syncUniforms(){
    let any=presence.value.w>.001||walker.value.w>.001;
    for(let i=0;i<PULSES;i++){
      const pulse=motion.impulses[i];
      if(pulse?.active){
        positions[i].set(pulse.position.x,pulse.position.y,pulse.position.z,pulse.panelId);
        impulses[i].set(pulse.direction.x,pulse.direction.z,pulse.strength,pulse.age);
        any=true;
      }else{
        positions[i].w=-1;
        impulses[i].set(0,0,0,0);
      }
    }
    active.value=any?1:0;
  }
  return {
    panels,meshes,motion,
    update(dt,sources){
      if(Number.isFinite(dt)&&dt>0)time.value+=dt;
      activePanels.clear();
      for(const panel of panels)if(visible(panel.mesh))activePanels.add(panel.id);
      motion.update(dt,sources,activePanels);
      // Within about a metre of the cloth, it eases away from the visitor.
      const lead=sources?.[0],hit=lead&&motion.nearest({x:lead.x,y:lead.y,z:lead.z},activePanels);
      const target=hit?Math.max(0,1-hit.distance/1.2)**1.2:0;
      const amount=presence.value.w+(target-presence.value.w)*(1-Math.exp(-Math.max(0,Number.isFinite(dt)?dt:0)/0.45));
      if(lead)presence.value.set(lead.x,lead.y,lead.z,amount);else presence.value.w=amount;
      syncUniforms();
    },
    // Someone behind the cloth (curtain-walker.js): { at: [x, y, z], amount } or null.
    setWalker(walk){
      if(walk)walker.value.set(walk.at[0],walk.at[1],walk.at[2],walk.amount);else walker.value.w=0;
      if(walker.value.w>.001)active.value=1;
    },
    // The curtains that can be walked behind: those in sight this frame.
    visiblePanels:()=>panels.filter(panel=>activePanels.has(panel.id)),
    activePanels,
    // Contact waves stop; the ambient breathing keeps its own clock.
    reset(){motion.reset();presence.value.w=0;walker.value.w=0;syncUniforms();},
    inspect(){return {...motion.inspect(),meshes:meshes.length,panels:activePanels.size,breath:breath.value,breathTime:time.value,presence:presence.value.w,walker:walker.value.w,extraDrawCalls:0};},
  };
}
