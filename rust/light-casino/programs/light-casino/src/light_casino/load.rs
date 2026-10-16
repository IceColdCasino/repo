use super::*;

impl AccountData for RevealPersistenceState {
    const DISCRIMINATOR: [u8; 8] = [201, 129, 101, 25, 107, 87, 148, 227];
}

impl AccountData for GameState {
    const DISCRIMINATOR: [u8; 8] = [144, 94, 208, 172, 248, 99, 134, 120];
}

impl AccountData for RouletteBetCommitment {
    const DISCRIMINATOR: [u8; 8] = [163, 112, 90, 17, 202, 93, 217, 171];
}

impl AccountData for BlackjackShowdownLayout {
    const DISCRIMINATOR: [u8; 8] = [108, 252, 52, 82, 204, 149, 18, 34];
}

impl AccountData for BlackjackActionLayout {
    const DISCRIMINATOR: [u8; 8] = [10, 100, 152, 59, 233, 15, 44, 193];
}

impl AccountData for BlackjackInsurance {
    const DISCRIMINATOR: [u8; 8] = [72, 134, 209, 244, 90, 53, 208, 66];
}

impl AccountData for BlackjackTurn {
    const DISCRIMINATOR: [u8; 8] = [124, 12, 242, 8, 72, 22, 169, 169];
}

impl AccountData for PlayerState {
    const DISCRIMINATOR: [u8; 8] = [56, 3, 60, 86, 174, 16, 244, 195];
}

impl AccountData for ProofReceipt {
    const DISCRIMINATOR: [u8; 8] = [235, 183, 148, 241, 160, 127, 228, 196];
}

impl AccountData for BingoShowdownRows {
    const DISCRIMINATOR: [u8; 8] = [186, 162, 192, 39, 187, 176, 139, 160];
}

impl AccountData for KenoShowdownRows {
    const DISCRIMINATOR: [u8; 8] = [55, 9, 232, 85, 161, 127, 206, 26];
}

impl AccountData for CpiAuthorityStub {
    const DISCRIMINATOR: [u8; 8] = [179, 173, 215, 90, 206, 1, 104, 184];
}

impl AccountData for ShufflePublicInputs {
    const DISCRIMINATOR: [u8; 8] = [43, 46, 215, 178, 131, 185, 129, 102];
}

impl AccountData for BetPublicInputs {
    const DISCRIMINATOR: [u8; 8] = [129, 44, 132, 70, 104, 226, 25, 239];
}

impl AccountData for SharePublicInputs {
    const DISCRIMINATOR: [u8; 8] = [239, 22, 11, 101, 87, 40, 143, 68];
}


