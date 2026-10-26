// Local curtain contact signals in metres, with no rendering or DOM dependencies.
// The fixed pulse slots are read directly by the renderer each frame.
const EPSILON = 1e-8;
const LIFETIME = 4;
const EMISSION_INTERVAL = 0.12;
const MAX_STRENGTH = 0.2;
const MAX_FRAME = 0.25;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const smooth = value => value * value * (3 - 2 * value);

function preparePanel(panel, index) {
  const path = (panel.path ?? []).filter(point => Array.isArray(point) &&
    Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const segments = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared > EPSILON) {
      const length = Math.sqrt(lengthSquared);
      segments.push({ x: a[0], z: a[1], dx, dz, lengthSquared, nx: -dz / length, nz: dx / length });
    }
  }
  const minY = finite(panel.minY), maxY = Math.max(minY, finite(panel.maxY, 4));
  return { id: panel.id ?? `panel-${index}`, segments, minY, maxY };
}

export function createCurtainMotion(panels = [], { maxImpulses = 6 } = {}) {
  const prepared = panels.map(preparePanel).filter(panel => panel.segments.length);
  const count = clamp(Math.floor(finite(maxImpulses, 6)), 1, 6);
  const impulses = Array.from({ length: count }, () => ({
    active: false, panelId: null, age: LIFETIME, strength: 0,
    position: { x: 0, y: 0, z: 0 }, direction: { x: 0, z: 1 },
  }));
  const previous = new Map();
  let time = 0, emitted = 0, maxStrength = 0;

  function nearestPanel(source, activePanelIds) {
    let nearest = null, distanceSquared = Infinity;
    for (const panel of prepared) {
      if (activePanelIds && !activePanelIds.has(panel.id)) continue;
      if (source.y < panel.minY - source.radius || source.y > panel.maxY + source.radius) continue;
      for (const segment of panel.segments) {
        const t = clamp(((source.x - segment.x) * segment.dx +
          (source.z - segment.z) * segment.dz) / segment.lengthSquared, 0, 1);
        const x = segment.x + segment.dx * t, z = segment.z + segment.dz * t;
        const squared = (source.x - x) ** 2 + (source.z - z) ** 2;
        if (squared < distanceSquared) {
          distanceSquared = squared;
          nearest = { panel, x, z, distance: Math.sqrt(squared), nx: segment.nx, nz: segment.nz };
        }
      }
    }
    return nearest;
  }

  function emit(source, hit, speed, tracking, velocityX, velocityZ) {
    // Heavy velvet still answers a passing body plainly: up to about 15 cm at
    // the point of contact, less the further away the body brushes past.
    const proximity = smooth(clamp(1 - hit.distance / source.radius, 0, 1));
    const strength = clamp((0.07 + 0.13 * (1 - Math.exp(-speed / 1.0))) * proximity, 0, MAX_STRENGTH);
    if (strength < 0.001) return;
    let side = (hit.x - source.x) * hit.nx + (hit.z - source.z) * hit.nz;
    if (Math.abs(side) < EPSILON) {
      // A source exactly on the cloth keeps its previous side, or follows the
      // direction of contact, so a zero-distance sample never produces NaN.
      side = tracking.panelId === hit.panel.id ? tracking.side : 0;
      if (Math.abs(side) < EPSILON) side = velocityX * hit.nx + velocityZ * hit.nz;
      if (Math.abs(side) < EPSILON) side = 1;
    }
    side = side < 0 ? -1 : 1;
    const slot = impulses.find(impulse => !impulse.active) ??
      impulses.reduce((oldest, impulse) => impulse.age > oldest.age ? impulse : oldest);
    const samePatch = tracking.panelId === hit.panel.id && tracking.patch &&
      Math.hypot(tracking.patch.x - hit.x, tracking.patch.z - hit.z) < 0.2;
    const patch = samePatch ? tracking.patch : { x: hit.x, z: hit.z };
    Object.assign(slot, { active: true, panelId: hit.panel.id, age: 0, strength });
    Object.assign(slot.position, {
      x: patch.x, y: clamp(source.y, hit.panel.minY, hit.panel.maxY), z: patch.z,
    });
    Object.assign(slot.direction, { x: hit.nx * side, z: hit.nz * side });
    Object.assign(tracking, { lastEmission: time, patch, panelId: hit.panel.id, side });
    emitted++;
    maxStrength = Math.max(maxStrength, strength);
  }

  function update(dt, sources = [], activePanelIds) {
    const elapsed = Math.max(0, finite(dt));
    time += elapsed;
    for (const impulse of impulses) {
      if (!impulse.active) continue;
      impulse.age = Math.min(LIFETIME, impulse.age + elapsed);
      if (impulse.age >= LIFETIME || (activePanelIds && !activePanelIds.has(impulse.panelId))) {
        impulse.active = false;
        impulse.strength = 0;
      }
    }
    const present = new Set();
    for (const raw of sources.slice(0, 3)) {
      if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isFinite(raw.z)) continue;
      const id = raw.id ?? 'body';
      if (present.has(id)) continue;
      present.add(id);
      const source = {
        x: raw.x, y: raw.y, z: raw.z,
        radius: clamp(finite(raw.radius, id === 'body' ? 0.65 : 0.3), 0.05, 1),
      };
      const prior = previous.get(id);
      const tracking = prior ?? { ...source, lastEmission: -Infinity, panelId: null, side: 0, patch: null };
      const dx = prior ? source.x - prior.x : 0, dz = prior ? source.z - prior.z : 0;
      const dy = prior ? source.y - prior.y : 0;
      const displacement = Math.hypot(dx, dy, dz);
      const velocityX = elapsed > EPSILON ? dx / elapsed : 0;
      const velocityZ = elapsed > EPSILON ? dz / elapsed : 0;
      const speed = elapsed > EPSILON ? displacement / elapsed : 0;
      const jumped = elapsed > MAX_FRAME || (prior && (displacement > 0.55 || speed > 8));
      Object.assign(tracking, source);
      previous.set(id, tracking);
      if (jumped) {
        Object.assign(tracking, { lastEmission: time, panelId: null, patch: null, side: 0 });
        continue;
      }
      if (elapsed <= EPSILON || time - tracking.lastEmission < EMISSION_INTERVAL - EPSILON) continue;
      const hit = nearestPanel(source, activePanelIds);
      if (!hit || hit.distance >= source.radius) continue;
      const intentX = finite(raw.intentX), intentZ = finite(raw.intentZ);
      const intentMagnitude = Math.hypot(intentX, intentZ);
      // An attempted move into or along the curtain still pushes it when the
      // navigation collision boundary holds the body in place. An attempt to
      // move away from it while stationary does not create a new contact.
      const toward = (hit.x - source.x) * intentX + (hit.z - source.z) * intentZ;
      const tangentIntent = Math.abs(intentX * hit.nz - intentZ * hit.nx);
      const intentSpeed = toward > EPSILON || tangentIntent > 0.06 || hit.distance < EPSILON
        ? Math.min(intentMagnitude, 3) : 0;
      const contactSpeed = Math.max(prior ? speed : 0, intentSpeed);
      if (contactSpeed < 0.035) continue;
      emit(source, hit, contactSpeed, tracking, velocityX || intentX, velocityZ || intentZ);
    }
    for (const id of previous.keys()) if (!present.has(id)) previous.delete(id);
    return impulses;
  }

  // A push from something that is not a tracked body, such as someone behind
  // the cloth: a wave at the curtain point nearest `point` ({ x, y, z }),
  // pushed away from it. Returns whether a curtain was there to touch.
  function touch(point, strength, activePanelIds) {
    const hit = nearestPanel({ radius: 0, ...point }, activePanelIds);
    if (!hit) return false;
    const side = (hit.x - point.x) * hit.nx + (hit.z - point.z) * hit.nz < 0 ? -1 : 1;
    const slot = impulses.find(impulse => !impulse.active) ??
      impulses.reduce((oldest, impulse) => impulse.age > oldest.age ? impulse : oldest);
    Object.assign(slot, { active: true, panelId: hit.panel.id, age: 0, strength: clamp(finite(strength), 0, MAX_STRENGTH) });
    Object.assign(slot.position, { x: hit.x, y: clamp(point.y, hit.panel.minY, hit.panel.maxY), z: hit.z });
    Object.assign(slot.direction, { x: hit.nx * side, z: hit.nz * side });
    emitted++;
    maxStrength = Math.max(maxStrength, slot.strength);
    return true;
  }

  function reset() {
    previous.clear();
    time = 0; emitted = 0; maxStrength = 0;
    for (const impulse of impulses) {
      Object.assign(impulse, { active: false, panelId: null, age: LIFETIME, strength: 0 });
    }
  }

  function inspect() {
    return { activeImpulses: impulses.filter(impulse => impulse.active).length,
      emitted, maxStrength, time, trackedSources: previous.size };
  }

  // The curtain line nearest a point, for the cloth's slower response to a
  // visitor standing close: { panel, x, z, distance, nx, nz } or null.
  const nearest = (source, activePanelIds) => nearestPanel({ radius: 0, ...source }, activePanelIds);

  return { update, touch, reset, impulses, inspect, nearest };
}
