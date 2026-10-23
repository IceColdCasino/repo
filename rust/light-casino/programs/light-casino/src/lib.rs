pub mod prelude;
mod dispatch;
mod pinocchio_idl;
mod rent_vault;
mod shuffle_chunks;

use pinocchio_idl_macros::{p_error, p_state};
use prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk_pinocchio::{
    address::v1::derive_address,
    cpi::{
        v1::{CpiAccounts, LightSystemProgramCpi},
        InvokeLightSystemProgram, LightCpiInstruction,
    },
    derive_light_cpi_signer,
    instruction::{PackedAddressTreeInfo, PackedAddressTreeInfoExt, ValidityProof},
    CpiSigner, LightAccount, LightDiscriminator, LightHasher,
};

pub mod deck_state;
pub mod game_config;
pub mod games;
pub mod groth16_verify;
pub mod light_artifacts;
pub mod poseidon_hash;
pub mod casino_cpi;
pub mod cpi_bridge;
pub mod bet_staging;
pub mod share_staging;
pub mod share_tier;
pub mod showdown_hash;
pub mod shuffle_hash;
pub mod shuffle_staging;
#[cfg(not(target_os = "solana"))]
pub mod test_vectors;
pub mod verifying_keys;

use deck_state::{active_deck_bytes, copy_deck_from_public_inputs};
use game_config::OnchainGameConfig;
use groth16_verify::{
    g1_add, g1_mul_add, verify_groth16, verify_pairing_prepared, UncompressedProof,
};
use light_artifacts::{
    ArtifactChunkCompressedAccount, BetCommitmentCompressedAccount, RegisterCompressedAccount,
    UsedPermutationCompressedAccount, used_perm_address_seeds,
};
use showdown_hash::{
    parse_coefficient_commitment, parse_showdown_material,
};
use shuffle_hash::{field_from_u128, hash_deck_fields, shuffle_input_hash_from_accounts_with_config};
use shuffle_staging::{
    fill_complete, init_header, init_prepared_accumulator, output_hash, prepared_g1_mut,
    prepared_g1_ref, public_inputs_slice,
    read_prepared_count, shuffle_account_size, write_inputs_chunk, write_prepare_chunk,
    write_prepared_count, PREPARE_INPUTS_PER_TX, SHUFFLE_CIRCUIT_VERSION,
};
use shared_zk_ids::{
    shuffle_initial_deck_hash, CIRCUIT_VERSION_V2, CPI_AUTHORITY_SEED, PROOF_PHASE_ACTION,
    PROOF_RECEIPT_V2_SEED, RECEIPT_STATUS_INITIALIZED, RECEIPT_STATUS_VERIFIED,
};
use verifying_keys::registry::{lookup as lookup_vk, VkPhase};

pub const ID: Pubkey = Pubkey([172, 30, 18, 160, 29, 168, 238, 203, 210, 100, 0, 181, 168, 232, 214, 194, 132, 12, 23, 220, 26, 79, 193, 140, 151, 156, 188, 112, 103, 235, 198, 89]);

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc");

#[cfg(feature = "no-entrypoint")]
pinocchio::entrypoint!(process_instruction);

#[cfg(feature = "no-entrypoint")]
fn process_instruction(
    program_id: &pinocchio::pubkey::Pubkey,
    accounts: &[pinocchio::account_info::AccountInfo],
    instruction_data: &[u8],
) -> pinocchio::ProgramResult {
    if *program_id != ID.0 {
        return Err(pinocchio::program_error::ProgramError::IncorrectProgramId);
    }
    let result = dispatch::dispatch(accounts, instruction_data);
    if result.is_ok() && prelude::take_account_write_failed() {
        return Err(pinocchio::program_error::ProgramError::Custom(3004));
    }
    let _ = prelude::take_account_write_failed();
    result.map_err(Into::into)
}

/// Instruction-argument wrappers. The Light SDK types serialize with Borsh, and
/// these newtypes give Anchor's IDL builder a local type with the same bytes.
#[derive(Clone, Copy, Debug)]
pub struct LightValidityProof(pub ValidityProof);

#[derive(Clone, Copy, Debug)]
pub struct LightAddressTreeInfo(pub PackedAddressTreeInfo);

#[derive(Clone, Copy, Debug)]
pub struct LightCompressedAccountMeta(
    pub light_sdk_pinocchio::instruction::account_meta::CompressedAccountMeta,
);

impl BorshSerialize for LightValidityProof {
    fn serialize<W: borsh::maybestd::io::Write>(
        &self,
        writer: &mut W,
    ) -> borsh::maybestd::io::Result<()> {
        BorshSerialize::serialize(&self.0, writer)
    }
}

impl BorshDeserialize for LightValidityProof {
    fn deserialize_reader<R: borsh::maybestd::io::Read>(
        reader: &mut R,
    ) -> borsh::maybestd::io::Result<Self> {
        Ok(Self(BorshDeserialize::deserialize_reader(reader)?))
    }
}

impl BorshSerialize for LightAddressTreeInfo {
    fn serialize<W: borsh::maybestd::io::Write>(
        &self,
        writer: &mut W,
    ) -> borsh::maybestd::io::Result<()> {
        BorshSerialize::serialize(&self.0, writer)
    }
}

impl BorshDeserialize for LightAddressTreeInfo {
    fn deserialize_reader<R: borsh::maybestd::io::Read>(
        reader: &mut R,
    ) -> borsh::maybestd::io::Result<Self> {
        Ok(Self(BorshDeserialize::deserialize_reader(reader)?))
    }
}

impl BorshSerialize for LightCompressedAccountMeta {
    fn serialize<W: borsh::maybestd::io::Write>(
        &self,
        writer: &mut W,
    ) -> borsh::maybestd::io::Result<()> {
        BorshSerialize::serialize(&self.0, writer)
    }
}

impl BorshDeserialize for LightCompressedAccountMeta {
    fn deserialize_reader<R: borsh::maybestd::io::Read>(
        reader: &mut R,
    ) -> borsh::maybestd::io::Result<Self> {
        Ok(Self(BorshDeserialize::deserialize_reader(reader)?))
    }
}


/// Create one new compressed account through `light-sdk-pinocchio`.
fn create_light_account<A, F>(
    signer: &AccountInfo,
    remaining: &[AccountInfo],
    proof: LightValidityProof,
    address_tree_info: LightAddressTreeInfo,
    output_merkle_tree_index: u8,
    seeds: &[&[u8]],
    fill: F,
) -> Result<()>
where
    A: BorshSerialize + BorshDeserialize + LightDiscriminator + light_hasher::DataHasher + Default,
    F: FnOnce(&mut LightAccount<A>),
{
    if remaining.is_empty() {
        return err!(ErrorCode::AccountNotEnoughKeys);
    }
    let tail: Vec<pinocchio::account_info::AccountInfo> =
        remaining.iter().map(|ai| *ai.raw).collect();
    let proof = proof.0;
    let address_tree_info = address_tree_info.0;
    let cpi_accounts = CpiAccounts::new(signer.raw, &tail, LIGHT_CPI_SIGNER);
    let tree = address_tree_info
        .get_tree_pubkey(&cpi_accounts)
        .map_err(|_| error!(ErrorCode::AccountNotEnoughKeys))?;
    let program_id = crate::ID.to_bytes();
    let (address, address_seed) = derive_address(seeds, &tree, &program_id);
    let new_address_params = address_tree_info.into_new_address_params_packed(address_seed);
    let mut account =
        LightAccount::<A>::new_init(&program_id, Some(address), output_merkle_tree_index);
    fill(&mut account);
    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(account)
        .map_err(|_err| {
            pinocchio::log::sol_log("light account create failed");
            error!(ErrorCode::InvalidProof)
        })?
        .with_new_addresses(core::slice::from_ref(&new_address_params))
        .invoke(cpi_accounts)
        .map_err(|_err| {
            pinocchio::log::sol_log("light cpi failed");
            error!(ErrorCode::InvalidProof)
        })?;
    Ok(())
}

/// Maximum number of commitments per revealed partials chunk
pub const MAX_COMMITMENTS: usize = 8;

/// Maximum number of players
pub const MAX_PLAYERS: u8 = 10;

/// Total cards = 2 * MAX_PLAYERS + 5 (hole cards + community)
pub const TOTAL_CARDS: usize = 25;

/// Number of pots in a max-player game = MAX_PLAYERS - 1
pub const MAX_POTS: usize = 9;

/// Number of public inputs for register_main circuit
pub const REGISTER_PUBLIC_INPUTS: usize = 6;

/// Shuffle proof nPublic: deck hash, permutation hash, derived input hash.
pub const SHUFFLE_PUBLIC_INPUTS: usize = 3;

/// Number of public inputs for share_hashout_main circuit.
pub const SHARE_PUBLIC_INPUTS: usize = 2;

/// Number of public inputs for showdown_hashout_main circuit
pub const SHOWDOWN_PUBLIC_INPUTS: usize = 2;

pub const PROOF_PHASE_REGISTER: u8 = 0;
pub const PROOF_PHASE_SHUFFLE: u8 = 1;
pub const PROOF_PHASE_SHARE: u8 = 2;
pub const PROOF_PHASE_SHOWDOWN: u8 = 3;
/// Solana caps CPI realloc / create at 10 KiB — grow large PDAs in steps.
pub const MAX_CPI_ALLOC: usize = 10_240;

/// Grow a program-owned account by up to [`MAX_CPI_ALLOC`] toward `target_size`.
///
/// Tops up rent before `realloc`. Caller must invoke repeatedly until
/// `account.data_len() == target_size`.
fn grow_account<'info>(
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    target_size: usize,
) -> Result<()> {
    let current = account.data_len();
    require!(current < target_size, ErrorCode::InvalidPublicInputs);
    let next = (current + MAX_CPI_ALLOC).min(target_size);
    let extra = next.saturating_sub(current);
    if extra == 0 {
        return Ok(());
    }

    require_keys_eq!(
        system_program.key(),
        SYSTEM_PROGRAM_ID,
        ErrorCode::InvalidPublicInputs
    );
    let needed = minimum_balance(next)?;
    let have = account.lamports();
    if needed > have {
        transfer(payer, account, needed - have)?;
    }

    account.realloc(next, false)?;
    Ok(())
}

/// PDA-side state for one Poker `RevealReceipt`.
///
/// The compressed chunk leaves remain Light-owned; this small PDA is the
/// fail-closed bridge state that records exact coverage and the commitment
/// supplied by Poker before the receipt is consumed.
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct RevealPersistenceState {
    pub game_id: Pubkey,
    pub generation: u64,
    pub recipient_index: u8,
    pub card_index: u16,
    pub filled_bits: u64,
    pub expected_commitment: [u8; 32],
    pub frozen: bool,
    pub receipt_consumed: bool,
}

pub mod light_casino {
    use super::*;
    use crate::prelude::{err, error, require, require_keys_eq};
    mod load;

    fn reimburse_created(remaining: &[AccountInfo], signer: &AccountInfo, amount: u64) -> Result<()> {
        rent_vault::reimburse_leading(remaining, signer, amount)
    }

    /// After casino has consumed the receipt, return its rent to the vault.
    fn close_consumed_receipt(
        remaining: &[AccountInfo],
        signer: &Signer,
        receipt: &mut Account<ProofReceipt>,
    ) -> Result<()> {
        if receipt.status != shared_zk_ids::RECEIPT_STATUS_CONSUMED {
            return Ok(());
        }
        receipt.exit(&crate::ID)?;
        rent_vault::close_to_leading(remaining, &signer.to_account_info(), &receipt.to_account_info())
    }

    // ─── Existing: Revealed Partials Storage ───

