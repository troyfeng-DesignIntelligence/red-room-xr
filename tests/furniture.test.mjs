import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { refinePresentation } from '../dist/js/presentation.js';
// Load the browser ES module directly, as the spatial tests do.
const source = readFileSync(new URL('../dist/js/furniture.js', import.meta.url));
const { createFurniture, separation, escape, curtainGap, placeOutline, reachOf } = await import(`data:text/javascript;base64,${source.toString('base64')}`);

// The real room: obstacles and curtain lines from spatial.json, outlines as
// the page measures them from the models.
const spatial = JSON.parse(readFileSync(new URL('../dist/assets/spatial.json', import.meta.url), 'utf8'));
const { outlines } = JSON.parse(readFileSync(new URL('./furniture-outlines.json', import.meta.url), 'utf8'));
const room = () => createFurniture(spatial.obstacles, outlines, spatial.wallSegments);
const LAPS = Array.from({ length: 59 }, (_, i) => i + 2);
const TABLES = ['A | table', 'F | table'];
const isTable = ({ index }) => TABLES.includes(spatial.obstacles[index].name);
const square = (x, z, size = 1) => [[x, z], [x + size, z], [x + size, z + size], [x, z + size]];

test('outlines: gaps, overlaps and turns', () => {
  assert.ok(Math.abs(separation(square(0, 0), square(2, 0)) - 1) < 1e-9);
  assert.ok(Math.abs(separation(square(0, 0), square(0.8, 0.5)) + 0.2) < 1e-9, 'overlapping by 20 cm');
  assert.ok(Math.abs(curtainGap(square(0, 0), [[[1.5, -3], [1.5, 3]]]) - 0.5) < 1e-9);
  assert.equal(curtainGap(square(0, 0), [[[0.5, -3], [0.5, 3]]]), 0, 'a curtain through the piece');
  const [[x, z]] = placeOutline([[1, 0]], [0, 0], 0.1, 0, Math.PI / 2);
  assert.ok(Math.abs(x - 0.1) < 1e-9 && Math.abs(z - 1) < 1e-9, 'a turn takes x toward z, then the shift');
  const [dx, dz] = escape(square(0, 0), square(0.8, 0.5), 0.01);
  assert.ok(Math.abs(dx + 0.21) < 1e-9 && dz === 0, 'out of an overlap by the shortest way, plus the gap');
  assert.equal(escape(square(0, 0), square(2, 0), 0.01), null, 'already clear');
});

test('on the first circuit only the side tables move, out of their armchairs, and they stay out', () => {
  const furniture = room(), first = furniture.shift(1);
  for (const lap of [0, -3, Number.NaN, undefined]) assert.deepEqual(furniture.shift(lap), first, 'a reset puts everything back there');
  assert.deepEqual(Object.keys(first).map(index => spatial.obstacles[index].name).sort(), TABLES);
  for (const [index, { dx, dz, yaw }] of Object.entries(first)) {
    // The export has each table about 30 cm inside its chair's arm.
    assert.ok(Math.hypot(dx, dz) > 0.25 && Math.hypot(dx, dz) < 0.35 && yaw === 0, spatial.obstacles[index].name);
    for (const lap of LAPS) assert.deepEqual(furniture.shift(lap)[index], first[index], 'the same on every circuit');
    // The waiting room's own pieces carry no room prefix.
    const chair = spatial.obstacles.findIndex(o => o.name === { 'A | table': 'Chair 01', 'F | table': 'F | Chair 01' }[spatial.obstacles[index].name]);
    const table = placeOutline(outlines[index], spatial.obstacles[index].center, dx, dz, 0);
    assert.ok(separation(outlines[chair], outlines[index]) < -0.25, 'the two overlap as exported');
    assert.ok(Math.abs(separation(outlines[chair], table) - 0.015) < 1e-6, 'and stand 1.5 cm apart now');
  }
  assert.deepEqual(furniture.pieces.map(p => spatial.obstacles[p.index].name).sort(),
    ['A | table', 'Chair 01', 'Chair 02', 'Chair 03', 'F | Chair 01', 'F | Chair 02', 'F | Chair 03', 'F | Torchiere 01', 'F | Torchiere 02', 'F | double', 'F | table', 'Torchiere 01', 'Torchiere 02']);
});

test('each circuit has its own arrangement, the same whenever it comes round', () => {
  const furniture = room();
  assert.deepEqual(furniture.shift(3), room().shift(3));
  const still = { dx: 0, dz: 0, yaw: 0 };
  let changed = 0, pairs = 0;
  for (const lap of LAPS.slice(0, -1)) {
    const now = furniture.shift(lap), next = furniture.shift(lap + 1);
    const moved = furniture.pieces.filter(piece => !isTable(piece)).filter(({ index }) => {
      const a = now[index] ?? still, b = next[index] ?? still;
      return Math.hypot(a.dx - b.dx, a.dz - b.dz) > 0.01 || Math.abs(a.yaw - b.yaw) > 0.017;
    }).length;
    // A hemmed-in lamp can land near its last spot by chance, rarely.
    assert.ok(moved >= furniture.pieces.length - TABLES.length - 2, `lap ${lap} → ${lap + 1}: ${moved} pieces rearranged`);
    changed += moved; pairs += furniture.pieces.length - TABLES.length;
  }
  assert.ok(changed / pairs > 0.95, `${changed} of ${pairs}`);
});

