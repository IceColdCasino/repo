# Proving keys

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

`zkey/` holds the Groth16 proving key and verification key for every main
the host tests prove. Git LFS tracks the whole directory (`zkey/**` in
`.gitattributes`).

A proof is an argument that a witness satisfies one compiled circuit under
one setup. The prover (libzkcasino, via rapidsnark) reads the proving key.
The verifier (`src/rapidsnark-ffi.ts`, and every `Game` method that calls
it) reads the verification key. A proof only verifies against the
verification key exported from the same `.zkey`.

## File names

For a Circom main `circuits/<name>.circom`:

| File | Who reads it |
|------|----------------|
| `zkey/<name>_0001.zkey` | Prover |
| `zkey/<name>_verification_key.json` | Verifier |

`<name>` is the main, including the `_main` suffix:
`register_main_0001.zkey`, `poker_showdown_hashout_main_0001.zkey`,
`bingo_showdown_75_hashout_main_0001.zkey`.

`libzkcasino` resolves those paths in `src/zig/prove/paths.zig`. It finds
the repo by walking upward until `zkey/register_main_0001.zkey` exists.
The TypeScript verifier joins `zkey/<circuit>_verification_key.json` from
`src/zk-game-base.ts`.

The `_0000` file is the setup output before the contribution. `calc.sh`
does not keep it.

## What the setup is

`./calc.sh <main>` from the repository root:

1. Compiles `circuits/<main>.circom` with circom (`-c --O2 --r1cs`) into
   `build/`. Those intermediates are not the keys.
2. Sizes a Hermez powers-of-tau file (`~/ptau/powersOfTau28_hez_final_*.ptau`)
   to the constraint count. The smallest power is 16. The largest accepted
   power is 28. A second argument overrides the power.
3. Runs `snarkjs groth16 setup` on a RAM disk, then one `zkey contribute`.
   The contribution entropy comes from `/dev/random`.
4. Exports the verification key and copies `<main>_0001.zkey` and
   `<main>_verification_key.json` into `zkey/`.

That contribution is a local development setup, not a multi-party ceremony.
The entropy used in `zkey contribute` is the toxic waste for that key. It
is not stored in this repository. Anyone who kept it can forge proofs for
that circuit. Re-running `calc.sh` for a main replaces both files; proofs
made under the previous key do not verify.

Regenerating a key needs `circom`, `bun`, `snarkjs` (pulled by the script),
`node_modules/circomlib`, and the powers-of-tau file. The script downloads
a missing tau file into `~/ptau/`. Large showdowns need a bigger RAM disk
(`RAMDISK_SIZE_MB`) and a larger Node heap (`NODE_OPTIONS`).

## Keys the tests load

Register and the shared shuffles are used by every game that has that shoe.
Share, showdown, bet, action, and card keys are per game. The witness
library that knows each circuit is listed in `libzkcasino/build.zig`.

| Game | Mains proved by the host tests |
|------|--------------------------------|
| All | `register_main` |
| Poker | `shuffle_1_deck_52_main`, `poker_share_hashout_main`, `poker_showdown_hashout_main` |
| Blackjack | `shuffle_{1,6,8}_deck_52_main`, `blackjack_share_hashout_main`, `blackjack_action_hashout_main`, `blackjack_showdown_hashout_main` |
| Baccarat | `shuffle_{1,6,8}_deck_52_main`, `baccarat_share_hashout_main`, `baccarat_showdown_hashout_main` |
| War | `shuffle_{1,6,8}_deck_52_main`, `war_share_hashout_main`, `war_showdown_hashout_main` |
| Roulette | `shuffle_1_deck_{37,38}_main`, `roulette_bet_{37,38}_main`, `roulette_share_hashout_main`, `roulette_showdown_{37,38}_hashout_main` |
| Craps | `shuffle_2_dice_6_main`, `craps_bet_main`, `craps_share_hashout_main`, `craps_showdown_hashout_main` |
| Keno | `shuffle_1_deck_80_main`, `keno_bet_main`, `keno_share_hashout_main`, `keno_showdown_hashout_main` |
| Slots | `shuffle_{3,5}_reel_22_main`, `slot_share_{3,5}_reel_hashout_main`, `slot_showdown_{3,5}_reel_hashout_main` |
| Bingo | `shuffle_1_deck_{75,90}_main`, `bingo_card_{75,90}_main`, `bingo_share_hashout_main`, `bingo_showdown_{75,90}_hashout_main` |

Isolated mains such as `poker_hand_eval_main` and `craps_bet_eval_main` are
circuit sources. The complete-game tests do not prove them on their own.
They are exercised only as templates inside the showdown the test does prove.
