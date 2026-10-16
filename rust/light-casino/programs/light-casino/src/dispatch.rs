use super::*;
use crate::light_casino::*;
use crate::prelude::err;

fn take<T: BorshDeserialize>(data: &mut &[u8]) -> Result<T> {
    T::deserialize(data).map_err(|_| Error::from(ProgramError::InvalidInstructionData))
}

pub fn dispatch(
    accounts: &[pinocchio::account_info::AccountInfo],
    data: &[u8],
) -> Result<()> {
    let _ = take_account_write_failed();
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData.into());
    }
    let (disc, rest) = data.split_at(8);
    let mut tag = [0u8; 8];
    tag.copy_from_slice(disc);
    let wrapped: Vec<AccountInfo> = accounts.iter().map(AccountInfo::new).collect();
    let result = match tag {
        [137, 218, 23, 170, 233, 115, 87, 119] => ix_create_revealed_partials(&wrapped, rest),
        [44, 62, 102, 247, 126, 208, 130, 215] => ix_initialize_game(&wrapped, rest),
        [72, 102, 29, 146, 68, 140, 140, 16] => ix_set_bingo_pattern(&wrapped, rest),
        [119, 73, 78, 154, 126, 131, 118, 25] => ix_extend_share_chunks(&wrapped, rest),
        [157, 223, 192, 119, 164, 37, 51, 74] => ix_init_cpi_authority(&wrapped, rest),
        [193, 6, 153, 33, 42, 79, 88, 219] => ix_close_cpi_authority(&wrapped, rest),
        [29, 31, 133, 255, 226, 59, 193, 217] => ix_store_artifact_chunk(&wrapped, rest),
        [211, 4, 222, 127, 216, 136, 25, 19] => ix_register_player_receipt(&wrapped, rest),
        [242, 146, 194, 234, 234, 145, 228, 42] => ix_register_player(&wrapped, rest),
        [85, 130, 90, 238, 130, 116, 156, 76] => ix_init_deck_state(&wrapped, rest),
        [194, 213, 236, 21, 63, 197, 71, 123] => ix_extend_deck_state(&wrapped, rest),
        [71, 87, 41, 189, 120, 211, 237, 8] => ix_close_deck_state(&wrapped, rest),
        [252, 2, 69, 224, 176, 70, 253, 27] => ix_allocate_shuffle_public_inputs(&wrapped, rest),
        [6, 213, 9, 237, 23, 95, 214, 109] => ix_extend_shuffle_public_inputs(&wrapped, rest),
        [154, 116, 208, 50, 228, 212, 46, 208] => ix_create_shuffle_public_inputs(&wrapped, rest),
        [100, 187, 243, 141, 27, 217, 64, 111] => ix_write_shuffle_public_inputs(&wrapped, rest),
        [138, 231, 117, 12, 39, 12, 107, 153] => ix_prepare_shuffle_chunk(&wrapped, rest),
        [175, 197, 86, 223, 206, 251, 132, 60] => ix_finalize_prepare_shuffle_inputs(&wrapped, rest),
        [161, 85, 82, 176, 22, 208, 61, 41] => ix_cache_shuffle_deck_hash(&wrapped, rest),
        [196, 141, 98, 44, 55, 174, 31, 30] => ix_verify_shuffle_staged(&wrapped, rest),
        [218, 123, 245, 228, 142, 193, 1, 31] => ix_finalize_shuffle(&wrapped, rest),
        [130, 23, 123, 115, 189, 93, 222, 235] => ix_verify_share(&wrapped, rest),
        [195, 218, 135, 66, 35, 103, 24, 160] => ix_verify_slot_share(&wrapped, rest),
        [161, 28, 162, 34, 206, 115, 77, 166] => ix_create_bet_public_inputs(&wrapped, rest),
        [216, 32, 238, 51, 164, 16, 200, 249] => ix_write_bet_public_inputs(&wrapped, rest),
        [112, 59, 42, 151, 176, 217, 70, 101] => ix_prepare_bet_chunk(&wrapped, rest),
        [126, 107, 78, 49, 218, 250, 44, 133] => ix_verify_bet(&wrapped, rest),
        [9, 87, 141, 205, 176, 243, 232, 47] => ix_verify_card_commit(&wrapped, rest),
        [247, 229, 225, 224, 133, 60, 205, 156] => ix_close_bet_public_inputs(&wrapped, rest),
        [86, 225, 101, 77, 217, 166, 33, 202] => ix_allocate_share_public_inputs(&wrapped, rest),
        [25, 97, 66, 146, 245, 23, 46, 77] => ix_extend_share_public_inputs(&wrapped, rest),
        [221, 30, 107, 191, 5, 95, 232, 224] => ix_create_share_public_inputs(&wrapped, rest),
        [153, 202, 94, 129, 164, 238, 54, 88] => ix_write_share_public_inputs(&wrapped, rest),
        [87, 157, 252, 238, 241, 119, 197, 1] => ix_prepare_share_inputs(&wrapped, rest),
        [246, 11, 210, 219, 185, 107, 32, 22] => ix_prepare_share_chunk(&wrapped, rest),
        [138, 201, 126, 165, 42, 229, 28, 152] => ix_finalize_prepare_share_inputs(&wrapped, rest),
        [28, 93, 93, 174, 199, 138, 168, 156] => ix_verify_share_staged(&wrapped, rest),
        [14, 78, 160, 62, 116, 60, 47, 194] => ix_store_roulette_bets(&wrapped, rest),
        [172, 122, 160, 143, 51, 247, 22, 182] => ix_init_shuffle_receipt(&wrapped, rest),
        [23, 36, 138, 11, 33, 148, 31, 37] => ix_init_share_receipt(&wrapped, rest),
        [197, 21, 130, 18, 243, 178, 118, 27] => ix_init_showdown_receipt(&wrapped, rest),
        [189, 40, 24, 38, 96, 17, 120, 178] => ix_init_bingo_showdown_rows(&wrapped, rest),
        [136, 218, 231, 236, 217, 185, 249, 248] => ix_hash_bingo_showdown_row(&wrapped, rest),
        [198, 214, 111, 76, 110, 154, 190, 163] => ix_init_keno_showdown_rows(&wrapped, rest),
        [226, 137, 230, 154, 65, 174, 189, 124] => ix_hash_keno_showdown_row(&wrapped, rest),
        [113, 167, 189, 160, 0, 183, 3, 37] => ix_verify_showdown_receipt(&wrapped, rest),
        [214, 117, 143, 100, 67, 65, 252, 117] => ix_finalize_showdown(&wrapped, rest),
        [66, 52, 40, 179, 255, 219, 8, 113] => ix_verify_showdown(&wrapped, rest),
        [63, 91, 162, 171, 160, 70, 220, 136] => ix_fold(&wrapped, rest),
        [145, 83, 152, 158, 77, 81, 157, 142] => ix_record_blackjack_showdown_layout(&wrapped, rest),
        [180, 110, 153, 99, 207, 197, 117, 182] => ix_record_blackjack_action_layout(&wrapped, rest),
        [98, 169, 0, 108, 12, 212, 239, 3] => ix_record_blackjack_insurance(&wrapped, rest),
        [105, 120, 140, 152, 158, 21, 108, 214] => ix_init_action_receipt(&wrapped, rest),
        [6, 4, 243, 214, 140, 39, 49, 3] => ix_verify_action(&wrapped, rest),
        [159, 84, 192, 27, 158, 213, 168, 137] => ix_forfeit_showdown(&wrapped, rest),
        [22, 89, 3, 180, 175, 79, 135, 73] => ix_open_blackjack_action_window(&wrapped, rest),
        [117, 75, 28, 226, 168, 194, 35, 70] => ix_stand_blackjack_seat(&wrapped, rest),
        [3, 197, 54, 216, 150, 125, 197, 201] => ix_open_showdown_window(&wrapped, rest),
        [128, 44, 115, 145, 179, 116, 35, 71] => crate::rent_vault::init_rent_vault(&wrapped, rest),
        [82, 227, 109, 211, 164, 252, 29, 19] => crate::rent_vault::deposit_rent_vault(&wrapped, rest),
        [50, 42, 236, 195, 212, 4, 16, 118] => crate::rent_vault::settle_rent_vault(&wrapped),
        [115, 164, 214, 71, 94, 163, 207, 118] => crate::rent_vault::reimburse_rent_vault(&wrapped, rest),
        [87, 110, 182, 107, 70, 130, 84, 241] => crate::rent_vault::recapture_rent_vault(&wrapped, rest),
        [26, 179, 25, 154, 195, 181, 188, 146] => crate::rent_vault::draw_rent_vault(&wrapped, rest),
        [107, 168, 253, 249, 125, 169, 108, 96] => crate::rent_vault::close_player_state(&wrapped),
        #[cfg(feature = "testing")]
        [24, 8, 77, 123, 160, 105, 223, 36] => crate::rent_vault::close_light_session(&wrapped, rest),
        [85, 194, 8, 44, 250, 213, 244, 39] => crate::rent_vault::close_share_receipt(&wrapped, rest),
        [218, 194, 0, 101, 54, 192, 94, 61] => crate::shuffle_chunks::write_prepare_shuffle_chunk(&wrapped, rest),
        [3, 131, 152, 7, 68, 89, 147, 77] => crate::shuffle_chunks::absorb_shuffle_fields(&wrapped, rest),
        [236, 76, 166, 86, 119, 169, 92, 28] => crate::shuffle_chunks::absorb_shuffle_partial(&wrapped, rest),
        [120, 66, 46, 216, 108, 103, 107, 234] => crate::shuffle_chunks::absorb_shuffle_batch(&wrapped, rest),
        [24, 243, 112, 150, 70, 175, 8, 100] => crate::share_tier::absorb_share_street(&wrapped, rest),
        [107, 199, 129, 31, 153, 104, 220, 111] => crate::share_tier::write_share_chunk(&wrapped, rest),
        [108, 196, 79, 95, 71, 86, 155, 136] => crate::share_tier::finish_share_street(&wrapped, rest),
        [88, 1, 206, 132, 43, 128, 184, 0] => crate::shuffle_chunks::fund_shuffle_lanes(&wrapped, rest),
        _ => Err(ProgramError::InvalidInstructionData.into()),
    };
    if result.is_ok() && take_account_write_failed() {
        return err!(ProgramErrorCode::AccountDidNotSerialize);
    }
    let _ = take_account_write_failed();
    result
}

