// Procedural room sound, no audio files: a low drone that breathes, footfalls
// on the linoleum and the rustle of velvet. Footsteps and cloth pass through a
// short, dark room response: the curtains swallow the highs and the tail.
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

export function createRoomAudio({ storageKey = 'red-room-audio' } = {}) {
  let context = null, master = null, room = null, droneLevel = null, droneFilter = null;
  let whiteBuffer = null, clothBuffer = null, voices = [];
  let muted = false, level = 1, started = false, phase = 'normal', side = 1;
  const stats = { footsteps: 0, rustles: 0, shifts: 0 };
  try { muted = localStorage.getItem(storageKey) === 'muted'; } catch {}

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

    whiteBuffer = noise(context, 2);
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
    droneFilter.connect(breath).connect(droneLevel).connect(master);
    // Two beating fundamentals, an octave of presence for small speakers and a
    // faint mains buzz: electricity somewhere behind the curtains.
    for (const [frequency, type, gain] of [[55, 'triangle', 0.3], [55.37, 'triangle', 0.26], [110.15, 'sawtooth', 0.045], [82.6, 'sine', 0.035], [60, 'sawtooth', 0.012]]) {
      const oscillator = context.createOscillator(), voiceGain = context.createGain();
      oscillator.type = type; oscillator.frequency.value = frequency; voiceGain.gain.value = gain;
      oscillator.connect(voiceGain).connect(droneFilter);
      oscillator.start();
      if (frequency !== 60) voices.push(oscillator);
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
        for (const oscillator of voices) oscillator.detune.value = -40;
        droneFilter.frequency.value = 280;
      }
      apply(2.2);
    }
    return true;
  }

  function setLevel(value, seconds = 0.8) {
    level = clamp(value, 0, 1);
    apply(seconds);
  }

  function setMuted(value) {
    muted = !!value;
    try { localStorage.setItem(storageKey, muted ? 'muted' : 'on'); } catch {}
    apply(0.3);
    return muted;
  }

  function footstep(intensity = 1) {
    if (!ready()) return;
    const now = context.currentTime, strength = clamp(intensity, 0.15, 1);
    side = -side;
    const panner = context.createStereoPanner();
    panner.pan.value = side * 0.07;
    panner.connect(room);
    // Heel on hard linoleum: a short band of noise...
    const click = context.createBufferSource(), band = context.createBiquadFilter(), clickGain = context.createGain();
    click.buffer = whiteBuffer;
    band.type = 'bandpass'; band.frequency.value = 1300 + Math.random() * 900; band.Q.value = 1.1;
    clickGain.gain.setValueAtTime(0, now);
    clickGain.gain.linearRampToValueAtTime(0.3 * strength, now + 0.002);
    clickGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.07 + Math.random() * 0.025);
    click.connect(band).connect(clickGain).connect(panner);
    click.start(now, Math.random() * 1.5, 0.12);
    // ...over the soft weight of the step.
    const thump = context.createOscillator(), thumpGain = context.createGain();
    thump.frequency.setValueAtTime(115, now);
    thump.frequency.exponentialRampToValueAtTime(55, now + 0.09);
    thumpGain.gain.setValueAtTime(0, now);
    thumpGain.gain.linearRampToValueAtTime(0.2 * strength, now + 0.004);
    thumpGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.12);
    thump.connect(thumpGain).connect(panner);
    thump.start(now); thump.stop(now + 0.14);
    stats.footsteps++;
  }

  // strength 0–1, pan -1 (left) to 1 (right), distance in metres.
  function rustle(strength = 0.5, pan = 0, distance = 0) {
    if (!ready()) return;
    const amount = clamp(strength, 0, 1) * clamp(1 - distance / 3, 0.25, 1);
    if (amount < 0.02) return;
    const now = context.currentTime, duration = 0.28 + Math.random() * 0.25;
    const source = context.createBufferSource(), high = context.createBiquadFilter(), presence = context.createBiquadFilter();
    const gain = context.createGain(), panner = context.createStereoPanner();
    source.buffer = clothBuffer;
    high.type = 'highpass'; high.frequency.value = 900 + Math.random() * 500;
    presence.type = 'peaking'; presence.frequency.value = 3200 + Math.random() * 1800; presence.gain.value = 5; presence.Q.value = 0.8;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16 * amount, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0004, now + duration);
    panner.pan.value = clamp(pan, -1, 1);
    source.connect(high).connect(presence).connect(gain).connect(panner).connect(room);
    source.start(now, Math.random() * 2.2, duration + 0.05);
    stats.rustles++;
  }

  // A changed room is heard before it is seen: the drone drops out, then
  // returns a little lower and slower when the dream state is active.
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
    for (const oscillator of voices) oscillator.detune.setTargetAtTime(phase === 'dream' ? -40 : 0, back, 1.2);
    droneFilter.frequency.setTargetAtTime(phase === 'dream' ? 280 : 340, back, 1.2);
    stats.shifts++;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!context) return;
      if (document.hidden) context.suspend().catch(() => {});
      else if (started) context.resume().catch(() => {});
    });
  }

  return {
    start, setLevel, setMuted, footstep, rustle, setPhase,
    inspect: () => ({ state: context?.state ?? 'idle', started, muted, level, phase, ...stats }),
  };
}
