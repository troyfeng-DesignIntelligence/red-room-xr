// Frame-exact recording (capture.mjs). Installed in the page before its own
// scripts: until a take begins the page runs as usual; from then on its clock
// stands still between frames and moves only when the recorder steps it, so a
// frame that takes half a second to capture is still 1/60 s of the room.
// Timers, animation frames, performance.now and Date.now follow that clock, CSS
// transitions are held to it, Math.random is seeded so a take can be repeated,
// and the sound is rendered offline, in step with the frames, instead of
// playing: an OfflineAudioContext stands in for the page's AudioContext.
//
// Serialised into the page (Function.prototype.toString), so it must not use
// anything from this module's scope. `config`: { seed, sampleRate, seconds,
// music }: how much sound the take can hold, and where the record's song
// should be: `from` seconds into it at `at` seconds into the take.
export function installCapture(win, { seed = 1, sampleRate = 48000, seconds = 60, music = null } = {}) {
  const perf = win.performance;
  const real = {
    now: perf.now.bind(perf),
    dateNow: win.Date.now.bind(win.Date),
    setTimeout: win.setTimeout.bind(win),
    setInterval: win.setInterval.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    requestAnimationFrame: win.requestAnimationFrame?.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame?.bind(win),
  };

  // The same choices on every take (mulberry32, as the tests use).
  let state = 0;
  const reseed = value => { state = value >>> 0; };
  win.Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  reseed(seed);

  // The clock: null while the page runs on real time, then milliseconds.
  let now = null, dateOffset = 0, nextId = 1e9;
  const timers = new Map(), frames = new Map();
  perf.now = () => now ?? real.now();
  win.Date.now = () => now === null ? real.dateNow() : Math.floor(now + dateOffset);
  const schedule = (fn, delay, args, repeat) => {
    const id = nextId++, wait = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, at: now + wait, fn, args, every: repeat ? Math.max(1, wait) : 0, order: id });
    return id;
  };
  win.setTimeout = (fn, delay, ...args) => now === null ? real.setTimeout(fn, delay, ...args) : schedule(fn, delay, args, false);
  win.setInterval = (fn, delay, ...args) => now === null ? real.setInterval(fn, delay, ...args) : schedule(fn, delay, args, true);
  // Timeouts and intervals share their numbers, as in the browser.
  win.clearTimeout = win.clearInterval = id => { if (!timers.delete(id)) real.clearTimeout(id); };
  win.requestAnimationFrame = fn => {
    if (now === null) return real.requestAnimationFrame(fn);
    const id = nextId++;
    frames.set(id, fn);
    return id;
  };
  win.cancelAnimationFrame = id => { if (!frames.delete(id)) real.cancelAnimationFrame?.(id); };

  // Fires every timer due by `until` in time order, each at its own time.
  function fire(until) {
    for (;;) {
      let next = null;
      for (const timer of timers.values()) {
        if (timer.at <= until && (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order))) next = timer;
      }
      if (!next) break;
      now = Math.max(now, next.at);
      if (next.every) { next.at += next.every; next.order = nextId++; } else timers.delete(next.id);
      if (typeof next.fn === 'function') {
        try { next.fn(...next.args); } catch (error) { console.error(error); }
      }
    }
    now = until;
  }

  // Draws a frame: the callbacks waiting for one, with the clock's time.
  function paint() {
    const due = [...frames.values()];
    frames.clear();
    for (const fn of due) {
      try { fn(now); } catch (error) { console.error(error); }
    }
  }

  // CSS transitions (the subtitles' fades) are held and moved with the clock.
  const born = new WeakMap();
  function hold() {
    for (const animation of win.document?.getAnimations?.() ?? []) {
      if (!born.has(animation)) { born.set(animation, now); animation.pause(); }
      animation.currentTime = Math.max(0, now - born.get(animation));
    }
  }

  // The page's sound, rendered offline. Its own resume and suspend calls change
  // nothing. A media element (the local record) cannot feed an offline
  // context, so its file is decoded and played from a buffer instead, at the
  // element's playbackRate as the page changes it; the element itself is muted.
  const Offline = win.OfflineAudioContext;
  let audio = null, media = null;
  function CaptureAudioContext() {
    const context = new Offline({ numberOfChannels: 2, length: Math.ceil(seconds * sampleRate), sampleRate });
    context.resume = () => Promise.resolve();
    context.suspend = () => Promise.resolve();
    context.createMediaElementSource = element => {
      const output = context.createGain();
      let rate = element.playbackRate || 1, node = null;
      element.muted = true;
      Object.defineProperty(element, 'playbackRate', {
        configurable: true, get: () => rate,
        set: value => { rate = value; node?.playbackRate.setValueAtTime(value, context.currentTime); },
      });
      media = { state: 'decoding' };
      win.fetch(element.currentSrc || element.src)
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${response.status}`)))
        .then(bytes => context.decodeAudioData(bytes))
        .then(buffer => {
          node = context.createBufferSource();
          Object.assign(node, { buffer, loop: true });
          node.playbackRate.value = rate;
          node.connect(output);
          // Without `music`, wherever the page had put it.
          const lead = music ? music.at - music.from : -(element.currentTime || 0);
          if (lead >= 0) node.start(lead, 0);
          else node.start(0, -lead % buffer.duration);
          media = { state: 'playing', seconds: buffer.duration };
        })
        .catch(error => { media = { state: 'failed', error: error.message }; });
      return output;
    };
    audio = {
      context, frame: 0, rendering: null, origin: now,
      resume: () => Offline.prototype.resume.call(context),
      suspend: time => Offline.prototype.suspend.call(context, time),
    };
    return context;
  }
  if (Offline) win.AudioContext = win.webkitAudioContext = CaptureAudioContext;

  // Renders the sound up to `until` (clock milliseconds), to the nearest
  // 128-sample block, where it stops again.
  async function hear(until) {
    if (!audio || audio.origin === null) return;
    const quantum = 128, last = Math.floor(audio.context.length / quantum) * quantum - quantum;
    const frame = Math.min(last, Math.round((until - audio.origin) / 1000 * sampleRate / quantum) * quantum);
    if (frame <= audio.frame) return;
    const reached = audio.suspend(frame / sampleRate);
    if (audio.rendering) await audio.resume();
    else audio.rendering = audio.context.startRendering();
    await reached;
    audio.frame = frame;
  }

  // 16-bit PCM WAV of a rendered buffer.
  function wav(buffer) {
    const channels = buffer.numberOfChannels, length = buffer.length, size = length * channels * 2;
    const bytes = new Uint8Array(44 + size), view = new DataView(bytes.buffer);
    const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, size, true);
    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let at = 44, peak = 0;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        const value = Math.max(-1, Math.min(1, data[c][i]));
        peak = Math.max(peak, Math.abs(value));
        view.setInt16(at, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        at += 2;
      }
    }
    return { bytes, peak };
  }

  let rendered = null;
  win.__capture = {
    // From here the clock is the recorder's: it starts a little ahead of real
    // time, so a frame the browser had already asked for cannot land later,
    // and just past a multiple of `grid` ms (the film's frame), so the page's
    // own once-a-frame changes (the grain) fall between the recorder's frames.
    begin(ahead = 250, grid = 0) {
      if (now !== null) return now;
      now = real.now() + ahead;
      if (grid > 0) now = Math.ceil(now / grid) * grid + grid * 1e-3;
      dateOffset = real.dateNow() - real.now();
      if (audio) audio.origin = now;
      reseed(seed);
      return now;
    },
    seed: reseed,
    now: () => now,
    // To `until` ms: the sound rendered, then every timer due by then fired.
    async advance(until) {
      if (now === null || until < now) throw new Error(`The clock cannot go from ${now} to ${until}.`);
      await hear(until);
      fire(until);
    },
    // The frame at the present time; the page's transitions held to it.
    paint() { paint(); hold(); },
    // Renders the rest of the sound and keeps it as WAV for collect().
    async finish() {
      if (!audio) return null;
      if (audio.rendering) await audio.resume();
      else audio.rendering = audio.context.startRendering();
      const buffer = await audio.rendering, { bytes, peak } = wav(buffer);
      rendered = bytes;
      return { bytes: bytes.length, peak, seconds: buffer.duration, sampleRate: buffer.sampleRate };
    },
    // A slice of the WAV, base64, for the recorder to write out.
    collect(start, size) {
      const part = rendered.subarray(start, start + size);
      let binary = '';
      for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
      return win.btoa(binary);
    },
    inspect: () => ({
      now, timers: timers.size, frames: frames.size, media,
      audio: audio && { origin: audio.origin, frame: audio.frame, length: audio.context.length, state: audio.context.state },
    }),
  };
}
