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

```text
.
├── circuits/              Groth16 / Circom sources (templates and mains)
├── libzkcasino/           Zig field math, witness generation, Groth16 prove
├── src/                   TypeScript table and player host
├── test/                  Complete-game Bun tests that prove every phase
├── zkey/                  Proving keys and verification keys (Git LFS)
├── calc.sh                Compile a main and run its trusted setup
└── docs/
    ├── zk-casino/         Protocol and per-game documentation
    ├── libzkcasino.md
    ├── zkeys.md
    └── tests.md
```

- **`circuits/`** — shared primitives (`elgamal`, `register`, `shuffle`,
  `share`, `showdown`, hashes) and the game-specific mains compiled from them.
- **`libzkcasino/`** — the library the host calls for every hash, decryption,
  witness, and proof. See [docs/libzkcasino.md](docs/libzkcasino.md).
- **`src/`** and **`test/`** — the TypeScript table. Proofs and hash checks
  go through Bun FFI into libzkcasino. See [docs/tests.md](docs/tests.md).
- **`zkey/`** — one Groth16 proving key and verification key per main.
  See [docs/zkeys.md](docs/zkeys.md).
- **`docs/zk-casino/`** — how the four-phase protocol works, how USPTO
  **19/811,546** maps onto these circuits, and the shoe / evaluator interface
  for each game.

Arcium MPC and the Solana programs are not in this repository. They consume
the same hashes and proofs.

`rapidsnark/` is a local build of the prover and is gitignored. The tests
expect `rapidsnark/lib/librapidsnark.dylib`.

## Documentation

Read **[docs/zk-casino/README.md](docs/zk-casino/README.md)** for the protocol.

That page covers encryption, the shared register → shuffle → share → showdown
pipeline, the patent-to-circuit map, and links to each game. The game pages
document shoe layout, opened indices, and evaluation.

The implementation docs are separate:

- **[docs/libzkcasino.md](docs/libzkcasino.md)** — Zig libraries, the JSON
  bridge, and the `calc` hashes.
- **[docs/zkeys.md](docs/zkeys.md)** — proving keys, verification keys, and
  `./calc.sh`.
- **[docs/tests.md](docs/tests.md)** — what `bun run test:games` actually
  checks.

## Legal

Every Circom source file begins with:

```text
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
```

That notice applies to the circuits, proving keys derived from them, and the
documentation in `docs/`. See the [Legal](docs/zk-casino/README.md#legal)
section of the docs README for the same reservation in more detail.
