#!/usr/bin/env python3
"""Regenerate every map's collision table in `sim/map.rs` from the art.

    python scripts/derive-maps.py          # both maps
    python scripts/derive-maps.py yard     # just one

`derive-brushes.py` turns one model into one table. This runs it over all of
them and splices the results into `map.rs` between the two markers below,
leaving everything outside them - the types, the lookup, the tests - alone.

It exists because regenerating one map and forgetting the other is a silent
failure: the tables are generated, the code around them is not, and nothing
about a stale `YARD_BRUSHES` looks wrong in a diff. One command that rebuilds
all of them is the only version of this that stays correct.

Bump `MAP_VERSION` in the same commit as any output of this script. That is what
tells a client with a cached wasm bundle to reload rather than predict against
walls the server has moved.
"""
import io
import os
import subprocess
import sys

BEGIN = '// --- generated: run scripts/derive-maps.py, do not edit by hand ---'
END = '// --- end of generated tables ---'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_RS = os.path.join(ROOT, 'crates', 'solatel-protocol', 'src', 'sim', 'map.rs')

# name, scale, spawn points, players one match seats.
#
# The scale is what the client draws the model at, and it is per map because
# the art is: the arena is authored at about a quarter life size and is
# playable only blown up, while the yard is already roughly in metres. Both are
# carried into the table by the generator, so the client cannot pick different
# ones. The seat count is per map because the ground is: the yard is 252
# metres across and swallows thirty players, while thirty in the arena would
# be a scrum. There are always more spawn points than seats, so a full match
# still has spare places to be scattered across and two matches running at
# once do not line everybody up identically.
MAPS = [
    # The arena is authored small. At four times, its ceilings came out at
    # 3.75 m - two of a 1.8 m player, which reads as a shed rather than a
    # building - and its doorways were correspondingly tight. Fifteen per
    # cent more puts ceilings over four metres and widens every opening.
    ('arena', 4.6, 28, 20),
    ('yard', 1.0, 42, 30),
]


def generate(name, scale, spawns, max_players):
    model = os.path.join(ROOT, 'assets', 'maps', f'{name}.glb')
    if not os.path.isfile(model):
        raise SystemExit(f'no model for {name}: {model}')
    print(f'{name}', file=sys.stderr)
    done = subprocess.run(
        [sys.executable, os.path.join(ROOT, 'scripts', 'derive-brushes.py'),
         model, '--name', name, '--scale', str(scale),
         '--spawns', str(spawns), '--max-players', str(max_players)],
        stdout=subprocess.PIPE, check=True,
    )
    return done.stdout.decode('utf-8')


def main(wanted):
    # Read up front only to fail fast on a file that cannot be spliced, and
    # again at the end for the version the tables are merged into.
    #
    # Generating the larger map takes minutes, and `map.rs` holds the types,
    # the lookup and the tests as well as the tables. Splicing into a copy read
    # before the run began quietly undoes anything edited meanwhile, which is
    # a confusing way to lose work: the file is rewritten, so it looks written,
    # and the change is simply not in it.
    with io.open(MAP_RS, encoding='utf-8', newline='') as handle:
        source = handle.read()
    for marker in (BEGIN, END):
        if marker not in source:
            raise SystemExit(f'{MAP_RS} has no {marker!r} marker')
    old = source.split(BEGIN, 1)[1].split(END, 1)[0]

    tables = []
    for name, scale, spawns, max_players in MAPS:
        if wanted and name not in wanted:
            # Keep the table that is already there, so generating one map does
            # not quietly delete the others.
            marker = f'static {name.upper()}_BRUSHES'
            if marker not in old:
                raise SystemExit(f'{name} is not in map.rs yet; generate it too')
            start = old.index(f'// --- {name} ')
            following = [
                old.index(f'// --- {other} ')
                for other, *_ in MAPS
                if other != name and f'// --- {other} ' in old
                and old.index(f'// --- {other} ') > start
            ]
            tables.append(old[start:min(following)] if following else old[start:])
            continue
        tables.append(generate(name, scale, spawns, max_players))

    body = '\n' + '\n'.join(t.strip('\n') + '\n' for t in tables)
    with io.open(MAP_RS, encoding='utf-8', newline='') as handle:
        head, rest = handle.read().split(BEGIN, 1)
    tail = rest.split(END, 1)[1]
    with io.open(MAP_RS, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(head + BEGIN + body + END + tail)

    print(f'-> {os.path.relpath(MAP_RS, ROOT)}', file=sys.stderr)
    print('   remember to bump MAP_VERSION, then ./x check && ./x test',
          file=sys.stderr)


if __name__ == '__main__':
    main(set(sys.argv[1:]))
