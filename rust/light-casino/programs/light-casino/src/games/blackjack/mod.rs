use crate::prelude::*;

use super::common::casino_share_input_hash_from_accounts_at;
use crate::deck_state::deck_bytes;
use crate::poseidon_hash::poseidon_fields_be;
use crate::shuffle_hash::{
    field_from_u128, hash_flat_values_be, hash_public_keys_8, identity_x, identity_y,
    read_player_padding, read_player_public_keys,
};
use crate::showdown_hash::{copy_revealed_section, ShowdownMaterialView};
use crate::casino_cpi;

const SHOWDOWN_CARDS: usize = 24;
const BJ_SLOTS: usize = 8;
const MAX_PLAYER_CARDS: u8 = 11;
const MAX_DEALER_CARDS: u8 = 13;

/// Blackjack share chunk: `ShareHashOut(8, 16)` over cards `[chunk*16 .. chunk*16+16)`.
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

pub fn share_input_hash_chunk_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    chunk_index: u8,
) -> Result<[u8; 32]> {
    let start_card = chunk_index as usize * shared_zk_ids::BLACKJACK_CHUNK_SHARE_CARDS as usize;
    casino_share_input_hash_from_accounts_at(
        deck,
        remaining,
        prover_index,
        num_players,
        game_id,
        program_id,
        start_card,
        shared_zk_ids::BLACKJACK_CHUNK_SHARE_CARDS as usize,
        8,
    )
}

/// Blackjack action input hash matching `BlackjackActionHashMain`:
/// `Poseidon(h1, h2, upcardHash, cardCount, canSplit, hitSoft17, isDealer, insuranceEligible, sealCommitment)`.
pub fn action_input_hash(
    h1: &[u8; 32],
    h2: &[u8; 32],
    upcard_hash: &[u8; 32],
    card_count: u8,
    can_split: bool,
    hit_soft_17: bool,
    is_dealer: bool,
    insurance_eligible: bool,
    coefficient_commitment: &[u8; 32],
) -> Result<[u8; 32]> {
    poseidon_fields_be(&[
        h1.as_slice(),
        h2.as_slice(),
        upcard_hash.as_slice(),
        field_from_u128(card_count as u128).as_slice(),
        field_from_u128(can_split as u128).as_slice(),
        field_from_u128(hit_soft_17 as u128).as_slice(),
        field_from_u128(is_dealer as u128).as_slice(),
        field_from_u128(insurance_eligible as u128).as_slice(),
        coefficient_commitment.as_slice(),
    ])
}

