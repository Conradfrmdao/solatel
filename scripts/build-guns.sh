#!/usr/bin/env bash
# Builds assets/guns/*.glb from two CC0 weapon packs.
#
#   bash scripts/build-guns.sh <stein-dir> <cc0-dir> <work-dir>
#
# <stein-dir>  Stein Games' "Free Classic Weapons Pack" v1.1, unzipped: the
#              folder holding AK47/, M700/, MP5/, 1911/ and license.txt.
#              https://stein-indie.itch.io/classic-weapons-pack
# <cc0-dir>    3DModelsCC0's "Guns & Explosives" pack, unpacked: the folder
#              holding Sniper/ and the rest (`bsdtar -xf` opens its RAR).
#              https://3dmodelscc0.itch.io/free-cc0-guns-explosives-pack
#
# Both are CC0 (ATTRIBUTION.md). They stay out of the repository - 180 MB of
# source files - and only the output is committed. <work-dir> gets the tools
# and the intermediate files. Needs curl, node, npm, python3 with Pillow and
# numpy, and basisu (scripts/build-basisu.sh builds it, or set BASISU).
set -euo pipefail

STEIN="$(cd "$1" && pwd)"
CC0="$(cd "$2" && pwd)"
WORK="$(mkdir -p "$3" && cd "$3" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASISU="${BASISU:-$ROOT/target/basisu/basisu}"
OUT="$ROOT/assets/guns"

cd "$WORK"
if [ ! -x FBX2glTF ]; then
    curl -sSL -o FBX2glTF \
        https://github.com/facebookincubator/FBX2glTF/releases/download/v0.9.7/FBX2glTF-linux-x64
    chmod +x FBX2glTF
fi
[ -f package.json ] || npm init -y >/dev/null
npm install --silent --no-audit --no-fund @gltf-transform/core@4 @gltf-transform/extensions@4

echo ">> FBX to glTF"
mkdir -p raw
for gun in AK47 MP5 M700 1911; do
    ./FBX2glTF --binary --input "$STEIN/$gun/SKM_$gun.fbx" --output "raw/$gun" >/dev/null
done
./FBX2glTF --binary --input "$CC0/Sniper/Sniper.fbx" --output raw/cc0-Sniper >/dev/null

mkdir -p textures
python3 "$ROOT/scripts/gun-textures.py" "$STEIN" "$CC0" textures

echo ">> KTX2"
# Colour and the packed occlusion-roughness-metalness as ETC1S, which keeps a
# 2048 px colour sheet under a megabyte; the normal map as UASTC, because
# ETC1S's blocks show in lighting. No -y_flip: glTF's textures are read the
# right way up, unlike the photographs (photo.js).
for png in textures/*.png; do
    name="$(basename "$png" .png)"
    case "$name" in
        *-color) "$BASISU" -ktx2 -mipmap -q 255 -mip_srgb "$png" -output_file "textures/$name.ktx2" >/dev/null ;;
        *-orm) "$BASISU" -ktx2 -mipmap -q 255 -linear -mip_linear "$png" -output_file "textures/$name.ktx2" >/dev/null ;;
        *-normal) "$BASISU" -uastc -uastc_level 2 -uastc_rdo_l 3 -ktx2 -ktx2_zstandard_level 18 -mipmap -linear -mip_linear -normal_map "$png" -output_file "textures/$name.ktx2" >/dev/null ;;
    esac
done

cp "$ROOT/scripts/build-guns.mjs" .
node build-guns.mjs raw textures "$OUT"
ls -l "$OUT"
