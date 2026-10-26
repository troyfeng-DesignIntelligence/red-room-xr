import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES modules directly, as the spatial tests do.
const load = async file => import(`data:text/javascript;base64,${readFileSync(new URL(file, import.meta.url)).toString('base64')}`);
const { createSimulation } = await load('../dist/js/simulation.js');
const { roomAt } = await load('../dist/js/rooms.js');

// A lap on the real floor plan: back into the waiting room by the other doorway.
const spatial = JSON.parse(readFileSync(new URL('../dist/assets/spatial.json', import.meta.url), 'utf8'));
const route = spatial.route;
const roomOf = (x, z) => roomAt(x, z)[0];
const walk = (points, changes = []) => {
  const sim = createSimulation(spatial, { roomOf, onLapChange: state => changes.push(state) });
  for (const point of points) sim.updateProgress(...point);
  return sim;
};
const line = (a, b) => {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1);
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
};
const nearest = ([x, z], points = route) => points.reduce((best, p, i) => Math.hypot(p[0] - x, p[1] - z) < Math.hypot(points[best][0] - x, points[best][1] - z) ? i : best, 0);
// A walk without its visit to a side room: straight on along the corridor instead.
const skip = (points, from, to) => points.slice(0, nearest(from, points) + 1).concat(line(from, to), points.slice(nearest(to, points)));

test('the guide route is one circuit, and twice round is two', () => {
  const changes = [];
  assert.equal(walk(route, changes).state.lap, 2);
  assert.deepEqual(changes.map(state => state.phase), ['dream']);
  assert.equal(walk(route.concat(route.slice(1))).state.lap, 3);
});

test('coming back in toward the chairs counts; the starting spot does not matter', () => {
  const into = route.slice(0, -18).concat(line([1.7, 6.5], [1.7, 3.5]));
  assert.equal(walk(into).state.lap, 2);
});

test('the side rooms may be skipped', () => {
  const withoutMirror = skip(route, [-9.5, 13.8], [-4.5, 14.3]);
  const withoutTable = skip(route, [-14, 5.61], [-14, 10.59]);
  assert.equal(walk(withoutMirror).state.lap, 2, 'past the mirrored waiting room');
  assert.equal(walk(withoutTable).state.lap, 2, 'past the empty-table room');
  assert.equal(walk(skip(withoutTable, [-9.5, 13.8], [-4.5, 14.3])).state.lap, 2, 'past both');
});

test('the other way round counts; out and back the same way never does', () => {
  assert.equal(walk([...route].reverse()).state.lap, 2);
  const corridor = nearest([-14, 3.5]);
  const outAndBack = route.slice(0, corridor).concat(route.slice(0, corridor).reverse());
  assert.equal(walk(outAndBack).state.lap, 1, 'to the corridor of returns and back');
  const statues = nearest([-7.2, 0]);
  assert.equal(walk(route.slice(0, statues).concat(route.slice(0, statues).reverse(), route.slice(0, statues), route.slice(0, statues).reverse())).state.lap, 1, 'twice to the statue corridor and back');
});

test('a jump is not a walk: it never closes a circuit', () => {
  const sim = walk(route.slice(0, nearest([-14, 3.5])));
  sim.updateProgress(1.7, 10.5); // a debug jump into the far corridor
  for (const point of line([1.7, 10.5], [1.7, 5])) sim.updateProgress(...point);
  assert.equal(sim.state.lap, 1);
});

test('a teleport through a doorway passes through the rooms on the way', () => {
  const sim = walk(route.slice(0, nearest([1.7, 10.5]) + 1));
  assert.equal(sim.state.lap, 1);
  sim.updateProgress(1.7, 6.1); // 4.4 m in one step, from the corridor into the waiting room
  assert.equal(sim.state.lap, 2);
});

test('a reset starts the count again from the waiting room', () => {
  const sim = walk(route);
  sim.resetProgress();
  assert.equal(sim.state.lap, 1);
  for (const point of route) sim.updateProgress(...point);
  assert.equal(sim.state.lap, 2);
});
