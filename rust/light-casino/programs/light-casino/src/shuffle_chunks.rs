//! One account per 16-field shuffle slice.
//!
//! Each slice is created by its own fee payer, so the writes land together.
//! The seat signs as a read-only authority. Field bytes stay on the chunk
//! until they are copied into the game shuffle buffer.
//! The shoe in `deck_state` is still published only by `verify_shuffle_staged`.

use crate::prelude::*;
use crate::rent_vault::{self, require_vault_for_player};
use crate::shuffle_staging::{
    inputs_range_written, partial_g1_ref, prepare_chunk_written, public_inputs_slice,
    write_inputs_chunk, write_prepare_chunk, PREPARE_INPUTS_PER_TX,
};
use crate::{ErrorCode, GamePhase, GameState, PlayerState};

pub const SHUFFLE_CHUNK_FIELDS: usize = PREPARE_INPUTS_PER_TX as usize;
/// Signers in one `fund_shuffle_lanes` transaction. A legacy packet is 1232
/// bytes and each lane adds a 32-byte key, which fits 28 lanes beside the
/// program, operator, game, player, and vault.
/// Must match the client `SHUFFLE_LANES_PER_TX`.
pub const SHUFFLE_LANES: usize = 28;
/// game id, payer, generation, player, start, count.
pub const SHUFFLE_CHUNK_HEADER: usize = 32 + 32 + 8 + 1 + 2 + 2;
pub const SHUFFLE_CHUNK_SIZE: usize = SHUFFLE_CHUNK_HEADER + SHUFFLE_CHUNK_FIELDS * 32 + 64;
const PARTIAL_AT: usize = SHUFFLE_CHUNK_HEADER + SHUFFLE_CHUNK_FIELDS * 32;
/// Signature budget per chunk transaction, including one retry.
pub const SHUFFLE_CHUNK_FEE: u64 = 10_000;

fn read_u16(data: &mut &[u8]) -> Result<u16> {
    require!(data.len() >= 2, ErrorCode::InvalidPublicInputs);
    let mut buf = [0u8; 2];
    buf.copy_from_slice(&data[..2]);
    *data = &data[2..];
    Ok(u16::from_le_bytes(buf))
}

fn require_shuffler(game: &GameState, player: &PlayerState, authority: &Pubkey) -> Result<()> {
    require!(
        game.phase == GamePhase::Shuffle as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player.player_index == game.current_player, ErrorCode::NotYourTurn);
    require!(player.game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    require!(player.authority == *authority, ErrorCode::InvalidAuthority);
    Ok(())
}

pub fn lane_budget_per_lane(caller_inputs: usize) -> Result<u64> {
    let chunks = caller_inputs.div_ceil(SHUFFLE_CHUNK_FIELDS);
    require!(chunks > 0, ErrorCode::InvalidPublicInputs);
    let rent = minimum_balance(SHUFFLE_CHUNK_SIZE)?;
    Ok(rent.saturating_add(SHUFFLE_CHUNK_FEE))
}

/// Move `amount` from this seat's vault to each lane payer.
///
/// Each lane pays for one chunk, so `amount` is that chunk's rent plus its
/// signature fee. A shoe with more chunks than `SHUFFLE_LANES` is funded
/// over several transactions. The operator of the hand signs.
pub fn fund_shuffle_lanes(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    require!(data.len() == 8, ErrorCode::InvalidPublicInputs);
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[..8]);
    data = &data[8..];
    require!(data.is_empty(), ErrorCode::InvalidPublicInputs);
    let amount = u64::from_le_bytes(buf);
    require!(amount > 0, ErrorCode::InvalidPublicInputs);

    let mut ix = IxCursor::new(accounts, crate::ID);
    let operator = ix.signer(true)?;
    let game = ix.load::<GameState>(false)?;
    let player = ix.load::<PlayerState>(false)?;
    let vault = ix.unchecked(true)?;
    require_keys_eq!(operator.key(), game.operator, ErrorCode::InvalidAuthority);
    require!(
        game.phase == GamePhase::Shuffle as u8 || game.phase == GamePhase::Share as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player.game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    require_vault_for_player(&vault.to_account_info(), &player.authority)?;
    let caller = game.config()?.shuffle_caller_public_inputs();
    let cap = lane_budget_per_lane(caller)?;
    require!(amount <= cap, ErrorCode::InvalidPublicInputs);
    let lanes = ix.rest();
    require!(
        !lanes.is_empty() && lanes.len() <= SHUFFLE_LANES,
        ErrorCode::InvalidPublicInputs
    );
    for lane in &lanes {
        require!(lane.is_writable(), ErrorCode::InvalidPublicInputs);
        move_lamports(&vault.to_account_info(), lane, amount)?;
    }
    let retain = minimum_balance(vault.data_len())?;
    require!(
        vault.lamports() >= retain,
        ErrorCode::InvalidPublicInputs
    );
    Ok(())
}

/// Create one chunk account, store its field bytes, and fold its MSM partial.
pub fn write_prepare_shuffle_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let start = read_u16(&mut data)?;
    require!(
        data.len() % 32 == 0 && !data.is_empty() && data.len() / 32 <= SHUFFLE_CHUNK_FIELDS,
        ErrorCode::InvalidPublicInputs
    );
    let count = data.len() / 32;
    let start_usize = start as usize;
    require!(
        start_usize % SHUFFLE_CHUNK_FIELDS == 0,
        ErrorCode::InvalidPublicInputs
    );

    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let payer = ix.signer(true)?;
    let game = ix.load::<GameState>(false)?;
    let player = ix.load::<PlayerState>(false)?;
    require_shuffler(&game, &player, &authority.key())?;
    let chunk = ix.init_unchecked(
        &payer.to_account_info(),
        SHUFFLE_CHUNK_SIZE,
        &[b"shuffle_chunk", &game.game_id[..], &start.to_le_bytes()],
        false,
    )?;
    let _system = ix.system()?;

    let config = game.config()?;
    let expected = config.shuffle_caller_public_inputs();
    require!(start_usize + count <= expected, ErrorCode::InvalidPublicInputs);
    // The shoe is hashed in finalize. A chunk only stores its fields.
    let partial = [0u8; 64];

    let mut account = chunk.try_borrow_mut_data()?;
    account[0..32].copy_from_slice(&game.game_id);
    account[32..64].copy_from_slice(payer.key().as_ref());
    account[64..72].copy_from_slice(&game.generation.to_le_bytes());
    account[72] = player.player_index;
    account[73..75].copy_from_slice(&start.to_le_bytes());
    account[75..77].copy_from_slice(&(count as u16).to_le_bytes());
    account[SHUFFLE_CHUNK_HEADER..SHUFFLE_CHUNK_HEADER + data.len()].copy_from_slice(data);
    account[PARTIAL_AT..PARTIAL_AT + 64].copy_from_slice(&partial);
    Ok(())
}

