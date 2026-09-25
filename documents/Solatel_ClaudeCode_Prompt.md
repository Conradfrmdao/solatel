# Solatel — Build Prompt for Claude Code

Paste everything below into Claude Code to start the build. Work through it phase by phase — do not try to build everything in one pass.

---

## Project Summary

Build **Solatel**, a global, browser-based, skill-based multiplayer first-person shooter where players pay a small entry fee in crypto (Solana) and earn real money for every kill. This is a real-money game, so correctness, fairness, and security matter more than visual polish.

- **Entry fee:** $1 per match (in Solana / USDC-SOL)
- **Kill reward:** ~$0.90 per kill, credited instantly to the player's internal balance
- **Platform fee:** ~$0.10 per kill
- **Match size:** 6–10 players
- **Match style:** Continuous-cycle — no fixed start/end, players join anytime (similar to BR1: Infinite)
- **Minimum withdrawal:** $5–10, paid out on-chain to the player's Solana wallet
- **Platform:** Browser-based (not a native download) — this is a deliberate choice to minimize friction for new players
- **No skill-based matchmaking at launch** — defer until there's real player data

Full product context is in the attached PRD (Solatel_PRD.pdf). Read it before starting.

---

## Tech Stack

- **Game engine:** Bevy (Rust), compiled to WebAssembly for browser play
- **Blockchain:** Solana (near-instant finality, ~$0.00025 fees — ideal for microtransactions)
- **Backend:** Server-authoritative — the server is the single source of truth for movement, hits, and kills. Never trust client-reported state.
- **Networking:** WebSockets or WebRTC for real-time transport, with client-side prediction and interpolation to smooth perceived lag
- **Ledger:** Internal balance tracking in a backend database. Deposits convert to internal balance; kills update balance instantly; **only withdrawals trigger real on-chain Solana transactions**
- **Treasury wallet:** Multi-signature, not single-key
- **Wallet integration:** Standard Solana wallet connection (e.g. Phantom-compatible) for deposits and withdrawals

---

## Build Phases — Work Through These in Order

### Phase 1: Project Scaffolding
- Set up a Bevy project targeting `wasm32-unknown-unknown`, with a working build pipeline that outputs a playable browser build (even if it's just a cube moving around a flat plane at this stage)
- Set up a separate backend service (language of your choice, but justify the pick) with a Postgres or similar database for the ledger
- Set up basic WebSocket communication between the Bevy client and the backend
- Confirm the whole pipeline works end to end before writing any gameplay code: client connects, server acknowledges, a message round-trips

### Phase 2: Core Movement and Shooting
- First-person camera and movement (WASD + mouse look), server-authoritative position updates
- Basic hitscan shooting with server-side hit validation
- A simple test map (doesn't need to be pretty — needs good sightlines and cover so movement/shooting can actually be evaluated)
- **This phase is the one that will need the most iteration.** Expect to build a version, have the user (Conrad) test it, describe precisely what feels wrong (e.g. "there's a delay between clicking and the shot registering", "strafing feels floaty"), and refine. Don't try to nail movement feel in one pass.

### Phase 3: Match Lifecycle and Ledger
- Match join/leave flow supporting the continuous-cycle model (no fixed start/end, 6–10 players per match)
- Backend ledger: deposits create/update internal balance; a kill event updates the killer's balance instantly (~$0.90) and logs the platform fee (~$0.10)
- Basic admin/debug view to inspect a player's balance and match history (useful for your own testing and for catching bugs before real money is involved)

### Phase 4: Solana Wallet Integration
- Wallet connect flow (deposit)
- Withdrawal flow: minimum $5–10, triggers a real on-chain transaction from the treasury (multi-sig) wallet to the player's wallet
- **Do not connect this to real funds until Phases 1–3 are solid and tested.** Use Solana devnet/testnet throughout development.

### Phase 5: Anti-Cheat Foundations
- Server-authoritative hit detection (should already be true from Phase 2 — verify it holds under adversarial testing, e.g. try to cheat your own client)
- Basic behavioral flagging: log statistically implausible performance (accuracy, reaction time) for later review
- A manual replay/review checkpoint before a payout is finalized (doesn't need to be automated at launch — a flagged-match queue a human can review is enough to start)

### Phase 6: Polish and Launch Prep
- Deploy client to a hosted URL, confirm the full flow works for a stranger with no prior context
- Load-test the match join flow with concurrent connections
- Final review of anti-cheat, ledger integrity, and withdrawal flow before going live with real funds

---

## Working Style for This Project

- **Build in small, testable increments.** After each meaningful change (especially to movement, shooting, or the ledger), stop and let Conrad test it before moving on.
- **Never skip server-side validation** for anything involving money or hit detection, even for early prototypes — bad habits here are expensive to unwind later.
- **Use Solana devnet for all development and testing.** Do not touch mainnet or real funds until Conrad explicitly says the platform is ready.
- **Flag anything that feels like it needs real playtesting to get right** (especially movement/shooting feel) rather than guessing at values — ask for a test pass instead.
- **Keep the client lightweight.** Visual fidelity is a low priority; responsiveness and reliability are not.

---

## First Task

Start with **Phase 1** only. Set up the Bevy WASM project and the backend skeleton, confirm they can talk to each other, and report back before writing any gameplay code.
