//! Shared constants between `casino` (Anchor) and `light-casino` (pinocchio).
//! No Anchor dependency — safe for both workspaces.

#![no_std]

mod game_config;
pub use game_config::*;

pub const LIGHT_CASINO_PROGRAM_ID: &str = "CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc";
pub const CASINO_PROGRAM_ID: &str = "4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY";
pub const CPI_AUTHORITY_SEED: &[u8] = b"cpi_authority";
/// Per-player SOL float that fronts staging rent. Seeds: `rent_vault || room_id || player`.
pub const RENT_VAULT_SEED: &[u8] = b"rent_vault";
/// Casino PDA that is the only signer allowed to pull or settle a rent vault.
pub const CASINO_RENT_AUTHORITY_SEED: &[u8] = b"casino_rent_authority";
pub const WHITELIST_ADMIN: &str = "CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3";
/// `sha256("account:RentVault")[..8]`
pub const RENT_VAULT_DISCRIMINATOR: [u8; 8] = [43, 81, 226, 94, 234, 69, 162, 61];
pub const RENT_VAULT_LEN: usize = 8 + 32 + 32 + 1;
/// `sha256("global:reimburse_rent_vault")[..8]`
pub const REIMBURSE_RENT_VAULT_DISCRIMINATOR: [u8; 8] = [115, 164, 214, 71, 94, 163, 207, 118];
/// `sha256("global:settle_rent_vault")[..8]`
pub const SETTLE_RENT_VAULT_DISCRIMINATOR: [u8; 8] = [50, 42, 236, 195, 212, 4, 16, 118];

pub const PROOF_PHASE_REGISTER: u8 = 0;
pub const PROOF_PHASE_SHUFFLE: u8 = 1;
pub const PROOF_PHASE_SHARE: u8 = 2;
pub const PROOF_PHASE_SHOWDOWN: u8 = 3;
pub const PROOF_PHASE_ACTION: u8 = 4;

pub const PROOF_RECEIPT_V2_SEED: &[u8] = b"proof_receipt_v2";
pub const PROOF_RECEIPT_SEED: &[u8] = PROOF_RECEIPT_V2_SEED;
pub const CIRCUIT_VERSION_V2: u16 = 2;
pub const RECEIPT_STATUS_INITIALIZED: u8 = 0;
pub const RECEIPT_STATUS_VERIFIED: u8 = 1;
pub const RECEIPT_STATUS_CONSUMED: u8 = 2;

pub const LIGHT_CHUNK_COMMITMENTS: u8 = 8;
pub const LIGHT_KIND_REGISTER: u8 = 1;
pub const LIGHT_KIND_SHUFFLE_DECK: u8 = 2;
pub const LIGHT_KIND_SHARE_PARTIALS: u8 = 3;
pub const LIGHT_KIND_SHOWDOWN_MASKS: u8 = 4;
pub const LIGHT_KIND_USED_PERM: u8 = 5;
/// Roulette share: encrypted bet ciphertexts (`encryptedBets[12][12][4]` limbs).
pub const LIGHT_KIND_ROULETTE_BETS: u8 = 6;
/// Split-game bet / bingo card commitment (`bet_hash` + count). Replaces the
/// 5,996-byte `bet_inputs` PDA after verify.
pub const LIGHT_KIND_BET_COMMIT: u8 = 7;
pub const USED_PERM_SEED: &[u8] = b"used_perm";
pub const BET_COMMIT_SEED: &[u8] = b"bet_commit";
/// Max seats in roulette circuits (`ShareHashOut(12, …)` / `CommitBets`).
pub const ROULETTE_MAX_PLAYERS: u8 = 12;
/// Widest table. Poker is 10, blackjack is 8, and slots is 2
/// ([`GameKind::max_players`]). The poker settlement ledger stays at 10.
pub const PRODUCT_MAX_PLAYERS: u8 = 12;
pub const ROULETTE_MAX_BETS: usize = 12;
pub const ROULETTE_BET_LIMBS: usize = ROULETTE_MAX_PLAYERS as usize * ROULETTE_MAX_BETS * 4; // 576

/// Casino `ShareVerifyAccumulator` PDA seed and Borsh layout (after 8-byte discriminator).
pub const SHARE_VERIFY_ACC_SEED: &[u8] = b"share_verify_acc";
/// `sha256("account:ShareVerifyAccumulator")[0..8]`
pub const SHARE_VERIFY_ACC_DISCRIMINATOR: [u8; 8] =
    [164, 37, 9, 81, 219, 59, 189, 247];
