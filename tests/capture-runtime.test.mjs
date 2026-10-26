import test from 'node:test';
import assert from 'node:assert/strict';
import { installCapture } from '../scripts/capture/runtime.js';

// A page's globals, enough for the runtime: a real clock that the test moves
// by hand, real timers that only record what was asked of them, and an
// offline audio context that records where it was told to stop.
function page({ offline = false } = {}) {
  const real = { now: 1000, timers: [], frames: [] };
  const animations = [];
  const win = {
    performance: { now: () => real.now },
    Date: { now: () => 1.7e12 + real.now },
    setTimeout: (fn, delay) => real.timers.push({ fn, delay }),
    setInterval: (fn, delay) => real.timers.push({ fn, delay, repeat: true }),
    clearTimeout: () => {},
    requestAnimationFrame: fn => real.frames.push(fn),
    cancelAnimationFrame: () => {},
    Math: {},
    document: { getAnimations: () => animations },
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
  };
  if (offline) {
    win.OfflineAudioContext = class {
      constructor(options) { Object.assign(this, { options, length: options.length, sampleRate: options.sampleRate, stops: [], resumes: 0, state: 'suspended', sources: [], currentTime: 0 }); }
      createGain() { return { gain: {}, connect() {} }; }
      createBufferSource() {
        const source = { playbackRate: { value: 1, setValueAtTime(value, time) { Object.assign(this, { value, at: time }); } }, connect() {}, start(...when) { this.started = when; } };
        this.sources.push(source);
        return source;
      }
      decodeAudioData() { return Promise.resolve({ duration: 300 }); }
      resume() { this.resumes++; return Promise.resolve(); }
      suspend(time) { this.stops.push(time); return Promise.resolve(); }
      startRendering() { this.started = true; return new Promise(() => {}); }
    };
    win.fetch = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  }
  return { win, real, animations };
}

test('until a take begins the page keeps real time and real timers', () => {
  const { win, real } = page();
  installCapture(win, {});
  win.setTimeout(() => {}, 50);
  win.requestAnimationFrame(() => {});
  assert.equal(real.timers.length, 1);
  assert.equal(real.frames.length, 1);
  real.now = 1234;
  assert.equal(win.performance.now(), 1234);
});

test('then the clock stands still between frames and moves only when stepped', async () => {
  const { win, real } = page();
  installCapture(win, {});
  const start = win.__capture.begin(250);
  assert.equal(start, 1250, 'a little ahead of real time');
  real.now = 99999;
  assert.equal(win.performance.now(), 1250);
  const date = win.Date.now();
  await win.__capture.advance(1250 + 1000 / 60);
  assert.ok(Math.abs(win.performance.now() - (1250 + 1000 / 60)) < 1e-9);
  assert.equal(win.Date.now() - date, 16);
  await assert.rejects(win.__capture.advance(1000), /cannot go/);
});

test('the take can start on the film’s frame grid', () => {
  const { win } = page();
  installCapture(win, {});
  const start = win.__capture.begin(250, 1000 / 24);
  const frames = start / (1000 / 24);
  assert.ok(start >= 1250 && frames - Math.floor(frames) > 0 && frames - Math.floor(frames) < 0.01, `${start} ms, frame ${frames}`);
});

test('timers fire in order, each at its own time, including those set by others', async () => {
  const { win, real } = page();
  installCapture(win, {});
  const t0 = win.__capture.begin(0), fired = [];
  win.setTimeout(() => fired.push(['b', win.performance.now() - t0]), 30);
  win.setTimeout(() => {
    fired.push(['a', win.performance.now() - t0]);
    win.setTimeout(() => fired.push(['c', win.performance.now() - t0]), 5);
  }, 10);
  const gone = win.setTimeout(() => fired.push(['never']), 20);
  win.clearTimeout(gone);
  await win.__capture.advance(t0 + 16);
  assert.deepEqual(fired, [['a', 10], ['c', 15]]);
  await win.__capture.advance(t0 + 40);
  assert.deepEqual(fired, [['a', 10], ['c', 15], ['b', 30]]);
  assert.equal(real.timers.length, 0, 'no real timer was used');
});

test('intervals repeat until cleared', async () => {
  const { win } = page();
  installCapture(win, {});
  const t0 = win.__capture.begin(0), ticks = [];
  const id = win.setInterval(() => ticks.push(win.performance.now() - t0), 100);
  await win.__capture.advance(t0 + 350);
  win.clearInterval(id);
  await win.__capture.advance(t0 + 1000);
  assert.deepEqual(ticks, [100, 200, 300]);
});

