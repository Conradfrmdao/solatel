# Mobile recovery, readiness and operator release — November 14

The active roster is Ranger (5), Breacher (6), Engineer (7), and Ghost (8).
Retired selections migrate to Ranger in the menu and on the server. IDs are
not renumbered, so recorded matches and existing selections remain readable.
The old full-body soldier and seven palette portraits are excluded from the
published asset manifest. The source soldier remains only as reproducible
input to `scripts/extract-firstperson-arms.py`. Its extracted output contains
only the working arm triangles, skeleton, textures and gripping clip. It is
1.33 MB versus the original 2.42 MB, and cannot render the retired body.

## Findings and changes

- A phone leaving the app could keep a WebSocket that reported OPEN but no
  longer delivered anything. Expired pings were discarded without recovery.
  The client now detects silent connections, reconnects on a sustained app
  switch, rejects callbacks from abandoned sockets and bounds queued input.
- An expired server resume window could leave the client believing it was
  still in the old match. A non-resumed welcome now clears that match and
  returns to the lobby. It does not requeue, recharge, or decide any payout.
- A slow frame previously reconciled every accumulated snapshot. It now uses
  the newest full state per match while retaining every reliable event in
  order. The server similarly collapses queued obsolete snapshots, times out
  blocked writes and disconnects the corresponding reader cleanly.
- The actual authoritative loop now reports step cost, tick rate and lateness.
  Its command-draining loop has a bounded batch so sustained input cannot
  indefinitely postpone simulation. The old separate idle clock log is not
  evidence of actual match performance.
- The first local cold Yard run measured 3.8 seconds in map loading, 2.2
  seconds in world shader compilation and 0.46 seconds in weapon compilation,
  before additional initial rendering/upload work. Preparation now starts
  when the player queues and is shared with match entry. It still must finish
  before sending loaded. Cached preparation is invalidated after GPU context
  restoration. Compilation timings vary substantially by shader cache, rig,
  hardware and concurrent work; do not claim a universal loading speedup.
- Grenade aiming previously calculated 161 path points every preview refresh
  and discarded all but 65. The dedicated preview calculates only those 65,
  exactly matching the full trajectory prefix. Release still predicts the
  full authoritative trajectory and retains its acknowledged release latch.
- Yard's diffuse light-volume strength is increased by 22%, with a higher
  minimum indirect fill in covered areas. Direct sun, exposure, shadow
  geometry, controls and collision remain unchanged. This lifts shaded walls,
  cargo and operators without adding runtime lights or render passes.
- Installation guidance appears on the first mobile visit during loading.
  iPhone instructions explain Safari Share → Add to Home Screen; Android
  uses its native prompt when provided, otherwise the browser-menu guide.
  Browser play remains available. No claim of automatic Safari installation.

## Verification and limits

Client tests cover interrupted sockets, stale callbacks, snapshot coalescing,
expired resume, controls, grenade release and audio. Protocol and server
regressions cover roster migration and existing multiplayer rules.

The mobile Chromium test returned to the same player and same active match
after a simulated 2.5-second background interruption. It also checked the
preview prefix against the actual WASM flight. Screens and measurements are
under `.artifacts/resume-loading/`.

The final warm-entry test delayed queue submission by 30 seconds to give
preparation time to finish, then measured 9.7 ms from match assignment to
the client's loaded signal. Map fetching/loading took 2.98 seconds and
preparation took 11.65 seconds in that run: the work moved into the queue
wait, it did not disappear. Immediate matches can still wait for this work.
Forced WebGL context loss/restoration recovered the same active match.

Final checks: 28 client unit tests, 117 protocol tests and 170 server tests
passed (9 database-dependent tests skipped); Rust formatting and Clippy
passed. Touch smoke tests checked simultaneous movement and grenade aiming,
release, sprint, ADS, persisted preferences and installation dismissal.
UI checks covered 568x320, 844x390, 852x300 and 390x844 viewports with no
reported layout failures. All four operator assets loaded with their
52-bone rigs and idle/run/aim/fire/death clips, without browser errors.

The isolated two-client test with 110 ms one-way delay and 20 ms jitter ran
for 18 seconds without meaningful movement corrections. Input acknowledgement
was about 310 ms median and 374 ms p95. These include the imposed network
travel and snapshots; they are not input-to-local-render latency. The local
server's game-loop window held 64 ticks per second, averaging 0.13 ms per
step, with a 6.8 ms worst step. This is not a production load test.

Physical 2017–2018 phones, sustained thermal performance, and the live VPS
load have not been validated. The available VPS login was rejected. A Canadian
server's network distance from Uganda cannot be removed by increasing CPU.
No region migration or Uganda payment changes are included in this release.
