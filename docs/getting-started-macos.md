# Getting started on macOS

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

This is the path from a fresh Apple silicon Mac to a host proof, a local
Solana validator with an Arcium cluster, and the desktop app. The host
proofs are [tests.md](./tests.md). The localnet hands are
[arcis-tests.md](./arcis-tests.md). The app is [app/README.md](../app/README.md).

The machine is Apple silicon running macOS 26. Apple Container, which the
localnet uses instead of Docker Desktop, is supported on that pair only.
`Darwin-x86_64` is not a host this checkout installs.

## 1. Tools

Install the Xcode command-line tools, then Homebrew packages:

```sh
xcode-select --install
brew install git git-lfs gmp node rustup bun
brew trust --tap IceColdCasino/groth16
brew tap IceColdCasino/groth16 https://github.com/IceColdCasino/groth16
brew install icecoldcasino/groth16/zkey
rustup-init -y
```

Open a new shell so `cargo` is on `PATH`. Zig must be **0.17.0**. Homebrew’s
`zig` formula is not that pin. Download the 0.17.0 aarch64 macOS archive from
<https://ziglang.org/download/0.17.0/>, unpack it, and put that `zig` on
`PATH`.

```sh
zig version          # 0.17.0
zkey lib             # path to libgroth16.dylib
cargo --version
bun --version
node --version
```

`zkey lib` is the prover. Witness builds link GMP from
`/opt/homebrew/lib/libgmp.dylib`.

## 2. Checkout

```sh
git clone git@github.com:IceColdCasino/repo.git
cd repo
git lfs install --local
git lfs pull
bun install --frozen-lockfile
```

`zkey/` is Git LFS. The full tree is about 12 GB. To prove one game, pull
only that game’s keys. Keno is the smaller shoe:

```sh
git lfs pull --include='zkey/register_main*,zkey/shuffle_1_deck_80_main*,zkey/keno_*'
```

The other games use the include lists in `.github/select-tests.sh`. A key
that is still an LFS pointer fails when that circuit is proved. Check with:

```sh
test -f zkey/register_main_0001.zkey
head -c 40 zkey/register_main_0001.zkey | grep -q 'git-lfs.github.com' && echo 'still a pointer'
```

## 3. Witness libraries

From `libzkcasino/`:

```sh
cd libzkcasino
zig build -Doptimize=ReleaseFast -Dcircuit-set=keno
```

That writes `libzkcasino/zig-out/lib/`. `keno` also builds the register
library. The same `-Dcircuit-set` accepts `poker`, `blackjack`, `baccarat`,
`war`, `roulette`, `craps`, `slots`, and `bingo`. Omit the option, or pass
`all`, to build every game. A full ReleaseFast build compiles every generated
witness and takes hours.

The desktop app links four of these libraries, so a poker app also needs:

```sh
zig build -Doptimize=ReleaseFast -Dcircuit-set=poker
```

Confirm the prover and the player bridge are both present:

```sh
test -f zig-out/lib/libzkcasino-player-bridge.dylib
test -f "$(zkey lib)"
```

`zig build` without extra steps does not build the player libraries the
tests load. Build those too:

```sh
zig build -Doptimize=ReleaseFast player-lib
zig build -Doptimize=ReleaseFast player-bridge-lib
```

`player-lib` and `player-bridge-lib` are steps on the same `zig build`.
Passing `-Dcircuit-set` and the step names together is fine.

## 4. Host proofs

These play a full table in Bun and prove every phase. They do not start
Solana. From the repository root, after the keno libraries and keys are in
place:

```sh
bun test --timeout=1800000 test/complete_keno_game_with_proofs.test.ts
```

`bun run test:games` runs every `test/complete_*_game_with_proofs.test.ts`.
Each game needs its own libraries and its own LFS keys. One missing dylib
fails in `require-player-ffi` before any proof. One missing zkey fails when
that circuit is proved.

## 5. Apple Container, Solana, Anchor, and Arcium

These four CLIs are pinned. Apple Container is the hypervisor the cluster
runs in. Solana is **3.1.10**. Anchor is **1.0.2**. Arcium is **0.14.1**.
A newer Solana CLI makes `arcium localnet` panic after it sets up log
streams. `cargo` from the Rust install has to be on `PATH` before Solana,
because the Solana install and the program builds both call it.

### Apple Container

```sh
brew install container
container system start
container system kernel set --recommended
container system status
```

The first start installs a Linux kernel when one is not already configured.
`container system status` should report the service running. Docker Desktop
is not the runtime. Leave `DOCKER_HOST` unset so a Desktop socket is not
picked up.

From the repository root, point `~/.local/bin/docker` at the repo shim.
`arcium build` calls `docker`. On this Mac that shim talks to `container`:

```sh
mkdir -p "$HOME/.local/bin"
ln -sfn "$PWD/scripts/bin/docker" "$HOME/.local/bin/docker"
unset DOCKER_HOST
export PATH="$HOME/.local/bin:$PATH"
```

The e2e tests put `scripts/bin` on `PATH` themselves. That directory’s
`anchor` keeps stdin open for `anchor localnet`. The real Anchor binary
stays at `~/.local/bin/anchor`.

### Solana 3.1.10

```sh
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
```

The version line must contain `3.1.10`. The installer writes
`solana`, `solana-keygen`, and `cargo-build-sbf` into
`~/.local/share/solana/install/active_release/bin`.

Create the default wallet if it is not there yet. `arcium localnet` reads
`~/.config/solana/id.json`:

```sh
mkdir -p "$HOME/.config/solana"
if [[ ! -f "$HOME/.config/solana/id.json" ]]; then
  solana-keygen new --no-bip39-passphrase -o "$HOME/.config/solana/id.json"
fi
solana-keygen pubkey "$HOME/.config/solana/id.json"
```

