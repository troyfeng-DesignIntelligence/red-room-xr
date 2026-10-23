import * as THREE from 'three';

const vertexShader=`
  varying vec2 vUv;
  void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}
`;

const gradeGLSL=`
  vec3 filmTone(vec3 color,float dream){
    float luma=dot(color,vec3(0.2126,0.7152,0.0722));
    // Film keeps the velvet's saturation; only the dream softens it a little.
    vec3 toned=mix(vec3(luma),color,1.0-dream*0.06);
    toned*=vec3(1.035,1.005,0.965);
    toned=toned/(vec3(1.0)+toned*0.105);
    float shadows=pow(1.0-clamp(luma,0.0,1.0),2.0);
    // A warm lift in the blacks, violet in the dream, instead of a grey veil.
    toned+=mix(vec3(0.0030,0.0012,0.0009),vec3(0.0044,0.0034,0.0050),dream)*shadows;
    return toned;
  }
`;

const blurFragment=`
  uniform sampler2D tInput;
  uniform vec2 uDirection;
  varying vec2 vUv;
  void main(){
    vec3 color=texture2D(tInput,vUv).rgb*0.227027;
    color+=texture2D(tInput,vUv+uDirection*1.384615).rgb*0.316216;
    color+=texture2D(tInput,vUv-uDirection*1.384615).rgb*0.316216;
    color+=texture2D(tInput,vUv+uDirection*3.230769).rgb*0.070270;
    color+=texture2D(tInput,vUv-uDirection*3.230769).rgb*0.070270;
    gl_FragColor=vec4(color,1.0);
  }
`;

const filmFragment=`
  uniform sampler2D tScene;
  uniform sampler2D tSoft;
  uniform float uStrength;
  uniform float uDream;
  uniform float uGrainFrame;
  uniform float uPixelRatio;
  varying vec2 vUv;
  ${gradeGLSL}
  float grainHash(vec2 p){
    vec3 q=fract(vec3(p.xyx)*0.1031);
    q+=dot(q,q.yzx+33.33+uGrainFrame*0.013);
    return fract((q.x+q.y)*q.z);
  }
  void main(){
    vec3 original=texture2D(tScene,vUv).rgb;
    vec3 soft=texture2D(tSoft,vUv).rgb;
    float light=dot(soft,vec3(0.2126,0.7152,0.0722));
    float diffusion=mix(0.14,0.32,uDream)*uStrength;
    vec3 color=mix(original,soft,diffusion);
    // Highlight diffusion and warm film halation remain local to bright edges.
    vec3 glow=soft*smoothstep(0.075,0.48,light);
    color+=glow*mix(0.19,0.43,uDream)*uStrength;
    color+=max(soft-original,vec3(0.0))*vec3(1.0,0.27,0.11)*mix(0.14,0.28,uDream)*uStrength;
    color=mix(color,filmTone(color,uDream),uStrength);
    vec2 fromCenter=(vUv-0.5)*vec2(1.0,0.9);
    color*=1.0-smoothstep(0.14,0.45,dot(fromCenter,fromCenter))*mix(0.18,0.25,uDream)*uStrength;
    gl_FragColor=vec4(max(color,vec3(0.0)),1.0);
    #include <colorspace_fragment>
    // Grain is added after display encoding so it remains fine in the shadows.
    // The picture never shakes or flickers as a whole.
    vec2 grainPixel=floor(gl_FragCoord.xy/max(1.0,uPixelRatio*0.85));
    float noise=grainHash(grainPixel+uGrainFrame*vec2(17.0,31.0))-0.5;
    float displayLuma=dot(gl_FragColor.rgb,vec3(0.2126,0.7152,0.0722));
    gl_FragColor.rgb+=noise*mix(0.022,0.016,uDream)*uStrength*(0.55+0.45*sin(clamp(displayLuma,0.0,1.0)*3.14159));
    gl_FragColor.rgb=clamp(gl_FragColor.rgb,0.0,1.0);
  }
`;

