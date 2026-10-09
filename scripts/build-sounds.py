#!/usr/bin/env python3
"""The game's recorded sounds, cut from three CC0 libraries.

    python3 scripts/build-sounds.py <firearms-dir> <kenney-dir> <voices-dir>

<firearms-dir> is "Prepared SFX Library" from The Free Firearm Sound Library
(the folder holding AK-47/, 1911/, Tikka/ ...); <kenney-dir> is the Audio/
folder of Kenney's Impact Sounds; <voices-dir> is "yelling sounds" from
HaelDB's Male Grunt/Yelling sounds. All three are CC0 (the voices are
OGA-BY 3.0 as well; we take them as CC0) - see ATTRIBUTION.md. None of them
is in the repository: they are 540 MB of 96 kHz field recordings and the
rest, and only the cuts below are.

Needs numpy, scipy and ffmpeg (with libmp3lame) on the PATH. Writes
`assets/sounds/*.mp3` and `client/src/sound-sets.js`, which says what is
there for `audio.js`.

What it makes, and why each choice:

- **Every gun twice: near and far.** The library recorded each gun from
  beside the shooter and again from mid distance, out in front - a
  different sound, not a quieter one: far off a shot is the boom and the
  land answering it, the crack long gone. `audio.js` crossfades between the
  two by distance. Near is stereo, because it is also the player's own gun;
  far is mono, because it is only ever placed somewhere. A recording holds
  several shots seconds apart, and each one is a variation, so a burst is
  not the same waveform five times.
- **Which recording for which gun**: the AK-47 is ours; the 1911 is ours;
  the MP5 is a 9 mm submachine gun and so is the Carl Gustav M45; the RPK
  fires the AK's 7.62x39 and the SKS was recorded firing it; the M700 is a
  bolt-action .308 and the Tikka T3 is a bolt-action .30-06.
- **Footsteps** by surface, **hits** (a round into a body, into the ground,
  into metal), **a body falling**, and **four men's voices** - pain and
  death - so a player keeps one voice for a whole match.
- **MP3**, because it is the one format every browser's `decodeAudioData`
  takes. Its encoder pads the start; the client finds each sound's onset
  when it decodes it rather than trusting any decoder to remove the pad.

Always UTF-8 and LF: see CLAUDE.md on what Windows defaults did here.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

RATE = 48000
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'sounds'
TABLE = ROOT / 'client' / 'src' / 'sound-sets.js'

# For each gun: (recording, seconds kept) near and far. Every shot in a
# recording is found by its onset (see `shots`) and becomes one variation.
GUNS = {
    'rifle': (('AK-47/C_28P.wav', 1.6), ('AK-47/C_31P.wav', 2.8)),
    'lmg': (('SKS/U_14P.wav', 1.6), ('SKS/U_19P.wav', 2.8)),
    'smg': (('Carl Gustav M45/G_31P.wav', 1.3), ('Carl Gustav M45/G_20P.wav', 1.8)),
    'pistol': (('1911/A_42P.wav', 1.4), ('1911/A_34P.wav', 2.0)),
    'sniper': (('Tikka/W_29P.wav', 2.2), ('Tikka/W_24P.wav', 3.0)),
}
# At most this many variations of each.
VARIATIONS = 4

# Kenney's Impact Sounds: what each set is made from, and the most of it kept.
KENNEY = {
    'step-concrete': ('footstep_concrete', 0.35),
    'step-grass': ('footstep_grass', 0.45),
    'step-wood': ('footstep_wood', 0.35),
    'step-metal': ('impactMetal_light', 0.3),
    'hit-flesh': ('impactPunch_heavy', 0.45),
    'hit-ground': ('impactGeneric_light', 0.3),
    'hit-metal': ('impactMetal_medium', 0.35),
    'fall': ('impactSoft_heavy', 0.5),
}

# The voices, by man: short cries for a hit, longer ones for a death. Sorted
# by length and by the shape of the pitch (a death's falls away at the end),
# from the recordings' own spectrograms; there are four men in the pack.
VOICES = {
    'a': (['1yell1', '1yell9', '1yell16', '1yell7'], ['1yell12', '1yell3', '1yell5']),
    'b': (['2yell1', '2yell7', '2yell2'], ['2yell8', '2yell3', '2yell4']),
    'c': (['3grunt1', '3grunt4', '3grunt5', '3yell3'], ['3yell2', '3yell1', '3yell9', '3yell15']),
    'd': (['yell12', 'yell13', 'yell7'], ['yell1', 'yell2', 'yell4', 'yell5']),
}


def decode(path, channels):
    """Any file ffmpeg reads, as float32 samples at RATE, frames x channels."""
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', str(channels),
         '-ar', str(RATE), '-'],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).astype(np.float64)


def encode(samples, path, bitrate):
    samples = np.clip(samples, -1, 1).astype(np.float32)
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE),
         '-ac', str(samples.shape[1]), '-i', '-', '-c:a', 'libmp3lame', '-b:a', bitrate,
         '-map_metadata', '-1', str(path)],
        input=samples.tobytes(), check=True,
    )


def envelope(x, window=0.002):
    """The loudest sample in each `window` seconds, spread back over it."""
    m = np.abs(x).max(axis=1)
    n = max(1, int(RATE * window))
    return np.maximum.reduceat(m, np.arange(0, len(m), n)).repeat(n)[: len(m)]


def shots(x):
    """Where each shot in a recording starts: a rise to within 12 dB of the
    loudest moment straight out of quiet (30 dB down), at least a second and
    a half after the last. These recordings are single shots seconds apart,
    and an echo off something a hundred metres away - which out at mid
    distance can come back out of quiet, two thirds of a second later - is
    part of its shot, not a shot of its own."""
    env = envelope(x)
    peak = env.max()
    loud, quiet = peak * 10 ** (-12 / 20), peak * 10 ** (-30 / 20)
    found, last_quiet = [], -(10**9)
    for i, v in enumerate(env):
        if v < quiet:
            last_quiet = i
        if v > loud and i - last_quiet < 0.02 * RATE and (not found or i - found[-1] > 1.5 * RATE):
            found.append(i)
    return found


def onset(x, below=40):
    """The first sample within `below` dB of the loudest."""
    env = np.abs(x).max(axis=1)
    return int(np.argmax(env > env.max() * 10 ** (-below / 20)))


def shape(x, keep, lead=0.004, below=40):
    """From just before its onset, for at most `keep` seconds, with a fade in
    too short to soften the attack and a fade out over the last third, so
    nothing ends on a click."""
    start = max(0, onset(x, below) - int(lead * RATE))
    x = x[start : start + int(keep * RATE)].copy()
    n_in = int(0.002 * RATE)
    x[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    n_out = len(x) // 3
    x[-n_out:] *= (np.cos(np.linspace(0, np.pi, n_out)) * 0.5 + 0.5)[:, None] ** 1.5
    return x


def peak_to(x, db=-1.0):
    return x * (10 ** (db / 20) / max(np.abs(x).max(), 1e-9))


def loudness_to(x, db, ceiling=-1.0):
    """Mean level over the part that is sounding, limited by the peak."""
    env = np.abs(x).max(axis=1)
    active = x[env > env.max() * 0.1]
    rms = np.sqrt(np.mean(active**2)) if len(active) else 1e-9
    gain = min(10 ** (db / 20) / max(rms, 1e-9), 10 ** (ceiling / 20) / max(env.max(), 1e-9))
    return x * gain


def written(name, samples, bitrate):
    path = OUT / f'{name}.mp3'
    encode(samples, path, bitrate)
    print(f'    {path.name:24s} {len(samples) / RATE:4.2f} s {path.stat().st_size / 1024:5.1f} KB')
    return name


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    firearms, kenney, voices = (Path(a) for a in argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*.mp3'):
        old.unlink()
    sets = {}

    print('>> guns')
    for gun, ((near_file, near_keep), (far_file, far_keep)) in GUNS.items():
        for kind, file, keep, channels, bitrate in (
            ('near', near_file, near_keep, 2, '160k'),
            ('far', far_file, far_keep, 1, '96k'),
        ):
            x = decode(firearms / file, channels)
            names = []
            starts = shots(x)
            for i, at in enumerate(starts[:VARIATIONS]):
                end = starts[i + 1] if i + 1 < len(starts) else len(x)
                # From a little before the shot; its onset is found 30 dB
                # down, above the noise of a recording made out of doors.
                cut = shape(x[max(0, at - int(0.05 * RATE)) : end - int(0.05 * RATE)], keep, below=30)
                names.append(written(f'{gun}-{kind}-{i + 1}', peak_to(cut), bitrate))
            sets[f'{gun}-{kind}'] = names

    print('>> footsteps, hits and falls')
    for name, (stem, keep) in KENNEY.items():
        names = []
        for i in range(5):
            x = decode(kenney / f'{stem}_{i:03d}.ogg', 1)
            cut = shape(x, keep, lead=0.001)
            level = loudness_to(cut, -16) if name.startswith('step') else peak_to(cut)
            names.append(written(f'{name}-{i + 1}', level, '64k'))
        sets[name] = names

    print('>> voices')
    for man, (pains, deaths) in VOICES.items():
        for kind, stems in (('pain', pains), ('death', deaths)):
            names = []
            for i, stem in enumerate(stems):
                x = decode(voices / f'{stem}.wav', 1)
                cut = shape(x, 2.0, lead=0.01)
                names.append(written(f'voice-{man}-{kind}-{i + 1}', loudness_to(cut, -18), '64k'))
            sets[f'voice-{man}-{kind}'] = names

    total = sum(p.stat().st_size for p in OUT.glob('*.mp3'))
    print(f'>> {len(list(OUT.glob("*.mp3")))} files, {total / 1024 / 1024:.2f} MB')
    TABLE.write_bytes(
        (
            '// Written by scripts/build-sounds.py: every recorded sound, by set.\n'
            '// Each name is `assets/sounds/<name>.mp3`. Do not edit by hand.\n'
            f'export const SOUND_SETS = {json.dumps(sets, indent=2)};\n'
        ).encode('utf-8')
    )
    print(f'>> {TABLE.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
