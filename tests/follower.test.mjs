import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES module directly, as the spatial tests do.
const source = readFileSync(new URL('../dist/js/follower.js', import.meta.url));
const { createFollower } = await import(`data:text/javascript;base64,${source.toString('base64')}`);

const seeded = (seed = 7) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const CADENCE = 0.576; // 0.72 m strides at 1.25 m/s

// Walks `count` steps from `start`, listening every 50 ms; returns what it heard and when.
function walk(follower, count, start = 0, dream = true) {
  const heard = [], visitor = [];
  for (let t = start, next = start; t <= start + count * CADENCE + 0.01; t += 0.05) {
    if (t >= next && visitor.length < count) { follower.step(next); visitor.push(next); next += CADENCE; }
    for (const step of follower.update(t, { dream })) heard.push({ ...step, heard: t });
  }
  return { heard, visitor };
}
const listen = (follower, from, to, dream = true) => {
  const heard = [];
  for (let t = from; t <= to; t += 0.05) for (const step of follower.update(t, { dream })) heard.push({ ...step, heard: t });
  return heard;
};

test('outside dream circuits no one follows', () => {
  const follower = createFollower({ random: seeded() });
  assert.deepEqual(walk(follower, 40, 0, false).heard, []);
});

test('it joins only after the visitor has walked a while, off the beat and never quite in time', () => {
  const follower = createFollower({ random: seeded(), warmup: 8 });
  follower.update(0, { dream: true });
  const { heard, visitor } = walk(follower, 30);
  assert.ok(heard.length > 12, `${heard.length} steps followed`);
  assert.ok(heard[0].at > visitor[7], 'nothing before the eighth step');
  const lags = heard.map(step => step.at - visitor.filter(t => t < step.at).at(-1));
  assert.ok(lags.every(lag => lag >= 0.22 - 1e-9 && lag <= 0.42 + 1e-9), 'between the visitor’s steps, never under the next one');
  assert.ok(Math.max(...lags) - Math.min(...lags) > 0.05, 'its pace drifts against the visitor’s');
});

test('now and then it misses a step', () => {
  const follower = createFollower({ random: seeded(3), warmup: 1, follow: [1000, 1000] });
  follower.update(0, { dream: true });
  const { heard, visitor } = walk(follower, 200);
  const missed = 1 - heard.length / (visitor.length - 1);
  assert.ok(missed > 0.05 && missed < 0.2, `missed ${(missed * 100).toFixed(0)}%`);
});

test('it stops when the visitor stops: one late step, then quiet', () => {
  const follower = createFollower({ random: seeded(), warmup: 1, follow: [1000, 1000] });
  follower.update(0, { dream: true });
  const { visitor } = walk(follower, 12);
  const stopped = visitor.at(-1) + 0.3;
  follower.stop(stopped);
  const after = listen(follower, stopped + 0.6, stopped + 8);
  const settles = after.filter(step => step.settle);
  assert.equal(settles.length, 1);
  assert.ok(settles[0].at - stopped >= 0.5 && settles[0].at - stopped <= 0.75);
  assert.equal(after.filter(step => step.at > settles[0].at).length, 0, 'nothing after it');
});

test('over a long walk it falls away for a stretch and comes back', () => {
  const follower = createFollower({ random: seeded(11), warmup: 8, follow: [40, 70], rest: [18, 32] });
  follower.update(0, { dream: true });
  const { heard, visitor } = walk(follower, 300);
  const gaps = heard.slice(1).map((step, i) => (step.at - heard[i].at) / CADENCE);
  assert.ok(gaps.some(gap => gap >= 15), 'a long silence while it rests');
  assert.ok(heard.at(-1).at > visitor[200], 'and it is back later');
});

test('leaving the dream circuit cuts it off at once', () => {
  const follower = createFollower({ random: seeded(), warmup: 1, follow: [1000, 1000] });
  follower.update(0, { dream: true });
  const { visitor } = walk(follower, 6);
  follower.step(visitor.at(-1) + CADENCE);
  assert.deepEqual(follower.update(visitor.at(-1) + CADENCE + 0.01, { dream: false }), []);
  assert.deepEqual(listen(follower, visitor.at(-1) + 1, visitor.at(-1) + 3), [], 'pending steps dropped');
  assert.equal(follower.inspect().phase, 'waiting', 'and it waits to begin again');
});

test('a teleport walks it two steps and settles it', () => {
  const follower = createFollower({ random: seeded(5), warmup: 1, follow: [1000, 1000] });
  follower.update(0, { dream: true });
  for (let jump = 0; jump < 6; jump++) { const t = jump * 3; follower.step(t); follower.step(t + 0.5); follower.stop(t + 0.55); }
  const heard = listen(follower, 0, 20);
  assert.ok(heard.filter(step => !step.settle).length >= 8 && heard.filter(step => step.settle).length >= 5);
});
