import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { markChairLeather, markProps } from '../dist/js/presentation.js';

// Welded boxes, so each one is a single connected part of the merged mesh.
function part(x, y, z, width, height, depth) {
  const box = new THREE.BoxGeometry(width, height, depth);
  box.deleteAttribute('normal'); box.deleteAttribute('uv');
  return mergeVertices(box).translate(x, y, z);
}
function merged(parts) {
  const geometry = mergeGeometries(parts.map(([, geometry]) => geometry));
  const ranges = []; let start = 0;
  for (const [name, geometry] of parts) { ranges.push([name, start, start + geometry.getAttribute('position').count]); start += geometry.getAttribute('position').count; }
  return { mesh: new THREE.Mesh(geometry), ranges };
}
const marks = (mesh, [, from, to]) => {
  const leather = mesh.geometry.getAttribute('propLeather');
  return Array.from({ length: to - from }, (_, i) => leather.getX(from + i));
};
const obstacles = [
  { name: 'Chair 01', center: [0, 0], radius: 0.85 },
  { name: 'Torchiere 01', center: [0.8, 0], radius: 0.24 },
  { name: 'A | table', center: [-0.9, 0], radius: 0.4 },
  { name: 'A | statue', center: [3, 0], radius: 0.42 },
];

test('chairs turn to leather; lamps, the side table, the statue and tall parts do not', () => {
  const { mesh, ranges } = merged([
    ['seat', part(0, 0.4, 0, 0.8, 0.8, 0.8)],
    ['arm', part(0.35, 0.6, 0, 0.15, 0.3, 0.8)],
    ['lamp base', part(0.8, 0.05, 0, 0.3, 0.1, 0.3)],
    ['table top', part(-0.9, 0.6, 0, 0.5, 0.04, 0.5)],
    ['statue', part(3, 0.9, 0, 0.5, 1.8, 0.5)],
    ['too tall', part(0, 0.9, 0.3, 0.2, 1.4, 0.2)],
  ]);
  assert.ok(markChairLeather(mesh, obstacles) > 0);
  const result = Object.fromEntries(ranges.map(range => [range[0], marks(mesh, range)]));
  assert.ok(result.seat.every(v => v === 1) && result.arm.every(v => v === 1));
  for (const name of ['lamp base', 'table top', 'statue', 'too tall']) assert.ok(result[name].every(v => v === 0), name);
});

test('the red double chair and rooms without club chairs are left alone', () => {
  const { mesh } = merged([['loveseat', part(0, 0.4, 0, 1.4, 0.8, 0.8)]]);
  assert.equal(markChairLeather(mesh, [{ name: 'F | double', center: [0, 0], radius: 0.85 }]), 0);
  assert.equal(mesh.geometry.getAttribute('propLeather'), undefined);
  assert.equal(markChairLeather(mesh, []), 0);
});

test('parts follow the mesh world transform', () => {
  const { mesh, ranges } = merged([['seat', part(0, 0.4, 0, 0.8, 0.8, 0.8)]]);
  mesh.position.set(5, 0, 0);
  assert.equal(markChairLeather(mesh, obstacles), 0, 'moved away from the chair footprint');
  mesh.position.set(0, 0, 0);
  assert.equal(markChairLeather(mesh, obstacles), ranges[0][2]);
});

test('a chair foot standing under its side table stays with the chair; the table keeps its legs', () => {
  const pieces = [
    { name: 'Chair 01', center: [0, 0], radius: 0.85 },
    { name: 'A | table', center: [-0.75, 0], radius: 0.4 },
  ];
  const { mesh, ranges } = merged([
    ['seat', part(0, 0.4, 0, 0.8, 0.5, 0.8)],
    ['foot under the table', part(-0.45, 0.05, 0.1, 0.08, 0.1, 0.08)],
    ['far foot', part(0.35, 0.05, 0.35, 0.08, 0.1, 0.08)],
    ['table top', part(-0.75, 0.55, 0, 0.6, 0.04, 0.6)],
    ['table leg', part(-0.5, 0.27, 0.25, 0.04, 0.5, 0.04)],
  ]);
  markProps(mesh, pieces);
  const owner = mesh.geometry.getAttribute('propObject');
  const of = name => { const [, from] = ranges.find(range => range[0] === name); return owner.getX(from); };
  assert.equal(of('foot under the table'), 0, 'inside the table\'s reach, but it is the chair\'s foot');
  assert.equal(of('far foot'), 0);
  assert.equal(of('table top'), 1);
  assert.equal(of('table leg'), 1, 'a tall leg under the top stays the table\'s');
});
