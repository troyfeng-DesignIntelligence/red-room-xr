// Room sound: a synthesized drone that breathes and the rustle of velvet;
// recorded footsteps (assets/footsteps) and the backwards voices
// (assets/voices). Footsteps and cloth pass through a short, dark room
// response: the curtains swallow the highs and the tail. An optional local
// record (assets/music) is heard faintly from somewhere else.
// Whatever has a place in the room is heard from it in three dimensions,
// through a head-related transfer function (HRTF): with headphones, front and
// back, left and right. The drone, the visitor's own steps and the answers to a
// circuit, which come from all around, are not placed.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function noise(context, seconds, shape = () => 1) {
  const rate = context.sampleRate, length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(1, length, rate), data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * shape(i / rate);
  return buffer;
}

function brownNoise(context, seconds) {
  const buffer = noise(context, seconds), data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * data[i]) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

// Fabric is grainy rather than a smooth hiss: white noise under a fast,
// irregular envelope of small fibre scrapes.
function clothNoise(context, seconds) {
  const buffer = noise(context, seconds), data = buffer.getChannelData(0);
  let envelope = 0, target = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.random() < 0.0016) target = 0.25 + Math.random() * 0.75;
    target *= 0.9996;
    envelope += (target - envelope) * 0.02;
    data[i] *= 0.35 + envelope;
  }
  return buffer;
}

function roomResponse(context, seconds) {
  const rate = context.sampleRate, length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      // Velvet absorbs the highs first: the smoothing grows along the tail.
      const smoothing = Math.min(0.97, 0.3 + t * 3.4);
      low = low * smoothing + (Math.random() * 2 - 1) * (1 - smoothing);
      data[i] = low * Math.exp(-t / 0.075) * Math.min(1, t / 0.004);
    }
  }
  return buffer;
}

// The record's own room: larger and darker than the velvet one, so the music
// seems to play somewhere else.
function farResponse(context, seconds) {
  const rate = context.sampleRate, length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const smoothing = Math.min(0.985, 0.6 + t * 0.9);
      low = low * smoothing + (Math.random() * 2 - 1) * (1 - smoothing);
      data[i] = low * Math.exp(-t / 0.6) * Math.min(1, Math.max(0, t - 0.03) / 0.08);
    }
  }
  return buffer;
}

