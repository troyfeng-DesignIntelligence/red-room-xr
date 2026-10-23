import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.mjs';
import { createSimulation } from './simulation.js';
import { createXRControls } from './xr-controls.js';
import { createCurtainField, refinePresentation, createNavigationGuide, createXRNotice } from './presentation.js';
import { createCurtainInteraction } from './curtains.js';
import { createFilmEffects } from './film.js';
import { createWalker } from './locomotion.js';
import { createRoomAudio } from './audio.js';

const $ = id => document.getElementById(id);
const ui = {
  welcome:$('welcome'), hud:$('hud'), footer:$('footer'), desktop:$('enter-desktop'),
  vr:$('enter-vr'), status:$('xr-status'), load:$('load-status'), bar:$('load-bar')
};
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EYE_HEIGHT = 1.65;
const state = { ready:false, exploring:false, entered:false, xrSupported:false, route:false, bob:false, yaw:0, pitch:-.03, keys:new Set(), touch:new Set() };
let renderer, scene, camera, rig, simulation, controls, spatial, models, comfortShell, contactShadows, navigation, xrNotice, curtains, film, presentation;
let lastFilmLook='film';
let comfortAmount=0, resetFadeUntil=0, previousTime=0, previousRoom='', previousLap=1, lastEmitted=0;
let toastTimeout, chromeTimeout, hintTimeout, introTimeout;
const pointer = { active:false, id:null, x:0, y:0, travel:0 };
const worldHead = new THREE.Vector3();
const listenerForward = new THREE.Vector3();
const desktopContact={id:'body',x:0,y:1.2,z:0,radius:.68,intentX:0,intentZ:0};
const desktopContacts=[desktopContact];
const isTouch = matchMedia('(pointer:coarse)').matches;
const walker = createWalker();
const audio = createRoomAudio();
document.body.classList.toggle('touch',isTouch);
document.body.classList.toggle('debug',params.has('debug'));
try{state.bob=localStorage.getItem('red-room-bob')==='on';}catch{}

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
  presentation?.setDream(changed);
  models.environment.traverse(object=>{
    if(object.name.replaceAll('_',' ').replace(/\s+/g,' ').trim()==='environment | F drape')object.visible=!changed;
  });
  // Development readout only (?debug). The walk itself never names a change.
  $('lap-label').textContent=`第 ${simulation.state.lap} 圈 · ${simulation.state.phase}`;
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
// A completed circuit is heard rather than announced: the drone drops out
// and returns changed. A reset returns quietly.
function onLapChange() {
  setPhase();
  audio.setPhase(simulation.state.phase,{dip:simulation.state.lap>previousLap});
  previousLap=simulation.state.lap;
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
// The walk shows only the room. Controls surface briefly after entering, on
// mouse movement, and when the pointer lock is released; touch keeps them.
function revealChrome(duration=2600){
  if(!state.exploring)return;
  document.body.classList.add('chrome-visible');
  clearTimeout(chromeTimeout);
  chromeTimeout=setTimeout(()=>document.body.classList.remove('chrome-visible'),duration);
}
function showHint(duration=6000){
  document.body.classList.add('hint-visible');
  clearTimeout(hintTimeout);
  hintTimeout=setTimeout(()=>document.body.classList.remove('hint-visible'),duration);
}
function hideChrome(){
  clearTimeout(chromeTimeout);clearTimeout(hintTimeout);
  document.body.classList.remove('chrome-visible','hint-visible');
}
// Entering dips to black and the room tone rises in the dark before the room
// fades in. Re-entering from the menu uses a short dip.
function playIntro(full){
  clearTimeout(introTimeout);
  document.body.classList.add('entering');
  document.body.classList.toggle('intro-long',full);
  introTimeout=setTimeout(()=>{
    document.body.classList.remove('entering');
    const linger=full?9000:6000;
    revealChrome(linger);showHint(linger);
  },full?1500:350);
}
function cancelIntro(){
  clearTimeout(introTimeout);
  document.body.classList.remove('entering','intro-long');
}
function setExploring(value) {
  state.exploring=value;
  document.body.classList.toggle('exploring',value);
  ui.welcome.hidden=value; ui.hud.hidden=!value; ui.footer.hidden=value;
  $('touch-controls').hidden=!value || !isTouch;
  if(!value) { state.keys.clear(); state.touch.clear(); pointer.active=false; walker.stop(); hideChrome(); cancelIntro(); }
  if(!value&&document.pointerLockElement)document.exitPointerLock();
  audio.setLevel(value?1:.35);
}
function enterRoom() {
  if(!state.ready || state.exploring) return;
  const first=!state.entered;
  state.entered=true;
  setExploring(true);
  // One click is the gesture for the sound, the pointer lock and the entry.
  // Starting the sound after setExploring keeps its slow first fade-in.
  audio.start();
  captureMouse();
  playIntro(first);
}
function reset() {
  if(!state.ready) return;
  const p=spatial.spawn.position;
  state.yaw=spatial.spawn.yaw||0; state.pitch=-.035;
  if(renderer.xr.isPresenting){
    let pose=null;
    try{
      const frame=renderer.xr.getFrame(),referenceSpace=renderer.xr.getReferenceSpace();
      if(frame&&referenceSpace)pose=frame.getViewerPose(referenceSpace)?.transform||null;
    }catch{
      // A mirror-page button can run after the XR frame has expired.
      // The camera retains the most recent pose in the rig's local space.
    }
    const local=pose?new THREE.Vector3(pose.position.x,pose.position.y,pose.position.z):camera.position.clone();
    const q=pose?new THREE.Quaternion(pose.orientation.x,pose.orientation.y,pose.orientation.z,pose.orientation.w):camera.quaternion.clone();
    const trackedYaw=new THREE.Euler().setFromQuaternion(q,'YXZ').y;
    rig.rotation.set(0,state.yaw-trackedYaw,0);
    local.applyAxisAngle(new THREE.Vector3(0,1,0),rig.rotation.y);
    rig.position.set(p[0]-local.x,0,p[2]-local.z);
    rig.updateMatrixWorld(true);
  }else{
    rig.position.set(p[0],0,p[2]); rig.rotation.set(0,0,0);
    camera.position.set(0,EYE_HEIGHT,0); camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
  }
  walker.stop();
  simulation.resetProgress(); setPhase(); controls.reset();
  curtains?.reset();
  toast('回到等候室。沿帘幕左侧的通道开始探索。');
  if(renderer.xr.isPresenting){resetFadeUntil=performance.now()+160;xrNotice.show('回到等候室','A / X 切换路线提示');}
}
function setGuide(value){
  state.route=!!value;
  $('route-toggle').checked=state.route;
}
function toggleGuide(){
  setGuide(!state.route);
  if(state.route)toast('沿地面微光前行。路标会跟随通道转弯。');
  if(renderer.xr.isPresenting)xrNotice.show(state.route?'路线提示已开启':'路线提示已隐藏','双手握键按住 1.2 秒 · 回到起点');
}
function syncSoundUI(){
  const muted=audio.inspect().muted;
  $('sound-button').setAttribute('aria-pressed',String(!muted));
  $('sound-button').textContent=muted?'静音':'声音';
}
function syncLookUI(save=false){
  if(!film)return;
  const {look,strength}=film.inspect();
  document.querySelectorAll('[data-look]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.look===look)));
  $('look-strength').value=String(Math.round(strength*100));$('look-strength').disabled=look==='clean';
  $('look-value').textContent=Math.round(strength*100)+'%';
  $('look-button').title='当前画面：'+({clean:'原始',film:'胶片',dream:'梦境'}[look]);
  if(look!=='clean')lastFilmLook=look;
  if(save)try{localStorage.setItem('red-room-look',JSON.stringify({look,strength,lastFilmLook}));}catch{}
}
function toggleFilm(){
  if(!film)return;
  film.setLook(film.inspect().look==='clean'?lastFilmLook:'clean');syncLookUI(true);
  toast(film.inspect().look==='clean'?'原始画面':lastFilmLook==='dream'?'梦境 · 朦胧光晕':'胶片 · 柔光与细颗粒');
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
function captureMouse(){
  if(isTouch || renderer.xr.isPresenting || document.pointerLockElement) return;
  try{renderer.domElement.requestPointerLock?.()?.catch?.(()=>toast('按住鼠标拖动也可以环顾。'));}
  catch{toast('按住鼠标拖动也可以环顾。');}
}
function setupDesktop() {
  const canvas=renderer.domElement;
  if(isTouch)$('hint').textContent='左下方向键行走 · 拖动画面环顾';
  document.addEventListener('pointerlockchange',()=>{
    pointer.active=false;
    const locked=document.pointerLockElement===canvas;
    $('hint').textContent=locked?'W A S D 行走 · 移动鼠标环顾 · Esc 释放鼠标':'W A S D 行走 · 单击画面环顾 · Esc 回到菜单';
    if(!locked&&state.exploring&&!renderer.xr.isPresenting){revealChrome(4000);showHint(4000);}
  });
  document.addEventListener('pointermove',e=>{
    if(e.pointerType==='mouse'&&!pointer.active&&document.pointerLockElement!==canvas)revealChrome();
  });
  canvas.addEventListener('pointerdown',e=>{
    if(!state.exploring || renderer.xr.isPresenting || e.button!==0 || document.pointerLockElement===canvas) return;
    audio.start();
    pointer.active=true;pointer.id=e.pointerId;pointer.x=e.clientX;pointer.y=e.clientY;pointer.travel=0;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    const locked=document.pointerLockElement===canvas;
    if(!locked&&(!pointer.active || pointer.id!==e.pointerId)) return;
    const dx=locked?e.movementX:e.clientX-pointer.x,dy=locked?e.movementY:e.clientY-pointer.y;
    state.yaw-=dx*.003;
    state.pitch=THREE.MathUtils.clamp(state.pitch-dy*.003,-1.25,1.25);
    pointer.travel+=Math.abs(dx)+Math.abs(dy);pointer.x=e.clientX;pointer.y=e.clientY;
  });
  const release=()=>{pointer.active=false;};
  canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
  // A click that is not a drag locks the mouse for free looking again.
  canvas.addEventListener('click',()=>{if(state.exploring&&pointer.travel<6)captureMouse();});
  addEventListener('keydown',e=>{
    if(document.querySelector('dialog[open]'))return;
    if(e.code==='Escape' && state.exploring && !renderer.xr.isPresenting) setExploring(false);
    if(e.code==='KeyV'&&!e.repeat){toggleFilm();return;}
    if(!state.exploring) return;
    audio.start();
    if(e.code==='KeyG'&&!e.repeat){toggleGuide();return;}
    if(e.code==='KeyM'&&!e.repeat){captureMouse();return;}
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)){
      e.preventDefault();state.keys.add(e.code);
    }
  });
  addEventListener('keyup',e=>state.keys.delete(e.code));
  addEventListener('blur',()=>{state.keys.clear();state.touch.clear();pointer.active=false;});
  document.querySelectorAll('[data-move]').forEach(button=>{
    button.addEventListener('pointerdown',e=>{e.preventDefault();audio.start();button.setPointerCapture(e.pointerId);state.touch.add(button.dataset.move);});
    ['pointerup','pointercancel','lostpointercapture'].forEach(event=>button.addEventListener(event,()=>state.touch.delete(button.dataset.move)));
  });
}
function updateDesktop(dt) {
  desktopContact.intentX=desktopContact.intentZ=0;
  let directionX=0,directionZ=0;
  if(state.exploring && !document.querySelector('dialog[open]')){
    const keys=state.keys, t=state.touch;
    const forward=Number(keys.has('KeyW')||keys.has('ArrowUp')||t.has('forward'))-Number(keys.has('KeyS')||keys.has('ArrowDown')||t.has('back'));
    const side=Number(keys.has('KeyD')||keys.has('ArrowRight')||t.has('right'))-Number(keys.has('KeyA')||keys.has('ArrowLeft')||t.has('left'));
    directionX=-Math.sin(state.yaw)*forward+Math.cos(state.yaw)*side;
    directionZ=-Math.cos(state.yaw)*forward-Math.sin(state.yaw)*side;
  }
  // The eased velocity is also the push against a curtain when blocked.
  const velocity=walker.update(dt,directionX,directionZ);
  if(velocity.x||velocity.z){
    desktopContact.intentX=velocity.x;desktopContact.intentZ=velocity.z;
    const from={x:rig.position.x,z:rig.position.z};
    const position=simulation.move(from,velocity.x*dt,velocity.z*dt);
    rig.position.x=position.x;rig.position.z=position.z;
    simulation.updateProgress(position.x,position.z);
    const steps=walker.advance(Math.hypot(position.x-from.x,position.z-from.z));
    for(let i=0;i<steps;i++)audio.footstep(walker.speedFraction());
  }
  camera.position.y=EYE_HEIGHT+(state.bob&&!reducedMotion?walker.bob(.012):0);
  camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
}
// Each new contact wave on the velvet becomes a rustle, panned to its side.
function playCurtainContacts(){
  const {emitted}=curtains.motion.inspect();
  let fresh=Math.max(0,emitted-lastEmitted);lastEmitted=emitted;
  if(!fresh)return;
  camera.getWorldDirection(listenerForward);
  const flat=Math.hypot(listenerForward.x,listenerForward.z)||1;
  for(const impulse of curtains.motion.impulses){
    if(!fresh)break;
    if(!impulse.active||impulse.age>0)continue;
    fresh--;
    const dx=impulse.position.x-worldHead.x,dz=impulse.position.z-worldHead.z,distance=Math.hypot(dx,dz);
    const pan=distance>1e-4?(dz*listenerForward.x-dx*listenerForward.z)/(distance*flat):0;
    audio.rustle(impulse.strength/.1,pan,distance);
  }
}
async function checkXR(){
  if(!window.isSecureContext) { ui.status.textContent='VR 模式需要通过 HTTPS 打开。电脑漫游仍可使用。';ui.vr.textContent='需要 HTTPS';return; }
  try { state.xrSupported=!!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); }
  catch {state.xrSupported=false;}
  ui.vr.textContent=state.xrSupported?'进入 VR':'在头显中打开';
  ui.status.textContent=state.xrSupported?'已检测到 VR 支持。扳机传送 · 摇杆转向 · A/X 路线。':'本地场景已可在电脑中探索。VR 需要支持 WebXR 的浏览器与已连接的头显。';
  ui.vr.disabled=!state.ready || !state.xrSupported;
}
async function enterVR(){
  if(!state.ready || !state.xrSupported || renderer.xr.isPresenting) return;
  audio.start();
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
  xrNotice=createXRNotice(camera);
  controls=createXRControls({renderer,scene,rig,camera,simulation,onComfortFade:amount=>{
    comfortAmount=amount;
  },onTeleport:()=>audio.footstep(.75),onToggleGuide:toggleGuide,onResetRequested:reset,onResetProgress:fraction=>{
    if(fraction>0&&fraction<1)xrNotice.show('继续按住双手握键','松开可取消 · 回到起点',fraction,200);
  }});
  renderer.xr.addEventListener('sessionstart',()=>{
    state.keys.clear();state.touch.clear();walker.stop();setExploring(true);
    rig.rotation.y=state.yaw;
    camera.position.set(0,0,0);camera.rotation.set(0,0,0);
    $('experience').classList.add('immersive');
    controls.reset();
    xrNotice.show('扳机传送 · 摇杆分段转向','A / X 路线提示 · 双握键长按回到起点',null,6500);
  });
  renderer.xr.addEventListener('sessionend',()=>{
    camera.getWorldPosition(worldHead);
    const direction=new THREE.Vector3();camera.getWorldDirection(direction);
    state.yaw=Math.atan2(-direction.x,-direction.z);state.pitch=0;
    const candidate=simulation.isValidPosition(worldHead.x,worldHead.z) ? worldHead : rig.position.clone();
    rig.position.set(candidate.x,0,candidate.z);rig.rotation.set(0,0,0);
    camera.position.set(0,EYE_HEIGHT,0);camera.rotation.set(0,state.yaw,0,'YXZ');
    comfortShell.visible=false;
    comfortAmount=0;resetFadeUntil=0;xrNotice.hide();
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
  camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.04,90);
  rig=new THREE.Group();scene.add(rig);rig.add(camera);
  const response=await fetch('./assets/spatial.json');if(!response.ok) throw new Error('空间数据加载失败');
  spatial=await response.json();
  simulation=createSimulation(spatial,{onLapChange});
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const entries=[['environment','environment.glb'],['milo','milo.glb'],['repeated','repeated-props.glb'],['double','double-chair.glb'],['dreamCurtains','dream-curtains.glb']];
  models={};let completed=0;
  await Promise.all(entries.map(async([key,file])=>{
    const gltf=await loader.loadAsync('./assets/'+file);
    models[key]=gltf.scene;scene.add(gltf.scene);
    completed++;ui.bar.style.width=`${completed/entries.length*100}%`;
    ui.load.textContent=`场景准备中 · ${completed} / ${entries.length}`;
  }));
  presentation=refinePresentation(scene,models,createCurtainField(spatial));
  curtains=createCurtainInteraction(models,{reducedMotion});
  film=createFilmEffects(renderer,models,{reducedMotion});
  try{
    const saved=JSON.parse(localStorage.getItem('red-room-look')||'null');
    if(saved){film.setLook(saved.look);film.setStrength(saved.strength);if(['film','dream'].includes(saved.lastFilmLook))lastFilmLook=saved.lastFilmLook;}
  }catch{}
  const requestedLook=params.get('look');
  if(requestedLook)film.setLook(requestedLook);
  syncLookUI();
  navigation=createNavigationGuide(scene,spatial,simulation);
  initContactShadows();setPhase();setupDesktop();setupXR();
  state.ready=true;reset();
  $('toast').classList.remove('show');
  ui.desktop.disabled=false;ui.desktop.innerHTML='进入房间<span>↗</span>';
  ui.load.textContent='场景已就绪 · 以真实尺度探索';
  $('poster').classList.add('loaded');
  await checkXR();
  renderer.setAnimationLoop(time=>{
    const frameDt=previousTime?Math.max(0,(time-previousTime)/1000):0;previousTime=time;
    const dt=Math.min(frameDt,.05);
    if(renderer.xr.isPresenting) controls.update(dt);else updateDesktop(dt);
    camera.getWorldPosition(worldHead);
    if(renderer.xr.isPresenting){
      const contacts=controls.getInteractionSources();
      if(contacts.length){worldHead.x=contacts[0].x;worldHead.z=contacts[0].z;}
      curtains.update(frameDt,contacts);
    }else{
      desktopContact.x=worldHead.x;desktopContact.y=Math.max(.6,worldHead.y-.45);desktopContact.z=worldHead.z;
      curtains.update(frameDt,state.exploring&&!document.querySelector('dialog[open]')?desktopContacts:[]);
    }
    playCurtainContacts();
    const room=roomAt(worldHead.x,worldHead.z);
    if(previousRoom!==room[0]){$('room-code').textContent=room[0];$('room-name').textContent=room[1];previousRoom=room[0];}
    navigation.update(worldHead,state.route&&state.exploring);
    xrNotice.update(renderer.xr.isPresenting);
    if(renderer.xr.isPresenting){const fade=Math.max(comfortAmount,(resetFadeUntil-performance.now())/140,0);comfortShell.material.opacity=Math.min(1,fade);comfortShell.visible=fade>.005;}
    film.render(scene,camera,time/1000);
  });
  if(params.has('curtains')){
    rig.position.set(-3.8,0,6);state.yaw=1.35;state.pitch=-.15;
    camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
    state.entered=true;setExploring(true);revealChrome(6000);showHint(6000);
    toast('W 轻靠红帘 · S 退后看回弹 · A / D 沿帘移动');
  }
  if(params.has('debug')){
    window.__redRoom={renderer,scene,camera,rig,simulation,spatial,models,state,controls,navigation,xrNotice,curtains,film,audio,walker,
      renderFrame:(time=performance.now()/1000)=>film.render(scene,camera,time),
      setExploring,enterRoom,reset,revealChrome,hideChrome,setGuide,
      inspect:()=>({position:rig.position.toArray(),phase:simulation.state.phase,lap:simulation.state.lap,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,assets:Object.keys(models),xr:renderer.xr.isPresenting,audio:audio.inspect()}),
      setPose:(x,z,yaw=0,pitch=0)=>{rig.position.set(x,0,z);rig.rotation.set(0,0,0);state.yaw=yaw;state.pitch=pitch;camera.rotation.set(pitch,yaw,0,'YXZ');},
      setPhase
    };
  }
}
ui.desktop.addEventListener('click',enterRoom);
ui.vr.addEventListener('click',enterVR);
$('menu-button').addEventListener('click',()=>setExploring(false));
$('reset-button').addEventListener('click',reset);
$('route-toggle').addEventListener('change',event=>setGuide(event.target.checked));
$('bob-toggle').checked=state.bob;$('bob-toggle').disabled=reducedMotion;
$('bob-toggle').addEventListener('change',event=>{
  state.bob=event.target.checked;
  try{localStorage.setItem('red-room-bob',state.bob?'on':'off');}catch{}
});
$('sound-button').addEventListener('click',()=>{audio.setMuted(!audio.inspect().muted);syncSoundUI();});
syncSoundUI();
for(const [button,dialog] of [['help-button','help-dialog'],['credits-button','credits-dialog'],['look-button','look-dialog']]){
  $(button).addEventListener('click',()=>{state.keys.clear();state.touch.clear();pointer.active=false;if(document.pointerLockElement)document.exitPointerLock();$(dialog).showModal();});
}
document.querySelectorAll('[data-look]').forEach(button=>button.addEventListener('click',()=>{if(film){film.setLook(button.dataset.look);syncLookUI(true);}}));
$('look-strength').addEventListener('input',event=>{if(film){film.setStrength(Number(event.target.value)/100);syncLookUI(true);}});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();}));
addEventListener('resize',resize);
checkXR();
init().catch(fail);
