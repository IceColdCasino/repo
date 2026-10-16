# Bingo

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Called balls come from a 75-ball or 90-ball shoe. The player’s card is an
ElGamal-encrypted cell vector committed before (or independently of) the
call sequence. Circom opens the called prefix, marks hits on the card, and
proves a pattern win plus the 1-based call index at which the pattern
completed.

Bingo has no house seat and no dealer pool. Each card locks the same price
into one pot. Seats that complete on the earliest winning call split it.
75-ball uses the table pattern. 90-ball pays the full-house term; one-line
and two-lines stay in the proof. Keno stays house-funded. See
[on-chain](../on-chain.md#bingo).

## Shoe

| | |
|--|--|
| Encoding | Ball `0..74` or `0..89` → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_1_deck_75_main`, `shuffle_1_deck_90_main` |
| Opened at showdown | Called prefix (`nCalled` ≤ variant size) |
| Showdown terms | 75-ball: `[packed, 0]`. 90-ball: 3 pattern limbs |
| Card cells | 25 (75-ball) or 27 (90-ball) |
| Share chunks | 15 × 5 balls (75) or 18 × 5 balls (90) |

## ZK pipeline

1. **Register / shuffle** — 75- or 90-ball cage.
2. **Card commit** — `bingo_card` / `bingo_card_{75,90}_main` encrypts
   cells (and pattern id for 75).
3. **Share** — `bingo_share_hashout_main` in 5-ball windows. The public
   output is `Poseidon(5)` of the five ball hashes. The chain recomputes
   one ball from that ball’s partials.
4. **Showdown** — `VerifyCalledBalls` only forces decrypt≡plaintext for
   `i < nCalled`. 75-ball publishes `(packed + 1) · c0 + c1`. 90-ball
   sums three pattern limbs.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `bingo_card.circom` | Encrypted card; legal cell set for the variant |
| `bingo_eval.circom` | Pattern AND/OR over marked cells; `PackBingoTerm(won, completionIndex)` |
| `bingo_showdown.circom` | Decrypt called prefix + card cells; bind `patternId` and `nCalled` |

75-ball uses a single packed term `won * 256 + completionIndex`. 90-ball
emits three limbs (more pattern groups). Unused future calls are **not**
required to match `P(v)` — same “used prefix” idea as blackjack’s
`nUsedCards`.

Keno-style helpers (`keno_bet.circom`) appear for packing encrypted cell
scalars; the game logic is bingo patterns, not a keno hit count.

## Public vs private

| Public | Private |
|--------|---------|
| `hash`, the seal polynomial, Groth16 proof | `sk`, called balls, card cells, completion index, 14 coefficients, seal commitment |

75-ball `hash` is `Poseidon(keys, playerIndex, ciphertextHash, cardHash, patternId, nCalled, sealCommitment)`. 90-ball drops `patternId`. The showdown template checks that equality.

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_1_deck_75_main.circom` / `shuffle_1_deck_90_main.circom` | Cage |
| `bingo_card_75_main.circom` / `bingo_card_90_main.circom` | Card commit |
| `bingo_share_hashout_main.circom` | Call partials |
| `bingo_showdown_75_hashout_main.circom` / `bingo_showdown_90_hashout_main.circom` | Pattern win |

## Host test

`test/complete_bingo_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
