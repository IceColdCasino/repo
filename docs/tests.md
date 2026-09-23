# Host tests

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

`test/complete_*_game_with_proofs.test.ts` plays a full table in Bun. Each
turn is a real Groth16 proof from [libzkcasino](./libzkcasino.md) against
the keys in [zkeys.md](./zkeys.md). The tests are not hash unit tests and
they do not call circomlibjs.

## Run

Build the libraries first (`zig build`, `zig build player-lib`,
`zig build player-bridge-lib` inside `libzkcasino/`). `zkey/` must already
contain the proving keys, and `rapidsnark/lib/librapidsnark.dylib` must be
the local rapidsnark build. Then, from the repository root:

```sh
bun install
bun run typecheck
bun run test:games
```

`test:games` is `bun test test/complete_*_game_with_proofs.test.ts`.
`typecheck` is `tsc --noEmit` over `src/` and `test/`.

`test/helpers/require-player-ffi.ts` fails immediately if either dylib is
missing. A missing zkey fails later, when that circuit is proved or verified.

## GitHub Actions

Pushing to `main` runs `.github/workflows/tests.yml`. Typecheck uses a small
Linux runner. Each game runs twice, on `ubuntu-24.04-arm` and on `macos-26`:
the proving keys are about 12 GB together, and a standard runner cannot hold
all of them plus the witness build. The job downloads that platform’s arm64
rapidsnark library from the iden3/rapidsnark release (`librapidsnark.so` on
Linux, `librapidsnark.dylib` on macOS), installs GMP, builds the witness
libraries for that game (`zig build -Dcircuit-set=<game>`), pulls only that
game’s keys from Git LFS, then runs the matching `complete_*` file.

Those jobs need `zkey/` and `.gitattributes` on `main`. The blackjack
eight-seat case stays skipped.

One file:

```sh
bun test test/complete_poker_game_with_proofs.test.ts
```

`-t` is a regular expression matched against the test name.

## What one turn does

1. The `Player` sends a JSON op to `libzkcasino-player-bridge`. Zig builds
   the witness and rapidsnark proves it. The returned proof and public
   signals are what the table sees. TypeScript does not build the witness.
2. The `Game` checks the phase and whose turn it is.
3. The `Game` asks libzkcasino `calc` for the hash of the table state it
   already has (deck, keys, bets, sealed coefficients). That value must
   equal the hash public signal. This is the check that the proof is about
   this table and not a different deck or bet vector.
4. `src/rapidsnark-ffi.ts` verifies the proof against
   `zkey/<circuit>_verification_key.json`.
5. Only then does the `Game` store the public outputs (shuffled deck,
   partials, winner limbs) and advance the phase.

If step 3 or 4 fails, the game method throws and the test fails. Several
files also call `verify` again on the showdown proof and compare the
decrypted faces with the outcome every seat computed.

Showdown coefficients in these tests are `hostShowdownCoefficients`:
`1n, 2n, …`. That vector stands in for the coefficients Arcium would seal
to the player. The tests check that the circuit and the host hash the same
limbs under those coefficients. They do not run Arcium.

## What is being tested

For every game below, a passing test means:

- Registration, shuffle, share, and showdown each produced a proof that
  verified, and each input hash matched the Zig calculation of the table
  state.
- Empty seats are the identity key, padded out to the committee size the
  circuit was compiled for.
- After the last showdown the phase is `Complete`.
- The opened cards, dice, pocket, draw, or called balls are the plaintext
  the proving player decrypted, and every seat agrees on the public result
  hash.

It does not mean the powers-of-tau ceremony was audited, that a forged
proof was searched for, or that Solana settlement ran.

| File | Cases | Extra checks |
|------|-------|----------------|
| `complete_poker_game_with_proofs.test.ts` | 2 players; 3 with one fold; 10 with five folds; 10 seated | Folded seats are zero in the winner mask. Seats agree on the mask limbs |
| `complete_blackjack_game_with_proofs.test.ts` | 1, 2, and 3 players plus the dealer | Action proof for hit / stand / split. Non-dealer action coefficients are `[1n, 0n]` because the circuit forces the ace coefficient to 0. Showdown output matches the host settlement hash. The 7-player plus dealer case is skipped unless `RUN_SLOW_BLACKJACK_8P=1` |
| `complete_baccarat_game_with_proofs.test.ts` | 2, 3, 10, and 12 players, plus a multi-seat pool | Player / banker / tie matches the decrypted hands. Pool nets are the proportional settlement of those seats |
| `complete_war_game_with_proofs.test.ts` | 2, 3, 10, and 12 players, plus a multi-seat pool | Same shape as baccarat: winner from the faces, then proportional seat nets |
| `complete_roulette_game_with_proofs.test.ts` | European 37 with 2 and 3 players; American 38 with 2 | Winning pocket equals the decrypted wheel index. The 12 payout limbs match the host hash of the committed tickets |
| `complete_craps_game_with_proofs.test.ts` | 2 players, bets committed after the shuffle | Both dice match the decrypted faces. The 14 showdown limbs match the host hash |
| `complete_keno_game_with_proofs.test.ts` | 2 players, tickets committed after the shuffle | The 20-ball draw matches the decryption. The hit-count hash matches the host |
| `complete_slot_game_with_proofs.test.ts` | 3-reel and 5-reel, dealer plus one player | Center symbols match the decrypted reel window. The dealer’s coin bet is 0 and the player’s is 3. The award hash matches the host |
| `complete_bingo_game_with_proofs.test.ts` | 75-ball and 90-ball, 2 players, card committed after register, one 5-ball share, `nCalled = 5` | Called balls match the decrypted prefix. The pattern hash matches the host. Uncalled shoe slots are BabyJub base-8 ciphertexts so `PartialDecrypt` can run on the whole shoe; equality to plaintext is only required for `i < nCalled` |

## What the tests do not cover

- Arcium MPC, sealed-coefficient delivery, and Solana programs.
- Seat counts other than the cases in the table.
- Isolated mains (`poker_hand_eval_main`, `poker_compare_hands_main`,
  `craps_bet_eval_main`). Those templates run inside a showdown, but the
  tests do not prove the isolated main.
- A second trusted setup. Verification succeeds for the keys currently in
  `zkey/`. Replacing a key without rebuilding the proofs makes that circuit’s
  tests fail.
