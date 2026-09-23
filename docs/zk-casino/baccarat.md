# Baccarat

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Player vs banker on a 1/6/8-deck shoe. Exactly **six** shoe indices are
opened: player two, banker two, optional thirds. Circom enforces the
standard tableau (third-card rules) and scores hands modulo 10.

## Shoe

| | |
|--|--|
| Encoding | Card `0..52·shoe−1` → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_{1,6,8}_deck_52_main` |
| Opened at showdown | 6 |
| Poly-hash terms | 1 (`0` player, `1` banker, `2` tie) |

## ZK pipeline

Shared register → shuffle → `baccarat_share_hashout_main` →
`baccarat_showdown` / `baccarat_showdown_hashout_main`.

There is no mid-hand action circuit. After share, showdown decrypts six
cards, applies tableau, and emits the side.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `baccarat_card.circom` | Face value (ace 1, ten/face 0) |
| `baccarat_hand_eval.circom` | Mod-10 sums, natural 8/9, player/banker third-card draws |
| `baccarat_showdown.circom` | Decrypt 6; `VerifyDecryptedCards` against the shoe; output winner |

Unlike blackjack, all six slots are always bound (unused third cards are
still encrypted positions in the deal window and must match `P(v)`).

## Public vs private

| Public | Private |
|--------|---------|
| Input hash, output hash (winner code) | `sk`, six faces, tableau intermediates |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_{1,6,8}_deck_52_main.circom` | Shoe |
| `baccarat_share_hashout_main.circom` | Partials |
| `baccarat_showdown_hashout_main.circom` | Player / banker / tie |

## Host test

`test/complete_baccarat_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
