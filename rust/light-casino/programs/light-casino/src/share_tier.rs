//! Two-tier share output.
//!
//! Poker, blackjack, bingo, and baccarat upload each street's partials in
//! Poseidon chunks of 12. The chain hashes a street once its chunks are in,
//! then folds those street hashes into the Groth16 output. When a card's
//! partials are opened, their Poseidon hash must equal the hash committed
//! for that card.

use crate::poseidon_hash::poseidon_fields_be;
use crate::prelude::*;
use crate::rent_vault::{refund_staging, require_vault_for_player};
use crate::shuffle_hash::hash_chunk_refs;
use crate::shuffle_hash::hash_flat_values_be;
use crate::ErrorCode;
use crate::GamePhase;
use crate::PROOF_PHASE_SHARE;
use shared_zk_ids::{GameKind, PROOF_RECEIPT_V2_SEED, RECEIPT_STATUS_INITIALIZED};

/// One chunk hash. Seeds are `share_chunk || game || generation || player || street || chunk`.
pub const SHARE_CHUNK_SEED: &[u8] = b"share_chunk";
pub const SHARE_CHUNK_LEN: usize = 32;

/// Poseidon width. A street is uploaded as whole chunks of this many fields,
/// with a short tail on the last chunk.
pub const SHARE_UPLOAD_CHUNK: usize = 12;
/// Largest street is a poker flop: 9 recipients × 3 cards × 4 limbs = 108 fields.
pub const MAX_STREET_CHUNKS: usize = 12;

/// Account bytes before the published-hash tail on a share receipt.
/// discriminator || ProofReceipt body.
pub const PROOF_RECEIPT_PREFIX: usize = 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1;
pub const MAX_PUBLISHED_TIERS: usize = 16;
const TIER_COUNT_AT: usize = PROOF_RECEIPT_PREFIX;
const TIER_HASH_AT: usize = PROOF_RECEIPT_PREFIX + 1;
const STREET_WORK_AT: usize = TIER_HASH_AT + MAX_PUBLISHED_TIERS * 32;
const ACTIVE_STREET_AT: usize = STREET_WORK_AT;
const CHUNK_MASK_AT: usize = STREET_WORK_AT + 1;
const READY_MASK_AT: usize = STREET_WORK_AT + 3;
const CHUNK_HASH_AT: usize = STREET_WORK_AT + 5;
/// active street, in-progress chunk mask, completed-street mask, 12 chunk hashes.
const STREET_WORK_LEN: usize = 5 + MAX_STREET_CHUNKS * 32;
pub const SHARE_RECEIPT_LEN: usize = STREET_WORK_AT + STREET_WORK_LEN;

pub fn tier_hash_count(kind: GameKind) -> Option<usize> {
    match kind {
        GameKind::Poker => Some(13),
        GameKind::Blackjack => Some(16),
        GameKind::Bingo => Some(5),
        GameKind::Baccarat => Some(4),
        _ => None,
    }
}

fn poseidon_all(fields: &[[u8; 32]]) -> Result<[u8; 32]> {
    let refs: Vec<&[u8]> = fields.iter().map(|field| field.as_slice()).collect();
    poseidon_fields_be(&refs)
}

/// Fold the published first-tier hashes into the single share output.
pub fn fold_tier_hashes(kind: GameKind, hashes: &[[u8; 32]]) -> Result<[u8; 32]> {
    match kind {
        GameKind::Blackjack => {
            require!(hashes.len() == 16, ErrorCode::InvalidPublicInputs);
            let first = poseidon_all(&hashes[..8])?;
            let rest = poseidon_all(&hashes[8..16])?;
            poseidon_all(&[first, rest])
        }
        GameKind::Bingo => {
            require!(hashes.len() == 5, ErrorCode::InvalidPublicInputs);
            poseidon_all(hashes)
        }
        GameKind::Poker => {
            require!(hashes.len() == 13, ErrorCode::InvalidPublicInputs);
            let holes = poseidon_all(&hashes[..10])?;
            let board = poseidon_all(&hashes[10..13])?;
            poseidon_all(&[holes, board])
        }
        GameKind::Baccarat => {
            require!(hashes.len() == 4, ErrorCode::InvalidPublicInputs);
            poseidon_all(hashes)
        }
        _ => return Err(error!(ErrorCode::InvalidGameConfig)),
    }
}

