# Casino

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). See [README.md](../README.md).

Anchor program for rooms, tables, encrypted wallets, poker pots, and the
dealer pool. Confidential transitions are queued to Arcium. The circuits
themselves are [arcium](./arcium.md). Groth16 receipts arrive by CPI from
[light-casino](./light-casino.md). How a pot differs from the dealer pool is
[on-chain](./on-chain.md).

| | |
|--|--|
| Crate | `rust/casino/programs/casino` |
| Program id | `4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY` |
| Stack | Anchor `1.0.2`, `arcium-anchor` `0.14.1` |
| IDL | `src/chain/idl/casino.json` |

`declare_id!` in `programs/casino/src/lib.rs`, `Anchor.toml`, and
`CASINO_PROGRAM_ID` in `rust/shared-zk-ids` are that same address.
`scripts/fetch-program-keypairs.sh` still fetches a different pubkey,
`CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv`. That key is not the id this
source declares. A local build writes a throwaway keypair so CI can compile.
The binary’s declared id stays `4nPbWQ…`.

The `testing` feature is off by default. Localnet builds turn it on. It
compiles the dealer-pool chip movement, the personal-chip faucet and
transfers, `end_hand`, `close_session`, the legacy `compute_pots` queue, and
the plaintext test setters `set_showdown_hash`, `set_pot_amounts`, and
`set_verified`. `init_dealer_pool`, the treasury, `start_hand` coverage,
`submit_bet`, `seal_showdown_pair`, and `distribute_and_settle` are in every
build.

Whitelist admin is `CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3`
(`WHITELIST_ADMIN` in `shared-zk-ids`). Creating a room and opening a table
stay with that key. A seated, whitelisted player calls `start_hand`.

## Accounts

Seeds are the byte strings below. Amounts that move in a hand are Rescue
ciphertexts plus a plaintext mirror the program can check without opening
the ciphertext (`balance_u64` on the wallet and escrow, `total_shares` on
the pool, pot amounts on `GameState`).

| Account | Seeds | Holds |
|---------|-------|--------|
| `Room` | `room`, room id | Authority, SPL mint, vault, table count, default small blind, poker `rake_bps`, house pubkey |
| Vault token account | `vault`, room id | The room’s SPL |
| `WhitelistEntry` | `whitelist`, room id, player | That player may sit |
| `RoomWallet` | `room_wallet`, player, room id | Encrypted personal balance for the room |
| `TableState` | `table`, room id, table id | Kind, shoe, variant, 12 seat pubkeys, dealer button, hand snapshot |
| `TableEscrow` | `table_escrow`, player, room id, table id | Encrypted chips locked at this seat |
| `DealerPool` | `dealer_pool`, room id, table id | Encrypted bankroll, share count, bet limits, reserved liability |
| `PoolStakeAccount` | `pool_stake`, pool, staker | That staker’s shares and encrypted accrual |
| `ProtocolTreasury` | `protocol_treasury`, room id | Plaintext `total_commissions` and `total_withdrawn` |
| `GameState` | `game_state`, game id | Phase, betting, pots, showdown hash, settlement, next-hand pipeline |
| `PlayerState` | `player`, game id, player index | Registered key and padding |
| `PlayerGameEscrow` | per player, per game | Encrypted hand stake |
| `EncryptedGameBetting` | per game | Encrypted bet totals and pot ciphertexts |
| `SealedShowdownCoefficients` | `sealed_showdown_coeffs`, owner | Two live coefficients, four revealed rows, 14 ciphertext slots |
| `EncryptedSettlementLedger` | per settlement | Ten encrypted seat balances from `settle_all_seats` |
| `DeckStaging` | per game | Up to 900 commitment limbs for the MPC shuffle |
| `RevealedCard` | recipient, card | Resealed partials for one card |
| `ShareVerifyAccumulator` | `share_verify_acc`, game id, player index | Running share-hash check. Layout is fixed in `shared-zk-ids` |
| `PendingWithdraw` | `pending_withdraw`, player, room id | An in-flight SPL withdrawal |
| Rent authority | `casino_rent_authority` | The only casino signer that may pull a light-casino rent vault |