export function createRoomAudio() {
  let context = null, master = null, room = null, echo = null, droneLevel = null, droneFilter = null, duck = null;
  let clothBuffer = null, tones = [], steps = [], lastStep = -1, otherSide = 1;
  // The footsteps arrive with the page and are decoded once there is a context.
  let stepFile = null, stepsDecoding = false;
  let muted = false, level = 1, started = false, phase = 'normal', side = 1;
  // The listener's head in world metres, where it is and which way it faces.
  const head = { x: 0, y: 1.65, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
  const encoded = new Map(), decoding = new Set(), clips = new Map();
  // The record streams through a media element: a whole song decoded into
  // memory would take tens of megabytes.
  let record = null;
  const RECORD_LEVEL = 0.25, DREAM_RATE = 0.88;
  const stats = { footsteps: 0, settles: 0, follower: 0, walker: 0, rustles: 0, shifts: 0, voices: 0, surges: 0 };

  function build() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return false;
    context = new AudioContextClass({ latencyHint: 'interactive' });
    master = context.createGain();
    master.gain.value = 0;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14; limiter.knee.value = 10; limiter.ratio.value = 4;
    limiter.attack.value = 0.004; limiter.release.value = 0.25;
    master.connect(limiter).connect(context.destination);

    room = context.createGain();
    const dry = context.createGain(), wet = context.createGain(), convolver = context.createConvolver();
    dry.gain.value = 0.82; wet.gain.value = 0.3;
    convolver.buffer = roomResponse(context, 0.42);
    room.connect(dry).connect(master);
    room.connect(convolver).connect(wet).connect(master);
    echo = convolver;

    clothBuffer = clothNoise(context, 3);
    buildDrone();
    return true;
  }

  function buildDrone() {
    droneFilter = context.createBiquadFilter();
    droneFilter.type = 'lowpass'; droneFilter.frequency.value = 340; droneFilter.Q.value = 0.7;
    const breath = context.createGain();
    droneLevel = context.createGain();
    droneLevel.gain.value = 0;
    // A separate stage lets the drone settle under a voice without touching
    // the dip of a completed circuit.
    duck = context.createGain();
    droneFilter.connect(breath).connect(droneLevel).connect(duck).connect(master);
    // Two beating fundamentals, an octave of presence for small speakers and a
    // faint mains buzz: electricity somewhere behind the curtains.
    for (const [frequency, type, gain] of [[55, 'triangle', 0.3], [55.37, 'triangle', 0.26], [110.15, 'sawtooth', 0.045], [82.6, 'sine', 0.035], [60, 'sawtooth', 0.012]]) {
      const oscillator = context.createOscillator(), toneGain = context.createGain();
      oscillator.type = type; oscillator.frequency.value = frequency; toneGain.gain.value = gain;
      oscillator.connect(toneGain).connect(droneFilter);
      oscillator.start();
      if (frequency !== 60) tones.push(oscillator);
    }
    const rumble = context.createBufferSource(), rumbleFilter = context.createBiquadFilter(), rumbleGain = context.createGain();
    rumble.buffer = brownNoise(context, 4); rumble.loop = true;
    rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 150; rumbleGain.gain.value = 0.55;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(breath);
    rumble.start();
    // Slow, uneven breathing of timbre and level.
    for (const [frequency, depth, target] of [[0.055, 110, droneFilter.frequency], [0.031, 0.18, breath.gain]]) {
      const lfo = context.createOscillator(), amount = context.createGain();
      lfo.frequency.value = frequency; amount.gain.value = depth;
      lfo.connect(amount).connect(target);
      lfo.start();
    }
  }

  const ready = () => !!context && started;

  // Called every frame with the camera (Vector3-like position, forward, up).
  function setListener(position, forward, up = { x: 0, y: 1, z: 0 }) {
    Object.assign(head, { x: position.x, y: position.y, z: position.z, fx: forward.x, fy: forward.y, fz: forward.z, ux: up.x, uy: up.y, uz: up.z });
    if (!context) return;
    const listener = context.listener;
    if (!listener.positionX) {
      listener.setPosition(head.x, head.y, head.z);
      listener.setOrientation(head.fx, head.fy, head.fz, head.ux, head.uy, head.uz);
      return;
    }
    // Plain values, not ramps: the panners stay on their fast path.
    listener.positionX.value = head.x; listener.positionY.value = head.y; listener.positionZ.value = head.z;
    listener.forwardX.value = head.fx; listener.forwardY.value = head.fy; listener.forwardZ.value = head.fz;
    listener.upX.value = head.ux; listener.upY.value = head.uy; listener.upZ.value = head.uz;
  }

  // A panner at [x, y, z]. It gives only the direction: how loud and how far
  // into the room's tail a sound is stays with the caller.
  function placed([x, y, z]) {
    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.rolloffFactor = 0;
    move(panner, [x, y, z]);
    return panner;
  }
  function move(panner, [x, y, z]) {
    if (!panner.positionX) { panner.setPosition(x, y, z); return; }
    panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z;
  }
  // Whether [x, y, z] is behind the listener's face.
  const behind = ([x, y, z]) => (x - head.x) * head.fx + (y - head.y) * head.fy + (z - head.z) * head.fz < 0;

  function apply(seconds) {
    if (!context) return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(muted ? 0 : level * 0.8, now, Math.max(0.01, seconds / 3));
  }

  // Must run inside a user gesture; later calls are cheap no-ops.
  function start() {
    if (!context && !build()) return false;
    if (context.state === 'suspended' && !document.hidden) context.resume().catch(() => {});
    if (!started) {
      started = true;
      droneLevel.gain.setTargetAtTime(0.2, context.currentTime, 0.7);
      if (phase === 'dream') {
        for (const oscillator of tones) oscillator.detune.value = -40;
        droneFilter.frequency.value = 280;
      }
      apply(2.2);
      decodeVoices();
      decodeFootsteps();
      connectRecord();
    }
    return true;
  }

  // A record playing somewhere behind the curtains, already mid-song when the
  // visitor first hears it. A missing file only leaves the room quieter.
  function loadMusic(url) {
    if (record || typeof Audio === 'undefined') return;
    const element = new Audio();
    element.loop = true; element.preload = 'auto';
    element.preservesPitch = element.mozPreservesPitch = element.webkitPreservesPitch = false;
    record = { element, chain: null, placedAt: -1, placed: { gain: 0, cutoff: 600, pan: 0 }, failed: false, nudgedAt: 0 };
    element.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(element.duration)) element.currentTime = Math.random() * element.duration * 0.85;
    }, { once: true });
    element.addEventListener('error', () => { record.failed = true; console.warn('Music not loaded:', url); });
    element.src = url;
    connectRecord();
  }

  function connectRecord() {
    if (!ready() || !record || record.chain || record.failed) return;
    const source = context.createMediaElementSource(record.element);
    // A song swells and falls by ten decibels; from another room it should
    // stay faint all the way through.
    const even = context.createDynamicsCompressor();
    even.threshold.value = -30; even.knee.value = 10; even.ratio.value = 8; even.attack.value = 0.08; even.release.value = 0.8;
    const high = context.createBiquadFilter(), lows = [context.createBiquadFilter(), context.createBiquadFilter()];
    const gain = context.createGain(), hush = context.createGain(), panner = placed([head.x, 1.1, head.z - 3]);
    const send = context.createGain(), far = context.createConvolver(), farLevel = context.createGain();
    high.type = 'highpass'; high.frequency.value = 110;
    // Two stacked low-passes: velvet takes the top off steeply.
    for (const low of lows) { low.type = 'lowpass'; low.frequency.value = 600; low.Q.value = 0.6; }
    gain.gain.value = 0;
    send.gain.value = 0.6; farLevel.gain.value = 0.45;
    far.buffer = farResponse(context, 2.8);
    source.connect(even).connect(high).connect(lows[0]).connect(lows[1]).connect(gain).connect(hush).connect(panner).connect(master);
    panner.connect(send).connect(far).connect(farLevel).connect(master);
    record.chain = { gain, hush, lows, panner };
    record.element.playbackRate = phase === 'dream' ? DREAM_RATE : 1;
    record.element.play().catch(error => console.warn('Music not started:', error.message));
  }

  // Where the visitor stands decides how much of the record comes through:
  // gain 0–1, low-pass cutoff in Hz, and `at`, a point in the direction it
  // comes from.
  function placeMusic({ gain = 0, cutoff = 600, at = null } = {}) {
    if (!record?.chain || !ready()) return;
    const now = context.currentTime;
    if (now - record.placedAt < 0.1) return;
    record.placedAt = now;
    record.placed = { gain, cutoff, at };
    // The record keeps playing: a device change or the system can pause a
    // media element behind the page's back.
    if (record.element.paused && !document.hidden && now - record.nudgedAt > 2) {
      record.nudgedAt = now;
      record.element.play().catch(() => {});
    }
    record.chain.gain.gain.setTargetAtTime(RECORD_LEVEL * clamp(gain, 0, 1), now, 0.5);
    for (const low of record.chain.lows) low.frequency.setTargetAtTime(clamp(cutoff, 200, 4000), now, 0.5);
    if (at) move(record.chain.panner, at);
  }

  // Spoken lines are fetched early and decoded once the context exists.
  // `lines` are manifest entries; their files are relative to `base`.
  function loadVoices(lines, base = './assets/') {
    for (const line of lines) {
      if (encoded.has(line.id)) continue;
      encoded.set(line.id, fetch(base + line.file)
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${line.file}: ${response.status}`)))
        .catch(error => { console.warn('Voice not loaded:', error.message); return null; }));
    }
    decodeVoices();
  }

  // A recording of one man walking, cut into single steps (scripts/footsteps):
  // a manifest and one file holding them in equal slots.
  function loadFootsteps(url = './assets/footsteps/steps.json') {
    if (stepFile) return;
    const manifestUrl = new URL(url, location.href);
    stepFile = fetch(manifestUrl)
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`${url}: ${response.status}`)))
      .then(manifest => fetch(new URL(manifest.file, manifestUrl))
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${manifest.file}: ${response.status}`)))
        .then(bytes => ({ manifest, bytes })))
      .catch(error => { console.warn('Footsteps not loaded:', error.message); return null; });
    decodeFootsteps();
  }
  function decodeFootsteps() {
    if (!context || !stepFile || stepsDecoding) return;
    stepsDecoding = true;
    stepFile.then(file => file && context.decodeAudioData(file.bytes).then(sprite => {
      const rate = sprite.sampleRate, data = sprite.getChannelData(0);
      steps = file.manifest.steps.map(({ at, length }) => {
        const buffer = context.createBuffer(1, Math.round(length * rate), rate);
        buffer.copyToChannel(data.subarray(Math.round(at * rate), Math.round((at + length) * rate)), 0);
        return buffer;
      });
    })).catch(error => console.warn('Footsteps not decoded:', error?.message));
  }
  function decodeVoices() {
    if (!context) return;
    for (const [id, bytes] of encoded) {
      if (decoding.has(id)) continue;
      decoding.add(id);
      bytes.then(data => data && context.decodeAudioData(data))
        .then(buffer => { if (buffer) clips.set(id, buffer); })
        .catch(error => console.warn('Voice not decoded:', id, error?.message));
    }
  }

  // A line from the room, heard from where it lives (`at`, [x, y, z]; without
  // it, from all around), further into the reverb with distance in metres. It
  // sits well above the drone in the speech band, and the drone settles under
  // it. Returns its length in seconds, or 0 when it cannot play yet.
  function speak(id, { at = null, distance = 2 } = {}) {
    const buffer = clips.get(id);
    if (!ready() || !buffer) return 0;
    const now = context.currentTime, near = clamp(1 - distance / 12, 0, 1);
    const source = context.createBufferSource(), gain = context.createGain();
    const panner = at ? placed(at) : context.createGain(), send = context.createGain();
    source.buffer = buffer;
    gain.gain.value = 1.7 * (0.75 + 0.25 * near);
    send.gain.value = 0.15 + 0.3 * (1 - near);
    source.connect(gain).connect(panner).connect(master);
    panner.connect(send).connect(echo);
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(0.4, now, 0.3);
    duck.gain.setTargetAtTime(1, now + buffer.duration, 0.9);
    if (record?.chain) {
      record.chain.hush.gain.cancelScheduledValues(now);
      record.chain.hush.gain.setTargetAtTime(0.45, now, 0.3);
      record.chain.hush.gain.setTargetAtTime(1, now + buffer.duration, 1.2);
    }
    source.start(now);
    stats.voices++;
    return buffer.duration;
  }

  function setLevel(value, seconds = 0.8) {
    level = clamp(value, 0, 1);
    apply(seconds);
  }

  // Not remembered: there is no switch on the page to undo it.
  function setMuted(value) {
    muted = !!value;
    apply(0.3);
    return muted;
  }

  // A recorded step, never the one just heard: a slower step lands softer and
  // duller, and the left and right shoe differ a little in tone. `settle` is
  // the trailing foot set down when the walk stops: quieter and duller still.
  // `from` ([x, y, z]) makes it someone else's step there: the same shoes, a
  // little heavier, about 14 dB down, further into the room's tail, and duller
  // from behind; `veiled`, on the far side of a curtain, through the velvet.
  // Silent until the recording has been decoded.
  function footstep(intensity = 1, { settle = false, from = null, veiled = false } = {}) {
    if (!ready() || !steps.length) return;
    const now = context.currentTime, strength = clamp(intensity, 0.15, 1);
    let index = Math.floor(Math.random() * steps.length);
    if (!from && index === lastStep) index = (index + 1) % steps.length;
    if (!from) lastStep = index;
    const foot = from ? (otherSide = -otherSide) : (side = -side);
    const source = context.createBufferSource(), tone = context.createBiquadFilter(), gain = context.createGain();
    const panner = from ? placed(from) : context.createStereoPanner();
    source.buffer = steps[index];
    source.playbackRate.value = (0.97 + Math.random() * 0.06) * (from ? 0.93 : 1) * (settle ? 0.96 : 1);
    tone.type = 'highshelf'; tone.frequency.value = 2200; tone.gain.value = foot * 1.5 - (1 - strength) * 5 - (settle ? 6 : 0);
    gain.gain.value = (settle ? 0.34 : 0.62) * (0.4 + 0.6 * strength) * (0.88 + Math.random() * 0.12) * (from ? (veiled ? 0.42 : 0.2) : 1);
    if (from) {
      const far = context.createBiquadFilter(), send = context.createGain();
      far.type = 'lowpass'; far.frequency.value = veiled ? 1100 : behind(from) ? 2000 : 3400;
      send.gain.value = veiled ? 0.8 : 0.6;
      source.connect(tone).connect(gain).connect(far).connect(panner).connect(room);
      panner.connect(send).connect(echo);
      if (veiled) stats.walker++;
      else stats.follower++;
    } else {
      panner.pan.value = foot * 0.06;
      source.connect(tone).connect(gain).connect(panner).connect(room);
      if (settle) stats.settles++;
      else stats.footsteps++;
    }
    source.start(now);
  }

  // strength 0–1; `at` ([x, y, z]) where the cloth was touched, `distance` in metres.
  function rustle(strength = 0.5, { at = null, distance = 0 } = {}) {
    if (!ready()) return;
    const amount = clamp(strength, 0, 1) * clamp(1 - distance / 3, 0.25, 1);
    if (amount < 0.02) return;
    const now = context.currentTime, duration = 0.28 + Math.random() * 0.25;
    const source = context.createBufferSource(), high = context.createBiquadFilter(), presence = context.createBiquadFilter();
    const gain = context.createGain(), panner = at ? placed(at) : context.createGain();
    source.buffer = clothBuffer;
    high.type = 'highpass'; high.frequency.value = 900 + Math.random() * 500;
    presence.type = 'peaking'; presence.frequency.value = 3200 + Math.random() * 1800; presence.gain.value = 5; presence.Q.value = 0.8;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16 * amount, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0004, now + duration);
    source.connect(high).connect(presence).connect(gain).connect(panner).connect(room);
    source.start(now, Math.random() * 2.2, duration + 0.05);
    stats.rustles++;
  }

  // Electricity in the walls when a circuit completes: the mains hum surges as
  // the lights stutter, crackles at each stutter (`crackles`, seconds from
  // now) from the lamp `at` ([x, y, z]), dies with the lights and hums back
  // faintly as they return.
  function surge(crackles = [], { length = 1.6, at = null } = {}) {
    if (!ready()) return;
    const now = context.currentTime;
    const mains = context.createOscillator(), ballast = context.createOscillator();
    const mainsGain = context.createGain(), ballastGain = context.createGain();
    const shape = context.createWaveShaper(), band = context.createBiquadFilter(), level = context.createGain();
    mains.type = 'sawtooth'; mains.frequency.value = 60;
    // A lamp ballast a little sour against the mains.
    ballast.type = 'square'; ballast.frequency.value = 120.4;
    mainsGain.gain.value = 0.6; ballastGain.gain.value = 0.25;
    shape.curve = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(3 * (i / 512 - 1)));
    band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 0.45;
    level.gain.setValueAtTime(0, now);
    level.gain.linearRampToValueAtTime(0.16, now + 0.025);
    level.gain.setValueAtTime(0.16, now + 0.3);
    level.gain.exponentialRampToValueAtTime(0.004, now + 0.42);
    level.gain.linearRampToValueAtTime(0.05, now + 1.0);
    level.gain.exponentialRampToValueAtTime(0.0005, now + length);
    mains.connect(mainsGain).connect(shape);
    ballast.connect(ballastGain).connect(shape);
    shape.connect(band).connect(level).connect(room);
    mains.start(now); ballast.start(now);
    mains.stop(now + length + 0.1); ballast.stop(now + length + 0.1);
    // Arcing contacts: short dry crackles, fainter from a lamp across the room.
    const lamp = at ? placed(at) : room, near = at ? clamp(2 / Math.max(2, Math.hypot(at[0] - head.x, at[2] - head.z)), 0.35, 1) : 1;
    if (at) lamp.connect(room);
    for (const delay of crackles) {
      const source = context.createBufferSource(), high = context.createBiquadFilter(), gain = context.createGain(), when = now + delay;
      source.buffer = clothBuffer;
      high.type = 'highpass'; high.frequency.value = 2200;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.25 * near, when + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.035 + Math.random() * 0.03);
      source.connect(high).connect(gain).connect(lamp);
      source.start(when, Math.random() * 2.5, 0.08);
    }
    stats.surges++;
  }

  // A changed room is heard before it is seen: the drone and the record drop
  // out, then return a little lower and slower when the dream state is active.
  function setPhase(value, { dip = true } = {}) {
    const changed = value !== phase;
    phase = value;
    if (!ready() || !changed) return;
    const now = context.currentTime, back = now + (dip ? 1.6 : 0);
    if (dip) {
      droneLevel.gain.cancelScheduledValues(now);
      droneLevel.gain.setTargetAtTime(0, now, 0.06);
      droneLevel.gain.setTargetAtTime(0.2, back, 0.9);
    }
    for (const oscillator of tones) oscillator.detune.setTargetAtTime(phase === 'dream' ? -40 : 0, back, 1.2);
    droneFilter.frequency.setTargetAtTime(phase === 'dream' ? 280 : 340, back, 1.2);
    if (record?.chain) {
      const rate = phase === 'dream' ? DREAM_RATE : 1;
      if (dip) {
        record.chain.hush.gain.cancelScheduledValues(now);
        record.chain.hush.gain.setTargetAtTime(0, now, 0.06);
        record.chain.hush.gain.setTargetAtTime(1, back, 0.9);
        // The record changes speed in the silence, not under the listener.
        setTimeout(() => { record.element.playbackRate = rate; }, 300);
      } else record.element.playbackRate = rate;
    }
    stats.shifts++;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!context) return;
      if (document.hidden) {
        context.suspend().catch(() => {});
        record?.element.pause();
      } else if (started) {
        context.resume().catch(() => {});
        if (record?.chain) record.element.play().catch(() => {});
      }
    });
  }

  return {
    start, setLevel, setMuted, setListener, footstep, rustle, setPhase, surge, loadVoices, loadFootsteps, speak, loadMusic, placeMusic,
    inspect: () => ({
      state: context?.state ?? 'idle', started, muted, level, phase, clips: clips.size, steps: steps.length, ...stats,
      listener: { position: [head.x, head.y, head.z], forward: [head.fx, head.fy, head.fz] },
      music: record && { connected: !!record.chain, failed: record.failed, playing: !record.element.paused,
        time: +record.element.currentTime.toFixed(1), rate: record.element.playbackRate, ...record.placed },
    }),
  };
}