/// Instruction tail: exactly `n` big-endian field elements, or empty for other games.
pub fn parse_published_tiers(kind: GameKind, bytes: &[u8]) -> Result<Vec<[u8; 32]>> {
    let Some(n) = tier_hash_count(kind) else {
        require!(bytes.is_empty(), ErrorCode::InvalidPublicInputs);
        return Ok(Vec::new());
    };
    require!(bytes.len() == n * 32, ErrorCode::InvalidPublicInputs);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = i * 32;
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes[start..start + 32]);
        out.push(hash);
    }
    Ok(out)
}

/// Fields in one street, in the same recipient-major order `hashFieldElements` uses.
pub fn street_field_count(kind: GameKind, street: usize) -> Result<usize> {
    let fields = match kind {
        GameKind::Poker => {
            let cards = match street {
                0..=9 => 2,
                10 => 3,
                11 | 12 => 1,
                _ => return Err(error!(ErrorCode::InvalidPublicInputs)),
            };
            9 * cards * 4
        }
        GameKind::Blackjack => {
            if street >= 16 {
                return Err(error!(ErrorCode::InvalidPublicInputs));
            }
            7 * 4
        }
        GameKind::Bingo => {
            if street >= 5 {
                return Err(error!(ErrorCode::InvalidPublicInputs));
            }
            11 * 4
        }
        GameKind::Baccarat => {
            let cards = match street {
                0 | 1 => 2,
                2 | 3 => 1,
                _ => return Err(error!(ErrorCode::InvalidPublicInputs)),
            };
            11 * cards * 4
        }
        _ => return Err(error!(ErrorCode::InvalidGameConfig)),
    };
    Ok(fields)
}

fn street_bit(index: usize) -> Result<u16> {
    let shift = u32::try_from(index).map_err(|_| error!(ErrorCode::InvalidPublicInputs))?;
    1u16
        .checked_shl(shift)
        .ok_or(error!(ErrorCode::InvalidPublicInputs))
}

fn full_ready_mask(n: usize) -> Result<u16> {
    if n == 16 {
        return Ok(u16::MAX);
    }
    Ok(street_bit(n)?.wrapping_sub(1))
}

fn read_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

