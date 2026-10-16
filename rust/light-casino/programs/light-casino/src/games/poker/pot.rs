//! Pot tracking, side-pot splitting, and all-in logic.
//!
//! Direct port of the TypeScript reference implementation in
//! `src/pot.ts` and `src/pot-manager.ts`. Amounts are `u64` chips and
//! players are referenced by seat index (0-based). Folded/active/all-in
//! membership is tracked with explicit collections to mirror the TS
//! `Map`/`Set` semantics exactly.
//!
//! This module is pure game logic with no Solana/Anchor dependencies so it
//! can be unit-tested with plain `cargo test` and reused by the on-chain
//! program for deterministic pot distribution.

extern crate alloc;
use alloc::vec::Vec;

/// Maximum players at a table (matches `MAX_PLAYERS` in poker.ts).
pub const MAX_PLAYERS: usize = 10;

/// A single (main or side) pot.
///
/// Mirrors `src/pot.ts`. `player_bets` holds the contribution of each
/// still-active contributor; `folded_bets` retains chips from players who
/// folded after contributing (their chips stay in the pot but they are no
/// longer eligible to win it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pot {
    amount: u64,
    /// (seat, bet) for active contributors.
    player_bets: Vec<(usize, u64)>,
    /// (seat, bet) for folded contributors (chips remain in pot).
    folded_bets: Vec<(usize, u64)>,
    last_bet_amount: u64,
}

impl Pot {
    /// Create an empty pot.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a pot pre-seeded with player bets and an explicit
    /// `last_bet_amount`. Matches the TS constructor used by `split`.
    pub fn with_bets(player_bets: Vec<(usize, u64)>, last_bet_amount: u64) -> Self {
        let amount = player_bets.iter().map(|(_, b)| *b).sum();
        let max_bet = player_bets.iter().map(|(_, b)| *b).max().unwrap_or(0);
        Self {
            amount,
            player_bets,
            folded_bets: Vec::new(),
            last_bet_amount: if last_bet_amount > 0 { last_bet_amount } else { max_bet },
        }
    }

    pub fn amount(&self) -> u64 {
        self.amount
    }

    pub fn last_bet_amount(&self) -> u64 {
        self.last_bet_amount
    }

    /// Current contribution of a seat in this pot.
    pub fn player_amount(&self, seat: usize) -> u64 {
        self.player_bets
            .iter()
            .find(|(s, _)| *s == seat)
            .map(|(_, b)| *b)
            .unwrap_or(0)
    }

    /// Seats with a positive active contribution.
    pub fn all_in_players(&self) -> Vec<usize> {
        self.player_bets
            .iter()
            .filter(|(_, b)| *b > 0)
            .map(|(s, _)| *s)
            .collect()
    }

    fn set_player_bet(&mut self, seat: usize, bet: u64) {
        if let Some(entry) = self.player_bets.iter_mut().find(|(s, _)| *s == seat) {
            entry.1 = bet;
        } else {
            self.player_bets.push((seat, bet));
        }
    }

    /// Split this pot at `amount`: contributions above `amount` are moved into
    /// a new side pot. Mirrors `Pot.split` in TS.
    pub fn split(&mut self, amount: u64) -> Pot {
        assert!(self.amount > 0, "Cannot split an empty pot");

        let mut new_player_bets: Vec<(usize, u64)> = Vec::new();
        for (seat, bet) in self.player_bets.iter_mut() {
            if *bet > amount {
                new_player_bets.push((*seat, *bet - amount));
                *bet = amount;
            }
        }

        let moved: u64 = new_player_bets.iter().map(|(_, b)| *b).sum();
        self.amount -= moved;

        Pot::with_bets(new_player_bets, 0)
    }

    fn place_player_bet(&mut self, seat: usize, bet_amount: u64, current_bet: Option<u64>) -> u64 {
        let existing = current_bet.unwrap_or_else(|| self.player_amount(seat));
        let new_bet = bet_amount + existing;
        self.set_player_bet(seat, new_bet);
        self.amount += bet_amount;
        new_bet
    }

    /// Add a bet for a seat. If the seat's total contribution would fall below
    /// the pot's `last_bet_amount` (i.e. a short all-in), the pot is split and
    /// the side pot is returned. Mirrors `Pot.addBet` in TS.
    pub fn add_bet(&mut self, seat: usize, bet_amount: u64) -> Option<Pot> {
        let current_bet = self.player_amount(seat);

        if bet_amount + current_bet < self.last_bet_amount {
            self.last_bet_amount = bet_amount + current_bet;
            let placed = self.place_player_bet(seat, bet_amount, Some(current_bet));
            return Some(self.split(placed));
        }

        self.last_bet_amount = self.place_player_bet(seat, bet_amount, Some(current_bet));
        None
    }

