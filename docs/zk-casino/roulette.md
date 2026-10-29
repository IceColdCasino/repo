# Roulette

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

A single winning pocket is an encrypted “card” on a 37-pocket (EU) or
38-pocket (US, includes `00`) wheel. Players commit **encrypted bets**
(`type || modifier`) before showdown. Circom opens the pocket, decrypts
each bet under the prover’s key, and applies the payout table.

The house seat shuffles the wheel and does not bet. Payouts come from the
dealer pool. Coverage before `start_hand` is `max_bet` times the twelve class
multipliers (35, 17, 17, 11, 8, 8, 5, 2, 2, 1, 1, 1) times the number of
seats. Action collection and the pool-win edge are each 250 bps. See
[on-chain](../on-chain.md#dealer-pool).

## Shoe

| | |
|--|--|
| Encoding | Pocket `0..36` (EU) or `0..37` (US, `37 = 00`) → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_1_deck_37_main`, `shuffle_1_deck_38_main` |
| Opened at showdown | 1 |
| Showdown terms | 12 bet codes |

The house seat shuffles; it does not place a player bet.

## ZK pipeline

1. **Register / shuffle** — one-index shoe (the wheel).
2. **Bet commit** — `roulette_bet` / `roulette_bet_{37,38}_main` packs and
   ElGamal-encrypts each `type` + `modifier` as `BabyPbk(packed + 1)`.
3. **Share** — `roulette_share_hashout_main` is `ShareHashOut(12, 1)`. The
   public output is a Poseidon of one ciphertext-hash per other player.
4. **Showdown** — decrypt pocket and bets. The public field sums
   `(code_i + 1) · coefficient_i` over all 12 bet classes.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `roulette_bet.circom` + `bet.circom` `PackBet` | Legal type/modifier; unique actual bets |
| `roulette_eval.circom` | Straight, split, street, corner, column, dozen, even-money, US row / top line |
| `roulette_showdown.circom` | Decrypt pocket and bet ciphertexts; bind `nActualBets` into the input hash |

The pocket uses the **aggregate** key (same as every shoe). Bets are
encrypted to the **proving player’s** key so only that player’s ticket is
opened in their showdown proof.

Payout codes (see comments in `roulette_eval.circom`): straight 35:1
through even-money 1:1; `0` / `00` lose even-money bets.

## Public vs private

| Public | Private |
|--------|---------|
| `hash`, `(packed + 1) · c0 + c1`, Groth16 proof | `sk`, winning pocket, bet types/modifiers, 2 coefficients, seal commitment |

`hash` is `Poseidon(keys, playerIndex, ciphertextHash, betHash, nActualBets, sealCommitment)`. The showdown template checks that equality. `packed` is `Σ code_i · 36^i` over the twelve bet classes. The second result is `0`.

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_1_deck_37_main.circom` / `shuffle_1_deck_38_main.circom` | Wheel |
| `roulette_bet_37_main.circom` / `roulette_bet_38_main.circom` | Ticket commit |
| `roulette_share_hashout_main.circom` | Pocket partials |
| `roulette_showdown_37_hashout_main.circom` / `roulette_showdown_38_hashout_main.circom` | Payouts |

## Host test

`test/complete_roulette_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
