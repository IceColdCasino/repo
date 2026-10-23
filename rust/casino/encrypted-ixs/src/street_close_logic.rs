/// Whether this validated action closes the betting street.
///
/// A heads-up limp matches the blind and is not the end of preflop. The big
/// blind still checks or raises. A raise clears everyone else's acted bit, so
/// the other player must call or raise before the street can close. A postflop
/// call still closes once the bettor has already acted and the bets match.
///
/// Shifts are only by loop indexes. Arcis rejects a shift by a player index.
fn street_closes_after_action(
    num_players: u8,
    player_index: u8,
    action: u8,
    bet_delta: u64,
    is_fold: bool,
    is_all_in: bool,
    is_valid: bool,
    current_bet: u64,
    folded_mask: u16,
    all_in_mask: u16,
    acted_mask: u16,
    hand_commits: [u64; 10],
) -> bool {
    let ready = is_valid && num_players >= 2 && player_index < 10 && player_index < num_players;
    let n = if ready { num_players as usize } else { 1 };
    let seat = if player_index < 10 { player_index as usize } else { 0 };
    let mut commits = hand_commits;
    if ready && bet_delta > 0 {
        for i in 0..10 {
            if i == seat {
                commits[i] = commits[i] + bet_delta;
            }
        }
    }
    let mut folded = folded_mask as u64;
    let mut all_in = all_in_mask as u64;
    let mut acted = acted_mask as u64;
    let mut seat_commit = 0u64;
    let mut seat_bit = 1u64;
    for i in 0..10 {
        if i == seat {
            seat_commit = commits[i];
            if ready && is_fold {
                folded = folded | seat_bit;
            }
            if ready && is_all_in {
                all_in = all_in | seat_bit;
            }
        }
        seat_bit = seat_bit * 2;
    }
    let mut new_current = current_bet;
    if ready && (action == 3 || action == 4) {
        new_current = seat_commit;
    } else if ready && action == 5 && seat_commit > new_current {
        new_current = seat_commit;
    }
    let raised = new_current > current_bet;
    if ready && (action == 3 || action == 4 || raised) {
        acted = 0;
        let mut bit = 1u64;
        for i in 0..10 {
            if i == seat {
                acted = bit;
            }
            bit = bit * 2;
        }
    } else if ready {
        let mut bit = 1u64;
        for i in 0..10 {
            if i == seat {
                acted = acted | bit;
            }
            bit = bit * 2;
        }
    }

    let mut active = 0u8;
    for i in 0..10 {
        if ready && i < n && (folded >> i) % 2 == 0 {
            active = active + 1;
        }
    }
    let mut someone_can_act = false;
    for offset in 1..11 {
        if ready && offset <= n {
            let mut candidate = seat + offset;
            if candidate >= n {
                candidate = candidate - n;
            }
            for i in 0..10 {
                if i == candidate && (folded >> i) % 2 == 0 && (all_in >> i) % 2 == 0 {
                    someone_can_act = true;
                }
            }
        }
    }
    let mut max_street = 0u64;
    for i in 0..10 {
        if ready && i < n && (folded >> i) % 2 == 0 && commits[i] > max_street {
            max_street = commits[i];
        }
    }
    let mut matched = true;
    let mut all_acted = true;
    for i in 0..10 {
        if ready && i < n && (folded >> i) % 2 == 0 && (all_in >> i) % 2 == 0 {
            if commits[i] != max_street {
                matched = false;
            }
            if (acted >> i) % 2 == 0 {
                all_acted = false;
            }
        }
    }
    ready && (active <= 1 || !someone_can_act || (all_acted && matched))
}
