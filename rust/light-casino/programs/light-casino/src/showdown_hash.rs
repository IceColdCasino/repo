//! Shared showdown account parsing and fixed-deal Poseidon layouts.
//!
//! Poker’s own showdown hash lives in `games::poker`. This module reads the
//! revealed-card accounts every game uses and hashes the fixed-card casino games.

use crate::prelude::*;

use crate::deck_state::deck_bytes;
use crate::poseidon_hash::poseidon_fields_be;
use crate::shuffle_hash::{
    field_from_u128, hash_flat_values_be, hash_public_keys_12,
    identity_x, identity_y, read_player_padding, read_player_public_keys,
};
use crate::casino_cpi;

const SHOWDOWN_MATERIAL_LEN: usize = 8 + 32 + 8 + 1 + 8 + 1;
// disc + game_id + player_index + n_active + 14×ciphertext + pubkey + nonce
const SEALED_COEFFICIENT_ROWS_OFFSET: usize = 8 + 32 + 1 + 1 + (14 * 32) + 32 + 16;
const SEALED_COEFFICIENT_ROWS: usize = 4;
const SEALED_COEFFICIENT_COMMITMENT_OFFSET: usize =
    SEALED_COEFFICIENT_ROWS_OFFSET + SEALED_COEFFICIENT_ROWS * 32;
const REVEALED_CARD_PARTIALS_OFFSET: usize = 8 + 32 + 8 + 1 + 1 + 1 + 8 + 2 + 32 + 32 + 89;