fn write_u16(data: &mut [u8], at: usize, value: u16) {
    data[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

/// Hash one 12-field chunk of a street. The street hash is written once every chunk is in.
pub fn absorb_street_chunk(
    data: &mut [u8],
    kind: GameKind,
    street: usize,
    chunk: usize,
    fields: &[[u8; 32]],
) -> Result<()> {
    let streets = tier_hash_count(kind).ok_or(error!(ErrorCode::InvalidGameConfig))?;
    require!(
        data.len() >= SHARE_RECEIPT_LEN && street < streets,
        ErrorCode::InvalidPublicInputs
    );
    let ready = read_u16(data, READY_MASK_AT);
    let street_flag = street_bit(street)?;
    if ready & street_flag != 0 {
        return Ok(());
    }
    let n_fields = street_field_count(kind, street)?;
    let n_chunks = n_fields.div_ceil(SHARE_UPLOAD_CHUNK);
    require!(
        n_chunks > 0 && n_chunks <= MAX_STREET_CHUNKS && chunk < n_chunks,
        ErrorCode::InvalidPublicInputs
    );
    let expect = if chunk + 1 == n_chunks {
        n_fields - chunk * SHARE_UPLOAD_CHUNK
    } else {
        SHARE_UPLOAD_CHUNK
    };
    require!(fields.len() == expect, ErrorCode::InvalidPublicInputs);

    let active = data[ACTIVE_STREET_AT];
    let mask = read_u16(data, CHUNK_MASK_AT);
    if mask != 0 && active != street as u8 {
        return Err(error!(ErrorCode::InvalidPublicInputs));
    }
    if mask == 0 {
        data[ACTIVE_STREET_AT] = street as u8;
        let hashes = CHUNK_HASH_AT + n_chunks * 32;
        data[CHUNK_HASH_AT..hashes].fill(0);
    }

    let chunk_hash = hash_chunk_refs(fields)?;
    let at = CHUNK_HASH_AT + chunk * 32;
    let bit = street_bit(chunk)?;
    if mask & bit != 0 {
        require!(
            data[at..at + 32] == chunk_hash[..],
            ErrorCode::InvalidPublicInputs
        );
        return Ok(());
    }
    data[at..at + 32].copy_from_slice(&chunk_hash);
    let mask = mask | bit;
    write_u16(data, CHUNK_MASK_AT, mask);
    let done = full_ready_mask(n_chunks)?;
    if mask != done {
        return Ok(());
    }

    let mut folded_inputs = [[0u8; 32]; MAX_STREET_CHUNKS];
    for i in 0..n_chunks {
        let start = CHUNK_HASH_AT + i * 32;
        folded_inputs[i].copy_from_slice(&data[start..start + 32]);
    }
    store_street_hash(data, street, street_flag, streets, &folded_inputs[..n_chunks])
}

/// Poseidon of one street's chunk hashes. Sets the street's ready bit.
fn store_street_hash(
    data: &mut [u8],
    street: usize,
    street_flag: u16,
    streets: usize,
    chunk_hashes: &[[u8; 32]],
) -> Result<()> {
    let street_hash = hash_chunk_refs(chunk_hashes)?;
    let slot = TIER_HASH_AT + street * 32;
    let ready = read_u16(data, READY_MASK_AT);
    if ready & street_flag != 0 {
        // Groth16 has not landed. A retry proves new partials; keep the street
        // hash aligned with those partials instead of rejecting the upload.
        if data.get(84).copied() == Some(RECEIPT_STATUS_INITIALIZED) {
            data[slot..slot + 32].copy_from_slice(&street_hash);
            return Ok(());
        }
        require!(
            data[slot..slot + 32] == street_hash[..],
            ErrorCode::InvalidPublicInputs
        );
        return Ok(());
    }
    data[slot..slot + 32].copy_from_slice(&street_hash);
    let ready = ready | street_flag;
    write_u16(data, READY_MASK_AT, ready);
    write_u16(data, CHUNK_MASK_AT, 0);
    data[ACTIVE_STREET_AT] = 0xff;
    if ready == full_ready_mask(streets)? {
        data[TIER_COUNT_AT] = streets as u8;
    }
    Ok(())
}

/// Street hashes produced by [`absorb_street_chunk`], in street order.
pub fn stored_tier_hashes(data: &[u8], kind: GameKind) -> Result<Vec<[u8; 32]>> {
    let streets = tier_hash_count(kind).ok_or(error!(ErrorCode::InvalidGameConfig))?;
    require!(data.len() >= SHARE_RECEIPT_LEN, ErrorCode::InvalidPublicInputs);
    require!(
        read_u16(data, READY_MASK_AT) == full_ready_mask(streets)?,
        ErrorCode::InvalidPublicInputs
    );
    let mut out = Vec::with_capacity(streets);
    for street in 0..streets {
        let start = TIER_HASH_AT + street * 32;
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[start..start + 32]);
        out.push(hash);
    }
    Ok(out)
}

/// Apply every chunk in one transaction. Each chunk is `street, index, n, n×32`.
pub fn absorb_share_street(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    require!(!data.is_empty(), ErrorCode::InvalidPublicInputs);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let signer = ix.signer(true)?;
    let game = ix.load::<crate::GameState>(false)?;
    let player = ix.load::<crate::PlayerState>(false)?;
    let receipt = ix.unchecked(true)?;
    require!(
        game.phase == GamePhase::Share as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player.game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    require!(player.authority == signer.key(), ErrorCode::InvalidAuthority);
    ix.check_seeds(
        &game.to_account_info(),
        &[b"game_state", &game.game_id[..]],
        false,
    )?;
    ix.check_seeds(
        &player.to_account_info(),
        &[b"player", &player.game_id[..], &[player.player_index]],
        false,
    )?;
    let kind = game.config()?.kind();
    require!(
        tier_hash_count(kind).is_some(),
        ErrorCode::InvalidGameConfig
    );

    let receipt_data = receipt.try_borrow_data()?;
    require!(
        receipt_data.len() >= SHARE_RECEIPT_LEN
            && receipt_data.len() >= 85
            && receipt_data[48] == PROOF_PHASE_SHARE
            && receipt_data[49] == player.player_index
            && receipt_data[84] == RECEIPT_STATUS_INITIALIZED
            && receipt_data[8..40] == game.game_id,
        ErrorCode::InvalidPublicInputs
    );
    let mut generation = [0u8; 8];
    generation.copy_from_slice(&receipt_data[40..48]);
    drop(receipt_data);
    ix.check_seeds(
        &receipt.to_account_info(),
        &[
            PROOF_RECEIPT_V2_SEED,
            &game.game_id[..],
            &generation,
            &[PROOF_PHASE_SHARE],
            &[player.player_index],
        ],
        false,
    )?;
    let mut receipt_data = receipt.try_borrow_mut_data()?;

    while !data.is_empty() {
        require!(data.len() >= 3, ErrorCode::InvalidPublicInputs);
        let street = data[0] as usize;
        let chunk = data[1] as usize;
        let n = data[2] as usize;
        data = &data[3..];
        require!(
            n > 0 && n <= SHARE_UPLOAD_CHUNK && data.len() >= n * 32,
            ErrorCode::InvalidPublicInputs
        );
        let mut fields = [[0u8; 32]; SHARE_UPLOAD_CHUNK];
        for field in &mut fields[..n] {
            field.copy_from_slice(&data[..32]);
            data = &data[32..];
        }
        absorb_street_chunk(&mut receipt_data, kind, street, chunk, &fields[..n])?;
    }
    Ok(())
}

fn load_share_seat<'a>(
    ix: &mut IxCursor<'a, '_>,
    writable_signer: bool,
) -> Result<(Signer<'a>, Account<'a, crate::GameState>, Account<'a, crate::PlayerState>)> {
    let authority = ix.signer(writable_signer)?;
    let game = ix.load::<crate::GameState>(false)?;
    let player = ix.load::<crate::PlayerState>(false)?;
    require!(
        game.phase == GamePhase::Share as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player.game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    require!(player.authority == authority.key(), ErrorCode::InvalidAuthority);
    ix.check_seeds(
        &game.to_account_info(),
        &[b"game_state", &game.game_id[..]],
        false,
    )?;
    ix.check_seeds(
        &player.to_account_info(),
        &[b"player", &player.game_id[..], &[player.player_index]],
        false,
    )?;
    Ok((authority, game, player))
}

/// Hash one 12-field chunk into its own account. Chunks do not share a writable account.
pub fn write_share_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    require!(data.len() >= 11, ErrorCode::InvalidPublicInputs);
    let mut generation = [0u8; 8];
    generation.copy_from_slice(&data[..8]);
    data = &data[8..];
    let street = data[0] as usize;
    let chunk = data[1] as usize;
    let n = data[2] as usize;
    data = &data[3..];
    require!(
        n > 0 && n <= SHARE_UPLOAD_CHUNK && data.len() == n * 32,
        ErrorCode::InvalidPublicInputs
    );
    let mut fields = [[0u8; 32]; SHARE_UPLOAD_CHUNK];
    for field in &mut fields[..n] {
        field.copy_from_slice(&data[..32]);
        data = &data[32..];
    }

    let mut ix = IxCursor::new(accounts, crate::ID);
    let _authority = ix.signer(false)?;
    let payer = ix.signer(true)?;
    let game = ix.load::<crate::GameState>(false)?;
    let player = ix.load::<crate::PlayerState>(false)?;
    require!(
        game.phase == GamePhase::Share as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player.game_id == game.game_id, ErrorCode::InvalidPublicInputs);
    require!(
        player.authority == _authority.key(),
        ErrorCode::InvalidAuthority
    );
    ix.check_seeds(
        &game.to_account_info(),
        &[b"game_state", &game.game_id[..]],
        false,
    )?;
    ix.check_seeds(
        &player.to_account_info(),
        &[b"player", &player.game_id[..], &[player.player_index]],
        false,
    )?;
    let kind = game.config()?.kind();
    let n_fields = street_field_count(kind, street)?;
    let n_chunks = n_fields.div_ceil(SHARE_UPLOAD_CHUNK);
    require!(chunk < n_chunks, ErrorCode::InvalidPublicInputs);
    let expect = if chunk + 1 == n_chunks {
        n_fields - chunk * SHARE_UPLOAD_CHUNK
    } else {
        SHARE_UPLOAD_CHUNK
    };
    require!(n == expect, ErrorCode::InvalidPublicInputs);
    let chunk_account = ix.open_or_init(
        &payer.to_account_info(),
        SHARE_CHUNK_LEN,
        &[
            SHARE_CHUNK_SEED,
            &game.game_id[..],
            &generation,
            &[player.player_index],
            &[street as u8],
            &[chunk as u8],
        ],
    )?;
    let _system = ix.system()?;
    let hash = hash_chunk_refs(&fields[..n])?;
    let mut stored = chunk_account.try_borrow_mut_data()?;
    // Staging only. The receipt fold is the commitment, and a share retry
    // writes a fresh hash here before Groth16.
    stored[..SHARE_CHUNK_LEN].copy_from_slice(&hash);
    Ok(())
}

/// Fold one street's chunk hashes into the receipt and return their rent.
pub fn finish_share_street(accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
    require!(data.len() == 1, ErrorCode::InvalidPublicInputs);
    let street = data[0] as usize;
    let mut ix = IxCursor::new(accounts, crate::ID);
    let (_authority, game, player) = load_share_seat(&mut ix, true)?;
    let receipt = ix.unchecked(true)?;
    let vault = ix.unchecked(true)?;
    require_vault_for_player(&vault.to_account_info(), &player.authority)?;
    let kind = game.config()?.kind();
    let streets = tier_hash_count(kind).ok_or(error!(ErrorCode::InvalidGameConfig))?;
    require!(street < streets, ErrorCode::InvalidPublicInputs);
    let n_fields = street_field_count(kind, street)?;
    let n_chunks = n_fields.div_ceil(SHARE_UPLOAD_CHUNK);
    let chunks = ix.rest();
    require!(chunks.len() == n_chunks, ErrorCode::InvalidPublicInputs);

    let street_flag = street_bit(street)?;
    let already = {
        let data = receipt.try_borrow_data()?;
        data.len() >= SHARE_RECEIPT_LEN && read_u16(&data, READY_MASK_AT) & street_flag != 0
    };
    if already {
        let open = {
            let data = receipt.try_borrow_data()?;
            data.len() > 84 && data[84] == RECEIPT_STATUS_INITIALIZED
        };
        // Verified receipts keep the committed street. An open receipt is
        // rewritten from the chunks this retry just uploaded.
        if !open {
            for chunk in &chunks {
                if chunk.owner() == crate::ID && chunk.lamports() > 0 {
                    refund_staging(chunk, &vault.to_account_info())?;
                }
            }
            return Ok(());
        }
    }

    let receipt_data = receipt.try_borrow_data()?;
    require!(
        receipt_data.len() >= SHARE_RECEIPT_LEN
            && receipt_data[48] == PROOF_PHASE_SHARE
            && receipt_data[49] == player.player_index
            && receipt_data[84] == RECEIPT_STATUS_INITIALIZED
            && receipt_data[8..40] == game.game_id,
        ErrorCode::InvalidPublicInputs
    );
    let mut generation = [0u8; 8];
    generation.copy_from_slice(&receipt_data[40..48]);
    drop(receipt_data);
    ix_check_receipt(&game.game_id, &generation, player.player_index, &receipt)?;

    let mut hashes = [[0u8; 32]; MAX_STREET_CHUNKS];
    for (index, chunk) in chunks.iter().enumerate() {
        require!(chunk.is_writable(), ErrorCode::InvalidPublicInputs);
        let (expected, _) = Pubkey::find_program_address(
            &[
                SHARE_CHUNK_SEED,
                &game.game_id[..],
                &generation,
                &[player.player_index],
                &[street as u8],
                &[index as u8],
            ],
            &crate::ID,
        );
        require_keys_eq!(chunk.key(), expected, ErrorCode::InvalidPublicInputs);
        let data = chunk.try_borrow_data()?;
        require!(
            chunk.owner() == crate::ID && data.len() >= SHARE_CHUNK_LEN,
            ErrorCode::InvalidPublicInputs
        );
        hashes[index].copy_from_slice(&data[..SHARE_CHUNK_LEN]);
        require!(
            hashes[index] != [0u8; 32],
            ErrorCode::InvalidPublicInputs
        );
    }
    {
        let mut receipt_data = receipt.try_borrow_mut_data()?;
        store_street_hash(
            &mut receipt_data,
            street,
            street_flag,
            streets,
            &hashes[..n_chunks],
        )?;
    }
    for chunk in &chunks {
        if chunk.owner() == crate::ID && chunk.lamports() > 0 {
            refund_staging(chunk, &vault.to_account_info())?;
        }
    }
    Ok(())
}

fn ix_check_receipt(
    game_id: &[u8; 32],
    generation: &[u8; 8],
    player_index: u8,
    receipt: &AccountInfo,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[
            PROOF_RECEIPT_V2_SEED,
            game_id,
            generation,
            &[PROOF_PHASE_SHARE],
            &[player_index],
        ],
        &crate::ID,
    );
    require_keys_eq!(receipt.key(), expected, ErrorCode::InvalidPublicInputs);
    Ok(())
}

