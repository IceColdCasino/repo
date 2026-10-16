//! Share input hash via light-poseidon (mirrors Circom `HashMain` / TS `Poker.shareHash`).

use crate::prelude::*;

use crate::poseidon_hash::poseidon_fields_be;
use crate::shuffle_hash::{
    field_from_u128, hash_public_keys_10, read_player_public_keys, share_ordered_public_keys,
};
use crate::{MAX_PLAYERS, TOTAL_CARDS};

/// Deal slice: 25 cards × 4 field elements.
pub const DEAL_FIELDS: usize = TOTAL_CARDS * 4;
pub const DEAL_BYTES: usize = DEAL_FIELDS * 32;

/// Hash the first 25 cards (100 BE fields) of a 52-card shuffled deck buffer.
///
/// Zero-copy over the deck buffer — SBF bump allocator does not free, so avoid
/// copying into a `Vec<[u8; 32]>` that would permanently consume heap.
pub fn hash_deal_25(deck_52: &[u8]) -> Result<[u8; 32]> {
    require!(
        deck_52.len() >= DEAL_BYTES,
        crate::ErrorCode::InvalidPublicInputs
    );
    crate::shuffle_hash::hash_flat_bytes_be(&deck_52[..DEAL_BYTES])
}

/// Bitmask of used cards for the share circuit (unused hole slots cleared).
/// Mirrors `shareCardMask` in `src/backend/card-layout.ts`.
pub fn share_card_mask(num_players: u8) -> Result<u128> {
    require!(
        (2..=MAX_PLAYERS).contains(&num_players),
        crate::ErrorCode::InvalidNumPlayers
    );
    let mut mask: u128 = 0;
    for i in 0..(num_players as u128 * 2) {
        mask |= 1u128 << i;
    }
    // Board always at indices 20..24 in the fixed 10-seat layout.
    for i in 20u128..25 {
        mask |= 1u128 << i;
    }
    Ok(mask)
}

/// `Poker.shareHash`: Poseidon(ctHash, cardMask, pkHash).
/// `nActualPlayers` is private and bound via PK identity constraints in-circuit.
pub fn share_input_hash(
    deck_52: &[u8],
    registered_keys: &[[[u8; 32]; 2]],
    prover_index: u8,
    num_players: u8,
) -> Result<[u8; 32]> {
    require!(
        (prover_index as usize) < registered_keys.len(),
        crate::ErrorCode::InvalidPlayerIndex
    );
    let ct_hash = hash_deal_25(deck_52)?;
    let card_mask = field_from_u128(share_card_mask(num_players)?);
    let ordered = share_ordered_public_keys(registered_keys, prover_index)?;
    let pk_hash = hash_public_keys_10(&ordered)?;
    poseidon_fields_be(&[
        ct_hash.as_slice(),
        card_mask.as_slice(),
        pk_hash.as_slice(),
    ])
}

/// Recompute share input hash from `deck_state` bytes + player PDAs in remaining accounts.
pub fn share_input_hash_from_accounts<'info>(
    deck_52: &[u8],
    remaining: &[AccountInfo<'info>],
    prover_index: u8,
    num_players: u8,
    game_id: &[u8; 32],
    program_id: &Pubkey,
) -> Result<[u8; 32]> {
    let keys = read_player_public_keys(remaining, num_players, game_id, program_id)?;
    share_input_hash(deck_52, &keys, prover_index, num_players)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shuffle_hash::{field_from_u128, identity_x, identity_y, SHARE_PLAYER_SLOTS};

    fn fe(n: u64) -> [u8; 32] {
        field_from_u128(n as u128)
    }

    #[test]
    fn share_card_mask_two_players() {
        // holes 0..3 + board 20..24 = 0b1_1111_0000_0000_0000_0000_1111 = 32505871
        assert_eq!(share_card_mask(2).unwrap(), 32_505_871);
    }

    #[test]
    fn share_card_mask_ten_players_is_all_bits() {
        assert_eq!(share_card_mask(10).unwrap(), (1u128 << 25) - 1);
    }

    #[test]
    fn hash_public_keys_10_identity_padded() {
        let keys = crate::shuffle_hash::pad_registered_keys_to_share_slots(&[]);
        assert_eq!(keys[0], identity_x());
        assert_eq!(keys[1], identity_y());
        let h = hash_public_keys_10(&keys).unwrap();
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn share_input_hash_zero_deck_two_players_matches_typescript() {
        let deck = [0u8; 208 * 32];
        let keys = [[fe(3), fe(4)], [fe(5), fe(6)]];
        let h = share_input_hash(&deck, &keys, 0, 2).unwrap();
        // Poseidon(ctHash, cardMask, pkHash) — nActualPlayers no longer hashed.
        let expected: [u8; 32] = [
            32, 83, 92, 118, 242, 8, 136, 255, 185, 234, 199, 214, 119, 169, 131, 203, 91, 235, 134,
            8, 157, 105, 163, 50, 152, 213, 210, 5, 36, 115, 202, 73,
        ];
        assert_eq!(h, expected);
    }

    #[test]
    fn share_ordered_puts_prover_first() {
        let keys = [[fe(3), fe(4)], [fe(5), fe(6)]];
        let ordered = share_ordered_public_keys(&keys, 1).unwrap();
        assert_eq!(ordered[0], fe(5));
        assert_eq!(ordered[1], fe(6));
        assert_eq!(ordered[2], fe(3));
        assert_eq!(ordered[3], fe(4));
        // Remaining 8 slots are identity.
        assert_eq!(ordered[4], identity_x());
        assert_eq!(ordered[5], identity_y());
        assert_eq!(SHARE_PLAYER_SLOTS, 10);
    }
}
