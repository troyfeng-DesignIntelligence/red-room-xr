import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Load the browser ES modules directly, as the spatial tests do.
const load = async file => import(`data:text/javascript;base64,${readFileSync(new URL(file, import.meta.url)).toString('base64')}`);
const { planWalk, createCurtainWalker } = await load('../dist/js/curtain-walker.js');

const seeded = seed => () => {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// A straight curtain from (x1, z1) to (x2, z2), sampled every half metre.
const line = (id, [x1, z1], [x2, z2]) => {
  const n = Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 0.5);
  return { id, path: Array.from({ length: n + 1 }, (_, i) => [x1 + (x2 - x1) * i / n, z1 + (z2 - z1) * i / n]) };
};
const wall = line(1, [-10, 0], [10, 0]);

test('the walk is behind the cloth, a few metres long, past the visitor', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const plan = planWalk([wall], [0, 3], { random: seeded(seed) });
    assert.equal(plan.panelId, 1);
    assert.ok(plan.length >= 4 - 1e-9 && plan.length <= 6.5, `${plan.length} m`);
    assert.ok(plan.points.every(([, z]) => Math.abs(z + 0.22) < 1e-9), 'on the far side, 22 cm behind the line');
    for (let i = 1; i < plan.points.length; i++) assert.ok(Math.hypot(plan.points[i][0] - plan.points[i - 1][0], plan.points[i][1] - plan.points[i - 1][1]) < 0.0501);
    const xs = plan.points.map(([x]) => x);
    assert.ok(Math.min(...xs) <= 0 && Math.max(...xs) >= 0, 'past the point nearest the visitor');
  }
  const beyond = planWalk([wall], [0, -3], { random: seeded(3) });
  assert.ok(beyond.points.every(([, z]) => Math.abs(z - 0.22) < 1e-9), 'from the other side, behind it is the other way');
});

test('no walk when the curtain is too near, too far or too short', () => {
  assert.equal(planWalk([wall], [0, 1]), null, '1 m away');
  assert.equal(planWalk([wall], [0, 6]), null, '6 m away');
  assert.equal(planWalk([line(2, [-1.5, 0], [1.5, 0])], [0, 3]), null, 'a 3 m curtain');
});

test('a curtain hanging behind another is never walked; one in front is preferred', () => {
  const behind = line(2, [-10, -1], [10, -1]);
  for (let seed = 1; seed <= 40; seed++) assert.equal(planWalk([behind, wall], [0, 3], { random: seeded(seed) }).panelId, 1);
  const ahead = line(3, [-10, -3], [10, -3]), back = line(4, [-10, 3], [10, 3]);
  let inFront = 0;
  for (let seed = 1; seed <= 200; seed++) if (planWalk([ahead, back], [0, 0], { forward: [0, -1], random: seeded(seed) }).panelId === 3) inFront++;
  assert.ok(inFront > 140, `${inFront} of 200 in front`);
});

test('a recording can ask for the walk near a spot', () => {
  const other = line(2, [-10, 6], [10, 6]);
  for (let seed = 1; seed <= 20; seed++) {
    const plan = planWalk([wall, other], [0, 3], { random: seeded(seed), prefer: [4, 6.5] });
    assert.equal(plan.panelId, 2);
    const xs = plan.points.map(([x]) => x), middle = (Math.min(...xs) + Math.max(...xs)) / 2;
    // Points every 5 cm: the last may fall just short of the end.
    assert.ok(Math.abs(middle - 4) < 0.03, `centred on the spot (${middle.toFixed(3)})`);
  }
  const walker = createCurtainWalker({ random: seeded(5) });
  assert.ok(walker.start(0, [wall, other], [0, 3], [0, -1], { prefer: [-3, 0] }));
  assert.equal(walker.inspect().panelId, 1);
});

