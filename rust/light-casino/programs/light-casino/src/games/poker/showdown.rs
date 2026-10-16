//! Poker showdown Poseidon matching Circom `PokerHashMain(10)` / TS `showdownHash`.

use crate::prelude::*;

use crate::casino_cpi;
use crate::deck_state::deck_bytes;
use crate::poseidon_hash::poseidon_fields_be;
use crate::showdown_hash::{copy_revealed_section, ShowdownMaterialView};
use crate::shuffle_hash::{
    field_from_u128, hash_flat_values_be, hash_public_keys_10, identity_x, identity_y,
    read_player_padding, read_player_public_keys, SHARE_PLAYER_SLOTS,
};
use crate::TOTAL_CARDS;

use super::share::hash_deal_25;

const BOARD_START: u16 = 20;
const DEAL_END: u16 = 24;
const DEAL_FIELDS: usize = TOTAL_CARDS * 4;

/// Poker in-play deal indices (holes for seated seats + board 20..=24).
pub fn poker_in_play_card_indices(num_players: u8) -> Result<Vec<u16>> {
    let mut buf = [0u16; 25];
    let n = fill_poker_in_play_indices(num_players, &mut buf)?;
    Ok(buf[..n].to_vec())
}

fn fill_poker_in_play_indices(num_players: u8, out: &mut [u16; 25]) -> Result<usize> {
    require!((2..=10).contains(&num_players), crate::ErrorCode::InvalidNumPlayers);
    let mut n = 0usize;
    for i in 0..(num_players as u16 * 2) {
        out[n] = i;
        n += 1;
    }
    for board in BOARD_START..=DEAL_END {
        out[n] = board;
        n += 1;
    }
    Ok(n)
}

fn poker_in_play_card_mask(num_players: u8) -> Result<u64> {
    let mut buf = [0u16; 25];
    let n = fill_poker_in_play_indices(num_players, &mut buf)?;
    let mut mask = 0u64;
    for card in buf[..n].iter() {
        mask |= 1u64 << card;
    }
    Ok(mask)
}

/// Remaining accounts: `num_players` Light player PDAs followed by in-play
/// `RevealedCard` PDAs (holes `0..2n-1` then board `20..=24`).
///
/// Heap discipline: SBF bump allocator never frees. Allocate one reusable
/// `DEAL_FIELDS` row buffer and stream limbs from RevealedCards — never
/// materialize `9 × 100` field matrices.
pub fn showdown_input_hash_from_accounts<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    pot_mask: u16,
    coefficient_commitment: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let mut in_play = [0u16; 25];
    let n_in_play = fill_poker_in_play_indices(num_players, &mut in_play)?;
    let required_mask = poker_in_play_card_mask(num_players)?;
    let n_seated = num_players as usize;
    require!(
        remaining.len() == n_seated + n_in_play && material.card_filled_bits == required_mask,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );

    let players = &remaining[..n_seated];
    let revealed_cards = &remaining[n_seated..];
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    let deal_hash = hash_deal_25(deck)?;

    let player_keys = read_player_public_keys(players, num_players, game_id, program_id)?;
    let mut padded = [[0u8; 32]; 20];
    for (i, key) in player_keys.iter().enumerate() {
        padded[i * 2] = key[0];
        padded[i * 2 + 1] = key[1];
    }
    for i in n_seated..SHARE_PLAYER_SLOTS {
        padded[i * 2] = identity_x();
        padded[i * 2 + 1] = identity_y();
    }
    let keys_hash = hash_public_keys_10(&padded)?;

    // Circom potMasks[9]: potMasks[0] is the full contestant bitmask; side pots follow.
    // Do NOT expand pot_mask into per-seat bits — that diverges from PokerHashMain / TS.
    let n_pots = SHARE_PLAYER_SLOTS - 1;
    let mut pot_fields = [[0u8; 32]; 9];
    pot_fields[0] = field_from_u128(pot_mask as u128);
    let mut h1_refs: [&[u8]; 9] = [&[]; 9];
    for pot in 0..n_pots {
        h1_refs[pot] = pot_fields[pot].as_slice();
    }
    let h1 = poseidon_fields_be(&h1_refs)?;

    // Unused deal slots + empty-seat rows use the proving player's register padding
    // (matches host remapping of masked-out share partials before showdown prove).
    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;

    let expected_count = (num_players - 1) * 4;
    let poker_pid = casino_cpi::casino_program_id();
    // Single reusable row — bump allocator does not reclaim.
    let mut row = vec![[0u8; 32]; DEAL_FIELDS];
    let mut row_hashes = [[0u8; 32]; SHARE_PLAYER_SLOTS - 1];
    let mut section = 0usize;
    for sharer in 0..SHARE_PLAYER_SLOTS {
        if sharer == material.recipient_index as usize {
            continue;
        }
        // Default every card to register padding, then overwrite in-play RevealedCards.
        for card in 0..TOTAL_CARDS {
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
            for slot in 0..n_in_play {
                let card_index = in_play[slot];
                let dest_start = card_index as usize * 4;
                copy_revealed_section(
                    &revealed_cards[slot],
                    game_id,
                    material.recipient_index,
                    card_index,
                    expected_count,
                    seated_section,
                    &mut row[dest_start..dest_start + 4],
                    &poker_pid,
                )?;
            }
        }
        row_hashes[section] = hash_flat_values_be(&row)?;
        section += 1;
    }

    let mut h3_refs: [&[u8]; SHARE_PLAYER_SLOTS] = [&[]; SHARE_PLAYER_SLOTS];
    h3_refs[0] = deal_hash.as_slice();
    for i in 0..(SHARE_PLAYER_SLOTS - 1) {
        h3_refs[i + 1] = row_hashes[i].as_slice();
    }
    let h3 = poseidon_fields_be(&h3_refs)?;
    let recipient_field = field_from_u128(material.recipient_index as u128);
    require!(
        *coefficient_commitment != [0u8; 32],
        crate::ErrorCode::ShowdownCoefficientCommitmentMissing
    );
    // Circom PokerHashMain: Poseidon([h1, playerIndex, h2, h3, sealCommitment]).
    poseidon_fields_be(&[
        h1.as_slice(),
        recipient_field.as_slice(),
        keys_hash.as_slice(),
        h3.as_slice(),
        coefficient_commitment.as_slice(),
    ])
}