fn ix_create_revealed_partials(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let game_id = take::<Pubkey>(&mut data)?;
    let recipient_index = take::<u8>(&mut data)?;
    let chunk_index = take::<u16>(&mut data)?;
    let start_index = take::<u16>(&mut data)?;
    let count = take::<u8>(&mut data)?;
    let commitment_0 = take::<[u8; 32]>(&mut data)?;
    let commitment_1 = take::<[u8; 32]>(&mut data)?;
    let commitment_2 = take::<[u8; 32]>(&mut data)?;
    let commitment_3 = take::<[u8; 32]>(&mut data)?;
    let commitment_4 = take::<[u8; 32]>(&mut data)?;
    let commitment_5 = take::<[u8; 32]>(&mut data)?;
    let commitment_6 = take::<[u8; 32]>(&mut data)?;
    let commitment_7 = take::<[u8; 32]>(&mut data)?;
    let ctx = GenericAnchorAccounts::load(accounts)?;
    create_revealed_partials(ctx, proof, address_tree_info, output_merkle_tree_index, game_id, recipient_index, chunk_index, start_index, count, commitment_0, commitment_1, commitment_2, commitment_3, commitment_4, commitment_5, commitment_6, commitment_7)
}

fn ix_initialize_game(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let game_id = take::<[u8; 32]>(&mut data)?;
    let num_players = take::<u8>(&mut data)?;
    let game_kind = take::<u8>(&mut data)?;
    let shoe_decks = take::<u8>(&mut data)?;
    let roulette_variant = take::<u8>(&mut data)?;
    let dealer_index = take::<u8>(&mut data)?;
    let bridge_mode = take::<u8>(&mut data)?;
    let ctx = InitializeGame::load(accounts, game_id)?;
    initialize_game(ctx, game_id, num_players, game_kind, shoe_decks, roulette_variant, dealer_index, bridge_mode)
}

