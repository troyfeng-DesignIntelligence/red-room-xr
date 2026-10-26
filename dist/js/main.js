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
import { createVoiceDirector } from './voice-director.js';
import { roomAt } from './rooms.js';
import { createMusicField, RECORD_SOURCES } from './music-field.js';
import { createFollower } from './follower.js';
import { lightAt, DARKEST, CRACKLES } from './flicker.js';
import { createFurniture } from './furniture.js';
import { createCurtainWalker } from './curtain-walker.js';
import { installHaze, createHaze } from './haze.js';
import { createWatchers, GAZES } from './watchers.js';

const $ = id => document.getElementById(id);
// The dream room's haze joins three.js's fog step before anything compiles.
installHaze();
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EYE_HEIGHT = 1.65;
const state = { ready:false, exploring:false, entered:false, xrSupported:false, route:false, bob:false, frame43:false, yaw:0, pitch:-.03, keys:new Set(), touch:new Set() };
let renderer, scene, camera, rig, simulation, controls, spatial, models, comfortShell, contactShadows, navigation, xrNotice, curtains, film, presentation;
let lastFilmLook='broadcast', voices=null, musicField=null, musicPlacedAt=0;
let comfortAmount=0, resetFadeUntil=0, previousTime=0, previousLap=1, lastEmitted=0, lastFootfall=-1e9, wasMoving=false;
let flickerAt=-Infinity, shownDark=0, furniture=null, furnishedLap=0, haze=null, watchers=null, lapShifts={};
let introTimeout, subtitleTimeout;
const pointer = { active:false, id:null, x:0, y:0, travel:0 };
const worldHead = new THREE.Vector3();
const listenerForward = new THREE.Vector3(), listenerUp = new THREE.Vector3(), listenerTurn = new THREE.Quaternion();
// The body is felt by the cloth from about a metre away.
const desktopContact={id:'body',x:0,y:1.2,z:0,radius:1,intentX:0,intentZ:0};
const desktopContacts=[desktopContact];
const isTouch = matchMedia('(pointer:coarse)').matches;
const walker = createWalker();
const audio = createRoomAudio();
const follower = createFollower();
const curtainWalker = createCurtainWalker();
// Where the visitor has just been, newest last, every 30 cm.
const trail = [];
document.body.classList.toggle('touch',isTouch);
document.body.classList.toggle('debug',params.has('debug'));
// There is nothing on the page to change a setting with, so none is kept
// between visits; the address can still ask for the 4:3 frame (?frame=4:3), a
// look (?look=film) or the walking sway (?bob). Older visits' choices, a muted
// room among them, are forgotten.
try{for(const key of ['red-room-audio','red-room-look','red-room-bob','red-room-frame'])localStorage.removeItem(key);}catch{}
state.bob=params.has('bob');
state.frame43=['4:3','43'].includes(params.get('frame'));
// A headset's own browser goes into VR with the entering click; a computer
// walks on its screen unless the address asks for VR (?vr).
const headsetBrowser=/OculusBrowser|Quest|PicoBrowser|Pico Neo|Pico 4|Wolvic|Mobile VR/i.test(navigator.userAgent);
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
  haze?.setDream(changed);
  models.environment.traverse(object=>{
    if(object.name.replaceAll('_',' ').replace(/\s+/g,' ').trim()==='environment | F drape')object.visible=!changed;
  });
  // The chairs and lamps are rearranged here, in the dark of a completed
  // circuit, once a circuit, never onto the visitor; a reset puts them back.
  if(furniture&&furnishedLap!==simulation.state.lap){
    furnishedLap=simulation.state.lap;
    const head=camera.getWorldPosition(new THREE.Vector3());
    const shifts=furniture.shift(simulation.state.lap,(piece,x,z)=>Math.hypot(x-head.x,z-head.z)>=
      Math.min(Math.hypot(piece.home[0]-head.x,piece.home[1]-head.z),spatial.obstacles[piece.index].radius+.4));
    for(const piece of furniture.pieces){
      const {dx=0,dz=0}=shifts[piece.index]??{};
      spatial.obstacles[piece.index].center[0]=piece.home[0]+dx;
      spatial.obstacles[piece.index].center[1]=piece.home[1]+dz;
    }
    lapShifts=shifts;placeFurniture();
  }
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
// This circuit's arrangement, with the statues turned as they have turned.
function placeFurniture(){
  presentation?.setFurniture({...lapShifts,...(watchers?.turns()??{})});
}
// Whether the visitor could see a statue now: within the view, with a margin
// and the statue's own height allowed for, and no curtain between. A statue of
// the other room state is out of sight anyway.
function statueSeen(statue){
  const obstacle=spatial.obstacles[statue.index];
  if(obstacle.state&&obstacle.state!==simulation.state.phase)return false;
  const dx=statue.at[0]-worldHead.x,dy=.9-worldHead.y,dz=statue.at[1]-worldHead.z,distance=Math.hypot(dx,dy,dz);
  if(distance<.6)return true;
  const ahead=(dx*listenerForward.x+dy*listenerForward.y+dz*listenerForward.z)/distance;
  const off=Math.acos(THREE.MathUtils.clamp(ahead,-1,1))-Math.asin(Math.min(1,.95/distance));
  const half=renderer.xr.isPresenting?1.15:Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov)/2)*Math.hypot(1,camera.aspect));
  return off<half+.2&&!simulation.wallBetween([worldHead.x,worldHead.z],statue.at);
}
// A completed circuit is heard rather than announced: the drone drops out,
// the lights stutter and go out with a surge of electricity, the room changes
// in the dark, the drone returns changed and a voice answers. A reset returns
// quietly, the room changing at once.
function onLapChange() {
  const completed=simulation.state.lap>previousLap;
  if(completed){
    flickerAt=performance.now()/1000;
    audio.surge(reducedMotion?[]:CRACKLES,{at:nearestLamp()});
    // In the dark the statues turn too, all at once.
    setTimeout(()=>{watchers?.turnAll([worldHead.x,worldHead.z]);setPhase();placeFurniture();},DARKEST*1000);
  }else setPhase();
  audio.setPhase(simulation.state.phase,{dip:completed});
  if(completed)voices?.lapChanged(simulation.state.lap,simulation.state.phase,performance.now()/1000);
  previousLap=simulation.state.lap;
}
// The floor lamp nearest the visitor: the lights' electricity crackles there.
function nearestLamp(){
  let lamp=null,nearest=Infinity;
  for(const obstacle of spatial.obstacles){
    if(!/torchiere/i.test(obstacle.name))continue;
    const distance=Math.hypot(obstacle.center[0]-worldHead.x,obstacle.center[1]-worldHead.z);
    if(distance<nearest){nearest=distance;lamp=[obstacle.center[0],1.85,obstacle.center[1]];}
  }
  return lamp;
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
// There is no interface: black while the room loads, then the room, dim and
// silent, until a click, a tap or a key steps in. The walk shows only the room
// and the subtitles of what it says.
// Entering dips to black and the room tone rises in the dark before the room
// fades in. Coming back from VR uses a short dip.
function playIntro(full){
  clearTimeout(introTimeout);
  document.body.classList.add('entering');
  document.body.classList.toggle('intro-long',full);
  introTimeout=setTimeout(()=>document.body.classList.remove('entering'),full?1500:350);
}
function cancelIntro(){
  clearTimeout(introTimeout);
  document.body.classList.remove('entering','intro-long');
}
function setExploring(value) {
  state.exploring=value;
  document.body.classList.toggle('exploring',value);
  if(!value) { state.keys.clear(); state.touch.clear(); pointer.active=false; walker.stop(); cancelIntro(); hideSubtitle(); }
  if(!value&&document.pointerLockElement)document.exitPointerLock();
  audio.setLevel(value?1:.35);
}
function enterRoom() {
  if(!state.ready || state.exploring) return;
  if(state.xrSupported&&(headsetBrowser||params.has('vr'))){enterVR();return;}
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
  simulation.resetProgress(); setPhase(); controls.reset(); voices?.reset(); trail.length=0; curtainWalker.reset();
  watchers?.reset(); placeFurniture();
  curtains?.reset();
  if(renderer.xr.isPresenting)resetFadeUntil=performance.now()+160;
}
function setGuide(value){
  state.route=!!value;
}
function toggleGuide(){
  setGuide(!state.route);
}
// V compares the picture with and without the screen effects.
function toggleFilm(){
  if(!film)return;
  const {look}=film.inspect();
  if(look!=='clean')lastFilmLook=look;
  film.setLook(look==='clean'?lastFilmLook:'clean');
}
// The 4:3 frame of the 1990-91 broadcast: the largest 4:3 picture that fits,
// centred on black. The screen effects follow the drawing buffer size.
function viewport() {
  if(!state.frame43) return [innerWidth,innerHeight];
  const height=Math.min(innerHeight,innerWidth*3/4);
  return [Math.round(height*4/3),Math.round(height)];
}
function resize() {
  if(!renderer || renderer.xr.isPresenting) return;
  const [width,height]=viewport();
  camera.aspect=width/height; camera.updateProjectionMatrix();
  renderer.setSize(width,height);
}
function setFrame(value) {
  state.frame43=!!value;
  resize();
}
// Without the lock, pressing and dragging still looks around.
function captureMouse(){
  if(isTouch || renderer.xr.isPresenting || document.pointerLockElement) return;
  try{renderer.domElement.requestPointerLock?.()?.catch?.(()=>{});}catch{}
}
function setupDesktop() {
  // Look gestures start anywhere in the picture area, including the 4:3 bars.
  const canvas=renderer.domElement,surface=$('canvas-wrap');
  document.addEventListener('pointerlockchange',()=>{pointer.active=false;});
  // On a touch screen a finger drags to look, and held still it walks
  // forward, still steering while it drags.
  let holdTimeout;
  surface.addEventListener('pointerdown',e=>{
    if(!state.exploring || renderer.xr.isPresenting || e.button!==0 || document.pointerLockElement===canvas) return;
    audio.start();
    pointer.active=true;pointer.id=e.pointerId;pointer.x=e.clientX;pointer.y=e.clientY;pointer.travel=0;
    surface.setPointerCapture(e.pointerId);
    clearTimeout(holdTimeout);
    if(e.pointerType==='touch')holdTimeout=setTimeout(()=>{if(pointer.active&&pointer.travel<14)state.touch.add('forward');},260);
  });
  surface.addEventListener('pointermove',e=>{
    const locked=document.pointerLockElement===canvas;
    if(!locked&&(!pointer.active || pointer.id!==e.pointerId)) return;
    const dx=locked?e.movementX:e.clientX-pointer.x,dy=locked?e.movementY:e.clientY-pointer.y;
    state.yaw-=dx*.003;
    state.pitch=THREE.MathUtils.clamp(state.pitch-dy*.003,-1.25,1.25);
    pointer.travel+=Math.abs(dx)+Math.abs(dy);pointer.x=e.clientX;pointer.y=e.clientY;
  });
  const release=()=>{pointer.active=false;clearTimeout(holdTimeout);state.touch.delete('forward');};
  surface.addEventListener('pointerup',release);surface.addEventListener('pointercancel',release);
  // The first click steps in; later, a click that is not a drag locks the
  // mouse for free looking again (Esc releases it).
  surface.addEventListener('click',()=>{
    if(!state.exploring){enterRoom();return;}
    if(pointer.travel<6)captureMouse();
  });
  addEventListener('keydown',e=>{
    if(!state.exploring){
      if(!e.repeat&&!['Shift','Control','Alt','Meta','Tab','Escape'].includes(e.key))enterRoom();
      return;
    }
    if(e.code==='KeyV'&&!e.repeat){toggleFilm();return;}
    audio.start();
    if(e.code==='KeyG'&&!e.repeat){toggleGuide();return;}
    if(e.code==='KeyM'&&!e.repeat){captureMouse();return;}
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)){
      e.preventDefault();state.keys.add(e.code);
    }
  });
  addEventListener('keyup',e=>state.keys.delete(e.code));
  addEventListener('blur',()=>{state.keys.clear();state.touch.clear();pointer.active=false;});
}
function updateDesktop(dt) {
  desktopContact.intentX=desktopContact.intentZ=0;
  let directionX=0,directionZ=0;
  if(state.exploring){
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
    for(let i=0;i<steps;i++){audio.footstep(walker.speedFraction());lastFootfall=performance.now();follower.step(lastFootfall/1000);}
  }
  // Coming to rest after walking, the trailing foot is set down beside the other.
  const moving=!!(velocity.x||velocity.z),sinceStep=performance.now()-lastFootfall;
  if(wasMoving&&!moving&&sinceStep>150&&sinceStep<1200){audio.footstep(.5,{settle:true});follower.stop(performance.now()/1000);}
  wasMoving=moving;
  camera.position.y=EYE_HEIGHT+(state.bob&&!reducedMotion?walker.bob(.012):0);
  camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
}
// Each new contact wave on the velvet becomes a rustle, heard where the cloth was touched.
function playCurtainContacts(){
  const {emitted}=curtains.motion.inspect();
  let fresh=Math.max(0,emitted-lastEmitted);lastEmitted=emitted;
  if(!fresh)return;
  for(const impulse of curtains.motion.impulses){
    if(!fresh)break;
    if(!impulse.active||impulse.age>0)continue;
    fresh--;
    const {x,y,z}=impulse.position;
    audio.rustle(impulse.strength/.1,{at:[x,y,z],distance:Math.hypot(x-worldHead.x,z-worldHead.z)});
  }
}
// On ordinary circuits, someone now and then walks behind a curtain near the
// visitor (curtain-walker.js): their figure presses out of the cloth, each step
// ripples it, and the steps come muffled through it.
function walkBehindCurtains(){
  const walking=curtainWalker.update(performance.now()/1000,{lap:simulation.state.lap,phase:simulation.state.phase,
    ready:state.exploring&&!document.body.classList.contains('entering')&&!$('subtitle').classList.contains('show'),
    panels:curtains.visiblePanels(),visitor:[worldHead.x,worldHead.z],forward:[listenerForward.x,listenerForward.z]});
  curtains.setWalker(walking.walker);
  for(const [x,z] of walking.steps){
    curtains.motion.touch({x,y:1.1,z},.05+Math.random()*.03,curtains.activePanels);
    audio.footstep(.8,{from:[x,.05,z],veiled:true});
  }
}
// A line spoken backwards by the room, heard from where it lives (a circuit's
// answer comes from all around) and subtitled in English and Chinese: at the
// foot of the picture, or on the headset's notice panel.
function speakLine(line){
  let at=null,distance=3;
  if(line.trigger.from){
    // At the height of someone standing there.
    const [x,z]=line.trigger.from;
    at=[x,1.55,z];distance=Math.hypot(x-worldHead.x,z-worldHead.z);
  }
  // Muted or not, the subtitle carries the line.
  const seconds=(audio.speak(line.id,{at,distance})||line.duration||4)+.8;
  if(renderer.xr.isPresenting){xrNotice.caption(line.en,line.zh,seconds*1000);return;}
  $('subtitle-en').textContent=line.en;$('subtitle-zh').textContent=line.zh;
  $('subtitle').classList.add('show');
  clearTimeout(subtitleTimeout);subtitleTimeout=setTimeout(hideSubtitle,seconds*1000);
}
// Whoever follows on dream circuits walks about 2.4 m back along the
// visitor's way (straight behind them until they have come that far). Turn
// round, and the steps are in front: no one is there.
function leaveTrail(x,z){
  const last=trail.at(-1);
  if(!last||Math.hypot(x-last[0],z-last[1])>.3){trail.push([x,z]);if(trail.length>24)trail.shift();}
}
function followerAt(){
  let back=2.4,x=worldHead.x,z=worldHead.z;
  for(let i=trail.length-1;i>=0;i--){
    const d=Math.hypot(trail[i][0]-x,trail[i][1]-z);
    if(d>=back)return [x+(trail[i][0]-x)*back/d,z+(trail[i][1]-z)*back/d];
    back-=d;x=trail[i][0];z=trail[i][1];
  }
  camera.getWorldDirection(listenerForward);
  return [worldHead.x-listenerForward.x*2.4,worldHead.z-listenerForward.z*2.4];
}
function playFollower(due){
  const [x,z]=followerAt();
  for(const step of due)audio.footstep(step.settle?.45:.8,{settle:step.settle,from:[x,.05,z]});
}
function hideSubtitle(){
  clearTimeout(subtitleTimeout);
  $('subtitle').classList.remove('show');
}
async function checkXR(){
  try { state.xrSupported=window.isSecureContext && !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); }
  catch {state.xrSupported=false;}
}
// If the headset will not start, the room opens on the screen instead.
async function enterVR(){
  if(!state.ready || !state.xrSupported || renderer.xr.isPresenting) return;
  audio.start();
  try {
    const session=await navigator.xr.requestSession('immersive-vr',{requiredFeatures:['local-floor'],optionalFeatures:['bounded-floor']});
    await renderer.xr.setSession(session);
  } catch(error) {
    console.warn('VR not started:',error.message);
    state.xrSupported=false;enterRoom();
  }
}
function setupXR(){
  renderer.xr.enabled=true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(1);
  const fadeMaterial=new THREE.MeshBasicMaterial({color:0x050000,side:THREE.BackSide,transparent:true,opacity:0,depthWrite:false,depthTest:false,fog:false});
  comfortShell=new THREE.Mesh(new THREE.SphereGeometry(.16,16,12),fadeMaterial);
  comfortShell.frustumCulled=false;comfortShell.renderOrder=10000;comfortShell.visible=false;camera.add(comfortShell);
  xrNotice=createXRNotice(camera);
  controls=createXRControls({renderer,scene,rig,camera,simulation,onComfortFade:amount=>{
    comfortAmount=amount;
  },onTeleport:()=>{
    // Landing from a teleport: one step, then the other foot settles. Whoever
    // follows on a dream circuit takes the same two steps, a beat behind.
    audio.footstep(.75);setTimeout(()=>audio.footstep(.4,{settle:true}),240);
    const now=performance.now()/1000;follower.step(now);follower.step(now+.5);follower.stop(now+.55);
  },onToggleGuide:toggleGuide,onResetRequested:reset});
  renderer.xr.addEventListener('sessionstart',()=>{
    state.keys.clear();state.touch.clear();walker.stop();setExploring(true);
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
    camera.position.set(0,EYE_HEIGHT,0);camera.rotation.set(0,state.yaw,0,'YXZ');
    comfortShell.visible=false;
    comfortAmount=0;resetFadeUntil=0;xrNotice.hide();
    $('experience').classList.remove('immersive');
    setExploring(false);resize();
  });
}
async function init(){
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,isTouch?1.25:1.5));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;
  $('canvas-wrap').appendChild(renderer.domElement);
  scene=new THREE.Scene();scene.background=new THREE.Color(0x080101);
  camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.04,90);
  resize();
  rig=new THREE.Group();scene.add(rig);rig.add(camera);
  // A dark backdrop round the whole set, inside the far plane: the slivers of
  // nothing between the curtain hems and the floor take the fog and the dream
  // room's haze like everything around them.
  const backdrop=new THREE.Mesh(new THREE.SphereGeometry(45,16,12),new THREE.MeshBasicMaterial({color:0x080101,side:THREE.BackSide,depthWrite:false}));
  backdrop.position.set(-12,0,8.5);backdrop.renderOrder=-1;scene.add(backdrop);
  const response=await fetch('./assets/spatial.json');if(!response.ok) throw new Error('空间数据加载失败');
  spatial=await response.json();
  // A lap is a walk round the loop of rooms, back into the waiting room by the other doorway.
  simulation=createSimulation(spatial,{onLapChange,roomOf:(x,z)=>roomAt(x,z)[0]});
  // The voices are optional: without them the room is only quieter.
  fetch('./assets/voices/manifest.json').then(r=>r.ok?r.json():null).then(manifest=>{
    if(!manifest?.lines?.length)return;
    voices=createVoiceDirector(manifest.lines);
    audio.loadVoices(manifest.lines,'./assets/');
  }).catch(error=>console.warn('Voices unavailable:',error.message));
  // A record somewhere behind the curtains: a local file that is not part of
  // the project. Without it the far rooms are only quieter.
  audio.loadFootsteps('./assets/footsteps/steps.json');
  musicField=createMusicField(RECORD_SOURCES,simulation.wallsBetween);
  audio.loadMusic('./assets/music/falling.mp3');
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const entries=[['environment','environment.glb'],['milo','milo.glb'],['repeated','repeated-props.glb'],['double','double-chair.glb'],['dreamCurtains','dream-curtains.glb']];
  models={};
  await Promise.all(entries.map(async([key,file])=>{
    const gltf=await loader.loadAsync('./assets/'+file);
    models[key]=gltf.scene;scene.add(gltf.scene);
  }));
  presentation=refinePresentation(scene,models,createCurtainField(spatial),spatial.obstacles);
  furniture=createFurniture(spatial.obstacles,presentation.outlines,spatial.wallSegments);
  // The statues watch the visitor, turning only while unseen (watchers.js).
  watchers=createWatchers(spatial.obstacles.map((obstacle,index)=>({obstacle,index})).filter(({obstacle})=>obstacle.name in GAZES)
    .map(({obstacle,index})=>({index,at:obstacle.center.slice(),facing:THREE.MathUtils.degToRad(GAZES[obstacle.name])})));
  curtains=createCurtainInteraction(models,{reducedMotion});
  film=createFilmEffects(renderer,models,{reducedMotion});
  const requestedLook=params.get('look');
  if(requestedLook)film.setLook(requestedLook);
  navigation=createNavigationGuide(scene,spatial,simulation);
  initContactShadows();setPhase();setupDesktop();setupXR();
  // Violet haze in the mirrored waiting room on dream circuits (haze.js).
  haze=createHaze(scene);haze.setDream(simulation.state.phase!=='normal',{now:true});
  state.ready=true;reset();
  await checkXR();
  document.body.classList.add('ready');
  renderer.setAnimationLoop(time=>{
    const frameDt=previousTime?Math.max(0,(time-previousTime)/1000):0;previousTime=time;
    const dt=Math.min(frameDt,.05);
    if(renderer.xr.isPresenting) controls.update(dt);else updateDesktop(dt);
    haze.update(frameDt,time/1000);
    camera.getWorldPosition(worldHead);
    // The ears go with the head: every placed sound is heard around it.
    camera.getWorldDirection(listenerForward);
    listenerUp.set(0,1,0).applyQuaternion(camera.getWorldQuaternion(listenerTurn));
    audio.setListener(worldHead,listenerForward,listenerUp);
    if(renderer.xr.isPresenting){
      const contacts=controls.getInteractionSources();
      if(contacts.length){worldHead.x=contacts[0].x;worldHead.z=contacts[0].z;}
      curtains.update(frameDt,contacts);
    }else{
      desktopContact.x=worldHead.x;desktopContact.y=Math.max(.6,worldHead.y-.45);desktopContact.z=worldHead.z;
      curtains.update(frameDt,state.exploring?desktopContacts:[]);
    }
    walkBehindCurtains();
    // Out of sight, the statues turn to face the visitor.
    if(state.exploring&&watchers.update(performance.now()/1000,{visitor:[worldHead.x,worldHead.z],seen:statueSeen}))placeFurniture();
    playCurtainContacts();
    const room=roomAt(worldHead.x,worldHead.z);
    if(voices&&state.exploring&&!document.body.classList.contains('entering')){
      const line=voices.update(room[0],simulation.state,performance.now()/1000);
      if(line)speakLine(line);
    }
    // Someone walks behind the visitor on dream circuits.
    if(state.exploring)leaveTrail(worldHead.x,worldHead.z);
    const followed=follower.update(performance.now()/1000,{dream:simulation.state.phase==='dream'&&state.exploring&&!document.body.classList.contains('entering')});
    if(followed.length)playFollower(followed);
    // How much of the record reaches this spot, and from which way, ten times a second.
    if(time-musicPlacedAt>100){
      musicPlacedAt=time;
      const heard=musicField.sample(worldHead.x,worldHead.z,simulation.state.phase),[dx,dz]=heard.direction;
      audio.placeMusic({...heard,at:[worldHead.x+dx*3,1.1,worldHead.z+dz*3]});
    }
    navigation.update(worldHead,state.route&&state.exploring);
    xrNotice.update(renderer.xr.isPresenting);
    // The lights' flicker at a completed circuit: over the picture on screens,
    // through the comfort shell in the headset.
    const dark=1-lightAt(performance.now()/1000-flickerAt,reducedMotion);
    if(renderer.xr.isPresenting){const fade=Math.max(comfortAmount,(resetFadeUntil-performance.now())/140,dark,0);comfortShell.material.opacity=Math.min(1,fade);comfortShell.visible=fade>.005;}
    else if(dark!==shownDark){$('flicker').style.opacity=dark.toFixed(3);shownDark=dark;}
    film.render(scene,camera,time/1000);
  });
  if(params.has('curtains')){
    rig.position.set(-3.8,0,6);state.yaw=1.35;state.pitch=-.15;
    camera.rotation.set(state.pitch,state.yaw,0,'YXZ');
    state.entered=true;setExploring(true);
  }
  if(params.has('debug')){
    window.__redRoom={renderer,scene,camera,rig,simulation,spatial,models,state,controls,navigation,xrNotice,curtains,film,audio,walker,
      renderFrame:(time=performance.now()/1000)=>film.render(scene,camera,time),
      setExploring,enterRoom,reset,setGuide,
      inspect:()=>({position:rig.position.toArray(),phase:simulation.state.phase,lap:simulation.state.lap,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,assets:Object.keys(models),xr:renderer.xr.isPresenting,audio:audio.inspect()}),
      setFrame,speakLine,musicField,follower,presentation,furniture,curtainWalker,haze,watchers,statueSeen,placeFurniture,
      walkBehindCurtain:()=>curtainWalker.start(performance.now()/1000,curtains.visiblePanels(),[worldHead.x,worldHead.z],[listenerForward.x,listenerForward.z]),
      get voices(){return voices;},
      setPose:(x,z,yaw=0,pitch=0)=>{rig.position.set(x,0,z);rig.rotation.set(0,0,0);state.yaw=yaw;state.pitch=pitch;camera.rotation.set(pitch,yaw,0,'YXZ');},
      setPhase
    };
  }
}
addEventListener('resize',resize);
init().catch(fail);
