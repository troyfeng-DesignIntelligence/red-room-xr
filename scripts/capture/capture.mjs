// Records the room as video, frame by frame, from a shot list (README: 录制视频).
//
//   node scripts/capture/capture.mjs [--shots scripts/capture/shots/rules.mjs]
//     [--format vertical,horizontal] [--fps 24] [--only statue,blackout]
//     [--scale 1] [--subframes 6] [--shutter 180] [--crf 14] [--chroma 420]
//     [--no-subtitles] [--no-music] [--no-lens] [--preview] [--out captures/<name>]
//
// Each format is a separate take in headless Chrome at the format's own size.
// The page's clock is stepped a fraction of a frame at a time (runtime.js), so
// camera moves keep their pace however long a frame takes to draw and capture.
// The frames rendered while the shutter is open are averaged in the page and
// developed through the shot list's lens (lens.js: soft focus, mist,
// halation, a veil over the blacks, vignette, gate weave); each frame is then
// a screenshot (the picture with its subtitles and the flicker over it) piped
// into ffmpeg. The sound of the whole take is rendered offline in step with
// the frames and written as WAV, then cut to each shot and muxed. Out come one
// clip per shot (with its WAV), the shots joined in order, the whole take's
// sound and a cover still. The local record plays where the shot list asks
// for it; --no-music keeps it out. --preview: half size, quicker encoding.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer, projectRoot } from '../../server.mjs';
import { installCapture } from './runtime.js';
import { installDirector } from './director.js';
import { installLens } from './lens.js';
import { cameraPath } from './path.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const EYE = 1.65;  // main.js
// Peaks held 1 dB under full scale where the sound is encoded to AAC.
const LIMIT = 'alimiter=limit=0.891:attack=5:release=50:level=false';

function options(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };
  const preview = argv.includes('--preview');
  const number = name => (value(name, null) === null ? null : Number(value(name, null)));
  return {
    shots: resolve(projectRoot, value('shots', 'scripts/capture/shots/rules.mjs')),
    formats: value('format', null)?.split(',').map(name => name.trim()).filter(Boolean) ?? null,
    only: value('only', null)?.split(',').map(name => name.trim()).filter(Boolean) ?? null,
    fps: number('fps'),
    scale: Number(value('scale', preview ? 0.5 : 1)),
    subframes: number('subframes'),
    shutter: number('shutter'),
    crf: Number(value('crf', preview ? 20 : 14)),
    preset: preview ? 'veryfast' : 'slow',
    chroma: value('chroma', '420') === '444' ? 'yuv444p' : 'yuv420p',
    subtitles: !argv.includes('--no-subtitles'),
    music: !argv.includes('--no-music'),
    lens: !argv.includes('--no-lens'),
    out: value('out', null),
    seed: number('seed'),
  };
}

function run(args, { level = 'error' } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(FFMPEG, ['-y', '-hide_banner', '-nostats', '-loglevel', level, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.on('error', fail);
    child.on('close', code => code === 0 ? done(errors) : fail(new Error(`ffmpeg ${args.at(-1)}: ${errors.trim() || code}`)));
  });
}

// Integrated loudness (LUFS) of a stretch of a sound file, as EBU R128 measures it.
async function loudness(file, start, seconds, filters) {
  const report = await run(['-ss', start.toFixed(6), '-t', seconds.toFixed(6), '-i', file, '-af', `${filters},ebur128`, '-f', 'null', '-'], { level: 'info' });
  return Number(report.match(/I:\s+(-?[\d.]+) LUFS\s+Threshold/s)?.[1] ?? NaN);
}

// PNG frames in, H.264 out, the colours converted as BT.709 (ffmpeg's default
// matrix would shift the reds).
function encoder(file, { fps, filters, crf, preset, pixfmt }) {
  const child = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', [...filters, 'scale=out_color_matrix=bt709:out_range=tv', `format=${pixfmt}`].join(','), '-r', String(fps),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-colorspace', 'bt709', '-color_primaries', 'bt709',
    '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  child.stdin.on('error', () => {});
  const closed = new Promise((done, fail) => child.on('close', code => code === 0 ? done() : fail(new Error(`ffmpeg ${basename(file)}: ${errors.trim() || code}`))));
  return {
    write: async frame => { if (!child.stdin.write(frame)) await once(child.stdin, 'drain'); },
    close: () => { child.stdin.end(); return closed; },
  };
}

const css = ({ bottom = '9vh', en = '2.2vw', zh = '1.7vw', width = '88vw' } = {}, show = true) => `
#subtitle{bottom:${bottom}!important;width:${width}!important;${show ? '' : 'display:none!important;'}}
#subtitle-en{font-size:${en}!important}#subtitle-zh{font-size:${zh}!important}
*{cursor:none!important}`;

