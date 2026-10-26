import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
// Load the browser ES modules directly, as the spatial tests do.
const load = file => import(`data:text/javascript;base64,${readFileSync(new URL(`../dist/js/${file}`, import.meta.url)).toString('base64')}`);
const { createVoiceDirector } = await load('voice-director.js');
const { createSimulation } = await load('simulation.js');
const { roomAt } = await load('rooms.js');
const json = path => JSON.parse(readFileSync(new URL(`../dist/assets/${path}`, import.meta.url), 'utf8'));
const manifest = json('voices/manifest.json'), spatial = json('spatial.json');

const roomLine = (id, room, extra = {}) => ({ id, duration: 3, trigger: { type: 'room', room, from: [0, 0], ...extra } });
const circuit = (id, minLap, extra = {}) => ({ id, duration: 3, trigger: { type: 'lap', minLap, ...extra } });
// Steps into `room` at `from` and stays until `to` seconds, listening at 10 Hz.
const stay = (director, room, from, to, state = {}) => {
  const heard = [];
  director.update(null, state, from - 0.05);
  for (let now = from; now <= to + 1e-9; now += 0.1) {
    const line = director.update(room, state, now);
    if (line) heard.push(line.id);
  }
  return heard;
};

test('a room line speaks after a moment in its room, and not in other rooms', () => {
  const director = createVoiceDirector([roomLine('a', '03')], { dwell: 1.5 });
  assert.deepEqual(stay(director, '02', 0, 5), [], 'another room');
  assert.equal(director.update('03', {}, 5.1), null, 'just stepped in');
  assert.equal(director.update('03', {}, 6.4), null);
  assert.equal(director.update('03', {}, 6.7)?.id, 'a');
});

test('a room line rests for a while before it speaks again, and a reset frees it', () => {
  const director = createVoiceDirector([roomLine('a', '03')], { dwell: 1.5, repeatAfter: 60 });
  assert.deepEqual(stay(director, '03', 0, 2), ['a']);
  stay(director, '02', 2.1, 20);
  assert.deepEqual(stay(director, '03', 20.1, 40), [], 'back within a minute');
  stay(director, '02', 40.1, 60);
  assert.deepEqual(stay(director, '03', 60.1, 64), ['a'], 'back after a minute');
  director.reset();
  stay(director, '02', 64.1, 65);
  assert.deepEqual(stay(director, '03', 65.1, 68), ['a'], 'after a reset');
});

test('room lines follow the room phase and their first circuit', () => {
  const director = createVoiceDirector([
    roomLine('normal', '06', { phase: 'normal' }), roomLine('dream', '06', { phase: 'dream' }), roomLine('late', '05', { minLap: 3 }),
  ], { repeatAfter: 0 });
  assert.deepEqual(stay(director, '06', 0, 3, { lap: 1, phase: 'normal' }), ['normal']);
  assert.deepEqual(stay(director, '06', 20, 23, { lap: 2, phase: 'dream' }), ['dream']);
  assert.deepEqual(stay(director, '05', 40, 45, { lap: 2, phase: 'dream' }), [], 'minLap not reached');
  assert.deepEqual(stay(director, '05', 60, 63, { lap: 3, phase: 'normal' }), ['late']);
});

test('a room speaks once a visit, and its lines take turns', () => {
  const director = createVoiceDirector([roomLine('x', '02'), roomLine('y', '02')], { repeatAfter: 60 });
  assert.deepEqual(stay(director, '02', 0, 25), ['x'], 'one line, however long the visitor stays');
  assert.deepEqual(stay(director, '02', 30, 35), ['y'], 'next visit, the other line');
  assert.deepEqual(stay(director, '02', 40, 45), [], 'both heard within a minute');
  assert.deepEqual(stay(director, '02', 100, 105), ['x'], 'the one heard longest ago');
});

test('a line can wait for the visitor to linger', () => {
  const director = createVoiceDirector([roomLine('slow', '01', { after: 12 })]);
  assert.deepEqual(stay(director, '01', 0, 11.5), [], 'passing through');
  const heard = stay(director, '01', 20, 33);
  assert.deepEqual(heard, ['slow']);
  assert.ok(Math.abs(director.inspect().heard.slow - 32) < 0.15, 'after twelve seconds in the room');
});

test('lines never overlap; one held back by the silence speaks if the visitor stays', () => {
  const director = createVoiceDirector([roomLine('a', '02'), roomLine('b', '03'), roomLine('c', '05')], { gap: 6, dwell: 1.5 });
  assert.deepEqual(stay(director, '02', 10, 12), ['a']);
  // a ends near 14.6 and the silence near 20.6: c's room is crossed too quickly to be heard.
  assert.deepEqual(stay(director, '05', 12.1, 16), []);
  assert.deepEqual(stay(director, '03', 16.1, 25), ['b']);
  assert.ok(director.inspect().heard.b >= 20.6, 'b waited for the silence');
});

