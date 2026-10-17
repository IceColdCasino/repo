//! Poker share-integrity stake and the public unseal window.
//!
//! The stake is [`POKER_SHARE_STAKE_BLINDS`] small blinds. Slashed chips stay
//! inside the Arcis `apply_share_unseal_penalty` circuit: cheater contributions
//! and stakes move onto the house ciphertext, and honest seats are refunded,
//! without revealing the amounts.

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

pub fn required_share_stake(small_blind: u64) -> Option<u64> {
    if small_blind == 0 {
        return None;
    }
    small_blind.checked_mul(POKER_SHARE_STAKE_BLINDS)
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
