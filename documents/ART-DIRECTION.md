# Approved art direction — October 14, 2026

The user selected a combination of all three generated Yard concepts:
Daybreak Terminal's freight layout, Glassworks' glazed roof and machinery,
and Solar Atrium's planted indoor courtyard. This replaces the outdoor Yard,
not an additional map. Broad daylight and readable, bright interiors are
requirements. Large indoor scale; clear ground routes, flanks, and usable
stairs. No gloomy weather. Avoid uninterrupted long sight lines and excessive
transparent layers or foliage cost.

The user selected all four operator concepts: Ranger, Breacher, Ghost and
Engineer, with optional color variants. Different geometry and equipment
silhouettes are required, not just recoloring the current soldier. The
concepts are targets, not screenshots or finished 3D assets. Maintain equal
movement and hitboxes; cosmetics must not alter combat stats.

The reference PNGs are preserved in `art-reference/`. The user explicitly
rejected the first in-engine approximation and requested the same visual
quality and clothing as those images. Naming a recolored soldier Ranger,
Breacher, Ghost or Engineer does not fulfill that request.

The implemented Yard now measures 72 x 108 m, with six stairs, two bridges,
side galleries, upper warehouse rooms, detailed structural columns and
concrete roof bands separated by skylights. Freight stacks, machinery,
polished metal screens, planters and work stations interrupt sightlines.
Warm daylight, locally packed PBR props and a scanned floor replace the
sparse early draft. Captures in `art-review/` are from the actual game.
The layout follows the combined direction, but it is not an exact recreation
of the concept image's geometry, reflections or photorealistic detail.

The first rejected equipment prototype was removed. The later revision
uses curved caps/helmets/hoods and fitted pouches, armor and tools tied to the
existing animated bones. Ranger, Breacher, Ghost and Engineer have distinct
kit silhouettes, but still share the source character's face and garment
sculpt. The four menu images show the actual implementation. Exact concept
faces, sleeve cuts, clothing folds and texture fidelity remain unfinished.

The earlier Tencent Hunyuan3D geometry test remains a local ignored
experiment; its textured service was not available here. With the user's
subsequent explicit permission, the four separate operator references were
processed through three.ws Forge's TRELLIS and Make-It-Animatable services.
Ranger and Ghost have distinct textured meshes, Mixamo-compatible rigs and
retargeted idle, run, fire and death clips. Their gameplay models are in
`assets/characters/`, and skins 5 and 8 use those models and matching menu
portraits. Local two-player matches confirmed the correct model and weapon
appear for each skin. Their silhouettes and clothing are much closer to the
approved lineup than the recolored soldier, though the generated facial
detail and material definition still fall short of the reference art.

Breacher and Engineer generation produced damaged facial geometry and
textures. Those results are only in ignored `.artifacts/character-pipeline/`;
skins 6 and 7 still use the previous in-game implementation until usable
replacement heads, helmet/visor details, rigs and animations are ready.
Do not present these two as faithful 3D versions of the approved concepts.
The first-person view still uses the original hand rig, with sleeves tinted
to the selected operator palette. Directly cutting arms from the generated
Ranger and Ghost meshes caused detached wrists and malformed forearms in
the weapon solver, so those arms were rejected. Matching first-person
sleeve and glove geometry remains unfinished.

The three.ws terms say that generated content belongs to its creator subject
to the output review obligation in its terms. The underlying TRELLIS and
Make-It-Animatable projects publish MIT licenses, and the source Ch15 motion
clips are used under Adobe Mixamo's game-use permission. Check these terms
again before a paid asset redistribution outside the game.

Exact production outfits still require detailed garment and equipment
modeling, retopology, UVs, PBR textures, first-person arm integration, and
animation QA against the supplied lineup. No automated image-to-3D result
here guarantees exact likeness. The rejected Breacher and Engineer models
need manually fitted, properly textured heads and helmet details before they
can replace the current game models.

Fixed regressions to preserve: the aim transition now hides the gun when
the scope overlay becomes visible. The Arena screenshot at (-13.6, 0.9, 15)
faces +Z toward the retired up2 switchback's vertical landing. Its replacement
and connected landing have a regression test from that exact approach and
two nearby approaches, without jumping. Yard's six stair routes have eighteen
walk-up approach cases. Performance still needs further work on integrated
graphics; the detailed map is not a verified 60 FPS experience at high/ultra.