test('it comes on ordinary circuits, now and then: the first time once the visitor has settled', () => {
  const walker = createCurtainWalker({ random: seeded(7) });
  const run = (from, to, options) => {
    const walks = [];
    for (let now = from; now < to; now += 1 / 60) {
      const { walker: at, steps } = walker.update(now, { ready: true, panels: [wall], visitor: [0, 3], ...options });
      if (at && (!walks.length || walks.at(-1).end < now - 0.1)) walks.push({ start: now, end: now, amounts: [], steps: [] });
      if (at) { walks.at(-1).end = now; walks.at(-1).amounts.push(at.amount); }
      for (const step of steps) walks.at(-1).steps.push({ now, step });
    }
    return walks;
  };
  const first = run(0, 200, { lap: 1, phase: 'normal' });
  assert.ok(first[0].start >= 35 && first[0].start <= 60.1, `on the first circuit after ${first[0].start.toFixed(1)} s`);
  walker.reset();
  assert.deepEqual(run(200, 400, { lap: 2, phase: 'dream' }), [], 'not on dream circuits: someone follows instead');
  const walks = run(400, 800, { lap: 3, phase: 'normal' });
  assert.ok(walks.length >= 4 && walks.length <= 10, `${walks.length} walks in 400 s`);
  assert.ok(walks[0].start - 400 >= 12 && walks[0].start - 400 <= 30.1, `later circuits after ${(walks[0].start - 400).toFixed(1)} s`);
  for (let i = 1; i < walks.length; i++) {
    const gap = walks[i].start - walks[i - 1].end;
    assert.ok(gap >= 39.9 && gap <= 75.2, `${gap.toFixed(1)} s between walks`);
  }
  for (const walk of [...first, ...walks]) {
    const seconds = walk.end - walk.start;
    assert.ok(seconds >= 3.5 && seconds <= 6, `${seconds.toFixed(2)} s at a slow walk`);
    assert.ok(walk.amounts[0] < 0.05 && walk.amounts.at(-1) < 0.05 && Math.max(...walk.amounts) > 0.95, 'out of the dark and back');
    assert.ok(walk.steps.length >= 5, 'steps all the way');
    for (let i = 1; i < walk.steps.length; i++) {
      const interval = walk.steps[i].now - walk.steps[i - 1].now;
      assert.ok(interval > 0.56 && interval < 0.64, `${interval.toFixed(3)} s between steps`);
    }
    assert.ok(walk.steps.every(({ step: [, z] }) => Math.abs(z + 0.22) < 1e-6), 'every step behind the cloth');
  }
});

test('never while the visitor is not ready; a walk once begun goes on; a reset ends it', () => {
  const walker = createCurtainWalker({ random: seeded(9), wait: [1, 1] });
  const at = (now, ready) => walker.update(now, { lap: 3, ready, panels: [wall], visitor: [0, 3] }).walker;
  for (let now = 0; now < 30; now += 0.1) assert.equal(at(now, false), null);
  assert.ok(at(30, true), 'begins once ready');
  assert.ok(at(31, false), 'and goes on regardless');
  walker.reset();
  assert.equal(walker.inspect().walking, false);
  assert.equal(at(31.1, false), null);
  assert.ok(walker.start(40, [wall], [0, 3], [0, -1]) && at(40.5, false), 'started by hand on any circuit');
});

test('on the real floor plan, from wherever the visitor stands, it is always behind cloth', () => {
  const spatial = JSON.parse(readFileSync(new URL('../dist/assets/spatial.json', import.meta.url), 'utf8'));
  const { panels } = JSON.parse(readFileSync(new URL('./curtain-panels.json', import.meta.url), 'utf8'));
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const crosses = (a, b, c, d) => side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
  let planned = 0, places = 0;
  for (let i = 0; i < spatial.route.length; i += 15) {
    const visitor = spatial.route[i];
    places++;
    const plan = planWalk(panels, visitor, { random: seeded(i + 1) });
    if (!plan) continue;
    planned++;
    for (const point of plan.points) {
      assert.ok(Math.hypot(point[0] - visitor[0], point[1] - visitor[1]) >= 1.4, `close to ${visitor}`);
      const veiled = panels.some(panel => panel.path.some((q, k) => k > 0 && crosses(visitor, point, panel.path[k - 1], q)));
      assert.ok(veiled, `walker at ${point.map(v => v.toFixed(2))} is in plain sight from ${visitor}`);
    }
  }
  assert.ok(planned / places > 0.6, `a walk from ${planned} of ${places} places on the route`);
});
