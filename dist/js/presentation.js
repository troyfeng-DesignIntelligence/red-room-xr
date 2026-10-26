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

// The merged prop mesh as its connected parts, each with its vertices, centre,
// top and width across the floor: a chair, a lamp or a statue is one or more
// parts. `world` holds every vertex in world space, x y z.
function propParts(mesh) {
  const geometry=mesh.geometry,position=geometry.getAttribute('position'),index=geometry.getIndex();
  const count=position.count,world=new Float32Array(count*3),vector=new THREE.Vector3();
  mesh.updateWorldMatrix(true,false);
  for(let i=0;i<count;i++){
    vector.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld);
    world.set([vector.x,vector.y,vector.z],i*3);
  }
  const parent=Int32Array.from({length:count},(_,i)=>i);
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[a]=b;};
  for(let i=0;i<index.count;i+=3){join(index.getX(i),index.getX(i+1));join(index.getX(i),index.getX(i+2));}
  const groups=new Map();
  for(let i=0;i<count;i++){
    const root=find(i);
    if(!groups.has(root))groups.set(root,[]);
    groups.get(root).push(i);
  }
  return {world,parts:[...groups.values()].map(vertices=>{
    let x=0,z=0,top=-Infinity,minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for(const i of vertices){
      const px=world[i*3],pz=world[i*3+2];
      x+=px;z+=pz;top=Math.max(top,world[i*3+1]);
      minX=Math.min(minX,px);maxX=Math.max(maxX,px);minZ=Math.min(minZ,pz);maxZ=Math.max(maxZ,pz);
    }
    const within=(center,reach)=>vertices.every(i=>Math.hypot(world[i*3]-center[0],world[i*3+2]-center[1])<=reach);
    return {vertices,x:x/vertices.length,z:z/vertices.length,top,width:Math.max(maxX-minX,maxZ-minZ),within};
  })};
}

// A piece's outline on the floor: the farthest point in each of 32
// directions, which traces its convex hull to within a few millimetres.
const OUTLINE_DIRECTIONS=Array.from({length:32},(_,k)=>[Math.cos(k*Math.PI/16),Math.sin(k*Math.PI/16)]);
function createOutline(){
  const best=new Float64Array(32).fill(-Infinity),at=new Float64Array(64);
  return {
    add(x,z){
      for(let k=0;k<32;k++){
        const reach=x*OUTLINE_DIRECTIONS[k][0]+z*OUTLINE_DIRECTIONS[k][1];
        if(reach>best[k]){best[k]=reach;at[k*2]=x;at[k*2+1]=z;}
      }
    },
    points(){
      const points=[];
      for(let k=0;k<32;k++){
        if(best[k]===-Infinity)continue;
        const point=[+at[k*2].toFixed(3),+at[k*2+1].toFixed(3)],last=points.at(-1);
        if(!last||last[0]!==point[0]||last[1]!==point[1])points.push(point);
      }
      if(points.length>1&&points[0][0]===points.at(-1)[0]&&points[0][1]===points.at(-1)[1])points.pop();
      return points;
    },
  };
}

// Lamps, the side table and statues claim the parts within their footprint first.
const claimsOf=obstacles=>[['torchiere',.32],['table',.62],['statue',.6]].flatMap(([word,reach])=>
  obstacles.map((o,index)=>({o,index})).filter(({o})=>o.name.toLowerCase().includes(word)).map(({o,index})=>({center:o.center,reach,index,word})));
const chairsOf=obstacles=>obstacles.map((o,index)=>({o,index})).filter(({o})=>/chair/i.test(o.name)&&!/double/i.test(o.name));

