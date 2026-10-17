# Combat pass — October 17, 2026

Implemented locally, pending publication:
- Yard has visible steel stair infill with derived collision on all six flights.
  Map version 33, 5,571 brushes, 42 spawns; lighting regenerated.
- Space climbs reachable 0.7–1.8 m ledges in shared simulation. Body route,
  headroom and landing clearance are checked. Death cancels the climb;
  snapshots/WASM reconciliation preserve climb and jump-edge state. Protocol 24.
- Grenade throw uses a compact visible arc and a fixed-shoulder two-bone solve;
  fingers open on release. Held grenade moves/rotates with the hand.
- Machine-gun pose and audio share a timing curve: brisk removal/insertion/
  charging actions, with the long portion spent retrieving the magazine.
- Server-confirmed landings now appear immediately on receipt instead of
  replaying flight time. Hit-confirmation audio comes from its dedicated event.
- Seven original Qwen Ryan soldier callouts replace the calm Kokoro clips,
  including Bagged it and Sweet money. MP3s, provenance and generator updated.

Validation so far:
- Workspace tests: 115 protocol +168 server +1 WASM passed; nine database tests
  ignored by the standard suite. Additional guard and angled-climb tests passed.
- Clippy passed; WASM build and instantiation check passed.
- Six Node input/timing/camera/audio tests passed.
- Browser scope/throw sequence and keyboard grenade flight passed without JS
  or HTTP errors. Captures: .artifacts/combat-review.
- Yard browser review decoded all seven voices, verified mute/overlap guards,
  rendered map/explosions with no JS/HTTP errors (.artifacts/release-review).
- Real local server climb with ~260 ms RTT: zero prediction correction, smooth
  forward camera motion and no downward eye movement on the side flight.

IMPORTANT unresolved user feedback:
User says the WHOLE SCENE still wobbles left/right on BOTH central and side
Yard stairs. Do not claim this resolved. Earlier vertical smoothing commit
is live (ee7134d) but does not settle this feedback. Angled geometry regression
passes on both live and new Yard collision. Need actual live network trace,
central stair trace and root cause. .artifacts/network-stairs.mjs navigates a
server-connected player to stairs and captures camera/correction state; --live
uses the real site, --central selects the middle flights. Live side-stair trace completed: 122 frames, RTT 277–345 ms, zero prediction
corrections, fixed yaw/roll, reached y=5.401. Central trace is still running. No reconciliation bypass in this test.
