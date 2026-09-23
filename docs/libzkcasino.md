# libzkcasino

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

Zig library that does the field arithmetic, witness generation, and Groth16
proving for the circuits in `circuits/`. The TypeScript tests load it with
Bun FFI. They do not reimplement Poseidon, the polynomial hash, decryption,
or witness generation.

## What a build produces

From `libzkcasino/`:

```sh
zig build
zig build player-lib
zig build player-bridge-lib
```

Artifacts land in `libzkcasino/zig-out/lib`.

| Library | Role |
|---------|------|
| `libfr` | BN254 field, from rapidsnark `fr.cpp`, the arm64 assembly, and GMP |
| `libzkcasino-player` | Poseidon, BabyJubJub, catalog decrypt, derangement, shuffle permutation |
| `libzkcasino-player-bridge` | JSON session the tests call. Proves with rapidsnark |
| `libzkcasino` | Register witness |
| `libzkcasino-shuffle-*` | One witness library per shoe size |
| `libzkcasino-{game}` | Share, showdown, and the game’s bet / action / card witnesses |

`zig build -Dcircuit-set=poker` builds register, the 52-card shuffle, and
the poker witnesses. The same option accepts `blackjack`, `baccarat`, `war`,
`roulette`, `craps`, `keno`, `slots`, and `bingo`. `all` is the default.
GitHub Actions uses one set per game so the runner only compiles the circuits
that test proves. Linux builds require aarch64 and link system GMP.

`zig build test` runs the library tests. `zig build player-test` checks
player crypto against the golden vectors in
`src/zig/player_vectors/crypto.json`. `zig build player-prove-test` runs a
Zig Groth16 prove.

Witness C++ is always compiled `ReleaseFast` with C sanitizers off. A debug
build of those Poseidon workers overflows the macOS thread stack.

## Two FFI entry points

`src/player-ffi.ts` loads `libzkcasino-player` (`zkplayer_*`). That library
is the field engine.

`src/player-bridge-ffi.ts` loads `libzkcasino-player-bridge`:

| Symbol | Role |
|--------|------|
| `zkplayer_bridge_create` | Poker session (kind 0) |
| `zkplayer_bridge_create_ex(kind, variant)` | Any game. Variant selects shoe size (decks, 37/38, 75/90, reel count) |
| `zkplayer_bridge_op` | One JSON operation |
| `zkplayer_bridge_free` | Drop the session |

Poker operations live in `src/zig/player/bridge_ops.zig`. Every other game
uses `src/zig/player/game_bridge.zig`. Kinds match the TypeScript `GameKind`:

| Kind | Game |
|------|------|
| 0 | Poker |
| 1 | Baccarat |
| 2 | Blackjack |
| 3 | War |
| 4 | Roulette |
| 5 | Craps |
| 6 | Keno |
| 7 | Slots |
| 8 | Bingo |

A non-poker session loads the Groth16 engine once for the process. The
engine reads zkeys from `zkey/` and witness libraries from `zig-out/lib`.
See [zkeys.md](./zkeys.md).

## JSON operations

Both bridges accept `ping`, `key`, `register`, `shuffle`, `share`,
`showdown`, `decrypt`, and `calc`. The non-poker bridge also accepts `bet`,
`action`, and `card`.

A prove operation builds the witness in Zig, writes the `.wtns` with the
circuit’s witness library, and calls rapidsnark against
`zkey/{circuit}_0001.zkey`. The response is the Groth16 proof and the public
signals.

`key` generates the BabyJubJub secret inside the session. When a player
object is attached to the bridge, `generateKey()` in TypeScript does not
sample a second key.

## `calc`

`{ "op": "calc", "fn": "<name>", ... }` returns a hash or a deck and does
not prove. Implemented in `src/zig/player/calc.zig`. TypeScript calls it
through `src/casino-calc.ts`.

| `fn` | Returns |
|------|---------|
| `initialDeck` | Identity catalog ciphertexts for the shoe |
| `shuffleHash` | Poseidon input hash of the current deck and public keys |
| `shareHash` | Poseidon input hash of the share |
| `shareOutputHash` | Polynomial hash of the sealed partials |
| `showdownHash` | Polynomial hash of the showdown limbs |
| `betHash` | Bet-ticket input hash |
| `cardHash` | Bingo card-commit input hash |
| `actionHash` | Blackjack action input hash |
| `decrypt` | Catalog indices for ciphertexts the session key can open |

The table `Game` uses these values as the expected public signals. A proof
whose hash does not match the Zig calculation is rejected before it changes
the table. That is what keeps the TypeScript game state on the same hashes
as the circuit.

Showdown and action coefficients are inputs to `calc` and to the prove
operation. The library does not sample them. They are host-sealed values,
or the fixed `HASH_COEFFS_900` set used by the polynomial hash. The
blackjack action circuit requires the non-dealer ace coefficient to be zero;
that slot is the only place a zero coefficient is accepted.

## Paths

`src/zig/prove/paths.zig` walks the working directory until it finds
`zkey/register_main_0001.zkey`. Override with:

| Variable | Default under the repo root |
|----------|-----------------------------|
| `ZK_REPO_ROOT` | discovered directory |
| `ZK_ZKEY_DIR` | `zkey` |
| `ZKCASINO_LIB_DIR` | `libzkcasino/zig-out/lib` |
| `ZKCASINO_DAT_ROOT` | `libzkcasino/src/zig/dat` |
| `RAPIDSNARK_LIB` | `rapidsnark/lib/librapidsnark.dylib` |

`src/zig/dat` holds the constant tables the witness libraries embed. `rapidsnark/`
is a local checkout and is gitignored.
