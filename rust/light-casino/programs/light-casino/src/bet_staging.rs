//! Split-game bet public-input staging (craps/keno/roulette).
//!
//! All Groth16 publics are caller-staged (encrypted bet limbs + input hash).
//! Max keno = 161 fields. PDA fits in one 10 KiB alloc.

use crate::prelude::*;
use shared_zk_ids::KENO_BET_PUBLIC_INPUTS;

pub const BET_MAX_PUBLIC_INPUTS: usize = KENO_BET_PUBLIC_INPUTS;
pub const BET_CIRCUIT_VERSION: u16 = 1;

pub const BET_INPUTS_HEADER_SIZE: usize = 8 + 32 + 8 + 1 + 2;
pub const PREPARED_G1_SIZE: usize = 64;
pub const PREPARED_COUNT_SIZE: usize = 2;
pub const FILL_MASK_BYTES: usize = (BET_MAX_PUBLIC_INPUTS + 7) / 8;
pub const PREPARE_INPUTS_PER_TX: u16 = 16;
pub const MAX_PREPARE_CHUNKS: usize =
    (BET_MAX_PUBLIC_INPUTS + PREPARE_INPUTS_PER_TX as usize - 1)
        / PREPARE_INPUTS_PER_TX as usize;
pub const PREPARE_MASK_BYTES: usize = (MAX_PREPARE_CHUNKS + 7) / 8;
pub const PARTIAL_G1_BYTES: usize = MAX_PREPARE_CHUNKS * PREPARED_G1_SIZE;

const GENERATION_OFFSET: usize = 8 + 32;
const PLAYER_INDEX_OFFSET: usize = GENERATION_OFFSET + 8;
const COUNT_OFFSET: usize = PLAYER_INDEX_OFFSET + 1;
pub const PREPARED_G1_OFFSET: usize =
    BET_INPUTS_HEADER_SIZE + 32 * BET_MAX_PUBLIC_INPUTS;
pub const PREPARED_COUNT_OFFSET: usize = PREPARED_G1_OFFSET + PREPARED_G1_SIZE;
pub const FILL_MASK_OFFSET: usize = PREPARED_COUNT_OFFSET + PREPARED_COUNT_SIZE;
pub const PREPARE_MASK_OFFSET: usize = FILL_MASK_OFFSET + FILL_MASK_BYTES;
pub const PARTIAL_G1_OFFSET: usize = PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES;
pub const BET_INPUTS_ACCOUNT_SIZE: usize = PARTIAL_G1_OFFSET + PARTIAL_G1_BYTES;

fn bit_is_set(mask: &[u8], i: usize) -> bool {
    (mask[i / 8] & (1 << (i % 8))) != 0
}

fn set_bit(mask: &mut [u8], i: usize) {
    mask[i / 8] |= 1 << (i % 8);
}

pub fn read_count(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= BET_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(u16::from_le_bytes(
        data[COUNT_OFFSET..COUNT_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

fn write_count(data: &mut [u8], count: u16) -> Result<()> {
    require!(
        data.len() >= BET_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[COUNT_OFFSET..COUNT_OFFSET + 2].copy_from_slice(&count.to_le_bytes());
    Ok(())
}

pub fn read_prepared_count(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(u16::from_le_bytes(
        data[PREPARED_COUNT_OFFSET..PREPARED_COUNT_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

pub fn write_prepared_count(data: &mut [u8], count: u16) -> Result<()> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[PREPARED_COUNT_OFFSET..PREPARED_COUNT_OFFSET + 2]
        .copy_from_slice(&count.to_le_bytes());
    Ok(())
}

fn fill_mask_mut(data: &mut [u8]) -> Result<&mut [u8]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[FILL_MASK_OFFSET..FILL_MASK_OFFSET + FILL_MASK_BYTES])
}

fn fill_mask_ref(data: &[u8]) -> Result<&[u8]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[FILL_MASK_OFFSET..FILL_MASK_OFFSET + FILL_MASK_BYTES])
}

fn prepare_mask_mut(data: &mut [u8]) -> Result<&mut [u8]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[PREPARE_MASK_OFFSET..PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES])
}

fn prepare_mask_ref(data: &[u8]) -> Result<&[u8]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[PREPARE_MASK_OFFSET..PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES])
}

