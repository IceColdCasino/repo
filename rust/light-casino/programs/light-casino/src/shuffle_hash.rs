use crate::prelude::*;

use crate::poseidon_hash::poseidon_fields_be;
use crate::PlayerState;

/// Fixed shuffle circuit width (`shuffle_1_deck_52_main` uses 12 player slots).
pub const SHUFFLE_PLAYER_SLOTS: usize = 12;

/// Fixed share/showdown circuit width (`poker_share_hashout_main` / showdown use 10 slots).
pub const SHARE_PLAYER_SLOTS: usize = 10;

const POSEIDON_CHUNK: usize = 12;
pub(crate) const PLAYER_PUBLIC_KEY_OFFSET: usize = 8 + 32 + 1 + 32;

/// BabyJub identity point: x = 0, y = 1 (big-endian field encoding).
pub fn identity_x() -> [u8; 32] {
    [0u8; 32]
}

pub fn identity_y() -> [u8; 32] {
    let mut y = [0u8; 32];
    y[31] = 1;
    y
}

/// Encode a small integer as a 32-byte big-endian BN254 field element.
pub fn field_from_u128(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&value.to_be_bytes());
    out
}

pub(crate) fn hash_chunk_refs(group: &[[u8; 32]]) -> Result<[u8; 32]> {
    require!(
        !group.is_empty() && group.len() <= POSEIDON_CHUNK,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut refs: [&[u8]; POSEIDON_CHUNK] = [&[]; POSEIDON_CHUNK];
    for (i, field) in group.iter().enumerate() {
        refs[i] = field.as_slice();
    }
    poseidon_fields_be(&refs[..group.len()])
}

/// Poseidon over a contiguous BE field buffer without `Vec<[u8; 32]>` copies.
///
/// Supports up to max shoe (1664 fields). Large chunk tables are heap-allocated
/// once per call (SBF bump allocator does not free — keep to one alloc path).
pub fn hash_flat_bytes_be(bytes: &[u8]) -> Result<[u8; 32]> {
    require!(
        !bytes.is_empty() && bytes.len() % 32 == 0,
        crate::ErrorCode::InvalidPublicInputs
    );
    let n_fields = bytes.len() / 32;
    // 8-deck: 1664 fields → 139 chunks; keep headroom for a third tree level.
    const MAX_CHUNKS: usize = 144;
    require!(
        n_fields <= MAX_CHUNKS * POSEIDON_CHUNK,
        crate::ErrorCode::InvalidPublicInputs
    );

    let n_chunks = n_fields.div_ceil(POSEIDON_CHUNK);
    require!(n_chunks <= MAX_CHUNKS, crate::ErrorCode::InvalidPublicInputs);
    let mut chunk_hashes = vec![[0u8; 32]; n_chunks];

    for c in 0..n_chunks {
        let start = c * POSEIDON_CHUNK;
        let end = (start + POSEIDON_CHUNK).min(n_fields);
        let len = end - start;
        let mut refs: [&[u8]; POSEIDON_CHUNK] = [&[]; POSEIDON_CHUNK];
        for i in 0..len {
            let off = (start + i) * 32;
            refs[i] = &bytes[off..off + 32];
        }
        chunk_hashes[c] = poseidon_fields_be(&refs[..len])?;
    }

    if n_chunks <= POSEIDON_CHUNK {
        return hash_chunk_refs(&chunk_hashes[..n_chunks]);
    }

    let n_level2 = n_chunks.div_ceil(POSEIDON_CHUNK);
    require!(n_level2 <= MAX_CHUNKS, crate::ErrorCode::InvalidPublicInputs);
    let mut level2 = vec![[0u8; 32]; n_level2];
    for c in 0..n_level2 {
        let start = c * POSEIDON_CHUNK;
        let end = (start + POSEIDON_CHUNK).min(n_chunks);
        level2[c] = hash_chunk_refs(&chunk_hashes[start..end])?;
    }
    if n_level2 <= POSEIDON_CHUNK {
        return hash_chunk_refs(&level2[..n_level2]);
    }
    let n_level3 = n_level2.div_ceil(POSEIDON_CHUNK);
    let mut level3 = vec![[0u8; 32]; n_level3];
    for c in 0..n_level3 {
        let start = c * POSEIDON_CHUNK;
        let end = (start + POSEIDON_CHUNK).min(n_level2);
        level3[c] = hash_chunk_refs(&level2[start..end])?;
    }
    hash_chunk_refs(&level3[..n_level3])
}

/// Row-major flatten + chunk-at-12 + hierarchical combine (matches `HashDeckGeneric`).
///
/// Heap-allocated like `hash_flat_bytes_be`. A 90-ball showdown row is 360 fields
/// (30 Poseidon chunks), which does not fit in the old 20-chunk stack table.
pub fn hash_flat_values_be(flat: &[[u8; 32]]) -> Result<[u8; 32]> {
    require!(!flat.is_empty(), crate::ErrorCode::InvalidPublicInputs);

    const MAX_CHUNKS: usize = 144;
    let n_chunks = flat.len().div_ceil(POSEIDON_CHUNK);
    require!(n_chunks <= MAX_CHUNKS, crate::ErrorCode::InvalidPublicInputs);
    let mut chunk_hashes = vec![[0u8; 32]; n_chunks];
    for c in 0..n_chunks {
        let start = c * POSEIDON_CHUNK;
        let end = (start + POSEIDON_CHUNK).min(flat.len());
        chunk_hashes[c] = hash_chunk_refs(&flat[start..end])?;
    }

    if n_chunks <= POSEIDON_CHUNK {
        return hash_chunk_refs(&chunk_hashes[..n_chunks]);
    }

    let n_level2 = n_chunks.div_ceil(POSEIDON_CHUNK);
    require!(n_level2 <= MAX_CHUNKS, crate::ErrorCode::InvalidPublicInputs);
    let mut level2 = vec![[0u8; 32]; n_level2];
    for c in 0..n_level2 {
        let start = c * POSEIDON_CHUNK;
        let end = (start + POSEIDON_CHUNK).min(n_chunks);
        level2[c] = hash_chunk_refs(&chunk_hashes[start..end])?;
    }
    hash_chunk_refs(&level2[..n_level2])
}

/// Single-deck (52 × 4) Poseidon deck hash. Accepts a larger buffer and hashes
/// only the leading 208 field elements.
pub fn hash_deck_52(deck: &[u8]) -> Result<[u8; 32]> {
    hash_deck_fields(deck, 208)
}

/// Poseidon deck hash over the first `deck_fields` field elements.
pub fn hash_deck_fields(deck: &[u8], deck_fields: usize) -> Result<[u8; 32]> {
    require!(
        deck_fields > 0 && deck.len() >= deck_fields * 32,
        crate::ErrorCode::InvalidPublicInputs
    );
    hash_flat_bytes_be(&deck[..deck_fields * 32])
}

/// `HashPublicKeys(12)` from `circuits/hash.circom`.
pub fn hash_public_keys_12(keys: &[[u8; 32]; 24]) -> Result<[u8; 32]> {
    let mut chunk1 = [[0u8; 32]; 12];
    let mut chunk2 = [[0u8; 32]; 12];
    chunk1.copy_from_slice(&keys[0..12]);
    chunk2.copy_from_slice(&keys[12..24]);

    let h1 = poseidon_fields_be(&chunk_refs(&chunk1))?;
    let h2 = poseidon_fields_be(&chunk_refs(&chunk2))?;
    poseidon_fields_be(&[h1.as_slice(), h2.as_slice()])
}

/// `HashPublicKeys(10)` from `circuits/hash.circom` (5+5 split).
pub fn hash_public_keys_10(keys: &[[u8; 32]; 20]) -> Result<[u8; 32]> {
    let mut chunk1 = [[0u8; 32]; 10];
    let mut chunk2 = [[0u8; 32]; 10];
    chunk1.copy_from_slice(&keys[0..10]);
    chunk2.copy_from_slice(&keys[10..20]);

    let h1 = poseidon_fields_be(&chunk_refs(&chunk1))?;
    let h2 = poseidon_fields_be(&chunk_refs(&chunk2))?;
    poseidon_fields_be(&[h1.as_slice(), h2.as_slice()])
}

/// `HashPublicKeys(2)` — slots share/showdown and 2-key bet circuits.
pub fn hash_public_keys_2(keys: &[[u8; 32]; 4]) -> Result<[u8; 32]> {
    let h1 = poseidon_fields_be(&[keys[0].as_slice(), keys[1].as_slice()])?;
    let h2 = poseidon_fields_be(&[keys[2].as_slice(), keys[3].as_slice()])?;
    poseidon_fields_be(&[h1.as_slice(), h2.as_slice()])
}

/// `HashPublicKeys(8)` from blackjack share/showdown (`ShareHashOut(8,*)` / `ShowdownHashOut(8)`).
pub fn hash_public_keys_8(keys: &[[u8; 32]; 16]) -> Result<[u8; 32]> {
    let mut chunk1 = [[0u8; 32]; 8];
    let mut chunk2 = [[0u8; 32]; 8];
    chunk1.copy_from_slice(&keys[0..8]);
    chunk2.copy_from_slice(&keys[8..16]);

    let h1 = poseidon_fields_be(&chunk_refs(&chunk1))?;
    let h2 = poseidon_fields_be(&chunk_refs(&chunk2))?;
    poseidon_fields_be(&[h1.as_slice(), h2.as_slice()])
}

fn chunk_refs<const N: usize>(chunk: &[[u8; 32]; N]) -> Vec<&[u8]> {
    chunk.iter().map(|f| f.as_slice()).collect()
}

/// Pad a list of registered player public keys to 10 share slots.
pub fn pad_registered_keys_to_share_slots(keys: &[[[u8; 32]; 2]]) -> [[u8; 32]; 20] {
    let mut out = [[0u8; 32]; 20];
    for slot in 0..SHARE_PLAYER_SLOTS {
        if slot < keys.len() {
            out[slot * 2] = keys[slot][0];
            out[slot * 2 + 1] = keys[slot][1];
        } else {
            out[slot * 2] = identity_x();
            out[slot * 2 + 1] = identity_y();
        }
    }
    out
}

/// Share-circuit key order: prover key first, then every other padded slot.
pub fn share_ordered_public_keys(
    registered: &[[[u8; 32]; 2]],
    prover_index: u8,
) -> Result<[[u8; 32]; 20]> {
    require!(
        (prover_index as usize) < registered.len() || (prover_index as usize) < SHARE_PLAYER_SLOTS,
        crate::ErrorCode::InvalidPlayerIndex
    );
    let padded = pad_registered_keys_to_share_slots(registered);
    require!(
        (prover_index as usize) < SHARE_PLAYER_SLOTS,
        crate::ErrorCode::InvalidPlayerIndex
    );
    let mut ordered = [[0u8; 32]; 20];
    ordered[0] = padded[prover_index as usize * 2];
    ordered[1] = padded[prover_index as usize * 2 + 1];
    let mut dst = 1usize;
    for slot in 0..SHARE_PLAYER_SLOTS {
        if slot == prover_index as usize {
            continue;
        }
        ordered[dst * 2] = padded[slot * 2];
        ordered[dst * 2 + 1] = padded[slot * 2 + 1];
        dst += 1;
    }
    Ok(ordered)
}

/// `PlayerState.padding` follows `public_key` (4×32 ElGamal limbs).
pub const PLAYER_PADDING_OFFSET: usize = PLAYER_PUBLIC_KEY_OFFSET + 64;

/// Read registered player public keys from remaining accounts (index order).
pub fn read_player_public_keys<'info>(
    remaining: &[AccountInfo<'info>],
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
) -> Result<Vec<[[u8; 32]; 2]>> {
    require!(
        remaining.len() >= num_players as usize,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut keys = Vec::with_capacity(num_players as usize);
    for slot in 0..num_players as usize {
        let acc = &remaining[slot];
        let (expected, _) =
            Pubkey::find_program_address(&[b"player", game_id, &[slot as u8]], program_id);
        require_keys_eq!(acc.key(), expected);
        let data = acc.try_borrow_data()?;
        require!(
            data.len() >= PLAYER_PUBLIC_KEY_OFFSET + 64,
            crate::ErrorCode::InvalidPublicInputs
        );
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        x.copy_from_slice(&data[PLAYER_PUBLIC_KEY_OFFSET..PLAYER_PUBLIC_KEY_OFFSET + 32]);
        y.copy_from_slice(&data[PLAYER_PUBLIC_KEY_OFFSET + 32..PLAYER_PUBLIC_KEY_OFFSET + 64]);
        keys.push([x, y]);
    }
    Ok(keys)
}

/// Read the proving player's register padding ciphertext (4 BE limbs).
pub fn read_player_padding(
    account: &AccountInfo,
    game_id: &[u8; 32],
    player_index: u8,
    program_id: &Pubkey,
) -> Result<[[u8; 32]; 4]> {
    let (expected, _) =
        Pubkey::find_program_address(&[b"player", game_id, &[player_index]], program_id);
    require_keys_eq!(account.key(), expected);
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= PLAYER_PADDING_OFFSET + 128,
        crate::ErrorCode::InvalidPublicInputs
    );
    let mut padding = [[0u8; 32]; 4];
    for i in 0..4 {
        let start = PLAYER_PADDING_OFFSET + i * 32;
        padding[i].copy_from_slice(&data[start..start + 32]);
    }
    Ok(padding)
}

/// Build 12 padded public-key slots from on-chain player states.
pub fn padded_shuffle_public_keys(
    players: &[PlayerState],
    num_players: u8,
) -> [[u8; 32]; 24] {
    let mut out = [[0u8; 32]; 24];
    for slot in 0..SHUFFLE_PLAYER_SLOTS {
        if (slot as u8) < num_players && (slot as usize) < players.len() {
            out[slot * 2] = players[slot].public_key[0];
            out[slot * 2 + 1] = players[slot].public_key[1];
        } else {
            out[slot * 2] = identity_x();
            out[slot * 2 + 1] = identity_y();
        }
    }
    out
}

/// `HashMain` / `Poker.shuffleHash`: Poseidon(deckHash, pkHash).
pub fn shuffle_input_hash(deck: &[u8], players: &[PlayerState], num_players: u8) -> Result<[u8; 32]> {
    let deck_hash = hash_deck_fields(deck, 208)?;
    let keys = padded_shuffle_public_keys(players, num_players);
    let pk_hash = hash_public_keys_12(&keys)?;
    poseidon_fields_be(&[deck_hash.as_slice(), pk_hash.as_slice()])
}

pub fn shuffle_input_hash_from_accounts<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    shuffle_input_hash_from_accounts_with_player(
        deck,
        remaining,
        num_players,
        /* player_index */ 0,
        game_id,
        program_id,
        /* use_initial_deck_constant */ false,
    )
}