/// Persist the hashes that were folded into the share output.
pub fn write_published_tiers(data: &mut [u8], hashes: &[[u8; 32]]) -> Result<()> {
    require!(
        hashes.len() <= MAX_PUBLISHED_TIERS && data.len() >= SHARE_RECEIPT_LEN,
        ErrorCode::InvalidPublicInputs
    );
    data[PROOF_RECEIPT_PREFIX] = hashes.len() as u8;
    for (i, hash) in hashes.iter().enumerate() {
        let start = PROOF_RECEIPT_PREFIX + 1 + i * 32;
        data[start..start + 32].copy_from_slice(hash);
    }
    let used = PROOF_RECEIPT_PREFIX + 1 + hashes.len() * 32;
    data[used..SHARE_RECEIPT_LEN].fill(0);
    Ok(())
}

pub fn published_tier_at(data: &[u8], index: usize) -> Result<[u8; 32]> {
    require!(data.len() >= PROOF_RECEIPT_PREFIX + 1, ErrorCode::InvalidPublicInputs);
    let n = data[PROOF_RECEIPT_PREFIX] as usize;
    require!(
        n <= MAX_PUBLISHED_TIERS
            && index < n
            && data.len() >= PROOF_RECEIPT_PREFIX + 1 + n * 32,
        ErrorCode::InvalidPublicInputs
    );
    let start = PROOF_RECEIPT_PREFIX + 1 + index * 32;
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[start..start + 32]);
    Ok(hash)
}

