use crate::prelude::*;

use super::common::casino_share_input_hash_from_accounts_at;
use crate::casino_cpi;
use crate::deck_state::deck_bytes;
use crate::poseidon_hash::poseidon_fields_be;
use crate::showdown_hash::{copy_revealed_section, ShowdownMaterialView};
use crate::shuffle_hash::{
    field_from_u128, hash_flat_values_be, hash_public_keys_12, identity_x, identity_y,
    read_player_padding, read_player_public_keys,
};

pub const BINGO_SHARE_SLOTS: usize = 12;

/// Bingo share chunk: `ShareHashOut(12, 5)` over shoe `[chunk*5 .. chunk*5+5)`.
pub fn share_input_hash_chunk_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    chunk_index: u8,
) -> Result<[u8; 32]> {
    let start_card = chunk_index as usize * shared_zk_ids::BINGO_CHUNK_BALLS as usize;
    casino_share_input_hash_from_accounts_at(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        start_card,
        shared_zk_ids::BINGO_CHUNK_BALLS as usize,
        BINGO_SHARE_SLOTS,
    )
}

pub fn share_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    _deck_fields: usize,
) -> Result<[u8; 32]> {
    share_input_hash_chunk_from_accounts(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        0,
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

/// Uncalled shoe slots are Base8||Base8, not the identity point. PartialDecrypt
/// rejects c0.x = 0, and the prover pads those slots with Base8.
fn pad_ciphertext() -> [[u8; 32]; 4] {
    const X: [u8; 32] = [
        11, 183, 122, 106, 214, 62, 115, 155, 78, 172, 178, 224, 157, 98, 119, 193,
        42, 184, 216, 1, 5, 52, 224, 182, 40, 147, 243, 246, 187, 149, 112, 81,
    ];
    const Y: [u8; 32] = [
        37, 121, 114, 3, 247, 160, 178, 73, 37, 87, 46, 28, 209, 107, 249, 237,
        252, 224, 5, 31, 185, 225, 51, 119, 75, 60, 37, 122, 135, 45, 125, 139,
    ];
    [X, Y, X, Y]
}

/// One `HashCiphertexts(nMax)` row. Index 0 is the called-ball shoe. Indices 1..11
/// are the non-recipient share rows in seat order. A 75-ball row is ~400k CU, so
/// the on-chain path stores these one transaction at a time.
pub fn hash_showdown_row<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    n_called: u64,
    n_max: usize,
    program_id: &Pubkey,
    row_index: u8,
) -> Result<[u8; 32]> {
    let prepared = prepare_showdown_rows(
        deck_state,
        remaining,
        material,
        game_id,
        generation,
        num_players,
        n_called,
        n_max,
        program_id,
        row_index == 0,
    )?;
    if row_index == 0 {
        return Ok(prepared.deal_hash);
    }
    let want = row_index as usize - 1;
    require!(want < BINGO_SHARE_SLOTS - 1, crate::ErrorCode::InvalidPublicInputs);
    let mut section = 0usize;
    for sharer in 0..BINGO_SHARE_SLOTS {
        if sharer == material.recipient_index as usize {
            continue;
        }
        if section == want {
            return hash_partial_row(&prepared, sharer, &remaining[prepared.n_seated..]);
        }
        section += 1;
    }
    err!(crate::ErrorCode::InvalidPublicInputs)
}

/// 75: `Poseidon(h1, playerIndex, h2, cardHash, patternId, nCalled, sealCommitment)`
/// 90: `Poseidon(h1, playerIndex, h2, cardHash, nCalled, sealCommitment)`
pub fn showdown_hash_from_rows<'info>(
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    num_players: u8,
    card_hash: &[u8; 32],
    pattern_id: Option<u64>,
    n_called: u64,
    row_hashes: &[[u8; 32]; 12],
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let n_seated = num_players as usize;
    require!(
        remaining.len() >= n_seated,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let players = &remaining[..n_seated];
    let player_keys = read_player_public_keys(players, num_players, game_id, program_id)?;
    let mut padded = [[0u8; 32]; 24];
    for slot in 0..12 {
        if slot < n_seated {
            padded[slot * 2] = player_keys[slot][0];
            padded[slot * 2 + 1] = player_keys[slot][1];
        } else {
            padded[slot * 2] = identity_x();
            padded[slot * 2 + 1] = identity_y();
        }
    }
    let keys_hash = hash_public_keys_12(&padded)?;
    let mut h2_refs: Vec<&[u8]> = Vec::with_capacity(BINGO_SHARE_SLOTS);
    for row in row_hashes {
        h2_refs.push(row.as_slice());
    }
    let h2 = poseidon_fields_be(&h2_refs)?;
    let recipient_field = field_from_u128(material.recipient_index as u128);
    let pattern_field = field_from_u128(pattern_id.unwrap_or(0) as u128);
    let n_called_field = field_from_u128(n_called as u128);
    if pattern_id.is_some() {
        poseidon_fields_be(&[
            keys_hash.as_slice(),
            recipient_field.as_slice(),
            h2.as_slice(),
            card_hash.as_slice(),
            pattern_field.as_slice(),
            n_called_field.as_slice(),
            coefficient_commitment.as_slice(),
        ])
    } else {
        poseidon_fields_be(&[
            keys_hash.as_slice(),
            recipient_field.as_slice(),
            h2.as_slice(),
            card_hash.as_slice(),
            n_called_field.as_slice(),
            coefficient_commitment.as_slice(),
        ])
    }
}

struct PreparedRows {
    deal_hash: [u8; 32],
    n_max: usize,
    n_seated: usize,
    recipient: usize,
    padding: [[u8; 32]; 4],
    game_id: [u8; 32],
    expected_count: u8,
    poker_pid: Pubkey,
}

fn prepare_showdown_rows<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    n_called: u64,
    n_max: usize,
    program_id: &Pubkey,
    hash_deal: bool,
    ) -> Result<PreparedRows> {
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    require!(
        n_called > 0 && (n_called as usize) <= n_max && (n_max == 75 || n_max == 90),
        crate::ErrorCode::InvalidPublicInputs
    );
    let n_called_usize = n_called as usize;
    if n_called_usize <= 64 {
        require!(
            material.card_filled_bits == (1u64 << n_called_usize) - 1,
            crate::ErrorCode::ShowdownMaterialsNotVerified
        );
    }
    let n_seated = num_players as usize;
    require!(
        remaining.len() == n_seated + n_called_usize,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );

    let players = &remaining[..n_seated];
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    require!(
        deck.len() >= n_max * 4 * 32,
        crate::ErrorCode::InvalidPublicInputs
    );

    let pad = pad_ciphertext();
    let deal_hash = if hash_deal {
        let mut deal = vec![0u8; n_max * 4 * 32];
        deal[..n_called_usize * 4 * 32].copy_from_slice(&deck[..n_called_usize * 4 * 32]);
        for card in n_called_usize..n_max {
            for (k, limb) in pad.iter().enumerate() {
                let dest = (card * 4 + k) * 32;
                deal[dest..dest + 32].copy_from_slice(limb);
            }
        }
        crate::shuffle_hash::hash_flat_bytes_be(&deal)?
    } else {
        [0u8; 32]
    };
    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;
    Ok(PreparedRows {
        deal_hash,
        n_max,
        n_seated,
        recipient: material.recipient_index as usize,
        padding,
        game_id: *game_id,
        expected_count: (num_players - 1) * 4,
        poker_pid: casino_cpi::casino_program_id(),
    })
}

