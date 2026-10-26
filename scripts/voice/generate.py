"""Red Room backwards voices: the 1990 method, done by machine (Windows only).

The series had its actors speak their lines phonetically backwards and then
ran the film in reverse. Here the Windows voice gives each word's phonemes,
speaks them reversed as IPA, and the recording is reversed: the words return
in order, every syllable keeps reversed articulation. A light room treatment
follows, then the offline recogniser checks each clip still carries its line.

    python scripts/voice/generate.py                  # from red-room-xr/
    python scripts/voice/generate.py --manifest-only  # triggers / Chinese only
Needs: Windows voices David / Zira, Python with numpy scipy soundfile librosa,
and ffmpeg on PATH. Writes dist/assets/voices/*.mp3 and manifest.json.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, sosfilt

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
OUT = HERE.parent.parent / "dist" / "assets" / "voices"
DLL = BUILD / "RoomVoice.dll"
VOICES = {"David": "Microsoft David Desktop", "Zira": "Microsoft Zira Desktop"}

# SAPI 5 American English phone IDs -> ARPAbet -> IPA.
SAPI = {10: "aa", 11: "ae", 12: "ah", 13: "ao", 14: "aw", 15: "ax", 16: "ay", 17: "b", 18: "ch", 19: "d", 20: "dh",
        21: "eh", 22: "er", 23: "ey", 24: "f", 25: "g", 26: "h", 27: "ih", 28: "iy", 29: "jh", 30: "k", 31: "l",
        32: "m", 33: "n", 34: "ng", 35: "ow", 36: "oy", 37: "p", 38: "r", 39: "s", 40: "sh", 41: "t", 42: "th",
        43: "uh", 44: "uw", 45: "v", 46: "w", 47: "y", 48: "z", 49: "zh"}
IPA = {"aa": "ɑ", "ae": "æ", "ah": "ʌ", "ao": "ɔ", "aw": "aʊ", "ax": "ə", "ay": "aɪ", "b": "b", "ch": "tʃ", "d": "d",
       "dh": "ð", "eh": "ɛ", "er": "ɝ", "ey": "eɪ", "f": "f", "g": "ɡ", "h": "h", "ih": "ɪ", "iy": "i", "jh": "dʒ",
       "k": "k", "l": "l", "m": "m", "n": "n", "ng": "ŋ", "ow": "oʊ", "oy": "ɔɪ", "p": "p", "r": "ɹ", "s": "s",
       "sh": "ʃ", "t": "t", "th": "θ", "uh": "ʊ", "uw": "u", "v": "v", "w": "w", "y": "j", "z": "z", "zh": "ʒ"}
# Glides and affricates run the other way when time does.
REVERSED = {"ay": "iɑ", "aw": "uɑ", "ey": "iɛ", "ow": "uɔ", "oy": "iɔ", "ch": "ʃt", "jh": "ʒd"}
VOWELS = {"aa", "ae", "ah", "ao", "aw", "ax", "ay", "eh", "er", "ey", "ih", "iy", "ow", "oy", "uh", "uw"}


def build_helper():
    BUILD.mkdir(exist_ok=True)
    source = HERE / "RoomVoice.cs"
    if DLL.exists() and DLL.stat().st_mtime > source.stat().st_mtime:
        return
    DLL.unlink(missing_ok=True)
    powershell(f"Add-Type -Path '{source}' -ReferencedAssemblies System.Speech -OutputAssembly '{DLL}' -OutputType Library",
               helper=False)


def powershell(command, helper=True):
    script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
    script += (f"Add-Type -Path '{DLL}'; " if helper else "") + command
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def utf8_file(name, text):
    path = BUILD / name
    path.write_text(text, encoding="utf-8")
    return path


def phrases_of(text):
    """Words grouped between punctuation marks; the voice pauses between groups."""
    return [words for part in re.split(r"[,;:.!?]", text) if (words := re.findall(r"[A-Za-z']+", part))]


def phonemes(voice, words):
    """Each word's ARPAbet phones as the voice itself says the word."""
    raw = powershell(f"[RoomVoice]::Phonemes('{voice}', '{utf8_file('words.txt', chr(10).join(words))}')")
    result = []
    for line in raw.strip().splitlines():
        _, _, ids = line.partition("\t")
        result.append([SAPI[int(i)] for i in ids.split() if int(i) in SAPI])
    return result


def ipa(phones, reverse=False):
    sequence = phones[::-1] if reverse else phones
    first_vowel = next((i for i, p in enumerate(sequence) if p in VOWELS), None)
    return "".join(("ˈ" if i == first_vowel and len(sequence) > 2 else "") +
                   (REVERSED.get(p, IPA[p]) if reverse else IPA[p]) for i, p in enumerate(sequence))


