//! Per-game Poseidon input-hash layouts and verify helpers.

pub mod baccarat;
pub mod bingo;
pub mod blackjack;
pub(crate) mod common;
pub mod craps;
pub mod keno;
pub mod poker;
pub mod roulette;
pub mod slots;
pub mod war;

use crate::prelude::*;
use shared_zk_ids::GameKind;

use crate::game_config::OnchainGameConfig;

/// Dispatch share input-hash derivation by game kind.
pub fn share_input_hash_from_accounts<'info>(
    config: OnchainGameConfig,
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    match config.kind() {
        GameKind::Poker => poker::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
        ),
        GameKind::Baccarat => baccarat::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::War => war::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::Blackjack => blackjack::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::Roulette => roulette::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::Craps => craps::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::Keno => keno::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
        GameKind::Slots => slots::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.roulette_variant() as usize,
        ),
        GameKind::Bingo => bingo::share_input_hash_from_accounts(
            deck,
            remaining,
            prover_index,
            num_players,
            game_id,
            program_id,
            config.deck_fields(),
        ),
    }
}

/// Dispatch showdown input-hash derivation by game kind.
pub fn showdown_input_hash_from_accounts<'info>(
    config: OnchainGameConfig,
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
    match config.kind() {
        GameKind::Poker => poker::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::Baccarat => baccarat::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::War => war::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::Blackjack => {
            let _ = (
                deck_state,
                remaining,
                material,
                game_id,
                generation,
                num_players,
                pot_mask,
                coefficient_commitment,
                program_id,
            );
            // Blackjack needs the action-derived layout account — see
            // `verify_showdown_receipt` blackjack branch.
            err!(crate::ErrorCode::BlackjackLayoutNotRecorded)
        }
        GameKind::Roulette => {
            let _ = (pot_mask, coefficient_commitment);
            // Roulette requires explicit bet binding via `showdown_input_hash`.
            roulette::showdown_input_hash_from_accounts(
                deck_state,
                remaining,
                material,
                game_id,
                generation,
                num_players,
                pot_mask,
                coefficient_commitment,
                program_id,
            )
        }
        GameKind::Craps => craps::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::Keno => keno::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::Slots => slots::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
        GameKind::Bingo => bingo::showdown_input_hash_from_accounts(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            pot_mask,
            coefficient_commitment,
            program_id,
        ),
    }
}
