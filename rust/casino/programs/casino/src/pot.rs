/// Deterministic side-pot recomputation for poker betting state.
///
/// Inputs are the total committed bet per player and the folded-player mask.
/// Output pots are ordered from main pot to side pots. Each eligible mask excludes
/// folded players but includes all-in players that contributed to that pot level.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CanonicalPots {
    pub amounts: [u64; 9],
    pub eligible_masks: [u16; 9],
    pub refunds: [u64; 10],
    pub pot_count: u8,
    pub total_contributions: u64,
    pub total_pots: u64,
    pub total_refunds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PotError {
    ArithmeticOverflow,
    EmptyEligibility,
    TooManyContestedPots,
}

pub fn recompute_pots(
    player_total_bets: &[u64; 10],
    folded_mask: u16,
    num_players: u8,
) -> core::result::Result<CanonicalPots, PotError> {
    let n = core::cmp::min(num_players as usize, 10);
    let mut canonical = CanonicalPots::default();
    let mut levels = [0u64; 10];
    let mut level_count = 0usize;

    for i in 0..n {
        let amount = player_total_bets[i];
        canonical.total_contributions = canonical
            .total_contributions
            .checked_add(amount)
            .ok_or(PotError::ArithmeticOverflow)?;
        if amount == 0 {
            continue;
        }
        let mut seen = false;
        for j in 0..level_count {
            if levels[j] == amount {
                seen = true;
                break;
            }
        }
        if !seen {
            levels[level_count] = amount;
            level_count += 1;
        }
    }

    for i in 1..level_count {
        let mut j = i;
        while j > 0 && levels[j - 1] > levels[j] {
            levels.swap(j - 1, j);
            j -= 1;
        }
    }

    let mut previous = 0u64;

    for level in levels.iter().take(level_count).copied() {
        if level <= previous {
            continue;
        }

        let mut contributors = 0u64;
        let mut eligible = 0u16;
        let mut sole_contributor = None;
        for player in 0..n {
            if player_total_bets[player] >= level {
                contributors = contributors
                    .checked_add(1)
                    .ok_or(PotError::ArithmeticOverflow)?;
                sole_contributor = Some(player);
                if (folded_mask & (1u16 << player)) == 0 {
                    eligible |= 1u16 << player;
                }
            }
        }

        let increment = level - previous;
        if contributors == 1 {
            let player = sole_contributor.expect("one contributor must have an index");
            canonical.refunds[player] = canonical.refunds[player]
                .checked_add(increment)
                .ok_or(PotError::ArithmeticOverflow)?;
            canonical.total_refunds = canonical
                .total_refunds
                .checked_add(increment)
                .ok_or(PotError::ArithmeticOverflow)?;
        } else if contributors > 1 {
            if eligible == 0 {
                return Err(PotError::EmptyEligibility);
            }
            let amount = increment
                .checked_mul(contributors)
                .ok_or(PotError::ArithmeticOverflow)?;
            let pot_index = canonical.pot_count as usize;
            if pot_index >= canonical.amounts.len() {
                return Err(PotError::TooManyContestedPots);
            }
            canonical.amounts[pot_index] = amount;
            canonical.eligible_masks[pot_index] = eligible;
            canonical.pot_count += 1;
            canonical.total_pots = canonical
                .total_pots
                .checked_add(amount)
                .ok_or(PotError::ArithmeticOverflow)?;
        }
        previous = level;
    }

    let conserved = canonical
        .total_pots
        .checked_add(canonical.total_refunds)
        .ok_or(PotError::ArithmeticOverflow)?;
    if conserved != canonical.total_contributions {
        return Err(PotError::ArithmeticOverflow);
    }

    Ok(canonical)
}

/// Apply a bet delta for `player_index`, then recompute side pots.
pub fn apply_bet_and_recompute_pots(
    player_total_bets: &mut [u64; 10],
    folded_mask: u16,
    all_in_mask: u16, // unused for pot math but kept for API clarity; pots use folded_mask only
    num_players: u8,
    player_index: usize,
    bet_delta: u64,
) -> core::result::Result<CanonicalPots, PotError> {
    let _ = all_in_mask;
    if player_index < 10 {
        player_total_bets[player_index] =
            player_total_bets[player_index]
                .checked_add(bet_delta)
                .ok_or(PotError::ArithmeticOverflow)?;
    }
    recompute_pots(player_total_bets, folded_mask, num_players)
}

