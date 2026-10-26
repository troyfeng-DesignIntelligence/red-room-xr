import * as THREE from 'three';

const clamp01=value=>Math.max(0,Math.min(1,value));
const smoothstep=value=>{const t=clamp01(value);return t*t*(3-2*t);};
const distance=(a,b)=>Math.hypot(b[0]-a[0],b[1]-a[1]);

function arcLengths(path) {
  const lengths=[0];
  for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+distance(path[i-1],path[i]));
  return lengths;
}

function pointAt(path,lengths,arc) {
  if(arc<=0)return path[0];
  if(arc>=lengths.at(-1))return path.at(-1);
  let low=1,high=lengths.length-1;
  while(low<high){const mid=(low+high)>>1;if(lengths[mid]<arc)low=mid+1;else high=mid;}
  const t=(arc-lengths[low-1])/(lengths[low]-lengths[low-1]||1);
  return [path[low-1][0]+t*(path[low][0]-path[low-1][0]),path[low-1][1]+t*(path[low][1]-path[low-1][1])];
}

// Average over the pleats, retaining the original opening endpoints. Sampling
// the resulting centreline every 12 cm keeps subsequent proximity work small.
export function smoothCurtainPath(points) {
  const lengths=arcLengths(points),end=lengths.at(-1),radius=.42;
  const smoothed=points.map((point,i)=>{
    let x=0,z=0,weight=0;
    for(let j=i;j>=0&&lengths[i]-lengths[j]<=radius;j--){
      const w=1-(lengths[i]-lengths[j])/radius;
      x+=points[j][0]*w;z+=points[j][1]*w;weight+=w;
    }
    for(let j=i+1;j<points.length&&lengths[j]-lengths[i]<=radius;j++){
      const w=1-(lengths[j]-lengths[i])/radius;
      x+=points[j][0]*w;z+=points[j][1]*w;weight+=w;
    }
    const blend=smoothstep(Math.min(lengths[i],end-lengths[i])/.3);
    return [point[0]+(x/weight-point[0])*blend,point[1]+(z/weight-point[1])*blend];
  });
  const smoothLengths=arcLengths(smoothed),total=smoothLengths.at(-1),count=Math.max(1,Math.ceil(total/.12));
  return Array.from({length:count+1},(_,i)=>pointAt(smoothed,smoothLengths,total*i/count).slice());
}

// How sharply the hanging line turns around each path sample (0 straight, 1 a
// corner), spread about 0.4 m either side so the whole corner is covered.
export function cornerWeights(path) {
  const turn=path.map((point,i)=>{
    if(i<3||i>path.length-4)return 0;
    const a=Math.atan2(point[1]-path[i-3][1],point[0]-path[i-3][0]),b=Math.atan2(path[i+3][1]-point[1],path[i+3][0]-point[0]);
    const degrees=Math.abs((((b-a)*180/Math.PI)+540)%360-180);
    return smoothstep((degrees-20)/45);
  });
  return turn.map((_,i)=>{
    let weight=0;
    for(let j=Math.max(0,i-4);j<=Math.min(turn.length-1,i+4);j++)weight=Math.max(weight,turn[j]*(1-Math.abs(j-i)/5));
    return weight;
  });
}

// Each row of a panel separated into its pleats and the slow sway they hang
// on: the pleat is what is left after a Hann-weighted average over about two
// pleats. Slopes are along the hanging line, in metres per metre. Some rows of
// the exported cloth alternate between two heights a few millimetres apart;
// heights within 2.5 cm are read as one row.
export function pleatRows(samples,window=.17) {
  const label=new Map();
  let row=0,last=-Infinity;
  for(const height of [...new Set(samples.map(sample=>Math.round(sample.y*1000)))].sort((a,b)=>a-b)){
    if(height-last>25)row++;
    label.set(height,row);last=height;
  }
  const rows=new Map();
  for(const sample of samples){
    const key=label.get(Math.round(sample.y*1000));
    if(!rows.has(key))rows.set(key,[]);
    rows.get(key).push(sample);
  }
  for(const list of rows.values()){
    list.sort((a,b)=>a.arc-b.arc);
    for(let i=0;i<list.length;i++){
      let sum=0,weight=0;
      for(let j=i;j>=0&&list[i].arc-list[j].arc<=window;j--){const w=.5+.5*Math.cos(Math.PI*(list[i].arc-list[j].arc)/window);sum+=list[j].offset*w;weight+=w;}
      for(let j=i+1;j<list.length&&list[j].arc-list[i].arc<=window;j++){const w=.5+.5*Math.cos(Math.PI*(list[j].arc-list[i].arc)/window);sum+=list[j].offset*w;weight+=w;}
      list[i].pleat=list.length<8?0:list[i].offset-sum/weight;
    }
    for(let i=0;i<list.length;i++){
      const a=list[Math.max(0,i-1)],b=list[Math.min(list.length-1,i+1)],span=b.arc-a.arc;
      list[i].pleatSlope=span>.005?Math.max(-6,Math.min(6,(b.pleat-a.pleat)/span)):0;
      list[i].offsetSlope=span>.005?Math.max(-6,Math.min(6,(b.offset-a.offset)/span)):0;
    }
  }
  return samples;
}