fn ix_set_bingo_pattern(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let pattern_id = take::<u8>(&mut data)?;
    let ctx = SetBingoPattern::load(accounts)?;
    set_bingo_pattern(ctx, pattern_id)
}

fn ix_extend_share_chunks(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = ExtendShareChunks::load(accounts)?;
    extend_share_chunks(ctx)
}

fn ix_init_cpi_authority(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitCpiAuthority::load(accounts)?;
    init_cpi_authority(ctx)
}

fn ix_close_cpi_authority(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = CloseCpiAuthority::load(accounts)?;
    close_cpi_authority(ctx)
}

fn ix_store_artifact_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let game_id = take::<Pubkey>(&mut data)?;
    let kind = take::<u8>(&mut data)?;
    let owner_index = take::<u8>(&mut data)?;
    let chunk_index = take::<u16>(&mut data)?;
    let start_index = take::<u16>(&mut data)?;
    let count = take::<u8>(&mut data)?;
    let commitment_0 = take::<[u8; 32]>(&mut data)?;
    let commitment_1 = take::<[u8; 32]>(&mut data)?;
    let commitment_2 = take::<[u8; 32]>(&mut data)?;
    let commitment_3 = take::<[u8; 32]>(&mut data)?;
    let commitment_4 = take::<[u8; 32]>(&mut data)?;
    let commitment_5 = take::<[u8; 32]>(&mut data)?;
    let commitment_6 = take::<[u8; 32]>(&mut data)?;
    let commitment_7 = take::<[u8; 32]>(&mut data)?;
    let ctx = GenericAnchorAccounts::load(accounts)?;
    store_artifact_chunk(ctx, proof, address_tree_info, output_merkle_tree_index, game_id, kind, owner_index, chunk_index, start_index, count, commitment_0, commitment_1, commitment_2, commitment_3, commitment_4, commitment_5, commitment_6, commitment_7)
}