    pub fn create_revealed_partials<'info>(
        ctx: Context<GenericAnchorAccounts>,
        proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
        game_id: Pubkey,
        recipient_index: u8,
        chunk_index: u16,
        start_index: u16,
        count: u8,
        commitment_0: [u8; 32],
        commitment_1: [u8; 32],
        commitment_2: [u8; 32],
        commitment_3: [u8; 32],
        commitment_4: [u8; 32],
        commitment_5: [u8; 32],
        commitment_6: [u8; 32],
        commitment_7: [u8; 32],
    ) -> Result<()> {
        require!(recipient_index < MAX_PLAYERS, ErrorCode::InvalidPlayerIndex);
        require!(count >= 1 && count <= 8, ErrorCode::InvalidChunkCount);
        create_light_account::<RevealedPartialsCompressedAccount, _>(
            ctx.accounts.signer.as_ref(),
            &ctx.remaining_accounts,
            proof,
            address_tree_info,
            output_merkle_tree_index,
            &[
                b"revealed",
                game_id.as_ref(),
                &[recipient_index],
                ctx.accounts.signer.key().as_ref(),
                &chunk_index.to_le_bytes(),
            ],
            |partials| {
                partials.game_id = game_id;
                partials.chunk_index = chunk_index;
                partials.start_index = start_index;
                partials.count = count;
                partials.commitment_0 = commitment_0;
                partials.commitment_1 = commitment_1;
                partials.commitment_2 = commitment_2;
                partials.commitment_3 = commitment_3;
                partials.commitment_4 = commitment_4;
                partials.commitment_5 = commitment_5;
                partials.commitment_6 = commitment_6;
                partials.commitment_7 = commitment_7;
            },
        )?;
        Ok(())
    }

    // ─── Game Lifecycle: Initialization ───

    /// Initialize a new game.
    ///
    /// Creates a `GameState` PDA to track game progress. Config is copied from
    /// the room table (`game_kind` / `shoe_decks` / `roulette_variant`).
    pub fn initialize_game(
        mut ctx: Context<InitializeGame>,
        game_id: [u8; 32],
        num_players: u8,
        game_kind: u8,
        shoe_decks: u8,
        roulette_variant: u8,
        dealer_index: u8,
        bridge_mode: u8,
    ) -> Result<()> {
        require!(
            bridge_mode == cpi_bridge::BRIDGE_MODE_STANDALONE
                || bridge_mode == cpi_bridge::BRIDGE_MODE_CASINO_REQUIRED,
            ErrorCode::InvalidGameConfig
        );
        let config = OnchainGameConfig::from_raw(game_kind, shoe_decks, roulette_variant)?;
        // Slots 2, blackjack 8, poker 10. Baccarat, war, roulette, craps, keno,
        // and bingo use the 12-seat table. Poker and bingo have no house seat.
        let max_players = config.kind().max_players();
        require!(
            num_players >= 2 && num_players <= max_players,
            ErrorCode::InvalidNumPlayers
        );
        let needs_dealer = config.kind().needs_house_seat();
        if needs_dealer {
            // The last player index is the house seat.
            require!(
                dealer_index == num_players.saturating_sub(1),
                ErrorCode::InvalidPlayerIndex
            );
        } else {
            require!(dealer_index == 255, ErrorCode::InvalidGameConfig);
        }

        let game_state = &mut ctx.accounts.game_state;
        game_state.game_id = game_id;
        game_state.generation = 0;
        game_state.phase = GamePhase::Registration as u8;
        game_state.num_players = num_players;
        game_state.current_player = 0;
        // Poker only: fold / side-pot contestants. House and PvP games leave this
        // at 0 and gate showdown by `dealer_index` (or any seated player).
        game_state.pot_mask = if config.kind() == shared_zk_ids::GameKind::Poker {
            (1u16 << num_players) - 1
        } else {
            0
        };
        game_state.shared_mask = 0;
        game_state.total_partials_expected = if config.is_roulette() {
            (num_players as u16 - 1) * 1
        } else if config.kind() == shared_zk_ids::GameKind::Blackjack {
            // Lazy share: start with one 16-card chunk; `extend_share_chunks` grows this.
            num_players as u16
        } else if config.kind() == shared_zk_ids::GameKind::Craps {
            (num_players as u16 - 1) * 2
        } else if config.kind() == shared_zk_ids::GameKind::Keno {
            (num_players as u16 - 1) * 20
        } else if config.kind() == shared_zk_ids::GameKind::Slots {
            require!(num_players == 2, ErrorCode::InvalidNumPlayers);
            (num_players as u16 - 1) * config.roulette_variant() as u16
        } else if config.kind() == shared_zk_ids::GameKind::Bingo {
            num_players as u16 * shared_zk_ids::BINGO_CHUNK_BALLS as u16
        } else {
            (num_players as u16) * ((num_players - 1) as u16)
        };
        game_state.total_partials_revealed = 0;
        game_state.game_kind = config.kind() as u8;
        game_state.shoe_decks = config.shoe_decks();
        game_state.roulette_variant = config.roulette_variant();
        game_state.dealer_index = dealer_index;
        // Blackjack / bingo start at 1 chunk; further chunks open on demand.
        game_state.n_share_chunks = 1;
        game_state.bridge_mode = bridge_mode;
        game_state.pattern_id = 0;
        game_state.showdown_opened_at = 0;
        game_state.showdown_forfeited = false;
        game_state.operator = ctx.accounts.payer.key();

        Ok(())
    }

    /// Announce the 75-ball public pattern (0=any line, 1=corners, 2=blackout).
    /// Must land after registration and before the first share chunk is verified.
    pub fn set_bingo_pattern(mut ctx: Context<SetBingoPattern>, pattern_id: u8) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.game_kind == shared_zk_ids::GameKind::Bingo as u8,
            ErrorCode::InvalidGameConfig
        );
        require!(
            game_state.roulette_variant == 75,
            ErrorCode::InvalidGameConfig
        );
        require!(pattern_id <= 2, ErrorCode::InvalidPublicInputs);
        require!(
            game_state.phase == GamePhase::Registration as u8
                || game_state.phase == GamePhase::Shuffle as u8
                || game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );
        require!(game_state.shared_mask == 0, ErrorCode::InvalidGamePhase);
        game_state.pattern_id = pattern_id;
        Ok(())
    }

    /// Open the next blackjack / bingo share chunk after a prefix finalize.
    ///
    /// Clears `shared_mask` and returns to Share so seats can verify chunk N+1
    /// while already-shared cards remain revealable on poker (`shared_cards`).
    pub fn extend_share_chunks(mut ctx: Context<ExtendShareChunks>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let kind = game_state.game_kind;
        require!(
            kind == shared_zk_ids::GameKind::Blackjack as u8
                || kind == shared_zk_ids::GameKind::Bingo as u8,
            ErrorCode::InvalidGameConfig
        );
        require!(
            game_state.phase == GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        let max_chunks = if kind == shared_zk_ids::GameKind::Bingo as u8 {
            shared_zk_ids::bingo_share_chunks(game_state.roulette_variant)
        } else {
            shared_zk_ids::blackjack_share_chunks_for_seats(game_state.num_players)
        };
        require!(
            game_state.n_share_chunks < max_chunks,
            ErrorCode::InvalidPublicInputs
        );
        game_state.n_share_chunks = game_state
            .n_share_chunks
            .checked_add(1)
            .ok_or(error!(ErrorCode::InvalidPublicInputs))?;
        game_state.total_partials_expected = if kind == shared_zk_ids::GameKind::Bingo as u8 {
            (game_state.n_share_chunks as u16)
                .saturating_mul(game_state.num_players as u16)
                .saturating_mul(shared_zk_ids::BINGO_CHUNK_BALLS as u16)
        } else {
            (game_state.n_share_chunks as u16).saturating_mul(game_state.num_players as u16)
        };
        game_state.shared_mask = 0;
        game_state.phase = GamePhase::Share as u8;
        game_state.current_player = 0;
        Ok(())
    }

    /// Initialize the empty `cpi_authority` PDA used to sign poker `consume_*` CPIs.
    pub fn init_cpi_authority(ctx: Context<InitCpiAuthority>) -> Result<()> {
        let _ = ctx.accounts.cpi_authority;
        Ok(())
    }

    /// Close the program-owned `cpi_authority` stub (any 8-byte init layout).
    /// After close, clients fund the same PDA as a system account so it can pay
    /// rent when CPIing `poker::consume_register_receipt`.
    pub fn close_cpi_authority(ctx: Context<CloseCpiAuthority>) -> Result<()> {
        let dest = ctx.accounts.payer.to_account_info();
        let source = ctx.accounts.cpi_authority.to_account_info();
        require_keys_eq!(source.owner(), crate::ID, ErrorCode::InvalidPublicInputs);
        let lamports = source.lamports();
        *dest.try_borrow_mut_lamports()? += lamports;
        *source.try_borrow_mut_lamports()? = 0;
        source.assign(&SYSTEM_PROGRAM_ID);
        source.realloc(0, false)?;
        Ok(())
    }

    /// Persist one artifact chunk (shuffle deck / share active limbs / showdown
    /// encrypted masks) to Light. Address seeds: `artifact` || game_id || kind || owner || chunk.
    pub fn store_artifact_chunk<'info>(
        ctx: Context<GenericAnchorAccounts>,
        proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
        game_id: Pubkey,
        kind: u8,
        owner_index: u8,
        chunk_index: u16,
        start_index: u16,
        count: u8,
        commitment_0: [u8; 32],
        commitment_1: [u8; 32],
        commitment_2: [u8; 32],
        commitment_3: [u8; 32],
        commitment_4: [u8; 32],
        commitment_5: [u8; 32],
        commitment_6: [u8; 32],
        commitment_7: [u8; 32],
    ) -> Result<()> {
        require!(count <= MAX_COMMITMENTS as u8, ErrorCode::InvalidPublicInputs);
        let kind_bytes = [kind];
        let owner_bytes = [owner_index];
        let chunk_bytes = chunk_index.to_le_bytes();
        create_light_account::<ArtifactChunkCompressedAccount, _>(
            ctx.accounts.signer.as_ref(),
            &ctx.remaining_accounts,
            proof,
            address_tree_info,
            output_merkle_tree_index,
            &[
                b"artifact",
                game_id.as_ref(),
                kind_bytes.as_ref(),
                owner_bytes.as_ref(),
                chunk_bytes.as_ref(),
            ],
            |chunk| {
                chunk.game_id = game_id;
                chunk.chunk_index = chunk_index;
                chunk.start_index = start_index;
                chunk.count = count;
                chunk.commitment_0 = commitment_0;
                chunk.commitment_1 = commitment_1;
                chunk.commitment_2 = commitment_2;
                chunk.commitment_3 = commitment_3;
                chunk.commitment_4 = commitment_4;
                chunk.commitment_5 = commitment_5;
                chunk.commitment_6 = commitment_6;
                chunk.commitment_7 = commitment_7;
            },
        )?;
        Ok(())
    }

    pub fn register_player_receipt(
        mut ctx: Context<RegisterPlayer>,
        player_index: u8,
        proof: UncompressedProof,
        public_inputs: [[u8; 32]; REGISTER_PUBLIC_INPUTS],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Registration as u8,
            ErrorCode::InvalidGamePhase
        );
        require!(
            player_index < game_state.num_players,
            ErrorCode::InvalidPlayerIndex
        );
        let bit = 1u16 << player_index;
        require!(
            game_state.shared_mask & bit == 0,
            ErrorCode::PlayerAlreadyRegistered
        );

        verify_groth16(
            &proof,
            &public_inputs,
            &verifying_keys::register_main::VERIFYING_KEY,
        )?;

        let public_key = [public_inputs[0], public_inputs[1]];
        let padding = [public_inputs[2], public_inputs[3], public_inputs[4], public_inputs[5]];

        let created = ctx.accounts.player_state.to_account_info().lamports()
            + ctx.accounts.proof_receipt.to_account_info().lamports();
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            created,
        )?;

        let player_state = &mut ctx.accounts.player_state;
        player_state.game_id = game_state.game_id;
        player_state.player_index = player_index;
        player_state.authority = ctx.accounts.signer.key();
        player_state.public_key = public_key;
        player_state.padding = padding;
        player_state.share_chunk_mask = 0;

        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = game_state.game_id;
        receipt.generation = game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_REGISTER;
        receipt.player_index = player_index;
        receipt.output_hash = public_inputs[0];
        // Groth16 already verified above — mark VERIFIED so poker CPI accepts it.
        receipt.status = RECEIPT_STATUS_VERIFIED;

        cpi_bridge::maybe_consume_register(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &ctx.accounts.poker_player_state,
            &mut ctx.accounts.proof_receipt,
            &ctx.accounts.system_program.to_account_info(),
            &public_key,
            &padding,
        )?;
        close_consumed_receipt(
            &ctx.remaining_accounts,
            &ctx.accounts.signer,
            &mut ctx.accounts.proof_receipt,
        )?;

        // Parallel register: shared_mask = registered bitmap until Shuffle.
        game_state.shared_mask |= bit;
        if game_state.shared_mask.count_ones() as u8 == game_state.num_players {
            game_state.phase = GamePhase::Shuffle as u8;
            game_state.current_player = 0;
            game_state.shared_mask = 0;
        }

        Ok(())
    }

    // ─── Game Lifecycle: Registration ───

    /// Register a player.
    /// 
    /// Verifies a `register_main` Groth16 proof (6 public inputs).
    /// The public inputs are: [publicKey_x, publicKey_y, padding_0, padding_1, padding_2, padding_3].
    /// Creates a `PlayerState` PDA and a `RegisterCompressedAccount` via Light Protocol CPI.
    pub fn register_player<'info>(
        mut ctx: Context<RegisterPlayer>,
        player_index: u8,
        proof: UncompressedProof,
        public_inputs: [[u8; 32]; REGISTER_PUBLIC_INPUTS],
        light_proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Registration as u8,
            ErrorCode::InvalidGamePhase
        );
        require!(
            player_index < game_state.num_players,
            ErrorCode::InvalidPlayerIndex
        );
        let bit = 1u16 << player_index;
        require!(
            game_state.shared_mask & bit == 0,
            ErrorCode::PlayerAlreadyRegistered
        );

        // Verify Groth16 proof
        verify_groth16(
            &proof,
            &public_inputs,
            &verifying_keys::register_main::VERIFYING_KEY,
        )?;

        // Extract public key and padding from public inputs
        let public_key = [public_inputs[0], public_inputs[1]];
        let padding = [public_inputs[2], public_inputs[3], public_inputs[4], public_inputs[5]];

        let player_state = &mut ctx.accounts.player_state;
        player_state.game_id = game_state.game_id;
        player_state.player_index = player_index;
        player_state.authority = ctx.accounts.signer.key();
        player_state.public_key = public_key;
        player_state.padding = padding;
        player_state.share_chunk_mask = 0;

        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = game_state.game_id;
        receipt.generation = game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_REGISTER;
        receipt.player_index = player_index;
        receipt.output_hash = public_inputs[0];
        // Groth16 already verified above — mark VERIFIED so poker CPI accepts it.
        receipt.status = RECEIPT_STATUS_VERIFIED;

        // Create compressed register artifact (PK + padding) on Light
        let game_id = game_state.game_id;
        let reg = RegisterCompressedAccount::new(
            Pubkey::new_from_array(game_id),
            player_index,
            public_key,
            padding,
        );
        create_light_account::<RegisterCompressedAccount, _>(
            ctx.accounts.signer.as_ref(),
            &ctx.remaining_accounts,
            light_proof,
            address_tree_info,
            output_merkle_tree_index,
            &[b"player", game_id.as_ref(), &[player_index]],
            |player_compressed| {
                player_compressed.game_id = reg.game_id;
                player_compressed.player_index = reg.player_index;
                player_compressed.kind = reg.kind;
                player_compressed.public_key_x = reg.public_key_x;
                player_compressed.public_key_y = reg.public_key_y;
                player_compressed.padding_0 = reg.padding_0;
                player_compressed.padding_1 = reg.padding_1;
                player_compressed.padding_2 = reg.padding_2;
                player_compressed.padding_3 = reg.padding_3;
            },
        )?;

        cpi_bridge::maybe_consume_register(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &ctx.accounts.poker_player_state,
            &mut ctx.accounts.proof_receipt,
            &ctx.accounts.system_program.to_account_info(),
            &public_key,
            &padding,
        )?;

        game_state.shared_mask |= bit;
        if game_state.shared_mask.count_ones() as u8 == game_state.num_players {
            game_state.phase = GamePhase::Shuffle as u8;
            game_state.current_player = 0;
            game_state.shared_mask = 0;
        }

        Ok(())
    }

    pub fn init_deck_state(ctx: Context<InitDeckState>) -> Result<()> {
        // Account starts at MAX_CPI_ALLOC; caller must `extend_deck_state` to full size.
        let _ = &ctx.accounts.deck_state;
        Ok(())
    }

    /// Grow `deck_state` by up to 10 KiB toward this table's shoe.
    pub fn extend_deck_state(ctx: Context<ExtendDeckState>) -> Result<()> {
        let target = deck_state::account_size(ctx.accounts.game_state.config()?.deck_fields())?;
        if ctx.accounts.deck_state.data_len() >= target {
            return Ok(());
        }
        grow_account(
            &ctx.accounts.deck_state.to_account_info(),
            &ctx.accounts.signer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            target,
        )
    }

    /// Return shoe-sized `deck_state` rent after the hand has finished reading it.
    ///
    /// Remaining accounts, when the game-scoped shuffle buffer is still open:
    /// `[shuffle_inputs, shuffle_vault, operator_vault]`. The last rent vault
    /// receives `deck_state`. The vault after `shuffle_inputs` receives that
    /// buffer. Both were drawn from the float.
    pub fn close_deck_state(ctx: Context<CloseDeckState>) -> Result<()> {
        let game = &ctx.accounts.game_state;
        require!(
            game.phase >= GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        require_keys_eq!(ctx.accounts.signer.key(), game.operator, ErrorCode::InvalidAuthority);
        let (shuffle_inputs, _) = Pubkey::find_program_address(
            &[b"shuffle_inputs", &game.game_id],
            &ctx.program_id,
        );
        let mut shuffle_vault: Option<AccountInfo> = None;
        let mut deck_vault: Option<AccountInfo> = None;
        if let Some(pos) = ctx
            .remaining_accounts
            .iter()
            .position(|account| account.key() == shuffle_inputs)
        {
            if let Some(vault) = ctx.remaining_accounts.get(pos + 1) {
                if rent_vault::is_rent_vault(vault) {
                    shuffle_vault = Some(vault.clone());
                }
            }
        }
        for account in ctx.remaining_accounts.iter() {
            if rent_vault::is_rent_vault(account) {
                deck_vault = Some(account.clone());
            }
        }
        let dest = deck_vault
            .clone()
            .unwrap_or_else(|| ctx.accounts.signer.to_account_info());
        let source = ctx.accounts.deck_state.to_account_info();
        require_keys_eq!(source.owner(), crate::ID, ErrorCode::InvalidPublicInputs);
        let lamports = source.lamports();
        *dest.try_borrow_mut_lamports()? += lamports;
        *source.try_borrow_mut_lamports()? = 0;
        source.assign(&SYSTEM_PROGRAM_ID);
        source.realloc(0, false)?;

        if let Some(staging) = ctx
            .remaining_accounts
            .iter()
            .find(|account| account.key() == shuffle_inputs)
        {
            if staging.owner() == crate::ID && staging.data_len() > 0 {
                if let Some(vault) = shuffle_vault {
                    rent_vault::refund_staging(staging, &vault)?;
                }
            }
        }
        Ok(())
    }

fn require_current_shuffler(game: &GameState, player_index: u8) -> Result<()> {
    require!(
        game.phase == GamePhase::Shuffle as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(player_index == game.current_player, ErrorCode::NotYourTurn);
    Ok(())
}

    /// Allocate the game's one shuffle buffer (≤10 KiB). Later shufflers overwrite it.
    /// Call `extend_shuffle_public_inputs` until full size, then
    /// `create_shuffle_public_inputs` to write the header.
    pub fn allocate_shuffle_public_inputs(ctx: Context<AllocateShufflePublicInputs>) -> Result<()> {
        require_current_shuffler(&ctx.accounts.game_state, ctx.accounts.player_state.player_index)?;
        let staging = ctx.accounts.shuffle_public_inputs.to_account_info();
        let (vault, _) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        if let Some(vault) = vault {
            rent_vault::reimburse_signer(
                &vault,
                &ctx.accounts.signer.to_account_info(),
                staging.lamports(),
            )?;
        }
        Ok(())
    }

    /// Grow shuffle public-inputs PDA by up to 10 KiB toward full size.
    pub fn extend_shuffle_public_inputs(ctx: Context<ExtendShufflePublicInputs>) -> Result<()> {
        require_current_shuffler(&ctx.accounts.game_state, ctx.accounts.player_state.player_index)?;
        let account = ctx.accounts.shuffle_public_inputs.to_account_info();
        let target = shuffle_account_size(
            ctx.accounts.game_state.config()?.shuffle_caller_public_inputs(),
        )?;
        if account.data_len() >= target {
            return Ok(());
        }
        let before = account.lamports();
        grow_account(
            &account,
            &ctx.accounts.signer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            target,
        )?;
        let paid = account.lamports().saturating_sub(before);
        let (vault, _) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        if let Some(vault) = vault {
            rent_vault::reimburse_signer(&vault, &ctx.accounts.signer.to_account_info(), paid)?;
        }
        Ok(())
    }

    /// Reset the game's one shuffle buffer so the current shuffler can write
    /// the next proof's public outputs. This does not publish a shoe.
    /// `deck_state` changes only in `verify_shuffle_staged`, after the buffer
    /// still matches the proof output.
    pub fn create_shuffle_public_inputs(ctx: Context<CreateShufflePublicInputs>) -> Result<()> {
        require_current_shuffler(&ctx.accounts.game_state, ctx.accounts.player_state.player_index)?;
        let config = ctx.accounts.game_state.config()?;
        let caller_inputs = config.shuffle_caller_public_inputs();
        let len = ctx.accounts.shuffle_public_inputs.data_len();
        require!(
            len >= shuffle_account_size(caller_inputs)?,
            ErrorCode::InvalidPublicInputs
        );
        let vk = lookup_vk(&config.shared(), VkPhase::Shuffle)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut data = ctx.accounts.shuffle_public_inputs.try_borrow_mut_data()?;
        data[0..8].copy_from_slice(&ShufflePublicInputs::DISCRIMINATOR);
        init_header(
            &mut data,
            &ctx.accounts.game_state.game_id,
            ctx.accounts.game_state.generation,
            SHUFFLE_CIRCUIT_VERSION,
            ctx.accounts.player_state.player_index,
            caller_inputs,
        )?;
        // Seed prepared accumulator with vk_ic[0] so chunked prepare can resume.
        init_prepared_accumulator(&mut data, &vk.vk.vk_ic[0], caller_inputs)
    }

    pub fn write_shuffle_public_inputs(
        ctx: Context<WriteShufflePublicInputs>,
        offset: u16,
        data: Vec<u8>,
    ) -> Result<()> {
        require_current_shuffler(&ctx.accounts.game_state, ctx.accounts.player_state.player_index)?;
        let expected_caller = ctx.accounts.game_state.config()?.shuffle_caller_public_inputs();
        let mut account_data = ctx.accounts.shuffle_public_inputs.try_borrow_mut_data()?;
        write_inputs_chunk(&mut account_data, offset, &data, expected_caller)
    }

    /// Fold one disjoint MSM slice of caller-staged public inputs into a partial G1.
    ///
    /// `start` must be a multiple of [`PREPARE_INPUTS_PER_TX`]. Chunks may land in
    /// any order. Does **not** re-derive the transient commitment (finalize does).
    pub fn prepare_shuffle_chunk(
        ctx: Context<PrepareShuffleChunk>,
        start: u16,
    ) -> Result<()> {
        require_current_shuffler(&ctx.accounts.game_state, ctx.accounts.player_state.player_index)?;
        let config = ctx.accounts.game_state.config()?;
        let expected_caller = config.shuffle_caller_public_inputs();
        let vk = lookup_vk(&config.shared(), VkPhase::Shuffle)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;

        let mut data = ctx.accounts.shuffle_public_inputs.try_borrow_mut_data()?;
        require!(
            fill_complete(&data, expected_caller)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            read_prepared_count(&data, expected_caller)? == 0,
            ErrorCode::InvalidPublicInputs
        );

        let start_usize = start as usize;
        require!(
            start_usize % PREPARE_INPUTS_PER_TX as usize == 0
                && start_usize < expected_caller,
            ErrorCode::InvalidPublicInputs
        );
        let end = (start_usize + PREPARE_INPUTS_PER_TX as usize).min(expected_caller);
        let inputs = public_inputs_slice(&data, expected_caller)?;

        // Fold from infinity into a private partial — no shared accumulator race.
        let mut partial = [0u8; 64];
        for index in start_usize..end {
            g1_mul_add(
                &mut partial,
                &vk.vk.vk_ic[index + 1],
                &inputs[index],
            )?;
        }
        write_prepare_chunk(&mut data, start, expected_caller, &partial)
    }

    /// Hash the shoe already in `deck_state` and stash it in the shuffle buffer.
    /// Player 0 uses the baked initial-deck constant, so it skips this.
    /// Keeping this off `finalize_prepare_shuffle_inputs` leaves that instruction
    /// enough compute to hash the new shoe and fold three public inputs.
    pub fn cache_shuffle_deck_hash<'info>(
        ctx: Context<FinalizePrepareShuffleInputs>,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require_current_shuffler(game_state, ctx.accounts.player_state.player_index)?;
        let player_index = ctx.accounts.player_state.player_index;
        require!(player_index > 0, ErrorCode::InvalidGamePhase);
        let config = game_state.config()?;
        let expected_caller = config.shuffle_caller_public_inputs();
        let deck_fields = config.deck_fields();
        // The absorb that fills this buffer can still be settling when this
        // simulation runs. Reject that before hashing the shoe.
        {
            let staged = ctx.accounts.shuffle_public_inputs.try_borrow_data()?;
            require!(
                fill_complete(&staged, expected_caller)?,
                ErrorCode::InvalidPublicInputs
            );
        }
        let deck_hash = {
            let deck_data = ctx.accounts.deck_state.try_borrow_data()?;
            let deck = active_deck_bytes(&deck_data, deck_fields)?;
            hash_deck_fields(deck, deck_fields)?
        };
        let mut data = ctx.accounts.shuffle_public_inputs.try_borrow_mut_data()?;
        shuffle_staging::write_cached_deck_hash(&mut data, &deck_hash, expected_caller)?;
        Ok(())
    }

    /// Sum MSM partials into `prepared_g1`, then fold the transient input commitment.
    ///
    /// Remaining accounts are the canonical player PDAs in seat order.
    pub fn finalize_prepare_shuffle_inputs<'info>(
        ctx: Context<FinalizePrepareShuffleInputs>,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require_current_shuffler(game_state, ctx.accounts.player_state.player_index)?;
        let config = game_state.config()?;
        let expected_caller = config.shuffle_caller_public_inputs();
        let expected_total = config.n_public_shuffle();
        let deck_fields = config.deck_fields();
        let initial_hash = shuffle_initial_deck_hash(&config.shared())
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let vk = lookup_vk(&config.shared(), VkPhase::Shuffle)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let player_index = ctx.accounts.player_state.player_index;
        // Same absorb race as `cache_shuffle_deck_hash`: the buffer is full on
        // the next read even when this simulation still sees the reset header.
        {
            let staged = ctx.accounts.shuffle_public_inputs.try_borrow_data()?;
            require!(
                fill_complete(&staged, expected_caller)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                read_prepared_count(&staged, expected_caller)? == 0,
                ErrorCode::InvalidPublicInputs
            );
        }
        let cached_deck_hash = if player_index == 0 {
            None
        } else {
            let staged = ctx.accounts.shuffle_public_inputs.try_borrow_data()?;
            let cached = shuffle_staging::read_cached_deck_hash(&staged, expected_caller)?;
            require!(cached != [0u8; 32], ErrorCode::InvalidPublicInputs);
            Some(cached)
        };
        let derived = shuffle_input_hash_from_accounts_with_config(
            &[],
            &ctx.remaining_accounts,
            game_state.num_players,
            player_index,
            &game_state.game_id,
            &ctx.program_id,
            player_index == 0,
            deck_fields,
            initial_hash,
            shared_zk_ids::shuffle_key_slots(&config.shared()),
            cached_deck_hash,
        )?;

        let mut data = ctx.accounts.shuffle_public_inputs.try_borrow_mut_data()?;
        require!(vk.vk.vk_ic.len() == 4, ErrorCode::InvalidGameConfig);

        // Public inputs are the shoe hash, the permutation hash, and the
        // derived input hash. The shoe limbs stay in the buffer for the next
        // player; they are not Groth16 inputs.
        let deck_fields = expected_caller - 1;
        let deck_hash = hash_deck_fields(
            &data[shuffle_staging::SHUFFLE_INPUTS_HEADER_SIZE
                ..shuffle_staging::SHUFFLE_INPUTS_HEADER_SIZE + deck_fields * 32],
            deck_fields,
        )?;
        let permutation = output_hash(&data, expected_caller)?;
        let mut prepared = *prepared_g1_ref(&data, expected_caller)?;
        g1_mul_add(&mut prepared, &vk.vk.vk_ic[1], &deck_hash)?;
        g1_mul_add(&mut prepared, &vk.vk.vk_ic[2], &permutation)?;
        g1_mul_add(&mut prepared, &vk.vk.vk_ic[3], &derived)?;
        prepared_g1_mut(&mut data, expected_caller)?.copy_from_slice(&prepared);
        write_prepared_count(&mut data, expected_total as u16, expected_caller)?;
        Ok(())
    }

    /// Verify staged shuffle Groth16 proof, register `permutationHash` globally
    /// via Light address uniqueness (`used_perm` || hash), then CPI-consume.
    ///
    /// Remaining accounts: Light CPI accounts only. Player PDAs are consumed by
    /// Preparation has already folded the locally derived transient commitment.
    pub fn verify_shuffle_staged<'info>(
        mut ctx: Context<VerifyShuffleStaged>,
        proof: UncompressedProof,
        light_proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Shuffle as u8,
            ErrorCode::InvalidGamePhase
        );

        let player_index = ctx.accounts.player_state.player_index;
        require!(
            player_index == game_state.current_player,
            ErrorCode::NotYourTurn
        );

        let (_staged_vault, light_remaining) =
            rent_vault::split_leading_vault(&ctx.remaining_accounts);
        let config = game_state.config()?;
        let expected_caller = config.shuffle_caller_public_inputs();
        let expected_total = config.n_public_shuffle();
        let deck_fields = config.deck_fields();
        let vk = lookup_vk(&config.shared(), VkPhase::Shuffle)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;

        // Scope borrows so we can later mutably borrow deck_state.
        let (output_hash_bytes, prepared_g1) = {
            let staged_data = ctx.accounts.shuffle_public_inputs.try_borrow_data()?;
            require!(
                fill_complete(&staged_data, expected_caller)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                read_prepared_count(&staged_data, expected_caller)? as usize == expected_total,
                ErrorCode::InvalidPublicInputs
            );
            let prepared = *prepared_g1_ref(&staged_data, expected_caller)?;
            let out = output_hash(&staged_data, expected_caller)?;
            (out, prepared)
        };

        // Pairing-only verify using the chunk-prepared accumulator.
        // A failed proof returns here, so the committed shoe is untouched.
        verify_pairing_prepared(&proof, &prepared_g1, vk.vk)?;

        // Global exclusion: create Light compressed account at used_perm || permutationHash.
        // Address-tree validity proof enforces the hash was never registered before.
        //
        // Arcium-only E2E localnet has no Light stack — with `feature = "testing"`,
        // empty Light remaining accounts skips this CPI so Groth16 shuffle still runs.
        // Production builds always require Light accounts + a real validity proof.
        let skip_used_perm = light_remaining.is_empty();
        #[cfg(not(feature = "testing"))]
        {
            require!(
                !skip_used_perm,
                ErrorCode::AccountNotEnoughKeys
            );
        }
        if !skip_used_perm {
            let seeds = used_perm_address_seeds(&output_hash_bytes);
            let leaf = UsedPermutationCompressedAccount::new(
                output_hash_bytes,
                Pubkey::new_from_array(game_state.game_id),
                player_index,
            );
            create_light_account::<UsedPermutationCompressedAccount, _>(
                ctx.accounts.signer.as_ref(),
                light_remaining,
                light_proof,
                address_tree_info,
                output_merkle_tree_index,
                &seeds,
                |used_perm| {
                    used_perm.permutation_hash = leaf.permutation_hash;
                    used_perm.game_id = leaf.game_id;
                    used_perm.player_index = leaf.player_index;
                    used_perm.kind = leaf.kind;
                },
            )?;
        }

        {
            // Staging writes are not the shoe. Publish them only when the
            // buffer still holds the public outputs the pairing just accepted.
            let staged_data = ctx.accounts.shuffle_public_inputs.try_borrow_data()?;
            require!(
                output_hash(&staged_data, expected_caller)? == output_hash_bytes,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                *prepared_g1_ref(&staged_data, expected_caller)? == prepared_g1,
                ErrorCode::InvalidPublicInputs
            );
            let mut deck_mut = ctx.accounts.deck_state.try_borrow_mut_data()?;
            copy_deck_from_public_inputs(
                &mut deck_mut,
                public_inputs_slice(&staged_data, expected_caller)?,
                deck_fields,
            )?;
        }

        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = game_state.game_id;
        receipt.generation = game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_SHUFFLE;
        receipt.player_index = player_index;
        receipt.output_hash = output_hash_bytes;
        receipt.status = RECEIPT_STATUS_VERIFIED;

        // CPI consume + turn advance happen in `finalize_shuffle` so the
        // Poseidon input-hash PDA and Groth16 receipt can land in parallel.
        // The shuffle buffer is left in place for the next shuffler.

        Ok(())
    }

    /// Consume the output-only shuffle receipt and advance.
    pub fn finalize_shuffle(mut ctx: Context<FinalizeShuffle>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Shuffle as u8,
            ErrorCode::InvalidGamePhase
        );
        let player_index = ctx.accounts.player_state.player_index;
        require!(
            player_index == game_state.current_player,
            ErrorCode::NotYourTurn
        );
        require!(
            ctx.accounts.proof_receipt.phase == PROOF_PHASE_SHUFFLE
                && ctx.accounts.proof_receipt.player_index == player_index
                && ctx.accounts.proof_receipt.status == RECEIPT_STATUS_VERIFIED,
            ErrorCode::InvalidPublicInputs
        );

        cpi_bridge::maybe_consume_proof(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &mut ctx.accounts.proof_receipt,
            None,
        )?;
        close_consumed_receipt(
            &ctx.remaining_accounts,
            &ctx.accounts.signer,
            &mut ctx.accounts.proof_receipt,
        )?;

        game_state.current_player += 1;
        if game_state.current_player == game_state.num_players {
            game_state.phase = GamePhase::Share as u8;
            game_state.current_player = 0;
            game_state.shared_mask = 0;
        }
        Ok(())
    }

    // ─── Game Lifecycle: Shuffle (legacy monolithic path removed — use staged flow) ───

    // ─── Game Lifecycle: Share Partials ───

    /// Verify share partials proof.
    ///
    /// Uses `share_hashout_main` (2 public inputs).
    /// Verifier inputs are [caller output, locally derived transient commitment].
    ///
    /// The verifier derives the second public signal from canonical deck and player
    /// accounts. The caller supplies only the proof and output digest.
    ///
    /// Players may submit in any order / in parallel. Progress is tracked via
    /// `shared_mask` (who has shared), not `current_player`.
    ///
    /// Blackjack: `chunk_index` selects the 16-card window; a seat is marked
    /// shared only after all `n_share_chunks` chunk proofs succeed.
    /// Non-blackjack: pass `chunk_index = 0`.
    ///
    /// Remaining accounts: player PDAs `0..num_players-1`.
    pub fn verify_share<'info>(
        mut ctx: Context<VerifyShare>,
        proof: UncompressedProof,
        output_hash: [u8; 32],
        chunk_index: u8,
        published_tiers: &[u8],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );

        let player_index = ctx.accounts.player_state.player_index;
        let num_players = game_state.num_players;
        let game_id = game_state.game_id;
        let n_chunks = game_state.n_share_chunks.max(1);
        let config = game_state.config()?;
        // Split roulette/craps/keno share is hashout-only (nPublic=2), same as war.
        require!(chunk_index < n_chunks, ErrorCode::InvalidPublicInputs);
        let is_chunked_share = config.kind() == shared_zk_ids::GameKind::Blackjack
            || config.kind() == shared_zk_ids::GameKind::Bingo;
        if !is_chunked_share {
            require!(chunk_index == 0, ErrorCode::InvalidPublicInputs);
        }
        let chunk_bit = 1u32 << chunk_index;
        require!(
            ctx.accounts.player_state.share_chunk_mask & chunk_bit == 0,
            ErrorCode::AlreadyShared
        );
        // Chunk opening is not required. Reveal hashing and the share stake
        // cover a bad partial. The accumulator binds the receipt generation
        // and, when no tier hashes are published, the Groth16 output.
        let acc = validate_share_verify_acc(
            &ctx.accounts.share_verify_acc.to_account_info(),
            &game_id,
            player_index,
        )?;
        let mut output_hash_le = output_hash;
        output_hash_le.reverse();
        let published = if share_tier::tier_hash_count(config.kind()).is_some() {
            require!(published_tiers.is_empty(), ErrorCode::InvalidPublicInputs);
            let staged = ctx.accounts.proof_receipt.to_account_info();
            let staged_data = staged.try_borrow_data()?;
            share_tier::stored_tier_hashes(&staged_data, config.kind())?
        } else {
            share_tier::parse_published_tiers(config.kind(), published_tiers)?
        };
        // Poker, blackjack, bingo, and baccarat bind the Groth16 output to the
        // fold of the street hashes uploaded with the partials. The Arcis sum
        // commits the rescue partials.
        if published.is_empty() {
            require!(
                acc.generation == ctx.accounts.proof_receipt.generation
                    && acc.verify_expected == output_hash_le,
                ErrorCode::InvalidPublicInputs
            );
        } else {
            let folded = share_tier::fold_tier_hashes(config.kind(), &published)?;
            require!(
                folded == output_hash
                    && acc.generation == ctx.accounts.proof_receipt.generation,
                ErrorCode::InvalidPublicInputs
            );
        }
        let mpc_generation = acc.generation;
        let (expected_receipt, _) = Pubkey::find_program_address(
            &[
                PROOF_RECEIPT_V2_SEED,
                &game_id,
                &mpc_generation.to_le_bytes(),
                &[PROOF_PHASE_SHARE],
                &[player_index],
            ],
            &ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.proof_receipt.key(),
            expected_receipt,
            ErrorCode::InvalidPublicInputs
        );
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let is_blackjack = config.kind() == shared_zk_ids::GameKind::Blackjack;
        let is_bingo = config.kind() == shared_zk_ids::GameKind::Bingo;
        let (_, player_accounts) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        let derived = {
            let deck_data = ctx.accounts.deck_state.try_borrow_data()?;
            let deck = active_deck_bytes(&deck_data, config.deck_fields())?;
            if is_blackjack {
                games::blackjack::share_input_hash_chunk_from_accounts(
                    deck,
                    player_accounts,
                    player_index,
                    num_players,
                    &game_id,
                    &ctx.program_id,
                    chunk_index,
                )?
            } else if is_bingo {
                games::bingo::share_input_hash_chunk_from_accounts(
                    deck,
                    player_accounts,
                    player_index,
                    num_players,
                    &game_id,
                    &ctx.program_id,
                    chunk_index,
                )?
            } else {
                games::share_input_hash_from_accounts(
                    config,
                    deck,
                    player_accounts,
                    player_index,
                    num_players,
                    &game_id,
                    &ctx.program_id,
                )?
            }
        };
        let verifier_inputs = [output_hash, derived];
        verify_groth16(&proof, &verifier_inputs, vk.vk)?;

        ctx.accounts.player_state.share_chunk_mask |= chunk_bit;
        let done_mask = (1u32 << n_chunks) - 1;
        let seat_fully_shared = ctx.accounts.player_state.share_chunk_mask == done_mask;
        if seat_fully_shared {
            mark_player_shared(game_state, player_index)?;
        }

        {
            let receipt = &mut ctx.accounts.proof_receipt;
            require!(
                receipt.status == RECEIPT_STATUS_INITIALIZED && receipt.output_hash == [0u8; 32],
                ErrorCode::InvalidPublicInputs
            );
            receipt.status = RECEIPT_STATUS_VERIFIED;
            receipt.output_hash = output_hash;
        }
        if !published.is_empty() {
            let info = ctx.accounts.proof_receipt.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            share_tier::write_published_tiers(&mut data, &published)?;
        }

        // Poker `mark_share_receipt` advances phase once every seat has shared.
        // For blackjack multi-chunk, only CPI-consume on the final chunk so poker
        // does not leave Share after the first chunk round.
        if seat_fully_shared {
            cpi_bridge::maybe_consume_proof(
                game_state.bridge_mode,
                &ctx.accounts.poker_program,
                &ctx.accounts.cpi_authority,
                ctx.bumps.cpi_authority,
                &ctx.accounts.poker_game_state,
                &mut ctx.accounts.proof_receipt,
                Some(&ctx.accounts.share_verify_acc),
            )?;
            // `finalize_share_phase` still reads this consumed receipt. The
            // client closes it into the vault after that instruction.
        }

        Ok(())
    }

    /// Slots share: Groth16 nPublic=10 (`outHash` + 8 coin-bet limbs + derived).
    /// Remaining accounts: player PDAs `0..num_players-1`.
    pub fn verify_slot_share<'info>(
        mut ctx: Context<VerifySlotShare>,
        proof: UncompressedProof,
        output_hash: [u8; 32],
        bet_limbs: [[u8; 32]; 8],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );
        let config = game_state.config()?;
        require!(
            config.kind() == shared_zk_ids::GameKind::Slots,
            ErrorCode::InvalidGameConfig
        );
        let player_index = ctx.accounts.player_state.player_index;
        let num_players = game_state.num_players;
        let game_id = game_state.game_id;
        require!(
            ctx.accounts.player_state.share_chunk_mask == 0,
            ErrorCode::AlreadyShared
        );
        let acc = validate_share_verify_acc(
            &ctx.accounts.share_verify_acc.to_account_info(),
            &game_id,
            player_index,
        )?;
        let mut output_hash_le = output_hash;
        output_hash_le.reverse();
        require!(
            acc.generation == ctx.accounts.proof_receipt.generation
                && acc.verify_expected == output_hash_le,
            ErrorCode::InvalidPublicInputs
        );
        let mpc_generation = acc.generation;
        let (expected_receipt, _) = Pubkey::find_program_address(
            &[
                PROOF_RECEIPT_V2_SEED,
                &game_id,
                &mpc_generation.to_le_bytes(),
                &[PROOF_PHASE_SHARE],
                &[player_index],
            ],
            &ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.proof_receipt.key(),
            expected_receipt,
            ErrorCode::InvalidPublicInputs
        );
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let (_, player_accounts) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        let derived = {
            let deck_data = ctx.accounts.deck_state.try_borrow_data()?;
            let deck = active_deck_bytes(&deck_data, config.deck_fields())?;
            games::slots::share_input_hash_from_accounts(
                deck,
                player_accounts,
                player_index,
                num_players,
                &game_id,
                &ctx.program_id,
                config.roulette_variant() as usize,
            )?
        };
        let verifier_inputs = [
            output_hash,
            bet_limbs[0],
            bet_limbs[1],
            bet_limbs[2],
            bet_limbs[3],
            bet_limbs[4],
            bet_limbs[5],
            bet_limbs[6],
            bet_limbs[7],
            derived,
        ];
        verify_groth16(&proof, &verifier_inputs, vk.vk)?;

        let bet_hash = crate::shuffle_hash::hash_flat_values_be(&bet_limbs[0..4])?;
        let bets = &mut ctx.accounts.roulette_bet_commitment;
        bets.game_id = game_id;
        bets.generation = game_state.generation;
        bets.player_index = player_index;
        // House still shares reel partials (fused circuit requires a dummy coin
        // in {1,2,3}); that ciphertext is not an economic wager.
        bets.actual_bet_count = if player_index == game_state.dealer_index {
            0
        } else {
            1
        };
        bets.bet_hash = bet_hash;
        bets.light_stored = true;

        ctx.accounts.player_state.share_chunk_mask |= 1;
        mark_player_shared(game_state, player_index)?;

        let receipt = &mut ctx.accounts.proof_receipt;
        require!(
            receipt.status == RECEIPT_STATUS_INITIALIZED && receipt.output_hash == [0u8; 32],
            ErrorCode::InvalidPublicInputs
        );
        receipt.status = RECEIPT_STATUS_VERIFIED;
        receipt.output_hash = output_hash;
        cpi_bridge::maybe_consume_proof(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &mut ctx.accounts.proof_receipt,
            Some(&ctx.accounts.share_verify_acc),
        )?;
        Ok(())
    }

    pub fn create_bet_public_inputs(ctx: Context<CreateBetPublicInputs>) -> Result<()> {
        let staging = ctx.accounts.bet_public_inputs.to_account_info();
        let (vault, _) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        if let Some(vault) = vault {
            rent_vault::reimburse_signer(
                &vault,
                &ctx.accounts.signer.to_account_info(),
                staging.lamports(),
            )?;
        }
        let config = ctx.accounts.game_state.config()?;
        require!(
            ctx.accounts.player_state.player_index != ctx.accounts.game_state.dealer_index,
            ErrorCode::DealerMustHaveZeroBets
        );
        let _expected = config
            .n_public_bet()
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let vk = lookup_vk(&config.shared(), VkPhase::Bet)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut data = ctx.accounts.bet_public_inputs.try_borrow_mut_data()?;
        require!(
            data.len() >= bet_staging::BET_INPUTS_ACCOUNT_SIZE,
            ErrorCode::InvalidPublicInputs
        );
        data[0..8].copy_from_slice(&BetPublicInputs::DISCRIMINATOR);
        bet_staging::init_header(
            &mut data,
            &ctx.accounts.game_state.game_id,
            ctx.accounts.game_state.generation,
            ctx.accounts.player_state.player_index,
        )?;
        bet_staging::init_prepared_accumulator(&mut data, &vk.vk.vk_ic[0])
    }

    pub fn write_bet_public_inputs(
        ctx: Context<WriteBetPublicInputs>,
        offset: u16,
        data: Vec<u8>,
    ) -> Result<()> {
        let expected = ctx
            .accounts
            .game_state
            .config()?
            .n_public_bet()
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut account_data = ctx.accounts.bet_public_inputs.try_borrow_mut_data()?;
        bet_staging::write_inputs_chunk(&mut account_data, offset, &data, expected)
    }

    pub fn prepare_bet_chunk(ctx: Context<PrepareBetChunk>, start: u16) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        let expected = config
            .n_public_bet()
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let vk = lookup_vk(&config.shared(), VkPhase::Bet)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut data = ctx.accounts.bet_public_inputs.try_borrow_mut_data()?;
        require!(
            bet_staging::fill_complete(&data, expected)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            bet_staging::read_prepared_count(&data)? == 0,
            ErrorCode::InvalidPublicInputs
        );
        let start_usize = start as usize;
        require!(
            start_usize % bet_staging::PREPARE_INPUTS_PER_TX as usize == 0
                && start_usize < expected,
            ErrorCode::InvalidPublicInputs
        );
        let end = (start_usize + bet_staging::PREPARE_INPUTS_PER_TX as usize).min(expected);
        let inputs = bet_staging::public_inputs_slice(&data, expected)?;
        let mut partial = [0u8; 64];
        for index in start_usize..end {
            g1_mul_add(&mut partial, &vk.vk.vk_ic[index + 1], &inputs[index])?;
        }
        bet_staging::write_prepare_chunk(&mut data, start, expected, &partial)
    }

    /// Verify staged split-game bet proof and record `RouletteBetCommitment`.
    /// Remaining accounts: player PDAs in seat order (for HashPublicKeys(2)).
    ///
    /// Roulette / craps / keno: every seat (including the house) must already
    /// be registered (phase is Shuffle or Share). Betting closes at Evaluation,
    /// before Arcis reveal / showdown.
    pub fn verify_bet<'info>(
        mut ctx: Context<VerifyBet>,
        proof: UncompressedProof,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Shuffle as u8
                || game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );
        let config = game_state.config()?;
        let expected = config
            .n_public_bet()
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let prover_limbs = shared_zk_ids::bet_prover_limbs(&config.shared())
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let max_n = shared_zk_ids::bet_max_n_actual(&config.shared())
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let vk = lookup_vk(&config.shared(), VkPhase::Bet)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let player_index = ctx.accounts.player_state.player_index;
        require!(
            player_index != game_state.dealer_index,
            ErrorCode::DealerMustHaveZeroBets
        );
        let (prepared, bet_hash, input_hash) = {
            let data = ctx.accounts.bet_public_inputs.try_borrow_data()?;
            require!(
                bet_staging::fill_complete(&data, expected)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                bet_staging::prepare_complete(&data, expected)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                bet_staging::read_prepared_count(&data)? == 0,
                ErrorCode::InvalidPublicInputs
            );
            let mut prepared = *bet_staging::prepared_g1_ref(&data)?;
            let n_chunks = bet_staging::prepare_chunk_count(expected)?;
            for chunk_id in 0..n_chunks {
                let partial = *bet_staging::partial_g1_ref(&data, chunk_id)?;
                g1_add(&mut prepared, &partial)?;
            }
            let inputs = bet_staging::public_inputs_slice(&data, expected)?;
            require!(
                inputs.len() == expected && expected > prover_limbs,
                ErrorCode::InvalidPublicInputs
            );
            let bet_hash = crate::shuffle_hash::hash_flat_values_be(&inputs[0..prover_limbs])?;
            let input_hash = inputs[expected - 1];
            (prepared, bet_hash, input_hash)
        };
        verify_pairing_prepared(&proof, &prepared, vk.vk)?;

        let keys = crate::shuffle_hash::read_player_public_keys(
            &ctx.remaining_accounts,
            game_state.num_players,
            &game_state.game_id,
            &ctx.program_id,
        )?;
        require!(
            (player_index as usize) < keys.len(),
            ErrorCode::InvalidPlayerIndex
        );
        let dealer = game_state.dealer_index;
        require!(
            (dealer as usize) < keys.len(),
            ErrorCode::InvalidPlayerIndex
        );
        let house_keys = [
            keys[player_index as usize][0],
            keys[player_index as usize][1],
            keys[dealer as usize][0],
            keys[dealer as usize][1],
        ];
        let hk = crate::shuffle_hash::hash_public_keys_2(&house_keys)?;
        let mut n_actual = None;
        for n in 0..=max_n {
            let n_f = field_from_u128(n as u128);
            let h = crate::poseidon_hash::poseidon_fields_be(&[hk.as_slice(), n_f.as_slice()])?;
            if h == input_hash {
                n_actual = Some(n);
                break;
            }
        }
        let n_actual = n_actual.ok_or(error!(ErrorCode::InvalidPublicInputs))?;

        let bets = &mut ctx.accounts.roulette_bet_commitment;
        bets.game_id = game_state.game_id;
        bets.generation = game_state.generation;
        bets.player_index = player_index;
        bets.actual_bet_count = n_actual;
        bets.bet_hash = bet_hash;
        // Durable copy is the Light leaf written by `close_bet_public_inputs`.
        bets.light_stored = false;
        Ok(())
    }

    /// PvP bingo card commit (not a bet). Sealed only to the prover.
    /// Window: after all seats register, before the first share chunk is verified.
    /// Remaining accounts: player PDAs in seat order (prover key only is hashed).
    pub fn verify_card_commit<'info>(
        mut ctx: Context<VerifyBet>,
        proof: UncompressedProof,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.dealer_index == 255,
            ErrorCode::InvalidGameConfig
        );
        require!(
            game_state.phase == GamePhase::Shuffle as u8
                || game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );
        require!(game_state.shared_mask == 0, ErrorCode::InvalidGamePhase);
        let config = game_state.config()?;
        require!(
            config.kind() == shared_zk_ids::GameKind::Bingo,
            ErrorCode::InvalidGameConfig
        );
        let expected = config
            .n_public_bet()
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let prover_limbs = shared_zk_ids::bet_prover_limbs(&config.shared())
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let n_cells = prover_limbs / 4;
        let vk = lookup_vk(&config.shared(), VkPhase::Bet)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let player_index = ctx.accounts.player_state.player_index;
        let (prepared, card_hash, input_hash) = {
            let data = ctx.accounts.bet_public_inputs.try_borrow_data()?;
            require!(
                bet_staging::fill_complete(&data, expected)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                bet_staging::prepare_complete(&data, expected)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                bet_staging::read_prepared_count(&data)? == 0,
                ErrorCode::InvalidPublicInputs
            );
            let mut prepared = *bet_staging::prepared_g1_ref(&data)?;
            let n_chunks = bet_staging::prepare_chunk_count(expected)?;
            for chunk_id in 0..n_chunks {
                let partial = *bet_staging::partial_g1_ref(&data, chunk_id)?;
                g1_add(&mut prepared, &partial)?;
            }
            let inputs = bet_staging::public_inputs_slice(&data, expected)?;
            require!(
                inputs.len() == expected && expected > prover_limbs,
                ErrorCode::InvalidPublicInputs
            );
            let card_hash = crate::shuffle_hash::hash_flat_values_be(&inputs[0..prover_limbs])?;
            let input_hash = inputs[expected - 1];
            (prepared, card_hash, input_hash)
        };
        verify_pairing_prepared(&proof, &prepared, vk.vk)?;

        let keys = crate::shuffle_hash::read_player_public_keys(
            &ctx.remaining_accounts,
            game_state.num_players,
            &game_state.game_id,
            &ctx.program_id,
        )?;
        require!(
            (player_index as usize) < keys.len(),
            ErrorCode::InvalidPlayerIndex
        );
        let n_cells_f = field_from_u128(n_cells as u128);
        let expected_hash = crate::poseidon_hash::poseidon_fields_be(&[
            keys[player_index as usize][0].as_slice(),
            keys[player_index as usize][1].as_slice(),
            n_cells_f.as_slice(),
        ])?;
        require!(expected_hash == input_hash, ErrorCode::InvalidPublicInputs);

        let bets = &mut ctx.accounts.roulette_bet_commitment;
        bets.game_id = game_state.game_id;
        bets.generation = game_state.generation;
        bets.player_index = player_index;
        bets.actual_bet_count = 1;
        bets.bet_hash = card_hash;
        bets.light_stored = false;
        Ok(())
    }

    /// Store the verified bet hash as a Light compressed account and refund
    /// the `bet_inputs` staging PDA to the seat.
    ///
    /// Must run after [`verify_bet`] or [`verify_card_commit`] and before showdown.
    /// Testing builds with no Light remaining accounts skip the CPI, still mark
    /// the commitment stored, and still return the staging rent.
    pub fn close_bet_public_inputs<'info>(
        mut ctx: Context<CloseBetPublicInputs>,
        proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
    ) -> Result<()> {
        let player_index = ctx.accounts.player_state.player_index;
        let game_id = ctx.accounts.game_state.game_id;
        let generation = ctx.accounts.game_state.generation;
        let (bet_hash, actual_bet_count) = {
            let bets = &ctx.accounts.roulette_bet_commitment;
            require!(
                bets.game_id == game_id
                    && bets.player_index == player_index
                    && bets.generation == generation
                    && !bets.light_stored
                    && bets.bet_hash != [0u8; 32],
                ErrorCode::InvalidPublicInputs
            );
            (bets.bet_hash, bets.actual_bet_count)
        };

        let (staged_vault, light_remaining) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
        let skip_light = light_remaining.is_empty();
        #[cfg(not(feature = "testing"))]
        {
            require!(!skip_light, ErrorCode::AccountNotEnoughKeys);
        }
        if !skip_light {
            create_light_account::<BetCommitmentCompressedAccount, _>(
                ctx.accounts.signer.as_ref(),
                light_remaining,
                proof,
                address_tree_info,
                output_merkle_tree_index,
                &[b"bet_commit", game_id.as_ref(), &[player_index]],
                |leaf| {
                    leaf.bet_hash = bet_hash;
                    leaf.game_id = Pubkey::new_from_array(game_id);
                    leaf.player_index = player_index;
                    leaf.actual_bet_count = actual_bet_count;
                    leaf.kind = shared_zk_ids::LIGHT_KIND_BET_COMMIT;
                },
            )?;
        } else {
            let _ = (proof, address_tree_info, output_merkle_tree_index);
        }

        ctx.accounts.roulette_bet_commitment.light_stored = true;

        let staging = ctx.accounts.bet_public_inputs.to_account_info();
        let signer = ctx.accounts.signer.to_account_info();
        let dest = match staged_vault {
            Some(vault) => {
                rent_vault::require_vault_for_player(&vault, &signer.key())?;
                vault
            }
            None => signer,
        };
        rent_vault::refund_staging(&staging, &dest)?;
        Ok(())
    }

    /// Allocate roulette share staging PDA (≤10 KiB). Call `extend_share_public_inputs`
    /// until full size, then `create_share_public_inputs` to write the header.
    pub fn allocate_share_public_inputs(ctx: Context<AllocateSharePublicInputs>) -> Result<()> {
        let _ = &ctx.accounts.share_public_inputs;
        Ok(())
    }

    /// Grow roulette share staging PDA by up to 10 KiB toward full size.
    pub fn extend_share_public_inputs(ctx: Context<ExtendSharePublicInputs>) -> Result<()> {
        require!(
            ctx.accounts.game_state.config()?.is_roulette(),
            ErrorCode::InvalidGameConfig
        );
        grow_account(
            &ctx.accounts.share_public_inputs.to_account_info(),
            &ctx.accounts.signer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            share_staging::SHARE_STAGING_ACCOUNT_SIZE,
        )
    }

    /// Write header into a fully allocated roulette share staging PDA (nPublic=579).
    pub fn create_share_public_inputs(ctx: Context<CreateSharePublicInputs>) -> Result<()> {
        let len = ctx.accounts.share_public_inputs.data_len();
        require!(
            len >= share_staging::SHARE_STAGING_ACCOUNT_SIZE,
            ErrorCode::InvalidPublicInputs
        );
        let config = ctx.accounts.game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut data = ctx.accounts.share_public_inputs.try_borrow_mut_data()?;
        data[0..8].copy_from_slice(&SharePublicInputs::DISCRIMINATOR);
        share_staging::init_header(
            &mut data,
            &ctx.accounts.game_state.game_id,
            ctx.accounts.game_state.generation,
            ctx.accounts.player_state.player_index,
        )?;
        share_staging::init_prepared_accumulator(&mut data, &vk.vk.vk_ic[0])
    }

    pub fn write_share_public_inputs(
        ctx: Context<WriteSharePublicInputs>,
        offset: u16,
        data: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.game_state.config()?.is_roulette(),
            ErrorCode::InvalidGameConfig
        );
        let mut account_data = ctx.accounts.share_public_inputs.try_borrow_mut_data()?;
        share_staging::write_inputs_chunk(&mut account_data, offset, &data)
    }

    /// Legacy sequential MSM fold into `prepared_g1`. Prefer
    /// [`prepare_share_chunk`] + [`finalize_prepare_share_inputs`].
    ///
    /// Incompatible with the parallel path once any prepare chunk has landed
    /// (`prepare_started`).
    pub fn prepare_share_inputs(ctx: Context<PrepareShareInputs>) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        let expected = config.n_public_share();
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let mut data = ctx.accounts.share_public_inputs.try_borrow_mut_data()?;
        require!(
            share_staging::fill_complete(&data)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            !share_staging::prepare_started(&data)?,
            ErrorCode::InvalidStagingWrite
        );
        let prepared_count = share_staging::read_prepared_count(&data)? as usize;
        require!(prepared_count < expected, ErrorCode::InvalidPublicInputs);
        let mut prepared = *share_staging::prepared_g1_ref(&data)?;
        let remaining = expected - prepared_count;
        let count = remaining.min(share_staging::PREPARE_INPUTS_PER_TX as usize);
        let inputs = share_staging::public_inputs_slice(&data)?;
        for index in prepared_count..prepared_count + count {
            g1_mul_add(
                &mut prepared,
                &vk.vk.vk_ic[index + 1],
                &inputs[index],
            )?;
        }
        share_staging::write_prepared_count(&mut data, (prepared_count + count) as u16)?;
        share_staging::prepared_g1_mut(&mut data)?.copy_from_slice(&prepared);
        Ok(())
    }

    /// Fold one disjoint MSM slice of staged share publics into a partial G1.
    ///
    /// `start` must be a multiple of [`share_staging::PREPARE_INPUTS_PER_TX`].
    /// Chunks may land in any order.
    pub fn prepare_share_chunk(ctx: Context<PrepareShareChunk>, start: u16) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        let expected = config.n_public_share();
        require!(
            expected == share_staging::SHARE_STAGING_PUBLIC_INPUTS,
            ErrorCode::InvalidGameConfig
        );
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;

        let mut data = ctx.accounts.share_public_inputs.try_borrow_mut_data()?;
        require!(
            share_staging::fill_complete(&data)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            share_staging::read_prepared_count(&data)? == 0,
            ErrorCode::InvalidPublicInputs
        );

        let start_usize = start as usize;
        require!(
            start_usize % share_staging::PREPARE_INPUTS_PER_TX as usize == 0
                && start_usize < expected,
            ErrorCode::InvalidPublicInputs
        );
        let end = (start_usize + share_staging::PREPARE_INPUTS_PER_TX as usize).min(expected);
        let inputs = share_staging::public_inputs_slice(&data)?;

        let mut partial = [0u8; 64];
        for index in start_usize..end {
            g1_mul_add(
                &mut partial,
                &vk.vk.vk_ic[index + 1],
                &inputs[index],
            )?;
        }
        share_staging::write_prepare_chunk(&mut data, start, &partial)
    }

    /// Sum MSM partials into `prepared_g1` and mark prepare complete.
    pub fn finalize_prepare_share_inputs(ctx: Context<FinalizePrepareShareInputs>) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        let expected = config.n_public_share();
        require!(
            expected == share_staging::SHARE_STAGING_PUBLIC_INPUTS,
            ErrorCode::InvalidGameConfig
        );

        let mut data = ctx.accounts.share_public_inputs.try_borrow_mut_data()?;
        require!(
            share_staging::fill_complete(&data)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            share_staging::prepare_complete(&data)?,
            ErrorCode::InvalidPublicInputs
        );
        require!(
            share_staging::read_prepared_count(&data)? == 0,
            ErrorCode::InvalidPublicInputs
        );

        // prepared = vk_ic[0] + Σ partial_g1[k]
        let mut prepared = *share_staging::prepared_g1_ref(&data)?;
        let n_chunks = share_staging::prepare_chunk_count();
        for chunk_id in 0..n_chunks {
            let partial = *share_staging::partial_g1_ref(&data, chunk_id)?;
            g1_add(&mut prepared, &partial)?;
        }
        share_staging::prepared_g1_mut(&mut data)?.copy_from_slice(&prepared);
        share_staging::write_prepared_count(&mut data, expected as u16)?;
        Ok(())
    }

    /// Verify roulette share with staged nPublic=579 inputs.
    ///
    /// Same Arcis binding as [`verify_share`]: `share_verify_acc` must be frozen
    /// and `verify_expected` must equal Groth16 `outHash`. Dealer shares must
    /// have `actualBetCount == 0`. Records bet commitment for Light persistence
    /// (see [`store_roulette_bets`]); staging stays open until bets are stored.
    pub fn verify_share_staged(mut ctx: Context<VerifyShareStaged>, proof: UncompressedProof) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );
        let config = game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        let expected = config.n_public_share();
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let player_index = ctx.accounts.player_state.player_index;

        // Arcis share-hash binding (card Rescue limbs) — same gate as verify_share.
        let acc = validate_share_verify_acc(
            &ctx.accounts.share_verify_acc.to_account_info(),
            &game_state.game_id,
            player_index,
        )?;

        let (output_hash_bytes, prepared_g1, actual_bets, bet_hash) = {
            let staged = ctx.accounts.share_public_inputs.try_borrow_data()?;
            require!(
                share_staging::fill_complete(&staged)?,
                ErrorCode::InvalidPublicInputs
            );
            require!(
                share_staging::read_prepared_count(&staged)? as usize == expected,
                ErrorCode::InvalidPublicInputs
            );
            let out = share_staging::output_hash(&staged)?;
            let count = share_staging::actual_bet_count(&staged)?;
            let hash = share_staging::bet_commitment_hash(&staged)?;
            (out, *share_staging::prepared_g1_ref(&staged)?, count, hash)
        };

        let mut output_hash_le = output_hash_bytes;
        output_hash_le.reverse();
        require!(
            acc.generation == ctx.accounts.proof_receipt.generation
                && acc.verify_expected == output_hash_le,
            ErrorCode::InvalidPublicInputs
        );
        // Receipt PDA is keyed by Arcis mpc generation (not light game_state.generation).
        let mpc_generation = acc.generation;
        let (expected_receipt, _) = Pubkey::find_program_address(
            &[
                PROOF_RECEIPT_V2_SEED,
                &game_state.game_id,
                &mpc_generation.to_le_bytes(),
                &[PROOF_PHASE_SHARE],
                &[player_index],
            ],
            &ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.proof_receipt.key(),
            expected_receipt,
            ErrorCode::InvalidPublicInputs
        );

        // Legacy fused share still carries encrypted bets. House must not
        // embed a real wager; prefer split `verify_bet` (players only).
        if player_index == game_state.dealer_index {
            require!(actual_bets == 0, ErrorCode::DealerMustHaveZeroBets);
        }

        verify_pairing_prepared(&proof, &prepared_g1, vk.vk)?;

        let bets = &mut ctx.accounts.roulette_bet_commitment;
        bets.game_id = game_state.game_id;
        // Bind to light game round — showdown receipts / materials use
        // `game_state.generation`, not the Arcis share-verify mpc generation.
        bets.generation = game_state.generation;
        bets.player_index = player_index;
        bets.actual_bet_count = actual_bets;
        bets.bet_hash = bet_hash;
        bets.light_stored = false;

        mark_player_shared(game_state, player_index)?;

        let receipt = &mut ctx.accounts.proof_receipt;
        require!(
            receipt.status == RECEIPT_STATUS_INITIALIZED && receipt.output_hash == [0u8; 32],
            ErrorCode::InvalidPublicInputs
        );
        receipt.status = RECEIPT_STATUS_VERIFIED;
        receipt.output_hash = output_hash_bytes;

        cpi_bridge::maybe_consume_proof(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &mut ctx.accounts.proof_receipt,
            Some(&ctx.accounts.share_verify_acc),
        )?;

        Ok(())
    }

    /// Persist roulette encrypted bet limbs into Light compressed artifact chunks
    /// (`LIGHT_KIND_ROULETTE_BETS`). Must run after [`verify_share_staged`] while
    /// share staging still holds the 576 bet fields. Closes staging when done.
    pub fn store_roulette_bets<'info>(
        mut ctx: Context<StoreRouletteBets>,
        proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8,
        chunk_index: u16,
        start_index: u16,
        count: u8,
        commitment_0: [u8; 32],
        commitment_1: [u8; 32],
        commitment_2: [u8; 32],
        commitment_3: [u8; 32],
        commitment_4: [u8; 32],
        commitment_5: [u8; 32],
        commitment_6: [u8; 32],
        commitment_7: [u8; 32],
    ) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(config.is_roulette(), ErrorCode::InvalidGameConfig);
        require!(count >= 1 && count <= 8, ErrorCode::InvalidChunkCount);
        let bets = &mut ctx.accounts.roulette_bet_commitment;
        require!(
            bets.game_id == ctx.accounts.game_state.game_id
                && bets.player_index == ctx.accounts.player_state.player_index
                && !bets.light_stored,
            ErrorCode::InvalidPublicInputs
        );

        // Bind chunk commitments to staged limbs (first limb of each commitment slot).
        {
            let staged = ctx.accounts.share_public_inputs.try_borrow_data()?;
            let limbs = share_staging::encrypted_bet_limbs(&staged)?;
            let start = start_index as usize;
            require!(
                start + count as usize <= limbs.len(),
                ErrorCode::InvalidPublicInputs
            );
            let provided = [
                commitment_0, commitment_1, commitment_2, commitment_3,
                commitment_4, commitment_5, commitment_6, commitment_7,
            ];
            for i in 0..count as usize {
                require!(
                    provided[i] == limbs[start + i],
                    ErrorCode::InvalidPublicInputs
                );
            }
        }

        let kind = shared_zk_ids::LIGHT_KIND_ROULETTE_BETS;
        let owner = ctx.accounts.player_state.player_index;
        let chunk_bytes = chunk_index.to_le_bytes();
        let game_id = ctx.accounts.game_state.game_id;
        create_light_account::<ArtifactChunkCompressedAccount, _>(
            ctx.accounts.signer.as_ref(),
            &ctx.remaining_accounts,
            proof,
            address_tree_info,
            output_merkle_tree_index,
            &[
                b"artifact",
                game_id.as_ref(),
                &[kind],
                &[owner],
                chunk_bytes.as_ref(),
            ],
            |chunk| {
                chunk.game_id = Pubkey::new_from_array(game_id);
                chunk.chunk_index = chunk_index;
                chunk.start_index = start_index;
                chunk.count = count;
                chunk.commitment_0 = commitment_0;
                chunk.commitment_1 = commitment_1;
                chunk.commitment_2 = commitment_2;
                chunk.commitment_3 = commitment_3;
                chunk.commitment_4 = commitment_4;
                chunk.commitment_5 = commitment_5;
                chunk.commitment_6 = commitment_6;
                chunk.commitment_7 = commitment_7;
            },
        )?;

        // Final chunk covers the last limb → mark stored and reclaim staging.
        let end = start_index as usize + count as usize;
        if end >= shared_zk_ids::ROULETTE_BET_LIMBS {
            bets.light_stored = true;
            let staging = ctx.accounts.share_public_inputs.to_account_info();
            let signer = ctx.accounts.signer.to_account_info();
            let rent = staging.lamports();
            *signer.try_borrow_mut_lamports()? = signer
                .lamports()
                .checked_add(rent)
                .ok_or(ErrorCode::InvalidPublicInputs)?;
            *staging.try_borrow_mut_lamports()? = 0;
            staging.assign(&SYSTEM_PROGRAM_ID);
            staging.realloc(0, false)?;
        }
        let _ = (kind, owner);
        Ok(())
    }

    /// Allocate the shuffle receipt separately so the proof + Light validity
    /// proof transaction does not exceed Solana's packet-size limit.
    pub fn init_shuffle_receipt(mut ctx: Context<InitShuffleReceipt>) -> Result<()> {
        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = ctx.accounts.game_state.game_id;
        receipt.generation = ctx.accounts.game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_SHUFFLE;
        receipt.player_index = ctx.accounts.player_state.player_index;
        receipt.output_hash = [0u8; 32];
        receipt.status = RECEIPT_STATUS_INITIALIZED;
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            ctx.accounts.proof_receipt.to_account_info().lamports(),
        )?;
        Ok(())
    }

    /// Allocate the share receipt before the hash-heavy Groth16 transaction.
    pub fn init_share_receipt(mut ctx: Context<InitShareReceipt>, mpc_generation: u64) -> Result<()> {
        let acc = validate_share_verify_acc(
            &ctx.accounts.share_verify_acc.to_account_info(),
            &ctx.accounts.game_state.game_id,
            ctx.accounts.player_state.player_index,
        )?;
        require!(
            acc.generation == mpc_generation && acc.generation > 0,
            ErrorCode::InvalidPublicInputs
        );
        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = ctx.accounts.game_state.game_id;
        receipt.generation = mpc_generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_SHARE;
        receipt.player_index = ctx.accounts.player_state.player_index;
        receipt.output_hash = [0u8; 32];
        receipt.status = RECEIPT_STATUS_INITIALIZED;
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            ctx.accounts.proof_receipt.to_account_info().lamports(),
        )?;
        Ok(())
    }

    // ─── Game Lifecycle: Showdown ───

    /// Allocate the showdown proof receipt separately so the hash-heavy verify
    /// transaction does not also carry Anchor's account-init heap overhead.
    pub fn init_showdown_receipt(mut ctx: Context<InitShowdownReceipt>) -> Result<()> {
        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = ctx.accounts.game_state.game_id;
        receipt.generation = ctx.accounts.game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_SHOWDOWN;
        receipt.player_index = ctx.accounts.player_state.player_index;
        receipt.output_hash = [0u8; 32];
        receipt.status = RECEIPT_STATUS_INITIALIZED;
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            ctx.accounts.proof_receipt.to_account_info().lamports(),
        )?;
        Ok(())
    }

    /// Allocate staged bingo showdown row hashes. Each `HashCiphertexts(nMax)`
    /// row is too large for the verify transaction's compute budget.
    pub fn init_bingo_showdown_rows(mut ctx: Context<InitBingoShowdownRows>) -> Result<()> {
        let rows = &mut ctx.accounts.bingo_showdown_rows;
        rows.game_id = ctx.accounts.game_state.game_id;
        rows.generation = ctx.accounts.game_state.generation;
        rows.player_index = ctx.accounts.player_state.player_index;
        rows.filled = 0;
        rows.row_hashes = [[0u8; 32]; 12];
        Ok(())
    }

    /// Hash one bingo showdown ciphertext row (0 = called balls, 1..11 = partials).
    pub fn hash_bingo_showdown_row<'info>(
        mut ctx: Context<HashBingoShowdownRow>,
        row_index: u8,
    ) -> Result<()> {
        require!(row_index < 12, ErrorCode::InvalidPublicInputs);
        let material_info = ctx.accounts.showdown_material.to_account_info();
        require_keys_eq!(
            material_info.owner(),
            casino_cpi::casino_program_id(),
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let player_index = ctx.accounts.player_state.player_index;
        let generation = ctx.accounts.game_state.generation;
        let (expected_material, _) = Pubkey::find_program_address(
            &[
                b"showdown_material",
                &ctx.accounts.game_state.game_id,
                &generation.to_le_bytes(),
                &[player_index],
            ],
            &casino_cpi::casino_program_id(),
        );
        require_keys_eq!(
            material_info.key(),
            expected_material,
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let material_data = material_info.try_borrow_data()?;
        let material = parse_showdown_material(&material_data)?;
        require!(material.complete, ErrorCode::ShowdownMaterialsNotVerified);
        let config = ctx.accounts.game_state.config()?;
        require!(
            config.kind() == shared_zk_ids::GameKind::Bingo,
            ErrorCode::InvalidGameConfig
        );
        let n_called = shared_zk_ids::bingo_called_balls(ctx.accounts.game_state.n_share_chunks) as u64;
        let n_max = config.roulette_variant() as usize;
        let hash = games::bingo::hash_showdown_row(
            &ctx.accounts.deck_state.to_account_info(),
            &ctx.remaining_accounts,
            &material,
            &ctx.accounts.game_state.game_id,
            generation,
            ctx.accounts.game_state.num_players,
            n_called,
            n_max,
            &ctx.program_id,
            row_index,
        )?;
        let rows = &mut ctx.accounts.bingo_showdown_rows;
        require!(
            rows.game_id == ctx.accounts.game_state.game_id
                && rows.generation == generation
                && rows.player_index == player_index,
            ErrorCode::InvalidPublicInputs
        );
        rows.row_hashes[row_index as usize] = hash;
        rows.filled |= 1u16 << row_index;
        Ok(())
    }

    /// Allocate staged keno share-row hashes. The rent vault reimburses the seat.
    pub fn init_keno_showdown_rows(mut ctx: Context<InitKenoShowdownRows>) -> Result<()> {
        let rent = ctx.accounts.keno_showdown_rows.to_account_info().lamports();
        let game_id = ctx.accounts.game_state.game_id;
        let generation = ctx.accounts.game_state.generation;
        let player_index = ctx.accounts.player_state.player_index;
        {
            let rows = &mut ctx.accounts.keno_showdown_rows;
            rows.game_id = game_id;
            rows.generation = generation;
            rows.player_index = player_index;
            rows.filled = 0;
            rows.row_hashes = [[0u8; 32]; games::keno::SHOWDOWN_ROW_COUNT];
        }
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            rent,
        )?;
        Ok(())
    }

    /// Hash one keno share row. A padding row fills every empty slot at once.
    pub fn hash_keno_showdown_row<'info>(
        mut ctx: Context<HashKenoShowdownRow>,
        row_index: u8,
    ) -> Result<()> {
        require!(
            (row_index as usize) < games::keno::SHOWDOWN_ROW_COUNT,
            ErrorCode::InvalidPublicInputs
        );
        let material_info = ctx.accounts.showdown_material.to_account_info();
        require_keys_eq!(
            material_info.owner(),
            casino_cpi::casino_program_id(),
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let player_index = ctx.accounts.player_state.player_index;
        let generation = ctx.accounts.game_state.generation;
        let (expected_material, _) = Pubkey::find_program_address(
            &[
                b"showdown_material",
                &ctx.accounts.game_state.game_id,
                &generation.to_le_bytes(),
                &[player_index],
            ],
            &casino_cpi::casino_program_id(),
        );
        require_keys_eq!(
            material_info.key(),
            expected_material,
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let material_data = material_info.try_borrow_data()?;
        let material = parse_showdown_material(&material_data)?;
        require!(
            material.complete && material.recipient_index == player_index,
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let config = ctx.accounts.game_state.config()?;
        require!(
            config.kind() == shared_zk_ids::GameKind::Keno,
            ErrorCode::InvalidGameConfig
        );
        let hash = games::keno::hash_showdown_row(
            &ctx.accounts.player_state.to_account_info(),
            &ctx.remaining_accounts,
            &material,
            &ctx.accounts.game_state.game_id,
            ctx.accounts.game_state.num_players,
            &ctx.program_id,
            row_index,
        )?;
        let n_seated = ctx.accounts.game_state.num_players as usize;
        let recipient = material.recipient_index as usize;
        let sharer = showdown_hash::sharer_for_row(12, recipient, row_index as usize)?;
        let rows = &mut ctx.accounts.keno_showdown_rows;
        require!(
            rows.game_id == ctx.accounts.game_state.game_id
                && rows.generation == generation
                && rows.player_index == player_index,
            ErrorCode::InvalidPublicInputs
        );
        if sharer < n_seated {
            rows.row_hashes[row_index as usize] = hash;
            rows.filled |= 1u16 << row_index;
        } else {
            for row in 0..games::keno::SHOWDOWN_ROW_COUNT {
                let slot = showdown_hash::sharer_for_row(12, recipient, row)?;
                if slot >= n_seated {
                    rows.row_hashes[row] = hash;
                    rows.filled |= 1u16 << row;
                }
            }
        }
        Ok(())
    }

    /// Verify showdown Groth16 proof against the on-chain Poseidon input hash.
    /// Does not advance phase or CPI-consume — call `finalize_showdown` next.
    ///
    /// Remaining accounts are canonical Light player PDAs followed by
    /// recipient-major, card-index ordered poker `RevealedCard` PDAs. They
    /// contain Arcis-resealed ciphertext limbs, which Light hashes with the
    /// Circom Poseidon layout; Arcis is not a showdown-row hash oracle.
    pub fn verify_showdown_receipt<'info>(
        mut ctx: Context<VerifyShowdownReceipt>,
        hand_index: u8,
        proof: UncompressedProof,
        output_hash: [u8; 32],
    ) -> Result<()> {
        let material_info = ctx.accounts.showdown_material.to_account_info();
        require_keys_eq!(
            material_info.owner(),
            casino_cpi::casino_program_id(),
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let generation = ctx.accounts.proof_receipt.generation;
        let player_index = ctx.accounts.player_state.player_index;
        let (expected_material, _) = Pubkey::find_program_address(
            &[
                b"showdown_material",
                &ctx.accounts.game_state.game_id,
                &generation.to_le_bytes(),
                &[player_index],
            ],
            &casino_cpi::casino_program_id(),
        );
        require_keys_eq!(
            material_info.key(),
            expected_material,
            ErrorCode::ShowdownMaterialsNotVerified
        );
        let material_data = material_info.try_borrow_data()?;
        let material = parse_showdown_material(&material_data)?;
        require!(material.complete, ErrorCode::ShowdownMaterialsNotVerified);
        let sealed_info = ctx.accounts.sealed_showdown_coefficients.to_account_info();
        require_keys_eq!(
            sealed_info.owner(),
            casino_cpi::casino_program_id(),
            ErrorCode::ShowdownCoefficientCommitmentMissing
        );
        let (expected_sealed, _) = Pubkey::find_program_address(
            &[
                b"sealed_showdown_coeffs",
                ctx.accounts.player_state.authority.as_ref(),
            ],
            &casino_cpi::casino_program_id(),
        );
        require_keys_eq!(
            sealed_info.key(),
            expected_sealed,
            ErrorCode::ShowdownCoefficientCommitmentMissing
        );
        let sealed_data = sealed_info.try_borrow_data()?;
        let coefficient_commitment = parse_coefficient_commitment(&sealed_data)?;
        let config = ctx.accounts.game_state.config()?;
        let vk = lookup_vk(&config.shared(), VkPhase::Showdown)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let derived = if config.is_roulette()
            || config.kind() == shared_zk_ids::GameKind::Craps
            || config.kind() == shared_zk_ids::GameKind::Keno
            || config.kind() == shared_zk_ids::GameKind::Slots
            || config.kind() == shared_zk_ids::GameKind::Bingo
        {
            let bets = ctx
                .accounts
                .roulette_bet_commitment
                .as_ref()
                .ok_or(error!(ErrorCode::RouletteBetsNotStored))?;
            require!(
                bets.game_id == ctx.accounts.game_state.game_id
                    && bets.player_index == player_index
                    && bets.generation == ctx.accounts.game_state.generation
                    && bets.light_stored,
                ErrorCode::RouletteBetsNotStored
            );
            match config.kind() {
                shared_zk_ids::GameKind::Roulette => games::roulette::showdown_input_hash(
                    &ctx.accounts.deck_state.to_account_info(),
                    &ctx.remaining_accounts,
                    &material,
                    &ctx.accounts.game_state.game_id,
                    generation,
                    ctx.accounts.game_state.num_players,
                    &bets.bet_hash,
                    bets.actual_bet_count,
                    &ctx.program_id,
                    &coefficient_commitment,
                )?,
                shared_zk_ids::GameKind::Craps => games::craps::showdown_input_hash(
                    &ctx.accounts.deck_state.to_account_info(),
                    &ctx.remaining_accounts,
                    &material,
                    &ctx.accounts.game_state.game_id,
                    generation,
                    ctx.accounts.game_state.num_players,
                    &bets.bet_hash,
                    bets.actual_bet_count,
                    0,
                    0,
                    &ctx.program_id,
                    &coefficient_commitment,
                )?,
                shared_zk_ids::GameKind::Keno => {
                    let rows = ctx
                        .accounts
                        .keno_showdown_rows
                        .as_ref()
                        .ok_or(error!(ErrorCode::InvalidPublicInputs))?;
                    require!(
                        rows.game_id == ctx.accounts.game_state.game_id
                            && rows.player_index == player_index
                            && rows.generation == generation
                            && rows.filled == games::keno::SHOWDOWN_ROWS_FILLED,
                        ErrorCode::InvalidPublicInputs
                    );
                    let (_, players) = rent_vault::split_leading_vault(&ctx.remaining_accounts);
                    let staged = rows.row_hashes;
                    games::keno::showdown_input_hash_from_rows(
                        &ctx.accounts.deck_state.to_account_info(),
                        players,
                        &material,
                        &ctx.accounts.game_state.game_id,
                        generation,
                        ctx.accounts.game_state.num_players,
                        &bets.bet_hash,
                        bets.actual_bet_count,
                        &staged,
                        &ctx.program_id,
                        &coefficient_commitment,
                    )?
                }
                shared_zk_ids::GameKind::Slots => games::slots::showdown_input_hash(
                    &ctx.accounts.deck_state.to_account_info(),
                    &ctx.remaining_accounts,
                    &material,
                    &ctx.accounts.game_state.game_id,
                    generation,
                    ctx.accounts.game_state.num_players,
                    &bets.bet_hash,
                    config.roulette_variant() as usize,
                    &ctx.program_id,
                    &coefficient_commitment,
                )?,
                shared_zk_ids::GameKind::Bingo => {
                    let rows = ctx
                        .accounts
                        .bingo_showdown_rows
                        .as_ref()
                        .ok_or(error!(ErrorCode::InvalidPublicInputs))?;
                    require!(
                        rows.game_id == ctx.accounts.game_state.game_id
                            && rows.player_index == player_index
                            && rows.generation == generation
                            && rows.filled == 0x0FFF,
                        ErrorCode::InvalidPublicInputs
                    );
                    let n_called = shared_zk_ids::bingo_called_balls(
                        ctx.accounts.game_state.n_share_chunks,
                    ) as u64;
                    let n_max = config.roulette_variant() as usize;
                    let pattern = if n_max == 75 {
                        Some(ctx.accounts.game_state.pattern_id as u64)
                    } else {
                        None
                    };
                    games::bingo::showdown_hash_from_rows(
                        &ctx.remaining_accounts,
                        &material,
                        &ctx.accounts.game_state.game_id,
                        ctx.accounts.game_state.num_players,
                        &bets.bet_hash,
                        pattern,
                        n_called,
                        &rows.row_hashes,
                        &ctx.program_id,
                        &coefficient_commitment,
                    )?
                }
                _ => return err!(ErrorCode::InvalidGameConfig),
            }
        } else if config.kind() == shared_zk_ids::GameKind::Blackjack {
            let layout = ctx
                .accounts
                .blackjack_showdown_layout
                .as_ref()
                .ok_or(error!(ErrorCode::BlackjackLayoutNotRecorded))?;
            require!(
                layout.game_id == ctx.accounts.game_state.game_id
                    && layout.player_index == player_index
                    && layout.hand_index == hand_index
                    && layout.generation == ctx.accounts.game_state.generation,
                ErrorCode::BlackjackLayoutNotRecorded
            );
            games::blackjack::showdown_input_hash_from_accounts(
                &ctx.accounts.deck_state.to_account_info(),
                &ctx.remaining_accounts,
                &material,
                &ctx.accounts.game_state.game_id,
                generation,
                ctx.accounts.game_state.num_players,
                ctx.accounts.game_state.pot_mask,
                &coefficient_commitment,
                &ctx.program_id,
                layout.player_card_count,
                layout.dealer_card_count,
                &layout.source_indices,
            )?
        } else {
            games::showdown_input_hash_from_accounts(
                config,
                &ctx.accounts.deck_state.to_account_info(),
                &ctx.remaining_accounts,
                &material,
                &ctx.accounts.game_state.game_id,
                generation,
                ctx.accounts.game_state.num_players,
                ctx.accounts.game_state.pot_mask,
                &coefficient_commitment,
                &ctx.program_id,
            )?
        };
        verify_groth16(&proof, &[output_hash, derived], vk.vk)?;
        {
            let receipt = &mut ctx.accounts.proof_receipt;
            require!(
                (receipt.status == RECEIPT_STATUS_INITIALIZED
                    || receipt.status == RECEIPT_STATUS_VERIFIED)
                    && receipt.phase == PROOF_PHASE_SHOWDOWN
                    && receipt.player_index == player_index
                    && (receipt.output_hash == [0u8; 32]
                        || receipt.status == RECEIPT_STATUS_VERIFIED),
                ErrorCode::InvalidPublicInputs
            );
            receipt.output_hash = output_hash;
            receipt.status = RECEIPT_STATUS_VERIFIED;
        }
        if config.kind() == shared_zk_ids::GameKind::Keno {
            if let Some(rows) = ctx.accounts.keno_showdown_rows.as_mut() {
                let info = rows.to_account_info();
                rows.exit(&crate::ID)?;
                rent_vault::close_to_leading(
                    &ctx.remaining_accounts,
                    &ctx.accounts.signer.to_account_info(),
                    &info,
                )?;
            }
        }
        Ok(())
    }

    /// Join showdown Groth16 receipt + Poseidon input hash, then CPI into poker.
    pub fn finalize_showdown(mut ctx: Context<FinalizeShowdown>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let player_index = ctx.accounts.player_state.player_index;
        require!(
            ctx.accounts.proof_receipt.phase == PROOF_PHASE_SHOWDOWN
                && ctx.accounts.proof_receipt.player_index == player_index
                && ctx.accounts.proof_receipt.status == RECEIPT_STATUS_VERIFIED
                && ctx.accounts.proof_receipt.output_hash != [0u8; 32],
            ErrorCode::InvalidPublicInputs
        );

        accept_showdown_submission(
            game_state,
            player_index,
            ctx.accounts.proof_receipt.output_hash,
            unix_now()?,
        )?;

        cpi_bridge::maybe_consume_proof(
            game_state.bridge_mode,
            &ctx.accounts.poker_program,
            &ctx.accounts.cpi_authority,
            ctx.bumps.cpi_authority,
            &ctx.accounts.poker_game_state,
            &mut ctx.accounts.proof_receipt,
            None,
        )?;
        close_consumed_receipt(
            &ctx.remaining_accounts,
            &ctx.accounts.signer,
            &mut ctx.accounts.proof_receipt,
        )?;
        Ok(())
    }

    /// Verify decrypt/compare hands proof.
    ///
    /// Uses `showdown_hashout_main` (2 public inputs).
    /// Verifier inputs are [caller output, locally derived transient commitment].
    ///
    /// Any seated player may submit; one proof completes the hand.
    /// Authenticated MPC materials are required before showdown verification.
    /// (Light remaining accounts are consumed by the CPI helper; pass hash accounts
    /// ahead of Light accounts by putting them in the typed context where possible.
    /// Here deck_state is typed; player + partials are in `remaining_accounts` before
    /// any Light accounts the client appends for the compressed-account CPI.)
    pub fn verify_showdown<'info>(
        _ctx: Context<VerifyShowdown>,
        _proof: UncompressedProof,
        _output_hash: [u8; 32],
        _light_proof: LightValidityProof,
        _account_meta: LightCompressedAccountMeta,
    ) -> Result<()> {
        err!(ErrorCode::ShowdownMaterialsNotVerified)
    }

    // ─── Game Lifecycle: Fold ───

    /// Fold a poker player.
    ///
    /// Equivalent to `verify_share` followed by clearing the player's
    /// `pot_mask` bit. Poker only — other games have no pot mask.
    pub fn fold<'info>(
        mut ctx: Context<VerifyShare>,
        proof: UncompressedProof,
        output_hash: [u8; 32],
    ) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let player_state = &ctx.accounts.player_state;
        let player_index = player_state.player_index;

        require!(
            game_state.phase == GamePhase::Share as u8,
            ErrorCode::InvalidGamePhase
        );

        let config = game_state.config()?;
        require!(
            config.kind() == shared_zk_ids::GameKind::Poker,
            ErrorCode::InvalidGameConfig
        );
        let vk = lookup_vk(&config.shared(), VkPhase::Share)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let derived = {
            let deck_data = ctx.accounts.deck_state.try_borrow_data()?;
            let deck = active_deck_bytes(&deck_data, config.deck_fields())?;
            games::share_input_hash_from_accounts(
                config,
                deck,
                &ctx.remaining_accounts,
                player_index,
                game_state.num_players,
                &game_state.game_id,
                &ctx.program_id,
            )?
        };
        let verifier_inputs = [output_hash, derived];
        verify_groth16(&proof, &verifier_inputs, vk.vk)?;

        mark_player_shared(game_state, player_index)?;

        // Remove player from pot
        game_state.pot_mask &= !(1u16 << player_index);

        Ok(())
    }

    /// Record the action-derived player/dealer card layout for blackjack showdown.
    /// Must run after hit/split/stay resolves a non-bust hand (bust skips showdown).
    pub fn record_blackjack_showdown_layout(
        mut ctx: Context<RecordBlackjackShowdownLayout>,
        hand_index: u8,
        player_card_count: u8,
        dealer_card_count: u8,
        source_indices: [u8; 24],
    ) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(
            matches!(config.kind(), shared_zk_ids::GameKind::Blackjack),
            ErrorCode::InvalidGameConfig
        );
        require!(
            player_card_count >= 2
                && player_card_count <= 11
                && dealer_card_count >= 2
                && dealer_card_count <= 13
                && (player_card_count as u16 + dealer_card_count as u16) <= 24,
            ErrorCode::BlackjackLayoutInvalid
        );
        let used = (player_card_count + dealer_card_count) as usize;
        for (i, &src) in source_indices.iter().enumerate() {
            if i < used {
                require!(src < 24, ErrorCode::BlackjackLayoutInvalid);
            }
        }
        let layout = &mut ctx.accounts.blackjack_showdown_layout;
        layout.game_id = ctx.accounts.game_state.game_id;
        layout.generation = ctx.accounts.game_state.generation;
        layout.player_index = ctx.accounts.player_state.player_index;
        layout.hand_index = hand_index;
        layout.player_card_count = player_card_count;
        layout.dealer_card_count = dealer_card_count;
        layout.source_indices = source_indices;
        Ok(())
    }

    pub fn record_blackjack_action_layout(
        mut ctx: Context<RecordBlackjackActionLayout>,
        action_seq: u16,
        h1: [u8; 32],
        h2: [u8; 32],
        card_count: u8,
        can_split: bool,
        hit_soft_17: bool,
        is_dealer: bool,
    ) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(
            matches!(config.kind(), shared_zk_ids::GameKind::Blackjack),
            ErrorCode::InvalidGameConfig
        );
        require!(
            card_count >= 2 && card_count <= 13,
            ErrorCode::BlackjackLayoutInvalid
        );
        require!(
            !(is_dealer && can_split) && !(!is_dealer && hit_soft_17),
            ErrorCode::BlackjackLayoutInvalid
        );
        let layout = &mut ctx.accounts.blackjack_action_layout;
        layout.game_id = ctx.accounts.game_state.game_id;
        layout.generation = ctx.accounts.game_state.generation;
        layout.player_index = ctx.accounts.player_state.player_index;
        layout.action_seq = action_seq;
        layout.h1 = h1;
        layout.h2 = h2;
        layout.card_count = card_count;
        layout.can_split = can_split;
        layout.hit_soft_17 = hit_soft_17;
        layout.is_dealer = is_dealer;
        layout.dealer_up_is_ace = false;
        Ok(())
    }

    /// Record an insurance / even-money decision.
    ///
    /// Allowed only while the hand is still in share/evaluation (pre-showdown),
    /// and only after the buyer and the dealer have each verified an action
    /// proof whose hashed `insuranceEligible` input is 1. That input is
    /// constrained to the dealer upcard being an Ace. Call once after those
    /// initial proofs and before further player actions.
    pub fn record_blackjack_insurance(
        mut ctx: Context<RecordBlackjackInsurance>,
        taken: bool,
        even_money: bool,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Share as u8
                || game_state.phase == GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        let config = game_state.config()?;
        require!(
            matches!(config.kind(), shared_zk_ids::GameKind::Blackjack),
            ErrorCode::InvalidGameConfig
        );
        // Initial player action must already be on-chain (seq 0, two cards, not dealer).
        let initial = &ctx.accounts.initial_action_layout;
        require!(
            initial.game_id == game_state.game_id
                && initial.generation == game_state.generation
                && initial.player_index == ctx.accounts.player_state.player_index
                && initial.action_seq == 0
                && initial.card_count == 2
                && !initial.is_dealer,
            ErrorCode::BlackjackInsuranceWindowClosed
        );
        let dealer_layout = &ctx.accounts.dealer_action_layout;
        require!(
            dealer_layout.game_id == game_state.game_id
                && dealer_layout.generation == game_state.generation
                && dealer_layout.player_index == game_state.dealer_index
                && dealer_layout.action_seq == 0
                && dealer_layout.is_dealer,
            ErrorCode::BlackjackInsuranceWindowClosed
        );
        require!(
            !(taken && even_money),
            ErrorCode::BlackjackLayoutInvalid
        );
        // Both the buyer and the dealer proved the upcard is an Ace.
        require!(
            initial.dealer_up_is_ace && dealer_layout.dealer_up_is_ace,
            ErrorCode::BlackjackInsuranceNotOffered
        );
        let ins = &mut ctx.accounts.blackjack_insurance;
        ins.game_id = game_state.game_id;
        ins.generation = game_state.generation;
        ins.player_index = ctx.accounts.player_state.player_index;
        ins.dealer_up_is_ace = true;
        ins.taken = taken;
        ins.even_money = even_money;
        Ok(())
    }

    /// Allocate blackjack action proof receipt.
    pub fn init_action_receipt(
        mut ctx: Context<InitActionReceipt>,
        _action_seq: u16,
    ) -> Result<()> {
        let config = ctx.accounts.game_state.config()?;
        require!(
            matches!(config.kind(), shared_zk_ids::GameKind::Blackjack),
            ErrorCode::InvalidGameConfig
        );
        let receipt = &mut ctx.accounts.proof_receipt;
        receipt.game_id = ctx.accounts.game_state.game_id;
        receipt.generation = ctx.accounts.game_state.generation;
        receipt.circuit_version = CIRCUIT_VERSION_V2;
        receipt.phase = PROOF_PHASE_ACTION;
        receipt.player_index = ctx.accounts.player_state.player_index;
        receipt.output_hash = [0u8; 32];
        receipt.status = RECEIPT_STATUS_INITIALIZED;
        reimburse_created(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            ctx.accounts.proof_receipt.to_account_info().lamports(),
        )?;
        Ok(())
    }

    /// Verify blackjack mid-hand action hashout proof.
    ///
    /// Public signals: `[output_hash, derived_input_hash]`.
    /// `insurance_eligible` is a hashed input, constrained to the dealer
    /// upcard being an Ace. It is not a separate public output.
    /// Dealer status 2 inside the polynomial is a natural blackjack.
    pub fn verify_action<'info>(
        mut ctx: Context<VerifyAction>,
        action_seq: u16,
        proof: UncompressedProof,
        output_hash: [u8; 32],
        insurance_eligible: bool,
        upcard_hash: [u8; 32],
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.phase == GamePhase::Share as u8
                || game_state.phase == GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        let config = game_state.config()?;
        let vk = lookup_vk(&config.shared(), VkPhase::Action)
            .ok_or(error!(ErrorCode::InvalidGameConfig))?;
        let player_index = ctx.accounts.player_state.player_index;
        let layout = &ctx.accounts.blackjack_action_layout;
        require!(
            layout.game_id == game_state.game_id
                && layout.generation == game_state.generation
                && layout.player_index == player_index
                && layout.action_seq == action_seq,
            ErrorCode::BlackjackLayoutNotRecorded
        );
        let sealed_info = ctx.accounts.sealed_showdown_coefficients.to_account_info();
        require_keys_eq!(
            sealed_info.owner(),
            casino_cpi::casino_program_id(),
            ErrorCode::ShowdownCoefficientCommitmentMissing
        );
        let (expected_sealed, _) = Pubkey::find_program_address(
            &[
                b"sealed_showdown_coeffs",
                ctx.accounts.player_state.authority.as_ref(),
            ],
            &casino_cpi::casino_program_id(),
        );
        require_keys_eq!(
            sealed_info.key(),
            expected_sealed,
            ErrorCode::ShowdownCoefficientCommitmentMissing
        );
        let sealed_data = sealed_info.try_borrow_data()?;
        let coefficient_commitment = parse_coefficient_commitment(&sealed_data)?;
        let derived = games::blackjack::action_input_hash(
            &layout.h1,
            &layout.h2,
            &upcard_hash,
            layout.card_count,
            layout.can_split,
            layout.hit_soft_17,
            layout.is_dealer,
            insurance_eligible,
            &coefficient_commitment,
        )?;
        verify_groth16(&proof, &[output_hash, derived], vk.vk)?;
        if !layout.is_dealer {
            if let Some(turn) = ctx.accounts.blackjack_turn.as_mut() {
                require!(
                    turn.game_id == game_state.game_id
                        && turn.generation == game_state.generation
                        && turn.player_index == player_index
                        && !turn.stood,
                    ErrorCode::BlackjackAlreadyStood
                );
                turn.window_opened_at = unix_now()?;
            }
        }
        ctx.accounts.blackjack_action_layout.dealer_up_is_ace = insurance_eligible;
        let receipt = &mut ctx.accounts.proof_receipt;
        require!(
            receipt.status == RECEIPT_STATUS_INITIALIZED
                && receipt.phase == PROOF_PHASE_ACTION
                && receipt.player_index == player_index
                && receipt.output_hash == [0u8; 32],
            ErrorCode::InvalidPublicInputs
        );
        receipt.output_hash = output_hash;
        receipt.status = RECEIPT_STATUS_VERIFIED;
        ctx.accounts.proof_receipt.exit(&crate::ID)?;
        rent_vault::close_to_leading(
            &ctx.remaining_accounts,
            &ctx.accounts.signer.to_account_info(),
            &ctx.accounts.proof_receipt.to_account_info(),
        )?;
        Ok(())
    }

    /// Mark the hand ready for a showdown proof. Idempotent.
    ///
    /// Share completion opens this window for every game except blackjack and
    /// bingo, which stay in evaluation while more chunks or actions land.
    /// Those two call this once the draw or the player decisions are finished.
    pub fn open_showdown_window(mut ctx: Context<OpenShowdownWindow>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let seat = &ctx.accounts.player_state;
        require!(
            seat.game_id == game_state.game_id
                && seat.player_index < game_state.num_players
                && seat.authority == ctx.accounts.signer.key(),
            ErrorCode::InvalidAuthority
        );
        open_showdown_window_at(game_state, unix_now()?)
    }

    /// Start the three-minute clock on a blackjack seat that still has to act.
    ///
    /// The seat or the house dealer may open it. A later player action proof
    /// resets the clock when the turn account is passed to `verify_action`.
    pub fn open_blackjack_action_window(
        mut ctx: Context<BlackjackActionWindow>,
    ) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.game_kind == shared_zk_ids::GameKind::Blackjack as u8,
            ErrorCode::InvalidGameConfig
        );
        require!(
            game_state.phase == GamePhase::Share as u8
                || game_state.phase == GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        let seat = &ctx.accounts.seat_state;
        require!(
            seat.player_index != game_state.dealer_index,
            ErrorCode::InvalidPlayerIndex
        );
        require_blackjack_window_signer(game_state, &ctx.accounts.signer, seat, &ctx.accounts.dealer_state)?;
        let turn = &mut ctx.accounts.blackjack_turn;
        turn.game_id = game_state.game_id;
        turn.generation = game_state.generation;
        turn.player_index = seat.player_index;
        turn.window_opened_at = unix_now()?;
        turn.stood = false;
        turn.left_hand = false;
        Ok(())
    }

    /// Record a blackjack stand.
    ///
    /// The seat signs this to leave the hand. The dealer signs it once the
    /// seat has had no action for [`BLACKJACK_ACTION_TIMEOUT_SECS`].
    pub fn stand_blackjack_seat(mut ctx: Context<StandBlackjackSeat>) -> Result<()> {
        let game_state = &ctx.accounts.game_state;
        require!(
            game_state.game_kind == shared_zk_ids::GameKind::Blackjack as u8,
            ErrorCode::InvalidGameConfig
        );
        require!(
            game_state.phase == GamePhase::Share as u8
                || game_state.phase == GamePhase::Evaluation as u8,
            ErrorCode::InvalidGamePhase
        );
        let seat = &ctx.accounts.seat_state;
        require!(
            seat.player_index != game_state.dealer_index,
            ErrorCode::InvalidPlayerIndex
        );
        require_blackjack_window_signer(game_state, &ctx.accounts.signer, seat, &ctx.accounts.dealer_state)?;
        let turn = &mut ctx.accounts.blackjack_turn;
        require!(
            turn.game_id == game_state.game_id
                && turn.generation == game_state.generation
                && turn.player_index == seat.player_index
                && !turn.stood,
            ErrorCode::BlackjackAlreadyStood
        );
        let leaving = ctx.accounts.signer.key() == seat.authority;
        if !leaving {
            require!(
                unix_now()? >= turn.window_opened_at.saturating_add(BLACKJACK_ACTION_TIMEOUT_SECS),
                ErrorCode::BlackjackActionTimeoutNotReached
            );
        }
        turn.stood = true;
        turn.left_hand = leaving;
        Ok(())
    }

    /// Close an unproven showdown as a player loss.
    ///
    /// The house dealer (or the game operator, when the game has no house seat)
    /// may call this [`SHOWDOWN_SUBMIT_TIMEOUT_SECS`] after the showdown window
    /// opened and no proof has been accepted.
    pub fn forfeit_showdown(mut ctx: Context<ForfeitShowdown>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        let seat = &ctx.accounts.player_state;
        require!(
            seat.game_id == game_state.game_id && seat.authority == ctx.accounts.signer.key(),
            ErrorCode::InvalidAuthority
        );
        if game_state.dealer_index != 255 {
            require!(
                seat.player_index == game_state.dealer_index,
                ErrorCode::InvalidAuthority
            );
        } else {
            require!(
                ctx.accounts.signer.key() == game_state.operator,
                ErrorCode::InvalidAuthority
            );
        }
        apply_showdown_forfeit(game_state, unix_now()?)
    }

}