pub const SHARE_VERIFY_ACC_DATA_LEN: usize = 273;
pub const SHARE_VERIFY_OFF_GAME_ID: usize = 8;
pub const SHARE_VERIFY_OFF_PLAYER_INDEX: usize = 40;
pub const SHARE_VERIFY_OFF_NUM_PLAYERS: usize = 41;
pub const SHARE_VERIFY_OFF_GENERATION: usize = 42;
pub const SHARE_VERIFY_OFF_ENCRYPTION_PUBKEY: usize = 50;
pub const SHARE_VERIFY_OFF_VERIFY_HASH_ACC: usize = 82;
pub const SHARE_VERIFY_OFF_VERIFY_EXPECTED: usize = 114;
pub const SHARE_VERIFY_OFF_VERIFY_PROGRESS: usize = 146;
pub const SHARE_VERIFY_OFF_VERIFY_TARGET: usize = 148;
pub const SHARE_VERIFY_OFF_VERIFY_BITS: usize = 150;
pub const SHARE_VERIFY_OFF_VERIFIED: usize = 270;
pub const SHARE_VERIFY_OFF_FROZEN: usize = 271;
pub const SHARE_VERIFY_OFF_SHARE_CARDS: usize = 272;

// Must match Anchor sighash(`global:consume_*`) / `src/chain/idl/casino.json`.
pub const CONSUME_PROOF_RECEIPT_V2_DISCRIMINATOR: [u8; 8] =
    [36, 8, 228, 150, 169, 252, 232, 177];
pub const CONSUME_REGISTER_RECEIPT_V2_DISCRIMINATOR: [u8; 8] =
    [222, 136, 123, 237, 225, 198, 144, 64];
pub const CONSUME_PROOF_RECEIPT_ARGS_LEN: usize = 8 + 1 + 1 + 2 + 32;
pub const CONSUME_REGISTER_RECEIPT_ARGS_LEN: usize = 8 + 1 + 2 + 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofReceiptPayload {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub phase: u8,
    pub player_index: u8,
    pub circuit_version: u16,
    pub output_hash: [u8; 32],
    pub status: u8,
}

impl ProofReceiptPayload {
    pub const SERIALIZED_LEN: usize = 32 + 8 + 1 + 1 + 2 + 32 + 1;

    pub fn try_from_account_data(data: &[u8]) -> Option<Self> {
        if data.len() < 8 + Self::SERIALIZED_LEN {
            return None;
        }
        let p = &data[8..];
        let mut game_id = [0u8; 32];
        game_id.copy_from_slice(&p[0..32]);
        let generation = u64::from_le_bytes(p[32..40].try_into().ok()?);
        let phase = p[40];
        let player_index = p[41];
        let circuit_version = u16::from_le_bytes(p[42..44].try_into().ok()?);
        let mut output_hash = [0u8; 32];
        output_hash.copy_from_slice(&p[44..76]);
        let status = p[76];
        Some(Self {
            game_id,
            generation,
            phase,
            player_index,
            circuit_version,
            output_hash,
            status,
        })
    }

    pub fn consume_proof_ix_data(&self) -> [u8; 8 + CONSUME_PROOF_RECEIPT_ARGS_LEN] {
        let mut out = [0u8; 8 + CONSUME_PROOF_RECEIPT_ARGS_LEN];
        out[0..8].copy_from_slice(&CONSUME_PROOF_RECEIPT_V2_DISCRIMINATOR);
        out[8..16].copy_from_slice(&self.generation.to_le_bytes());
        out[16] = self.phase;
        out[17] = self.player_index;
        out[18..20].copy_from_slice(&self.circuit_version.to_le_bytes());
        out[20..52].copy_from_slice(&self.output_hash);
        out
    }

    pub fn consume_register_ix_data(&self) -> [u8; 8 + CONSUME_REGISTER_RECEIPT_ARGS_LEN] {
        let mut out = [0u8; 8 + CONSUME_REGISTER_RECEIPT_ARGS_LEN];
        out[0..8].copy_from_slice(&CONSUME_REGISTER_RECEIPT_V2_DISCRIMINATOR);
        out[8..16].copy_from_slice(&self.generation.to_le_bytes());
        out[16] = self.player_index;
        out[17..19].copy_from_slice(&self.circuit_version.to_le_bytes());
        out[19..51].copy_from_slice(&self.output_hash);
        out
    }
}