fn hash_partial_row<'info>(
    prepared: &PreparedRows,
    sharer: usize,
    revealed_cards: &[AccountInfo<'info>],
) -> Result<[u8; 32]> {
    let mut row = vec![[0u8; 32]; prepared.n_max * 4];
    for card in 0..prepared.n_max {
        row[card * 4..card * 4 + 4].copy_from_slice(&prepared.padding);
    }
    if sharer < prepared.n_seated {
        let mut seated_section = 0usize;
        for sh in 0..prepared.n_seated {
            if sh == prepared.recipient {
                continue;
            }
            if sh == sharer {
                break;
            }
            seated_section += 1;
        }
        for (card_index, account) in revealed_cards.iter().enumerate() {
            copy_revealed_section(
                account,
                &prepared.game_id,
                prepared.recipient as u8,
                card_index as u16,
                prepared.expected_count,
                seated_section,
                &mut row[card_index * 4..card_index * 4 + 4],
                &prepared.poker_pid,
            )?;
        }
    }
    hash_flat_values_be(&row)
}

/// Hash 75/90 showdown slots: called prefix from the shoe, unused slots identity-padded.
/// Partials: revealed compact `0..nCalled-1`, unused slots use the prover register pad.
pub fn showdown_input_hash<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    card_hash: &[u8; 32],
    pattern_id: Option<u64>,
    n_called: u64,
    n_max: usize,
    program_id: &Pubkey,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let mut row_hashes = [[0u8; 32]; 12];
    for row in 0..12u8 {
        row_hashes[row as usize] = hash_showdown_row(
            deck_state,
            remaining,
            material,
            game_id,
            generation,
            num_players,
            n_called,
            n_max,
            program_id,
            row,
        )?;
    }
    showdown_hash_from_rows(
        remaining,
        material,
        game_id,
        num_players,
        card_hash,
        pattern_id,
        n_called,
        &row_hashes,
        program_id,
        coefficient_commitment,
    )
}
