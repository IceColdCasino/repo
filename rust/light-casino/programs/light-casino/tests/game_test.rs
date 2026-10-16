use borsh::{BorshDeserialize, BorshSerialize};
use groth16_solana::groth16::Groth16Verifier;
use light_casino::{
    groth16_verify::UncompressedProof,
    prelude::Pubkey,
    test_vectors::{TEST_PROOF, TEST_PUBLIC_INPUTS, TEST_VERIFYING_KEY},
    GamePhase, GameState, PlayerState,
};

/// Convert endianness by reversing each 32-byte chunk.
fn convert_endianness<const IN_SIZE: usize, const OUT_SIZE: usize>(input: &[u8; IN_SIZE]) -> [u8; OUT_SIZE] {
    assert_eq!(IN_SIZE, OUT_SIZE);
    let mut output = [0u8; OUT_SIZE];
    for (chunk_idx, chunk) in input.chunks(32).enumerate() {
        let start = chunk_idx * 32;
        for i in 0..32 {
            output[start + i] = chunk[31 - i];
        }
    }
    output
}

// ─── Groth16 Verification Tests ───

/// Verify that the Groth16 verifier correctly verifies a known-good proof.
/// This uses the built-in test vectors from groth16-solana.
#[test]
fn test_verify_groth16_with_known_proof() {
    use ark_bn254::g1::G1Affine;
    use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
    use std::ops::Neg;

    // The TEST_PROOF constant contains the non-negated proof_a.
    // Groth16Verifier::new expects the NEGATED proof_a.
    // We need to negate it before passing to the verifier.

    // Deserialize proof_a, negate, and re-serialize
    let proof_a_le = convert_endianness::<64, 64>(&TEST_PROOF[0..64].try_into().unwrap());
    let g1 = G1Affine::deserialize_with_mode(
        &*[&proof_a_le[..], &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    )
    .unwrap();
    let mut proof_a_neg_le = [0u8; 64];
    g1.neg()
        .x
        .serialize_with_mode(&mut proof_a_neg_le[..32], Compress::No)
        .unwrap();
    g1.neg()
        .y
        .serialize_with_mode(&mut proof_a_neg_le[32..], Compress::No)
        .unwrap();
    let proof_a = convert_endianness::<64, 64>(&proof_a_neg_le);

    let proof_b = TEST_PROOF[64..192].try_into().unwrap();
    let proof_c = TEST_PROOF[192..256].try_into().unwrap();

    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &TEST_PUBLIC_INPUTS,
        &TEST_VERIFYING_KEY,
    )
    .unwrap();
    verifier.verify().unwrap();
}

/// Verify that a wrong proof (non-negated proof_a) fails verification.
#[test]
fn test_verify_groth16_wrong_proof_fails() {
    let proof_a = TEST_PROOF[0..64].try_into().unwrap();
    let proof_b = TEST_PROOF[64..192].try_into().unwrap();
    let proof_c = TEST_PROOF[192..256].try_into().unwrap();

    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &TEST_PUBLIC_INPUTS,
        &TEST_VERIFYING_KEY,
    )
    .unwrap();
    assert!(verifier.verify().is_err());
}

// ─── Game State Machine Tests ───

#[test]
fn test_game_phase_enum_values() {
    assert_eq!(GamePhase::Registration as u8, 0);
    assert_eq!(GamePhase::Shuffle as u8, 1);
    assert_eq!(GamePhase::Share as u8, 2);
    assert_eq!(GamePhase::Evaluation as u8, 3);
    assert_eq!(GamePhase::Complete as u8, 4);
}

