# Poker (Texas Hold'em)

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Mental-poker Texas Hold'em for 2–10 players. One 52-card deck. Street betting
is **outside** these circuits; Circom proves shuffle, share, and a winner-mask
showdown over encrypted holes and board.

## Shoe

| | |
|--|--|
| Encoding | Card `0..51` → `BabyPbk(v+1)` |
| Shuffle main | `shuffle_1_deck_52_main` |
| Opened at showdown | 25 indices (player `i` holes `2i, 2i+1`; board `20..24`) |
| Poly-hash terms | 9 winner-mask limbs |

## ZK pipeline

1. **Register** — shared `register_main`.
2. **Shuffle** — each player permutes and re-encrypts the 52-card shoe.
3. **Share** — `poker_share` / `poker_share_hashout_main` seals partials for
   the 25 deal cards (not the unused stub).
4. **Showdown** — one proving player decrypts the deal, evaluates every
   active 7-card hand, compares them, and poly-hashes **winner masks** (not
   ranks or faces).

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `poker_card.circom` | Rank / suit from a 0..51 index |
| `poker_hand_eval.circom` | Best 5-card rank from 5–7 cards (category + kickers) |
| `poker_compare_hands.circom` | Pairwise comparison of evaluated hands |
| `poker_showdown.circom` | Decrypt 25 cards; apply pot masks; emit 9 mask limbs |
| `poker_polynomial_hash.circom` | Poker-sized poly-hash helper |

Showdown binds **pot masks** into the Poseidon input hash so a proof for pot A
cannot be replayed onto pot B. Folded or uneconomic seats are zeroed in the
mask; the circuit still decrypts their hole slots when the mask bit is on.

Unlike house games, poker has **no encrypted side-bet object**. The only
private extras at showdown are pot membership bits and the usual key / deck
witness.

## Public vs private

| Public | Private |
|--------|---------|
| Poseidon input hash, poly output hash, Groth16 proof | `sk`, 25 faces, pot masks, sealed partials, sealed showdown coefficients |

The 9 output limbs are `(winner_mask[i] + 1) · sealed_coeff[i]` style terms
consumed by settlement. Coefficients are **not** `HASH_COEFFS_900`; they are
the showdown seal vector.

## Entrypoints

| Main | Role |
|------|------|
| `register_main.circom` | Key |
| `shuffle_1_deck_52_main.circom` | Shoe |
| `poker_share_main.circom` / `poker_share_hashout_main.circom` | Partials |
| `poker_showdown_main.circom` / `poker_showdown_hashout_main.circom` | Winners |
| `poker_hand_eval_main.circom` / `poker_compare_hands_main.circom` | Isolated eval / compare (tests and tooling) |
