use anchor_lang::prelude::*;
use shared_zk_ids::GameKind;

use crate::seat_order::{self, MAX_TABLE_SEATS, MIN_HAND_PLAYERS};

pub const MAX_TABLES_PER_ROOM: u64 = 64;

#[account]
#[derive(InitSpace)]
pub struct Room {
    pub room_id: [u8; 32],
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub table_count: u64,
    pub small_blind_default: u64,
    /// Poker rake in basis points. `0` takes nothing. `500` is 5%.
    /// Charged on a post-flop fold to one player, or at showdown.
    pub rake_bps: u16,
    /// Whitelisted house that receives the rake into its own encrypted wallet.
    pub house: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct TableState {
    pub room_id: [u8; 32],
    pub table_id: u64,
    /// [`shared_zk_ids::GameKind`] as u8.
    pub game_kind: u8,
    /// Shoe decks for baccarat/blackjack/war (`1|6|8`); `1` for poker; `0` for roulette.
    pub shoe_decks: u8,
    /// Roulette variant (`37|38`); `0` for non-roulette tables.
    pub roulette_variant: u8,
    pub seats: [Pubkey; MAX_TABLE_SEATS],
    pub dealer_seat: u8,
    pub hand_in_progress: bool,
    pub current_game_id: [u8; 32],
    pub hand_seat_order: [u8; MAX_TABLE_SEATS],
    pub hand_num_players: u8,
    pub pending_seat_order: [u8; MAX_TABLE_SEATS],
    pub pending_num_players: u8,
}

impl TableState {
    pub fn init(
        room_id: [u8; 32],
        table_id: u64,
        game_kind: u8,
        shoe_decks: u8,
        roulette_variant: u8,
    ) -> Self {
        Self {
            room_id,
            table_id,
            game_kind,
            shoe_decks,
            roulette_variant,
            seats: [Pubkey::default(); MAX_TABLE_SEATS],
            dealer_seat: 0,
            hand_in_progress: false,
            current_game_id: [0u8; 32],
            hand_seat_order: [0u8; MAX_TABLE_SEATS],
            hand_num_players: 0,
            pending_seat_order: [0u8; MAX_TABLE_SEATS],
            pending_num_players: 0,
        }
    }

    pub fn house_seat_index(&self) -> Option<u8> {
        GameKind::from_u8(self.game_kind).and_then(|kind| kind.house_seat())
    }

    pub fn refresh_pending_order(&mut self) {
        if let Some(house) = self.house_seat_index() {
            self.refresh_reserved_house_order(house);
            return;
        }
        let (order, dealer, count) =
            seat_order::recompute_pending_order(&self.seats, self.dealer_seat);
        self.pending_seat_order = order;
        self.pending_num_players = count;
        self.dealer_seat = dealer;
    }

    /// Bettors keep ascending seats. The reserved house seat is always last.
    fn refresh_reserved_house_order(&mut self, house: u8) {
        let mut order = [0u8; MAX_TABLE_SEATS];
        let mut count = 0u8;
        for (idx, seat) in self.seats.iter().enumerate() {
            if idx == house as usize || *seat == Pubkey::default() {
                continue;
            }
            order[count as usize] = idx as u8;
            count = count.saturating_add(1);
        }
        if (house as usize) < MAX_TABLE_SEATS && self.seats[house as usize] != Pubkey::default() {
            order[count as usize] = house;
            count = count.saturating_add(1);
            self.dealer_seat = house;
        }
        self.pending_seat_order = order;
        self.pending_num_players = count;
    }

    pub fn snapshot_hand(&mut self, game_id: [u8; 32]) -> Result<()> {
        let cap = self.seat_cap()?;
        require!(
            self.pending_num_players >= MIN_HAND_PLAYERS,
            crate::ErrorCode::NotEnoughPlayers
        );
        require!(
            self.pending_num_players <= cap,
            crate::ErrorCode::InvalidSeat
        );
        require!(
            self.seats
                .iter()
                .skip(cap as usize)
                .all(|seat| *seat == Pubkey::default()),
            crate::ErrorCode::InvalidSeat
        );
        if let Some(house) = self.house_seat_index() {
            require!(
                self.seats[house as usize] != Pubkey::default(),
                crate::ErrorCode::InvalidSeat
            );
        }
        require!(!self.hand_in_progress, crate::ErrorCode::HandInProgress);

        self.hand_seat_order = self.pending_seat_order;
        self.hand_num_players = self.pending_num_players;
        self.current_game_id = game_id;
        self.hand_in_progress = true;
        Ok(())
    }

    pub fn end_hand(&mut self) {
        self.hand_in_progress = false;
        self.current_game_id = [0u8; 32];
        self.hand_seat_order = [0u8; MAX_TABLE_SEATS];
        self.hand_num_players = 0;
        self.refresh_pending_order();
    }

    /// Slots 2, blackjack 8, poker 10. Every other game uses the 12-seat array.
    pub fn seat_cap(&self) -> Result<u8> {
        let cap = GameKind::from_u8(self.game_kind)
            .ok_or(error!(crate::ErrorCode::InvalidGameKind))?
            .max_players();
        require!(
            (cap as usize) <= MAX_TABLE_SEATS,
            crate::ErrorCode::InvalidSeat
        );
        Ok(cap)
    }