    /// Fold a seat out of this pot: its chips move to `folded_bets` and it is
    /// removed from active contributors. Mirrors `Pot.foldPlayer` in TS.
    pub fn fold_player(&mut self, seat: usize) {
        let bet = self.player_amount(seat);
        if bet > 0 {
            if let Some(entry) = self.folded_bets.iter_mut().find(|(s, _)| *s == seat) {
                entry.1 = bet;
            } else {
                self.folded_bets.push((seat, bet));
            }
        }
        self.player_bets.retain(|(s, _)| *s != seat);
    }
}

/// Manages the main pot and any side pots for a hand.
///
/// Mirrors `src/pot-manager.ts`. Blind handling and bet routing across
/// existing side pots match the TS implementation.
#[derive(Clone, Debug)]
pub struct PotManager {
    pots: Vec<Pot>,
    active_players: Vec<usize>,
    all_in_players: Vec<usize>,
    small_blind_player: Option<usize>,
    small_blind_amount: Option<u64>,
    big_blind_player: Option<usize>,
    blinds_collected: bool,
}

impl PotManager {
    /// Create a manager seeded with the active players. Optionally configure
    /// blinds (all three blind parameters must be provided together).
    pub fn new(
        players: Vec<usize>,
        small_blind_amount: Option<u64>,
        small_blind_player: Option<usize>,
        big_blind_player: Option<usize>,
    ) -> Self {
        if let (Some(sb), Some(_), Some(bb)) =
            (small_blind_amount, small_blind_player, big_blind_player)
        {
            assert!(
                players.contains(&small_blind_player.unwrap()),
                "Small blind player must be in players array"
            );
            assert!(
                players.contains(&bb),
                "Big blind player must be in players array"
            );
            let _ = sb;
        }

        let initial = Pot::with_bets(players.iter().map(|p| (*p, 0u64)).collect(), 0);

        Self {
            pots: alloc::vec![initial],
            active_players: players,
            all_in_players: Vec::new(),
            small_blind_player,
            small_blind_amount,
            big_blind_player,
            blinds_collected: false,
        }
    }

    fn big_blind_amount(&self) -> Option<u64> {
        self.small_blind_amount.map(|sb| sb * 2)
    }

    pub fn pots(&self) -> &[Pot] {
        &self.pots
    }

    pub fn active_players(&self) -> &[usize] {
        &self.active_players
    }

    pub fn all_in_players(&self) -> &[usize] {
        &self.all_in_players
    }

    /// Total current bet level across all pots (sum of `last_bet_amount`).
    pub fn current_bet(&self) -> u64 {
        self.pots.iter().map(|p| p.last_bet_amount()).sum()
    }

    /// A player's total contribution across all pots.
    pub fn bet_for_player(&self, seat: usize) -> u64 {
        self.pots.iter().map(|p| p.player_amount(seat)).sum()
    }

    /// Post the small and big blinds into the main pot. Mirrors
    /// `PotManager.collectBlinds`.
    pub fn collect_blinds(&mut self) -> u64 {
        assert!(!self.blinds_collected, "Already collected blinds");

        match (
            self.small_blind_player,
            self.small_blind_amount,
            self.big_blind_player,
            self.big_blind_amount(),
        ) {
            (Some(sbp), Some(sba), Some(bbp), Some(bba)) => {
                self.pots[0].place_player_bet(sbp, sba, None);
                // place big blind; set last_bet to big blind
                self.pots[0].place_player_bet(bbp, bba, None);
                self.pots[0].last_bet_amount = bba;
                self.blinds_collected = true;
                bba
            }
            _ => 0,
        }
    }

    /// Route a bet through existing pots, creating side pots as needed.
    /// Mirrors `PotManager.addBet`.
    pub fn add_bet(&mut self, seat: usize, bet_amount: u64) {
        assert!(
            !self.all_in_players.contains(&seat),
            "Cannot bet for an all-in player"
        );
        assert!(
            self.active_players.contains(&seat),
            "Player is not active in the pot"
        );

        let mut remaining = bet_amount;
        let mut i = 0;
        while i < self.pots.len() {
            let last_bet_amount = self.pots[i].last_bet_amount();
            let has_all_in = !self.all_in_players.is_empty();

            if last_bet_amount > 0
                && remaining > last_bet_amount
                && has_all_in
                && i < self.pots.len() - 1
            {
                self.pots[i].add_bet(seat, last_bet_amount);
                remaining -= last_bet_amount;
                i += 1;
                continue;
            }

            if let Some(new_pot) = self.pots[i].add_bet(seat, remaining) {
                self.pots.insert(i + 1, new_pot);
                break;
            }
            break;
        }
    }

