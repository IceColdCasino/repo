use crate::prelude::*;

use super::common::casino_share_input_hash_from_accounts;

pub mod share_penalty;

/// War share: `ShareHashOut(12, 4)`.
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
        4,
        12,
    )
}

pub fn showdown_input_hash_from_accounts<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &crate::showdown_hash::ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    pot_mask: u16,
    coefficient_commitment: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    crate::showdown_hash::showdown_input_hash_fixed_cards(
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        pot_mask,
        coefficient_commitment,
        program_id,
        4,
    )
}
