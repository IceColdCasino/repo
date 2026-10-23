//! Optional poker CPI after light-casino verify + receipt write.

use crate::prelude::*;

use crate::casino_cpi::{
    consume_proof_receipt_cpi, consume_register_receipt_cpi, payload_from_fields,
};
use crate::ProofReceipt;

pub const BRIDGE_MODE_STANDALONE: u8 = 0;
pub const BRIDGE_MODE_CASINO_REQUIRED: u8 = 1;

/// When all poker bridge accounts are present, CPI consume and mark receipt consumed.
/// In `BRIDGE_MODE_CASINO_REQUIRED`, omitting the bridge fails closed.
pub fn maybe_consume_proof<'info>(
    bridge_mode: u8,
    poker_program: &Option<UncheckedAccount<'info>>,
    cpi_authority: &Option<UncheckedAccount<'info>>,
    cpi_authority_bump: Option<u8>,
    poker_game_state: &Option<UncheckedAccount<'info>>,
    proof_receipt: &mut Account<'info, ProofReceipt>,
    share_verify_acc: Option<&UncheckedAccount<'info>>,
) -> Result<()> {
    match (poker_program, cpi_authority, poker_game_state, cpi_authority_bump) {
        (Some(pp), Some(auth), Some(gs), Some(bump)) => {
            let payload = payload_from_fields(
                proof_receipt.game_id,
                proof_receipt.generation,
                proof_receipt.phase,
                proof_receipt.player_index,
                proof_receipt.circuit_version,
                proof_receipt.output_hash,
                proof_receipt.status,
            );
            proof_receipt.exit(&crate::ID)?;
            let receipt_info = proof_receipt.to_account_info();
            consume_proof_receipt_cpi(
                &pp.to_account_info(),
                &auth.to_account_info(),
                bump,
                &gs.to_account_info(),
                &receipt_info,
                share_verify_acc.map(|acc| acc.to_account_info()),
                &payload,
            )?;
            proof_receipt.status = shared_zk_ids::RECEIPT_STATUS_CONSUMED;
            Ok(())
        }
        (None, None, None, _) => {
            require!(
                bridge_mode != BRIDGE_MODE_CASINO_REQUIRED,
                crate::ErrorCode::CasinoBridgeRequired
            );
            Ok(())
        }
        _ => err!(crate::ErrorCode::InvalidPokerBridgeAccounts),
    }
}

/// Register path: also needs poker player_state PDA (uninit).
/// `cpi_authority` must be pre-funded (pays poker PlayerState rent).
pub fn maybe_consume_register<'info>(
    bridge_mode: u8,
    poker_program: &Option<UncheckedAccount<'info>>,
    cpi_authority: &Option<UncheckedAccount<'info>>,
    cpi_authority_bump: Option<u8>,
    poker_game_state: &Option<UncheckedAccount<'info>>,
    poker_player_state: &Option<UncheckedAccount<'info>>,
    proof_receipt: &mut Account<'info, ProofReceipt>,
    system_program: &AccountInfo<'info>,
    public_key: &[[u8; 32]; 2],
    padding: &[[u8; 32]; 4],
) -> Result<()> {
    match (
        poker_program,
        cpi_authority,
        poker_game_state,
        poker_player_state,
        cpi_authority_bump,
    ) {
        (Some(pp), Some(auth), Some(gs), Some(ps), Some(bump)) => {
            let payload = payload_from_fields(
                proof_receipt.game_id,
                proof_receipt.generation,
                proof_receipt.phase,
                proof_receipt.player_index,
                proof_receipt.circuit_version,
                proof_receipt.output_hash,
                proof_receipt.status,
            );
            proof_receipt.exit(&crate::ID)?;
            let receipt_info = proof_receipt.to_account_info();
            consume_register_receipt_cpi(
                &pp.to_account_info(),
                &auth.to_account_info(),
                bump,
                &gs.to_account_info(),
                &ps.to_account_info(),
                &receipt_info,
                system_program,
                &payload,
                public_key,
                padding,
            )?;
            proof_receipt.status = shared_zk_ids::RECEIPT_STATUS_CONSUMED;
            Ok(())
        }
        (None, None, None, None, _) => {
            require!(
                bridge_mode != BRIDGE_MODE_CASINO_REQUIRED,
                crate::ErrorCode::CasinoBridgeRequired
            );
            Ok(())
        }
        _ => err!(crate::ErrorCode::InvalidPokerBridgeAccounts),
    }
}
