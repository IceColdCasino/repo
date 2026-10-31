# Arcis end-to-end tests

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

`test/e2e/full-game-zk-arcis-*-2player.test.ts` plays one full hand per game
on a local Solana validator and a local Arcium cluster. Groth16 proofs are
still produced by libzkcasino and checked by light-casino. Arcis is the
cluster that opens sealed shares, seals showdown coefficients, and moves
encrypted chips. The host suite in [tests.md](./tests.md) stops before any
of that.

The cluster and the computation names are [arcium.md](./arcium.md). The nine
files, and the runners they call:

| File | Runner | Seats in the full hand |
|------|--------|------------------------|
| `full-game-zk-arcis-poker-2player.test.ts` | `ContinuousZkArcisHand` | 2, both economic |
| `full-game-zk-arcis-baccarat-2player.test.ts` | `ContinuousCasinoHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-war-2player.test.ts` | `ContinuousCasinoHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-blackjack-2player.test.ts` | `ContinuousBlackjackHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-roulette-2player.test.ts` | `ContinuousRouletteHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-craps-2player.test.ts` | `ContinuousCrapsHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-keno-2player.test.ts` | `ContinuousKenoHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-slots-2player.test.ts` | `ContinuousSlotHand` | 2: bettor 0, house 1 |
| `full-game-zk-arcis-bingo-2player.test.ts` | `ContinuousBingoHand` | 2, no house seat |

The house is one seat in that set, opened with `src/house/<game>.ts`. The
other seats stay full players and are the only ones that bet. For
blackjack, roulette, craps, keno, and slots that seat is `dealerIndex`
(seat 1 in these files). For baccarat and war it is the last seat. Poker
and bingo have no house seat.

`test/e2e/continuous-*.ts` re-exports those classes from `src/chain/`. The
other files under `test/e2e/` start localnet, load the programs, and stage
the deck. They are not extra games.

GitHub Actions runs this suite on macOS after the game builds. That job
downloads the macOS `libzkcasino` libraries and the Linux localnet programs
(`casino.so`, the `.arcis` circuits, and `light_casino.so`) instead of
compiling them again. A change under `test/e2e/`, `src/chain/`, `src/arcium/`,
`src/testing/`, `rust/`, or `app/` selects every game so those libraries exist.

## Run

From the repository root, with the Zig player libraries and `zkey lib`
printing the prover library, and with a localnet
whose `casino.so` matches the program the test will load:

```sh
export PATH="/tmp/arcium-0.14/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
bun test --max-concurrency=1 --timeout=1800000 test/e2e/full-game-zk-arcis-*-2player.test.ts
```

One game:

```sh
bun run test:e2e:keno
```

`setupE2E` is allowed `E2E_SETUP_TIMEOUT_MS` (30 minutes). Each complete-hand
test is allowed 30 minutes. Run the files one at a time. A second file in
the same process shares the localnet through `ArciumLocalnet`; overlapping
processes do not.

The same files run on Solana devnet. `E2E_CLUSTER=devnet` does not start
localnet, does not compare `casino.so` to a genesis binary, and does not
upgrade light-casino. It loads the vanity programs already on the cluster.
Seat keys are funded by a transfer from the payer (0.2 SOL), not a faucet
airdrop. The bettor still submits showdown during the open window; this
suite does not wait out the 180 second house-showdown clock.

```sh
export PATH="/tmp/arcium-0.14/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export ARCIUM_CLUSTER_OFFSET=<devnet MXE offset>
# optional: SOLANA_RPC_URL (default https://api.devnet.solana.com)
# MXE_AUTHORITY_KEYPAIR (default ~/.config/solana/id.json)
# that key is the devnet fee payer and the CompDef signer, and must hold at least 2 SOL
# WHITELIST_ADMIN_KEYPAIR (default ~/.config/solana/whitelist-admin.json)
# that file must sign as CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3 and hold SOL
bun run test:e2e:devnet:keno
```

`UPLOAD_COMP_DEFS=1` still uploads missing computation definitions.
`E2E_UPGRADE=1` upgrades light-casino from the local `testing` build and
needs the program keypair. Leave it unset when the deployed program is
already the one you want to exercise.

On localnet, `setupE2E` does this:

