//! Poker share-integrity stake and the public unseal window.
//!
//! The stake is SOL: the signature fees for every other player to reshuffle and
//! share, plus [`PROTOCOL_SHARE_PENALTY_LAMPORTS`]. Rent is funded with the
//! hand. The stake is not a blind.
//! [`settle_share_penalty`] pays the first cheater's reshuffle lamports to the
//! players who still have to redo the work, and sends a later cheater's
//! reshuffle lamports to the protocol. When every player cheated, the whole
//! slash goes to the protocol. Pot chips are a separate house debit.

/// Signature fees for one player to reshuffle a 1-deck shoe and share again.
/// Fourteen shuffle chunks and seventy-five share uploads, at 10,000 lamports
/// each (one signature plus a retry). Rent is left out.
pub const POKER_RESHUFFLE_AND_SHARE_LAMPORTS: u64 = 890_000;

/// Flat lamports added to every share slash. The protocol sets this.
pub const PROTOCOL_SHARE_PENALTY_LAMPORTS: u64 = 100_000_000;

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

/// SOL and pot movement for one bad unseal. `kicked` is detection order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareSlash {
    pub kicked: [u8; 10],
    pub kicked_count: u8,
    pub house_from_pot: u64,
    pub protocol_lamports: u64,
    pub paid_to_players: [u64; 10],
    pub player_from_cheater: [u64; 10],
    pub refunds: [u64; 10],
    pub slashed_stake: [u64; 10],
    pub returned_stake: [u64; 10],
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

pub fn required_share_stake(player_count: u64) -> Option<u64> {
    if !(2..=10).contains(&player_count) {
        return None;
    }
    (player_count - 1)
        .checked_mul(POKER_RESHUFFLE_AND_SHARE_LAMPORTS)?
        .checked_add(PROTOCOL_SHARE_PENALTY_LAMPORTS)
}

fn split_across(paid: &mut [u64; 10], honest: &[u8], honest_count: usize, total: u64) -> Result<(), &'static str> {
    if honest_count == 0 || total == 0 {
        return Ok(());
    }
    let each = total / honest_count as u64;
    let mut remainder = total % honest_count as u64;
    for seat in honest.iter().take(honest_count) {
        let extra = if remainder > 0 {
            remainder -= 1;
            1
        } else {
            0
        };
        let at = *seat as usize;
        paid[at] = paid[at]
            .checked_add(each)
            .and_then(|sum| sum.checked_add(extra))
            .ok_or("player payout overflow")?;
    }
    Ok(())
}