`TableState.seats` is 12 wide. The live cap is `GameKind::max_players`:
slots 2, blackjack 8, poker 10, everything else 12. A room holds at most 64
tables.

`GameState.phase` is `0` registration, `1` shuffle, `2` share, `3`
evaluation, `4` complete, `5` showdown, `6` pots distributed. Poker
`betting_phase` is `0` not started, then preflop, flop, turn, river,
showdown. `act_deadline_unix` is the betting clock. `0` means no decision is
open. The offset of that field is fixed: later code calls it
`ACT_DEADLINE_OFFSET` at byte 1053 of the account data.

`SealedShowdownCoefficients` is keyed by the seat wallet so the next hand
can reuse a seal that showdown has not consumed. Settlement sets `consumed`.

`ProtocolTreasury.total_commissions` is a legacy counter. Current
`settle_casino_hand` does not add to it. `withdraw_protocol_commissions`
still transfers `total_commissions − total_withdrawn` out of the room vault
and cannot exceed that remainder.

## Rooms and seats

`create_casino` / `add_casino_admin` / `add_casino_dealer` open the operator
records. `create_room` opens the mint, vault, and room. `set_room_rake`
sets poker rake in basis points. `0` takes nothing. `500` is 5 percent.
Rake is charged on a post-flop fold to one player, or at showdown, and is
credited to the whitelisted house wallet. A preflop fold leaves
`reached_flop` false and is not raked. `poker_rake_lamports` in `pot.rs` is
the public formula.

`create_table` stores `GameKind`, shoe decks, and the roulette or slots
variant. `close_table` refuses a table that still has a seated player.
`GameKind` is poker `0`, baccarat `1`, blackjack `2`, war `3`, roulette `4`,
craps `5`, keno `6`, slots `7`, bingo `8`.

`add_to_whitelist` / `remove_from_whitelist` edit the room list.
`sit_at_table` takes any free physical seat under that kind’s cap. The
reserved house seat is `GameKind::house_seat`: baccarat, war, roulette,
craps, and keno use 11, blackjack uses 7, and slots uses 1. A whitelisted
player may sit there. `snapshot_hand` refuses to start until that seat is
occupied. The pending order lists the other seats first and the house last,
and sets `dealer_seat` to it. Poker and bingo have no reserved seat. The
button for those two advances in `seat_order.rs`.

`init_room_wallet` opens the encrypted wallet. `buy_in_room` is the same
account path. `credit_room_balance` queues the Arcis credit after SPL has
landed in the vault. `lock_table_buyin` queues the move into table escrow.
`unlock_table` queues the move back, and only when that seat is not in a
hand. `withdraw_spl` queues `debit_for_withdraw` and, on a sufficient
callback, transfers SPL out of the vault.

`open_room_session` and `open_delegated_room_session` bind a session key.
`close_room_session` drops it. A session key plays as its owner.

With `testing`, `faucet_credit_personal` mints personal chips, and
`transfer_personal_to_seat` / `transfer_seat_to_personal` move them. Those
three are how the localnet harness funds a seat.

## A hand

`initialize_game` on light-casino creates the proof-side `GameState`.
Casino `start_hand` links the table to a casino `GameState` for the same
game id. The signer is seated and whitelisted. Poker’s pot mask starts as
every seated player. Every other kind starts with an empty mask.

Poker and bingo may pass an empty dealer-pool account. Every other kind
fails with `InsufficientDealerCoverage` when that account is empty. When
`max_bet` or `bet_unit` is set, `total_shares` must cover the worst case
in `room.rs`:

| Kind | Shares required |
|------|-----------------|
| Roulette | `max_bet × (35+17+17+11+8+8+5+2+2+1+1+1) × seats` |
| Blackjack | `bet_unit × 4 × 3 × seats` |
| War, baccarat, craps, keno, slots | `bet_unit × seats` |

