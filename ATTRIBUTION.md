# Third-party assets

Everything under `assets/` came from somewhere else. This file is the record of
where, and under what terms. It is not optional paperwork: Solatel charges real
money to play, which makes shipping an asset we do not have commercial rights to
a legal problem rather than an etiquette one.

**One asset is currently unlicensed and must not ship: the rifle.** It is
usable for development and has no written grant. The yard map's terms are
Conrad's word, recorded below, and are still worth finding in writing.

Licence text embedded in a `.glb` lives in its `asset.extras` field. To re-check
a file's own claim about itself, or all of them at once:

```
python scripts/asset-licence.py assets/characters/soldier.glb
python scripts/asset-licence.py assets/*/*.glb
```

## Arena — `assets/maps/arena.glb`

> This work is based on ["LOWPOLY | FPS | TDM | GAME | MAP by ResoForge"](https://sketchfab.com/3d-models/lowpoly-fps-tdm-game-map-by-resoforge-d41a19f699ea421a9aa32b407cb7537b)
> by [Space_One](https://sketchfab.com/aslbekburonbey) licensed under
> [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).

Commercial use allowed, author must be credited. CC-BY-4.0 also requires that
changes be stated. They are:

- `scripts/prepare-assets.py` repacked the original `scene.gltf` + `scene.bin`
  into a single `.glb`, lifted the ground plane's base colour from 0.021 to
  0.10 so that it takes light instead of drawing as a black void, and stripped
  normals and texture coordinates, which nothing reads.
- `scripts/extend-arena.py` **adds geometry of our own and removes 40
  triangles of the original.** 24 are the east and west walls of the
  enclosing box, so the map can continue past where they stood. The other 16
  are a redundant red-orange ground quad in `floors_0`: the file carries two
  full-map floors at exactly y 0, that one and the grey `Plane_0`, and two
  surfaces at the same depth flicker against each other over the whole
  arena. The grey one is kept. Everything added is Solatel's own work and is
  listed below.
- `scripts/extend-arena.py` also **repaints the whole model.** Every
  primitive of the original is given one of Solatel's own materials in place
  of the original's saturated orange, red and amber - weathered concrete,
  asphalt, painted plaster, rusty steel, timber - by what the piece is. No
  vertex or index is changed by this, and the original's materials stay in
  the file, unused, with each primitive's original material recorded in
  `asset.extras` so a second run restores it. The weathering itself (stains,
  panel joints, planks, paint on the ground) is drawn by the client and is
  not in the file.

The original model is therefore modified, not merely repackaged, and the
adaptation is offered under the same terms. The two are kept apart in the file
so the distinction survives: our geometry hangs off a single scene node named
`solatel_extension`, and the removed triangles are only pointed away from,
never deleted, with the original accessor recorded in `asset.extras` so a
second run restores them. Deleting that node, restoring those indices and
putting back the recorded materials gives back the download.

### What Solatel added to the arena

Authored in `scripts/extend-arena.py`, which is the readable description of
it; this is the summary.

- An external staircase and landing onto the roof of the north-west building,
  which had 56 m² of standing room and no way up.
- Gated boundary walls on the lines of the old east and west walls, three
  openings in each.
- Thirty metres of new ground beyond each, out to x 50 and x -50, with their
  own perimeter walls and ground.
- Twelve buildings across the two, each with an interior, four doorways, a
  roof, and an external flight onto that roof; and eighteen pairs of crates
  as cover.
- All of it painted from the same palette as the repainted original, so the
  new halves are the same map rather than an estate attached to it.

None of it is derived from the original model's geometry.

## Yard — `assets/maps/yard.glb`

**Licence unconfirmed.** Unpacked from
`lowpoly-map-asset-by-resoforge.zip`, as `source/RP_MAP_1.glb`. The archive
contains nothing but that one file: no licence text, no readme, and the model's
own `asset` block carries only a Blender version string, so
`scripts/asset-licence.py` exits non-zero on it.

The ResoForge name and the shared art style make it very likely the same
author as the arena above, under the same CC-BY-4.0. That is an inference from
a filename, not a grant, and it is not what this file is for.

`scripts/prepare-assets.py` lifted three near-black materials (`PLANE`,
`DARK`, `DARK-2`) out of near-black so they take light, and stripped the
normals and texture coordinates - the file has no textures and the client
flat-shades it, so neither was ever read, and together they were fifteen of its
twenty-six megabytes. No geometry was touched; the collision brushes are
derived from this same file.

**Conrad confirmed on 2026-09-26 that the yard's asset pack is free for
anybody to use, for any purpose,** and asked for it to be reused in the
facility map. That is the owner's statement of the terms and is recorded here
as such. The written grant from the model's page is still worth finding and
copying in verbatim before launch, so the record does not rest on a message.

## Facility — `assets/maps/facility.glb`

Built from nothing by `scripts/build-facility.py`, which is the readable
description of it. Two kinds of content, recorded separately:

- **Solatel's own geometry**: the ground, the river and its walls, the
  terraced ridge and the mountain with its tunnel, every building, the silos
  and tanks, the pipe rack, the bridges and the dam, the trees and rock
  outcrops. Authored in that script from boxes and cylinders; none of it is
  derived from anybody else's model.
- **Dressing reused from the yard's asset pack** (see above): trucks, cars,
  shipping containers, barrels, crates, sandbags, barriers, pallets, trestles
  and the water tower. Each is taken from one named node of `yard.glb`,
  scaled to the size of the real object, and repainted in Solatel's palette;
  the vertices are otherwise the pack's. The script lists every one and what
  it was painted.

## Character — `assets/characters/soldier.glb`

"Ch15" and the animations "Rifle Idle", "Rifle Run", "Firing Rifle" and
"Rifle Death", from [Adobe Mixamo](https://www.mixamo.com), downloaded by Conrad.

Mixamo's terms: the characters and animations may be used royalty-free in
personal and commercial projects, games included, with no attribution
required; they may not be redistributed as raw files or as asset packs. So the
downloads are kept out of this repository, which is public, and only the
built game file is committed.

`scripts/build-soldier.sh` records everything done to them: converted from FBX,
textures resized to 1024 px and re-encoded as WebP, the four clips copied onto
the character's skeleton, root motion removed from idle, run and fire, and the
mesh simplified to 34k triangles. The terms are also written into the file's
`asset.extras`, where `scripts/asset-licence.py` reports them.

This replaces "Low Poly Soldier -Free" by manoeldarochadeoliveira (CC-BY-4.0),
which is no longer used anywhere in the game.

## Weapon — `assets/weapons/rifle.glb`

**Licence unconfirmed.** "Assault Rifle" by Zsky, downloaded from Sketchfab. The
file carries no `asset.extras` and shipped with no licence text, so we currently
have no written grant for it. Its material colours were lifted out of near-black
by `scripts/prepare-assets.py`; geometry is unchanged.

This must be resolved before launch: either confirm the terms on the model's
Sketchfab page and record them here, or replace the model. Until then it is fine
for development and must not ship.

## Photographs, sky and foliage — `assets/photo/`, `assets/sky/`

**CC0 1.0 (public domain), from Poly Haven** (https://polyhaven.com/license).
No attribution is required and redistribution is allowed; they are listed here
so the originals can be found. `scripts/fetch-photo-assets.mjs` downloads every
one at 1k and re-encodes it as WebP; nothing else is done to them.

- Surfaces, each a colour and an OpenGL normal map: `concrete_wall_008`,
  `concrete_floor_worn_001`, `asphalt_02`, `leafy_grass`, `aerial_grass_rock`,
  `dry_ground_01`, `dirt`, `gravel_floor`, `coast_sand_rocks_02`,
  `cliff_side`, `corrugated_iron_02`, `container_side`, `rusty_metal_02`,
  `rusty_painted_metal`, `metal_plate_02`, `plastered_wall_02`,
  `brick_wall_02`, `brown_planks_03`, `clay_roof_tiles_02`, `pine_bark`.
- Foliage, colour, alpha mask and normal: the leaves of `tree_small_02`, the
  twigs of `fir_tree_01`, the blades of `grass_medium_01`. Only these
  textures are used; the models themselves are millions of polygons and are
  not in the game.
- Sky: `kloofendal_48d_partly_cloudy_puresky`, the 1k HDR for lighting and
  the tonemapped panorama, at 4096 px, for the background.

## Credit in the product

CC-BY-4.0 requires the credit to reach players, not just this repository. It
does: the menu's **fair play** pane (`client/src/menu.js`) ends with the
credits, and they carry the arena's CC-BY-4.0 notice as it is given above,
with its links, and what Solatel changed. The same list credits the yard's
pack, Mixamo, the rifle's author, Poly Haven and three.js, none of which
requires it. A new CC-BY asset is not cleared to ship until its notice is in
that list too.