/// Copy one chunk's field bytes into the game shuffle buffer.
pub fn absorb_shuffle_fields(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let game = ix.load::<GameState>(false)?;
    let player = ix.load::<PlayerState>(false)?;
    let shuffle = ix.unchecked(true)?;
    let chunk = ix.unchecked(false)?;
    require_shuffler(&game, &player, &authority.key())?;
    ix.check_seeds(
        &shuffle.to_account_info(),
        &[b"shuffle_inputs", &game.game_id[..]],
        false,
    )?;
    let (start, count, fields) = read_chunk(&game, &chunk.to_account_info())?;
    let mut shuffle_data = shuffle.try_borrow_mut_data()?;
    let expected = game.config()?.shuffle_caller_public_inputs();
    let start_usize = start as usize;
    let count_usize = count as usize;
    if inputs_range_written(&shuffle_data, start_usize, count_usize, expected)? {
        let slice = public_inputs_slice(&shuffle_data, expected)?;
        for i in 0..count_usize {
            require!(
                slice[start_usize + i] == fields[i * 32..i * 32 + 32],
                ErrorCode::InvalidStagingWrite
            );
        }
        return Ok(());
    }
    write_inputs_chunk(&mut shuffle_data, start, &fields, expected)
}

/// Copy one chunk's MSM partial, then return the chunk rent to this seat's vault.
pub fn absorb_shuffle_partial(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let game = ix.load::<GameState>(false)?;
    let player = ix.load::<PlayerState>(false)?;
    let shuffle = ix.unchecked(true)?;
    let chunk = ix.unchecked(true)?;
    let vault = ix.unchecked(true)?;
    require_shuffler(&game, &player, &authority.key())?;
    require_vault_for_player(&vault.to_account_info(), &player.authority)?;
    ix.check_seeds(
        &shuffle.to_account_info(),
        &[b"shuffle_inputs", &game.game_id[..]],
        false,
    )?;
    let (start, _count, _fields) = read_chunk(&game, &chunk.to_account_info())?;
    let mut partial = [0u8; 64];
    {
        let data = chunk.try_borrow_data()?;
        partial.copy_from_slice(&data[PARTIAL_AT..PARTIAL_AT + 64]);
    }
    {
        let mut shuffle_data = shuffle.try_borrow_mut_data()?;
        let expected = game.config()?.shuffle_caller_public_inputs();
        let chunk_id = start as usize / SHUFFLE_CHUNK_FIELDS;
        if prepare_chunk_written(&shuffle_data, chunk_id, expected)? {
            require!(
                partial_g1_ref(&shuffle_data, chunk_id, expected)? == &partial,
                ErrorCode::InvalidStagingWrite
            );
        } else {
            write_prepare_chunk(&mut shuffle_data, start, expected, &partial)?;
        }
    }
    rent_vault::refund_staging(&chunk.to_account_info(), &vault.to_account_info())
}

