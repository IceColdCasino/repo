# Casino War

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Player vs dealer, 1/6/8-deck shoe. Four cards: each side’s up-card, then a
war pair if ranks tie. Circom compares ranks only (suits do not matter).

The dealer side is a card outcome, not a house seat. Wins are paid from the
dealer pool. Coverage before `start_hand` is `bet_unit × seats`. Action
collection and the pool-win edge are each 250 bps. See
[on-chain](../on-chain.md#dealer-pool).

## Shoe

| | |
|--|--|
| Encoding | Card `0..52·shoe−1` → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_{1,6,8}_deck_52_main` |
| Opened at showdown | 4 |
| Showdown terms | 2: `[winner, 0]` (`0` player, `1` dealer, `2` tie) |

## ZK pipeline

Shared register → shuffle → `war_share_hashout_main` →
`war_showdown_hashout_main`.

Share uses `ShareHashOut(12, 4)`. Its public output is a Poseidon of one
ciphertext-hash per other player. Showdown always opens four positions and
publishes `(winner + 1) · c0 + c1`. The evaluator uses the second pair only
when the first ranks are equal.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `card_rank.circom` (via `war_hand_eval`) | Rank from a shoe index (multi-deck aware) |
| `war_hand_eval.circom` | Compare `cards[0]` vs `cards[1]`; on tie compare `cards[2]` vs `cards[3]` |
| `war_showdown.circom` | Decrypt 4, verify encoding, emit winner |

This is the smallest card-game evaluator: no pot masks, no soft aces, no
tableau. The encryption path is identical to baccarat (same shoe family,
fewer opened indices).

## Public vs private

| Public | Private |
|--------|---------|
| `hash`, `(winner+1)·c0 + c1`, Groth16 proof | `sk`, four faces, 14 coefficients, seal commitment |

`hash` is `Poseidon(keys, playerIndex, ciphertextHash, sealCommitment)`. The showdown template checks that equality.

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_{1,6,8}_deck_52_main.circom` | Shoe |
| `war_share_hashout_main.circom` | Partials |
| `war_showdown_hashout_main.circom` | Player / dealer / tie |

## Host test

`test/complete_war_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
