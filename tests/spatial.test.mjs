import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
// Load the browser ES module directly without depending on ancestor package.json
// files or changing the buildless site's packaging.
const source = readFileSync(new URL('../dist/js/simulation.js', import.meta.url), 'utf8');
const { createSimulation, pointInPolygon, segmentsIntersect } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const rect = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2]];
const room = {
  floorY: 0,
  walkablePolygons: [rect(-5, -5, 5, 5)],
  wallSegments: [[[0, -5], [0, -0.6]], [[0, 0.6], [0, 5]]],
  obstacles: [{ center: [2, 2], radius: 0.55 }],
};

test('floor union preserves doorways, and finite-radius users cannot stand on floor edges', () => {
  const sim = createSimulation({ walkablePolygons: [rect(-3, -2, 0.1, 2), rect(-0.1, -2, 3, 2)] });
  assert.equal(sim.isValidPosition(0, 0, 0.2), true);
  assert.equal(sim.isValidPosition(2.9, 0, 0.2), false);
  assert.equal(sim.isValidPosition(6, 0), false);
  assert.equal(sim.isValidPosition(NaN, 0), false);
  assert.equal(pointInPolygon([3, 2], rect(-3, -2, 3, 2)), true);
});

test('swept movement blocks thin curtains even when endpoints are both walkable', () => {
  const sim = createSimulation(room);
  const movement = sim.move({ x: -2, z: 2 }, 4, 0);
  assert.equal(movement.collided, true);
  assert.ok(movement.x < -0.2 && movement.x > -0.3);
  assert.equal(sim.traceSegment([-2, 2], [2, 2]).clear, false);
  assert.equal(sim.traceSegment([-2, 0], [2, 0]).clear, true);
  assert.equal(segmentsIntersect([-1, 0], [1, 0], [0, -1], [0, 1]), true);
  assert.equal(segmentsIntersect([-1, 0], [1, 0], [0, 0], [2, 0]), true);
});

test('movement slides along walls instead of stopping both axes', () => {
  const sim = createSimulation(room);
  const result = sim.move({ x: -0.3, z: 2 }, 1, 1);
  assert.equal(result.collided, true);
  assert.ok(result.x < -0.2);
  assert.ok(result.z > 2.9);
});

test('teleport rejects furniture, out-of-range landings, and a wall-separated valid floor', () => {
  const sim = createSimulation(room);
  assert.equal(sim.canTeleport([-2, 2], [1, 2]), false);
  assert.equal(sim.canTeleport([1, 0], [2, 2]), false);
  assert.equal(sim.canTeleport([-2, 0], [2, 0]), true);
  assert.equal(sim.canTeleport([-4, 0], [4, 0]), false);
  assert.equal(sim.canTeleport([-2, 0], [-2, 0]), false);
});

test('obstacle visibility follows the current dream state', () => {
  const sim = createSimulation({
    walkablePolygons: [rect(-10, -10, 10, 10)],
    obstacles: [
      { center: [2, 0], radius: 1, state: 'normal' },
      { center: [-2, 0], radius: 1, state: 'dream' },
    ],
  });
  assert.equal(sim.isValidPosition(2, 0), false);
  assert.equal(sim.isValidPosition(-2, 0), true);
  sim.state.phase = 'dream';
  assert.equal(sim.isValidPosition(2, 0), true);
  assert.equal(sim.isValidPosition(-2, 0), false);
});

test('lap state only changes after ordered checkpoints and a genuine return to the start', () => {
  const changes = [];
  const sim = createSimulation({
    walkablePolygons: [rect(-1, -1, 11, 11)],
    checkpoints: [[0, 0], [5, 0], [10, 5], [5, 10], [0, 5], [0, 0]],
  }, { onLapChange: state => changes.push(state), checkpointRadius: 0.7 });
  sim.updateProgress(0, 0);
  sim.updateProgress(0, 5); // Walking straight to the last checkpoint is insufficient.
  sim.updateProgress(0, 0);
  assert.equal(sim.state.lap, 1);
  assert.equal(sim.state.checkpointIndex, 1);
  const path = [[5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5], [0, 0]];
  for (const point of path) sim.updateProgress(...point);
  assert.equal(sim.state.lap, 2);
  assert.equal(sim.state.phase, 'dream');
  for (const point of path) sim.updateProgress(...point);
  assert.equal(sim.state.lap, 3);
  assert.equal(sim.state.phase, 'normal');
  assert.equal(changes.length, 2);
  sim.resetProgress();
  assert.equal(sim.state.lap, 1);
});

test('a teleport crossing a checkpoint still counts, but jumps over 6.25 metres do not', () => {
  const sim = createSimulation({
    walkablePolygons: [rect(-1, -1, 21, 21)],
    checkpoints: [[0, 0], [3, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  }, { checkpointRadius: 0.4 });
  sim.updateProgress(0, 0);
  sim.updateProgress(5, 0);
  assert.equal(sim.state.checkpointIndex, 2);
  sim.updateProgress(15, 0);
  assert.equal(sim.state.checkpointIndex, 2);
});

test('a nearby checkpoint behind a closed curtain does not count', () => {
  const sim = createSimulation({
    ...room,
    checkpoints: [[-2, 2], [0.4, 2], [3, 4], [-2, 2]],
  });
  sim.updateProgress(-2, 2);
  sim.updateProgress(-0.3, 2);
  assert.equal(sim.state.checkpointIndex, 1);
});

const assetPath = new URL('../dist/assets/spatial.json', import.meta.url);
test('exported scene route is walkable and completes both room states', { skip: !existsSync(assetPath) }, () => {
  const data = JSON.parse(readFileSync(assetPath, 'utf8'));
  const sim = createSimulation(data);
  assert.ok(sim.checkpoints.length >= 10);
  const failed = data.route.filter(([x, z]) => !sim.isValidPosition(x, z, 0.2));
  assert.equal(failed.length, 0, `Route has ${failed.length} blocked samples: ${JSON.stringify(failed.slice(0, 4))}`);
  for (let lap = 0; lap < 2; lap++) {
    for (const point of data.route) sim.updateProgress(...point);
  }
  assert.equal(sim.state.lap, 3);
  assert.equal(sim.state.phase, 'normal');
});
