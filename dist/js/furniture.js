// After every completed circuit the furniture is not quite where it was. Each
// chair and floor lamp has moved a few centimetres and each chair has turned a
// few degrees, a little more on later circuits, fresh each time from where it
// first stood; nothing moves on the first circuit, so a reset puts it all back.
// Measured on the pieces' real outlines: a piece never pushes further into a
// neighbour it already touches, never comes within GAP of one it does not, and
// never comes nearer a curtain than CURTAIN unless it already stood nearer, in
// which case it may only move along or away. A piece with no such move this
// circuit stays where it first stood. The export left each side table half
// inside its armchair; on every circuit, the first included, the table stands
// beside the chair instead, SETTLE clear of it, and stays there. Pure:
// obstacles, their outlines on the floor and the curtain lines in;
// { [obstacle index]: { dx, dz, yaw } } out, in metres and radians, the turn
// about where the piece first stood, x toward z.

const GAP = 0.06, CURTAIN = 0.25, SETTLE = 0.015, SLACK = 0.002, TRIES = 16;

const kindOf = name => /double/i.test(name) ? 'double' : /chair/i.test(name) ? 'chair' : /torchiere/i.test(name) ? 'lamp' : /table/i.test(name) ? 'table' : null;
// "F | Chair 01" stands in room F; unprefixed pieces are in the waiting room.
const roomOf = name => name.includes('|') ? name.split('|')[0].trim() : 'A';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How far apart two convex outlines are along the axis that best separates
// them: never more than the true gap when they are apart, and minus the depth
// of the overlap when they overlap.
export function separation(a, b) {
  let best = -Infinity;
  for (const outline of [a, b]) {
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i], q = outline[(i + 1) % outline.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!length) continue;
      const nx = (q[1] - p[1]) / length, nz = (p[0] - q[0]) / length;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, z] of a) { const d = x * nx + z * nz; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const [x, z] of b) { const d = x * nx + z * nz; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      best = Math.max(best, minB - maxA, minA - maxB);
    }
  }
  return best;
}

// The shortest move [dx, dz] that takes convex outline `a` at least `gap` clear
// of outline `b`, or null when it is clear already.
export function escape(a, b, gap = 0) {
  let best = null;
  for (const outline of [a, b]) {
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i], q = outline[(i + 1) % outline.length];
      const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!length) continue;
      const nx = (q[1] - p[1]) / length, nz = (p[0] - q[0]) / length;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, z] of a) { const d = x * nx + z * nz; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const [x, z] of b) { const d = x * nx + z * nz; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      // Along this axis: past b's far side, or back past its near side.
      for (const [distance, sign] of [[maxB - minA + gap, 1], [maxA - minB + gap, -1]]) {
        if (distance <= 0) return null;
        if (!best || distance < best.distance) best = { distance, x: nx * sign, z: nz * sign };
      }
    }
  }
  return best && [best.x * best.distance, best.z * best.distance];
}

function pointToSegment(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lengthSquared)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

function crosses(a, b, c, d) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

// The nearest any curtain line comes to an outline's edge, 0 where one crosses it.
export function curtainGap(outline, walls) {
  let gap = Infinity;
  for (const [c, d] of walls) {
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      gap = Math.min(gap, crosses(a, b, c, d) ? 0 : Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b)));
    }
  }
  return gap;
}

// An outline turned about `home` by `yaw`, then moved by (dx, dz).
export function placeOutline(outline, home, dx, dz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return outline.map(([x, z]) => [
    home[0] + dx + c * (x - home[0]) - s * (z - home[1]),
    home[1] + dz + s * (x - home[0]) + c * (z - home[1]),
  ]);
}

// How far a piece may move and turn on a circuit: up to 6 cm and 3.4° on the
// second, growing to 12 cm and 6.9° by the sixth, at least half of each.
export function reachOf(lap) {
  const grown = Math.min(Math.max(lap - 2, 0), 4) / 4;
  return { move: 0.06 + 0.06 * grown, turn: 0.06 + 0.06 * grown };
}