/// Three minutes, measured by the Clock sysvar.
pub const SHOWDOWN_SUBMIT_TIMEOUT_SECS: i64 = 180;
pub const BLACKJACK_ACTION_TIMEOUT_SECS: i64 = 180;

fn unix_now() -> Result<i64> {
    use pinocchio::sysvars::Sysvar;
    pinocchio::sysvars::clock::Clock::get()
        .map(|clock| clock.unix_timestamp)
        .map_err(|_| Error::from(ErrorCode::InvalidGamePhase))
}

fn open_showdown_window_at(game_state: &mut GameState, now: i64) -> Result<()> {
    require!(
        game_state.phase == GamePhase::Evaluation as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.showdown_hash == [0u8; 32] && !game_state.showdown_forfeited,
        ErrorCode::ShowdownAlreadySubmitted
    );
    if game_state.showdown_opened_at == 0 {
        game_state.showdown_opened_at = now;
    }
    Ok(())
}

fn apply_showdown_forfeit(game_state: &mut GameState, now: i64) -> Result<()> {
    require!(
        game_state.phase == GamePhase::Evaluation as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.showdown_hash == [0u8; 32] && !game_state.showdown_forfeited,
        ErrorCode::ShowdownAlreadySubmitted
    );
    require!(
        game_state.showdown_opened_at > 0,
        ErrorCode::ShowdownNotOpen
    );
    require!(
        now >= game_state
            .showdown_opened_at
            .saturating_add(SHOWDOWN_SUBMIT_TIMEOUT_SECS),
        ErrorCode::ShowdownTimeoutNotReached
    );
    game_state.showdown_forfeited = true;
    game_state.phase = GamePhase::Complete as u8;
    Ok(())
}