// Sorts a merged prop mesh by the obstacles from spatial.json. Lamps, the side
// table and statues claim the parts within their footprint first, so they
// never turn to leather; the club chairs take the low parts around them, each
// part its nearest chair. Writes `propLeather` (1 on the club chairs) and
// `propObject` (the obstacle index of each chair, floor lamp, side table and
// statue, -1 elsewhere, so the shader can move or turn a piece whole). Returns the marked vertex counts and
// the outline on the floor of every piece found, by obstacle index.
export function markProps(mesh, obstacles = []) {
  const geometry=mesh.geometry,result={leather:0,moving:0,outlines:{}};
  if(!geometry.getIndex())return result;
  const claims=claimsOf(obstacles),chairs=chairsOf(obstacles),{world,parts}=propParts(mesh);
  const count=geometry.getAttribute('position').count,leather=new Float32Array(count),owner=new Float32Array(count).fill(-1),outlines={};
  for(const part of parts){
    let chair=-1,nearest=Infinity;
    if(part.top<=1.05)for(const {o,index} of chairs){
      const distance=Math.hypot(part.x-o.center[0],part.z-o.center[1]);
      if(distance<o.radius+.15&&distance<nearest){nearest=distance;chair=index;}
    }
    let claim=claims.find(c=>part.within(c.center,c.reach));
    // The export stands each side table half inside its armchair, so the
    // chair's feet are under the table top: a small part on the floor goes to
    // the chair it stands under, or it would leave with the table.
    if(claim?.word==='table'&&chair>=0&&part.top<=.15&&part.width<=.2)claim=null;
    const index=claim?claim.index:chair;
    if(index<0)continue;
    const outline=outlines[index]??=createOutline();
    for(const i of part.vertices)outline.add(world[i*3],world[i*3+2]);
    for(const i of part.vertices)owner[i]=index;
    result.moving+=part.vertices.length;
    if(claim)continue;
    for(const i of part.vertices)leather[i]=1;
    result.leather+=part.vertices.length;
  }
  if(result.leather)geometry.setAttribute('propLeather',new THREE.Float32BufferAttribute(leather,1));
  if(result.moving)geometry.setAttribute('propObject',new THREE.Float32BufferAttribute(owner,1));
  for(const [index,outline] of Object.entries(outlines))result.outlines[index]=outline.points();
  return result;
}

// The club chairs alone: returns how many vertices turned to leather.
export function markChairLeather(mesh, obstacles = []) {
  return markProps(mesh,obstacles).leather;
}

// Black leather in a red room, after the 1991 chairs: an almost black,
// oxblood body; soft warm highlights from the stage lights overhead along the
// rolled arms and the top of the back; the red curtains reflected at grazing
// angles; and, within reach, a pebbled grain that breaks up the highlights.
const LEATHER_FUNCTIONS=`
  float leatherHash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
  float leatherNoise(vec3 x){
    vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
    return mix(mix(mix(leatherHash(i),leatherHash(i+vec3(1,0,0)),f.x),mix(leatherHash(i+vec3(0,1,0)),leatherHash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(leatherHash(i+vec3(0,0,1)),leatherHash(i+vec3(1,0,1)),f.x),mix(leatherHash(i+vec3(0,1,1)),leatherHash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
`;
const LEATHER_LIGHT=`
  if(vPropLeather>0.5){
    vec3 leatherV=normalize(cameraPosition-vRoomPosition);
    vec3 leatherN=inverseTransformDirection(normalize(vRoomNormal),viewMatrix);
    leatherN*=dot(leatherN,leatherV)<0.0?-1.0:1.0;
    float leatherNV=max(dot(leatherN,leatherV),0.0);
    float leatherNear=1.0-smoothstep(0.0015,0.006,length(fwidth(vRoomPosition)));
    float leatherGrain=mix(0.5,leatherNoise(vRoomPosition*420.0)*0.65+leatherNoise(vRoomPosition*1100.0)*0.35,leatherNear);
    float leatherNH=max(dot(leatherN,normalize(vec3(0.0,1.0,0.0)+leatherV)),0.0);
    float leatherSpec=pow(leatherNH,48.0)*0.12+pow(leatherNH,10.0)*0.004;
    vec3 leatherR=reflect(-leatherV,leatherN);
    vec3 leatherRoom=vec3(0.16,0.007,0.009)*smoothstep(-0.08,0.12,leatherR.y)*(1.0-smoothstep(0.35,0.8,leatherR.y))
      +vec3(0.03,0.013,0.011)*(1.0-smoothstep(-0.3,0.0,leatherR.y));
    float leatherFresnel=0.02+0.25*pow(1.0-leatherNV,5.0);
    diffuseColor.rgb=diffuseColor.rgb*vec3(0.2,0.1,0.08)
      +(vec3(1.0,0.42,0.3)*leatherSpec+leatherRoom*leatherFresnel)*mix(0.65,1.2,leatherGrain);
  }
`;

// A moved chair or floor lamp: turned about where it first stood, then
// shifted along the floor, in world space whatever the mesh's own transform.
// uPropShift is (dx, dz, cos, sin) per obstacle, uPropPivot where it stood.
const MOVE_PROP=`
  vec3 propNormal=normal;
  if(propObject>-0.5){
    int propIndex=int(propObject+0.5);
    vec4 propShift=uPropShift[propIndex];
    mat2 propTurn=mat2(propShift.z,propShift.w,-propShift.w,propShift.z);
    vec4 propWorld=modelMatrix*vec4(transformed,1.0);
    propWorld.xz=uPropPivot[propIndex]+propShift.xy+propTurn*(propWorld.xz-uPropPivot[propIndex]);
    transformed=(uPropFromWorld*propWorld).xyz;
    // Normals go to world space by the inverse transpose and come back by the transpose.
    vec3 propWorldNormal=normal*mat3(uPropFromWorld);
    propWorldNormal.xz=propTurn*propWorldNormal.xz;
    propNormal=propWorldNormal*mat3(modelMatrix);
  }
`;