    pub fn assign_seat(&mut self, physical_seat: u8, player: Pubkey) -> Result<()> {
        let cap = self.seat_cap()?;
        require!(physical_seat < cap, crate::ErrorCode::InvalidSeat);
        require!(physical_seat < MAX_TABLE_SEATS as u8, crate::ErrorCode::InvalidSeat);
        let idx = physical_seat as usize;
        require!(
            self.seats[idx] == Pubkey::default(),
            crate::ErrorCode::SeatTaken
        );
        require!(
            !self.seats.iter().any(|s| *s == player),
            crate::ErrorCode::AlreadySeated
        );
        self.seats[idx] = player;
        Ok(())
    }

    pub fn clear_seat(&mut self, player: &Pubkey) -> Result<u8> {
        for (idx, seat) in self.seats.iter_mut().enumerate() {
            if *seat == *player {
                *seat = Pubkey::default();
                return Ok(idx as u8);
            }
        }
        Err(error!(crate::ErrorCode::NotSeated))
    }
}

/// Roulette class profit multipliers (12 unique bet classes).
pub const ROULETTE_CLASS_PAYOUT_MULT: [u64; 12] = [35, 17, 17, 11, 8, 8, 5, 2, 2, 1, 1, 1];

/// Worst-case dealer liability for roulette at `max_bet` across all 12 classes × seats.
pub fn roulette_max_liability(max_bet: u64, seats: u8) -> Option<u64> {
    let mut per_seat: u64 = 0;
    for m in ROULETTE_CLASS_PAYOUT_MULT {
        per_seat = per_seat.checked_add(max_bet.checked_mul(m)?)?;
    }
    per_seat.checked_mul(seats as u64)
}

/// Worst-case blackjack liability: bet_unit × 4 hands × 3 (double + even payout headroom).
pub fn blackjack_max_liability(bet_unit: u64, seats: u8) -> Option<u64> {
    bet_unit
        .checked_mul(4)?
        .checked_mul(3)?
        .checked_mul(seats as u64)
}

/// Head-to-head (war/baccarat): seat stakes × 1 (even-money payout liability).
pub fn head_to_head_max_liability(bet_unit: u64, seats: u8) -> Option<u64> {
    bet_unit.checked_mul(seats as u64)
}

pub fn table_bit(table_id: u64) -> Result<u64> {
    require!(table_id < MAX_TABLES_PER_ROOM, crate::ErrorCode::InvalidTableId);
    Ok(1u64 << table_id)
}

/// Closing the highest table id frees that slot for the next `create_table`.
/// A hole below the highest id stays in `table_count` so a later open does not
/// collide with a table that is still there.
pub fn table_count_after_close(closed_id: u64, table_count: u64) -> u64 {
    if closed_id.saturating_add(1) == table_count {
        closed_id
    } else {
        table_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baccarat_reserves_the_last_seat_for_the_house() {
        let mut table = TableState::init([1u8; 32], 0, GameKind::Baccarat as u8, 6, 0);
        table.assign_seat(0, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        assert!(table.snapshot_hand([2u8; 32]).is_err());

        table.assign_seat(11, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        assert_eq!(table.pending_num_players, 2);
        assert_eq!(table.pending_seat_order[0], 0);
        assert_eq!(table.pending_seat_order[1], 11);
        table.snapshot_hand([2u8; 32]).unwrap();
    }

    #[test]
    fn poker_button_moves_one_seat_when_the_hand_ends() {
        let mut table = TableState::init([1u8; 32], 0, GameKind::Poker as u8, 1, 0);
        table.assign_seat(0, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        table.assign_seat(1, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        let first_button = table.dealer_seat;
        table.snapshot_hand([1u8; 32]).unwrap();
        assert_eq!(table.hand_seat_order[0], first_button);

        table.end_hand();
        let next_button = table.dealer_seat;
        assert_ne!(next_button, first_button);
        // start_hand snapshots this pending order. It must not refresh again.
        table.snapshot_hand([2u8; 32]).unwrap();
        assert_eq!(table.dealer_seat, next_button);
        assert_eq!(table.hand_seat_order[0], next_button);
    }

    #[test]
    fn poker_and_bingo_do_not_reserve_a_house_seat() {
        for kind in [GameKind::Poker, GameKind::Bingo] {
            let mut table = TableState::init([1u8; 32], 0, kind as u8, 1, 0);
            table.assign_seat(0, Pubkey::new_unique()).unwrap();
            table.assign_seat(1, Pubkey::new_unique()).unwrap();
            table.refresh_pending_order();
            assert!(table.snapshot_hand([3u8; 32]).is_ok());
        }
    }

    #[test]
    fn closing_the_highest_table_reuses_its_id() {
        assert_eq!(super::table_count_after_close(0, 1), 0);
        assert_eq!(super::table_count_after_close(2, 3), 2);
        assert_eq!(super::table_count_after_close(0, 3), 3);
        assert_eq!(super::table_count_after_close(1, 3), 3);
    }
}
