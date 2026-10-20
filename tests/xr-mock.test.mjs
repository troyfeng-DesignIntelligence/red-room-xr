import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createXRControls} from '../dist/js/xr-controls.js';
import {createSimulation} from '../dist/js/simulation.js';

function setup(walls=[]){
  const scene=new THREE.Scene(),rig=new THREE.Group(),camera=new THREE.PerspectiveCamera();
  scene.add(rig);rig.add(camera);
  const xr=new THREE.EventDispatcher(),controllers=[new THREE.Group(),new THREE.Group()],grips=[new THREE.Group(),new THREE.Group()];
  const pose={position:{x:.35,y:1.65,z:.25}};
  Object.assign(xr,{isPresenting:true,getController:i=>controllers[i],getControllerGrip:i=>grips[i],getFrame:()=>({getViewerPose:()=>({transform:pose})}),getReferenceSpace:()=>({})});
  const simulation=createSimulation({walkablePolygons:[[[-10,-10],[10,-10],[10,10],[-10,10]]],wallSegments:walls});
  let fade=0,teleports=0;
  const controls=createXRControls({renderer:{xr},scene,rig,camera,simulation,onComfortFade:a=>{fade=a},onTeleport:()=>teleports++});
  controllers[0].position.set(.35,1.3,.25);
  const gamepad={axes:[0,0,0,0]};
  controllers[0].dispatchEvent({type:'connected',data:{targetRayMode:'tracked-pointer',gamepad}});
  scene.updateMatrixWorld(true);
  const head=()=>rig.localToWorld(new THREE.Vector3(pose.position.x,pose.position.y,pose.position.z));
  return {scene,rig,controllers,xr,pose,controls,gamepad,head,fade:()=>fade,teleports:()=>teleports};
}
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