impl<'info> InitializeGame<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], game_id: [u8; 32]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let payer = ix.signer(true)?;
        let game_state = ix.init::<GameState>(&payer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 1 + 2 + 2 + 2 + 2 + 32 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 8 + 1 + 32, &[b"game_state", &game_id[..]], false)?;
        let system_program = ix.system()?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { payer, game_state, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> SetBingoPattern<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> ExtendShareChunks<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitCpiAuthority<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let payer = ix.signer(true)?;
        let cpi_authority = ix.init::<CpiAuthorityStub>(&payer.to_account_info(), 8, &[CPI_AUTHORITY_SEED], true)?;
        let system_program = ix.system()?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { payer, cpi_authority, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CloseCpiAuthority<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let payer = ix.signer(true)?;
        let cpi_authority = ix.unchecked(true)?;
        ix.check_seeds(&cpi_authority.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { payer, cpi_authority },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> RegisterPlayer<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], player_index: u8) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.init::<PlayerState>(&signer.to_account_info(), 8 + 32 + 1 + 32 + 64 + 128 + 4, &[b"player", &game_state.game_id[..], &[player_index]], false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_REGISTER], &[player_index]], false)?;
        let system_program = ix.system()?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(true)?;
        let poker_game_state = ix.optional(true)?;
        let poker_player_state = ix.optional(true)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, system_program, poker_program, cpi_authority, poker_game_state, poker_player_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitDeckState<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let deck_state = ix.init_unchecked(&signer.to_account_info(), MAX_CPI_ALLOC, &[b"deck_state", &game_state.game_id[..]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, deck_state, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> ExtendDeckState<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let deck_state = ix.unchecked(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, deck_state, game_state, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CloseDeckState<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let deck_state = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, deck_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> WriteDeckState<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let deck_state = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, deck_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> FinalizeShuffle<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&proof_receipt.to_account_info(), &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHUFFLE], &[player_state.player_index]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, poker_program, cpi_authority, poker_game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> AllocateShufflePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.init_unchecked(&signer.to_account_info(), MAX_CPI_ALLOC, &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> ExtendShufflePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CreateShufflePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> WriteShufflePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> PrepareShuffleChunk<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> FinalizePrepareShuffleInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let deck_state = ix.unchecked(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, shuffle_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> AllocateSharePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.init_unchecked(&signer.to_account_info(), MAX_CPI_ALLOC, &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> ExtendSharePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CreateSharePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> WriteSharePublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> PrepareShareInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> PrepareShareChunk<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> FinalizePrepareShareInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyShareStaged<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        let share_verify_acc = ix.unchecked(false)?;
        let roulette_bet_commitment = ix.init::<RouletteBetCommitment>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 8 + 32 + 1, &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs, share_verify_acc, roulette_bet_commitment, proof_receipt, poker_program, cpi_authority, poker_game_state, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> StoreRouletteBets<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_public_inputs = ix.unchecked(true)?;
        let roulette_bet_commitment = ix.load::<RouletteBetCommitment>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&share_public_inputs.to_account_info(), &[b"share_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        ix.check_seeds(&roulette_bet_commitment.to_account_info(), &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_public_inputs, roulette_bet_commitment },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> RecordBlackjackActionLayout<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], action_seq: u16) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let blackjack_action_layout = ix.init::<BlackjackActionLayout>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 2 + 32 + 32 + 1 + 1 + 1 + 1 + 1, &[b"bj_action_layout", &game_state.game_id[..], &[player_state.player_index], &action_seq.to_le_bytes()], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, blackjack_action_layout, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> RecordBlackjackInsurance<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let initial_action_layout = ix.load::<BlackjackActionLayout>(false)?;
        let dealer_action_layout = ix.load::<BlackjackActionLayout>(false)?;
        let blackjack_insurance = ix.init::<BlackjackInsurance>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 1 + 1, &[b"bj_insurance", &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&initial_action_layout.to_account_info(), &[b"bj_action_layout", &game_state.game_id[..], &[player_state.player_index], &0u16.to_le_bytes()], false)?;
        ix.check_seeds(&dealer_action_layout.to_account_info(), &[b"bj_action_layout", &game_state.game_id[..], &[game_state.dealer_index], &0u16.to_le_bytes()], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, initial_action_layout, dealer_action_layout, blackjack_insurance, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitActionReceipt<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], action_seq: u16) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_ACTION], &[player_state.player_index], &action_seq.to_le_bytes()], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyAction<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], action_seq: u16) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let blackjack_action_layout = ix.load::<BlackjackActionLayout>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&proof_receipt.to_account_info(), &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_ACTION], &[player_state.player_index], &action_seq.to_le_bytes()], false)?;
        ix.check_seeds(&blackjack_action_layout.to_account_info(), &[b"bj_action_layout", &game_state.game_id[..], &[player_state.player_index], &action_seq.to_le_bytes()], false)?;
        let blackjack_turn = ix.optional_load::<BlackjackTurn>(true)?;
        if let Some(turn) = blackjack_turn.as_ref() {
            ix.check_seeds(&turn.to_account_info(), &[b"bj_turn", &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[player_state.player_index]], false)?;
        }
        let sealed_showdown_coefficients = ix.unchecked(false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, blackjack_action_layout, blackjack_turn, sealed_showdown_coefficients },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> OpenShowdownWindow<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> BlackjackActionWindow<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let seat_state = ix.load::<PlayerState>(false)?;
        let dealer_state = ix.load::<PlayerState>(false)?;
        let blackjack_turn = ix.init::<BlackjackTurn>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 8 + 1 + 1, &[b"bj_turn", &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[seat_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&seat_state.to_account_info(), &[b"player", &seat_state.game_id[..], &[seat_state.player_index]], false)?;
        ix.check_seeds(&dealer_state.to_account_info(), &[b"player", &dealer_state.game_id[..], &[dealer_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, seat_state, dealer_state, blackjack_turn, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> StandBlackjackSeat<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let seat_state = ix.load::<PlayerState>(false)?;
        let dealer_state = ix.load::<PlayerState>(false)?;
        let blackjack_turn = ix.load::<BlackjackTurn>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&seat_state.to_account_info(), &[b"player", &seat_state.game_id[..], &[seat_state.player_index]], false)?;
        ix.check_seeds(&dealer_state.to_account_info(), &[b"player", &dealer_state.game_id[..], &[dealer_state.player_index]], false)?;
        ix.check_seeds(&blackjack_turn.to_account_info(), &[b"bj_turn", &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[seat_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, seat_state, dealer_state, blackjack_turn },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> ForfeitShowdown<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyShuffleStaged<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let shuffle_public_inputs = ix.unchecked(true)?;
        let deck_state = ix.unchecked(true)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&shuffle_public_inputs.to_account_info(), &[b"shuffle_inputs", &game_state.game_id[..]], false)?;
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&proof_receipt.to_account_info(), &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHUFFLE], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, shuffle_public_inputs, deck_state, proof_receipt },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitShuffleReceipt<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHUFFLE], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitShareReceipt<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], mpc_generation: u64) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let share_verify_acc = ix.unchecked(false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), crate::share_tier::SHARE_RECEIPT_LEN, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &mpc_generation.to_le_bytes(), &[PROOF_PHASE_SHARE], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, share_verify_acc, proof_receipt, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifySlotShare<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(true)?;
        let deck_state = ix.unchecked(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let share_verify_acc = ix.unchecked(false)?;
        let roulette_bet_commitment = ix.init::<RouletteBetCommitment>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 8 + 32 + 1, &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, proof_receipt, share_verify_acc, roulette_bet_commitment, poker_program, cpi_authority, poker_game_state, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CreateBetPublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bet_public_inputs = ix.init_unchecked(&signer.to_account_info(), bet_staging::BET_INPUTS_ACCOUNT_SIZE, &[b"bet_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bet_public_inputs, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> WriteBetPublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bet_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&bet_public_inputs.to_account_info(), &[b"bet_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bet_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> PrepareBetChunk<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bet_public_inputs = ix.unchecked(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&bet_public_inputs.to_account_info(), &[b"bet_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bet_public_inputs },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyBet<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bet_public_inputs = ix.unchecked(true)?;
        let roulette_bet_commitment = ix.init::<RouletteBetCommitment>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 8 + 32 + 1, &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&bet_public_inputs.to_account_info(), &[b"bet_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bet_public_inputs, roulette_bet_commitment, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> CloseBetPublicInputs<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bet_public_inputs = ix.unchecked(true)?;
        let roulette_bet_commitment = ix.load::<RouletteBetCommitment>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&bet_public_inputs.to_account_info(), &[b"bet_inputs", &game_state.game_id[..], &[player_state.player_index]], false)?;
        ix.check_seeds(&roulette_bet_commitment.to_account_info(), &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bet_public_inputs, roulette_bet_commitment },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyShare<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(true)?;
        let deck_state = ix.unchecked(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let share_verify_acc = ix.unchecked(false)?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, proof_receipt, share_verify_acc, poker_program, cpi_authority, poker_game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitShowdownReceipt<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHOWDOWN], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitBingoShowdownRows<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let bingo_showdown_rows = ix.init::<BingoShowdownRows>(
            &signer.to_account_info(),
            8 + 32 + 8 + 1 + 2 + 32 * 12,
            &[b"bingo_showdown_rows", &game_state.game_id[..], &[player_state.player_index]],
            false,
        )?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, bingo_showdown_rows, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> HashBingoShowdownRow<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let deck_state = ix.unchecked(false)?;
        let showdown_material = ix.unchecked(false)?;
        let bingo_showdown_rows = ix.load::<BingoShowdownRows>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&bingo_showdown_rows.to_account_info(), &[b"bingo_showdown_rows", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, showdown_material, bingo_showdown_rows },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyShowdownReceipt<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], hand_index: u8) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let deck_state = ix.unchecked(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let showdown_material = ix.unchecked(false)?;
        let sealed_showdown_coefficients = ix.unchecked(false)?;
        let roulette_bet_commitment = ix.optional_load::<RouletteBetCommitment>(false)?;
        let blackjack_showdown_layout = ix.optional_load::<BlackjackShowdownLayout>(false)?;
        let bingo_showdown_rows = ix.optional_load::<BingoShowdownRows>(false)?;
        let keno_showdown_rows = ix.optional_load::<KenoShowdownRows>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&proof_receipt.to_account_info(), &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHOWDOWN], &[player_state.player_index]], false)?;
        if let Some(account) = roulette_bet_commitment.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[b"roulette_bets", &game_state.game_id[..], &[player_state.player_index]], false)?;
        }
        if let Some(account) = blackjack_showdown_layout.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[b"bj_showdown_layout", &game_state.game_id[..], &[player_state.player_index], &[hand_index]], false)?;
        }
        if let Some(account) = bingo_showdown_rows.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[b"bingo_showdown_rows", &game_state.game_id[..], &[player_state.player_index]], false)?;
        }
        if let Some(account) = keno_showdown_rows.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[b"keno_showdown_rows", &game_state.game_id[..], &[player_state.player_index]], false)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, proof_receipt, showdown_material, sealed_showdown_coefficients, roulette_bet_commitment, blackjack_showdown_layout, bingo_showdown_rows, keno_showdown_rows },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> InitKenoShowdownRows<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let keno_showdown_rows = ix.init::<KenoShowdownRows>(
            &signer.to_account_info(),
            8 + 32 + 8 + 1 + 2 + 32 * 11,
            &[b"keno_showdown_rows", &game_state.game_id[..], &[player_state.player_index]],
            false,
        )?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, keno_showdown_rows, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> HashKenoShowdownRow<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let showdown_material = ix.unchecked(false)?;
        let keno_showdown_rows = ix.load::<KenoShowdownRows>(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&keno_showdown_rows.to_account_info(), &[b"keno_showdown_rows", &game_state.game_id[..], &[player_state.player_index]], false)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, showdown_material, keno_showdown_rows },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> RecordBlackjackShowdownLayout<'info> {
    pub fn load(accounts: &[AccountInfo<'info>], hand_index: u8) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(false)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let blackjack_showdown_layout = ix.init::<BlackjackShowdownLayout>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 1 + 1 + 24, &[b"bj_showdown_layout", &game_state.game_id[..], &[player_state.player_index], &[hand_index]], false)?;
        let system_program = ix.system()?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, blackjack_showdown_layout, system_program },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> FinalizeShowdown<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(false)?;
        let proof_receipt = ix.load::<ProofReceipt>(true)?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&proof_receipt.to_account_info(), &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHOWDOWN], &[player_state.player_index]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, proof_receipt, poker_program, cpi_authority, poker_game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> VerifyShowdown<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let game_state = ix.load::<GameState>(true)?;
        let player_state = ix.load::<PlayerState>(true)?;
        let deck_state = ix.unchecked(false)?;
        let proof_receipt = ix.init::<ProofReceipt>(&signer.to_account_info(), 8 + 32 + 8 + 1 + 1 + 2 + 32 + 1, &[PROOF_RECEIPT_V2_SEED, &game_state.game_id[..], &game_state.generation.to_le_bytes(), &[PROOF_PHASE_SHOWDOWN], &[player_state.player_index]], false)?;
        let system_program = ix.system()?;
        let poker_program = ix.optional(false)?;
        let cpi_authority = ix.optional(false)?;
        let poker_game_state = ix.optional(true)?;
        ix.check_seeds(&game_state.to_account_info(), &[b"game_state", &game_state.game_id[..]], false)?;
        ix.check_seeds(&player_state.to_account_info(), &[b"player", &player_state.game_id[..], &[player_state.player_index]], false)?;
        require!(player_state.game_id == game_state.game_id, ErrorCode::InvalidPublicInputs);
        require!(player_state.authority == signer.key(), ErrorCode::InvalidAuthority);
        ix.check_seeds(&deck_state.to_account_info(), &[b"deck_state", &game_state.game_id[..]], false)?;
        if let Some(account) = cpi_authority.as_ref() {
            ix.check_seeds(&account.to_account_info(), &[CPI_AUTHORITY_SEED], true)?;
        }
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer, game_state, player_state, deck_state, proof_receipt, system_program, poker_program, cpi_authority, poker_game_state },
            remaining_accounts,
            bumps,
        })
    }
}

impl<'info> GenericAnchorAccounts<'info> {
    pub fn load(accounts: &[AccountInfo<'info>]) -> Result<Context<'info, Self>> {
        let mut ix = IxCursor::new(accounts, crate::ID);
        let signer = ix.signer(true)?;
        let remaining_accounts = ix.rest();
        let bumps = ix.bumps;
        Ok(Context {
            program_id: crate::ID,
            accounts: Self { signer },
            remaining_accounts,
            bumps,
        })
    }
}