fn require_blackjack_window_signer(
    game_state: &GameState,
    signer: &Signer,
    seat: &PlayerState,
    dealer: &PlayerState,
) -> Result<()> {
    require!(
        seat.game_id == game_state.game_id && dealer.game_id == game_state.game_id,
        ErrorCode::InvalidPublicInputs
    );
    require!(
        dealer.player_index == game_state.dealer_index && dealer.authority != Pubkey::default(),
        ErrorCode::InvalidPlayerIndex
    );
    let signer_key = signer.key();
    require!(
        signer_key == seat.authority || signer_key == dealer.authority,
        ErrorCode::InvalidAuthority
    );
    Ok(())
}

/// Record one showdown proof. Poker uses `pot_mask` (folded seats are out).
/// PvP (bingo, war, baccarat) allows any seated player — `pot_mask` is unused.
/// House games let the bettor prove during the window. After
/// [`SHOWDOWN_SUBMIT_TIMEOUT_SECS`] the house dealer may submit the same
/// showdown proof so a player who left does not stick the table.
/// A no-proof close is [`apply_showdown_forfeit`].
fn accept_showdown_submission(
    game_state: &mut GameState,
    player_index: u8,
    output_hash: [u8; 32],
    now: i64,
) -> Result<()> {
    require!(
        game_state.phase == GamePhase::Evaluation as u8,
        ErrorCode::InvalidGamePhase
    );
    require!(
        game_state.showdown_hash == [0u8; 32] && !game_state.showdown_forfeited,
        ErrorCode::ShowdownAlreadySubmitted
    );
    require!(
        player_index < game_state.num_players,
        ErrorCode::InvalidPlayerIndex
    );
    if game_state.game_kind == shared_zk_ids::GameKind::Poker as u8 {
        require!(
            game_state.pot_mask & (1u16 << player_index) != 0,
            ErrorCode::InvalidPlayerIndex
        );
    } else if game_state.dealer_index != 255 && player_index == game_state.dealer_index {
        require!(
            game_state.showdown_opened_at > 0,
            ErrorCode::ShowdownNotOpen
        );
        require!(
            now >= game_state
                .showdown_opened_at
                .saturating_add(SHOWDOWN_SUBMIT_TIMEOUT_SECS),
            ErrorCode::ShowdownTimeoutNotReached
        );
    }
    game_state.showdown_hash = output_hash;
    game_state.phase = GamePhase::Complete as u8;
    Ok(())
}