fn ix_register_player_receipt(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let player_index = take::<u8>(&mut data)?;
    let proof = take::<UncompressedProof>(&mut data)?;
    let public_inputs = take::<[[u8; 32]; REGISTER_PUBLIC_INPUTS]>(&mut data)?;
    let ctx = RegisterPlayer::load(accounts, player_index)?;
    register_player_receipt(ctx, player_index, proof, public_inputs)
}

fn ix_register_player(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let player_index = take::<u8>(&mut data)?;
    let proof = take::<UncompressedProof>(&mut data)?;
    let public_inputs = take::<[[u8; 32]; REGISTER_PUBLIC_INPUTS]>(&mut data)?;
    let light_proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let ctx = RegisterPlayer::load(accounts, player_index)?;
    register_player(ctx, player_index, proof, public_inputs, light_proof, address_tree_info, output_merkle_tree_index)
}

fn ix_init_deck_state(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitDeckState::load(accounts)?;
    init_deck_state(ctx)
}

fn ix_extend_deck_state(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = ExtendDeckState::load(accounts)?;
    extend_deck_state(ctx)
}

fn ix_close_deck_state(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = CloseDeckState::load(accounts)?;
    close_deck_state(ctx)
}

fn ix_allocate_shuffle_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = AllocateShufflePublicInputs::load(accounts)?;
    allocate_shuffle_public_inputs(ctx)
}

fn ix_extend_shuffle_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = ExtendShufflePublicInputs::load(accounts)?;
    extend_shuffle_public_inputs(ctx)
}

fn ix_create_shuffle_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = CreateShufflePublicInputs::load(accounts)?;
    create_shuffle_public_inputs(ctx)
}

fn ix_write_shuffle_public_inputs(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let offset = take::<u16>(&mut data)?;
    let data = take::<Vec<u8>>(&mut data)?;
    let ctx = WriteShufflePublicInputs::load(accounts)?;
    write_shuffle_public_inputs(ctx, offset, data)
}

fn ix_prepare_shuffle_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let start = take::<u16>(&mut data)?;
    let ctx = PrepareShuffleChunk::load(accounts)?;
    prepare_shuffle_chunk(ctx, start)
}

fn ix_finalize_prepare_shuffle_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = FinalizePrepareShuffleInputs::load(accounts)?;
    finalize_prepare_shuffle_inputs(ctx)
}

fn ix_cache_shuffle_deck_hash(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = FinalizePrepareShuffleInputs::load(accounts)?;
    cache_shuffle_deck_hash(ctx)
}

fn ix_verify_shuffle_staged(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let light_proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let ctx = VerifyShuffleStaged::load(accounts)?;
    verify_shuffle_staged(ctx, proof, light_proof, address_tree_info, output_merkle_tree_index)
}

fn ix_finalize_shuffle(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = FinalizeShuffle::load(accounts)?;
    finalize_shuffle(ctx)
}

fn ix_verify_share(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let output_hash = take::<[u8; 32]>(&mut data)?;
    let chunk_index = take::<u8>(&mut data)?;
    let published_tiers = data;
    let ctx = VerifyShare::load(accounts)?;
    verify_share(ctx, proof, output_hash, chunk_index, published_tiers)
}

fn ix_verify_slot_share(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let output_hash = take::<[u8; 32]>(&mut data)?;
    let bet_limbs = take::<[[u8; 32]; 8]>(&mut data)?;
    let ctx = VerifySlotShare::load(accounts)?;
    verify_slot_share(ctx, proof, output_hash, bet_limbs)
}

fn ix_create_bet_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = CreateBetPublicInputs::load(accounts)?;
    create_bet_public_inputs(ctx)
}

