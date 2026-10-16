//! Staged public inputs for large share circuits (roulette nPublic=579).
//!
//! Writes are random-access via a per-field fill mask (shuffle-style). Prepare
//! folds are also random-access: each tx stores a disjoint MSM partial; finalize
//! sums partials into `prepared_g1`.

use crate::prelude::*;
use shared_zk_ids::ROULETTE_SHARE_PUBLIC_INPUTS;

pub const SHARE_STAGING_PUBLIC_INPUTS: usize = ROULETTE_SHARE_PUBLIC_INPUTS;
pub const SHARE_STAGING_HEADER_SIZE: usize = 8 + 32 + 8 + 1 + 2; // disc+game+gen+player+count
pub const PREPARED_G1_SIZE: usize = 64;
pub const PREPARED_COUNT_SIZE: usize = 2;

/// One bit per staged public input (579 → 73 bytes).
pub const FILL_MASK_BYTES: usize = (SHARE_STAGING_PUBLIC_INPUTS + 7) / 8;

/// Inputs folded per prepare-chunk tx (BN254 mul/add budget).
pub const PREPARE_INPUTS_PER_TX: u16 = 16;
/// Max MSM partial slots: ceil(579 / 16) = 37.
pub const MAX_PREPARE_CHUNKS: usize =
    (SHARE_STAGING_PUBLIC_INPUTS + PREPARE_INPUTS_PER_TX as usize - 1)
        / PREPARE_INPUTS_PER_TX as usize;
pub const PREPARE_MASK_BYTES: usize = (MAX_PREPARE_CHUNKS + 7) / 8;
pub const PARTIAL_G1_BYTES: usize = MAX_PREPARE_CHUNKS * PREPARED_G1_SIZE;

const GENERATION_OFFSET: usize = 8 + 32;
const PLAYER_INDEX_OFFSET: usize = GENERATION_OFFSET + 8;
const COUNT_OFFSET: usize = PLAYER_INDEX_OFFSET + 1;
pub const PREPARED_G1_OFFSET: usize =
    SHARE_STAGING_HEADER_SIZE + 32 * SHARE_STAGING_PUBLIC_INPUTS;
pub const PREPARED_COUNT_OFFSET: usize = PREPARED_G1_OFFSET + PREPARED_G1_SIZE;
pub const FILL_MASK_OFFSET: usize = PREPARED_COUNT_OFFSET + PREPARED_COUNT_SIZE;
pub const PREPARE_MASK_OFFSET: usize = FILL_MASK_OFFSET + FILL_MASK_BYTES;
pub const PARTIAL_G1_OFFSET: usize = PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES;

pub const SHARE_STAGING_ACCOUNT_SIZE: usize = PARTIAL_G1_OFFSET + PARTIAL_G1_BYTES;

pub fn read_count(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= SHARE_STAGING_HEADER_SIZE,
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
        data.len() >= SHARE_STAGING_HEADER_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[COUNT_OFFSET..COUNT_OFFSET + 2].copy_from_slice(&count.to_le_bytes());
    Ok(())
}

pub fn read_prepared_count(data: &[u8]) -> Result<u16> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
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
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    data[PREPARED_COUNT_OFFSET..PREPARED_COUNT_OFFSET + 2]
        .copy_from_slice(&count.to_le_bytes());
    Ok(())
}

pub fn prepared_g1_mut(data: &mut [u8]) -> Result<&mut [u8; 64]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &mut data[PREPARED_G1_OFFSET..PREPARED_G1_OFFSET + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

pub fn prepared_g1_ref(data: &[u8]) -> Result<&[u8; 64]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let slice = &data[PREPARED_G1_OFFSET..PREPARED_G1_OFFSET + 64];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
}

fn fill_mask_mut(data: &mut [u8]) -> Result<&mut [u8]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[FILL_MASK_OFFSET..FILL_MASK_OFFSET + FILL_MASK_BYTES])
}

fn fill_mask_ref(data: &[u8]) -> Result<&[u8]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[FILL_MASK_OFFSET..FILL_MASK_OFFSET + FILL_MASK_BYTES])
}

fn prepare_mask_mut(data: &mut [u8]) -> Result<&mut [u8]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&mut data[PREPARE_MASK_OFFSET..PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES])
}

fn prepare_mask_ref(data: &[u8]) -> Result<&[u8]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&data[PREPARE_MASK_OFFSET..PREPARE_MASK_OFFSET + PREPARE_MASK_BYTES])
}

