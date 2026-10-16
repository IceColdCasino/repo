//! Admin-funded per-player SOL float.
//!
//! Seeds are `rent_vault || room_id || player`. Staging instructions reimburse
//! the seat from this account in the same transaction that spends the rent.
//! Closes pay the rent back here. Casino `leave_table` / `sit_out` settle it
//! to the player, signed by the casino rent-authority PDA.

use crate::prelude::*;
use crate::ErrorCode;
use shared_zk_ids::{
    CASINO_PROGRAM_ID, CASINO_RENT_AUTHORITY_SEED, PROOF_PHASE_SHARE, PROOF_RECEIPT_V2_SEED,
    RECEIPT_STATUS_CONSUMED, RENT_VAULT_DISCRIMINATOR, RENT_VAULT_LEN, RENT_VAULT_SEED,
    WHITELIST_ADMIN,
};

pub fn casino_program() -> Pubkey {
    Pubkey::from_str(CASINO_PROGRAM_ID).expect("casino program id")
}

pub fn whitelist_admin() -> Pubkey {
    Pubkey::from_str(WHITELIST_ADMIN).expect("whitelist admin")
}

pub fn casino_rent_authority() -> Pubkey {
    Pubkey::find_program_address(&[CASINO_RENT_AUTHORITY_SEED], &casino_program()).0
}

pub fn is_rent_vault(account: &AccountInfo) -> bool {
    if account.owner() != crate::ID || account.data_len() < RENT_VAULT_LEN {
        return false;
    }
    account
        .try_borrow_data()
        .map(|data| data[..8] == RENT_VAULT_DISCRIMINATOR)
        .unwrap_or(false)
}

