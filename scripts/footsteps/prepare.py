"""Cuts a recording of footsteps into single steps for the room.

Source: BigSoundBank #0165, "Man Footsteps on the Wooden Floor" by DavidGreck,
CC0 1.0 (public domain), https://bigsoundbank.com/man-footsteps-on-the-wooden-floor-s0165.html
A man in shoes walking on a wooden floor in a studio: thirteen steps, each a
heel strike and the toe about a tenth of a second later.

Writes dist/assets/footsteps/steps.wav, the steps one after another in equal
slots, and steps.json, where each step starts and how long it lasts. Each step
keeps its own heel and toe and its natural tail; only the rumble below 45 Hz
goes, and every step is brought to the same loudness so the room can vary it.

    python scripts/footsteps/prepare.py
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, find_peaks, sosfiltfilt

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'source' / 'bigsoundbank-0165.aiff'
OUT = HERE.parents[1] / 'dist' / 'assets' / 'footsteps'
SLOT = 0.5          # seconds per step in the sprite
LENGTH = 0.46       # longest step kept, heel to the end of its tail
TARGET_RMS = -18.0  # dBFS over the first 150 ms of each step
CEILING = -1.0      # dBFS peak


def envelope(x, rate, window=0.003):
    detect = sosfiltfilt(butter(4, 100, 'highpass', fs=rate, output='sos'), x)
    size = max(1, int(rate * window))
    return 20 * np.log10(np.sqrt(np.convolve(detect ** 2, np.ones(size) / size, 'same')) + 1e-9)


def main():
    x, rate = sf.read(SOURCE, dtype='float64')
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = sosfiltfilt(butter(2, 45, 'highpass', fs=rate, output='sos'), x)
    level = envelope(x, rate)
    floor = np.percentile(level, 10)
    peaks, _ = find_peaks(level, height=floor + 25, distance=int(rate * 0.35), prominence=15)
    # Heel strikes only: toes and tails are much quieter than the steps around them.
    strong = np.median(level[peaks])
    peaks = peaks[level[peaks] > strong - 12]

    steps, sprite = [], []
    for n, peak in enumerate(peaks):
        # The onset: back from the peak to where the strike rises out of the quiet.
        onset = peak
        while onset > peak - int(rate * 0.04) and level[onset] > level[peak] - 30:
            onset -= 1
        start = max(0, onset - int(rate * 0.004))
        end = start + int(rate * LENGTH)
        if n + 1 < len(peaks):
            end = min(end, peaks[n + 1] - int(rate * 0.03))
        step = x[start:end].copy()
        fade_in, fade_out = int(rate * 0.0015), int(rate * 0.09)
        step[:fade_in] *= np.linspace(0, 1, fade_in)
        step[-fade_out:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade_out))
        head = step[:int(rate * 0.15)]
        gain = 10 ** ((TARGET_RMS - 20 * np.log10(np.sqrt(np.mean(head ** 2)))) / 20)
        gain = min(gain, 10 ** (CEILING / 20) / np.abs(step).max())
        step *= gain
        slot = np.zeros(int(rate * SLOT))
        slot[:len(step)] = step
        steps.append({'at': round(len(sprite) * SLOT, 4), 'length': round(len(step) / rate, 4)})
        sprite.append(slot)
        print(f'step {n + 1:2d}: {start / rate:5.2f}s, {len(step) / rate * 1000:3.0f} ms, gain {20 * np.log10(gain):+5.1f} dB, '
              f'peak {20 * np.log10(np.abs(step).max()):5.1f} dBFS')

    OUT.mkdir(parents=True, exist_ok=True)
    sf.write(OUT / 'steps.wav', np.concatenate(sprite), rate, subtype='PCM_16')
    manifest = {
        'source': 'BigSoundBank #0165, "Man Footsteps on the Wooden Floor" by DavidGreck, CC0 1.0',
        'url': 'https://bigsoundbank.com/man-footsteps-on-the-wooden-floor-s0165.html',
        'file': 'steps.wav',
        'steps': steps,
    }
    (OUT / 'steps.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'{len(steps)} steps -> {OUT / "steps.wav"}')


if __name__ == '__main__':
    main()
