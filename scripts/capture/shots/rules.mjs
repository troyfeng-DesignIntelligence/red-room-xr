// "Rules of the Red Room": the short for social media (vertical) and its
// landscape twin. Six slow shots, a little over a minute, dipping through
// black from one to the next. It opens on the original's own shot, the 1991
// empty wide, framed 4:3 as it was broadcast, before the frame opens and the
// camera walks in; then the statue that turns while you look away, someone
// behind the curtain, the walk toward the Milo, the lights going out on a
// completed circuit, and the violet room after it. Shot on "film": 24 fps,
// each frame averaged over a half-open shutter, through a hazy lens, the
// camera on a breathing hand, the record behind the curtains under all of it.
// Titles and rule cards are left for the edit.
//
// A shot: { name, duration, keys (path.js), events: [{ t, say | walker | lap |
// statues | look | music }], setup: { lap, statues, walker, music }, steps
// (footsteps while the camera walks), bob, drift (false: a locked-off camera),
// fade: { in, out }, cover (a still at t) }. Positions are metres on the floor
// plan, [x, z]; heights in metres.
const DEG = Math.PI / 180;
const STATUE = [2.73, 1.3, 0.12];        // A | statue, at chest height
const MILO = [-7.2, 1.45, -6.25];
const DOUBLE = [-7, 0.85, 22.5];
// The camera of the 1991 empty wide (episode 29, "Beyond Life and Death"),
// fitted to the lamps, the statue's head and the chairs annotated on the
// still (work/references/s2_original_empty_wide): 1.80 m up, turned 1.35°,
// tilted down 11.3°, a 54.5° lens on the 4:3 picture; 6.7 px off on 1000.
const CLASSIC = { at: [0.117, 6.721], y: 1.804, yaw: 1.35 * DEG, pitch: -11.32 * DEG, fov43: 54.45 };

export default {
  name: 'rules',
  fps: 24,
  subframes: 6,
  shutter: 180,
  preroll: 3,
  seed: 1991,
  // The glass and the stock (lens.js): soft focus, mist, halation, a smoky
  // veil, vignette, gate weave and grain.
  lens: { soft: 1.8, mist: 0.48, mistRadius: 24, halation: 0.4, halationRadius: 58, veil: 0.07, vignette: 0.42, weave: 0.7, grain: 0.1 },
  // An operator's breathing on the camera (path.js).
  drift: { turn: 0.35, sway: 0.006, lift: 0.004, rate: 0.28 },
  // The record (the local Falling) under the whole film from its first bar,
  // through the velvet a little less than in the room.
  music: { from: 0, gain: 1, cutoff: 1500 },
  formats: {
    // 9:16; subtitles above the platform's captions and buttons.
    vertical: { size: [1080, 1920], fov: 72, subtitles: { bottom: '24vh', en: '4.4vw', zh: '3.5vw', width: '86vw' } },
    horizontal: { size: [1920, 1080], fov: 50, subtitles: { bottom: '8vh', en: '2.1vw', zh: '1.65vw', width: '80vw' } },
  },
  shots: [
    {
      // The original's shot, held as it was: the camera locked off, the
      // picture 4:3 in black, in the 1991 look matched to the stills, no haze.
      // Then the frame opens out to the whole screen, the haze comes in, and
      // the camera walks into the room toward the statue: from here on it is
      // ours.
      name: 'classic', duration: 12, cover: 5, fade: { in: 1.5, out: 0.6 }, drift: false,
      setup: { lap: 1, statues: 'home' },
      keys: [
        { t: 0, ...CLASSIC, matte: 1, haze: 0 },
        { t: 6.5, matte: 1, haze: 0 },
        { t: 10.5, at: [0.62, 5.0], y: 1.66, look: STATUE, zoom: 1, matte: 0, haze: 1 },
        { t: 12, at: [0.7, 4.75], look: STATUE },
      ],
    },
    {
      // Rule one: don't turn your back on the statue. One take: she looks
      // aside; the camera turns slowly to the chairs and stays there; when it
      // turns back, she is facing it.
      name: 'statue', duration: 13, cover: 12.6, fade: { in: 0.5, out: 0.5 },
      setup: { lap: 1, statues: 'home' },
      keys: [
        { t: 0, at: [0.36, -1.32], look: STATUE, zoom: 1.25 },
        { t: 3.5, at: [0.55, -1.17], look: STATUE },
        { t: 6.3, look: [-1.45, 0.45, 0.5] },
        { t: 9.6, at: [0.6, -1.12], look: [-1.4, 0.42, 0.5] },
        { t: 11.8, at: [0.62, -1.1], look: STATUE },
        { t: 13, at: [0.7, -1.04], look: STATUE },
      ],
    },
    {
      // Rule two: there is no one behind the curtain. The room says someone is
      // waiting there; then someone walks behind the far curtain.
      name: 'curtain', duration: 10.5, fade: { in: 0.5, out: 0.5 },
      keys: [
        { t: 0, at: [-17.1, 1.2], look: [-19.5, 1.15, -1.3], zoom: 1.1 },
        { t: 10.5, at: [-17.4, 0.92], look: [-19.5, 1.1, -0.9] },
      ],
      events: [
        { t: 1.0, say: 'waiting' },
        { t: 4.6, walker: { prefer: [-19.5, -0.9] } },
      ],
    },
    {
      // Slowly toward the Milo down the statue corridor; she speaks.
      name: 'corridor', duration: 11, steps: true, fade: { in: 0.5, out: 0.5 },
      // Unseen in the shot before, she would have turned toward it.
      setup: { statues: 'home' },
      keys: [
        { t: 0, at: [-7.2, 2.6], look: MILO },
        { t: 9.6, at: [-7.2, -1.2], look: MILO },
        { t: 11, at: [-7.2, -1.2], look: MILO },
      ],
      events: [{ t: 2.2, say: 'gum' }],
    },
    {
      // Rule three: when the lights go out, don't move. Back in the waiting
      // room over the chairs, the statue turned away; a circuit completes; in
      // the dark she turns; the lights return on her face, the record comes
      // back slower, and the room says you have been here before.
      name: 'blackout', duration: 14, steps: true, fade: { in: 0.5, out: 0.6 },
      setup: { statues: { face: [4.4, -1.4] } },
      keys: [
        { t: 0, at: [-1.25, 5.5], look: STATUE },
        { t: 4.6, at: [-0.45, 2.75], look: STATUE },
        { t: 7.2, at: [-0.45, 2.75], look: STATUE, zoom: 1 },
        { t: 14, at: [0.05, 2.1], look: STATUE, zoom: 1.35 },
      ],
      events: [
        { t: 5.6, lap: true },
        { t: 7.4, say: 'before' },
      ],
    },
    {
      // After it: the mirrored waiting room in violet haze, the double chair.
      name: 'violet', duration: 11, fade: { in: 0.8, out: 3 },
      setup: { lap: 2 },
      keys: [
        { t: 0, at: [-7, 18.2], look: DOUBLE },
        { t: 11, at: [-7, 19.6], look: DOUBLE },
      ],
      events: [{ t: 2.0, say: 'remembers' }],
    },
  ],
};