test('a completed circuit is answered after the dip, latest line first, once lines once a visit', () => {
  const director = createVoiceDirector([circuit('before', 2), circuit('notme', 3, { once: true })], { lapDelay: 1.8 });
  director.lapChanged(2, 'dream', 100);
  assert.equal(director.update('01', { lap: 2 }, 101), null, 'the drone dips first');
  assert.equal(director.update('01', { lap: 2 }, 101.9)?.id, 'before');
  director.lapChanged(3, 'normal', 200);
  assert.equal(director.update('01', { lap: 3 }, 202)?.id, 'notme');
  director.lapChanged(4, 'dream', 300);
  assert.equal(director.update('01', { lap: 4 }, 302)?.id, 'before', 'notme does not repeat');
  director.reset();
  director.lapChanged(3, 'normal', 400);
  assert.equal(director.update('01', { lap: 3 }, 402)?.id, 'before', 'not even after a reset');
});

test('a circuit line waits for a line in progress, goes before room lines and lapses when missed', () => {
  const director = createVoiceDirector([roomLine('a', '02'), roomLine('b', '03'), circuit('before', 2)], { gap: 6, lapDelay: 1.8, lapExpiry: 10 });
  director.update('02', { lap: 1 }, 8);
  assert.equal(director.update('02', { lap: 1 }, 10)?.id, 'a');
  director.lapChanged(2, 'dream', 10.5);
  assert.equal(director.update('03', { lap: 2 }, 12.5), null, 'a is still speaking');
  assert.equal(director.update('03', { lap: 2 }, 14.1)?.id, 'before', 'a second after a ends, ahead of the room line');
  assert.equal(director.update('03', { lap: 2 }, 23.2)?.id, 'b');
  director.lapChanged(3, 'normal', 30);
  assert.equal(director.update('03', { lap: 3 }, 45), null, 'the visitor was away');
  assert.equal(director.inspect().pending, null);
});

test('every shipped line has both subtitles, a clip and a room that exists', () => {
  const simulation = createSimulation(spatial), ids = new Set();
  assert.ok(manifest.lines.length >= 5);
  for (const line of manifest.lines) {
    assert.ok(!ids.has(line.id), `${line.id} is unique`);
    ids.add(line.id);
    assert.ok(line.en && line.zh && line.source, `${line.id} has English, Chinese and a source`);
    assert.ok(existsSync(new URL(`../dist/assets/${line.file}`, import.meta.url)), `${line.id} clip exists`);
    assert.ok(line.duration > 1 && line.duration < 12, `${line.id} duration`);
    if (line.trigger.type === 'room') {
      assert.ok(['01', '02', '03', '04', '05', '06'].includes(line.trigger.room), `${line.id} has a room`);
      if (!line.trigger.from) continue;
      assert.equal(roomAt(...line.trigger.from)[0], line.trigger.room, `${line.id} is heard from inside its room`);
      assert.ok(simulation.isValidPosition(...line.trigger.from) || spatial.obstacles.some(o => Math.hypot(o.center[0] - line.trigger.from[0], o.center[1] - line.trigger.from[1]) < 0.05),
        `${line.id} is heard from the floor or from a prop`);
    } else assert.equal(line.trigger.type, 'lap');
  }
});

// Walks a path at 1.25 m/s, listening at about 10 Hz.
function walk(director, path, lap, phase, clock) {
  const heard = [];
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i], length = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(length / 0.125));
    for (let step = 1; step <= steps; step++) {
      clock.now += length / steps / 1.25;
      const line = director.update(roomAt(ax + (bx - ax) * step / steps, az + (bz - az) * step / steps)[0], { lap, phase }, clock.now);
      if (line) heard.push(line.id);
    }
  }
  return heard;
}

test('walking the circuit, the rooms speak, answer the lap and change their words', () => {
  const director = createVoiceDirector(manifest.lines), clock = { now: 0 }, laps = [];
  for (let lap = 1; lap <= 4; lap++) {
    const phase = lap % 2 ? 'normal' : 'dream';
    if (lap > 1) director.lapChanged(lap, phase, clock.now);
    laps.push(walk(director, spatial.route, lap, phase, clock));
  }
  assert.deepEqual(laps[0], ['cousin', 'waiting', 'birds', 'twentyfive']);
  assert.deepEqual(laps[1], ['before', 'gone', 'empty', 'longer', 'fire', 'remembers'], 'the dream circuit has its own words');
  assert.deepEqual(laps[2], ['notme', 'gum', 'waiting', 'coffee', 'twentyfive'], 'lines take turns from one circuit to the next');
  assert.deepEqual(laps[3].slice(0, 1), ['again']);
  assert.ok(new Set(laps.flat()).size >= 14, 'four circuits hear almost every line');
});

test('a visitor who only steps inside a room and turns back still hears it', () => {
  // Both doorways of the empty-table room and of the mirror waiting room are on
  // one side: this walker never goes more than about a metre into either.
  const shallow = spatial.route.map(([x, z]) => [Math.max(x, -20.5), z > 16.9 ? Math.min(z, 17.9) : z]);
  const director = createVoiceDirector(manifest.lines);
  assert.deepEqual(walk(director, shallow, 1, 'normal', { now: 0 }), ['cousin', 'waiting', 'birds', 'twentyfive']);
});