// `outlines` holds the outline on the floor, [[x, z], ...], of each obstacle
// by index; chairs, floor lamps and the double chair with an outline move, side
// tables settle once, any other outlined obstacle (a statue) is in their way.
export function createFurniture(obstacles, outlines = {}, walls = []) {
  const all = obstacles.map((obstacle, index) => ({
    index, kind: kindOf(obstacle.name), room: roomOf(obstacle.name), state: obstacle.state,
    home: obstacle.center.slice(), outline: outlines[index],
  })).filter(piece => piece.outline?.length);
  // Pieces in different states are never in the room together.
  const together = (a, b) => a !== b && a.room === b.room && (!a.state || !b.state || a.state === b.state);
  // Each side table out of the chairs it stands in, by the shortest way.
  const settled = {};
  for (const table of all.filter(piece => piece.kind === 'table')) {
    let dx = 0, dz = 0;
    for (let pass = 0; pass < 4; pass++) {
      const outline = placeOutline(table.outline, table.home, dx, dz, 0);
      const out = all.filter(other => other.kind && other.kind !== 'table' && together(table, other))
        .map(other => escape(outline, other.outline, SETTLE)).find(Boolean);
      if (!out) break;
      dx += out[0]; dz += out[1];
    }
    if (!dx && !dz) continue;
    settled[table.index] = { dx, dz, yaw: 0 };
    table.outline = placeOutline(table.outline, table.home, dx, dz, 0);
  }
  const pieces = all.filter(piece => piece.kind && piece.kind !== 'table');
  for (const piece of pieces) {
    piece.neighbours = all.filter(other => together(piece, other)).map(other => ({ other, before: separation(piece.outline, other.outline) }));
    const size = Math.max(...piece.outline.map(([x, z]) => Math.hypot(x - piece.home[0], z - piece.home[1])));
    piece.walls = walls.filter(([a, b]) => pointToSegment(piece.home, a, b) < size + 1);
    piece.curtain = curtainGap(piece.outline, piece.walls);
  }

  // `keepClear(piece, x, z)` may refuse a piece's new centre, say where the visitor stands.
  function shift(lap, keepClear = () => true) {
    const shifts = { ...settled };
    if (!(lap > 1)) return shifts;
    const { move, turn } = reachOf(lap), placed = new Map(all.map(piece => [piece, piece.outline]));
    // A piece hemmed in on both sides gets a second chance once its neighbours have moved.
    for (let pass = 0; pass < 2; pass++) for (const piece of pieces) {
      if (shifts[piece.index]) continue;
      const random = seeded(Math.imul(lap, 7919) + piece.index * 104729 + pass * 15485863);
      for (let attempt = 0; attempt < TRIES; attempt++) {
        const angle = random() * Math.PI * 2, distance = move * (0.5 + 0.5 * random());
        const yaw = piece.kind === 'lamp' ? 0 : turn * (0.5 + 0.5 * random()) * (random() < 0.5 ? -1 : 1);
        const dx = Math.cos(angle) * distance, dz = Math.sin(angle) * distance;
        const outline = placeOutline(piece.outline, piece.home, dx, dz, yaw);
        if (piece.neighbours.some(({ other, before }) => separation(outline, placed.get(other)) < Math.min(before, GAP) - SLACK)) continue;
        if (curtainGap(outline, piece.walls) < Math.min(piece.curtain, CURTAIN) - SLACK) continue;
        if (!keepClear(piece, piece.home[0] + dx, piece.home[1] + dz)) continue;
        placed.set(piece, outline);
        shifts[piece.index] = { dx, dz, yaw };
        break;
      }
    }
    return shifts;
  }

  return { pieces: all.filter(piece => piece.kind).map(({ index, kind, room, home }) => ({ index, kind, room, home })), shift };
}