def take_ipa(voice, text):
    """What the voice reads for the take: phrases, words and phones all reversed,
    so the recording played backwards says the line and pauses at its commas."""
    phrases = phrases_of(text)
    phones = iter(phonemes(voice, [word for phrase in phrases for word in phrase]))
    grouped = [[next(phones) for _ in phrase] for phrase in phrases]
    return " | ".join(" ".join(ipa(p, reverse=True) for p in reversed(group) if p) for group in reversed(grouped))


def speak_ipa(voice, text_ipa, name, rate):
    wav = BUILD / name
    powershell(f"[RoomVoice]::SpeakIpa('{voice}', '{utf8_file('ipa.txt', text_ipa)}', '{wav}', {rate})")
    audio, sr = sf.read(wav)
    return (audio.mean(1) if audio.ndim > 1 else audio), sr


def trim(audio, threshold=0.004):
    loud = np.where(np.abs(audio) > threshold)[0]
    return audio[max(0, loud[0] - 400): loud[-1] + 400] if len(loud) else audio


def room(audio, sr, preverb=0.16, seconds=1.2):
    """A touch slower and lower, a reverse reverb that swells into each word,
    a short dark room, an early-90s broadcast band and a little tape."""
    slowed = librosa.effects.time_stretch(audio.astype(np.float32), rate=0.95)
    lowered = librosa.effects.pitch_shift(slowed, sr=sr, n_steps=-0.5)
    rng = np.random.default_rng(7)
    n = int(sr * seconds)
    tail = sosfilt(butter(2, 2500, "low", fs=sr, output="sos"), rng.standard_normal(n) * np.exp(-np.arange(n) / (sr * 0.35)))
    swell = fftconvolve(lowered[::-1], tail / np.sqrt(np.sum(tail ** 2)))[::-1]
    dry = np.pad(lowered, (len(swell) - len(lowered), 0))
    mixed = dry + preverb * swell / (np.max(np.abs(swell)) + 1e-9) * np.max(np.abs(dry))
    short = rng.standard_normal(int(sr * 0.25)) * np.exp(-np.arange(int(sr * 0.25)) / (sr * 0.05))
    mixed = mixed + 0.08 * fftconvolve(mixed, short / np.sqrt(np.sum(short ** 2)))[:len(mixed)]
    mixed = np.tanh(sosfilt(butter(2, [100, 7000], "bandpass", fs=sr, output="sos"), mixed) * 1.3) / np.tanh(1.3)
    return 0.89 * mixed / (np.max(np.abs(mixed)) + 1e-9)


def recognise(wav, candidates):
    picked, _, confidence = powershell(
        f"[RoomVoice]::Recognize('en-US', '{wav}', '{utf8_file('choices.txt', chr(10).join(candidates))}')").rstrip("\r\n").partition("\t")
    return picked, float(confidence or 0)


def entry(line, duration):
    return {key: line[key] for key in ("id", "en", "zh", "source", "trigger", "voice")} | \
        {"file": f"voices/{line['id']}.mp3", "duration": duration}


def write_manifest(entries):
    (OUT / "manifest.json").write_text(json.dumps({"engine": "Windows SAPI double reversal", "lines": entries},
                                                  ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def refresh_manifest(lines):
    """Triggers or Chinese subtitles changed, not the words: keep the clips."""
    known = {line["id"]: line for line in json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["lines"]}
    stale = [line["id"] for line in lines if line["id"] not in known or known[line["id"]]["en"] != line["en"]]
    if stale:
        sys.exit(f"New or changed words need new clips: {', '.join(stale)}. Run without --manifest-only.")
    write_manifest([entry(line, known[line["id"]]["duration"]) for line in lines])
    print(f"manifest refreshed for {len(lines)} existing clips")


def main():
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))["lines"]
    if "--manifest-only" in sys.argv[1:]:
        return refresh_manifest(lines)
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required on PATH")
    build_helper()
    OUT.mkdir(parents=True, exist_ok=True)
    candidates = [line["en"] for line in lines]
    manifest, failures = [], []
    for line in lines:
        voice = VOICES[line["voice"]]
        take, sr = speak_ipa(voice, take_ipa(voice, line.get("say", line["en"])), f"{line['id']}_take.wav", -2)
        clip = room(trim(take[::-1]), sr)
        wav = BUILD / f"{line['id']}.wav"
        sf.write(wav, clip, sr, subtype="PCM_16")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-ac", "1", "-ar", "22050", "-b:a", "64k",
                        str(OUT / f"{line['id']}.mp3")], check=True)
        picked, confidence = recognise(wav, candidates)
        ok = picked.rstrip(".") == line["en"].rstrip(".")
        if not ok:
            failures.append(line["id"])
        print(f"{line['id']:11} {len(clip) / sr:5.2f}s  heard as: {picked or '(nothing)'} [{confidence:.2f}]{'' if ok else '  <- check'}")
        manifest.append(entry(line, round(len(clip) / sr, 2)))
    write_manifest(manifest)
    print(f"{len(manifest)} clips written to {OUT}; recogniser matched {len(manifest) - len(failures)}/{len(manifest)}")


if __name__ == "__main__":
    main()
