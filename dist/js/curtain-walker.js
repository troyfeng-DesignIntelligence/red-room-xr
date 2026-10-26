// Someone walks behind a curtain. On ordinary circuits, now and then: the
// figure of someone pressed against the velvet, head and shoulders, moves along
// it at a slow walk for a few metres, in time with muffled steps, then fades as
// if it had walked on into the dark. It walks behind a curtain line between
// 1.4 and 5.5 m from the visitor, on the far side from them, past the point
// nearest them, and prefers one in front of them. Pure: curtain lines and times
// in, positions out; metres and seconds, points on the floor as [x, z].

const PACE = 1.1;     // metres a second
const STEP = 0.6;     // seconds between footfalls at that pace
const OFFSET = 0.22;  // how far behind the cloth line the body walks
const HEIGHT = 1.1;   // the middle of the body
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = value => value * value * (3 - 2 * value);

// The point `s` metres along a polyline, with that segment's unit normal.
function along(path, arcs, s) {
  let i = 1;
  while (i < path.length - 1 && arcs[i] < s) i++;
  const [ax, az] = path[i - 1], [bx, bz] = path[i], length = arcs[i] - arcs[i - 1] || 1;
  const t = clamp((s - arcs[i - 1]) / length, 0, 1);
  return [ax + (bx - ax) * t, az + (bz - az) * t, -(bz - az) / length, (bx - ax) / length];
}

function crosses(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

// A walk behind one of `panels` ({ id, path: [[x, z], ...] }), or null when no
// curtain is at the right distance in plain view. `forward` is the visitor's
// facing; `prefer`, a point [x, z], asks for the curtain nearest it and the walk
// centred there (a recording sets it; capture.mjs).
export function planWalk(panels, visitor, { forward = [0, -1], random = Math.random, near = 1.4, far = 5.5, length = [4, 6.5], prefer = null } = {}) {
  const facing = Math.hypot(forward[0], forward[1]) || 1;
  // Where curtains hang double, the far one is hidden behind the near one.
  const hidden = (panel, x, z) => {
    const distance = Math.hypot(x - visitor[0], z - visitor[1]), back = Math.max(0, distance - 0.25) / distance;
    const seen = [visitor[0] + (x - visitor[0]) * back, visitor[1] + (z - visitor[1]) * back];
    return panels.some(other => other !== panel && other.path?.some((point, i) => i > 0 && crosses(visitor, seen, other.path[i - 1], point)));
  };
  // Whether some curtain stands between the visitor and a point.
  const veiled = point => panels.some(other => other.path?.some((p, i) => i > 0 && crosses(visitor, point, other.path[i - 1], p)));
  const candidates = [];
  for (const panel of panels) {
    const path = panel.path;
    if (!path || path.length < 2) continue;
    const arcs = [0];
    let nearest = null, anchor = null;
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1], [bx, bz] = path[i], dx = bx - ax, dz = bz - az, segment = Math.hypot(dx, dz);
      arcs.push(arcs[i - 1] + segment);
      if (!segment) continue;
      const t = clamp(((visitor[0] - ax) * dx + (visitor[1] - az) * dz) / (segment * segment), 0, 1);
      const x = ax + dx * t, z = az + dz * t, distance = Math.hypot(visitor[0] - x, visitor[1] - z);
      if (!nearest || distance < nearest.distance) nearest = { distance, arc: arcs[i - 1] + segment * t, x, z, nx: -dz / segment, nz: dx / segment };
      if (!prefer) continue;
      const u = clamp(((prefer[0] - ax) * dx + (prefer[1] - az) * dz) / (segment * segment), 0, 1);
      const off = Math.hypot(prefer[0] - ax - dx * u, prefer[1] - az - dz * u);
      if (!anchor || off < anchor.distance) anchor = { distance: off, arc: arcs[i - 1] + segment * u };
    }
    if (!nearest || arcs.at(-1) < length[0] || nearest.distance < near || nearest.distance > far) continue;
    const ahead = ((nearest.x - visitor[0]) * forward[0] + (nearest.z - visitor[1]) * forward[1]) / (nearest.distance * facing);
    const centre = (anchor ?? nearest).arc;
    candidates.push({ panel, arcs, nearest, centre, score: anchor ? -anchor.distance : (ahead > 0.3 ? 3 : 1) * (0.5 + random()) });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const { panel, arcs, nearest, centre } of candidates) {
    const total = arcs.at(-1), wanted = Math.min(total, length[0] + random() * (length[1] - length[0]));
    // Behind the cloth is the side away from the visitor.
    const side = (visitor[0] - nearest.x) * nearest.nx + (visitor[1] - nearest.z) * nearest.nz > 0 ? -1 : 1;
    const forwards = random() < 0.5;
    // Shorter walks, if a long one will not fit the stretch in view.
    for (let span = wanted; span >= length[0] - 1e-9; span -= 0.5) {
      const from = clamp(centre - span / 2, 0, total - span);
      // Most of the way must be in plain view.
      let seen = 0;
      for (let k = 0; k <= 4; k++) {
        const [x, z] = along(panel.path, arcs, from + span * k / 4);
        if (Math.hypot(x - visitor[0], z - visitor[1]) <= far + 1 && !hidden(panel, x, z)) seen++;
      }
      if (seen < 4) continue;
      const points = [];
      for (let s = 0; s <= span + 1e-9; s += 0.05) {
        const [x, z, nx, nz] = along(panel.path, arcs, forwards ? from + s : from + span - s);
        points.push([x + nx * side * OFFSET, z + nz * side * OFFSET]);
      }
      // Never out in the open: near a curtain's end, beside a doorway, the body
      // would be in plain sight with nothing there.
      if (points.some((point, i) => i % 5 === 0 && !veiled(point)) || !points.every(veiled)) continue;
      return { panelId: panel.id, points, length: span };
    }
  }
  return null;
}

