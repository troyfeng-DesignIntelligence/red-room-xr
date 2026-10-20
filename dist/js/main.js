import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.mjs';
import { createSimulation } from './simulation.js';
import { createXRControls } from './xr-controls.js';

const $ = id => document.getElementById(id);
const ui = {
  welcome:$('welcome'), hud:$('hud'), footer:$('footer'), desktop:$('enter-desktop'),
  vr:$('enter-vr'), status:$('xr-status'), load:$('load-status'), bar:$('load-bar')
};
const state = { ready:false, exploring:false, xrSupported:false, route:false, yaw:0, pitch:-.03, keys:new Set(), touch:new Set() };
let renderer, scene, camera, rig, simulation, controls, spatial, models, comfortShell, contactShadows;
let toastTimeout;
const pointer = { active:false, id:null, x:0, y:0 };
const worldHead = new THREE.Vector3();
const clock = new THREE.Clock();
const routeMarker = new THREE.Group();
const isTouch = matchMedia('(pointer:coarse)').matches;

function toast(message) {
  $('toast').textContent=message; $('toast').classList.add('show');
  clearTimeout(toastTimeout); toastTimeout=setTimeout(()=>$('toast').classList.remove('show'),4200);
}
function fail(error) {
  console.error(error);
  $('error-message').textContent='请刷新页面重试。若仍无法打开，请确认浏览器已启用硬件加速。'+(error?.message ? `（${error.message}）`:'');
  $('error').hidden=false;
}
function setPhase() {
  if(!models || !simulation) return;
  const changed=simulation.state.phase!=='normal';
  models.milo.visible=!changed;
  models.repeated.visible=!changed;
  models.double.visible=changed;
  models.dreamCurtains.visible=changed;
  models.environment.traverse(object=>{
    if(object.name.replaceAll('_',' ').replace(/\s+/g,' ').trim()==='environment | F drape')object.visible=!changed;
  });
  $('lap-label').textContent=`第 ${simulation.state.lap} 圈 · ${changed?'某些事物变了':'熟悉的房间'}`;
  if(contactShadows){
    const transform=new THREE.Object3D();let count=0;
    for(const obstacle of spatial.obstacles){
      if(obstacle.state && obstacle.state!==simulation.state.phase)continue;
      transform.position.set(obstacle.center[0],.006,obstacle.center[1]);
      transform.rotation.x=-Math.PI/2;transform.scale.setScalar(obstacle.radius*2.6);
      transform.updateMatrix();contactShadows.setMatrixAt(count++,transform.matrix);
    }
    contactShadows.count=count;contactShadows.instanceMatrix.needsUpdate=true;
    contactShadows.computeBoundingSphere();
  }
}
function initContactShadows(){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const context=canvas.getContext('2d');
  const gradient=context.createRadialGradient(32,32,1,32,32,32);
  gradient.addColorStop(0,'rgba(0,0,0,.58)');gradient.addColorStop(.45,'rgba(0,0,0,.3)');gradient.addColorStop(1,'rgba(0,0,0,0)');
  context.fillStyle=gradient;context.fillRect(0,0,64,64);
  const texture=new THREE.CanvasTexture(canvas);
  contactShadows=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}),spatial.obstacles.length);
  contactShadows.renderOrder=1;scene.add(contactShadows);
}
function setExploring(value) {
  state.exploring=value;
  document.body.classList.toggle('exploring',value);
  ui.welcome.hidden=value; ui.hud.hidden=!value; ui.footer.hidden=value;
  $('touch-controls').hidden=!value || !isTouch;
  if(!value) { state.keys.clear(); state.touch.clear(); pointer.active=false; }
}
function reset() {
  if(!state.ready) return;
  const p=spatial.spawn.position;
  rig.position.set(p[0],0,p[2]); rig.rotation.set(0,0,0);
  state.yaw=spatial.spawn.yaw||0; state.pitch=-.03;
  camera.position.set(0,1.65,0); camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
  simulation.resetProgress(); setPhase(); controls.reset();
  toast('回到等候室。沿帘幕左侧的通道开始探索。');
}
function roomAt(x,z) {
  if(x<-19.15) return ['05','空桌房间'];
  if(z>16.9) return ['06','镜像等候室'];
  if(z>8.5 || (x<-12.4 && z>2.7)) return ['04','回返走廊'];
  if(x<-9.2 && z<2.8) return ['03','空置的房间'];
  if(x<-5.6 && x>-9.2) return ['02','雕像长廊'];
  return ['01','等候室'];
}
function resize() {
  if(!renderer || renderer.xr.isPresenting) return;
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
}
function setupDesktop() {
  const canvas=renderer.domElement;
  canvas.addEventListener('pointerdown',e=>{
    if(!state.exploring || renderer.xr.isPresenting || e.button!==0) return;
    pointer.active=true;pointer.id=e.pointerId;pointer.x=e.clientX;pointer.y=e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!pointer.active || pointer.id!==e.pointerId) return;
    state.yaw-=(e.clientX-pointer.x)*.003;
    state.pitch=THREE.MathUtils.clamp(state.pitch-(e.clientY-pointer.y)*.003,-1.25,1.25);
    pointer.x=e.clientX;pointer.y=e.clientY;
  });
  const release=()=>{pointer.active=false;};
  canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  addEventListener('keydown',e=>{
    if(e.code==='Escape' && state.exploring && !renderer.xr.isPresenting) setExploring(false);
    if(!state.exploring || document.querySelector('dialog[open]')) return;
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)){
      e.preventDefault();state.keys.add(e.code);
    }
  });
  addEventListener('keyup',e=>state.keys.delete(e.code));
  addEventListener('blur',()=>{state.keys.clear();state.touch.clear();pointer.active=false;});
  document.querySelectorAll('[data-move]').forEach(button=>{
    button.addEventListener('pointerdown',e=>{e.preventDefault();button.setPointerCapture(e.pointerId);state.touch.add(button.dataset.move);});
    ['pointerup','pointercancel','lostpointercapture'].forEach(event=>button.addEventListener(event,()=>state.touch.delete(button.dataset.move)));
  });
}
function updateDesktop(dt) {
  if(!state.exploring || document.querySelector('dialog[open]')) return;
  const keys=state.keys, t=state.touch;
  let forward=Number(keys.has('KeyW')||keys.has('ArrowUp')||t.has('forward'))-Number(keys.has('KeyS')||keys.has('ArrowDown')||t.has('back'));
  let side=Number(keys.has('KeyD')||keys.has('ArrowRight')||t.has('right'))-Number(keys.has('KeyA')||keys.has('ArrowLeft')||t.has('left'));
  const length=Math.hypot(forward,side);
  if(length){
    forward/=length;side/=length;
    const dx=(-Math.sin(state.yaw)*forward+Math.cos(state.yaw)*side)*dt*1.55;
    const dz=(-Math.cos(state.yaw)*forward-Math.sin(state.yaw)*side)*dt*1.55;
    const position=simulation.move({x:rig.position.x,z:rig.position.z},dx,dz);
    rig.position.x=position.x;rig.position.z=position.z;
    simulation.updateProgress(position.x,position.z);
  }
  camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
}
function initRouteMarker(){
  const material=new THREE.MeshBasicMaterial({color:0xdcc29c,transparent:true,opacity:.66,depthWrite:false});
  const ring=new THREE.Mesh(new THREE.RingGeometry(.19,.23,32),material);
  ring.rotation.x=-Math.PI/2;routeMarker.add(ring);
  const dot=new THREE.Mesh(new THREE.ConeGeometry(.07,.2,3),material);
  dot.position.y=.16;routeMarker.add(dot);
  routeMarker.visible=false;scene.add(routeMarker);
}
function updateRouteMarker(time) {
  routeMarker.visible=state.route && state.exploring;
  if(!routeMarker.visible) return;
  const cp=simulation.checkpoints[simulation.state.checkpointIndex % simulation.checkpoints.length];
  if(!cp) return;
  const x=cp.x??cp[0], z=cp.z??cp[1];
  routeMarker.position.set(x,.018,z);
  routeMarker.children[1].rotation.y=time*.0006;
}
async function checkXR(){
  if(!window.isSecureContext) { ui.status.textContent='VR 模式需要通过 HTTPS 打开。电脑漫游仍可使用。';ui.vr.textContent='需要 HTTPS';return; }
  try { state.xrSupported=!!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); }
  catch {state.xrSupported=false;}
  ui.vr.textContent=state.xrSupported?'进入 VR':'在头显中打开';
  ui.status.textContent=state.xrSupported?'已检测到 VR 支持。按住扳机传送，摇杆分段转向。':'当前浏览器未提供 VR 会话。可先电脑漫游，或在支持 WebXR 的头显浏览器中打开此链接。';
  ui.vr.disabled=!state.ready || !state.xrSupported;
}
async function enterVR(){
  if(!state.ready || !state.xrSupported || renderer.xr.isPresenting) return;
  ui.vr.disabled=true;
  try {
    const session=await navigator.xr.requestSession('immersive-vr',{requiredFeatures:['local-floor'],optionalFeatures:['bounded-floor']});
    await renderer.xr.setSession(session);
  } catch(error) { toast('未能进入 VR：'+error.message); ui.vr.disabled=false; }
}
function setupXR(){
  renderer.xr.enabled=true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(1);
  const fadeMaterial=new THREE.MeshBasicMaterial({color:0x050000,side:THREE.BackSide,transparent:true,opacity:0,depthWrite:false,depthTest:false});
  comfortShell=new THREE.Mesh(new THREE.SphereGeometry(.16,16,12),fadeMaterial);
  comfortShell.frustumCulled=false;comfortShell.renderOrder=10000;comfortShell.visible=false;camera.add(comfortShell);
  controls=createXRControls({renderer,scene,rig,camera,simulation,onComfortFade:amount=>{
    fadeMaterial.opacity=amount; comfortShell.visible=amount>.005;
  },onTeleport:()=>{},onStateChange:setPhase});
  renderer.xr.addEventListener('sessionstart',()=>{
    state.keys.clear();state.touch.clear();setExploring(true);
    rig.rotation.y=state.yaw;
    camera.position.set(0,0,0);camera.rotation.set(0,0,0);
    $('experience').classList.add('immersive');
    controls.reset();
  });
  renderer.xr.addEventListener('sessionend',()=>{
    camera.getWorldPosition(worldHead);
    const direction=new THREE.Vector3();camera.getWorldDirection(direction);
    state.yaw=Math.atan2(-direction.x,-direction.z);state.pitch=0;
    const candidate=simulation.isValidPosition(worldHead.x,worldHead.z) ? worldHead : rig.position.clone();
    rig.position.set(candidate.x,0,candidate.z);rig.rotation.set(0,0,0);
    camera.position.set(0,1.65,0);camera.rotation.set(0,state.yaw,0,'YXZ');
    comfortShell.visible=false;
    $('experience').classList.remove('immersive');ui.vr.disabled=false;
    setExploring(false);resize();
  });
}
async function init(){
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,isTouch?1.25:1.5));
  renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;
  $('canvas-wrap').appendChild(renderer.domElement);
  scene=new THREE.Scene();scene.background=new THREE.Color(0x080101);
  camera=new THREE.PerspectiveCamera(65,innerWidth/innerHeight,.04,90);
  rig=new THREE.Group();scene.add(rig);rig.add(camera);
  const response=await fetch('./assets/spatial.json');if(!response.ok) throw new Error('空间数据加载失败');
  spatial=await response.json();
  simulation=createSimulation(spatial,{onLapChange:()=>{setPhase();toast('你回来了。');}});
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const entries=[['environment','environment.glb'],['milo','milo.glb'],['repeated','repeated-props.glb'],['double','double-chair.glb'],['dreamCurtains','dream-curtains.glb']];
  models={};let completed=0;
  await Promise.all(entries.map(async([key,file])=>{
    const gltf=await loader.loadAsync('./assets/'+file);
    models[key]=gltf.scene;scene.add(gltf.scene);
    completed++;ui.bar.style.width=`${completed/entries.length*100}%`;
    ui.load.textContent=`场景准备中 · ${completed} / ${entries.length}`;
  }));
  initContactShadows();setPhase();initRouteMarker();setupDesktop();setupXR();
  state.ready=true;reset();
  $('toast').classList.remove('show');
  ui.desktop.disabled=false;ui.desktop.innerHTML='进入房间<span>↗</span>';
  ui.load.textContent='场景已就绪 · 以真实尺度探索';
  $('poster').classList.add('loaded');
  await checkXR();
  renderer.setAnimationLoop(time=>{
    const dt=Math.min(clock.getDelta(),.05);
    if(renderer.xr.isPresenting) controls.update(dt);else updateDesktop(dt);
    camera.getWorldPosition(worldHead);
    const room=roomAt(worldHead.x,worldHead.z);
    $('room-code').textContent=room[0];$('room-name').textContent=room[1];
    updateRouteMarker(time);
    renderer.render(scene,camera);
  });
  if(new URLSearchParams(location.search).has('debug')){
    window.__redRoom={renderer,scene,camera,rig,simulation,spatial,models,state,controls,
      setExploring,reset,
      inspect:()=>({position:rig.position.toArray(),phase:simulation.state.phase,lap:simulation.state.lap,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,assets:Object.keys(models),xr:renderer.xr.isPresenting}),
      setPose:(x,z,yaw=0,pitch=0)=>{rig.position.set(x,0,z);rig.rotation.set(0,0,0);state.yaw=yaw;state.pitch=pitch;camera.rotation.set(pitch,yaw,0,'YXZ');},
      setPhase
    };
  }
}
ui.desktop.addEventListener('click',()=>setExploring(true));
ui.vr.addEventListener('click',enterVR);
$('menu-button').addEventListener('click',()=>setExploring(false));
$('reset-button').addEventListener('click',reset);
$('route-button').addEventListener('click',()=>{
  state.route=!state.route;$('route-button').textContent=state.route?'隐藏路线':'路线提示';
  if(state.route)toast('沿地面上的微光路标行走。绕行一圈后，房态会改变。');
});
for(const [button,dialog] of [['help-button','help-dialog'],['credits-button','credits-dialog']]){
  $(button).addEventListener('click',()=>{state.keys.clear();state.touch.clear();$(dialog).showModal();});
}
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();}));
addEventListener('resize',resize);
checkXR();
init().catch(fail);
