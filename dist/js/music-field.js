// Where the record is heard. It plays somewhere behind the curtains, never in
// sight: on ordinary circuits behind the far rooms, on dream circuits also
// behind the waiting room. Distance and the curtains in between decide how
// loud and how muffled it is, and from which way it comes. Pure geometry: the
// curtain count is passed in (simulation.wallsBetween). Metres, Hz.
export const RECORD_SOURCES = [
  { at: [-7, 25.8] },                    // behind the mirror waiting room
  { at: [-29.5, 8], phase: 'normal' },   // behind the empty-table room
  { at: [0, -3], phase: 'dream' },       // behind the waiting room's chairs
];

export function createMusicField(sources, curtainsBetween, { reach = 14 } = {}) {
  // Listener at (x, z). Gain 0–1, low-pass cutoff, and the direction the
  // record is heard from on the floor plan: a unit [dx, dz], louder sources
  // weighing more ([0, 0] when it is not heard).
  function sample(x, z, phase = 'normal') {
    let energy = 0, cutoff = 0, toX = 0, toZ = 0;
    for (const source of sources) {
      if (source.phase && source.phase !== phase) continue;
      const [sx, sz] = source.at, dx = sx - x, dz = sz - z, distance = Math.hypot(dx, dz);
      if (distance >= reach) continue;
      // The record is always behind one curtain; each further one takes about
      // 6 dB and half the brightness.
      const beyond = Math.max(0, curtainsBetween([x, z], [sx, sz]) - 1);
      const near = 1 - distance / reach, gain = near ** 1.2 * 0.5 ** beyond, weight = gain * gain;
      energy += weight;
      if (distance > 1e-4) { toX += weight * dx / distance; toZ += weight * dz / distance; }
      cutoff += weight * (600 + 1700 * near) * 0.5 ** beyond;
    }
    if (!energy) return { gain: 0, cutoff: 600, direction: [0, 0] };
    const length = Math.hypot(toX, toZ);
    return { gain: Math.min(1, Math.sqrt(energy)), cutoff: cutoff / energy, direction: length > 1e-6 ? [toX / length, toZ / length] : [0, 0] };
  }
  return { sample };
}
