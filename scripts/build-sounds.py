#!/usr/bin/env python3
"""The game's recorded sounds, cut from CC0 libraries.

    python3 scripts/build-sounds.py <firearms-dir> <kenney-dir> <voices-dir> <handling-dir>

<firearms-dir> is "Prepared SFX Library" from The Free Firearm Sound Library
(the folder holding AK-47/, 1911/, Tikka/ ...); <kenney-dir> is the Audio/
folder of Kenney's Impact Sounds; <voices-dir> is "yelling sounds" from
HaelDB's Male Grunt/Yelling sounds; <handling-dir> holds the recordings in
`HANDLING_FILES` under the names they are downloaded as - from the USC
Cinema / Sunset Editorial collection on archive.org, and zer0_sol's handgun
reload from OpenGameArt. All of them are CC0 (the voices are OGA-BY 3.0 as
well; we take them as CC0) - see ATTRIBUTION.md. None of them is in the
repository: they are 550 MB of field recordings and the rest, and only the
cuts below are.

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
- **Weight in the near shots** (`weight`): the rumble under 25 Hz the
  microphone took from the blast is three quarters of the sniper rifle's
  recording and none of it is heard, and every near recording had its crack
  20 dB over its body, which plays as a click with a tail. The rumble is
  taken out, the body under 150 Hz lifted, and the whole saturated a
  little, so a shot lands as a blow.
- **Reloads that are recordings** (`HANDLING`): a real pistol reload in
  three parts - magazine out, in, slide - and for the rifles a magazine
  pulled, one seated and an action racked, cut from takes of each; the
  bolt of a bolt-action rifle worked once, for the M700 after every shot.
  `audio.js` lines each up with the moment the hands do it.
- **Rounds striking** (`HANDLING` as well): real rounds into dirt and
  timber, and onto steel plate, in place of Kenney's thuds and clanks,
  which Conrad found comic.
- **Footsteps** by surface, **a round into a body**, **a body falling**,
  and **four men's voices** - pain and death - so a player keeps one voice
  for a whole match.
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
    'fall': ('impactSoft_heavy', 0.5),
}

# The handling recordings, by the names they download as. From the USC
# Cinema / Sunset Editorial collection on archive.org (items SSE_Library_GUNS,
# SSE_Library_BULLETS and SSE_Library_METAL), CC0, and zer0_sol's "Handgun
# Reload Sound Effect" on OpenGameArt, CC0.
COCKING = 'GUNMech_Cock and fire empty rifle; many takes_CS_USC.flac'
BOLT = 'GUNMech_Cocking bolt action rifle; indoors_CS_USC.flac'
CLIP = 'GUNMech_Loading a clip into a rifle_CS_USC.flac'
STEEL = 'METLImpt_Shooting gallery or anvil_CS_USC.flac'
STRIKES = 'BLLTImpt_Bullets flying overhead and hitting objects_CS_USC.flac'
RIFLE_STRIKES = 'GUNRif_Rifle bullets flying over and hitting objects_CS_USC.flac'
HANDGUN = 'reload.wav'
HANDLING_FILES = [COCKING, BOLT, CLIP, STEEL, STRIKES, RIFLE_STRIKES, HANDGUN]

# Each set and its takes: (recording, from, to) in seconds, found by eye on
# each recording's envelope. A take runs from just before its first sound to
# where its last has died away; `audio.js` lines up each take's loudest
# moment (or, for the bolt, its start) with the hands.
HANDLING = {
    # One handgun reload, in its three parts: the magazine dropped, the new
    # one pushed home, the slide racked back and let go.
    'reload-pistol-out': [(HANDGUN, 0.07, 0.34)],
    'reload-pistol-in': [(HANDGUN, 0.55, 0.88)],
    'reload-pistol-slide': [(HANDGUN, 1.0, 1.5)],
    # A rifle's: the magazine knocked out, a fresh one rocked in to a clack,
    # and the action pulled back and let fly - four takes, each ending on the
    # slam of the bolt going home.
    'reload-mag-out': [(CLIP, 1.30, 1.55)],
    'reload-mag-in': [(CLIP, 4.47, 5.04), (CLIP, 5.64, 6.09)],
    'reload-charge': [(COCKING, 0.72, 1.16), (COCKING, 3.27, 3.62), (COCKING, 4.98, 5.34), (COCKING, 5.41, 5.78)],
    # A bolt worked once, quickly: lifted 0.04 s in, back by a quarter of a
    # second, home at a third and turned down by 0.4 - the M700's own
    # `BOLT_WORK` in viewmodel.js, which it was timed against.
    'bolt': [(BOLT, 2.30, 2.98)],
    # Rounds striking: into dirt and timber, the strike and the start of
    # the spray after it, and onto steel plate, a hard ring.
    'hit-ground': [(STRIKES, 5.25, 5.5), (STRIKES, 8.568, 8.82), (STRIKES, 9.345, 9.6),
                   (RIFLE_STRIKES, 0.27, 0.48), (RIFLE_STRIKES, 4.44, 4.69)],
    'hit-metal': [(STEEL, 0.219, 0.62), (STEEL, 1.879, 2.28), (STEEL, 5.896, 6.3),
                  (STEEL, 8.451, 8.85), (STEEL, 17.052, 17.45)],
}

# Sets whose takes die away from their first moment, this many seconds to
# fall by e: a round into the ground is a strike, and the recordings go on
# into the spray of dirt after it, which on its own is a hiss.
DECAY = {'hit-ground': 0.07}

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


def weight(x, drive=1.8):
    """A near shot as it is heard from behind the gun rather than measured
    beside it: the rumble under 25 Hz the blast put on the microphone taken
    out (it is three quarters of the sniper rifle's recording, and none of
    it is heard), the body under 150 Hz lifted by about 4 dB, and the whole
    gently saturated, which brings the body up about 5 dB against the crack
    - a click with a tail becomes a blow."""
    from scipy.signal import butter, sosfilt

    x = sosfilt(butter(2, 25, 'highpass', fs=RATE, output='sos'), x, axis=0)
    low = sosfilt(butter(2, 150, 'lowpass', fs=RATE, output='sos'), x, axis=0)
    x = peak_to(x + 0.6 * low, 0.0)
    return np.tanh(drive * x) / np.tanh(drive)


def take(x, start, end):
    """A stretch of a recording, with a fade in too short to soften its
    attack and a fade out over its last third, so it ends on nothing."""
    x = x[int(start * RATE) : int(end * RATE)].copy()
    n_in = int(0.002 * RATE)
    x[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    n_out = len(x) // 3
    x[-n_out:] *= (np.cos(np.linspace(0, np.pi, n_out)) * 0.5 + 0.5)[:, None] ** 1.5
    return x


def written(name, samples, bitrate):
    path = OUT / f'{name}.mp3'
    encode(samples, path, bitrate)
    print(f'    {path.name:24s} {len(samples) / RATE:4.2f} s {path.stat().st_size / 1024:5.1f} KB')
    return name


def main(argv):
    if len(argv) != 5:
        print(__doc__)
        return 2
    firearms, kenney, voices, handling = (Path(a) for a in argv[1:])
    missing = [name for name in HANDLING_FILES if not (handling / name).exists()]
    if missing:
        print(f'not in {handling}: {missing}')
        return 2
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
                if kind == 'near':
                    cut = weight(cut)
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

    print('>> reloads, the bolt, and rounds striking')
    recordings = {}
    for name, takes in HANDLING.items():
        names = []
        for i, (file, start, end) in enumerate(takes):
            if file not in recordings:
                recordings[file] = decode(handling / file, 1)
            cut = take(recordings[file], start, end)
            if name in DECAY:
                cut *= np.exp(-np.arange(len(cut)) / (DECAY[name] * RATE))[:, None]
            # Levelled by what is sounding rather than by the peak, so the
            # takes of a set are as loud as one another.
            names.append(written(f'{name}-{i + 1}', loudness_to(cut, -16), '96k'))
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
