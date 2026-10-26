// The statues turn to look at the visitor, but only while nobody is looking at
// them. A statue unseen for PATIENCE seconds turns, at once, to face where the
// visitor is now, if that is more than NOTICE from where it already faces; then
// it waits again. When the lights go out, nobody sees anything and all of them
// turn together. Turn round, and she is watching you; walk past, and she has
// followed. Starting over puts them all back. Pure: statues, the visitor and a
// test of what can be seen in; turns out, in radians, x toward z.

const PATIENCE = 2.5;  // seconds out of sight before a statue moves
const NOTICE = 0.35;   // radians: smaller turns are not worth the risk of being seen
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));

// Which way each statue's face looks as exported, in degrees x toward z, read
// off renders taken round each one. Her face, not her body, is what finds the
// visitor: the Medici looks down over her left shoulder, about 40° from her
// body, and the far room's copy is the same set turned half round; the Milo
// looks away to her left. Measure again if the models change.
export const GAZES = { 'A | statue': 122, 'B | statue': 18, 'F | statue': -58 };

// `statues`: [{ index, at: [x, z], facing }], facing in radians as GAZES gives it.
export function createWatchers(statues) {
  const watching = statues.map(statue => ({ ...statue, yaw: 0, unseenSince: null }));

  // Turns a statue to face the visitor, unless she nearly does already.
  function face(statue, visitor) {
    const yaw = wrap(Math.atan2(visitor[1] - statue.at[1], visitor[0] - statue.at[0]) - statue.facing);
    if (Math.abs(wrap(yaw - statue.yaw)) < NOTICE) return false;
    statue.yaw = yaw;
    return true;
  }

  // `seen(statue)` says whether the visitor could see it now. Returns whether any turned.
  function update(now, { visitor, seen }) {
    let turned = false;
    for (const statue of watching) {
      if (seen(statue)) { statue.unseenSince = null; continue; }
      statue.unseenSince ??= now;
      if (now - statue.unseenSince < PATIENCE) continue;
      statue.unseenSince = now;
      turned = face(statue, visitor) || turned;
    }
    return turned;
  }

  // In the dark every statue is out of sight.
  function turnAll(visitor) {
    let turned = false;
    for (const statue of watching) turned = face(statue, visitor) || turned;
    return turned;
  }

  // { [obstacle index]: { dx: 0, dz: 0, yaw } } for the statues that have turned.
  const turns = () => Object.fromEntries(watching.filter(s => s.yaw).map(s => [s.index, { dx: 0, dz: 0, yaw: s.yaw }]));
  function reset() { for (const statue of watching) Object.assign(statue, { yaw: 0, unseenSince: null }); }
  const inspect = () => watching.map(({ index, facing, yaw, unseenSince }) => ({ index, facing, yaw, unseen: unseenSince !== null }));

  return { update, turnAll, turns, reset, inspect };
}
