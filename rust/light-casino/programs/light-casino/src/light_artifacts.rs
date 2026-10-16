//! Light Protocol compressed account schemas for ZK-phase ledger storage.
//!
//! `LightHasher` allows at most 12 hashed fields; chunk accounts store up to
//! 8 commitments (same pattern as `RevealedPartialsCompressedAccount`).
//! Kind / owner are encoded in the compressed address seeds, not extra fields.

use crate::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk_pinocchio::{LightDiscriminator, LightHasher};
use shared_zk_ids::{
    BET_COMMIT_SEED, LIGHT_KIND_BET_COMMIT, LIGHT_KIND_REGISTER, LIGHT_KIND_SHARE_PARTIALS,
    LIGHT_KIND_SHOWDOWN_MASKS, LIGHT_KIND_SHUFFLE_DECK, LIGHT_KIND_USED_PERM, USED_PERM_SEED,
};

/// Register artifact: ElGamal public key + padding ciphertext coords.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct RegisterCompressedAccount {
    #[hash]
    pub game_id: Pubkey,
    pub player_index: u8,
    pub kind: u8,
    #[hash]
    pub public_key_x: [u8; 32],
    #[hash]
    pub public_key_y: [u8; 32],
    #[hash]
    pub padding_0: [u8; 32],
    #[hash]
    pub padding_1: [u8; 32],
    #[hash]
    pub padding_2: [u8; 32],
    #[hash]
    pub padding_3: [u8; 32],
}

impl RegisterCompressedAccount {
    pub fn new(
        game_id: Pubkey,
        player_index: u8,
        public_key: [[u8; 32]; 2],
        padding: [[u8; 32]; 4],
    ) -> Self {
        Self {
            game_id,
            player_index,
            kind: LIGHT_KIND_REGISTER,
            public_key_x: public_key[0],
            public_key_y: public_key[1],
            padding_0: padding[0],
            padding_1: padding[1],
            padding_2: padding[2],
            padding_3: padding[3],
        }
    }
}

/// Shuffle / share / showdown chunk: up to 8 BE field commitments.
/// Address seeds carry `(kind, owner_index, chunk_index)`.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct ArtifactChunkCompressedAccount {
    #[hash]
    pub game_id: Pubkey,
    pub chunk_index: u16,
    pub start_index: u16,
    pub count: u8,
    #[hash]
    pub commitment_0: [u8; 32],
    #[hash]
    pub commitment_1: [u8; 32],
    #[hash]
    pub commitment_2: [u8; 32],
    #[hash]
    pub commitment_3: [u8; 32],
    #[hash]
    pub commitment_4: [u8; 32],
    #[hash]
    pub commitment_5: [u8; 32],
    #[hash]
    pub commitment_6: [u8; 32],
    #[hash]
    pub commitment_7: [u8; 32],
}

impl ArtifactChunkCompressedAccount {
    pub fn from_limbs(
        game_id: Pubkey,
        chunk_index: u16,
        start_index: u16,
        limbs: &[[u8; 32]],
    ) -> Self {
        let mut commitments = [[0u8; 32]; 8];
        let count = limbs.len().min(8) as u8;
        for (i, limb) in limbs.iter().take(8).enumerate() {
            commitments[i] = *limb;
        }
        Self {
            game_id,
            chunk_index,
            start_index,
            count,
            commitment_0: commitments[0],
            commitment_1: commitments[1],
            commitment_2: commitments[2],
            commitment_3: commitments[3],
            commitment_4: commitments[4],
            commitment_5: commitments[5],
            commitment_6: commitments[6],
            commitment_7: commitments[7],
        }
    }
}

/// Global used-permutation leaf: one Light address per `permutationHash`.
/// Address seeds: `used_perm` || permutation_hash (not per-game).
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct UsedPermutationCompressedAccount {
    #[hash]
    pub permutation_hash: [u8; 32],
    #[hash]
    pub game_id: Pubkey,
    pub player_index: u8,
    pub kind: u8,
}

impl UsedPermutationCompressedAccount {
    pub fn new(permutation_hash: [u8; 32], game_id: Pubkey, player_index: u8) -> Self {
        Self {
            permutation_hash,
            game_id,
            player_index,
            kind: LIGHT_KIND_USED_PERM,
        }
    }
}

/// Address seed slices for global permutation exclusion: `used_perm` || hash.
pub fn used_perm_address_seeds(permutation_hash: &[u8; 32]) -> [&[u8]; 2] {
    [USED_PERM_SEED, permutation_hash.as_ref()]
}

/// Durable split-game bet (or bingo card) commitment.
/// Address seeds: `bet_commit` || game_id || player_index.
/// The 5,996-byte `bet_inputs` PDA is staging only and is closed once this leaf exists.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct BetCommitmentCompressedAccount {
    #[hash]
    pub bet_hash: [u8; 32],
    #[hash]
    pub game_id: Pubkey,
    pub player_index: u8,
    pub actual_bet_count: u64,
    pub kind: u8,
}

impl BetCommitmentCompressedAccount {
    pub fn new(
        bet_hash: [u8; 32],
        game_id: Pubkey,
        player_index: u8,
        actual_bet_count: u64,
    ) -> Self {
        Self {
            bet_hash,
            game_id,
            player_index,
            actual_bet_count,
            kind: LIGHT_KIND_BET_COMMIT,
        }
    }
}

