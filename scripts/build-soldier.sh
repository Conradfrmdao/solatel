#!/usr/bin/env bash
# Builds assets/characters/soldier.glb from Mixamo downloads.
#
#   bash scripts/build-soldier.sh <downloads-dir> <work-dir>
#
# <downloads-dir> holds the FBX files exactly as Mixamo named them:
#
#   Ch15_nonPBR.fbx     the character, T-pose, with skin
#   Rifle Idle.fbx      Rifle Run.fbx      Firing Rifle.fbx      Rifle Death.fbx
#
# They stay out of the repository - it is public, and Mixamo's licence does
# not allow the raw files to be redistributed. Only the output is committed.
#
# <work-dir> gets the tools and the intermediate files. Needs curl, node and
# npm; runs on Linux (FBX2glTF is a Linux binary here).
set -euo pipefail

DOWNLOADS="$(cd "$1" && pwd)"
WORK="$(mkdir -p "$2" && cd "$2" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/assets/characters/soldier.glb"

cd "$WORK"
if [ ! -x FBX2glTF ]; then
    curl -sSL -o FBX2glTF \
        https://github.com/facebookincubator/FBX2glTF/releases/download/v0.9.7/FBX2glTF-linux-x64
    chmod +x FBX2glTF
fi
[ -f package.json ] || npm init -y >/dev/null
npm install --silent --no-audit --no-fund \
    @gltf-transform/cli@4 @gltf-transform/core@4 @gltf-transform/extensions@4

echo ">> converting FBX to glTF"
mkdir -p anims
./FBX2glTF --binary --input "$DOWNLOADS/Ch15_nonPBR.fbx" --output character >/dev/null
for name in "Rifle Idle" "Rifle Run" "Firing Rifle" "Rifle Death"; do
    ./FBX2glTF --binary --input "$DOWNLOADS/$name.fbx" --output "anims/${name// /_}" >/dev/null
done

# Textures: the download carries 4096 px PNGs, 94 MB of them. 1024 px WebP
# is sharp at any distance a player is seen from, and 3% of the size.
echo ">> textures to 1024 px WebP"
npx gltf-transform optimize character.glb character-small.glb \
    --texture-compress webp --texture-size 1024 \
    --simplify false --compress false --join false --instance false --flatten false

echo ">> clips onto the character"
# Run from here, beside the node_modules it imports from: Node resolves a
# script's imports from where the script is, not from the working directory.
cp "$ROOT/scripts/build-soldier.mjs" .
node build-soldier.mjs character-small.glb anims merged.glb

# Resample drops keyframes that say nothing new; prune drops what nothing
# uses; simplify takes the mesh from 46k triangles to 34k, which does not
# show at game distances and matters with thirty of them on screen.
echo ">> resample, prune, simplify"
npx gltf-transform resample merged.glb resampled.glb
npx gltf-transform prune resampled.glb pruned.glb
npx gltf-transform simplify pruned.glb "$OUT" --ratio 0.6 --error 0.0005

echo ">> $OUT"
ls -lh "$OUT"
