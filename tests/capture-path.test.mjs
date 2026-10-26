import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraPath, resolveKeys, zoom43 } from '../scripts/capture/path.js';

const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;
const deg = Math.PI / 180;

test('one key holds the camera there, at eye height, with the format’s lens', () => {
  const pose = cameraPath([{ t: 0, at: [1, 2], yaw: 0.5, pitch: -0.1 }], { fov: 60 });
  for (const t of [-1, 0, 3]) {
    const { fov, ...place } = pose(t);
    assert.deepEqual(place, { x: 1, z: 2, y: 1.65, yaw: 0.5, pitch: -0.1, matte: 0, haze: 1 });
    assert.ok(close(fov, 60, 1e-9));
  }
});

test('the path passes through every key, at rest at the first and the last', () => {
  const keys = [{ t: 0, at: [0, 0] }, { t: 2, at: [2, 1] }, { t: 3, at: [5, 1] }, { t: 5, at: [6, 0] }];
  const pose = cameraPath(keys);
  for (const key of keys) assert.ok(close(pose(key.t).x, key.at[0]) && close(pose(key.t).z, key.at[1]), `at ${key.t}`);
  const speed = t => Math.hypot(pose(t + 1e-4).x - pose(t).x, pose(t + 1e-4).z - pose(t).z) / 1e-4;
  assert.ok(speed(0) < 1e-3 && speed(5 - 1e-4) < 1e-3, 'starts and ends still');
  assert.ok(speed(2) > 0.5, 'moves on through an interior key');
});

test('a value held over two keys stays still between them, and nothing overshoots', () => {
  const pose = cameraPath([{ t: 0, at: [0, 0] }, { t: 1, at: [3, 0] }, { t: 2, at: [3, 0] }, { t: 3, at: [1, 0] }]);
  for (let t = 1; t <= 2; t += 0.05) assert.ok(close(pose(t).x, 3), `held at ${t.toFixed(2)}`);
  for (let t = 0; t <= 3; t += 0.01) assert.ok(pose(t).x <= 3 + 1e-9 && pose(t).x >= -1e-9, `inside the keys at ${t.toFixed(2)}`);
});

test('look points the camera as three.js does: yaw 0 toward -z, turning left is positive', () => {
  const [ahead] = resolveKeys([{ t: 0, at: [0, 0], look: [0, 1.65, -5] }]);
  assert.ok(close(ahead.yaw, 0) && close(ahead.pitch, 0));
  const [left] = resolveKeys([{ t: 0, at: [0, 0], look: [-5, 1.65, 0] }]);
  assert.ok(close(left.yaw, 90 * deg), `${left.yaw}`);
  const [down] = resolveKeys([{ t: 0, at: [0, 0], look: [0, 0.65, -1] }]);
  assert.ok(close(down.pitch, -45 * deg));
  // The camera's own forward, (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch), reaches the spot.
  const [any] = resolveKeys([{ t: 0, at: [2, -1], y: 1.4, look: [-3, 0.9, 4] }]);
  const along = Math.hypot(-5, 5, -0.5);
  assert.ok(close(-Math.sin(any.yaw) * Math.cos(any.pitch), -5 / along) && close(Math.sin(any.pitch), -0.5 / along) && close(-Math.cos(any.yaw) * Math.cos(any.pitch), 5 / along));
});

test('yaw takes the shorter way round', () => {
  const pose = cameraPath([{ t: 0, at: [0, 0], yaw: 170 * deg }, { t: 1, yaw: -170 * deg }]);
  assert.ok(close(pose(0.5).yaw, 180 * deg), `${pose(0.5).yaw / deg}°`);
  assert.ok(close(pose(1).yaw, 190 * deg));
});

