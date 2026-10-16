use anchor_lang::prelude::*;

pub const MAX_TABLE_SEATS: usize = 12;
pub const MIN_HAND_PLAYERS: u8 = 2;

/// Collect occupied physical seat numbers sorted ascending.
pub fn sorted_occupied_seats(seats: &[Pubkey; MAX_TABLE_SEATS]) -> Vec<u8> {
    let mut out = Vec::new();
    for (idx, key) in seats.iter().enumerate() {
        if *key != Pubkey::default() {
            out.push(idx as u8);
        }
    }
    out.sort_unstable();
    out
}

/// Advance dealer button to the next occupied seat (wrap around).
pub fn advance_dealer(dealer_seat: u8, sorted: &[u8]) -> u8 {
    if sorted.is_empty() {
        return dealer_seat;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    if let Some(pos) = sorted.iter().position(|&s| s == dealer_seat) {
        sorted[(pos + 1) % sorted.len()]
    } else {
        sorted[0]
    }
}

/// Action order for the next hand.
/// Multiway: circular from seat-after-dealer (SB). Heads-up: dealer is SB.
pub fn action_order_from_dealer(sorted: &[u8], dealer_seat: u8) -> ([u8; MAX_TABLE_SEATS], u8) {
    let mut order = [0u8; MAX_TABLE_SEATS];
    if sorted.is_empty() {
        return (order, 0);
    }

    let dealer_idx = sorted.iter().position(|&s| s == dealer_seat).unwrap_or(0);
    let dealer = sorted[dealer_idx];
    let count = sorted.len() as u8;

    if sorted.len() == 2 {
        let other = if sorted[0] == dealer { sorted[1] } else { sorted[0] };
        order[0] = dealer;
        order[1] = other;
        return (order, count);
    }

    let sb_idx = (dealer_idx + 1) % sorted.len();
    for i in 0..sorted.len() {
        order[i] = sorted[(sb_idx + i) % sorted.len()];
    }

    (order, count)
}

/// Recompute pending seat order and advance dealer.
pub fn recompute_pending_order(
    seats: &[Pubkey; MAX_TABLE_SEATS],
    dealer_seat: u8,
) -> ([u8; MAX_TABLE_SEATS], u8, u8) {
    let sorted = sorted_occupied_seats(seats);
    let new_dealer = advance_dealer(dealer_seat, &sorted);
    let (order, count) = action_order_from_dealer(&sorted, new_dealer);
    (order, new_dealer, count)
}

/// Find player_index in hand_seat_order for a physical seat.
pub fn player_index_for_seat(hand_seat_order: &[u8; MAX_TABLE_SEATS], hand_num: u8, seat: u8) -> Option<u8> {
    for i in 0..hand_num as usize {
        if hand_seat_order[i] == seat {
            return Some(i as u8);
        }
    }
    None
}

/// Find player_index for a player pubkey in the current hand.
pub fn player_index_for_pubkey(
    seats: &[Pubkey; MAX_TABLE_SEATS],
    hand_seat_order: &[u8; MAX_TABLE_SEATS],
    hand_num: u8,
    player: &Pubkey,
) -> Option<u8> {
    for i in 0..hand_num as usize {
        let seat = hand_seat_order[i] as usize;
        if seats[seat] == *player {
            return Some(i as u8);
        }
    }
    None
}

/// Check if player is in the active hand at this table.
pub fn player_in_active_hand(
    seats: &[Pubkey; MAX_TABLE_SEATS],
    hand_seat_order: &[u8; MAX_TABLE_SEATS],
    hand_num: u8,
    hand_in_progress: bool,
    player: &Pubkey,
) -> bool {
    hand_in_progress && player_index_for_pubkey(seats, hand_seat_order, hand_num, player).is_some()
}

/// First player to act for a betting street.
///
/// `hand_seat_order` is SB-first (index 0 = SB, 1 = BB).
/// Heads-up: dealer is SB. Preflop SB acts first; postflop BB acts first.
/// Multiway preflop (`betting_phase == 1`): UTG (index 2). Postflop: SB (index 0).
pub fn first_to_act(
    betting_phase: u8,
    num_players: u8,
    folded_mask: u16,
    all_in_mask: u16,
) -> Option<u8> {
    if num_players < 2 {
        return None;
    }
    let start = if betting_phase == 1 {
        if num_players == 2 {
            0u8 // heads-up preflop: dealer / SB
        } else {
            2u8 // multiway preflop: UTG
        }
    } else if num_players == 2 {
        1u8 // heads-up postflop: BB
    } else {
        0u8 // multiway postflop: SB
    };
    let inactive = folded_mask | all_in_mask;
    for offset in 0..num_players {
        let candidate = ((start as u16 + offset as u16) % num_players as u16) as u8;
        if (inactive & (1u16 << candidate)) == 0 {
            return Some(candidate);
        }
    }
    None
}

/// Advance to the next player who can still act (not folded, not all-in).
/// Returns None if no such player exists (everyone folded/all-in).
pub fn next_active_player(
    current: u8,
    num_players: u8,
    folded_mask: u16,
    all_in_mask: u16,
) -> Option<u8> {
    if num_players == 0 {
        return None;
    }
    let inactive = folded_mask | all_in_mask;
    for offset in 1..=num_players {
        let candidate = (current + offset) % num_players;
        if (inactive & (1u16 << candidate)) == 0 {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seats_with(indices: &[usize]) -> [Pubkey; MAX_TABLE_SEATS] {
        let mut seats = [Pubkey::default(); MAX_TABLE_SEATS];
        for &i in indices {
            seats[i] = Pubkey::new_unique();
        }
        seats
    }

    #[test]
    fn sorted_occupied_seats_works() {
        let seats = seats_with(&[2, 0, 5]);
        assert_eq!(sorted_occupied_seats(&seats), vec![0, 2, 5]);
    }

    #[test]
    fn dealer_rotates() {
        let sorted = vec![0u8, 2, 5];
        assert_eq!(advance_dealer(0, &sorted), 2);
        assert_eq!(advance_dealer(5, &sorted), 0);
    }

    #[test]
    fn action_order_starts_at_sb() {
        let sorted = vec![0u8, 2, 5];
        let (order, count) = action_order_from_dealer(&sorted, 0);
        assert_eq!(count, 3);
        // dealer=0, SB=2, BB=5, then wrap
        assert_eq!(order[0], 2);
        assert_eq!(order[1], 5);
        assert_eq!(order[2], 0);
    }

    #[test]
    fn heads_up_action_order_starts_at_dealer() {
        let sorted = vec![0u8, 1];
        let (order, count) = action_order_from_dealer(&sorted, 0);
        assert_eq!(count, 2);
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 1);
        let (order, _) = action_order_from_dealer(&sorted, 1);
        assert_eq!(order[0], 1);
        assert_eq!(order[1], 0);
    }

    #[test]
    fn recompute_pending_order_works() {
        let seats = seats_with(&[0, 2, 5]);
        let (order, dealer, count) = super::recompute_pending_order(&seats, 0);
        assert_eq!(count, 3);
        assert_eq!(dealer, 2);
        assert_eq!(order[0], 5);
        assert_eq!(order[1], 0);
        assert_eq!(order[2], 2);
    }

    #[test]
    fn next_active_skips_folded_player() {
        // players 0,1,2; player 1 folded; from 0 -> 2
        assert_eq!(next_active_player(0, 3, 1 << 1, 0), Some(2));
    }

    #[test]
    fn next_active_skips_all_in_player() {
        // players 0,1,2; player 1 all-in; from 0 -> 2
        assert_eq!(next_active_player(0, 3, 0, 1 << 1), Some(2));
    }

    #[test]
    fn next_active_wraps_around() {
        // players 0,1,2; from 2 -> 0
        assert_eq!(next_active_player(2, 3, 0, 0), Some(0));
    }

    #[test]
    fn next_active_returns_none_when_all_remaining_folded_or_all_in() {
        // All seats folded or all-in — no eligible actor anywhere in the scan.
        assert_eq!(next_active_player(0, 3, 0b011, 0b100), None);
        assert_eq!(next_active_player(1, 3, 0b111, 0), None);
    }

    #[test]
    fn next_active_returns_sole_remaining_active() {
        // only player 1 can act; from 0 (folded) -> 1
        assert_eq!(next_active_player(0, 3, 1 << 0, 1 << 2), Some(1));
        // from 2 (all-in) -> 1
        assert_eq!(next_active_player(2, 3, 1 << 0, 1 << 2), Some(1));
        // from 1, wraps and finds only 1 again
        assert_eq!(next_active_player(1, 3, 1 << 0, 1 << 2), Some(1));
    }

    #[test]
    fn first_to_act_heads_up_preflop_is_sb() {
        assert_eq!(first_to_act(1, 2, 0, 0), Some(0));
    }

    #[test]
    fn first_to_act_heads_up_postflop_is_bb() {
        assert_eq!(first_to_act(2, 2, 0, 0), Some(1));
    }

    #[test]
    fn first_to_act_multiway_preflop_is_utg() {
        assert_eq!(first_to_act(1, 4, 0, 0), Some(2));
    }

    #[test]
    fn first_to_act_postflop_is_sb() {
        assert_eq!(first_to_act(2, 4, 0, 0), Some(0));
    }

    #[test]
    fn first_to_act_postflop_skips_folded_sb() {
        assert_eq!(first_to_act(2, 4, 1 << 0, 0), Some(1));
    }
}
