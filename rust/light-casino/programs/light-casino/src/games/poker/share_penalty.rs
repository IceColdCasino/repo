//! Poker share-integrity stake and the unseal penalty.
//!
//! The stake is [`POKER_SHARE_STAKE_BLINDS`] small blinds. It is slashed only
//! when a receiving player unseals partials that miss the street hash published
//! at share time. Each cheater is removed from the hand and their pot
//! contribution is taken by the house. Every other contribution is refunded.

use super::pot::MAX_PLAYERS;

/// Posted before share. Slashed only at unseal, and only on a hash mismatch.
pub const POKER_SHARE_STAKE_BLINDS: u64 = 10;

/// After the first bad unseal, other players have this long to reveal the
/// same street. The hand ends when the window expires.
pub const POKER_UNSEAL_CHALLENGE_SECS: u64 = 120;

/// Open window started by the first mismatched street.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsealChallenge {
    pub street: u8,
    pub opened_at: u64,
    pub deadline: u64,
    pub closed: bool,
}

pub fn open_unseal_challenge(street: u8, now: u64) -> Result<UnsealChallenge, &'static str> {
    if street > 12 {
        return Err("poker street is out of range");
    }
    let deadline = now
        .checked_add(POKER_UNSEAL_CHALLENGE_SECS)
        .ok_or("unseal deadline overflow")?;
    Ok(UnsealChallenge {
        street,
        opened_at: now,
        deadline,
        closed: false,
    })
}

pub fn unseal_challenge_accepts(challenge: &UnsealChallenge, now: u64) -> bool {
    !challenge.closed && now < challenge.deadline
}

pub fn unseal_challenge_should_close(
    challenge: &UnsealChallenge,
    now: u64,
    street_fully_revealed: bool,
) -> bool {
    !challenge.closed && (street_fully_revealed || now >= challenge.deadline)
}

/// Outcome of an unseal that proved one or more bad shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareUnsealPenalty {
    /// Bit `i` is set when seat `i` submitted partials that missed the hash.
    pub kicked_mask: u16,
    /// Cheaters' pot contributions, taken by the house.
    pub house_from_pot: u64,
    /// Slashed share stakes, taken by the house.
    pub house_from_stake: u64,
    /// Honest players receive their pot contribution back.
    pub refunds: [u64; MAX_PLAYERS],
    pub slashed_stake: [u64; MAX_PLAYERS],
    pub returned_stake: [u64; MAX_PLAYERS],
}

pub fn required_share_stake(small_blind: u64) -> Option<u64> {
    if small_blind == 0 {
        return None;
    }
    small_blind.checked_mul(POKER_SHARE_STAKE_BLINDS)
}

/// Settle a hand whose unseal proved one or more bad shares.
///
/// `cheater_mask` bit `i` marks seat `i`. An empty mask is rejected so a fair
/// hand cannot be refunded through this path.
pub fn settle_bad_unseal(
    contributions: &[u64],
    stakes: &[u64],
    cheater_mask: u16,
) -> Result<ShareUnsealPenalty, &'static str> {
    if contributions.len() != stakes.len() {
        return Err("each seat needs a pot contribution and a share stake");
    }
    if contributions.len() > MAX_PLAYERS {
        return Err("too many seats");
    }
    if cheater_mask == 0 {
        return Err("unseal slash requires a mismatched share");
    }
    let seat_bits = (1u16 << contributions.len()) - 1;
    if cheater_mask & !seat_bits != 0 {
        return Err("cheater seat is not in the hand");
    }

    let mut penalty = ShareUnsealPenalty {
        kicked_mask: cheater_mask,
        house_from_pot: 0,
        house_from_stake: 0,
        refunds: [0; MAX_PLAYERS],
        slashed_stake: [0; MAX_PLAYERS],
        returned_stake: [0; MAX_PLAYERS],
    };

    for seat in 0..contributions.len() {
        let contribution = contributions[seat];
        let stake = stakes[seat];
        if cheater_mask & (1u16 << seat) != 0 {
            penalty.house_from_pot = penalty
                .house_from_pot
                .checked_add(contribution)
                .ok_or("pot slash overflow")?;
            penalty.house_from_stake = penalty
                .house_from_stake
                .checked_add(stake)
                .ok_or("stake slash overflow")?;
            penalty.slashed_stake[seat] = stake;
        } else {
            penalty.refunds[seat] = contribution;
            penalty.returned_stake[seat] = stake;
        }
    }

    Ok(penalty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stake_is_ten_small_blinds() {
        assert_eq!(required_share_stake(10), Some(100));
        assert_eq!(required_share_stake(0), None);
    }

    #[test]
    fn one_cheater_loses_their_pot_and_stake() {
        let penalty = settle_bad_unseal(&[20, 40, 60], &[100, 100, 100], 0b010).unwrap();
        assert_eq!(penalty.kicked_mask, 0b010);
        assert_eq!(penalty.house_from_pot, 40);
        assert_eq!(penalty.house_from_stake, 100);
        assert_eq!(&penalty.refunds[..3], &[20, 0, 60]);
        assert_eq!(&penalty.returned_stake[..3], &[100, 0, 100]);
        assert_eq!(penalty.slashed_stake[1], 100);
    }

    #[test]
    fn every_cheater_is_penalized() {
        let penalty = settle_bad_unseal(&[10, 30, 50], &[100, 100, 100], 0b101).unwrap();
        assert_eq!(penalty.house_from_pot, 60);
        assert_eq!(penalty.house_from_stake, 200);
        assert_eq!(penalty.refunds[1], 30);
        assert_eq!(penalty.returned_stake[1], 100);
        assert_eq!(penalty.slashed_stake[0], 100);
        assert_eq!(penalty.slashed_stake[2], 100);
    }

    #[test]
    fn a_fair_hand_cannot_be_slashed() {
        assert!(settle_bad_unseal(&[10, 20], &[100, 100], 0).is_err());
    }

    #[test]
    fn the_first_mismatch_opens_two_minutes() {
        let challenge = open_unseal_challenge(10, 1_000).unwrap();
        assert_eq!(challenge.deadline, 1_120);
        assert!(unseal_challenge_accepts(&challenge, 1_119));
        assert!(!unseal_challenge_accepts(&challenge, 1_120));
        assert!(!unseal_challenge_should_close(&challenge, 1_050, false));
        assert!(unseal_challenge_should_close(&challenge, 1_050, true));
        assert!(unseal_challenge_should_close(&challenge, 1_120, false));
    }
}