1. `requirePlayerFfi` and `requirePlayerBridge`. Missing dylibs fail here.
2. `ArciumLocalnet.acquire`. A ready validator plus MXE is reused. A
   half-dead process is stopped, then one orchestrator is started. Release
   does not stop a localnet the test attached to.
3. Airdrop 10 SOL to a fresh payer. Account reads use `confirmed`.
4. `ensureCasinoMatchesLocalnet`. A `casino.so` that differs from the
   genesis binary fails the file before any hand starts.
5. Load the casino program and deploy light-casino for this provider.
6. `SHUFFLE_WRITE_CONCURRENCY` defaults to 16. Shuffle account writes fan
   out that many transactions at a time.

Each hand then calls `initCompDefs` for its computation list. The default
is to require those computation definitions already finalized on the
cluster. `UPLOAD_COMP_DEFS=1` uploads any that are missing.
`SKIP_COMP_DEFS=1` skips the check. On devnet the fee payer is the MXE
authority (`MXE_AUTHORITY_KEYPAIR`, default `~/.config/solana/id.json`).
The whitelist admin is a different key,
`CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3`, loaded from
`WHITELIST_ADMIN_KEYPAIR` (default `~/.config/solana/whitelist-admin.json`).
On localnet that admin is airdropped when its balance is under 1 SOL.
The casino binary must be rebuilt before a cluster enforces the new pubkey.

## Two checks on every hand

**Groth16, on light-casino.** The seat builds a witness in Zig and proves
it with rapidsnark. Light-casino verifies the proof and writes a receipt.
When the casino accounts are present, that receipt is consumed by CPI.
Register, shuffle, share, showdown, and any bet or blackjack action circuit
are this path. The public field must equal the host sum of
`(result + 1) · coefficient` under the coefficients Arcis sealed. A mismatch throws inside the
runner, before the test’s own `expect`.

**Arcis, on the cluster.** Casino queues an encrypted instruction. The
function name in `rust/casino/encrypted-ixs` is the computation name. The
callback writes the new ciphertext. These tests queue:

| Computation | What the hand uses it for |
|-------------|---------------------------|
| `verify_deck_hash_chunk` | Record the next chunk of the shared deck. The share proof, not this instruction, commits the partials |
| `reveal_card` | Open sealed partials for one recipient and one card index. The chain stores the seal, not the face |
| `seal_showdown_pair` | Seal the two live coefficients and reveal the four subset-sum rows. Each coefficient has bit 127 set. The account keeps 14 ciphertext slots |
| `validate_bet` | Poker streets only. Checks the encrypted stack and records the public bet delta |
| `compute_pots` | Poker, testing builds only. Legacy queue. The callback discards the old payout vector and advances the hand to phase 6. Circuit source settles with `settle_all_seats` and `distribute_and_settle` |
| `fund_player_game_escrow` | Move the hand stake from table escrow into that seat’s game escrow |
| `apply_casino_player_net` | Add or subtract that seat’s net on the game escrow |
| `return_player_game_escrow` | Move the remaining game escrow back to table escrow |
| `settle_casino_hand` | House games. Update the dealer-pool ciphertext and end the hand |
| `stake_dealer_pool` | Before the hand, for every kind except bingo. Covers `start_hand` |

