import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installHaze, createHaze } from '../dist/js/haze.js';

test('the haze joins three.js fog once, in both shader stages', () => {
  installHaze();
  installHaze();
  for (const chunk of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
    assert.equal(THREE.ShaderChunk[chunk].split('Haze').length - 1 > 0, true, chunk);
  }
  assert.equal(THREE.ShaderChunk.fog_fragment.match(/applyHaze/g).length, 1, 'added once');
  assert.ok(THREE.ShaderChunk.fog_pars_fragment.includes('vec3 applyHaze(vec3 color)'));
  assert.ok(!/\bflat\b/.test(THREE.ShaderChunk.fog_pars_fragment), 'no GLSL 3 reserved words as names');
});

test('every fogged material gets the shared values; its own shader changes still run', () => {
  const scene = new THREE.Scene();
  const fogged = new THREE.MeshBasicMaterial(), clear = new THREE.MeshBasicMaterial({ fog: false }), custom = new THREE.MeshBasicMaterial();
  let ownRan = false;
  custom.onBeforeCompile = () => { ownRan = true; };
  custom.customProgramCacheKey = () => 'velvet';
  for (const material of [fogged, clear, custom]) scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), fogged));
  const haze = createHaze(scene);
  const shader = { uniforms: {} };
  custom.onBeforeCompile(shader);
  assert.ok(ownRan, 'the material\'s own change runs first');
  for (const name of ['hazeMin', 'hazeMax', 'hazeColor', 'hazeLight', 'hazeStrength', 'hazeTime']) assert.equal(shader.uniforms[name], haze.uniforms[name], name);
  assert.equal(custom.customProgramCacheKey(), 'velvet|haze');
  assert.ok(fogged.customProgramCacheKey().endsWith('|haze'));
  assert.ok(!Object.prototype.hasOwnProperty.call(clear, 'onBeforeCompile'), 'a material without fog is left alone');
  // The volume covers the mirrored waiting room, floor to curtain tops.
  assert.deepEqual(haze.uniforms.hazeMin.value.toArray(), [-11.8, 0, 16.6]);
  assert.deepEqual(haze.uniforms.hazeMax.value.toArray(), [-2.2, 7.5, 25]);
});

test('it comes in with a dream circuit and goes with an ordinary one', () => {
  const haze = createHaze(new THREE.Scene());
  assert.equal(haze.inspect().strength, 0);
  haze.setDream(true);
  haze.update(0.8, 10);
  const partway = haze.inspect().strength;
  assert.ok(partway > 0.5 && partway < 0.7, `${partway} after 0.8 s`);
  for (let i = 0; i < 300; i++) haze.update(1 / 60, 10 + i / 60);
  assert.ok(haze.inspect().strength > 0.99);
  assert.ok(Math.abs(haze.uniforms.hazeTime.value - (10 + 299 / 60)) < 1e-9, 'the drift keeps time');
  haze.setDream(false, { now: true });
  assert.equal(haze.inspect().strength, 0, 'at once when asked');
});
