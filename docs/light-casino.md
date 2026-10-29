# Light-casino

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

Pinocchio program that verifies Groth16 proofs, stores the shoe artifacts,
and can CPI a receipt into [casino](./casino.md). Casino owns the chips.
This program owns the proof. The circuits those proofs come from are
[zk-casino](./zk-casino/README.md).

| | |
|--|--|
| Crate | `rust/light-casino/programs/light-casino` |
| Program id | `CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc` |
| Stack | pinocchio `0.9`, `light-sdk-pinocchio` `0.23`, `groth16-solana` `0.2` |
| Entry | `dispatch::dispatch` matches an 8-byte Anchor sighash |

`shared-zk-ids` is the program id, `GameKind`, receipt layout, and
share-accumulator offsets that both programs share. The verifying keys are
generated into `programs/light-casino/src/verifying_keys/<game>/` and
selected by `verifying_keys/registry.rs`.

`scripts/fetch-program-keypairs.sh` fetches this program’s vanity keypair
from the IceColdCasino 1Password vault. A local `./scripts/build.sh` writes
a throwaway keypair so CI can compile. The declared id stays
`Casinodr…`.

The `testing` feature is off unless the build enables it. With it,
`close_light_session` is available, and a shuffle may skip the
UsedPermutation Light CPI when the remaining Light accounts are empty.
Arcium-only localnet has no Light indexer, which is why the skip exists.
A production build leaves the feature off.

## Game state

`initialize_game` creates `GameState`. The caller passes `game_id`,
`num_players`, `game_kind`, `shoe_decks`, `roulette_variant`,
`dealer_index`, and `bridge_mode`.

| `GameKind` | Seats | House seat | Shoe / variant |
|------------|------:|------------|----------------|
| Poker `0` | 2–10 | none (`dealer_index` 255) | 1 deck |
| Baccarat `1` | 2–12 | last player index | 1, 6, or 8 decks |
| Blackjack `2` | 2–8 | last player index | 1, 6, or 8 decks |
| War `3` | 2–12 | last player index | 1, 6, or 8 decks |
| Roulette `4` | 2–12 | last player index | 37 or 38 |
| Craps `5` | 2–12 | last player index | two dice |
| Keno `6` | 2–12 | last player index | 80-ball cage |
| Slots `7` | 2 | last player index (seat 1) | 3 or 5 reels, in `roulette_variant` |
| Bingo `8` | 2–12 | none (`dealer_index` 255) | 75 or 90, in `roulette_variant` |

`needs_house_seat` is every kind except poker and bingo. The house seat
registers, shuffles, and shares. It does not place the economic bet.
Baccarat’s banker and war’s dealer in the showdown winner code are card
outcomes. The seat index is still required.

`bridge_mode` is `0` standalone or `1` casino-required. Standalone verify
succeeds with the bridge accounts omitted. Casino-required verify fails
closed when they are omitted. A partial set of bridge accounts is
`InvalidPokerBridgeAccounts`.

`GamePhase` on this program stops at `4`: registration, shuffle, share,
evaluation, complete. Poker’s phase `5` and `6` live on the casino
`GameState`.

`set_bingo_pattern` sets the 75-ball pattern (`0` any line, `1` corners,
`2` blackout) after registration and before the first share chunk.
`pattern_id` is ignored for 90-ball and for every other game.

Blackjack and bingo start at one share chunk. `extend_share_chunks` opens
the next chunk once the hand is in evaluation. Blackjack’s further chunks
are 16 cards. Bingo’s are 5 balls. Other games stay at one chunk.

## Proof receipt

`ProofReceipt` is seeded `proof_receipt_v2`, then game id, generation,
phase, and player index. Circuit version is `2` (`CIRCUIT_VERSION_V2`).

| Status | Value | Meaning |
|--------|------:|---------|
| Initialized | `0` | Account exists, proof not accepted |
| Verified | `1` | Pairing succeeded and the public inputs matched |
| Consumed | `2` | Casino accepted the CPI |

Phases are register `0`, shuffle `1`, share `2`, showdown `3`, action `4`.

`init_cpi_authority` creates the PDA that signs `consume_*` into casino.
After that, clients fund the same address as a system account so it can pay
rent for the casino `PlayerState` on register. Seeds are `cpi_authority`.

When the bridge accounts are present, verify CPIs:

| Casino instruction | When |
|--------------------|------|
| `consume_register_receipt` | Register. Also passes the BabyJubJub key and padding. Creates casino `PlayerState`. |
| `consume_proof_receipt` | Shuffle, share, showdown, action. Share also passes casino `ShareVerifyAccumulator`. |

The CPI payload is fixed in `shared-zk-ids`: generation, phase, player
index, circuit version, output hash. Casino rejects a receipt that is not
`Verified`, a version other than 2, or a hash that does not match the
account.

## Instructions

The handlers live in `programs/light-casino/src/lib.rs`. `dispatch.rs` is
the sighash table. Grouped by the shoe:

**Session.** `initialize_game`, `set_bingo_pattern`, `extend_share_chunks`,
`init_cpi_authority`, `close_cpi_authority`.

**Register.** `register_player_receipt` verifies and writes the receipt.
`register_player` does that and also stores the key as a Light compressed
account. Public inputs are the `register_main` verifying key.

**Shuffle.** `allocate_shuffle_public_inputs` and
`extend_shuffle_public_inputs` grow the staging account in 10 KiB steps.
`create_shuffle_public_inputs` opens it in one shot when it fits.
`write_shuffle_public_inputs` and `prepare_shuffle_chunk` fill caller
inputs and the MSM partial. `write_prepare_shuffle_chunk`,
`absorb_shuffle_fields`, `absorb_shuffle_partial`, `absorb_shuffle_batch`,
and `fund_shuffle_lanes` are the chunked path that keeps each transaction
under the size cap. `cache_shuffle_deck_hash` stores the running deck hash.
`finalize_prepare_shuffle_inputs` checks the prepare mask.
`verify_shuffle_staged` runs the pairing. `finalize_shuffle` advances the
phase once every seat has a consumed shuffle receipt. `init_shuffle_receipt`
opens the receipt account ahead of verify.