function nearestArc(point,path,lengths) {
  let best=Infinity,arc=0;
  for(let i=1;i<path.length;i++){
    const dx=path[i][0]-path[i-1][0],dz=path[i][1]-path[i-1][1];
    const t=clamp01(((point[0]-path[i-1][0])*dx+(point[1]-path[i-1][1])*dz)/(dx*dx+dz*dz||1));
    const ex=point[0]-path[i-1][0]-t*dx,ez=point[1]-path[i-1][1]-t*dz,d=ex*ex+ez*ez;
    if(d<best){best=d;arc=lengths[i-1]+t*(lengths[i]-lengths[i-1]);}
  }
  return arc;
}

function readPanels(mesh) {
  const geometry=mesh.geometry,position=geometry.getAttribute('position'),index=geometry.getIndex();
  if(!index)throw new Error(`Curtain surface requires indexed geometry: ${mesh.name}`);
  const count=position.count,parent=Int32Array.from({length:count},(_,i)=>i),world=new Float64Array(count*3);
  const vector=new THREE.Vector3(),edges=new Map();
  // Accessor getters decode normalized Int16 positions before the GLB node's
  // quantization scale and translation are applied.
  for(let i=0;i<count;i++){
    vector.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld);
    world.set([vector.x,vector.y,vector.z],i*3);
  }
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a,b)=>{parent[find(a)]=find(b);};
  const edge=(a,b)=>{const key=Math.min(a,b)*count+Math.max(a,b);edges.set(key,(edges.get(key)||0)+1);};
  for(let i=0;i<index.count;i+=3){
    const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2);
    join(a,b);join(a,c);edge(a,b);edge(b,c);edge(c,a);
  }
  const groups=new Map();
  for(let i=0;i<count;i++){
    const root=find(i);
    if(!groups.has(root))groups.set(root,{vertices:[],boundary:[],minY:Infinity,maxY:-Infinity});
    const group=groups.get(root),y=world[i*3+1];
    group.vertices.push(i);group.minY=Math.min(group.minY,y);group.maxY=Math.max(group.maxY,y);
  }
  for(const [key,uses] of edges)if(uses===1){
    const a=Math.floor(key/count),b=key%count;
    groups.get(find(a)).boundary.push([a,b]);
  }
  const result=[];
  for(const group of groups.values()){
    // The final height interval is >1 m in the exported meshes. This threshold
    // includes their slightly uneven top row while excluding the row below.
    const topThreshold=group.maxY-Math.min(.35,(group.maxY-group.minY)*.08);
    const top=new Map(),pinned=new Set();
    for(const [a,b] of group.boundary){
      // Every boundary vertex belongs to the hem, header or an opening edge.
      // Pin the actual topology as well as fading adjacent interior vertices.
      pinned.add(a);pinned.add(b);
      if(world[a*3+1]>topThreshold&&world[b*3+1]>topThreshold){
        if(!top.has(a))top.set(a,[]);if(!top.has(b))top.set(b,[]);
        top.get(a).push(b);top.get(b).push(a);
      }
    }
    const endpoints=[...top.keys()].filter(i=>top.get(i).length===1);
    if(endpoints.length!==2||[...top.values()].some(neighbours=>neighbours.length>2)){
      throw new Error(`Curtain header is not an open strip: ${mesh.name}`);
    }
    endpoints.sort((a,b)=>world[a*3]-world[b*3]||world[a*3+2]-world[b*3+2]);
    let current=endpoints[0],previous=-1;
    const points=[];
    while(current!==undefined){
      points.push([world[current*3],world[current*3+2]]);
      const next=top.get(current).find(i=>i!==previous);previous=current;current=next;
    }
    if(points.length!==top.size)throw new Error(`Curtain header is disconnected: ${mesh.name}`);
    result.push({...group,pinned,path:smoothCurtainPath(points)});
  }
  return {world,groups:result};
}

