// Metres, Three.js Y-up; all navigation points below are [x, z].
// This module deliberately has no DOM or rendering dependencies.
const EPSILON = 1e-7;
const TAU = Math.PI * 2;
const asPoint = value => Array.isArray(value) ? [value[0], value[1]] : [value.x, value.z];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared))
    : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (distanceToSegment(point, a, b) < EPSILON) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ac = cross(a, b, c), ad = cross(a, b, d);
  const ca = cross(c, d, a), cb = cross(c, d, b);
  if (((ac > EPSILON && ad < -EPSILON) || (ac < -EPSILON && ad > EPSILON)) &&
      ((ca > EPSILON && cb < -EPSILON) || (ca < -EPSILON && cb > EPSILON))) return true;
  return (Math.abs(ac) <= EPSILON && distanceToSegment(c, a, b) <= EPSILON) ||
    (Math.abs(ad) <= EPSILON && distanceToSegment(d, a, b) <= EPSILON) ||
    (Math.abs(ca) <= EPSILON && distanceToSegment(a, c, d) <= EPSILON) ||
    (Math.abs(cb) <= EPSILON && distanceToSegment(b, c, d) <= EPSILON);
}

function createCheckpoints(route, spacing = 4.5) {
  if (route.length < 2) return [];
  const checkpoints = [[...route[0]]];
  let travelled = 0;
  for (let i = 1; i < route.length; i++) {
    travelled += distance(route[i - 1], route[i]);
    if (travelled >= spacing && distance(route[i], route[0]) > 2.5) {
      checkpoints.push([...route[i]]);
      travelled = 0;
    }
  }
  if (checkpoints.length < 3) return [];
  checkpoints.push([...route[0]]);
  return checkpoints;
}

