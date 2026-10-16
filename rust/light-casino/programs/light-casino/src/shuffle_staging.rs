//! Parameterized shuffle public-input staging.
//!
//! The PDA is allocated for the table's shoe (1, 6, or 8 decks, or that game's
//! card count). Offsets below the header move with the caller-input count.
//! `SHUFFLE_INPUTS_ACCOUNT_SIZE` is the 8-deck ceiling.
//!
//! Writes are random-access via a per-field fill mask. Prepare folds are also
//! random-access: each tx computes a disjoint MSM partial into `partial_g1[k]`;
//! finalize sums partials + folds the transient commitment, then verify runs.

use crate::prelude::*;
use shared_zk_ids::{MAX_SHUFFLE_CALLER_PUBLIC_INPUTS, MAX_SHUFFLE_PUBLIC_INPUTS};

pub const SHUFFLE_CALLER_PUBLIC_INPUTS: usize = MAX_SHUFFLE_CALLER_PUBLIC_INPUTS;
pub const SHUFFLE_PUBLIC_INPUTS: usize = MAX_SHUFFLE_PUBLIC_INPUTS;
pub const SHUFFLE_CIRCUIT_VERSION: u16 = 4;

pub const SHUFFLE_INPUTS_HEADER_SIZE: usize = 8 + 32 + 8 + 2 + 1 + 2;
pub const PREPARED_G1_SIZE: usize = 64;
pub const PREPARED_COUNT_SIZE: usize = 2;
/// One bit per caller public input (max 1665 → 209 bytes).
pub const FILL_MASK_BYTES: usize = (SHUFFLE_CALLER_PUBLIC_INPUTS + 7) / 8;

/// Inputs folded per prepare-chunk tx (BN254 mul/add budget).
pub const PREPARE_INPUTS_PER_TX: u16 = 16;
/// Max MSM partial slots: ceil(1665 / 16) = 105.
pub const MAX_PREPARE_CHUNKS: usize =
    (SHUFFLE_CALLER_PUBLIC_INPUTS + PREPARE_INPUTS_PER_TX as usize - 1)
        / PREPARE_INPUTS_PER_TX as usize;
pub const PREPARE_MASK_BYTES: usize = (MAX_PREPARE_CHUNKS + 7) / 8;
pub const PARTIAL_G1_BYTES: usize = MAX_PREPARE_CHUNKS * PREPARED_G1_SIZE;

const GENERATION_OFFSET: usize = 8 + 32;
const CIRCUIT_VERSION_OFFSET: usize = GENERATION_OFFSET + 8;
const PLAYER_INDEX_OFFSET: usize = CIRCUIT_VERSION_OFFSET + 2;
const COUNT_OFFSET: usize = PLAYER_INDEX_OFFSET + 1;
pub const PREPARED_G1_OFFSET: usize =
    SHUFFLE_INPUTS_HEADER_SIZE + 32 * SHUFFLE_CALLER_PUBLIC_INPUTS;
pub const PREPARED_COUNT_OFFSET: usize = PREPARED_G1_OFFSET + PREPARED_G1_SIZE;
pub const FILL_MASK_OFFSET: usize = PREPARED_COUNT_OFFSET + PREPARED_COUNT_SIZE;
pub const PREPARE_MASK_OFFSET: usize = FILL_MASK_OFFSET + FILL_MASK_BYTES;
pub const PARTIAL_G1_OFFSET: usize = PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES;

pub const SHUFFLE_INPUTS_ACCOUNT_SIZE: usize = PARTIAL_G1_OFFSET + PARTIAL_G1_BYTES;

/// Byte layout of a shuffle-inputs account for `caller_inputs` field elements.
#[derive(Clone, Copy)]
pub struct ShuffleLayout {
    pub prepared_g1: usize,
    pub prepared_count: usize,
    pub fill_mask: usize,
    pub fill_mask_len: usize,
    pub prepare_mask: usize,
    pub prepare_mask_len: usize,
    pub partial_g1: usize,
    pub chunks: usize,
    pub size: usize,
}

