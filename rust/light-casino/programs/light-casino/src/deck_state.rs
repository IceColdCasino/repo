//! Temporary deck staging for Poseidon shuffle/share/showdown input hashes.
//!
//! After each shuffle verify, the output deck is copied here for the next
//! player's input-hash check. The account grows to this table's shoe. The
//! 8-deck size is the ceiling.

use crate::prelude::*;
use shared_zk_ids::MAX_DECK_FIELDS;

/// Max flattened deck public outputs across supported games (8 × 52 × 4).
pub const SHUFFLE_DECK_FIELDS: usize = MAX_DECK_FIELDS;
pub const SHUFFLE_DECK_BYTES: usize = SHUFFLE_DECK_FIELDS * 32;

pub const DECK_STATE_ACCOUNT_SIZE: usize = 8 + SHUFFLE_DECK_BYTES;

/// Byte length of `deck_state` for this table's shoe.
pub fn account_size(deck_fields: usize) -> Result<usize> {
    require!(
        deck_fields > 0 && deck_fields <= SHUFFLE_DECK_FIELDS,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(DATA_OFFSET + deck_fields * 32)
}

const DATA_OFFSET: usize = 8;

pub fn write_deck_chunk(data: &mut [u8], offset: u16, chunk: &[u8]) -> Result<()> {
    require!(chunk.len() % 32 == 0, crate::ErrorCode::InvalidPublicInputs);
    let start = offset as usize * 32;
    let end = start + chunk.len();
    require!(end <= SHUFFLE_DECK_BYTES, crate::ErrorCode::InvalidPublicInputs);
    require!(
        DATA_OFFSET + end <= data.len(),
        crate::ErrorCode::InvalidPublicInputs
    );
    data[DATA_OFFSET + start..DATA_OFFSET + end].copy_from_slice(chunk);
    Ok(())
}

pub fn deck_bytes(data: &[u8]) -> Result<&[u8]> {
    require!(
        data.len() > DATA_OFFSET,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[DATA_OFFSET..])
}

/// Active deck slice for `deck_fields` field elements (config-driven).
pub fn active_deck_bytes(data: &[u8], deck_fields: usize) -> Result<&[u8]> {
    let need = account_size(deck_fields)?;
    require!(
        data.len() >= need,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[DATA_OFFSET..need])
}

pub fn copy_deck_from_public_inputs(
    deck_data: &mut [u8],
    inputs: &[[u8; 32]],
    deck_fields: usize,
) -> Result<()> {
    let need = account_size(deck_fields)?;
    require!(
        deck_data.len() >= need,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        inputs.len() >= deck_fields,
        crate::ErrorCode::InvalidPublicInputs
    );
    for i in 0..deck_fields {
        deck_data[DATA_OFFSET + i * 32..DATA_OFFSET + (i + 1) * 32].copy_from_slice(&inputs[i]);
    }
    Ok(())
}
