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
├── rust/                  Solana programs (casino, light-casino, Arcis)
├── calc.sh                Compile a main and run its trusted setup
└── docs/
    ├── zk-casino/         Protocol and per-game circuit documentation
    ├── on-chain.md        Casino and light-casino; poker pots vs dealer pool
    ├── sol-cost.md        Vault float in bytes; lamports follow the rent rate
    ├── arcis-tests.md     What the localnet Arcis hands actually run
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
- **`docs/on-chain.md`** — the casino and light-casino programs, and how
  poker and bingo settle from player pots while every other game, including
  keno, settles against a dealer pool.
- **`rust/casino`** — the Anchor program: rooms, encrypted wallets, poker
  pots, and the dealer pool. Its address is
  `CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv` on localnet, devnet, and mainnet.
  Confidential transitions live in `rust/casino/encrypted-ixs` and run on the
  Arcium cluster.
- **`rust/light-casino`** — the pinocchio program that verifies Groth16
  proofs and can CPI the receipt into casino. Its address is
  `CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc`.
  Builds write a throwaway keypair (`scripts/write-build-keypairs.sh`) so CI
  can compile without secrets. Deploy fetches the vanity keypairs from the
  IceColdCasino vault in 1Password. They are not stored in the repo.
  `rust/shared-zk-ids` is the shared program-id, `GameKind`, and receipt layout.

How poker pots and the bingo card pot differ from the dealer pool is in
[docs/on-chain.md](docs/on-chain.md).

`rapidsnark/` is not part of this checkout. The prover and verifier load the
library printed by `zkey lib` from the IceColdCasino/groth16 Homebrew formula.

## Documentation

Read **[docs/zk-casino/README.md](docs/zk-casino/README.md)** for the protocol.

That page covers encryption, the shared register → shuffle → share → showdown
pipeline, the patent-to-circuit map, and links to each game. The game pages
document shoe layout, opened indices, and evaluation.

**[docs/on-chain.md](docs/on-chain.md)** is the program doc: casino, light-casino,
Arcis, poker pots, the bingo card pot, and the dealer pool.

The implementation docs are separate:

- **[docs/libzkcasino.md](docs/libzkcasino.md)** — Zig libraries, the JSON
  bridge, and the `calc` hashes.
- **[docs/zkeys.md](docs/zkeys.md)** — proving keys, verification keys, and
  `./calc.sh`.
- **[docs/tests.md](docs/tests.md)** — what `bun run test:games` actually
  checks.
- **[docs/arcis-tests.md](docs/arcis-tests.md)** — what the nine localnet
  Arcis hands actually run and assert.
- **[docs/sol-cost.md](docs/sol-cost.md)** — vault float in bytes. Lamports
  are that count times the cluster's lamports per byte.

## Legal

Every Circom source file begins with:

```text
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
```

That notice applies to the circuits, proving keys derived from them, and the
documentation in `docs/`. See the [Legal](docs/zk-casino/README.md#legal)
section of the docs README for the same reservation in more detail.
