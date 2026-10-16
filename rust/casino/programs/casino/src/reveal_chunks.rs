//! Ephemeral reveal-staging chunks.
//!
//! Each chunk is its own account, so the writes land together. A later
//! instruction copies them into `deck_staging` and returns the rent.

use anchor_lang::prelude::*;

use crate::{apply_staging_bytes_write, ErrorCode, DECK_STAGING_ACCOUNT_SIZE};

/// Bytes of staging payload in one chunk transaction.
/// A 736-byte body plus the header, the refund account, and two signatures
/// stays inside a packet.
pub const REVEAL_CHUNK_BYTES: usize = 736;
/// game id, refund destination, offset, length.
pub const REVEAL_CHUNK_HEADER: usize = 32 + 32 + 4 + 2;
pub const REVEAL_CHUNK_ACCOUNT_SIZE: usize = REVEAL_CHUNK_HEADER + REVEAL_CHUNK_BYTES;

pub struct RevealChunkView<'a> {
    pub game_id: [u8; 32],
    pub payer: Pubkey,
    pub offset: u32,
    pub bytes: &'a [u8],
}

pub fn store_reveal_chunk(
    account: &mut [u8],
    game_id: &[u8; 32],
    payer: &Pubkey,
    offset: u32,
    data: &[u8],
) -> Result<()> {
    require!(account.len() == REVEAL_CHUNK_ACCOUNT_SIZE, ErrorCode::WriteExceedsBounds);
    require!(
        !data.is_empty() && data.len() <= REVEAL_CHUNK_BYTES && data.len() % 32 == 0,
        ErrorCode::StagingWriteMisaligned
    );
    require!(offset % 32 == 0, ErrorCode::StagingWriteMisaligned);
    let end = (offset as usize)
        .checked_add(data.len())
        .ok_or(ErrorCode::WriteExceedsBounds)?;
    require!(end <= DECK_STAGING_ACCOUNT_SIZE, ErrorCode::WriteExceedsBounds);

    account[..32].copy_from_slice(game_id);
    account[32..64].copy_from_slice(payer.as_ref());
    account[64..68].copy_from_slice(&offset.to_le_bytes());
    account[68..70].copy_from_slice(&(data.len() as u16).to_le_bytes());
    account[REVEAL_CHUNK_HEADER..REVEAL_CHUNK_HEADER + data.len()].copy_from_slice(data);
    account[REVEAL_CHUNK_HEADER + data.len()..].fill(0);
    Ok(())
}

pub fn view_reveal_chunk(account: &[u8]) -> Result<RevealChunkView<'_>> {
    require!(account.len() >= REVEAL_CHUNK_HEADER, ErrorCode::WriteExceedsBounds);
    let mut game_id = [0u8; 32];
    game_id.copy_from_slice(&account[..32]);
    let mut payer_bytes = [0u8; 32];
    payer_bytes.copy_from_slice(&account[32..64]);
    let mut offset_bytes = [0u8; 4];
    offset_bytes.copy_from_slice(&account[64..68]);
    let offset = u32::from_le_bytes(offset_bytes);
    let mut len_bytes = [0u8; 2];
    len_bytes.copy_from_slice(&account[68..70]);
    let len = u16::from_le_bytes(len_bytes) as usize;
    require!(
        len > 0 && len <= REVEAL_CHUNK_BYTES && len % 32 == 0 && offset % 32 == 0,
        ErrorCode::StagingWriteMisaligned
    );
    require!(account.len() >= REVEAL_CHUNK_HEADER + len, ErrorCode::WriteExceedsBounds);
    Ok(RevealChunkView {
        game_id,
        payer: Pubkey::new_from_array(payer_bytes),
        offset,
        bytes: &account[REVEAL_CHUNK_HEADER..REVEAL_CHUNK_HEADER + len],
    })
}

pub fn copy_reveal_chunk<'info>(
    game_id: &[u8; 32],
    chunk: &AccountInfo<'info>,
    lane: &AccountInfo<'info>,
    staging: &mut [u8],
) -> Result<()> {
    let data = chunk.try_borrow_data()?;
    let view = view_reveal_chunk(&data)?;
    require!(view.game_id == *game_id, ErrorCode::InvalidGamePhase);
    require_keys_eq!(view.payer, *lane.key, ErrorCode::InvalidAuthority);
    let (expected, _) = Pubkey::find_program_address(
        &[b"reveal_chunk", game_id, &view.offset.to_le_bytes()],
        &crate::ID,
    );
    require_keys_eq!(*chunk.key, expected, ErrorCode::InvalidStagingTarget);
    apply_staging_bytes_write(staging, view.offset, view.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_chunk_roundtrip_and_bounds() {
        assert_eq!(REVEAL_CHUNK_HEADER, 70);
        assert_eq!(REVEAL_CHUNK_BYTES % 32, 0);
        assert!(REVEAL_CHUNK_BYTES <= 900);
        assert_eq!(REVEAL_CHUNK_ACCOUNT_SIZE, 806);

        let payer = Pubkey::new_unique();
        let mut account = vec![0u8; REVEAL_CHUNK_ACCOUNT_SIZE];
        let payload = vec![7u8; 64];
        store_reveal_chunk(&mut account, &[9u8; 32], &payer, 128, &payload).unwrap();
        let view = view_reveal_chunk(&account).unwrap();
        assert_eq!(view.game_id, [9u8; 32]);
        assert_eq!(view.payer, payer);
        assert_eq!(view.offset, 128);
        assert_eq!(view.bytes, payload.as_slice());

        assert!(store_reveal_chunk(&mut account, &[9u8; 32], &payer, 1, &payload).is_err());
        assert!(store_reveal_chunk(&mut account, &[9u8; 32], &payer, 0, &[1u8; 31]).is_err());
        assert!(store_reveal_chunk(&mut account, &[9u8; 32], &payer, 0, &[1u8; 800]).is_err());
        assert!(
            store_reveal_chunk(&mut account, &[9u8; 32], &payer, 29_888, &payload).is_err()
        );
    }
}
