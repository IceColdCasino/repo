# ZK Casino

Groth16 / Circom circuits for a mental-poker casino: ElGamal-encrypted shoes,
threshold share, and per-game showdown evaluators.

## Publication notice

This repository is published **only for audit and transparency**. It is not an
open-source release, a product distribution, or an invitation to use, fork, or
commercialize the work.

**Copyright © 2026 Barrett Harber. All rights reserved.**

The invention is **patent pending** under USPTO application **19/811,546**, as
stated in the header of every file in `circuits/`. No copyright license and no
patent license are granted. Reproduction, modification, distribution, or
commercial use is prohibited without written permission.

Presence of source here does not waive those rights.

## Layout

This public tree is a curated subset of the private implementation. It contains
the Circom sources and the protocol documentation that maps them onto the
patent.

```text
.
├── circuits/              Groth16 / Circom sources (templates and mains)
└── docs/zk-casino/        Protocol and per-game documentation
    ├── README.md          Start here
    ├── poker.md
    ├── blackjack.md
    ├── baccarat.md
    ├── war.md
    ├── roulette.md
    ├── craps.md
    ├── keno.md
    ├── slots.md
    └── bingo.md
```

- **`circuits/`** — shared primitives (`elgamal`, `register`, `shuffle`,
  `share`, `showdown`, hashes) and the game-specific mains compiled from them.
- **`docs/zk-casino/`** — how the four-phase protocol works, how USPTO
  **19/811,546** maps onto these circuits, and the shoe / evaluator interface
  for each game.

Arcium MPC, Solana programs, native app code, tests, and build tooling are
**not** in this repository. Those layers consume the same hashes and proofs;
they are not part of these circuits.

## Documentation

Read **[docs/zk-casino/README.md](docs/zk-casino/README.md)** first.

That page covers encryption, the shared register → shuffle → share → showdown
pipeline, the patent-to-circuit map, and links to each game. The game pages
document only shoe layout, opened indices, and evaluation.

## Legal

Every Circom source file begins with:

```text
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
```

That notice applies to the circuits, proving keys derived from them, and the
documentation in `docs/`. See the [Legal](docs/zk-casino/README.md#legal)
section of the docs README for the same reservation in more detail.