The initial deck hash every shuffle must extend is
`SHUFFLE_INITIAL_DECK_HASH` in `shared-zk-ids`.

**Share.** `allocate_share_public_inputs`, `extend_share_public_inputs`,
`create_share_public_inputs`, `write_share_public_inputs`,
`prepare_share_inputs`, `prepare_share_chunk`,
`finalize_prepare_share_inputs`, and `verify_share_staged` mirror the
shuffle staging for the share circuit. `write_share_chunk`,
`absorb_share_street`, and `finish_share_street` are the street-sized path
in `share_tier.rs`. `verify_share` is the single-transaction verifier.
`verify_slot_share` is the slots share, which fuses the coin bet.
`init_share_receipt` opens the receipt. `close_share_receipt` returns its
rent.

**Bets and cards.** `create_bet_public_inputs`, `write_bet_public_inputs`,
`prepare_bet_chunk`, and `verify_bet` verify roulette, craps, and keno bet
circuits. `verify_card_commit` verifies a bingo card. `close_bet_public_inputs`
replaces the large bet-input account with a `LIGHT_KIND_BET_COMMIT`
compressed account. `store_roulette_bets` stores the encrypted roulette
bet limbs (`LIGHT_KIND_ROULETTE_BETS`).

**Showdown.** `init_showdown_receipt` opens the receipt.
`init_bingo_showdown_rows` / `hash_bingo_showdown_row` stage up to 12 bingo
row hashes so verify does not carry every card account.
`init_keno_showdown_rows` / `hash_keno_showdown_row` stage 11 keno rows.
`verify_showdown_receipt` and `verify_showdown` run the showdown pairing.
`finalize_showdown` requires every required seat’s receipt and, in casino
bridge mode, the consumed status. `fold` records a poker fold on this
program’s game state.

**Blackjack actions.** `record_blackjack_action_layout` and
`record_blackjack_showdown_layout` store the public statement of the next
action or of the final hand. `record_blackjack_insurance` stores insurance
or even money. `init_action_receipt` / `verify_action` verify
`blackjack_action_hashout_main`. `open_blackjack_action_window` starts the
three-minute clock on `BlackjackTurn`. `stand_blackjack_seat` is the seat
leaving, or the dealer standing them in after the timeout.

**Timeouts.** `open_showdown_window` starts the three-minute showdown clock
for blackjack and bingo. Other games open that clock when share completes.
`forfeit_showdown` is the house dealer, or the `initialize_game` payer when
the kind has no house seat. It sets `showdown_forfeited`, moves the phase
to complete, and rejects a later proof. It does not invent a Groth16 proof.
The clock is 180 seconds on the Clock sysvar. The chip effect of a forfeit
is described in [on-chain](./on-chain.md#timeouts).

## Verifying keys

`registry::lookup` picks the key from `GameConfig` and `VkPhase`:

| Phase | How the circuit id is chosen |
|-------|-------------------------------|
| Register | `register_main` for every game |
| Shuffle | Shoe: `shuffle_{1,6,8}_deck_52_main`, `shuffle_1_deck_{37,38}_main`, `shuffle_2_dice_6_main`, `shuffle_1_deck_{75,80,90}_main`, `shuffle_{3,5}_reel_22_main` |
| Share | `{game}_share_hashout_main`, or `slot_share_{3,5}_reel_hashout_main` |
| Showdown | `{game}_showdown_*_hashout_main` |
| Action | `blackjack_action_hashout_main` |
| Bet | `roulette_bet_{37,38}_main`, `craps_bet_main`, `keno_bet_main`, `bingo_card_{75,90}_main` |

A public-input count that does not match the key fails before the pairing.
The host’s proving keys are the `zkey/` files in [zkeys](./zkeys.md). These
Rust keys are the verification half, committed into the program binary.

## Light compressed accounts

Shuffle and share artifacts can be stored through the Light system program.
`store_artifact_chunk` and `create_revealed_partials` each take a Light
validity proof and write up to eight 32-byte commitments
(`LIGHT_CHUNK_COMMITMENTS`).

| Kind | Value | Payload |
|------|------:|---------|
| Register | `1` | Encryption key |
| Shuffle deck | `2` | Deck commitments |
| Share partials | `3` | Sealed partials |
| Showdown masks | `4` | Winner-mask material |
| Used permutation | `5` | The permutation the shuffle consumed |
| Roulette bets | `6` | Encrypted bet limbs |
| Bet commit | `7` | `bet_hash` plus the bet count |

The Light system programs loaded at localnet genesis are a different
program from this one. This program is the casino verifier. It CPIs into
Light. It is not the Light protocol itself.

## Rent vault

Per-player SOL that fronts staging rent. Seeds are `rent_vault`, room id,
player. The account is owned by light-casino and is 73 data bytes
(discriminator, room, player, bump). The whitelist admin funds it with
`deposit_rent_vault`. Shuffle, share, and showdown instructions draw the
next realloc from it (`draw_rent_vault`) and pay the rent back on close
(`reimburse_rent_vault`). `recapture_rent_vault` pulls SOL that was left on
a staging account. `settle_rent_vault` pays the player, and only when the
signer is the casino rent-authority PDA. `close_player_state` returns a
finished player account. `close_light_session` (`testing`) closes the
light-casino session accounts after a hand.

The byte budget those draws have to cover is [sol-cost](./sol-cost.md).
