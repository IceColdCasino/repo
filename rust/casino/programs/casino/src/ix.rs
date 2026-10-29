use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::betting::*;
use crate::casino_factory::{
    Casino, CasinoAdmin, CasinoDealer, CASINO_ADMIN_SEED, CASINO_DEALER_SEED, CASINO_SEED,
};
use crate::room::{Room, TableState};
use crate::wallet::*;
use crate::whitelist::{self, WhitelistEntry};
use crate::session::{RoomSessionKey, RoomSessionLock};
use crate::{ErrorCode, GameState, PlayerState};

#[derive(Accounts)]
#[instruction(room_id: [u8; 32])]
pub struct CreateRoom<'info> {
    /// CAdmin, or a delegated casino admin. The handler checks which.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Room::INIT_SPACE,
        seeds = [b"room", &room_id[..]],
        bump
    )]
    pub room: Account<'info, Room>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = room,
        seeds = [b"vault", &room_id[..]],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetRoomRake<'info> {
    /// CAdmin, or a delegated admin of this room's casino.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    /// CHECK: whitelisted house recorded when `rake_bps` is non-zero.
    pub house: Option<UncheckedAccount<'info>>,
    pub whitelist_entry: Option<Account<'info, WhitelistEntry>>,
}

#[derive(Accounts)]
pub struct CreateTable<'info> {
    /// CAdmin, or a delegated admin of this room's casino.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub room: Account<'info, Room>,
    #[account(
        init,
        payer = authority,
        space = 8 + TableState::INIT_SPACE,
        seeds = [b"table", &room.room_id[..], &room.table_count.to_le_bytes()],
        bump
    )]
    pub table_state: Account<'info, TableState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CloseTable<'info> {
    /// CAdmin, or a delegated admin of this room's casino. Receives the table rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        mut,
        close = authority,
        seeds = [b"table", &room.room_id[..], &table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room.room_id @ ErrorCode::InvalidTableId,
        constraint = table_state.table_id == table_id @ ErrorCode::InvalidTableId,
    )]
    pub table_state: Account<'info, TableState>,
}

#[derive(Accounts)]
#[instruction(room_id: [u8; 32])]
pub struct AddToWhitelist<'info> {
    /// CAdmin, or a delegated admin of this room's casino.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"room", &room_id[..]], bump)]
    pub room: Account<'info, Room>,
    /// CHECK: player pubkey being whitelisted; validated via PDA seeds.
    pub player_to_whitelist: AccountInfo<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [whitelist::WHITELIST_SEED, &room_id[..], player_to_whitelist.key().as_ref()],
        bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    /// CAdmin, or a delegated admin of the room that owns this entry.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        close = admin,
        seeds = [whitelist::WHITELIST_SEED, &whitelist_entry.room_id[..], &whitelist_entry.player.as_ref()],
        bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
}

#[derive(Accounts)]
#[instruction(room_id: [u8; 32])]
pub struct InitRoomWallet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoomWallet::INIT_SPACE,
        seeds = [b"room_wallet", player.key().as_ref(), &room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateShieldedWallet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerShieldedWallet::INIT_SPACE,
        seeds = [b"shielded", player.key().as_ref()],
        bump
    )]
    pub shielded_wallet: Account<'info, PlayerShieldedWallet>,
    pub player: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSpl<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(mut, address = room.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    /// SPL deposit entitlement consumed later by `request_credit_room_balance`.
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PendingDeposit::INIT_SPACE,
        seeds = [b"pending_deposit", player.key().as_ref(), &room.room_id[..]],
        bump
    )]
    pub pending_deposit: Account<'info, PendingDeposit>,
    #[account(mut, constraint = player_token_account.mint == room.mint)]
    pub player_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct PendingWithdraw {
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(physical_seat: u8, _buy_in: u64)]
pub struct SitAtTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"table", &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    /// Reused after `leave_table`. That instruction clears the seat and keeps
    /// this PDA, so a second sit must not `init` it again.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + TableEscrow::INIT_SPACE,
        seeds = [b"table_escrow", player.key().as_ref(), &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_escrow: Account<'info, TableEscrow>,
    #[account(
        mut,
        seeds = [b"room_session", &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = room_session.session == player.key() @ ErrorCode::InvalidSessionKey,
        constraint = room_session.room_id == room.room_id @ ErrorCode::InvalidSessionKey,
    )]
    pub room_session: Account<'info, RoomSessionKey>,
    #[account(
        mut,
        seeds = [b"room_session_lock", &room.room_id[..], room_session.owner.as_ref()],
        bump,
        constraint = room_session_lock.owner == room_session.owner @ ErrorCode::InvalidSessionKey,
        constraint = room_session_lock.room_id == room.room_id @ ErrorCode::InvalidSessionKey,
    )]
    pub room_session_lock: Account<'info, RoomSessionLock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenRoomSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], owner.key().as_ref()],
        bump,
        constraint = owner_whitelist.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = owner_whitelist.player == owner.key() @ ErrorCode::NotWhitelisted,
    )]
    pub owner_whitelist: Account<'info, WhitelistEntry>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoomSessionKey::INIT_SPACE,
        seeds = [b"room_session", &room.room_id[..], owner.key().as_ref()],
        bump,
    )]
    pub room_session: Account<'info, RoomSessionKey>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RoomSessionLock::INIT_SPACE,
        seeds = [b"room_session_lock", &room.room_id[..], owner.key().as_ref()],
        bump,
    )]
    pub room_session_lock: Account<'info, RoomSessionLock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenDelegatedRoomSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    pub session: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], owner.key().as_ref()],
        bump,
        constraint = owner_whitelist.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = owner_whitelist.player == owner.key() @ ErrorCode::NotWhitelisted,
    )]
    pub owner_whitelist: Account<'info, WhitelistEntry>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + WhitelistEntry::INIT_SPACE,
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], session.key().as_ref()],
        bump,
    )]
    pub session_whitelist: Account<'info, WhitelistEntry>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoomSessionKey::INIT_SPACE,
        seeds = [b"room_session", &room.room_id[..], session.key().as_ref()],
        bump,
    )]
    pub room_session: Account<'info, RoomSessionKey>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RoomSessionLock::INIT_SPACE,
        seeds = [b"room_session_lock", &room.room_id[..], owner.key().as_ref()],
        bump,
    )]
    pub room_session_lock: Account<'info, RoomSessionLock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRoomSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        seeds = [b"room_session", &room_session.room_id[..], room_session.session.as_ref()],
        bump,
        constraint = room_session.owner == owner.key() @ ErrorCode::InvalidSessionKey,
        constraint = room_session.active_tables == 0 @ ErrorCode::SessionAlreadyPlaying,
    )]
    pub room_session: Account<'info, RoomSessionKey>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct FaucetCreditPersonal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room.room_id[..]],
        bump,
        constraint = room_wallet.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub room_wallet: Account<'info, RoomWallet>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct TransferPersonalToSeat<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room_wallet.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room_wallet.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room_wallet.room_id @ ErrorCode::InvalidTableId,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room_wallet.room_id[..]],
        bump,
        constraint = room_wallet.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room_wallet.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated,
        constraint = table_escrow.player == player.key() @ ErrorCode::NotSeated,
    )]
    pub table_escrow: Account<'info, TableEscrow>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct TransferSeatToPersonal<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room_wallet.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room_wallet.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room_wallet.room_id @ ErrorCode::InvalidTableId,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room_wallet.room_id[..]],
        bump,
        constraint = room_wallet.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room_wallet.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated,
        constraint = table_escrow.player == player.key() @ ErrorCode::NotSeated,
    )]
    pub table_escrow: Account<'info, TableEscrow>,
}