/// `cheaters` is the order they were caught. Every seat must have posted
/// [`required_share_stake`] for `contributions.len()` players.
pub fn settle_share_penalty(
    contributions: &[u64],
    stakes: &[u64],
    cheaters: &[u8],
    reshuffle_and_share: u64,
    protocol_penalty: u64,
) -> Result<ShareSlash, &'static str> {
    if contributions.len() != stakes.len() || contributions.len() < 2 || contributions.len() > 10 {
        return Err("each seat needs a pot contribution and a share stake");
    }
    let player_count = contributions.len();
    let required = (player_count as u64 - 1)
        .checked_mul(reshuffle_and_share)
        .and_then(|fees| fees.checked_add(protocol_penalty))
        .ok_or("share stake overflow")?;

    let mut seen = 0u16;
    let mut kicked = [0u8; 10];
    let mut kicked_count = 0usize;
    for seat in cheaters {
        let seat = *seat as usize;
        if seat >= player_count {
            return Err("cheater seat is not in the hand");
        }
        let bit = 1u16 << seat;
        if seen & bit != 0 {
            continue;
        }
        seen |= bit;
        kicked[kicked_count] = seat as u8;
        kicked_count += 1;
    }
    if kicked_count == 0 {
        return Err("unseal slash requires a mismatched share");
    }

    let mut slash = ShareSlash {
        kicked,
        kicked_count: kicked_count as u8,
        house_from_pot: 0,
        protocol_lamports: 0,
        paid_to_players: [0; 10],
        player_from_cheater: [0; 10],
        refunds: [0; 10],
        slashed_stake: [0; 10],
        returned_stake: [0; 10],
    };
    let mut honest = [0u8; 10];
    let mut honest_count = 0usize;
    for seat in 0..player_count {
        if stakes[seat] != required {
            return Err("share stake is not the protocol amount");
        }
        if seen & (1u16 << seat) != 0 {
            slash.house_from_pot = slash
                .house_from_pot
                .checked_add(contributions[seat])
                .ok_or("pot slash overflow")?;
            slash.slashed_stake[seat] = stakes[seat];
        } else {
            slash.refunds[seat] = contributions[seat];
            slash.returned_stake[seat] = stakes[seat];
            slash.paid_to_players[seat] = stakes[seat];
            honest[honest_count] = seat as u8;
            honest_count += 1;
        }
    }

    if honest_count == 0 {
        for seat in kicked.iter().take(kicked_count) {
            slash.protocol_lamports = slash
                .protocol_lamports
                .checked_add(stakes[*seat as usize])
                .ok_or("protocol slash overflow")?;
        }
        return Ok(slash);
    }

    for (index, seat) in kicked.iter().take(kicked_count).enumerate() {
        let to_players = if index == 0 {
            (honest_count as u64)
                .checked_mul(reshuffle_and_share)
                .and_then(|fees| fees.checked_add(protocol_penalty))
                .ok_or("player slash overflow")?
        } else {
            protocol_penalty
        };
        slash.player_from_cheater[index] = to_players;
        slash.protocol_lamports = slash
            .protocol_lamports
            .checked_add(stakes[*seat as usize] - to_players)
            .ok_or("protocol slash overflow")?;
        if index == 0 {
            for other in honest.iter().take(honest_count) {
                let at = *other as usize;
                slash.paid_to_players[at] = slash.paid_to_players[at]
                    .checked_add(reshuffle_and_share)
                    .ok_or("player payout overflow")?;
            }
        }
        split_across(
            &mut slash.paid_to_players,
            &honest,
            honest_count,
            protocol_penalty,
        )?;
    }
    Ok(slash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stake_covers_every_other_player_and_the_protocol_penalty() {
        assert_eq!(
            required_share_stake(2),
            Some(POKER_RESHUFFLE_AND_SHARE_LAMPORTS + PROTOCOL_SHARE_PENALTY_LAMPORTS)
        );
        assert_eq!(
            required_share_stake(10),
            Some(9 * POKER_RESHUFFLE_AND_SHARE_LAMPORTS + PROTOCOL_SHARE_PENALTY_LAMPORTS)
        );
        assert_eq!(required_share_stake(1), None);
        assert_eq!(required_share_stake(11), None);
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

    fn settle(cheaters: &[u8]) -> ShareSlash {
        settle_share_penalty(&[20, 40, 60], &[210, 210, 210], cheaters, 100, 10).unwrap()
    }

    #[test]
    fn one_cheater_pays_the_other_players() {
        let penalty = settle(&[1]);
        assert_eq!(penalty.house_from_pot, 40);
        assert_eq!(penalty.protocol_lamports, 0);
        assert_eq!(penalty.paid_to_players[0], 315);
        assert_eq!(penalty.paid_to_players[1], 0);
        assert_eq!(penalty.paid_to_players[2], 315);
        assert_eq!(penalty.refunds[0], 20);
        assert_eq!(penalty.refunds[1], 0);
        assert_eq!(penalty.player_from_cheater[0], 210);
    }

    #[test]
    fn a_later_cheater_pays_the_protocol_for_the_reshuffle() {
        let penalty = settle(&[0, 2]);
        assert_eq!(penalty.kicked_count, 2);
        assert_eq!(penalty.house_from_pot, 80);
        assert_eq!(penalty.protocol_lamports, 300);
        assert_eq!(penalty.paid_to_players[1], 330);
        assert_eq!(penalty.player_from_cheater[0], 110);
        assert_eq!(penalty.player_from_cheater[1], 10);
        assert_eq!(penalty.returned_stake[1], 210);
        assert_eq!(penalty.slashed_stake[0], 210);
        assert_eq!(penalty.slashed_stake[2], 210);
    }

    #[test]
    fn the_first_caught_cheater_is_the_one_who_funds_the_reshuffle() {
        let penalty = settle(&[2, 0]);
        assert_eq!(penalty.kicked[0], 2);
        assert_eq!(penalty.player_from_cheater[0], 110);
        assert_eq!(penalty.player_from_cheater[1], 10);
        assert_eq!(penalty.protocol_lamports, 300);
    }

    #[test]
    fn everyone_cheating_pays_the_protocol() {
        let penalty = settle(&[0, 1, 2]);
        assert_eq!(penalty.protocol_lamports, 630);
        assert_eq!(penalty.paid_to_players, [0; 10]);
        assert_eq!(penalty.house_from_pot, 120);
        assert_eq!(penalty.player_from_cheater[0], 0);
    }

    #[test]
    fn a_fair_hand_is_rejected() {
        assert!(settle_share_penalty(&[20, 40], &[110, 110], &[], 100, 10).is_err());
    }
}
