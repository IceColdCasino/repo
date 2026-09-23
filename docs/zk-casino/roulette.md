# Roulette

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

A single winning pocket is an encrypted “card” on a 37-pocket (EU) or
38-pocket (US, includes `00`) wheel. Players commit **encrypted bets**
(`type || modifier`) before showdown. Circom opens the pocket, decrypts
each bet under the prover’s key, and applies the payout table.

## Shoe

| | |
|--|--|
| Encoding | Pocket `0..36` (EU) or `0..37` (US, `37 = 00`) → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_1_deck_37_main`, `shuffle_1_deck_38_main` |
| Opened at showdown | 1 |
| Poly-hash terms | 12 bet-code limbs |

The house seat shuffles; it does not place a player bet.

## ZK pipeline

1. **Register / shuffle** — one-index shoe (the wheel).
2. **Bet commit** — `roulette_bet` / `roulette_bet_{37,38}_main` packs and
   ElGamal-encrypts each `type` + `modifier` as `BabyPbk(packed + 1)`.
3. **Share** — `roulette_share_hashout_main` seals the pocket partials.
4. **Showdown** — decrypt pocket + bets; `EvaluateBetEU` / `EvaluateBetUS`.

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
| Input hash (deck + bet ciphertexts + `nActualBets`), 12-limb output hash | `sk`, winning pocket, bet types/modifiers |

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