fn partial_g1_mut(data: &mut [u8], chunk_id: usize) -> Result<&mut [u8; 64]> {
    require!(
        chunk_id < MAX_PREPARE_CHUNKS,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
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
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = PARTIAL_G1_OFFSET + chunk_id * PREPARED_G1_SIZE;
    let slice = &data[start..start + PREPARED_G1_SIZE];
    Ok(slice
        .try_into()
        .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?)
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

/// True when every field in `0..SHARE_STAGING_PUBLIC_INPUTS` has been written.
pub fn fill_complete(data: &[u8]) -> Result<bool> {
    if read_count(data)? as usize != SHARE_STAGING_PUBLIC_INPUTS {
        return Ok(false);
    }
    let mask = fill_mask_ref(data)?;
    for i in 0..SHARE_STAGING_PUBLIC_INPUTS {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn prepare_chunk_count() -> usize {
    MAX_PREPARE_CHUNKS
}

/// True when every MSM partial has been written.
pub fn prepare_complete(data: &[u8]) -> Result<bool> {
    let mask = prepare_mask_ref(data)?;
    for i in 0..MAX_PREPARE_CHUNKS {
        if !bit_is_set(mask, i) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn prepare_started(data: &[u8]) -> Result<bool> {
    let mask = prepare_mask_ref(data)?;
    Ok(mask.iter().any(|&b| b != 0))
}

pub fn init_header(
    data: &mut [u8],
    game_id: &[u8; 32],
    generation: u64,
    player_index: u8,
) -> Result<()> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
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

/// Random-access write. Chunks may arrive out of order; overlapping fields rejected.
pub fn write_inputs_chunk(data: &mut [u8], offset: u16, chunk: &[u8]) -> Result<()> {
    require!(
        !chunk.is_empty() && chunk.len() % 32 == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = offset as usize;
    let n = chunk.len() / 32;
    let end = start + n;
    require!(
        end <= SHARE_STAGING_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        read_prepared_count(data)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        !prepare_started(data)?,
        crate::ErrorCode::InvalidStagingWrite
    );

    {
        let mask = fill_mask_ref(data)?;
        for i in start..end {
            require!(!bit_is_set(mask, i), crate::ErrorCode::InvalidStagingWrite);
        }
    }

    let base = SHARE_STAGING_HEADER_SIZE + start * 32;
    data[base..base + chunk.len()].copy_from_slice(chunk);

    {
        let mask = fill_mask_mut(data)?;
        for i in start..end {
            set_bit(mask, i);
        }
    }

    let next = read_count(data)? as usize + n;
    require!(
        next <= SHARE_STAGING_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    write_count(data, next as u16)
}

/// Store one MSM partial for `start..min(start+PREPARE_INPUTS_PER_TX, 579)`.
pub fn write_prepare_chunk(data: &mut [u8], start: u16, partial: &[u8; 64]) -> Result<()> {
    require!(fill_complete(data)?, crate::ErrorCode::InvalidPublicInputs);
    require!(
        read_prepared_count(data)? == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    let start = start as usize;
    require!(
        start % PREPARE_INPUTS_PER_TX as usize == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    require!(
        start < SHARE_STAGING_PUBLIC_INPUTS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let chunk_id = start / PREPARE_INPUTS_PER_TX as usize;
    require!(
        chunk_id < MAX_PREPARE_CHUNKS,
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

pub fn public_inputs_slice(data: &[u8]) -> Result<&[[u8; 32]]> {
    require!(
        data.len() >= SHARE_STAGING_ACCOUNT_SIZE,
        crate::ErrorCode::InvalidPublicInputs
    );
    let end = SHARE_STAGING_HEADER_SIZE + 32 * SHARE_STAGING_PUBLIC_INPUTS;
    let bytes = &data[SHARE_STAGING_HEADER_SIZE..end];
    let ptr = bytes.as_ptr() as *const [u8; 32];
    Ok(unsafe { core::slice::from_raw_parts(ptr, SHARE_STAGING_PUBLIC_INPUTS) })
}

/// First public signal is the circuit output hash (`outHash`).
pub fn output_hash(data: &[u8]) -> Result<[u8; 32]> {
    let inputs = public_inputs_slice(data)?;
    Ok(inputs[0])
}

/// Second public signal: `actualBetCount` (field element, low limb).
pub fn actual_bet_count(data: &[u8]) -> Result<u64> {
    let inputs = public_inputs_slice(data)?;
    // Big-endian field: count fits in the last 8 bytes.
    let mut le = [0u8; 8];
    le.copy_from_slice(&inputs[1][24..32]);
    Ok(u64::from_be_bytes(le))
}

/// Encrypted bet limbs: `encryptedBets[12][12][4]` = 576 fields after outHash+count.
pub fn encrypted_bet_limbs(data: &[u8]) -> Result<&[[u8; 32]]> {
    let inputs = public_inputs_slice(data)?;
    // Layout: [0]=outHash, [1]=actualBetCount, [2..578]=bets, [578]=inputHash
    require!(
        inputs.len() >= 2 + shared_zk_ids::ROULETTE_BET_LIMBS + 1,
        crate::ErrorCode::InvalidPublicInputs
    );
    Ok(&inputs[2..2 + shared_zk_ids::ROULETTE_BET_LIMBS])
}

/// Showdown `betHash` = `HashCiphertexts(encryptedBets[0])` (sharer-major row).
///
/// Share pubs layout is `encryptedBets[12][12][4]` with index 0 sealed to the
/// sharer — matching Circom `RouletteShowdownHashMain` / TS `hashCiphertexts`.
pub fn bet_commitment_hash(data: &[u8]) -> Result<[u8; 32]> {
    use crate::shuffle_hash::hash_flat_bytes_be;
    let limbs = encrypted_bet_limbs(data)?;
    const PROVER_BET_LIMBS: usize = shared_zk_ids::ROULETTE_MAX_BETS * 4; // 48
    require!(
        limbs.len() >= PROVER_BET_LIMBS,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut bytes = Vec::with_capacity(PROVER_BET_LIMBS * 32);
    for limb in &limbs[..PROVER_BET_LIMBS] {
        bytes.extend_from_slice(limb);
    }
    hash_flat_bytes_be(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> Vec<u8> {
        let mut data = vec![0u8; SHARE_STAGING_ACCOUNT_SIZE];
        init_header(&mut data, &[1u8; 32], 7, 0).unwrap();
        init_prepared_accumulator(&mut data, &[2u8; 64]).unwrap();
        data
    }

    #[test]
    fn accepts_out_of_order_writes_and_rejects_overlap() {
        let mut data = account();
        write_inputs_chunk(&mut data, 2, &[4u8; 32]).unwrap();
        write_inputs_chunk(&mut data, 0, &[3u8; 64]).unwrap(); // covers indices 0 and 1
        assert_eq!(read_count(&data).unwrap(), 3);
        assert!(write_inputs_chunk(&mut data, 1, &[5u8; 32]).is_err());
        assert!(write_inputs_chunk(&mut data, 0, &[5u8; 32]).is_err());
    }

    #[test]
    fn rejects_writes_after_prepare_starts() {
        let mut data = account();
        for i in 0..SHARE_STAGING_PUBLIC_INPUTS {
            write_inputs_chunk(&mut data, i as u16, &[3u8; 32]).unwrap();
        }
        assert!(fill_complete(&data).unwrap());
        write_prepare_chunk(&mut data, 0, &[9u8; 64]).unwrap();
        assert!(write_inputs_chunk(&mut data, 0, &[4u8; 32]).is_err());
    }

    #[test]
    fn accepts_parallel_prepare_chunks() {
        let mut data = account();
        for i in 0..SHARE_STAGING_PUBLIC_INPUTS {
            write_inputs_chunk(&mut data, i as u16, &[(i % 250 + 1) as u8; 32]).unwrap();
        }
        // Write chunks out of order
        write_prepare_chunk(&mut data, 16, &[1u8; 64]).unwrap();
        write_prepare_chunk(&mut data, 0, &[2u8; 64]).unwrap();
        for start in (32..SHARE_STAGING_PUBLIC_INPUTS).step_by(PREPARE_INPUTS_PER_TX as usize) {
            write_prepare_chunk(&mut data, start as u16, &[3u8; 64]).unwrap();
        }
        assert!(prepare_complete(&data).unwrap());
        assert!(write_prepare_chunk(&mut data, 0, &[4u8; 64]).is_err());
    }

    #[test]
    fn account_size_constants() {
        assert_eq!(SHARE_STAGING_PUBLIC_INPUTS, 579);
        assert_eq!(FILL_MASK_BYTES, 73);
        assert_eq!(MAX_PREPARE_CHUNKS, 37);
        assert_eq!(PREPARE_MASK_BYTES, 5);
        assert!(SHARE_STAGING_ACCOUNT_SIZE > 18_645);
    }
}
