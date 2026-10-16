use crate::prelude::*;

use super::common::casino_share_input_hash_from_selected;
use crate::showdown_hash::{showdown_input_hash_fixed_cards_with_bind, ShowdownMaterialView};

/// Reel-major shoe: center stop of each reel (`out[reel][0]`).
const SLOT_DEAL_CARDS: [usize; 5] = [
    0,
    shared_zk_ids::SLOT_STOPS_PER_REEL,
    2 * shared_zk_ids::SLOT_STOPS_PER_REEL,
    3 * shared_zk_ids::SLOT_STOPS_PER_REEL,
    4 * shared_zk_ids::SLOT_STOPS_PER_REEL,
];

/// Slots share: `SlotShareHashOut(2, nReels)` — 2 seats only.
pub fn share_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    n_reels: usize,
) -> Result<[u8; 32]> {
    require!(num_players == 2, crate::ErrorCode::InvalidNumPlayers);
    require!(
        n_reels == 3 || n_reels == 5,
        crate::ErrorCode::InvalidGameConfig
    );
    casino_share_input_hash_from_selected(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        &SLOT_DEAL_CARDS[..n_reels],
        2,
    )
}

pub fn showdown_input_hash_from_accounts<'info>(
    _deck_state: &AccountInfo<'info>,
    _remaining: &[AccountInfo<'info>],
    _material: &ShowdownMaterialView,
    _game_id: &[u8; 32],
    _generation: u64,
    _num_players: u8,
    _pot_mask: u16,
    _coefficient_commitment: &[u8; 32],
    _program_id: &Pubkey,
) -> Result<[u8; 32]> {
    err!(crate::ErrorCode::InvalidGameConfig)
}

/// `Poseidon(h1, playerIndex, h2, betHash)` — coin-bet sealed at share.
pub fn showdown_input_hash<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    bet_hash: &[u8; 32],
    n_reels: usize,
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    showdown_input_hash_fixed_cards_with_bind(
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        program_id,
        n_reels,
        2,
        &[bet_hash.as_slice()],
        Some(&SLOT_DEAL_CARDS[..n_reels]),
        coefficient_commitment,
    )
}