`init_dealer_pool` refuses poker and bingo and stores `min_bet`, `max_bet`,
and `bet_unit`. `init_protocol_treasury` and `init_pool_stake` open the
commission account and one staker. The stake and redeem queues are
`testing`-only. See [on-chain](./on-chain.md#dealer-pool) for the fee
schedule the settle circuit applies inside the ciphertext.

`mark_in_hand` records that a seated player is in this hand.
`init_player_state` (`testing`) opens the per-player registration account.
`init_player_game_escrow`, `init_encrypted_game_betting`, and
`init_game_table_key` open the hand’s encrypted betting accounts.
`init_bet_action_log` opens the public action log.

Registration, shuffle, and share are light-casino proofs. Casino records
them when light-casino CPIs `consume_register_receipt` or
`consume_proof_receipt`. `begin_verify_deck_hash`, `verify_deck_hash_chunk`,
and `sync_verify_deck_hash` check the deck. `verify_share_hash_chunk` and
`sync_verify_share_hash` check one player’s share. Both chunk instructions
queue the same Arcis computation, `verify_deck_hash_chunk`.
`reopen_share_for_next_chunk` returns a non-poker hand to the share phase
when `shared_cards` is still short of `num_cards`. `DeckStaging` and
`write_deck_staging` / `write_share_deck_staging` hold the limbs the cluster
reads.
`reveal_card` queues the 4-limb open. The circuit returns `to_le_bytes`. The callback reverses each limb into `RevealedCard`, so the stored commitment is the big-endian field the street hash used.
`write_reveal_chunk` / `absorb_reveal_chunks` stage those limbs.
`close_revealed_card` refunds the account after the client has stored it.

`register_next_hand`, `submit_next_hand_shuffle`, and
`submit_next_hand_share` let the next shoe proceed while this hand is still
settling. The saved seat order is `next_seat_order` on `GameState`.

## Betting and showdown

`open_preflop` opens poker betting. `start_betting_round` and
`collect_blinds` are `testing` helpers. `submit_bet` queues `validate_bet`.
The callback writes the public bet delta, recomputes up to nine pots in
`pot.rs`, and advances the street when the revealed street-close bit says
the street is over. The caller does not pick flop, turn, or river.
`expire_bet_turn` folds a seat whose `act_deadline_unix` has passed.

Folded seats leave a pot. All-in seats stay eligible for the levels they
paid. Unmatched chips are refunds. Nine pots and ten seats are the account
width.

`seal_showdown_pair` queues the two-coefficient seal. The callback stores
the ciphertexts and the four rows. Light-casino then verifies the Groth16
showdown and CPIs the receipt. Casino latches `showdown_hash` and
`showdown_hash_player`, and sets `showdown_finalized` when
`finalize_showdown` consumes the receipt.

Poker settlement is [arcium](./arcium.md#poker-settlement-as-the-program-stands):
`distribute_and_settle` in every build, `compute_pots` only under `testing`,
and `settle_all_seats` present as a circuit with no Anchor queue yet.

House games call `fund_player_game_escrow`, then `settle_casino_hand`, then
`apply_casino_player_net`, then `return_player_game_escrow`. Those four
queues are `testing`-only. Bingo uses the fund, net, and return path and
does not call `settle_casino_hand`. The room authority then `end_hand`
(`testing`). `close_session` (`testing`) closes the hand session.

`close_seat_rent` asks the casino rent authority to settle that player’s
light-casino rent vault.

## Callback clock

`PendingOperation` is shared by the encrypted instructions. The rules are in
[arcium](./arcium.md#pending-operations). Betting has its own
`bet_pending_operation`. Settlement has `settlement_pending_operation`,
`settlement_generation`, and `settlement_expiry_slot`, so a stalled
all-seat job can be replaced without accepting a different computation.

Showdown and blackjack action timeouts of 180 seconds live on light-casino.
They are described in [on-chain](./on-chain.md#timeouts).