/// Record that `player_index` has shared. Advances to Evaluation when everyone has.
fn mark_player_shared(game_state: &mut GameState, player_index: u8) -> Result<()> {
    let bit = 1u16 << player_index;
    require!(game_state.shared_mask & bit == 0, ErrorCode::AlreadyShared);
    game_state.shared_mask |= bit;
    if game_state.shared_mask.count_ones() as u8 == game_state.num_players {
        game_state.phase = GamePhase::Evaluation as u8;
        game_state.current_player = 0;
        let chunked = game_state.game_kind == shared_zk_ids::GameKind::Blackjack as u8
            || game_state.game_kind == shared_zk_ids::GameKind::Bingo as u8;
        if !chunked && game_state.showdown_opened_at == 0 {
            game_state.showdown_opened_at = unix_now()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod showdown_submission_tests {
    use super::*;

    fn evaluation_state(num_players: u8) -> GameState {
        GameState {
            game_id: [1u8; 32],
            generation: 0,
            phase: GamePhase::Evaluation as u8,
            num_players,
            current_player: 0,
            pot_mask: (1u16 << num_players) - 1,
            shared_mask: (1u16 << num_players) - 1,
            total_partials_expected: 0,
            total_partials_revealed: 0,
            showdown_hash: [0u8; 32],
            game_kind: 0,
            shoe_decks: 1,
            roulette_variant: 0,
            dealer_index: 255,
            n_share_chunks: 1,
            bridge_mode: cpi_bridge::BRIDGE_MODE_STANDALONE,
            pattern_id: 0,
            showdown_opened_at: 0,
            showdown_forfeited: false,
            operator: Pubkey::default(),
        }
    }

    #[test]
    fn dealer_forfeit_requires_three_minutes() {
        let mut state = evaluation_state(2);
        state.game_kind = shared_zk_ids::GameKind::Blackjack as u8;
        state.dealer_index = 1;
        state.showdown_opened_at = 1_000;
        assert!(apply_showdown_forfeit(&mut state, 1_000 + 179).is_err());
        assert!(!state.showdown_forfeited);
        apply_showdown_forfeit(&mut state, 1_000 + 180).unwrap();
        assert!(state.showdown_forfeited);
        assert_eq!(state.phase, GamePhase::Complete as u8);
        assert!(accept_showdown_submission(&mut state, 0, [9u8; 32], 0).is_err());
    }

    #[test]
    fn forfeit_before_the_window_opens_fails() {
        let mut state = evaluation_state(2);
        state.dealer_index = 1;
        assert!(apply_showdown_forfeit(&mut state, 10_000).is_err());
        assert!(!state.showdown_forfeited);
    }

    #[test]
    fn non_current_contesting_player_can_submit_showdown() {
        let mut state = evaluation_state(3);
        state.current_player = 0;
        state.pot_mask = 0b110;
        accept_showdown_submission(&mut state, 2, [9u8; 32], 0).unwrap();
        assert_eq!(state.showdown_hash, [9u8; 32]);
        assert_eq!(state.phase, GamePhase::Complete as u8);
    }

    #[test]
    fn folded_player_cannot_submit_showdown() {
        let mut state = evaluation_state(3);
        state.pot_mask = 0b011;
        assert!(accept_showdown_submission(&mut state, 2, [9u8; 32], 0).is_err());
        assert_eq!(state.showdown_hash, [0u8; 32]);
    }

    #[test]
    fn rejects_second_showdown_submission() {
        let mut state = evaluation_state(2);
        accept_showdown_submission(&mut state, 0, [1u8; 32], 0).unwrap();
        assert!(accept_showdown_submission(&mut state, 1, [2u8; 32], 0).is_err());
    }

    #[test]
    fn rejects_out_of_range_player_index() {
        let mut state = evaluation_state(2);
        assert!(accept_showdown_submission(&mut state, 2, [1u8; 32], 0).is_err());
    }

    #[test]
    fn house_dealer_showdown_waits_for_the_player_window() {
        let mut state = evaluation_state(2);
        state.game_kind = shared_zk_ids::GameKind::Keno as u8;
        state.dealer_index = 1;
        state.pot_mask = 0;
        state.showdown_opened_at = 1_000;
        assert!(accept_showdown_submission(&mut state, 1, [9u8; 32], 1_000 + 179).is_err());
        accept_showdown_submission(&mut state, 0, [7u8; 32], 1_000).unwrap();
        assert_eq!(state.showdown_hash, [7u8; 32]);
    }

    #[test]
    fn house_dealer_showdown_after_the_window_frees_the_hand() {
        let mut state = evaluation_state(2);
        state.game_kind = shared_zk_ids::GameKind::Blackjack as u8;
        state.dealer_index = 1;
        state.pot_mask = 0;
        state.showdown_opened_at = 1_000;
        accept_showdown_submission(&mut state, 1, [9u8; 32], 1_000 + 180).unwrap();
        assert_eq!(state.showdown_hash, [9u8; 32]);
        assert_eq!(state.phase, GamePhase::Complete as u8);
    }

    #[test]
    fn bingo_any_seat_can_submit_without_pot_mask() {
        let mut state = evaluation_state(2);
        state.game_kind = shared_zk_ids::GameKind::Bingo as u8;
        state.dealer_index = 255;
        state.pot_mask = 0;
        accept_showdown_submission(&mut state, 1, [9u8; 32], 0).unwrap();
        assert_eq!(state.showdown_hash, [9u8; 32]);
    }
}

// ─── Game Phase Enum ───

#[derive(Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[repr(u8)]
pub enum GamePhase {
    Registration = 0,
    Shuffle = 1,
    Share = 2,
    Evaluation = 3,
    Complete = 4,
}

// ─── Account Structs ───

/// Minimal fixed-layout view of Casino's ShareVerifyAccumulator.
struct ShareVerifyAccView {
    game_id: [u8; 32],
    player_index: u8,
    generation: u64,
    verify_expected: [u8; 32],
    verified: bool,
    frozen: bool,
}

/// Parse Casino-owned `ShareVerifyAccumulator` with owner, PDA, and discriminator checks.
fn validate_share_verify_acc(
    acc_info: &AccountInfo,
    expected_game_id: &[u8; 32],
    expected_player_index: u8,
) -> Result<ShareVerifyAccView> {
    require_keys_eq!(
        acc_info.owner(),
        casino_cpi::casino_program_id(),
        ErrorCode::InvalidPublicInputs
    );
    let (expected_pda, _) = Pubkey::find_program_address(
        &[
            shared_zk_ids::SHARE_VERIFY_ACC_SEED,
            expected_game_id.as_ref(),
            &[expected_player_index],
        ],
        &casino_cpi::casino_program_id(),
    );
    require_keys_eq!(acc_info.key(), expected_pda, ErrorCode::InvalidPublicInputs);

    let data = acc_info.try_borrow_data()?;
    require!(
        data.len() >= shared_zk_ids::SHARE_VERIFY_ACC_DATA_LEN,
        ErrorCode::InvalidPublicInputs
    );
    require!(
        data[0..8] == shared_zk_ids::SHARE_VERIFY_ACC_DISCRIMINATOR,
        ErrorCode::InvalidPublicInputs
    );

    let mut game_id = [0u8; 32];
    game_id.copy_from_slice(
        &data[shared_zk_ids::SHARE_VERIFY_OFF_GAME_ID
            ..shared_zk_ids::SHARE_VERIFY_OFF_GAME_ID + 32],
    );
    let mut generation_bytes = [0u8; 8];
    generation_bytes.copy_from_slice(
        &data[shared_zk_ids::SHARE_VERIFY_OFF_GENERATION
            ..shared_zk_ids::SHARE_VERIFY_OFF_GENERATION + 8],
    );
    let mut verify_expected = [0u8; 32];
    verify_expected.copy_from_slice(
        &data[shared_zk_ids::SHARE_VERIFY_OFF_VERIFY_EXPECTED
            ..shared_zk_ids::SHARE_VERIFY_OFF_VERIFY_EXPECTED + 32],
    );
    let player_index = data[shared_zk_ids::SHARE_VERIFY_OFF_PLAYER_INDEX];
    require!(
        game_id == *expected_game_id && player_index == expected_player_index,
        ErrorCode::InvalidPublicInputs
    );
    Ok(ShareVerifyAccView {
        game_id,
        player_index,
        generation: u64::from_le_bytes(generation_bytes),
        verify_expected,
        verified: data[shared_zk_ids::SHARE_VERIFY_OFF_VERIFIED] != 0,
        frozen: data[shared_zk_ids::SHARE_VERIFY_OFF_FROZEN] != 0,
    })
}

#[cfg(test)]
mod share_verify_acc_layout_tests {
    use super::*;

    #[test]
    fn verified_and_frozen_offsets_are_not_share_cards() {
        assert_eq!(shared_zk_ids::SHARE_VERIFY_OFF_VERIFIED, 270);
        assert_eq!(shared_zk_ids::SHARE_VERIFY_OFF_FROZEN, 271);
        assert_eq!(shared_zk_ids::SHARE_VERIFY_OFF_SHARE_CARDS, 272);
        // Crafted buffer: verified=true, frozen=false, share_cards=9
        let mut data = [0u8; shared_zk_ids::SHARE_VERIFY_ACC_DATA_LEN];
        data[0..8].copy_from_slice(&shared_zk_ids::SHARE_VERIFY_ACC_DISCRIMINATOR);
        data[shared_zk_ids::SHARE_VERIFY_OFF_VERIFIED] = 1;
        data[shared_zk_ids::SHARE_VERIFY_OFF_FROZEN] = 0;
        data[shared_zk_ids::SHARE_VERIFY_OFF_SHARE_CARDS] = 9;
        assert_eq!(data[270], 1);
        assert_eq!(data[271], 0);
        assert_eq!(data[272], 9);
        // Old buggy parser would treat frozen as verified and share_cards as frozen.
        assert_ne!(data[271], 1);
        assert_ne!(data[272], 0);
    }
}

#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct GameState {
    pub game_id: [u8; 32],
    /// Monotonic hand generation bound into every V2 proof receipt PDA.
    pub generation: u64,
    pub phase: u8,
    pub num_players: u8,
    pub current_player: u8,
    /// Poker only: fold / side-pot contestant bitmask. Zero for every other game.
    pub pot_mask: u16,
    /// Bitmap of players who have submitted share partials (parallel share phase).
    pub shared_mask: u16,
    pub total_partials_expected: u16,
    pub total_partials_revealed: u16,
    pub showdown_hash: [u8; 32], // Polynomial hash commitment from proof
    pub game_kind: u8,
    pub shoe_decks: u8,
    pub roulette_variant: u8,
    /// House/dealer seat (`255` = none). Required for roulette, blackjack, craps, keno, slots.
    /// Bingo is PvP and always uses `255`.
    pub dealer_index: u8,
    /// Blackjack / bingo share chunk rounds; `1` for other games.
    pub n_share_chunks: u8,
    /// `0` = standalone (bridge optional); `1` = Casino CPI required on finalize.
    pub bridge_mode: u8,
    /// 75-ball public pattern id (0=any line, 1=corners, 2=blackout). Unused otherwise.
    pub pattern_id: u8,
    /// Unix seconds when a showdown proof became due. `0` until the window opens.
    pub showdown_opened_at: i64,
    /// House dealer closed the hand as a player loss after the showdown timeout.
    pub showdown_forfeited: bool,
    /// `initialize_game` payer. Submits a showdown forfeit when there is no house seat.
    pub operator: Pubkey,
}

/// Per-player bet commitment. Split games set `light_stored` from
/// [`close_bet_public_inputs`]. Fused roulette share sets it from
/// [`store_roulette_bets`].
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct RouletteBetCommitment {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub actual_bet_count: u64,
    pub bet_hash: [u8; 32],
    pub light_stored: bool,
}

/// Action-derived one-hand showdown layout for blackjack (player + dealer cards
/// selected from the shared shoe window). Recorded after hit/split/stay.
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BlackjackShowdownLayout {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub hand_index: u8,
    pub player_card_count: u8,
    pub dealer_card_count: u8,
    /// Dense `oneHandShowdownSourceIndices`: player used || dealer used || pad 0.
    pub source_indices: [u8; 24],
}

#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BlackjackActionLayout {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub action_seq: u16,
    pub h1: [u8; 32],
    pub h2: [u8; 32],
    pub card_count: u8,
    pub can_split: bool,
    pub hit_soft_17: bool,
    pub is_dealer: bool,
    /// Set by `verify_action` from the hashed insurance-eligibility input.
    pub dealer_up_is_ace: bool,
}

/// One-shot insurance / even-money decision for a seat (generation-scoped).
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BlackjackInsurance {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub dealer_up_is_ace: bool,
    pub taken: bool,
    pub even_money: bool,
}

/// Per-seat blackjack action clock. A stand here is a leave or a 3-minute timeout.
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BlackjackTurn {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub window_opened_at: i64,
    pub stood: bool,
    pub left_hand: bool,
}

impl GameState {
    pub fn config(&self) -> Result<OnchainGameConfig> {
        OnchainGameConfig::from_state(self.game_kind, self.shoe_decks, self.roulette_variant)
    }
}

#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct PlayerState {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub authority: Pubkey,
    pub public_key: [[u8; 32]; 2],
    pub padding: [[u8; 32]; 4],
    /// Blackjack: bits of completed share chunks (bit i = chunk i verified).
    pub share_chunk_mask: u32,
}