/// Address seeds: `bet_commit` || game_id || player_index.
pub fn bet_commit_address_seeds<'a>(
    game_id: &'a [u8; 32],
    player_index: &'a [u8; 1],
) -> [&'a [u8]; 3] {
    [BET_COMMIT_SEED, game_id.as_ref(), player_index.as_ref()]
}

/// Seed prefix for artifact chunk addresses: `artifact` || kind || owner || chunk.
pub fn artifact_address_seeds<'a>(
    kind: u8,
    owner_index: u8,
    chunk_index: u16,
    kind_buf: &'a mut [u8; 1],
    owner_buf: &'a mut [u8; 1],
    chunk_buf: &'a mut [u8; 2],
) -> [&'a [u8]; 4] {
    kind_buf[0] = kind;
    owner_buf[0] = owner_index;
    chunk_buf.copy_from_slice(&chunk_index.to_le_bytes());
    [b"artifact", kind_buf.as_slice(), owner_buf.as_slice(), chunk_buf.as_slice()]
}

pub fn shuffle_kind() -> u8 {
    LIGHT_KIND_SHUFFLE_DECK
}
pub fn share_kind() -> u8 {
    LIGHT_KIND_SHARE_PARTIALS
}
pub fn showdown_kind() -> u8 {
    LIGHT_KIND_SHOWDOWN_MASKS
}

/// Pack active share limbs (same indices as `hash900Values` / Circom poly hash).
///
/// Layout source is recipient-major `9 × 25 × 4` fields; only active recipients
/// and cards are emitted. Absolute limb indices are preserved in the returned
/// `(absolute_index, limb)` pairs for `start_index` on each Light chunk.
pub fn collect_active_share_limbs(
    full_matrix: &[[u8; 32]],
    n_actual_players: u8,
) -> Result<alloc::vec::Vec<(u16, [u8; 32])>> {
    require!(
        (2..=10).contains(&n_actual_players),
        crate::ErrorCode::InvalidNumPlayers
    );
    require!(
        full_matrix.len() == 900,
        crate::ErrorCode::InvalidPublicInputs
    );
    let n_others = 9usize;
    let n_cards = 25usize;
    let board_start = 20usize;
    let mut out = alloc::vec::Vec::new();
    let mut idx = 0u16;
    for i in 0..n_others {
        let recipient_active = i < (n_actual_players as usize - 1);
        for j in 0..n_cards {
            let card_active = j >= board_start || j < 2 * (n_actual_players as usize);
            let active = recipient_active && card_active;
            for _k in 0..4 {
                if active {
                    out.push((idx, full_matrix[idx as usize]));
                }
                idx += 1;
            }
        }
    }
    Ok(out)
}

extern crate alloc;

#[cfg(test)]
mod tests {
    use super::*;
    use shared_zk_ids::share_active_limb_count;

    #[test]
    fn active_share_limb_count_matches_helper() {
        let zeros = [[0u8; 32]; 900];
        let packed = collect_active_share_limbs(&zeros, 2).unwrap();
        assert_eq!(packed.len(), share_active_limb_count(2));
        let packed10 = collect_active_share_limbs(&zeros, 10).unwrap();
        assert_eq!(packed10.len(), 900);
    }

    #[test]
    fn artifact_chunk_packs_limbs() {
        let limbs = [[1u8; 32], [2u8; 32]];
        let chunk = ArtifactChunkCompressedAccount::from_limbs(Pubkey::default(), 0, 4, &limbs);
        assert_eq!(chunk.count, 2);
        assert_eq!(chunk.start_index, 4);
        assert_eq!(chunk.commitment_0, [1u8; 32]);
        assert_eq!(shuffle_kind(), LIGHT_KIND_SHUFFLE_DECK);
    }

    #[test]
    fn used_perm_seeds_are_global_and_hash_keyed() {
        let h1 = [1u8; 32];
        let h2 = [2u8; 32];
        let s1 = used_perm_address_seeds(&h1);
        let s2 = used_perm_address_seeds(&h2);
        assert_eq!(s1[0], USED_PERM_SEED);
        assert_eq!(s1[1], h1.as_ref());
        assert_ne!(s1[1], s2[1]);
        let acc = UsedPermutationCompressedAccount::new(h1, Pubkey::default(), 3);
        assert_eq!(acc.kind, LIGHT_KIND_USED_PERM);
        assert_eq!(acc.player_index, 3);
        assert_eq!(acc.permutation_hash, h1);
    }

    #[test]
    fn bet_commit_is_keyed_by_game_and_seat() {
        let game = [9u8; 32];
        let seat0 = [0u8];
        let seat1 = [1u8];
        let s0 = bet_commit_address_seeds(&game, &seat0);
        let s1 = bet_commit_address_seeds(&game, &seat1);
        assert_eq!(s0[0], BET_COMMIT_SEED);
        assert_eq!(s0[1], game.as_ref());
        assert_eq!(s0[2], seat0.as_ref());
        assert_ne!(s0[2], s1[2]);
        let leaf = BetCommitmentCompressedAccount::new([7u8; 32], Pubkey::default(), 4, 3);
        assert_eq!(leaf.kind, LIGHT_KIND_BET_COMMIT);
        assert_eq!(leaf.player_index, 4);
        assert_eq!(leaf.actual_bet_count, 3);
        assert_eq!(leaf.bet_hash, [7u8; 32]);
    }
}
