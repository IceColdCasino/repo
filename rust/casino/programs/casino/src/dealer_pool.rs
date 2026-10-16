//! Shared Dealer Pool and protocol treasury accounts for casino games.
//!
//! Financial settlement math runs in Arcium MPC; these accounts hold encrypted
//! state and public fee parameters verified at room creation.

use anchor_lang::prelude::*;
use shared_zk_ids::GameKind;

/// Fixed fee parameters mirrored from TypeScript `casino-fees.ts`.
pub mod fee_schedule {
    pub const BACCARAT_BANKER_WIN_COMMISSION_BPS: u16 = 500;
    pub const BACCARAT_ACTION_COLLECTION_BPS: u16 = 100;
    pub const BLACKJACK_ACTION_COLLECTION_BPS: u16 = 200;
    pub const BLACKJACK_POOL_WIN_EDGE_BPS: u16 = 200;
    pub const WAR_ACTION_COLLECTION_BPS: u16 = 250;
    pub const WAR_POOL_WIN_EDGE_BPS: u16 = 250;
    /// Placeholder until product fees land (mirrors war).
    pub const ROULETTE_ACTION_COLLECTION_BPS: u16 = 250;
    pub const ROULETTE_POOL_WIN_EDGE_BPS: u16 = 250;
    pub const MAX_SIDE_BET_POOL_INCENTIVE_BPS: u16 = 3000;
}

/// Alias kept for existing call sites; values match [`GameKind`].
pub type CasinoGameKind = GameKind;

#[account]
#[derive(InitSpace)]
pub struct DealerPool {
    pub room_id: [u8; 32],
    pub table_id: u64,
    pub game_kind: u8,
    /// Encrypted aggregate pool balance (Arcium Shared encryption).
    pub balance_ciphertext: [u8; 32],
    pub nonce: u128,
    /// Total outstanding pool shares (plaintext for share mint/burn validation).
    pub total_shares: u64,
    pub staker_count: u16,
    /// Whether optional action collection is enabled (baccarat 1%).
    pub action_collection_enabled: bool,
    /// Side-bet pool incentive 0..3000 bps.
    pub side_bet_pool_incentive_bps: u16,
    /// Staged total action for the in-flight settlement callback event.
    pub pending_total_action: u64,
    /// Shares to burn during an in-flight redeem callback.
    pub pending_shares_burn: u64,
    /// X25519 owner public key that produced `balance_ciphertext` (zero = unset).
    pub encryption_pubkey: [u8; 32],
    /// Room/table min bet (roulette class or casino unit).
    pub min_bet: u64,
    /// Room/table max bet.
    pub max_bet: u64,
    /// Blackjack / war / baccarat bet-per-hand unit.
    pub bet_unit: u64,
    /// Reserved max-payout liability for the current hand.
    pub reserved_liability: u64,
}

#[account]
#[derive(InitSpace)]
pub struct PoolStakeAccount {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub shares: u64,
    /// Encrypted staker accrual for selective reveal on redemption.
    pub accrued_ciphertext: [u8; 32],
    pub nonce: u128,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolTreasury {
    pub room_id: [u8; 32],
    /// Cumulative transparent commission accrual (plaintext audit trail).
    pub total_commissions: u64,
    /// SPL already transferred out of the vault to the protocol.
    pub total_withdrawn: u64,
    pub mint: Pubkey,
}

impl DealerPool {
    pub fn init(
        room_id: [u8; 32],
        table_id: u64,
        game_kind: CasinoGameKind,
        min_bet: u64,
        max_bet: u64,
        bet_unit: u64,
    ) -> Self {
        Self {
            room_id,
            table_id,
            game_kind: game_kind as u8,
            balance_ciphertext: [0u8; 32],
            nonce: 0,
            total_shares: 0,
            staker_count: 0,
            action_collection_enabled: true,
            side_bet_pool_incentive_bps: 0,
            pending_total_action: 0,
            pending_shares_burn: 0,
            encryption_pubkey: [0u8; 32],
            min_bet,
            max_bet,
            bet_unit,
            reserved_liability: 0,
        }
    }
}

pub fn dealer_pool_seeds(room_id: &[u8; 32], table_id: u64) -> [Vec<u8>; 3] {
    [
        b"dealer_pool".to_vec(),
        room_id.to_vec(),
        table_id.to_le_bytes().to_vec(),
    ]
}

pub fn pool_stake_seeds(pool: &Pubkey, staker: &Pubkey) -> [Vec<u8>; 3] {
    [
        b"pool_stake".to_vec(),
        pool.to_bytes().to_vec(),
        staker.to_bytes().to_vec(),
    ]
}

pub fn protocol_treasury_seeds(room_id: &[u8; 32]) -> [Vec<u8>; 2] {
    [b"protocol_treasury".to_vec(), room_id.to_vec()]
}