#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct ProofReceipt {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub phase: u8,
    pub player_index: u8,
    pub circuit_version: u16,
    pub output_hash: [u8; 32],
    pub status: u8,
}

/// Staged `HashCiphertexts` rows for a bingo showdown. One row per transaction.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BingoShowdownRows {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub filled: u16,
    pub row_hashes: [[u8; 32]; 12],
}

/// Staged keno share-row hashes. Eleven Poseidon rows replace the 20
/// revealed-card accounts on the verify transaction. The rent vault funds the
/// account and receives it back when verify closes it.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct KenoShowdownRows {
    pub game_id: [u8; 32],
    pub generation: u64,
    pub player_index: u8,
    pub filled: u16,
    pub row_hashes: [[u8; 32]; 11],
}

/// Empty program-owned stub for `cpi_authority` (legacy). Prefer a system-funded PDA.
#[p_state]
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct CpiAuthorityStub {}

/// Header for staged shuffle public inputs. Caller stages 209 field elements
/// (deck + permutation digest); the verifier derives the input hash transiently.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct ShufflePublicInputs {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub count: u16,
}

#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct BetPublicInputs {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub count: u16,
}

// ─── Compressed Account Types ───

#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct PlayerCompressedAccount {
    #[hash]
    pub game_id: Pubkey,
    pub player_index: u8,
    #[hash]
    pub public_key_x: [u8; 32],
    #[hash]
    pub public_key_y: [u8; 32],
}

