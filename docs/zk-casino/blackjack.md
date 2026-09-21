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
| Poly-hash terms | 1 settlement limb |

Share chunking scales with seats (`blackjackShareChunksForSeats`, min 2, max 19).

## ZK pipeline

1. **Register** / **shuffle** — shared primitives; multi-deck shoe.
2. **Share** — `blackjack_share_hashout_main` seals partials for the deal window.
3. **Action** (unique) — `blackjack_action` / `blackjack_action_hashout_main`
   proves the next hit/stand/split is legal given the encrypted cards already
   dealt to that seat (or the dealer).
4. **Showdown** — open used cards, score player vs dealer (H17/S17), hash
   the settlement.

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
| Input hash (includes card counts), action/showdown output hashes | `sk`, used faces, unused shoe, action flags |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_{1,6,8}_deck_52_main.circom` | Shoe |
| `blackjack_share_hashout_main.circom` | Partials |
| `blackjack_action_hashout_main.circom` | Hit / stand / split |
| `blackjack_showdown_hashout_main.circom` | Settlement |
