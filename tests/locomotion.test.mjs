import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES module directly, as the spatial tests do.
const source = readFileSync(new URL('../dist/js/locomotion.js', import.meta.url), 'utf8');
const { createWalker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const run = (walker, seconds, hz, x, z) => {
  for (let i = 0; i < Math.round(seconds * hz); i++) walker.update(1 / hz, x, z);
  return Math.hypot(walker.velocity.x, walker.velocity.z);
};

test('walking eases in and out instead of starting and stopping in one frame', () => {
  const walker = createWalker({ speed: 1.25, accelTime: 0.35, decelTime: 0.25 });
  walker.update(1 / 60, 0, -1);
  const first = Math.hypot(walker.velocity.x, walker.velocity.z);
  assert.ok(first > 0 && first < 0.3, 'one frame does not reach full speed');
  assert.ok(run(walker, 0.35, 60, 0, -1) > 1.25 * 0.94, 'about 95% of walking speed after the acceleration time');
  assert.ok(walker.velocity.z < 0 && Math.abs(walker.velocity.x) < 1e-9, 'heading follows the requested direction');
  assert.ok(run(walker, 0.1, 60, 0, 0) > 0, 'the body glides briefly after release');
  assert.equal(run(walker, 0.4, 60, 0, 0), 0, 'it settles fully at rest');
});

test('easing is independent of the frame rate', () => {
  const speeds = [30, 60, 90, 144].map(hz => run(createWalker(), 0.2, hz, 1, 0));
  for (const value of speeds) assert.ok(Math.abs(value - speeds[1]) < 0.01, `${value} vs ${speeds[1]}`);
});

test('the direction length does not change the walking speed', () => {
  assert.ok(Math.abs(run(createWalker(), 1, 60, 3, 4) - run(createWalker(), 1, 60, 0.3, 0.4)) < 1e-9);
});

test('footfalls follow travelled distance, with an early first step', () => {
  const walker = createWalker({ stepLength: 0.72 });
  walker.update(1 / 60, 0, -1);
  let travelled = 0, first = null, count = 0;
  while (travelled < 3) {
    travelled += 0.02;
    const steps = walker.advance(0.02);
    if (steps && first === null) first = travelled;
    count += steps;
  }
  assert.ok(first < 0.4, `first footfall after ${first} m`);
  assert.equal(count, 4);
  assert.equal(walker.advance(0), 0, 'blocked movement makes no sound');
  walker.stop();
  assert.equal(walker.inspect().moving, false);
  assert.equal(walker.speedFraction(), 0);
});

test('invalid input cannot poison the velocity', () => {
  const walker = createWalker();
  walker.update(NaN, 1, 0);
  walker.update(1 / 60, NaN, Infinity);
  walker.update(-1, 1, 0);
  assert.ok(Number.isFinite(walker.velocity.x) && Number.isFinite(walker.velocity.z));
  assert.equal(walker.advance(NaN), 0);
  assert.equal(walker.advance(Infinity), 0);
});

test('head bob is zero at rest and bounded while walking', () => {
  const walker = createWalker();
  assert.equal(walker.bob(0.012), 0);
  run(walker, 0.5, 60, 1, 0);
  for (let i = 0; i < 40; i++) {
    walker.advance(0.05);
    assert.ok(Math.abs(walker.bob(0.012)) <= 0.012 + 1e-9);
  }
});
