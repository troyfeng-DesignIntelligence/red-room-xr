// Someone walking behind the visitor on dream circuits. Not an echo: its own
// steps, off the beat and never quite in time, now and then missing one. It
// joins after the visitor has walked a while, falls away for a stretch, comes
// back, and stops when the visitor stops, one late step after. Counted in the
// visitor's footfalls, so a teleport walks it as well. Pure timing in seconds:
// main.js reports the visitor's footfalls and stops, audio.js plays what
// update() returns.
export function createFollower({ warmup = 8, follow = [40, 70], rest = [18, 32], random = Math.random } = {}) {
  const pending = [];
  let dream = false, phase = 'waiting', stepsLeft = warmup, lag = 0.32, lastStep = -Infinity, followed = 0;
  const between = ([low, high]) => Math.round(low + random() * (high - low));
  const schedule = entry => {
    let i = pending.length;
    while (i > 0 && pending[i - 1].at > entry.at) i--;
    pending.splice(i, 0, entry);
  };

  // The visitor's foot landed at `now`.
  function step(now) {
    if (!dream) return;
    if (--stepsLeft <= 0) {
      phase = phase === 'following' ? 'resting' : 'following';
      stepsLeft = between(phase === 'following' ? follow : rest);
    }
    if (phase !== 'following') return;
    lastStep = now;
    if (random() < 0.12) return;
    // Its pace drifts against the visitor's, but it stays on the off-beat,
    // 0.22–0.42 s behind, so it never hides under the visitor's next step.
    lag = Math.max(0.22, Math.min(0.42, lag + (random() - 0.5) * 0.1));
    schedule({ at: now + lag, settle: false });
    followed++;
  }

  // The visitor came to rest at `now`: one last step from behind, then quiet.
  function stop(now) {
    if (!dream || phase !== 'following' || now - lastStep > 1.5) return;
    schedule({ at: now + 0.5 + random() * 0.25, settle: true });
  }

  // Steps due by `now`, oldest first. Outside dream circuits it waits to begin again.
  function update(now, { dream: active = false } = {}) {
    if (!active) {
      dream = false; pending.length = 0; phase = 'waiting'; stepsLeft = warmup;
      return [];
    }
    dream = true;
    const due = [];
    while (pending.length && pending[0].at <= now) due.push(pending.shift());
    return due;
  }

  return { step, stop, update, inspect: () => ({ dream, phase, stepsLeft, pending: pending.length, followed, lag }) };
}
