# Craps

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Two dice, six faces each, stored **die-major** in the shoe (die 0 at index
0, die 1 at index 6). Circom opens two faces, evaluates come-out vs point,
and settles a vector of encrypted table bets.

## Shoe

| | |
|--|--|
| Encoding | Face `0..5` per die → `BabyPbk(v+1)` |
| Shuffle main | `shuffle_2_dice_6_main` (also `craps_shuffle.circom`) |
| Opened at showdown | 2 (share indices `[0, 6]`) |
| Poly-hash terms | 14 (12 bet codes + table action + `pointOut`) |

House seat shuffles.

## ZK pipeline

1. **Register / shuffle** — two independent 6-face strips.
2. **Bet commit** — `craps_bet` / `craps_bet_main` encrypts table bets.
3. **Share** — `craps_share_hashout_main` seals the two die `c0` partials.
4. **Showdown** — decrypt dice and bets; `CrapsEval` + `craps_bet_eval`.

Phase and point are **hashed into the showdown input** (`nActualBets`,
`phase`, `point`) so a come-out proof cannot be replayed on a point roll.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `craps_eval.circom` | Come-out: natural 7/11, craps 2/3/12, or establish point 4–6/8–10. Point: pass, seven-out, or reroll |
| `craps_bet.circom` | Encrypted bet objects |
| `craps_bet_eval.circom` / `craps_bet_eval_main.circom` | Per-bet win/lose given action + point |
| `craps_showdown.circom` | Decrypt 2 dice + up to 12 bets; emit 14 poly terms |

`action % 3` is the phase-local class: pass wins, don’t-pass wins, or
continue. That is craps-specific; no other game has a multi-roll point
state inside Circom.

## Public vs private

| Public | Private |
|--------|---------|
| Input hash (includes phase/point), 14-limb output hash | `sk`, two faces, bet tickets, intermediate totals |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_2_dice_6_main.circom` | Dice shoe |
| `craps_bet_main.circom` | Ticket commit |
| `craps_share_hashout_main.circom` | Die partials |
| `craps_showdown_hashout_main.circom` | Bets + action + point |
| `craps_bet_eval_main.circom` | Isolated bet evaluation |

## Host test

`test/complete_craps_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
