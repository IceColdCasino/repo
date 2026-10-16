use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::room::Room;

pub fn transfer_to_vault<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
    )
}

pub fn transfer_from_vault<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    room: &Account<'info, Room>,
    amount: u64,
    room_id: &[u8; 32],
    bump: u8,
) -> Result<()> {
    // SPL outflows only from MPC-authorized `debit_for_withdraw_callback` via room PDA signer.
    let seeds: &[&[u8]] = &[b"room", room_id.as_ref(), &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: room.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Burn the room vault's chips and close it onto `dest`. The room PDA signs.
pub fn burn_and_close_vault<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    vault: &Account<'info, TokenAccount>,
    room: &Account<'info, Room>,
    dest: &AccountInfo<'info>,
    room_id: &[u8; 32],
    bump: u8,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"room", room_id.as_ref(), &[bump]];
    let amount = vault.amount;
    if amount > 0 {
        token::burn(
            CpiContext::new_with_signer(
                token_program.key(),
                Burn {
                    mint: mint.to_account_info(),
                    from: vault.to_account_info(),
                    authority: room.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: dest.clone(),
            authority: room.to_account_info(),
        },
        &[seeds],
    ))
}