/// Copy every chunk's fields and MSM partial into the shuffle buffer, then
/// return each chunk's rent. One transaction holds as many chunks as a
/// 1232-byte packet allows (26, once the client adds compute-budget
/// instructions). Chunks in the batch are independent, so several batches
/// can be submitted together.
pub fn absorb_shuffle_batch(accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
    require!(data.is_empty(), ErrorCode::InvalidPublicInputs);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let game = ix.load::<GameState>(false)?;
    let player = ix.load::<PlayerState>(false)?;
    let shuffle = ix.unchecked(true)?;
    let vault = ix.unchecked(true)?;
    require_shuffler(&game, &player, &authority.key())?;
    require_vault_for_player(&vault.to_account_info(), &player.authority)?;
    ix.check_seeds(
        &shuffle.to_account_info(),
        &[b"shuffle_inputs", &game.game_id[..]],
        false,
    )?;
    let chunks = ix.rest();
    require!(
        !chunks.is_empty() && chunks.len() <= 26,
        ErrorCode::InvalidPublicInputs
    );
    for chunk in &chunks {
        require!(chunk.is_writable(), ErrorCode::InvalidPublicInputs);
        copy_chunk_into_buffer(&game, &shuffle.to_account_info(), chunk, &vault.to_account_info())?;
    }
    Ok(())
}

fn copy_chunk_into_buffer(
    game: &GameState,
    shuffle: &AccountInfo,
    chunk: &AccountInfo,
    vault: &AccountInfo,
) -> Result<()> {
    let (start, count, fields) = read_chunk(game, chunk)?;
    let expected = game.config()?.shuffle_caller_public_inputs();
    let start_usize = start as usize;
    let count_usize = count as usize;
    let mut partial = [0u8; 64];
    {
        let data = chunk.try_borrow_data()?;
        partial.copy_from_slice(&data[PARTIAL_AT..PARTIAL_AT + 64]);
    }
    {
        let mut shuffle_data = shuffle.try_borrow_mut_data()?;
        if inputs_range_written(&shuffle_data, start_usize, count_usize, expected)? {
            let slice = public_inputs_slice(&shuffle_data, expected)?;
            for i in 0..count_usize {
                require!(
                    slice[start_usize + i] == fields[i * 32..i * 32 + 32],
                    ErrorCode::InvalidStagingWrite
                );
            }
        } else {
            write_inputs_chunk(&mut shuffle_data, start, &fields, expected)?;
        }
        let chunk_id = start_usize / SHUFFLE_CHUNK_FIELDS;
        if prepare_chunk_written(&shuffle_data, chunk_id, expected)? {
            require!(
                partial_g1_ref(&shuffle_data, chunk_id, expected)? == &partial,
                ErrorCode::InvalidStagingWrite
            );
        } else {
            write_prepare_chunk(&mut shuffle_data, start, expected, &partial)?;
        }
    }
    if chunk.owner() == crate::ID && chunk.lamports() > 0 {
        rent_vault::refund_staging(chunk, vault)?;
    }
    Ok(())
}

fn read_chunk(game: &GameState, chunk: &AccountInfo) -> Result<(u16, u16, Vec<u8>)> {
    let data = chunk.try_borrow_data()?;
    require!(data.len() >= SHUFFLE_CHUNK_SIZE, ErrorCode::InvalidPublicInputs);
    let mut game_id = [0u8; 32];
    game_id.copy_from_slice(&data[0..32]);
    require!(game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    let mut generation = [0u8; 8];
    generation.copy_from_slice(&data[64..72]);
    require!(
        u64::from_le_bytes(generation) == game.generation,
        ErrorCode::InvalidPublicInputs
    );
    require!(data[72] == game.current_player, ErrorCode::InvalidPublicInputs);
    let mut start_bytes = [0u8; 2];
    start_bytes.copy_from_slice(&data[73..75]);
    let start = u16::from_le_bytes(start_bytes);
    let mut count_bytes = [0u8; 2];
    count_bytes.copy_from_slice(&data[75..77]);
    let count = u16::from_le_bytes(count_bytes);
    require!(
        (start as usize) % SHUFFLE_CHUNK_FIELDS == 0
            && count > 0
            && count as usize <= SHUFFLE_CHUNK_FIELDS,
        ErrorCode::InvalidPublicInputs
    );
    let (expected, _) = Pubkey::find_program_address(
        &[b"shuffle_chunk", &game.game_id[..], &start.to_le_bytes()],
        &crate::ID,
    );
    require_keys_eq!(chunk.key(), expected, ErrorCode::InvalidPublicInputs);
    let nbytes = count as usize * 32;
    Ok((
        start,
        count,
        data[SHUFFLE_CHUNK_HEADER..SHUFFLE_CHUNK_HEADER + nbytes].to_vec(),
    ))
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    {
        let mut src = from.try_borrow_mut_lamports()?;
        *src = src.checked_sub(amount).ok_or(ErrorCode::InvalidPublicInputs)?;
    }
    {
        let mut dst = to.try_borrow_mut_lamports()?;
        *dst = dst.checked_add(amount).ok_or(ErrorCode::InvalidPublicInputs)?;
    }
    Ok(())
}
