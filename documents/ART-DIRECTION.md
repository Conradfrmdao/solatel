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

With the user's explicit permission to upload the generated Ranger image
to Tencent's public Hunyuan3D Hugging Face demo, a raw geometry test succeeded
(381,556 triangles). Textured generation was refused by the demo's GPU
duration limit. The mesh is untextured and unrigged, has soft small details,
and remains a local ignored experiment under `.artifacts/generated-3d/`.
It is not a finished game asset. Do not upload the other operators without
the user's authorization for that external destination.

Exact production outfits still require detailed garment and equipment
modeling, retopology, UVs, PBR textures, rigging, first-person arm integration,
and animation QA against the supplied lineup. There is no connected service
here that completes all those steps or guarantees exact image fidelity.
The public demo's license also needs consideration before any output is
distributed: https://huggingface.co/tencent/Hunyuan3D-2.1/blob/main/LICENSE.

Fixed regressions to preserve: the aim transition now hides the gun when
the scope overlay becomes visible. The Arena screenshot at (-13.6, 0.9, 15)
faces +Z toward the retired up2 switchback's vertical landing. Its replacement
and connected landing have a regression test from that exact approach and
two nearby approaches, without jumping. Yard's six stair routes have eighteen
walk-up approach cases. Performance still needs further work on integrated
graphics; the detailed map is not a verified 60 FPS experience at high/ultra.