pub const SHUFFLE_INITIAL_DECK_HASH: [u8; 32] = [
    0x2a, 0xfb, 0x73, 0xe8, 0xa2, 0xb9, 0x7a, 0x7a, 0xc0, 0x19, 0x55, 0xef, 0xe2, 0x00, 0x76, 0xd1,
    0xd1, 0x62, 0xc0, 0x63, 0x00, 0xd7, 0x6e, 0x38, 0x8c, 0xe2, 0xcb, 0xff, 0xcf, 0xc3, 0xfd, 0xdb,
];

/// Poker deal active Rescue limbs: `(n-1) * (2n+5) * 4` for players 2..=10.
pub fn share_active_limb_count(n_actual_players: u8) -> usize {
    if !(2..=10).contains(&n_actual_players) {
        return 0;
    }
    let n_others = (n_actual_players - 1) as usize;
    let active_cards = 2 * (n_actual_players as usize) + 5;
    n_others * active_cards * 4
}

/// Active Rescue limbs for Arcis share-hash verify by card count.
/// - `n_cards == 1` (roulette): `(n-1)*4`, players 2..=12
/// - `n_cards == 25` (poker deal): recipient-major hole layout via [`share_active_limb_count`]
/// - otherwise (baccarat/war/blackjack chunk window): contiguous `(n-1)*n_cards*4`, ≤900
pub fn share_active_limb_count_for_cards(n_actual_players: u8, n_cards: u8) -> usize {
    if n_cards == 1 {
        if !(2..=ROULETTE_MAX_PLAYERS).contains(&n_actual_players) {
            return 0;
        }
        return (n_actual_players as usize - 1) * 4;
    }
    if n_cards == 25 {
        return share_active_limb_count(n_actual_players);
    }
    if !(2..=ROULETTE_MAX_PLAYERS).contains(&n_actual_players) || n_cards == 0 {
        return 0;
    }
    let limbs = (n_actual_players as usize - 1) * (n_cards as usize) * 4;
    if limbs > 900 {
        return 0;
    }
    limbs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_active_limb_count_two_players() {
        assert_eq!(share_active_limb_count(2), 36);
    }

    #[test]
    fn share_active_limb_count_ten_players() {
        assert_eq!(share_active_limb_count(10), 900);
    }

    #[test]
    fn roulette_share_limbs_one_card() {
        assert_eq!(share_active_limb_count_for_cards(2, 1), 4);
        assert_eq!(share_active_limb_count_for_cards(12, 1), 44);
    }

    #[test]
    fn share_verify_acc_offsets_match_borsh_layout() {
        assert_eq!(SHARE_VERIFY_OFF_GAME_ID, 8);
        assert_eq!(SHARE_VERIFY_OFF_PLAYER_INDEX, 40);
        assert_eq!(SHARE_VERIFY_OFF_NUM_PLAYERS, 41);
        assert_eq!(SHARE_VERIFY_OFF_GENERATION, 42);
        assert_eq!(SHARE_VERIFY_OFF_VERIFY_EXPECTED, 114);
        assert_eq!(SHARE_VERIFY_OFF_VERIFIED, 270);
        assert_eq!(SHARE_VERIFY_OFF_FROZEN, 271);
        assert_eq!(SHARE_VERIFY_OFF_SHARE_CARDS, 272);
        assert_eq!(SHARE_VERIFY_ACC_DATA_LEN, 273);
        assert_ne!(SHARE_VERIFY_OFF_VERIFIED, SHARE_VERIFY_OFF_FROZEN);
        assert_ne!(SHARE_VERIFY_OFF_FROZEN, SHARE_VERIFY_OFF_SHARE_CARDS);
    }

    #[test]
    fn v2_receipt_round_trip_and_ix_layout() {
        let payload = ProofReceiptPayload {
            game_id: [3u8; 32],
            generation: 9,
            phase: PROOF_PHASE_SHARE,
            player_index: 1,
            circuit_version: CIRCUIT_VERSION_V2,
            output_hash: [7u8; 32],
            status: RECEIPT_STATUS_VERIFIED,
        };
        let mut data = [0u8; 8 + ProofReceiptPayload::SERIALIZED_LEN];
        data[8..40].copy_from_slice(&payload.game_id);
        data[40..48].copy_from_slice(&payload.generation.to_le_bytes());
        data[48] = payload.phase;
        data[49] = payload.player_index;
        data[50..52].copy_from_slice(&payload.circuit_version.to_le_bytes());
        data[52..84].copy_from_slice(&payload.output_hash);
        data[84] = payload.status;
        assert_eq!(ProofReceiptPayload::try_from_account_data(&data), Some(payload));
        let ix = payload.consume_proof_ix_data();
        assert_eq!(&ix[8..16], &9u64.to_le_bytes());
        assert_eq!(&ix[20..52], &[7u8; 32]);
    }
}
