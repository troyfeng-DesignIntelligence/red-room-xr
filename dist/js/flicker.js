// The lights when a circuit completes: they stutter twice, go out while the
// room changes unseen, and come back as the drone returns. Brightness 0–1
// against seconds since that moment; picture and sound share this timeline.
// Never more than two flashes in a second; with reduced motion, one slow dip
// and no flashes.
const STUTTER = [[0, 1], [0.04, 0.22], [0.13, 0.22], [0.16, 0.9], [0.29, 0.85], [0.32, 0.05], [0.8, 0.05], [1.4, 1]];
const DIP = [[0, 1], [0.35, 0.4], [0.9, 0.4], [1.6, 1]];

// The room changes here, in the dark.
export const DARKEST = 0.5;
// The electricity crackles as the lights stutter.
export const CRACKLES = [0.04, 0.16, 0.32];

export function lightAt(seconds, reduced = false) {
  const keys = reduced ? DIP : STUTTER;
  if (!(seconds > 0) || seconds >= keys.at(-1)[0]) return 1;
  let i = 1;
  while (keys[i][0] < seconds) i++;
  const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
  return v0 + (v1 - v0) * (seconds - t0) / (t1 - t0);
}