fn ix_write_bet_public_inputs(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let offset = take::<u16>(&mut data)?;
    let data = take::<Vec<u8>>(&mut data)?;
    let ctx = WriteBetPublicInputs::load(accounts)?;
    write_bet_public_inputs(ctx, offset, data)
}

fn ix_prepare_bet_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let start = take::<u16>(&mut data)?;
    let ctx = PrepareBetChunk::load(accounts)?;
    prepare_bet_chunk(ctx, start)
}

fn ix_verify_bet(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let ctx = VerifyBet::load(accounts)?;
    verify_bet(ctx, proof)
}

fn ix_close_bet_public_inputs(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let ctx = CloseBetPublicInputs::load(accounts)?;
    close_bet_public_inputs(ctx, proof, address_tree_info, output_merkle_tree_index)
}

fn ix_verify_card_commit(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let ctx = VerifyBet::load(accounts)?;
    verify_card_commit(ctx, proof)
}

fn ix_allocate_share_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = AllocateSharePublicInputs::load(accounts)?;
    allocate_share_public_inputs(ctx)
}

fn ix_extend_share_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = ExtendSharePublicInputs::load(accounts)?;
    extend_share_public_inputs(ctx)
}

fn ix_create_share_public_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = CreateSharePublicInputs::load(accounts)?;
    create_share_public_inputs(ctx)
}

fn ix_write_share_public_inputs(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let offset = take::<u16>(&mut data)?;
    let data = take::<Vec<u8>>(&mut data)?;
    let ctx = WriteSharePublicInputs::load(accounts)?;
    write_share_public_inputs(ctx, offset, data)
}

fn ix_prepare_share_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = PrepareShareInputs::load(accounts)?;
    prepare_share_inputs(ctx)
}

fn ix_prepare_share_chunk(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let start = take::<u16>(&mut data)?;
    let ctx = PrepareShareChunk::load(accounts)?;
    prepare_share_chunk(ctx, start)
}

fn ix_finalize_prepare_share_inputs(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = FinalizePrepareShareInputs::load(accounts)?;
    finalize_prepare_share_inputs(ctx)
}

fn ix_verify_share_staged(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let ctx = VerifyShareStaged::load(accounts)?;
    verify_share_staged(ctx, proof)
}

fn ix_store_roulette_bets(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<LightValidityProof>(&mut data)?;
    let address_tree_info = take::<LightAddressTreeInfo>(&mut data)?;
    let output_merkle_tree_index = take::<u8>(&mut data)?;
    let chunk_index = take::<u16>(&mut data)?;
    let start_index = take::<u16>(&mut data)?;
    let count = take::<u8>(&mut data)?;
    let commitment_0 = take::<[u8; 32]>(&mut data)?;
    let commitment_1 = take::<[u8; 32]>(&mut data)?;
    let commitment_2 = take::<[u8; 32]>(&mut data)?;
    let commitment_3 = take::<[u8; 32]>(&mut data)?;
    let commitment_4 = take::<[u8; 32]>(&mut data)?;
    let commitment_5 = take::<[u8; 32]>(&mut data)?;
    let commitment_6 = take::<[u8; 32]>(&mut data)?;
    let commitment_7 = take::<[u8; 32]>(&mut data)?;
    let ctx = StoreRouletteBets::load(accounts)?;
    store_roulette_bets(ctx, proof, address_tree_info, output_merkle_tree_index, chunk_index, start_index, count, commitment_0, commitment_1, commitment_2, commitment_3, commitment_4, commitment_5, commitment_6, commitment_7)
}

fn ix_init_shuffle_receipt(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitShuffleReceipt::load(accounts)?;
    init_shuffle_receipt(ctx)
}

fn ix_init_share_receipt(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let mpc_generation = take::<u64>(&mut data)?;
    let ctx = InitShareReceipt::load(accounts, mpc_generation)?;
    init_share_receipt(ctx, mpc_generation)
}

fn ix_init_showdown_receipt(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitShowdownReceipt::load(accounts)?;
    init_showdown_receipt(ctx)
}

fn ix_init_bingo_showdown_rows(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitBingoShowdownRows::load(accounts)?;
    init_bingo_showdown_rows(ctx)
}

fn ix_hash_bingo_showdown_row(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let row_index = take::<u8>(&mut data)?;
    let ctx = HashBingoShowdownRow::load(accounts)?;
    hash_bingo_showdown_row(ctx, row_index)
}