    /// Mark a seat all-in (excluded from future betting but still eligible to
    /// win pots it contributed to).
    pub fn mark_all_in(&mut self, seat: usize) {
        if !self.all_in_players.contains(&seat) {
            self.all_in_players.push(seat);
        }
    }

    /// Fold a seat out of all pots. Mirrors `PotManager.foldPlayer`.
    pub fn fold_player(&mut self, seat: usize) {
        assert!(
            !self.all_in_players.contains(&seat),
            "Cannot fold an all-in player"
        );
        assert!(
            self.active_players.contains(&seat),
            "Player has already folded"
        );
        assert!(
            self.active_players.len() != 1,
            "Cannot fold only player in the pot"
        );

        for pot in self.pots.iter_mut() {
            pot.fold_player(seat);
        }
        self.active_players.retain(|s| *s != seat);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Pot (mirrors test/pot.test.ts) ───

    #[test]
    fn add_bet() {
        let mut pot = Pot::new();
        pot.add_bet(0, 100);
        assert_eq!(pot.amount(), 100);
        assert_eq!(pot.last_bet_amount(), 100);
    }

    #[test]
    fn add_bet_no_split_when_above() {
        let mut pot = Pot::new();
        pot.add_bet(4, 100);
        assert_eq!(pot.amount(), 100);
        assert_eq!(pot.last_bet_amount(), 100);

        let result = pot.add_bet(3, 200);
        assert!(result.is_none());
        assert_eq!(pot.amount(), 300);
        assert_eq!(pot.last_bet_amount(), 200);
    }

    #[test]
    fn all_in_less_than_current_creates_side_pot() {
        let mut pot = Pot::new();
        pot.add_bet(0, 500);
        assert_eq!(pot.amount(), 500);
        assert_eq!(pot.last_bet_amount(), 500);

        let new_pot = pot.add_bet(1, 300).expect("side pot");
        assert_eq!(pot.amount(), 600); // 300 * 2 players
        assert_eq!(pot.last_bet_amount(), 300);
        assert_eq!(new_pot.amount(), 200); // player 0's extra 200
        assert_eq!(new_pot.last_bet_amount(), 200);
    }

    #[test]
    fn fold_player_removes_from_pot() {
        let mut pot = Pot::new();
        pot.add_bet(0, 100);
        pot.fold_player(0);
        assert_eq!(pot.player_amount(0), 0);
    }

    #[test]
    fn total_pot_amounts_sum_correctly() {
        let mut pot = Pot::new();
        pot.add_bet(0, 500);
        let new_pot = pot.add_bet(1, 300).expect("side pot");
        assert_eq!(pot.amount() + new_pot.amount(), 800);
    }

    // ─── PotManager (mirrors test/pot-manager.test.ts) ───

    fn players() -> Vec<usize> {
        alloc::vec![0, 1, 2, 3, 4]
    }

    #[test]
    fn manager_initial_state() {
        let pm = PotManager::new(players(), None, None, None);
        assert_eq!(pm.pots().len(), 1);
        assert_eq!(pm.active_players().len(), 5);
        assert_eq!(pm.all_in_players().len(), 0);
    }

    #[test]
    fn manager_collect_blinds() {
        let mut pm = PotManager::new(players(), Some(5), Some(0), Some(1));
        pm.collect_blinds();
        assert_eq!(pm.pots()[0].amount(), 15);
        assert_eq!(pm.pots()[0].last_bet_amount(), 10);
    }

    #[test]
    fn manager_add_bet_without_splitting() {
        let mut pm = PotManager::new(players(), None, None, None);
        pm.add_bet(4, 100);
        assert_eq!(pm.pots()[0].amount(), 100);
        assert_eq!(pm.pots()[0].last_bet_amount(), 100);

        pm.add_bet(3, 200);
        assert_eq!(pm.pots().len(), 1);
        assert_eq!(pm.pots()[0].amount(), 300);
        assert_eq!(pm.pots()[0].last_bet_amount(), 200);
    }

    #[test]
    fn manager_fold_player() {
        let mut pm = PotManager::new(players(), None, None, None);
        pm.add_bet(4, 20);
        pm.fold_player(0);
        assert_eq!(pm.active_players().len(), 4);
        pm.fold_player(1);
        pm.fold_player(2);
        pm.fold_player(3);
        assert_eq!(pm.active_players().len(), 1);
    }

    #[test]
    #[should_panic(expected = "Cannot fold only player in the pot")]
    fn manager_cannot_fold_last_player() {
        let mut pm = PotManager::new(players(), None, None, None);
        pm.add_bet(4, 20);
        pm.fold_player(0);
        pm.fold_player(1);
        pm.fold_player(2);
        pm.fold_player(3);
        pm.fold_player(4);
    }
}