function pointAt(walk, t) {
  const position = clamp(t * PACE / 0.05, 0, walk.points.length - 1), i = Math.floor(position), f = position - i;
  const [ax, az] = walk.points[i], [bx, bz] = walk.points[Math.min(i + 1, walk.points.length - 1)];
  return [ax + (bx - ax) * f, az + (bz - az) * f];
}

// When it comes: on the first circuit `firstWait` seconds in, as the visitor
// has settled; on later ordinary circuits `wait` seconds in; then `gap` seconds
// apart; never while the visitor is not `ready` (entering, or a line being
// spoken). A walk once begun goes on to its end.
export function createCurtainWalker({ random = Math.random, firstWait = [35, 60], wait = [12, 30], gap = [40, 75] } = {}) {
  let walk = null, nextAt = null;
  const between = ([low, high]) => low + random() * (high - low);

  function start(now, panels, visitor, forward, options = {}) {
    const plan = planWalk(panels, visitor, { forward, random, ...options });
    if (!plan) return false;
    walk = { ...plan, start: now, duration: plan.length / PACE, nextStep: 0.3 + random() * 0.2 };
    return true;
  }

  // Each frame. Returns the walker ({ at: [x, y, z], amount 0–1, panelId }) or
  // null, and the footfalls taken since the last call ([x, z] each).
  function update(now, { lap = 1, phase = 'normal', ready = false, panels = [], visitor = [0, 0], forward = [0, -1] } = {}) {
    const steps = [];
    if (!walk) {
      if (phase !== 'normal') { nextAt = null; return { walker: null, steps }; }
      nextAt ??= now + between(lap > 1 ? wait : firstWait);
      if (!ready || now < nextAt) return { walker: null, steps };
      // No curtain at the right distance here: look again in a moment.
      if (!start(now, panels, visitor, forward)) { nextAt = now + 1; return { walker: null, steps }; }
    }
    const t = now - walk.start;
    if (t >= walk.duration) { walk = null; nextAt = now + between(gap); return { walker: null, steps }; }
    while (walk.nextStep <= t) {
      steps.push(pointAt(walk, walk.nextStep));
      walk.nextStep += STEP * (0.95 + random() * 0.1);
    }
    // Out of the dark and back into it.
    const amount = smooth(clamp(t / 0.7, 0, 1)) * smooth(clamp((walk.duration - t) / 0.9, 0, 1));
    const [x, z] = pointAt(walk, t);
    return { walker: { at: [x, HEIGHT, z], amount, panelId: walk.panelId }, steps };
  }

  function reset() { walk = null; nextAt = null; }
  const inspect = () => ({ walking: !!walk, panelId: walk?.panelId ?? null, length: walk?.length ?? 0, nextAt });

  return { start, update, reset, inspect };
}
