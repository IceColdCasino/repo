use crate::prelude::*;

use super::common::casino_share_input_hash_from_accounts;
use crate::showdown_hash::{
    hash_one_fixed_card_row, showdown_input_hash_fixed_cards_with_bind,
    showdown_input_hash_from_staged_rows, ShowdownMaterialView,
};
use crate::shuffle_hash::field_from_u128;

/// Keno share: `ShareHashOut(12, 20)`.
pub fn share_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    _deck_fields: usize,
) -> Result<[u8; 32]> {
    casino_share_input_hash_from_accounts(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        20,
        12,
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

/// Circuit width of `ShareHashOut(12, 20)`: 11 non-recipient rows.
pub const SHOWDOWN_ROW_COUNT: usize = 11;
pub const SHOWDOWN_ROWS_FILLED: u16 = (1u16 << SHOWDOWN_ROW_COUNT) - 1;

/// One share row. Padding rows ignore `revealed_cards`.
pub fn hash_showdown_row<'info>(
    padding_account: &AccountInfo<'info>,
    revealed_cards: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    num_players: u8,
    program_id: &Pubkey,
    row_index: u8,
) -> Result<[u8; 32]> {
    hash_one_fixed_card_row(
        padding_account,
        revealed_cards,
        material,
        game_id,
        num_players,
        program_id,
        20,
        12,
        row_index,
    )
}

/// `Poseidon(h1, playerIndex, h2, betHash, nActualBets)` from staged row hashes.
pub fn showdown_input_hash_from_rows<'info>(
    deck_state: &AccountInfo<'info>,
    players: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    bet_hash: &[u8; 32],
    n_actual_bets: u64,
    row_hashes: &[[u8; 32]; SHOWDOWN_ROW_COUNT],
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let n_bets = field_from_u128(n_actual_bets as u128);
    showdown_input_hash_from_staged_rows(
        deck_state,
        players,
        material,
        game_id,
        generation,
        num_players,
        program_id,
        20,
        12,
        row_hashes,
        &[bet_hash.as_slice(), n_bets.as_slice()],
        coefficient_commitment,
    )
}

/// `Poseidon(h1, playerIndex, h2, betHash, nActualBets)`.
pub fn showdown_input_hash<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    bet_hash: &[u8; 32],
    n_actual_bets: u64,
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let n_bets = field_from_u128(n_actual_bets as u128);
    showdown_input_hash_fixed_cards_with_bind(
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        program_id,
        20,
        12,
        &[bet_hash.as_slice(), n_bets.as_slice()],
        None,
        coefficient_commitment,
    )
}
