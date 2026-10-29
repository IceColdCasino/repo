# Arcium

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

Arcium is the confidential-compute cluster. Casino queues an encrypted
instruction, the cluster runs it, and a callback writes the new ciphertext
back into a casino account. Groth16 stays on [light-casino](./light-casino.md).
Chip accounts, rooms, and the callback handlers live in
[casino](./casino.md). What the nine localnet hands actually queue is in
[arcis-tests](./arcis-tests.md).

The circuit crate is `rust/casino/encrypted-ixs`. It depends on `arcis` and
wraps every computation in `#[encrypted] mod circuits`. The function name on
`#[instruction]` is the computation name. Casino binds that same string in
`#[arcium_callback(encrypted_ix = "...")]`, in the queue and callback account
macros, and in `comp_def_offset`.

Anchor side is `arcium-anchor` `0.14.1`, matching the casino program.

## Cluster

`rust/casino/Arcium.toml` describes the localnet MXE:

| Setting | Value |
|---------|--------|
| Nodes | 2 |
| Node addresses | `172.21.0.3`, `172.21.0.4` |
| Backend | Cerberus |
| Startup wait | 1800 seconds |

The cluster offset selects the MXE accounts. Localnet uses `0`. Devnet uses
`456`, the constant `DEVNET_CLUSTER_OFFSET` in
`app/frontend/src/backend/client.ts`. A browser reads the offset from
`__ZK_LAUNCH_CONFIG.clusterOffset`. A process reads `ARCIUM_CLUSTER_OFFSET`.
`ArciumMPCHelper` in `src/arcium/mpc.ts` derives the cluster, mempool,
executing-pool, and computation accounts from that offset. It does not call
`getArciumEnv()`, which throws in a browser.

Each in-flight computation reserves an 8,000,000-lamport budget. That figure
is a lamport ceiling. It does not scale with the rent rate. The byte layout
of the rest of the hand float is in [sol-cost](./sol-cost.md).

## Queue and callback

A casino instruction that moves encrypted chips does four things:

1. Check the public preconditions (phase, whitelist, seat, coverage).
2. Build arguments with `ArgBuilder`: an X25519 pubkey and nonce in front of
   each ciphertext, then the plaintext fields the circuit is allowed to see.
3. `queue_computation` with a caller-chosen `computation_offset`, the argument
   bytes, and a callback instruction that names the accounts the cluster may
   write.
4. Return. The ciphertext changes when the callback lands.

The callback verifies `SignedComputationOutputs` against the cluster account
and the computation account. A failed verification is
`ArciumError::AbortedComputation` and writes nothing. A computation that
reveals a boolean acceptance flag is rejected with `InvalidProof` when that
flag is false, before any ciphertext is stored.

`init_*_comp_def` uploads one computation definition. The e2e runner calls
`initCompDefs` and, by default, requires those definitions to already be
finalized. `UPLOAD_COMP_DEFS=1` uploads any that are missing.
`SKIP_COMP_DEFS=1` skips the check. The host name map is
`CIRCUIT_OFFSET_ALIAS` in `src/arcium/mpc.ts` (`sealShowdownPair` →
`seal_showdown_pair`, and the same for the other camelCase callers).

## Pending operations

`PendingOperation` on the casino account binds a callback to the computation
that opened it:

| Field | Meaning |
|-------|---------|
| `generation` | Which hand job this is |
| `computation` | Computation account that may deliver |
| `authority` | Who queued it |
| `started_slot`, `expires_slot` | Slot clock. TTL is `CALLBACK_TTL_SLOTS` (300) |
| `status` | `1` pending, `2` completed, `3` expired |

A callback for a different computation fails closed (`StaleCallback`). A
second delivery of a completed computation is a success and writes nothing.
A late delivery of the same pending computation still applies after
`expires_slot`. The expiry only lets a lost callback be replaced.

## Computations

Every `#[instruction]` in `encrypted-ixs/src/lib.rs`:

| Computation | What the cluster does | What the callback receives |
|-------------|----------------------|------------------------------|
| `credit_room_balance` | Add a deposited chip count to the room wallet | The new ciphertext |
| `lock_table_buyin` | Move `buy_in` from the room wallet into table escrow when the wallet covers it. Otherwise both ciphertexts stay | Both ciphertexts |
| `unlock_table` | Add table escrow back onto the room wallet when `in_hand` is `0` | Room-wallet ciphertext |
| `debit_for_withdraw` | Subtract a withdrawal when the wallet covers it above locked escrow | New ciphertext and `sufficient` |
| `stake_dealer_pool` | Move a stake from the staker’s room wallet into the dealer pool when the wallet covers it | Both ciphertexts |
| `redeem_dealer_pool` | Move a redemption the other way when the pool covers it | Both ciphertexts |
| `fund_player_game_escrow` | Move a hand stake from table escrow into that seat’s game escrow when the escrow covers it | Both ciphertexts |
| `return_player_game_escrow` | Add the remaining game escrow back onto table escrow and zero the game escrow | Both ciphertexts |
| `apply_casino_player_net` | Add or subtract that seat’s net on game escrow when the showdown terms are in range | Ciphertext and `ranges_ok` |
| `settle_casino_hand` | Add the pool’s gross win, then subtract the player payout and the protocol fee, when the showdown terms are in range | New pool ciphertext, a zero word, `ranges_ok` |
| `validate_bet` | Check the encrypted stack and the current bet | Updated balance, new current bet, fold, all-in, bet delta, street-closed |
| `verify_deck_hash_chunk` | Open one 4-limb batch and re-seal it to the cluster. Casino queues this for the deck-hash accumulator and for each player’s share accumulator | Re-sealed limbs, a zero contribution, the batch index |
| `reveal_card` | Open one 4-limb slice of a staged card | Up to 4 little-endian limbs, the destination offset, the count. The callback stores the limbs big-endian |
| `seal_showdown_pair` | Draw the two live showdown coefficients and their subset-sum rows | Two ciphertexts and four revealed rows |
| `settle_all_seats` | Recompute the poker showdown hash. On a match, add every seat’s share onto one encrypted ledger | Ledger ciphertext and `hash_matches` |
| `distribute_and_settle` | Same hash check and the same share function, for one seat’s escrow | That escrow’s ciphertext and `hash_matches` |
| `apply_share_unseal_penalty` | On a public cheater mask, move that seat’s encrypted bet to the house and refund the others | Refunds, the share-stake ciphertexts unchanged, house ciphertext, `accepted` |

Amounts that fail the coverage check stay where they were. The cluster does
not mint chips to make a lock, stake, or debit succeed.

`settle_casino_hand` debits the protocol fee inside the pool ciphertext. The
second output is a zero word. The casino callback stores the new pool
ciphertext, marks the hand settled, ends the table hand, and emits
`protocol_commission: 0`. It does not add the fee to `ProtocolTreasury`.

`validate_bet` reveals the street-close bit. A heads-up call that only
matches the blind leaves the street open so the big blind can still act.
The callback applies that bit. It does not close the street on its own.

`apply_share_unseal_penalty` does not add the SOL share stake to the house.
That stake is settled in public by `settle_share_penalty`. A set bit past
`num_players`, or an empty mask, is rejected and changes nothing.

## Showdown seal

`seal_showdown_pair` is one circuit. Slot 0 is encrypted under `nonce` and
slot 1 under `nonce + 1`. Both slots force bit 127
(`TWO_127` in `encrypted-ixs`). Their weights, from `seal_weights.rs` and
`circuits/showdown_seal.circom`, accumulate into four rows. The callback
reveals those rows and stores them on `SealedShowdownCoefficients`.

The account still has 14 ciphertext slots. The live polynomial uses the
first two. `n_active`, `coeffs_needed`, and `coeffs_done` are 2 after the
callback, and `folds_done` is 1. `slot_done` is `0b11`. Settlement consumes
the seal that belongs to `GameState.showdown_hash_player`.

The host name is `sealShowdownPair`. Older notes that say
`seal_showdown_coefficients` mean this computation.

## Poker settlement, as the program stands

`settle_all_seats` is the all-seat circuit. It would write
`EncryptedSettlementLedger` and reveal only `hash_matches`. The Anchor
program does not queue it yet.

`distribute_and_settle` is compiled in every casino build. It credits one
seat’s `PlayerGameEscrow` with that seat’s share. A hash mismatch rejects
the callback before the escrow changes. When every unsettled showdown seat
has been credited, the callback sets phase `6`, marks settlement settled,
and ends the table hand.

`compute_pots` is a testing-only queue for a previously built artifact. The
circuit source no longer returns that artifact’s payout vector. The
instruction stays so a cluster that still has the old definition can be
called. Its callback requires `hash_matches`, discards the payout vector,
zeroes `GameState.payouts`, and closes the hand. `cfg(feature = "testing")`
gates the body; a build without that feature returns
`LegacySettlementDisabled`. The two-player localnet hand still queues
`compute_pots`. See [arcis-tests](./arcis-tests.md#poker).

Plaintext pot rebuilding for the public bet tracker is `pot.rs` inside the
casino program. That runs on Solana, in the `validate_bet` callback, and is
separate from these three MPC settlements.

## What stays public

The cluster sees ciphertexts and the plaintext fields listed above. It
reveals the flags and the seal rows. It does not reveal a room-wallet
balance, a pool balance, a pot payout, or a card face. `reveal_card` returns
the opened commitment bytes. The callback writes their big-endian form into
`RevealedCard`. The face stays encrypted to the recipient.

Light-casino’s Groth16 receipt is the other public commitment. Arcis checks
that the sealed coefficients reproduce `showdown_hash`. It does not run the
pairing.