export function createFilmEffects(renderer,models,{reducedMotion=false}={}){
  let look='film',strength=.65,lastPath='screen-film';
  let sceneTarget,blurA,blurB,width=0,height=0,samples=0,targetType='';
  const size=new THREE.Vector2();
  const xrStrength={value:0},xrDream={value:0};
  const hooks=[],seen=new Set();
  // XR keeps both eyes on the native rendering path. Only authored room
  // materials receive the restrained tone, leaving comfort fades / HUD clear.
  for(const root of Object.values(models))root.traverse(object=>{
    if(!object.isMesh)return;
    for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(seen.has(material))continue;seen.add(material);
      const compile=material.onBeforeCompile,key=material.customProgramCacheKey;
      const baseKey=key.call(material);
      hooks.push({material,compile,key});
      material.onBeforeCompile=function(shader,...args){
        compile.call(this,shader,...args);
        shader.uniforms.uXRFilmStrength=xrStrength;
        shader.uniforms.uXRFilmDream=xrDream;
        shader.fragmentShader='uniform float uXRFilmStrength; uniform float uXRFilmDream;\n'+gradeGLSL+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <colorspace_fragment>',`
          gl_FragColor.rgb=mix(gl_FragColor.rgb,filmTone(gl_FragColor.rgb,uXRFilmDream),uXRFilmStrength);
          #include <colorspace_fragment>
        `);
      };
      material.customProgramCacheKey=()=>baseKey+'|xr-film-tone-v1';
      material.needsUpdate=true;
    }
  });

  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,2,0,0,2],2));
  const blur=new THREE.ShaderMaterial({vertexShader,fragmentShader:blurFragment,
    uniforms:{tInput:{value:null},uDirection:{value:new THREE.Vector2()}},depthTest:false,depthWrite:false,toneMapped:false});
  const composite=new THREE.ShaderMaterial({vertexShader,fragmentShader:filmFragment,
    uniforms:{tScene:{value:null},tSoft:{value:null},uStrength:{value:.65},uDream:{value:0},uGrainFrame:{value:0},uPixelRatio:{value:1}},
    depthTest:false,depthWrite:false,toneMapped:false});
  const triangle=new THREE.Mesh(geometry,blur);triangle.frustumCulled=false;
  const screen=new THREE.Scene();screen.add(triangle);
  const screenCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);

  function ensureTargets(){
    renderer.getDrawingBufferSize(size);
    const w=Math.max(1,Math.floor(size.x)),h=Math.max(1,Math.floor(size.y));
    if(!sceneTarget){
      const half=renderer.extensions.has('EXT_color_buffer_float');
      const gl=renderer.getContext();
      const supported=gl.getInternalformatParameter(gl.RENDERBUFFER,half?gl.RGBA16F:gl.RGBA8,gl.SAMPLES)||[];
      const depthSamples=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,gl.SAMPLES)||[]);
      // Match the canvas's edge coverage on narrow pleats and the chevrons.
      samples=Math.max(0,...Array.from(supported).filter(value=>value<=4&&depthSamples.includes(value)));
      targetType=half?'half-float':'unsigned-byte';
      const options={type:half?THREE.HalfFloatType:THREE.UnsignedByteType,colorSpace:THREE.LinearSRGBColorSpace,
        minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false,stencilBuffer:false};
      sceneTarget=new THREE.WebGLRenderTarget(w,h,{...options,samples,depthBuffer:true});
      blurA=new THREE.WebGLRenderTarget(Math.max(1,w>>2),Math.max(1,h>>2),{...options,depthBuffer:false});
      blurB=blurA.clone();
      composite.uniforms.tScene.value=sceneTarget.texture;
      composite.uniforms.tSoft.value=blurB.texture;
    }
    if(w!==width||h!==height){
      width=w;height=h;sceneTarget.setSize(w,h);
      blurA.setSize(Math.max(1,w>>2),Math.max(1,h>>2));blurB.setSize(Math.max(1,w>>2),Math.max(1,h>>2));
    }
  }

  function render(scene,camera,time=0){
    const amount=look==='clean'?0:strength;
    const dream=look==='dream'?1:0;
    xrStrength.value=renderer.xr.isPresenting?amount*.78:0;xrDream.value=dream;
    if(renderer.xr.isPresenting||amount===0){
      lastPath=renderer.xr.isPresenting?(amount?'xr-grade':'xr-clean'):'screen-clean';
      renderer.render(scene,camera);
      return;
    }
    ensureTargets();lastPath='screen-'+look;
    const previousTarget=renderer.getRenderTarget(),previousXR=renderer.xr.enabled;
    const previousReset=renderer.info.autoReset,previousClear=renderer.autoClear;
    renderer.info.reset();renderer.info.autoReset=false;renderer.autoClear=true;
    // A fullscreen camera must never be replaced with WebXR's stereo camera.
    renderer.xr.enabled=false;
    try{
      renderer.setRenderTarget(sceneTarget);renderer.render(scene,camera);
      const ratio=renderer.getPixelRatio(),radius=(dream?5.0:3.2)*ratio;
      triangle.material=blur;
      blur.uniforms.tInput.value=sceneTarget.texture;blur.uniforms.uDirection.value.set(radius/width,0);
      renderer.setRenderTarget(blurA);renderer.render(screen,screenCamera);
      blur.uniforms.tInput.value=blurA.texture;blur.uniforms.uDirection.value.set(0,radius/height);
      renderer.setRenderTarget(blurB);renderer.render(screen,screenCamera);
      triangle.material=composite;
      composite.uniforms.uStrength.value=amount;composite.uniforms.uDream.value=dream;
      composite.uniforms.uGrainFrame.value=reducedMotion?0:Math.floor(Math.max(0,time)*24)%10000;
      composite.uniforms.uPixelRatio.value=ratio;
      renderer.setRenderTarget(previousTarget);renderer.render(screen,screenCamera);
    }finally{
      renderer.setRenderTarget(previousTarget);renderer.xr.enabled=previousXR;
      renderer.info.autoReset=previousReset;renderer.autoClear=previousClear;
    }
  }

  return {
    render,
    setLook(value){if(['clean','film','dream'].includes(value))look=value;return look;},
    setStrength(value){if(Number.isFinite(value))strength=THREE.MathUtils.clamp(value,0,1);return strength;},
    inspect(){return {look,strength,path:lastPath,width,height,targetType,samples,extraDrawCalls:lastPath.startsWith('screen-')&&lastPath!=='screen-clean'?3:0};},
    dispose(){
      sceneTarget?.dispose();blurA?.dispose();blurB?.dispose();geometry.dispose();blur.dispose();composite.dispose();
      for(const {material,compile,key} of hooks){material.onBeforeCompile=compile;material.customProgramCacheKey=key;material.needsUpdate=true;}
    },
  };
}
