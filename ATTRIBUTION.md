# Third-party assets

Everything under `assets/` came from somewhere else. This file is the record of
where, and under what terms. It is not optional paperwork: Solatel charges real
money to play, which makes shipping an asset we do not have commercial rights to
a legal problem rather than an etiquette one.

**Two assets are currently unlicensed and must not ship: the rifle and the
yard map.** Both are usable for development. Neither has a written grant.

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

The original model is therefore modified, not merely repackaged, and the
adaptation is offered under the same terms. The two are kept apart in the file
so the distinction survives: our geometry hangs off a single scene node named
`solatel_extension`, and the removed triangles are only pointed away from,
never deleted, with the original accessor recorded in `asset.extras` so a
second run restores them. Deleting that node and restoring those indices gives
back the download.

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
- All of it made from the original's own materials, chosen by measuring which
  ones it actually uses, so the new half is the same map rather than a grey
  estate attached to an orange one.

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

This must be resolved before launch, the same way as the rifle: find the
model's page, confirm the terms, and record them here verbatim — or replace the
map. Until then it is fine for development and must not ship.

## Character — `assets/characters/soldier.glb`

> This work is based on ["Low Poly Soldier -Free"](https://sketchfab.com/3d-models/low-poly-soldier-free-739772a9b0f14feeb4a4f1b45dadf4e3)
> by [manoeldarochadeoliveira](https://sketchfab.com/manoeldarochadeoliveira)
> licensed under [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).

Commercial use allowed, author must be credited. CC-BY-4.0 also requires that
changes be stated, and two meshes were removed by `scripts/prepare-assets.py`:

- `holster_soldier_0`, which is broken in the source file — its geometry is
  authored about 6.5 m below the body and weighted to the right thigh bone, so
  in game it is a slab swinging around under the player's feet.
- `hand_knife_soldier_0`, a knife in the hand, which clashes with the rifle
  viewmodel.

Nothing else was altered: the skeleton, the five animation clips and the
remaining geometry are the author's, untouched.

## Weapon — `assets/weapons/rifle.glb`

**Licence unconfirmed.** "Assault Rifle" by Zsky, downloaded from Sketchfab. The
file carries no `asset.extras` and shipped with no licence text, so we currently
have no written grant for it. Its material colours were lifted out of near-black
by `scripts/prepare-assets.py`; geometry is unchanged.

This must be resolved before launch: either confirm the terms on the model's
Sketchfab page and record them here, or replace the model. Until then it is fine
for development and must not ship.

## Credit in the product

CC-BY-4.0 requires the credit to reach players, not just this repository. A
credits panel is not built yet; when one exists, the two CC-BY-4.0 notices above
belong in it verbatim.
