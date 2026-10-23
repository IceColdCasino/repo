//! CPI into the casino program to consume proof receipts after light-casino verify.

use crate::prelude::*;
use shared_zk_ids::{CPI_AUTHORITY_SEED, CASINO_PROGRAM_ID, ProofReceiptPayload};

pub fn casino_program_id() -> Pubkey {
    Pubkey::from_str(CASINO_PROGRAM_ID).expect("valid casino program id")
}

fn invoke_casino<'a>(
    program: &AccountInfo<'a>,
    data: &[u8],
    metas: &[pinocchio::instruction::AccountMeta],
    infos: &[&pinocchio::account_info::AccountInfo],
    bump: u8,
) -> Result<()> {
    require_keys_eq!(program.key(), casino_program_id(), crate::ErrorCode::InvalidPokerProgram);
    let instruction = pinocchio::instruction::Instruction {
        program_id: program.key_ptr(),
        accounts: metas,
        data,
    };
    let bump_bytes = [bump];
    let seeds = [
        pinocchio::instruction::Seed::from(CPI_AUTHORITY_SEED),
        pinocchio::instruction::Seed::from(&bump_bytes),
    ];
    let signer = pinocchio::instruction::Signer::from(&seeds);
    pinocchio::cpi::slice_invoke_signed(&instruction, infos, &[signer]).map_err(Error::from)
}

/// Invoke `casino::consume_proof_receipt` signed by light-casino `cpi_authority` PDA.
pub fn consume_proof_receipt_cpi<'info>(
    poker_program: &AccountInfo<'info>,
    cpi_authority: &AccountInfo<'info>,
    cpi_authority_bump: u8,
    poker_game_state: &AccountInfo<'info>,
    proof_receipt: &AccountInfo<'info>,
    share_verify_acc: Option<AccountInfo<'info>>,
    receipt: &ProofReceiptPayload,
) -> Result<()> {
    let ix_data = receipt.consume_proof_ix_data();
    let share = share_verify_acc.unwrap_or(*poker_program);
    let metas = [
        pinocchio::instruction::AccountMeta::readonly_signer(cpi_authority.key_ptr()),
        pinocchio::instruction::AccountMeta::writable(poker_game_state.key_ptr()),
        pinocchio::instruction::AccountMeta::readonly(proof_receipt.key_ptr()),
        pinocchio::instruction::AccountMeta::readonly(share.key_ptr()),
    ];
    invoke_casino(
        poker_program,
        &ix_data,
        &metas,
        &[
            cpi_authority.raw,
            poker_game_state.raw,
            proof_receipt.raw,
            share.raw,
        ],
        cpi_authority_bump,
    )
}

/// Invoke `poker::consume_register_receipt`.
///
/// Account layout matches genesis poker: `authority` is mut and pays for `PlayerState`.
/// Callers must fund `cpi_authority` before the first register CPI.
pub fn consume_register_receipt_cpi<'info>(
    poker_program: &AccountInfo<'info>,
    cpi_authority: &AccountInfo<'info>,
    cpi_authority_bump: u8,
    poker_game_state: &AccountInfo<'info>,
    poker_player_state: &AccountInfo<'info>,
    proof_receipt: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    receipt: &ProofReceiptPayload,
    public_key: &[[u8; 32]; 2],
    padding: &[[u8; 32]; 4],
) -> Result<()> {
    let ix_data = receipt.consume_register_ix_data(public_key, padding);
    let metas = [
        pinocchio::instruction::AccountMeta::writable_signer(cpi_authority.key_ptr()),
        pinocchio::instruction::AccountMeta::writable(poker_game_state.key_ptr()),
        pinocchio::instruction::AccountMeta::writable(poker_player_state.key_ptr()),
        pinocchio::instruction::AccountMeta::readonly(proof_receipt.key_ptr()),
        pinocchio::instruction::AccountMeta::readonly(system_program.key_ptr()),
    ];
    invoke_casino(
        poker_program,
        &ix_data,
        &metas,
        &[
            cpi_authority.raw,
            poker_game_state.raw,
            poker_player_state.raw,
            proof_receipt.raw,
            system_program.raw,
        ],
        cpi_authority_bump,
    )
}

/// Build a `ProofReceiptPayload` from on-chain receipt fields.
pub fn payload_from_fields(
    game_id: [u8; 32],
    generation: u64,
    phase: u8,
    player_index: u8,
    circuit_version: u16,
    output_hash: [u8; 32],
    status: u8,
) -> ProofReceiptPayload {
    ProofReceiptPayload {
        game_id,
        generation,
        phase,
        player_index,
        circuit_version,
        output_hash,
        status,
    }
}