test('a frame runs the callbacks waiting for it with the clock’s time; asking again waits for the next', async () => {
  const { win, real } = page();
  installCapture(win, {});
  const t0 = win.__capture.begin(0), seen = [];
  const loop = time => { seen.push(time - t0); win.requestAnimationFrame(loop); };
  win.requestAnimationFrame(loop);
  await win.__capture.advance(t0 + 20);
  win.__capture.paint();
  await win.__capture.advance(t0 + 40);
  win.__capture.paint();
  assert.deepEqual(seen, [20, 40]);
  assert.equal(real.frames.length, 0);
});

test('CSS transitions are held and moved with the clock', async () => {
  const { win, animations } = page();
  installCapture(win, {});
  const t0 = win.__capture.begin(0);
  const fade = { paused: false, currentTime: 0, pause() { this.paused = true; } };
  await win.__capture.advance(t0 + 100);
  animations.push(fade);
  win.__capture.paint();
  assert.equal(fade.paused, true);
  assert.equal(fade.currentTime, 0);
  await win.__capture.advance(t0 + 350);
  win.__capture.paint();
  assert.equal(fade.currentTime, 250);
});

test('chance is seeded: the same take makes the same choices', () => {
  const draws = () => {
    const { win } = page();
    installCapture(win, { seed: 42 });
    const first = [win.Math.random(), win.Math.random()];
    win.__capture.seed(42);
    return [...first, win.Math.random()];
  };
  const [a, b, again] = draws();
  assert.deepEqual(draws(), [a, b, again]);
  assert.notEqual(a, b);
  assert.equal(again, a, 'seeding again starts over');
  assert.ok(a >= 0 && a < 1);
});

test('the sound is rendered offline in step with the frames', async () => {
  const { win } = page({ offline: true });
  installCapture(win, { sampleRate: 48000, seconds: 10 });
  const context = new win.AudioContext({ latencyHint: 'interactive' });
  assert.ok(context instanceof win.OfflineAudioContext);
  assert.equal(context.length, 480000);
  await context.resume();
  assert.equal(context.resumes, 0, 'the page’s own resume changes nothing');
  const t0 = win.__capture.begin(0);
  await win.__capture.advance(t0 + 1000 / 60);
  assert.equal(context.started, true);
  // 800 samples, to the nearest 128-sample block.
  assert.deepEqual(context.stops, [768 / 48000]);
  await win.__capture.advance(t0 + 50);
  assert.deepEqual(context.stops, [768 / 48000, 2432 / 48000]);
  assert.equal(context.resumes, 1);
  await win.__capture.advance(t0 + 51);
  assert.equal(context.stops.length, 2, 'less than a block: nothing to render');
});

test('the record plays offline from its decoded file, where the take asks, at the page’s speed', async () => {
  const settle = () => new Promise(done => setTimeout(done, 0));
  const { win } = page({ offline: true });
  installCapture(win, { music: { from: 20, at: 3 } });
  const context = new win.AudioContext();
  const element = { src: './assets/music/falling.mp3', playbackRate: 1, currentTime: 41, muted: false };
  assert.ok(context.createMediaElementSource(element));
  assert.equal(element.muted, true, 'the element itself stays silent');
  await settle(); await settle(); await settle();
  const [source] = context.sources;
  assert.deepEqual(source.started, [0, 17], 'twenty seconds into the song three seconds into the take');
  assert.deepEqual(win.__capture.inspect().media, { state: 'playing', seconds: 300 });
  context.currentTime = 9;
  element.playbackRate = 0.88;
  assert.equal(element.playbackRate, 0.88);
  assert.deepEqual([source.playbackRate.value, source.playbackRate.at], [0.88, 9], 'slowed when the page slows it');

  const late = page({ offline: true });
  installCapture(late.win, { music: { from: 0, at: 3 } });
  const later = new late.win.AudioContext();
  later.createMediaElementSource({ src: 'x', playbackRate: 1, currentTime: 0 });
  await settle(); await settle(); await settle();
  assert.deepEqual(later.sources[0].started, [3, 0], 'from its first bar when the first shot begins');

  const loose = page({ offline: true });
  installCapture(loose.win, {});
  const room = new loose.win.AudioContext();
  room.createMediaElementSource({ src: 'x', playbackRate: 1, currentTime: 41 });
  await settle(); await settle(); await settle();
  assert.deepEqual(room.sources[0].started, [0, 41], 'without a cue, wherever the page put it');
});
