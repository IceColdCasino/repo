# On-chain programs

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending). The circuits those
> proofs come from are documented in [zk-casino](./zk-casino/README.md).

Two Solana programs plus the Arcis instructions the casino program queues.
The Groth16 circuits prove the shoe and the evaluation. These programs hold
the accounts, move the chips, and accept a proof only when light-casino has
verified it.

| Piece | Path | Address |
|-------|------|---------|
| Casino (Anchor) | `rust/casino` | `CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv` |
| Light-casino (pinocchio) | `rust/light-casino` | `CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc` |
| Arcis instructions | `rust/casino/encrypted-ixs` | Queued by casino; executed by the Arcium cluster |
| Shared ids and `GameKind` | `rust/shared-zk-ids` | Both programs |

`GameKind` is stored on the table: poker `0`, baccarat `1`, blackjack `2`,
war `3`, roulette `4`, craps `5`, keno `6`, slots `7`, bingo `8`.

## What each program does

**Casino** owns rooms, tables, the SPL vault, whitelist, encrypted room
wallets, table escrow, the hand, and (for every game except poker and
bingo) the dealer pool. Confidential balances are Rescue ciphertexts. A state change
on those balances is an Arcis instruction: casino queues it, the cluster
runs `encrypted-ixs`, and the callback writes the new ciphertext. Plaintext
mirrors (`balance_u64`, pot amounts, share counts, treasury commissions)
exist so the program can enforce limits without opening the ciphertext.

**Light-casino** verifies the Groth16 proofs for register, shuffle, share,
showdown, and the game-specific action or bet circuits. Verifying keys live
under `programs/light-casino/src/verifying_keys/<game>/`. A successful verify
writes a proof receipt. When the casino bridge accounts are present it CPIs
into casino to consume that receipt. Shuffle and share artifacts can also be
stored as Light Protocol compressed accounts.

**Arcis** is the confidential half of casino. The function name in
`encrypted-ixs/src/lib.rs` is the computation name (`validate_bet`,
`settle_all_seats`, `stake_dealer_pool`, …). Casino binds the same string in
`#[arcium_callback]`, the queue and callback account macros, and
`comp_def_offset`. What the localnet hands actually queue and assert is in
[arcis-tests.md](./arcis-tests.md).

## Chips, before the game matters

Every seated player follows the same path into a hand:

1. SPL is deposited into the room vault.
2. `credit_room_balance` adds that amount to the encrypted room wallet.
3. `lock_table_buyin` moves the buy-in from the room wallet into that seat’s
   table escrow, and only when the room wallet covers it.

From there the two bankrolls diverge.

## Poker

Poker is player versus player. The chips that pay a winner are the chips the
seats already committed. There is no dealer pool. `init_dealer_pool` rejects
`GameKind::Poker`. `start_hand` still receives the dealer-pool account, and
that account may be empty.

A hand:

1. `start_hand` links the table to a `GameState`. The poker pot mask starts
   as every seated player eligible. Casino kinds start with an empty mask.
2. `open_preflop` opens betting. Later streets advance inside the
   `validate_bet` callback. The caller does not pick flop, turn, or river.
3. `submit_bet` queues `validate_bet`. The circuit checks the encrypted stack
   and the current bet, then returns an updated player balance, the new
   current bet, and whether the action was a fold or an all-in. The callback
   records the public bet delta and recomputes pots.
4. `pot.rs` rebuilds up to nine pots from each seat’s total commitment and
   the fold mask. Folded seats are out of a pot. All-in seats stay eligible
   for the levels they paid. Unmatched chips are refunds.
5. Showdown is a Groth16 proof whose public field is the nine-term sum
   `Σ (mask_i + 1) · coefficient_i`. Light-casino verifies it. Casino
   latches `showdown_hash`.
6. Settlement pays those pots. `settle_all_seats` checks the same hash and
   adds each seat’s share to one encrypted ledger, all seats or none.
   `distribute_and_settle` does the same check and credits one seat’s escrow.
   A hash mismatch pays nothing.

Nine pots and ten seats are the account width. The poker circuits use the
same ten-seat committee.

## Bingo

Bingo is also player versus player. There is no dealer pool.
`init_dealer_pool` rejects `GameKind::Bingo`, and `start_hand` allows an
empty pool account, the same as poker. Keno stays on the dealer pool: a hit
count pays a multiple of that ticket, and the house covers the multiple.

Each seated card locks the same card price out of that seat’s table escrow
into one pot (`fund_player_game_escrow`). The showdown opens the called
balls. Every committed card is scored against that prefix. The seats whose
pattern completed on the earliest winning call split the pot. A 75-ball card
uses the table pattern. A 90-ball card uses the full-house term; one-line and
two-lines stay in the proof and do not pay a second pot. An odd chip goes to
the lower seat index. If nobody completed, each card price is returned.

The host applies those nets with `apply_casino_player_net` and returns the
escrow. It does not call `settle_casino_hand`, so the prize never moves
through a house balance. The room authority then `end_hand`.

## Dealer pool

Every kind except poker and bingo pays winners from a shared encrypted
bankroll on that table. Players still lock a buy-in into table escrow, then
stake a hand out of it. The counterparty is the pool, not another seat.

