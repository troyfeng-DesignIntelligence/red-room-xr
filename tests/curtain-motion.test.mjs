import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurtainMotion } from '../dist/js/curtain-motion.js';

const front = { id: 'front', path: [[-4, 0], [4, 0]], minY: 0, maxY: 4 };
const body = (x = 0, z = 0.2, extra = {}) => ({ id: 'body', x, y: 1.1, z, radius: 0.65, ...extra });
const step = (motion, frames, getSource, hz = 60, ids) => {
  for (let i = 0; i < frames; i++) motion.update(1 / hz, [getSource(i / hz)], ids);
};

test('distant movement and a first nearby sample do not disturb the curtain', () => {
  const motion = createCurtainMotion([front]);
  motion.update(1 / 60, [body()]);
  assert.equal(motion.inspect().emitted, 0);
  step(motion, 120, t => body(t, 3));
  assert.equal(motion.inspect().emitted, 0);
});

test('brushing along a curtain produces bounded, directed pulses without restarting their age every frame', () => {
  const motion = createCurtainMotion([front]);
  step(motion, 60, t => body(t));
  assert.ok(motion.inspect().emitted >= 7);
  assert.ok(motion.inspect().emitted <= 9);
  assert.equal(motion.impulses.length, 6);
  assert.ok(motion.impulses.some(pulse => pulse.active && pulse.age > 0.1));
  for (const pulse of motion.impulses.filter(pulse => pulse.active)) {
    assert.equal(pulse.panelId, 'front');
    assert.ok(pulse.strength > 0.04 && pulse.strength <= 0.1);
    assert.equal(pulse.position.z, 0);
    assert.equal(pulse.direction.z, -1);
    assert.equal(Math.hypot(pulse.direction.x, pulse.direction.z), 1);
  }
});

test('collision intent pushes cloth even when the body cannot move', () => {
  const motion = createCurtainMotion([front]);
  step(motion, 30, () => body(0, 0.2, { intentZ: -1.8 }));
  assert.ok(motion.inspect().emitted >= 4);
  assert.ok(motion.impulses.some(pulse => pulse.active && pulse.direction.z < 0));
  const away = createCurtainMotion([front]);
  step(away, 30, () => body(0, 0.2, { intentZ: 1.8 }));
  assert.equal(away.inspect().emitted, 0);
});

test('standing still stops emission and existing waves decay with no sources or after a pause', () => {
  const motion = createCurtainMotion([front]);
  step(motion, 30, t => body(t));
  const last = body(29 / 60);
  const emitted = motion.inspect().emitted;
  step(motion, 120, () => last);
  assert.equal(motion.inspect().emitted, emitted);
  motion.update(1, []);
  assert.ok(motion.impulses.every(pulse => !pulse.active || pulse.age >= 3));
  motion.update(2, []);
  assert.equal(motion.inspect().activeImpulses, 0);
  assert.equal(motion.inspect().trackedSources, 0);
});

test('a source only reaches the nearest curtain, including tight parallel passages', () => {
  const behind = { ...front, id: 'behind', path: [[-4, -0.18], [4, -0.18]] };
  const motion = createCurtainMotion([behind, front]);
  step(motion, 45, t => body(t, 0.12));
  assert.ok(motion.inspect().emitted > 0);
  assert.ok(motion.impulses.filter(pulse => pulse.active).every(pulse => pulse.panelId === 'front'));
});

test('hidden phase panels are filtered and their existing waves are removed', () => {
  const behind = { ...front, id: 'dream', path: [[-4, -0.18], [4, -0.18]] };
  const motion = createCurtainMotion([behind, front]);
  step(motion, 30, t => body(t, 0.12), 60, new Set(['dream']));
  assert.ok(motion.impulses.filter(pulse => pulse.active).every(pulse => pulse.panelId === 'dream'));
  motion.update(1 / 60, [], new Set(['front']));
  assert.equal(motion.inspect().activeImpulses, 0);
});

test('teleports and long frames reset tracking without sweeping a contact along the jump', () => {
  const motion = createCurtainMotion([front]);
  motion.update(1 / 60, [body(-3)]);
  motion.update(1 / 60, [body(3, 0.2, { intentZ: -2 })]);
  assert.equal(motion.inspect().emitted, 0);
  motion.update(1, [body(2, 0.2, { intentZ: -2 })]);
  assert.equal(motion.inspect().emitted, 0);
  step(motion, 30, () => body(2));
  assert.equal(motion.inspect().emitted, 0);
});

test('response strength is stable at 30, 60, and 90 Hz and fixed capacity is respected', () => {
  const strengths = [], emissions = [];
  for (const hz of [30, 60, 90]) {
    const motion = createCurtainMotion([front], { maxImpulses: 3 });
    step(motion, hz, t => body(t), hz);
    strengths.push(motion.inspect().maxStrength);
    emissions.push(motion.inspect().emitted);
    assert.equal(motion.impulses.length, 3);
    assert.ok(motion.inspect().activeImpulses <= 3);
    assert.ok(motion.inspect().maxStrength <= 0.1);
  }
  assert.ok(Math.max(...strengths) - Math.min(...strengths) < 1e-6);
  assert.ok(Math.max(...emissions) - Math.min(...emissions) <= 1);
});

test('hands respond vertically, exact contact has a finite normal, and invalid input cannot poison pulses', () => {
  const motion = createCurtainMotion([front]);
  const hand = y => ({ id: 'left', x: 0, y, z: 0, radius: 0.3 });
  step(motion, 30, t => hand(1 + t));
  assert.ok(motion.inspect().emitted > 0);
  motion.update(NaN, [body(NaN), { ...hand(1), x: Infinity }]);
  motion.update(Infinity, [body(0, 0.1, { intentX: Infinity, intentZ: NaN })]);
  for (const pulse of motion.impulses) {
    for (const number of [pulse.age, pulse.strength, ...Object.values(pulse.position), ...Object.values(pulse.direction)]) {
      assert.ok(Number.isFinite(number));
    }
  }
  motion.reset();
  assert.deepEqual(motion.inspect(), { activeImpulses: 0, emitted: 0, maxStrength: 0, time: 0, trackedSources: 0 });
});
