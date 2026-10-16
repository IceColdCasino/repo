use crate::prelude::*;

use super::common::casino_share_input_hash_from_selected;
use crate::poseidon_hash::poseidon_fields_be;
use crate::showdown_hash::{showdown_input_hash_fixed_cards_with_bind, ShowdownMaterialView};
use crate::shuffle_hash::field_from_u128;

/// Die-major shoe: first face of each die (`out[die][0]`).
const CRAPS_DEAL_CARDS: [usize; 2] = [0, shared_zk_ids::CRAPS_FACES_PER_DIE];

/// Craps share: `ShareHashOut(12, 2)`.
pub fn share_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    _deck_fields: usize,
) -> Result<[u8; 32]> {
    casino_share_input_hash_from_selected(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        &CRAPS_DEAL_CARDS,
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

/// `Poseidon(h1, playerIndex, h2, betHash, Poseidon(nActualBets, phase, point))`.
pub fn showdown_input_hash<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    bet_hash: &[u8; 32],
    n_actual_bets: u64,
    phase: u64,
    point: u64,
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let n_bets = field_from_u128(n_actual_bets as u128);
    let phase_f = field_from_u128(phase as u128);
    let point_f = field_from_u128(point as u128);
    let table_bind = poseidon_fields_be(&[n_bets.as_slice(), phase_f.as_slice(), point_f.as_slice()])?;
    showdown_input_hash_fixed_cards_with_bind(
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        program_id,
        2,
        12,
        &[bet_hash.as_slice(), table_bind.as_slice()],
        Some(&CRAPS_DEAL_CARDS),
        coefficient_commitment,
    )
}
