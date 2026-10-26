// When the room speaks. The lines and their triggers come from
// assets/voices/manifest.json; this module only decides which line is due,
// from the room the visitor is in (rooms.js codes) and how many circuits they
// have walked. No DOM or audio dependencies; times in seconds.
//
// A room speaks at most once each time the visitor enters it: after `dwell`
// seconds inside (or the line's own `after`), one of its lines that suits the
// room's phase and the circuit count (minLap), the one heard longest ago
// first, and never the same line twice within `repeatAfter` seconds. A
// circuit line answers the drone's dip when a circuit is completed,
// preferring the highest minLap. `once` lines speak once per visit, even
// across a reset. Lines never overlap, and a short silence separates them; a
// line held back by that silence still speaks if the visitor stays.
export function createVoiceDirector(lines, { gap = 6, dwell = 1.5, repeatAfter = 60, lapDelay = 1.8, lapExpiry = 10 } = {}) {
  const rooms = lines.filter(line => line.trigger?.type === 'room');
  const circuits = lines.filter(line => line.trigger?.type === 'lap');
  const lastHeard = new Map(), heardOnce = new Set();
  let pending = null, busyUntil = -Infinity, quietUntil = -Infinity, spoken = 0, room = null, enteredAt = 0, spokeHere = false;

  const due = (line, lap, phase) => {
    const { phase: only, minLap = 1, once = false } = line.trigger;
    return (!only || only === phase) && lap >= minLap && !(once && heardOnce.has(line.id));
  };

  function speak(line, now) {
    lastHeard.set(line.id, now);
    if (line.trigger.once) heardOnce.add(line.id);
    busyUntil = now + (line.duration ?? 4);
    quietUntil = busyUntil + gap;
    spoken++;
    return line;
  }

  // The circuit count rose to `lap`, and the room is now in `phase`.
  function lapChanged(lap, phase, now) {
    const line = circuits.filter(candidate => due(candidate, lap, phase))
      .sort((a, b) => (b.trigger.minLap ?? 1) - (a.trigger.minLap ?? 1))[0];
    pending = line ? { line, at: now + lapDelay } : null;
  }

  // The line to speak now, or null.
  function update(here, { lap = 1, phase = 'normal' } = {}, now = 0) {
    if (here !== room) { room = here; enteredAt = now; spokeHere = false; }
    if (pending && now > pending.at + lapExpiry) pending = null;
    if (pending) {
      // A circuit line waits out a line still speaking, not the silence after it.
      if (now < pending.at || now < busyUntil + 1) return null;
      const { line } = pending;
      pending = null;
      return speak(line, now);
    }
    if (now < quietUntil || spokeHere) return null;
    let next = null, nextHeard = Infinity;
    for (const line of rooms) {
      if (line.trigger.room !== room || !due(line, lap, phase) || now - enteredAt < (line.trigger.after ?? dwell)) continue;
      const heard = lastHeard.get(line.id) ?? -Infinity;
      if (now - heard >= repeatAfter && heard < nextHeard) { next = line; nextHeard = heard; }
    }
    if (!next) return null;
    spokeHere = true;
    return speak(next, now);
  }

  // Back to the start: room lines may speak again; `once` lines stay spoken.
  function reset() {
    lastHeard.clear();
    pending = null;
    busyUntil = quietUntil = -Infinity;
    room = null;
  }

  return {
    update, lapChanged, reset,
    inspect: () => ({ spoken, room, pending: pending?.line.id ?? null, busyUntil, quietUntil, heard: Object.fromEntries(lastHeard), once: [...heardOnce] }),
  };
}
