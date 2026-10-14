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

Current work is on `codex/indoor-yard-reference`, separate from live main.
The draft includes a 96 x 144 m indoor Yard, four stairs and side galleries,
freight cases, service modules, machined equipment, glass roof, indoor tree
islands, authored signs and dry daylight. Captures in `art-review/` show the
actual game, not image-generated substitutes. The layout and materials are
closer to the references, but environment detail and shading still fall
short of the approved concept fidelity. Do not describe this as finished.

Procedural operator equipment was tried, rendered, rejected as too crude
and removed from the runtime. The existing skins are still in place.
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

Immediate bug reports: aim transition overlays the optic while the gun model
still occupies its lens; Arena screenshot at (-13.6, 0.9, 15) faces +Z toward
the old up2 switchback's vertical landing. Reproduce that exact approach,
without jumping, rather than relying only on tests of other ramps.