/// Poseidon of the four subset-sum rows the seal commit revealed.
///
/// That digest is the last input of the showdown hash. Arcis reveals the rows
/// and does not hash them.
pub fn parse_coefficient_commitment(data: &[u8]) -> Result<[u8; 32]> {
    require!(
        data.len() >= SEALED_COEFFICIENT_COMMITMENT_OFFSET + 32,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut rows = [[0u8; 32]; SEALED_COEFFICIENT_ROWS];
    let mut any = false;
    for k in 0..SEALED_COEFFICIENT_ROWS {
        let start = SEALED_COEFFICIENT_ROWS_OFFSET + k * 32;
        rows[k].copy_from_slice(&data[start..start + 32]);
        require!(rows[k][0] >> 5 == 0, crate::ErrorCode::InvalidPublicInputs);
        if rows[k].iter().any(|b| *b != 0) {
            any = true;
        }
    }
    require!(any, crate::ErrorCode::ShowdownCoefficientCommitmentMissing);
    poseidon_fields_be(&[
        rows[0].as_slice(),
        rows[1].as_slice(),
        rows[2].as_slice(),
        rows[3].as_slice(),
    ])
}

pub struct ShowdownMaterialView {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub recipient_index: u8,
    pub card_filled_bits: u64,
    pub complete: bool,
}

/// Decode the fixed Borsh layout of poker's canonical
/// `ShowdownMaterialCommitment` PDA. The caller also verifies the owner and
/// PDA seeds, so a Light account can never substitute an arbitrary coverage
/// registry.
pub fn parse_showdown_material(data: &[u8]) -> Result<ShowdownMaterialView> {
    require!(data.len() >= SHOWDOWN_MATERIAL_LEN, crate::ErrorCode::InvalidPublicInputs);
    let mut game_id = [0u8; 32];
    game_id.copy_from_slice(&data[8..40]);
    let mut generation = [0u8; 8];
    generation.copy_from_slice(&data[40..48]);
    let recipient_index = data[48];
    let mut card_filled_bits = [0u8; 8];
    card_filled_bits.copy_from_slice(&data[49..57]);
    Ok(ShowdownMaterialView {
        game_id,
        generation: u64::from_le_bytes(generation),
        recipient_index,
        card_filled_bits: u64::from_le_bytes(card_filled_bits),
        complete: data[57] != 0,
    })
}

/// Validate RevealedCard PDA and copy one sharer section (4 limbs) into `dest`.
pub(crate) fn copy_revealed_section(
    account: &AccountInfo,
    game_id: &[u8; 32],
    recipient_index: u8,
    card_index: u16,
    expected_count: u8,
    section: usize,
    dest: &mut [[u8; 32]],
    poker_program: &Pubkey,
) -> Result<()> {
    require!(dest.len() == 4, crate::ErrorCode::ShowdownMaterialsNotVerified);
    require_keys_eq!(account.owner(), *poker_program, crate::ErrorCode::ShowdownMaterialsNotVerified);
    let (expected, _) = Pubkey::find_program_address(
        &[b"RevealedCard", game_id, &[recipient_index], &card_index.to_le_bytes()],
        poker_program,
    );
    require_keys_eq!(account.key(), expected, crate::ErrorCode::ShowdownMaterialsNotVerified);
    let data = account.try_borrow_data()?;
    // Skip RevealedCard.generation: poker stamps `async_generation` at first write
    // (street-varying). Showdown material / proof receipt use Light game generation.
    require!(
        data.len() >= REVEALED_CARD_PARTIALS_OFFSET + expected_count as usize * 32
            && data[8..40] == game_id[..]
            && data[48] == recipient_index
            && data[49] == expected_count
            && data[50] == expected_count
            && u64::from_le_bytes(data[51..59].try_into().unwrap())
                == (1u64 << expected_count) - 1
            && u16::from_le_bytes(data[59..61].try_into().unwrap()) == card_index,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let base = REVEALED_CARD_PARTIALS_OFFSET + section * 4 * 32;
    require!(
        data.len() >= base + 4 * 32,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    for limb in 0..4 {
        let start = base + limb * 32;
        dest[limb].copy_from_slice(&data[start..start + 32]);
    }
    Ok(())
}

/// Legacy helper kept for casino fixed-deal paths that still return owned limbs.
pub fn revealed_card_partials(
    account: &AccountInfo,
    game_id: &[u8; 32],
    generation: u64,
    recipient_index: u8,
    card_index: u16,
    expected_count: u8,
    poker_program: &Pubkey,
) -> Result<Vec<[u8; 32]>> {
    let _ = generation;
    require_keys_eq!(account.owner(), *poker_program, crate::ErrorCode::ShowdownMaterialsNotVerified);
    let (expected, _) = Pubkey::find_program_address(
        &[b"RevealedCard", game_id, &[recipient_index], &card_index.to_le_bytes()],
        poker_program,
    );
    require_keys_eq!(account.key(), expected, crate::ErrorCode::ShowdownMaterialsNotVerified);
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= REVEALED_CARD_PARTIALS_OFFSET + expected_count as usize * 32
            && data[8..40] == game_id[..]
            && data[48] == recipient_index
            && data[49] == expected_count
            && data[50] == expected_count
            && u64::from_le_bytes(data[51..59].try_into().unwrap())
                == (1u64 << expected_count) - 1
            && u16::from_le_bytes(data[59..61].try_into().unwrap()) == card_index,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let mut partials = Vec::with_capacity(expected_count as usize);
    for limb in 0..expected_count as usize {
        let start = REVEALED_CARD_PARTIALS_OFFSET + limb * 32;
        let mut value = [0u8; 32];
        value.copy_from_slice(&data[start..start + 32]);
        partials.push(value);
    }
    Ok(partials)
}

/// Casino / fixed-deal showdown Poseidon for baccarat/war.
///
/// Matches Circom `HashMain(12, N)` / TS `showdownHash`:
/// `Poseidon(HashPublicKeys(12), playerIndex, Poseidon([deal, …11 partial rows]))`.
/// Coefficient commitment is authenticated separately (must be non-zero); pot_mask
/// is unused (no potMasks in casino HashMain).
pub fn showdown_input_hash_fixed_cards<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    pot_mask: u16,
    coefficient_commitment: &[u8; 32],
    program_id: &Pubkey,
    n_total_cards: usize,
) -> Result<[u8; 32]> {
    let _ = pot_mask;
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    const CASINO_SLOTS: usize = 12;
    let n_seated = num_players as usize;
    require!(
        n_total_cards > 0
            && n_total_cards <= 64
            && remaining.len() == n_seated + n_total_cards
            && material.card_filled_bits == (1u64 << n_total_cards) - 1,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    require!(
        *coefficient_commitment != [0u8; 32],
        crate::ErrorCode::ShowdownCoefficientCommitmentMissing
    );
    let players = &remaining[..n_seated];
    let revealed_cards = &remaining[n_seated..];
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    let deal_hash = crate::shuffle_hash::hash_flat_bytes_be(&deck[..n_total_cards * 4 * 32])?;
    let player_keys = read_player_public_keys(players, num_players, game_id, program_id)?;
    let mut padded = [[0u8; 32]; 24];
    for slot in 0..CASINO_SLOTS {
        if slot < n_seated {
            padded[slot * 2] = player_keys[slot][0];
            padded[slot * 2 + 1] = player_keys[slot][1];
        } else {
            padded[slot * 2] = identity_x();
            padded[slot * 2 + 1] = identity_y();
        }
    }
    let keys_hash = hash_public_keys_12(&padded)?;

    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;
    let expected_count = (num_players - 1) * 4;
    let poker_pid = casino_cpi::casino_program_id();
    // One reusable row buffer — SBF bump allocator does not free.
    let mut row = vec![[0u8; 32]; n_total_cards * 4];
    let mut row_hashes = [[0u8; 32]; CASINO_SLOTS - 1];
    let mut section = 0usize;
    for sharer in 0..CASINO_SLOTS {
        if sharer == material.recipient_index as usize {
            continue;
        }
        for card in 0..n_total_cards {
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
            for (card_index, account) in revealed_cards.iter().enumerate() {
                copy_revealed_section(
                    account,
                    game_id,
                    material.recipient_index,
                    card_index as u16,
                    expected_count,
                    seated_section,
                    &mut row[card_index * 4..card_index * 4 + 4],
                    &poker_pid,
                )?;
            }
        }
        row_hashes[section] = hash_flat_values_be(&row)?;
        section += 1;
    }

    let mut h2_refs: [&[u8]; CASINO_SLOTS] = [&[]; CASINO_SLOTS];
    h2_refs[0] = deal_hash.as_slice();
    for i in 0..(CASINO_SLOTS - 1) {
        h2_refs[i + 1] = row_hashes[i].as_slice();
    }
    let h2 = poseidon_fields_be(&h2_refs)?;
    let recipient_field = field_from_u128(material.recipient_index as u128);
    // Circom HashMain: Poseidon([h1=keys, playerIndex, h2, sealCommitment]).
    poseidon_fields_be(&[
        keys_hash.as_slice(),
        recipient_field.as_slice(),
        h2.as_slice(),
        coefficient_commitment.as_slice(),
    ])
}

/// Betting showdown: `Poseidon(h1, playerIndex, h2, extra...)`.
///
/// `extra` is typically `betHash` and optionally `nActualBets` or a table bind.
pub fn showdown_input_hash_fixed_cards_with_bind<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    program_id: &Pubkey,
    n_total_cards: usize,
    player_slots: usize,
    extra: &[&[u8]],
    deal_card_indices: Option<&[usize]>,
    seal_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete
            && material.card_filled_bits == (1u64 << n_total_cards) - 1,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    require!(
        player_slots == 2 || player_slots == 12,
        crate::ErrorCode::InvalidGameConfig
    );
    let n_seated = num_players as usize;
    require!(
        n_total_cards > 0
            && n_total_cards <= 64
            && remaining.len() == n_seated + n_total_cards
            && extra.len() <= 4,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );

    let players = &remaining[..n_seated];
    let revealed_cards = &remaining[n_seated..];
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    let deal_hash = if let Some(indices) = deal_card_indices {
        require!(
            indices.len() == n_total_cards,
            crate::ErrorCode::ShowdownMaterialsNotVerified
        );
        crate::games::common::hash_deal_selected_cards(deck, indices)?
    } else {
        crate::shuffle_hash::hash_flat_bytes_be(&deck[..n_total_cards * 4 * 32])?
    };
    let player_keys = read_player_public_keys(players, num_players, game_id, program_id)?;

    let keys_hash = if player_slots == 2 {
        require!(n_seated == 2, crate::ErrorCode::InvalidNumPlayers);
        let mut padded = [[0u8; 32]; 4];
        padded[0] = player_keys[0][0];
        padded[1] = player_keys[0][1];
        padded[2] = player_keys[1][0];
        padded[3] = player_keys[1][1];
        crate::shuffle_hash::hash_public_keys_2(&padded)?
    } else {
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
        hash_public_keys_12(&padded)?
    };

    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;
    let expected_count = (num_players - 1) * 4;
    let poker_pid = casino_cpi::casino_program_id();
    let mut row = vec![[0u8; 32]; n_total_cards * 4];
    let others = player_slots - 1;
    let mut row_hashes = vec![[0u8; 32]; others];
    let mut section = 0usize;
    for sharer in 0..player_slots {
        if sharer == material.recipient_index as usize {
            continue;
        }
        for card in 0..n_total_cards {
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
            for (card_index, account) in revealed_cards.iter().enumerate() {
                copy_revealed_section(
                    account,
                    game_id,
                    material.recipient_index,
                    card_index as u16,
                    expected_count,
                    seated_section,
                    &mut row[card_index * 4..card_index * 4 + 4],
                    &poker_pid,
                )?;
            }
        }
        row_hashes[section] = hash_flat_values_be(&row)?;
        section += 1;
    }

    bind_showdown_hash(
        &deal_hash,
        &keys_hash,
        material.recipient_index,
        &row_hashes,
        extra,
        seal_commitment,
    )
}

/// Seat index, in the 12-wide circuit, of non-recipient row `row_index`.
pub fn sharer_for_row(player_slots: usize, recipient: usize, row_index: usize) -> Result<usize> {
    let mut section = 0usize;
    for sharer in 0..player_slots {
        if sharer == recipient {
            continue;
        }
        if section == row_index {
            return Ok(sharer);
        }
        section += 1;
    }
    err!(crate::ErrorCode::InvalidPublicInputs)
}

/// Poseidon hash of one showdown share row.
///
/// A seated sharer reads `n_total_cards` revealed-card accounts. A padding slot
/// hashes the recipient padding alone, and that hash is identical for every
/// empty slot.
pub fn hash_one_fixed_card_row<'info>(
    padding_account: &AccountInfo<'info>,
    revealed_cards: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    num_players: u8,
    program_id: &Pubkey,
    n_total_cards: usize,
    player_slots: usize,
    row_index: u8,
) -> Result<[u8; 32]> {
    require!(
        player_slots == 12 && n_total_cards > 0 && n_total_cards <= 64,
        crate::ErrorCode::InvalidGameConfig
    );
    let n_seated = num_players as usize;
    require!(
        (row_index as usize) < player_slots - 1
            && material.recipient_index < num_players
            && material.complete,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let sharer = sharer_for_row(player_slots, material.recipient_index as usize, row_index as usize)?;
    let padding = read_player_padding(
        padding_account,
        game_id,
        material.recipient_index,
        program_id,
    )?;
    let mut row = vec![[0u8; 32]; n_total_cards * 4];
    for card in 0..n_total_cards {
        row[card * 4..card * 4 + 4].copy_from_slice(&padding);
    }
    if sharer < n_seated {
        require!(
            revealed_cards.len() == n_total_cards,
            crate::ErrorCode::ShowdownMaterialsNotVerified
        );
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
        let expected_count = (num_players - 1) * 4;
        let poker_pid = casino_cpi::casino_program_id();
        for (card_index, account) in revealed_cards.iter().enumerate() {
            copy_revealed_section(
                account,
                game_id,
                material.recipient_index,
                card_index as u16,
                expected_count,
                seated_section,
                &mut row[card_index * 4..card_index * 4 + 4],
                &poker_pid,
            )?;
        }
    } else {
        require!(
            revealed_cards.is_empty(),
            crate::ErrorCode::ShowdownMaterialsNotVerified
        );
    }
    hash_flat_values_be(&row)
}

/// Same bind as `showdown_input_hash_fixed_cards_with_bind`, with row hashes
/// already staged. `players` is the seated player PDAs only.
pub fn showdown_input_hash_from_staged_rows<'info>(
    deck_state: &AccountInfo<'info>,
    players: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    program_id: &Pubkey,
    n_total_cards: usize,
    player_slots: usize,
    row_hashes: &[[u8; 32]],
    extra: &[&[u8]],
    seal_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete
            && material.card_filled_bits == (1u64 << n_total_cards) - 1,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    require!(player_slots == 12, crate::ErrorCode::InvalidGameConfig);
    let n_seated = num_players as usize;
    require!(
        players.len() == n_seated && row_hashes.len() == player_slots - 1 && extra.len() <= 4,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    let deal_hash = crate::shuffle_hash::hash_flat_bytes_be(&deck[..n_total_cards * 4 * 32])?;
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
    bind_showdown_hash(
        &deal_hash,
        &keys_hash,
        material.recipient_index,
        row_hashes,
        extra,
        seal_commitment,
    )
}

fn bind_showdown_hash(
    deal_hash: &[u8; 32],
    keys_hash: &[u8; 32],
    recipient_index: u8,
    row_hashes: &[[u8; 32]],
    extra: &[&[u8]],
    seal_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    let mut h2_refs: Vec<&[u8]> = Vec::with_capacity(1 + row_hashes.len());
    h2_refs.push(deal_hash.as_slice());
    for row in row_hashes {
        h2_refs.push(row.as_slice());
    }
    let h2 = poseidon_fields_be(&h2_refs)?;
    let recipient_field = field_from_u128(recipient_index as u128);
    let mut refs: Vec<&[u8]> = Vec::with_capacity(4 + extra.len());
    refs.push(keys_hash.as_slice());
    refs.push(recipient_field.as_slice());
    refs.push(h2.as_slice());
    refs.extend_from_slice(extra);
    refs.push(seal_commitment.as_slice());
    poseidon_fields_be(&refs)
}