#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator, LightHasher)]
pub struct RevealedPartialsCompressedAccount {
    #[hash]
    pub game_id: Pubkey,
    pub chunk_index: u16,
    pub start_index: u16,
    pub count: u8,
    #[hash]
    pub commitment_0: [u8; 32],
    #[hash]
    pub commitment_1: [u8; 32],
    #[hash]
    pub commitment_2: [u8; 32],
    #[hash]
    pub commitment_3: [u8; 32],
    #[hash]
    pub commitment_4: [u8; 32],
    #[hash]
    pub commitment_5: [u8; 32],
    #[hash]
    pub commitment_6: [u8; 32],
    #[hash]
    pub commitment_7: [u8; 32],
}

// ─── Context Structs ───

pub struct InitializeGame<'info> {
        pub payer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
    pub system_program: Program<'info, System>,
}

pub struct SetBingoPattern<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
}

pub struct ExtendShareChunks<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
}

/// Header for staged roulette share public inputs (579 field elements).
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct SharePublicInputs {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub count: u16,
}

pub struct InitCpiAuthority<'info> {
        pub payer: Signer<'info>,
        pub cpi_authority: Account<'info, CpiAuthorityStub>,
    pub system_program: Program<'info, System>,
}

pub struct CloseCpiAuthority<'info> {
        pub payer: Signer<'info>,
    /// CHECK: program-owned stub at cpi_authority seeds; closed manually in handler.
        pub cpi_authority: UncheckedAccount<'info>,
}