/// If the first remaining account is a rent vault, peel it off.
pub fn split_leading_vault<'a, 'info>(
    remaining: &'a [AccountInfo<'info>],
) -> (Option<AccountInfo<'info>>, &'a [AccountInfo<'info>]) {
    match remaining.first() {
        Some(first) if is_rent_vault(first) => (Some(*first), &remaining[1..]),
        _ => (None, remaining),
    }
}

fn vault_player(account: &AccountInfo) -> Result<Pubkey> {
    let data = account.try_borrow_data()?;
    require!(
        data.len() >= RENT_VAULT_LEN && data[..8] == RENT_VAULT_DISCRIMINATOR,
        ErrorCode::InvalidPublicInputs
    );
    let mut player = [0u8; 32];
    player.copy_from_slice(&data[40..72]);
    Ok(Pubkey(player))
}

fn vault_room(account: &AccountInfo) -> Result<[u8; 32]> {
    let data = account.try_borrow_data()?;
    let mut room = [0u8; 32];
    room.copy_from_slice(&data[8..40]);
    Ok(room)
}

pub fn require_vault_for_player(vault: &AccountInfo, player: &Pubkey) -> Result<()> {
    require!(vault.owner() == crate::ID, ErrorCode::InvalidPublicInputs);
    require!(vault_player(vault)? == *player, ErrorCode::InvalidAuthority);
    let room = vault_room(vault)?;
    let (expected, _) = Pubkey::find_program_address(
        &[RENT_VAULT_SEED, &room, player.as_ref()],
        &crate::ID,
    );
    require!(vault.key() == expected, ErrorCode::InvalidPublicInputs);
    Ok(())
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    {
        let mut src = from.try_borrow_mut_lamports()?;
        *src = src.checked_sub(amount).ok_or(ErrorCode::InvalidPublicInputs)?;
    }
    {
        let mut dst = to.try_borrow_mut_lamports()?;
        *dst = dst.checked_add(amount).ok_or(ErrorCode::InvalidPublicInputs)?;
    }
    Ok(())
}

/// Reimburse `signer` from a leading rent vault. No vault means the seat keeps the rent.
pub fn reimburse_leading(remaining: &[AccountInfo], signer: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let (Some(vault), _) = split_leading_vault(remaining) else {
        return Ok(());
    };
    reimburse_signer(&vault, signer, amount)
}

/// Close `account` into a leading rent vault. No vault leaves the account open.
pub fn close_to_leading(remaining: &[AccountInfo], signer: &AccountInfo, account: &AccountInfo) -> Result<()> {
    let (Some(vault), _) = split_leading_vault(remaining) else {
        return Ok(());
    };
    require_vault_for_player(&vault, &signer.key())?;
    refund_staging(account, &vault)
}

/// Return `amount` to the seat. The vault must stay rent-exempt.
pub fn reimburse_signer(vault: &AccountInfo, signer: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_vault_for_player(vault, &signer.key())?;
    let min = minimum_balance(vault.data_len())?;
    require!(
        vault.lamports().saturating_sub(amount) >= min,
        ErrorCode::InvalidPublicInputs
    );
    move_lamports(vault, signer, amount)
}

pub fn refund_staging(staging: &AccountInfo, dest: &AccountInfo) -> Result<()> {
    let rent = staging.lamports();
    move_lamports(staging, dest, rent)?;
    staging.assign(&SYSTEM_PROGRAM_ID);
    staging.realloc(0, false)?;
    Ok(())
}

fn read_exact<const N: usize>(data: &mut &[u8]) -> Result<[u8; N]> {
    require!(data.len() >= N, ErrorCode::InvalidPublicInputs);
    let (head, tail) = data.split_at(N);
    let mut out = [0u8; N];
    out.copy_from_slice(head);
    *data = tail;
    Ok(out)
}

pub fn init_rent_vault(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let room_id = read_exact::<32>(&mut data)?;
    let player = Pubkey(read_exact::<32>(&mut data)?);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let payer = ix.signer(true)?;
    require!(payer.key() == whitelist_admin(), ErrorCode::InvalidAuthority);
    let vault = ix.init_unchecked(
        &payer.to_account_info(),
        RENT_VAULT_LEN,
        &[RENT_VAULT_SEED, &room_id, player.as_ref()],
        false,
    )?;
    let _ = ix.system()?;
    let (_, bump) =
        Pubkey::find_program_address(&[RENT_VAULT_SEED, &room_id, player.as_ref()], &crate::ID);
    write_vault(&vault.to_account_info(), &room_id, &player, bump)
}

pub fn deposit_rent_vault(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let amount = u64::from_le_bytes(read_exact::<8>(&mut data)?);
    require!(amount > 0, ErrorCode::InvalidPublicInputs);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let payer = ix.signer(true)?;
    let vault = ix.unchecked(true)?;
    let _ = ix.system()?;
    let player = vault_player(&vault.to_account_info())?;
    require_vault_for_player(&vault.to_account_info(), &player)?;
    system_transfer(&payer.to_account_info(), &vault.to_account_info(), amount)
}

pub fn settle_rent_vault(accounts: &[AccountInfo]) -> Result<()> {
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let vault = ix.unchecked(true)?;
    let player = ix.unchecked(true)?;
    let allowed = authority.key() == whitelist_admin() || authority.key() == casino_rent_authority();
    require!(allowed, ErrorCode::InvalidAuthority);
    require_vault_for_player(&vault.to_account_info(), &player.key())?;
    let lamports = vault.lamports();
    move_lamports(&vault.to_account_info(), &player.to_account_info(), lamports)?;
    let vault_info = vault.to_account_info();
    vault_info.assign(&SYSTEM_PROGRAM_ID);
    vault_info.realloc(0, false)?;
    Ok(())
}

/// Return lamports above `keep` to `destination`. The vault stays open.
///
/// `keep` is the shoe float plus the vault's own rent. The account never
/// drops below its rent-exempt minimum, so a later shuffle can reuse it.
pub fn recapture_rent_vault(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let keep = u64::from_le_bytes(read_exact::<8>(&mut data)?);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    require!(authority.key() == whitelist_admin(), ErrorCode::InvalidAuthority);
    let destination = ix.unchecked(true)?;
    let vault = ix.unchecked(true)?;
    let player = ix.unchecked(false)?;
    require!(destination.key() != vault.key(), ErrorCode::InvalidPublicInputs);
    require_vault_for_player(&vault.to_account_info(), &player.key())?;
    let min = minimum_balance(vault.data_len())?;
    let leave = keep.max(min);
    let have = vault.lamports();
    if have <= leave {
        return Ok(());
    }
    move_lamports(&vault.to_account_info(), &destination.to_account_info(), have - leave)
}

/// Move `amount` from the player's vault to `destination` before an account
/// is opened. The player signs. Pass two accounts when the destination is the
/// player (the seat pays its own pending deposit). The vault keeps its
/// rent-exempt minimum. Callers must leave the hand float in the vault.
pub fn draw_rent_vault(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let amount = u64::from_le_bytes(read_exact::<8>(&mut data)?);
    require!(amount > 0, ErrorCode::InvalidPublicInputs);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let player = ix.signer(true)?;
    let second = ix.unchecked(true)?;
    let (destination, vault) = match ix.unchecked(true) {
        Ok(vault) => (second, vault),
        Err(_) => (UncheckedAccount(player.to_account_info()), second),
    };
    require!(
        destination.to_account_info().key() != vault.to_account_info().key(),
        ErrorCode::InvalidPublicInputs
    );
    require_vault_for_player(&vault.to_account_info(), &player.key())?;
    let min = minimum_balance(vault.data_len())?;
    require!(
        vault.lamports().saturating_sub(amount) >= min,
        ErrorCode::InvalidPublicInputs
    );
    move_lamports(&vault.to_account_info(), &destination.to_account_info(), amount)
}

pub fn reimburse_rent_vault(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let amount = u64::from_le_bytes(read_exact::<8>(&mut data)?);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let authority = ix.signer(false)?;
    let vault = ix.unchecked(true)?;
    let player = ix.unchecked(true)?;
    require!(
        authority.key() == casino_rent_authority(),
        ErrorCode::InvalidAuthority
    );
    reimburse_signer(&vault.to_account_info(), &player.to_account_info(), amount)
}

/// Close this seat's light player account into their vault once the hand is complete.
pub fn close_player_state(accounts: &[AccountInfo]) -> Result<()> {
    let mut ix = IxCursor::new(accounts, crate::ID);
    let signer = ix.signer(true)?;
    let game_state = ix.load::<crate::GameState>(false)?;
    let mut player_state = ix.load::<crate::PlayerState>(true)?;
    ix.check_seeds(
        &game_state.to_account_info(),
        &[b"game_state", &game_state.game_id[..]],
        false,
    )?;
    ix.check_seeds(
        &player_state.to_account_info(),
        &[b"player", &player_state.game_id[..], &[player_state.player_index]],
        false,
    )?;
    require!(
        player_state.game_id == game_state.game_id,
        ErrorCode::InvalidPublicInputs
    );
    require!(
        player_state.authority == signer.key(),
        ErrorCode::InvalidAuthority
    );
    let vault = ix.unchecked(true)?;
    let casino_game = ix.unchecked(false)?;
    let extras = ix.rest();
    require!(
        game_state.phase == crate::GamePhase::Complete as u8
            || casino_hand_settled(&casino_game.to_account_info(), &game_state.game_id),
        ErrorCode::InvalidGamePhase
    );
    require_vault_for_player(&vault.to_account_info(), &signer.key())?;
    let player_index = player_state.player_index;
    let game_id = game_state.game_id;
    player_state.exit(&crate::ID)?;
    refund_staging(&player_state.to_account_info(), &vault.to_account_info())?;
    if let Some(extra) = extras.first() {
        let (share_inputs, _) = Pubkey::find_program_address(
            &[b"share_inputs", &game_id, &[player_index]],
            &crate::ID,
        );
        if extra.key() == share_inputs && extra.owner() == crate::ID && extra.data_len() > 0 {
            refund_staging(extra, &vault.to_account_info())?;
        }
    }
    Ok(())
}

/// Return a consumed share receipt to the seat's vault.
///
/// Casino `finalize_share_phase` reads the receipt after Groth16 consume, so
/// this runs only once that instruction has finished. The receipt generation
/// is the share-verify accumulator's generation.
pub fn close_share_receipt(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let player_index = read_exact::<1>(&mut data)?[0];
    let generation = u64::from_le_bytes(read_exact::<8>(&mut data)?);
    let mut ix = IxCursor::new(accounts, crate::ID);
    let signer = ix.signer(true)?;
    let player_state = ix.load::<crate::PlayerState>(false)?;
    let mut receipt = ix.load::<crate::ProofReceipt>(true)?;
    let vault = ix.unchecked(true)?;
    require!(
        player_state.player_index == player_index && player_state.authority == signer.key(),
        ErrorCode::InvalidAuthority
    );
    ix.check_seeds(
        &player_state.to_account_info(),
        &[b"player", &player_state.game_id[..], &[player_index]],
        false,
    )?;
    let generation_le = generation.to_le_bytes();
    ix.check_seeds(
        &receipt.to_account_info(),
        &[
            PROOF_RECEIPT_V2_SEED,
            &player_state.game_id[..],
            &generation_le,
            &[PROOF_PHASE_SHARE],
            &[player_index],
        ],
        false,
    )?;
    require!(
        receipt.game_id == player_state.game_id
            && receipt.generation == generation
            && receipt.phase == PROOF_PHASE_SHARE
            && receipt.player_index == player_index
            && receipt.status == RECEIPT_STATUS_CONSUMED,
        ErrorCode::InvalidPublicInputs
    );
    require_vault_for_player(&vault.to_account_info(), &signer.key())?;
    receipt.exit(&crate::ID)?;
    refund_staging(&receipt.to_account_info(), &vault.to_account_info())
}

/// Casino `GameState.settlement_status` for `SETTLEMENT_SETTLED`.
const CASINO_SETTLEMENT_SETTLED: u8 = 3;
/// Byte offset of that field: 8-byte discriminator plus the borsh prefix.
const CASINO_SETTLEMENT_STATUS_OFFSET: usize = 987;
const CASINO_GAME_ID_OFFSET: usize = 31;

fn casino_hand_settled(account: &AccountInfo, game_id: &[u8; 32]) -> bool {
    if account.owner() != casino_program() || account.data_len() <= CASINO_SETTLEMENT_STATUS_OFFSET {
        return false;
    }
    let (expected, _) = Pubkey::find_program_address(&[b"game_state", game_id], &casino_program());
    if account.key() != expected {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    data.len() > CASINO_SETTLEMENT_STATUS_OFFSET
        && data[CASINO_GAME_ID_OFFSET..CASINO_GAME_ID_OFFSET + 32] == *game_id
        && data[CASINO_SETTLEMENT_STATUS_OFFSET] == CASINO_SETTLEMENT_SETTLED
}

/// Close this hand's light accounts onto the operator. Testing builds only.
/// `data[0] == 1` also closes the game state. Rent vaults stay for the casino path.
#[cfg(feature = "testing")]
pub fn close_light_session(accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
    let close_game = data.first().copied().unwrap_or(1) == 1;
    let mut ix = IxCursor::new(accounts, crate::ID);
    let operator = ix.signer(true)?;
    let mut game = ix.load::<crate::GameState>(close_game)?;
    ix.check_seeds(
        &game.to_account_info(),
        &[b"game_state", &game.game_id[..]],
        false,
    )?;
    require!(game.operator == operator.key(), ErrorCode::InvalidAuthority);
    let extras = ix.rest();
    if close_game {
        game.exit(&crate::ID)?;
    }
    for account in extras {
        if account.key() == operator.key() || account.key() == game.key() {
            continue;
        }
        if account.owner() != crate::ID || account.data_len() == 0 || is_rent_vault(&account) {
            continue;
        }
        refund_staging(&account, &operator.to_account_info())?;
    }
    if close_game {
        refund_staging(&game.to_account_info(), &operator.to_account_info())?;
    }
    Ok(())
}

pub fn write_vault(account: &AccountInfo, room_id: &[u8; 32], player: &Pubkey, bump: u8) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    require!(data.len() >= RENT_VAULT_LEN, ErrorCode::InvalidPublicInputs);
    data[..8].copy_from_slice(&RENT_VAULT_DISCRIMINATOR);
    data[8..40].copy_from_slice(room_id);
    data[40..72].copy_from_slice(player.as_ref());
    data[72] = bump;
    Ok(())
}