#[test]
fn test_game_state_serialization() {
    let game_state = GameState {
        game_id: [1u8; 32],
        generation: 42,
        phase: GamePhase::Shuffle as u8,
        num_players: 4,
        current_player: 2,
        pot_mask: 0b1111,
        shared_mask: 0b0101,
        total_partials_expected: 12,
        total_partials_revealed: 6,
        showdown_hash: [7u8; 32],
        game_kind: 0,
        shoe_decks: 1,
        roulette_variant: 0,
        dealer_index: 255,
        n_share_chunks: 1,
        bridge_mode: 0,
        pattern_id: 0,
        showdown_opened_at: 0,
        showdown_forfeited: false,
        operator: Pubkey::default(),
    };

    let mut serialized = Vec::new();
    game_state.serialize(&mut serialized).unwrap();
    let deserialized = GameState::deserialize(&mut &serialized[..]).unwrap();

    assert_eq!(deserialized.game_id, [1u8; 32]);
    assert_eq!(deserialized.generation, 42);
    assert_eq!(deserialized.phase, GamePhase::Shuffle as u8);
    assert_eq!(deserialized.num_players, 4);
    assert_eq!(deserialized.current_player, 2);
    assert_eq!(deserialized.pot_mask, 0b1111);
    assert_eq!(deserialized.shared_mask, 0b0101);
    assert_eq!(deserialized.total_partials_expected, 12);
    assert_eq!(deserialized.total_partials_revealed, 6);
    assert_eq!(deserialized.showdown_hash, [7u8; 32]);
    assert_eq!(deserialized.n_share_chunks, 1);
}

#[test]
fn test_player_state_serialization() {
    let player_state = PlayerState {
        game_id: [2u8; 32],
        player_index: 3,
        authority: light_casino::prelude::Pubkey::default(),
        public_key: [[1u8; 32], [2u8; 32]],
        padding: [[3u8; 32], [4u8; 32], [5u8; 32], [6u8; 32]],
        share_chunk_mask: 0,
    };

    let mut serialized = Vec::new();
    player_state.serialize(&mut serialized).unwrap();
    let deserialized = PlayerState::deserialize(&mut &serialized[..]).unwrap();

    assert_eq!(deserialized.game_id, [2u8; 32]);
    assert_eq!(deserialized.player_index, 3);
    assert_eq!(deserialized.public_key, [[1u8; 32], [2u8; 32]]);
    assert_eq!(deserialized.padding, [[3u8; 32], [4u8; 32], [5u8; 32], [6u8; 32]]);
}

// ─── Uncompressed Proof Serialization Tests ───

#[test]
fn test_uncompressed_proof_serialization() {
    let proof = UncompressedProof {
        a: [1u8; 64],
        b: [2u8; 128],
        c: [3u8; 64],
    };

    let mut serialized = Vec::new();
    proof.serialize(&mut serialized).unwrap();
    assert_eq!(serialized.len(), 64 + 128 + 64); // 256 bytes total

    let deserialized = UncompressedProof::deserialize(&mut &serialized[..]).unwrap();
    assert_eq!(deserialized.a, [1u8; 64]);
    assert_eq!(deserialized.b, [2u8; 128]);
    assert_eq!(deserialized.c, [3u8; 64]);
}

// ─── PDA Derivation Tests ───

#[test]
fn test_game_state_pda_derivation() {
    let game_id = [42u8; 32];
    let program_id = light_casino::ID;

    let (expected_address, _bump) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"game_state", &game_id[..]],
        &program_id,
    );

    assert_ne!(expected_address, solana_sdk::pubkey::Pubkey::default());
}

#[test]
fn test_player_state_pda_derivation() {
    let game_id = [1u8; 32];
    let player_index = 5u8;
    let program_id = light_casino::ID;

    let (expected_address, _bump) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"player", &game_id[..], &[player_index]],
        &program_id,
    );

    assert_ne!(expected_address, solana_sdk::pubkey::Pubkey::default());
}

#[test]
fn test_proof_receipt_pda_derivation() {
    let game_id = [1u8; 32];
    let player_index = 5u8;
    let phase = light_casino::PROOF_PHASE_SHARE;
    let program_id = light_casino::ID;

    let (expected_address, _bump) = solana_sdk::pubkey::Pubkey::find_program_address(
        &[b"proof_receipt", &game_id[..], &[phase], &[player_index]],
        &program_id,
    );

    assert_ne!(expected_address, solana_sdk::pubkey::Pubkey::default());
}

// ─── Constants Tests ───

#[test]
fn test_constants() {
    assert_eq!(light_casino::MAX_PLAYERS, 10);
    assert_eq!(light_casino::TOTAL_CARDS, 25);
    assert_eq!(light_casino::MAX_POTS, 9);
    assert_eq!(light_casino::REGISTER_PUBLIC_INPUTS, 6);
    assert_eq!(light_casino::SHUFFLE_PUBLIC_INPUTS, 3);
    assert_eq!(light_casino::SHARE_PUBLIC_INPUTS, 2);
    assert_eq!(light_casino::SHOWDOWN_PUBLIC_INPUTS, 2);
}
