#!/usr/bin/env python3
"""The guns' textures, ready for the KTX2 encoder.

    python3 scripts/gun-textures.py <stein-dir> <cc0-dir> <out-dir>

<stein-dir> is Stein Games' "Free Classic Weapons Pack" unzipped (the folder
holding AK47/, M700/, MP5/, 1911/ ...); <cc0-dir> is 3DModelsCC0's "Guns &
Explosives" pack unpacked (the folder holding Sniper/ ...). Both are CC0; see
ATTRIBUTION.md. Neither is in the repository - they are 180 MB of source
files - and only what `build-guns.mjs` makes of them is.

For each texture set this writes three PNGs, which `build-guns.sh` encodes:

  <set>-color.png    the colour, 2048 px (the gun fills half the screen in
                     first person, and ETC1S keeps 2048 px under 1 MB)
  <set>-normal.png   the normal map, 1024 px, OpenGL's way up: Stein's are
                     Unreal's (DirectX), whose green points the other way,
                     and a normal map upside down lights every bump as a dent
  <set>-orm.png      occlusion, roughness and metalness in red, green and
                     blue, 1024 px, the way glTF reads them. Stein packs them
                     as roughness, metalness, occlusion ("RMAO"); 3DModelsCC0
                     ships them as separate greyscale files.

The scope is cut out of the 3DModelsCC0 sniper rifle's sheet, which it shares
with the rest of that rifle: only the rectangle its main island covers is
kept (`SCOPE_CROP`), and `build-guns.mjs` moves the scope's coordinates into
it. A few specks of the scope fall outside it and are given a plain patch of
the tube.

Always UTF-8 and LF: see CLAUDE.md on what Windows defaults did here.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Stein Games: the texture files of each gun, by folder.
STEIN = {
    'ak47': ('AK47', 'T_AK47_C.png', 'T_AK47_N.png', 'T_AK47_RMAO.png'),
    'mp5': ('MP5', 'T_MP5_C.png', 'T_MP5_N.png', 'T_MP5_RMAO.png'),
    'm700': ('M700', 'T_M700_C.png', 'T_M700_N.png', 'T_M700_RMAO.png'),
    # The 1911's normal map is named for a different year in the download.
    '1911': ('1911', 'T_1911_C.png', 'T_1991_N.png', 'T_1911_RMAO.png'),
}

# The scope's island on the 3DModelsCC0 sniper's sheet, as u0, v0, u1, v1
# with v down the image (glTF's convention). Must match build-guns.mjs.
SCOPE_CROP = (0.06, 0.26, 0.56, 0.70)

COLOUR = 2048
DETAIL = 1024


def load(path, mode, size):
    image = Image.open(path).convert(mode)
    if isinstance(size, int):
        size = (size, size)
    return image.resize(size, Image.LANCZOS) if image.size != size else image


def write(out, name, array):
    Image.fromarray(np.ascontiguousarray(array).astype(np.uint8)).save(out / name)
    print('   ', name)


def stein(source, out):
    for name, (folder, colour, normal, rmao) in STEIN.items():
        root = source / folder
        write(out, f'{name}-color.png', np.asarray(load(root / colour, 'RGB', COLOUR)))
        n = np.asarray(load(root / normal, 'RGB', DETAIL)).copy()
        n[..., 1] = 255 - n[..., 1]
        write(out, f'{name}-normal.png', n)
        packed = np.asarray(load(root / rmao, 'RGB', DETAIL))
        write(out, f'{name}-orm.png', np.stack([packed[..., 2], packed[..., 0], packed[..., 1]], axis=-1))


def scope(source, out):
    root = source / 'Sniper'

    def crop(path, mode, size):
        image = Image.open(path).convert(mode)
        w, h = image.size
        u0, v0, u1, v1 = SCOPE_CROP
        box = (round(u0 * w), round(v0 * h), round(u1 * w), round(v1 * h))
        return np.asarray(image.crop(box).resize((size, size), Image.LANCZOS))

    write(out, 'scope-color.png', crop(root / 'Sniper_Base_Color.png', 'RGB', DETAIL))
    write(out, 'scope-normal.png', crop(root / 'Sniper_Normal.png', 'RGB', DETAIL // 2))
    rough = crop(root / 'Sniper_Roughness.png', 'L', DETAIL // 2)
    metal = crop(root / 'Sniper_Metallic.png', 'L', DETAIL // 2)
    write(out, 'scope-orm.png', np.stack([np.full_like(rough, 255), rough, metal], axis=-1))


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    stein_dir, cc0_dir, out = Path(argv[1]), Path(argv[2]), Path(argv[3])
    out.mkdir(parents=True, exist_ok=True)
    print('>> gun textures')
    stein(stein_dir, out)
    scope(cc0_dir, out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