const FLOOR_FUNCTIONS=`
  float floorHash(vec2 p){p=fract(p*vec2(0.1031,0.1030));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x);}
  float floorNoise(vec2 x){
    vec2 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
    return mix(mix(floorHash(i),floorHash(i+vec2(1,0)),f.x),mix(floorHash(i+vec2(0,1)),floorHash(i+vec2(1,1)),f.x),f.y);
  }
`;

// Keep the authored, baked illumination. These small view-dependent details
// restore depth without bringing the offline scene's lights into the XR frame.
export function refinePresentation(scene, models, field = null, obstacles = []) {
  scene.fog=new THREE.FogExp2(0x0a0303,.021);
  const floorUniforms={
    uCurtainField:{value:field?.texture??new THREE.DataTexture(new Uint8Array([255]),1,1,THREE.RedFormat,THREE.UnsignedByteType)},
    uCurtainFieldScale:{value:field?.scale??new THREE.Vector2()},
    uCurtainFieldOffset:{value:field?.offset??new THREE.Vector2(.5,.5)},
    uCurtainFieldRange:{value:field?.range??3},
    uRoomDream:{value:0},
  };
  if(!field)floorUniforms.uCurtainField.value.needsUpdate=true;
  // Where each chair and floor lamp stands now (see setFurniture), and the
  // outline on the floor of every piece of furniture, by obstacle index.
  const propUniforms={
    uPropShift:{value:obstacles.map(()=>new THREE.Vector4(0,0,1,0))},
    uPropPivot:{value:obstacles.map(o=>new THREE.Vector2(o.center[0],o.center[1]))},
  };
  const outlines={},doubleIndex=obstacles.findIndex(o=>/double/i.test(o.name)),doubleOutline=createOutline();
  for(const root of Object.values(models))root.traverse(object=>{
    if(!object.isMesh)return;
    const name=object.name.replaceAll('_',' ');
    const floor=name.includes(' floor');
    const props=name.includes(' props') || root===models.milo || root===models.double || root===models.repeated;
    if(!floor&&!props)return;
    if(props&&!object.geometry.attributes.normal)object.geometry.computeVertexNormals();
    // Only the furnished rooms have club chairs; the red double chair is velvet.
    const marks=props&&(root===models.environment||root===models.repeated)?markProps(object,obstacles):{leather:0,moving:0,outlines:{}};
    Object.assign(outlines,marks.outlines);
    const leather=marks.leather>0,moving=marks.moving>0;
    // The double chair is a model of its own, moved whole.
    if(root===models.double&&doubleIndex>=0){
      const position=object.geometry.getAttribute('position'),vector=new THREE.Vector3();
      object.updateWorldMatrix(true,false);
      for(let i=0;i<position.count;i++){vector.fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld);doubleOutline.add(vector.x,vector.z);}
    }
    // A moved piece can stand a little outside the mesh's bounds.
    let fromWorld=null;
    if(moving){
      fromWorld=object.matrixWorld.clone().invert();
      object.geometry.computeBoundingSphere();
      object.geometry.boundingSphere.radius+=.25/object.matrixWorld.getMaxScaleOnAxis();
    }
    const material=object.material.clone();
    material.dithering=true;
    material.customProgramCacheKey=()=>(floor?'room-floor-v4':leather?'room-leather-v1':'room-soft-sheen-v2')+(moving?`|moving-${obstacles.length}`:'');
    material.onBeforeCompile=shader=>{
      const declarations='varying vec3 vRoomPosition; varying vec3 vRoomNormal; varying vec3 vRoomView;\n'+(leather?'varying float vPropLeather;\n':'');
      shader.vertexShader=declarations+(leather?'attribute float propLeather;\n':'')+shader.vertexShader;
      shader.fragmentShader=declarations+(leather?LEATHER_FUNCTIONS:'')+shader.fragmentShader;
      if(floor){
        Object.assign(shader.uniforms,floorUniforms);
        shader.fragmentShader='uniform sampler2D uCurtainField; uniform vec2 uCurtainFieldScale; uniform vec2 uCurtainFieldOffset; uniform float uCurtainFieldRange; uniform float uRoomDream;\n'+FLOOR_FUNCTIONS+shader.fragmentShader;
      }
      if(moving){
        Object.assign(shader.uniforms,propUniforms,{uPropFromWorld:{value:fromWorld}});
        shader.vertexShader=`attribute float propObject; uniform vec4 uPropShift[${obstacles.length}]; uniform vec2 uPropPivot[${obstacles.length}]; uniform mat4 uPropFromWorld;\n`+
          shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n'+MOVE_PROP);
      }
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vRoomPosition=(modelMatrix*vec4(transformed,1.0)).xyz;
        vRoomView=-mvPosition.xyz;
        vRoomNormal=normalize(normalMatrix*${moving?'propNormal':'normal'});
        ${leather?'vPropLeather=propLeather;':''}`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        ${floor ? `
          vec2 p=vRoomPosition.xz;
          float a=exp(-dot(p-vec2(0.,1.8),p-vec2(0.,1.8))/24.);
          float b=exp(-dot(p-vec2(-7.2,-3.),p-vec2(-7.2,-3.))/18.);
          float e=exp(-dot(p-vec2(-25.,8.),p-vec2(-25.,8.))/22.);
          float f=exp(-dot(p-vec2(-7.,22.5),p-vec2(-7.,22.5))/24.);
          float pool=max(max(a,b),max(e,f));
          float footprint=max(length(dFdx(p)),length(dFdy(p)));
          // Worn linoleum: a soft mottle at ~2 cm and a speckle at ~6 mm, each
          // fading out before it is small enough to shimmer.
          float grain=(floorNoise(p*48.)-.5)*.1*(1.-smoothstep(.006,.02,footprint))
            +(floorNoise(p*160.+7.3)-.5)*.08*(1.-smoothstep(.002,.007,footprint));
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
          ${leather?LEATHER_LIGHT:''}
        `}`);
    };
    object.material=material;
  });
  if(doubleIndex>=0&&models.double)outlines[doubleIndex]=doubleOutline.points();
  // Pieces that are models of their own move as a whole: the double chair, and
  // the Venus de Milo of the statue corridor.
  const wholes=[[models.double,doubleIndex],[models.milo,obstacles.findIndex(o=>/^B \| statue$/i.test(o.name))]]
    .filter(([root,index])=>root&&index>=0)
    .map(([root,index])=>({root,index,home:new THREE.Matrix4().compose(root.position,root.quaternion,root.scale)}));
  const turn=new THREE.Matrix4(),placed=new THREE.Matrix4(),back=new THREE.Matrix4();
  return {
    outlines,
    setDream(value){floorUniforms.uRoomDream.value=value?1:0;},
    // { [obstacle index]: { dx, dz, yaw } } from furniture.js; a piece left
    // out goes back to where it stood.
    setFurniture(shifts={}){
      propUniforms.uPropShift.value.forEach((shift,index)=>{
        const {dx=0,dz=0,yaw=0}=shifts[index]??{};
        shift.set(dx,dz,Math.cos(yaw),Math.sin(yaw));
      });
      for(const {root,index,home} of wholes){
        const {dx=0,dz=0,yaw=0}=shifts[index]??{},[x,z]=propUniforms.uPropPivot.value[index].toArray();
        // three.js turns x away from z; furniture.js turns x toward it.
        placed.makeTranslation(x+dx,0,z+dz).multiply(turn.makeRotationY(-yaw)).multiply(back.makeTranslation(-x,0,-z)).multiply(home);
        placed.decompose(root.position,root.quaternion,root.scale);
      }
    },
  };
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

