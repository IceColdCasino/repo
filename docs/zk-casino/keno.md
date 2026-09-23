# Keno

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

An 80-number cage. Showdown opens **20** drawn numbers. The player’s spots
are ElGamal-encrypted before the draw is opened. Circom counts how many
committed spots appear in the draw.

## Shoe

| | |
|--|--|
| Encoding | Number `0..79` → `BabyPbk(v+1)` |
| Shuffle main | `shuffle_1_deck_80_main` |
| Opened at showdown | 20 |
| Poly-hash terms | 1 (hit count) |

House seat shuffles.

## ZK pipeline

1. **Register / shuffle** — 80-ball shoe.
2. **Bet commit** — `keno_bet` / `keno_bet_main` encrypts up to 20 spots.
3. **Share** — `keno_share_hashout_main` seals partials for the 20 draws.
4. **Showdown** — decrypt draws + spots; `keno_eval` sums matches among
   the first `nActualBets` spots.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `keno_bet.circom` | Encrypted spot list; unused slots ignored via `nActualBets` |
| `keno_eval.circom` | Hit count: each actual bet vs each of 20 draws |
| `keno_showdown.circom` | Decrypt both; bind bet ciphertexts and `nActualBets` into the input hash |

There is no paytable in Circom — only the **hit count**. Multiplier tables
live outside the circuit. The ZK statement is “these sealed spots hit the
opened 20 this many times.”

## Public vs private

| Public | Private |
|--------|---------|
| Input hash, hit-count output hash | `sk`, 20 draws, chosen spots |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_1_deck_80_main.circom` | Cage |
| `keno_bet_main.circom` | Spot ticket |
| `keno_share_hashout_main.circom` | Draw partials |
| `keno_showdown_hashout_main.circom` | Hits |

## Host test

`test/complete_keno_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