/// Poseidon of one card's opened recipient partials. Same chunking as `HashFlat`.
pub fn hash_opened_partials(limbs: &[[u8; 32]]) -> Result<[u8; 32]> {
    hash_flat_values_be(limbs)
}

/// Reveal check: the opened partials for one card must match its committed hash.
pub fn require_opened_column(committed: &[u8; 32], limbs: &[[u8; 32]]) -> Result<()> {
    let got = hash_opened_partials(limbs)?;
    require!(got == *committed, ErrorCode::InvalidPublicInputs);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(n: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..32].copy_from_slice(&n.to_be_bytes());
        out
    }

    fn seq(n: usize) -> Vec<[u8; 32]> {
        (0..n).map(|i| fe((i as u64) + 1)).collect()
    }

    #[test]
    fn blackjack_fold_is_eight_and_eight() {
        let hashes = seq(16);
        let folded = fold_tier_hashes(GameKind::Blackjack, &hashes).unwrap();
        let first = poseidon_all(&hashes[..8]).unwrap();
        let rest = poseidon_all(&hashes[8..16]).unwrap();
        let expected = poseidon_all(&[first, rest]).unwrap();
        assert_eq!(folded, expected);

        let old_first = poseidon_all(&hashes[..12]).unwrap();
        let old_rest = poseidon_all(&hashes[12..16]).unwrap();
        let old = poseidon_all(&[old_first, old_rest]).unwrap();
        assert_ne!(folded, old);
        assert_ne!(folded, [0u8; 32]);
    }

    #[test]
    fn bingo_fold_is_poseidon_of_the_five_ball_hashes() {
        let hashes = seq(5);
        let folded = fold_tier_hashes(GameKind::Bingo, &hashes).unwrap();
        assert_eq!(folded, poseidon_all(&hashes).unwrap());
    }

    #[test]
    fn poker_fold_is_ten_hole_hashes_and_three_board_hashes() {
        let hashes = seq(13);
        let folded = fold_tier_hashes(GameKind::Poker, &hashes).unwrap();
        let holes = poseidon_all(&hashes[..10]).unwrap();
        let board = poseidon_all(&hashes[10..13]).unwrap();
        assert_eq!(folded, poseidon_all(&[holes, board]).unwrap());
    }

    #[test]
    fn baccarat_fold_is_poseidon_of_the_four_street_hashes() {
        let hashes = seq(4);
        let folded = fold_tier_hashes(GameKind::Baccarat, &hashes).unwrap();
        assert_eq!(folded, poseidon_all(&hashes).unwrap());
        assert!(parse_published_tiers(GameKind::Baccarat, &seq(4).into_iter().flatten().collect::<Vec<_>>()).is_ok());
        assert!(parse_published_tiers(GameKind::Baccarat, &[]).is_err());
    }

    #[test]
    fn published_tail_must_match_the_game() {
        let bytes: Vec<u8> = seq(16).into_iter().flatten().collect();
        assert!(parse_published_tiers(GameKind::Blackjack, &bytes).is_ok());
        assert!(parse_published_tiers(GameKind::Bingo, &bytes).is_err());
        assert!(parse_published_tiers(GameKind::War, &[]).is_ok());
        assert!(parse_published_tiers(GameKind::War, &bytes[..32]).is_err());
    }

    #[test]
    fn stored_hash_is_the_one_checked_when_the_card_opens() {
        let hashes = seq(16);
        let mut receipt = vec![0u8; SHARE_RECEIPT_LEN];
        write_published_tiers(&mut receipt, &hashes).unwrap();
        let committed = published_tier_at(&receipt, 3).unwrap();
        assert_eq!(committed, hashes[3]);

        let mut limbs: Vec<[u8; 32]> = (0..28).map(|i| fe(100 + i)).collect();
        let card_hash = hash_opened_partials(&limbs).unwrap();
        require_opened_column(&card_hash, &limbs).unwrap();
        limbs[0][31] ^= 1;
        assert!(require_opened_column(&card_hash, &limbs).is_err());
    }

    #[test]
    fn share_output_is_the_fold_of_the_published_hashes() {
        let hashes = seq(16);
        let bytes: Vec<u8> = hashes.iter().flatten().copied().collect();
        let published = parse_published_tiers(GameKind::Blackjack, &bytes).unwrap();
        let output = fold_tier_hashes(GameKind::Blackjack, &published).unwrap();
        let mut wrong = published.clone();
        wrong.swap(0, 1);
        assert_ne!(
            fold_tier_hashes(GameKind::Blackjack, &wrong).unwrap(),
            output
        );
    }

    fn absorb_street(kind: GameKind, street: usize, fields: &[[u8; 32]]) -> Vec<u8> {
        let mut receipt = vec![0u8; SHARE_RECEIPT_LEN];
        let mut chunk = 0usize;
        let mut offset = 0usize;
        while offset < fields.len() {
            let end = (offset + SHARE_UPLOAD_CHUNK).min(fields.len());
            absorb_street_chunk(&mut receipt, kind, street, chunk, &fields[offset..end]).unwrap();
            chunk += 1;
            offset = end;
        }
        receipt
    }

    #[test]
    fn uploaded_chunks_hash_to_the_same_street_as_the_flat_grid() {
        let blackjack: Vec<[u8; 32]> = (0..28).map(|i| fe(1 + i)).collect();
        let receipt = absorb_street(GameKind::Blackjack, 0, &blackjack);
        let expected = hash_flat_values_be(&blackjack).unwrap();
        let slot = PROOF_RECEIPT_PREFIX + 1;
        assert_eq!(&receipt[slot..slot + 32], &expected);
        assert!(stored_tier_hashes(&receipt, GameKind::Blackjack).is_err());

        let poker: Vec<[u8; 32]> = (0..72).map(|i| fe(50 + i)).collect();
        let receipt = absorb_street(GameKind::Poker, 3, &poker);
        let expected = hash_flat_values_be(&poker).unwrap();
        let slot = PROOF_RECEIPT_PREFIX + 1 + 3 * 32;
        assert_eq!(&receipt[slot..slot + 32], &expected);

        let mut again = receipt.clone();
        absorb_street_chunk(&mut again, GameKind::Poker, 3, 0, &poker[..12]).unwrap();
        assert_eq!(again, receipt);
        assert!(absorb_street_chunk(&mut again, GameKind::Poker, 4, 0, &poker[..4]).is_err());

        let mut mid = vec![0u8; SHARE_RECEIPT_LEN];
        absorb_street_chunk(&mut mid, GameKind::Blackjack, 0, 0, &blackjack[..12]).unwrap();
        assert!(absorb_street_chunk(&mut mid, GameKind::Blackjack, 1, 0, &blackjack[..12]).is_err());
    }
}