// The headset shows nothing but the room's subtitles, low in the view.
export function createXRNotice(camera) {
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=220;
  const context=canvas.getContext('2d');
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const panel=new THREE.Mesh(new THREE.PlaneGeometry(.82,.176),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,depthTest:false,fog:false}));
  panel.position.set(0,-.29,-1.25);panel.renderOrder=9999;panel.frustumCulled=false;panel.visible=false;camera.add(panel);
  let expires=0;
  // A spoken line: bare outlined text over the room, English above Chinese,
  // each scaled down to fit the panel.
  function caption(english,chinese='',duration=4000){
    context.clearRect(0,0,1024,220);
    context.textAlign='center';context.lineJoin='round';context.lineWidth=7;context.strokeStyle='rgba(0,0,0,.78)';
    for(const [text,y,size,color] of [[english,92,36,'#f6f1e7'],[chinese,154,29,'#e9dfd0']]){
      context.font=`${size}px sans-serif`;
      context.font=`${Math.floor(size*Math.min(1,990/Math.max(1,context.measureText(text).width)))}px sans-serif`;
      context.strokeText(text,512,y);context.fillStyle=color;context.fillText(text,512,y);
    }
    texture.needsUpdate=true;panel.visible=true;expires=performance.now()+duration;
  }
  return {caption,hide:()=>{panel.visible=false;},update:active=>{panel.visible=active&&performance.now()<expires;}};
}