async function take({ list, format, name, settings, base, out }) {
  const fps = settings.fps ?? list.fps ?? 24, sub = Math.max(1, Math.round(settings.subframes ?? list.subframes ?? 1));
  const shutter = Math.min(360, Math.max(1, settings.shutter ?? list.shutter ?? 180));
  // Of each frame's subframes, the first `open` are exposed and averaged.
  const rate = fps * sub, step = 1000 / rate, open = Math.min(sub, Math.max(1, Math.round(sub * shutter / 360)));
  const width = Math.round(format.size[0] * settings.scale / 2) * 2, height = Math.round(format.size[1] * settings.scale / 2) * 2;
  const shots = list.shots.filter(shot => !settings.only || settings.only.includes(shot.name));
  if (!shots.length) throw new Error(`No shots named ${settings.only.join(', ')} in ${list.name}.`);
  const preroll = list.preroll ?? 3, seed = settings.seed ?? list.seed ?? 1;
  const seconds = preroll + shots.reduce((sum, shot) => sum + Math.round(shot.duration * fps) / fps, 0) + 2;
  const lens = settings.lens && (list.lens || sub > 1) ? { ...(list.lens ?? {}), ...(format.lens ?? {}), seed } : sub > 1 ? { seed } : null;
  const music = settings.music && list.music ? list.music : null;
  const folder = resolve(out, name), work = join(folder, '.frames');
  // The folder itself stays (it may be open in Explorer); what was in it goes.
  await mkdir(folder, { recursive: true });
  for (const entry of await readdir(folder)) await rm(join(folder, entry), { recursive: true, force: true });
  await mkdir(join(folder, 'shots'), { recursive: true });
  await mkdir(work, { recursive: true });
  console.log(`${name}: ${width}×${height}, ${fps} fps, ${sub > 1 ? `${sub} subframes at ${shutter}°, ` : ''}${shots.length} shots, ${(seconds - preroll - 2).toFixed(1)} s${music ? ', with the record' : ''}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    if (!music) await context.route('**/assets/music/**', route => route.abort());
    await context.addInitScript({ content: `(${installCapture})(window, ${JSON.stringify({ seed, sampleRate: 48000, seconds, music: music && { from: music.from ?? 0, at: preroll } })});` });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/music|ERR_FAILED/i.test(message.text())) errors.push(message.text().slice(0, 300)); });
    const query = new URLSearchParams({ debug: '' });
    if (list.look) query.set('look', list.look);
    if (format.frame) query.set('frame', format.frame);
    await page.goto(`${base}/?${query.toString().replace('debug=', 'debug')}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__redRoom?.state.ready && document.body.classList.contains('ready'), null, { timeout: 90000 });
    await page.addStyleTag({ content: css(format.subtitles, settings.subtitles) });
    // In, as a visitor would come in; then the sound decoded and the entry's fades done.
    await page.mouse.click(width / 2, height / 2);
    const lines = await page.evaluate(() => fetch('./assets/voices/manifest.json').then(response => response.json()).then(manifest => manifest.lines.length).catch(() => 0));
    await page.waitForFunction(count => { const sound = window.__redRoom.audio.inspect(); return sound.started && sound.steps > 0 && sound.clips >= count; }, lines, { timeout: 60000 });
    await page.waitForFunction(() => window.__capture.inspect().media?.state !== 'decoding', null, { timeout: 60000 });
    await page.waitForTimeout(4800);
    const record = await page.evaluate(() => window.__capture.inspect().media);
    if (music && record?.state !== 'playing') console.warn(`  the record is not playing (${record?.state ?? 'no file'}${record?.error ? `: ${record.error}` : ''})`);
    await page.evaluate(`(${installDirector})(window, ${JSON.stringify({ eye: EYE, music: music && { gain: music.gain, cutoff: music.cutoff } })})`);
    if (lens) await page.evaluate(`(${installLens})(window, window.__redRoom.renderer.domElement, ${JSON.stringify(lens)})`);
    const cdp = await context.newCDPSession(page);
    const capture = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');

    const origin = await page.evaluate(grid => window.__capture.begin(250, grid), 1000 / fps);
    let tick = 0;
    // A subframe: the next step of the clock, with what happens in it.
    const subframe = (pose, { events = [], steps = false, bob = 1, take = null } = {}) => ({ at: origin + ++tick * step, pose, events, steps, bob, take });
    const frames = batch => batch.length ? page.evaluate(list => window.__director.frames(list), batch) : null;
    // The room settles round the first place before anything is kept.
    const paths = shots.map((shot, index) => cameraPath(shot.keys, { eye: EYE, fov: format.fov, aspect: width / height,
      drift: (shot.drift ?? list.drift) ? { ...list.drift, ...shot.drift, seed: seed + index } : null }));
    await page.evaluate(([pose]) => window.__director.setup({}, undefined, pose), [paths[0](0)]);
    for (let i = 0; i < Math.round(preroll * rate); i += 12) await frames(Array.from({ length: Math.min(12, Math.round(preroll * rate) - i) }, () => subframe(paths[0](0))));

    const timeline = [];
    for (const [index, shot] of shots.entries()) {
      const path = paths[index], count = Math.round(shot.duration * fps), length = count / fps;
      const events = [...(shot.events ?? [])].sort((a, b) => a.t - b.t);
      await page.evaluate(([setup, seed, pose]) => window.__director.setup(setup, seed, pose), [shot.setup ?? {}, seed + (index + 1) * 7919, path(0)]);
      const number = String(list.shots.indexOf(shot) + 1).padStart(2, '0'), file = join(work, `${number}-${shot.name}.mp4`);
      const fades = [];
      if (shot.fade?.in) fades.push(`fade=t=in:st=0:d=${shot.fade.in}`);
      if (shot.fade?.out) fades.push(`fade=t=out:st=${(length - shot.fade.out).toFixed(3)}:d=${shot.fade.out}`);
      const video = encoder(file, { fps, filters: fades, crf: settings.crf, preset: settings.preset, pixfmt: settings.chroma });
      const started = Date.now();
      let next = 0, start = 0, closed = [];
      const at = (f, s) => {
        const t = (f * sub + s) / rate, due = [];
        while (next < events.length && events[next].t <= t + 1e-9) due.push(events[next++]);
        return { t, due };
      };
      for (let f = 0; f < count; f++) {
        // The shutter opens: the frame's first subframes are exposed together.
        const batch = closed;
        for (let s = 0; s < open; s++) {
          const { t, due } = at(f, s);
          batch.push(subframe(path(t), { events: due, steps: !!shot.steps, bob: shot.bob ?? 1, take: [s, open] }));
        }
        await frames(batch);
        if (f === 0) start = (tick - open + 1) * step / 1000;
        const png = await capture();
        if (shot.cover !== undefined && f === Math.round(shot.cover * fps)) await writeFile(join(folder, `cover-${shot.name}.png`), png);
        await video.write(png);
        // The rest of the frame passes with the shutter closed.
        closed = [];
        for (let s = open; s < sub; s++) {
          const { t, due } = at(f, s);
          closed.push(subframe(path(t), { events: due, steps: !!shot.steps, bob: shot.bob ?? 1 }));
        }
      }
      await frames(closed);
      await video.close();
      const state = await page.evaluate(() => window.__director.inspect());
      timeline.push({ name: shot.name, number, file, start, seconds: length, state });
      console.log(`  ${number} ${shot.name}: ${length.toFixed(2)} s in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }

    // The whole take's sound, then each shot with its stretch of it.
    const sound = await page.evaluate(() => window.__capture.finish());
    const parts = [];
    for (let at = 0; at < sound.bytes; at += 4 << 20) parts.push(Buffer.from(await page.evaluate(([s, n]) => window.__capture.collect(s, n), [at, 4 << 20]), 'base64'));
    const wav = join(folder, 'sound.wav');
    await writeFile(wav, Buffer.concat(parts));
    for (const shot of timeline) {
      const clip = join(folder, 'shots', `${shot.number}-${shot.name}`);
      await run(['-i', shot.file, '-ss', shot.start.toFixed(6), '-t', shot.seconds.toFixed(6), '-i', wav, '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-af', LIMIT, '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', `${clip}.mp4`]);
      await run(['-ss', shot.start.toFixed(6), '-t', shot.seconds.toFixed(6), '-i', wav, '-c:a', 'pcm_s16le', `${clip}.wav`]);
    }
    // The joined film is brought to the platforms' loudness (list.loudness,
    // LUFS); the shots keep the level they were rendered at.
    const joined = join(work, 'shots.txt'), total = timeline.reduce((sum, shot) => sum + shot.seconds, 0);
    await writeFile(joined, timeline.map(shot => `file '${shot.file.replaceAll('\\', '/')}'`).join('\n'));
    const fade = `afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2`, target = list.loudness ?? -14;
    const measured = await loudness(wav, timeline[0].start, total, fade);
    const gain = Number.isFinite(measured) && target !== null ? target - measured : 0;
    await run(['-f', 'concat', '-safe', '0', '-i', joined, '-ss', timeline[0].start.toFixed(6), '-t', total.toFixed(6), '-i', wav,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', `${fade},volume=${gain.toFixed(2)}dB,${LIMIT}`,
      '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', join(folder, `${name}.mp4`)]);
    await rm(work, { recursive: true, force: true });
    const report = { name, size: [width, height], fps, subframes: sub, shutter, lens, music: music && { ...music, record }, seconds: total, preroll, seed,
      sound: { peak: +sound.peak.toFixed(3), loudness: measured, gain: +gain.toFixed(2) },
      shots: timeline.map(shot => ({ name: shot.name, start: +shot.start.toFixed(3), seconds: shot.seconds, state: shot.state })), errors };
    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`  → ${relative(projectRoot, join(folder, `${name}.mp4`))} (${total.toFixed(2)} s, sound peak ${sound.peak.toFixed(2)})${errors.length ? `, ${errors.length} page errors (report.json)` : ''}`);
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  const settings = options(process.argv.slice(2));
  const list = (await import(pathToFileURL(settings.shots))).default;
  const formats = settings.formats ?? Object.keys(list.formats);
  const out = resolve(projectRoot, settings.out ?? join('captures', list.name));
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const name of formats) {
      const format = list.formats[name];
      if (!format) throw new Error(`No format "${name}" in ${list.name}: ${Object.keys(list.formats).join(', ')}.`);
      await take({ list, format, name: `${list.name}-${name}`, settings, base, out });
    }
  } finally {
    server.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
