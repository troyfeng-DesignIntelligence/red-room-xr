// The room's side of a recording (capture.mjs): puts the camera where the shot
// says, walks with the visitor's footsteps where the shot walks, and makes the
// room's events happen on cue: a line spoken, someone behind a curtain, a
// circuit completed in the dark, the statues set. The room's own timing of
// lines and of walks behind curtains is off for a take; everything else (the
// statues watching, the lights, the steps behind on dream circuits, the cloth
// feeling the body) runs as it would. With `music`, the record behind the
// curtains plays under the whole film instead of only near its room, still
// through the velvet, settling under the voices and slowing on dream circuits.
// Needs the page's ?debug hooks and the capture runtime (runtime.js);
// serialised into the page like it.
export async function installDirector(win, { eye = 1.65, music = null } = {}) {
  const r = win.__redRoom, capture = win.__capture;
  if (!r || !capture) throw new Error('The page needs ?debug and the capture runtime.');
  const manifest = await win.fetch('./assets/voices/manifest.json').then(response => response.ok ? response.json() : { lines: [] });
  const lines = new Map(manifest.lines.map(line => [line.id, line]));
  // Lines and walks behind curtains come only when a shot calls for them.
  const quiet = () => {
    if (r.voices && !r.voices.directed) Object.assign(r.voices, { update: () => null, directed: true });
  };
  quiet();
  const walkerUpdate = r.curtainWalker.update;
  r.curtainWalker.update = (now, options) => walkerUpdate(now, { ...options, ready: false });

  const Vector = r.camera.position.constructor, head = new Vector(), facing = new Vector();
  // The song from in front, as loud and as bright as the shot asks, wherever
  // the camera is; otherwise where the room puts it.
  let score = music;
  const placeMusic = r.audio.placeMusic;
  r.audio.placeMusic = options => {
    if (!score) return placeMusic(options);
    r.camera.getWorldPosition(head);
    r.camera.getWorldDirection(facing);
    return placeMusic({ gain: score.gain ?? 1, cutoff: score.cutoff ?? 1200, at: [head.x + facing.x * 3, head.y + 0.3, head.z + facing.z * 3] });
  };

  const STEP = 0.72, SPEED = 1.25;  // the visitor's stride and pace (locomotion.js)
  const log = [];
  let gait = null;
  const stand = () => { gait = { last: null, time: null, moving: false, stride: 0, footfall: -1e9, count: 0, speed: 0 }; };
  stand();

  // Footsteps where the camera walks, as the visitor's own (main.js): the first
  // one early from a standstill, then one every 72 cm, louder for a faster
  // walk, and the trailing foot set down on stopping. Someone following on a
  // dream circuit hears them too.
  function walk(x, z) {
    const now = win.performance.now(), last = gait.last, seconds = gait.time === null ? 0 : (now - gait.time) / 1000;
    gait.last = [x, z];
    gait.time = now;
    if (!last || !(seconds > 0)) return;
    const distance = Math.hypot(x - last[0], z - last[1]);
    if (distance > 1) { gait.moving = false; return; }
    const speed = distance / seconds, moving = speed > 0.35;
    gait.speed = speed;
    if (moving) {
      if (!gait.moving) gait.stride = STEP * 0.55;
      gait.stride += distance;
      while (gait.stride >= STEP) {
        gait.stride -= STEP;
        gait.count++;
        r.audio.footstep(Math.min(1, speed / SPEED));
        gait.footfall = now;
        r.follower.step(now / 1000);
      }
    } else if (gait.moving && now - gait.footfall > 150 && now - gait.footfall < 1200) {
      r.audio.footstep(0.5, { settle: true });
      r.follower.stop(now / 1000);
    }
    gait.moving = moving;
  }

  // `bob` scales the walk in the camera: lowest at each footfall (1.2 cm), and
  // a sway from foot to foot (0.8 cm), as the visitor's own (?bob).
  function place({ x, z, y, yaw, pitch, fov }, steps, bob = 1) {
    r.setPose(x, z, yaw, pitch);
    r.rig.position.y = y - eye;
    if (Math.abs(r.camera.fov - fov) > 1e-6) { r.camera.fov = fov; r.camera.updateProjectionMatrix(); }
    if (!steps) { stand(); return; }
    walk(x, z);
    const phase = gait.count + gait.stride / STEP, pace = Math.min(1, gait.speed / SPEED) * bob;
    const side = 0.008 * Math.sin(Math.PI * phase) * pace;
    r.rig.position.y -= 0.012 * Math.cos(2 * Math.PI * phase) * pace;
    r.rig.position.x += Math.cos(yaw) * side;
    r.rig.position.z -= Math.sin(yaw) * side;
  }

  // 'home', 'camera' (all of them facing it) or { face: [x, z] }.
  function setStatues(mode) {
    r.watchers.reset();
    if (mode === 'camera') { r.camera.getWorldPosition(head); r.watchers.turnAll([head.x, head.z]); }
    else if (mode?.face) r.watchers.turnAll(mode.face);
    r.placeFurniture();
  }

  // A circuit's state without walking it: no lights, no sound of it.
  function setLap(lap) {
    const state = r.simulation.state;
    if (state.lap === lap) return;
    Object.assign(state, { lap, phase: lap % 2 === 0 ? 'dream' : 'normal' });
    r.setPhase();
    r.audio.setPhase(state.phase, { dip: false });
    r.haze.setDream(state.phase !== 'normal', { now: true });
  }

  function run(event) {
    quiet();
    const now = win.performance.now();
    if (event.say) {
      const line = lines.get(event.say);
      if (!line) throw new Error(`No line "${event.say}" in the voices manifest.`);
      r.speakLine(line);
      log.push({ at: now, say: event.say });
    }
    if (event.walker) {
      r.camera.getWorldPosition(head);
      r.camera.getWorldDirection(facing);
      const started = r.curtainWalker.start(now / 1000, r.curtains.visiblePanels(), [head.x, head.z], [facing.x, facing.z], { prefer: event.walker.prefer ?? null });
      log.push({ at: now, walker: started, panel: r.curtainWalker.inspect().panelId });
    }
    // The way round the loop, walked at once: the lights go, the room changes.
    if (event.lap) {
      const before = r.simulation.state.lap;
      for (const [x, z] of r.spatial.route) r.simulation.updateProgress(x, z);
      log.push({ at: now, lap: r.simulation.state.lap, completed: r.simulation.state.lap > before });
    }
    if (event.statues) setStatues(event.statues);
    if (event.look) r.film.setLook(event.look);
    if (event.music !== undefined) score = event.music || null;
  }

  win.__director = {
    // Before a shot: the camera at its first place, then the room as the shot
    // wants it; `seed` makes the shot's chances repeatable.
    setup({ lap, statues, walker = 'reset', music: shotMusic } = {}, seed, pose) {
      if (seed !== undefined) capture.seed(seed);
      if (pose) place(pose, false);
      if (lap) setLap(lap);
      if (walker === 'reset') { r.curtainWalker.reset(); r.curtains.setWalker(null); }
      if (statues) setStatues(statues);
      if (shotMusic !== undefined) score = shotMusic || null;
      stand();
    },
    // Frames in order, each: the clock to `at`, the camera placed, the cues
    // run, drawn, and (`take`: [index, count] while the shutter is open) given
    // to the lens.
    async frames(list) {
      for (const { at, pose, events = [], steps = false, bob = 1, take = null } of list) {
        await capture.advance(at);
        place(pose, steps, bob);
        for (const event of events) run(event);
        capture.paint();
        if (take) win.__lens?.take(take[0], take[1], at / 1000, pose.matte ?? 0, pose.haze ?? 1);
      }
    },
    inspect: () => ({
      lap: r.simulation.state.lap, phase: r.simulation.state.phase,
      statues: r.watchers.inspect().map(({ index, yaw }) => ({ index, yaw: +yaw.toFixed(3) })),
      walker: r.curtainWalker.inspect(), subtitle: win.document.getElementById('subtitle-en')?.textContent ?? '',
      music: r.audio.inspect().music, log,
    }),
  };
}