#[derive(Accounts)]
#[instruction(casino_id: [u8; 32])]
pub struct CreateCasino<'info> {
    #[account(
        mut,
        constraint = authority.key() == whitelist::WHITELIST_ADMIN @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Casino::INIT_SPACE,
        seeds = [CASINO_SEED, &casino_id],
        bump
    )]
    pub casino: Account<'info, Casino>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(casino_id: [u8; 32])]
pub struct AddCasinoAdmin<'info> {
    #[account(
        mut,
        constraint = authority.key() == whitelist::WHITELIST_ADMIN @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(seeds = [CASINO_SEED, &casino_id], bump = casino.bump)]
    pub casino: Account<'info, Casino>,
    /// CHECK: admin pubkey being delegated. The PDA seeds bind it.
    pub admin_key: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + CasinoAdmin::INIT_SPACE,
        seeds = [CASINO_ADMIN_SEED, &casino_id, admin_key.key().as_ref()],
        bump
    )]
    pub casino_admin: Account<'info, CasinoAdmin>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveCasinoAdmin<'info> {
    #[account(
        mut,
        constraint = authority.key() == whitelist::WHITELIST_ADMIN @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority,
        seeds = [CASINO_ADMIN_SEED, &casino_admin.casino_id, casino_admin.admin.as_ref()],
        bump = casino_admin.bump
    )]
    pub casino_admin: Account<'info, CasinoAdmin>,
}

#[derive(Accounts)]
#[instruction(casino_id: [u8; 32], game_kind: u8)]
pub struct AddCasinoDealer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CASINO_SEED, &casino_id], bump = casino.bump)]
    pub casino: Account<'info, Casino>,
    #[account(
        seeds = [CASINO_ADMIN_SEED, &casino_id, admin.key().as_ref()],
        bump = casino_admin.bump,
        constraint = casino_admin.admin == admin.key() @ ErrorCode::NotCasinoAdmin
    )]
    pub casino_admin: Account<'info, CasinoAdmin>,
    /// CHECK: dealer pubkey being registered for this game kind.
    pub dealer: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + CasinoDealer::INIT_SPACE,
        seeds = [CASINO_DEALER_SEED, &casino_id, &[game_kind], dealer.key().as_ref()],
        bump
    )]
    pub casino_dealer: Account<'info, CasinoDealer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveCasinoDealer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CASINO_SEED, &casino_dealer.casino_id], bump = casino.bump)]
    pub casino: Account<'info, Casino>,
    #[account(
        seeds = [CASINO_ADMIN_SEED, &casino_dealer.casino_id, admin.key().as_ref()],
        bump = casino_admin.bump,
        constraint = casino_admin.admin == admin.key() @ ErrorCode::NotCasinoAdmin
    )]
    pub casino_admin: Account<'info, CasinoAdmin>,
    #[account(
        mut,
        close = admin,
        seeds = [
            CASINO_DEALER_SEED,
            &casino_dealer.casino_id,
            &[casino_dealer.game_kind],
            casino_dealer.dealer.as_ref()
        ],
        bump = casino_dealer.bump
    )]
    pub casino_dealer: Account<'info, CasinoDealer>,
}