pub fn shuffle_layout(caller_inputs: usize) -> Result<ShuffleLayout> {
    require!(
        caller_inputs > 0 && caller_inputs <= SHUFFLE_CALLER_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let chunks = (caller_inputs + PREPARE_INPUTS_PER_TX as usize - 1)
        / PREPARE_INPUTS_PER_TX as usize;
    let fill_mask_len = (caller_inputs + 7) / 8;
    let prepare_mask_len = (chunks + 7) / 8;
    let prepared_g1 = SHUFFLE_INPUTS_HEADER_SIZE + 32 * caller_inputs;
    let prepared_count = prepared_g1 + PREPARED_G1_SIZE;
    let fill_mask = prepared_count + PREPARED_COUNT_SIZE;
    let prepare_mask = fill_mask + fill_mask_len;
    let partial_g1 = prepare_mask + prepare_mask_len;
    let size = partial_g1 + chunks * PREPARED_G1_SIZE;
    Ok(ShuffleLayout {
        prepared_g1,
        prepared_count,
        fill_mask,
        fill_mask_len,
        prepare_mask,
        prepare_mask_len,
        partial_g1,
        chunks,
        size,
    })
}

/// Rent-bearing size for this shoe. An 8-deck shoe matches [`SHUFFLE_INPUTS_ACCOUNT_SIZE`].
pub fn shuffle_account_size(caller_inputs: usize) -> Result<usize> {
    Ok(shuffle_layout(caller_inputs)?.size)
}

pub fn read_generation(data: &[u8]) -> Result<u64> {
    require!(
        data.len() >= SHUFFLE_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(u64::from_le_bytes(
        data[GENERATION_OFFSET..GENERATION_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

pub fn read_circuit_version(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= SHUFFLE_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(u16::from_le_bytes(
        data[CIRCUIT_VERSION_OFFSET..CIRCUIT_VERSION_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

pub fn read_count(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= SHUFFLE_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(u16::from_le_bytes(
        data[COUNT_OFFSET..COUNT_OFFSET + 2]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

pub fn write_count(data: &mut [u8], count: u16) -> Result<()> {
    require!(
        data.len() >= SHUFFLE_INPUTS_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[COUNT_OFFSET..COUNT_OFFSET + 2].copy_from_slice(&count.to_le_bytes());
    Ok(())
}

pub fn read_prepared_count(data: &[u8], caller_inputs: usize) -> Result<u16> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let at = layout.prepared_count;
    Ok(u16::from_le_bytes(
        data[at..at + 2]
            .try_into()
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?,
    ))
}

/// Prior-shoe Poseidon hash, stashed after absorb so the next finalize does not
/// hash 1,248 fields a second time. Absorb overwrites this slot; cache runs after it.
pub fn write_cached_deck_hash(data: &mut [u8], hash: &[u8; 32], caller_inputs: usize) -> Result<()> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.partial_g1 + 32,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[layout.partial_g1..layout.partial_g1 + 32].copy_from_slice(hash);
    Ok(())
}

pub fn read_cached_deck_hash(data: &[u8], caller_inputs: usize) -> Result<[u8; 32]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.partial_g1 + 32,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[layout.partial_g1..layout.partial_g1 + 32]);
    Ok(out)
}

pub fn write_prepared_count(data: &mut [u8], count: u16, caller_inputs: usize) -> Result<()> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let at = layout.prepared_count;
    data[at..at + 2].copy_from_slice(&count.to_le_bytes());
    Ok(())
}

fn fill_mask_mut(data: &mut [u8], caller_inputs: usize) -> Result<&mut [u8]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[layout.fill_mask..layout.fill_mask + layout.fill_mask_len])
}

fn fill_mask_ref(data: &[u8], caller_inputs: usize) -> Result<&[u8]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[layout.fill_mask..layout.fill_mask + layout.fill_mask_len])
}

fn prepare_mask_mut(data: &mut [u8], caller_inputs: usize) -> Result<&mut [u8]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[layout.prepare_mask..layout.prepare_mask + layout.prepare_mask_len])
}

fn prepare_mask_ref(data: &[u8], caller_inputs: usize) -> Result<&[u8]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[layout.prepare_mask..layout.prepare_mask + layout.prepare_mask_len])
}

fn bit_is_set(mask: &[u8], index: usize) -> bool {
    let byte = index / 8;
    let bit = index % 8;
    (mask[byte] & (1u8 << bit)) != 0
}

fn set_bit(mask: &mut [u8], index: usize) {
    let byte = index / 8;
    let bit = index % 8;
    mask[byte] |= 1u8 << bit;
}

/// True when every field in `0..expected_caller` has been written.
pub fn fill_complete(data: &[u8], expected_caller: usize) -> Result<bool> {
    require!(
        expected_caller > 0 && expected_caller <= SHUFFLE_CALLER_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    if read_count(data)? as usize != expected_caller {
        return Ok(false);
    }
    let mask = fill_mask_ref(data, expected_caller)?;
    for i in 0..expected_caller {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// True when `start..start+count` is already present. A retry of a landed absorb uses this.
pub fn inputs_range_written(
    data: &[u8],
    start: usize,
    count: usize,
    expected_caller: usize,
) -> Result<bool> {
    if count == 0 || start + count > expected_caller {
        return Ok(false);
    }
    let mask = fill_mask_ref(data, expected_caller)?;
    Ok((start..start + count).all(|index| bit_is_set(mask, index)))
}

/// True when this MSM slice was already copied into the game shuffle buffer.
pub fn prepare_chunk_written(
    data: &[u8],
    chunk_id: usize,
    expected_caller: usize,
) -> Result<bool> {
    if chunk_id >= prepare_chunk_count(expected_caller)? {
        return Ok(false);
    }
    Ok(bit_is_set(prepare_mask_ref(data, expected_caller)?, chunk_id))
}

pub fn prepare_chunk_count(expected_caller: usize) -> Result<usize> {
    require!(
        expected_caller > 0 && expected_caller <= SHUFFLE_CALLER_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok((expected_caller + PREPARE_INPUTS_PER_TX as usize - 1)
        / PREPARE_INPUTS_PER_TX as usize)
}

/// True when every MSM partial for `0..expected_caller` has been written.
pub fn prepare_complete(data: &[u8], expected_caller: usize) -> Result<bool> {
    let n_chunks = prepare_chunk_count(expected_caller)?;
    let mask = prepare_mask_ref(data, expected_caller)?;
    for i in 0..n_chunks {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn prepare_started(data: &[u8], caller_inputs: usize) -> Result<bool> {
    let mask = prepare_mask_ref(data, caller_inputs)?;
    Ok(mask.iter().any(|&b| b != 0))
}

pub fn prepared_g1_mut(data: &mut [u8], caller_inputs: usize) -> Result<&mut [u8; 64]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &mut data[layout.prepared_g1..layout.prepared_g1 + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn prepared_g1_ref(data: &[u8], caller_inputs: usize) -> Result<&[u8; 64]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &data[layout.prepared_g1..layout.prepared_g1 + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn partial_g1_mut(
    data: &mut [u8],
    chunk_id: usize,
    caller_inputs: usize,
) -> Result<&mut [u8; 64]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        chunk_id < layout.chunks,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = layout.partial_g1 + chunk_id * PREPARED_G1_SIZE;
    let slice = &mut data[start..start + PREPARED_G1_SIZE];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn partial_g1_ref(data: &[u8], chunk_id: usize, caller_inputs: usize) -> Result<&[u8; 64]> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        chunk_id < layout.chunks,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = layout.partial_g1 + chunk_id * PREPARED_G1_SIZE;
    let slice = &data[start..start + PREPARED_G1_SIZE];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn init_header(
    data: &mut [u8],
    game_id: &[u8; 32],
    generation: u64,
    circuit_version: u16,
    player_index: u8,
    caller_inputs: usize,
) -> Result<()> {
    let layout = shuffle_layout(caller_inputs)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        circuit_version == SHUFFLE_CIRCUIT_VERSION,
        crate::ErrorCode::InvalidCircuitVersion
    );
    data[8..40].copy_from_slice(game_id);
    data[GENERATION_OFFSET..GENERATION_OFFSET + 8].copy_from_slice(&generation.to_le_bytes());
    data[CIRCUIT_VERSION_OFFSET..CIRCUIT_VERSION_OFFSET + 2]
        .copy_from_slice(&circuit_version.to_le_bytes());
    data[PLAYER_INDEX_OFFSET] = player_index;
    write_count(data, 0)?;
    data[layout.prepared_g1..layout.prepared_g1 + 64].fill(0);
    write_prepared_count(data, 0, caller_inputs)?;
    fill_mask_mut(data, caller_inputs)?.fill(0);
    prepare_mask_mut(data, caller_inputs)?.fill(0);
    data[layout.partial_g1..layout.size].fill(0);
    Ok(())
}

pub fn init_prepared_accumulator(
    data: &mut [u8],
    vk_ic0: &[u8; 64],
    caller_inputs: usize,
) -> Result<()> {
    require!(
        read_prepared_count(data, caller_inputs)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    prepared_g1_mut(data, caller_inputs)?.copy_from_slice(vk_ic0);
    Ok(())
}

/// Random-access write. Chunks may arrive out of order; overlapping fields rejected.
pub fn write_inputs_chunk(
    data: &mut [u8],
    offset: u16,
    chunk: &[u8],
    expected_caller: usize,
) -> Result<()> {
    require!(
        !chunk.is_empty() && chunk.len() % 32 == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        expected_caller > 0 && expected_caller <= SHUFFLE_CALLER_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = offset as usize;
    let n = chunk.len() / 32;
    let end = start + n;
    require!(end <= expected_caller, crate::ErrorCode::InvalidPublicInputs);
    require!(
        read_prepared_count(data, expected_caller)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );

    // Reject any overlap with already-filled fields. A chunk's partial may
    // already be stored; that does not freeze the ranges still empty.
    {
        let mask = fill_mask_ref(data, expected_caller)?;
        for i in start..end {
            require!(!bit_is_set(mask, i), crate::ErrorCode::InvalidStagingWrite);
        }
    }

    let base = SHUFFLE_INPUTS_HEADER_SIZE + start * 32;
    data[base..base + chunk.len()].copy_from_slice(chunk);

    {
        let mask = fill_mask_mut(data, expected_caller)?;
        for i in start..end {
            set_bit(mask, i);
        }
    }

    let next = read_count(data)? as usize + n;
    require!(next <= expected_caller, crate::ErrorCode::InvalidPublicInputs);
    write_count(data, next as u16)
}

/// Store one MSM partial for `start..min(start+PREPARE_INPUTS_PER_TX, expected_caller)`.
/// `partial` is the already-folded G1 for that range (from infinity).
pub fn write_prepare_chunk(
    data: &mut [u8],
    start: u16,
    expected_caller: usize,
    partial: &[u8; 64],
) -> Result<()> {
    require!(
        read_prepared_count(data, expected_caller)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = start as usize;
    require!(
        start % PREPARE_INPUTS_PER_TX as usize == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    {
        let end = (start + PREPARE_INPUTS_PER_TX as usize).min(expected_caller);
        let mask = fill_mask_ref(data, expected_caller)?;
        for i in start..end {
            require!(bit_is_set(mask, i), crate::ErrorCode::InvalidPublicInputs);
        }
    }
    require!(start < expected_caller, crate::ErrorCode::InvalidPublicInputs);
    let chunk_id = start / PREPARE_INPUTS_PER_TX as usize;
    require!(
        chunk_id < prepare_chunk_count(expected_caller)?,
        crate::ErrorCode::InvalidPublicInputs
    );
    {
        let mask = prepare_mask_ref(data, expected_caller)?;
        require!(
            !bit_is_set(mask, chunk_id),
            crate::ErrorCode::InvalidStagingWrite
        );
    }
    partial_g1_mut(data, chunk_id, expected_caller)?.copy_from_slice(partial);
    set_bit(prepare_mask_mut(data, expected_caller)?, chunk_id);
    Ok(())
}

/// Contiguous caller-staged field elements (length = `expected_caller`).
pub fn public_inputs_slice(data: &[u8], expected_caller: usize) -> Result<&[[u8; 32]]> {
    let layout = shuffle_layout(expected_caller)?;
    require!(
        data.len() >= layout.size,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        expected_caller > 0 && expected_caller <= SHUFFLE_CALLER_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let end = SHUFFLE_INPUTS_HEADER_SIZE + 32 * expected_caller;
    let bytes = &data[SHUFFLE_INPUTS_HEADER_SIZE..end];
    // SAFETY: 32-byte aligned field buffer of exact length.
    let ptr = bytes.as_ptr() as *const [u8; 32];
    Ok(unsafe { core::slice::from_raw_parts(ptr, expected_caller) })
}

/// Legacy fixed-size view for poker/single-deck callers (209).
pub fn public_inputs_ref(data: &[u8]) -> Result<&[[u8; 32]]> {
    public_inputs_slice(data, 209)
}

pub fn output_hash(data: &[u8], expected_caller: usize) -> Result<[u8; 32]> {
    let inputs = public_inputs_slice(data, expected_caller)?;
    Ok(inputs[expected_caller - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(caller: usize) -> Vec<u8> {
        let mut data = vec![0u8; shuffle_account_size(caller).unwrap()];
        init_header(&mut data, &[1u8; 32], 7, SHUFFLE_CIRCUIT_VERSION, 0, caller).unwrap();
        init_prepared_accumulator(&mut data, &[2u8; 64], caller).unwrap();
        data
    }

    #[test]
    fn accepts_out_of_order_writes_and_rejects_overlap() {
        let expected = 209;
        let mut data = account(expected);
        write_inputs_chunk(&mut data, 2, &[4u8; 32], expected).unwrap();
        write_inputs_chunk(&mut data, 0, &[3u8; 64], expected).unwrap();
        assert_eq!(read_count(&data).unwrap(), 3);
        assert!(!fill_complete(&data, expected).unwrap());
        assert!(write_inputs_chunk(&mut data, 1, &[5u8; 32], expected).is_err());
        assert!(write_inputs_chunk(&mut data, 0, &[5u8; 32], expected).is_err());
    }

    #[test]
    fn rejects_writes_after_prepare_starts() {
        let expected = 32;
        let mut data = account(expected);
        for i in 0..expected {
            write_inputs_chunk(&mut data, i as u16, &[3u8; 32], expected).unwrap();
        }
        write_prepare_chunk(&mut data, 0, expected, &[9u8; 64]).unwrap();
        assert!(write_inputs_chunk(&mut data, 0, &[4u8; 32], expected).is_err());
    }

    #[test]
    fn accepts_parallel_prepare_chunks() {
        let expected = 40; // 3 chunks (16+16+8)
        let mut data = account(expected);
        for i in 0..expected {
            write_inputs_chunk(&mut data, i as u16, &[(i + 1) as u8; 32], expected).unwrap();
        }
        write_prepare_chunk(&mut data, 16, expected, &[1u8; 64]).unwrap();
        write_prepare_chunk(&mut data, 0, expected, &[2u8; 64]).unwrap();
        write_prepare_chunk(&mut data, 32, expected, &[3u8; 64]).unwrap();
        assert!(prepare_complete(&data, expected).unwrap());
        assert!(write_prepare_chunk(&mut data, 0, expected, &[4u8; 64]).is_err());
    }

    #[test]
    fn max_account_size_fits_eight_deck() {
        assert_eq!(SHUFFLE_CALLER_PUBLIC_INPUTS, 1665);
        assert_eq!(SHUFFLE_PUBLIC_INPUTS, 1666);
        assert_eq!(FILL_MASK_BYTES, 209);
        assert_eq!(MAX_PREPARE_CHUNKS, 105);
        assert_eq!(PREPARE_MASK_BYTES, 14);
        assert_eq!(
            shuffle_account_size(SHUFFLE_CALLER_PUBLIC_INPUTS).unwrap(),
            SHUFFLE_INPUTS_ACCOUNT_SIZE
        );
        assert!(shuffle_account_size(209).unwrap() < SHUFFLE_INPUTS_ACCOUNT_SIZE);
        assert!(shuffle_account_size(52 * 6 * 4 + 1).unwrap() < SHUFFLE_INPUTS_ACCOUNT_SIZE);
    }
}