/// Compute shuffle input hash, optionally substituting the baked-in initial-deck
/// hash for player 0 (`SHUFFLE_INITIAL_DECK_HASH`) instead of folding `deck`.
pub fn shuffle_input_hash_from_accounts_with_player<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    num_players: u8,
    player_index: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    use_initial_deck_constant: bool,
) -> Result<[u8; 32]> {
    shuffle_input_hash_from_accounts_with_config(
        deck,
        remaining,
        num_players,
        player_index,
        game_id,
        program_id,
        use_initial_deck_constant,
        208,
        shared_zk_ids::SHUFFLE_INITIAL_DECK_HASH,
        12,
        None,
    )
}

/// Config-aware shuffle input hash (variable shoe / roulette wheel).
pub fn shuffle_input_hash_from_accounts_with_config<'info>(
    deck: &[u8],
    remaining: &[AccountInfo<'info>],
    num_players: u8,
    player_index: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
    use_initial_deck_constant: bool,
    deck_fields: usize,
    initial_deck_hash: [u8; 32],
    key_slots: usize,
    cached_deck_hash: Option<[u8; 32]>,
) -> Result<[u8; 32]> {
    require!(
        remaining.len() >= num_players as usize,
        crate::ErrorCode::InvalidPublicInputs
    );

    let mut keys = [[0u8; 32]; 24];
    for slot in 0..SHUFFLE_PLAYER_SLOTS {
        keys[slot * 2] = identity_x();
        keys[slot * 2 + 1] = identity_y();
    }

    for slot in 0..num_players as usize {
        let acc = &remaining[slot];
        let (expected, _) = Pubkey::find_program_address(
            &[b"player", game_id, &[slot as u8]],
            program_id,
        );
        require_keys_eq!(acc.key(), expected);

        let data = acc.try_borrow_data()?;
        require!(data.len() >= PLAYER_PUBLIC_KEY_OFFSET + 64, crate::ErrorCode::InvalidPublicInputs);
        keys[slot * 2].copy_from_slice(&data[PLAYER_PUBLIC_KEY_OFFSET..PLAYER_PUBLIC_KEY_OFFSET + 32]);
        keys[slot * 2 + 1]
            .copy_from_slice(&data[PLAYER_PUBLIC_KEY_OFFSET + 32..PLAYER_PUBLIC_KEY_OFFSET + 64]);
    }

    let deck_hash = if use_initial_deck_constant && player_index == 0 {
        initial_deck_hash
    } else if let Some(cached) = cached_deck_hash {
        cached
    } else {
        hash_deck_fields(deck, deck_fields)?
    };
    let pk_hash = if key_slots == 2 {
        require!(num_players == 2, crate::ErrorCode::InvalidNumPlayers);
        let mut keys2 = [[0u8; 32]; 4];
        keys2.copy_from_slice(&keys[0..4]);
        hash_public_keys_2(&keys2)?
    } else {
        hash_public_keys_12(&keys)?
    };
    poseidon_fields_be(&[deck_hash.as_slice(), pk_hash.as_slice()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon_hash::poseidon_hash;

    fn fe(n: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..32].copy_from_slice(&n.to_be_bytes());
        out
    }

    #[test]
    fn hash_public_keys_12_identity_slots() {
        let keys = padded_shuffle_public_keys(&[], 0);
        let h = hash_public_keys_12(&keys).unwrap();
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn shuffle_input_hash_two_identity_players() {
        let deck = [0u8; 208 * 32];
        let p0 = PlayerState {
            game_id: [0; 32],
            player_index: 0,
            authority: Pubkey::default(),
            public_key: [fe(3), fe(4)],
            padding: [[0; 32]; 4],
            share_chunk_mask: 0,
        };
        let mut p1 = p0.clone();
        p1.player_index = 1;
        p1.public_key = [fe(5), fe(6)];
        let h = shuffle_input_hash(&deck, &[p0, p1], 2).unwrap();
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn hash_deck_52_empty_deck_matches_typescript() {
        let deck = [0u8; 208 * 32];
        let h = hash_deck_52(&deck).unwrap();
        let expected: [u8; 32] = [
            35, 176, 87, 213, 48, 236, 246, 233, 143, 236, 227, 211, 161, 169, 207, 255, 222,
            97, 95, 190, 131, 123, 114, 15, 89, 106, 144, 199, 199, 204, 227, 114,
        ];
        assert_eq!(h, expected);
    }

    #[test]
    fn hash_flat_values_be_matches_deck_52() {
        let deck = [0u8; 208 * 32];
        let n_fields = 208;
        let flat: Vec<[u8; 32]> = (0..n_fields)
            .map(|i| {
                let start = i * 32;
                let mut field = [0u8; 32];
                field.copy_from_slice(&deck[start..start + 32]);
                field
            })
            .collect();
        assert_eq!(hash_flat_values_be(&flat).unwrap(), hash_deck_52(&deck).unwrap());
    }

    #[test]
    fn poseidon_two_matches_module() {
        let via_hasher = poseidon_fields_be(&[fe(1).as_slice(), fe(2).as_slice()]).unwrap();
        let via_mod = poseidon_hash(&[fe(1), fe(2)]).unwrap();
        assert_eq!(via_hasher, via_mod);
    }
}
