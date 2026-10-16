//! Shared helpers for non-poker card-game share hashes.
//!
//! Circom `ShareHashOut(nPlayers, nCards)` / TS `shareHash`:
//! Poseidon(hashCiphertexts(deal), hashPublicKeys(ordered)).
//! `nActualPlayers` is private and bound via PK identity constraints.

use crate::prelude::*;

use crate::poseidon_hash::poseidon_fields_be;
use crate::shuffle_hash::{
    hash_flat_bytes_be, hash_public_keys_12, identity_x, identity_y, read_player_public_keys,
};

pub fn hash_deal_fields(deck: &[u8], deal_fields: usize) -> Result<[u8; 32]> {
    hash_deal_fields_at(deck, 0, deal_fields)
}

/// Hash `deal_fields` ElGamal limbs starting at card `start_card` (4 limbs/card).
pub fn hash_deal_fields_at(deck: &[u8], start_card: usize, deal_cards: usize) -> Result<[u8; 32]> {
    let deal_fields = deal_cards * 4;
    let start = start_card * 4 * 32;
    let end = start + deal_fields * 32;
    require!(
        deal_fields > 0 && deck.len() >= end,
        crate::ErrorCode::InvalidPublicInputs
    );
    hash_flat_bytes_be(&deck[start..end])
}

/// Hash selected shoe cards in circuit order (4 ElGamal limbs each).
pub fn hash_deal_selected_cards(deck: &[u8], card_indices: &[usize]) -> Result<[u8; 32]> {
    require!(
        !card_indices.is_empty() && card_indices.len() <= shared_zk_ids::MAX_SHARE_DEAL_INDICES,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut buf = vec![0u8; card_indices.len() * 4 * 32];
    for (i, &idx) in card_indices.iter().enumerate() {
        let start = idx * 4 * 32;
        let end = start + 4 * 32;
        require!(deck.len() >= end, crate::ErrorCode::InvalidPublicInputs);
        let dest = i * 4 * 32;
        buf[dest..dest + 4 * 32].copy_from_slice(&deck[start..end]);
    }
    hash_flat_bytes_be(&buf)
}

fn pad_keys_12(keys: &[[[u8; 32]; 2]]) -> [[u8; 32]; 24] {
    let mut out = [[0u8; 32]; 24];
    for slot in 0..12 {
        if slot < keys.len() {
            out[slot * 2] = keys[slot][0];
            out[slot * 2 + 1] = keys[slot][1];
        } else {
            out[slot * 2] = identity_x();
            out[slot * 2 + 1] = identity_y();
        }
    }
    out
}

/// Slots hashes the two seated keys. Shuffle requires both, so there is no identity pad.
fn order_two_keys(keys: &[[[u8; 32]; 2]], prover_index: u8) -> Result<[[u8; 32]; 4]> {
    require!(keys.len() == 2, crate::ErrorCode::InvalidNumPlayers);
    require!((prover_index as usize) < 2, crate::ErrorCode::InvalidPlayerIndex);
    let other = 1 - prover_index as usize;
    Ok([
        keys[prover_index as usize][0],
        keys[prover_index as usize][1],
        keys[other][0],
        keys[other][1],
    ])
}

fn pad_keys_8(keys: &[[[u8; 32]; 2]]) -> [[u8; 32]; 16] {
    let mut out = [[0u8; 32]; 16];
    for slot in 0..8 {
        if slot < keys.len() {
            out[slot * 2] = keys[slot][0];
            out[slot * 2 + 1] = keys[slot][1];
        } else {
            out[slot * 2] = identity_x();
            out[slot * 2 + 1] = identity_y();
        }
    }
    out
}

fn order_prover_first_8(padded: &[[u8; 32]; 16], prover_index: u8) -> Result<[[u8; 32]; 16]> {
    require!((prover_index as usize) < 8, crate::ErrorCode::InvalidPlayerIndex);
    let mut ordered = [[0u8; 32]; 16];
    ordered[0] = padded[prover_index as usize * 2];
    ordered[1] = padded[prover_index as usize * 2 + 1];
    let mut dst = 1usize;
    for slot in 0..8 {
        if slot == prover_index as usize {
            continue;
        }
        ordered[dst * 2] = padded[slot * 2];
        ordered[dst * 2 + 1] = padded[slot * 2 + 1];
        dst += 1;
    }
    Ok(ordered)
}

fn order_prover_first_12(padded: &[[u8; 32]; 24], prover_index: u8) -> Result<[[u8; 32]; 24]> {
    require!((prover_index as usize) < 12, crate::ErrorCode::InvalidPlayerIndex);
    let mut ordered = [[0u8; 32]; 24];
    ordered[0] = padded[prover_index as usize * 2];
    ordered[1] = padded[prover_index as usize * 2 + 1];
    let mut dst = 1usize;
    for slot in 0..12 {
        if slot == prover_index as usize {
            continue;
        }
        ordered[dst * 2] = padded[slot * 2];
        ordered[dst * 2 + 1] = padded[slot * 2 + 1];
        dst += 1;
    }
    Ok(ordered)
}

pub fn casino_share_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    deal_cards: usize,
    player_slots: usize,
) -> Result<[u8; 32]> {
    casino_share_input_hash_from_accounts_at(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        0,
        deal_cards,
        player_slots,
    )
}

pub fn casino_share_input_hash_from_accounts_at<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    start_card: usize,
    deal_cards: usize,
    player_slots: usize,
) -> Result<[u8; 32]> {
    require!(
        (2..=12).contains(&num_players),
        crate::ErrorCode::InvalidNumPlayers
    );
    require!(
        (prover_index as usize) < num_players as usize,
        crate::ErrorCode::InvalidPlayerIndex
    );
    let ct_hash = hash_deal_fields_at(deck, start_card, deal_cards)?;
    share_input_hash_from_ct(ct_hash, remaining, prover_index, num_players, game_id, program_id, player_slots)
}

/// Share input hash using sparse shoe indices (craps die centers, slot reel centers).
pub fn casino_share_input_hash_from_selected<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    card_indices: &[usize],
    player_slots: usize,
) -> Result<[u8; 32]> {
    require!(
        (2..=12).contains(&num_players),
        crate::ErrorCode::InvalidNumPlayers
    );
    require!(
        (prover_index as usize) < num_players as usize,
        crate::ErrorCode::InvalidPlayerIndex
    );
    let ct_hash = hash_deal_selected_cards(deck, card_indices)?;
    share_input_hash_from_ct(ct_hash, remaining, prover_index, num_players, game_id, program_id, player_slots)
}

fn share_input_hash_from_ct<'info>(
    ct_hash: [u8; 32],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    player_slots: usize,
) -> Result<[u8; 32]> {
    let keys = read_player_public_keys(remaining, num_players, game_id, program_id)?;
    let pk_hash = if player_slots == 2 {
        let ordered = order_two_keys(&keys, prover_index)?;
        crate::shuffle_hash::hash_public_keys_2(&ordered)?
    } else if player_slots == 8 {
        let padded = pad_keys_8(&keys);
        let ordered = order_prover_first_8(&padded, prover_index)?;
        crate::shuffle_hash::hash_public_keys_8(&ordered)?
    } else {
        require!(player_slots == 12, crate::ErrorCode::InvalidNumPlayers);
        let padded = pad_keys_12(&keys);
        let ordered = order_prover_first_12(&padded, prover_index)?;
        hash_public_keys_12(&ordered)?
    };
    // nActualPlayers is private and bound via PK identity constraints, not Poseidon.
    poseidon_fields_be(&[ct_hash.as_slice(), pk_hash.as_slice()])
}
