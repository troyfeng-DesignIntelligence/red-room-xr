import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES module directly, as the spatial tests do.
const source = readFileSync(new URL('../dist/js/flicker.js', import.meta.url));
const { lightAt, DARKEST, CRACKLES } = await import(`data:text/javascript;base64,${source.toString('base64')}`);

const samples = reduced => Array.from({ length: 251 }, (_, i) => ({ t: i / 100, light: lightAt(i / 100, reduced) }));
// A flash (WCAG 2.3.1) is a pair of opposing changes in brightness: a swing of
// at least a fifth of full brightness one way, then one back.
function flashes(series) {
  const swings = [];
  let direction = 0, anchor = series[0];
  for (const sample of series) {
    const change = sample.light - anchor.light;
    if (Math.abs(change) >= 0.2 && Math.sign(change) !== direction) {
      swings.push(sample.t); direction = Math.sign(change); anchor = sample;
    } else if (direction && Math.sign(change) === direction) anchor = sample;
  }
  const pairs = [];
  for (let i = 1; i < swings.length; i += 2) pairs.push({ start: swings[i - 1], end: swings[i] });
  return pairs;
}

test('the lights are full before and after, nearly out while the room changes', () => {
  assert.equal(lightAt(-1), 1);
  assert.equal(lightAt(0), 1);
  assert.equal(lightAt(Number.NaN), 1);
  assert.equal(lightAt(5), 1);
  assert.ok(lightAt(DARKEST) <= 0.1, 'the room changes unseen');
  assert.ok(Math.min(...samples(false).map(s => s.light)) <= 0.06);
});

test('never more than two flashes in any second, and the crackles land on the stutters', () => {
  const swings = flashes(samples(false));
  for (const swing of swings) {
    const within = swings.filter(other => other.start >= swing.start && other.start < swing.start + 1);
    assert.ok(within.length <= 2, `${within.length} flashes from ${swing.start}s`);
  }
  for (const at of CRACKLES) {
    const before = lightAt(at - 0.02), after = lightAt(at + 0.02);
    assert.ok(Math.abs(after - before) > 0.2, `${at}s is a stutter`);
  }
});

test('with reduced motion, one slow dip and no flashes', () => {
  const series = samples(true);
  const lowest = series.reduce((low, s) => (s.light < low.light ? s : low));
  assert.ok(lowest.light >= 0.3);
  for (let i = 1; i < series.length; i++) {
    const step = series[i].light - series[i - 1].light;
    assert.ok(series[i].t <= lowest.t + 0.6 ? step <= 1e-9 || series[i].t > lowest.t : step >= -1e-9, 'down, hold, back up');
  }
  assert.ok(series.every(s => Math.abs(lightAt(s.t + 0.01, true) - s.light) < 0.03), 'no sudden steps');
});
