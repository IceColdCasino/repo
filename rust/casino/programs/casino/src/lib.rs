use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use shared_zk_ids::{
    share_active_limb_count, share_active_limb_count_for_cards, showdown_coeff_count, GameConfig,
    GameKind, CIRCUIT_VERSION_V2, CPI_AUTHORITY_SEED, LIGHT_CASINO_PROGRAM_ID, PROOF_RECEIPT_SEED,
    SHOWDOWN_MAX_COEFFS,
    PROOF_RECEIPT_V2_SEED, RECEIPT_STATUS_CONSUMED, RECEIPT_STATUS_VERIFIED,
};

#[cfg(any(target_os = "solana", target_arch = "sbf"))]
mod getrandom_stub {
    use getrandom::{register_custom_getrandom, Error};

    fn solana_getrandom(dest: &mut [u8]) -> Result<(), Error> {
        for byte in dest.iter_mut() {
            *byte = 0;
        }
        Ok(())
    }

    register_custom_getrandom!(solana_getrandom);
}

pub mod pot;
pub mod wallet;
pub mod room;
pub mod seat_order;
pub mod betting;
pub mod token;
pub mod ix;
pub mod whitelist;
pub mod session;
pub mod dealer_pool;
pub mod casino_settlement;
pub mod casino_pool;
pub mod casino_factory;
mod rent_vault;
mod reveal_chunks;
use pot::{apply_bet_and_recompute_pots, apply_poker_rake, recompute_pots};
use wallet::*;
use room::*;
use seat_order::*;
use betting::*;
use ix::*;
use whitelist::*;
use dealer_pool::{CasinoGameKind, DealerPool, PoolStakeAccount, ProtocolTreasury};
use casino_settlement::*;
use casino_pool::*;
use casino_factory::{authorize_room_operator, authorize_whitelist_removal, bind_room_authority};
use token::{transfer_from_vault, transfer_to_vault};

fn bind_wallet_encryption_pubkey(stored: &mut [u8; 32], provided: &[u8; 32]) -> Result<()> {
    bind_encryption_pubkey(stored, provided).map_err(|_| error!(ErrorCode::InvalidMpcKeyPurpose))
}

declare_id!("4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY");

/// Instructions sysvar. Anchor 1.0 no longer re-exports this id from
/// `solana_program::sysvar::instructions`.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey =
    pubkey!("Sysvar1nstructions1111111111111111111111111");

pub const PROOF_PHASE_REGISTER: u8 = 0;
pub const PROOF_PHASE_SHUFFLE: u8 = 1;
pub const PROOF_PHASE_SHARE: u8 = 2;
pub const PROOF_PHASE_SHOWDOWN: u8 = 3;

/// Async callback state. A callback is accepted for the computation that opened
/// this generation, including after `expires_slot`. The expiry only lets a lost
/// callback be replaced; a late delivery of that same computation still applies.
pub const PENDING_OPERATION_PENDING: u8 = 1;
pub const PENDING_OPERATION_COMPLETED: u8 = 2;
pub const PENDING_OPERATION_EXPIRED: u8 = 3;

pub const CALLBACK_TTL_SLOTS: u64 = 300;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PendingOperation {
    pub generation: u64,
    pub computation: Pubkey,
    pub authority: Pubkey,
    pub started_slot: u64,
    pub expires_slot: u64,
    pub status: u8,
}

fn start_pending_operation(operation: &mut PendingOperation, generation: u64, computation: Pubkey, authority: Pubkey) -> Result<()> {
    let now = Clock::get()?.slot;
    require!(
        operation.status != PENDING_OPERATION_PENDING || now > operation.expires_slot,
        ErrorCode::PendingOperationActive
    );
    *operation = PendingOperation {
        generation,
        computation,
        authority,
        started_slot: now,
        expires_slot: now.saturating_add(CALLBACK_TTL_SLOTS),
        status: PENDING_OPERATION_PENDING,
    };
    Ok(())
}

/// Returns true for a same-generation duplicate callback, which is deliberately
/// a success/no-op. A different computation fails closed. A matching pending
/// computation is applied even when `expires_slot` has passed.
fn accept_pending_callback(operation: &mut PendingOperation, computation: Pubkey) -> Result<bool> {
    require!(operation.computation == computation, ErrorCode::StaleCallback);
    if operation.status == PENDING_OPERATION_COMPLETED {
        return Ok(true);
    }
    require!(operation.status == PENDING_OPERATION_PENDING, ErrorCode::StaleCallback);
    Ok(false)
}
/// Settlement state is independent from the hand phase: a showdown can be
/// accepted while its all-seat MPC job is still pending.
pub const SETTLEMENT_AWAITING_PROOF: u8 = 0;
pub const SETTLEMENT_PROOF_ACCEPTED: u8 = 1;
pub const SETTLEMENT_PENDING: u8 = 2;
pub const SETTLEMENT_SETTLED: u8 = 3;
pub const SETTLEMENT_REFUNDABLE: u8 = 4;
pub const SETTLEMENT_REFUNDED: u8 = 5;
pub const SETTLEMENT_TIMEOUT_SLOTS: u64 = 1_200;

/// On-chain action kinds for [`PlayerActionRequired`] (clients react per seat).
pub const ACTION_KIND_REGISTER: u8 = 0;
pub const ACTION_KIND_SHUFFLE: u8 = 1;
pub const ACTION_KIND_SHARE: u8 = 2;
pub const ACTION_KIND_BET: u8 = 3;
pub const ACTION_KIND_SHOWDOWN: u8 = 4;
pub const ACTION_KIND_REVEAL: u8 = 5;
pub const ACTION_KIND_NEXT_REGISTER: u8 = 6;
pub const ACTION_KIND_NEXT_SHUFFLE: u8 = 7;
pub const ACTION_KIND_NEXT_SHARE: u8 = 8;

/// Next-hand pipeline. It opens when a poker street enters showdown.
/// 0 closed, 1 register, 2 shuffle, 3 share, 4 ready for `start_hand`.
pub const NEXT_HAND_CLOSED: u8 = 0;
pub const NEXT_HAND_REGISTER: u8 = 1;
pub const NEXT_HAND_SHUFFLE: u8 = 2;
pub const NEXT_HAND_SHARE: u8 = 3;
pub const NEXT_HAND_READY: u8 = 4;

const HAND_PLAYER_CAP: usize = 10;

/// Public keys and padding for the ten player indexes. Kept off `GameState`
/// so deserializing a hand still fits in a 4KB stack frame.
#[derive(Clone, Default)]
struct RegistrationMaterial {
    public_key: [[[u8; 32]; 2]; HAND_PLAYER_CAP],
    padding: [[[u8; 32]; 4]; HAND_PLAYER_CAP],
}

/// One player: two 32-byte key limbs and four 32-byte padding limbs.
const REG_SLOT_BYTES: usize = 192;
const REG_TAIL_BYTES: usize = REG_SLOT_BYTES * HAND_PLAYER_CAP;

fn heap_registration() -> Box<RegistrationMaterial> {
    let layout = std::alloc::Layout::new::<RegistrationMaterial>();
    unsafe {
        let ptr = std::alloc::alloc_zeroed(layout) as *mut RegistrationMaterial;
        assert!(!ptr.is_null(), "registration heap");
        Box::from_raw(ptr)
    }
}

fn read_registration_tail(src: &[u8], dst: &mut RegistrationMaterial) {
    let mut offset = 0;
    for player in 0..HAND_PLAYER_CAP {
        for limb in 0..2 {
            dst.public_key[player][limb].copy_from_slice(&src[offset..offset + 32]);
            offset += 32;
        }
        for limb in 0..4 {
            dst.padding[player][limb].copy_from_slice(&src[offset..offset + 32]);
            offset += 32;
        }
    }
}

fn write_registration_tail(dst: &mut [u8], src: &RegistrationMaterial) {
    let mut offset = 0;
    for player in 0..HAND_PLAYER_CAP {
        for limb in 0..2 {
            dst[offset..offset + 32].copy_from_slice(&src.public_key[player][limb]);
            offset += 32;
        }
        for limb in 0..4 {
            dst[offset..offset + 32].copy_from_slice(&src.padding[player][limb]);
            offset += 32;
        }
    }
}

/// Keys sit after the Borsh `GameState` payload so account load stays small.
#[inline(never)]
fn load_registration(info: &AccountInfo) -> Result<Box<RegistrationMaterial>> {
    let mut material = heap_registration();
    let data = info.try_borrow_data()?;
    let start = 8 + GameState::INIT_SPACE;
    let end = start + REG_TAIL_BYTES;
    if data.len() >= end {
        read_registration_tail(&data[start..end], &mut material);
    }
    Ok(material)
}

#[inline(never)]
fn store_registration(info: &AccountInfo, material: &RegistrationMaterial) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let start = 8 + GameState::INIT_SPACE;
    let end = start + REG_TAIL_BYTES;
    require!(data.len() >= end, ErrorCode::InvalidGamePhase);
    write_registration_tail(&mut data[start..end], material);
    Ok(())
}

fn joined_player_mask(n: u8) -> u16 {
    if n == 0 || n >= 16 {
        0
    } else {
        (1u16 << n) - 1
    }
}

fn registration_material_ready(public_key: &[[u8; 32]; 2], padding: &[[u8; 32]; 4]) -> bool {
    *public_key != [[0u8; 32]; 2] && *padding != [[0u8; 32]; 4]
}

fn remember_player_registration(
    game_state: &mut GameState,
    material: &mut RegistrationMaterial,
    player_index: u8,
    public_key: [[u8; 32]; 2],
    padding: [[u8; 32]; 4],
) -> Result<()> {
    require!(
        (player_index as usize) < HAND_PLAYER_CAP,
        ErrorCode::InvalidGamePhase
    );
    require!(
        registration_material_ready(&public_key, &padding),
        ErrorCode::InvalidProof
    );
    let index = player_index as usize;
    let bit = 1u16 << player_index;
    if game_state.registered_mask & bit != 0 {
        require!(
            material.public_key[index] == public_key && material.padding[index] == padding,
            ErrorCode::InvalidProof
        );
    } else {
        material.public_key[index] = public_key;
        material.padding[index] = padding;
        game_state.registered_mask |= bit;
    }
    Ok(())
}

/// Open the next hand when poker betting enters showdown.
///
/// Every player in this hand must register and shuffle. When each of them
/// already has a public key and padding, registration is reused and shuffle
/// is open immediately.
fn open_next_hand_on_showdown(game_state: &mut GameState) {
    if game_state.betting_phase != 5 || game_state.next_hand_phase != NEXT_HAND_CLOSED {
        return;
    }
    let n = game_state.num_players;
    if n == 0 || n as usize > HAND_PLAYER_CAP {
        return;
    }
    let joined = joined_player_mask(n);
    let already = game_state.registered_mask & joined;
    game_state.next_num_players = n;
    game_state.next_shuffler = 0;
    game_state.next_shuffled_mask = 0;
    game_state.next_shared_mask = 0;
    game_state.next_registered_mask = already;
    game_state.next_hand_phase = if already == joined {
        NEXT_HAND_SHUFFLE
    } else {
        NEXT_HAND_REGISTER
    };
}

fn note_next_hand_registration(game_state: &mut GameState, player_index: u8) -> Result<()> {
    require!(
        game_state.next_hand_phase == NEXT_HAND_REGISTER,
        ErrorCode::InvalidGamePhase
    );
    require!(
        player_index < game_state.next_num_players,
        ErrorCode::InvalidGamePhase
    );
    let bit = 1u16 << player_index;
    require!(
        game_state.next_registered_mask & bit == 0,
        ErrorCode::PlayerAlreadyRegistered
    );
    require!(
        game_state.registered_mask & bit != 0,
        ErrorCode::InvalidProof
    );
    game_state.next_registered_mask |= bit;
    if game_state.next_registered_mask == joined_player_mask(game_state.next_num_players) {
        game_state.next_hand_phase = NEXT_HAND_SHUFFLE;
        game_state.next_shuffler = 0;
    }
    Ok(())
}

pub(crate) fn register_next_hand_player(
    game_state: &mut GameState,
    material: &mut RegistrationMaterial,
    player_state: &mut PlayerState,
    public_key: [[u8; 32]; 2],
    padding: [[u8; 32]; 4],
) -> Result<()> {
    let player_index = player_state.player_index;
    remember_player_registration(game_state, material, player_index, public_key, padding)?;
    player_state.public_key = public_key;
    player_state.padding = padding;
    if player_state.game_id == [0u8; 32] {
        player_state.game_id = game_state.game_id;
    }
    note_next_hand_registration(game_state, player_index)
}

pub(crate) fn join_next_hand_shuffle(game_state: &mut GameState, player_index: u8) -> Result<()> {
    require!(
        game_state.next_hand_phase == NEXT_HAND_SHUFFLE,
        ErrorCode::InvalidGamePhase
    );
    require!(
        player_index < game_state.next_num_players,
        ErrorCode::InvalidGamePhase
    );
    require!(player_index == game_state.next_shuffler, ErrorCode::NotYourTurn);
    let bit = 1u16 << player_index;
    require!(
        game_state.next_registered_mask & bit != 0,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.next_shuffled_mask & bit == 0,
        ErrorCode::InvalidGamePhase
    );
    game_state.next_shuffled_mask |= bit;
    game_state.next_shuffler = game_state.next_shuffler.saturating_add(1);
    if game_state.next_shuffled_mask == joined_player_mask(game_state.next_num_players) {
        game_state.next_hand_phase = NEXT_HAND_SHARE;
    }
    Ok(())
}

pub(crate) fn join_next_hand_share(game_state: &mut GameState, player_index: u8) -> Result<()> {
    require!(
        game_state.next_hand_phase == NEXT_HAND_SHARE,
        ErrorCode::InvalidGamePhase
    );
    require!(
        player_index < game_state.next_num_players,
        ErrorCode::InvalidGamePhase
    );
    let bit = 1u16 << player_index;
    require!(
        game_state.next_shuffled_mask & bit != 0,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.next_shared_mask & bit == 0,
        ErrorCode::AlreadyShared
    );
    game_state.next_shared_mask |= bit;
    if game_state.next_shared_mask == joined_player_mask(game_state.next_num_players) {
        game_state.next_hand_phase = NEXT_HAND_READY;
    }
    Ok(())
}

fn snapshot_next_hand_seats(game_state: &mut GameState, table: &TableState) {
    if game_state.next_seat_saved || game_state.next_num_players == 0 {
        return;
    }
    let n = game_state.next_num_players as usize;
    if n > game_state.next_seat_order.len() || n > table.hand_seat_order.len() {
        return;
    }
    game_state.next_seat_order[..n].copy_from_slice(&table.hand_seat_order[..n]);
    game_state.next_seat_saved = true;
}

/// The pot callback accepted this hand. Save the next-hand seats, mark the
/// pot settled, and clear the table so the next hand can start.
fn close_hand_after_pot_settlement(
    game_state: &mut GameState,
    table: &mut TableState,
) -> Result<()> {
    require!(
        table.hand_in_progress && table.current_game_id == game_state.game_id,
        ErrorCode::InvalidGamePhase
    );
    game_state.phase = 6;
    game_state.settlement_status = SETTLEMENT_SETTLED;
    snapshot_next_hand_seats(game_state, table);
    table.end_hand();
    Ok(())
}

fn require_next_hand_seat(
    game_state: &GameState,
    table: &TableState,
    player_index: u8,
    signer: &Pubkey,
) -> Result<()> {
    require!(
        player_index < game_state.next_num_players,
        ErrorCode::InvalidGamePhase
    );
    let seat = if game_state.next_seat_saved {
        game_state.next_seat_order[player_index as usize]
    } else if table.hand_in_progress && table.current_game_id == game_state.game_id {
        table.hand_seat_order[player_index as usize]
    } else {
        return err!(ErrorCode::InvalidGamePhase);
    };
    require!(
        (seat as usize) < table.seats.len(),
        ErrorCode::InvalidSeat
    );
    require!(table.seats[seat as usize] == *signer, ErrorCode::NotSeated);
    Ok(())
}

fn require_next_hand_table(ctx: &Context<NextHandPlayer>) -> Result<()> {
    verify_whitelisted(
        &ctx.accounts.whitelist_entry,
        &ctx.accounts.table_state.room_id,
        &ctx.accounts.player.key(),
    )?;
    require!(
        ctx.accounts.game_state.table_room_id == ctx.accounts.table_state.room_id
            && ctx.accounts.game_state.table_id == ctx.accounts.table_state.table_id,
        ErrorCode::InvalidAuthority
    );
    Ok(())
}

fn prepare_next_hand_seat(
    game_state: &mut GameState,
    table: &TableState,
    player_index: u8,
    signer: &Pubkey,
) -> Result<()> {
    if !game_state.next_seat_saved
        && table.hand_in_progress
        && table.current_game_id == game_state.game_id
    {
        snapshot_next_hand_seats(game_state, table);
    }
    require_next_hand_seat(game_state, table, player_index, signer)
}

#[inline(never)]
fn reindex_registrations_to_seat_order(
    game_state: &mut GameState,
    material: &mut RegistrationMaterial,
    new_order: &[u8],
    num_players: u8,
) {
    if !game_state.next_seat_saved {
        return;
    }
    let n = (num_players as usize).min(HAND_PLAYER_CAP).min(new_order.len());
    let old_n = (game_state.next_num_players as usize).min(game_state.next_seat_order.len());
    let mut old = heap_registration();
    unsafe {
        std::ptr::copy_nonoverlapping(
            material as *const RegistrationMaterial,
            &mut *old as *mut RegistrationMaterial,
            1,
        );
        std::ptr::write_bytes(material as *mut RegistrationMaterial, 0, 1);
    }
    let old_mask = game_state.registered_mask;
    game_state.registered_mask = 0;
    for new_index in 0..n {
        let seat = new_order[new_index];
        let Some(old_index) = game_state.next_seat_order[..old_n]
            .iter()
            .position(|old_seat| *old_seat == seat)
        else {
            continue;
        };
        material.public_key[new_index] = old.public_key[old_index];
        material.padding[new_index] = old.padding[old_index];
        if old_mask & (1u16 << old_index) != 0 {
            game_state.registered_mask |= 1u16 << new_index;
        }
    }
}

fn accept_next_hand_for_start(game_state: &GameState, num_players: u8) -> Result<()> {
    match game_state.next_hand_phase {
        NEXT_HAND_CLOSED => Ok(()),
        NEXT_HAND_READY => {
            require!(
                game_state.next_num_players == num_players,
                ErrorCode::InvalidGamePhase
            );
            Ok(())
        }
        _ => err!(ErrorCode::InvalidGamePhase),
    }
}

fn finish_next_hand_for_start(game_state: &mut GameState, num_players: u8, next_phase: u8) {
    if next_phase == NEXT_HAND_READY {
        game_state.phase = 3;
        game_state.shared_mask = joined_player_mask(num_players);
    }
    game_state.next_hand_phase = NEXT_HAND_CLOSED;
    game_state.next_num_players = 0;
    game_state.next_shuffler = 0;
    game_state.next_registered_mask = 0;
    game_state.next_shuffled_mask = 0;
    game_state.next_shared_mask = 0;
    game_state.next_seat_saved = false;
    game_state.next_seat_order = [0u8; HAND_PLAYER_CAP];
}

fn emit_next_hand_required(game_state: &GameState) {
    let (kind, mask, sequential) = match game_state.next_hand_phase {
        NEXT_HAND_REGISTER => (
            ACTION_KIND_NEXT_REGISTER,
            game_state.next_registered_mask,
            false,
        ),
        NEXT_HAND_SHUFFLE => (ACTION_KIND_NEXT_SHUFFLE, game_state.next_shuffled_mask, true),
        NEXT_HAND_SHARE => (ACTION_KIND_NEXT_SHARE, game_state.next_shared_mask, false),
        _ => return,
    };
    for i in 0..game_state.next_num_players {
        if sequential && i != game_state.next_shuffler {
            continue;
        }
        if mask & (1u16 << i) != 0 {
            continue;
        }
        emit!(PlayerActionRequired {
            game_id: game_state.game_id,
            player_index: i,
            action_kind: kind,
            phase: game_state.phase,
            betting_phase: game_state.betting_phase,
            act_deadline_unix: game_state.act_deadline_unix,
        });
    }
}

/// Escrow transfer kinds for [`EscrowFundedEvent`].
#[cfg(feature = "testing")]
pub const ESCROW_KIND_FAUCET: u8 = 0;
pub const ESCROW_KIND_PERSONAL_TO_SEAT: u8 = 1;
pub const ESCROW_KIND_SEAT_TO_PERSONAL: u8 = 2;

/// Emit one (or many, for parallel register/share/showdown) "you must act" events from `GameState`.
fn emit_player_action_required(game_state: &GameState) {
    // Register is parallel: `shared_mask` tracks who has registered until Shuffle.
    if game_state.phase == PROOF_PHASE_REGISTER {
        for i in 0..game_state.num_players {
            if game_state.shared_mask & (1u16 << i) == 0 {
                emit!(PlayerActionRequired {
                    game_id: game_state.game_id,
                    player_index: i,
                    action_kind: ACTION_KIND_REGISTER,
                    phase: game_state.phase,
                    betting_phase: game_state.betting_phase,
                    act_deadline_unix: game_state.act_deadline_unix,
                });
            }
        }
        return;
    }

    if game_state.phase == PROOF_PHASE_SHARE {
        for i in 0..game_state.num_players {
            if game_state.shared_mask & (1u16 << i) == 0 {
                emit!(PlayerActionRequired {
                    game_id: game_state.game_id,
                    player_index: i,
                    action_kind: ACTION_KIND_SHARE,
                    phase: game_state.phase,
                    betting_phase: game_state.betting_phase,
                    act_deadline_unix: game_state.act_deadline_unix,
                });
            }
        }
        return;
    }

    if game_state.betting_phase == 5 || game_state.phase == 5 {
        for i in 0..game_state.num_players {
            if game_state.folded_mask & (1u16 << i) == 0 {
                emit!(PlayerActionRequired {
                    game_id: game_state.game_id,
                    player_index: i,
                    action_kind: ACTION_KIND_SHOWDOWN,
                    phase: game_state.phase,
                    betting_phase: game_state.betting_phase,
                    act_deadline_unix: game_state.act_deadline_unix,
                });
            }
        }
        emit_next_hand_required(game_state);
        return;
    }

    let action_kind = if game_state.betting_phase >= 1 && game_state.betting_phase <= 4 {
        ACTION_KIND_BET
    } else {
        match game_state.phase {
            PROOF_PHASE_REGISTER => ACTION_KIND_REGISTER,
            PROOF_PHASE_SHUFFLE => ACTION_KIND_SHUFFLE,
            _ => return,
        }
    };

    emit!(PlayerActionRequired {
        game_id: game_state.game_id,
        player_index: game_state.current_player,
        action_kind,
        phase: game_state.phase,
        betting_phase: game_state.betting_phase,
        act_deadline_unix: game_state.act_deadline_unix,
    });
}

fn emit_phase_advanced(game_state: &GameState) {
    emit!(PhaseAdvancedEvent {
        game_id: game_state.game_id,
        phase: game_state.phase,
        betting_phase: game_state.betting_phase,
        current_player: game_state.current_player,
    });
}

fn emit_street_advanced(game_state: &GameState, from_betting_phase: u8) {
    emit!(StreetAdvancedEvent {
        game_id: game_state.game_id,
        from_betting_phase,
        betting_phase: game_state.betting_phase,
        phase: game_state.phase,
        current_player: game_state.current_player,
    });
}

/// Non-folded seats still in the hand.
fn active_player_count(game_state: &GameState) -> u8 {
    let mut n = 0u8;
    for i in 0..game_state.num_players {
        if game_state.folded_mask & (1u16 << i) == 0 {
            n = n.saturating_add(1);
        }
    }
    n
}

fn street_bets_matched(game_state: &GameState) -> bool {
    let n = (game_state.num_players as usize).min(game_state.hand_commits.len());
    let mut max_street = 0u64;
    for i in 0..n {
        if game_state.folded_mask & (1u16 << i) != 0 {
            continue;
        }
        max_street = max_street.max(game_state.hand_commits[i]);
    }
    for i in 0..n {
        if game_state.folded_mask & (1u16 << i) != 0 {
            continue;
        }
        if game_state.all_in_mask & (1u16 << i) != 0 {
            continue;
        }
        if game_state.hand_commits[i] != max_street {
            return false;
        }
    }
    true
}

/// Every player who can still act has acted this street.
fn all_can_act_have_acted(game_state: &GameState) -> bool {
    for i in 0..game_state.num_players {
        if game_state.folded_mask & (1u16 << i) != 0 {
            continue;
        }
        if game_state.all_in_mask & (1u16 << i) != 0 {
            continue;
        }
        if game_state.acted_mask & (1u16 << i) == 0 {
            return false;
        }
    }
    true
}

/// Update `acted_mask` after a bet callback. Raises reset the mask to the aggressor.
fn record_street_acted(game_state: &mut GameState, player_index: u8, action: u8, raised: bool) {
    let bit = 1u16 << player_index;
    if action == 3 || action == 4 || raised {
        game_state.acted_mask = bit;
    } else {
        game_state.acted_mask |= bit;
    }
}

fn is_legal_betting_phase_transition(from: u8, to: u8) -> bool {
    (from == 0 && to == 1) || (from == to && (1..=5).contains(&to))
}

/// Seconds a player has to check, fold, or raise once the turn is theirs.
pub const BET_DECISION_SECONDS: i64 = 60;

fn assign_action_deadline(game_state: &mut GameState, now: i64) {
    if (1..=4).contains(&game_state.betting_phase) {
        game_state.act_deadline_unix = now.saturating_add(BET_DECISION_SECONDS);
    } else {
        game_state.act_deadline_unix = 0;
    }
}

fn action_is_in_time(deadline: i64, now: i64) -> bool {
    deadline != 0 && now <= deadline
}

/// Arm or clear the turn clock. Host tests have no Clock sysvar, so they
/// call [`assign_action_deadline`] with an explicit timestamp.
fn note_betting_turn(game_state: &mut GameState) {
    #[cfg(any(target_os = "solana", target_arch = "sbf"))]
    {
        if let Ok(clock) = Clock::get() {
            assign_action_deadline(game_state, clock.unix_timestamp);
        }
    }
    #[cfg(not(any(target_os = "solana", target_arch = "sbf")))]
    {
        let _ = game_state;
    }
}

/// Open preflop only — streets advance exclusively via bet-callback
/// [`advance_betting_street_on_chain`]. Callers never supply a phase.
fn apply_open_preflop(game_state: &mut GameState) -> Result<()> {
    require!(game_state.betting_phase == 0, ErrorCode::InvalidGamePhase);
    game_state.betting_phase = 1;
    game_state.acted_mask = 0;
    game_state.current_player = first_to_act(
        1,
        game_state.num_players,
        game_state.folded_mask,
        game_state.all_in_mask,
    )
    .unwrap_or(0);
    note_betting_turn(game_state);
    emit_phase_advanced(game_state);
    emit_player_action_required(game_state);
    Ok(())
}

fn is_betting_round_authority(authority: &Pubkey) -> bool {
    #[cfg(feature = "testing")]
    {
        let _ = authority;
        true
    }
    #[cfg(not(feature = "testing"))]
    {
        *authority == whitelist::WHITELIST_ADMIN
    }
}

/// Close the current betting street and open the next (or Showdown).
/// Emits `StreetAdvancedEvent` + `PhaseAdvancedEvent` (+ action required).
fn advance_betting_street_on_chain(game_state: &mut GameState) -> Result<()> {
    let from = game_state.betting_phase;
    let already_on_flop = game_state.reached_flop;
    // One player left: no showdown. The pot (and any uncalled refund) is theirs.
    // A preflop fold never sets `reached_flop`, so the pot is not raked.
    if active_player_count(game_state) == 1 {
        return close_uncontested_hand(game_state, from);
    }
    // River complete with players still contesting → showdown.
    if from >= 4 {
        game_state.betting_phase = 5;
        game_state.phase = 5;
        open_next_hand_on_showdown(game_state);
        game_state.current_bet = 0;
        game_state.last_aggressor = 0;
        game_state.last_aggressor_amount = 0;
        game_state.acted_mask = 0;
        // hand_commits tracks per-street bets during v2 betting.
        game_state.hand_commits = [0u64; 10];
        game_state.current_player = 0;
        note_betting_turn(game_state);
        emit_street_advanced(game_state, from);
        emit_phase_advanced(game_state);
        emit_player_action_required(game_state);
        return Ok(());
    }

    // Advance one street at a time; skip empty streets when nobody can act (all-in runout).
    let mut cursor = from;
    loop {
        let next = cursor.saturating_add(1);
        if next >= 2 {
            game_state.reached_flop = true;
        }
        game_state.betting_phase = next;
        game_state.current_bet = 0;
        game_state.last_aggressor = 0;
        game_state.last_aggressor_amount = 0;
        game_state.acted_mask = 0;
        game_state.hand_commits = [0u64; 10];
        if next >= 5 {
            game_state.betting_phase = 5;
            game_state.phase = 5;
            open_next_hand_on_showdown(game_state);
            game_state.current_player = 0;
            note_betting_turn(game_state);
            emit_street_advanced(game_state, from);
            emit_phase_advanced(game_state);
            emit_player_action_required(game_state);
            break;
        }
        if let Some(first) = first_to_act(
            next,
            game_state.num_players,
            game_state.folded_mask,
            game_state.all_in_mask,
        ) {
            game_state.current_player = first;
            note_betting_turn(game_state);
            emit_street_advanced(game_state, from);
            emit_phase_advanced(game_state);
            emit_player_action_required(game_state);
            break;
        }
        cursor = next;
    }
    if !already_on_flop && game_state.reached_flop {
        take_flop_rake(game_state)?;
    }
    Ok(())
}

/// Fold left a single player. Credit that player and finish the hand.
/// Showdown is not opened, and no showdown action is requested.
fn close_uncontested_hand(game_state: &mut GameState, from: u8) -> Result<()> {
    let mut winner: Option<u8> = None;
    for i in 0..game_state.num_players {
        if game_state.folded_mask & (1u16 << i) == 0 {
            winner = Some(i);
            break;
        }
    }
    let winner = winner.unwrap_or(0);
    let mut payouts = [0u64; 10];
    let n = (game_state.num_players as usize).min(payouts.len());
    for i in 0..n {
        payouts[i] = game_state.refunds[i];
    }
    let mut pot_total = 0u64;
    for amount in game_state.pots {
        pot_total = pot_total.saturating_add(amount);
    }
    if (winner as usize) < payouts.len() {
        payouts[winner as usize] = payouts[winner as usize].saturating_add(pot_total);
    }
    game_state.payouts = payouts;
    game_state.phase = 6;
    // Stay on the street that was open. Flop, turn, and river reveals key off
    // `betting_phase`, so jumping to 6 would publish streets that were never dealt.
    game_state.current_bet = 0;
    game_state.last_aggressor = 0;
    game_state.last_aggressor_amount = 0;
    game_state.acted_mask = 0;
    game_state.hand_commits = [0u64; 10];
    game_state.current_player = winner;
    game_state.act_deadline_unix = 0;
    emit_street_advanced(game_state, from);
    emit_phase_advanced(game_state);
    Ok(())
}

/// Apply the street-close flag revealed by Arcis `validate_bet`.
fn apply_arcis_street_decision(
    game_state: &mut GameState,
    player_index: u8,
    action: u8,
    raised: bool,
    street_closed: bool,
) -> Result<()> {
    if game_state.betting_phase < 1 || game_state.betting_phase > 4 {
        return Ok(());
    }
    if street_closed {
        return advance_betting_street_on_chain(game_state);
    }
    record_street_acted(game_state, player_index, action, raised);
    if let Some(next) = next_active_player(
        player_index,
        game_state.num_players,
        game_state.folded_mask,
        game_state.all_in_mask,
    ) {
        game_state.current_player = next;
        note_betting_turn(game_state);
        emit_player_action_required(game_state);
    }
    Ok(())
}

/// A missed decision window folds. A free check is sent by the client before
/// the deadline, so the chain does not turn a timeout into a check.
fn apply_timeout_action(game_state: &mut GameState) -> Result<u8> {
    let player_index = game_state.current_player;
    require!(player_index < game_state.num_players, ErrorCode::NotYourTurn);
    require!(
        (player_index as usize) < game_state.hand_commits.len(),
        ErrorCode::InvalidSeat
    );
    require!(
        game_state.folded_mask & (1u16 << player_index) == 0
            && game_state.all_in_mask & (1u16 << player_index) == 0,
        ErrorCode::InvalidBet
    );
    game_state.folded_mask |= 1u16 << player_index;
    after_bet_update_turn(game_state, player_index, 0, false)?;
    Ok(0)
}

/// After a validated bet: close street when matched+acted (or nobody can act), else next player.
fn store_raked_pots(game_state: &mut GameState, canonical: pot::CanonicalPots) -> Result<()> {
    let raked = apply_poker_rake(
        &canonical.amounts,
        game_state.rake_bps,
        game_state.reached_flop,
    )
    .map_err(|_| error!(ErrorCode::InvalidCanonicalPot))?;
    game_state.pots = raked.amounts;
    game_state.rake_amount = raked.rake;
    game_state.pot_eligible_masks = canonical.eligible_masks;
    game_state.refunds = canonical.refunds;
    game_state.pot_count = canonical.pot_count;
    Ok(())
}

/// First time the board is dealt, the pots on the account are still gross.
fn take_flop_rake(game_state: &mut GameState) -> Result<()> {
    let raked = apply_poker_rake(
        &game_state.pots,
        game_state.rake_bps,
        game_state.reached_flop,
    )
    .map_err(|_| error!(ErrorCode::InvalidCanonicalPot))?;
    game_state.pots = raked.amounts;
    game_state.rake_amount = raked.rake;
    Ok(())
}

fn after_bet_update_turn(game_state: &mut GameState, player_index: u8, action: u8, raised: bool) -> Result<()> {
    if game_state.betting_phase < 1 || game_state.betting_phase > 4 {
        return Ok(());
    }
    record_street_acted(game_state, player_index, action, raised);

    let nobody_can_act = next_active_player(
        player_index,
        game_state.num_players,
        game_state.folded_mask,
        game_state.all_in_mask,
    )
    .is_none();
    // A heads-up limp matches the blind but is not the end of preflop. The big
    // blind still checks or raises. Close only once everyone who can act has
    // acted and the street bets match (or nobody is left to act).
    let street_done = active_player_count(game_state) <= 1
        || nobody_can_act
        || (all_can_act_have_acted(game_state) && street_bets_matched(game_state));

    if street_done {
        return advance_betting_street_on_chain(game_state);
    }

    if let Some(next) = next_active_player(
        player_index,
        game_state.num_players,
        game_state.folded_mask,
        game_state.all_in_mask,
    ) {
        game_state.current_player = next;
        note_betting_turn(game_state);
        emit_player_action_required(game_state);
    }
    Ok(())
}

/// Deck/share staging size.
///
/// Logical commitments are 900 limbs (28_800 bytes). The extra 1_120 bytes are
/// historical padding from the 36-limb reader; 4-limb folds end on limb 900 and
/// do not use it. Do not shrink the account.
pub const DECK_STAGING_ACCOUNT_SIZE: usize = 29_920;
/// Commitments in one card-major row. Reveal still walks a row in fold-sized slices.
pub const VERIFY_CHUNK_LEN: u16 = 36;
pub const VERIFY_CHUNK_BYTES: u32 = (VERIFY_CHUNK_LEN as u32) * 32;
/// Limbs decrypted by one `reveal_card` and one share-verify job.
/// Must divide every active span (those spans are multiples of 4).
pub const VERIFY_FOLD_LEN: u16 = 4;
pub const VERIFY_FOLD_BYTES: u32 = (VERIFY_FOLD_LEN as u32) * 32;

/// Number of deal cards that participate in verify for `num_players` (holes + board).
pub fn used_verify_card_count(num_players: u8) -> u16 {
    (num_players as u16).saturating_mul(2).saturating_add(5)
}

/// Progress target: used cards × active limbs per card. Padding past that prefix
/// is not folded and does not count.
pub fn used_verify_progress_target(num_players: u8) -> u16 {
    used_verify_card_count(num_players).saturating_mul(verify_limb_count(num_players) as u16)
}

/// Active recipient limbs hashed per card row: (num_players - 1) × 4.
pub fn verify_limb_count(num_players: u8) -> u8 {
    num_players.saturating_sub(1).saturating_mul(4)
}

/// Canonical share-verify job at `start` inside `[span, span+len)`.
///
/// Every 4-aligned offset that still fits is one Poseidon(4) job.
fn fold_in_span(start: u16, span: u16, len: u16) -> Option<u8> {
    if start < span {
        return None;
    }
    let offset = start - span;
    if offset % VERIFY_FOLD_LEN != 0 {
        return None;
    }
    let end = span.saturating_add(len);
    if start.saturating_add(VERIFY_FOLD_LEN) <= end {
        Some(VERIFY_FOLD_LEN as u8)
    } else {
        None
    }
}

/// Validate an absolute recipient-major share fold and return its limb count.
///
/// Must match TypeScript `recipientMajorVerifyChunks`. Each job is 4 limbs.
/// Ten-player rows are 100 contiguous limbs, so a step never reads past the
/// 900-limb staging boundary.
fn share_verify_limb_count(num_players: u8, start_index: u16) -> Option<u8> {
    share_verify_limb_count_for_cards(num_players, start_index, /* poker deal */ 25)
}

/// Fold schedule for Arcis share-hash verify.
/// Contiguous games (`num_cards != 25`): 4-limb steps from offset 0.
/// Poker deal (`num_cards == 25`): the same rule inside each recipient-major
/// hole and community span.
fn share_verify_limb_count_for_cards(
    num_players: u8,
    start_index: u16,
    num_cards: u8,
) -> Option<u8> {
    if num_cards != 25 {
        let target = share_active_limb_count_for_cards(num_players, num_cards) as u16;
        if target == 0 {
            return None;
        }
        return fold_in_span(start_index, 0, target);
    }
    if !(2..=10).contains(&num_players) {
        return None;
    }
    let row = start_index / 100;
    let offset = start_index % 100;
    if row >= num_players.saturating_sub(1) as u16 {
        return None;
    }
    if num_players == 10 {
        return fold_in_span(offset, 0, 100);
    }
    let holes = (2 * num_players as u16) * 4;
    if let Some(n) = fold_in_span(offset, 0, holes) {
        return Some(n);
    }
    fold_in_span(offset, 80, 20)
}
/// Solana CPI realloc limit per instruction.
pub const MAX_CPI_ALLOC: usize = 10_240;
/// Initial create size (one CPI-alloc chunk; grown via `extend_deck_staging`).
pub const DECK_STAGING_INITIAL_SIZE: usize = MAX_CPI_ALLOC;

fn le_bytes_from_u128_halves(low: u128, high: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&low.to_le_bytes());
    out[16..].copy_from_slice(&high.to_le_bytes());
    out
}

fn u128_halves_from_le_bytes(bytes: &[u8; 32]) -> (u128, u128) {
    let mut low_b = [0u8; 16];
    let mut high_b = [0u8; 16];
    low_b.copy_from_slice(&bytes[..16]);
    high_b.copy_from_slice(&bytes[16..]);
    (u128::from_le_bytes(low_b), u128::from_le_bytes(high_b))
}

/// Groth16 `showdown_hash` is BE field encoding; Arcis expects LE u128 halves.
fn showdown_hash_le_u128_halves(be: &[u8; 32]) -> (u128, u128) {
    let mut le = [0u8; 32];
    for i in 0..32 {
        le[i] = be[31 - i];
    }
    u128_halves_from_le_bytes(&le)
}

fn seal_rows_revealed(rows: &[[u8; 32]; 4]) -> bool {
    rows.iter().any(|row| row.iter().any(|b| *b != 0))
}

/// Wrapping 256-bit add. Poseidon(4) group sums wrap modulo 2^256 across a deck.
fn add_u256_le(acc: &[u8; 32], contrib_low: u128, contrib_high: u128) -> [u8; 32] {
    let (a_low, a_high) = u128_halves_from_le_bytes(acc);
    let (sum_low, carry) = a_low.overflowing_add(contrib_low);
    let sum_high = a_high
        .wrapping_add(contrib_high)
        .wrapping_add(u128::from(carry));
    le_bytes_from_u128_halves(sum_low, sum_high)
}

const VERIFY_BITS_LEN: usize = 120; // 15 × u64 covers 960 bits (>900)

/// Fixed 10-player share layout: hole slots 0..19, board 20..24.
const BOARD_START_INDEX: u16 = 20;
const FLOP_END_INDEX: u16 = 22; // inclusive
const TURN_INDEX: u16 = 23;
const RIVER_INDEX: u16 = 24;
const DEAL_END_INDEX: u16 = 24; // inclusive; indices > 24 are undealt deck

/// True iff `card_index` is an in-play deal slot for `num_players`:
/// holes for seats `0..num_players-1` (indices `0..2*n-1`) plus board `20..=24`.
/// Empty-seat holes (`2*n..19`) and undealt deck (`>= 25`) are never in play.
fn card_index_in_play(card_index: u16, num_players: u8) -> bool {
    if !(2..=10).contains(&num_players) {
        return false;
    }
    if card_index <= DEAL_END_INDEX && card_index >= BOARD_START_INDEX {
        return true;
    }
    if card_index >= BOARD_START_INDEX {
        return false;
    }
    let player = (card_index / 2) as u8;
    player < num_players
        && (card_index == (player as u16) * 2 || card_index == (player as u16) * 2 + 1)
}

/// In-play poker deal indices in card-major order (holes then board 20..=24).
fn poker_in_play_card_indices(num_players: u8) -> Result<Vec<u16>> {
    require!((2..=10).contains(&num_players), ErrorCode::InvalidSeat);
    let mut out = Vec::with_capacity(num_players as usize * 2 + 5);
    for i in 0..(num_players as u16 * 2) {
        out.push(i);
    }
    for board in BOARD_START_INDEX..=DEAL_END_INDEX {
        out.push(board);
    }
    Ok(out)
}

/// Bitmask of in-play poker deal indices (bits 0..2n-1 and 20..=24).
fn poker_in_play_card_mask(num_players: u8) -> Result<u64> {
    let mut mask = 0u64;
    for card in poker_in_play_card_indices(num_players)? {
        mask |= 1u64 << card;
    }
    Ok(mask)
}

/// Folded hole cards stay mucked unless the player opted into show-on-fold.
fn hole_owner_revealable(player: u8, folded_mask: u16, show_on_fold_mask: u16) -> bool {
    let bit = 1u16 << player;
    if folded_mask & bit == 0 {
        return true;
    }
    show_on_fold_mask & bit != 0
}

fn deck_staging_pda(program_id: &Pubkey, game_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"deck_staging", &game_id[..]], program_id).0
}

fn require_reveal_deck_staging_account(
    program_id: &Pubkey,
    game_id: &[u8; 32],
    deck_staging: &Pubkey,
) -> Result<()> {
    require!(
        *deck_staging == deck_staging_pda(program_id, game_id),
        ErrorCode::InvalidCardIndex
    );
    Ok(())
}

/// Staging limb size (BN254 field element as 32 LE bytes).
const STAGING_LIMB_BYTES: usize = 32;
/// Max bytes per typed staging write (matches TS chunk size budget).
const MAX_STAGING_WRITE_BYTES: usize = 900;

/// Authorize typed staging writes and enforce post-verify write freezes.
///
/// - `player_index: Some(i)` → share_deck_staging: signer must be hand seat `i`;
///   writes freeze once `share_finalized` (verify/finalize complete).
/// - `player_index: None` → deck_staging: any seated player in the hand;
///   freezes once legacy deck-hash verify has started (`verify_started`) or
///   completed (`verified && verify_progress > 0`). Continuous-hand reveal
///   staging leaves `verify_progress == 0`, so those writes stay allowed after
///   share finalize.
/// `record_reveal` / `close_deck_staging` / `close_share_deck_staging` /
/// `sync_verify_deck_hash` signer must be the staging rent payer
/// (`game.staging_authority`).
fn require_staging_authority(authority: &Pubkey, game: &GameState) -> Result<()> {
    require!(
        *authority == game.staging_authority,
        ErrorCode::UnauthorizedStagingAuthority
    );
    Ok(())
}

fn require_share_staging_close_authorized(
    authority: &Pubkey,
    player_index: u8,
    table: &TableState,
    game: &GameState,
) -> Result<()> {
    require_canonical_game_table(table, game)?;
    require!(game.share_finalized, ErrorCode::InvalidVerifyProgress);
    let signer_index = player_index_for_pubkey(
        &table.seats,
        &table.hand_seat_order,
        table.hand_num_players,
        authority,
    )
    .ok_or(error!(ErrorCode::NotInHand))?;
    require!(signer_index == player_index, ErrorCode::InvalidAuthority);
    Ok(())
}

/// Copy accumulator → GameState with monotonic progress (no rewind / un-verify).
fn apply_sync_verify_deck_hash(
    game: &mut GameState,
    acc: &VerifyDeckHashAccumulator,
) -> Result<()> {
    require!(acc.game_id == game.game_id, ErrorCode::InvalidVerifyProgress);
    // Cannot rewind chunk progress.
    require!(
        acc.verify_progress >= game.verify_progress,
        ErrorCode::InvalidVerifyProgress
    );
    // Once GameState.verified is latched, refuse to clear it.
    if game.verified {
        require!(acc.verified, ErrorCode::InvalidVerifyProgress);
    }
    game.verify_hash_acc = acc.verify_hash_acc;
    game.verify_expected = acc.verify_expected;
    game.verify_progress = acc.verify_progress;
    game.verify_bits = acc.verify_bits;
    game.verified = acc.verified;
    game.verify_started = acc.verify_started;
    Ok(())
}

/// Close is only allowed once every scheduled sealed partial has been recorded.
fn require_reveals_complete(game: &GameState) -> Result<()> {
    require!(
        game.revealed_partials >= game.total_partials,
        ErrorCode::RevealsNotComplete
    );
    Ok(())
}

/// Progress units for `total_partials` / `revealed_partials`: one per sealed
/// partial (not BN254 limbs). A completed card credits `num_players - 1`.
fn partials_per_card(num_players: u8) -> u8 {
    num_players.saturating_sub(1)
}

/// Accrue reveal progress without exceeding `total_partials`.
fn apply_record_reveal_progress(revealed: u8, total: u8, count: u8) -> Result<u8> {
    require!(count > 0, ErrorCode::InvalidAmount);
    let next = revealed
        .checked_add(count)
        .ok_or(error!(ErrorCode::InvalidAmount))?;
    require!(next <= total, ErrorCode::InvalidAmount);
    Ok(next)
}

fn reveal_range_unfilled(filled_bits: u64, start: usize, count: usize) -> bool {
    let mask = ((1u64 << count) - 1) << start;
    filled_bits & mask == 0
}

fn reveal_prefix_complete(filled_bits: u64, count: u8) -> bool {
    if count == 0 || count > 36 {
        return false;
    }
    let expected = (1u64 << count) - 1;
    filled_bits == expected
}

fn require_canonical_game_table(table: &TableState, game: &GameState) -> Result<()> {
    require!(
        table.room_id == game.table_room_id && table.table_id == game.table_id,
        ErrorCode::InvalidGamePhase
    );
    Ok(())
}

fn showdown_coeff_count_for_table(table: &TableState) -> u8 {
    GameConfig::from_raw(table.game_kind, table.shoe_decks, table.roulette_variant)
        .map(|c| showdown_coeff_count(&c).min(SHOWDOWN_MAX_COEFFS))
        .unwrap_or(9)
}

fn require_revealed_card_close_authorized(
    authority: &Pubkey,
    table: &TableState,
    game: &GameState,
    revealed: &RevealedCard,
) -> Result<()> {
    require_canonical_game_table(table, game)?;
    require!(revealed.game_id == game.game_id, ErrorCode::InvalidGamePhase);
    require!(game.phase == 6, ErrorCode::InvalidGamePhase);
    require!(
        *authority == revealed.recipient_authority,
        ErrorCode::InvalidRevealRecipient
    );
    require!(
        reveal_prefix_complete(revealed.filled_bits, revealed.count),
        ErrorCode::InvalidVerifyProgress
    );
    Ok(())
}

fn require_staging_write_authorized(
    player_index: Option<u8>,
    authority: &Pubkey,
    table: &TableState,
    game: &GameState,
) -> Result<()> {
    require_canonical_game_table(table, game)?;
    require!(
        table.hand_in_progress
            && table.current_game_id == game.game_id
            && table.hand_num_players == game.num_players,
        ErrorCode::InvalidGamePhase
    );
    let signer_index = player_index_for_pubkey(
        &table.seats,
        &table.hand_seat_order,
        table.hand_num_players,
        authority,
    )
    .ok_or(error!(ErrorCode::NotInHand))?;

    match player_index {
        Some(i) => {
            // Share staging is only written during share verify, before finalize.
            require!(!game.share_finalized, ErrorCode::InvalidGamePhase);
            require!(i < game.num_players, ErrorCode::InvalidSeat);
            require!(signer_index == i, ErrorCode::InvalidAuthority);
        }
        None => {
            // Legacy deck-hash path latches verify_started / verify_progress on
            // GameState; refuse swaps after that point. Share-phase finalize sets
            // verified without touching verify_progress, so continuous reveal
            // staging into deck_staging remains allowed for seated writers.
            require!(!game.verify_started, ErrorCode::InvalidGamePhase);
            require!(
                !(game.verified && game.verify_progress > 0),
                ErrorCode::InvalidGamePhase
            );
        }
    }
    Ok(())
}

/// Copy limb-aligned bytes into a raw staging buffer (no Anchor header).
pub(crate) fn apply_staging_bytes_write(
    target_data: &mut [u8],
    offset: u32,
    data: &[u8],
) -> Result<()> {
    require!(!data.is_empty(), ErrorCode::InvalidAmount);
    require!(
        data.len() <= MAX_STAGING_WRITE_BYTES,
        ErrorCode::WriteExceedsBounds
    );
    require!(
        (offset as usize) % STAGING_LIMB_BYTES == 0,
        ErrorCode::StagingWriteMisaligned
    );
    require!(
        data.len() % STAGING_LIMB_BYTES == 0,
        ErrorCode::StagingWriteMisaligned
    );
    let start = offset as usize;
    let end = start
        .checked_add(data.len())
        .ok_or(ErrorCode::WriteExceedsBounds)?;
    require!(end <= target_data.len(), ErrorCode::WriteExceedsBounds);
    target_data[start..end].copy_from_slice(data);
    Ok(())
}

/// Betting phase: 0=none, 1=preflop, 2=flop, 3=turn, 4=river, 5=showdown.
/// Rejects unused/undealt indices, mucked folded holes, and street/recipient
/// timing violations.
fn require_card_reveal_allowed(
    card_index: u16,
    num_players: u8,
    betting_phase: u8,
    verified: bool,
    recipient_index: u8,
    folded_mask: u16,
    show_on_fold_mask: u16,
) -> Result<()> {
    require_card_reveal_allowed_with_cards(
        card_index,
        num_players,
        /* num_cards */ 25,
        betting_phase,
        verified,
        recipient_index,
        folded_mask,
        show_on_fold_mask,
        /* shared_cards */ 0,
    )
}

/// Reveal policy. `num_cards == 1` is the roulette wheel outcome: after share
/// verify, card 0 may be revealed to every seated recipient.
/// Contiguous casino deals (`num_cards` not 1 or 25): any seated recipient may
/// receive cards `0..limit` once share is verified. `shared_cards` (when > 0)
/// is the lazy-share prefix; otherwise the full `num_cards` window is allowed.
fn require_card_reveal_allowed_with_cards(
    card_index: u16,
    num_players: u8,
    num_cards: u8,
    betting_phase: u8,
    verified: bool,
    recipient_index: u8,
    folded_mask: u16,
    show_on_fold_mask: u16,
    shared_cards: u16,
) -> Result<()> {
    require!(verified, ErrorCode::CardRevealNotAllowed);
    let seat_cap = shared_zk_ids::max_players_for_reveal_cards(num_cards);
    require!(
        num_players >= 2 && num_players <= seat_cap,
        ErrorCode::CardRevealNotAllowed
    );
    if num_cards == 1 {
        require!(recipient_index < num_players, ErrorCode::InvalidRevealRecipient);
        require!(card_index == 0, ErrorCode::CardIndexNotInPlay);
        return Ok(());
    }
    if num_cards != 25 {
        require!(recipient_index < num_players, ErrorCode::InvalidRevealRecipient);
        let limit = if shared_cards > 0 {
            shared_cards.min(num_cards as u16)
        } else {
            num_cards as u16
        };
        require!(card_index < limit, ErrorCode::CardIndexNotInPlay);
        return Ok(());
    }
    require!(recipient_index < num_players, ErrorCode::InvalidRevealRecipient);
    require!(
        card_index_in_play(card_index, num_players),
        ErrorCode::CardIndexNotInPlay
    );

    if card_index < BOARD_START_INDEX {
        let player = (card_index / 2) as u8;
        require!(
            hole_owner_revealable(player, folded_mask, show_on_fold_mask),
            ErrorCode::HoleCardsMucked
        );
        // Hole sealed partials only after preflop betting has started.
        require!(betting_phase >= 1, ErrorCode::CardRevealNotAllowed);
        // Before showdown: own holes only. Show-on-fold only opts out of mucking;
        // it does not let opponents decrypt the owner's holes while betting is live.
        require!(
            betting_phase >= 5 || player == recipient_index,
            ErrorCode::CardRevealNotAllowed
        );
        return Ok(());
    }

    if card_index >= BOARD_START_INDEX && card_index <= FLOP_END_INDEX {
        require!(betting_phase >= 2, ErrorCode::CardRevealNotAllowed);
        return Ok(());
    }
    if card_index == TURN_INDEX {
        require!(betting_phase >= 3, ErrorCode::CardRevealNotAllowed);
        return Ok(());
    }
    if card_index == RIVER_INDEX {
        require!(betting_phase >= 4, ErrorCode::CardRevealNotAllowed);
        return Ok(());
    }

    // Unreachable when `card_index_in_play` holds; keep exhaustive.
    err!(ErrorCode::CardIndexNotInPlay)
}

#[cfg(test)]
mod share_verify_limb_count_tests {
    use super::*;

    #[test]
    fn two_player_chunks_match_typescript_schedule() {
        assert_eq!(share_verify_limb_count(2, 0), Some(4));
        assert_eq!(share_verify_limb_count(2, 12), Some(4));
        assert_eq!(share_verify_limb_count(2, 16), None);
        assert_eq!(share_verify_limb_count(2, 80), Some(4));
        assert_eq!(share_verify_limb_count(2, 84), Some(4));
        assert_eq!(share_verify_limb_count(2, 96), Some(4));
        assert_eq!(share_verify_limb_count(2, 36), None);
    }

    #[test]
    fn ten_player_folds_across_each_row() {
        assert_eq!(share_verify_limb_count(10, 0), Some(4));
        assert_eq!(share_verify_limb_count(10, 4), Some(4));
        assert_eq!(share_verify_limb_count(10, 32), Some(4));
        assert_eq!(share_verify_limb_count(10, 36), Some(4));
        assert_eq!(share_verify_limb_count(10, 96), Some(4));
        assert_eq!(share_verify_limb_count(10, 100), Some(4));
        assert_eq!(share_verify_limb_count(10, 896), Some(4));
        assert_eq!(share_verify_limb_count(10, 900), None);
    }

    #[test]
    fn contiguous_games_step_by_four() {
        // Keno 2p: 20 cards × 4 = 80 limbs.
        assert_eq!(share_verify_limb_count_for_cards(2, 0, 20), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 64, 20), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 76, 20), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 80, 20), None);
        // Blackjack chunk: 16 cards × 4 = 64 limbs.
        assert_eq!(share_verify_limb_count_for_cards(2, 48, 16), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 60, 16), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 64, 16), None);
        // Baccarat: 6 cards × 4 = 24 limbs.
        assert_eq!(share_verify_limb_count_for_cards(2, 0, 6), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 16, 6), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 20, 6), Some(4));
        assert_eq!(share_verify_limb_count_for_cards(2, 24, 6), None);
        // Roulette stays a single 4-limb job.
        assert_eq!(share_verify_limb_count_for_cards(2, 0, 1), Some(4));
    }

    #[test]
    fn two_player_bits_exact_accepts_sparse_schedule() {
        let mut bits = [0u64; 15];
        // start0 → 16 hole limbs, start80 → 20 community limbs.
        for i in 0..16u16 {
            verify_bit_set(&mut bits, i);
        }
        for i in 80..100u16 {
            verify_bit_set(&mut bits, i);
        }
        assert!(share_verify_bits_exact(&bits, 2, 25, 36));
        // Contiguous-prefix shape must NOT pass for sparse poker layout.
        let mut prefix = [0u64; 15];
        for i in 0..36u16 {
            verify_bit_set(&mut prefix, i);
        }
        assert!(!share_verify_bits_exact(&prefix, 2, 25, 36));
    }

    #[test]
    fn contiguous_roulette_bits_exact() {
        let mut bits = [0u64; 15];
        // 2p roulette: (2-1)*4 = 4 limbs at offset 0.
        for i in 0..4u16 {
            verify_bit_set(&mut bits, i);
        }
        assert!(share_verify_bits_exact(&bits, 2, 1, 4));
        assert!(!share_verify_bits_exact(&bits, 2, 1, 5));
    }
}

#[cfg(test)]
mod reveal_policy_tests {
    use super::*;

    #[test]
    fn betting_round_authority_matches_build_mode() {
        #[cfg(feature = "testing")]
        assert!(is_betting_round_authority(&Pubkey::new_unique()));
        #[cfg(not(feature = "testing"))]
        {
            assert!(is_betting_round_authority(&whitelist::WHITELIST_ADMIN));
            assert!(!is_betting_round_authority(&Pubkey::new_unique()));
        }
    }

    #[test]
    fn preflop_opens_only_from_fresh_hand() {
        assert!(is_legal_betting_phase_transition(0, 1));
        assert!(!is_legal_betting_phase_transition(0, 2));
        assert!(!is_legal_betting_phase_transition(0, 5));
        let mut game = GameState {
            num_players: 2,
            betting_phase: 0,
            ..Default::default()
        };
        assert!(apply_open_preflop(&mut game).is_ok());
        assert_eq!(game.betting_phase, 1);
        assert!(apply_open_preflop(&mut game).is_err());
    }

    #[test]
    fn manual_street_advances_are_rejected() {
        assert!(!is_legal_betting_phase_transition(1, 2));
        assert!(!is_legal_betting_phase_transition(2, 3));
        assert!(!is_legal_betting_phase_transition(3, 4));
        assert!(!is_legal_betting_phase_transition(4, 5));
    }

    #[test]
    fn manual_street_retries_are_idempotent() {
        assert!(is_legal_betting_phase_transition(1, 1));
        assert!(is_legal_betting_phase_transition(2, 2));
        assert!(is_legal_betting_phase_transition(4, 4));
        assert!(is_legal_betting_phase_transition(5, 5));
    }

    #[test]
    fn skipping_streets_is_rejected() {
        assert!(!is_legal_betting_phase_transition(1, 5));
        assert!(!is_legal_betting_phase_transition(1, 4));
        assert!(!is_legal_betting_phase_transition(2, 4));
        assert!(!is_legal_betting_phase_transition(3, 5));
    }

    #[test]
    fn regressing_streets_is_rejected() {
        assert!(!is_legal_betting_phase_transition(4, 2));
        assert!(!is_legal_betting_phase_transition(5, 1));
        assert!(!is_legal_betting_phase_transition(2, 1));
    }

    #[test]
    fn out_of_range_target_is_rejected() {
        assert!(!is_legal_betting_phase_transition(1, 0));
        assert!(!is_legal_betting_phase_transition(4, 6));
    }

    #[test]
    fn typed_staging_write_pda_seeds_are_distinct() {
        // Typed writers bind these seeds in Anchor constraints (no generic target).
        let game_id = [7u8; 32];
        let deck =
            Pubkey::find_program_address(&[b"deck_staging", &game_id[..]], &crate::id()).0;
        let share0 = Pubkey::find_program_address(
            &[b"share_deck_staging", &game_id[..], &[0u8]],
            &crate::id(),
        )
        .0;
        let share1 = Pubkey::find_program_address(
            &[b"share_deck_staging", &game_id[..], &[1u8]],
            &crate::id(),
        )
        .0;
        assert_ne!(deck, share0);
        assert_ne!(share0, share1);
        let game_state =
            Pubkey::find_program_address(&[b"game_state", &game_id[..]], &crate::id()).0;
        assert_ne!(game_state, deck);
        assert_ne!(game_state, share0);
    }

    #[test]
    fn apply_staging_bytes_write_requires_limb_alignment() {
        let mut buf = vec![0u8; 128];
        let limb = [1u8; 32];
        assert!(apply_staging_bytes_write(&mut buf, 0, &limb).is_ok());
        assert_eq!(&buf[..32], &limb);
        // Misaligned offset / length rejected.
        assert!(apply_staging_bytes_write(&mut buf, 1, &limb).is_err());
        assert!(apply_staging_bytes_write(&mut buf, 0, &[1u8; 31]).is_err());
        // Oversized chunk rejected.
        assert!(apply_staging_bytes_write(&mut buf, 0, &[2u8; 928]).is_err());
        // Empty rejected.
        assert!(apply_staging_bytes_write(&mut buf, 0, &[]).is_err());
    }

    fn staging_auth_fixture() -> (TableState, GameState, Pubkey, Pubkey) {
        let p0 = Pubkey::new_unique();
        let p1 = Pubkey::new_unique();
        let game_id = [9u8; 32];
        let mut table = TableState::init([1u8; 32], 0, GameKind::Poker as u8, 1, 0);
        table.seats[0] = p0;
        table.seats[1] = p1;
        table.hand_in_progress = true;
        table.current_game_id = game_id;
        table.hand_seat_order = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        table.hand_num_players = 2;
        let mut game = GameState::default();
        game.game_id = game_id;
        game.table_room_id = table.room_id;
        game.table_id = table.table_id;
        game.num_players = 2;
        (table, game, p0, p1)
    }

    #[test]
    fn staging_write_auth_requires_seated_share_owner() {
        let (table, game, p0, p1) = staging_auth_fixture();
        assert!(require_staging_write_authorized(Some(0), &p0, &table, &game).is_ok());
        assert!(require_staging_write_authorized(Some(0), &p1, &table, &game).is_err());
        assert!(require_staging_write_authorized(Some(1), &p1, &table, &game).is_ok());
        assert!(require_staging_write_authorized(None, &p0, &table, &game).is_ok());
        assert!(require_staging_write_authorized(None, &Pubkey::new_unique(), &table, &game).is_err());
    }

    #[test]
    fn staging_write_auth_freezes_after_share_finalize_or_deck_verify() {
        let (table, mut game, p0, _) = staging_auth_fixture();
        game.share_finalized = true;
        assert!(require_staging_write_authorized(Some(0), &p0, &table, &game).is_err());
        // Continuous reveal staging: verified after share finalize, verify_progress=0.
        game.share_finalized = true;
        game.verified = true;
        game.verify_progress = 0;
        game.verify_started = false;
        assert!(require_staging_write_authorized(None, &p0, &table, &game).is_ok());
        // Legacy deck-hash verify started → freeze global staging.
        game.verified = false;
        game.verify_started = true;
        assert!(require_staging_write_authorized(None, &p0, &table, &game).is_err());
        // Legacy deck-hash verify completed → freeze.
        game.verify_started = false;
        game.verified = true;
        game.verify_progress = 72;
        assert!(require_staging_write_authorized(None, &p0, &table, &game).is_err());
    }

    #[test]
    fn staging_authority_rejects_outsider() {
        let authority = Pubkey::new_unique();
        let outsider = Pubkey::new_unique();
        let state = GameState {
            staging_authority: authority,
            total_partials: 4,
            revealed_partials: 0,
            ..Default::default()
        };
        assert!(require_staging_authority(&authority, &state).is_ok());
        assert!(require_staging_authority(&outsider, &state).is_err());
    }

    #[test]
    fn close_share_deck_staging_rejects_outsider_and_unfinalized() {
        let (table, mut state, authority, outsider) = staging_auth_fixture();
        assert!(require_share_staging_close_authorized(
            &authority,
            0,
            &table,
            &state,
        )
        .is_err());
        state.share_finalized = true;
        assert!(require_share_staging_close_authorized(
            &authority,
            0,
            &table,
            &state,
        )
        .is_ok());
        assert!(require_share_staging_close_authorized(
            &outsider,
            0,
            &table,
            &state,
        )
        .is_err());
    }

    #[test]
    fn sync_verify_rejects_progress_rewind_and_unverify() {
        let game_id = [3u8; 32];
        let mut game = GameState {
            game_id,
            verify_progress: 10,
            verified: true,
            verify_started: true,
            ..Default::default()
        };
        let mut acc = VerifyDeckHashAccumulator {
            game_id,
            verify_progress: 5, // rewind
            verified: true,
            verify_started: true,
            ..Default::default()
        };
        assert!(apply_sync_verify_deck_hash(&mut game, &acc).is_err());

        acc.verify_progress = 10;
        acc.verified = false; // un-verify
        assert!(apply_sync_verify_deck_hash(&mut game, &acc).is_err());

        acc.verified = true;
        acc.verify_progress = 12;
        assert!(apply_sync_verify_deck_hash(&mut game, &acc).is_ok());
        assert_eq!(game.verify_progress, 12);
        assert!(game.verified);
    }

    #[test]
    fn sync_verify_allows_first_latch_from_zero() {
        let game_id = [4u8; 32];
        let mut game = GameState {
            game_id,
            verify_progress: 0,
            verified: false,
            ..Default::default()
        };
        let acc = VerifyDeckHashAccumulator {
            game_id,
            verify_progress: 1,
            verified: false,
            verify_started: true,
            ..Default::default()
        };
        assert!(apply_sync_verify_deck_hash(&mut game, &acc).is_ok());
        assert_eq!(game.verify_progress, 1);
        assert!(game.verify_started);
    }

    #[test]
    fn close_deck_staging_requires_all_partials_recorded() {
        let mut state = GameState {
            staging_authority: Pubkey::new_unique(),
            total_partials: 4,
            revealed_partials: 0,
            ..Default::default()
        };
        assert!(require_reveals_complete(&state).is_err());
        state.revealed_partials = 3;
        assert!(require_reveals_complete(&state).is_err());
        state.revealed_partials = 4;
        assert!(require_reveals_complete(&state).is_ok());
        state.revealed_partials = 5;
        assert!(require_reveals_complete(&state).is_ok());
    }

    #[test]
    fn reveal_progress_uses_partial_units_not_limbs() {
        // 2p: 1 partial/card (not 4 limbs). 10p: 9 partials/card (not 36 limbs).
        assert_eq!(partials_per_card(2), 1);
        assert_eq!(partials_per_card(10), 9);
        // Seven completed 2p cards credit 7 — still below total_partials=25.
        let mut revealed = 0u8;
        let total = 25u8;
        for _ in 0..7 {
            revealed = apply_record_reveal_progress(revealed, total, partials_per_card(2)).unwrap();
        }
        assert_eq!(revealed, 7);
        assert!(revealed < total);
        // Old bug: 7 * 4 limbs = 28 >= 25 would unlock close early.
        assert!(7 * 4 >= 25);
        assert!(require_reveals_complete(&GameState {
            total_partials: total,
            revealed_partials: revealed,
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn record_reveal_cannot_exceed_total_partials() {
        assert!(apply_record_reveal_progress(0, 4, 0).is_err());
        assert!(apply_record_reveal_progress(3, 4, 2).is_err());
        assert_eq!(apply_record_reveal_progress(3, 4, 1).unwrap(), 4);
    }

    #[test]
    fn duplicate_reveal_range_does_not_fake_prefix_coverage() {
        assert!(!reveal_prefix_complete(0, 4));
        assert!(!reveal_prefix_complete(0b1100, 4));
        assert!(reveal_prefix_complete(0b1111, 4));
        assert!(!reveal_prefix_complete(0b1_1111, 4));
    }

    /// Default masks: nobody folded / nobody showed.
    fn allow(
        card_index: u16,
        num_players: u8,
        betting_phase: u8,
        verified: bool,
        recipient_index: u8,
    ) -> Result<()> {
        require_card_reveal_allowed(
            card_index,
            num_players,
            betting_phase,
            verified,
            recipient_index,
            0,
            0,
        )
    }

    #[test]
    fn own_holes_only_before_showdown() {
        assert!(allow(0, 2, 1, true, 0).is_ok());
        assert!(allow(2, 2, 1, true, 1).is_ok());
        assert!(allow(2, 2, 1, true, 0).is_err());
        assert!(allow(0, 2, 4, true, 1).is_err());
        assert!(allow(2, 2, 5, true, 0).is_ok());
    }

    #[test]
    fn board_cards_follow_street_gates() {
        assert!(allow(20, 2, 1, true, 0).is_err());
        assert!(allow(20, 2, 2, true, 0).is_ok());
        assert!(allow(23, 2, 2, true, 0).is_err());
        assert!(allow(23, 2, 3, true, 0).is_ok());
        assert!(allow(24, 2, 3, true, 0).is_err());
        assert!(allow(24, 2, 4, true, 0).is_ok());
    }

    #[test]
    fn unused_empty_seat_holes_never_in_play() {
        // 2p: seats 0–1 use 0–3; empty-seat holes 4–19 must not reveal.
        for idx in 4u16..20 {
            assert!(!card_index_in_play(idx, 2), "2p hole {idx}");
            assert!(allow(idx, 2, 5, true, 0).is_err());
        }
        // 3p unlocks seat-2 holes 4–5 only.
        assert!(card_index_in_play(4, 3));
        assert!(card_index_in_play(5, 3));
        assert!(!card_index_in_play(6, 3));
        assert!(allow(4, 3, 1, true, 2).is_ok());
        assert!(allow(6, 3, 5, true, 0).is_err());
    }

    #[test]
    fn undealt_deck_indices_never_in_play() {
        for idx in [25u16, 26, 51, 899] {
            assert!(!card_index_in_play(idx, 10));
            assert!(allow(idx, 10, 5, true, 0).is_err());
        }
        assert!(card_index_in_play(24, 10));
        assert!(card_index_in_play(0, 10));
        assert!(card_index_in_play(18, 10));
        assert!(card_index_in_play(19, 10));
    }

    #[test]
    fn folded_holes_muck_by_default_at_showdown() {
        // Player 1 folded without show → holes 2–3 blocked for everyone.
        let folded = 1u16 << 1;
        assert!(require_card_reveal_allowed(2, 2, 5, true, 0, folded, 0).is_err());
        assert!(require_card_reveal_allowed(3, 2, 5, true, 1, folded, 0).is_err());
        // Non-folded player 0 holes still ok.
        assert!(require_card_reveal_allowed(0, 2, 5, true, 1, folded, 0).is_ok());
        assert!(require_card_reveal_allowed(1, 2, 5, true, 0, folded, 0).is_ok());
    }

    #[test]
    fn show_on_fold_allows_cross_recipient_only_at_showdown() {
        let folded = 1u16 << 1;
        let shown = 1u16 << 1;
        assert!(require_card_reveal_allowed(2, 2, 5, true, 0, folded, shown).is_ok());
        assert!(require_card_reveal_allowed(3, 2, 2, true, 0, folded, shown).is_err());
        assert!(require_card_reveal_allowed(3, 2, 2, true, 1, folded, shown).is_ok());
        assert!(require_card_reveal_allowed(2, 2, 5, true, 0, folded, 0).is_err());
    }

    #[test]
    fn streets_past_the_open_one_cannot_be_revealed() {
        // Preflop is still the open street: no board.
        assert!(require_card_reveal_allowed(20, 2, 1, true, 0, 0, 0).is_err());
        assert!(require_card_reveal_allowed(23, 2, 1, true, 0, 0, 0).is_err());
        assert!(require_card_reveal_allowed(24, 2, 1, true, 0, 0, 0).is_err());
        // Flop was dealt. Turn and river were not.
        assert!(require_card_reveal_allowed(22, 2, 2, true, 0, 0, 0).is_ok());
        assert!(require_card_reveal_allowed(23, 2, 2, true, 0, 0, 0).is_err());
        assert!(require_card_reveal_allowed(24, 2, 3, true, 0, 0, 0).is_err());
        // River betting and showdown have already dealt the river.
        assert!(require_card_reveal_allowed(24, 2, 4, true, 0, 0, 0).is_ok());
        assert!(require_card_reveal_allowed(24, 2, 5, true, 0, 0, 0).is_ok());
    }

    #[test]
    fn reveal_deck_account_must_be_game_staging_pda() {
        let program_id = crate::ID;
        let game_id = [9u8; 32];
        let expected = deck_staging_pda(&program_id, &game_id);
        assert!(require_reveal_deck_staging_account(&program_id, &game_id, &expected).is_ok());
        assert!(require_reveal_deck_staging_account(&program_id, &game_id, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn showdown_hash_be_to_le_halves_roundtrip() {
        // BE encoding of 9 << 128 (high limb = 9, low = 0)
        let mut be = [0u8; 32];
        be[15] = 9; // byte index for 2^128 in BE32: bit 128 is at byte 15 from MSB… 
        // value = 9 * 2^128 → LE: low=0, high=9 → LE bytes[16]=9
        // BE: reverse → be[15]=9
        let (low, high) = showdown_hash_le_u128_halves(&be);
        assert_eq!(low, 0);
        assert_eq!(high, 9);
    }

    #[test]
    fn muck_blocks_own_hole_re_reveal_after_fold() {
        let folded = 1u16 << 0;
        assert!(require_card_reveal_allowed(0, 2, 1, true, 0, folded, 0).is_err());
        assert!(require_card_reveal_allowed(0, 2, 1, true, 0, folded, 1u16 << 0).is_ok());
    }

    /// Adversarial: sealed partials must not leak for any card that is not yet
    /// street-legal, for any seated recipient. Exhaustive over 2p deal slots.
    #[test]
    fn adversarial_early_partials_rejected_for_every_recipient() {
        const N: u8 = 2;
        let deal: &[u16] = &[0, 1, 2, 3, 20, 21, 22, 23, 24];
        // (phase, card) pairs that MUST fail for every recipient before their street.
        let early: &[(u8, u16)] = &[
            // Unverified / pre-betting: everything blocked.
            // Handled below with verified=false and phase=0.
            // Preflop: board is early.
            (1, 20),
            (1, 21),
            (1, 22),
            (1, 23),
            (1, 24),
            // Flop: turn + river early.
            (2, 23),
            (2, 24),
            // Turn: river early.
            (3, 24),
        ];

        // Unverified: no partials, period.
        for &card in deal {
            for recip in 0..N {
                assert!(
                    require_card_reveal_allowed(card, N, 5, false, recip, 0, 0).is_err(),
                    "unverified card={card} recip={recip}"
                );
            }
        }

        // Phase 0 (verified, betting not open): no holes, no board.
        for &card in deal {
            for recip in 0..N {
                assert!(
                    require_card_reveal_allowed(card, N, 0, true, recip, 0, 0).is_err(),
                    "phase0 card={card} recip={recip}"
                );
            }
        }

        for &(phase, card) in early {
            for recip in 0..N {
                assert!(
                    require_card_reveal_allowed(card, N, phase, true, recip, 0, 0).is_err(),
                    "early board/future street phase={phase} card={card} recip={recip}"
                );
            }
        }

        // Opponent hole partials before showdown — every street 1..=4.
        for phase in 1u8..=4 {
            for recip in 0..N {
                let opponent = 1 - recip;
                for hole_off in 0u16..2 {
                    let card = (opponent as u16) * 2 + hole_off;
                    assert!(
                        require_card_reveal_allowed(card, N, phase, true, recip, 0, 0).is_err(),
                        "opponent hole early phase={phase} card={card} recip={recip}"
                    );
                }
            }
        }
    }

    /// Adversarial: show-on-fold must not unlock opponent hole partials early.
    #[test]
    fn adversarial_show_on_fold_cannot_peek_before_showdown() {
        let folded = 1u16 << 1;
        let shown = 1u16 << 1;
        for phase in 1u8..=4 {
            // Recipient 0 must not receive player-1 hole partials before showdown,
            // even when player 1 opted into show-on-fold.
            assert!(
                require_card_reveal_allowed(2, 2, phase, true, 0, folded, shown).is_err(),
                "show-on-fold peek phase={phase}"
            );
            assert!(
                require_card_reveal_allowed(3, 2, phase, true, 0, folded, shown).is_err(),
                "show-on-fold peek phase={phase} card3"
            );
            // Owner may still get their own sealed partials on a live street.
            assert!(
                require_card_reveal_allowed(2, 2, phase, true, 1, folded, shown).is_ok(),
                "owner hole still ok phase={phase}"
            );
        }
        // Only at showdown may the opponent decrypt show-on-fold holes.
        assert!(require_card_reveal_allowed(2, 2, 5, true, 0, folded, shown).is_ok());
        assert!(require_card_reveal_allowed(3, 2, 5, true, 0, folded, shown).is_ok());
    }

    /// Adversarial 10-player: every other seat's holes stay sealed until showdown;
    /// future board streets stay sealed on earlier phases.
    #[test]
    fn adversarial_ten_player_early_partial_matrix() {
        const N: u8 = 10;
        for phase in 1u8..=4 {
            for recip in 0..N {
                for owner in 0..N {
                    if owner == recip {
                        continue;
                    }
                    for hole_off in 0u16..2 {
                        let card = (owner as u16) * 2 + hole_off;
                        assert!(
                            require_card_reveal_allowed(card, N, phase, true, recip, 0, 0)
                                .is_err(),
                            "10p opponent hole phase={phase} owner={owner} recip={recip} card={card}"
                        );
                    }
                }
                // Own holes allowed once preflop is open.
                assert!(
                    require_card_reveal_allowed((recip as u16) * 2, N, phase, true, recip, 0, 0)
                        .is_ok()
                );
            }
        }

        // Street gates for every recipient (board is public, but still phase-gated).
        for recip in 0..N {
            assert!(require_card_reveal_allowed(20, N, 1, true, recip, 0, 0).is_err());
            assert!(require_card_reveal_allowed(22, N, 1, true, recip, 0, 0).is_err());
            assert!(require_card_reveal_allowed(23, N, 2, true, recip, 0, 0).is_err());
            assert!(require_card_reveal_allowed(24, N, 3, true, recip, 0, 0).is_err());
            assert!(require_card_reveal_allowed(20, N, 2, true, recip, 0, 0).is_ok());
            assert!(require_card_reveal_allowed(23, N, 3, true, recip, 0, 0).is_ok());
            assert!(require_card_reveal_allowed(24, N, 4, true, recip, 0, 0).is_ok());
        }
    }
}

fn verify_bit_get(bits: &[u64; 15], index: u16) -> bool {
    let i = index as usize;
    (bits[i / 64] & (1u64 << (i % 64))) != 0
}

/// A share verifier is complete only when every scheduled chunk's limbs are set
/// and no callback has written outside that schedule.
///
/// Poker deals (`share_cards == 25`, `n < 10`) use a **sparse** recipient-major
/// layout (e.g. 2p: bits `{0..15, 80..99}` for target 36). Contiguous-prefix
/// checks reject the final community chunk and leave Arcis callbacks stuck
/// retrying with `InvalidVerifyProgress`.
fn share_verify_bits_exact(
    bits: &[u64; 15],
    num_players: u8,
    share_cards: u8,
    target: u16,
) -> bool {
    let expected_target = share_active_limb_count_for_cards(num_players, share_cards) as u16;
    if target == 0 || target != expected_target || target > 900 {
        return false;
    }
    let mut expected = [false; 900];
    let mut covered = 0u16;
    for start in 0..900u16 {
        let Some(limb_count) =
            share_verify_limb_count_for_cards(num_players, start, share_cards)
        else {
            continue;
        };
        for j in 0..limb_count as u16 {
            let idx = match start.checked_add(j) {
                Some(v) if v < 900 => v as usize,
                _ => return false,
            };
            if expected[idx] {
                return false; // overlapping schedule entries
            }
            expected[idx] = true;
            covered = match covered.checked_add(1) {
                Some(v) => v,
                None => return false,
            };
        }
    }
    if covered != target {
        return false;
    }
    for index in 0..900u16 {
        if verify_bit_get(bits, index) != expected[index as usize] {
            return false;
        }
    }
    true
}

fn verify_bit_set(bits: &mut [u64; 15], index: u16) {
    let i = index as usize;
    bits[i / 64] |= 1u64 << (i % 64);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProofReceiptData {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub phase: u8,
    pub player_index: u8,
    pub circuit_version: u16,
    pub output_hash: [u8; 32],
    pub status: u8,
}

/// Share-receipt tail written by light-casino after the fixed proof body.
/// `5`, `13`, and `16` are the published bingo, poker, and blackjack hashes.
fn published_share_tier_count(data: &[u8]) -> Result<u8> {
    const PREFIX: usize = 85;
    if data.len() < PREFIX + 1 {
        return Ok(0);
    }
    let n = data[PREFIX];
    if n == 0 {
        return Ok(0);
    }
    require!(
        matches!(n, 4 | 5 | 13 | 16) && data.len() >= PREFIX + 1 + (n as usize) * 32,
        ErrorCode::InvalidProofReceipt
    );
    Ok(n)
}

fn read_proof_receipt(info: &AccountInfo) -> Result<ProofReceiptData> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidProofReceipt);
    let mut payload = &data[8..];
    ProofReceiptData::deserialize(&mut payload).map_err(|_| error!(ErrorCode::InvalidProofReceipt))
}

fn light_casino_id() -> Pubkey {
    use std::str::FromStr;
    Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).expect("valid light-casino program id")
}

/// The only signer allowed into casino settlement is light-casino's `cpi_authority` PDA.
fn assert_cpi_authority(authority: &AccountInfo) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], &light_casino_id());
    require_keys_eq!(*authority.key, expected, ErrorCode::UnauthorizedCpiCaller);
    require!(authority.is_signer, ErrorCode::UnauthorizedCpiCaller);
    Ok(())
}

/// Receipt must be owned by light-casino, match V2 canonical seeds, and be verified.
fn validate_light_casino_receipt(
    info: &AccountInfo,
    game_id: &[u8; 32],
    expected_generation: u64,
    expected_phase: u8,
    expected_player_index: u8,
    expected_circuit_version: u16,
) -> Result<()> {
    let light_id = light_casino_id();
    require_keys_eq!(*info.owner, light_id, ErrorCode::InvalidProofReceipt);
    let (expected_key, _) = Pubkey::find_program_address(
        &[
            PROOF_RECEIPT_V2_SEED,
            game_id.as_ref(),
            &expected_generation.to_le_bytes(),
            &[expected_phase],
            &[expected_player_index],
        ],
        &light_id,
    );
    require_keys_eq!(*info.key, expected_key, ErrorCode::InvalidProofReceipt);
    let receipt = read_proof_receipt(info)?;
    require!(
        receipt.status == RECEIPT_STATUS_VERIFIED,
        ErrorCode::ProofReceiptAlreadyConsumed
    );
    require!(receipt.generation == expected_generation, ErrorCode::InvalidProofReceipt);
    require!(
        receipt.circuit_version == expected_circuit_version,
        ErrorCode::InvalidProofReceipt
    );
    require!(
        expected_circuit_version == CIRCUIT_VERSION_V2,
        ErrorCode::InvalidProofReceipt
    );
    require!(receipt.phase == expected_phase, ErrorCode::InvalidProofReceipt);
    require!(
        receipt.player_index == expected_player_index,
        ErrorCode::InvalidProofReceipt
    );
    Ok(())
}

fn advance_after_receipt(game_state: &mut GameState, phase: u8) -> Result<()> {
    match phase {
        // Legacy sequential path — prefer `mark_register_receipt` for parallel register.
        PROOF_PHASE_REGISTER => {
            game_state.current_player = game_state.current_player.saturating_add(1);
            if game_state.current_player == game_state.num_players {
                game_state.phase = PROOF_PHASE_SHUFFLE;
                game_state.current_player = 0;
                game_state.shared_mask = 0;
            }
        }
        _ => return Err(error!(ErrorCode::InvalidProofReceipt)),
    }
    Ok(())
}

/// Parallel register: reuse `shared_mask` as registered-bitmap until Shuffle, then clear.
fn mark_register_receipt(game_state: &mut GameState, player_index: u8) -> Result<()> {
    require!(
        game_state.phase == PROOF_PHASE_REGISTER,
        ErrorCode::InvalidGamePhase
    );
    require!(
        player_index < game_state.num_players,
        ErrorCode::InvalidGamePhase
    );
    let bit = 1u16 << player_index;
    require!(game_state.shared_mask & bit == 0, ErrorCode::PlayerAlreadyRegistered);
    game_state.shared_mask |= bit;
    if game_state.shared_mask.count_ones() as u8 == game_state.num_players {
        game_state.phase = PROOF_PHASE_SHUFFLE;
        game_state.current_player = 0;
        game_state.shared_mask = 0;
    }
    Ok(())
}

fn mark_share_receipt(game_state: &mut GameState, player_index: u8) -> Result<()> {
    let bit = 1u16 << player_index;
    require!(game_state.shared_mask & bit == 0, ErrorCode::AlreadyShared);
    game_state.shared_mask |= bit;
    if game_state.shared_mask.count_ones() as u8 == game_state.num_players {
        game_state.phase = 3; // Evaluation
        game_state.current_player = 0;
    }
    Ok(())
}

fn mark_showdown_receipt(
    game_state: &mut GameState,
    player_index: u8,
    output_hash: [u8; 32],
) -> Result<()> {
    // Any non-folded seated player may submit. One proof completes showdown and
    // binds settlement to that player's SealedShowdownCoefficients PDA.
    require!(
        player_index < game_state.num_players,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.phase == 3 || game_state.phase == 5, // Evaluation or showdown reveal
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.showdown_hash == [0u8; 32],
        ErrorCode::InvalidProof
    );
    require!(
        game_state.folded_mask & (1u16 << player_index) == 0,
        ErrorCode::InvalidProof
    );
    game_state.showdown_hash = output_hash;
    game_state.showdown_finalized = true;
    // Bind settlement to the sealed coefficients of the player who proved the
    // showdown hash. `compute_pots` / `distribute_and_settle` load the
    // `SealedShowdownCoefficients` PDA seeded by this index.
    game_state.showdown_hash_player = player_index;
    game_state.phase = 5; // Showdown
    open_next_hand_on_showdown(game_state);
    // A verified showdown receipt is the sole transition into settlement.
    game_state.settlement_status = SETTLEMENT_PROOF_ACCEPTED;
    Ok(())
}

/// Start one uniquely identified all-seat MPC settlement.  The computation
/// offset and generation are both checked by the callback so a result arriving
/// after a refund can never settle the next generation.
fn begin_all_seat_settlement(
    game_state: &mut GameState,
    computation: u64,
    current_slot: u64,
) -> Result<()> {
    require!(
        game_state.settlement_status == SETTLEMENT_PROOF_ACCEPTED,
        ErrorCode::InvalidSettlementState
    );
    game_state.settlement_generation = game_state
        .settlement_generation
        .checked_add(1)
        .ok_or(error!(ErrorCode::InvalidSettlementState))?;
    game_state.settlement_computation = computation;
    game_state.settlement_started_slot = current_slot;
    game_state.settlement_expiry_slot = current_slot
        .checked_add(SETTLEMENT_TIMEOUT_SLOTS)
        .ok_or(error!(ErrorCode::InvalidSettlementState))?;
    game_state.settlement_status = SETTLEMENT_PENDING;
    Ok(())
}

fn make_settlement_refundable(game_state: &mut GameState, current_slot: u64) -> Result<()> {
    require!(
        game_state.settlement_status == SETTLEMENT_PENDING,
        ErrorCode::InvalidSettlementState
    );
    require!(
        current_slot >= game_state.settlement_expiry_slot,
        ErrorCode::SettlementNotExpired
    );
    game_state.settlement_status = SETTLEMENT_REFUNDABLE;
    Ok(())
}

fn refund_all_seats(game_state: &mut GameState) -> Result<()> {
    require!(
        game_state.settlement_status == SETTLEMENT_REFUNDABLE,
        ErrorCode::InvalidSettlementState
    );
    // Incrementing generation makes any delayed callback stale before it can
    // touch an escrow.  The account-level refund instruction must validate and
    // restore every active PlayerGameEscrow in the same transaction.
    game_state.settlement_generation = game_state
        .settlement_generation
        .checked_add(1)
        .ok_or(error!(ErrorCode::InvalidSettlementState))?;
    game_state.settlement_status = SETTLEMENT_REFUNDED;
    Ok(())
}

fn complete_all_seat_settlement(
    game_state: &mut GameState,
    computation: u64,
    generation: u64,
) -> Result<()> {
    require!(
        game_state.settlement_status == SETTLEMENT_PENDING
            && game_state.settlement_computation == computation
            && game_state.settlement_generation == generation,
        ErrorCode::StaleSettlementCallback
    );
    game_state.settlement_status = SETTLEMENT_SETTLED;
    game_state.phase = 6;
    Ok(())
}

#[cfg(test)]
mod cpi_authority_tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn light_casino_id_parses() {
        let id = Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).unwrap();
        assert_ne!(id, Pubkey::default());
    }

    #[test]
    fn cpi_authority_pda_is_stable() {
        let program_id = Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).unwrap();
        let (a, bump) = Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], &program_id);
        let (b, bump2) = Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], &program_id);
        assert_eq!(a, b);
        assert_eq!(bump, bump2);
    }

    #[test]
    fn proof_receipt_seeds_include_phase_and_player() {
        let program_id = Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).unwrap();
        let game_id = [3u8; 32];
        let (a, _) = Pubkey::find_program_address(
            &[PROOF_RECEIPT_SEED, &game_id, &[PROOF_PHASE_SHARE], &[1]],
            &program_id,
        );
        let (b, _) = Pubkey::find_program_address(
            &[PROOF_RECEIPT_SEED, &game_id, &[PROOF_PHASE_SHARE], &[2]],
            &program_id,
        );
        assert_ne!(a, b);
    }
}

#[cfg(test)]
mod next_hand_tests {
    use super::*;

    fn material(byte: u8) -> ([[u8; 32]; 2], [[u8; 32]; 4]) {
        let mut public_key = [[0u8; 32]; 2];
        public_key[0][0] = byte;
        public_key[1][0] = byte.wrapping_add(1);
        let mut padding = [[0u8; 32]; 4];
        padding[0][0] = byte.wrapping_add(7);
        (public_key, padding)
    }

    fn store(
        game: &mut GameState,
        keys: &mut RegistrationMaterial,
        player_index: u8,
        byte: u8,
    ) {
        let (public_key, padding) = material(byte);
        remember_player_registration(game, keys, player_index, public_key, padding).unwrap();
    }

    fn showdown_game(players: u8) -> GameState {
        GameState {
            num_players: players,
            betting_phase: 4,
            phase: 3,
            ..Default::default()
        }
    }

    #[test]
    fn showdown_opens_register_until_every_joined_player_has_a_key() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        advance_betting_street_on_chain(&mut game).unwrap();
        assert_eq!(game.phase, 5);
        assert_eq!(game.betting_phase, 5);
        assert_eq!(game.next_hand_phase, NEXT_HAND_REGISTER);
        assert_eq!(game.next_num_players, 2);
        assert_eq!(game.next_registered_mask, 0b01);
    }

    #[test]
    fn showdown_reuses_keys_when_every_joined_player_registered() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        let kept = keys.public_key;
        advance_betting_street_on_chain(&mut game).unwrap();
        assert_eq!(game.phase, 5);
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
        assert_eq!(game.next_registered_mask, 0b11);
        assert_eq!(keys.public_key, kept);
    }

    #[test]
    fn pot_settlement_closes_the_table() {
        let mut table = TableState::init([1u8; 32], 0, GameKind::Poker as u8, 1, 0);
        table.assign_seat(0, Pubkey::new_unique()).unwrap();
        table.assign_seat(1, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        let game_id = [9u8; 32];
        table.snapshot_hand(game_id).unwrap();
        let hand_order = table.hand_seat_order;

        let mut game = showdown_game(2);
        game.game_id = game_id;
        game.phase = 5;
        game.settlement_status = SETTLEMENT_PROOF_ACCEPTED;
        game.next_num_players = 2;
        game.next_hand_phase = NEXT_HAND_SHUFFLE;

        close_hand_after_pot_settlement(&mut game, &mut table).unwrap();

        assert!(!table.hand_in_progress);
        assert_eq!(table.current_game_id, [0u8; 32]);
        assert_eq!(table.hand_num_players, 0);
        assert_eq!(game.phase, 6);
        assert_eq!(game.settlement_status, SETTLEMENT_SETTLED);
        assert!(game.next_seat_saved);
        assert_eq!(game.next_seat_order[0], hand_order[0]);
        assert_eq!(game.next_seat_order[1], hand_order[1]);
    }

    #[test]
    fn pot_settlement_rejects_a_different_game() {
        let mut table = TableState::init([1u8; 32], 0, GameKind::Poker as u8, 1, 0);
        table.assign_seat(0, Pubkey::new_unique()).unwrap();
        table.assign_seat(1, Pubkey::new_unique()).unwrap();
        table.refresh_pending_order();
        table.snapshot_hand([9u8; 32]).unwrap();

        let mut game = showdown_game(2);
        game.game_id = [8u8; 32];
        assert!(close_hand_after_pot_settlement(&mut game, &mut table).is_err());
        assert!(table.hand_in_progress);
        assert_eq!(table.current_game_id, [9u8; 32]);
    }

    #[test]
    fn missing_player_registers_then_everyone_must_shuffle_and_share() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        advance_betting_street_on_chain(&mut game).unwrap();
        let (public_key, padding) = material(2);
        let mut player = PlayerState {
            player_index: 1,
            ..Default::default()
        };
        register_next_hand_player(&mut game, &mut keys, &mut player, public_key, padding).unwrap();
        assert_eq!(player.public_key, public_key);
        assert_eq!(player.padding, padding);
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
        assert_eq!(game.phase, 5);

        assert!(join_next_hand_shuffle(&mut game, 1).is_err());
        join_next_hand_shuffle(&mut game, 0).unwrap();
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
        join_next_hand_shuffle(&mut game, 1).unwrap();
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHARE);
        assert_eq!(game.phase, 5);

        join_next_hand_share(&mut game, 0).unwrap();
        assert!(join_next_hand_share(&mut game, 0).is_err());
        join_next_hand_share(&mut game, 1).unwrap();
        assert_eq!(game.next_hand_phase, NEXT_HAND_READY);
        assert_eq!(game.phase, 5);
        assert_eq!(game.registered_mask, 0b11);
    }

    #[test]
    fn reused_key_must_match_the_stored_padding() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        advance_betting_street_on_chain(&mut game).unwrap();
        let (public_key, mut padding) = material(1);
        padding[0][0] = 99;
        let mut player = PlayerState {
            player_index: 0,
            ..Default::default()
        };
        assert!(
            register_next_hand_player(&mut game, &mut keys, &mut player, public_key, padding)
                .is_err()
        );
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
    }

    #[test]
    fn opening_showdown_again_does_not_reset_the_pipeline() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        advance_betting_street_on_chain(&mut game).unwrap();
        join_next_hand_shuffle(&mut game, 0).unwrap();
        mark_showdown_receipt(&mut game, 0, [7u8; 32]).unwrap();
        assert_eq!(game.phase, 5);
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
        assert_eq!(game.next_shuffler, 1);
        assert_eq!(game.next_shuffled_mask, 0b01);
    }

    #[test]
    fn folded_player_still_joins_the_next_shuffle() {
        let mut game = showdown_game(3);
        let mut keys = RegistrationMaterial::default();
        game.folded_mask = 0b100;
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        store(&mut game, &mut keys, 2, 3);
        advance_betting_street_on_chain(&mut game).unwrap();
        assert_eq!(game.phase, 5);
        assert_eq!(game.next_num_players, 3);
        assert_eq!(game.next_hand_phase, NEXT_HAND_SHUFFLE);
    }

    #[test]
    fn start_waits_until_the_next_hand_has_shared() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        advance_betting_street_on_chain(&mut game).unwrap();
        assert!(accept_next_hand_for_start(&game, 2).is_err());
        join_next_hand_shuffle(&mut game, 0).unwrap();
        join_next_hand_shuffle(&mut game, 1).unwrap();
        join_next_hand_share(&mut game, 0).unwrap();
        join_next_hand_share(&mut game, 1).unwrap();
        accept_next_hand_for_start(&game, 2).unwrap();
        assert!(accept_next_hand_for_start(&game, 3).is_err());
        let kept = keys.public_key[0];
        finish_next_hand_for_start(&mut game, 2, NEXT_HAND_READY);
        assert_eq!(game.phase, 3);
        assert_eq!(game.shared_mask, 0b11);
        assert_eq!(game.next_hand_phase, NEXT_HAND_CLOSED);
        assert_eq!(keys.public_key[0], kept);
    }

    #[test]
    fn reused_keys_follow_the_seat_when_the_button_moves() {
        let mut game = showdown_game(2);
        let mut keys = RegistrationMaterial::default();
        store(&mut game, &mut keys, 0, 1);
        store(&mut game, &mut keys, 1, 2);
        advance_betting_street_on_chain(&mut game).unwrap();
        game.next_seat_saved = true;
        game.next_seat_order = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let seat0_key = keys.public_key[1];
        reindex_registrations_to_seat_order(&mut game, &mut keys, &[0, 1], 2);
        assert_eq!(keys.public_key[0], seat0_key);
        assert_eq!(game.registered_mask, 0b11);
    }

    #[test]
    fn first_hand_can_start_with_the_pipeline_closed() {
        let game = GameState::default();
        accept_next_hand_for_start(&game, 2).unwrap();
    }

    #[test]
    fn registration_tail_sits_after_the_game_record() {
        let game = GameState::default();
        let mut encoded = Vec::new();
        game.try_serialize(&mut encoded).unwrap();
        assert_eq!(encoded.len(), 8 + GameState::INIT_SPACE);

        let mut keys = RegistrationMaterial::default();
        keys.public_key[3][1][7] = 9;
        keys.padding[3][2][4] = 8;
        let mut tail = vec![0u8; REG_TAIL_BYTES];
        write_registration_tail(&mut tail, &keys);
        let mut loaded = RegistrationMaterial::default();
        read_registration_tail(&tail, &mut loaded);
        assert_eq!(loaded.public_key[3][1][7], 9);
        assert_eq!(loaded.padding[3][2][4], 8);
        assert_eq!(REG_TAIL_BYTES, 1920);
    }
}

#[cfg(test)]
mod showdown_receipt_tests {
    use super::*;

    #[test]
    fn non_folded_seated_player_may_submit_even_if_not_current() {
        let mut state = GameState {
            num_players: 3,
            phase: 3,
            current_player: 0,
            folded_mask: 0b100,
            ..Default::default()
        };
        mark_showdown_receipt(&mut state, 1, [42u8; 32]).unwrap();
        assert_eq!(state.showdown_hash, [42u8; 32]);
        assert!(state.showdown_finalized);
        assert_eq!(state.phase, 5);
    }

    #[test]
    fn folded_player_cannot_submit_showdown_hash() {
        let mut state = GameState {
            num_players: 3,
            phase: 3,
            folded_mask: 0b100,
            ..Default::default()
        };
        assert!(mark_showdown_receipt(&mut state, 2, [42u8; 32]).is_err());
        assert_eq!(state.showdown_hash, [0u8; 32]);
        assert!(!state.showdown_finalized);
    }

    #[test]
    fn rejects_duplicate_showdown() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            ..Default::default()
        };
        mark_showdown_receipt(&mut state, 0, [1u8; 32]).unwrap();
        assert!(mark_showdown_receipt(&mut state, 1, [2u8; 32]).is_err());
    }

    #[test]
    fn rejects_player_outside_hand() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            ..Default::default()
        };
        assert!(mark_showdown_receipt(&mut state, 2, [1u8; 32]).is_err());
    }

    #[test]
    fn records_showdown_submitter_for_coefficient_binding() {
        // Settlement (`compute_pots` / `distribute_and_settle`) loads the
        // SealedShowdownCoefficients PDA seeded by `showdown_hash_player`. That
        // index MUST be the player whose proof set `showdown_hash` — otherwise a
        // caller could point settlement at their own self-chosen coefficients.
        let mut state = GameState {
            num_players: 3,
            phase: 3,
            ..Default::default()
        };
        assert_eq!(state.showdown_hash_player, 0);
        mark_showdown_receipt(&mut state, 2, [7u8; 32]).unwrap();
        assert_eq!(state.showdown_hash_player, 2);
    }
}

#[cfg(test)]
mod street_closure_tests {
    use super::*;

    /// Heads-up: SB completes the blind. Bets match, but the BB has not acted.
    #[test]
    fn heads_up_limp_leaves_big_blind_option() {
        let mut state = GameState {
            num_players: 2,
            betting_phase: 1,
            current_bet: 20,
            current_player: 0,
            // Blinds: SB=10 (index 0), BB=20 (index 1).
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 10;
                c[1] = 20;
                c
            },
            player_total_bets: {
                let mut t = [0u64; 10];
                t[0] = 10;
                t[1] = 20;
                t
            },
            acted_mask: 0,
            ..Default::default()
        };
        state.hand_commits[0] = 20;
        state.player_total_bets[0] = 20;
        after_bet_update_turn(&mut state, 0, 2, false).unwrap();
        assert_eq!(state.betting_phase, 1);
        assert_eq!(state.current_player, 1);
        assert_eq!(state.acted_mask, 1);

        // BB checks. Both players have acted and the street bets match.
        after_bet_update_turn(&mut state, 1, 1, false).unwrap();
        assert_eq!(state.betting_phase, 2);
    }

    /// The callback must follow Arcis: a matched limp stays on preflop when the
    /// circuit says the street is still open, and advances when it says closed.
    #[test]
    fn arcis_street_flag_gates_the_big_blind_option() {
        let mut state = GameState {
            num_players: 2,
            betting_phase: 1,
            current_bet: 20,
            current_player: 0,
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 20;
                c[1] = 20;
                c
            },
            acted_mask: 0,
            ..Default::default()
        };
        apply_arcis_street_decision(&mut state, 0, 2, false, false).unwrap();
        assert_eq!(state.betting_phase, 1);
        assert_eq!(state.current_player, 1);

        apply_arcis_street_decision(&mut state, 1, 4, true, false).unwrap();
        assert_eq!(state.betting_phase, 1);
        assert_eq!(state.current_player, 0);
        assert_eq!(state.acted_mask, 0b10);

        apply_arcis_street_decision(&mut state, 0, 2, false, true).unwrap();
        assert_eq!(state.betting_phase, 2);
    }

    /// Heads-up flop: the bettor has acted, so the call closes the street.
    #[test]
    fn heads_up_flop_call_closes_street() {
        let mut state = GameState {
            num_players: 2,
            betting_phase: 2,
            current_bet: 20,
            current_player: 0,
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 20;
                c[1] = 20;
                c
            },
            acted_mask: 0b10,
            ..Default::default()
        };
        after_bet_update_turn(&mut state, 0, 2, false).unwrap();
        assert_eq!(state.betting_phase, 3);
    }

    #[test]
    fn five_percent_rake_is_taken_when_the_flop_is_dealt() {
        let mut state = GameState {
            num_players: 2,
            betting_phase: 1,
            current_bet: 20,
            rake_bps: 500,
            pots: {
                let mut pots = [0u64; 9];
                pots[0] = 200;
                pots
            },
            pot_count: 1,
            hand_commits: {
                let mut commits = [0u64; 10];
                commits[0] = 20;
                commits[1] = 20;
                commits
            },
            ..Default::default()
        };
        after_bet_update_turn(&mut state, 0, 2, false).unwrap();
        assert_eq!(state.betting_phase, 1);
        assert!(!state.reached_flop);
        after_bet_update_turn(&mut state, 1, 1, false).unwrap();
        assert!(state.reached_flop);
        assert_eq!(state.rake_amount, 10);
        assert_eq!(state.pots[0], 190);

        let mut folded = GameState {
            num_players: 2,
            betting_phase: 1,
            rake_bps: 500,
            folded_mask: 1 << 1,
            pots: {
                let mut pots = [0u64; 9];
                pots[0] = 200;
                pots
            },
            ..Default::default()
        };
        after_bet_update_turn(&mut folded, 1, 0, false).unwrap();
        assert_eq!(folded.phase, 6);
        assert_ne!(folded.betting_phase, 5);
        assert_eq!(folded.payouts[0], 200);
        assert!(!folded.reached_flop);
        assert_eq!(folded.rake_amount, 0);
        assert_eq!(folded.pots[0], 200);
    }

    /// The last fold pays the remaining player. Showdown does not open.
    #[test]
    fn fold_awards_the_pot_and_skips_showdown() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            betting_phase: 1,
            folded_mask: 1 << 0,
            act_deadline_unix: 50,
            pots: {
                let mut pots = [0u64; 9];
                pots[0] = 20;
                pots
            },
            refunds: {
                let mut refunds = [0u64; 10];
                refunds[1] = 10;
                refunds
            },
            ..Default::default()
        };
        after_bet_update_turn(&mut state, 0, 0, false).unwrap();
        assert_eq!(state.phase, 6);
        assert_eq!(state.betting_phase, 1);
        assert_eq!(state.act_deadline_unix, 0);
        assert!(require_card_reveal_allowed(20, 2, state.betting_phase, true, 1, state.folded_mask, 0).is_err());
        assert!(require_card_reveal_allowed(24, 2, state.betting_phase, true, 1, state.folded_mask, 0).is_err());
        assert_eq!(state.payouts[0], 0);
        assert_eq!(state.payouts[1], 30);
        assert_eq!(state.next_hand_phase, 0);
    }

    /// Folding on the flop keeps that street and seals the turn and river.
    #[test]
    fn fold_on_the_flop_does_not_open_later_streets() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            betting_phase: 2,
            reached_flop: true,
            folded_mask: 1 << 1,
            act_deadline_unix: 80,
            ..Default::default()
        };
        after_bet_update_turn(&mut state, 1, 0, false).unwrap();
        assert_eq!(state.phase, 6);
        assert_eq!(state.betting_phase, 2);
        assert_eq!(state.act_deadline_unix, 0);
        assert!(require_card_reveal_allowed(22, 2, state.betting_phase, true, 0, state.folded_mask, 0).is_ok());
        assert!(require_card_reveal_allowed(23, 2, state.betting_phase, true, 0, state.folded_mask, 0).is_err());
        assert!(require_card_reveal_allowed(24, 2, state.betting_phase, true, 0, state.folded_mask, 0).is_err());
    }

    /// Two players still in on the river. The closing call is a real showdown.
    #[test]
    fn river_with_both_players_in_reaches_showdown() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            betting_phase: 4,
            current_bet: 20,
            acted_mask: 0b10,
            hand_commits: {
                let mut commits = [0u64; 10];
                commits[0] = 20;
                commits[1] = 20;
                commits
            },
            ..Default::default()
        };
        after_bet_update_turn(&mut state, 0, 2, false).unwrap();
        assert_eq!(state.phase, 5);
        assert_eq!(state.betting_phase, 5);
    }

    /// Cumulative totals that differ from the street level must not block
    /// closure when the street-local commits are matched (regression: prior
    /// streets or a doubled blind left player_total_bets unequal).
    #[test]
    fn matched_street_closes_despite_unequal_cumulative_totals() {
        let state = GameState {
            num_players: 2,
            folded_mask: 0,
            all_in_mask: 0,
            // Street commits equal → matched.
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 20;
                c[1] = 20;
                c
            },
            // Cumulative totals differ (e.g. unbalanced prior street).
            player_total_bets: {
                let mut t = [0u64; 10];
                t[0] = 20;
                t[1] = 40;
                t
            },
            ..Default::default()
        };
        assert!(street_bets_matched(&state));
        // Sanity: the old cumulative-based check would have (incorrectly) failed.
        assert_ne!(state.player_total_bets[0], state.player_total_bets[1]);
    }

    /// Street stays open until the caller actually matches the street bet.
    #[test]
    fn unmatched_street_stays_open() {
        let state = GameState {
            num_players: 2,
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 10; // SB has not yet matched the 20 level
                c[1] = 20;
                c
            },
            ..Default::default()
        };
        assert!(!street_bets_matched(&state));
    }

    /// Folded and all-in players are excluded from the match requirement.
    #[test]
    fn folded_and_all_in_players_excluded() {
        let state = GameState {
            num_players: 3,
            folded_mask: 0b010,  // player 1 folded
            all_in_mask: 0b100,  // player 2 all-in short
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 50;
                c[1] = 20; // folded, ignored
                c[2] = 30; // all-in short, ignored
                c
            },
            ..Default::default()
        };
        assert!(street_bets_matched(&state));
    }

    #[test]
    fn decision_window_is_sixty_seconds_and_inclusive() {
        let mut state = GameState {
            betting_phase: 1,
            ..Default::default()
        };
        assign_action_deadline(&mut state, 1_700_000_000);
        assert_eq!(state.act_deadline_unix, 1_700_000_060);
        assert!(action_is_in_time(state.act_deadline_unix, 1_700_000_060));
        assert!(!action_is_in_time(state.act_deadline_unix, 1_700_000_061));
        assert!(!action_is_in_time(0, 1_700_000_060));
        state.betting_phase = 5;
        assign_action_deadline(&mut state, 1_700_000_060);
        assert_eq!(state.act_deadline_unix, 0);
    }

    #[test]
    fn act_deadline_is_the_last_game_state_field() {
        let mut game = GameState::default();
        game.act_deadline_unix = 0x0102_0304_0506_0708;
        let mut encoded = Vec::new();
        game.try_serialize(&mut encoded).unwrap();
        assert_eq!(encoded.len(), 8 + GameState::INIT_SPACE);
        let offset = encoded.len() - 8;
        assert_eq!(offset, GameState::INIT_SPACE);
        let raw = i64::from_le_bytes(encoded[offset..offset + 8].try_into().unwrap());
        assert_eq!(raw, game.act_deadline_unix);
    }

    /// SB still owes the big blind. Time runs out and the hand ends.
    #[test]
    fn timeout_folds_when_chips_are_owed() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            betting_phase: 1,
            current_player: 0,
            current_bet: 20,
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 10;
                c[1] = 20;
                c
            },
            pots: {
                let mut pots = [0u64; 9];
                pots[0] = 30;
                pots
            },
            ..Default::default()
        };
        let action = apply_timeout_action(&mut state).unwrap();
        assert_eq!(action, 0);
        assert_eq!(state.folded_mask & 1, 1);
        assert_eq!(state.phase, 6);
        assert_ne!(state.betting_phase, 5);
    }

    /// Big blind already matches the blind. Missing the window still folds.
    #[test]
    fn timeout_folds_even_when_a_check_was_legal() {
        let mut state = GameState {
            num_players: 2,
            phase: 3,
            betting_phase: 1,
            current_player: 1,
            current_bet: 20,
            acted_mask: 0b01,
            hand_commits: {
                let mut c = [0u64; 10];
                c[0] = 20;
                c[1] = 20;
                c
            },
            pots: {
                let mut pots = [0u64; 9];
                pots[0] = 40;
                pots
            },
            ..Default::default()
        };
        let action = apply_timeout_action(&mut state).unwrap();
        assert_eq!(action, 0);
        assert_eq!(state.folded_mask, 0b10);
        assert_eq!(state.phase, 6);
        assert_ne!(state.betting_phase, 5);
        assert_eq!(state.payouts[0], 40);
    }

    /// Three players remain. Folding the actor passes the turn and stays on the street.
    #[test]
    fn timeout_fold_passes_the_turn_when_others_remain() {
        let mut state = GameState {
            num_players: 3,
            phase: 3,
            betting_phase: 2,
            current_player: 0,
            current_bet: 0,
            ..Default::default()
        };
        let action = apply_timeout_action(&mut state).unwrap();
        assert_eq!(action, 0);
        assert_eq!(state.folded_mask, 0b001);
        assert_eq!(state.phase, 3);
        assert_eq!(state.betting_phase, 2);
        assert_eq!(state.current_player, 1);
    }
}

fn consume_receipt_and_advance(
    game_state: &mut GameState,
    proof_receipt: &AccountInfo,
    share_verify_acc: Option<&AccountInfo>,
    expected_generation: u64,
    expected_phase: u8,
    expected_player_index: u8,
    expected_circuit_version: u16,
    expected_output_hash: [u8; 32],
) -> Result<()> {
    let receipt = read_proof_receipt(proof_receipt)?;

    require!(receipt.game_id == game_state.game_id, ErrorCode::InvalidProofReceipt);
    require!(receipt.generation == expected_generation, ErrorCode::InvalidProofReceipt);
    require!(receipt.phase == expected_phase, ErrorCode::InvalidProofReceipt);
    require!(receipt.player_index == expected_player_index, ErrorCode::InvalidProofReceipt);
    require!(
        receipt.circuit_version == expected_circuit_version,
        ErrorCode::InvalidProofReceipt
    );
    require!(receipt.status == RECEIPT_STATUS_VERIFIED, ErrorCode::ProofReceiptAlreadyConsumed);
    require!(receipt.output_hash == expected_output_hash, ErrorCode::InvalidProofReceipt);

    // Register is parallel: track who registered via shared_mask (cleared at Shuffle).
    if expected_phase == PROOF_PHASE_REGISTER {
        require!(game_state.phase == PROOF_PHASE_REGISTER, ErrorCode::InvalidGamePhase);
        mark_register_receipt(game_state, expected_player_index)?;
        return Ok(());
    }

    // Share phase is parallel: track who has shared via shared_mask, not turn order.
    // A showdown-opened next hand records the same receipt on its own mask.
    if expected_phase == PROOF_PHASE_SHARE {
        let next_hand_share = game_state.next_hand_phase == NEXT_HAND_SHARE;
        if !next_hand_share {
            require!(game_state.phase == PROOF_PHASE_SHARE, ErrorCode::InvalidGamePhase);
        }
        let share_verify = share_verify_acc.ok_or(error!(ErrorCode::InvalidVerifyProgress))?;
        require!(share_verify.owner == &crate::ID, ErrorCode::InvalidAccountOwner);
        let mut data = &share_verify.try_borrow_data()?[..];
        let acc = ShareVerifyAccumulator::try_deserialize(&mut data)
            .map_err(|_| error!(ErrorCode::InvalidVerifyProgress))?;
        // Share chunks are not opened here. Reveal hashing and the share
        // stake cover a bad or missing opening. The accumulator only binds
        // the receipt to the generation recorded at begin.
        require!(
            acc.game_id == game_state.game_id
                && acc.player_index == expected_player_index
                && acc.generation == expected_generation,
            ErrorCode::InvalidVerifyProgress
        );
        if next_hand_share {
            join_next_hand_share(game_state, expected_player_index)?;
        } else {
            mark_share_receipt(game_state, expected_player_index)?;
        }
        return Ok(());
    }

    // Showdown: Light already verified Groth16 against ShowdownMaterialCommitment
    // + RevealedCards. CPI from light-casino `cpi_authority` latches settlement.
    if expected_phase == PROOF_PHASE_SHOWDOWN {
        mark_showdown_receipt(game_state, expected_player_index, receipt.output_hash)?;
        return Ok(());
    }

    if expected_phase == PROOF_PHASE_SHUFFLE && game_state.next_hand_phase == NEXT_HAND_SHUFFLE {
        join_next_hand_shuffle(game_state, expected_player_index)?;
        return Ok(());
    }

    require!(game_state.current_player == expected_player_index, ErrorCode::NotYourTurn);

    match expected_phase {
        PROOF_PHASE_SHUFFLE => {
            game_state.current_player = game_state.current_player.saturating_add(1);
            if game_state.current_player == game_state.num_players {
                game_state.phase = PROOF_PHASE_SHARE;
                game_state.current_player = 0;
                game_state.shared_mask = 0;
            }
        }
        _ => return Err(error!(ErrorCode::InvalidProofReceipt)),
    }

    Ok(())
}

#[arcium_program]
pub mod casino {
    use super::*;
    use super::rent_vault;
    
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.data.count = 0;
        Ok(())
    }
    
    pub fn set_count(ctx: Context<SetCount>, count: u64) -> Result<()> {
        ctx.accounts.data.count = count;
        Ok(())
    }

    pub fn consume_proof_receipt(
        ctx: Context<ConsumeProofReceipt>,
        expected_generation: u64,
        expected_phase: u8,
        expected_player_index: u8,
        expected_circuit_version: u16,
        expected_output_hash: [u8; 32],
    ) -> Result<()> {
        assert_cpi_authority(&ctx.accounts.authority.to_account_info())?;
        validate_light_casino_receipt(
            &ctx.accounts.proof_receipt.to_account_info(),
            &ctx.accounts.game_state.game_id,
            expected_generation,
            expected_phase,
            expected_player_index,
            expected_circuit_version,
        )?;
        let share_verify_acc_info = ctx.accounts.share_verify_acc.as_ref()
            .map(|account| account.to_account_info());
        consume_receipt_and_advance(
            &mut ctx.accounts.game_state,
            &ctx.accounts.proof_receipt.to_account_info(),
            share_verify_acc_info.as_ref(),
            expected_generation,
            expected_phase,
            expected_player_index,
            expected_circuit_version,
            expected_output_hash,
        )?;
        emit_phase_advanced(&ctx.accounts.game_state);
        emit_player_action_required(&ctx.accounts.game_state);
        Ok(())
    }

    pub fn consume_register_receipt(
        ctx: Context<ConsumeRegisterReceipt>,
        expected_generation: u64,
        expected_player_index: u8,
        expected_circuit_version: u16,
        expected_output_hash: [u8; 32],
        public_key: [[u8; 32]; 2],
        padding: [[u8; 32]; 4],
    ) -> Result<()> {
        assert_cpi_authority(&ctx.accounts.authority.to_account_info())?;
        validate_light_casino_receipt(
            &ctx.accounts.proof_receipt.to_account_info(),
            &ctx.accounts.game_state.game_id,
            expected_generation,
            PROOF_PHASE_REGISTER,
            expected_player_index,
            expected_circuit_version,
        )?;
        let receipt = read_proof_receipt(&ctx.accounts.proof_receipt.to_account_info())?;
        let player_state = &mut ctx.accounts.player_state;
        let game_state = &mut ctx.accounts.game_state;

        require!(receipt.game_id == game_state.game_id, ErrorCode::InvalidProofReceipt);
        require!(receipt.generation == expected_generation, ErrorCode::InvalidProofReceipt);
        require!(receipt.phase == PROOF_PHASE_REGISTER, ErrorCode::InvalidProofReceipt);
        require!(receipt.player_index == expected_player_index, ErrorCode::InvalidProofReceipt);
        require!(
            receipt.circuit_version == expected_circuit_version
                && receipt.status == RECEIPT_STATUS_VERIFIED,
            ErrorCode::InvalidProofReceipt
        );
        require!(receipt.output_hash == expected_output_hash, ErrorCode::InvalidProofReceipt);
        require!(public_key[0] == expected_output_hash, ErrorCode::InvalidProof);

        player_state.game_id = game_state.game_id;
        player_state.player_index = expected_player_index;
        if (expected_player_index as usize) < HAND_PLAYER_CAP {
            let info = game_state.to_account_info();
            let mut material = load_registration(&info)?;
            remember_player_registration(
                game_state,
                &mut material,
                expected_player_index,
                public_key,
                padding,
            )?;
            store_registration(&info, &material)?;
            player_state.public_key = public_key;
            player_state.padding = padding;
        } else {
            player_state.public_key[0] = expected_output_hash;
        }

        if game_state.next_hand_phase == NEXT_HAND_REGISTER {
            note_next_hand_registration(game_state, expected_player_index)?;
        } else {
            mark_register_receipt(game_state, expected_player_index)?;
        }
        emit_phase_advanced(game_state);
        emit_player_action_required(game_state);
        Ok(())
    }

    /// Open preflop betting (`betting_phase` 0 → 1).
    ///
    /// Streets advance only via Enc bet-callback
    /// [`advance_betting_street_on_chain`] — callers cannot select Flop/Turn/River/Showdown.
    pub fn open_preflop(ctx: Context<OpenPreflop>) -> Result<()> {
        apply_open_preflop(&mut ctx.accounts.game_state)
    }

    /// Testing-only: legacy phase-arg entry (idempotent same-street / open preflop).
    /// Release builds expose [`open_preflop`] only — no caller-selected street jumps.
    #[cfg(feature = "testing")]
    pub fn start_betting_round(
        ctx: Context<StartBettingRound>,
        betting_phase: u8,
    ) -> Result<()> {
        require!(betting_phase >= 1 && betting_phase <= 5, ErrorCode::InvalidGamePhase);
        let game_state = &mut ctx.accounts.game_state;
        require!(
            is_legal_betting_phase_transition(game_state.betting_phase, betting_phase),
            ErrorCode::InvalidGamePhase
        );
        if game_state.betting_phase == betting_phase {
            return Ok(());
        }
        // Only 0 → 1 remains legal for a real transition.
        apply_open_preflop(game_state)
    }

    /// Testing only: plaintext blind mint without Enc seat debit.
    /// Production blinds must debit the canonical Enc hand ledger.
    #[cfg(feature = "testing")]
    pub fn collect_blinds(
        ctx: Context<CollectBlinds>,
        small_blind: u64,
        big_blind: u64,
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(game_state.num_players >= 2, ErrorCode::InvalidGamePhase);
        require!(
            ctx.accounts.encrypted_game_betting.is_some(),
            ErrorCode::InvalidGamePhase
        );
        require!(small_blind > 0 && big_blind >= small_blind, ErrorCode::InvalidAmount);
        game_state.player_total_bets[0] = small_blind;
        game_state.player_total_bets[1] = big_blind;
        game_state.hand_commits = [0u64; 10];
        game_state.hand_commits[0] = small_blind;
        game_state.hand_commits[1] = big_blind;
        game_state.current_bet = big_blind;
        game_state.last_aggressor = 1;
        game_state.last_aggressor_amount = big_blind;
        let canonical = recompute_pots(
            &game_state.player_total_bets,
            game_state.folded_mask,
            game_state.num_players,
        )
        .map_err(|_| error!(ErrorCode::InvalidCanonicalPot))?;
        store_raked_pots(game_state, canonical)?;

        if let Some(ref mut betting) = ctx.accounts.encrypted_game_betting {
            betting.sync_from_plaintext(
                &game_state.player_total_bets,
                &game_state.pots,
                game_state.current_bet,
                game_state.last_aggressor_amount,
            );
        }
        Ok(())
    }

    // ─── Arcium Integration: verify_deck_hash_chunk ───
    //
    // Parallel-safe: each chunk returns one Poseidon(4) digest. Callbacks
    // accumulate modulo 2^256 and mark a completion bitset. Call
    // `begin_verify_deck_hash` once before queueing chunks concurrently.

    pub fn init_verify_deck_hash_chunk_comp_def(
        ctx: Context<InitVerifyDeckHashChunkCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Reset accumulator / bitset and latch the expected Poseidon(4) sum.
    pub fn begin_verify_deck_hash(
        ctx: Context<BeginVerifyDeckHash>,
        expected_hash_low: u128,
        expected_hash_high: u128,
    ) -> Result<()> {
        let gs = &mut ctx.accounts.game_state;
        require_staging_authority(&ctx.accounts.payer.key(), gs)?;
        require!(
            !gs.verify_started && gs.verify_progress == 0 && !gs.verified,
            ErrorCode::InvalidVerifyProgress
        );
        let verify = &mut ctx.accounts.verify_accumulator;
        require!(
            !verify.verify_started && verify.verify_progress == 0 && !verify.verified,
            ErrorCode::InvalidVerifyProgress
        );
        gs.verify_hash_acc = [0u8; 32];
        gs.verify_bits = [0u64; 15];
        gs.verify_progress = 0;
        gs.verify_expected = le_bytes_from_u128_halves(expected_hash_low, expected_hash_high);
        gs.verified = false;
        gs.verify_started = true;

        // Callbacks deliberately write only this small PDA.  A callback that
        // deserializes GameState also brings the full betting/pot state into
        // the delivery transaction; Arcium's local callback relayer can
        // silently drop that transaction.  The client syncs this accumulator
        // into GameState after callbacks land.
        verify.game_id = gs.game_id;
        verify.verify_hash_acc = [0u8; 32];
        verify.verify_bits = [0u64; 15];
        verify.verify_progress = 0;
        verify.verify_expected = gs.verify_expected;
        verify.verify_target = used_verify_progress_target(gs.num_players);
        verify.verified = false;
        verify.verify_started = true;
        Ok(())
    }

    pub fn verify_deck_hash_chunk(
        ctx: Context<VerifyDeckHashChunk>,
        computation_offset: u64,
        deck_account_pubkey: Pubkey,
        encryption_pubkey: [u8; 32],
        base_nonce: u128,
        start_index: u16,
        _expected_hash_low: u128,
        _expected_hash_high: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            ctx.accounts.verify_accumulator.verify_started,
            ErrorCode::InvalidVerifyProgress
        );
        let active = verify_limb_count(ctx.accounts.game_state.num_players) as u16;
        let row_off = start_index % VERIFY_CHUNK_LEN;
        require!(
            start_index % VERIFY_FOLD_LEN == 0
                && row_off + VERIFY_FOLD_LEN <= active
                && start_index + VERIFY_FOLD_LEN <= 900,
            ErrorCode::InvalidCardIndex
        );
        // Slice is complete iff its first bit is set (callback sets all 4 bits).
        require!(
            !verify_bit_get(&ctx.accounts.verify_accumulator.verify_bits, start_index),
            ErrorCode::InvalidVerifyProgress
        );

        let byte_offset = (start_index as u32) * 32;
        let chunk_nonce = base_nonce + start_index as u128;
        let verify_accumulator_key = ctx.accounts.verify_accumulator.key();

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(chunk_nonce)
            .plaintext_u16(start_index)
            .account(deck_account_pubkey, byte_offset, VERIFY_FOLD_BYTES)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![VerifyDeckHashChunkCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: verify_accumulator_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "verify_deck_hash_chunk")]
    pub fn verify_deck_hash_chunk_callback(
        ctx: Context<VerifyDeckHashChunkCallback>,
        output: SignedComputationOutputs<VerifyDeckHashChunkOutput>,
    ) -> Result<()> {
        let o = match output
            .verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account)
        {
            Ok(VerifyDeckHashChunkOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };

        // (Enc<Mxe, [BaseField25519; 4]>, contrib_low, contrib_high, start_index).
        // The ciphertext is the opened batch resealed to the cluster. The
        // callback records the batch index and a zero contribution.
        let _opened = o.field_0;
        let contrib_low: u128 = o.field_1;
        let contrib_high: u128 = o.field_2;
        let start_index: u16 = o.field_3;

        let info = ctx.accounts.verify_accumulator.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        if data.starts_with(VerifyDeckHashAccumulator::DISCRIMINATOR) {
            require!(
                start_index % VERIFY_FOLD_LEN == 0
                    && start_index + VERIFY_FOLD_LEN <= 900,
                ErrorCode::InvalidCardIndex
            );
            let mut input = &data[..];
            let mut verify = VerifyDeckHashAccumulator::try_deserialize(&mut input)
                .map_err(|_| error!(ErrorCode::InvalidVerifyProgress))?;
            if !verify_bit_get(&verify.verify_bits, start_index) {
                for j in 0..VERIFY_FOLD_LEN {
                    verify_bit_set(&mut verify.verify_bits, start_index + j);
                }
                verify.verify_hash_acc =
                    add_u256_le(&verify.verify_hash_acc, contrib_low, contrib_high);
                verify.verify_progress = verify
                    .verify_progress
                    .checked_add(VERIFY_FOLD_LEN)
                    .ok_or(ErrorCode::InvalidVerifyProgress)?;
                if verify.verify_progress == verify.verify_target && verify.verify_target > 0 {
                    verify.verified = verify.verify_hash_acc == verify.verify_expected;
                    verify.verify_started = false;
                }
                let mut output_data = &mut data[..];
                verify.try_serialize(&mut output_data)?;
            }
            emit!(VerifyDeckHashChunkEvent {
                start_index,
                verified: verify.verified,
                progress: verify.verify_progress,
            });
            return Ok(());
        }

        require!(
            data.starts_with(ShareVerifyAccumulator::DISCRIMINATOR),
            ErrorCode::InvalidVerifyProgress
        );
        let mut input = &data[..];
        let mut verify = ShareVerifyAccumulator::try_deserialize(&mut input)
            .map_err(|_| error!(ErrorCode::InvalidVerifyProgress))?;
        require!(!verify.frozen, ErrorCode::InvalidVerifyProgress);
        let share_cards = if verify.share_cards > 0 {
            verify.share_cards
        } else {
            // Legacy accumulators predating `share_cards`: poker deal layout.
            25
        };
        let limb_count = share_verify_limb_count_for_cards(
            verify.num_players,
            start_index,
            share_cards,
        )
        .ok_or(ErrorCode::InvalidCardIndex)? as u16;
        require!(limb_count == VERIFY_FOLD_LEN, ErrorCode::InvalidCardIndex);
        if !verify_bit_get(&verify.verify_bits, start_index) {
            for j in 0..limb_count {
                verify_bit_set(&mut verify.verify_bits, start_index + j);
            }
            verify.verify_hash_acc =
                add_u256_le(&verify.verify_hash_acc, contrib_low, contrib_high);
            verify.verify_progress = verify
                .verify_progress
                .checked_add(limb_count)
                .ok_or(ErrorCode::InvalidVerifyProgress)?;
            require!(
                verify.verify_progress <= verify.verify_target,
                ErrorCode::InvalidVerifyProgress
            );
            if verify.verify_progress == verify.verify_target {
                require!(
                    share_verify_bits_exact(
                        &verify.verify_bits,
                        verify.num_players,
                        share_cards,
                        verify.verify_target,
                    ),
                    ErrorCode::InvalidVerifyProgress
                );
                verify.verified = verify.verify_hash_acc == verify.verify_expected;
                if verify.verified {
                    verify.frozen = true;
                }
            }
            let mut output_data = &mut data[..];
            verify.try_serialize(&mut output_data)?;
        }
        Ok(())
    }

    /// Copy the callback-owned verification state into GameState.
    ///
    /// This intentionally stays outside the Arcium callback so callback
    /// delivery touches only `VerifyDeckHashAccumulator`.
    /// Authority must be `game_state.staging_authority`; progress is monotonic.
    pub fn sync_verify_deck_hash(ctx: Context<SyncVerifyDeckHash>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require_staging_authority(&ctx.accounts.authority.key(), game_state)?;
        apply_sync_verify_deck_hash(game_state, &ctx.accounts.verify_accumulator)?;
        Ok(())
    }

    /// Initialize one player's recipient-major share hash verification.
    pub fn begin_verify_share_hash<'a>(
        ctx: Context<'a, BeginVerifyShareHash<'a>>,
        player_index: u8,
        expected_hash_low: u128,
        expected_hash_high: u128,
    ) -> Result<()> {
        let created = ctx.accounts.share_verify_acc.game_id == [0u8; 32];
        let game_state = &mut ctx.accounts.game_state;
        require_canonical_game_table(&ctx.accounts.table_state, game_state)?;
        let signer_index = player_index_for_pubkey(
            &ctx.accounts.table_state.seats,
            &ctx.accounts.table_state.hand_seat_order,
            ctx.accounts.table_state.hand_num_players,
            &ctx.accounts.payer.key(),
        )
        .ok_or(error!(ErrorCode::NotInHand))?;
        require!(signer_index == player_index, ErrorCode::InvalidAuthority);
        require!(player_index < game_state.num_players, ErrorCode::InvalidSeat);
        // `game_state.verified` may be true after a prior chunk round; begin resets it.
        // Block only once the whole share phase is finalized.
        require!(!game_state.share_finalized, ErrorCode::InvalidVerifyProgress);
        let verify = &mut ctx.accounts.share_verify_acc;
        // Allow: fresh / incomplete restart, OR a completed prior round so blackjack
        // can begin the next share chunk (generation bump clears verified/frozen).
        let fresh = !verify.frozen
            && !verify.verified
            && verify.verify_progress == 0
            && verify.verify_bits == [0u64; 15];
        let incomplete_restart = !verify.frozen
            && !verify.verified
            && verify.verify_progress == verify.verify_target;
        let completed_round = verify.verified && verify.frozen;
        require!(
            fresh || incomplete_restart || completed_round,
            ErrorCode::InvalidVerifyProgress
        );
        verify.generation = verify.generation.checked_add(1)
            .ok_or(ErrorCode::InvalidVerifyProgress)?;
        let player_mpc_key = &ctx.accounts.player_mpc_key;
        require!(
            player_mpc_key.game_id == game_state.game_id
                && player_mpc_key.player_index == player_index
                && player_mpc_key.purpose == 1,
            ErrorCode::InvalidMpcKeyPurpose
        );
        verify.game_id = game_state.game_id;
        verify.player_index = player_index;
        verify.num_players = game_state.num_players;
        verify.encryption_pubkey = player_mpc_key.encryption_pubkey;
        verify.verify_hash_acc = [0u8; 32];
        verify.verify_expected =
            le_bytes_from_u128_halves(expected_hash_low, expected_hash_high);
        verify.verify_progress = 0;
        let share_cards = if ctx.accounts.table_state.game_kind
            == GameKind::Blackjack as u8
        {
            // Each BJ share chunk is ShareHashOut(8,16); Arcis verifies one chunk.
            shared_zk_ids::BLACKJACK_CHUNK_SHARE_CARDS
        } else if ctx.accounts.table_state.game_kind == GameKind::Bingo as u8 {
            shared_zk_ids::BINGO_CHUNK_BALLS
        } else {
            game_state.num_cards
        };
        verify.share_cards = share_cards;
        verify.verify_target =
            share_active_limb_count_for_cards(game_state.num_players, share_cards) as u16;
        require!(verify.verify_target > 0, ErrorCode::InvalidVerifyProgress);
        verify.verify_bits = [0u64; 15];
        verify.verified = false;
        verify.frozen = false;
        // Keep `verified` latched across lazy next-chunk rounds so already-shared
        // cards (`shared_cards`) remain revealable while the next MSM runs.
        if game_state.shared_cards == 0 {
            game_state.verified = false;
        }
        game_state.share_finalized = false;
        if created {
            rent_vault::reimburse(
                ctx.remaining_accounts,
                &ctx.accounts.payer.to_account_info(),
                ctx.accounts.share_verify_acc.to_account_info().lamports(),
            )?;
        }
        Ok(())
    }

    /// Re-open Share after a prefix finalize so the next BJ chunk can verify.
    ///
    /// Keeps `verified` + `shared_cards` so cards already in the prefix stay
    /// revealable. Clears `share_finalized` / `shared_mask` and returns phase
    /// to Share. Pair with light-casino `extend_share_chunks`.
    pub fn reopen_share_for_next_chunk(ctx: Context<ReopenShareForNextChunk>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(game_state.share_finalized, ErrorCode::InvalidVerifyProgress);
        require!(game_state.shared_cards > 0, ErrorCode::InvalidVerifyProgress);
        require!(
            game_state.num_cards != 25 && game_state.num_cards != 0,
            ErrorCode::InvalidGamePhase
        );
        require!(
            game_state.shared_cards < game_state.num_cards as u16,
            ErrorCode::InvalidVerifyProgress
        );
        game_state.share_finalized = false;
        game_state.shared_mask = 0;
        game_state.phase = PROOF_PHASE_SHARE;
        // verified + shared_cards unchanged
        Ok(())
    }

    /// Decrypt one batch of a player's staged share. Starts are limb-aligned.
    /// The job does not hash the plaintext; reveal delivers it later.
    pub fn verify_share_hash_chunk(
        ctx: Context<VerifyShareHashChunk>,
        computation_offset: u64,
        deck_account_pubkey: Pubkey,
        encryption_pubkey: [u8; 32],
        base_nonce: u128,
        start_index: u16,
        limb_count: u8,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let verify = &ctx.accounts.share_verify_acc;
        require!(
            !verify.frozen && !verify.verified && verify.generation > 0,
            ErrorCode::InvalidVerifyProgress
        );
        require!(
            encryption_pubkey == verify.encryption_pubkey,
            ErrorCode::InvalidMpcKeyPurpose
        );
        let share_cards = if verify.share_cards > 0 {
            verify.share_cards
        } else {
            ctx.accounts.game_state.num_cards
        };
        let expected_count = share_verify_limb_count_for_cards(
            verify.num_players,
            start_index,
            share_cards,
        )
        .ok_or(ErrorCode::InvalidCardIndex)?;
        require!(limb_count == expected_count, ErrorCode::InvalidVerifyProgress);
        require!(
            limb_count == VERIFY_FOLD_LEN as u8,
            ErrorCode::InvalidVerifyProgress
        );
        require!(start_index < 900, ErrorCode::InvalidCardIndex);
        require!(
            (start_index as u32) + (limb_count as u32) <= 900,
            ErrorCode::InvalidCardIndex
        );
        require!(
            (start_index as u32) * 32 + (limb_count as u32) * 32
                <= DECK_STAGING_ACCOUNT_SIZE as u32,
            ErrorCode::InvalidCardIndex
        );
        require!(
            !verify_bit_get(&verify.verify_bits, start_index),
            ErrorCode::InvalidVerifyProgress
        );

        let byte_offset = (start_index as u32) * 32;
        let chunk_nonce = base_nonce + start_index as u128;
        let accumulator_key = ctx.accounts.share_verify_acc.key();
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(chunk_nonce)
            .plaintext_u16(start_index)
            .account(deck_account_pubkey, byte_offset, VERIFY_FOLD_BYTES)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![VerifyDeckHashChunkCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: accumulator_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    pub fn sync_verify_share_hash(ctx: Context<SyncVerifyShareHash>) -> Result<()> {
        let verify = &ctx.accounts.share_verify_acc;
        require!(
            verify.game_id == ctx.accounts.game_state.game_id
                && verify.player_index < ctx.accounts.game_state.num_players,
            ErrorCode::InvalidVerifyProgress
        );
        let share_cards = if verify.share_cards > 0 {
            verify.share_cards
        } else {
            25
        };
        require!(
            verify.verified
                && verify.frozen
                && share_verify_bits_exact(
                    &verify.verify_bits,
                    verify.num_players,
                    share_cards,
                    verify.verify_target,
                )
                && verify.verify_hash_acc == verify.verify_expected,
            ErrorCode::InvalidVerifyProgress
        );
        Ok(())
    }

    /// Bind every consumed Groth16 share receipt to that player's Arcis hash.
    ///
    /// Remaining accounts are pairs `[share_verify_acc, light_proof_receipt]`
    /// in player-index order.
    pub fn finalize_share_phase<'info>(
        ctx: Context<'info, FinalizeSharePhase<'info>>,
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let n = game_state.num_players as usize;
        require!(
            game_state.shared_mask.count_ones() as usize == n,
            ErrorCode::InvalidVerifyProgress
        );
        require!(
            ctx.remaining_accounts.len() == n * 2,
            ErrorCode::InvalidVerifyProgress
        );
        let light_id = light_casino_id();
        let mut round_cards: u16 = game_state.num_cards as u16;
        for player in 0..n {
            let acc_info = &ctx.remaining_accounts[player * 2];
            let receipt_info = &ctx.remaining_accounts[player * 2 + 1];
            let (expected_acc, _) = Pubkey::find_program_address(
                &[b"share_verify_acc", &game_state.game_id, &[player as u8]],
                ctx.program_id,
            );
            require_keys_eq!(acc_info.key(), expected_acc, ErrorCode::InvalidVerifyProgress);
            require!(acc_info.owner == ctx.program_id, ErrorCode::InvalidAccountOwner);
            let mut acc_data = &acc_info.try_borrow_data()?[..];
            let acc = ShareVerifyAccumulator::try_deserialize(&mut acc_data)
                .map_err(|_| error!(ErrorCode::InvalidVerifyProgress))?;
            let share_cards = if acc.share_cards > 0 {
                acc.share_cards
            } else {
                game_state.num_cards
            };
            if player == 0 {
                round_cards = share_cards as u16;
            }
            require!(
                acc.game_id == game_state.game_id
                    && acc.player_index == player as u8
                    && acc.generation > 0,
                ErrorCode::InvalidVerifyProgress
            );

            require!(receipt_info.owner == &light_id, ErrorCode::InvalidProofReceipt);
            let receipt = read_proof_receipt(receipt_info)?;
            // Reject a truncated or unexpected share-hash tail. The Groth16
            // output stays the Poseidon of the partials; the Arcis accumulator
            // is 0, so the two are not compared.
            published_share_tier_count(&receipt_info.try_borrow_data()?)?;
            require!(
                receipt.game_id == game_state.game_id
                    && receipt.phase == PROOF_PHASE_SHARE
                    && receipt.player_index == player as u8
                    && receipt.generation == acc.generation
                    && receipt.status == RECEIPT_STATUS_CONSUMED,
                ErrorCode::InvalidProofReceipt
            );
        }
        // Grow the revealable prefix by this round's Arcis card window (BJ=16).
        game_state.shared_cards = game_state
            .shared_cards
            .saturating_add(round_cards)
            .min(game_state.num_cards as u16);
        game_state.verified = true;
        game_state.share_finalized = true;
        game_state.phase = 3;
        game_state.current_player = 0;
        emit_phase_advanced(game_state);
        // Street betting / reveal is opened by a later `open_preflop`.
        Ok(())
    }

    // ─── Arcium Integration: reveal_card ───

    pub fn init_reveal_card_comp_def(ctx: Context<InitRevealCardCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Create the canonical sealed-limb reveal coverage registry for one
    /// showdown generation and recipient.
    pub fn begin_showdown_material<'a>(
        ctx: Context<'a, BeginShowdownMaterial<'a>>,
        generation: u64,
        recipient_index: u8,
    ) -> Result<()> {
        let game = &ctx.accounts.game_state;
        require_canonical_game_table(&ctx.accounts.table_state, game)?;
        let signer_index = player_index_for_pubkey(
            &ctx.accounts.table_state.seats,
            &ctx.accounts.table_state.hand_seat_order,
            ctx.accounts.table_state.hand_num_players,
            &ctx.accounts.payer.key(),
        )
        .ok_or(error!(ErrorCode::NotInHand))?;
        require!(signer_index == recipient_index, ErrorCode::InvalidRevealRecipient);
        require!(recipient_index < game.num_players, ErrorCode::InvalidSeat);
        let material = &mut ctx.accounts.showdown_material;
        material.game_id = game.game_id;
        material.generation = generation;
        material.recipient_index = recipient_index;
        material.card_filled_bits = 0;
        material.complete = false;
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            ctx.accounts.showdown_material.to_account_info().lamports(),
        )?;
        Ok(())
    }

    /// Synchronize authenticated `RevealedCard` coverage for this showdown.
    ///
    /// Remaining accounts must be exactly the recipient-major `RevealedCard`
    /// PDAs for card indices `0..num_players*2+5`, ordered by card index.
    /// Their resealed ciphertext limbs remain on those PDAs; this registry
    /// records only complete-card coverage and never stores a digest.
    pub fn sync_showdown_material(
        ctx: Context<SyncShowdownMaterial>,
        generation: u64,
        recipient_index: u8,
    ) -> Result<()> {
        let game = &ctx.accounts.game_state;
        require_canonical_game_table(&ctx.accounts.table_state, game)?;
        let signer_index = player_index_for_pubkey(
            &ctx.accounts.table_state.seats,
            &ctx.accounts.table_state.hand_seat_order,
            ctx.accounts.table_state.hand_num_players,
            &ctx.accounts.payer.key(),
        )
        .ok_or(error!(ErrorCode::NotInHand))?;
        require!(signer_index == recipient_index, ErrorCode::InvalidRevealRecipient);
        require!(recipient_index < game.num_players, ErrorCode::InvalidSeat);
        let material = &mut ctx.accounts.showdown_material;
        require!(
            material.game_id == game.game_id
                && material.generation == generation
                && material.recipient_index == recipient_index
                && !material.complete,
            ErrorCode::ShowdownMaterialsNotVerified
        );
        // Remaining accounts are RevealedCard PDAs in game-specific card order.
        // Poker uses the fixed 10-seat layout (holes 0..2n-1 + board 20..=24),
        // not compact 0..2n+4 — reveal_card / share staging use the sparse indices.
        //
        // Blackjack is variable-length: only the used shoe slots (after staged
        // deal/hit reveals) are synced — not the full 24-card window.
        let is_blackjack = ctx.accounts.table_state.game_kind == GameKind::Blackjack as u8;
        let is_bingo = ctx.accounts.table_state.game_kind == GameKind::Bingo as u8;
        let card_indices: Option<Vec<u16>> = if is_blackjack || is_bingo {
            None
        } else {
            Some(match ctx.accounts.table_state.game_kind {
                k if k == GameKind::Roulette as u8 => vec![0],
                k if k == GameKind::Baccarat as u8 => (0..6u16).collect(),
                k if k == GameKind::War as u8 => (0..4u16).collect(),
                k if k == GameKind::Craps as u8 => (0..2u16).collect(),
                k if k == GameKind::Keno as u8 => (0..20u16).collect(),
                k if k == GameKind::Slots as u8 => (0..u16::from(game.num_cards)).collect(),
                _ if game.num_cards == 1 => vec![0],
                _ => poker_in_play_card_indices(game.num_players)?,
            })
        };
        if let Some(ref indices) = card_indices {
            require!(indices.len() <= 52, ErrorCode::InvalidCardIndex);
            require!(
                ctx.remaining_accounts.len() == indices.len(),
                ErrorCode::ShowdownMaterialsNotVerified
            );
        } else {
            let max_var = if is_bingo { 90 } else { 24 };
            require!(
                !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() <= max_var,
                ErrorCode::ShowdownMaterialsNotVerified
            );
        }

        let expected_count = (game.num_players - 1) * 4;
        let mut coverage = 0u64;
        for (slot, revealed_info) in ctx.remaining_accounts.iter().enumerate() {
            require!(
                revealed_info.owner == ctx.program_id,
                ErrorCode::ShowdownMaterialsNotVerified
            );
            let mut data = &revealed_info.try_borrow_data()?[..];
            let revealed = RevealedCard::try_deserialize(&mut data)
                .map_err(|_| error!(ErrorCode::ShowdownMaterialsNotVerified))?;
            let card_index_u16 = if let Some(ref indices) = card_indices {
                indices[slot]
            } else {
                // Blackjack / bingo: PDA card index must match account data.
                let max_idx = if is_bingo { 90 } else { 24 };
                require!(
                    (revealed.card_index as usize) < max_idx,
                    ErrorCode::ShowdownMaterialsNotVerified
                );
                revealed.card_index
            };
            let (expected_revealed, _) = Pubkey::find_program_address(
                &[
                    b"RevealedCard",
                    &game.game_id,
                    &[recipient_index],
                    &card_index_u16.to_le_bytes(),
                ],
                ctx.program_id,
            );
            require_keys_eq!(
                revealed_info.key(),
                expected_revealed,
                ErrorCode::ShowdownMaterialsNotVerified
            );
            // RevealedCard.generation tracks poker `async_generation` at first write
            // (bumped per bet/op). Showdown material binds Light `game_state.generation`
            // instead — do not require the two to match across streets.
            require!(
                revealed.game_id == game.game_id
                    && revealed.recipient_index == recipient_index
                    && revealed.card_index == card_index_u16
                    && revealed.count == expected_count
                    && revealed.filled == expected_count
                    && reveal_prefix_complete(revealed.filled_bits, revealed.count),
                ErrorCode::ShowdownMaterialsNotVerified
            );
            if card_index_u16 < 64 {
                coverage |= 1u64 << card_index_u16;
            }
        }
        material.card_filled_bits = coverage;
        let required = if is_blackjack || is_bingo {
            // Complete once every attached card is filled; Light checks the
            // called-prefix / action-derived mask at showdown verify.
            coverage
        } else {
            match ctx.accounts.table_state.game_kind {
                k if k == GameKind::Roulette as u8
                    || k == GameKind::Baccarat as u8
                    || k == GameKind::War as u8
                    || k == GameKind::Craps as u8
                    || k == GameKind::Keno as u8
                    || k == GameKind::Slots as u8 =>
                {
                    let n = card_indices.as_ref().map(|v| v.len()).unwrap_or(0);
                    (1u64 << n) - 1
                }
                _ if game.num_cards == 1 => 1u64,
                _ => poker_in_play_card_mask(game.num_players)?,
            }
        };
        material.complete = material.card_filled_bits == required;
        Ok(())
    }

    pub fn reveal_card(
        ctx: Context<RevealCard>,
        computation_offset: u64,
        deck_account_pubkey: Pubkey,
        encryption_pubkey: [u8; 32],
        base_nonce: u128,
        card_index: u16,
        start_index: u16,
        from_offset: u8,
        dest_offset: u8,
        chunk_count: u8,
        total_count: u8,
        recipient_index: u8,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            start_index % VERIFY_CHUNK_LEN == 0,
            ErrorCode::InvalidCardIndex
        );
        require!(
            start_index + VERIFY_CHUNK_LEN <= 900,
            ErrorCode::InvalidCardIndex
        );
        require!(
            start_index == card_index.saturating_mul(VERIFY_CHUNK_LEN),
            ErrorCode::InvalidCardIndex
        );
        // Each MPC job reveals at most REVEAL_CARD_LIMBS_PER_JOB (4) so the
        // callback's output signature verify stays under Arx's ~800k CU budget.
        const REVEAL_CARD_LIMBS_PER_JOB: u8 = 4;
        require!(
            from_offset % (VERIFY_FOLD_LEN as u8) == 0
                && (from_offset as u16) + (chunk_count as u16) <= VERIFY_CHUNK_LEN,
            ErrorCode::InvalidCardIndex
        );
        require!(
            (dest_offset as u16) + (chunk_count as u16) <= 36,
            ErrorCode::InvalidCardIndex
        );
        let end = (dest_offset as u16) + (chunk_count as u16);
        require!(end <= total_count as u16, ErrorCode::InvalidCardIndex);
        require!(
            chunk_count > 0 && chunk_count <= REVEAL_CARD_LIMBS_PER_JOB,
            ErrorCode::InvalidCardIndex
        );
        require!(total_count > 0 && total_count <= 36, ErrorCode::InvalidCardIndex);

        let game = &ctx.accounts.game_state;
        require_reveal_deck_staging_account(
            ctx.program_id,
            &game.game_id,
            &deck_account_pubkey,
        )?;
        require!(
            ctx.accounts.deck_staging.key() == deck_account_pubkey,
            ErrorCode::InvalidCardIndex
        );
        require_canonical_game_table(&ctx.accounts.table_state, game)?;
        require!(
            ctx.accounts.table_state.hand_in_progress
                && ctx.accounts.table_state.current_game_id == game.game_id
                && ctx.accounts.table_state.hand_num_players == game.num_players,
            ErrorCode::InvalidRevealRecipient
        );
        let signer_index = player_index_for_pubkey(
            &ctx.accounts.table_state.seats,
            &ctx.accounts.table_state.hand_seat_order,
            ctx.accounts.table_state.hand_num_players,
            &ctx.accounts.recipient.key(),
        )
        .ok_or(error!(ErrorCode::InvalidRevealRecipient))?;
        require!(
            signer_index == recipient_index,
            ErrorCode::InvalidRevealRecipient
        );
        require_card_reveal_allowed_with_cards(
            card_index,
            game.num_players,
            game.num_cards,
            game.betting_phase,
            game.verified,
            recipient_index,
            game.folded_mask,
            game.show_on_fold_mask,
            game.shared_cards,
        )?;
        let expected_count = game.num_players.saturating_sub(1).saturating_mul(4);
        require!(total_count == expected_count, ErrorCode::InvalidCardIndex);

        let game_id = ctx.accounts.game_state.game_id;
        {
            let revealed_card = &mut ctx.accounts.revealed_card;
            if revealed_card.filled_bits == 0 && revealed_card.count == 0 {
                revealed_card.game_id = game_id;
                revealed_card.generation = game.async_generation;
                revealed_card.card_index = card_index;
                revealed_card.recipient_index = recipient_index;
                revealed_card.count = total_count;
                revealed_card.filled = 0;
                revealed_card.filled_bits = 0;
                revealed_card.recipient_authority = ctx.accounts.recipient.key();
                revealed_card.refund_to = ctx.accounts.payer.key();
                revealed_card.pending_operation = PendingOperation::default();
                revealed_card.partials = [[0u8; 32]; 36];
            } else {
                require!(
                    revealed_card.card_index == card_index
                        && revealed_card.recipient_index == recipient_index
                        && revealed_card.count == total_count
                        && revealed_card.recipient_authority == ctx.accounts.recipient.key()
                        && revealed_card.refund_to == ctx.accounts.payer.key(),
                    ErrorCode::InvalidCardIndex
                );
            }
        }

        let slice_start = (start_index as u16).saturating_add(from_offset as u16);
        let chunk_nonce = base_nonce + slice_start as u128;
        let byte_offset = (slice_start as u32) * 32;
        let revealed_card_key = ctx.accounts.revealed_card.key();
        let game_state_key = ctx.accounts.game_state.key();

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(chunk_nonce)
            .plaintext_u8(dest_offset)
            .plaintext_u8(chunk_count)
            .account(deck_account_pubkey, byte_offset, VERIFY_FOLD_BYTES)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealCardCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: revealed_card_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: game_state_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_card")]
    pub fn reveal_card_callback(
        ctx: Context<RevealCardCallback>,
        output: SignedComputationOutputs<RevealCardOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(RevealCardOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };

        // Tuple: (values[4], dest_offset, count) — see REVEAL_CARD_LIMBS_PER_JOB
        let values = o.field_0;
        let dest_offset: u8 = o.field_1;
        let n: u8 = o.field_2;
        require!(n as usize <= values.len(), ErrorCode::InvalidCardIndex);

        let revealed = &mut ctx.accounts.revealed_card;
        let end = (dest_offset as usize)
            .checked_add(n as usize)
            .ok_or(ErrorCode::InvalidCardIndex)?;
        require!(end <= revealed.partials.len(), ErrorCode::InvalidCardIndex);
        require!(end <= revealed.count as usize, ErrorCode::InvalidCardIndex);
        require!(
            reveal_range_unfilled(revealed.filled_bits, dest_offset as usize, n as usize),
            ErrorCode::InvalidVerifyProgress
        );
        let before_complete = reveal_prefix_complete(revealed.filled_bits, revealed.count);
        for j in 0..n as usize {
            let index = dest_offset as usize + j;
            revealed.partials[index] = values[j];
            revealed.filled_bits |= 1u64 << index;
        }
        revealed.filled = revealed.filled_bits.count_ones().min(u8::MAX as u32) as u8;

        let card_index = revealed.card_index;
        if !before_complete && reveal_prefix_complete(revealed.filled_bits, revealed.count) {
            // Credit partial units (n-1), never limb count (n-1)*4 — must match
            // `total_partials = num_cards * (num_players - 1)`.
            let credit = partials_per_card(ctx.accounts.game_state.num_players);
            let game = &mut ctx.accounts.game_state;
            if let Ok(next) = apply_record_reveal_progress(
                game.revealed_partials,
                game.total_partials,
                credit,
            ) {
                game.revealed_partials = next;
            }
            // Emitted once the card's sealed partials are fully written — clients
            // should await this event instead of polling RevealedCard / the callback.
            emit!(RevealCardEvent {
                card_index,
                recipient_index: revealed.recipient_index,
                count: revealed.count,
            });
        }
        Ok(())
    }

    /// Write limb-aligned bytes into the game's `deck_staging` PDA.
    ///
    /// Account seeds bind the target — there is no generic `target` account.
    /// Authority: any seated player; freezes after legacy deck-hash verify
    /// (see [`require_staging_write_authorized`]).
    pub fn write_deck_staging(
        ctx: Context<WriteDeckStaging>,
        game_id: [u8; 32],
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.game_state.game_id == game_id,
            ErrorCode::InvalidGamePhase
        );
        require_staging_write_authorized(
            None,
            &ctx.accounts.authority.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let staging = ctx.accounts.deck_staging.to_account_info();
        require!(staging.owner == &crate::id(), ErrorCode::InvalidAccountOwner);
        let mut target_data = staging.try_borrow_mut_data()?;
        apply_staging_bytes_write(&mut target_data, offset, &data)
    }

    /// Store one packed reveal range in its own chunk account.
    ///
    /// The lane pays for the account, so several chunks can land in one slot.
    /// `absorb_reveal_chunks` copies them into `deck_staging`.
    pub fn write_reveal_chunk(
        ctx: Context<WriteRevealChunk>,
        game_id: [u8; 32],
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.game_state.game_id == game_id,
            ErrorCode::InvalidGamePhase
        );
        require_staging_write_authorized(
            None,
            &ctx.accounts.authority.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let chunk = ctx.accounts.chunk.to_account_info();
        let mut buf = chunk.try_borrow_mut_data()?;
        reveal_chunks::store_reveal_chunk(
            &mut buf,
            &game_id,
            &ctx.accounts.refund.key(),
            offset,
            &data,
        )
    }

    /// Copy packed reveal chunks into `deck_staging` and close them.
    ///
    /// Remaining accounts are `(chunk, refund)` pairs. Rent returns to the
    /// wallet recorded when the chunk was written. The lane that paid for the
    /// account only keeps its signature budget.
    pub fn absorb_reveal_chunks(
        ctx: Context<AbsorbRevealChunks>,
        game_id: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.game_state.game_id == game_id,
            ErrorCode::InvalidGamePhase
        );
        require_staging_write_authorized(
            None,
            &ctx.accounts.authority.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let staging_info = ctx.accounts.deck_staging.to_account_info();
        require!(staging_info.owner == &crate::id(), ErrorCode::InvalidAccountOwner);
        let remaining = ctx.remaining_accounts;
        require!(
            remaining.len() % 2 == 0,
            ErrorCode::InvalidAmount
        );
        {
            let mut staging = staging_info.try_borrow_mut_data()?;
            for pair in remaining.chunks(2) {
                let chunk = &pair[0];
                let refund = &pair[1];
                if chunk.data_is_empty() {
                    continue;
                }
                reveal_chunks::copy_reveal_chunk(&game_id, chunk, refund, &mut staging)?;
            }
        }
        for pair in remaining.chunks(2) {
            let chunk = &pair[0];
            let refund = &pair[1];
            if chunk.data_is_empty() || chunk.owner != &crate::id() {
                continue;
            }
            rent_vault::close_into(chunk, refund)?;
        }
        Ok(())
    }

    /// Write limb-aligned bytes into per-player `share_deck_staging`.
    ///
    /// Account seeds bind `[share_deck_staging, game_id, player_index]`.
    /// Authority: hand seat `player_index` only; freezes after `share_finalized`.
    pub fn write_share_deck_staging(
        ctx: Context<WriteShareDeckStaging>,
        game_id: [u8; 32],
        player_index: u8,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.game_state.game_id == game_id,
            ErrorCode::InvalidGamePhase
        );
        require_staging_write_authorized(
            Some(player_index),
            &ctx.accounts.authority.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let staging = ctx.accounts.share_deck_staging.to_account_info();
        require!(staging.owner == &crate::id(), ErrorCode::InvalidAccountOwner);
        let mut target_data = staging.try_borrow_mut_data()?;
        apply_staging_bytes_write(&mut target_data, offset, &data)
    }

    /// Initialize a GameState PDA to track verification and reveal progress.
    ///
    /// Call this once at game start, before any Arcis operations.
    /// `num_players` determines how many partials each card needs (n-1).
    pub fn initialize_game(
        ctx: Context<InitializeGame>,
        game_id: [u8; 32],
        num_players: u8,
        num_cards: u8,
    ) -> Result<()> {
        require!(
            is_betting_round_authority(&ctx.accounts.payer.key()),
            ErrorCode::InvalidAuthority
        );
        let seat_cap = shared_zk_ids::max_players_for_reveal_cards(num_cards);
        require!(
            (2..=seat_cap).contains(&num_players),
            ErrorCode::InvalidCardIndex
        );
        let game_state = &mut ctx.accounts.game_state;
        game_state.verified = false;
        game_state.share_finalized = false;
        game_state.shared_cards = 0;
        game_state.showdown_finalized = false;
        game_state.hash = 0;
        game_state.game_id = game_id;
        game_state.async_generation = 0;
        game_state.phase = PROOF_PHASE_REGISTER;
        game_state.num_players = num_players;
        game_state.num_cards = num_cards;
        game_state.current_player = 0;
        game_state.betting_phase = 0;
        game_state.reached_flop = false;
        game_state.rake_bps = 0;
        game_state.rake_amount = 0;
        game_state.current_bet = 0;
        game_state.last_aggressor = 0;
        game_state.last_aggressor_amount = 0;
        game_state.folded_mask = 0;
        game_state.show_on_fold_mask = 0;
        game_state.all_in_mask = 0;
        game_state.shared_mask = 0;
        game_state.acted_mask = 0;
        game_state.hand_commits = [0u64; 10];
        game_state.player_total_bets = [0u64; 10];
        game_state.pots = [0u64; 9];
        game_state.pot_eligible_masks = [0u16; 9];
        game_state.refunds = [0u64; 10];
        game_state.pot_count = 0;
        game_state.showdown_hash = [0u8; 32];
        game_state.showdown_finalized = false;
        game_state.showdown_hash_player = 0;
        game_state.bet_pending = false;
        game_state.bet_pending_operation = PendingOperation::default();
        game_state.settlement_pending_operation = PendingOperation::default();
        game_state.payouts = [0u64; 10];
        game_state.verify_hash_acc = [0u8; 32];
        game_state.verify_expected = [0u8; 32];
        game_state.verify_progress = 0;
        game_state.verify_bits = [0u64; 15];
        game_state.verify_started = false;
        game_state.pot_mask = if num_players >= 16 { u16::MAX } else { (1u16 << num_players) - 1 };
        // Total partials to reveal = cards × (players - 1)
        game_state.total_partials = num_cards.saturating_mul(num_players.saturating_sub(1));
        game_state.revealed_partials = 0;
        // Provisional; overwritten by `create_deck_staging` with the rent payer.
        game_state.staging_authority = ctx.accounts.payer.key();
        emit!(HandStartedEvent {
            game_id,
            num_players,
        });
        emit_phase_advanced(game_state);
        emit_player_action_required(game_state);
        Ok(())
    }

    /// Create a staging PDA for encrypted deck data.
    ///
    /// The PDA size depends on the number of players:
    ///   - 2 players:  25 cards × 4 values  = 100 values  = 3,200 bytes
    ///   - 5 players:  25 cards × 16 values = 400 values  = 12,800 bytes
    ///   - 10 players: 25 cards × 36 values = 900 values  = 28,800 bytes
    ///
    /// Rent is fully refunded when the PDA is closed via `close_deck_staging`.
    /// Create a staging PDA for encrypted deck data (first chunk).
    ///
    /// Solana caps CPI realloc at 10 KiB per instruction, so the full
    /// 28,840-byte staging account is grown via `extend_deck_staging`.
    /// Uses `UncheckedAccount` so Anchor does not stack-allocate
    /// `[[u8;32];900]` on init.
    ///
    /// Rent is fully refunded when the PDA is closed via `close_deck_staging`.
    pub fn create_deck_staging(
        ctx: Context<CreateDeckStaging>,
        _game_id: [u8; 32],
    ) -> Result<()> {
        // UncheckedAccount is zero-initialized by the system program.
        // Arcis verify_deck_hash_chunk reads VERIFY_CHUNK_LEN commitments at start_index * 32;
        // Typed staging writers also start at 0 — no header is required here.
        let _ = &ctx.accounts.deck_staging;
        require_staging_authority(
            &ctx.accounts.payer.key(),
            &ctx.accounts.game_state,
        )?;
        Ok(())
    }

    pub fn create_share_deck_staging<'a>(
        ctx: Context<'a, CreateShareDeckStaging<'a>>,
        _game_id: [u8; 32],
        player_index: u8,
    ) -> Result<()> {
        require_staging_write_authorized(
            Some(player_index),
            &ctx.accounts.payer.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let paid = ctx.accounts.share_deck_staging.to_account_info().lamports();
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            paid,
        )?;
        Ok(())
    }

    /// Grow `deck_staging` by up to 10 KiB toward [`DECK_STAGING_ACCOUNT_SIZE`].
    ///
    /// Call repeatedly after `create_deck_staging` until
    /// `account.data_len() == DECK_STAGING_ACCOUNT_SIZE`.
    pub fn extend_deck_staging(ctx: Context<ExtendDeckStaging>) -> Result<()> {
        let staging = ctx.accounts.deck_staging.to_account_info();
        let current = staging.data_len();
        require!(
            current < DECK_STAGING_ACCOUNT_SIZE,
            ErrorCode::WriteExceedsBounds
        );
        let next = (current + MAX_CPI_ALLOC)
            .min(DECK_STAGING_ACCOUNT_SIZE);
        let extra = next.saturating_sub(current);
        if extra == 0 {
            return Ok(());
        }

        let rent = Rent::get()?;
        let needed = rent.minimum_balance(next);
        let have = staging.lamports();
        if needed > have {
            let top_up = needed - have;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: staging.clone(),
                    },
                ),
                top_up,
            )?;
        }

        staging.resize(next)?;
        Ok(())
    }

    pub fn extend_share_deck_staging<'a>(
        ctx: Context<'a, ExtendShareDeckStaging<'a>>,
        _player_index: u8,
    ) -> Result<()> {
        let staging = ctx.accounts.share_deck_staging.to_account_info();
        let before = staging.lamports();
        let current = staging.data_len();
        require!(
            current < DECK_STAGING_ACCOUNT_SIZE,
            ErrorCode::WriteExceedsBounds
        );
        let next = (current + MAX_CPI_ALLOC).min(DECK_STAGING_ACCOUNT_SIZE);
        let needed = Rent::get()?.minimum_balance(next);
        let have = staging.lamports();
        if needed > have {
            let cpi = anchor_lang::system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: staging.clone(),
            };
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.key(), cpi),
                needed - have,
            )?;
        }
        staging.resize(next)?;
        let paid = staging.lamports().saturating_sub(before);
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            paid,
        )?;
        Ok(())
    }

    /// Close a per-player `share_deck_staging` PDA after `finalize_share_phase`.
    ///
    /// Authority must be `game_state.staging_authority` (staging rent payer).
    /// Rent is refunded only to that key — prevents outsider rent theft.
    pub fn close_share_deck_staging<'a>(
        ctx: Context<'a, CloseShareDeckStaging<'a>>,
        _player_index: u8,
    ) -> Result<()> {
        require_share_staging_close_authorized(
            &ctx.accounts.authority.key(),
            _player_index,
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
        )?;
        let staging = ctx.accounts.share_deck_staging.to_account_info();
        let authority = ctx.accounts.authority.to_account_info();
        let dest = rent_vault::share_refund_account(
            ctx.remaining_accounts,
            &ctx.accounts.game_state.table_room_id,
            &ctx.accounts.authority.key(),
            authority,
        )?;
        let rent = staging.lamports();
        **dest.lamports.borrow_mut() = dest
            .lamports()
            .checked_add(rent)
            .ok_or(ErrorCode::InvalidAmount)?;
        **staging.lamports.borrow_mut() = 0;
        staging.assign(&anchor_lang::system_program::ID);
        staging.resize(0)?;
        Ok(())
    }

    /// Record that partials have been revealed.
    ///
    /// Call this after each successful Arcis reveal callback and Light Protocol
    /// storage. `count` is the number of partials revealed (not cards).
    /// For a `reveal_card` call that returns all partials for one card,
    /// count = num_players - 1.
    ///
    /// Authority must be `game_state.staging_authority` (deck staging rent payer).
    /// `count` is in partial units (not limbs) and cannot exceed remaining total.
    pub fn record_reveal(ctx: Context<RecordReveal>, count: u8) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require_staging_authority(&ctx.accounts.authority.key(), game_state)?;
        game_state.revealed_partials = apply_record_reveal_progress(
            game_state.revealed_partials,
            game_state.total_partials,
            count,
        )?;
        Ok(())
    }

    /// Close the deck staging PDA and refund all rent to the staging authority.
    ///
    /// Can only be called after all partials have been revealed and showdown
    /// has been accepted. Phase 5 is that showdown. Poker later advances to
    /// phase 6, and house settlement sets `SETTLEMENT_SETTLED` without that
    /// advance. Bingo settles the buy-in pot without a dealer pool, so it
    /// stays on phase 5.
    /// Authority must be `game_state.staging_authority` (deck staging rent payer).
    pub fn close_deck_staging<'a>(ctx: Context<'a, CloseDeckStaging<'a>>) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require_staging_authority(&ctx.accounts.authority.key(), game_state)?;
        require!(
            game_state.phase >= 5
                || game_state.settlement_status == SETTLEMENT_SETTLED,
            ErrorCode::InvalidGamePhase
        );
        require_reveals_complete(game_state)?;
        // Manual close — UncheckedAccount avoids deserializing 28,800-byte commitments.
        let staging = ctx.accounts.deck_staging.to_account_info();
        let authority = ctx.accounts.authority.to_account_info();
        let dest = rent_vault::share_refund_account(
            ctx.remaining_accounts,
            &ctx.accounts.game_state.table_room_id,
            &ctx.accounts.authority.key(),
            authority,
        )?;
        let rent = staging.lamports();
        **dest.lamports.borrow_mut() = dest
            .lamports()
            .checked_add(rent)
            .ok_or(ErrorCode::WriteExceedsBounds)?;
        **staging.lamports.borrow_mut() = 0;
        staging.assign(&anchor_lang::system_program::ID);
        staging.resize(0)?;
        Ok(())
    }

    /// Close a `RevealedCard` PDA and refund rent to the authority.
    pub fn close_revealed_card(ctx: Context<CloseRevealedCard>) -> Result<()> {
        require_revealed_card_close_authorized(
            &ctx.accounts.authority.key(),
            &ctx.accounts.table_state,
            &ctx.accounts.game_state,
            &ctx.accounts.revealed_card,
        )
    }

    // ─── Casino factory ───

    /// CAdmin opens a tenant bound to this program and light-casino.
    pub fn create_casino(ctx: Context<CreateCasino>, casino_id: [u8; 32]) -> Result<()> {
        let casino = &mut ctx.accounts.casino;
        casino.casino_id = casino_id;
        casino.casino_program = crate::ID;
        casino.light_casino_program = casino_factory::light_casino_program();
        casino.bump = ctx.bumps.casino;
        casino_factory::require_protocol_casino(casino)
    }

    /// CAdmin delegates a key that may administer this casino's rooms and tables.
    pub fn add_casino_admin(ctx: Context<AddCasinoAdmin>, casino_id: [u8; 32]) -> Result<()> {
        require!(ctx.accounts.casino.casino_id == casino_id, ErrorCode::InvalidCasino);
        casino_factory::require_protocol_casino(&ctx.accounts.casino)?;
        let entry = &mut ctx.accounts.casino_admin;
        entry.casino_id = casino_id;
        entry.admin = ctx.accounts.admin_key.key();
        entry.bump = ctx.bumps.casino_admin;
        Ok(())
    }

    pub fn remove_casino_admin(_ctx: Context<RemoveCasinoAdmin>) -> Result<()> {
        Ok(())
    }

    /// A delegated casino admin registers a dealer key for one game kind.
    pub fn add_casino_dealer(
        ctx: Context<AddCasinoDealer>,
        casino_id: [u8; 32],
        game_kind: u8,
    ) -> Result<()> {
        require!(ctx.accounts.casino.casino_id == casino_id, ErrorCode::InvalidCasino);
        casino_factory::require_protocol_casino(&ctx.accounts.casino)?;
        require!(GameKind::from_u8(game_kind).is_some(), ErrorCode::InvalidGameKind);
        let entry = &mut ctx.accounts.casino_dealer;
        entry.casino_id = casino_id;
        entry.game_kind = game_kind;
        entry.dealer = ctx.accounts.dealer.key();
        entry.bump = ctx.bumps.casino_dealer;
        Ok(())
    }

    pub fn remove_casino_dealer(ctx: Context<RemoveCasinoDealer>) -> Result<()> {
        casino_factory::require_protocol_casino(&ctx.accounts.casino)?;
        require!(
            ctx.accounts.casino.casino_id == ctx.accounts.casino_dealer.casino_id,
            ErrorCode::InvalidCasino
        );
        Ok(())
    }

    // ─── Room / Table / Wallet Lifecycle ───

    pub fn create_room(
        ctx: Context<CreateRoom>,
        room_id: [u8; 32],
        small_blind_default: u64,
    ) -> Result<()> {
        let room = &mut ctx.accounts.room;
        room.room_id = room_id;
        room.authority = bind_room_authority(
            &ctx.accounts.authority.key(),
            ctx.remaining_accounts,
        )?;
        room.mint = ctx.accounts.mint.key();
        room.vault = ctx.accounts.vault.key();
        room.table_count = 0;
        room.small_blind_default = small_blind_default;
        room.rake_bps = 0;
        room.house = Pubkey::default();
        Ok(())
    }

    /// Room authority sets the poker flop rake. `0` is the default and takes nothing.
    /// A non-zero rate records the whitelisted house that must later open its own
    /// encrypted room wallet and SPL token account.
    pub fn set_room_rake(ctx: Context<SetRoomRake>, rake_bps: u16) -> Result<()> {
        authorize_room_operator(
            &ctx.accounts.authority.key(),
            &ctx.accounts.room.authority,
            ctx.remaining_accounts,
        )?;
        require!(rake_bps <= 10_000, ErrorCode::InvalidAmount);
        if rake_bps > 0 {
            let house = ctx
                .accounts
                .house
                .as_ref()
                .ok_or(error!(ErrorCode::HouseRakeWalletMissing))?;
            let entry = ctx
                .accounts
                .whitelist_entry
                .as_ref()
                .ok_or(error!(ErrorCode::NotWhitelisted))?;
            require!(
                house.key() != Pubkey::default(),
                ErrorCode::HouseRakeWalletMissing
            );
            verify_whitelisted(entry, &ctx.accounts.room.room_id, &house.key())?;
            ctx.accounts.room.house = house.key();
        }
        ctx.accounts.room.rake_bps = rake_bps;
        Ok(())
    }

    /// Add a player pubkey to the room whitelist. Only [`WHITELIST_ADMIN`] may call.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>, room_id: [u8; 32]) -> Result<()> {
        authorize_room_operator(
            &ctx.accounts.admin.key(),
            &ctx.accounts.room.authority,
            ctx.remaining_accounts,
        )?;
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.room_id = room_id;
        entry.player = ctx.accounts.player_to_whitelist.key();
        emit!(WhitelistAdded {
            room_id,
            player: entry.player,
        });
        Ok(())
    }

    /// Remove a player from the room whitelist. Only [`WHITELIST_ADMIN`] may call.
    pub fn remove_from_whitelist(ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        authorize_whitelist_removal(
            &ctx.accounts.admin.key(),
            &ctx.accounts.whitelist_entry.room_id,
            ctx.remaining_accounts,
        )
    }

    pub fn create_table(
        ctx: Context<CreateTable>,
        game_kind: u8,
        shoe_decks: u8,
        roulette_variant: u8,
        min_bet: u64,
        max_bet: u64,
        bet_unit: u64,
    ) -> Result<()> {
        authorize_room_operator(
            &ctx.accounts.authority.key(),
            &ctx.accounts.room.authority,
            ctx.remaining_accounts,
        )?;
        let config = GameConfig::from_raw(game_kind, shoe_decks, roulette_variant)
            .ok_or(error!(ErrorCode::InvalidGameKind))?;
        if config.kind == GameKind::Roulette {
            require!(min_bet > 0 && min_bet <= max_bet, ErrorCode::InvalidAmount);
        } else if max_bet > 0 {
            require!(min_bet <= max_bet, ErrorCode::InvalidAmount);
        }
        let room = &mut ctx.accounts.room;
        let table_id = room.table_count;
        room.table_count = room.table_count.saturating_add(1);
        // Bet limits are stored on `DealerPool` at `init_dealer_pool` (same args
        // forwarded from TS createTable → initDealerPool).
        let _ = (min_bet, max_bet, bet_unit);
        ctx.accounts.table_state.set_inner(TableState::init(
            room.room_id,
            table_id,
            config.kind as u8,
            config.shoe_decks,
            config.roulette_variant,
        ));
        Ok(())
    }

    pub fn init_room_wallet(ctx: Context<InitRoomWallet>, room_id: [u8; 32]) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &room_id,
            &ctx.accounts.player.key(),
        )?;
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.player = ctx.accounts.player.key();
        wallet.room_id = room_id;
        wallet.balance_ciphertext = [0u8; 32];
        wallet.nonce = 0;
        wallet.active_tables = 0;
        wallet.in_hand_tables = 0;
        wallet.balance_u64 = 0;
        wallet.pending_mirror_credit = 0;
        wallet.encryption_pubkey = [0u8; 32];
        Ok(())
    }

    /// Localnet / test faucet: credit a player's personal room escrow (`balance_u64`).
    /// Does not move SPL — use `deposit_spl` + `request_credit_room_balance` for vault-backed
    /// encrypted credits. Whitelisted player (or room admin via payer) may call.
    /// Testing builds only — must not ship in release (inflates plaintext escrow).
    #[cfg(feature = "testing")]
    pub fn faucet_credit_personal(
        ctx: Context<FaucetCreditPersonal>,
        amount: u64,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_u64 = wallet
            .balance_u64
            .checked_add(amount)
            .ok_or(ErrorCode::InvalidAmount)?;
        emit!(EscrowFundedEvent {
            player: ctx.accounts.player.key(),
            personal_delta: amount,
            seat_delta: 0,
            kind: ESCROW_KIND_FAUCET,
        });
        Ok(())
    }

    /// Transfer chips from personal room escrow into this seat's table escrow.
    /// Rejected while the player is in an active hand at this table.
    /// Testing-only: plaintext ledger move (diverges from Enc). Release uses
    /// `lock_table_buyin` Enc path instead.
    #[cfg(feature = "testing")]
    pub fn transfer_personal_to_seat(
        ctx: Context<TransferPersonalToSeat>,
        amount: u64,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room_wallet.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(ctx.accounts.table_escrow.is_seated, ErrorCode::NotSeated);
        let bit = table_bit(ctx.accounts.table_escrow.table_id)?;
        require!(
            ctx.accounts.room_wallet.in_hand_tables & bit == 0,
            ErrorCode::InActiveHand
        );
        require!(
            !ctx.accounts.table_state.hand_in_progress
                || !player_in_active_hand(
                    &ctx.accounts.table_state.seats,
                    &ctx.accounts.table_state.hand_seat_order,
                    ctx.accounts.table_state.hand_num_players,
                    ctx.accounts.table_state.hand_in_progress,
                    &ctx.accounts.player.key(),
                ),
            ErrorCode::InActiveHand
        );

        let wallet = &mut ctx.accounts.room_wallet;
        require!(wallet.balance_u64 >= amount, ErrorCode::InsufficientBalance);
        wallet.balance_u64 -= amount;
        let escrow = &mut ctx.accounts.table_escrow;
        escrow.balance_u64 = escrow
            .balance_u64
            .checked_add(amount)
            .ok_or(ErrorCode::InvalidAmount)?;
        emit!(EscrowFundedEvent {
            player: ctx.accounts.player.key(),
            personal_delta: 0,
            seat_delta: amount,
            kind: ESCROW_KIND_PERSONAL_TO_SEAT,
        });
        Ok(())
    }

    /// Return seat escrow chips to personal room escrow.
    /// Rejected while a hand is in progress for this player/table (seat is locked to pot).
    /// Testing-only: plaintext ledger move (diverges from Enc). Release uses
    /// `unlock_table` Enc path instead.
    #[cfg(feature = "testing")]
    pub fn transfer_seat_to_personal(
        ctx: Context<TransferSeatToPersonal>,
        amount: u64,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room_wallet.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(ctx.accounts.table_escrow.is_seated, ErrorCode::NotSeated);
        let bit = table_bit(ctx.accounts.table_escrow.table_id)?;
        require!(
            ctx.accounts.room_wallet.in_hand_tables & bit == 0,
            ErrorCode::InActiveHand
        );
        require!(
            !ctx.accounts.table_state.hand_in_progress
                || !player_in_active_hand(
                    &ctx.accounts.table_state.seats,
                    &ctx.accounts.table_state.hand_seat_order,
                    ctx.accounts.table_state.hand_num_players,
                    ctx.accounts.table_state.hand_in_progress,
                    &ctx.accounts.player.key(),
                ),
            ErrorCode::InActiveHand
        );

        let escrow = &mut ctx.accounts.table_escrow;
        require!(escrow.balance_u64 >= amount, ErrorCode::InsufficientBalance);
        escrow.balance_u64 -= amount;
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_u64 = wallet
            .balance_u64
            .checked_add(amount)
            .ok_or(ErrorCode::InvalidAmount)?;
        emit!(EscrowFundedEvent {
            player: ctx.accounts.player.key(),
            personal_delta: amount,
            seat_delta: 0,
            kind: ESCROW_KIND_SEAT_TO_PERSONAL,
        });
        Ok(())
    }

    /// Legacy alias for init_room_wallet.
    pub fn buy_in_room(ctx: Context<InitRoomWallet>, room_id: [u8; 32], _amount: u64) -> Result<()> {
        init_room_wallet(ctx, room_id)
    }

    pub fn create_shielded_wallet(ctx: Context<CreateShieldedWallet>) -> Result<()> {
        let wallet = &mut ctx.accounts.shielded_wallet;
        wallet.player = ctx.accounts.player.key();
        wallet.balance_ciphertext = [0u8; 32];
        wallet.nonce = 0;
        Ok(())
    }

    pub fn deposit_spl<'a>(ctx: Context<'a, DepositSpl<'a>>, amount: u64) -> Result<()> {
        let created = ctx.accounts.pending_deposit.player == Pubkey::default()
            && ctx.accounts.pending_deposit.amount == 0;
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        transfer_to_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.player_token_account,
            &ctx.accounts.vault,
            &ctx.accounts.player,
            amount,
        )?;
        // Accrue one-time credit entitlement (consumed by request_credit_room_balance).
        let pending = &mut ctx.accounts.pending_deposit;
        if pending.amount == 0 && pending.player == Pubkey::default() {
            pending.player = ctx.accounts.player.key();
            pending.room_id = ctx.accounts.room.room_id;
        }
        require!(
            pending.player == ctx.accounts.player.key()
                && pending.room_id == ctx.accounts.room.room_id,
            ErrorCode::NoPendingDeposit
        );
        pending.amount = accrue_pending_deposit(pending.amount, amount)
            .ok_or(ErrorCode::InvalidAmount)?;
        emit!(DepositEvent {
            room_id: ctx.accounts.room.room_id,
            player: ctx.accounts.player.key(),
            amount,
        });
        if created {
            rent_vault::reimburse(
                ctx.remaining_accounts,
                &ctx.accounts.player.to_account_info(),
                ctx.accounts.pending_deposit.to_account_info().lamports(),
            )?;
        }
        Ok(())
    }

    pub fn request_credit_room_balance<'a>(
        ctx: Context<'a, RequestCreditRoomBalance<'a>>,
        computation_offset: u64,
        deposit_amount: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.payer.key(),
        )?;
        // Credit amount is derived from PendingDeposit (SPL-backed), not minted
        // from a free-form caller argument. `deposit_amount` must match exactly.
        let pending = &mut ctx.accounts.pending_deposit;
        require!(
            pending.player == ctx.accounts.payer.key()
                && pending.room_id == ctx.accounts.room.room_id,
            ErrorCode::NoPendingDeposit
        );
        let credit = consume_pending_deposit(pending.amount, deposit_amount)
            .ok_or(ErrorCode::NoPendingDeposit)?;
        pending.amount = 0;
        // Stash credit for plaintext mirror — applied only after Enc callback.
        require!(
            ctx.accounts.room_wallet.pending_mirror_credit == 0,
            ErrorCode::InvalidAmount
        );
        ctx.accounts.room_wallet.pending_mirror_credit = credit;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.room_wallet.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .plaintext_u64(credit)
            .build();
        let room_wallet_key = ctx.accounts.room_wallet.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CreditRoomBalanceCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: room_wallet_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        let paid = ctx.accounts.computation_account.to_account_info().lamports();
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            paid,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "credit_room_balance")]
    pub fn credit_room_balance_callback(
        ctx: Context<CreditRoomBalanceCallback>,
        output: SignedComputationOutputs<CreditRoomBalanceOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(CreditRoomBalanceOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.ciphertexts[0];
        wallet.nonce = o.nonce;
        // V7: plaintext mirror only after Enc success.
        let credit = wallet.pending_mirror_credit;
        if credit > 0 {
            wallet.balance_u64 =
                mirror_credit(wallet.balance_u64, credit).ok_or(ErrorCode::InvalidAmount)?;
            wallet.pending_mirror_credit = 0;
        }
        Ok(())
    }

    /// Move the flop rake into the house's encrypted wallet.
    ///
    /// The house must already have called `init_room_wallet`, bound an encryption
    /// key, and created an SPL token account for the room mint. The circuit
    /// recomputes `floor(gross * rake_bps / 10_000)` and the callback rejects
    /// any other amount.
    pub fn credit_poker_rake<'a>(
        ctx: Context<'a, CreditPokerRake<'a>>,
        computation_offset: u64,
    ) -> Result<()> {
        let table_kind = ctx.accounts.table_state.game_kind;
        require!(table_kind == GameKind::Poker as u8, ErrorCode::InvalidGameKind);
        let reached_flop = ctx.accounts.game_state.reached_flop;
        let rake_bps = ctx.accounts.game_state.rake_bps;
        let rake_amount = ctx.accounts.game_state.rake_amount;
        let pots = ctx.accounts.game_state.pots;
        require!(reached_flop, ErrorCode::InvalidGamePhase);
        require!(rake_bps > 0, ErrorCode::InvalidAmount);
        require!(rake_amount > 0, ErrorCode::InvalidAmount);
        let house = ctx.accounts.room.house;
        let mint = ctx.accounts.room.mint;
        require!(house != Pubkey::default(), ErrorCode::HouseRakeWalletMissing);
        require!(
            house == ctx.accounts.house_wallet.player,
            ErrorCode::HouseRakeWalletMissing
        );
        require!(
            ctx.accounts.house_wallet.encryption_pubkey != [0u8; 32],
            ErrorCode::HouseRakeWalletMissing
        );
        require!(
            ctx.accounts.house_token_account.owner == house
                && ctx.accounts.house_token_account.mint == mint,
            ErrorCode::HouseRakeWalletMissing
        );
        let gross = pots
            .iter()
            .try_fold(rake_amount, |sum, pot| sum.checked_add(*pot))
            .ok_or(error!(ErrorCode::InvalidAmount))?;
        let expected = pot::poker_rake_lamports(gross, rake_bps, true);
        require!(expected == rake_amount, ErrorCode::InvalidCanonicalPot);
        require!(
            ctx.accounts.house_wallet.pending_mirror_credit == 0,
            ErrorCode::InvalidAmount
        );
        let pubkey = ctx.accounts.house_wallet.encryption_pubkey;
        let nonce = ctx.accounts.house_wallet.nonce;
        let ciphertext = ctx.accounts.house_wallet.balance_ciphertext;
        ctx.accounts.house_wallet.pending_mirror_credit = expected;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ciphertext)
            .plaintext_u64(expected)
            .build();
        let house_wallet_key = ctx.accounts.house_wallet.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![CreditRoomBalanceCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: house_wallet_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        let paid = ctx.accounts.computation_account.to_account_info().lamports();
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            paid,
        )?;
        Ok(())
    }

    /// Register the owner's own key as the room session. It stays valid until
    /// `close_room_session`. No clock expiry.
    pub fn open_room_session(ctx: Context<OpenRoomSession>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        session::init_session(
            &mut ctx.accounts.room_session,
            &mut ctx.accounts.room_session_lock,
            ctx.accounts.room.room_id,
            owner,
            owner,
        )
        .map_err(session::map_session_error)
    }

    /// The owner authorizes a different key for this room and whitelists it.
    /// That key is the seat. The owner's lock still allows only one of their
    /// session keys to play.
    pub fn open_delegated_room_session(
        ctx: Context<OpenDelegatedRoomSession>,
    ) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let session_key = ctx.accounts.session.key();
        require!(session_key != owner, ErrorCode::InvalidSessionKey);
        let entry = &mut ctx.accounts.session_whitelist;
        if entry.player == Pubkey::default() {
            entry.room_id = ctx.accounts.room.room_id;
            entry.player = session_key;
        }
        require!(
            entry.player == session_key && entry.room_id == ctx.accounts.room.room_id,
            ErrorCode::InvalidSessionKey
        );
        session::init_session(
            &mut ctx.accounts.room_session,
            &mut ctx.accounts.room_session_lock,
            ctx.accounts.room.room_id,
            owner,
            session_key,
        )
        .map_err(session::map_session_error)
    }

    /// Owner reclaim. Refused while the session is seated.
    pub fn close_room_session(_ctx: Context<CloseRoomSession>) -> Result<()> {
        Ok(())
    }

    pub fn sit_at_table(
        ctx: Context<SitAtTable>,
        physical_seat: u8,
        buy_in: u64,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.player.key(),
        )?;
        let table = &mut ctx.accounts.table_state;
        let player_key = ctx.accounts.player.key();
        table.assign_seat(physical_seat, player_key)?;
        session::begin_play(
            &mut ctx.accounts.room_session,
            &mut ctx.accounts.room_session_lock,
            table.table_id,
        )
        .map_err(session::map_session_error)?;

        let bit = table_bit(table.table_id)?;
        let room_wallet = &mut ctx.accounts.room_wallet;
        require!(room_wallet.active_tables & bit == 0, ErrorCode::AlreadySeated);
        room_wallet.active_tables |= bit;

        open_table_escrow(
            &mut ctx.accounts.table_escrow,
            player_key,
            table.room_id,
            table.table_id,
        )
        .map_err(|err| match err {
            TableEscrowSitError::AlreadySeated => error!(ErrorCode::AlreadySeated),
            TableEscrowSitError::ChipsStillLocked => error!(ErrorCode::InvalidAmount),
        })?;

        table.refresh_pending_order();
        let _ = buy_in;
        Ok(())
    }

    pub fn lock_table_buyin(
        ctx: Context<LockTableBuyin>,
        buy_in: u64,
        computation_offset: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room_wallet.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(buy_in > 0, ErrorCode::InvalidAmount);
        let bit = table_bit(ctx.accounts.table_escrow.table_id)?;
        require!(
            ctx.accounts.room_wallet.in_hand_tables & bit == 0,
            ErrorCode::InActiveHand
        );
        // Soft precheck that mirrors are in sync before queueing Enc (Enc is SoT).
        // Plaintext stacks move only in the callback after Enc succeeds.
        require!(
            ctx.accounts.room_wallet.balance_u64 >= buy_in,
            ErrorCode::InsufficientBalance
        );
        require!(
            ctx.accounts.table_escrow.pending_buy_in == 0,
            ErrorCode::InvalidAmount
        );
        ctx.accounts.table_escrow.pending_buy_in = buy_in;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.room_wallet.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.table_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        // Each Enc<Shared, _> needs its own Shared header (x25519 + nonce).
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.table_escrow.balance_ciphertext)
            .plaintext_u64(buy_in)
            .build();
        let room_wallet_key = ctx.accounts.room_wallet.key();
        let table_escrow_key = ctx.accounts.table_escrow.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![LockTableBuyinCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: room_wallet_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: table_escrow_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "lock_table_buyin")]
    pub fn lock_table_buyin_callback(
        ctx: Context<LockTableBuyinCallback>,
        output: SignedComputationOutputs<LockTableBuyinOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(LockTableBuyinOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.field_0.ciphertexts[0];
        wallet.nonce = o.field_0.nonce;
        let escrow = &mut ctx.accounts.table_escrow;
        escrow.balance_ciphertext = o.field_1.ciphertexts[0];
        escrow.nonce = wallet.nonce.wrapping_add(1);
        // V7: apply plaintext mirror only after Enc callback (same no-mint policy).
        let buy_in = escrow.pending_buy_in;
        if buy_in > 0 {
            let (room, table) =
                apply_lock_table_buyin(wallet.balance_u64, escrow.balance_u64, buy_in);
            wallet.balance_u64 = room;
            escrow.balance_u64 = table;
            escrow.pending_buy_in = 0;
        }
        Ok(())
    }

    pub fn leave_table<'a>(ctx: Context<'a, LeaveTable<'a>>) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.table_state.room_id,
            &ctx.accounts.player.key(),
        )?;
        let table = &mut ctx.accounts.table_state;
        let player_key = ctx.accounts.player.key();
        require!(
            !player_in_active_hand(
                &table.seats,
                &table.hand_seat_order,
                table.hand_num_players,
                table.hand_in_progress,
                &player_key,
            ),
            ErrorCode::InActiveHand
        );

        let table_id = table.table_id;
        table.clear_seat(&player_key)?;
        table.refresh_pending_order();
        session::end_play(
            &mut ctx.accounts.room_session,
            &mut ctx.accounts.room_session_lock,
            table_id,
        )
        .map_err(session::map_session_error)?;

        let bit = table_bit(table_id)?;
        // V7: seat chips return via Enc `unlock_table` only — refuse plaintext drain.
        require!(
            ctx.accounts.table_escrow.balance_u64 == 0
                && ctx.accounts.table_escrow.pending_buy_in == 0,
            ErrorCode::InvalidAmount
        );
        {
            let room_wallet = &mut ctx.accounts.room_wallet;
            room_wallet.active_tables &= !bit;
            room_wallet.in_hand_tables &= !bit;
        }
        let escrow = &mut ctx.accounts.table_escrow;
        escrow.is_seated = false;
        rent_vault::settle(ctx.remaining_accounts, &ctx.accounts.player.to_account_info())?;
        Ok(())
    }

    /// Drop the in-hand flag between hands and return the rent vault to the player.
    /// The seat and chip balance stay.
    pub fn sit_out<'a>(ctx: Context<'a, LeaveTable<'a>>) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.table_state.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(ctx.accounts.table_escrow.is_seated, ErrorCode::NotSeated);
        let table = &ctx.accounts.table_state;
        let player_key = ctx.accounts.player.key();
        let seated = table_bit(table.table_id)?;
        require!(
            ctx.accounts.room_session.active_tables & seated != 0
                && ctx.accounts.room_session_lock.occupied_tables & seated != 0,
            ErrorCode::SessionNotPlaying
        );
        require!(
            !player_in_active_hand(
                &table.seats,
                &table.hand_seat_order,
                table.hand_num_players,
                table.hand_in_progress,
                &player_key,
            ),
            ErrorCode::InActiveHand
        );
        let bit = table_bit(table.table_id)?;
        ctx.accounts.room_wallet.in_hand_tables &= !bit;
        rent_vault::settle(ctx.remaining_accounts, &ctx.accounts.player.to_account_info())?;
        Ok(())
    }

    /// Return hand-scoped rent (MPC key, share accumulator, showdown material,
    /// pending deposit) to this player's vault. The hand must already be finished.
    pub fn close_seat_rent(
        ctx: Context<CloseSeatRent>,
        player_index: u8,
        mpc_purpose: u8,
        mpc_generation: u64,
        showdown_generation: u64,
    ) -> Result<()> {
        let game = &ctx.accounts.game_state;
        require!(
            game.phase >= 5 || game.settlement_status == SETTLEMENT_SETTLED,
            ErrorCode::InvalidGamePhase
        );
        let player = ctx.accounts.player.key();
        require!(
            ctx.accounts.table_state.seats.iter().any(|seat| *seat == player),
            ErrorCode::NotSeated
        );
        let vault = ctx.accounts.rent_vault.to_account_info();
        require_keys_eq!(
            vault.key(),
            rent_vault::vault_address(&game.table_room_id, &player),
            ErrorCode::InvalidAuthority
        );
        {
            let data = ctx.accounts.player_mpc_key.try_borrow_data()?;
            require!(
                data.len() >= 41 && data[40] == player_index,
                ErrorCode::InvalidMpcKeyPurpose
            );
        }
        rent_vault::close_owned_pda(
            &ctx.accounts.player_mpc_key.to_account_info(),
            Pubkey::find_program_address(
                &[
                    b"player_mpc_key",
                    &game.game_id[..],
                    &[player_index],
                    &[mpc_purpose],
                    &mpc_generation.to_le_bytes(),
                ],
                &crate::ID,
            )
            .0,
            &vault,
            Some(98),
            &player,
        )?;
        rent_vault::close_owned_pda(
            &ctx.accounts.share_verify_acc.to_account_info(),
            Pubkey::find_program_address(
                &[b"share_verify_acc", &game.game_id[..], &[player_index]],
                &crate::ID,
            )
            .0,
            &vault,
            None,
            &player,
        )?;
        if let Some(material) = ctx.accounts.showdown_material.as_ref() {
            rent_vault::close_owned_pda(
                &material.to_account_info(),
                Pubkey::find_program_address(
                    &[
                        b"showdown_material",
                        &game.game_id[..],
                        &showdown_generation.to_le_bytes(),
                        &[player_index],
                    ],
                    &crate::ID,
                )
                .0,
                &vault,
                None,
                &player,
            )?;
        }
        if let Some(pending) = ctx.accounts.pending_deposit.as_ref() {
            rent_vault::close_owned_pda(
                &pending.to_account_info(),
                Pubkey::find_program_address(
                    &[b"pending_deposit", player.as_ref(), &game.table_room_id[..]],
                    &crate::ID,
                )
                .0,
                &vault,
                Some(8),
                &player,
            )?;
        }
        Ok(())
    }

    pub fn unlock_table(
        ctx: Context<UnlockTable>,
        computation_offset: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room_wallet.room_id,
            &ctx.accounts.player.key(),
        )?;
        require!(
            !ctx.accounts.table_state.hand_in_progress,
            ErrorCode::InActiveHand
        );
        let bit = table_bit(ctx.accounts.table_escrow.table_id)?;
        require!(
            ctx.accounts.room_wallet.in_hand_tables & bit == 0,
            ErrorCode::InActiveHand
        );
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.room_wallet.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.table_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        // Plaintext seat→personal mirror applied in unlock_table_callback only.

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.table_escrow.balance_ciphertext)
            .plaintext_u8(0)
            .build();
        let room_wallet_key = ctx.accounts.room_wallet.key();
        let table_escrow_key = ctx.accounts.table_escrow.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![UnlockTableCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: room_wallet_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: table_escrow_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "unlock_table")]
    pub fn unlock_table_callback(
        ctx: Context<UnlockTableCallback>,
        output: SignedComputationOutputs<UnlockTableOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(UnlockTableOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.ciphertexts[0];
        wallet.nonce = o.nonce;
        let escrow = &mut ctx.accounts.table_escrow;
        // V7: mirror Enc unlock onto plaintext after success.
        let seat_bal = escrow.balance_u64;
        if seat_bal > 0 {
            wallet.balance_u64 =
                mirror_credit(wallet.balance_u64, seat_bal).ok_or(ErrorCode::InvalidAmount)?;
            escrow.balance_u64 = 0;
        }
        escrow.balance_ciphertext = [0u8; 32];
        escrow.is_seated = false;
        Ok(())
    }

    pub fn withdraw_spl(
        ctx: Context<WithdrawSpl>,
        amount: u64,
        computation_offset: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
        locked_escrow_sum: u64,
    ) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.payer.key(),
        )?;
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(ctx.accounts.room_wallet.in_hand_tables == 0, ErrorCode::InActiveHand);
        ctx.accounts.pending_withdraw.amount = amount;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .plaintext_u64(locked_escrow_sum)
            .plaintext_u64(amount)
            .build();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DebitForWithdrawCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "debit_for_withdraw")]
    pub fn debit_for_withdraw_callback(
        ctx: Context<DebitForWithdrawCallback>,
        output: SignedComputationOutputs<DebitForWithdrawOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(DebitForWithdrawOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        require!(o.field_1, ErrorCode::InsufficientBalance);

        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.field_0.ciphertexts[0];
        wallet.nonce = o.field_0.nonce;

        let amount = ctx.accounts.pending_withdraw.amount;
        require!(
            vault_covers_withdraw(ctx.accounts.vault.amount, amount),
            ErrorCode::InsufficientBalance
        );
        // V7: debit plaintext mirror only after Enc debit succeeded.
        wallet.balance_u64 =
            mirror_debit(wallet.balance_u64, amount).ok_or(ErrorCode::InsufficientBalance)?;
        let room_id = ctx.accounts.room.room_id;
        let bump = ctx.bumps.room;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.player_token_account,
            &ctx.accounts.room,
            amount,
            &room_id,
            bump,
        )?;
        Ok(())
    }

    pub fn init_credit_room_balance_comp_def(ctx: Context<InitCreditRoomBalanceCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_lock_table_buyin_comp_def(ctx: Context<InitLockTableBuyinCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_unlock_table_comp_def(ctx: Context<InitUnlockTableCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_debit_for_withdraw_comp_def(ctx: Context<InitDebitForWithdrawCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Disabled in release: Arcis output updates only the pool, not player ledgers.
    #[cfg(feature = "testing")]
    pub fn init_settle_casino_hand_comp_def(ctx: Context<InitSettleCasinoHandCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Initialize shared Dealer Pool for a casino table.
    /// `game_kind` must match the table. Poker and bingo are rejected: those
    /// prizes are player pots, not a house bankroll.
    pub fn init_dealer_pool(
        ctx: Context<InitDealerPool>,
        game_kind: u8,
        min_bet: u64,
        max_bet: u64,
        bet_unit: u64,
    ) -> Result<()> {
        let room_id = ctx.accounts.room.room_id;
        let table_id = ctx.accounts.table_state.table_id;
        let kind = GameKind::from_u8(game_kind).ok_or(error!(ErrorCode::InvalidGameKind))?;
        require!(
            kind != GameKind::Poker && kind != GameKind::Bingo,
            ErrorCode::InvalidGameKind
        );
        require!(
            ctx.accounts.table_state.game_kind == kind as u8,
            ErrorCode::InvalidGameKind
        );
        if kind == GameKind::Roulette {
            require!(min_bet > 0 && min_bet <= max_bet, ErrorCode::InvalidAmount);
        } else if max_bet > 0 {
            require!(min_bet <= max_bet, ErrorCode::InvalidAmount);
        }
        let unit = if bet_unit > 0 { bet_unit } else { min_bet };
        ctx.accounts
            .dealer_pool
            .set_inner(DealerPool::init(room_id, table_id, kind, min_bet, max_bet, unit));
        Ok(())
    }

    /// Protocol treasury for transparent commission accrual per room.
    pub fn init_protocol_treasury(ctx: Context<InitProtocolTreasury>) -> Result<()> {
        let treasury = &mut ctx.accounts.protocol_treasury;
        treasury.room_id = ctx.accounts.room.room_id;
        treasury.total_commissions = 0;
        treasury.total_withdrawn = 0;
        treasury.mint = ctx.accounts.room.mint;
        Ok(())
    }

    /// Transfer accrued protocol commissions from the room vault (admin only).
    pub fn withdraw_protocol_commissions(
        ctx: Context<WithdrawProtocolCommissions>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let treasury = &mut ctx.accounts.protocol_treasury;
        let available = treasury
            .total_commissions
            .saturating_sub(treasury.total_withdrawn);
        require!(amount <= available, ErrorCode::InsufficientBalance);

        treasury.total_withdrawn = treasury
            .total_withdrawn
            .checked_add(amount)
            .ok_or(error!(ErrorCode::InvalidAmount))?;

        let room_id = ctx.accounts.room.room_id;
        let bump = ctx.bumps.room;
        transfer_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.recipient_token_account,
            &ctx.accounts.room,
            amount,
            &room_id,
            bump,
        )?;

        emit!(TreasuryWithdrawEvent {
            room_id,
            amount,
            recipient: ctx.accounts.recipient_token_account.owner,
        });
        Ok(())
    }

    pub fn init_pool_stake(ctx: Context<InitPoolStake>) -> Result<()> {
        let stake = &mut ctx.accounts.pool_stake;
        stake.pool = ctx.accounts.dealer_pool.key();
        stake.staker = ctx.accounts.staker.key();
        stake.shares = 0;
        stake.accrued_ciphertext = [0u8; 32];
        stake.nonce = 0;
        Ok(())
    }

    /// Disabled in release: Arcis cannot authenticate transfer success vs insufficient-balance no-op.
    #[cfg(feature = "testing")]
    pub fn init_stake_dealer_pool_comp_def(ctx: Context<InitStakeDealerPoolCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Disabled in release: redemption value is caller-chosen, not share-derived.
    #[cfg(feature = "testing")]
    pub fn init_redeem_dealer_pool_comp_def(ctx: Context<InitRedeemDealerPoolCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Testing / localnet only — arbitrary `player_net_abs` would mint/drain escrow
    /// in release. Production must bind nets to a consumed casino outcome receipt.
    #[cfg(feature = "testing")]
    pub fn init_apply_casino_player_net_comp_def(
        ctx: Context<InitApplyCasinoPlayerNetCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    pub fn init_fund_player_game_escrow_comp_def(
        ctx: Context<InitFundPlayerGameEscrowCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    pub fn init_return_player_game_escrow_comp_def(
        ctx: Context<InitReturnPlayerGameEscrowCompDef>,
    ) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Disabled in release until Arcis exposes authenticated transferred value.
    #[cfg(feature = "testing")]
    pub fn stake_dealer_pool(
        ctx: Context<StakeDealerPool>,
        computation_offset: u64,
        stake_amount: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(stake_amount > 0, ErrorCode::InvalidAmount);
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.dealer_pool.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.room_wallet.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        ctx.accounts.dealer_pool.pending_total_action = stake_amount;

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.dealer_pool.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .plaintext_u64(stake_amount)
            .build();

        let dealer_pool_key = ctx.accounts.dealer_pool.key();
        let room_wallet_key = ctx.accounts.room_wallet.key();
        let pool_stake_key = ctx.accounts.pool_stake.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![StakeDealerPoolCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: dealer_pool_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: room_wallet_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: pool_stake_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "stake_dealer_pool")]
    pub fn stake_dealer_pool_callback(
        ctx: Context<StakeDealerPoolCallback>,
        output: SignedComputationOutputs<StakeDealerPoolOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(StakeDealerPoolOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };

        let pool = &mut ctx.accounts.dealer_pool;
        pool.balance_ciphertext = o.field_0.ciphertexts[0];
        pool.nonce = o.field_0.nonce;

        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.field_1.ciphertexts[0];
        wallet.nonce = o.field_1.nonce;

        let stake_amount = pool.pending_total_action;
        pool.pending_total_action = 0;

        let minted = if pool.total_shares == 0 {
            stake_amount
        } else {
            stake_amount
        };
        pool.total_shares = pool
            .total_shares
            .checked_add(minted)
            .ok_or(error!(ErrorCode::InvalidAmount))?;

        let pool_stake = &mut ctx.accounts.pool_stake;
        pool_stake.shares = pool_stake
            .shares
            .checked_add(minted)
            .ok_or(error!(ErrorCode::InvalidAmount))?;

        emit!(PoolStakeEvent {
            pool: pool.key(),
            staker: pool_stake.staker,
            amount: stake_amount,
            shares_minted: minted,
        });
        Ok(())
    }

    /// Disabled in release until redemption value is derived from shares + authenticated transfer.
    #[cfg(feature = "testing")]
    pub fn redeem_dealer_pool(
        ctx: Context<RedeemDealerPool>,
        computation_offset: u64,
        redeem_amount: u64,
        shares_to_burn: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(redeem_amount > 0 && shares_to_burn > 0, ErrorCode::InvalidAmount);
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.dealer_pool.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.room_wallet.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        ctx.accounts.dealer_pool.pending_total_action = redeem_amount;
        ctx.accounts.dealer_pool.pending_shares_burn = shares_to_burn;

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.dealer_pool.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.room_wallet.balance_ciphertext)
            .plaintext_u64(redeem_amount)
            .build();

        let dealer_pool_key = ctx.accounts.dealer_pool.key();
        let room_wallet_key = ctx.accounts.room_wallet.key();
        let pool_stake_key = ctx.accounts.pool_stake.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RedeemDealerPoolCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: dealer_pool_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: room_wallet_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: pool_stake_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "redeem_dealer_pool")]
    pub fn redeem_dealer_pool_callback(
        ctx: Context<RedeemDealerPoolCallback>,
        output: SignedComputationOutputs<RedeemDealerPoolOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(RedeemDealerPoolOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };

        let pool = &mut ctx.accounts.dealer_pool;
        pool.balance_ciphertext = o.field_0.ciphertexts[0];
        pool.nonce = o.field_0.nonce;

        let wallet = &mut ctx.accounts.room_wallet;
        wallet.balance_ciphertext = o.field_1.ciphertexts[0];
        wallet.nonce = o.field_1.nonce;

        let redeem_amount = pool.pending_total_action;
        let shares_burned = pool.pending_shares_burn;
        pool.pending_total_action = 0;
        pool.pending_shares_burn = 0;

        let pool_stake = &mut ctx.accounts.pool_stake;
        pool_stake.shares = pool_stake
            .shares
            .checked_sub(shares_burned)
            .ok_or(error!(ErrorCode::InsufficientBalance))?;
        pool.total_shares = pool.total_shares.saturating_sub(shares_burned);

        emit!(PoolRedeemEvent {
            pool: pool.key(),
            staker: pool_stake.staker,
            amount: redeem_amount,
            shares_burned,
        });
        Ok(())
    }

    /// Testing / localnet only — caller-chosen net would mint/drain game escrow.
    /// Do not ship in release until nets are bound to a one-time outcome receipt.
    #[cfg(feature = "testing")]
    pub fn apply_casino_player_net(
        ctx: Context<ApplyCasinoPlayerNet>,
        computation_offset: u64,
        player_index: u8,
        player_net_abs: u64,
        player_won: bool,
        encryption_pubkey: [u8; 32],
        nonce: u128,
        showdown_results: [u64; 14],
        result_count: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.player_game_escrow.player_index == player_index,
            ErrorCode::InvalidAuthority
        );
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.player_game_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.player_game_escrow.pending_net_abs = player_net_abs;
        ctx.accounts.player_game_escrow.pending_net_won = u8::from(player_won);
        let game_kind = ctx.accounts.table_state.game_kind;
        let variant = ctx.accounts.table_state.roulette_variant;

        let mut args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.player_game_escrow.balance_ciphertext)
            .plaintext_u64(player_net_abs)
            .plaintext_bool(player_won)
            .plaintext_u8(game_kind)
            .plaintext_u8(variant)
            .plaintext_u8(result_count);
        for term in showdown_results {
            args = args.plaintext_u64(term);
        }
        let args = args.build();

        let game_escrow_key = ctx.accounts.player_game_escrow.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ApplyCasinoPlayerNetCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: game_escrow_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "apply_casino_player_net")]
    pub fn apply_casino_player_net_callback(
        ctx: Context<ApplyCasinoPlayerNetCallback>,
        output: SignedComputationOutputs<ApplyCasinoPlayerNetOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ApplyCasinoPlayerNetOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        require!(o.field_1, ErrorCode::InvalidProof);

        let escrow = &mut ctx.accounts.player_game_escrow;
        escrow.balance_ciphertext = o.field_0.ciphertexts[0];
        escrow.nonce = o.field_0.nonce;
        let abs = escrow.pending_net_abs;
        if abs > 0 {
            if escrow.pending_net_won != 0 {
                escrow.balance_u64 = escrow
                    .balance_u64
                    .checked_add(abs)
                    .ok_or(ErrorCode::InvalidAmount)?;
            } else {
                escrow.balance_u64 = escrow.balance_u64.saturating_sub(abs);
            }
            escrow.pending_net_abs = 0;
            escrow.pending_net_won = 0;
        }
        Ok(())
    }

    /// Lock stake from `table_escrow` into `player_game_escrow` for the current hand.
    #[cfg(feature = "testing")]
    pub fn fund_player_game_escrow(
        ctx: Context<FundPlayerGameEscrow>,
        computation_offset: u64,
        player_index: u8,
        stake: u64,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.player_game_escrow.player_index == player_index,
            ErrorCode::InvalidAuthority
        );
        require!(stake > 0, ErrorCode::InvalidAmount);
        require!(
            ctx.accounts.table_escrow.balance_u64 >= stake,
            ErrorCode::InsufficientBalance
        );
        require!(
            ctx.accounts.player_game_escrow.pending_fund == 0,
            ErrorCode::InvalidAmount
        );
        ctx.accounts.player_game_escrow.pending_fund = stake;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.table_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.player_game_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.table_escrow.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.player_game_escrow.balance_ciphertext)
            .plaintext_u64(stake)
            .build();

        let table_escrow_key = ctx.accounts.table_escrow.key();
        let game_escrow_key = ctx.accounts.player_game_escrow.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![FundPlayerGameEscrowCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: table_escrow_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: game_escrow_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "fund_player_game_escrow")]
    pub fn fund_player_game_escrow_callback(
        ctx: Context<FundPlayerGameEscrowCallback>,
        output: SignedComputationOutputs<FundPlayerGameEscrowOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(FundPlayerGameEscrowOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let table = &mut ctx.accounts.table_escrow;
        table.balance_ciphertext = o.field_0.ciphertexts[0];
        table.nonce = o.field_0.nonce;
        let game = &mut ctx.accounts.player_game_escrow;
        game.balance_ciphertext = o.field_1.ciphertexts[0];
        game.nonce = table.nonce.wrapping_add(1);
        let stake = game.pending_fund;
        if stake > 0 {
            table.balance_u64 = table
                .balance_u64
                .checked_sub(stake)
                .ok_or(ErrorCode::InsufficientBalance)?;
            game.balance_u64 = game
                .balance_u64
                .checked_add(stake)
                .ok_or(ErrorCode::InvalidAmount)?;
            game.pending_fund = 0;
        }
        Ok(())
    }

    /// Return remaining hand stake from `player_game_escrow` to `table_escrow`.
    #[cfg(feature = "testing")]
    pub fn return_player_game_escrow(
        ctx: Context<ReturnPlayerGameEscrow>,
        computation_offset: u64,
        player_index: u8,
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.player_game_escrow.player_index == player_index,
            ErrorCode::InvalidAuthority
        );
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.table_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        bind_wallet_encryption_pubkey(
            &mut ctx.accounts.player_game_escrow.encryption_pubkey,
            &encryption_pubkey,
        )?;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.table_escrow.balance_ciphertext)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.player_game_escrow.balance_ciphertext)
            .build();

        let table_escrow_key = ctx.accounts.table_escrow.key();
        let game_escrow_key = ctx.accounts.player_game_escrow.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ReturnPlayerGameEscrowCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: table_escrow_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: game_escrow_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "return_player_game_escrow")]
    pub fn return_player_game_escrow_callback(
        ctx: Context<ReturnPlayerGameEscrowCallback>,
        output: SignedComputationOutputs<ReturnPlayerGameEscrowOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ReturnPlayerGameEscrowOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let table = &mut ctx.accounts.table_escrow;
        table.balance_ciphertext = o.field_0.ciphertexts[0];
        table.nonce = o.field_0.nonce;
        let game = &mut ctx.accounts.player_game_escrow;
        let returned = game.balance_u64;
        game.balance_ciphertext = o.field_1.ciphertexts[0];
        game.nonce = table.nonce.wrapping_add(1);
        table.balance_u64 = table
            .balance_u64
            .checked_add(returned)
            .ok_or(ErrorCode::InvalidAmount)?;
        game.balance_u64 = 0;
        Ok(())
    }

    /// Disabled in release: caller-selected outcomes/fees; Arcis updates pool only.
    /// Arcis rejects the job when `showdown_results` is outside that game's range.
    #[cfg(feature = "testing")]
    pub fn settle_casino_hand(
        ctx: Context<SettleCasinoHand>,
        computation_offset: u64,
        total_action: u64,
        pool_gross_win: u64,
        player_payout: u64,
        action_fee_bps: u16,
        pool_win_fee_bps: u16,
        banker_commission_bps: u16,
        encryption_pubkey: [u8; 32],
        nonce: u128,
        showdown_results: [u64; 14],
        result_count: u8,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        ctx.accounts.dealer_pool.pending_total_action = total_action;
        let game_kind = ctx.accounts.table_state.game_kind;
        let variant = ctx.accounts.table_state.roulette_variant;

        let mut args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(ctx.accounts.dealer_pool.balance_ciphertext)
            .plaintext_u64(total_action)
            .plaintext_u64(pool_gross_win)
            .plaintext_u64(player_payout)
            .plaintext_u16(action_fee_bps)
            .plaintext_u16(pool_win_fee_bps)
            .plaintext_u16(banker_commission_bps)
            .plaintext_u8(game_kind)
            .plaintext_u8(variant)
            .plaintext_u8(result_count);
        for term in showdown_results {
            args = args.plaintext_u64(term);
        }
        let args = args.build();

        let game_state_key = ctx.accounts.game_state.key();
        let table_state_key = ctx.accounts.table_state.key();
        let dealer_pool_key = ctx.accounts.dealer_pool.key();
        let protocol_treasury_key = ctx.accounts.protocol_treasury.key();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SettleCasinoHandCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: game_state_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: table_state_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: dealer_pool_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: protocol_treasury_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[cfg(feature = "testing")]
    #[arcium_callback(encrypted_ix = "settle_casino_hand")]
    pub fn settle_casino_hand_callback(
        ctx: Context<SettleCasinoHandCallback>,
        output: SignedComputationOutputs<SettleCasinoHandOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(SettleCasinoHandOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        require!(o.field_2, ErrorCode::InvalidProof);

        let pool = &mut ctx.accounts.dealer_pool;
        pool.balance_ciphertext = o.field_0.ciphertexts[0];
        pool.nonce = o.field_0.nonce;

        let commission = o.field_1;
        let treasury = &mut ctx.accounts.protocol_treasury;
        treasury.total_commissions = treasury
            .total_commissions
            .checked_add(commission)
            .ok_or(error!(ErrorCode::InvalidAmount))?;

        // Mark casino settle complete without advancing poker phase to 6.
        ctx.accounts.game_state.settlement_status = SETTLEMENT_SETTLED;
        snapshot_next_hand_seats(&mut ctx.accounts.game_state, &ctx.accounts.table_state);

        let table = &mut ctx.accounts.table_state;
        let room_id = pool.room_id;
        let table_id = pool.table_id;
        let total_action = pool.pending_total_action;
        pool.pending_total_action = 0;
        table.end_hand();

        emit!(CasinoSettlementEvent {
            room_id,
            table_id,
            protocol_commission: commission,
            total_action,
        });
        Ok(())
    }

    /// Link a seated table to an existing (or freshly created) `GameState`.
    ///
    /// The signer must be whitelisted for the room and already seated at this
    /// table. Creating the room and the table stays with [`WHITELIST_ADMIN`].
    /// Prefer `initialize_game` first when the hand also needs ZK fields
    /// (`num_cards`, verify bits, etc.). `init_if_needed` keeps room-only
    /// flows working when no GameState exists yet.
    pub fn start_hand(ctx: Context<StartHand>, game_id: [u8; 32]) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.room.room_id,
            &ctx.accounts.authority.key(),
        )?;
        require!(
            ctx.accounts.room.room_id == ctx.accounts.table_state.room_id,
            ErrorCode::InvalidAuthority
        );
        require!(
            ctx.accounts
                .table_state
                .seats
                .iter()
                .any(|seat| *seat == ctx.accounts.authority.key()),
            ErrorCode::NotSeated
        );
        let table = &mut ctx.accounts.table_state;
        // Sit/leave already refresh the pending order. end_hand advances the
        // button once for the next hand. Refreshing again here moves it a
        // second time, so the button lands on the same seat every hand.
        // Dealer-pool max-payout coverage. Poker and bingo pay from player
        // commitments (poker streets, bingo card buy-ins), so an empty pool
        // account is allowed. Keno stays on this check.
        if table.game_kind != GameKind::Poker as u8
            && table.game_kind != GameKind::Bingo as u8
        {
            let pool_info = ctx.accounts.dealer_pool.to_account_info();
            require!(
                !pool_info.data_is_empty(),
                ErrorCode::InsufficientDealerCoverage
            );
            let pool_data = pool_info.try_borrow_data()?;
            let pool = DealerPool::try_deserialize(&mut &pool_data[..])?;
            if pool.max_bet > 0 || pool.bet_unit > 0 {
                let seats = table.pending_num_players.max(1);
                let needed = match table.game_kind {
                    k if k == GameKind::Roulette as u8 => {
                        roulette_max_liability(pool.max_bet, seats)
                    }
                    k if k == GameKind::Blackjack as u8 => {
                        blackjack_max_liability(pool.bet_unit.max(pool.min_bet), seats)
                    }
                    _ => head_to_head_max_liability(pool.bet_unit.max(pool.min_bet), seats),
                }
                .ok_or(ErrorCode::InvalidAmount)?;
                require!(
                    pool.total_shares >= needed,
                    ErrorCode::InsufficientDealerCoverage
                );
            }
        }
        table.snapshot_hand(game_id)?;

        let game_state = &mut ctx.accounts.game_state;
        let num_players = table.hand_num_players;
        accept_next_hand_for_start(game_state, num_players)?;
        let next_phase = game_state.next_hand_phase;
        let preserving_zk = game_state.num_cards > 0;

        game_state.game_id = game_id;
        game_state.table_room_id = table.room_id;
        game_state.table_id = table.table_id;
        game_state.num_players = num_players;
        if !preserving_zk {
            // Room-only path: seed defaults so betting/showdown helpers work.
            game_state.num_cards = 25;
            game_state.total_partials = 25u8.saturating_mul(num_players.saturating_sub(1));
            game_state.pot_mask = if table.game_kind == GameKind::Poker as u8 {
                if num_players >= 16 {
                    u16::MAX
                } else {
                    (1u16 << num_players) - 1
                }
            } else {
                0
            };
            game_state.phase = 0;
            game_state.verify_hash_acc = [0u8; 32];
            game_state.verify_expected = [0u8; 32];
            game_state.verify_progress = 0;
            game_state.verify_bits = [0u64; 15];
            game_state.verify_started = false;
            game_state.revealed_partials = 0;
        }
        if game_state.staging_authority == Pubkey::default() {
            game_state.staging_authority = ctx.accounts.authority.key();
        }
        game_state.current_player = 0;
        game_state.betting_phase = 0;
        game_state.reached_flop = false;
        game_state.rake_amount = 0;
        game_state.rake_bps = if table.game_kind == GameKind::Poker as u8 {
            ctx.accounts.room.rake_bps
        } else {
            0
        };
        game_state.folded_mask = 0;
        game_state.show_on_fold_mask = 0;
        game_state.all_in_mask = 0;
        game_state.shared_mask = 0;
        game_state.acted_mask = 0;
        game_state.verified = false;
        game_state.share_finalized = false;
        game_state.showdown_finalized = false;
        game_state.current_bet = 0;
        game_state.last_aggressor = 0;
        game_state.last_aggressor_amount = 0;
        game_state.pot_count = 0;
        game_state.pots = [0u64; 9];
        game_state.pot_eligible_masks = [0u16; 9];
        game_state.player_total_bets = [0u64; 10];
        game_state.hand_commits = [0u64; 10];
        game_state.payouts = [0u64; 10];
        game_state.showdown_hash = [0u8; 32];
        game_state.showdown_finalized = false;
        game_state.showdown_hash_player = 0;
        game_state.bet_pending = false;
        if next_phase == NEXT_HAND_READY {
            let info = game_state.to_account_info();
            let mut material = load_registration(&info)?;
            reindex_registrations_to_seat_order(
                game_state,
                &mut material,
                &table.hand_seat_order,
                num_players,
            );
            store_registration(&info, &material)?;
        }
        finish_next_hand_for_start(game_state, num_players, next_phase);

        let bit = table_bit(table.table_id)?;
        for seat in table.hand_seat_order.iter().take(table.hand_num_players as usize) {
            let pk = table.seats[*seat as usize];
            // in_hand_tables updated per-player in their RoomWallet by client calling mark_in_hand
            let _ = pk;
        }
        let _ = bit;
        emit!(HandStartedEvent {
            game_id,
            num_players,
        });
        emit_phase_advanced(game_state);
        emit_player_action_required(game_state);
        Ok(())
    }

    /// Create a `PlayerState` PDA without a Groth16 register receipt.
    /// Testing only — production initializes via `consume_register_receipt`.
    #[cfg(feature = "testing")]
    pub fn init_player_state(ctx: Context<InitPlayerState>, player_index: u8) -> Result<()> {
        require!(
            player_index < ctx.accounts.game_state.num_players,
            ErrorCode::InvalidCardIndex
        );
        let player_state = &mut ctx.accounts.player_state;
        player_state.game_id = ctx.accounts.game_state.game_id;
        player_state.player_index = player_index;
        player_state.public_key = [[0u8; 32]; 2];
        player_state.padding = [[0u8; 32]; 4];
        player_state.action = 0;
        player_state.show_on_fold = false;
        Ok(())
    }

    pub fn mark_in_hand(ctx: Context<MarkInHand>) -> Result<()> {
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &ctx.accounts.table_state.room_id,
            &ctx.accounts.player.key(),
        )?;
        let table = &ctx.accounts.table_state;
        require!(table.hand_in_progress, ErrorCode::HandInProgress);
        let player_key = ctx.accounts.player.key();
        require!(
            player_in_active_hand(
                &table.seats,
                &table.hand_seat_order,
                table.hand_num_players,
                table.hand_in_progress,
                &player_key,
            ),
            ErrorCode::NotInHand
        );
        let bit = table_bit(table.table_id)?;
        ctx.accounts.room_wallet.in_hand_tables |= bit;
        Ok(())
    }

    /// Testing only until all-seat settlement is release-reachable.
    /// Production hands end via authenticated settlement/refund callbacks.
    #[cfg(feature = "testing")]
    pub fn end_hand(ctx: Context<EndHand>) -> Result<()> {
        require!(
            ctx.accounts.room.authority == ctx.accounts.authority.key(),
            ErrorCode::InvalidAuthority
        );
        require!(
            ctx.accounts.room.room_id == ctx.accounts.table_state.room_id,
            ErrorCode::InvalidAuthority
        );
        let table = &mut ctx.accounts.table_state;
        require!(table.hand_in_progress, ErrorCode::HandInProgress);
        snapshot_next_hand_seats(&mut ctx.accounts.game_state, table);
        table.end_hand();
        Ok(())
    }

    /// Store a key for a player who joined this hand and still needs one.
    /// Players who already registered are marked when showdown opens.
    pub fn register_next_hand(
        ctx: Context<NextHandPlayer>,
        public_key: [[u8; 32]; 2],
        padding: [[u8; 32]; 4],
    ) -> Result<()> {
        require_next_hand_table(&ctx)?;
        prepare_next_hand_seat(
            &mut ctx.accounts.game_state,
            &ctx.accounts.table_state,
            ctx.accounts.player_state.player_index,
            &ctx.accounts.player.key(),
        )?;
        let info = ctx.accounts.game_state.to_account_info();
        let mut material = load_registration(&info)?;
        register_next_hand_player(
            &mut ctx.accounts.game_state,
            &mut material,
            &mut ctx.accounts.player_state,
            public_key,
            padding,
        )?;
        store_registration(&info, &material)?;
        emit_player_action_required(&ctx.accounts.game_state);
        Ok(())
    }

    /// Shuffle seat in the next hand. Order is the joined-player index.
    pub fn submit_next_hand_shuffle(ctx: Context<NextHandPlayer>) -> Result<()> {
        require_next_hand_table(&ctx)?;
        prepare_next_hand_seat(
            &mut ctx.accounts.game_state,
            &ctx.accounts.table_state,
            ctx.accounts.player_state.player_index,
            &ctx.accounts.player.key(),
        )?;
        join_next_hand_shuffle(
            &mut ctx.accounts.game_state,
            ctx.accounts.player_state.player_index,
        )?;
        emit_player_action_required(&ctx.accounts.game_state);
        Ok(())
    }

    /// Share seat in the next hand. Every joined player shares after the shuffle.
    pub fn submit_next_hand_share(ctx: Context<NextHandPlayer>) -> Result<()> {
        require_next_hand_table(&ctx)?;
        prepare_next_hand_seat(
            &mut ctx.accounts.game_state,
            &ctx.accounts.table_state,
            ctx.accounts.player_state.player_index,
            &ctx.accounts.player.key(),
        )?;
        join_next_hand_share(
            &mut ctx.accounts.game_state,
            ctx.accounts.player_state.player_index,
        )?;
        emit_player_action_required(&ctx.accounts.game_state);
        Ok(())
    }

    /// Close casino-owned session accounts onto `rent_dest`. The room stays open
    /// so a full table can be reclaimed in several transactions.
    #[cfg(feature = "testing")]
    pub fn close_session_accounts<'a>(
        ctx: Context<'a, CloseSessionAccounts<'a>>,
    ) -> Result<()> {
        let dest = ctx.accounts.rent_dest.to_account_info();
        for account in ctx.remaining_accounts.iter() {
            if account.key() == dest.key()
                || account.key() == ctx.accounts.authority.key()
                || account.key() == ctx.accounts.room.key()
            {
                continue;
            }
            if *account.owner != crate::ID || account.data_is_empty() {
                continue;
            }
            rent_vault::close_into(account, &dest)?;
        }
        Ok(())
    }

    /// Burn the room's chips, close that token account, and close the room and
    /// table onto `rent_dest`. Call after `close_session_accounts`.
    #[cfg(feature = "testing")]
    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        let room_id = ctx.accounts.room.room_id;
        let bump = ctx.bumps.room;
        let dest = ctx.accounts.rent_dest.to_account_info();
        crate::token::burn_and_close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.mint,
            &ctx.accounts.token_vault,
            &ctx.accounts.room,
            &dest,
            &room_id,
            bump,
        )?;
        Ok(())
    }

    pub fn init_game_table_key(
        ctx: Context<InitGameTableKey>,
        encryption_pubkey: [u8; 32],
        nonce_base: u128,
    ) -> Result<()> {
        let key = &mut ctx.accounts.game_table_key;
        key.game_id = ctx.accounts.game_state.game_id;
        key.encryption_pubkey = encryption_pubkey;
        key.nonce_base = nonce_base;
        Ok(())
    }

    /// Publish a purpose-separated random X25519 public key for one seat/generation.
    /// Requires a registered `PlayerState` for the seat. When the game is bound to
    /// a table, the signer must be the seated player for that hand index.
    pub fn init_player_mpc_key<'a>(
        ctx: Context<'a, InitPlayerMpcKey<'a>>,
        player_index: u8,
        purpose: u8,
        generation: u64,
        encryption_pubkey: [u8; 32],
        nonce_base: u128,
    ) -> Result<()> {
        require!(
            player_index < ctx.accounts.game_state.num_players,
            ErrorCode::InvalidMpcKeyPurpose
        );
        require!(purpose <= 3, ErrorCode::InvalidMpcKeyPurpose);
        require!(
            encryption_pubkey != [0u8; 32],
            ErrorCode::InvalidMpcKeyPurpose
        );
        require!(
            ctx.accounts.player_state.game_id == ctx.accounts.game_state.game_id
                && ctx.accounts.player_state.player_index == player_index,
            ErrorCode::InvalidMpcKeyPurpose
        );
        if let Some(table) = ctx.accounts.table_state.as_ref() {
            require!(
                table.current_game_id == ctx.accounts.game_state.game_id
                    && table.hand_in_progress
                    && player_index < table.hand_num_players,
                ErrorCode::InvalidMpcKeyPurpose
            );
            let physical = table.hand_seat_order[player_index as usize];
            require!(
                table.seats[physical as usize] == ctx.accounts.authority.key(),
                ErrorCode::InvalidAuthority
            );
        }
        let key = &mut ctx.accounts.player_mpc_key;
        key.game_id = ctx.accounts.game_state.game_id;
        key.player_index = player_index;
        key.purpose = purpose;
        key.generation = generation;
        key.encryption_pubkey = encryption_pubkey;
        key.nonce_base = nonce_base;
        key.authority = ctx.accounts.authority.key();
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            ctx.accounts.player_mpc_key.to_account_info().lamports(),
        )?;
        Ok(())
    }

    pub fn init_player_game_escrow(
        ctx: Context<InitPlayerGameEscrow>,
        player_index: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.player_game_escrow;
        escrow.game_id = ctx.accounts.game_state.game_id;
        escrow.player_index = player_index;
        escrow.balance_ciphertext = [0u8; 32];
        escrow.current_bet_ciphertext = [0u8; 32];
        escrow.nonce = 0;
        escrow.encryption_pubkey = [0u8; 32];
        escrow.balance_u64 = 0;
        escrow.pending_fund = 0;
        escrow.pending_net_abs = 0;
        escrow.pending_net_won = 0;
        Ok(())
    }

    pub fn init_encrypted_game_betting(ctx: Context<InitEncryptedGameBetting>) -> Result<()> {
        let betting = &mut ctx.accounts.encrypted_game_betting;
        betting.game_id = ctx.accounts.game_state.game_id;
        betting.player_total_bets_ct = [[0u8; 32]; 10];
        betting.pots_ct = [[0u8; 32]; 9];
        betting.current_bet_ct = [0u8; 32];
        betting.last_aggressor_amount_ct = [0u8; 32];
        betting.nonce = 0;
        Ok(())
    }

    pub fn init_bet_action_log(ctx: Context<InitBetActionLog>) -> Result<()> {
        let mut log = ctx.accounts.bet_action_log.load_init()?;
        log.game_id = ctx.accounts.game_state.game_id;
        log.entry_count = 0;
        log.bump = ctx.bumps.bet_action_log;
        Ok(())
    }

    // ─── Betting (Arcium) ───
    //
    // Betting uses `validate_bet` in encrypted-ixs/src/lib.rs.

    pub fn init_validate_bet_comp_def(ctx: Context<InitValidateBetCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Queue an encrypted bet. `show_on_fold` applies only when folding (`action == 0`);
    /// default `false` mucks hole cards.
    pub fn submit_bet(
        ctx: Context<SubmitBet>,
        action: u8,
        _encrypted_action: [u8; 32],
        encrypted_amount: [u8; 32],
        encrypted_player_balance: [u8; 32],
        encrypted_player_current_bet: [u8; 32],
        encrypted_current_bet: [u8; 32],
        encrypted_last_aggressor_amount: [u8; 32],
        encryption_pubkey: [u8; 32],
        nonce: u128,
        computation_offset: u64,
        show_on_fold: bool,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        let table = &ctx.accounts.table_state;

        require!(
            game_state.betting_phase >= 1 && game_state.betting_phase <= 4,
            ErrorCode::InvalidGamePhase
        );
        require!(game_state.phase != 6, ErrorCode::InvalidGamePhase);
        require!(table.hand_in_progress, ErrorCode::HandInProgress);
        require!(
            table.current_game_id == game_state.game_id
                && table.hand_num_players == game_state.num_players,
            ErrorCode::InvalidGamePhase
        );
        require!(!game_state.bet_pending, ErrorCode::InvalidBet);
        require!(
            ctx.accounts.player_state.game_id == game_state.game_id,
            ErrorCode::InvalidGamePhase
        );

        let player_key = ctx.accounts.player.key();
        verify_whitelisted(
            &ctx.accounts.whitelist_entry,
            &table.room_id,
            &player_key,
        )?;
        let player_index = player_index_for_pubkey(
            &table.seats,
            &table.hand_seat_order,
            table.hand_num_players,
            &player_key,
        ).ok_or(ErrorCode::NotInHand)?;
        require!(
            player_index == game_state.current_player,
            ErrorCode::NotYourTurn
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            action_is_in_time(game_state.act_deadline_unix, now),
            ErrorCode::ActionExpired
        );
        // Show-on-fold only meaningful for fold (action 0); ignore otherwise.
        require!(
            !show_on_fold || action == 0,
            ErrorCode::InvalidBet
        );

        ctx.accounts.player_state.action = action;
        ctx.accounts.player_state.show_on_fold = show_on_fold && action == 0;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        require!(
            (player_index as usize) < game_state.player_total_bets.len(),
            ErrorCode::InvalidSeat
        );
        let committed = game_state.player_total_bets[player_index as usize];
        require!(
            ctx.accounts.table_escrow.balance_u64 >= committed,
            ErrorCode::InsufficientBalance
        );
        let expected_player_balance = ctx.accounts.table_escrow.balance_u64 - committed;
        let expected_player_current_bet = game_state.hand_commits[player_index as usize];
        let expected_current_bet = game_state.current_bet;
        let expected_last_aggressor_amount = game_state.last_aggressor_amount;
        let street_num_players = game_state.num_players;
        let street_folded_mask = game_state.folded_mask;
        let street_all_in_mask = game_state.all_in_mask;
        let street_acted_mask = game_state.acted_mask;
        let street_commits = game_state.hand_commits;
        let game_id = game_state.game_id;
        let game_state_key = ctx.accounts.game_state.key();
        let player_state_key = ctx.accounts.player_state.key();
        let player_game_escrow = Pubkey::find_program_address(
            &[
                b"player_game_escrow",
                &game_id[..],
                &[player_index],
            ],
            ctx.program_id,
        )
        .0;
        let encrypted_game_betting = Pubkey::find_program_address(
            &[b"encrypted_betting", &game_id[..]],
            ctx.program_id,
        )
        .0;
        let bet_action_log = Pubkey::find_program_address(
            &[b"bet_action_log", &game_id[..]],
            ctx.program_id,
        )
        .0;
        let game = &mut ctx.accounts.game_state;
        game.async_generation = game.async_generation.saturating_add(1);
        let generation = game.async_generation;
        start_pending_operation(
            &mut game.bet_pending_operation,
            generation,
            ctx.accounts.computation_account.key(),
            ctx.accounts.player.key(),
        )?;
        game.bet_pending = true;

        // Each Enc<Shared, _> input is {x25519_pubkey, nonce, ciphertext} in the .idarc.
        let args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_player_balance)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_player_current_bet)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u8(_encrypted_action)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_amount)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_current_bet)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce)
            .encrypted_u64(encrypted_last_aggressor_amount)
            .plaintext_u64(expected_player_balance)
            .plaintext_u64(expected_player_current_bet)
            .plaintext_u8(action)
            .plaintext_u64(expected_current_bet)
            .plaintext_u64(expected_last_aggressor_amount)
            .plaintext_u8(player_index)
            .plaintext_u8(street_num_players)
            .plaintext_u16(street_folded_mask)
            .plaintext_u16(street_all_in_mask)
            .plaintext_u16(street_acted_mask)
            .plaintext_u64(street_commits[0])
            .plaintext_u64(street_commits[1])
            .plaintext_u64(street_commits[2])
            .plaintext_u64(street_commits[3])
            .plaintext_u64(street_commits[4])
            .plaintext_u64(street_commits[5])
            .plaintext_u64(street_commits[6])
            .plaintext_u64(street_commits[7])
            .plaintext_u64(street_commits[8])
            .plaintext_u64(street_commits[9])
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ValidateBetCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: game_state_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: player_state_key,
                        is_writable: false,
                    },
                    CallbackAccount {
                        pubkey: player_game_escrow,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: encrypted_game_betting,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: bet_action_log,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "validate_bet")]
    pub fn validate_bet_callback(
        ctx: Context<ValidateBetCallback>,
        output: SignedComputationOutputs<ValidateBetOutput>,
    ) -> Result<()> {
        let result = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(r) => r,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };

        let o = result.field_0;
        if !o.field_3 {
            return Err(ErrorCode::InvalidBet.into());
        }

        let game_state = &mut ctx.accounts.game_state;
        if accept_pending_callback(
            &mut game_state.bet_pending_operation,
            ctx.accounts.computation_account.key(),
        )? {
            return Ok(());
        }
        require!(game_state.bet_pending, ErrorCode::InvalidBet);
        game_state.bet_pending = false;
        game_state.bet_pending_operation.status = PENDING_OPERATION_COMPLETED;
        let player_index = ctx.accounts.player_state.player_index as usize;
        require!(
            player_index < game_state.hand_commits.len(),
            ErrorCode::InvalidSeat
        );
        let action = ctx.accounts.player_state.action;
        let bet_delta = o.field_6;
        let prev_current_bet = game_state.current_bet;

        let escrow = &mut ctx.accounts.player_game_escrow;
        escrow.balance_ciphertext = o.field_0.ciphertexts[0];
        escrow.current_bet_ciphertext = o.field_1.ciphertexts[0];
        escrow.nonce = o.field_0.nonce;

        if o.field_4 {
            game_state.folded_mask |= 1u16 << player_index;
            if ctx.accounts.player_state.show_on_fold {
                game_state.show_on_fold_mask |= 1u16 << player_index;
            }
        }
        if o.field_5 {
            game_state.all_in_mask |= 1u16 << player_index;
        }

        // Street-local tracker (hand_commits): bet_delta is chips added this action.
        // Raise/bet must set current_bet to the raiser's *new street total*
        // (pcb + bet_delta), NOT old_current_bet + bet_delta — that inflated the
        // level whenever the raiser was behind (heads-up SB open-raise), so a
        // call could not match totals and the street never closed.
        if bet_delta > 0 {
            game_state.hand_commits[player_index] = game_state.hand_commits[player_index]
                .saturating_add(bet_delta);
        }
        if action == 3 || action == 4 {
            game_state.current_bet = game_state.hand_commits[player_index];
        } else if action == 5 {
            let street = game_state.hand_commits[player_index];
            if street > game_state.current_bet {
                game_state.current_bet = street;
            }
        }
        let raised = game_state.current_bet > prev_current_bet;
        if raised {
            game_state.last_aggressor = player_index as u8;
            game_state.last_aggressor_amount = game_state.current_bet - prev_current_bet;
        }

        let folded_mask = game_state.folded_mask;
        let all_in_mask = game_state.all_in_mask;
        let num_players = game_state.num_players;
        let canonical = apply_bet_and_recompute_pots(
            &mut game_state.player_total_bets,
            folded_mask,
            all_in_mask,
            num_players,
            player_index,
            bet_delta,
        )
        .map_err(|_| error!(ErrorCode::InvalidCanonicalPot))?;
        store_raked_pots(game_state, canonical)?;

        let current_bet = game_state.current_bet;
        let last_aggressor_amount = game_state.last_aggressor_amount;
        let player_total_bets = game_state.player_total_bets;
        let pots_snapshot = game_state.pots;
        ctx.accounts.encrypted_game_betting.sync_from_plaintext(
            &player_total_bets,
            &pots_snapshot,
            current_bet,
            last_aggressor_amount,
        );

        // Arcis `validate_bet` decides whether the street closes. A heads-up limp
        // reveals false so the big blind still checks or raises.
        apply_arcis_street_decision(
            game_state,
            player_index as u8,
            action,
            raised,
            o.field_7,
        )?;

        let log_entry = BetLogEntry {
            nonce: o.field_2.nonce,
            amount_ciphertext: o.field_2.ciphertexts[0],
            balance_ciphertext: o.field_0.ciphertexts[0],
            player_index: player_index as u8,
            action,
            _padding: [0u8; 14],
        };
        ctx.accounts.bet_action_log.load_mut()?.append(log_entry)?;

        emit!(BetEvent {
            player_index: player_index as u8,
            action,
            amount: bet_delta,
            is_fold: o.field_4,
            is_all_in: o.field_5,
            show_on_fold: (game_state.show_on_fold_mask & (1u16 << player_index)) != 0,
        });

        Ok(())
    }

    /// Fold the player who missed the one-minute decision window.
    ///
    /// Anyone may crank this once the deadline has passed and no bet callback
    /// is in flight. A free check is a normal bet the client sends earlier.
    pub fn expire_bet_turn(ctx: Context<ExpireBetTurn>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.betting_phase >= 1 && game_state.betting_phase <= 4,
            ErrorCode::InvalidGamePhase
        );
        require!(game_state.phase != 6, ErrorCode::InvalidGamePhase);
        require!(!game_state.bet_pending, ErrorCode::PendingOperationActive);
        require!(
            !action_is_in_time(game_state.act_deadline_unix, now),
            ErrorCode::ActionNotExpired
        );
        require!(game_state.act_deadline_unix != 0, ErrorCode::ActionNotExpired);
        let player_index = game_state.current_player;
        let action = apply_timeout_action(game_state)?;
        let player_total_bets = game_state.player_total_bets;
        let pots_snapshot = game_state.pots;
        let current_bet = game_state.current_bet;
        let last_aggressor_amount = game_state.last_aggressor_amount;
        ctx.accounts.encrypted_game_betting.sync_from_plaintext(
            &player_total_bets,
            &pots_snapshot,
            current_bet,
            last_aggressor_amount,
        );
        let log_entry = BetLogEntry {
            nonce: 0,
            amount_ciphertext: betting::encode_u64_le_field(0),
            balance_ciphertext: betting::encode_u64_le_field(0),
            player_index,
            action,
            _padding: [0u8; 14],
        };
        ctx.accounts.bet_action_log.load_mut()?.append(log_entry)?;
        emit!(BetEvent {
            player_index,
            action,
            amount: 0,
            is_fold: action == 0,
            is_all_in: false,
            show_on_fold: false,
        });
        Ok(())
    }

    /// Set the showdown_hash on a GameState (testing builds only).
    ///
    /// Production path: verify showdown via Groth16 in light-casino, then call
    /// `distribute_and_settle` with the resulting hash commitment.
    #[cfg(feature = "testing")]
    pub fn set_showdown_hash(
        ctx: Context<SetShowdownHash>,
        hash: [u8; 32],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.showdown_hash = hash;
        game_state.showdown_finalized = true;
        // Testing helper binds settlement to seat 0's sealed coefficients.
        game_state.showdown_hash_player = 0;
        game_state.phase = 5; // Showdown
        Ok(())
    }

    /// Set pot amounts on a GameState (testing builds only).
    ///
    /// Production path: pot amounts live in `EncryptedGameBetting` ciphertexts;
    /// `distribute_and_settle` reads encrypted state inside MPC.
    #[cfg(feature = "testing")]
    pub fn set_pot_amounts(
        ctx: Context<SetPotAmounts>,
        pots: [u64; 9],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.pots = pots;
        Ok(())
    }

    /// Mark deck hash verified (testing builds only).
    ///
    /// Production path: set by `verify_deck_hash_chunk` callback when the fold matches.
    #[cfg(feature = "testing")]
    pub fn set_verified(
        ctx: Context<SetVerified>,
        verified: bool,
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.verified = verified;
        Ok(())
    }

    pub fn init_seal_showdown_pair_comp_def(ctx: Context<InitSealShowdownPairCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Seal both coefficients and reveal their combined rows in one callback.
    ///
    /// The account belongs to the seat wallet. A written seal that settlement has
    /// not consumed is reused. A consumed seal, or one opened under a different
    /// key, is reset and sealed again. A live pending callback is left in place.
    pub fn seal_showdown_pair<'a>(
        ctx: Context<'a, SealShowdownPair<'a>>,
        computation_offset: u64,
        player_encryption_pubkey: [u8; 32],
        nonce: u128,
        player_index: u8,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require_seal_caller(
            game_state,
            &ctx.accounts.table_state,
            &ctx.accounts.player_state,
            &ctx.accounts.payer.key(),
            player_index,
        )?;
        let computation = ctx.accounts.computation_account.key();
        let payer = ctx.accounts.payer.key();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        let n_active = showdown_coeff_count_for_table(&ctx.accounts.table_state);
        require!(n_active == 2, ErrorCode::InvalidSealedCoefficients);
        let mut opened_fresh = false;
        {
            let sealed = &mut ctx.accounts.sealed_showdown_coefficients;
            let same_batch = sealed.owner == payer
                && !sealed.consumed
                && sealed.n_active == n_active
                && sealed.coeffs_needed == n_active
                && sealed.encryption_pubkey == player_encryption_pubkey
                && sealed.input_nonce == nonce;
            if !same_batch {
                reset_showdown_seal(
                    sealed,
                    payer,
                    game_state.game_id,
                    player_index,
                    player_encryption_pubkey,
                    nonce,
                    n_active,
                );
                opened_fresh = true;
            } else if seal_rows_revealed(&sealed.coefficient_rows) {
                return Ok(());
            }
            require!(
                sealed.player_index == player_index && sealed.game_id == game_state.game_id,
                ErrorCode::InvalidSealedCoefficients
            );
            if sealed.pending_operation.status == PENDING_OPERATION_PENDING
                && Clock::get()?.slot <= sealed.pending_operation.expires_slot
            {
                return Ok(());
            }
            start_pending_operation(
                &mut sealed.pending_operation,
                game_state.async_generation,
                computation,
                payer,
            )?;
        }
        let seal_info = ctx.accounts.sealed_showdown_coefficients.to_account_info();
        if opened_fresh {
            let mut data = seal_info.try_borrow_mut_data()?;
            require!(data.len() >= seal_account_space(), ErrorCode::InvalidSealedCoefficients);
            zero_seal_tail(&mut data);
        }
        let input_nonce = ctx.accounts.sealed_showdown_coefficients.input_nonce;
        let sealed_key = ctx.accounts.sealed_showdown_coefficients.key();
        let args = ArgBuilder::new()
            .x25519_pubkey(player_encryption_pubkey)
            .plaintext_u128(input_nonce)
            .x25519_pubkey(player_encryption_pubkey)
            .plaintext_u128(input_nonce.wrapping_add(1))
            .build();
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![SealShowdownPairCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: sealed_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        let paid = ctx.accounts.computation_account.to_account_info().lamports();
        rent_vault::reimburse(
            ctx.remaining_accounts,
            &ctx.accounts.payer.to_account_info(),
            paid,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "seal_showdown_pair")]
    pub fn seal_showdown_pair_callback(
        ctx: Context<SealShowdownPairCallback>,
        output: SignedComputationOutputs<SealShowdownPairOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SealShowdownPairOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        let sealed = &mut ctx.accounts.sealed_showdown_coefficients;
        if accept_pending_callback(
            &mut sealed.pending_operation,
            ctx.accounts.computation_account.key(),
        )? {
            return Ok(());
        }
        let c0 = o.field_0;
        let c1 = o.field_1;
        require!(
            c0.encryption_key == c1.encryption_key,
            ErrorCode::InvalidSealedCoefficients
        );
        require!(
            c1.nonce == c0.nonce.wrapping_add(1),
            ErrorCode::InvalidSealedCoefficients
        );
        sealed.encryption_pubkey = c0.encryption_key;
        sealed.nonce = c0.nonce;
        sealed.coefficients_ciphertext[0] = c0.ciphertexts[0];
        sealed.coefficients_ciphertext[1] = c1.ciphertexts[0];
        sealed.coefficient_rows = o.field_2;
        sealed.slot_done = 0b11;
        sealed.coeffs_done = 2;
        sealed.folds_done = 1;
        sealed.pending_operation.status = PENDING_OPERATION_COMPLETED;
        Ok(())
    }

    pub fn init_distribute_and_settle_comp_def(ctx: Context<InitDistributeAndSettleCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn distribute_and_settle(
        ctx: Context<DistributeAndSettle>,
        computation_offset: u64,
        encrypted_winner_masks: [[u8; 32]; 9],
        encryption_pubkey: [u8; 32],
        nonce: u128,
        player_index: u8,
    ) -> Result<()> {
        // V2 settles every active seat in one callback.  Retain this entrypoint
        // only for local fixtures compiled with `--features testing`.
        require!(cfg!(feature = "testing"), ErrorCode::LegacySettlementDisabled);
        let game_state = &ctx.accounts.game_state;
        require!(game_state.phase == 5, ErrorCode::InvalidGamePhase);
        require!(game_state.showdown_hash != [0u8; 32], ErrorCode::InvalidProof);
        require!(game_state.showdown_finalized, ErrorCode::InvalidProof);
        require!(
            player_index < game_state.num_players,
            ErrorCode::InvalidGamePhase
        );
        require!(
            ctx.accounts.player_game_escrow.player_index == player_index
                && ctx.accounts.player_game_escrow.game_id == game_state.game_id,
            ErrorCode::InvalidGamePhase
        );
        require!(
            ctx.accounts.table_state.hand_in_progress
                && ctx.accounts.table_state.current_game_id == game_state.game_id
                && ctx.accounts.table_state.hand_num_players == game_state.num_players,
            ErrorCode::InvalidGamePhase
        );

        // Fused Arcis verify+settle: PDA sealed coeffs + Enc masks vs showdown_hash.
        // Groth16 must already have latched showdown_finalized / showdown_hash.
        {
            let sealed = &mut ctx.accounts.sealed_showdown_coefficients;
            require!(
                sealed.coefficients_ciphertext != [[0u8; 32]; 14],
                ErrorCode::InvalidSealedCoefficients
            );
            require!(
                sealed.n_active == 2
                    && sealed.coeffs_done == 2
                    && sealed.folds_done == 1
                    && seal_rows_revealed(&sealed.coefficient_rows),
                ErrorCode::InvalidSealedCoefficients
            );
            mark_seal_consumed(
                sealed,
                &ctx.accounts.table_state,
                game_state.showdown_hash_player,
            )?;
        }
        let sealed = &ctx.accounts.sealed_showdown_coefficients;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let (expected_hash_low, expected_hash_high) =
            showdown_hash_le_u128_halves(&game_state.showdown_hash);

        // Circuit: winner_masks Enc, sealed_coefficients Enc, expected_hash halves, ...
        let mut args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce);
        for i in 0..9 {
            args = args.encrypted_u64(encrypted_winner_masks[i]);
        }
        args = append_sealed_coeff_args(args, sealed, 2);
        args = args
            .plaintext_u128(expected_hash_low)
            .plaintext_u128(expected_hash_high)
            .plaintext_u8(game_state.num_players);
        for i in 0..9 {
            args = args.plaintext_u16(game_state.pot_eligible_masks[i]);
        }
        for i in 0..9 {
            args = args.plaintext_u64(game_state.pots[i]);
        }
        args = args
            .plaintext_u8(player_index)
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(ctx.accounts.player_game_escrow.nonce)
            .encrypted_u64(ctx.accounts.player_game_escrow.balance_ciphertext);
        let args = args.build();

        let game_state_key = ctx.accounts.game_state.key();
        let player_game_escrow_key = ctx.accounts.player_game_escrow.key();
        let table_state_key = ctx.accounts.table_state.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DistributeAndSettleCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: game_state_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: player_game_escrow_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: table_state_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "distribute_and_settle")]
    pub fn distribute_and_settle_callback(
        ctx: Context<DistributeAndSettleCallback>,
        output: SignedComputationOutputs<DistributeAndSettleOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(DistributeAndSettleOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        // field_1 = hash_matches from fused verify+settle; reject before any credit.
        require!(o.field_1, ErrorCode::InvalidProof);

        let escrow = &mut ctx.accounts.player_game_escrow;
        escrow.balance_ciphertext = o.field_0.ciphertexts[0];
        escrow.nonce = o.field_0.nonce;

        let game_state = &mut ctx.accounts.game_state;
        game_state.phase = 6;
        snapshot_next_hand_seats(game_state, &ctx.accounts.table_state);

        let table = &mut ctx.accounts.table_state;
        table.end_hand();

        emit!(PotDistributionEvent {
            game_id: game_state.game_id,
            total_payout: 0,
        });
        Ok(())
    }

    pub fn init_compute_pots_comp_def(ctx: Context<InitComputePotsCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn compute_pots(
        ctx: Context<ComputePots>,
        computation_offset: u64,
        encrypted_winner_masks: [[u8; 32]; 9],
        encryption_pubkey: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        // This produces plaintext payouts and cannot be the production V2 path.
        require!(cfg!(feature = "testing"), ErrorCode::LegacySettlementDisabled);
        let game_state = &ctx.accounts.game_state;

        require!(
            game_state.phase == 5, // Showdown
            ErrorCode::InvalidGamePhase
        );

        require!(
            game_state.showdown_hash != [0u8; 32],
            ErrorCode::InvalidProof
        );
        require!(
            game_state.showdown_finalized,
            ErrorCode::InvalidProof
        );

        // Fused Arcis verify+distribute: PDA sealed coeffs + Enc masks vs showdown_hash.
        // Groth16 must already have latched showdown_finalized / showdown_hash.
        {
            let sealed = &mut ctx.accounts.sealed_showdown_coefficients;
            require!(
                sealed.coefficients_ciphertext != [[0u8; 32]; 14],
                ErrorCode::InvalidSealedCoefficients
            );
            require!(
                sealed.n_active == 2
                    && sealed.coeffs_done == 2
                    && sealed.folds_done == 1
                    && seal_rows_revealed(&sealed.coefficient_rows),
                ErrorCode::InvalidSealedCoefficients
            );
            mark_seal_consumed(
                sealed,
                &ctx.accounts.table_state,
                game_state.showdown_hash_player,
            )?;
        }
        let sealed = &ctx.accounts.sealed_showdown_coefficients;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Full 32-byte Groth16 hash as LE limbs for BaseField25519 compare in Arcis.
        let (expected_hash_low, expected_hash_high) =
            showdown_hash_le_u128_halves(&game_state.showdown_hash);

        // Circuit arg order: winner_masks Enc, sealed_coefficients Enc,
        // expected_hash_low/high, num_players, pot_amounts
        let mut args = ArgBuilder::new()
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(nonce);
        for i in 0..9 {
            args = args.encrypted_u64(encrypted_winner_masks[i]);
        }
        args = append_sealed_coeff_args(args, sealed, 2);
        args = args
            .plaintext_u128(expected_hash_low)
            .plaintext_u128(expected_hash_high)
            .plaintext_u8(game_state.num_players);
        for i in 0..9 {
            args = args.plaintext_u16(game_state.pot_eligible_masks[i]);
        }
        for i in 0..9 {
            args = args.plaintext_u64(game_state.pots[i]);
        }
        let args = args.build();

        let game_state_key = ctx.accounts.game_state.key();
        let table_state_key = ctx.accounts.table_state.key();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputePotsCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: game_state_key,
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: table_state_key,
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_pots")]
    pub fn compute_pots_callback(
        ctx: Context<ComputePotsCallback>,
        output: SignedComputationOutputs<ComputePotsOutput>,
    ) -> Result<()> {
        let result = match output.verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account) {
            Ok(ComputePotsOutput { field_0 }) => field_0,
            Err(_) => return Err(error!(ArciumError::AbortedComputation)),
        };
        // field_1 = hash_matches from fused verify+distribute; reject before writing payouts.
        require!(result.field_1, ErrorCode::InvalidProof);

        let game_state = &mut ctx.accounts.game_state;

        // Store payouts per player
        for (slot, payout) in game_state.payouts.iter_mut().zip(result.field_0.iter()) {
            *slot = *payout;
        }
        let total_payout = result.field_0.iter().sum();
        let game_id = game_state.game_id;

        // Accepted payouts close the table. A rejected proof never reaches here.
        close_hand_after_pot_settlement(game_state, &mut ctx.accounts.table_state)?;

        emit!(PotDistributionEvent {
            game_id,
            total_payout,
        });

        Ok(())
    }
}


fn require_seal_caller(
    game_state: &GameState,
    table_state: &TableState,
    player_state: &PlayerState,
    payer: &Pubkey,
    player_index: u8,
) -> Result<()> {
    require!(
        player_index < game_state.num_players,
        ErrorCode::InvalidGamePhase
    );
    require_canonical_game_table(table_state, game_state)?;
    require!(
        table_state.hand_in_progress
            && table_state.current_game_id == game_state.game_id
            && table_state.hand_num_players == game_state.num_players,
        ErrorCode::InvalidGamePhase
    );
    let signer_index = player_index_for_pubkey(
        &table_state.seats,
        &table_state.hand_seat_order,
        table_state.hand_num_players,
        payer,
    )
    .ok_or(error!(ErrorCode::NotInHand))?;
    require!(signer_index == player_index, ErrorCode::InvalidAuthority);
    require!(
        player_state.game_id == game_state.game_id
            && player_state.player_index == player_index,
        ErrorCode::InvalidAuthority
    );
    require!(
        game_state.folded_mask & (1u16 << player_index) == 0,
        ErrorCode::InvalidAuthority
    );
    Ok(())
}

fn reset_showdown_seal(
    sealed: &mut SealedShowdownCoefficients,
    owner: Pubkey,
    game_id: [u8; 32],
    player_index: u8,
    encryption_pubkey: [u8; 32],
    nonce: u128,
    n_active: u8,
) {
    sealed.game_id = game_id;
    sealed.player_index = player_index;
    sealed.n_active = n_active;
    sealed.encryption_pubkey = encryption_pubkey;
    sealed.nonce = 0;
    sealed.input_nonce = nonce;
    sealed.coefficient_commitment = [0u8; 32];
    sealed.pending_operation = PendingOperation::default();
    sealed.coeffs_needed = n_active;
    sealed.coeffs_done = 0;
    sealed.folds_done = 0;
    sealed.row_latest = SealMxeRows::default();
    sealed.row_acc = SealMxeRows::default();
    sealed.owner = owner;
    sealed.consumed = false;
    sealed.slot_done = 0;
    sealed.coefficients_ciphertext = [[0u8; 32]; 14];
    sealed.coefficient_rows = [[0u8; 32]; 4];
}

fn slot_ready(bits: u16, slot: u8) -> bool {
    slot < 14 && bits & (1u16 << slot) != 0
}

fn write_seal_coeff(
    sealed: &mut SealedShowdownCoefficients,
    slot: usize,
    encryption_key: [u8; 32],
    nonce: u128,
    ciphertext: [u8; 32],
    row_nonce: u128,
    row_ciphertexts: [[u8; 32]; 4],
) -> Result<()> {
    require!(
        slot < 14 && slot < sealed.coeffs_needed as usize,
        ErrorCode::InvalidSealedCoefficients
    );
    if slot == 0 {
        sealed.encryption_pubkey = encryption_key;
        sealed.nonce = nonce;
    } else {
        require!(
            encryption_key == sealed.encryption_pubkey,
            ErrorCode::InvalidSealedCoefficients
        );
    }
    sealed.coefficients_ciphertext[slot] = ciphertext;
    if slot == 0 {
        sealed.row_acc = SealMxeRows {
            nonce: row_nonce,
            ciphertexts: row_ciphertexts,
        };
    }
    sealed.slot_done |= 1u16 << slot;
    sealed.coeffs_done = sealed.slot_done.count_ones() as u8;
    Ok(())
}

fn mark_seal_consumed(
    sealed: &mut SealedShowdownCoefficients,
    table: &TableState,
    showdown_player: u8,
) -> Result<()> {
    let owner_index = player_index_for_pubkey(
        &table.seats,
        &table.hand_seat_order,
        table.hand_num_players,
        &sealed.owner,
    )
    .ok_or(error!(ErrorCode::InvalidSealedCoefficients))?;
    require!(owner_index == showdown_player, ErrorCode::InvalidSealedCoefficients);
    require!(!sealed.consumed, ErrorCode::InvalidSealedCoefficients);
    sealed.consumed = true;
    Ok(())
}

fn mxe_row_args(mut args: ArgBuilder, rows: SealMxeRows) -> ArgBuilder {
    args = args.plaintext_u128(rows.nonce);
    for ciphertext in rows.ciphertexts {
        args = args.encrypted_u128(ciphertext);
    }
    args
}

fn append_sealed_coeff_args(
    mut args: ArgBuilder,
    sealed: &SealedShowdownCoefficients,
    n: usize,
) -> ArgBuilder {
    for slot in 0..n {
        args = args
            .x25519_pubkey(sealed.encryption_pubkey)
            .plaintext_u128(sealed.nonce.wrapping_add(slot as u128))
            .encrypted_u128(sealed.coefficients_ciphertext[slot]);
    }
    args
}

// ─── Room / Arcium account structs ───

#[account]
#[derive(InitSpace)]
pub struct PendingWithdraw {
    pub amount: u64,
}

#[queue_computation_accounts("debit_for_withdraw", payer)]
#[derive(Accounts)]
#[instruction(amount: u64, computation_offset: u64)]
pub struct WithdrawSpl<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], payer.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == payer.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(mut, address = room.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"room_wallet", payer.key().as_ref(), &room.room_id[..]],
        bump,
        constraint = room_wallet.in_hand_tables == 0 @ ErrorCode::InActiveHand
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        init,
        payer = payer,
        space = 8 + PendingWithdraw::INIT_SPACE,
        seeds = [b"pending_withdraw", payer.key().as_ref(), &room.room_id[..]],
        bump
    )]
    pub pending_withdraw: Account<'info, PendingWithdraw>,
    #[account(mut, constraint = player_token_account.mint == room.mint)]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("debit_for_withdraw")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("lock_table_buyin", payer)]
#[derive(Accounts)]
#[instruction(buy_in: u64, computation_offset: u64)]
pub struct LockTableBuyin<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room_wallet.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room_wallet.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room_wallet.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &table_escrow.room_id[..], &table_escrow.table_id.to_le_bytes()],
        bump
    )]
    pub table_escrow: Account<'info, TableEscrow>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("lock_table_buyin")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[derive(Accounts)]
pub struct CloseSeatRent<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    /// CHECK: this seat's MPC key. Closed into the rent vault.
    #[account(mut)]
    pub player_mpc_key: UncheckedAccount<'info>,
    /// CHECK: this seat's share-verify accumulator. Closed into the rent vault.
    #[account(mut)]
    pub share_verify_acc: UncheckedAccount<'info>,
    /// CHECK: showdown material for the proving seat. Program id means none.
    #[account(mut)]
    pub showdown_material: Option<UncheckedAccount<'info>>,
    /// CHECK: pending SPL deposit. Program id means none.
    #[account(mut)]
    pub pending_deposit: Option<UncheckedAccount<'info>>,
    /// CHECK: light-casino rent vault for `player`.
    #[account(mut)]
    pub rent_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LeaveTable<'info> {
    /// Writable so sit-out and leave can receive the rent-vault balance.
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &table_state.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == table_state.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &table_state.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_escrow: Account<'info, TableEscrow>,
    #[account(
        mut,
        seeds = [b"room_session", &table_state.room_id[..], player.key().as_ref()],
        bump,
        constraint = room_session.session == player.key() @ ErrorCode::InvalidSessionKey,
        constraint = room_session.room_id == table_state.room_id @ ErrorCode::InvalidSessionKey,
    )]
    pub room_session: Account<'info, session::RoomSessionKey>,
    #[account(
        mut,
        seeds = [b"room_session_lock", &table_state.room_id[..], room_session.owner.as_ref()],
        bump,
        constraint = room_session_lock.owner == room_session.owner @ ErrorCode::InvalidSessionKey,
        constraint = room_session_lock.room_id == table_state.room_id @ ErrorCode::InvalidSessionKey,
    )]
    pub room_session_lock: Account<'info, session::RoomSessionLock>,
}

#[queue_computation_accounts("unlock_table", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct UnlockTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
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
        constraint = table_state.table_id == table_escrow.table_id @ ErrorCode::InvalidTableId,
        constraint = !table_state.hand_in_progress @ ErrorCode::InActiveHand,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &room_wallet.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room_wallet.room_id[..], &table_escrow.table_id.to_le_bytes()],
        bump
    )]
    pub table_escrow: Account<'info, TableEscrow>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("unlock_table")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32])]
pub struct StartHand<'info> {
    /// Whitelisted player seated at this table. Not the room creator.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"room", &room.room_id[..]],
        bump,
    )]
    pub room: Box<Account<'info, Room>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], authority.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == authority.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Box<Account<'info, TableState>>,
    /// CHECK: Dealer pool PDA for casino coverage; may be uninitialized for poker and bingo.
    #[account(
        seeds = [b"dealer_pool", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + GameState::INIT_SPACE + 1920,
        seeds = [b"game_state", &game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
#[instruction(player_index: u8)]
pub struct InitPlayerState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player", &game_state.game_id[..], &[player_index]],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct EndHand<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"room", &room.room_id[..]],
        bump,
        constraint = room.authority == authority.key() @ ErrorCode::InvalidAuthority,
    )]
    pub room: Account<'info, Room>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room.room_id @ ErrorCode::InvalidAuthority,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump,
        constraint = game_state.table_room_id == table_state.room_id @ ErrorCode::InvalidAuthority,
        constraint = game_state.table_id == table_state.table_id @ ErrorCode::InvalidAuthority,
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[derive(Accounts)]
pub struct NextHandPlayer<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &table_state.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == table_state.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump,
        constraint = game_state.table_room_id == table_state.room_id @ ErrorCode::InvalidAuthority,
        constraint = game_state.table_id == table_state.table_id @ ErrorCode::InvalidAuthority,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"player", &game_state.game_id[..], &[player_state.player_index]],
        bump,
        constraint = player_state.game_id == game_state.game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub player_state: Account<'info, PlayerState>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct CloseSessionAccounts<'info> {
    pub authority: Signer<'info>,
    /// CHECK: receives the closed accounts' rent. The fee payer.
    #[account(mut)]
    pub rent_dest: UncheckedAccount<'info>,
    #[account(
        seeds = [b"room", &room.room_id[..]],
        bump,
        constraint = room.authority == authority.key() @ ErrorCode::InvalidAuthority,
    )]
    pub room: Account<'info, Room>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct CloseSession<'info> {
    pub authority: Signer<'info>,
    /// CHECK: receives the closed accounts' rent. The fee payer.
    #[account(mut)]
    pub rent_dest: UncheckedAccount<'info>,
    #[account(
        mut,
        close = rent_dest,
        seeds = [b"room", &room.room_id[..]],
        bump,
        constraint = room.authority == authority.key() @ ErrorCode::InvalidAuthority,
    )]
    pub room: Account<'info, Room>,
    #[account(
        mut,
        close = rent_dest,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room.room_id @ ErrorCode::InvalidAuthority,
        constraint = !table_state.hand_in_progress @ ErrorCode::InActiveHand,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(mut, address = room.mint @ ErrorCode::InvalidAuthority)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"vault", &room.room_id[..]],
        bump,
        token::mint = mint,
        token::authority = room,
    )]
    pub token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MarkInHand<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &table_state.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == table_state.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"room_wallet", player.key().as_ref(), &table_state.room_id[..]],
        bump
    )]
    pub room_wallet: Account<'info, RoomWallet>,
}

#[derive(Accounts)]
pub struct InitGameTableKey<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = 8 + GameTableKey::INIT_SPACE,
        seeds = [b"game_table_key", &game_state.game_id[..]],
        bump
    )]
    pub game_table_key: Account<'info, GameTableKey>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(player_index: u8, purpose: u8, generation: u64)]
pub struct InitPlayerMpcKey<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"player", &game_state.game_id[..], &[player_index]],
        bump,
        constraint = player_state.game_id == game_state.game_id @ ErrorCode::InvalidMpcKeyPurpose,
        constraint = player_state.player_index == player_index @ ErrorCode::InvalidMpcKeyPurpose,
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// When present, signer must be the seated player for `player_index`.
    pub table_state: Option<Box<Account<'info, TableState>>>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerMpcKey::INIT_SPACE,
        seeds = [
            b"player_mpc_key",
            &game_state.game_id[..],
            &[player_index],
            &[purpose],
            &generation.to_le_bytes()
        ],
        bump
    )]
    pub player_mpc_key: Box<Account<'info, PlayerMpcKey>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(player_index: u8)]
pub struct InitPlayerGameEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = 8 + PlayerGameEscrow::INIT_SPACE,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_index]],
        bump
    )]
    pub player_game_escrow: Account<'info, PlayerGameEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitEncryptedGameBetting<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = 8 + EncryptedGameBetting::INIT_SPACE,
        seeds = [b"encrypted_betting", &game_state.game_id[..]],
        bump
    )]
    pub encrypted_game_betting: Account<'info, EncryptedGameBetting>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitBetActionLog<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = BetActionLog::LEN,
        seeds = [b"bet_action_log", &game_state.game_id[..]],
        bump
    )]
    pub bet_action_log: AccountLoader<'info, BetActionLog>,
    pub system_program: Program<'info, System>,
}

macro_rules! wallet_comp_def_accounts {
    ($name:literal, $struct_name:ident) => {
        #[init_computation_definition_accounts($name, payer)]
        #[derive(Accounts)]
        pub struct $struct_name<'info> {
            #[account(mut)]
            pub payer: Signer<'info>,
            #[account(mut, address = derive_mxe_pda!())]
            pub mxe_account: Box<Account<'info, MXEAccount>>,
            #[account(mut)]
            /// CHECK: comp_def_account
            pub comp_def_account: UncheckedAccount<'info>,
            #[account(mut)]
            /// CHECK: address_lookup_table
            pub address_lookup_table: UncheckedAccount<'info>,
            /// CHECK: lut_program
            pub lut_program: UncheckedAccount<'info>,
            pub system_program: Program<'info, System>,
            pub arcium_program: Program<'info, Arcium>,
        }
    };
}

wallet_comp_def_accounts!("credit_room_balance", InitCreditRoomBalanceCompDef);
wallet_comp_def_accounts!("lock_table_buyin", InitLockTableBuyinCompDef);
wallet_comp_def_accounts!("unlock_table", InitUnlockTableCompDef);
wallet_comp_def_accounts!("debit_for_withdraw", InitDebitForWithdrawCompDef);

#[queue_computation_accounts("credit_room_balance", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RequestCreditRoomBalance<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], payer.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == payer.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(mut, seeds = [b"room_wallet", payer.key().as_ref(), &room.room_id[..]], bump)]
    pub room_wallet: Account<'info, RoomWallet>,
    /// Must hold a positive SPL-backed entitlement from `deposit_spl`.
    #[account(
        mut,
        seeds = [b"pending_deposit", payer.key().as_ref(), &room.room_id[..]],
        bump,
        constraint = pending_deposit.amount > 0 @ ErrorCode::NoPendingDeposit,
        constraint = pending_deposit.player == payer.key() @ ErrorCode::NoPendingDeposit,
        constraint = pending_deposit.room_id == room.room_id @ ErrorCode::NoPendingDeposit,
    )]
    pub pending_deposit: Account<'info, PendingDeposit>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("credit_room_balance")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("credit_room_balance", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CreditPokerRake<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], room.house.as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == room.house @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.room_id == room.room_id @ ErrorCode::InvalidTableId,
    )]
    pub table_state: Account<'info, TableState>,
    #[account(
        seeds = [b"game_state", &game_state.game_id[..]],
        bump,
        constraint = game_state.table_room_id == room.room_id @ ErrorCode::InvalidGamePhase,
        constraint = game_state.table_id == table_state.table_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"room_wallet", room.house.as_ref(), &room.room_id[..]],
        bump,
    )]
    pub house_wallet: Account<'info, RoomWallet>,
    #[account(
        constraint = house_token_account.mint == room.mint @ ErrorCode::HouseRakeWalletMissing,
        constraint = house_token_account.owner == room.house @ ErrorCode::HouseRakeWalletMissing,
    )]
    pub house_token_account: Account<'info, TokenAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("credit_room_balance")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("credit_room_balance")]
#[derive(Accounts)]
pub struct CreditRoomBalanceCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("credit_room_balance")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
}

#[callback_accounts("lock_table_buyin")]
#[derive(Accounts)]
pub struct LockTableBuyinCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("lock_table_buyin")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(mut)]
    pub table_escrow: Account<'info, TableEscrow>,
}

#[callback_accounts("unlock_table")]
#[derive(Accounts)]
pub struct UnlockTableCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("unlock_table")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(mut)]
    pub table_escrow: Account<'info, TableEscrow>,
}

#[callback_accounts("debit_for_withdraw")]
#[derive(Accounts)]
pub struct DebitForWithdrawCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("debit_for_withdraw")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Account<'info, Room>,
    #[account(mut, address = room.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(mut, close = payer)]
    pub pending_withdraw: Account<'info, PendingWithdraw>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("validate_bet", payer)]
#[derive(Accounts)]
pub struct InitValidateBetCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("validate_bet", payer)]
#[derive(Accounts)]
#[instruction(
    action: u8,
    _encrypted_action: [u8; 32],
    encrypted_amount: [u8; 32],
    encrypted_player_balance: [u8; 32],
    encrypted_player_current_bet: [u8; 32],
    encrypted_current_bet: [u8; 32],
    encrypted_last_aggressor_amount: [u8; 32],
    encryption_pubkey: [u8; 32],
    nonce: u128,
    computation_offset: u64,
)]
pub struct SubmitBet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub player: Signer<'info>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &table_state.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == table_state.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == player.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("validate_bet")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"player", &player_state.game_id, &[player_state.player_index]],
        bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        mut,
        seeds = [
            b"table_escrow",
            player.key().as_ref(),
            &table_state.room_id[..],
            &table_state.table_id.to_le_bytes()
        ],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated
    )]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("validate_bet")]
#[derive(Accounts)]
pub struct ValidateBetCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("validate_bet")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(seeds = [b"player", &player_state.game_id, &[player_state.player_index]], bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        mut,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_state.player_index]],
        bump
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(mut, seeds = [b"encrypted_betting", &game_state.game_id[..]], bump)]
    pub encrypted_game_betting: Box<Account<'info, EncryptedGameBetting>>,
    #[account(mut, seeds = [b"bet_action_log", &game_state.game_id[..]], bump)]
    pub bet_action_log: AccountLoader<'info, BetActionLog>,
}

#[derive(Accounts)]
pub struct ExpireBetTurn<'info> {
    #[account(mut)]
    pub crank: Signer<'info>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.hand_in_progress @ ErrorCode::HandInProgress,
        constraint = table_state.current_game_id == game_state.game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(mut, seeds = [b"encrypted_betting", &game_state.game_id[..]], bump)]
    pub encrypted_game_betting: Box<Account<'info, EncryptedGameBetting>>,
    #[account(mut, seeds = [b"bet_action_log", &game_state.game_id[..]], bump)]
    pub bet_action_log: AccountLoader<'info, BetActionLog>,
}

#[init_computation_definition_accounts("seal_showdown_pair", payer)]
#[derive(Accounts)]
pub struct InitSealShowdownPairCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("seal_showdown_pair", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, player_encryption_pubkey: [u8; 32], nonce: u128, player_index: u8)]
pub struct SealShowdownPair<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("seal_showdown_pair")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        seeds = [b"player", &game_state.game_id[..], &[player_index]],
        bump,
        constraint = player_state.game_id == game_state.game_id @ ErrorCode::InvalidAuthority,
        constraint = player_state.player_index == player_index @ ErrorCode::InvalidAuthority,
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SealedShowdownCoefficients::INIT_SPACE + SEAL_SLOT_TAIL,
        seeds = [b"sealed_showdown_coeffs", payer.key().as_ref()],
        bump
    )]
    pub sealed_showdown_coefficients: Box<Account<'info, SealedShowdownCoefficients>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("seal_showdown_pair")]
#[derive(Accounts)]
pub struct SealShowdownPairCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("seal_showdown_pair")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [
            b"sealed_showdown_coeffs",
            sealed_showdown_coefficients.owner.as_ref(),
        ],
        bump
    )]
    pub sealed_showdown_coefficients: Box<Account<'info, SealedShowdownCoefficients>>,
}

#[init_computation_definition_accounts("distribute_and_settle", payer)]
#[derive(Accounts)]
pub struct InitDistributeAndSettleCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("distribute_and_settle", payer)]
#[derive(Accounts)]
#[instruction(
    computation_offset: u64,
    encrypted_winner_masks: [[u8; 32]; 9],
    encryption_pubkey: [u8; 32],
    nonce: u128,
    player_index: u8
)]
pub struct DistributeAndSettle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("distribute_and_settle")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(seeds = [b"encrypted_betting", &game_state.game_id[..]], bump)]
    pub encrypted_game_betting: Box<Account<'info, EncryptedGameBetting>>,
    /// Seat-wallet seal. Settlement marks it consumed. The owner must be the
    /// showdown submitter's seat.
    #[account(
        mut,
        seeds = [
            b"sealed_showdown_coeffs",
            sealed_showdown_coefficients.owner.as_ref(),
        ],
        bump
    )]
    pub sealed_showdown_coefficients: Box<Account<'info, SealedShowdownCoefficients>>,
    #[account(
        mut,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_index]],
        bump
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Box<Account<'info, TableState>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("distribute_and_settle")]
#[derive(Accounts)]
pub struct DistributeAndSettleCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("distribute_and_settle")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [
            b"player_game_escrow",
            &game_state.game_id[..],
            &[player_game_escrow.player_index]
        ],
        bump
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.current_game_id == game_state.game_id @ ErrorCode::InvalidGamePhase
    )]
    pub table_state: Box<Account<'info, TableState>>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("settle_casino_hand", payer)]
#[derive(Accounts)]
pub struct InitSettleCasinoHandCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("settle_casino_hand", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SettleCasinoHand<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.hand_in_progress @ ErrorCode::InvalidGamePhase,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"game_state", &table_state.current_game_id],
        bump,
        constraint = table_state.current_game_id == game_state.game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], payer.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == payer.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    #[account(
        mut,
        seeds = [b"dealer_pool", &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: Box<Account<'info, DealerPool>>,
    #[account(
        mut,
        seeds = [b"protocol_treasury", &room.room_id[..]],
        bump,
    )]
    pub protocol_treasury: Box<Account<'info, ProtocolTreasury>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("settle_casino_hand")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("settle_casino_hand")]
#[derive(Accounts)]
pub struct SettleCasinoHandCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("settle_casino_hand")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut, seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"dealer_pool", &dealer_pool.room_id[..], &dealer_pool.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: Box<Account<'info, DealerPool>>,
    #[account(
        mut,
        seeds = [b"protocol_treasury", &protocol_treasury.room_id[..]],
        bump,
    )]
    pub protocol_treasury: Box<Account<'info, ProtocolTreasury>>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("stake_dealer_pool", payer)]
#[derive(Accounts)]
pub struct InitStakeDealerPoolCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("redeem_dealer_pool", payer)]
#[derive(Accounts)]
pub struct InitRedeemDealerPoolCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("apply_casino_player_net", payer)]
#[derive(Accounts)]
pub struct InitApplyCasinoPlayerNetCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("stake_dealer_pool", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, stake_amount: u64)]
pub struct StakeDealerPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], payer.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == payer.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    #[account(
        mut,
        seeds = [b"dealer_pool", &room.room_id[..], &dealer_pool.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: Box<Account<'info, DealerPool>>,
    #[account(mut, seeds = [b"room_wallet", payer.key().as_ref(), &room.room_id[..]], bump)]
    pub room_wallet: Box<Account<'info, RoomWallet>>,
    #[account(
        mut,
        seeds = [b"pool_stake", dealer_pool.key().as_ref(), payer.key().as_ref()],
        bump,
    )]
    pub pool_stake: Box<Account<'info, PoolStakeAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("stake_dealer_pool")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("stake_dealer_pool")]
#[derive(Accounts)]
pub struct StakeDealerPoolCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("stake_dealer_pool")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub dealer_pool: Account<'info, DealerPool>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(mut)]
    pub pool_stake: Account<'info, PoolStakeAccount>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("redeem_dealer_pool", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, redeem_amount: u64, shares_to_burn: u64)]
pub struct RedeemDealerPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], payer.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
        constraint = whitelist_entry.player == payer.key() @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    #[account(
        mut,
        seeds = [b"dealer_pool", &room.room_id[..], &dealer_pool.table_id.to_le_bytes()],
        bump,
    )]
    pub dealer_pool: Box<Account<'info, DealerPool>>,
    #[account(mut, seeds = [b"room_wallet", payer.key().as_ref(), &room.room_id[..]], bump)]
    pub room_wallet: Box<Account<'info, RoomWallet>>,
    #[account(
        mut,
        seeds = [b"pool_stake", dealer_pool.key().as_ref(), payer.key().as_ref()],
        bump,
        constraint = pool_stake.shares >= shares_to_burn @ ErrorCode::InsufficientBalance,
    )]
    pub pool_stake: Box<Account<'info, PoolStakeAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Box<Account<'info, ArciumSignerAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("redeem_dealer_pool")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("redeem_dealer_pool")]
#[derive(Accounts)]
pub struct RedeemDealerPoolCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("redeem_dealer_pool")))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub dealer_pool: Account<'info, DealerPool>,
    #[account(mut)]
    pub room_wallet: Account<'info, RoomWallet>,
    #[account(mut)]
    pub pool_stake: Account<'info, PoolStakeAccount>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("apply_casino_player_net", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, player_index: u8, player_net_abs: u64, player_won: bool)]
pub struct ApplyCasinoPlayerNet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.hand_in_progress @ ErrorCode::InvalidGamePhase,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        seeds = [b"game_state", &table_state.current_game_id],
        bump,
        constraint = table_state.current_game_id == game_state.game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated,
    )]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    #[account(
        mut,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_index]],
        bump,
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("apply_casino_player_net")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("apply_casino_player_net")]
#[derive(Accounts)]
pub struct ApplyCasinoPlayerNetCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("apply_casino_player_net")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("fund_player_game_escrow", payer)]
#[derive(Accounts)]
pub struct InitFundPlayerGameEscrowCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[init_computation_definition_accounts("return_player_game_escrow", payer)]
#[derive(Accounts)]
pub struct InitReturnPlayerGameEscrowCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("fund_player_game_escrow", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, player_index: u8, stake: u64)]
pub struct FundPlayerGameEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.hand_in_progress @ ErrorCode::InvalidGamePhase,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        seeds = [b"game_state", &table_state.current_game_id],
        bump,
        constraint = table_state.current_game_id == game_state.game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated,
    )]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    #[account(
        mut,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_index]],
        bump,
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("fund_player_game_escrow")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("fund_player_game_escrow")]
#[derive(Accounts)]
pub struct FundPlayerGameEscrowCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("fund_player_game_escrow")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    #[account(mut)]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
}

#[cfg(feature = "testing")]
#[queue_computation_accounts("return_player_game_escrow", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, player_index: u8)]
pub struct ReturnPlayerGameEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"room", &room.room_id[..]], bump)]
    pub room: Box<Account<'info, Room>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [whitelist::WHITELIST_SEED, &room.room_id[..], player.key().as_ref()],
        bump,
        constraint = whitelist_entry.room_id == room.room_id @ ErrorCode::NotWhitelisted,
    )]
    pub whitelist_entry: Box<Account<'info, WhitelistEntry>>,
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"table_escrow", player.key().as_ref(), &room.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_escrow.is_seated @ ErrorCode::NotSeated,
    )]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    #[account(
        mut,
        seeds = [b"player_game_escrow", &game_state.game_id[..], &[player_index]],
        bump,
    )]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("return_player_game_escrow")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[cfg(feature = "testing")]
#[callback_accounts("return_player_game_escrow")]
#[derive(Accounts)]
pub struct ReturnPlayerGameEscrowCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("return_player_game_escrow")))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub table_escrow: Box<Account<'info, TableEscrow>>,
    #[account(mut)]
    pub player_game_escrow: Box<Account<'info, PlayerGameEscrow>>,
}

#[event]
pub struct DepositEvent {
    pub room_id: [u8; 32],
    pub player: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct SetShowdownHash<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[derive(Accounts)]
pub struct SetPotAmounts<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct SetVerified<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[init_computation_definition_accounts("compute_pots", payer)]
#[derive(Accounts)]
pub struct InitComputePotsCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program, checked by arcium program.
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("compute_pots", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ComputePots<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account)
    )]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account)
    )]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account)
    )]
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("compute_pots"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(
        mut,
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    /// Seat-wallet seal. Settlement marks it consumed. The owner must be the
    /// showdown submitter's seat.
    #[account(
        mut,
        seeds = [
            b"sealed_showdown_coeffs",
            sealed_showdown_coefficients.owner.as_ref(),
        ],
        bump
    )]
    pub sealed_showdown_coefficients: Box<Account<'info, SealedShowdownCoefficients>>,
    #[account(
        mut,
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump
    )]
    pub table_state: Box<Account<'info, TableState>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("compute_pots")]
#[derive(Accounts)]
pub struct ComputePotsCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("compute_pots"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"table", &table_state.room_id[..], &table_state.table_id.to_le_bytes()],
        bump,
        constraint = table_state.hand_in_progress
            && table_state.current_game_id == game_state.game_id
            @ ErrorCode::InvalidGamePhase
    )]
    pub table_state: Box<Account<'info, TableState>>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = signer, space = 8 + 8)]
    pub data: Account<'info, Data>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCount<'info> {
    #[account(mut)]
    pub data: Account<'info, Data>,
}

#[derive(Accounts)]
pub struct ConsumeProofReceipt<'info> {
    /// light-casino `cpi_authority` PDA. No other signer may call this.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub game_state: Box<Account<'info, GameState>>,
    /// CHECK: owned by light-casino; validated in handler via seeds + layout.
    pub proof_receipt: UncheckedAccount<'info>,
    /// CHECK: required only for share receipts; validated in handler.
    pub share_verify_acc: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
// Must list all preceding ix args so `expected_player_index` aligns with
// `consume_register_receipt(generation, player_index, …)` instruction data.
#[instruction(expected_generation: u64, expected_player_index: u8)]
pub struct ConsumeRegisterReceipt<'info> {
    /// light-casino `cpi_authority` PDA. No other signer may call this.
    /// Must be mutable and funded — pays rent for the poker `PlayerState` PDA.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = authority,
        space = 8 + PlayerState::INIT_SPACE,
        seeds = [b"player".as_slice(), &game_state.game_id[..], &[expected_player_index][..]],
        bump
    )]
    pub player_state: Account<'info, PlayerState>,
    /// CHECK: owned by light-casino; validated in handler via seeds + layout.
    pub proof_receipt: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPreflop<'info> {
    #[account(
        mut,
        constraint = is_betting_round_authority(&authority.key()) @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct StartBettingRound<'info> {
    #[account(
        mut,
        constraint = is_betting_round_authority(&authority.key()) @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct CollectBlinds<'info> {
    #[account(
        mut,
        constraint = is_betting_round_authority(&authority.key()) @ ErrorCode::NotWhitelistAdmin
    )]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    /// Required for testing collect_blinds (Enc betting path present).
    #[account(
        mut,
        seeds = [b"encrypted_betting", &game_state.game_id[..]],
        bump
    )]
    pub encrypted_game_betting: Option<Box<Account<'info, EncryptedGameBetting>>>,
}

#[derive(Accounts)]
pub struct BeginVerifyDeckHash<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + VerifyDeckHashAccumulator::INIT_SPACE,
        seeds = [b"verify_accumulator".as_ref(), &game_state.game_id],
        bump
    )]
    pub verify_accumulator: Box<Account<'info, VerifyDeckHashAccumulator>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncVerifyDeckHash<'info> {
    /// Deck staging rent payer — sole party allowed to latch verify state.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump,
        constraint = authority.key() == game_state.staging_authority @ ErrorCode::UnauthorizedStagingAuthority
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"verify_accumulator".as_ref(), &game_state.game_id],
        bump
    )]
    pub verify_accumulator: Box<Account<'info, VerifyDeckHashAccumulator>>,
}

#[derive(Accounts)]
#[instruction(player_index: u8)]
pub struct BeginVerifyShareHash<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        seeds = [
            b"player_mpc_key",
            &game_state.game_id[..],
            &[player_index],
            &[1],
            &player_mpc_key.generation.to_le_bytes(),
        ],
        bump
    )]
    pub player_mpc_key: Account<'info, PlayerMpcKey>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ShareVerifyAccumulator::INIT_SPACE,
        seeds = [b"share_verify_acc", &game_state.game_id[..], &[player_index]],
        bump
    )]
    pub share_verify_acc: Box<Account<'info, ShareVerifyAccumulator>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncVerifyShareHash<'info> {
    #[account(
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [
            b"share_verify_acc",
            &game_state.game_id[..],
            &[share_verify_acc.player_index]
        ],
        bump
    )]
    pub share_verify_acc: Box<Account<'info, ShareVerifyAccumulator>>,
}

#[derive(Accounts)]
pub struct FinalizeSharePhase<'info> {
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[derive(Accounts)]
pub struct ReopenShareForNextChunk<'info> {
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[init_computation_definition_accounts("verify_deck_hash_chunk", payer)]
#[derive(Accounts)]
pub struct InitVerifyDeckHashChunkCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program, checked by arcium program.
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("verify_deck_hash_chunk", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, deck_account_pubkey: Pubkey)]
pub struct VerifyDeckHashChunk<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account)
    )]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account)
    )]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account)
    )]
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("verify_deck_hash_chunk"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(
        mut,
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    /// Continuous-hand GameState (`seeds = [b"game_state", game_id]`).
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"verify_accumulator".as_ref(), &game_state.game_id],
        bump
    )]
    pub verify_accumulator: Box<Account<'info, VerifyDeckHashAccumulator>>,
    /// CHECK: deck staging / encrypted commitments read by Arcis (VERIFY_CHUNK_BYTES slice).
    /// Must be present so queue_computation can reference the account data.
    pub deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("verify_deck_hash_chunk")]
#[derive(Accounts)]
pub struct VerifyDeckHashChunkCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("verify_deck_hash_chunk"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        owner = crate::id()
    )]
    /// CHECK: callback-owned global or per-player accumulator; discriminator
    /// and contents are validated by the callback.
    pub verify_accumulator: UncheckedAccount<'info>,
}

#[queue_computation_accounts("verify_deck_hash_chunk", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, deck_account_pubkey: Pubkey)]
pub struct VerifyShareHashChunk<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account)
    )]
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("verify_deck_hash_chunk"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(
        seeds = [b"game_state", &game_state.game_id],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [
            b"share_verify_acc",
            &game_state.game_id[..],
            &[share_verify_acc.player_index]
        ],
        bump
    )]
    pub share_verify_acc: Box<Account<'info, ShareVerifyAccumulator>>,
    #[account(
        seeds = [
            b"share_deck_staging",
            &game_state.game_id[..],
            &[share_verify_acc.player_index]
        ],
        bump,
        address = deck_account_pubkey
    )]
    /// CHECK: raw recipient-major encrypted share limbs.
    pub share_deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}


#[init_computation_definition_accounts("reveal_card", payer)]
#[derive(Accounts)]
pub struct InitRevealCardCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program, checked by arcium program.
    pub lut_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[derive(Accounts)]
#[instruction(generation: u64, recipient_index: u8)]
pub struct BeginShowdownMaterial<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ShowdownMaterialCommitment::INIT_SPACE,
        seeds = [
            b"showdown_material",
            &game_state.game_id[..],
            &generation.to_le_bytes(),
            &[recipient_index],
        ],
        bump
    )]
    pub showdown_material: Box<Account<'info, ShowdownMaterialCommitment>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(generation: u64, recipient_index: u8)]
pub struct SyncShowdownMaterial<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [
            b"showdown_material",
            &game_state.game_id,
            &generation.to_le_bytes(),
            &[recipient_index],
        ],
        bump
    )]
    pub showdown_material: Box<Account<'info, ShowdownMaterialCommitment>>,
}

#[queue_computation_accounts("reveal_card", payer)]
#[derive(Accounts)]
#[instruction(
    computation_offset: u64,
    deck_account_pubkey: Pubkey,
    encryption_pubkey: [u8; 32],
    base_nonce: u128,
    card_index: u16,
    start_index: u16,
    from_offset: u8,
    dest_offset: u8,
    chunk_count: u8,
    total_count: u8,
    recipient_index: u8,
)]
pub struct RevealCard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub recipient: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 9,
        seeds = [b"ArciumSignerAccount"],
        bump,
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account)
    )]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account)
    )]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account)
    )]
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("reveal_card"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(
        mut,
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(
        seeds = [b"game_state", &game_state.game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        seeds = [b"deck_staging", &game_state.game_id[..]],
        bump
    )]
    /// CHECK: deck staging / encrypted deck account read by Arcis (full 28,800 bytes)
    pub deck_staging: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RevealedCard::INIT_SPACE,
        seeds = [
            b"RevealedCard",
            &game_state.game_id[..],
            &[recipient_index],
            &card_index.to_le_bytes()
        ],
        bump
    )]
    pub revealed_card: Box<Account<'info, RevealedCard>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("reveal_card")]
#[derive(Accounts)]
pub struct RevealCardCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(::arcium_anchor::comp_def_offset("reveal_card"))
    )]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [
            b"RevealedCard",
            &revealed_card.game_id,
            &[revealed_card.recipient_index],
            &revealed_card.card_index.to_le_bytes()
        ],
        bump
    )]
    pub revealed_card: Box<Account<'info, RevealedCard>>,
    #[account(
        mut,
        seeds = [b"game_state", &revealed_card.game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[derive(Accounts)]
pub struct CloseRevealedCard<'info> {
    pub authority: Signer<'info>,
    #[account(mut, address = revealed_card.refund_to)]
    /// CHECK: original reveal account payer; address is stored in RevealedCard.
    pub refund_to: UncheckedAccount<'info>,
    #[account(
        seeds = [b"game_state", &revealed_card.game_id[..]],
        bump,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        close = refund_to,
        seeds = [
            b"RevealedCard",
            &revealed_card.game_id,
            &[revealed_card.recipient_index],
            &revealed_card.card_index.to_le_bytes()
        ],
        bump
    )]
    pub revealed_card: Account<'info, RevealedCard>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32])]
pub struct WriteDeckStaging<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"game_state", &game_id[..]],
        bump,
        constraint = game_state.game_id == game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    /// Table that owns this hand; membership checked in the handler.
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"deck_staging", &game_id[..]],
        bump
    )]
    /// CHECK: raw headerless deck staging buffer; PDA seeds bind the target.
    pub deck_staging: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32], offset: u32)]
pub struct WriteRevealChunk<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Rent returns here when the chunk is absorbed. The lane signs the write,
    /// so it consents to this destination. The same wallet can be named by
    /// every parallel chunk.
    /// CHECK: recorded in the chunk header and matched at absorb.
    pub refund: UncheckedAccount<'info>,
    #[account(
        seeds = [b"game_state", &game_id[..]],
        bump,
        constraint = game_state.game_id == game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = reveal_chunks::REVEAL_CHUNK_ACCOUNT_SIZE,
        seeds = [b"reveal_chunk", &game_id[..], &offset.to_le_bytes()],
        bump,
    )]
    /// CHECK: raw chunk buffer; the handler writes the header and payload.
    pub chunk: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32])]
pub struct AbsorbRevealChunks<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"game_state", &game_id[..]],
        bump,
        constraint = game_state.game_id == game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"deck_staging", &game_id[..]],
        bump,
    )]
    /// CHECK: raw deck staging buffer; chunk bytes are copied in by the handler.
    pub deck_staging: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32], player_index: u8)]
pub struct WriteShareDeckStaging<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"game_state", &game_id[..]],
        bump,
        constraint = game_state.game_id == game_id @ ErrorCode::InvalidGamePhase,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    /// Table that owns this hand; membership checked in the handler.
    pub table_state: Account<'info, TableState>,
    #[account(
        mut,
        seeds = [b"share_deck_staging", &game_id[..], &[player_index]],
        bump
    )]
    /// CHECK: raw headerless share staging buffer; PDA seeds bind the target.
    pub share_deck_staging: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32], num_players: u8, num_cards: u8)]
pub struct InitializeGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + GameState::INIT_SPACE + 1920,
        seeds = [b"game_state", &game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32])]
pub struct CreateDeckStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_id[..]],
        bump
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        init,
        payer = payer,
        space = DECK_STAGING_INITIAL_SIZE,
        seeds = [b"deck_staging", &game_id[..]],
        bump
    )]
    /// CHECK: raw staging buffer; grown via `extend_deck_staging`.
    /// Not `Account<DeckStaging>` — that would stack-allocate 28,800 bytes on init.
    pub deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: [u8; 32], player_index: u8)]
pub struct CreateShareDeckStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_id[..]], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        init,
        payer = payer,
        space = DECK_STAGING_INITIAL_SIZE,
        seeds = [b"share_deck_staging", &game_id[..], &[player_index]],
        bump
    )]
    /// CHECK: raw recipient-major staging buffer.
    pub share_deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(player_index: u8)]
pub struct ExtendShareDeckStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"game_state", &game_state.game_id], bump)]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        mut,
        seeds = [b"share_deck_staging", &game_state.game_id[..], &[player_index]],
        bump
    )]
    /// CHECK: raw recipient-major staging buffer.
    pub share_deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(player_index: u8)]
pub struct CloseShareDeckStaging<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"game_state", &game_state.game_id],
        bump,
    )]
    pub game_state: Box<Account<'info, GameState>>,
    #[account(
        seeds = [b"table", &game_state.table_room_id[..], &game_state.table_id.to_le_bytes()],
        bump,
    )]
    pub table_state: Box<Account<'info, TableState>>,
    #[account(
        mut,
        seeds = [b"share_deck_staging", &game_state.game_id[..], &[player_index]],
        bump
    )]
    /// CHECK: closed after share phase finalize; rent → staging_authority only.
    pub share_deck_staging: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ExtendDeckStaging<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: must be the deck_staging PDA; grown toward DECK_STAGING_ACCOUNT_SIZE.
    #[account(mut)]
    pub deck_staging: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordReveal<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"game_state", &game_state.game_id],
        bump,
        constraint = authority.key() == game_state.staging_authority @ ErrorCode::UnauthorizedStagingAuthority
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[derive(Accounts)]
pub struct CloseDeckStaging<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"deck_staging", &game_state.game_id],
        bump
    )]
    /// CHECK: closed manually in `close_deck_staging` (avoids deserializing commitments).
    pub deck_staging: UncheckedAccount<'info>,
    #[account(
        seeds = [b"game_state", &game_state.game_id],
        bump,
        constraint = authority.key() == game_state.staging_authority @ ErrorCode::UnauthorizedStagingAuthority
    )]
    pub game_state: Box<Account<'info, GameState>>,
}

#[error_code]
pub enum ErrorCode {
    ClusterNotSet,
    #[msg("Invalid MPC key purpose, seat, or zero public key")]
    InvalidMpcKeyPurpose,
    #[msg("Account is not owned by the poker program")]
    InvalidAccountOwner,
    #[msg("Write exceeds account bounds")]
    WriteExceedsBounds,
    #[msg("Target is not the game's raw staging PDA")]
    InvalidStagingTarget,
    #[msg("Not all cards have been revealed yet")]
    RevealsNotComplete,
    #[msg("Invalid game phase for this action")]
    InvalidGamePhase,
    #[msg("Not your turn")]
    NotYourTurn,
    #[msg("Player already shared")]
    AlreadyShared,
    #[msg("Player already registered")]
    PlayerAlreadyRegistered,
    #[msg("Invalid bet")]
    InvalidBet,
    #[msg("Invalid proof")]
    InvalidProof,
    #[msg("Invalid proof receipt")]
    InvalidProofReceipt,
    #[msg("Proof receipt already consumed")]
    ProofReceiptAlreadyConsumed,
    #[msg("Showdown proof materials were not independently verified")]
    ShowdownMaterialsNotVerified,
    #[msg("Unauthorized CPI caller")]
    UnauthorizedCpiCaller,
    #[msg("Invalid seat number")]
    InvalidSeat,
    #[msg("Seat is already taken")]
    SeatTaken,
    #[msg("Player already seated at this table")]
    AlreadySeated,
    #[msg("Player is not seated")]
    NotSeated,
    #[msg("Not enough players to start hand")]
    NotEnoughPlayers,
    #[msg("Hand already in progress")]
    HandInProgress,
    #[msg("Player not in active hand")]
    NotInHand,
    #[msg("Cannot leave or withdraw during active hand")]
    InActiveHand,
    #[msg("Invalid table id")]
    InvalidTableId,
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Invalid game kind for dealer pool")]
    InvalidGameKind,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Dealer pool cannot cover max payout for this hand")]
    InsufficientDealerCoverage,
    #[msg("Bet action log is full")]
    BetLogFull,
    #[msg("Player is not on the room whitelist")]
    NotWhitelisted,
    #[msg("Signer is not the whitelist admin")]
    NotWhitelistAdmin,
    #[msg("Invalid card or commitment index")]
    InvalidCardIndex,
    #[msg("Card reveal not allowed for current betting phase")]
    CardRevealNotAllowed,
    #[msg("Reveal signer is not the requested recipient")]
    InvalidRevealRecipient,
    #[msg("Deck hash verify chunks must run in order")]
    InvalidVerifyProgress,
    #[msg("Card index is unused for this hand (empty-seat hole or undealt deck)")]
    CardIndexNotInPlay,
    #[msg("Folded hole cards were mucked and cannot be revealed")]
    HoleCardsMucked,
    #[msg("Sealed showdown coefficients missing or not bound to the showdown submitter")]
    InvalidSealedCoefficients,
    #[msg("Signer is not the deck staging rent payer for this game")]
    UnauthorizedStagingAuthority,
    #[msg("No SPL-backed pending deposit entitlement for encrypted credit")]
    NoPendingDeposit,
    #[msg("Staging write offset or length is not 32-byte limb aligned")]
    StagingWriteMisaligned,
    #[msg("Pot levels are not a valid conserved canonical pot set")]
    InvalidCanonicalPot,
    #[msg("An async operation is still pending; retry after its expiry slot")]
    PendingOperationActive,
    #[msg("Async callback expired before it was delivered")]
    PendingOperationExpired,
    #[msg("Callback does not match the active operation generation")]
    StaleCallback,
    #[msg("Settlement is not in a state that permits this transition")]
    InvalidSettlementState,
    #[msg("Settlement callback does not match the pending computation")]
    StaleSettlementCallback,
    #[msg("Settlement has not reached its refund expiry")]
    SettlementNotExpired,
    #[msg("Every active seat escrow must be supplied exactly once")]
    MissingSettlementSeat,
    #[msg("Legacy one-seat settlement is disabled outside testing")]
    LegacySettlementDisabled,
    #[msg("Casino account is missing or is not a tenant of this program")]
    InvalidCasino,
    #[msg("Signer is not a delegated admin of this casino")]
    NotCasinoAdmin,
    #[msg("House encrypted wallet is not ready to receive the rake")]
    HouseRakeWalletMissing,
    #[msg("This player already has a session key at this table")]
    SessionAlreadyPlaying,
    #[msg("Session key is not playing this table")]
    SessionNotPlaying,
    #[msg("Session key does not belong to this owner")]
    InvalidSessionKey,
    #[msg("The betting decision window has expired")]
    ActionExpired,
    #[msg("The betting decision window is still open")]
    ActionNotExpired,
}

#[account]
#[derive(Default)]
pub struct Data {
    pub count: u64,
}

/// Staging PDA for encrypted deck data during a single game.
///
/// Created at game start, populated via typed staging writes, read by Arcis MPC.
/// Closed after all verifications/reveals complete — rent is fully refunded.
#[account]
pub struct DeckStaging {
    pub game_id: [u8; 32],
    pub commitments: [[u8; 32]; 900],
}

/// Temporary PDA storing revealed threshold-decryption partials for ONE card.
///
/// The number of valid partials depends on the number of players:
///   - 2 players: 1 partial  = 4 values
///   - 5 players: 4 partials = 16 values
///   - 10 players: 9 partials = 36 values (max)
///
/// The `count` field stores how many values are valid (num_players - 1) * 4.
/// The remaining slots are zeroed and ignored.
///
/// Created by the Arcis reveal_card callback, closed by the client after
/// storing in a Light Protocol compressed account.
#[account]
#[derive(InitSpace)]
pub struct RevealedCard {
    pub game_id: [u8; 32],
    /// Monotonic hand generation; prevents old reveal callbacks crossing hands.
    pub generation: u64,
    /// Player whose public encryption key this section is sealed to.
    pub recipient_index: u8,
    /// Total expected BN254 values in `partials` (num_players - 1) * 4
    pub count: u8,
    /// Number of distinct filled slots.
    pub filled: u8,
    /// Exact coverage bitmap for the 36 possible slots.
    pub filled_bits: u64,
    /// Card index in the deck (0-based)
    pub card_index: u16,
    /// Recipient signer authorized to read/close this record.
    pub recipient_authority: Pubkey,
    /// Original account payer; receives the rent refund.
    pub refund_to: Pubkey,
    /// Each reveal job is generation- and computation-bound before its callback
    /// may write a previously empty limb range.
    pub pending_operation: PendingOperation,
    /// Resealed ciphertext partials. Max 36 values (10-player game).
    pub partials: [[u8; 32]; 36],
}

/// Immutable receipt produced when a `RevealedCard` reaches exact coverage.
/// Light persistence must consume this PDA before the source record can close.
#[account]
#[derive(Default, InitSpace)]
pub struct RevealReceipt {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub recipient_index: u8,
    pub card_index: u16,
    pub count: u8,
    /// SHA-256 over the domain-separated reveal tuple and exactly `count` limbs.
    pub partials_commitment: [u8; 32],
    pub persistence_consumed: bool,
}

fn reveal_receipt_commitment(
    game_id: &[u8; 32],
    generation: u64,
    recipient_index: u8,
    card_index: u16,
    count: u8,
    partials: &[[u8; 32]; 36],
) -> [u8; 32] {
    use solana_sha256_hasher::hashv;
    let generation_bytes = generation.to_le_bytes();
    let card_bytes = card_index.to_le_bytes();
    let count_bytes = [count];
    let recipient_bytes = [recipient_index];
    let mut chunks: Vec<&[u8]> = vec![
        b"zk-poker-reveal-receipt-v2",
        game_id,
        &generation_bytes,
        &recipient_bytes,
        &card_bytes,
        &count_bytes,
    ];
    for partial in partials.iter().take(count as usize) {
        chunks.push(partial);
    }
    hashv(&chunks).to_bytes()
}

/// Canonical sealed-limb reveal coverage for one showdown recipient.
///
/// Seeds: `[b"showdown_material", game_id, generation_le, recipient_index]`.
/// Each set bit means the corresponding showdown card has a complete,
/// recipient-scoped `RevealedCard` containing only Arcis-resealed ciphertext
/// limbs. Light/Circom hash those limbs directly; this account stores no digest.
#[account]
#[derive(Default, InitSpace)]
pub struct ShowdownMaterialCommitment {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub recipient_index: u8,
    /// Coverage over card indices 0..num_players*2+5 (at most 25 today).
    pub card_filled_bits: u64,
    pub complete: bool,
}

/// Arcis-sealed showdown poly-hash coefficients for one proving player.
///
/// Produced by the pair seal and consumed by
/// `compute_pots` / `distribute_and_settle`. Seeds:
/// `[b"sealed_showdown_coeffs", owner]`.
#[account]
#[derive(Default, InitSpace)]
pub struct SealedShowdownCoefficients {
    pub game_id: [u8; 32],
    pub player_index: u8,
    /// Live polynomial terms. Every game seals two.
    pub n_active: u8,
    /// Enc<Shared, [u128; 14]> ciphertexts
    pub coefficients_ciphertext: [[u8; 32]; 14],
    pub encryption_pubkey: [u8; 32],
    pub nonce: u128,
    /// Subset-sum rows the seal commit revealed (big-endian, each below 2^253).
    /// The showdown input hash Poseidon-binds these with the other statement fields.
    pub coefficient_rows: [[u8; 32]; 4],
    /// Kept so later fields stay at a fixed offset. The seal commit does not write it.
    pub coefficient_commitment: [u8; 32],
    pub pending_operation: PendingOperation,
    /// Nonce passed into the first seal. Slot `i` is encrypted under this plus `i`.
    /// `nonce` is the Rescue nonce for slot 0 (the circuit advances the input by one).
    pub input_nonce: u128,
    /// Live polynomial terms. One `seal_showdown_pair` call writes both.
    pub coeffs_needed: u8,
    /// Coefficient callbacks completed. The next slot is this index.
    pub coeffs_done: u8,
    /// Row-fold callbacks completed. Commit requires `folds_done + 1 == coeffs_needed`.
    pub folds_done: u8,
    /// MXE ciphertext of the latest coefficient's rows, waiting to be folded.
    pub row_latest: SealMxeRows,
    /// Running sum of the row contributions.
    pub row_acc: SealMxeRows,
    /// Seat wallet. The account address is this key, so the next hand can reuse
    /// coefficients that a showdown has not consumed.
    pub owner: Pubkey,
    /// Set when settlement uses this seal.
    pub consumed: bool,
    /// Bit `i` is set once coefficient slot `i` has landed.
    pub slot_done: u16,
}

/// Per-slot jobs and row ciphertexts live after the Anchor body so account
/// deserialization stays inside the SBF stack. 14 jobs then 14 rows.
const SEAL_SLOT_COUNT: usize = 14;
const SEAL_SLOT_TAIL: usize = SEAL_SLOT_COUNT * 32 + SEAL_SLOT_COUNT * 144;

fn seal_tail_base() -> usize {
    8 + SealedShowdownCoefficients::INIT_SPACE
}

fn seal_account_space() -> usize {
    seal_tail_base() + SEAL_SLOT_TAIL
}

fn write_slot_job(data: &mut [u8], slot: usize, job: &Pubkey) {
    let start = seal_tail_base() + slot * 32;
    data[start..start + 32].copy_from_slice(job.as_ref());
}

fn slot_job_is_set(data: &[u8], slot: usize) -> bool {
    let start = seal_tail_base() + slot * 32;
    data[start..start + 32].iter().any(|byte| *byte != 0)
}

fn slot_job_matches(data: &[u8], slot: usize, job: &Pubkey) -> bool {
    let start = seal_tail_base() + slot * 32;
    &data[start..start + 32] == job.as_ref()
}

fn write_slot_row(data: &mut [u8], slot: usize, rows: &SealMxeRows) {
    let start = seal_tail_base() + SEAL_SLOT_COUNT * 32 + slot * 144;
    data[start..start + 16].copy_from_slice(&rows.nonce.to_le_bytes());
    for (index, ciphertext) in rows.ciphertexts.iter().enumerate() {
        let at = start + 16 + index * 32;
        data[at..at + 32].copy_from_slice(ciphertext);
    }
}

fn read_slot_row(data: &[u8], slot: usize) -> SealMxeRows {
    let start = seal_tail_base() + SEAL_SLOT_COUNT * 32 + slot * 144;
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&data[start..start + 16]);
    let mut ciphertexts = [[0u8; 32]; 4];
    for index in 0..4 {
        let at = start + 16 + index * 32;
        ciphertexts[index].copy_from_slice(&data[at..at + 32]);
    }
    SealMxeRows {
        nonce: u128::from_le_bytes(nonce),
        ciphertexts,
    }
}

fn zero_seal_tail(data: &mut [u8]) {
    let start = seal_tail_base();
    data[start..start + SEAL_SLOT_TAIL].fill(0);
}

/// `Enc<Mxe, [BaseField25519; 4]>` as the seal callbacks store it.
/// Appended after the fields Light and zig read, so those offsets stay put.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct SealMxeRows {
    pub nonce: u128,
    pub ciphertexts: [[u8; 32]; 4],
}

#[account]
#[derive(Default, InitSpace)]
pub struct PlayerState {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub public_key: [[u8; 32]; 2],
    pub padding: [[u8; 32]; 4],
    pub action: u8,
    /// Pending show-on-fold request for the in-flight `submit_bet` (default muck).
    pub show_on_fold: bool,
}

#[account]
#[derive(Default, InitSpace)]
pub struct VerifyDeckHashAccumulator {
    /// Game this callback-owned accumulator belongs to.
    pub game_id: [u8; 32],
    /// Running Poseidon(4) sum (LE u128 low || u128 high), wrapping modulo 2^256.
    pub verify_hash_acc: [u8; 32],
    /// Expected Poseidon(4) sum latched at the start of a verification round.
    pub verify_expected: [u8; 32],
    /// Number of commitments covered by delivered callbacks.
    pub verify_progress: u16,
    /// Progress value at which verification is complete (used cards × active limbs).
    pub verify_target: u16,
    /// Completion bitset for the 900 commitment indices.
    pub verify_bits: [u64; 15],
    /// Final hash comparison result once all chunks arrive.
    pub verified: bool,
    /// True while chunk callbacks are expected.
    pub verify_started: bool,
}

#[account]
#[derive(Default, InitSpace)]
pub struct ShareVerifyAccumulator {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub num_players: u8,
    pub generation: u64,
    pub encryption_pubkey: [u8; 32],
    pub verify_hash_acc: [u8; 32],
    pub verify_expected: [u8; 32],
    pub verify_progress: u16,
    pub verify_target: u16,
    pub verify_bits: [u64; 15],
    pub verified: bool,
    pub frozen: bool,
    /// Card window for this verify round (BJ chunk=16; else game.num_cards).
    pub share_cards: u8,
}

#[account]
#[derive(Default, InitSpace)]
pub struct GameState {
    pub verified: bool,
    /// True only after every player's Groth16 receipt and Arcis share hash agree.
    pub share_finalized: bool,
    /// Contiguous casino cards covered by finalized share rounds (lazy BJ prefix).
    /// Reveal allows `card_index < shared_cards` when this is non-zero.
    pub shared_cards: u16,
    /// True only after light-casino `finalize_showdown` CPI-consumes the showdown receipt.
    pub showdown_finalized: bool,
    pub hash: u128,
    /// Poker only: fold / side-pot contestant bitmask. Zero for other games.
    pub pot_mask: u16,
    /// Game identifier
    pub game_id: [u8; 32],
    /// Incremented for each queued async operation in this game.
    pub async_generation: u64,
    /// Canonical table identity for this hand.
    pub table_room_id: [u8; 32],
    pub table_id: u64,
    /// Number of players in this game
    pub num_players: u8,
    /// Number of cards in the deck
    pub num_cards: u8,
    /// Total partials to reveal = num_cards * (num_players - 1)
    pub total_partials: u8,
    /// Partials revealed so far (partial units = n-1 per completed card; not limbs).
    pub revealed_partials: u8,
    /// Rent payer of `deck_staging`; sole signer for `record_reveal` / `close_deck_staging`.
    pub staging_authority: Pubkey,
    /// Game phase: 0=registration, 1=shuffle, 2=share, 3=evaluation, 4=complete, 5=showdown, 6=pots_distributed
    pub phase: u8,
    // ─── Betting Fields ───
    /// Betting phase: 0=not started, 1=preflop, 2=flop, 3=turn, 4=river, 5=showdown
    pub betting_phase: u8,
    /// Current player index (whose turn it is)
    pub current_player: u8,
    /// Current bet amount to call
    pub current_bet: u64,
    /// Last aggressor player index
    pub last_aggressor: u8,
    /// Last aggressor's bet amount
    pub last_aggressor_amount: u64,
    /// Bitmap of folded players
    pub folded_mask: u16,
    /// Bitmap of folded players who opted to show hole cards (else muck).
    pub show_on_fold_mask: u16,
    /// Bitmap of all-in players
    pub all_in_mask: u16,
    /// Bitmap of players who have submitted share partials (parallel share phase)
    pub shared_mask: u16,
    /// Per-street bet amounts during v2 betting (also legacy hand commits in v1).
    /// Reset each street; seeded with blinds on PreFlop. Raise sets `current_bet`
    /// from this tracker so callers can match (not `current_bet + bet_delta`).
    pub hand_commits: [u64; 10],
    /// Legacy plaintext per-player totals — use `EncryptedGameBetting` in production.
    pub player_total_bets: [u64; 10],
    /// Legacy plaintext pots — use `EncryptedGameBetting.pots_ct` in production.
    pub pots: [u64; 9],
    /// Eligible player mask per pot (folded players excluded)
    pub pot_eligible_masks: [u16; 9],
    /// Uncalled terminal contributions returned to their sole contributor.
    pub refunds: [u64; 10],
    /// Number of valid pots in `pots` / `pot_eligible_masks`
    pub pot_count: u8,
    /// Polynomial hash commitment from showdown proof
    pub showdown_hash: [u8; 32],
    /// Payout amounts per player after pot distribution
    pub payouts: [u64; 10],
    /// Running Poseidon(4) sum (LE u128 low || u128 high), wrapping modulo 2^256.
    pub verify_hash_acc: [u8; 32],
    /// Expected Poseidon(4) sum latched by `begin_verify_deck_hash`.
    pub verify_expected: [u8; 32],
    /// Number of distinct chunk callbacks applied (0..900)
    pub verify_progress: u16,
    /// Bitset of completed commitment indices (900 bits in 15×u64)
    pub verify_bits: [u64; 15],
    /// True after begin_verify_deck_hash until all 900 chunks land
    pub verify_started: bool,
    /// Bitmap of players who have acted on the current betting street.
    /// Raises clear peers so action re-opens; street closes when all can-act bits are set and totals match.
    pub acted_mask: u16,
    /// Player index whose Groth16 showdown proof produced `showdown_hash`.
    /// Settlement (`compute_pots` / `distribute_and_settle`) MUST consume the
    /// `SealedShowdownCoefficients` PDA seeded by this index — the sealed coeffs
    /// used to build `showdown_hash` belong to this player only.
    pub showdown_hash_player: u8,
    /// One queued bet may mutate the shared betting state at a time.
    pub bet_pending: bool,
    /// Binds the MPC bet callback to the request that opened `bet_pending`.
    pub bet_pending_operation: PendingOperation,
    /// Binds the settlement callback; retries are permitted after slot expiry.
    pub settlement_pending_operation: PendingOperation,
    /// V2 settlement state machine; see SETTLEMENT_* constants.
    pub settlement_status: u8,
    /// Monotonic generation invalidates callbacks from a timed-out settlement.
    pub settlement_generation: u64,
    /// Arcium computation offset currently authorized to complete settlement.
    pub settlement_computation: u64,
    /// Slot at which the current all-seat settlement was queued.
    pub settlement_started_slot: u64,
    /// First slot at which the authority may refund a stalled settlement.
    pub settlement_expiry_slot: u64,
    /// Poker: the board was dealt (flop, turn, river, or an all-in runout).
    /// A preflop fold leaves this false and the pot is not raked.
    pub reached_flop: bool,
    /// Room rake snapshotted at `start_hand`. `0` takes nothing. Basis points.
    pub rake_bps: u16,
    /// Lamports removed from the contested pots for the house.
    pub rake_amount: u64,
    /// Bits of players whose public key and padding are stored.
    /// The key bytes live in `RegistrationMaterial`, not on this account.
    pub registered_mask: u16,
    /// See `NEXT_HAND_*`. Opens when poker betting enters showdown.
    pub next_hand_phase: u8,
    /// Players who joined the hand that opened this pipeline.
    pub next_num_players: u8,
    /// Next sequential shuffler. Share is parallel.
    pub next_shuffler: u8,
    /// `hand_seat_order` captured so a seat can still act after `end_hand`.
    pub next_seat_saved: bool,
    pub next_registered_mask: u16,
    pub next_shuffled_mask: u16,
    pub next_shared_mask: u16,
    pub next_seat_order: [u8; 10],
    /// Unix timestamp by which `current_player` must check, fold, or raise.
    /// `0` when no betting decision is open. The registration tail follows this field.
    pub act_deadline_unix: i64,
}

/// Callback-owned encrypted output of `settle_all_seats`.
///
/// Arcium's current output plumbing cannot fan a single computation directly
/// into ten independently owned encrypted accounts.  The callback first writes
/// this ledger, then applies the ten slots while all active
/// `PlayerGameEscrow` accounts are present in the same transaction.  No
/// plaintext payout array is stored on `GameState`.
#[account]
#[derive(InitSpace)]
pub struct EncryptedSettlementLedger {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub ciphertexts: [[u8; 32]; 10],
    pub nonce: u128,
    pub hash_matches: bool,
}

#[event]
pub struct WhitelistAdded {
    pub room_id: [u8; 32],
    pub player: Pubkey,
}

#[event]
pub struct VerifyDeckHashChunkEvent {
    pub start_index: u16,
    pub verified: bool,
    pub progress: u16,
}

#[event]
pub struct RevealCardEvent {
    pub card_index: u16,
    pub recipient_index: u8,
    pub count: u8,
}

#[event]
pub struct BetEvent {
    pub player_index: u8,
    pub action: u8,
    pub amount: u64,
    pub is_fold: bool,
    pub is_all_in: bool,
    pub show_on_fold: bool,
}

/// Emitted whenever a specific player must take an on-chain action.
/// Clients subscribe via program logs / `onLogs` and filter by `player_index`.
#[event]
pub struct PlayerActionRequired {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub action_kind: u8,
    pub phase: u8,
    pub betting_phase: u8,
    /// Unix time the current betting decision must be in by. `0` outside a street.
    pub act_deadline_unix: i64,
}

#[event]
pub struct HandStartedEvent {
    pub game_id: [u8; 32],
    pub num_players: u8,
}

#[event]
pub struct PhaseAdvancedEvent {
    pub game_id: [u8; 32],
    pub phase: u8,
    pub betting_phase: u8,
    pub current_player: u8,
}

/// Emitted when a betting street closes after a bet callback and the next street (or Showdown) opens.
#[event]
pub struct StreetAdvancedEvent {
    pub game_id: [u8; 32],
    pub from_betting_phase: u8,
    pub betting_phase: u8,
    pub phase: u8,
    pub current_player: u8,
}

#[event]
pub struct EscrowFundedEvent {
    pub player: Pubkey,
    pub personal_delta: u64,
    pub seat_delta: u64,
    /// 0=faucet, 1=personal→seat, 2=seat→personal
    pub kind: u8,
}

#[event]
pub struct PotDistributionEvent {
    pub game_id: [u8; 32],
    pub total_payout: u64,
}

#[cfg(test)]
mod seal_progress_layout {
    use super::SealedShowdownCoefficients;
    use anchor_lang::{AnchorSerialize, Space};

    /// Client reads these after the 8-byte account discriminator.
    /// coeffs_needed = 803, coeffs_done = 804, folds_done = 805.
    #[test]
    fn seal_progress_offsets() {
        let mut sealed = SealedShowdownCoefficients::default();
        sealed.coeffs_needed = 5;
        sealed.coeffs_done = 3;
        sealed.folds_done = 2;
        sealed.consumed = true;
        sealed.slot_done = 0x0003;
        let mut bytes = Vec::new();
        sealed.serialize(&mut bytes).unwrap();
        assert_eq!(bytes[795], 5, "coeffs_needed");
        assert_eq!(bytes[796], 3, "coeffs_done");
        assert_eq!(bytes[797], 2, "folds_done");
        let consumed_at = bytes.iter().rposition(|byte| *byte == 1).expect("consumed");
        assert_eq!(consumed_at, 1118, "consumed");
        assert_eq!(bytes[1119], 3, "slot_done");
        assert_eq!(bytes[1120], 0, "slot_done high");
        assert_eq!(bytes.len(), SealedShowdownCoefficients::INIT_SPACE);
    }
}