`distribute_and_settle` and `settle_all_seats` are on the poker computation
list, so the cluster must have them finalized. The two-player test still
settles with the legacy `compute_pots` queue and does not call
`distribute_and_settle`. The Anchor program does not queue `settle_all_seats`
yet. See [arcium.md](./arcium.md#poker-settlement-as-the-program-stands).

Chip amounts in `settle_casino_hand` and `apply_casino_player_net` are
chosen by the runner. Those instructions are compiled with the `testing`
feature. A passing test means the queue, the callback, and `end_hand` (or,
for bingo, the room authority’s `end_hand`) completed. It does not decrypt
the pool or the escrow and compare them to a plaintext ledger.

## Shared shape of a casino hand

House games and baccarat, war, and bingo go through
`setupCasinoEncryptedTable` after `initializeGames`:

1. Create an SPL mint, a room, and encrypted room wallets.
2. Deposit, credit, and lock a 10,000 buy-in into each seat’s table escrow.
3. For every kind except bingo, initialize the dealer pool and stake
   250,000 so `start_hand` coverage passes. Bingo skips the pool.
4. `start_hand`, then `mark_in_hand`.

The shoe is then:

1. Every seat registers and shuffles.
2. Share proofs land, and `verify_deck_hash_chunk` produces `deckHash`.
3. `reveal_card` opens the cards that showdown needs, for the proving seat.
4. `seal_showdown_pair` runs for that seat. The host decrypts the
   coefficients with the MXE key.
5. The proving seat submits the showdown proof. The runner recomputes the
   public field from the opened faces and the sealed coefficients.
6. Settlement runs, then deck staging is closed.

Poker has no dealer pool and no `setupCasinoEncryptedTable` stake. Its
betting and reveal order is below.

After settlement the casino `GameState.phase` is read back. Poker must be
`6` (`PotsDistributed`). Every other full hand must be at least `3`
(evaluation). House settlement ends the table hand without pushing the
poker street machine to 6.

## Poker

`runComplete2PlayerHand` is a two-seat check-down.

1. Register, shuffle `shuffle_1_deck_52_main`, share
   `poker_share_hashout_main`.
2. Preflop `validate_bet`: small blind 10, big blind 20, then checks.
   Flop, turn, and river are checks. Stacks start at the seat buy-in.
3. `reveal_card` opens each seat’s two hole cards to that seat, then the
   board to both seats as each street closes. At showdown each seat also
   receives the opponent’s holes.
4. Both seats preview the nine winner masks from the shuffled deck. The
   masks must agree. Active pots are normalized to one chip for that
   preview. The encrypted pot amounts stay private. Winner ranking is
   unchanged.
5. One seat proves `poker_showdown_hashout_main`.
6. `compute_pots` waits until phase is 6.

The test expects `(packed + 1) · c0 + c1`, where `packed` is the nine
winner masks as `Σ mask_i · 1024^i`, the input hash including the seal
commitment, and phase 6. The seal is the two coefficients from
`seal_showdown_pair`.

## Baccarat and war

Both use `ContinuousCasinoHand`. Baccarat loads a 1-deck shoe and opens 6
cards. War loads a 6-deck shoe and opens 4 cards. The last seat is the
house player (`src/house/baccarat.ts` or `src/house/war.ts`). It sits in
the reserved physical seat (`11` on a full table; the last player of a
shorter hand is placed there). It registers, shuffles, and shares, and
does not lock a stake. The earlier seats are the bettors. Banker or dealer
in the showdown winner is the card outcome.

The proving seat is seat 0. The last seat is the house, and
`initialize_game` sets `dealer_index` to that player index. Showdown
returns winner `0` (player), `1` (banker or dealer), or `2` (tie). That
winner is the card outcome. The public field is `(winner + 1) · c0 + c1`.

Settlement locks `stakeAmount` (100 in the test) from each bettor. A player
win pays that stake back to every bettor from the pool (`playerPayout = stake
× bettors`, `poolGrossWin = 0`). A house win leaves the stakes in the pool
(`poolGrossWin = stake × bettors`). A tie moves no net. The test expects the
winner in `{0, 1, 2}`, that two-term field, `handSettled`, and phase at
least 3.

## Blackjack

Two seats, 6-deck shoe, dealer index 1, stake 100. Light-casino starts at
one 16-card share chunk. Further chunks open only when the shoe cursor
needs card 16 or later. The off-chain plan for two seats is two chunks (32
cards) and a 24-card showdown window. A separate test initializes a 4-seat
game and checks that the chain still starts at one chunk while the plan
says four. That test does not play the hand.

The played hand:

1. Register, shuffle, share.
2. Staged reveals: both player cards and the dealer upcard to the bettor;
   the hole only to the dealer until the player has finished.
3. If the upcard is an ace, insurance or even money is recorded before
   further hits. Even money, or every player hand busting, skips showdown.
   The test expects `skippedShowdown === false`, so this shoe must reach a
   showdown.
4. The player follows basic strategy, including split, up to four hands.
   Each hit, stand, or split is a Groth16 action proof verified before the
   next card. The test expects at least two action proofs.
5. The dealer plays stand on soft 17. Draws are revealed as they are dealt.
6. The bettor proves showdown. Outcome `0` is a loss, `1` a push, `2` a
   win, `3` a blackjack. The public field is
   `(outcome + 1) · c0 + c1`.
7. `settle_casino_hand` pays the bettor from the dealer pool: loss keeps
   the stake, push returns it, win pays even money, blackjack pays 3:2.
   Insurance that hits pays 2:1 on the insurance stake.

`open_blackjack_action_window` starts the three-minute action clock. The
test acts immediately, so the timeout instructions are not what this file
exercises.

## Roulette

European wheel, 37 pockets, dealer index 1, stake 100. The twelve bet
classes are packed as `Σ code_i · 36^i` into the first of the two sealed
coefficients.
The bettor commits two tickets before the draw is opened: straight-up on
17, and red. The dealer does not bet.

Showdown opens one pocket. The public field is `(packed + 1) · c0 + c1`.
Settlement pays the bettor from the dealer pool using that field. The test
expects the hash match, seat 0 as the submitter, `handSettled`, and phase
at least 3.

## Craps

Dealer index 1, stake 100, two dice. The twelve bet multipliers pack into
the first coefficient and `action + pointOut · 6` is the second. The bettor
commits pass and field before the dice are opened. The dealer does not bet.

Showdown opens both faces. The public field is `(bets + 1) · c0 + (table + 1) · c1`. Settlement
pays the bettor from the dealer pool. The test expects the hash match,
`handSettled`, and phase at least 3.

## Keno

Dealer index 1, 80-number cage, twenty draws opened. The public field is
`(hitCount + 1) · c0 + c1`. The dealer’s ticket is empty. The bettor’s
ticket is the seven spots `1, 7, 19, 33, 44, 56, 68`, committed with
`keno_bet_main` after register and before the draw is revealed.

Showdown counts hits. Settlement is house-funded. The runner treats each
hit as one unit of profit on `stakeAmount` (100): a miss pays the stake to
the pool, and `matches > 0` pays `stake × matches` of profit on top of the
stake. That is the harness paytable, not a separate posted keno table. The
test expects the hash match, `handSettled`, and phase at least 3.

## Slots

3-reel, 22 stops, dealer index 1, stake 100. The coin bet is fused into
the share circuit, so the hand is exactly two seats. The player’s coin bet
is 1. The house coin is the share-circuit dummy and is not an economic bet.
The 5-reel shoe is covered by the host proof tests, not by this file.

Showdown opens the center stop of each reel. The public field is
`(award + 1) · c0 + c1`. Settlement pays the bettor from the dealer pool:
`profit = stake × award`. A zero award sends the coin stake to the pool.
The test expects the hash match, `handSettled`, and phase at least 3.

## Bingo

75-ball, two seats, no house seat, no dealer pool. Card price is 100. The
chain is initialized with a 75-card reveal window, dealer index 255, and
pot mask 0. The off-chain plan has 15 share chunks of 5 balls. The hand
plays chunk 0 only, so `nCalled` is 5.

1. Register, then `bingo_card_75_main` for each seat.
2. Shuffle `shuffle_1_deck_75_main`, share the first 5-ball window.
3. Reveal those balls to seat 0, run `seal_showdown_pair`, prove
   `bingo_showdown_75_hashout_main`.
4. The public field is `(packed + 1) · c0 + c1`, where `packed` is
   `won * 256 + completionIndex`.
5. Both committed cards are scored against the opened prefix. The seats
   that finished on the earliest winning call split `100 × 2`. Nobody
   finishing returns each card price. The odd chip, when there is one, goes
   to the lower seat index. Chips move with `fund_player_game_escrow`,
   `apply_casino_player_net`, and `return_player_game_escrow`.
   `settle_casino_hand` is not called.
6. The room authority calls `end_hand`.

The test expects the hash match, `nCalled === 5`,
a non-zero deck hash, `handSettled`, and phase at least 3. The 90-ball
showdown is covered by the host proof tests. This file does not play it.

## What a pass establishes

- Localnet accepted the casino binary and light-casino verified every proof
  the hand submitted.
- The Arcis computations in that hand’s list were queued and their callbacks
  landed.
- The showdown public field is the host sum of the opened result under the
  coefficients the cluster sealed.
- The share proof committed the sealed partials.
- Poker reached phase 6. Every other full hand settled and left phase at
  least 3.
- Blackjack played at least two action proofs and reached showdown.
- Bingo’s called-ball count is the one chunk the hand shared.

The three-minute showdown forfeit and the three-minute blackjack stand are
described in [on-chain.md](./on-chain.md#timeouts). These tests submit the
proof as soon as the window opens, so they do not wait out either clock.