fn ix_init_keno_showdown_rows(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = InitKenoShowdownRows::load(accounts)?;
    init_keno_showdown_rows(ctx)
}

fn ix_hash_keno_showdown_row(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let row_index = take::<u8>(&mut data)?;
    let ctx = HashKenoShowdownRow::load(accounts)?;
    hash_keno_showdown_row(ctx, row_index)
}

fn ix_verify_showdown_receipt(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let hand_index = take::<u8>(&mut data)?;
    let proof = take::<UncompressedProof>(&mut data)?;
    let output_hash = take::<[u8; 32]>(&mut data)?;
    let ctx = VerifyShowdownReceipt::load(accounts, hand_index)?;
    verify_showdown_receipt(ctx, hand_index, proof, output_hash)
}

fn ix_finalize_showdown(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = FinalizeShowdown::load(accounts)?;
    finalize_showdown(ctx)
}

fn ix_verify_showdown(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let _proof = take::<UncompressedProof>(&mut data)?;
    let _output_hash = take::<[u8; 32]>(&mut data)?;
    let _light_proof = take::<LightValidityProof>(&mut data)?;
    let _account_meta = take::<LightCompressedAccountMeta>(&mut data)?;
    let ctx = VerifyShowdown::load(accounts)?;
    verify_showdown(ctx, _proof, _output_hash, _light_proof, _account_meta)
}

fn ix_fold(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let proof = take::<UncompressedProof>(&mut data)?;
    let output_hash = take::<[u8; 32]>(&mut data)?;
    let ctx = VerifyShare::load(accounts)?;
    fold(ctx, proof, output_hash)
}

fn ix_record_blackjack_showdown_layout(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let hand_index = take::<u8>(&mut data)?;
    let player_card_count = take::<u8>(&mut data)?;
    let dealer_card_count = take::<u8>(&mut data)?;
    let source_indices = take::<[u8; 24]>(&mut data)?;
    let ctx = RecordBlackjackShowdownLayout::load(accounts, hand_index)?;
    record_blackjack_showdown_layout(ctx, hand_index, player_card_count, dealer_card_count, source_indices)
}

fn ix_record_blackjack_action_layout(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let action_seq = take::<u16>(&mut data)?;
    let h1 = take::<[u8; 32]>(&mut data)?;
    let h2 = take::<[u8; 32]>(&mut data)?;
    let card_count = take::<u8>(&mut data)?;
    let can_split = take::<bool>(&mut data)?;
    let hit_soft_17 = take::<bool>(&mut data)?;
    let is_dealer = take::<bool>(&mut data)?;
    let ctx = RecordBlackjackActionLayout::load(accounts, action_seq)?;
    record_blackjack_action_layout(ctx, action_seq, h1, h2, card_count, can_split, hit_soft_17, is_dealer)
}

fn ix_record_blackjack_insurance(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let taken = take::<bool>(&mut data)?;
    let even_money = take::<bool>(&mut data)?;
    let ctx = RecordBlackjackInsurance::load(accounts)?;
    record_blackjack_insurance(ctx, taken, even_money)
}

fn ix_init_action_receipt(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let _action_seq = take::<u16>(&mut data)?;
    let action_seq = _action_seq;
    let ctx = InitActionReceipt::load(accounts, action_seq)?;
    init_action_receipt(ctx, _action_seq)
}

fn ix_verify_action(accounts: &[AccountInfo], mut data: &[u8]) -> Result<()> {
    let action_seq = take::<u16>(&mut data)?;
    let proof = take::<UncompressedProof>(&mut data)?;
    let output_hash = take::<[u8; 32]>(&mut data)?;
    let insurance_eligible = take::<bool>(&mut data)?;
    let upcard_hash = take::<[u8; 32]>(&mut data)?;
    let ctx = VerifyAction::load(accounts, action_seq)?;
    verify_action(ctx, action_seq, proof, output_hash, insurance_eligible, upcard_hash)
}

fn ix_forfeit_showdown(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = ForfeitShowdown::load(accounts)?;
    forfeit_showdown(ctx)
}

fn ix_open_blackjack_action_window(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = BlackjackActionWindow::load(accounts)?;
    open_blackjack_action_window(ctx)
}

fn ix_stand_blackjack_seat(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = StandBlackjackSeat::load(accounts)?;
    stand_blackjack_seat(ctx)
}

fn ix_open_showdown_window(accounts: &[AccountInfo], _data: &[u8]) -> Result<()> {
    let ctx = OpenShowdownWindow::load(accounts)?;
    open_showdown_window(ctx)
}

