import * as THREE from 'three';
import { distanceToSegment } from './simulation.js';

// Distance from the floor to the nearest curtain line, sampled once into a
// small texture. The floor reads it for the shadow under the hem and for the
// red light the velvet throws onto the linoleum.
export function createCurtainField(spatial, { resolution = .2, range = 3 } = {}) {
  const walls = spatial.wallSegments ?? [];
  const points = (spatial.walkablePolygons ?? []).flat();
  if (!walls.length || !points.length) return null;
  const minX = Math.min(...points.map(p => p[0])) - 1, minZ = Math.min(...points.map(p => p[1])) - 1;
  const maxX = Math.max(...points.map(p => p[0])) + 1, maxZ = Math.max(...points.map(p => p[1])) + 1;
  const width = Math.ceil((maxX - minX) / resolution) + 1, height = Math.ceil((maxZ - minZ) / resolution) + 1;
  // Cells as large as the range: a texel only needs the walls listed in its cell.
  const cells = new Map();
  walls.forEach(([a, b], index) => {
    for (let x = Math.floor((Math.min(a[0], b[0]) - range) / range); x <= Math.floor((Math.max(a[0], b[0]) + range) / range); x++) {
      for (let z = Math.floor((Math.min(a[1], b[1]) - range) / range); z <= Math.floor((Math.max(a[1], b[1]) + range) / range); z++) {
        const key = `${x},${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      }
    }
  });
  const data = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const point = [minX + i * resolution, minZ + j * resolution];
      let nearest = range;
      for (const index of cells.get(`${Math.floor(point[0] / range)},${Math.floor(point[1] / range)}`) ?? []) {
        nearest = Math.min(nearest, distanceToSegment(point, walls[index][0], walls[index][1]));
      }
      data[j * width + i] = Math.round(nearest / range * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  texture.unpackAlignment = 1;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  // uv = xz * scale + offset lands exactly on texel centres.
  return {
    texture, range,
    scale: new THREE.Vector2(1 / (resolution * width), 1 / (resolution * height)),
    offset: new THREE.Vector2(.5 / width - minX / (resolution * width), .5 / height - minZ / (resolution * height)),
  };
}

// Keep the authored, baked illumination. These small view-dependent details
// restore depth without bringing the offline scene's lights into the XR frame.
export function refinePresentation(scene, models, field = null) {
  scene.fog=new THREE.FogExp2(0x0a0303,.021);
  const floorUniforms={
    uCurtainField:{value:field?.texture??new THREE.DataTexture(new Uint8Array([255]),1,1,THREE.RedFormat,THREE.UnsignedByteType)},
    uCurtainFieldScale:{value:field?.scale??new THREE.Vector2()},
    uCurtainFieldOffset:{value:field?.offset??new THREE.Vector2(.5,.5)},
    uCurtainFieldRange:{value:field?.range??3},
    uRoomDream:{value:0},
  };
  if(!field)floorUniforms.uCurtainField.value.needsUpdate=true;
  for(const root of Object.values(models))root.traverse(object=>{
    if(!object.isMesh)return;
    const name=object.name.replaceAll('_',' ');
    const floor=name.includes(' floor');
    const props=name.includes(' props') || root===models.milo || root===models.double || root===models.repeated;
    if(!floor&&!props)return;
    if(props&&!object.geometry.attributes.normal)object.geometry.computeVertexNormals();
    const material=object.material.clone();
    material.dithering=true;
    material.customProgramCacheKey=()=>floor?'room-floor-v3':'room-soft-sheen-v2';
    material.onBeforeCompile=shader=>{
      const declarations='varying vec3 vRoomPosition; varying vec3 vRoomNormal; varying vec3 vRoomView;\n';
      shader.vertexShader=declarations+shader.vertexShader;
      shader.fragmentShader=declarations+shader.fragmentShader;
      if(floor){
        Object.assign(shader.uniforms,floorUniforms);
        shader.fragmentShader='uniform sampler2D uCurtainField; uniform vec2 uCurtainFieldScale; uniform vec2 uCurtainFieldOffset; uniform float uCurtainFieldRange; uniform float uRoomDream;\n'+shader.fragmentShader;
      }
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vRoomPosition=(modelMatrix*vec4(transformed,1.0)).xyz;
        vRoomView=-mvPosition.xyz;
        vRoomNormal=normalize(normalMatrix*normal);`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        ${floor ? `
          vec2 p=vRoomPosition.xz;
          float a=exp(-dot(p-vec2(0.,1.8),p-vec2(0.,1.8))/24.);
          float b=exp(-dot(p-vec2(-7.2,-3.),p-vec2(-7.2,-3.))/18.);
          float e=exp(-dot(p-vec2(-25.,8.),p-vec2(-25.,8.))/22.);
          float f=exp(-dot(p-vec2(-7.,22.5),p-vec2(-7.,22.5))/24.);
          float pool=max(max(a,b),max(e,f));
          float footprint=max(length(dFdx(p)),length(dFdy(p)));
          float grain=(fract(sin(dot(floor(p*130.),vec2(12.9898,78.233)))*43758.5453)-.5)*.009*(1.-smoothstep(.004,.025,footprint));
          // The exported linoleum is neutral. On the 1991 stage the cream band
          // reads peach and the black band oxblood, lit by the red velvet.
          float roomCream=smoothstep(.035,.075,dot(diffuseColor.rgb,vec3(.2126,.7152,.0722)));
          // In the dream state the violet room F throws a cooler light instead.
          float roomViolet=uRoomDream*smoothstep(16.5,17.5,p.y);
          vec3 roomTint=mix(mix(vec3(1.88,.45,.235),vec3(1.355,.621,.486),roomCream),
            mix(vec3(1.45,.4,.62),vec3(1.18,.6,.8),roomCream),roomViolet);
          float roomHem=texture2D(uCurtainField,p*uCurtainFieldScale+uCurtainFieldOffset).r*uCurtainFieldRange;
          roomTint*=mix(vec3(1.),mix(vec3(1.12,.84,.8),vec3(1.04,.84,1.1),roomViolet),exp(-roomHem/1.1));
          // The shadow under the hem also hides the clipped chevron edges.
          float roomShade=mix(.16,1.,smoothstep(.05,.95,roomHem));
          diffuseColor.rgb*=roomTint*(.74+.26*pool+grain)*roomShade;
          float grazing=pow(1.-abs(normalize(cameraPosition-vRoomPosition).y),5.);
          diffuseColor.rgb+=vec3(.006,.003,.002)*grazing*pool*roomShade;
        ` : `
          float edge=pow(1.-abs(dot(normalize(vRoomNormal),normalize(vRoomView))),3.5);
          diffuseColor.rgb+=vec3(.0045,.0034,.0028)*edge;
        `}`);
    };
    object.material=material;
  });
  return {setDream(value){floorUniforms.uRoomDream.value=value?1:0;}};
}

export function createNavigationGuide(scene, spatial, simulation) {
  const route=spatial.route;
  const distances=[0];
  for(let i=1;i<route.length;i++)distances.push(distances[i-1]+Math.hypot(route[i][0]-route[i-1][0],route[i][1]-route[i-1][1]));
  const checkpointIndices=[];let cursor=0;
  for(let c=0;c<simulation.checkpoints.length;c++){
    if(c===simulation.checkpoints.length-1){checkpointIndices.push(route.length-1);break;}
    let best=Infinity,found=cursor;
    for(let i=cursor;i<route.length-1;i++){
      const distance=Math.hypot(route[i][0]-simulation.checkpoints[c][0],route[i][1]-simulation.checkpoints[c][1]);
      if(distance<best){best=distance;found=i;}
    }
    checkpointIndices.push(found);cursor=found;
  }
  const geometry=new THREE.RingGeometry(.025,.045,12);
  const material=new THREE.MeshBasicMaterial({color:0xd3ba91,transparent:true,opacity:.65,depthWrite:false});
  const dots=new THREE.InstancedMesh(geometry,material,24);
  dots.frustumCulled=false;dots.visible=false;dots.renderOrder=3;scene.add(dots);
  const arrow=new THREE.Mesh(new THREE.ConeGeometry(.07,.18,3),material);
  arrow.rotation.x=Math.PI/2;arrow.visible=false;scene.add(arrow);
  const transform=new THREE.Object3D();transform.rotation.x=-Math.PI/2;
  function pointAt(distance){
    let i=1;while(i<distances.length-1&&distances[i]<distance)i++;
    const t=THREE.MathUtils.clamp((distance-distances[i-1])/(distances[i]-distances[i-1]||1),0,1);
    return [THREE.MathUtils.lerp(route[i-1][0],route[i][0],t),THREE.MathUtils.lerp(route[i-1][1],route[i][1],t)];
  }
  return {dots,update(position,enabled){
    dots.visible=arrow.visible=enabled;
    if(!enabled)return;
    const checkpoint=Math.min(simulation.state.checkpointIndex,checkpointIndices.length-1);
    const start=Math.max(0,checkpointIndices[Math.max(0,checkpoint-1)]-18);
    const end=checkpointIndices[checkpoint];
    let nearest=start,best=Infinity;
    for(let i=start;i<=end;i++){
      const d=Math.hypot(route[i][0]-position.x,route[i][1]-position.z);
      if(d<best&&!simulation.wallBetween([position.x,position.z],route[i])){nearest=i;best=d;}
    }
    let count=0;
    for(let d=distances[nearest]+.18;d<Math.min(distances.at(-1),distances[nearest]+6.5);d+=.3){
      const [x,z]=pointAt(d);
      transform.position.set(x,.014,z);transform.updateMatrix();dots.setMatrixAt(count++,transform.matrix);
    }
    dots.count=count;dots.instanceMatrix.needsUpdate=true;
    const target=pointAt(Math.min(distances[nearest]+1.1,distances.at(-1)));
    const next=pointAt(Math.min(distances[nearest]+1.4,distances.at(-1)));
    arrow.position.set(target[0],.055,target[1]);
    arrow.rotation.set(Math.PI/2,0,-Math.atan2(next[0]-target[0],next[1]-target[1]));
  }};
}

export function createXRNotice(camera) {
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=220;
  const context=canvas.getContext('2d');
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const panel=new THREE.Mesh(new THREE.PlaneGeometry(.82,.176),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,depthTest:false}));
  panel.position.set(0,-.29,-1.25);panel.renderOrder=9999;panel.frustumCulled=false;panel.visible=false;camera.add(panel);
  let expires=0;
  function show(title,subtitle='',progress=null,duration=2600){
    context.clearRect(0,0,1024,220);
    context.fillStyle='rgba(17,6,5,.88)';context.fillRect(0,0,1024,220);
    context.strokeStyle='rgba(206,166,126,.5)';context.strokeRect(2,2,1020,216);
    context.textAlign='center';context.fillStyle='#ead8c2';context.font='32px sans-serif';context.fillText(title,512,83);
    context.fillStyle='#b69b82';context.font='23px sans-serif';context.fillText(subtitle,512,133);
    if(progress!==null){context.fillStyle='#5c3d2c';context.fillRect(180,172,664,4);context.fillStyle='#ddbd90';context.fillRect(180,172,664*progress,4);}
    texture.needsUpdate=true;panel.visible=true;expires=performance.now()+duration;
  }
  return {show,hide:()=>{panel.visible=false;},update:active=>{panel.visible=active&&performance.now()<expires;}};
}