/** Build one-time, world-space cloth data without changing authored assets. */
export function prepareCurtainSurfaces(models) {
  const meshes=[],panels=[],identities=new Map(),seen=new Set();
  for(const root of Object.values(models)){
    if(!root?.traverse)continue;
    root.updateWorldMatrix(true,true);
    root.traverse(mesh=>{
      if(!mesh.isMesh||seen.has(mesh)||!/(?:^|[ _])drape(?:[ _]|$)/i.test(mesh.name))return;
      seen.add(mesh);meshes.push(mesh);
      const {world,groups}=readPanels(mesh),count=mesh.geometry.getAttribute('position').count;
      const attributes=new Float32Array(count*4),folds=new Float32Array(count*2),shapes=new Float32Array(count*4),heights=new Float32Array(count);
      for(const group of groups){
        const {path,minY,maxY}=group,lengths=arcLengths(path),total=lengths.at(-1),corners=cornerWeights(path),samples=[];
        // The normal and dream room F have identical geometry. Sharing their
        // ID keeps an ongoing contact response continuous across a state swap.
        const identity=path.map(p=>p.map(v=>v.toFixed(4)).join(',')).join(';')+`|${minY.toFixed(4)},${maxY.toFixed(4)}`;
        if(!identities.has(identity))identities.set(identity,identities.size+1);
        const id=identities.get(identity);
        panels.push({id,path,minY,maxY,meshName:mesh.name,mesh});
        for(const i of group.vertices){
          const y=world[i*3+1],arc=nearestArc([world[i*3],world[i*3+2]],path,lengths);
          const before=pointAt(path,lengths,arc-.18),after=pointAt(path,lengths,arc+.18);
          const dx=after[0]-before[0],dz=after[1]-before[1],length=Math.hypot(dx,dz)||1;
          const heightFraction=clamp01((y-minY)/(maxY-minY||1));
          const weight=group.pinned.has(i)?0:Math.pow(1-heightFraction,1.35)*smoothstep((y-minY)/.16)*smoothstep(Math.min(arc,total-arc)/.22);
          attributes.set([-dz/length,dx/length,weight,id],i*4);
          // Signed distance from the smoothed centreline along its normal:
          // positive on the normal's side. With the arc it lets the shader
          // tell crests from troughs and place pools of light along the panel.
          const centre=pointAt(path,lengths,arc);
          const offset=(world[i*3]-centre[0])*(-dz/length)+(world[i*3+2]-centre[1])*(dx/length);
          folds.set([offset,arc],i*2);
          heights[i]=heightFraction;
          samples.push({index:i,arc,y,offset,corner:corners[Math.min(corners.length-1,Math.round(arc/(total||1)*(corners.length-1)))]});
        }
        // Pleats, their slopes and the corners, for reshaping the cloth in the shader.
        for(const sample of pleatRows(samples))shapes.set([sample.pleat,sample.pleatSlope,sample.offsetSlope,sample.corner],sample.index*4);
      }
      mesh.geometry.setAttribute('curtainSurface',new THREE.Float32BufferAttribute(attributes,4));
      mesh.geometry.setAttribute('curtainFold',new THREE.Float32BufferAttribute(folds,2));
      mesh.geometry.setAttribute('curtainShape',new THREE.Float32BufferAttribute(shapes,4));
      mesh.geometry.setAttribute('curtainHeight',new THREE.Float32BufferAttribute(heights,1));
      mesh.geometry.computeBoundingSphere();
      const scale=new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
      // Room for deeper pleats, rounded corners and the cloth's movement.
      mesh.geometry.boundingSphere.radius+=.45/Math.max(1e-8,Math.min(Math.abs(scale.x),Math.abs(scale.y),Math.abs(scale.z)));
    });
  }
  return {panels,meshes};
}
