//! Plaintext mirror of Arcis `apply_share_unseal_penalty`.
//!
//! The circuit reseals the same arrays. A bad share pays the cheater's pot to
//! the house and refunds everyone else. The share stake is SOL and stays out
//! of this circuit; `settle_share_penalty` divides it. A fair hand moves no chips.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShareUnsealPenalty {
    pub refunds: [u64; 10],
    pub stakes_out: [u64; 10],
    pub house_balance: u64,
    pub accepted: bool,
}

/// Same control flow as the Arcis instruction. Keep the two copies together.
pub fn apply_share_unseal_penalty(
    player_bets: [u64; 10],
    share_stakes: [u64; 10],
    house_balance: u64,
    cheater_mask: u16,
    num_players: u8,
) -> ShareUnsealPenalty {
    let mut house = house_balance;
    let mask = cheater_mask as u64;
    let n = num_players as usize;

    let mut accepted = cheater_mask != 0 && num_players > 0 && num_players <= 10;
    for seat in 0..16 {
        let bit = (mask >> seat) % 2;
        if seat >= n && bit == 1 {
            accepted = false;
        }
    }

    let mut refunds = player_bets;
    let stake_out = share_stakes;
    if accepted {
        refunds = [0u64; 10];
        for seat in 0..10 {
            if seat < n {
                let cheated = (mask >> seat) % 2;
                if cheated == 1 {
                    house = house + player_bets[seat];
                } else {
                    refunds[seat] = player_bets[seat];
                }
            }
        }
    }

    ShareUnsealPenalty {
        refunds,
        stakes_out: stake_out,
        house_balance: house,
        accepted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(prefix: &[u64]) -> [u64; 10] {
        let mut out = [0u64; 10];
        out[..prefix.len()].copy_from_slice(prefix);
        out
    }

    #[test]
    fn one_cheater_loses_their_pot() {
        let penalty = apply_share_unseal_penalty(
            row(&[20, 40, 60]),
            row(&[100, 100, 100]),
            1_000,
            0b010,
            3,
        );
        assert!(penalty.accepted);
        assert_eq!(penalty.house_balance, 1_040);
        assert_eq!(&penalty.refunds[..3], &[20, 0, 60]);
        assert_eq!(&penalty.stakes_out[..3], &[100, 100, 100]);
        assert_eq!(penalty.refunds[3], 0);
        assert_eq!(penalty.stakes_out[3], 0);
    }

    #[test]
    fn every_cheater_is_penalized() {
        let penalty = apply_share_unseal_penalty(
            row(&[10, 30, 50]),
            row(&[100, 100, 100]),
            0,
            0b101,
            3,
        );
        assert!(penalty.accepted);
        assert_eq!(penalty.house_balance, 60);
        assert_eq!(&penalty.refunds[..3], &[0, 30, 0]);
        assert_eq!(&penalty.stakes_out[..3], &[100, 100, 100]);
    }

    #[test]
    fn a_fair_hand_does_not_move_chips() {
        let bets = row(&[10, 20]);
        let stakes = row(&[100, 100]);
        let penalty = apply_share_unseal_penalty(bets, stakes, 50, 0, 2);
        assert!(!penalty.accepted);
        assert_eq!(penalty.house_balance, 50);
        assert_eq!(penalty.refunds, bets);
        assert_eq!(penalty.stakes_out, stakes);
    }

    #[test]
    fn a_bit_past_the_last_seat_is_rejected() {
        let bets = row(&[10, 20, 30]);
        let stakes = row(&[100, 100, 100]);
        let penalty = apply_share_unseal_penalty(bets, stakes, 7, 0b1000, 3);
        assert!(!penalty.accepted);
        assert_eq!(penalty.house_balance, 7);
        assert_eq!(penalty.refunds, bets);
        assert_eq!(penalty.stakes_out, stakes);
    }

    #[test]
    fn an_empty_or_oversized_table_is_rejected() {
        let bets = row(&[10]);
        let stakes = row(&[100]);
        let empty = apply_share_unseal_penalty(bets, stakes, 1, 0b1, 0);
        assert!(!empty.accepted);
        assert_eq!(empty.house_balance, 1);
        let oversized = apply_share_unseal_penalty(bets, stakes, 1, 0b1, 11);
        assert!(!oversized.accepted);
        assert_eq!(oversized.refunds, bets);
    }
}
