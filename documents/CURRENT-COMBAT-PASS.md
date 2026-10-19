# October 19 follow-up

Protocol 25: hold G to prepare/aim, release to throw. No timed auto-release
and no server wind-up after release. Focus loss cancels the hold. The held
hand has an upright grip; the short preview arc and predicted local flight
use the shared Rust collision/flight simulation. The server still decides
explosion and damage. Snapshot matching suppresses a duplicate grenade.
The release command stays present until acknowledgement, and the server
preserves its edge through long guesses so a stall cannot throw twice.

Local browser test added 250 ms RTT and a 600 ms main-thread stall. Holding
1.8 seconds consumed no grenade and launched nothing. Release displayed
locally in 3 ms, then exactly one server grenade appeared; count fell from
2 to 1. The predicted mesh was removed after the authoritative flight ended.
No JS errors, including firing after the throw. Screenshot/report are in
.artifacts/grenade-hold. This is a local verification, not a live release claim.

Predicted static-world bullet impacts now appear at shared ballistic arrival
instead of waiting for the server. Confirmed duplicate world effects are
suppressed. No predicted blood, damage or rewards; potentially intercepted
shots defer to the server. Node tests cover delays of 100/250/500 ms.

The user's whole-scene lateral stair wobble remains unresolved/unreproduced.
A live keyboard W climb on the central flight measured zero lateral movement,
zero camera yaw/roll and zero prediction correction at 252–258 ms RTT.
This does not invalidate the user's report about both sets of stairs.

# Combat pass — October 17, 2026

Combat batch pushed as 00b10c36e637; live at solatelgame.com:
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
corrections, fixed yaw/roll, reached y=5.401. Central trace also completed: 145 frames, zero corrections, ~2 mm total
lateral movement while ascending; no yaw or roll oscillation. No reconciliation bypass in this test.

Follow-up: live camera trace did show vertical frame jumps up to 0.247 m.
The old smoothing accelerated with distance, undoing much of its effect
while running. A critically damped height/velocity filter replaces that
term; tall-riser regression passes at 30/60/120 FPS while real jumps and
falls still bypass it. Browser validation passed with zero corrections: central-stair peak vertical
frame change fell from 0.127 m to 0.074 m, and peak upward speed from
9.87 to 5.44 m/s in the captured runs. No downward eye movement on ascent.
This addresses measured upward kicks; lateral oscillation has not yet been
reproduced and should not be claimed solved.
