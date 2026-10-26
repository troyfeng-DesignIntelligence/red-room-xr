// The lens and the film stock of a recording (capture.mjs), laid over the
// rendered frames in the page before each one is captured. The frames rendered
// while the shutter is open are averaged (motion blur, as a 24 fps film camera
// gives it); then the picture is developed: soft focus, a mist filter's
// diffusion lifting the shadows into haze, red halation round the lit velvet,
// a veil over the blacks, a vignette, the frame weaving a little in the gate,
// and grain on top, sharp, since it is in the film and not in front of it.
// A matte can close the frame down to the 4:3 picture of the 1990–91
// broadcast, black round it. The subtitles and the flicker of the lights stay
// sharp above it all.
// Sizes are pixels on a frame 1080 wide; amounts 0–1. Serialised into the page
// like runtime.js.
export function installLens(win, source, {
  soft = 0, mist = 0, mistRadius = 18, halation = 0, halationRadius = 42,
  veil = 0, vignette = 0, weave = 0, grain = 0, seed = 1,
} = {}) {
  const lens = { soft, mist, halation, veil, vignette };
  const document = win.document;
  const out = document.createElement('canvas'), exposure = document.createElement('canvas');
  out.setAttribute('aria-hidden', 'true');
  // Out of the page's flow from the start: in it, it would push the room aside.
  out.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none';
  source.parentElement.appendChild(out);
  const film = exposure.getContext('2d'), print = out.getContext('2d');

  // The gate's wander: a few sines at unrelated rates, phases from the seed.
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sines = [0, 1].map(() => [[0.7, 0.6], [1.9, 0.3], [4.3, 0.1]].map(([rate, weight]) => [rate, weight, random() * 6.283]));
  const wander = (time, axis) => sines[axis].reduce((sum, [rate, weight, phase]) => sum + weight * Math.sin(6.283 * rate * time + phase), 0);

  // A few tiles of grain around mid-grey, drawn with a new tile and offset
  // every film frame.
  const tiles = grain ? Array.from({ length: 6 }, () => {
    const tile = document.createElement('canvas'), size = 256;
    Object.assign(tile, { width: size, height: size });
    const context = tile.getContext('2d'), image = context.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const value = 128 + (random() + random() - 1) * 110;
      image.data.set([value, value, value, 255], i * 4);
    }
    context.putImageData(image, 0, 0);
    return tile;
  }) : [];

  function fit() {
    const width = source.width, height = source.height;
    for (const canvas of [out, exposure]) if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const box = source.getBoundingClientRect();
    out.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;pointer-events:none`;
  }

  // The picture from the averaged exposure; `matte` 1 shows only its 4:3
  // middle; `haze` scales the lens's softness and glow, from none (the
  // picture as rendered, weave and grain only) to all of it.
  function develop(time, matte, haze) {
    const width = out.width, height = out.height, unit = width / 1080;
    const soft = lens.soft * haze, mist = lens.mist * haze, halation = lens.halation * haze, veil = lens.veil * haze, vignette = lens.vignette * haze;
    const left = width / height < 4 / 3 ? 0 : (width - height * 4 / 3) / 2 * matte;
    const top = width / height < 4 / 3 ? (height - width * 3 / 4) / 2 * matte : 0;
    const dx = weave * unit * wander(time, 0), dy = weave * unit * 0.7 * wander(time, 1);
    // Grown a little, so the weave never shows an edge.
    const grow = 1 + (2 * weave * unit + 2) / Math.min(width, height);
    const place = () => print.setTransform(grow, 0, 0, grow, width * (1 - grow) / 2 + dx, height * (1 - grow) / 2 + dy);
    print.save();
    place();
    print.globalCompositeOperation = 'copy';
    print.filter = soft ? `blur(${soft * unit}px)` : 'none';
    print.drawImage(exposure, 0, 0);
    print.globalCompositeOperation = 'screen';
    if (mist) {
      print.globalAlpha = mist;
      print.filter = `blur(${mistRadius * unit}px)`;
      print.drawImage(exposure, 0, 0);
    }
    if (halation) {
      // Only the bright parts, warmer and wider: the light bleeding back
      // through the film from its base.
      print.globalAlpha = halation;
      print.filter = `blur(${halationRadius * unit}px) brightness(0.8) contrast(2.4) saturate(1.8)`;
      print.drawImage(exposure, 0, 0);
    }
    print.setTransform(1, 0, 0, 1, 0, 0);
    print.filter = 'none';
    print.globalAlpha = 1;
    if (veil) {
      print.fillStyle = `rgba(52, 14, 16, ${veil})`;
      print.fillRect(0, 0, width, height);
    }
    if (vignette) {
      print.globalCompositeOperation = 'multiply';
      const reach = Math.hypot(width - 2 * left, height - 2 * top) / 2, edge = Math.round(255 * (1 - vignette));
      const shade = print.createRadialGradient(width / 2, height / 2, reach * 0.35, width / 2, height / 2, reach);
      shade.addColorStop(0, '#fff');
      shade.addColorStop(1, `rgb(${edge},${edge},${edge})`);
      print.fillStyle = shade;
      print.fillRect(0, 0, width, height);
    }
    if (grain) {
      const frame = Math.round(time * 24), hash = n => { const s = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453; return s - Math.floor(s); };
      const pattern = print.createPattern(tiles[frame % tiles.length], 'repeat');
      pattern.setTransform(new win.DOMMatrix([1.5 * unit, 0, 0, 1.5 * unit, hash(frame) * 256, hash(frame + 0.5) * 256]));
      print.globalCompositeOperation = 'overlay';
      print.globalAlpha = grain;
      print.fillStyle = pattern;
      print.fillRect(0, 0, width, height);
    }
    if (left || top) {
      print.globalCompositeOperation = 'source-over';
      print.globalAlpha = 1;
      print.fillStyle = '#000';
      print.fillRect(0, 0, width, top);
      print.fillRect(0, height - top, width, top);
      print.fillRect(0, 0, left, height);
      print.fillRect(width - left, 0, left, height);
    }
    print.restore();
  }

  win.__lens = {
    // The frame just drawn, as the `index`th of `count` while the shutter is
    // open; the last of them develops the picture, at `time` seconds, behind
    // the matte, with that much haze.
    take(index, count, time, matte = 0, haze = 1) {
      if (index === 0) {
        fit();
        film.globalCompositeOperation = 'copy';
        film.globalAlpha = 1;
      } else {
        film.globalCompositeOperation = 'source-over';
        film.globalAlpha = 1 / (index + 1);
      }
      film.drawImage(source, 0, 0);
      if (index === count - 1) develop(time, matte, haze);
    },
  };
}