test('a few centimetres and degrees, a little more on later circuits; lamps only slide', () => {
  const furniture = room(), mean = lap => {
    const moves = Object.entries(furniture.shift(lap)).filter(([index]) => !isTable({ index })).map(([, { dx, dz }]) => Math.hypot(dx, dz));
    return moves.reduce((sum, d) => sum + d, 0) / moves.length;
  };
  for (const lap of LAPS) {
    const { move, turn } = reachOf(lap), shifts = furniture.shift(lap);
    for (const piece of furniture.pieces.filter(piece => !isTable(piece))) {
      const shift = shifts[piece.index];
      if (!shift) continue;
      const distance = Math.hypot(shift.dx, shift.dz);
      assert.ok(distance >= move / 2 - 1e-9 && distance <= move + 1e-9, `${distance} m`);
      assert.ok(distance <= 0.12 + 1e-9 && Math.abs(shift.yaw) <= 0.12 + 1e-9);
      if (piece.kind === 'lamp') assert.equal(shift.yaw, 0);
      else assert.ok(Math.abs(shift.yaw) >= turn / 2 - 1e-9);
    }
  }
  assert.ok(mean(2) < 0.06 && mean(8) > mean(2) * 1.4, `${mean(2)} m, then ${mean(8)} m`);
});

test('nothing is pushed into a neighbour, the table, the statue or a curtain', () => {
  const furniture = room();
  const all = spatial.obstacles.map((o, index) => ({ ...o, index, outline: outlines[index] })).filter(o => o.outline);
  const roomOf = name => name.includes('|') ? name.split('|')[0].trim() : 'A';
  const together = (a, b) => a !== b && roomOf(a.name) === roomOf(b.name) && (!a.state || !b.state || a.state === b.state);
  // Where everything stands on the first circuit, the tables already beside their chairs.
  const at = shifts => new Map(all.map(o => {
    const shift = shifts[o.index];
    return [o, shift ? placeOutline(o.outline, o.center, shift.dx, shift.dz, shift.yaw) : o.outline];
  }));
  const first = at(furniture.shift(1));
  let moved = 0, chances = 0;
  for (const lap of LAPS) {
    const shifts = furniture.shift(lap), placed = at(shifts);
    for (const piece of furniture.pieces.filter(piece => !isTable(piece))) {
      const o = all.find(other => other.index === piece.index);
      chances++; if (shifts[piece.index]) moved++;
      for (const other of all.filter(other => together(o, other))) {
        const before = separation(first.get(o), first.get(other)), after = separation(placed.get(o), placed.get(other));
        if (isTable(other)) assert.ok(after >= 0.012, `lap ${lap}: ${o.name} into ${other.name}, ${after.toFixed(3)} m`);
        assert.ok(after >= Math.min(before, 0.06) - 0.0025, `lap ${lap}: ${o.name} and ${other.name} ${before.toFixed(3)} → ${after.toFixed(3)} m`);
      }
      const before = curtainGap(o.outline, spatial.wallSegments), after = curtainGap(placed.get(o), spatial.wallSegments);
      assert.ok(after >= Math.min(before, 0.25) - 0.0025, `lap ${lap}: ${o.name} to the curtain ${before.toFixed(3)} → ${after.toFixed(3)} m`);
    }
  }
  // The lamp against the waiting-room curtain may only move along or away from it,
  // and the two chairs arm to arm only apart: still, nearly everything moves.
  assert.ok(moved / chances > 0.9, `${moved} of ${chances} moves`);
});

test('a spot the caller refuses, say where the visitor stands, is never used', () => {
  const furniture = room(), visitor = [-1.2, 1.4];
  for (const lap of LAPS) {
    const shifts = furniture.shift(lap, (piece, x, z) => Math.hypot(x - visitor[0], z - visitor[1]) >= Math.hypot(piece.home[0] - visitor[0], piece.home[1] - visitor[1]));
    for (const piece of furniture.pieces.filter(piece => !isTable(piece))) {
      const shift = shifts[piece.index];
      if (shift) assert.ok(Math.hypot(piece.home[0] + shift.dx - visitor[0], piece.home[1] + shift.dz - visitor[1]) >= Math.hypot(piece.home[0] - visitor[0], piece.home[1] - visitor[1]));
    }
  }
  assert.deepEqual(room().shift(4, () => false), room().shift(1), 'refused everywhere: only the tables, settled');
});

test('the double chair model turns and moves as the outlines do', () => {
  const obstacles = [{ name: 'F | double', center: [-7, 22.5], radius: 0.85 }];
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.8).translate(-7, 0.4, 22.5), new THREE.MeshBasicMaterial());
  box.name = 'double chair props';
  const double = new THREE.Group().add(box);
  const models = { environment: new THREE.Group(), milo: new THREE.Group(), repeated: new THREE.Group(), double, dreamCurtains: new THREE.Group() };
  const presentation = refinePresentation(new THREE.Scene(), models, null, obstacles);
  assert.ok(presentation.outlines[0].length >= 4, 'the double chair is outlined');
  const shift = { dx: 0.05, dz: -0.03, yaw: 0.1 };
  presentation.setFurniture({ 0: shift });
  double.updateMatrixWorld(true);
  const corner = new THREE.Vector3(-6.2, 0, 22.9), moved = corner.clone().applyMatrix4(double.matrixWorld);
  const [[x, z]] = placeOutline([[corner.x, corner.z]], obstacles[0].center, shift.dx, shift.dz, shift.yaw);
  assert.ok(Math.abs(moved.x - x) < 1e-6 && Math.abs(moved.z - z) < 1e-6 && Math.abs(moved.y) < 1e-9);
  presentation.setFurniture({});
  double.updateMatrixWorld(true);
  assert.ok(corner.clone().applyMatrix4(double.matrixWorld).distanceTo(corner) < 1e-9, 'and goes back');
});
