//! Plaintext mirror of the street-close decision inside Arcis `validate_bet`.

include!("street_close_logic.rs");

#[cfg(test)]
mod tests {
    use super::street_closes_after_action;

    fn commits(sb: u64, bb: u64) -> [u64; 10] {
        let mut row = [0u64; 10];
        row[0] = sb;
        row[1] = bb;
        row
    }

    #[test]
    fn heads_up_limp_leaves_big_blind_option() {
        let closes = street_closes_after_action(
            2, 0, 2, 10, false, false, true, 20, 0, 0, 0, commits(10, 20),
        );
        assert!(!closes);
    }

    #[test]
    fn big_blind_check_closes_preflop() {
        let closes = street_closes_after_action(
            2, 1, 1, 0, false, false, true, 20, 0, 0, 0b01, commits(20, 20),
        );
        assert!(closes);
    }

    #[test]
    fn big_blind_raise_reopens_action() {
        let closes = street_closes_after_action(
            2, 1, 4, 20, false, false, true, 20, 0, 0, 0b01, commits(20, 20),
        );
        assert!(!closes);
    }

    #[test]
    fn caller_must_match_a_big_blind_raise() {
        let closes = street_closes_after_action(
            2, 0, 2, 20, false, false, true, 40, 0, 0, 0b10, commits(20, 40),
        );
        assert!(closes);
    }

    #[test]
    fn heads_up_flop_call_closes_street() {
        // BB already bet 20. SB's call is the chips added on top of a zero street commit.
        let closes = street_closes_after_action(
            2, 0, 2, 20, false, false, true, 20, 0, 0, 0b10, commits(0, 20),
        );
        assert!(closes);
    }
}