Accounts, all in `dealer_pool.rs`:

| Account | Seeds | What it holds |
|---------|-------|----------------|
| `DealerPool` | `dealer_pool`, room id, table id | Encrypted balance, plaintext share count, bet limits, reserved liability |
| `PoolStakeAccount` | `pool_stake`, pool, staker | That staker’s shares and encrypted accrual |
| `ProtocolTreasury` | `protocol_treasury`, room id | Plaintext commissions accrued and withdrawn |

`init_dealer_pool` requires the kind to match the table and refuses poker and bingo.
It stores `min_bet`, `max_bet`, and `bet_unit`. `init_protocol_treasury`
opens the room’s commission account. `init_pool_stake` opens one staker’s
share account.

`stake_dealer_pool` moves chips from the staker’s encrypted room wallet into
`balance_ciphertext` when the wallet covers the stake, and mints shares.
`redeem_dealer_pool` moves chips the other way. `total_shares` is the
plaintext count `start_hand` checks. The ciphertext is the balance the
settle circuit updates.

`start_hand` fails with `InsufficientDealerCoverage` when the pool account
is empty. When `max_bet` or `bet_unit` is set, `total_shares` must cover the
worst case for the seats in this hand (`room.rs`):

| Kind | Shares required |
|------|-----------------|
| Roulette | `max_bet × (35+17+17+11+8+8+5+2+2+1+1+1) × seats` |
| Blackjack | `bet_unit × 4 × 3 × seats` |
| War, baccarat, craps, keno, slots | `bet_unit × seats` |

A hand against the pool:

1. `fund_player_game_escrow` moves the hand stake from table escrow into
   `player_game_escrow`.
2. The shoe runs as in the circuit docs. A house seat, when the kind has
   one, is a shuffle participant that does not place this bet. Baccarat and
   war have no house seat; they still require the pool. Bingo does not use
   this path.
3. Light-casino verifies showdown. The public output is one field,
   `Σ (result_i + 1) · coefficient_i`. Baccarat, war, blackjack, keno, and
   slots use two terms, the result and a zero. Roulette uses twelve bet
   codes. Craps uses fourteen. Bingo 75 uses two terms; bingo 90 uses
   three. That field scores the dealer pool, or the card pot for bingo.
4. `settle_casino_hand` applies that outcome to the pool. It adds the pool’s
   gross win, then subtracts the player payout and the protocol commission.
   The new balance stays encrypted. The commission is revealed and added to
   `ProtocolTreasury`. The callback marks the hand settled and ends it. It
   does not advance a poker street.
5. `apply_casino_player_net` adds or subtracts that seat’s net on
   `player_game_escrow`.
6. `return_player_game_escrow` moves whatever remains back to table escrow.

Commission inputs are basis points on the settle instruction. The schedule
in `dealer_pool.rs` is:

| Game | Action collection | Pool-win edge | Banker commission |
|------|-------------------|---------------|-------------------|
| Baccarat | 100 bps | — | 500 bps on a pool win |
| Blackjack | 200 bps | 200 bps | — |
| War | 250 bps | 250 bps | — |
| Roulette | 250 bps | 250 bps | — |

`withdraw_protocol_commissions` transfers accrued commission out of the room
vault. It cannot withdraw more than `total_commissions − total_withdrawn`.

Stake, redeem, settle, fund, return, and `apply_casino_player_net` are
compiled into the casino program with the `testing` feature. Localnet builds
use that feature. `init_dealer_pool`, the treasury, and the `start_hand`
coverage check are in every build.

## House seat and dealer pool

These are different jobs.

`GameKind::needs_house_seat` is roulette, blackjack, craps, keno, and slots.
That seat registers a key, shuffles, and does not place an economic bet. The
circuit docs call this a table-layout concern because the encryption is the
same either way.

The dealer pool is the bankroll for every kind except poker and bingo.
Baccarat and war have no house seat and still cannot `start_hand` until the
pool exists and, when bet limits are set, `total_shares` covers the table
above. Keno is house-funded the same way. Bingo’s prize is the card pot.

## Timeouts

Both clocks are three minutes on the Clock sysvar (`180` seconds).

**Showdown.** When the hand is ready for a showdown proof, `showdown_opened_at`
is set. Share completion does that for every game except blackjack and bingo;
those call `open_showdown_window` once the actions or the called balls are
finished. The bettor submits the real Groth16 proof during the window. The
house build keeps that showdown circuit, and blackjack also keeps the dealer
action circuit, so the house can play the dealer hand and can still prove
showdown. Three minutes after the window opens, the house dealer may submit
that showdown proof and the hand completes, which frees the table when the
player quit without proving. Games with no house seat use the
`initialize_game` payer for `forfeit_showdown` instead. A forfeit does not
invent a proof: `showdown_forfeited` is set, the phase becomes complete, and
a later proof is rejected.

**Blackjack action.** `open_blackjack_action_window` starts a clock on a seat
that still has to hit, stand, or split. Each later player action proof resets
it. If that seat signs `stand_blackjack_seat`, they have left and the hand
treats them as stood. If they send no action for three minutes, the dealer
signs the same instruction and the seat stands. The dealer then finishes the
hand. The showdown timeout above still applies if nobody submits the proof.