pub struct RegisterPlayer<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
    /// CHECK: poker program — omit with other bridge accounts for light-only flows.
    pub poker_program: Option<UncheckedAccount<'info>>,
    /// CHECK: light-casino cpi_authority PDA (mut: pays poker PlayerState rent on CPI).
        pub cpi_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: poker GameState PDA
        pub poker_game_state: Option<UncheckedAccount<'info>>,
    /// CHECK: poker PlayerState PDA (uninit; created by consume_register_receipt)
        pub poker_player_state: Option<UncheckedAccount<'info>>,
}

pub struct InitDeckState<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        /// CHECK: raw deck buffer; grown via `extend_deck_state` to DECK_STATE_ACCOUNT_SIZE.
    pub deck_state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct ExtendDeckState<'info> {
        pub signer: Signer<'info>,
        /// CHECK: deck_state PDA being grown.
    pub deck_state: UncheckedAccount<'info>,
        pub game_state: Account<'info, GameState>,
    pub system_program: Program<'info, System>,
}

pub struct CloseDeckState<'info> {
    pub signer: Signer<'info>,
    pub game_state: Account<'info, GameState>,
    /// CHECK: deck_state PDA closed back to the game operator.
    pub deck_state: UncheckedAccount<'info>,
}

pub struct WriteDeckState<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        /// CHECK: deck buffer validated by seeds.
    pub deck_state: UncheckedAccount<'info>,
}

pub struct FinalizeShuffle<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: poker program (optional bridge)
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
}

pub struct AllocateShufflePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: grown via `extend_shuffle_public_inputs` before header write.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct ExtendShufflePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffle staging PDA being grown.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct CreateShufflePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffle staging PDA; header written manually to avoid stack-heavy deserialize.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct WriteShufflePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffle staging PDA validated by seeds.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
}

pub struct PrepareShuffleChunk<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffle staging PDA; MSM partial written in place.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
}

pub struct FinalizePrepareShuffleInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: authoritative prior verified deck for non-genesis shuffles.
    pub deck_state: UncheckedAccount<'info>,
        /// CHECK: shuffle staging PDA; prepared G1 accumulator finalized in place.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
}

pub struct AllocateSharePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: grown via `extend_share_public_inputs` before header write.
    pub share_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct ExtendSharePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA being grown.
    pub share_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct CreateSharePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA (pre-allocated to full size).
    pub share_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct WriteSharePublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA.
    pub share_public_inputs: UncheckedAccount<'info>,
}

pub struct PrepareShareInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA.
    pub share_public_inputs: UncheckedAccount<'info>,
}

pub struct PrepareShareChunk<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA; MSM partial written in place.
    pub share_public_inputs: UncheckedAccount<'info>,
}

pub struct FinalizePrepareShareInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA; prepared_g1 finalized here.
    pub share_public_inputs: UncheckedAccount<'info>,
}

pub struct VerifyShareStaged<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: roulette share staging PDA; closed after Light bet store.
    pub share_public_inputs: UncheckedAccount<'info>,
    /// CHECK: poker ShareVerifyAccumulator — Arcis card share hash binding.
    pub share_verify_acc: UncheckedAccount<'info>,
        pub roulette_bet_commitment: Account<'info, RouletteBetCommitment>,
    /// Share receipt keyed by Arcis `share_verify_acc.generation` (see `init_share_receipt`).
    /// PDA seeds are checked in the instruction against that generation.
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: optional poker program for receipt CPI
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub struct StoreRouletteBets<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: staging still holding bet limbs until final chunk.
    pub share_public_inputs: UncheckedAccount<'info>,
        pub roulette_bet_commitment: Account<'info, RouletteBetCommitment>,
}

pub struct RecordBlackjackActionLayout<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub blackjack_action_layout: Account<'info, BlackjackActionLayout>,
    pub system_program: Program<'info, System>,
}

pub struct RecordBlackjackInsurance<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
    /// Initial (seq 0) player action layout — proves pre-action 2-card window.
        pub initial_action_layout: Account<'info, BlackjackActionLayout>,
    /// Dealer seq-0 action layout — Ace-up comes from verified circuit output.
        pub dealer_action_layout: Account<'info, BlackjackActionLayout>,
        pub blackjack_insurance: Account<'info, BlackjackInsurance>,
    pub system_program: Program<'info, System>,
}

pub struct InitActionReceipt<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
}

pub struct VerifyAction<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
        pub blackjack_action_layout: Account<'info, BlackjackActionLayout>,
        pub blackjack_turn: Option<Account<'info, BlackjackTurn>>,
    /// CHECK: casino-owned sealed coefficients PDA for this seat.
    pub sealed_showdown_coefficients: UncheckedAccount<'info>,
}

pub struct OpenShowdownWindow<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
}

pub struct BlackjackActionWindow<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub seat_state: Account<'info, PlayerState>,
        pub dealer_state: Account<'info, PlayerState>,
        pub blackjack_turn: Account<'info, BlackjackTurn>,
    pub system_program: Program<'info, System>,
}

pub struct StandBlackjackSeat<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub seat_state: Account<'info, PlayerState>,
        pub dealer_state: Account<'info, PlayerState>,
        pub blackjack_turn: Account<'info, BlackjackTurn>,
}

pub struct ForfeitShowdown<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
}

pub struct VerifyShuffleStaged<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffle staging PDA validated by seeds; closed after verify.
    pub shuffle_public_inputs: UncheckedAccount<'info>,
        /// CHECK: authoritative pre-shuffle deck for Poseidon input-hash verification.
    pub deck_state: UncheckedAccount<'info>,
        pub proof_receipt: Account<'info, ProofReceipt>,
}

pub struct InitShuffleReceipt<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
}

pub struct InitShareReceipt<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
    /// CHECK: poker-owned ShareVerifyAccumulator, validated by manual Borsh.
    pub share_verify_acc: UncheckedAccount<'info>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
}

pub struct VerifySlotShare<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffled deck used to recompute share input hash.
    pub deck_state: UncheckedAccount<'info>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: poker-owned ShareVerifyAccumulator, validated before Groth16.
    pub share_verify_acc: UncheckedAccount<'info>,
        pub roulette_bet_commitment: Account<'info, RouletteBetCommitment>,
    /// CHECK: poker program (optional bridge)
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

pub struct CreateBetPublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: split-game bet staging; header written in the instruction.
    pub bet_public_inputs: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct WriteBetPublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: bet staging PDA.
    pub bet_public_inputs: UncheckedAccount<'info>,
}

pub struct PrepareBetChunk<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: bet staging PDA.
    pub bet_public_inputs: UncheckedAccount<'info>,
}

pub struct VerifyBet<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: filled + prepared bet staging.
    pub bet_public_inputs: UncheckedAccount<'info>,
        pub roulette_bet_commitment: Account<'info, RouletteBetCommitment>,
    pub system_program: Program<'info, System>,
}

pub struct CloseBetPublicInputs<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: staging PDA closed after the Light commitment is written.
    pub bet_public_inputs: UncheckedAccount<'info>,
        pub roulette_bet_commitment: Account<'info, RouletteBetCommitment>,
}

pub struct VerifyShare<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: shuffled deck used to recompute share input hash.
    pub deck_state: UncheckedAccount<'info>,
    /// Share receipt keyed by Arcis `share_verify_acc.generation` (see `init_share_receipt`).
    /// PDA seeds are checked in the instruction against that generation.
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: poker-owned ShareVerifyAccumulator, validated before Groth16.
    pub share_verify_acc: UncheckedAccount<'info>,
    /// CHECK: poker program (optional bridge)
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
}

pub struct InitShowdownReceipt<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
}

pub struct InitBingoShowdownRows<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub bingo_showdown_rows: Account<'info, BingoShowdownRows>,
    pub system_program: Program<'info, System>,
}

pub struct HashBingoShowdownRow<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
    pub deck_state: UncheckedAccount<'info>,
    pub showdown_material: UncheckedAccount<'info>,
        pub bingo_showdown_rows: Account<'info, BingoShowdownRows>,
}

pub struct InitKenoShowdownRows<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub keno_showdown_rows: Account<'info, KenoShowdownRows>,
    pub system_program: Program<'info, System>,
}

pub struct HashKenoShowdownRow<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
    pub showdown_material: UncheckedAccount<'info>,
        pub keno_showdown_rows: Account<'info, KenoShowdownRows>,
}

pub struct VerifyShowdownReceipt<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: canonical deal ciphertext output.
    pub deck_state: UncheckedAccount<'info>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: poker-owned canonical PDA. Owner, seeds, fixed layout, generation,
    /// recipient, and `complete` are verified in `verify_showdown_receipt`.
    pub showdown_material: UncheckedAccount<'info>,
    /// CHECK: poker-owned sealed coefficients PDA for the proving seat. Owner,
    /// PDA seed, non-zero immutable commitment, and layout are verified above.
    pub sealed_showdown_coefficients: UncheckedAccount<'info>,
    /// Roulette only: bet commitment PDA (`roulette_bets` || game || player).
        pub roulette_bet_commitment: Option<Account<'info, RouletteBetCommitment>>,
    /// Blackjack only: action-derived showdown layout PDA.
        pub blackjack_showdown_layout: Option<Account<'info, BlackjackShowdownLayout>>,
    /// Bingo only: staged ciphertext-row hashes. Required before verify.
        pub bingo_showdown_rows: Option<Account<'info, BingoShowdownRows>>,
    /// Keno only: staged share-row hashes. Closed into the rent vault on success.
        pub keno_showdown_rows: Option<Account<'info, KenoShowdownRows>>,
}

pub struct RecordBlackjackShowdownLayout<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub blackjack_showdown_layout: Account<'info, BlackjackShowdownLayout>,
    pub system_program: Program<'info, System>,
}

pub struct FinalizeShowdown<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    /// CHECK: poker program (optional bridge)
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
}

pub struct VerifyShowdown<'info> {
        pub signer: Signer<'info>,
        pub game_state: Account<'info, GameState>,
        pub player_state: Account<'info, PlayerState>,
        /// CHECK: deal ciphertexts for showdown input hash.
    pub deck_state: UncheckedAccount<'info>,
        pub proof_receipt: Account<'info, ProofReceipt>,
    pub system_program: Program<'info, System>,
    /// CHECK: poker program (optional bridge)
    pub poker_program: Option<UncheckedAccount<'info>>,
        /// CHECK: cpi_authority PDA
    pub cpi_authority: Option<UncheckedAccount<'info>>,
        /// CHECK: poker GameState
    pub poker_game_state: Option<UncheckedAccount<'info>>,
}

pub struct GenericAnchorAccounts<'info> {
        pub signer: Signer<'info>,
}

// ─── Error Codes ───

#[p_error]
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    AccountNotEnoughKeys = 6000,
    InvalidGamePhase = 6001,
    NotYourTurn = 6002,
    AlreadyShared = 6003,
    InvalidNumPlayers = 6004,
    PlayerAlreadyRegistered = 6005,
    InvalidProof = 6006,
    InvalidPublicInputs = 6007,
    InputHashMismatch = 6008,
    ShowdownAlreadySubmitted = 6009,
    InvalidPlayerIndex = 6010,
    InvalidChunkCount = 6011,
    InvalidPokerProgram = 6012,
    InvalidPokerBridgeAccounts = 6013,
    InvalidAuthority = 6014,
    CasinoBridgeRequired = 6015,
    ShowdownMaterialsNotVerified = 6016,
    ShowdownCoefficientCommitmentMissing = 6017,
    InvalidCircuitVersion = 6018,
    InvalidStagingWrite = 6019,
    InvalidGameConfig = 6020,
    DealerMustHaveZeroBets = 6021,
    RouletteBetsNotStored = 6022,
    BlackjackLayoutNotRecorded = 6023,
    BlackjackLayoutInvalid = 6024,
    BlackjackInsuranceNotOffered = 6025,
    BlackjackInsuranceWindowClosed = 6026,
    ShowdownNotOpen = 6027,
    ShowdownTimeoutNotReached = 6028,
    BlackjackAlreadyStood = 6029,
    BlackjackActionTimeoutNotReached = 6030,
}

impl From<ErrorCode> for Error {
    fn from(code: ErrorCode) -> Self {
        Error::Custom(code as u32)
    }
}
