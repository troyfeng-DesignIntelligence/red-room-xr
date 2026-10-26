import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createFilmEffects} from '../dist/js/film.js';

test('immersive rendering bypasses every offscreen pass and keeps the native XR camera path',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
  const room=new THREE.Group(),material=new THREE.MeshBasicMaterial();
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);room.add(mesh);scene.add(room);
  const overlay=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial());scene.add(overlay);
  const overlayCompile=overlay.material.onBeforeCompile;
  const calls=[];
  const renderer={xr:{isPresenting:true,enabled:true},render:(s,c)=>calls.push([s,c]),
    setRenderTarget:()=>assert.fail('XR framebuffer must not be replaced'),
    getDrawingBufferSize:()=>assert.fail('XR must not allocate desktop targets')};
  const film=createFilmEffects(renderer,{room});
  film.render(scene,camera,3);
  assert.equal(calls.length,1);assert.deepEqual(calls[0],[scene,camera]);
  assert.equal(renderer.xr.enabled,true);
  assert.equal(film.inspect().path,'xr-grade');assert.equal(film.inspect().extraDrawCalls,0);
  assert.equal(overlay.material.onBeforeCompile,overlayCompile,'comfort/notice overlays are not graded');
  const shader={uniforms:{},fragmentShader:'#include <colorspace_fragment>'};
  material.onBeforeCompile(shader);
  assert.ok(shader.uniforms.uXRFilmStrength.value>0);
  film.setLook('clean');film.render(scene,camera,4);
  assert.equal(shader.uniforms.uXRFilmStrength.value,0);
  assert.equal(film.inspect().path,'xr-clean');
  film.dispose();mesh.geometry.dispose();material.dispose();overlay.geometry.dispose();overlay.material.dispose();
});

test('the 1991 look only crushes the blacks in XR and is a selectable preset',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
  const room=new THREE.Group(),material=new THREE.MeshBasicMaterial();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(),material));
  const renderer={xr:{isPresenting:true,enabled:true},render:()=>{},
    setRenderTarget:()=>assert.fail('XR framebuffer must not be replaced'),
    getDrawingBufferSize:()=>assert.fail('XR must not allocate desktop targets')};
  const film=createFilmEffects(renderer,{room});
  assert.equal(film.setLook('broadcast'),'broadcast');
  const shader={uniforms:{},fragmentShader:'#include <colorspace_fragment>'};
  material.onBeforeCompile(shader);
  film.render(scene,camera,1);
  assert.equal(shader.uniforms.uXRFilmCrush.value,1);
  assert.ok(shader.uniforms.uXRFilmStrength.value>0);
  assert.equal(film.inspect().extraDrawCalls,0,'no grain, smear or flicker passes in the headset');
  film.setLook('film');film.render(scene,camera,2);
  assert.equal(shader.uniforms.uXRFilmCrush.value,0);
  assert.equal(film.setLook('vhs'),'film','unknown looks are ignored');
  film.dispose();material.dispose();
});

test('clean and zero-strength views render directly without allocating postprocessing buffers',()=>{
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();let renders=0;
  const renderer={xr:{isPresenting:false},render:()=>renders++,
    getDrawingBufferSize:()=>assert.fail('disabled effects must not allocate targets')};
  const film=createFilmEffects(renderer,{});
  film.setLook('clean');film.render(scene,camera);
  film.setLook('dream');film.setStrength(0);film.render(scene,camera);
  assert.equal(renders,2);assert.equal(film.inspect().extraDrawCalls,0);
  film.dispose();
});
