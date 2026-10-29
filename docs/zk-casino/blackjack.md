# Blackjack

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Player vs house. Shoe of 1, 6, or 8 standard 52-card decks. The house seat
shuffles and plays the dealer hand. Circom proves card totals, bust /
blackjack, and **legal hit / stand / split** without revealing unused shoe
slots.

## Shoe

| | |
|--|--|
| Encoding | Card `0..52·shoe−1` → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_{1,6,8}_deck_52_main` |
| Opened at showdown | Up to 24 used slots (`nUsedCards`); unused slots are not forced equal |
| Showdown terms | 2: `[settlement, 0]` |

Share chunking scales with seats (`blackjackShareChunksForSeats`, min 2, max 19).

## ZK pipeline

1. **Register** / **shuffle** — shared primitives; multi-deck shoe.
2. **Share** — `blackjack_share_hashout_main` seals a 16-card window. The
   public output is `Poseidon(2)` of two `Poseidon(8)` card hashes. The
   chain recomputes one card from that card’s partials.
3. **Action** (unique) — `blackjack_action_hashout_main` proves the next
   hit, stand, or split. Its public field is `(status + 1) · c0 + c1` under
   the same seal. Dealer status `2` is a natural.
4. **Showdown** — open used cards, score player vs dealer (H17/S17). The
   public field is `(settlement + 1) · c0 + c1`.

The house seat shuffles and plays the dealer hand. Wins are paid from the
table dealer pool. Before `start_hand`, `total_shares` must cover
`bet_unit × 4 × 3 × seats`. A seat that leaves, or sends no action for three
minutes, stands. See [on-chain](../on-chain.md#timeouts).

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `blackjack_card.circom` / `blackjack_constants.circom` | Face values; ace = 1 or 11 |
| `blackjack_hand_eval.circom` | Best total, bust, natural blackjack, soft flag |
| `blackjack_action.circom` | Poseidon-bound action: `cardCount`, `canSplit`, `hitSoft17`, `isDealer` |
| `blackjack_showdown.circom` | Decrypt used slots only; compare player vs dealer |

`VerifyShoeDecryptedCards` only constrains `c < nUsedCards`. That is required
because a blackjack deal does not consume a fixed 24 faces.

Action is the poker-equivalent of “this street is legal” — except the
constraint is **hand composition**, not betting order.

## Public vs private

| Public | Private |
|--------|---------|
| `hash`, the seal polynomial, Groth16 proof | `sk`, used faces, unused shoe, action flags, 2 coefficients, seal commitment |

Showdown `hash` is `Poseidon(playerCardCount, dealerCardCount, keys, playerIndex, ciphertextHash, sealCommitment)`. The template checks that equality. The seal commitment is the last hashed input.

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_{1,6,8}_deck_52_main.circom` | Shoe |
| `blackjack_share_hashout_main.circom` | Partials |
| `blackjack_action_hashout_main.circom` | Hit / stand / split |
| `blackjack_showdown_hashout_main.circom` | Settlement |

## Host test

`test/complete_blackjack_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