### Anchor 1.0.2

The Mac binary is the aarch64 release. It has to live at
`~/.local/bin/anchor`, which is where `scripts/bin/anchor` execs it:

```sh
mkdir -p "$HOME/.local/bin"
curl -fsSL -o "$HOME/.local/bin/anchor" \
  https://github.com/coral-xyz/anchor/releases/download/v1.0.2/anchor-1.0.2-aarch64-apple-darwin
chmod +x "$HOME/.local/bin/anchor"
export PATH="$HOME/.local/bin:$PATH"
anchor --version
```

### Arcium 0.14.1

The resolver looks for `/tmp/arcium-0.14/bin/arcium`. The Mac asset is the
aarch64 build:

```sh
mkdir -p /tmp/arcium-0.14/bin
curl -fsSL -o /tmp/arcium-0.14/bin/arcium \
  https://bin.arcium.com/download/arcium_aarch64_macos_0.14.1
chmod +x /tmp/arcium-0.14/bin/arcium
export PATH="/tmp/arcium-0.14/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
arcium --version
```

`/tmp` is cleared on reboot. Run the Arcium `curl` again if `arcium` is
missing after a restart. The same three downloads are what
`.github/install-localnet-tools.sh` does on this Mac. It refuses any host
other than `Darwin-arm64` and `Linux-x86_64`.

Check all four before building programs:

```sh
container system status
solana --version     # 3.1.10
anchor --version     # 1.0.2
arcium --version     # 0.14.1
```

## 6. Localnet programs

The Arcis hands need a Solana validator, an Arcium cluster, and programs
built with the `testing` feature. The program ids in git are the published
ones. A localnet build generates throwaway ids and rewrites the checkout to
match them. That rewrite is local. Do not commit it.

Keep the `PATH` from the previous section. Generate the localnet ids, then
build both programs. `arcium build` pulls the published `linux/amd64`
cluster images through Apple Container. The first pull is large.

Generate the localnet ids, then build both programs. `arcium build` pulls
the published `linux/amd64` cluster images through Apple Container. The
first pull is large.

```sh
export CASINO_EPHEMERAL_PROGRAM_IDS=1
export CASINO_ALLOW_TESTING=1
export CASINO_FEATURES=testing
bash scripts/prepare-ephemeral-program-ids.sh
bash rust/casino/scripts/build.sh
(
  cd rust/light-casino
  unset CARGO_TARGET_DIR
  RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build-sbf \
    --tools-version v1.54 \
    --manifest-path programs/light-casino/Cargo.toml \
    --features testing
)
test -f rust/casino/target/deploy/casino.so
test -f rust/casino/target/idl/casino.json
test -f rust/light-casino/target/deploy/light_casino.so
```

The whitelist admin written by that prepare script is a new keypair under
`rust/casino/target/deploy/`. It is not the devnet admin in 1Password.

## 7. One localnet hand

Keep the `PATH` from the previous section. From the repository root, with
the keno witness libraries built:

```sh
bun test --max-concurrency=1 --timeout=1800000 test/e2e/full-game-zk-arcis-keno-2player.test.ts
```

`setupE2E` is allowed 30 minutes to start the validator and the cluster.
The hand itself is allowed 30 minutes. Run one file at a time. A second
file in the same process can reuse the localnet. Two processes cannot.

`UPLOAD_COMP_DEFS` defaults to `1` inside the test, so missing computation
definitions are uploaded. The script names for the other games are
`bun run test:e2e:poker` and the same pattern for `blackjack`, `baccarat`,
`war`, `roulette`, `craps`, `slots`, and `bingo`. Each one needs that
game’s witness libraries and proving keys.

The house-image check (`bun run test:e2e:house`) is separate. It builds a
container per game and allows two hours per image.

## 8. Desktop app

The app links the poker witness libraries and `libgroth16`. From the
repository root, after `libzkcasino` was built with `-Dcircuit-set=poker`:

```sh
mkdir -p ../groth16/zig-out/lib
ln -sfn "$(zkey lib)" ../groth16/zig-out/lib/libgroth16.dylib
npm install --prefix /tmp/zn zero-native@0.2.0
npm ci --prefix app/frontend
cd app
zig build -Doptimize=ReleaseFast -Dzero-native-path=/tmp/zn/node_modules/zero-native
```

`zig build` installs `app/zig-out/bin/app` and copies the poker dylibs into
`app/zig-out/lib`. Launch the shell against the Vite dev server with:

```sh
zig build dev -Dzero-native-path=/tmp/zn/node_modules/zero-native
```

That is the poker desktop app. It does not start the localnet. A devnet
launch is `app/scripts/run-devnet.sh`, which reads `../.env.devnet` and does
not upload computation definitions.

Frontend unit tests, from the repository root:

```sh
bun install --frozen-lockfile
npm test --prefix app/frontend -- --testTimeout=120000
```

## What a finished stack is

| Piece | Where it runs |
|-------|----------------|
| Witness generation and Groth16 | This Mac, `libzkcasino` and `zkey lib` |
| Host table proofs | `bun test test/complete_*_game_with_proofs.test.ts` |
| Solana validator and Arcium MXE | This Mac, Apple Container, started by the e2e test |
| Casino and light-casino | Built here with `CASINO_FEATURES=testing` |
| Desktop app | `app/zig-out/bin/app`, poker libraries only |

GitHub Actions does not run this localnet on a Mac. The Actions Arcium job
is an x86 Linux runner with Docker Engine. The libraries it loads are built
on Linux runners. This guide is the Mac path.
