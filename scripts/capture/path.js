// Camera moves for a recording (capture.mjs): keys in, the camera at any
// moment out. A key is { t, at: [x, z], y, yaw, pitch, look: [x, y, z], zoom,
// fov43, matte }, seconds and metres; anything a key leaves out stays as the
// key before had it. `look` points the camera at a spot (its yaw and pitch are
// worked out there), `y` is the eye height and `zoom` narrows the lens (1 is
// the format's own). `fov43` frames a 4:3 picture with that vertical angle in
// the middle of whatever the format is, as the 1990–91 broadcast was framed;
// `matte` (0–1) closes the frame down to that 4:3 picture; `haze` (0–1, 1 at
// first) is how much of the lens's haze is on the picture (lens.js).
// Each value moves on a monotone cubic through its keys: it starts and ends at
// rest, never overshoots a key, and passes interior keys smoothly, so a value
// held over two keys stays still between them; an optional drift adds a hand.
// Yaw takes the shorter way round and follows three.js: 0 looks toward -z,
// turning left is positive. Pure.

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// A monotone cubic Hermite through (ts, vs), at rest at both ends.
function curve(ts, vs) {
  const n = ts.length;
  if (n === 1) return () => vs[0];
  const h = [], slope = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(ts[i + 1] - ts[i]); slope.push((vs[i + 1] - vs[i]) / h[i]); }
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) continue;
    // Fritsch–Butland: a weighted harmonic mean keeps the curve monotone.
    const a = 2 * h[i] + h[i - 1], b = h[i] + 2 * h[i - 1];
    m[i] = (a + b) / (a / slope[i - 1] + b / slope[i]);
  }
  return t => {
    if (t <= ts[0]) return vs[0];
    if (t >= ts[n - 1]) return vs[n - 1];
    let i = 0;
    while (t > ts[i + 1]) i++;
    const u = (t - ts[i]) / h[i], u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * h[i] * m[i] + (3 * u2 - 2 * u3) * vs[i + 1] + (u3 - u2) * h[i] * m[i + 1];
  };
}

// The zoom that shows a 4:3 picture of vertical angle `fov43` (degrees) in the
// middle of a frame `aspect` wide to 1 high whose own lens is `fov`: across
// the whole width of a taller frame, the whole height of a wider one.
export function zoom43(fov43, { fov = 60, aspect = 4 / 3 } = {}) {
  const share = Math.min(1, aspect * 3 / 4), half = angle => Math.tan(angle * Math.PI / 360);
  return half(fov) * share / half(fov43);
}

// Every key with all its values, yaw unwrapped from the key before.
export function resolveKeys(keys, { eye = 1.65, fov = 60, aspect = 4 / 3 } = {}) {
  if (!keys?.length) throw new Error('A shot needs at least one camera key.');
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  if (!sorted[0].at) throw new Error('The first key of a shot needs a place: at [x, z].');
  const resolved = [];
  let previous = { x: 0, z: 0, y: eye, yaw: 0, pitch: 0, zoom: 1, matte: 0, haze: 1 };
  for (const key of sorted) {
    const k = {
      t: key.t, x: key.at?.[0] ?? previous.x, z: key.at?.[1] ?? previous.z, y: key.y ?? previous.y,
      yaw: previous.yaw, pitch: previous.pitch,
      zoom: key.fov43 !== undefined ? zoom43(key.fov43, { fov, aspect }) : key.zoom ?? previous.zoom,
      matte: key.matte ?? previous.matte, haze: key.haze ?? previous.haze,
    };
    if (key.look) {
      const [lx, ly, lz] = key.look;
      k.yaw = Math.atan2(k.x - lx, k.z - lz);
      k.pitch = Math.atan2(ly - k.y, Math.hypot(lx - k.x, lz - k.z));
    }
    if (key.yaw !== undefined) k.yaw = key.yaw;
    if (key.pitch !== undefined) k.pitch = key.pitch;
    if (resolved.length) k.yaw = previous.yaw + wrap(k.yaw - previous.yaw);
    resolved.push(k);
    previous = k;
  }
  return resolved;
}

// A slow, uneven wander between -1 and 1: three sines at unrelated rates with
// phases from the seed (mulberry32).
function wander(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const parts = [[1, 0.55], [1.73, 0.3], [2.89, 0.15]].map(([rate, weight]) => [rate, weight, random() * Math.PI * 2]);
  return (t, rate) => parts.reduce((sum, [r, weight, phase]) => sum + weight * Math.sin(2 * Math.PI * rate * r * t + phase), 0);
}

// The camera at shot time t: { x, z, y, yaw, pitch, fov, matte, haze } (fov in
// degrees, vertical, from the format's `fov` and the zoom; `aspect` is the
// format's width to height). `drift` lets a hand show on it, as an operator
// breathing on a fluid head: { turn (degrees), sway and lift (metres), rate
// (Hz), seed }.
export function cameraPath(keys, { eye = 1.65, fov = 60, aspect = 4 / 3, drift = null } = {}) {
  const resolved = resolveKeys(keys, { eye, fov, aspect }), ts = resolved.map(k => k.t);
  const channels = Object.fromEntries(['x', 'z', 'y', 'yaw', 'pitch', 'zoom', 'matte', 'haze'].map(name => [name, curve(ts, resolved.map(k => k[name]))]));
  const half = Math.tan(fov * Math.PI / 360);
  const { turn = 0, sway = 0, lift = 0, rate = 0.3, seed = 1 } = drift ?? {};
  const hand = [0, 1, 2, 3, 4].map(i => wander(seed * 5 + i));
  return t => {
    const zoom = Math.max(0.05, channels.zoom(t)), degrees = Math.PI / 180;
    return {
      x: channels.x(t) + sway * hand[0](t, rate), z: channels.z(t) + sway * hand[1](t, rate), y: channels.y(t) + lift * hand[2](t, rate),
      yaw: channels.yaw(t) + turn * degrees * hand[3](t, rate), pitch: channels.pitch(t) + turn * 0.6 * degrees * hand[4](t, rate),
      fov: Math.atan(half / zoom) * 360 / Math.PI,
      matte: Math.min(1, Math.max(0, channels.matte(t))), haze: Math.min(1, Math.max(0, channels.haze(t))),
    };
  };
}
