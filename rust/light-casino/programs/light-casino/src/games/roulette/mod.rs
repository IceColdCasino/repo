use crate::prelude::*;

use super::common::casino_share_input_hash_from_accounts;
use crate::deck_state::active_deck_bytes;
use crate::poseidon_hash::poseidon_fields_be;
use crate::shuffle_hash::{
    field_from_u128, hash_flat_bytes_be, hash_flat_values_be, hash_public_keys_12, identity_x,
    identity_y, read_player_padding, read_player_public_keys,
};
use crate::showdown_hash::{copy_revealed_section, ShowdownMaterialView};

/// Roulette share card limb: single encrypted outcome (`nTotalCards = 1`).
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
        1,
        12,
    )
}

/// Roulette showdown Poseidon layout (`RouletteShowdownHashMain`):
/// `Poseidon(h1, playerIndex, h2, betHash, nActualBets)` where
/// - h1 = HashPublicKeys(12)
/// - h2 = Poseidon(cardHash, 11 partialRowHashes) — padded to 12 seats
/// - betHash = HashCiphertexts(prover's 12 bet ciphertexts)
///
/// Remaining accounts: player PDAs `0..n-1`, then one `RevealedCard` (card 0)
/// for the showdown recipient. `bet_hash` + `n_actual_bets` come from the
/// `RouletteBetCommitment` PDA verified by the caller.
pub fn showdown_input_hash_from_accounts<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    _pot_mask: u16,
    _coefficient_commitment: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    // Caller must supply bet hash/count via the dedicated roulette path.
    let _ = (
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        program_id,
    );
    err!(crate::ErrorCode::InvalidGameConfig)
}

/// Full roulette showdown input hash with explicit bet binding.
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
    const CASINO_SLOTS: usize = 12;
    const N_TOTAL_CARDS: usize = 1;

    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete
            && material.card_filled_bits == 1, // card 0 only
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let n_seated = num_players as usize;
    require!(
        remaining.len() >= n_seated + 1,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let players = &remaining[..n_seated];
    let revealed_cards = &remaining[n_seated..n_seated + 1];

    let deck_data = deck_state.try_borrow_data()?;
    let deck = active_deck_bytes(&deck_data, N_TOTAL_CARDS * 4)?;
    let card_hash = hash_flat_bytes_be(deck)?;

    let keys = read_player_public_keys(players, num_players, game_id, program_id)?;
    let mut padded = [[0u8; 32]; 24];
    for slot in 0..CASINO_SLOTS {
        if slot < keys.len() {
            padded[slot * 2] = keys[slot][0];
            padded[slot * 2 + 1] = keys[slot][1];
        } else {
            padded[slot * 2] = identity_x();
            padded[slot * 2 + 1] = identity_y();
        }
    }
    let h1 = hash_public_keys_12(&padded)?;

    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;
    let expected_count = (num_players - 1) * 4;
    let poker_pid = crate::casino_cpi::casino_program_id();
    let mut row = vec![[0u8; 32]; N_TOTAL_CARDS * 4];
    let mut row_hashes = [[0u8; 32]; CASINO_SLOTS - 1];
    let mut section = 0usize;
    for sharer in 0..CASINO_SLOTS {
        if sharer == material.recipient_index as usize {
            continue;
        }
        for card in 0..N_TOTAL_CARDS {
            let dest = &mut row[card * 4..card * 4 + 4];
            dest.copy_from_slice(&padding);
        }
        if sharer < n_seated {
            let mut seated_section = 0usize;
            for sh in 0..n_seated {
                if sh == material.recipient_index as usize {
                    continue;
                }
                if sh == sharer {
                    break;
                }
                seated_section += 1;
            }
            copy_revealed_section(
                &revealed_cards[0],
                game_id,
                material.recipient_index,
                0,
                expected_count,
                seated_section,
                &mut row[0..4],
                &poker_pid,
            )?;
        }
        row_hashes[section] = hash_flat_values_be(&row)?;
        section += 1;
    }

    let mut h2_refs: [&[u8]; CASINO_SLOTS] = [&[]; CASINO_SLOTS];
    h2_refs[0] = card_hash.as_slice();
    for i in 0..(CASINO_SLOTS - 1) {
        h2_refs[i + 1] = row_hashes[i].as_slice();
    }
    let h2 = poseidon_fields_be(&h2_refs)?;

    let player_index = field_from_u128(material.recipient_index as u128);
    let n_bets = field_from_u128(n_actual_bets as u128);
    poseidon_fields_be(&[
        h1.as_slice(),
        player_index.as_slice(),
        h2.as_slice(),
        bet_hash.as_slice(),
        n_bets.as_slice(),
        coefficient_commitment.as_slice(),
    ])
}