/// Blackjack showdown Poseidon matching `BlackjackShowdownHashMain(8, 24)`:
/// `Poseidon(playerCardCount, dealerCardCount, h1, playerIndex, h2)` with
/// `HashPublicKeys(8)` and `Poseidon(8)` over selected one-hand ciphertexts.
///
/// Card counts + `source_indices` come from the recorded action-derived layout
/// (`BlackjackShowdownLayout`); pad slots use shoe index 0 (card-0 ciphertext).
pub fn showdown_input_hash_from_accounts<'info>(
    deck_state: &AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    material: &ShowdownMaterialView,
    game_id: &[u8; 32],
    generation: u64,
    num_players: u8,
    _pot_mask: u16,
    coefficient_commitment: &[u8; 32],
    program_id: &Pubkey,
    player_card_count: u8,
    dealer_card_count: u8,
    source_indices: &[u8; SHOWDOWN_CARDS],
) -> Result<[u8; 32]> {
    require!(
        material.game_id == *game_id
            && material.generation == generation
            && material.recipient_index < num_players
            && material.complete,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    require!(
        *coefficient_commitment != [0u8; 32],
        crate::ErrorCode::ShowdownCoefficientCommitmentMissing
    );
    require!(
        player_card_count >= 2
            && player_card_count <= MAX_PLAYER_CARDS
            && dealer_card_count >= 2
            && dealer_card_count <= MAX_DEALER_CARDS
            && (player_card_count as usize + dealer_card_count as usize) <= SHOWDOWN_CARDS,
        crate::ErrorCode::BlackjackLayoutInvalid
    );
    let used = player_card_count as usize + dealer_card_count as usize;
    let mut required_bits = 0u64;
    for (i, &src) in source_indices.iter().enumerate() {
        if i < used {
            require!(
                (src as usize) < SHOWDOWN_CARDS,
                crate::ErrorCode::BlackjackLayoutInvalid
            );
            required_bits |= 1u64 << src;
        } else {
            // Circom pads unused showdown slots with shoe index 0 ciphertext.
            require!(src == 0, crate::ErrorCode::BlackjackLayoutInvalid);
        }
    }
    // Staged reveals: only used shoe slots (not the full 24-card window).
    require!(
        material.card_filled_bits & required_bits == required_bits,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let n_seated = num_players as usize;
    // Remaining = seated players + only the *used* RevealedCard PDAs (in source
    // order). Full 24-card metas blow the legacy 1232-byte tx limit; pads reuse
    // the used card-0 account, or one trailing card-0 account when card 0 is not
    // part of the hand.
    let pad_account_index = source_indices[..used].iter().position(|src| *src == 0);
    let needs_pad_account = pad_account_index.is_none();
    require!(
        remaining.len() == n_seated + used + needs_pad_account as usize,
        crate::ErrorCode::ShowdownMaterialsNotVerified
    );
    let players = &remaining[..n_seated];
    let revealed_used = &remaining[n_seated..n_seated + used];
    let revealed_pad = if let Some(index) = pad_account_index {
        &revealed_used[index]
    } else {
        &remaining[n_seated + used]
    };
    let deck_data = deck_state.try_borrow_data()?;
    let deck = deck_bytes(&deck_data)?;
    let sources: [usize; SHOWDOWN_CARDS] =
        core::array::from_fn(|i| source_indices[i] as usize);

    let mut deal_fields = Vec::with_capacity(SHOWDOWN_CARDS * 4);
    for &card in &sources {
        let base = card * 4 * 32;
        for limb in 0..4 {
            let start = base + limb * 32;
            let mut value = [0u8; 32];
            value.copy_from_slice(&deck[start..start + 32]);
            deal_fields.push(value);
        }
    }
    let deal_hash = hash_flat_values_be(&deal_fields)?;

    let player_keys = read_player_public_keys(players, num_players, game_id, program_id)?;
    let mut padded = [[0u8; 32]; 16];
    for slot in 0..BJ_SLOTS {
        if slot < player_keys.len() {
            padded[slot * 2] = player_keys[slot][0];
            padded[slot * 2 + 1] = player_keys[slot][1];
        } else {
            padded[slot * 2] = identity_x();
            padded[slot * 2 + 1] = identity_y();
        }
    }
    let keys_hash = hash_public_keys_8(&padded)?;

    let padding = read_player_padding(
        &players[material.recipient_index as usize],
        game_id,
        material.recipient_index,
        program_id,
    )?;
    let expected_count = (num_players - 1) * 4;
    let poker_pid = casino_cpi::casino_program_id();
    let mut row = vec![[0u8; 32]; SHOWDOWN_CARDS * 4];
    let mut row_hashes = [[0u8; 32]; BJ_SLOTS - 1];
    let mut section = 0usize;
    for sharer in 0..BJ_SLOTS {
        if sharer == material.recipient_index as usize {
            continue;
        }
        for card in 0..SHOWDOWN_CARDS {
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
            for sel in 0..SHOWDOWN_CARDS {
                let src_card = sources[sel];
                let revealed = if sel < used {
                    &revealed_used[sel]
                } else {
                    revealed_pad
                };
                copy_revealed_section(
                    revealed,
                    game_id,
                    material.recipient_index,
                    src_card as u16,
                    expected_count,
                    seated_section,
                    &mut row[sel * 4..sel * 4 + 4],
                    &poker_pid,
                )?;
            }
        }
        row_hashes[section] = hash_flat_values_be(&row)?;
        section += 1;
    }

    let mut h2_refs: [&[u8]; BJ_SLOTS] = [&[]; BJ_SLOTS];
    h2_refs[0] = deal_hash.as_slice();
    for i in 0..(BJ_SLOTS - 1) {
        h2_refs[i + 1] = row_hashes[i].as_slice();
    }
    let h2 = poseidon_fields_be(&h2_refs)?;
    let recipient_field = field_from_u128(material.recipient_index as u128);
    poseidon_fields_be(&[
        field_from_u128(player_card_count as u128).as_slice(),
        field_from_u128(dealer_card_count as u128).as_slice(),
        keys_hash.as_slice(),
        recipient_field.as_slice(),
        h2.as_slice(),
        coefficient_commitment.as_slice(),
    ])
}
