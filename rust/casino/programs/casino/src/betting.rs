use anchor_lang::prelude::*;

pub const MAX_BET_LOG_ENTRIES: usize = 64;
pub const ENCRYPTED_FIELD_SIZE: usize = 32;

#[account]
#[derive(InitSpace)]
pub struct GameTableKey {
    pub game_id: [u8; 32],
    pub encryption_pubkey: [u8; 32],
    pub nonce_base: u128,
}

/// Purpose-separated per-seat MPC transport key (Protocol V2).
/// Seeds: `[b"player_mpc_key", game_id, player_index, purpose, generation_le]`.
#[account]
#[derive(InitSpace)]
pub struct PlayerMpcKey {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub purpose: u8,
    pub generation: u64,
    pub encryption_pubkey: [u8; 32],
    pub nonce_base: u128,
    pub authority: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct EncryptedGameBetting {
    pub game_id: [u8; 32],
    pub player_total_bets_ct: [[u8; ENCRYPTED_FIELD_SIZE]; 10],
    pub pots_ct: [[u8; ENCRYPTED_FIELD_SIZE]; 9],
    pub current_bet_ct: [u8; ENCRYPTED_FIELD_SIZE],
    pub last_aggressor_amount_ct: [u8; ENCRYPTED_FIELD_SIZE],
    pub nonce: u128,
}

/// Fixed-layout log entry for zero-copy `BetActionLog` (must stay under BPF stack limits).
#[zero_copy]
#[repr(C)]
pub struct BetLogEntry {
    pub nonce: u128,
    pub amount_ciphertext: [u8; ENCRYPTED_FIELD_SIZE],
    pub balance_ciphertext: [u8; ENCRYPTED_FIELD_SIZE],
    pub player_index: u8,
    pub action: u8,
    pub _padding: [u8; 14],
}

/// Large account — use `AccountLoader` / zero-copy so callbacks do not Borsh-deserialize ~5KB onto the BPF stack.
#[account(zero_copy)]
#[repr(C)]
pub struct BetActionLog {
    pub game_id: [u8; 32],
    pub entry_count: u16,
    pub bump: u8,
    /// Pad so `entries` starts at a 16-byte boundary (required by `Pod` / `u128` in `BetLogEntry`).
    pub _padding: [u8; 13],
    pub entries: [BetLogEntry; MAX_BET_LOG_ENTRIES],
}

impl BetActionLog {
    pub const LEN: usize = 8 + core::mem::size_of::<BetActionLog>();

    pub fn append(&mut self, entry: BetLogEntry) -> Result<()> {
        let idx = self.entry_count as usize;
        require!(idx < MAX_BET_LOG_ENTRIES, crate::ErrorCode::BetLogFull);
        self.entries[idx] = entry;
        self.entry_count = self
            .entry_count
            .checked_add(1)
            .ok_or(crate::ErrorCode::BetLogFull)?;
        Ok(())
    }
}

/// Encode a plaintext u64 as a 32-byte little-endian field (transitional bridge
/// until pot ciphertexts are produced inside Arcis MPC).
pub fn encode_u64_le_field(value: u64) -> [u8; ENCRYPTED_FIELD_SIZE] {
    let mut out = [0u8; ENCRYPTED_FIELD_SIZE];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

impl EncryptedGameBetting {
    /// Sync ciphertext slots from plaintext GameState betting fields.
    pub fn sync_from_plaintext(
        &mut self,
        player_total_bets: &[u64; 10],
        pots: &[u64; 9],
        current_bet: u64,
        last_aggressor_amount: u64,
    ) {
        for i in 0..10 {
            self.player_total_bets_ct[i] = encode_u64_le_field(player_total_bets[i]);
        }
        for i in 0..9 {
            self.pots_ct[i] = encode_u64_le_field(pots[i]);
        }
        self.current_bet_ct = encode_u64_le_field(current_bet);
        self.last_aggressor_amount_ct = encode_u64_le_field(last_aggressor_amount);
        self.nonce = self.nonce.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_u64_le_field_roundtrip_prefix() {
        let enc = encode_u64_le_field(0x0102_0304_0506_0708);
        assert_eq!(&enc[..8], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert!(enc[8..].iter().all(|&b| b == 0));
    }

    #[test]
    fn sync_from_plaintext_writes_pots_and_bumps_nonce() {
        let mut betting = EncryptedGameBetting {
            game_id: [0u8; 32],
            player_total_bets_ct: [[0u8; 32]; 10],
            pots_ct: [[0u8; 32]; 9],
            current_bet_ct: [0u8; 32],
            last_aggressor_amount_ct: [0u8; 32],
            nonce: 0,
        };
        let mut totals = [0u64; 10];
        totals[0] = 50;
        totals[1] = 100;
        let mut pots = [0u64; 9];
        pots[0] = 150;
        betting.sync_from_plaintext(&totals, &pots, 100, 100);
        assert_eq!(betting.nonce, 1);
        assert_eq!(&betting.pots_ct[0][..8], &150u64.to_le_bytes());
        assert_eq!(&betting.current_bet_ct[..8], &100u64.to_le_bytes());
        assert_eq!(&betting.player_total_bets_ct[1][..8], &100u64.to_le_bytes());
    }
}
