#!/usr/bin/env python3
"""Print the licence a .glb claims for itself.

glTF files carry an `asset.extras` block, and Sketchfab downloads record the
title, author, licence and source URL there. Solatel charges real money, so
shipping an asset without a commercial grant is a legal problem - this is the
one-command check that a file says what ATTRIBUTION.md says it says.

A file with no embedded licence is not thereby unlicensed; it means nobody
wrote one down, and the source page has to be checked by hand.

    python scripts/asset-licence.py assets/**/*.glb
"""
import json
import struct
import sys


def read_asset_block(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    if data[:4] != b'glTF':
        raise ValueError('not a binary glTF file')
    offset = 12
    while offset < len(data):
        length, kind = struct.unpack_from('<II', data, offset)
        offset += 8
        if kind == 0x4E4F534A:  # JSON chunk
            return json.loads(data[offset:offset + length].decode('utf-8')).get('asset', {})
        offset += length
    raise ValueError('no JSON chunk')


def main(paths):
    missing = 0
    for path in paths:
        print(path)
        try:
            asset = read_asset_block(path)
        except (OSError, ValueError) as error:
            print(f'    unreadable: {error}')
            missing += 1
            continue

        extras = asset.get('extras') or {}
        licence = extras.get('license') or asset.get('copyright')
        if not licence:
            print('    NO EMBEDDED LICENCE - check the source page by hand')
            missing += 1
            continue

        for field in ('title', 'author', 'license', 'source'):
            if extras.get(field):
                print(f'    {field:7s} {extras[field]}')
        if asset.get('copyright'):
            print(f"    {'©':7s} {asset['copyright']}")

    # Non-zero exit so this can gate a release check later.
    return 1 if missing else 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1:]))
