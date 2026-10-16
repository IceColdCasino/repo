# Poker (Texas Hold'em)

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Mental-poker Texas Hold'em for 2–10 players. One 52-card deck. Street betting
is **outside** these circuits; Circom proves shuffle, share, and a winner-mask
showdown over encrypted holes and board.

Settlement pays the pots the seats committed. There is no dealer pool.
`init_dealer_pool` rejects this kind. Chip movement, the nine-pot rebuild,
and `settle_all_seats` / `distribute_and_settle` are in
[on-chain](../on-chain.md#poker).

## Shoe

| | |
|--|--|
| Encoding | Card `0..51` → `BabyPbk(v+1)` |
| Shuffle main | `shuffle_1_deck_52_main` |
| Opened at showdown | 25 indices (player `i` holes `2i, 2i+1`; board `20..24`) |
| Showdown terms | 9 winner masks (`nPlayers − 1` at the 10-seat main) |

## ZK pipeline

1. **Register** — shared `register_main`.
2. **Shuffle** — each player permutes and re-encrypts the 52-card shoe.
3. **Share** — `poker_share_hashout_main` seals partials for the 25 deal
   cards. The public output is `Poseidon(2)` of the ten hole-card hashes
   and `Poseidon(flop, turn, river)`. Street hashes stay inside the proof.
4. **Showdown** — one proving player decrypts the deal, evaluates every
   active 7-card hand, and publishes the winner masks as
   `Σ (mask_i + 1) · coefficient_i`. Ranks and faces stay private.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `poker_card.circom` | Rank / suit from a 0..51 index |
| `poker_hand_eval.circom` | Best 5-card rank from 5–7 cards (category + kickers) |
| `poker_compare_hands.circom` | Pairwise comparison of evaluated hands |
| `poker_showdown.circom` | Decrypt 25 cards; apply pot masks; sum the 9 mask terms |

Showdown checks `hash === HashMain.out` inside the template. `HashMain` is
`Poseidon(potMaskHash, playerIndex, keyHash, ciphertextHash, sealCommitment)`.
Pot masks are split once with `Num2Bits(10)` and those bits are passed down.
Folded or uneconomic seats are zeroed in the mask; the circuit still
decrypts their hole slots when the mask bit is on.

Unlike house games, poker has **no encrypted side-bet object**. The only
private extras at showdown are pot membership bits and the usual key / deck
witness.

## Public vs private

| Public | Private |
|--------|---------|
| `hash`, the winner-mask sum, Groth16 proof | `sk`, 25 faces, pot masks, sealed partials, 14 coefficients, seal commitment |

The public field is `Σ (winner_mask[i] + 1) · coefficient[i]` over the first
nine of the 14 sealed coefficients. Settlement consumes that one field.

## Entrypoints

| Main | Role |
|------|------|
| `register_main.circom` | Key |
| `shuffle_1_deck_52_main.circom` | Shoe |
| `poker_share_hashout_main.circom` | Partials |
| `poker_showdown_hashout_main.circom` | Winners |

## Host test

`test/complete_poker_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
