import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createXRControls} from '../dist/js/xr-controls.js';
import {createSimulation} from '../dist/js/simulation.js';

function setup(walls=[], {resetControlsOnRequest=false}={}){
  const scene=new THREE.Scene(),rig=new THREE.Group(),camera=new THREE.PerspectiveCamera();
  scene.add(rig);rig.add(camera);
  const xr=new THREE.EventDispatcher(),controllers=[new THREE.Group(),new THREE.Group()],grips=[new THREE.Group(),new THREE.Group()];
  const pose={position:{x:.35,y:1.65,z:.25}};
  Object.assign(xr,{isPresenting:true,getController:i=>controllers[i],getControllerGrip:i=>grips[i],getFrame:()=>({getViewerPose:()=>({transform:pose})}),getReferenceSpace:()=>({})});
  const simulation=createSimulation({walkablePolygons:[[[-10,-10],[10,-10],[10,10],[-10,10]]],wallSegments:walls});
  let fade=0,teleports=0,toggles=0,resets=0,resetProgress=0;
  const controls=createXRControls({renderer:{xr},scene,rig,camera,simulation,
    onComfortFade:a=>{fade=a},onTeleport:()=>teleports++,onToggleGuide:()=>toggles++,
    onResetProgress:value=>{resetProgress=value},
    onResetRequested:()=>{resets++;if(resetControlsOnRequest)controls.reset()}});
  controllers[0].position.set(.35,1.3,.25);
  const gamepad={axes:[0,0,0,0],buttons:Array.from({length:6},()=>({pressed:false,value:0}))};
  controllers[0].dispatchEvent({type:'connected',data:{targetRayMode:'tracked-pointer',gamepad}});
  scene.updateMatrixWorld(true);
  const head=()=>rig.localToWorld(new THREE.Vector3(pose.position.x,pose.position.y,pose.position.z));
  const connectSecond=()=>{
    const second={axes:[0,0,0,0],buttons:Array.from({length:6},()=>({pressed:false,value:0}))};
    controllers[1].dispatchEvent({type:'connected',data:{targetRayMode:'tracked-pointer',gamepad:second}});
    return second;
  };
  return {scene,rig,controllers,grips,xr,pose,controls,gamepad,head,connectSecond,
    fade:()=>fade,teleports:()=>teleports,toggles:()=>toggles,resets:()=>resets,resetProgress:()=>resetProgress};
}
function hold(gamepad,index,pressed=true){gamepad.buttons[index].pressed=pressed;gamepad.buttons[index].value=pressed?1:0}
function advance(h,seconds){for(let i=0;i<Math.round(seconds*100);i++)h.controls.update(.01)}