test('a drift adds a small, slow, repeatable hand to the camera', () => {
  const keys = [{ t: 0, at: [0, 0], yaw: 0, pitch: 0 }, { t: 10, at: [4, 0], yaw: 1 }];
  const still = cameraPath(keys), drift = { turn: 0.4, sway: 0.01, lift: 0.005, rate: 0.3, seed: 7 };
  const hand = cameraPath(keys, { drift }), again = cameraPath(keys, { drift }), other = cameraPath(keys, { drift: { ...drift, seed: 8 } });
  let moved = 0, previous = null;
  for (let t = 0; t <= 10; t += 0.05) {
    const base = still(t), pose = hand(t);
    assert.ok(Math.abs(pose.yaw - base.yaw) <= 0.4 * deg + 1e-9 && Math.abs(pose.pitch - base.pitch) <= 0.24 * deg + 1e-9, `turn within bounds at ${t.toFixed(2)}`);
    assert.ok(Math.hypot(pose.x - base.x, pose.z - base.z) <= Math.SQRT2 * 0.01 + 1e-9 && Math.abs(pose.y - base.y) <= 0.005 + 1e-9);
    assert.deepEqual(pose, again(t), 'the same seed, the same hand');
    moved = Math.max(moved, Math.abs(pose.yaw - base.yaw));
    // At 0.3 Hz the hand turns at most about 1.1°/s: well under 0.1° a frame.
    if (previous !== null) assert.ok(Math.abs((pose.yaw - base.yaw) - previous) < 0.08 * deg, 'slow: no jumps between frames');
    previous = pose.yaw - base.yaw;
  }
  assert.ok(moved > 0.15 * deg, 'it does move');
  assert.notEqual(other(3).yaw, hand(3).yaw, 'another seed, another hand');
});

test('values left out stay as they were; zoom narrows the lens', () => {
  const keys = resolveKeys([{ t: 0, at: [1, 2], y: 1.2, yaw: 0.3, zoom: 2 }, { t: 1, pitch: -0.2 }]);
  assert.deepEqual(keys[1], { t: 1, x: 1, z: 2, y: 1.2, yaw: 0.3, pitch: -0.2, zoom: 2, matte: 0, haze: 1 });
  const pose = cameraPath([{ t: 0, at: [0, 0], zoom: 2 }], { fov: 60 });
  assert.ok(close(Math.tan(pose(0).fov / 2 * deg), Math.tan(30 * deg) / 2));
  assert.throws(() => resolveKeys([{ t: 0, yaw: 1 }]), /needs a place/);
  assert.throws(() => resolveKeys([]), /at least one/);
});

test('a 4:3 picture keeps its framing in the middle of any format', () => {
  const half = angle => Math.tan(angle * Math.PI / 360);
  // In a tall frame the picture is the whole width, three quarters of it high.
  const tall = cameraPath([{ t: 0, at: [0, 0], fov43: 54.45 }], { fov: 72, aspect: 9 / 16 })(0);
  assert.ok(close(half(tall.fov) * (9 / 16) * (3 / 4), half(54.45)), `${tall.fov.toFixed(2)}° for the 9:16 frame`);
  // In a wide frame it is the whole height.
  const wide = cameraPath([{ t: 0, at: [0, 0], fov43: 54.45 }], { fov: 50, aspect: 16 / 9 })(0);
  assert.ok(close(wide.fov, 54.45));
  assert.ok(close(zoom43(54.45, { fov: 54.45, aspect: 4 / 3 }), 1), 'a 4:3 frame is the picture itself');
});

test('the matte opens and the haze comes in, like any other value', () => {
  const pose = cameraPath([{ t: 0, at: [0, 0], matte: 1, haze: 0 }, { t: 6, matte: 1, haze: 0 }, { t: 10, matte: 0, haze: 1 }]);
  assert.deepEqual([pose(0).matte, pose(0).haze], [1, 0]);
  assert.deepEqual([pose(5.9).matte, pose(5.9).haze], [1, 0], 'held until the frame opens');
  assert.ok(pose(8).matte > 0 && pose(8).matte < 1 && pose(8).haze > 0 && pose(8).haze < 1);
  assert.deepEqual([pose(12).matte, pose(12).haze], [0, 1]);
});
