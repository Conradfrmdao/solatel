# Brief for the next session (from Conrad, 10 October 2026)

Read `documents/HANDOFF.md` (newest entry first) and `CLAUDE.md` before
anything else. Its rules are not negotiable: the server is authoritative,
money is `MicroUsd` integers, the ledger is append-only, Solana stays on
devnet. Work on branch `claude/confident-feynman-6benf7`, which holds
unmerged work. For every change: commit, PR, merge, watch
`https://solatelgame.com/deploy.json`, then tell Conrad in short plain words
and ask for a playtest. Prove visual changes with screenshots
(`client/tour.mjs`). Run the tests, clippy and the browser drivers before
every merge.

**Do a lot of research first.** Look at how Call of Duty, Battlefield,
Valorant and CS2 handle each topic below: lighting, materials, map
dressing, first-person arms, reload animation, sprint, gamepad. Use web
searches, GDC talks, and CC0 asset sources such as Poly Haven, ambientCG
and Quaternius. Then design. Be creative and add things that make the game
better. The bar is "production ready, the best it can be, visually
appealing in every way", most of all on the yard and the facility, which
are not yet up to standard.

## 1. Finish what was in progress (see HANDOFF)
- Sunny yard and facility (unmerged on the branch):
  - re-shoot the yard's menu card `assets/menu/map-yard.webp` (880x550)
    in the sunny light;
  - test, PR, merge, ship.

## 2. Maps: production ready, modern, realistic
- **Yard and facility above all; the arena too.** Be creative:
  - real detail on the plain concrete walls (panels, trims, pipes, signage);
  - many more props (pallets, cables, fences, AC units, lights, vehicles);
  - ground decals (oil, tyre marks, painted bay lines, cracks);
  - better corner shading;
  - believable buildings with windows that are real openings.
- Keep each map under its download budget (~50 MB). Nothing may give a
  hiding advantage, and the look must be the same for every player.
- **Arena stairs.**
  - Remove the "Z" (zigzag) stairs. Players hit an invisible barrier on them
    and cannot climb.
  - Keep the newer ramps/stairs, but move them so they actually reach the
    upper level. Today a player can only get up by climbing the stairs,
    stepping onto the metal bars and jumping.
  - Make every way up walkable without jumping, and prove it in
    `map.rs` tests (`ARENA_RAMPS` etc.).
- **Shots and grenades through openings.** Close to walls, shooting
  through windows fails, and a thrown grenade will not pass through a
  window either.
  - Check every map, for bullets *and* grenades (`sim/grenade.rs`
    collision).
  - Check the player's own collision box and the muzzle/eye origin near
    walls.
  - Use `scripts/check-openings.py` and extend it to grenades.
  - Also fix the leftovers: the crawlspace under sloped ramps is filled,
    and slab undersides hang a cell low.

## 3. Players, hands, guns: make them look and feel great
- **First-person hands and arms** look bad and unrealistic. Make them
  realistic: proper skinned arms, gloves and sleeves of the player's suit,
  good materials and lighting.
- **The pistol** is too small and disappears in the hands.
  - Match the reference picture Conrad sent: a proper two-handed pistol
    hold, a realistic size on screen.
  - If the picture isn't in the repo, ask him to send it again.
- **Third-person soldiers** must look very nice and realistic: suit,
  gear, materials.
- **Guns:** better looking, better animations (idle, shooting, recoil,
  switching), and a fantastic, detailed **reload for every gun**.
- **Sound:** a real reload sound for each gun, and gunshot sounds tuned
  per gun until they are perfect.
- **Bullets** must go exactly where aimed and not be stopped by walls that
  aren't drawn.

## 4. Gameplay
- **Add sprinting.**
  - Server-authoritative, in the shared sim (`step_tick`), predicted by
    the wasm.
  - Bump the protocol if the wire changes.
  - Add a sprint animation, view bob, and rules for sprint-to-fire delay.

## 5. Make sure the wallet works end to end
- Deposits (SOL and USDC, devnet), withdrawals, and balances in the menu.
- Run the ledger tests (`bash scripts/test-ledger-local.sh`) and the
  drivers.
- Do not move devnet SOL or touch any real money without asking Conrad
  first.

## 6. Later, only when Conrad says he's happy with all of the above
- Gamepad/controller support, with buttons players can remap.

Conrad's standing rule: never, without asking first, move money in any
database, move devnet SOL, touch mainnet, write secrets into files, commit
raw Mixamo files, or disable TLS checks.
