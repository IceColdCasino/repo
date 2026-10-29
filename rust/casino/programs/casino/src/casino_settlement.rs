//! On-chain account contexts for casino Dealer Pool initialization.

use anchor_lang::prelude::*;

use crate::dealer_pool::{DealerPool, ProtocolTreasury};
use crate::room::{Room, TableState};

#[derive(Accounts)]
pub struct InitDealerPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        init,
        payer = payer,
        space = 8 + DealerPool::INIT_SPACE,
        seeds = [b"dealer_pool", &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: Account<'info, DealerPool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitProtocolTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolTreasury::INIT_SPACE,
        seeds = [b"protocol_treasury", &room.room_id[..]],
        bump,
    )]
    pub protocol_treasury: Account<'info, ProtocolTreasury>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct CasinoSettlementEvent {
    pub room_id: [u8; 32],
    pub table_id: u64,
    /// Always 0. The hand's protocol fee is not published.
    pub protocol_commission: u64,
    /// Always 0. The action that produced the fee is not published.
    pub total_action: u64,
}
