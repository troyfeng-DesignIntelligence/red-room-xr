import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES modules directly, as the spatial tests do.
const load = async file => import(`data:text/javascript;base64,${readFileSync(new URL(file, import.meta.url)).toString('base64')}`);
const { createWatchers, GAZES } = await load('../dist/js/watchers.js');
const spatial = JSON.parse(readFileSync(new URL('../dist/assets/spatial.json', import.meta.url), 'utf8'));

const deg = Math.PI / 180;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
// One statue at the origin whose face looks along +x.
const lone = () => createWatchers([{ index: 4, at: [0, 0], facing: 0 }]);
const yawOf = watchers => watchers.inspect()[0].yaw;
const never = () => false, always = () => true;

test('a statue in view never turns, however long it is watched', () => {
  const watchers = lone();
  for (let t = 0; t <= 60; t += 0.1) assert.equal(watchers.update(t, { visitor: [0, 3], seen: always }), false);
  assert.equal(yawOf(watchers), 0);
  assert.deepEqual(watchers.turns(), {});
});

test('unseen for two and a half seconds, she turns at once to face the visitor', () => {
  const watchers = lone();
  for (let t = 0; t < 2.45; t += 0.1) assert.equal(watchers.update(t, { visitor: [0, 3], seen: never }), false);
  assert.equal(yawOf(watchers), 0);
  assert.equal(watchers.update(2.5, { visitor: [0, 3], seen: never }), true);
  // Her face, turned by yaw (x toward z), points at the visitor.
  assert.ok(Math.abs(wrap(yawOf(watchers) - 90 * deg)) < 1e-9);
  assert.deepEqual(watchers.turns(), { 4: { dx: 0, dz: 0, yaw: yawOf(watchers) } });
});

test('her face, not where she stands, is what turns to the visitor', () => {
  const watchers = createWatchers([{ index: 1, at: [2, 1], facing: 122 * deg }]);
  watchers.update(0, { visitor: [-1, -2], seen: never });
  watchers.update(2.5, { visitor: [-1, -2], seen: never });
  const facing = 122 * deg + yawOf(watchers);
  assert.ok(Math.abs(wrap(facing - Math.atan2(-3, -3))) < 1e-9);
});

test('after turning she waits again before turning a second time', () => {
  const watchers = lone();
  watchers.update(0, { visitor: [0, 3], seen: never });
  watchers.update(2.5, { visitor: [0, 3], seen: never });
  for (let t = 2.6; t < 4.95; t += 0.1) assert.equal(watchers.update(t, { visitor: [0, -3], seen: never }), false);
  assert.ok(Math.abs(wrap(yawOf(watchers) - 90 * deg)) < 1e-9);
  assert.equal(watchers.update(5, { visitor: [0, -3], seen: never }), true);
  assert.ok(Math.abs(wrap(yawOf(watchers) + 90 * deg)) < 1e-9);
});

test('a glance resets her patience', () => {
  const watchers = lone();
  watchers.update(0, { visitor: [0, 3], seen: never });
  watchers.update(2, { visitor: [0, 3], seen: always });
  for (let t = 2.1; t < 4.55; t += 0.1) watchers.update(t, { visitor: [0, 3], seen: never });
  assert.equal(yawOf(watchers), 0);
  watchers.update(4.7, { visitor: [0, 3], seen: never });
  assert.ok(yawOf(watchers) !== 0);
});

test('turns smaller than twenty degrees are not worth the risk', () => {
  const watchers = lone();
  const visitor = [3 * Math.cos(15 * deg), 3 * Math.sin(15 * deg)];
  watchers.update(0, { visitor, seen: never });
  assert.equal(watchers.update(2.5, { visitor, seen: never }), false);
  assert.equal(yawOf(watchers), 0);
  const further = [3 * Math.cos(25 * deg), 3 * Math.sin(25 * deg)];
  assert.equal(watchers.update(5, { visitor: further, seen: never }), true);
  assert.ok(Math.abs(yawOf(watchers) - 25 * deg) < 1e-9);
});

test('each statue keeps its own watch', () => {
  const watchers = createWatchers([{ index: 1, at: [0, 0], facing: 0 }, { index: 2, at: [10, 0], facing: 0 }]);
  const seen = statue => statue.index === 1;
  watchers.update(0, { visitor: [5, 5], seen });
  watchers.update(3, { visitor: [5, 5], seen });
  assert.deepEqual(Object.keys(watchers.turns()), ['2']);
  assert.deepEqual(watchers.inspect().map(s => s.unseen), [false, true]);
});

test('in the dark every statue turns at once, even one in plain view', () => {
  const watchers = createWatchers([{ index: 1, at: [0, 0], facing: 0 }, { index: 2, at: [0, 6], facing: -90 * deg }]);
  assert.equal(watchers.turnAll([0, 3]), true);
  // The second already looks at the visitor, so only the first moves.
  assert.deepEqual(Object.keys(watchers.turns()), ['1']);
  assert.equal(watchers.turnAll([0, 3]), false);
});

test('starting over puts them all back', () => {
  const watchers = lone();
  watchers.turnAll([0, 3]);
  watchers.update(0, { visitor: [0, 3], seen: never });
  watchers.reset();
  assert.deepEqual(watchers.inspect(), [{ index: 4, facing: 0, yaw: 0, unseen: false }]);
  assert.deepEqual(watchers.turns(), {});
});

test('the measured gazes belong to the exported statues', () => {
  const statues = spatial.obstacles.filter(o => /statue/i.test(o.name)).map(o => o.name).sort();
  assert.deepEqual(Object.keys(GAZES).sort(), statues);
  // The far room's Medici is the waiting room's set turned half round.
  assert.ok(Math.abs(wrap((GAZES['F | statue'] - GAZES['A | statue'] - 180) * deg)) < 1e-9);
});
