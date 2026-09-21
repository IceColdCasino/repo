# Casino War

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Player vs dealer, 1/6/8-deck shoe. Four cards: each side’s up-card, then a
war pair if ranks tie. Circom compares ranks only (suits do not matter).

## Shoe

| | |
|--|--|
| Encoding | Card `0..52·shoe−1` → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_{1,6,8}_deck_52_main` |
| Opened at showdown | 4 |
| Poly-hash terms | 1 (`0` player, `1` dealer, `2` tie) |

## ZK pipeline

Shared register → shuffle → `war_share_hashout_main` →
`war_showdown` / `war_showdown_hashout_main`.

No action circuit. Showdown always opens four positions; the evaluator
uses the second pair only when the first ranks are equal.

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
| Input hash, output hash (winner code) | `sk`, four faces |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_{1,6,8}_deck_52_main.circom` | Shoe |
| `war_share_hashout_main.circom` | Partials |
| `war_showdown_hashout_main.circom` | Player / dealer / tie |
