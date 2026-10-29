pub mod field_element;
pub mod share_penalty;
pub mod street_close;

pub use field_element::{FieldElement, field_element_from_low_high, field_element_from_u64, field_element_from_u128, field_element_zero};

pub fn basefield_from_hex(hex: &[u8]) -> FieldElement {
    let bytes = hex::decode(hex).unwrap();
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..(start + bytes.len())].copy_from_slice(&bytes);

    let mut low_bytes = [0u8; 16];
    let mut high_bytes = [0u8; 16];
    low_bytes.copy_from_slice(&padded[16..32]);
    high_bytes.copy_from_slice(&padded[0..16]);
    
    let low = u128::from_be_bytes(low_bytes);
    let high = u128::from_be_bytes(high_bytes);
    field_element_from_low_high(low, high)
}

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// 2^127. Forced top bit of every sealed showdown coefficient.
    const TWO_127: u128 = 170_141_183_460_469_231_731_687_303_715_884_105_728;

    /// Weighted seal slots. Must match `circuits/showdown_seal.circom`.
    /// The account still holds 14 ciphertext slots; slots past these two are not weighted.
    const SEAL_SLOTS: usize = 2;
    const SEAL_BITS: usize = 128;
    const SEAL_ROWS: usize = 4;

    include!("seal_weights.rs");
    include!("street_close_logic.rs");

    /// Reconstruct BaseField25519 from LE u128 limbs (bytes 0..16 / 16..32).
    fn field_from_u128_halves(low: u128, high: u128) -> BaseField25519 {
        let low_b = low.to_le_bytes();
        let high_b = high.to_le_bytes();
        let mut le = [0u8; 32];
        for i in 0..16 {
            le[i] = low_b[i];
            le[16 + i] = high_b[i];
        }
        // value = Σ le[i] * 256^i  (build MSB-first for Horner)
        let mut acc = BaseField25519::from_u128(0);
        let two_fifty_six = BaseField25519::from_u128(256);
        for i in 0..32 {
            let idx = 31 - i;
            acc = acc * two_fifty_six + BaseField25519::from_u128(le[idx] as u128);
        }
        acc
    }

    /// Each winner mask is a 10-bit seat mask and a subset of that pot's
    /// eligible mask. Bits 10 and above, and any seat absent from the pot,
    /// are rejected. The polynomial still folds `active_winner_mask`, so this
    /// check is what stops a stripped high bit from matching the Groth16 hash.
    fn winner_masks_accepted(masks: [u64; 9], pot_masks: [u16; 9]) -> bool {
        let mut ok = true;
        for i in 0..9 {
            let winner = masks[i];
            if winner >= 1024 {
                ok = false;
            }
            let pot = pot_masks[i] as u64;
            for bit in 0..10 {
                let winner_bit = (winner >> bit) % 2;
                let pot_bit = (pot >> bit) % 2;
                if winner_bit == 1 && pot_bit == 0 {
                    ok = false;
                }
            }
        }
        ok
    }

    /// Showdown term ranges. `result_count` is the number of blackjack hands
    /// in `results` (1..=4). Other games use a fixed layout and ignore it.
    /// Terms past the live prefix must be zero.
    ///
    /// - Baccarat / war: winner `0..=2`, then a zero pad
    /// - Blackjack: each hand `0..=3`
    /// - Keno: hit count `0..=20`, then a zero pad
    /// - Slots: award `0..=7500` (3-reel max 6000, 5-reel max 250×10×3), then a zero pad
    /// - Roulette: 12 payout codes `0..=35`
    /// - Craps: 12 bet codes `0..=901`, action `0..=5`, point in {0,4,5,6,8,9,10}
    /// - Bingo 75: one packed term, index `0` or `1..=75`
    /// - Bingo 90: three packed terms, index `0` or `1..=90`
    fn showdown_results_in_range(
        kind: u8,
        variant: u8,
        result_count: u8,
        results: [u64; 14],
    ) -> bool {
        let mut ok = true;
        if kind == 1 || kind == 3 {
            if results[0] > 2 {
                ok = false;
            }
            ok = zero_from(results, 1) && ok;
        } else if kind == 2 {
            if result_count == 0 || result_count > 4 {
                ok = false;
            }
            for i in 0..14 {
                if (i as u8) < result_count {
                    if results[i] > 3 {
                        ok = false;
                    }
                } else if results[i] != 0 {
                    ok = false;
                }
            }
        } else if kind == 4 {
            for i in 0..12 {
                if results[i] > 35 {
                    ok = false;
                }
            }
            ok = zero_from(results, 12) && ok;
        } else if kind == 5 {
            for i in 0..12 {
                if results[i] > 901 {
                    ok = false;
                }
            }
            if results[12] > 5 || !craps_point_ok(results[13]) {
                ok = false;
            }
        } else if kind == 6 {
            if results[0] > 20 {
                ok = false;
            }
            ok = zero_from(results, 1) && ok;
        } else if kind == 7 {
            if results[0] > 7500 {
                ok = false;
            }
            ok = zero_from(results, 1) && ok;
        } else if kind == 8 {
            let max_ball = if variant == 90 { 90u64 } else { 75u64 };
            let n_terms = if variant == 90 { 3usize } else { 1usize };
            for i in 0..14 {
                if i < n_terms {
                    if !bingo_term_ok(results[i], max_ball) {
                        ok = false;
                    }
                } else if results[i] != 0 {
                    ok = false;
                }
            }
        } else {
            ok = false;
        }
        ok
    }

    fn zero_from(results: [u64; 14], start: usize) -> bool {
        let mut ok = true;
        for i in 0..14 {
            if i >= start && results[i] != 0 {
                ok = false;
            }
        }
        ok
    }

    fn craps_point_ok(point: u64) -> bool {
        point == 0 || (point >= 4 && point <= 6) || (point >= 8 && point <= 10)
    }

    fn bingo_term_ok(packed: u64, max_ball: u64) -> bool {
        let mut ok = packed == 0;
        if packed >= 256 && packed < 512 {
            let index = packed - 256;
            ok = index >= 1 && index <= max_ball;
        }
        ok
    }

    /// Keep only bits `0..num_players` (Arcis has no integer `&`/`<<`).
    ///
    /// The polynomial uses this value. `winner_masks_accepted` rejects a mask
    /// whose stripped form would still match, so high bits cannot be paid.
    fn active_winner_mask(mask: u64, num_players: u8) -> u64 {
        let mut out = 0u64;
        let mut place = 1u64;
        for player in 0..10 {
            if player < num_players as usize {
                let bit = (mask >> player) % 2;
                out = out + bit * place;
            }
            place = place * 2;
        }
        out
    }

    /// Showdown poly-hash in BaseField25519 (not wrapping u128).
    ///
    /// Each active mask is 10 bits. `packed = Σ mask_i * 1024^i` is below 2^90.
    /// h = (packed + 1) * coeff0 + coeff1. The product is below 2^219, so
    /// BN254 (Groth16) and BaseField25519 agree without reduction.
    fn showdown_poly_hash_field(
        masks: [u64; 9],
        coeffs: [u128; 2],
        num_players: u8,
    ) -> BaseField25519 {
        let mut packed = BaseField25519::from_u128(0);
        let mut place = BaseField25519::from_u128(1);
        let base = BaseField25519::from_u128(1024);
        for i in 0..9 {
            let masked = active_winner_mask(masks[i], num_players);
            packed = packed + BaseField25519::from_u128(masked as u128) * place;
            place = place * base;
        }
        let one = BaseField25519::from_u128(1);
        (packed + one) * BaseField25519::from_u128(coeffs[0])
            + BaseField25519::from_u128(coeffs[1])
    }

    /// Open one 4-limb batch of a staged share.
    ///
    /// Share encrypts on the client and decrypts here. It does not hash the
    /// plaintext. The opened limbs are re-sealed to the cluster so the decrypt
    /// stays in the circuit, and the callback only sees a zero contribution
    /// plus the batch index.
    #[instruction]
    pub fn verify_deck_hash_chunk(
        key: ArcisX25519Pubkey,
        chunk_nonce: u128,
        start_index: u16,
        chunk: EncData<[BaseField25519; 4]>,
    ) -> (Enc<Mxe, [BaseField25519; 4]>, u128, u128, u16) {
        let opened = chunk.to_arcis_with_pubkey_and_nonce(key, chunk_nonce);
        (
            Mxe::get().from_arcis(opened),
            0u128.reveal(),
            0u128.reveal(),
            start_index.reveal(),
        )
    }

    /// Reveal sealed partials for one card from its staging chunk.
    ///
    /// Staging is Rescue-encrypted in 4-limb batches under
    /// `nonce = base + card_index * 36 + from_offset`. One MPC job decrypts
    /// that batch. A card row is still 36 limbs; the chain queues one job per
    /// 4-limb slice.
    ///
    /// Returns `(values[4], dest_offset, count)`. The first `count` entries are
    /// `to_le_bytes` of the opened limbs. Reversing them here is a general
    /// circuit; `to_le_bytes` is one builtin. The callback stores the
    /// big-endian commitment, which is what the street hash was computed on.
    ///
    /// Output is capped at 4 limbs so the on-chain callback stays under Arx's
    /// ~800k CU signature-verify budget.
    #[instruction]
    pub fn reveal_card(
        key: ArcisX25519Pubkey,
        chunk_nonce: u128,
        dest_offset: u8,
        count: u8,
        chunk: EncData<[BaseField25519; 4]>,
    ) -> ([[u8; 32]; 4], u8, u8) {
        let decrypted = chunk.to_arcis_with_pubkey_and_nonce(key, chunk_nonce);
        let n = count as usize;

        let mut values = [[0u8; 32]; 4];
        for j in 0..4 {
            if j < n {
                values[j] = decrypted[j].to_le_bytes();
            }
        }

        (values, dest_offset, count).reveal()
    }

    /// Poker reads two coefficients. Each slot is its own Rescue ciphertext,
    /// decrypted with `nonce + slot`. The nine winner masks are packed into the first.
    fn poker_sealed_coeffs(c0: u128, c1: u128) -> [u128; 2] {
        [c0, c1]
    }

    /// Groth16 `showdown_hash` over the sealed coefficients and winner masks.
    ///
    /// h = (packed + 1) * coeff0 + coeff1 in BaseField25519, where
    /// packed = Σ active_mask[i] * 1024^i and active_mask keeps bits
    /// `0..num_players`. A mask that is not a 10-bit subset of its pot fails.
    fn showdown_hash_matches(
        masks: [u64; 9],
        coeffs: [u128; 2],
        expected_hash_low: u128,
        expected_hash_high: u128,
        num_players: u8,
        pot_eligible_masks: [u16; 9],
    ) -> bool {
        winner_masks_accepted(masks, pot_eligible_masks)
            && showdown_poly_hash_field(masks, coeffs, num_players)
                == field_from_u128_halves(expected_hash_low, expected_hash_high)
    }

    /// Add each pot's share onto the encrypted seat balances.
    ///
    /// Odd chips go to the lowest seat index in that pot. Seats at or past
    /// `num_players` stay unchanged. The amounts stay inside MPC.
    fn credit_showdown_shares(
        starting: [u64; 10],
        masks: [u64; 9],
        num_players: u8,
        pot_amounts: [u64; 9],
    ) -> [u64; 10] {
        let mut balances = starting;
        for pot_idx in 0..9 {
            let mask = active_winner_mask(masks[pot_idx], num_players);
            let mut winner_count = 0u64;
            for player in 0..10 {
                if player < num_players as usize {
                    winner_count = winner_count + ((mask >> player) % 2);
                }
            }
            if winner_count > 0 {
                let share = pot_amounts[pot_idx] / winner_count;
                let remainder = pot_amounts[pot_idx] % winner_count;
                let mut winner_position = 0u64;
                for player in 0..10 {
                    if player < num_players as usize {
                        let won = (mask >> player) % 2;
                        let extra = if won == 1 && winner_position < remainder { 1u64 } else { 0u64 };
                        balances[player] = balances[player] + won * share + extra;
                        winner_position = winner_position + won;
                    }
                }
            }
        }
        balances
    }

    /// All-seat showdown settlement.
    ///
    /// After Groth16 latches `showdown_hash`, this one MPC job recomputes the
    /// sealed-coeff poly hash and, when it matches, adds every seat's share
    /// onto `settlement_ledger`. The ledger is encrypted. The only public
    /// output is `hash_matches`, so the callback can fail closed before it
    /// writes `EncryptedSettlementLedger`. A mismatch leaves the ledger unchanged.
    ///
    /// `distribute_and_settle` credits one escrow with the same share function.
    #[instruction]
    pub fn settle_all_seats(
        winner_masks: Enc<Shared, [u64; 9]>,
        coeff0: Enc<Shared, u128>,
        coeff1: Enc<Shared, u128>,
        expected_hash_low: u128,
        expected_hash_high: u128,
        num_players: u8,
        pot_eligible_masks: [u16; 9],
        pot_amounts: [u64; 9],
        settlement_ledger: Enc<Shared, [u64; 10]>,
    ) -> (Enc<Shared, [u64; 10]>, bool) {
        let masks = winner_masks.to_arcis();
        let coeffs = poker_sealed_coeffs(coeff0.to_arcis(), coeff1.to_arcis());
        let hash_matches = showdown_hash_matches(
            masks,
            coeffs,
            expected_hash_low,
            expected_hash_high,
            num_players,
            pot_eligible_masks,
        );
        let starting = settlement_ledger.to_arcis();
        let balances = if hash_matches {
            credit_showdown_shares(starting, masks, num_players, pot_amounts)
        } else {
            starting
        };
        (settlement_ledger.owner.from_arcis(balances), hash_matches.reveal())
    }

    /// Public subset-sum weight of bit `j` of seal slot `i` in row `k`
    /// (each below 2^242).
    fn seal_weight(k: usize, i: usize, j: usize, two_128: BaseField25519) -> BaseField25519 {
        let n = k * SEAL_SLOTS * SEAL_BITS + i * SEAL_BITS + j;
        BaseField25519::from_u128(SEAL_WEIGHTS_LO[n])
            + BaseField25519::from_u128(SEAL_WEIGHTS_HI[n]) * two_128
    }

    /// Weight of bit `bit` of `slot` in row `row`.
    /// Each arm uses a literal slot so that arm's table entry constant-folds.
    fn slot_weight(slot: u8, row: usize, bit: usize, two_128: BaseField25519) -> BaseField25519 {
        let mut w = BaseField25519::from_u128(0);
        if slot == 0u8 { w = seal_weight(row, 0, bit, two_128); }
        if slot == 1u8 { w = seal_weight(row, 1, bit, two_128); }
        w
    }

    /// Draw one coefficient and its four row contributions.
    /// Bit 127 is forced on. `slot` is the literal 0 or 1.
    fn draw_coefficient(
        slot: u8,
        zero: BaseField25519,
        two_128: BaseField25519,
    ) -> (u128, [BaseField25519; SEAL_ROWS]) {
        let mut c = TWO_127;
        let mut place = 1u128;
        let mut rows = [zero; SEAL_ROWS];
        for j in 0..SEAL_BITS - 1 {
            let bit = ArcisRNG::bool();
            c = c + if bit { place } else { 0u128 };
            for k in 0..SEAL_ROWS {
                let w = slot_weight(slot, k, j, two_128);
                rows[k] = rows[k] + if bit { w } else { zero };
            }
            place = place * 2;
        }
        for k in 0..SEAL_ROWS {
            rows[k] = rows[k] + slot_weight(slot, k, SEAL_BITS - 1, two_128);
        }
        (c, rows)
    }

    /// Seal both showdown coefficients and reveal their combined rows.
    ///
    /// Slot 0 is encrypted under `nonce` and slot 1 under `nonce + 1`. Both
    /// slots' weights accumulate into the same four rows, which this callback
    /// reveals. ArgBuilder:
    /// `.x25519_pubkey(pk).plaintext_u128(nonce).x25519_pubkey(pk).plaintext_u128(nonce + 1)`.
    #[instruction]
    pub fn seal_showdown_pair(
        player0: Shared,
        player1: Shared,
    ) -> (Enc<Shared, u128>, Enc<Shared, u128>, [[u8; 32]; 4]) {
        let zero = BaseField25519::from_u128(0);
        let two_128 = BaseField25519::from_u128(TWO_127) * BaseField25519::from_u128(2);
        let (c0, rows0) = draw_coefficient(0, zero, two_128);
        let (c1, rows1) = draw_coefficient(1, zero, two_128);
        let mut rows = [zero; SEAL_ROWS];
        for k in 0..SEAL_ROWS {
            rows[k] = rows0[k] + rows1[k];
        }
        let mut revealed = [[0u8; 32]; SEAL_ROWS];
        for k in 0..SEAL_ROWS {
            let le = rows[k].to_le_bytes();
            let mut be = [0u8; 32];
            for i in 0..32 {
                be[i] = le[31 - i];
            }
            revealed[k] = be;
        }
        (player0.from_arcis(c0), player1.from_arcis(c1), revealed.reveal())
    }

    /// Add an SPL deposit to the encrypted room wallet.
    ///
    /// The amount is the deposited chip count. Poker rake is computed on the
    /// hand, when a post-flop fold leaves one player or when showdown opens,
    /// and is credited later with that stored amount.
    #[instruction]
    pub fn credit_room_balance(
        balance: Enc<Shared, u64>,
        deposit_amount: u64,
    ) -> Enc<Shared, u64> {
        let b = balance.to_arcis();
        balance.owner.from_arcis(b + deposit_amount)
    }

    /// Lock buy-in from room wallet to table escrow.
    /// Only moves chips when room balance covers `buy_in`; otherwise leaves both unchanged
    /// (same pattern as `stake_dealer_pool` — never mint table escrow).
    /// Plaintext mirror + unit tests: `wallet::apply_lock_table_buyin`.
    #[instruction]
    pub fn lock_table_buyin(
        room_balance: Enc<Shared, u64>,
        table_balance: Enc<Shared, u64>,
        buy_in: u64,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>) {
        let mut rb = room_balance.to_arcis();
        let mut tb = table_balance.to_arcis();
        // Keep in sync with `programs/casino/src/wallet.rs::apply_lock_table_buyin`.
        if rb >= buy_in {
            rb -= buy_in;
            tb += buy_in;
        }
        (
            room_balance.owner.from_arcis(rb),
            table_balance.owner.from_arcis(tb),
        )
    }

    /// Unlock table escrow back to room wallet.
    #[instruction]
    pub fn unlock_table(
        room_balance: Enc<Shared, u64>,
        table_balance: Enc<Shared, u64>,
        in_hand: u8,
    ) -> Enc<Shared, u64> {
        let rb = room_balance.to_arcis();
        let tb = table_balance.to_arcis();
        let unlocked = if in_hand == 0 { tb } else { 0 };
        room_balance.owner.from_arcis(rb + unlocked)
    }

    /// Debit room wallet for SPL withdrawal.
    #[instruction]
    pub fn debit_for_withdraw(
        balance: Enc<Shared, u64>,
        locked_escrow_sum: u64,
        withdraw_amount: u64,
    ) -> (Enc<Shared, u64>, bool) {
        let b = balance.to_arcis();
        let available = if b >= locked_escrow_sum { b - locked_escrow_sum } else { 0u64 };
        let sufficient = available >= withdraw_amount;
        let new_balance = if sufficient {
            b - withdraw_amount
        } else {
            b
        };
        (
            balance.owner.from_arcis(new_balance),
            sufficient.reveal(),
        )
    }

    /// Validate bet with encrypted outputs sealed to table key.
    ///
    /// The last revealed bool is the street-close decision. A heads-up call that
    /// only matches the blind leaves the street open so the big blind can check
    /// or raise. The callback applies this flag and does not close the street
    /// on its own.
    #[instruction]
    pub fn validate_bet(
        player_balance: Enc<Shared, u64>,
        player_current_bet: Enc<Shared, u64>,
        action: Enc<Shared, u8>,
        action_amount: Enc<Shared, u64>,
        current_bet: Enc<Shared, u64>,
        last_aggressor_amount: Enc<Shared, u64>,
        expected_player_balance: u64,
        expected_player_current_bet: u64,
        expected_action: u8,
        expected_current_bet: u64,
        expected_last_aggressor_amount: u64,
        player_index: u8,
        num_players: u8,
        folded_mask: u16,
        all_in_mask: u16,
        acted_mask: u16,
        hand_commit_0: u64,
        hand_commit_1: u64,
        hand_commit_2: u64,
        hand_commit_3: u64,
        hand_commit_4: u64,
        hand_commit_5: u64,
        hand_commit_6: u64,
        hand_commit_7: u64,
        hand_commit_8: u64,
        hand_commit_9: u64,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>, Enc<Shared, u64>, bool, bool, bool, u64, bool) {
        let pb = player_balance.to_arcis();
        let pcb = player_current_bet.to_arcis();
        let act = action.to_arcis();
        let amt = action_amount.to_arcis();
        let cb = current_bet.to_arcis();
        let laa = last_aggressor_amount.to_arcis();
        let state_matches = pb == expected_player_balance
            && pcb == expected_player_current_bet
            && act == expected_action
            && cb == expected_current_bet
            && laa == expected_last_aggressor_amount;

        let mut new_balance = pb;
        let mut new_current_bet = pcb;
        let mut is_valid = state_matches;
        let mut is_fold = false;
        let mut is_all_in = false;
        let mut bet_delta = 0u64;

        if act == 0 {
            is_fold = state_matches;
        } else if act == 1 {
            is_valid = state_matches && amt == 0 && pcb == cb;
        } else if act == 2 {
            let call_amount = if cb >= pcb { cb - pcb } else { 0u64 };
            is_valid = state_matches && cb >= pcb && amt == call_amount && pb >= call_amount;
            if is_valid {
                new_balance = pb - call_amount;
                new_current_bet = cb;
                bet_delta = call_amount;
            }
        } else if act == 3 || act == 4 {
            let can_add = amt <= u64::MAX - pcb;
            let can_build_min = laa <= u64::MAX - cb;
            let total_bet = if can_add { pcb + amt } else { 0u64 };
            let min_total = if can_build_min { cb + laa } else { u64::MAX };
            is_valid = state_matches
                && amt > 0
                && can_add
                && can_build_min
                && total_bet > cb
                && total_bet >= min_total
                && pb >= amt;
            if is_valid {
                new_balance = pb - amt;
                new_current_bet = total_bet;
                bet_delta = amt;
            }
        } else if act == 5 {
            let can_add = pb <= u64::MAX - pcb;
            is_valid = state_matches && amt == pb && can_add;
            is_all_in = is_valid;
            if is_valid {
                new_balance = 0;
                new_current_bet = pcb + pb;
                bet_delta = pb;
            }
        } else {
            is_valid = false;
        }

        let hand_commits = [
            hand_commit_0,
            hand_commit_1,
            hand_commit_2,
            hand_commit_3,
            hand_commit_4,
            hand_commit_5,
            hand_commit_6,
            hand_commit_7,
            hand_commit_8,
            hand_commit_9,
        ];
        let street_closed = street_closes_after_action(
            num_players,
            player_index,
            act,
            bet_delta,
            is_fold,
            is_all_in,
            is_valid,
            cb,
            folded_mask,
            all_in_mask,
            acted_mask,
            hand_commits,
        );

        (
            player_balance.owner.from_arcis(new_balance),
            player_current_bet.owner.from_arcis(new_current_bet),
            action_amount.owner.from_arcis(bet_delta),
            is_valid.reveal(),
            is_fold.reveal(),
            is_all_in.reveal(),
            bet_delta.reveal(),
            street_closed.reveal(),
        )
    }

    /// Slash a bad share without revealing the pot.
    ///
    /// `player_bets` is the encrypted contribution for each of the 10 seats.
    /// `share_stakes` is passed through. The share stake is SOL and is settled
    /// in public by `settle_share_penalty`, so this circuit does not add it to
    /// the house. `cheater_mask` is public because a street-hash mismatch is
    /// public. A set bit moves that seat's bet onto `house_balance`. A clear
    /// bit refunds the bet. An empty mask, or a bit past `num_players`,
    /// changes nothing. Only `accepted` is revealed.
    ///
    /// Plaintext mirror and tests: `share_penalty::apply_share_unseal_penalty`.
    #[instruction]
    pub fn apply_share_unseal_penalty(
        player_bets: Enc<Shared, [u64; 10]>,
        share_stakes: Enc<Shared, [u64; 10]>,
        house_balance: Enc<Shared, u64>,
        cheater_mask: u16,
        num_players: u8,
    ) -> (
        Enc<Shared, [u64; 10]>,
        Enc<Shared, [u64; 10]>,
        Enc<Shared, u64>,
        bool,
    ) {
        let bets = player_bets.to_arcis();
        let stakes = share_stakes.to_arcis();
        let mut house = house_balance.to_arcis();
        let mask = cheater_mask as u64;
        let n = num_players as usize;

        let mut accepted = cheater_mask != 0 && num_players > 0 && num_players <= 10;
        for seat in 0..16 {
            let bit = (mask >> seat) % 2;
            if seat >= n && bit == 1 {
                accepted = false;
            }
        }

        let mut refunds = bets;
        let stake_out = stakes;
        if accepted {
            refunds = [0u64; 10];
            for seat in 0..10 {
                if seat < n {
                    let cheated = (mask >> seat) % 2;
                    if cheated == 1 {
                        house = house + bets[seat];
                    } else {
                        refunds[seat] = bets[seat];
                    }
                }
            }
        }

        (
            player_bets.owner.from_arcis(refunds),
            share_stakes.owner.from_arcis(stake_out),
            house_balance.owner.from_arcis(house),
            accepted.reveal(),
        )
    }

    /// Credit one escrow with that seat's share of `settle_all_seats`.
    ///
    /// Same hash check and the same share function. The payout amount stays
    /// inside this seat's ciphertext. The callback rejects when `hash_matches`
    /// is false.
    #[instruction]
    pub fn distribute_and_settle(
        winner_masks: Enc<Shared, [u64; 9]>,
        coeff0: Enc<Shared, u128>,
        coeff1: Enc<Shared, u128>,
        expected_hash_low: u128,
        expected_hash_high: u128,
        num_players: u8,
        pot_eligible_masks: [u16; 9],
        pot_amounts: [u64; 9],
        player_index: u8,
        player_balance: Enc<Shared, u64>,
    ) -> (Enc<Shared, u64>, bool) {
        let masks = winner_masks.to_arcis();
        let coeffs = poker_sealed_coeffs(coeff0.to_arcis(), coeff1.to_arcis());
        let hash_matches = showdown_hash_matches(
            masks,
            coeffs,
            expected_hash_low,
            expected_hash_high,
            num_players,
            pot_eligible_masks,
        );
        let shares = if hash_matches {
            credit_showdown_shares([0u64; 10], masks, num_players, pot_amounts)
        } else {
            [0u64; 10]
        };
        let mut payout = 0u64;
        for player in 0..10 {
            if player == player_index as usize && player < num_players as usize {
                payout = shares[player];
            }
        }
        let pb = player_balance.to_arcis();
        (
            player_balance.owner.from_arcis(pb + payout),
            hash_matches.reveal(),
        )
    }

    /// Settle a casino hand against the shared Dealer Pool (baccarat / war / blackjack).
    ///
    /// ZK verifies outcome. Fee rates are public basis points fixed at room
    /// setup. The hand's action and the pool's gross win are encrypted, and
    /// the protocol fee computed from them is only used to debit the pool.
    /// That amount is not an output.
    ///
    /// Inputs (encrypted):
    ///   - pool_balance: aggregate dealer pool bankroll
    ///   - total_action: sum of player-side wagers
    ///   - pool_gross_win: dealer pool gross win before fees (0 if pool lost)
    ///
    /// Inputs (public, from ZK outcome summary):
    ///   - player_payout: total paid to winning players (deducted from pool)
    ///
    /// Fee params (public, fixed per game):
    ///   - action_fee_bps: rake on total action
    ///   - pool_win_fee_bps: edge share on pool gross win (blackjack/war)
    ///   - banker_commission_bps: commission on pool win (baccarat banker side)
    ///
    /// Outputs:
    ///   - updated encrypted pool balance
    ///   - a zero word. The fee is not revealed.
    ///   - ranges_ok: showdown terms are inside that game's range. The pool
    ///     is left unchanged when this is false.
    ///
    /// `showdown_results` is the polynomial term vector (14 slots).
    /// `result_count` is the blackjack hand count; other games ignore it.
    #[instruction]
    pub fn settle_casino_hand(
        pool_balance: Enc<Shared, u64>,
        total_action: Enc<Shared, u64>,
        pool_gross_win: Enc<Shared, u64>,
        player_payout: u64,
        action_fee_bps: u16,
        pool_win_fee_bps: u16,
        banker_commission_bps: u16,
        game_kind: u8,
        variant: u8,
        result_count: u8,
        showdown_results: [u64; 14],
    ) -> (Enc<Shared, u64>, u64, bool) {
        let mut pb = pool_balance.to_arcis();
        let action = total_action.to_arcis();
        let gross_win = pool_gross_win.to_arcis();
        let ranges_ok =
            showdown_results_in_range(game_kind, variant, result_count, showdown_results);

        if ranges_ok {
            let action_fee = (action as u128 * action_fee_bps as u128 / 10_000) as u64;
            let pool_win_fee = (gross_win as u128 * pool_win_fee_bps as u128 / 10_000) as u64;
            let banker_fee =
                (gross_win as u128 * banker_commission_bps as u128 / 10_000) as u64;
            let protocol_commission = action_fee + pool_win_fee + banker_fee;

            pb = pb + gross_win;
            if pb >= player_payout + protocol_commission {
                pb = pb - player_payout - protocol_commission;
            } else {
                pb = 0;
            }
        }

        (
            pool_balance.owner.from_arcis(pb),
            0u64.reveal(),
            ranges_ok.reveal(),
        )
    }

    /// Stake into the shared Dealer Pool from a staker's encrypted room wallet.
    #[instruction]
    pub fn stake_dealer_pool(
        pool_balance: Enc<Shared, u64>,
        room_balance: Enc<Shared, u64>,
        stake_amount: u64,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>) {
        let mut pb = pool_balance.to_arcis();
        let mut rb = room_balance.to_arcis();
        if rb >= stake_amount {
            rb -= stake_amount;
            pb += stake_amount;
        }
        (
            pool_balance.owner.from_arcis(pb),
            room_balance.owner.from_arcis(rb),
        )
    }

    /// Redeem pro-rata stake from the Dealer Pool back to room wallet.
    #[instruction]
    pub fn redeem_dealer_pool(
        pool_balance: Enc<Shared, u64>,
        room_balance: Enc<Shared, u64>,
        redeem_amount: u64,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>) {
        let mut pb = pool_balance.to_arcis();
        let mut rb = room_balance.to_arcis();
        if pb >= redeem_amount {
            pb -= redeem_amount;
            rb += redeem_amount;
        }
        (
            pool_balance.owner.from_arcis(pb),
            room_balance.owner.from_arcis(rb),
        )
    }

    /// Apply a player's net chip delta to encrypted **game** escrow after ZK settlement.
    /// (Seat bankroll stays on table_escrow; hand stake lives on player_game_escrow.)
    #[instruction]
    pub fn apply_casino_player_net(
        game_escrow: Enc<Shared, u64>,
        player_net_abs: u64,
        player_won: bool,
        game_kind: u8,
        variant: u8,
        result_count: u8,
        showdown_results: [u64; 14],
    ) -> (Enc<Shared, u64>, bool) {
        let ranges_ok =
            showdown_results_in_range(game_kind, variant, result_count, showdown_results);
        let mut ge = game_escrow.to_arcis();
        if ranges_ok {
            if player_won {
                ge += player_net_abs;
            } else {
                ge = if ge >= player_net_abs {
                    ge - player_net_abs
                } else {
                    0u64
                };
            }
        }
        (game_escrow.owner.from_arcis(ge), ranges_ok.reveal())
    }

    /// Lock stake from seat bankroll (`table_escrow`) into hand stake (`player_game_escrow`).
    #[instruction]
    pub fn fund_player_game_escrow(
        table_balance: Enc<Shared, u64>,
        game_balance: Enc<Shared, u64>,
        stake: u64,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>) {
        let mut tb = table_balance.to_arcis();
        let mut gb = game_balance.to_arcis();
        if tb >= stake {
            tb -= stake;
            gb += stake;
        }
        (
            table_balance.owner.from_arcis(tb),
            game_balance.owner.from_arcis(gb),
        )
    }

    /// Return remaining hand stake from `player_game_escrow` back to `table_escrow`.
    #[instruction]
    pub fn return_player_game_escrow(
        table_balance: Enc<Shared, u64>,
        game_balance: Enc<Shared, u64>,
    ) -> (Enc<Shared, u64>, Enc<Shared, u64>) {
        let mut tb = table_balance.to_arcis();
        let gb = game_balance.to_arcis();
        tb += gb;
        (
            table_balance.owner.from_arcis(tb),
            game_balance.owner.from_arcis(0u64),
        )
    }
}