/// Distribute pots from player-index bitmasks, splitting ties evenly.
pub fn distribute_pots_to_payouts(
    winner_masks: &[u64; 9],
    pot_amounts: &[u64; 9],
    num_players: u8,
) -> [u64; 10] {
    let mut payouts = [0u64; 10];
    for i in 0..9 {
        let mask = active_winner_mask(winner_masks[i], num_players);
        let winner_count = mask.count_ones() as u64;
        if winner_count == 0 {
            continue;
        }
        let share = pot_amounts[i] / winner_count;
        let mut remainder = pot_amounts[i] % winner_count;
        for player in 0..num_players as usize {
            if mask & (1u64 << player) == 0 {
                continue;
            }
            let extra = u64::from(remainder > 0);
            remainder = remainder.saturating_sub(extra);
            payouts[player] = payouts[player].saturating_add(share.saturating_add(extra));
        }
    }
    payouts
}

pub const POKER_RAKE_BPS_DENOM: u128 = 10_000;

/// Arcis `credit_poker_rake` uses this formula.
///
/// Rake is `floor(pot_total * rake_bps / 10_000)` after the flop. A room rate
/// of 0, or a hand that never reaches the flop, takes nothing.
pub fn poker_rake_lamports(pot_total: u64, rake_bps: u16, reached_flop: bool) -> u64 {
    if !reached_flop || rake_bps == 0 || pot_total == 0 {
        return 0;
    }
    ((pot_total as u128) * (rake_bps as u128) / POKER_RAKE_BPS_DENOM) as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RakedPots {
    pub amounts: [u64; 9],
    pub rake: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HouseRakeError {
    /// The house has not initialized an encrypted room wallet and an SPL token account.
    HouseWalletMissing,
}

/// Take rake from contested pots, main pot first. Uncalled refunds are not raked.
pub fn apply_poker_rake(
    amounts: &[u64; 9],
    rake_bps: u16,
    reached_flop: bool,
) -> core::result::Result<RakedPots, PotError> {
    let mut total = 0u64;
    for amount in amounts {
        total = total.checked_add(*amount).ok_or(PotError::ArithmeticOverflow)?;
    }
    let rake = poker_rake_lamports(total, rake_bps, reached_flop);
    let mut net = *amounts;
    let mut left = rake;
    for pot in &mut net {
        let take = (*pot).min(left);
        *pot -= take;
        left -= take;
    }
    if left != 0 {
        return Err(PotError::ArithmeticOverflow);
    }
    Ok(RakedPots { amounts: net, rake })
}

/// A positive rake can be credited only when the house already opened both
/// their encrypted room wallet and the SPL token account for the room mint.
pub fn require_house_rake_wallet(
    rake: u64,
    encrypted_wallet_ready: bool,
    spl_token_account_ready: bool,
) -> core::result::Result<(), HouseRakeError> {
    if rake == 0 || (encrypted_wallet_ready && spl_token_account_ready) {
        Ok(())
    } else {
        Err(HouseRakeError::HouseWalletMissing)
    }
}

/// Plaintext mirror of Arcis `distribute_and_settle` per-player payout share.
///
/// When `hash_matches` is false, returns 0 (balance unchanged in the circuit).
/// Otherwise returns this player's deterministic share of each winner bitmask.
pub fn player_payout_from_pots(
    winner_masks: &[u64; 9],
    pot_amounts: &[u64; 9],
    num_players: u8,
    player_index: u8,
    hash_matches: bool,
) -> u64 {
    if !hash_matches || player_index >= num_players {
        return 0;
    }
    let mut payout = 0u64;
    for i in 0..9 {
        let mask = active_winner_mask(winner_masks[i], num_players);
        if mask & (1u64 << player_index) == 0 {
            continue;
        }
        let winner_count = mask.count_ones() as u64;
        if winner_count == 0 {
            continue;
        }
        let share = pot_amounts[i] / winner_count;
        let remainder = pot_amounts[i] % winner_count;
        let winners_before = (mask & ((1u64 << player_index) - 1)).count_ones() as u64;
        let extra = u64::from(winners_before < remainder);
        payout = payout.saturating_add(share.saturating_add(extra));
    }
    payout
}

/// Widening multiply for the packed showdown term (packed+1 < 2^91, coeff < 2^128 → < 2^219).
fn widening_mul_u128(a: u128, b: u128) -> (u128, u128) {
    let a0 = a & 0xffff_ffff_ffff_ffff;
    let a1 = a >> 64;
    let b0 = b & 0xffff_ffff_ffff_ffff;
    let b1 = b >> 64;
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & 0xffff_ffff_ffff_ffff) + (p10 & 0xffff_ffff_ffff_ffff);
    let low = (p00 & 0xffff_ffff_ffff_ffff) | (mid << 64);
    let high = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (low, high)
}

/// Bits `0..num_players` of a winner bitmask (same as Arcis `active_winner_mask`).
pub fn active_winner_mask(mask: u64, num_players: u8) -> u64 {
    if num_players == 0 {
        0
    } else if num_players >= 64 {
        mask
    } else {
        mask & ((1u64 << num_players) - 1)
    }
}

/// `mask0 + mask1 * 1024 + ... + mask8 * 1024^8`. Each active mask is 10 bits.
fn pack_poker_winner_masks(winner_masks: &[u64; 9], num_players: u8) -> u128 {
    let mut packed = 0u128;
    let mut place = 1u128;
    for i in 0..9 {
        let masked = active_winner_mask(winner_masks[i], num_players) as u128;
        debug_assert!(masked < 1024);
        packed += masked * place;
        if i + 1 < 9 {
            place *= 1024;
        }
    }
    packed
}

/// Showdown polynomial hash as LE u128 halves (matches Arcis BaseField25519 fold).
///
/// h = (packed + 1) * coeff[0] + coeff[1], where packed places each active
/// mask at 1024^i. Active masks keep bits `0..num_players`. The product is
/// below 2^219, so BN254 (Groth16) and BaseField25519 agree without reduction.
///
/// Coefficients come from the Arcis pair seal — never HASH_COEFFS_900.
pub fn showdown_poly_hash_halves(
    winner_masks: &[u64; 9],
    coefficients: &[u128],
    num_players: u8,
) -> (u128, u128) {
    assert!(
        coefficients.len() >= 2,
        "poker showdown uses 2 sealed coefficients"
    );
    let packed = pack_poker_winner_masks(winner_masks, num_players);
    let (p_low, p_high) = widening_mul_u128(packed + 1, coefficients[0]);
    let (sum_low, carry) = p_low.overflowing_add(coefficients[1]);
    (sum_low, p_high + u128::from(carry))
}

/// Low limb only — for small-coeff unit tests where high == 0.
pub fn showdown_poly_hash(
    winner_masks: &[u64; 9],
    coefficients: &[u128],
    num_players: u8,
) -> u128 {
    let (low, high) = showdown_poly_hash_halves(winner_masks, coefficients, num_players);
    debug_assert_eq!(high, 0, "showdown hash high limb non-zero; use showdown_poly_hash_halves");
    low
}

/// Verify Rescue-submitted showdown masks against the Groth16 output hash using
/// the sealed coefficients (plaintext mirror of Arcis BaseField25519 verification).
pub fn verify_showdown_hash_with_sealed_coeffs(
    winner_masks: &[u64; 9],
    coefficients: &[u128],
    expected_low: u128,
    expected_high: u128,
    num_players: u8,
) -> bool {
    showdown_poly_hash_halves(winner_masks, coefficients, num_players)
        == (expected_low, expected_high)
}

/// 10-bit winner masks, each a subset of that pot's eligible mask.
///
/// Same rule as Arcis `winner_masks_accepted`. A bit at or above 10, or a
/// seat missing from the pot, is rejected even when stripping that bit would
/// leave the polynomial unchanged.
pub fn winner_masks_accepted(winner_masks: &[u64; 9], pot_eligible_masks: &[u16; 9]) -> bool {
    winner_masks.iter().zip(pot_eligible_masks.iter()).all(|(winner, pot)| {
        *winner < 1024 && (*winner as u16) & !pot == 0
    })
}

/// Plaintext mirror of fused Arcis `compute_pots`: verify poly hash, then pay.
///
/// On mismatch returns zero payouts and `false` (callback must reject).
pub fn fused_verify_and_distribute_pots(
    winner_masks: &[u64; 9],
    coefficients: &[u128],
    expected_low: u128,
    expected_high: u128,
    pot_amounts: &[u64; 9],
    num_players: u8,
    pot_eligible_masks: &[u16; 9],
) -> ([u64; 10], bool) {
    let hash_matches = winner_masks_accepted(winner_masks, pot_eligible_masks)
        && verify_showdown_hash_with_sealed_coeffs(
            winner_masks,
            coefficients,
            expected_low,
            expected_high,
            num_players,
        );
    if !hash_matches {
        return ([0u64; 10], false);
    }
    (
        distribute_pots_to_payouts(winner_masks, pot_amounts, num_players),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arcis_five_percent_flop_rake_credits_the_house_wallet() {
        let mut pots = [0u64; 9];
        pots[0] = 200;
        let preflop = apply_poker_rake(&pots, 500, false).unwrap();
        assert_eq!(preflop.rake, 0);
        assert_eq!(preflop.amounts[0], 200);
        assert!(require_house_rake_wallet(preflop.rake, false, false).is_ok());

        let no_rate = apply_poker_rake(&pots, 0, true).unwrap();
        assert_eq!(no_rate.rake, 0);

        let raked = apply_poker_rake(&pots, 500, true).unwrap();
        assert_eq!(poker_rake_lamports(200, 500, true), 10);
        assert_eq!(raked.rake, 10);
        assert_eq!(raked.amounts[0], 190);
        assert_eq!(
            require_house_rake_wallet(raked.rake, false, true),
            Err(HouseRakeError::HouseWalletMissing)
        );
        assert_eq!(
            require_house_rake_wallet(raked.rake, true, false),
            Err(HouseRakeError::HouseWalletMissing)
        );
        require_house_rake_wallet(raked.rake, true, true).unwrap();

        let mut side = [0u64; 9];
        side[0] = 200;
        side[1] = 100;
        let sided = apply_poker_rake(&side, 500, true).unwrap();
        assert_eq!(sided.rake, 15);
        assert_eq!(sided.amounts[0], 185);
        assert_eq!(sided.amounts[1], 100);
    }

    #[test]
    fn heads_up_no_side_pot() {
        let mut bets = [0u64; 10];
        bets[0] = 100;
        bets[1] = 100;
        let canonical = recompute_pots(&bets, 0, 2).unwrap();
        assert_eq!(canonical.pot_count, 1);
        assert_eq!(canonical.amounts[0], 200);
        assert_eq!(canonical.eligible_masks[0], 0b11);
    }

    #[test]
    fn canonical_pots_refunds_unmatched_overbet_and_conserves_value() {
        let mut bets = [0u64; 10];
        bets[0] = 100;
        bets[1] = 300;
        bets[2] = 500;

        let canonical = recompute_pots(&bets, 0, 3).unwrap();
        assert_eq!(canonical.amounts[..2], [300, 400]);
        assert_eq!(canonical.eligible_masks[..2], [0b111, 0b110]);
        assert_eq!(canonical.refunds[2], 200);
        assert_eq!(canonical.pot_count, 2);
        assert_eq!(canonical.total_contributions, 900);
        assert_eq!(canonical.total_pots, 700);
        assert_eq!(canonical.total_refunds, 200);
        assert_eq!(
            canonical.total_contributions,
            canonical.total_pots + canonical.total_refunds
        );
    }

    #[test]
    fn canonical_pots_reject_overflow() {
        let mut bets = [0u64; 10];
        bets[0] = u64::MAX;
        bets[1] = u64::MAX;
        assert!(recompute_pots(&bets, 0, 2).is_err());
    }

    #[test]
    fn excludes_folded_player_from_eligibility_but_keeps_chips() {
        let mut bets = [0u64; 10];
        bets[0] = 100;
        bets[1] = 100;
        bets[2] = 100;
        let canonical = recompute_pots(&bets, 1 << 1, 3).unwrap();
        assert_eq!(canonical.pot_count, 1);
        assert_eq!(canonical.amounts[0], 300);
        assert_eq!(canonical.eligible_masks[0], 0b101);
    }

    #[test]
    fn one_short_all_in_creates_side_pot() {
        let mut bets = [0u64; 10];
        bets[0] = 100;
        bets[1] = 300;
        bets[2] = 300;
        let canonical = recompute_pots(&bets, 0, 3).unwrap();
        assert_eq!(canonical.pot_count, 2);
        assert_eq!(canonical.amounts[0], 300);
        assert_eq!(canonical.eligible_masks[0], 0b111);
        assert_eq!(canonical.amounts[1], 400);
        assert_eq!(canonical.eligible_masks[1], 0b110);
    }

    #[test]
    fn multiway_side_pots() {
        let mut bets = [0u64; 10];
        bets[0] = 50;
        bets[1] = 100;
        bets[2] = 250;
        bets[3] = 250;
        let canonical = recompute_pots(&bets, 0, 4).unwrap();
        assert_eq!(canonical.pot_count, 3);
        assert_eq!(canonical.amounts[0], 200);
        assert_eq!(canonical.eligible_masks[0], 0b1111);
        assert_eq!(canonical.amounts[1], 150);
        assert_eq!(canonical.eligible_masks[1], 0b1110);
        assert_eq!(canonical.amounts[2], 300);
        assert_eq!(canonical.eligible_masks[2], 0b1100);
    }

    #[test]
    fn zero_value_levels_are_omitted() {
        let mut bets = [0u64; 10];
        bets[0] = 0;
        bets[1] = 100;
        bets[2] = 100;

        let canonical = recompute_pots(&bets, 0, 3).unwrap();
        assert_eq!(canonical.pot_count, 1);
        assert_eq!(canonical.amounts[0], 200);
        assert_eq!(canonical.amounts[1], 0);
        assert_eq!(canonical.eligible_masks[0], 0b110);
    }

    #[test]
    fn apply_bet_creates_side_pot_on_short_all_in() {
        // Start with short stack all-in at 100; others at 100.
        let mut bets = [0u64; 10];
        bets[0] = 100;
        bets[1] = 100;
        bets[2] = 100;
        // Player 1 adds 200 more (to 300); player 2 matches to 300 via second call.
        let canonical =
            apply_bet_and_recompute_pots(&mut bets, 0, 1 << 0, 3, 1, 200).unwrap();
        assert_eq!(bets[1], 300);
        assert_eq!(canonical.pot_count, 1);
        assert_eq!(canonical.amounts[0], 300); // 100 * 3
        assert_eq!(canonical.eligible_masks[0], 0b111);
        assert_eq!(canonical.refunds[1], 200); // unmatched until player 2 calls
        // After player 2 also matches:
        let canonical =
            apply_bet_and_recompute_pots(&mut bets, 0, 1 << 0, 3, 2, 200).unwrap();
        assert_eq!(bets[2], 300);
        assert_eq!(canonical.pot_count, 2);
        assert_eq!(canonical.amounts[0], 300);
        assert_eq!(canonical.eligible_masks[0], 0b111);
        assert_eq!(canonical.amounts[1], 400); // 200 * 2
        assert_eq!(canonical.eligible_masks[1], 0b110);
    }

    #[test]
    fn distribute_routes_main_and_side_pots_from_bitmasks() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 1 << 0;
        pot_amounts[0] = 300;
        winner_masks[1] = 1 << 1;
        pot_amounts[1] = 400;
        let payouts = distribute_pots_to_payouts(&winner_masks, &pot_amounts, 3);
        assert_eq!(payouts[0], 300);
        assert_eq!(payouts[1], 400);
        assert_eq!(payouts[2], 0);
    }

    #[test]
    fn distribute_splits_tied_pot_and_preserves_remainder() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = (1 << 0) | (1 << 2);
        pot_amounts[0] = 101;
        let payouts = distribute_pots_to_payouts(&winner_masks, &pot_amounts, 3);
        assert_eq!(payouts[0], 51);
        assert_eq!(payouts[1], 0);
        assert_eq!(payouts[2], 50);
        assert_eq!(payouts.iter().sum::<u64>(), 101);
    }

    #[test]
    fn distribute_zero_pots_stays_zero() {
        let winner_masks = [0u64; 9];
        let pot_amounts = [0u64; 9];
        let payouts = distribute_pots_to_payouts(&winner_masks, &pot_amounts, 3);
        assert_eq!(payouts, [0u64; 10]);
    }

    #[test]
    fn distribute_ignores_bits_outside_active_players() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 1 << 5;
        pot_amounts[0] = 1000;
        winner_masks[1] = 1 << 1;
        pot_amounts[1] = 250;
        let payouts = distribute_pots_to_payouts(&winner_masks, &pot_amounts, 3);
        assert_eq!(payouts[0], 0);
        assert_eq!(payouts[1], 250);
        assert_eq!(payouts[5], 0);
    }

    #[test]
    fn player_payout_hash_mismatch_is_zero() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 0;
        pot_amounts[0] = 500;
        assert_eq!(
            player_payout_from_pots(&winner_masks, &pot_amounts, 2, 0, false),
            0
        );
    }

    #[test]
    fn player_payout_player0_wins_pot0_only() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 1 << 0;
        pot_amounts[0] = 300;
        winner_masks[1] = 1 << 1;
        pot_amounts[1] = 400;
        assert_eq!(
            player_payout_from_pots(&winner_masks, &pot_amounts, 3, 0, true),
            300
        );
    }

    #[test]
    fn player_payout_player1_wins_side_pot() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 1 << 0;
        pot_amounts[0] = 300;
        winner_masks[1] = 1 << 1;
        pot_amounts[1] = 400;
        assert_eq!(
            player_payout_from_pots(&winner_masks, &pot_amounts, 3, 1, true),
            400
        );
    }

    #[test]
    fn player_payout_splits_tie_by_player_index() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = (1 << 0) | (1 << 2);
        pot_amounts[0] = 101;
        assert_eq!(player_payout_from_pots(&winner_masks, &pot_amounts, 3, 0, true), 51);
        assert_eq!(player_payout_from_pots(&winner_masks, &pot_amounts, 3, 2, true), 50);
    }

    #[test]
    fn player_payout_non_winner_is_zero() {
        let mut winner_masks = [0u64; 9];
        let mut pot_amounts = [0u64; 9];
        winner_masks[0] = 0;
        pot_amounts[0] = 300;
        winner_masks[1] = 1;
        pot_amounts[1] = 400;
        assert_eq!(
            player_payout_from_pots(&winner_masks, &pot_amounts, 3, 2, true),
            0
        );
    }

    #[test]
    fn showdown_poly_hash_uses_sealed_coeffs_not_fixed_table() {
        let mut masks = [0u64; 9];
        masks[0] = 1; // player 1 wins pot 0
        let mut coeffs_a = [0u128; 9];
        let mut coeffs_b = [0u128; 9];
        for i in 0..9 {
            coeffs_a[i] = (i as u128 + 1) * 1000;
            coeffs_b[i] = (i as u128 + 1) * 2000;
        }
        let ha = showdown_poly_hash_halves(&masks, &coeffs_a, 2);
        let hb = showdown_poly_hash_halves(&masks, &coeffs_b, 2);
        assert_ne!(ha, hb);
        assert!(verify_showdown_hash_with_sealed_coeffs(
            &masks, &coeffs_a, ha.0, ha.1, 2
        ));
        assert!(!verify_showdown_hash_with_sealed_coeffs(
            &masks, &coeffs_a, hb.0, hb.1, 2
        ));
    }

    #[test]
    fn showdown_poly_hash_adds_one_to_each_mask() {
        let masks = [0u64; 9];
        let mut coeffs = [0u128; 9];
        coeffs[0] = 7;
        // (0+1)*7 = 7
        assert_eq!(showdown_poly_hash(&masks, &coeffs, 2), 7);
    }

    #[test]
    fn showdown_poly_hash_ignores_bits_above_num_players() {
        let mut low_only = [0u64; 9];
        low_only[0] = 0b01; // player 0
        let mut with_high = low_only;
        with_high[0] |= 1u64 << 40; // junk above num_players
        with_high[1] = !0u64 << 2; // unused pot: only bits >= num_players
        let mut coeffs = [0u128; 9];
        for i in 0..9 {
            coeffs[i] = (i as u128 + 1) * 17;
        }
        let num_players = 2u8;
        assert_eq!(
            showdown_poly_hash_halves(&low_only, &coeffs, num_players),
            showdown_poly_hash_halves(&with_high, &coeffs, num_players)
        );
        // Changing an active low bit must still change the hash.
        let mut different_low = low_only;
        different_low[0] = 0b10;
        assert_ne!(
            showdown_poly_hash_halves(&low_only, &coeffs, num_players),
            showdown_poly_hash_halves(&different_low, &coeffs, num_players)
        );
    }

    #[test]
    fn showdown_poly_hash_does_not_wrap_at_u128() {
        // Nine masks of 1 pack below 2^90. Times a 2^127 coefficient this exceeds 2^128.
        let mut masks = [0u64; 9];
        let mut coeffs = [0u128; 2];
        for i in 0..9 {
            masks[i] = 1;
        }
        coeffs[0] = 1u128 << 127;
        coeffs[1] = 1u128 << 127;
        let (low, high) = showdown_poly_hash_halves(&masks, &coeffs, 2);
        assert_ne!(high, 0);
        assert!(verify_showdown_hash_with_sealed_coeffs(
            &masks, &coeffs, low, high, 2
        ));
    }

    #[test]
    fn fused_verify_and_distribute_pays_on_matching_hash() {
        let mut masks = [0u64; 9];
        masks[0] = 0b01; // player 0
        let mut coeffs = [0u128; 9];
        for i in 0..9 {
            coeffs[i] = (i as u128 + 1) * 11;
        }
        let (elo, ehi) = showdown_poly_hash_halves(&masks, &coeffs, 2);
        let mut pots = [0u64; 9];
        pots[0] = 100;
        let (payouts, ok) =
            fused_verify_and_distribute_pots(&masks, &coeffs, elo, ehi, &pots, 2, &open_pots(2));
        assert!(ok);
        assert_eq!(payouts[0], 100);
        assert_eq!(payouts[1], 0);
    }

    #[test]
    fn fused_verify_and_distribute_rejects_wrong_masks() {
        let mut honest_masks = [0u64; 9];
        honest_masks[0] = 0b01;
        let mut attacker_masks = [0u64; 9];
        attacker_masks[0] = 0b10; // claim player 1
        let mut coeffs = [0u128; 9];
        for i in 0..9 {
            coeffs[i] = (i as u128 + 1) * 13;
        }
        let (elo, ehi) = showdown_poly_hash_halves(&honest_masks, &coeffs, 2);
        let mut pots = [0u64; 9];
        pots[0] = 500;
        let (payouts, ok) =
            fused_verify_and_distribute_pots(&attacker_masks, &coeffs, elo, ehi, &pots, 2, &open_pots(2));
        assert!(!ok);
        assert_eq!(payouts, [0u64; 10]);
        assert_eq!(
            player_payout_from_pots(&attacker_masks, &pots, 2, 1, false),
            0
        );
    }

    #[test]
    fn fused_verify_and_distribute_splits_tie_bitmask() {
        let mut masks = [0u64; 9];
        masks[0] = 0b11; // seats 0 and 1 split
        let coeffs = [1u128; 9];
        let (elo, ehi) = showdown_poly_hash_halves(&masks, &coeffs, 2);
        let mut pots = [0u64; 9];
        pots[0] = 101;
        let (payouts, ok) =
            fused_verify_and_distribute_pots(&masks, &coeffs, elo, ehi, &pots, 2, &open_pots(2));
        assert!(ok);
        assert_eq!(payouts[0] + payouts[1], 101);
        assert_eq!(payouts[0], 51);
        assert_eq!(payouts[1], 50);
    }

    #[test]
    fn fused_verify_rejects_bits_above_10() {
        let mut honest = [0u64; 9];
        honest[0] = 0b01;
        let mut noisy = honest;
        noisy[0] |= 1u64 << 33;
        let coeffs = [3u128; 9];
        let (elo, ehi) = showdown_poly_hash_halves(&honest, &coeffs, 2);
        let mut pots = [0u64; 9];
        pots[0] = 100;
        let (payouts, ok) =
            fused_verify_and_distribute_pots(&noisy, &coeffs, elo, ehi, &pots, 2, &open_pots(2));
        assert!(!ok);
        assert_eq!(payouts, [0u64; 10]);
    }

    fn fused_verify_rejects_winner_outside_pot() {
        let mut masks = [0u64; 9];
        masks[0] = 0b11;
        let coeffs = [3u128; 9];
        let (elo, ehi) = showdown_poly_hash_halves(&masks, &coeffs, 2);
        let mut pots = [0u64; 9];
        pots[0] = 100;
        let mut eligible = open_pots(2);
        eligible[0] = 0b01;
        let (payouts, ok) =
            fused_verify_and_distribute_pots(&masks, &coeffs, elo, ehi, &pots, 2, &eligible);
        assert!(!ok);
        assert_eq!(payouts, [0u64; 10]);
    }

    fn open_pots(num_players: u8) -> [u16; 9] {
        [(1u16 << num_players) - 1; 9]
    }
}
