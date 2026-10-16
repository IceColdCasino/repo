//! Annotation surface for `pinocchio-idl`.
//!
//! These functions are not the instruction handlers. `dispatch.rs` still
//! matches the 8-byte sighash. `idl/generate.py fix` copies those sighashes
//! onto the IDL, because pinocchio-idl's `id` is a single byte.

#![allow(unused_variables)]

use pinocchio_idl_macros::p_instruction;

macro_rules! declare_id {
    ($id:literal) => {};
}

declare_id!("CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc");

#[allow(dead_code)]
#[p_instruction(
    id = 0,
    accounts = [
        signer(mut, signer)
    ],
    data = [
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
        commitment_7: [u8; 32]
    ]
)]
pub fn create_revealed_partials(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 1,
    accounts = [
        payer(mut, signer),
        game_state(mut, state = GameState),
        system_program
    ],
    data = [
        game_id: [u8; 32],
        num_players: u8,
        game_kind: u8,
        shoe_decks: u8,
        roulette_variant: u8,
        dealer_index: u8,
        bridge_mode: u8
    ]
)]
pub fn initialize_game(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 2,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState)
    ],
    data = [
        pattern_id: u8
    ]
)]
pub fn set_bingo_pattern(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 3,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState)
    ],
)]
pub fn extend_share_chunks(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 4,
    accounts = [
        payer(mut, signer),
        cpi_authority(mut, state = CpiAuthorityStub),
        system_program
    ],
)]
pub fn init_cpi_authority(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 5,
    accounts = [
        payer(mut, signer),
        cpi_authority(mut)
    ],
)]
pub fn close_cpi_authority(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 6,
    accounts = [
        signer(mut, signer)
    ],
    data = [
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
        commitment_7: [u8; 32]
    ]
)]
pub fn store_artifact_chunk(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 7,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        system_program,
        poker_program,
        cpi_authority(mut),
        poker_game_state(mut),
        poker_player_state(mut)
    ],
    data = [
        player_index: u8,
        proof: UncompressedProof,
        public_inputs: [[u8; 32]; 6]
    ]
)]
pub fn register_player_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 8,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        system_program,
        poker_program,
        cpi_authority(mut),
        poker_game_state(mut),
        poker_player_state(mut)
    ],
    data = [
        player_index: u8,
        proof: UncompressedProof,
        public_inputs: [[u8; 32]; 6],
        light_proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8
    ]
)]
pub fn register_player(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 9,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        deck_state(mut),
        system_program
    ],
)]
pub fn init_deck_state(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 10,
    accounts = [
        signer(mut, signer),
        deck_state(mut),
        game_state(state = GameState),
        system_program
    ],
)]
pub fn extend_deck_state(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 11,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut),
        system_program
    ],
)]
pub fn allocate_shuffle_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 12,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut),
        system_program
    ],
)]
pub fn extend_shuffle_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 13,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut),
        system_program
    ],
)]
pub fn create_shuffle_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 14,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut)
    ],
    data = [
        offset: u16,
        data: Vec<u8>
    ]
)]
pub fn write_shuffle_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 15,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut)
    ],
    data = [
        start: u16
    ]
)]
pub fn prepare_shuffle_chunk(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 16,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        deck_state,
        shuffle_public_inputs(mut)
    ],
)]
pub fn finalize_prepare_shuffle_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 17,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(state = PlayerState),
        shuffle_public_inputs(mut),
        deck_state(mut),
        proof_receipt(mut, state = ProofReceipt)
    ],
    data = [
        proof: UncompressedProof,
        light_proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8
    ]
)]
pub fn verify_shuffle_staged(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 18,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        poker_program,
        cpi_authority,
        poker_game_state(mut)
    ],
)]
pub fn finalize_shuffle(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 19,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        deck_state,
        proof_receipt(mut, state = ProofReceipt),
        share_verify_acc,
        poker_program,
        cpi_authority,
        poker_game_state(mut)
    ],
    data = [
        proof: UncompressedProof,
        output_hash: [u8; 32],
        chunk_index: u8
    ]
)]
pub fn verify_share(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 20,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        deck_state,
        proof_receipt(mut, state = ProofReceipt),
        share_verify_acc,
        roulette_bet_commitment(mut, state = RouletteBetCommitment),
        poker_program,
        cpi_authority,
        poker_game_state(mut),
        system_program
    ],
    data = [
        proof: UncompressedProof,
        output_hash: [u8; 32],
        bet_limbs: [[u8; 32]; 8]
    ]
)]
pub fn verify_slot_share(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 21,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut),
        system_program
    ],
)]
pub fn create_bet_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 22,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut)
    ],
    data = [
        offset: u16,
        data: Vec<u8>
    ]
)]
pub fn write_bet_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 23,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut)
    ],
    data = [
        start: u16
    ]
)]
pub fn prepare_bet_chunk(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 24,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut),
        roulette_bet_commitment(mut, state = RouletteBetCommitment),
        system_program
    ],
    data = [
        proof: UncompressedProof
    ]
)]
pub fn verify_bet(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 25,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut),
        roulette_bet_commitment(mut, state = RouletteBetCommitment),
        system_program
    ],
    data = [
        proof: UncompressedProof
    ]
)]
pub fn verify_card_commit(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 51,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        bet_public_inputs(mut),
        roulette_bet_commitment(mut, state = RouletteBetCommitment)
    ],
    data = [
        proof: LightValidityProof,
        address_tree_info: LightAddressTreeInfo,
        output_merkle_tree_index: u8
    ]
)]
pub fn close_bet_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 26,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut),
        system_program
    ],
)]
pub fn allocate_share_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 27,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut),
        system_program
    ],
)]
pub fn extend_share_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 28,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut),
        system_program
    ],
)]
pub fn create_share_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 29,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut)
    ],
    data = [
        offset: u16,
        data: Vec<u8>
    ]
)]
pub fn write_share_public_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 30,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut)
    ],
)]
pub fn prepare_share_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 31,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut)
    ],
    data = [
        start: u16
    ]
)]
pub fn prepare_share_chunk(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 32,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut)
    ],
)]
pub fn finalize_prepare_share_inputs(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 33,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut),
        share_verify_acc,
        roulette_bet_commitment(mut, state = RouletteBetCommitment),
        proof_receipt(mut, state = ProofReceipt),
        poker_program,
        cpi_authority,
        poker_game_state(mut),
        system_program
    ],
    data = [
        proof: UncompressedProof
    ]
)]
pub fn verify_share_staged(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 34,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_public_inputs(mut),
        roulette_bet_commitment(mut, state = RouletteBetCommitment)
    ],
    data = [
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
        commitment_7: [u8; 32]
    ]
)]
pub fn store_roulette_bets(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 35,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        system_program
    ],
)]
pub fn init_shuffle_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 36,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        share_verify_acc,
        proof_receipt(mut, state = ProofReceipt),
        system_program
    ],
    data = [
        mpc_generation: u64
    ]
)]
pub fn init_share_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 37,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        system_program
    ],
)]
pub fn init_showdown_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 38,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(state = PlayerState),
        deck_state,
        proof_receipt(mut, state = ProofReceipt),
        showdown_material,
        sealed_showdown_coefficients,
        roulette_bet_commitment(state = RouletteBetCommitment),
        blackjack_showdown_layout(state = BlackjackShowdownLayout)
    ],
    data = [
        hand_index: u8,
        proof: UncompressedProof,
        output_hash: [u8; 32]
    ]
)]
pub fn verify_showdown_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 39,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        poker_program,
        cpi_authority,
        poker_game_state(mut)
    ],
)]
pub fn finalize_showdown(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 40,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        deck_state,
        proof_receipt(mut, state = ProofReceipt),
        system_program,
        poker_program,
        cpi_authority,
        poker_game_state(mut)
    ],
    data = [
        _proof: UncompressedProof,
        _output_hash: [u8; 32],
        _light_proof: LightValidityProof,
        _account_meta: LightCompressedAccountMeta
    ]
)]
pub fn verify_showdown(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 41,
    accounts = [
        signer(mut, signer),
        game_state(mut, state = GameState),
        player_state(mut, state = PlayerState),
        deck_state,
        proof_receipt(mut, state = ProofReceipt),
        share_verify_acc,
        poker_program,
        cpi_authority,
        poker_game_state(mut)
    ],
    data = [
        proof: UncompressedProof,
        output_hash: [u8; 32]
    ]
)]
pub fn fold(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 42,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        blackjack_showdown_layout(mut, state = BlackjackShowdownLayout),
        system_program
    ],
    data = [
        hand_index: u8,
        player_card_count: u8,
        dealer_card_count: u8,
        source_indices: [u8; 24]
    ]
)]
pub fn record_blackjack_showdown_layout(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 43,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        blackjack_action_layout(mut, state = BlackjackActionLayout),
        system_program
    ],
    data = [
        action_seq: u16,
        h1: [u8; 32],
        h2: [u8; 32],
        card_count: u8,
        can_split: bool,
        hit_soft_17: bool,
        is_dealer: bool
    ]
)]
pub fn record_blackjack_action_layout(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 44,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        initial_action_layout(state = BlackjackActionLayout),
        dealer_action_layout(state = BlackjackActionLayout),
        blackjack_insurance(mut, state = BlackjackInsurance),
        system_program
    ],
    data = [
        taken: bool,
        even_money: bool
    ]
)]
pub fn record_blackjack_insurance(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 45,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        system_program
    ],
    data = [
        _action_seq: u16
    ]
)]
pub fn init_action_receipt(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(
    id = 46,
    accounts = [
        signer(mut, signer),
        game_state(state = GameState),
        player_state(state = PlayerState),
        proof_receipt(mut, state = ProofReceipt),
        blackjack_action_layout(mut, state = BlackjackActionLayout)
    ],
    data = [
        action_seq: u16,
        proof: UncompressedProof,
        output_hash: [u8; 32],
        insurance_eligible: bool,
        upcard_hash: [u8; 32]
    ]
)]
pub fn verify_action(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(id = 47, accounts = [signer(mut, signer), game_state(mut, state = GameState), player_state(state = PlayerState)])]
pub fn open_showdown_window(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(id = 48, accounts = [signer(mut, signer), game_state(state = GameState), seat_state(state = PlayerState), dealer_state(state = PlayerState), blackjack_turn(mut, state = BlackjackTurn), system_program])]
pub fn open_blackjack_action_window(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(id = 49, accounts = [signer(mut, signer), game_state(state = GameState), seat_state(state = PlayerState), dealer_state(state = PlayerState), blackjack_turn(mut, state = BlackjackTurn)])]
pub fn stand_blackjack_seat(accounts: &[u8]) {}

#[allow(dead_code)]
#[p_instruction(id = 50, accounts = [signer(mut, signer), game_state(mut, state = GameState), player_state(state = PlayerState)])]
pub fn forfeit_showdown(accounts: &[u8]) {}
