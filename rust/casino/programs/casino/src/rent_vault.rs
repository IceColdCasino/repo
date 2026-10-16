//! Pull staging rent from a light-casino rent vault, and settle that vault
//! back to the player. The casino rent-authority PDA is the only signer
//! light-casino accepts for those debits.

use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use shared_zk_ids::{
    CASINO_RENT_AUTHORITY_SEED, LIGHT_CASINO_PROGRAM_ID, REIMBURSE_RENT_VAULT_DISCRIMINATOR,
    RENT_VAULT_SEED, SETTLE_RENT_VAULT_DISCRIMINATOR,
};

pub fn vault_address(room_id: &[u8; 32], player: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[RENT_VAULT_SEED, room_id, player.as_ref()], &light_program_id()).0
}

fn light_program_id() -> Pubkey {
    Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).expect("light-casino program id")
}

fn rent_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CASINO_RENT_AUTHORITY_SEED], &crate::ID)
}

/// `None` when the client omitted the vault or passed the light-casino program id.
fn vault_accounts<'a, 'info>(
    remaining: &'a [AccountInfo<'info>],
) -> Result<Option<(&'a AccountInfo<'info>, &'a AccountInfo<'info>, &'a AccountInfo<'info>)>> {
    if remaining.len() < 3 {
        return Ok(None);
    }
    let vault = &remaining[0];
    let authority = &remaining[1];
    let light_program = &remaining[2];
    if vault.key() == light_program.key() {
        return Ok(None);
    }
    let light_id = light_program_id();
    require_keys_eq!(*light_program.key, light_id, crate::ErrorCode::InvalidAuthority);
    let (expected, _) = rent_authority();
    require_keys_eq!(*authority.key, expected, crate::ErrorCode::InvalidAuthority);
    Ok(Some((vault, authority, light_program)))
}

fn invoke_vault<'info>(
    discriminator: &[u8; 8],
    amount: Option<u64>,
    vault: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    player: &AccountInfo<'info>,
    light_program: &AccountInfo<'info>,
) -> Result<()> {
    let (_, bump) = rent_authority();
    let bump_seed = [bump];
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(discriminator);
    if let Some(amount) = amount {
        data.extend_from_slice(&amount.to_le_bytes());
    }
    let ix = Instruction {
        program_id: light_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new(vault.key(), false),
            AccountMeta::new(player.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[authority.clone(), vault.clone(), player.clone()],
        &[&[CASINO_RENT_AUTHORITY_SEED, &bump_seed]],
    )
    .map_err(|_| error!(crate::ErrorCode::InvalidAmount))?;
    let _ = light_program;
    Ok(())
}

/// Credit `player` from their vault for rent this instruction just charged them.
pub fn reimburse<'info>(
    remaining: &[AccountInfo<'info>],
    player: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let Some((vault, authority, light_program)) = vault_accounts(remaining)? else {
        return Ok(());
    };
    invoke_vault(
        &REIMBURSE_RENT_VAULT_DISCRIMINATOR,
        Some(amount),
        vault,
        authority,
        player,
        light_program,
    )
}

/// Send the vault balance to `player` and close the vault.
pub fn settle<'info>(remaining: &[AccountInfo<'info>], player: &AccountInfo<'info>) -> Result<()> {
    let Some((vault, authority, light_program)) = vault_accounts(remaining)? else {
        return Ok(());
    };
    invoke_vault(
        &SETTLE_RENT_VAULT_DISCRIMINATOR,
        None,
        vault,
        authority,
        player,
        light_program,
    )
}

/// Close a casino-owned PDA into `vault` when `owner_at` names `player`.
pub fn close_owned_pda<'info>(
    account: &AccountInfo<'info>,
    expected: Pubkey,
    vault: &AccountInfo<'info>,
    owner_at: Option<usize>,
    player: &Pubkey,
) -> Result<()> {
    if account.data_is_empty() {
        return Ok(());
    }
    require_keys_eq!(account.key(), expected, crate::ErrorCode::InvalidAuthority);
    require_keys_eq!(*account.owner, crate::ID, crate::ErrorCode::InvalidAuthority);
    if let Some(offset) = owner_at {
        let data = account.try_borrow_data()?;
        require!(
            data.len() >= offset + 32 && &data[offset..offset + 32] == player.as_ref(),
            crate::ErrorCode::InvalidAuthority
        );
    }
    close_into(account, vault)
}

/// Move every lamport off a casino-owned account and into `dest`, then close it.
pub fn close_into<'info>(account: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    let rent = account.lamports();
    if rent == 0 {
        return Ok(());
    }
    **dest.lamports.borrow_mut() = dest
        .lamports()
        .checked_add(rent)
        .ok_or(error!(crate::ErrorCode::InvalidAmount))?;
    **account.lamports.borrow_mut() = 0;
    account.assign(&anchor_lang::system_program::ID);
    account.resize(0)?;
    Ok(())
}

/// Share-staging close credits the player's vault when one was passed.
pub fn share_refund_account<'info>(
    remaining: &[AccountInfo<'info>],
    room_id: &[u8; 32],
    player: &Pubkey,
    seat: AccountInfo<'info>,
) -> Result<AccountInfo<'info>> {
    if remaining.is_empty() || remaining[0].key() == light_program_id() {
        return Ok(seat);
    }
    let vault = &remaining[0];
    let (expected, _) = Pubkey::find_program_address(
        &[RENT_VAULT_SEED, room_id, player.as_ref()],
        &light_program_id(),
    );
    require_keys_eq!(*vault.key, expected, crate::ErrorCode::InvalidAuthority);
    Ok(vault.clone())
}
