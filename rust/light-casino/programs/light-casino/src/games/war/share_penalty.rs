//! Slash a war player who does not share after the casino has shared.

/// Posted before share, as a multiple of the seat's wager.
pub const WAR_SHARE_STAKE_MULTIPLE: u64 = 10;
/// Seconds after the casino share during which every player may still share.
pub const WAR_PLAYER_SHARE_SECS: u64 = 180;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WarShareSlash {
    pub slashed_mask: u16,
    pub house_from_stake: u64,
    pub house_from_wager: u64,
}

pub fn required_share_stake(wager: u64) -> Option<u64> {
    if wager == 0 {
        return None;
    }
    wager.checked_mul(WAR_SHARE_STAKE_MULTIPLE)
}

/// `shared` bit `i` is set when seat `i` has shared.
/// The casino bit must be set. A call before the deadline is rejected.
pub fn slash_unshared(
    casino_seat: usize,
    casino_shared_at: u64,
    now: u64,
    shared_mask: u16,
    wagers: &[u64],
    stakes: &[u64],
) -> Result<WarShareSlash, &'static str> {
    if wagers.len() != stakes.len() || wagers.len() > 16 {
        return Err("each seat needs a wager and a stake");
    }
    if casino_seat >= wagers.len() {
        return Err("casino seat is not in the hand");
    }
    if shared_mask & (1u16 << casino_seat) == 0 {
        return Err("the casino has not shared");
    }
    let deadline = casino_shared_at
        .checked_add(WAR_PLAYER_SHARE_SECS)
        .ok_or("share deadline overflow")?;
    if now < deadline {
        return Err("players can still share");
    }

    let mut penalty = WarShareSlash {
        slashed_mask: 0,
        house_from_stake: 0,
        house_from_wager: 0,
    };
    for seat in 0..wagers.len() {
        if seat == casino_seat || shared_mask & (1u16 << seat) != 0 {
            continue;
        }
        penalty.slashed_mask |= 1u16 << seat;
        penalty.house_from_wager = penalty
            .house_from_wager
            .checked_add(wagers[seat])
            .ok_or("wager slash overflow")?;
        penalty.house_from_stake = penalty
            .house_from_stake
            .checked_add(stakes[seat])
            .ok_or("stake slash overflow")?;
    }
    if penalty.slashed_mask == 0 {
        return Err("every player shared");
    }
    Ok(penalty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_player_who_misses_the_deadline_is_slashed() {
        let penalty = slash_unshared(1, 1_000, 1_180, 0b0010, &[20, 100], &[200, 1000]).unwrap();
        assert_eq!(penalty.slashed_mask, 0b0001);
        assert_eq!(penalty.house_from_wager, 20);
        assert_eq!(penalty.house_from_stake, 200);
    }

    #[test]
    fn the_window_stays_open_until_three_minutes() {
        assert!(slash_unshared(1, 1_000, 1_179, 0b0010, &[20, 100], &[200, 1000]).is_err());
    }
}
