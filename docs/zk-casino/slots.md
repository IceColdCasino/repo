# Slots

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](./README.md).

Each reel is a 22-stop strip stored **reel-major** (center of reel `i` at
index `i · 22`). Circom opens one center stop per reel, reconstructs the
three-symbol window `(above, center, below)` with wrap-around, and awards
the highest matching paytable line for a 1–3 coin bet.

## Shoe

| | |
|--|--|
| Encoding | Stop index `0..21` per reel → `BabyPbk(v+1)` |
| Shuffle mains | `shuffle_3_reel_22_main`, `shuffle_5_reel_22_main` |
| Opened at showdown | 3 or 5 center stops |
| Poly-hash terms | 1 (award) |

House seat shuffles. Table is heads-up (player + house).

## ZK pipeline

1. **Register / shuffle** — `slot_shuffle.circom` wraps the shared shuffle
   for 3×22 or 5×22.
2. **Coin bet** — `slot_coin_bet.circom` encrypts `coinBet ∈ {1,2,3}`.
3. **Share** — `slot_share` / `slot_share_{3,5}_reel_hashout_main`.
4. **Showdown** — decrypt centers + coin; evaluate strip windows.

## Unique ZK

| Circuit | What it proves |
|---------|----------------|
| `slot_shuffle.circom` / `slot_share.circom` | Reel-major shoe wrappers |
| `slot_coin_bet.circom` | Single encrypted coin stake |
| `slot_eval.circom` | Circular `ReelWindow`; 3-reel Wilson / Double Diamond paytable; 5-reel variant |
| `slot_showdown.circom` | Decrypt centers; bind the one bet ciphertext into the input hash |

3-reel symbols: blank, cherry, bars, 7s, wild (Double Diamond). One center
payline; **highest award only**. 5-reel uses the same window idea with a
wider paytable in the same file.

The encryption is still threshold ElGamal on the **stop indices**, not on
the painted symbols. The strip mapping is a circuit constant.

## Public vs private

| Public | Private |
|--------|---------|
| Input hash (reel ciphertexts + coin ciphertext), award output hash | `sk`, center indices, coin amount, window symbols |

## Entrypoints

| Main | Role |
|------|------|
| `shuffle_3_reel_22_main.circom` / `shuffle_5_reel_22_main.circom` | Reels |
| `slot_share_3_reel_hashout_main.circom` / `slot_share_5_reel_hashout_main.circom` | Partials |
| `slot_showdown_3_reel_hashout_main.circom` / `slot_showdown_5_reel_hashout_main.circom` | Award |

## Host test

`test/complete_slot_game_with_proofs.test.ts`. What that file checks is in
[tests.md](../tests.md).