pub fn prepared_g1_mut(data: &mut [u8]) -> Result<&mut [u8; 64]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &mut data[PREPARED_G1_OFFSET..PREPARED_G1_OFFSET + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn prepared_g1_ref(data: &[u8]) -> Result<&[u8; 64]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &data[PREPARED_G1_OFFSET..PREPARED_G1_OFFSET + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

fn partial_g1_mut(data: &mut [u8], chunk_id: usize) -> Result<&mut [u8; 64]> {
    require!(
        chunk_id < MAX_PREPARE_CHUNKS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = PARTIAL_G1_OFFSET + chunk_id * PREPARED_G1_SIZE;
    let slice = &mut data[start..start + PREPARED_G1_SIZE];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn partial_g1_ref(data: &[u8], chunk_id: usize) -> Result<&[u8; 64]> {
    require!(
        chunk_id < MAX_PREPARE_CHUNKS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = PARTIAL_G1_OFFSET + chunk_id * PREPARED_G1_SIZE;
    let slice = &data[start..start + PREPARED_G1_SIZE];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn prepare_chunk_count(expected: usize) -> Result<usize> {
    require!(
        expected > 0 && expected <= BET_MAX_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok((expected + PREPARE_INPUTS_PER_TX as usize - 1) / PREPARE_INPUTS_PER_TX as usize)
}

pub fn fill_complete(data: &[u8], expected: usize) -> Result<bool> {
    if read_count(data)? as usize != expected {
        return Ok(false);
    }
    let mask = fill_mask_ref(data)?;
    for i in 0..expected {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn prepare_complete(data: &[u8], expected: usize) -> Result<bool> {
    let n = prepare_chunk_count(expected)?;
    let mask = prepare_mask_ref(data)?;
    for i in 0..n {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn init_header(
    data: &mut [u8],
    game_id: &[u8; 32],
    generation: u64,
    player_index: u8,
) -> Result<()> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[8..40].copy_from_slice(game_id);
    data[GENERATION_OFFSET..GENERATION_OFFSET + 8].copy_from_slice(&generation.to_le_bytes());
    data[PLAYER_INDEX_OFFSET] = player_index;
    write_count(data, 0)?;
    data[PREPARED_G1_OFFSET..PREPARED_G1_OFFSET + 64].fill(0);
    write_prepared_count(data, 0)?;
    fill_mask_mut(data)?.fill(0);
    prepare_mask_mut(data)?.fill(0);
    data[PARTIAL_G1_OFFSET..PARTIAL_G1_OFFSET + PARTIAL_G1_BYTES].fill(0);
    Ok(())
}

pub fn init_prepared_accumulator(data: &mut [u8], vk_ic0: &[u8; 64]) -> Result<()> {
    require!(
        read_prepared_count(data)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    prepared_g1_mut(data)?.copy_from_slice(vk_ic0);
    Ok(())
}

pub fn write_inputs_chunk(
    data: &mut [u8],
    offset: u16,
    chunk: &[u8],
    expected: usize,
) -> Result<()> {
    require!(
        !chunk.is_empty() && chunk.len() % 32 == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        expected > 0 && expected <= BET_MAX_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = offset as usize;
    let n = chunk.len() / 32;
    let end = start + n;
    require!(end <= expected, crate::ErrorCode::InvalidPublicInputs);
    require!(
        read_prepared_count(data)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    {
        let mask = fill_mask_ref(data)?;
        for i in start..end {
            require!(!bit_is_set(mask, i), crate::ErrorCode::InvalidStagingWrite);
        }
    }
    let base = BET_INPUTS_HEADER_SIZE + start * 32;
    data[base..base + chunk.len()].copy_from_slice(chunk);
    {
        let mask = fill_mask_mut(data)?;
        for i in start..end {
            set_bit(mask, i);
        }
    }
    let next = read_count(data)? as usize + n;
    require!(next <= expected, crate::ErrorCode::InvalidPublicInputs);
    write_count(data, next as u16)
}

pub fn write_prepare_chunk(
    data: &mut [u8],
    start: u16,
    expected: usize,
    partial: &[u8; 64],
) -> Result<()> {
    require!(
        fill_complete(data, expected)?,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        read_prepared_count(data)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = start as usize;
    require!(
        start % PREPARE_INPUTS_PER_TX as usize == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(start < expected, crate::ErrorCode::InvalidPublicInputs);
    let chunk_id = start / PREPARE_INPUTS_PER_TX as usize;
    require!(
        chunk_id < prepare_chunk_count(expected)?,
        crate::ErrorCode::InvalidPublicInputs
    );
    {
        let mask = prepare_mask_ref(data)?;
        require!(
            !bit_is_set(mask, chunk_id),
            crate::ErrorCode::InvalidStagingWrite
        );
    }
    partial_g1_mut(data, chunk_id)?.copy_from_slice(partial);
    set_bit(prepare_mask_mut(data)?, chunk_id);
    Ok(())
}

pub fn public_inputs_slice(data: &[u8], expected: usize) -> Result<&[[u8; 32]]> {
    require!(
        data.len() >= BET_INPUTS_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        expected > 0 && expected <= BET_MAX_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let end = BET_INPUTS_HEADER_SIZE + 32 * expected;
    let bytes = &data[BET_INPUTS_HEADER_SIZE..end];
    let ptr = bytes.as_ptr() as *const [u8; 32];
    Ok(unsafe { core::slice::from_raw_parts(ptr, expected) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_fits_one_alloc() {
        assert!(BET_INPUTS_ACCOUNT_SIZE <= 10_240);
        assert_eq!(BET_MAX_PUBLIC_INPUTS, 161);
        // Rent `close_bet_public_inputs` returns to the seat (5080 * (len + 128)).
        assert_eq!(BET_INPUTS_ACCOUNT_SIZE, 5996);
        assert_eq!(5080 * (BET_INPUTS_ACCOUNT_SIZE + 128), 31_109_920);
    }
}
