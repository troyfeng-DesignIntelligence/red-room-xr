import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES modules directly, as the spatial tests do.
const load = file => import(`data:text/javascript;base64,${readFileSync(new URL(`../dist/js/${file}`, import.meta.url)).toString('base64')}`);
const { createMusicField, RECORD_SOURCES } = await load('music-field.js');
const { createSimulation } = await load('simulation.js');
const spatial = JSON.parse(readFileSync(new URL('../dist/assets/spatial.json', import.meta.url), 'utf8'));

// One record behind a curtain along x = 0; every further metre of x crosses one more curtain line.
const curtains = ([ax], [bx]) => 1 + Math.floor(Math.abs(Math.min(ax, 0) - Math.min(bx, 0)) / 1);
const field = createMusicField([{ at: [2, 0] }], curtains, { reach: 14 });

test('the record is louder and brighter nearer, and silent out of reach', () => {
  const near = field.sample(1, 0), far = field.sample(-0.5, 9);
  assert.ok(near.gain > 0.8 && near.gain <= 1);
  assert.ok(far.gain < near.gain && far.cutoff < near.cutoff);
  assert.deepEqual(field.sample(1, 20), { gain: 0, cutoff: 600, direction: [0, 0] }, 'beyond reach');
});

test('each curtain beyond the first takes level and brightness', () => {
  // Both 4.5 m from the record: one behind its own curtain, one two curtains further.
  const one = field.sample(0.5, Math.sqrt(4.5 ** 2 - 1.5 ** 2)), three = field.sample(-2.5, 0);
  assert.ok(three.gain < one.gain * 0.35, 'two more curtains: about -12 dB');
  assert.ok(three.cutoff < one.cutoff * 0.35);
});

test('the record is heard from where it plays, louder sources weighing more', () => {
  const [dx, dz] = field.sample(1, 0).direction;
  assert.ok(dx > 0.99 && Math.abs(dz) < 1e-9, 'straight towards +x');
  assert.ok(Math.abs(Math.hypot(...field.sample(-0.5, 9).direction) - 1) < 1e-9, 'a unit direction');
  const two = createMusicField([{ at: [2, 0] }, { at: [-6, 0] }], () => 1, { reach: 14 });
  assert.ok(two.sample(0, 0).direction[0] > 0.9, 'the nearer record wins');
  const even = createMusicField([{ at: [4, 0] }, { at: [0, 4] }], () => 1, { reach: 14 }).sample(0, 0).direction;
  assert.ok(Math.abs(even[0] - Math.SQRT1_2) < 1e-9 && Math.abs(even[1] - Math.SQRT1_2) < 1e-9, 'two equal records: between them');
});

test('on the real floor plan: silent at the start, faint near the far rooms, moving on dream circuits', () => {
  const simulation = createSimulation(spatial), music = createMusicField(RECORD_SOURCES, simulation.wallsBetween);
  const at = (x, z, phase = 'normal') => music.sample(x, z, phase).gain;
  for (const [x, z] of [[0, 7], [-7.2, 0], [-14, -2.6]]) assert.equal(at(x, z), 0, `silent at ${x}, ${z} on an ordinary circuit`);
  assert.ok(at(-7, 24.2) > 0.75, 'clearest right by the mirror room curtain');
  assert.ok(at(-7, 21) > 0.4 && at(-7, 21) < at(-7, 24.2), 'softer in the middle of the room');
  assert.ok(at(-9.5, 15.5) > 0.05 && at(-9.5, 15.5) < 0.3, 'barely there in the corridor leading in');
  assert.ok(at(-24, 8) > 0.4, 'the empty-table room has it too');
  assert.ok(at(0, 2, 'dream') > 0.4 && at(0, 2) === 0, 'on dream circuits it is behind the waiting room chairs');
  assert.equal(at(-24, 8, 'dream'), 0, 'and gone from the empty-table room');
});