test('curtain contact uses tracked world body and only connected visible controller grips',()=>{
  const h=setup();
  h.rig.position.set(2,0,-3);h.rig.rotation.y=Math.PI/2;
  const contacts=h.controls.getInteractionSources();
  const head=h.head();
  assert.equal(contacts.length,1);
  assert.ok(Math.abs(contacts[0].x-head.x)<1e-7);
  assert.ok(Math.abs(contacts[0].z-head.z)<1e-7);
  h.controllers[0].dispatchEvent({type:'connected',data:{targetRayMode:'tracked-pointer',gamepad:h.gamepad,gripSpace:{}}});
  h.grips[0].position.set(.5,1.1,0);
  const handContacts=h.controls.getInteractionSources();
  const grip=h.grips[0].getWorldPosition(new THREE.Vector3());
  assert.equal(handContacts.length,2);
  assert.ok(Math.abs(handContacts[1].x-grip.x)<1e-7);
  assert.ok(Math.abs(handContacts[1].z-grip.z)<1e-7);
  h.grips[0].visible=false;
  assert.equal(h.controls.getInteractionSources().length,1);
  h.grips[0].visible=true;
  h.controllers[0].dispatchEvent({type:'disconnected'});
  assert.equal(h.controls.getInteractionSources().length,1);
  h.xr.isPresenting=false;
  assert.equal(h.controls.getInteractionSources().length,0);
  h.controls.dispose();
});
test('trigger release teleports the actual head to a valid landing, retaining tracked offsets',()=>{
  const h=setup();
  h.controllers[0].dispatchEvent({type:'selectstart'});h.controls.update(.016);
  const marker=h.scene.children.find(o=>o.geometry?.type==='RingGeometry'&&o.visible);
  assert.ok(marker);const landing=marker.position.clone();
  h.controllers[0].dispatchEvent({type:'selectend'});
  assert.equal(h.teleports(),1);
  assert.ok(Math.abs(h.head().x-landing.x)<1e-5);
  assert.ok(Math.abs(h.head().z-landing.z)<1e-5);
  assert.equal(h.head().y,1.65);
  h.controls.dispose();
});
test('a curtain intersecting the aiming arc prevents teleport',()=>{
  const h=setup([[[-10,-1],[10,-1]]]);
  h.controllers[0].dispatchEvent({type:'selectstart'});h.controls.update(.016);
  h.controllers[0].dispatchEvent({type:'selectend'});
  assert.equal(h.teleports(),0);assert.equal(h.rig.position.length(),0);
  h.controls.dispose();
});
test('snap turn pivots around the head and requires releasing the thumbstick',()=>{
  const h=setup(),before=h.head().clone();
  h.gamepad.axes[2]=1;h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y+Math.PI/6)<1e-7);
  assert.ok(h.head().distanceTo(before)<1e-7);
  for(let i=0;i<100;i++)h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y+Math.PI/6)<1e-7);
  h.gamepad.axes[2]=0;h.controls.update(.016);
  h.gamepad.axes[2]=-1;h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y)<1e-7);
  assert.ok(h.head().distanceTo(before)<1e-7);
  h.controls.dispose();
});
test('walking beyond the room fades the view and stepping back restores it',()=>{
  const h=setup();h.pose.position.x=12;
  for(let i=0;i<30;i++)h.controls.update(.016);
  assert.ok(h.fade()>.99);
  h.pose.position.x=.35;
  for(let i=0;i<30;i++)h.controls.update(.016);
  assert.ok(h.fade()<.01);
  h.xr.dispatchEvent({type:'sessionend'});
  assert.equal(h.fade(),0);h.controls.dispose();
});
test('A or X toggles the guide once per press, merging simultaneous presses',()=>{
  const h=setup(),second=h.connectSecond();
  hold(h.gamepad,4);hold(second,4);h.controls.update(.016);
  assert.equal(h.toggles(),1);
  advance(h,1);assert.equal(h.toggles(),1);
  hold(h.gamepad,4,false);hold(second,4,false);h.controls.update(.016);
  hold(second,4);h.controls.update(.016);assert.equal(h.toggles(),2);
  h.controls.dispose();
});
test('holding only one grip or briefly squeezing both never requests reset',()=>{
  const h=setup(),second=h.connectSecond();
  hold(h.gamepad,1);advance(h,2);
  assert.equal(h.resets(),0);assert.equal(h.resetProgress(),0);
  hold(second,1);advance(h,.5);
  assert.ok(h.resetProgress()>.4&&h.resetProgress()<.5);
  hold(second,1,false);h.controls.update(.016);
  assert.equal(h.resetProgress(),0);
  hold(second,1);advance(h,.8);
  assert.equal(h.resets(),0); // Previous partial hold is not retained.
  h.controls.dispose();
});
test('both grips reset after 1.2 seconds only once until released, including application reset',()=>{
  const h=setup([], {resetControlsOnRequest:true}),second=h.connectSecond();
  hold(h.gamepad,1);hold(second,1);advance(h,1.19);
  assert.equal(h.resets(),0);
  h.controls.update(.01);assert.equal(h.resets(),1);
  advance(h,3);assert.equal(h.resets(),1);
  hold(second,1,false);h.controls.update(.01);
  assert.equal(h.resetProgress(),0);
  hold(second,1);advance(h,1.2);assert.equal(h.resets(),2);
  h.controls.dispose();
});
test('disconnect cancels an in-progress reset and ignores retained buttons and axes',()=>{
  const h=setup(),second=h.connectSecond();
  hold(h.gamepad,1);hold(second,1);advance(h,.6);
  h.controllers[1].dispatchEvent({type:'disconnected'});
  assert.equal(h.resetProgress(),0);
  second.axes[2]=1;hold(second,4);advance(h,2);
  assert.equal(h.rig.rotation.y,0);assert.equal(h.toggles(),0);assert.equal(h.resets(),0);
  assert.ok(h.grips[1].children.every(o=>!o.visible));
  h.controllers[1].dispatchEvent({type:'connected',data:{targetRayMode:'tracked-pointer',gamepad:second}});
  h.controls.update(.016);
  assert.equal(h.rig.rotation.y,0);assert.equal(h.toggles(),0);
  second.axes[2]=0;hold(second,4,false);h.controls.update(.016);
  second.axes[2]=1;hold(second,4);h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y+Math.PI/6)<1e-7);assert.equal(h.toggles(),1);
  h.controls.dispose();
});
test('two simultaneous sticks produce one 30 degree turn with the tracked head fixed',()=>{
  const h=setup(),second=h.connectSecond(),before=h.head().clone();
  h.gamepad.axes[2]=1;second.axes[2]=1;h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y+Math.PI/6)<1e-7);
  assert.ok(h.head().distanceTo(before)<1e-7);
  advance(h,2);
  assert.ok(Math.abs(h.rig.rotation.y+Math.PI/6)<1e-7);
  second.axes[2]=0;h.controls.update(.016);second.axes[2]=-1;h.controls.update(.016);
  assert.ok(Math.abs(h.rig.rotation.y)<1e-7);
  assert.ok(h.head().distanceTo(before)<1e-7);
  h.controls.dispose();
});
test('controller meshes stay hidden outside XR and without an attached input source',()=>{
  const h=setup();
  h.controls.update(.016);
  assert.ok(h.grips[0].children.every(o=>o.visible));
  assert.ok(h.grips[1].children.every(o=>!o.visible));
  h.xr.isPresenting=false;h.controls.update(.016);
  assert.ok(h.grips.every(grip=>grip.children.every(o=>!o.visible)));
  h.controls.dispose();
});