// `roomOf(x, z)` names the room at a point. Given it, a circuit closes on
// coming back into the starting room by another doorway than the one left by,
// whichever way round; out and back the same way never counts, and side rooms
// may be skipped. The checkpoints then only lead the route guide. Without it,
// a circuit is the ordered checkpoints back to the start.
export function createSimulation(spatial, { onLapChange = () => {}, checkpointRadius = 1.7, roomOf = null } = {}) {
  const polygons = spatial.walkablePolygons ?? [];
  const walls = spatial.wallSegments ?? [];
  const obstacles = spatial.obstacles ?? [];
  const checkpoints = spatial.checkpoints ?? createCheckpoints(spatial.route ?? []);
  const state = { lap: 1, phase: 'normal', checkpointIndex: 1, progress: 0 };
  let previousProgressPosition = null;
  const spawn = spatial.spawn?.position;
  let home = null, room = null, leftTo = null;
  const cellSize = 2;
  const wallCells = new Map();
  const polygonBounds = polygons.map(polygon => [
    Math.min(...polygon.map(point => point[0])), Math.min(...polygon.map(point => point[1])),
    Math.max(...polygon.map(point => point[0])), Math.max(...polygon.map(point => point[1])),
  ]);
  const cellsForBounds = (minX, minZ, maxX, maxZ, visit) => {
    for (let x = Math.floor(minX / cellSize); x <= Math.floor(maxX / cellSize); x++) {
      for (let z = Math.floor(minZ / cellSize); z <= Math.floor(maxZ / cellSize); z++) visit(`${x},${z}`);
    }
  };
  for (let i = 0; i < walls.length; i++) {
    const [a, b] = walls[i];
    cellsForBounds(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), key => {
      if (!wallCells.has(key)) wallCells.set(key, []);
      wallCells.get(key).push(i);
    });
  }
  function nearbyWalls(minX, minZ, maxX, maxZ) {
    const indices = new Set();
    cellsForBounds(minX, minZ, maxX, maxZ, key => {
      for (const index of wallCells.get(key) ?? []) indices.add(index);
    });
    return indices;
  }

  const activeObstacles = () => obstacles.filter(obstacle => !obstacle.state || obstacle.state === state.phase);
  const onFloor = point => polygons.some((polygon, index) => {
    const [minX, minZ, maxX, maxZ] = polygonBounds[index];
    return point[0] >= minX - EPSILON && point[0] <= maxX + EPSILON &&
      point[1] >= minZ - EPSILON && point[1] <= maxZ + EPSILON && pointInPolygon(point, polygon);
  });

  // A circle on the floor and clear of every curtain line, furniture aside.
  function clearOfWalls(x, z, radius = 0.2) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return false;
    const point = [x, z];
    if (!onFloor(point)) return false;
    // Test the union of floor regions, so overlapping room / doorway rectangles
    // do not introduce invisible boundaries between neighbouring regions.
    if (radius > 0) {
      for (let i = 0; i < 12; i++) {
        if (!onFloor([x + Math.cos(i * TAU / 12) * radius, z + Math.sin(i * TAU / 12) * radius])) return false;
      }
    }
    for (const index of nearbyWalls(x - radius - EPSILON, z - radius - EPSILON, x + radius + EPSILON, z + radius + EPSILON)) {
      if (distanceToSegment(point, ...walls[index]) < radius + EPSILON) return false;
    }
    return true;
  }

  function isValidPosition(x, z, radius = 0.2) {
    return clearOfWalls(x, z, radius) && !activeObstacles().some(obstacle => distance([x, z], obstacle.center) < radius + obstacle.radius);
  }

  function wallBetween(from, to) {
    const a = asPoint(from), b = asPoint(to);
    for (const index of nearbyWalls(
      Math.min(a[0], b[0]) - EPSILON, Math.min(a[1], b[1]) - EPSILON,
      Math.max(a[0], b[0]) + EPSILON, Math.max(a[1], b[1]) + EPSILON,
    )) {
      if (segmentsIntersect(a, b, ...walls[index])) return true;
    }
    return false;
  }

  // How many curtain lines a sound crosses between two points.
  function wallsBetween(from, to) {
    const a = asPoint(from), b = asPoint(to);
    let count = 0;
    for (const index of nearbyWalls(
      Math.min(a[0], b[0]) - EPSILON, Math.min(a[1], b[1]) - EPSILON,
      Math.max(a[0], b[0]) + EPSILON, Math.max(a[1], b[1]) + EPSILON,
    )) {
      if (segmentsIntersect(a, b, ...walls[index])) count++;
    }
    return count;
  }

  function traceSegment(from, to, radius = 0.2) {
    const a = asPoint(from), b = asPoint(to);
    if (!isValidPosition(a[0], a[1], radius)) {
      return { clear: false, position: { x: a[0], z: a[1] }, fraction: 0 };
    }
    const count = Math.max(1, Math.ceil(distance(a, b) / Math.max(0.025, Math.min(0.08, radius / 2 || 0.025))));
    let previous = a;
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      const next = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (wallBetween(previous, next) || !isValidPosition(next[0], next[1], radius)) {
        return { clear: false, position: { x: previous[0], z: previous[1] }, fraction: (i - 1) / count };
      }
      previous = next;
    }
    return { clear: true, position: { x: b[0], z: b[1] }, fraction: 1 };
  }

  function move(position, dx, dz, radius = 0.2) {
    let [x, z] = asPoint(position);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return { x, z, collided: true };
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.075));
    let collided = false;
    for (let i = 0; i < steps; i++) {
      const sx = dx / steps, sz = dz / steps;
      const clear = traceSegment([x, z], [x + sx, z + sz], radius);
      if (clear.clear) {
        x += sx; z += sz;
      } else {
        collided = true;
        if (traceSegment([x, z], [x + sx, z], radius).clear) x += sx;
        if (traceSegment([x, z], [x, z + sz], radius).clear) z += sz;
      }
    }
    return { x, z, collided };
  }

  function canTeleport(from, to, maxDistance = 6) {
    const a = asPoint(from), b = asPoint(to);
    if (distance(a, b) < 0.15 || distance(a, b) > maxDistance) return false;
    return traceSegment(a, b, 0.2).clear;
  }

  function completeLap() {
    state.lap++;
    state.phase = state.lap % 2 === 0 ? 'dream' : 'normal';
    state.checkpointIndex = 1;
    state.progress = 0;
    onLapChange({ ...state });
  }

  // True when stepping into `next` closes a circuit.
  function enterRoom(next) {
    if (!next || next === room) return false;
    const from = room;
    room = next;
    if (from === home) { leftTo = next; return false; }
    if (next !== home) return false;
    const closed = leftTo !== null && from !== leftTo;
    leftTo = null;
    return closed;
  }

  function updateProgress(x, z) {
    if ((!checkpoints.length && !roomOf) || !isValidPosition(x, z, 0.08)) return state;
    const here = [x, z];
    const previous = previousProgressPosition ?? here;
    if (roomOf && !previousProgressPosition) {
      home ??= spawn ? roomOf(spawn[0], spawn[2]) : roomOf(x, z);
      room = roomOf(x, z);
    }
    previousProgressPosition = here;
    // A reset or an arbitrary debug jump cannot complete the circuit.
    if (distance(previous, here) > 6.25 || !traceSegment(previous, here, 0.08).clear) {
      if (roomOf) { room = roomOf(x, z); leftTo = null; }
      return state;
    }
    if (roomOf) {
      // Every room on the way, so a teleport through a doorway counts too.
      const samples = Math.ceil(distance(previous, here) / 0.25);
      for (let i = 1; i <= samples; i++) {
        const t = i / samples;
        if (enterRoom(roomOf(previous[0] + (here[0] - previous[0]) * t, previous[1] + (here[1] - previous[1]) * t))) {
          completeLap();
          return state;
        }
      }
    }
    let advanced = false;
    while (state.checkpointIndex < checkpoints.length) {
      const checkpoint = checkpoints[state.checkpointIndex];
      const last = state.checkpointIndex === checkpoints.length - 1;
      const radius = last ? 0.8 : checkpointRadius;
      if (distanceToSegment(checkpoint, previous, here) > radius) break;
      // Nearby points behind curtains do not count as visiting a room.
      if (wallBetween(here, checkpoint)) break;
      state.checkpointIndex++;
      advanced = true;
      if (last) {
        if (roomOf) { state.checkpointIndex = 1; break; }
        completeLap();
        return state;
      }
    }
    if (advanced) state.progress = (state.checkpointIndex - 1) / (checkpoints.length - 1);
    return state;
  }

  function resetProgress() {
    Object.assign(state, { lap: 1, phase: 'normal', checkpointIndex: 1, progress: 0 });
    previousProgressPosition = null;
    room = leftTo = null;
    onLapChange({ ...state });
  }

  return {
    floorY: spatial.floorY ?? 0, state, checkpoints, isValidPosition, clearOfWalls, wallBetween, wallsBetween,
    traceSegment, move, canTeleport, updateProgress, resetProgress,
  };
}
