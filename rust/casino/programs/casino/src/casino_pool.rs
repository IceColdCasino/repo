//! Non-Arcium account contexts for casino pool and treasury.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::dealer_pool::{DealerPool, PoolStakeAccount, ProtocolTreasury};
use crate::room::Room;
use crate::whitelist;

#[derive(Accounts)]
pub struct WithdrawProtocolCommissions<'info> {
    #[account(
        constraint = authority.key() == whitelist::WHITELIST_ADMIN @ crate::ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        mut,
        seeds = [b"protocol_treasury", &room.room_id[..]],
        bump,
        constraint = protocol_treasury.room_id == room.room_id @ crate::ErrorCode::InvalidAccountOwner,
    )]
    pub protocol_treasury: Account<'info, ProtocolTreasury>,
    #[account(mut, seeds = [b"vault", &room.room_id[..]], bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitPoolStake<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"dealer_pool", &dealer_pool.room_id[..], &dealer_pool.table_id.to_le_bytes()], bump)]
    pub dealer_pool: Account<'info, DealerPool>,
    #[account(
        init,
        payer = payer,
        space = 8 + PoolStakeAccount::INIT_SPACE,
        seeds = [b"pool_stake", dealer_pool.key().as_ref(), staker.key().as_ref()],
        bump,
    )]
    pub pool_stake: Account<'info, PoolStakeAccount>,
    /// CHECK: staker pubkey for PDA seeds.
    pub staker: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct PoolStakeEvent {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct PoolRedeemEvent {
    pub pool: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
    pub shares_burned: u64,
}

#[event]
pub struct TreasuryWithdrawEvent {
    pub room_id: [u8; 32],
    pub amount: u64,
    pub recipient: Pubkey,
}
