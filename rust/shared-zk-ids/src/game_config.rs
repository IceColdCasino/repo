//! Shared multi-game table/hand configuration (no Anchor).

/// Casino / poker game kind stored on `TableState` and light-casino `GameState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum GameKind {
    Poker = 0,
    Baccarat = 1,
    Blackjack = 2,
    War = 3,
    Roulette = 4,
    Craps = 5,
    Keno = 6,
    Slots = 7,
    Bingo = 8,
}

impl GameKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Poker),
            1 => Some(Self::Baccarat),
            2 => Some(Self::Blackjack),
            3 => Some(Self::War),
            4 => Some(Self::Roulette),
            5 => Some(Self::Craps),
            6 => Some(Self::Keno),
            7 => Some(Self::Slots),
            8 => Some(Self::Bingo),
            _ => None,
        }
    }

    pub fn is_card_shoe_game(self) -> bool {
        matches!(self, Self::Baccarat | Self::Blackjack | Self::War)
    }

    pub fn is_roulette(self) -> bool {
        matches!(self, Self::Roulette)
    }

    /// Seated house/dealer who must shuffle and cannot place an economic bet.
    /// Poker and bingo have no house seat.
    pub fn needs_house_seat(self) -> bool {
        matches!(
            self,
            Self::Baccarat
                | Self::Roulette
                | Self::Blackjack
                | Self::War
                | Self::Craps
                | Self::Keno
                | Self::Slots
        )
    }

    /// Seats a full table can open, including the house when the game has one.
    /// Slots is 2, blackjack is 8, poker is 10. Every other game is 12.
    pub fn max_players(self) -> u8 {
        match self {
            Self::Slots => 2,
            Self::Blackjack => 8,
            Self::Poker => 10,
            Self::Baccarat
            | Self::War
            | Self::Roulette
            | Self::Craps
            | Self::Keno
            | Self::Bingo => TABLE_MAX_SEATS,
        }
    }

    /// Physical seat kept for the house. Poker and bingo have no reserved seat.
    pub fn house_seat(self) -> Option<u8> {
        if self.needs_house_seat() {
            Some(self.max_players() - 1)
        } else {
            None
        }
    }
}

/// Widest `TableState` seat array. Per-game caps are [`GameKind::max_players`].
pub const TABLE_MAX_SEATS: u8 = 12;

/// Seat cap for a poker-program `num_cards` value.
/// Poker deals 25 cards (10 seats), blackjack 24 (8), slots 3 or 5 reels (2).
/// Every other reveal width uses the 12-seat table.
pub fn max_players_for_reveal_cards(num_cards: u8) -> u8 {
    match num_cards {
        25 => GameKind::Poker.max_players(),
        24 => GameKind::Blackjack.max_players(),
        3 | 5 => GameKind::Slots.max_players(),
        _ => TABLE_MAX_SEATS,
    }
}

/// Number of 52-card decks in the shoe for baccarat / blackjack / war.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ShoeDecks {
    One = 1,
    Six = 6,
    Eight = 8,
}

impl ShoeDecks {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::One),
            6 => Some(Self::Six),
            8 => Some(Self::Eight),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Roulette wheel size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RouletteVariant {
    Eu = 37,
    Us = 38,
}

impl RouletteVariant {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            37 => Some(Self::Eu),
            38 => Some(Self::Us),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Validated table/hand circuit configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameConfig {
    pub kind: GameKind,
    pub shoe_decks: u8,
    pub roulette_variant: u8,
}

impl GameConfig {
    /// Poker: shoe forced to 1, variant 0.
    /// Card casino: shoe ∈ {1,6,8}, variant 0.
    /// Roulette: shoe 0, variant ∈ {37,38}.
    pub fn new(kind: GameKind, shoe_decks: u8, roulette_variant: u8) -> Option<Self> {
        match kind {
            GameKind::Poker => {
                if roulette_variant != 0 {
                    return None;
                }
                Some(Self {
                    kind,
                    shoe_decks: 1,
                    roulette_variant: 0,
                })
            }
            GameKind::Baccarat | GameKind::Blackjack | GameKind::War => {
                if roulette_variant != 0 {
                    return None;
                }
                ShoeDecks::from_u8(shoe_decks)?;
                Some(Self {
                    kind,
                    shoe_decks,
                    roulette_variant: 0,
                })
            }
            GameKind::Roulette => {
                RouletteVariant::from_u8(roulette_variant)?;
                Some(Self {
                    kind,
                    shoe_decks: 0,
                    roulette_variant,
                })
            }
            GameKind::Craps | GameKind::Keno => {
                if roulette_variant != 0 {
                    return None;
                }
                Some(Self {
                    kind,
                    shoe_decks: 0,
                    roulette_variant: 0,
                })
            }
            GameKind::Slots => {
                if roulette_variant != 3 && roulette_variant != 5 {
                    return None;
                }
                Some(Self {
                    kind,
                    shoe_decks: 0,
                    roulette_variant,
                })
            }
            GameKind::Bingo => {
                if roulette_variant != 75 && roulette_variant != 90 {
                    return None;
                }
                Some(Self {
                    kind,
                    shoe_decks: 0,
                    roulette_variant,
                })
            }
        }
    }

    pub fn from_raw(kind: u8, shoe_decks: u8, roulette_variant: u8) -> Option<Self> {
        Self::new(GameKind::from_u8(kind)?, shoe_decks, roulette_variant)
    }
}

/// Cards in the shuffle shoe / wheel.
pub fn shuffle_card_count(config: &GameConfig) -> usize {
    match config.kind {
        GameKind::Poker => 52,
        GameKind::Baccarat | GameKind::Blackjack | GameKind::War => {
            52 * (config.shoe_decks as usize)
        }
        GameKind::Roulette => config.roulette_variant as usize,
        GameKind::Craps => 12,
        GameKind::Keno => 80,
        GameKind::Slots => (config.roulette_variant as usize) * 22,
        GameKind::Bingo => config.roulette_variant as usize,
    }
}

/// Flattened deck field elements: cards × 4.
pub fn deck_fields(config: &GameConfig) -> usize {
    shuffle_card_count(config) * 4
}

/// Public-key width of the shuffle `HashMain` circuit.
/// Slots is a 2-seat `HashPublicKeys(2)`; every other shuffle pads to 12.
pub fn shuffle_key_slots(config: &GameConfig) -> usize {
    match config.kind {
        GameKind::Slots => 2,
        _ => 12,
    }
}

/// Shoe bytes staged on chain, plus the permutation digest in the last field.
/// The Groth16 public inputs are the two proof hashes and the derived input hash,
/// not these limbs.
pub fn shuffle_caller_public_inputs(config: &GameConfig) -> usize {
    deck_fields(config) + 1
}

/// Shuffle proof public inputs: deck hash, permutation hash, derived input hash.
pub fn n_public_shuffle(_config: &GameConfig) -> usize {
    3
}

/// Max deck fields across supported configs (8-deck shoe).
pub const MAX_DECK_FIELDS: usize = 8 * 52 * 4; // 1664
pub const MAX_SHUFFLE_CALLER_PUBLIC_INPUTS: usize = MAX_DECK_FIELDS + 1; // 1665
pub const MAX_SHUFFLE_PUBLIC_INPUTS: usize = MAX_SHUFFLE_CALLER_PUBLIC_INPUTS + 1; // 1666

pub const ROULETTE_SHARE_PUBLIC_INPUTS: usize = 2;
pub const ROULETTE_BET_PUBLIC_INPUTS: usize = 97;
pub const HASHOUT_PUBLIC_INPUTS: usize = 2;
pub const REGISTER_PUBLIC_INPUTS: usize = 6;

/// Circom / zkey short circuit id (without `_main` where applicable for lib names).
/// Full zkey names append `_main` for shuffle/register and use `*_hashout_main` for hashouts.
pub fn shuffle_circuit_id(config: &GameConfig) -> Option<&'static str> {
    match config.kind {
        GameKind::Poker => Some("shuffle_1_deck_52_main"),
        GameKind::Baccarat | GameKind::Blackjack | GameKind::War => match config.shoe_decks {
            1 => Some("shuffle_1_deck_52_main"),
            6 => Some("shuffle_6_deck_52_main"),
            8 => Some("shuffle_8_deck_52_main"),
            _ => None,
        },
        GameKind::Roulette => match config.roulette_variant {
            37 => Some("shuffle_1_deck_37_main"),
            38 => Some("shuffle_1_deck_38_main"),
            _ => None,
        },
        GameKind::Craps => Some("shuffle_2_dice_6_main"),
        GameKind::Keno => Some("shuffle_1_deck_80_main"),
        GameKind::Slots => match config.roulette_variant {
            3 => Some("shuffle_3_reel_22_main"),
            5 => Some("shuffle_5_reel_22_main"),
            _ => None,
        },
        GameKind::Bingo => match config.roulette_variant {
            75 => Some("shuffle_1_deck_75_main"),
            90 => Some("shuffle_1_deck_90_main"),
            _ => None,
        },
    }
}

pub fn share_circuit_id(config: &GameConfig) -> Option<&'static str> {
    match config.kind {
        GameKind::Poker => Some("poker_share_hashout_main"),
        GameKind::Baccarat => Some("baccarat_share_hashout_main"),
        GameKind::War => Some("war_share_hashout_main"),
        GameKind::Blackjack => Some("blackjack_share_hashout_main"),
        GameKind::Roulette => Some("roulette_share_hashout_main"),
        GameKind::Craps => Some("craps_share_hashout_main"),
        GameKind::Keno => Some("keno_share_hashout_main"),
        GameKind::Slots => match config.roulette_variant {
            3 => Some("slot_share_3_reel_hashout_main"),
            5 => Some("slot_share_5_reel_hashout_main"),
            _ => None,
        },
        GameKind::Bingo => Some("bingo_share_hashout_main"),
    }
}

pub fn showdown_circuit_id(config: &GameConfig) -> Option<&'static str> {
    match config.kind {
        GameKind::Poker => Some("poker_showdown_hashout_main"),
        GameKind::Baccarat => Some("baccarat_showdown_hashout_main"),
        GameKind::War => Some("war_showdown_hashout_main"),
        GameKind::Blackjack => Some("blackjack_showdown_hashout_main"),
        GameKind::Roulette => match config.roulette_variant {
            37 => Some("roulette_showdown_37_hashout_main"),
            38 => Some("roulette_showdown_38_hashout_main"),
            _ => None,
        },
        GameKind::Craps => Some("craps_showdown_hashout_main"),
        GameKind::Keno => Some("keno_showdown_hashout_main"),
        GameKind::Slots => match config.roulette_variant {
            3 => Some("slot_showdown_3_reel_hashout_main"),
            5 => Some("slot_showdown_5_reel_hashout_main"),
            _ => None,
        },
        GameKind::Bingo => match config.roulette_variant {
            75 => Some("bingo_showdown_75_hashout_main"),
            90 => Some("bingo_showdown_90_hashout_main"),
            _ => None,
        },
    }
}

pub fn action_circuit_id(config: &GameConfig) -> Option<&'static str> {
    match config.kind {
        GameKind::Blackjack => Some("blackjack_action_hashout_main"),
        _ => None,
    }
}

/// Split bet circuit (encrypted bets + Poseidon hash). Slots keep coin-bet in share.
pub fn bet_circuit_id(config: &GameConfig) -> Option<&'static str> {
    match config.kind {
        GameKind::Roulette => match config.roulette_variant {
            37 => Some("roulette_bet_37_main"),
            38 => Some("roulette_bet_38_main"),
            _ => None,
        },
        GameKind::Craps => Some("craps_bet_main"),
        GameKind::Keno => Some("keno_bet_main"),
        GameKind::Bingo => match config.roulette_variant {
            75 => Some("bingo_card_75_main"),
            90 => Some("bingo_card_90_main"),
            _ => None,
        },
        _ => None,
    }
}

pub fn n_public_bet(config: &GameConfig) -> Option<usize> {
    match config.kind {
        GameKind::Roulette | GameKind::Craps => Some(CRAPS_BET_PUBLIC_INPUTS),
        GameKind::Keno => Some(KENO_BET_PUBLIC_INPUTS),
        GameKind::Bingo => match config.roulette_variant {
            75 => Some(BINGO_CARD_75_PUBLIC_INPUTS),
            90 => Some(BINGO_CARD_90_PUBLIC_INPUTS),
            _ => None,
        },
        _ => None,
    }
}

/// Prover-sealed bet row length (`encryptedBets[0][*][4]`).
pub fn bet_prover_limbs(config: &GameConfig) -> Option<usize> {
    match config.kind {
        GameKind::Roulette | GameKind::Craps => Some(12 * 4),
        GameKind::Keno => Some(20 * 4),
        GameKind::Bingo => match config.roulette_variant {
            75 => Some(BINGO_CARD_75_CELLS * 4),
            90 => Some(BINGO_CARD_90_CELLS * 4),
            _ => None,
        },
        _ => None,
    }
}

pub fn bet_max_n_actual(config: &GameConfig) -> Option<u64> {
    match config.kind {
        GameKind::Roulette | GameKind::Craps => Some(12),
        GameKind::Keno => Some(20),
        GameKind::Bingo => Some(1),
        _ => None,
    }
}

pub const SLOT_SHARE_PUBLIC_INPUTS: usize = 10;
pub const CRAPS_BET_PUBLIC_INPUTS: usize = 97;
pub const KENO_BET_PUBLIC_INPUTS: usize = 161;

pub fn n_public_share(config: &GameConfig) -> usize {
    match config.kind {
        GameKind::Roulette => ROULETTE_SHARE_PUBLIC_INPUTS,
        GameKind::Slots => SLOT_SHARE_PUBLIC_INPUTS,
        _ => HASHOUT_PUBLIC_INPUTS,
    }
}

/// Poker-program `num_cards` for Arcis reveal / showdown materials.
pub fn reveal_card_count(config: &GameConfig) -> u8 {
    showdown_card_count(config)
}

/// Faces per craps die. Share/showdown hash die centers at shoe indices
/// `0` and `CRAPS_FACES_PER_DIE` (die-major `out[nDice][nFaces]`).
pub const CRAPS_FACES_PER_DIE: usize = 6;
/// Stops per slot reel. Share/showdown hash reel centers at `reel * SLOT_STOPS_PER_REEL`.
pub const SLOT_STOPS_PER_REEL: usize = 22;
/// Max sparse deal indices (90-ball bingo shoe).
pub const MAX_SHARE_DEAL_INDICES: usize = 90;

/// Bingo share window (`ShareHashOut(12, 5)`).
pub const BINGO_CHUNK_BALLS: u8 = 5;
pub const BINGO_CARD_75_CELLS: usize = 25;
pub const BINGO_CARD_90_CELLS: usize = 27;
pub const BINGO_CARD_75_PUBLIC_INPUTS: usize = BINGO_CARD_75_CELLS * 4 + 1;
pub const BINGO_CARD_90_PUBLIC_INPUTS: usize = BINGO_CARD_90_CELLS * 4 + 1;

/// Max bingo share chunks: ceil(nBalls / 5) → 15 (75) or 18 (90).
pub fn bingo_share_chunks(variant: u8) -> u8 {
    match variant {
        75 => 15,
        90 => 18,
        _ => 0,
    }
}

pub fn bingo_called_balls(n_share_chunks: u8) -> u16 {
    n_share_chunks as u16 * BINGO_CHUNK_BALLS as u16
}

/// Shoe indices of the shared / showdown deal cards.
///
/// Shuffle stores the full shoe (die-major / reel-major). Share and showdown
/// circuits hash only the centers. RevealedCard PDAs stay compact `0..n-1`.
///
/// Writes `n` indices into `out` and returns `n`. `out` must hold at least
/// [`showdown_card_count`] entries.
pub fn share_deal_card_indices(config: &GameConfig, out: &mut [u16]) -> Option<usize> {
    let n = showdown_card_count(config) as usize;
    if out.len() < n {
        return None;
    }
    match config.kind {
        GameKind::Craps => {
            out[0] = 0;
            out[1] = CRAPS_FACES_PER_DIE as u16;
            Some(2)
        }
        GameKind::Slots => {
            for i in 0..n {
                out[i] = (i * SLOT_STOPS_PER_REEL) as u16;
            }
            Some(n)
        }
        GameKind::Keno => {
            for i in 0..n {
                out[i] = i as u16;
            }
            Some(n)
        }
        GameKind::Roulette
        | GameKind::Baccarat
        | GameKind::War
        | GameKind::Blackjack
        | GameKind::Bingo => {
            for i in 0..n {
                out[i] = i as u16;
            }
            Some(n)
        }
        GameKind::Poker => None,
    }
}

/// Fixed cards folded into the showdown / reveal material commitment.
pub fn showdown_card_count(config: &GameConfig) -> u8 {
    match config.kind {
        GameKind::Poker => 25,
        GameKind::Baccarat => 6,
        GameKind::War => 4,
        GameKind::Blackjack => 24,
        GameKind::Roulette => 1,
        GameKind::Craps => 2,
        GameKind::Keno => 20,
        GameKind::Slots => config.roulette_variant,
        GameKind::Bingo => config.roulette_variant,
    }
}

/// Active polynomial-hash coefficient terms for showdown (pad to [`SHOWDOWN_MAX_COEFFS`]).
/// Every game seals two coefficients. Poker packs its nine winner masks into the first.
pub fn showdown_coeff_count(config: &GameConfig) -> u8 {
    match config.kind {
        GameKind::Poker
        | GameKind::Baccarat
        | GameKind::War
        | GameKind::Blackjack
        | GameKind::Keno
        | GameKind::Slots
        | GameKind::Roulette
        | GameKind::Craps
        | GameKind::Bingo => 2,
    }
}

/// Ciphertext slots in every showdown seal account. The polynomial and the
/// seal weights use the first `showdown_coeff_count` slots. Later slots are
/// not weighted.
pub const SHOWDOWN_MAX_COEFFS: u8 = 14;

/// Blackjack share chunk size (`ShareHashOut(8, 16)`).
pub const BLACKJACK_CHUNK_SHARE_CARDS: u8 = 16;
/// Max blackjack share chunks over `MAX_SHARE_CARDS=290`.
pub const BLACKJACK_MAX_SHARE_CHUNKS: u8 = 19;

/// Blackjack share chunks for `n_seats` (players + dealer).
/// Base 2 chunks (32 cards ≥ 24 showdown); scales 1:1 with seats; cap 19.
pub fn blackjack_share_chunks_for_seats(n_seats: u8) -> u8 {
    n_seats.clamp(2, BLACKJACK_MAX_SHARE_CHUNKS)
}

/// Active blackjack share cards for a seat count (`chunks * 16`).
pub fn blackjack_share_card_count(n_seats: u8) -> u16 {
    blackjack_share_chunks_for_seats(n_seats) as u16 * BLACKJACK_CHUNK_SHARE_CARDS as u16
}

pub fn n_public_showdown(_config: &GameConfig) -> usize {
    HASHOUT_PUBLIC_INPUTS
}

pub fn n_public_action(config: &GameConfig) -> usize {
    match config.kind {
        GameKind::Blackjack => 3,
        _ => HASHOUT_PUBLIC_INPUTS,
    }
}

/// Poseidon deck-hash of the canonical ElGamal initial shoe for a config.
///
/// Card values are `Base8 * (card + 1)`. A 1-deck shoe is `0..51`. A 6- or
/// 8-deck shoe is that same block repeated once per deck, not `0 .. 52·n − 1`.
pub fn shuffle_initial_deck_hash(config: &GameConfig) -> Option<[u8; 32]> {
    match (config.kind, config.shoe_decks, config.roulette_variant) {
        (GameKind::Poker, _, _)
        | (GameKind::Baccarat | GameKind::Blackjack | GameKind::War, 1, _) => {
            Some(crate::SHUFFLE_INITIAL_DECK_HASH)
        }
        (GameKind::Baccarat | GameKind::Blackjack | GameKind::War, 6, _) => {
            Some(SHUFFLE_INITIAL_DECK_HASH_6)
        }
        (GameKind::Baccarat | GameKind::Blackjack | GameKind::War, 8, _) => {
            Some(SHUFFLE_INITIAL_DECK_HASH_8)
        }
        (GameKind::Roulette, _, 37) => Some(SHUFFLE_INITIAL_DECK_HASH_37),
        (GameKind::Roulette, _, 38) => Some(SHUFFLE_INITIAL_DECK_HASH_38),
        (GameKind::Craps, _, _) => Some(SHUFFLE_INITIAL_DECK_HASH_2_DICE_6),
        (GameKind::Keno, _, _) => Some(SHUFFLE_INITIAL_DECK_HASH_80),
        (GameKind::Slots, _, 3) => Some(SHUFFLE_INITIAL_DECK_HASH_3_REEL_22),
        (GameKind::Slots, _, 5) => Some(SHUFFLE_INITIAL_DECK_HASH_5_REEL_22),
        (GameKind::Bingo, _, 75) => Some(SHUFFLE_INITIAL_DECK_HASH_75),
        (GameKind::Bingo, _, 90) => Some(SHUFFLE_INITIAL_DECK_HASH_90),
        _ => None,
    }
}

/// 6-deck shoe: `0..51` repeated six times.
pub const SHUFFLE_INITIAL_DECK_HASH_6: [u8; 32] = [
    0x25, 0xbc, 0x10, 0x52, 0x06, 0xc4, 0x1c, 0xd9, 0xab, 0x47, 0x87, 0xb3, 0xa3, 0x93, 0x8f, 0xbb,
    0x6b, 0x7c, 0x4d, 0x35, 0x6c, 0x7d, 0xd4, 0xe4, 0xa9, 0x9d, 0x24, 0x6a, 0x98, 0x55, 0x9d, 0xc3,
];

/// 8-deck shoe: `0..51` repeated eight times.
pub const SHUFFLE_INITIAL_DECK_HASH_8: [u8; 32] = [
    0x02, 0xd5, 0xc9, 0x0a, 0x3b, 0x86, 0x29, 0x4f, 0x09, 0xfb, 0x4e, 0x37, 0xf2, 0xfa, 0xce, 0x68,
    0xc1, 0xa7, 0x66, 0x2f, 0xfc, 0x7a, 0x29, 0x9f, 0xfb, 0xa5, 0x81, 0x4f, 0x30, 0x9a, 0x26, 0xdc,
];

/// European roulette (37) initial wheel hash.
pub const SHUFFLE_INITIAL_DECK_HASH_37: [u8; 32] = [
    0x23, 0x32, 0xda, 0xa3, 0xe0, 0x66, 0xc8, 0xac, 0xa1, 0x98, 0xc9, 0x8b, 0x9f, 0xe6, 0x82, 0x21,
    0xf3, 0x1a, 0xdd, 0x48, 0xa7, 0x8a, 0x31, 0xdd, 0xfe, 0xb4, 0x65, 0x34, 0xe0, 0x74, 0xfc, 0x13,
];

/// American roulette (38) initial wheel hash.
pub const SHUFFLE_INITIAL_DECK_HASH_38: [u8; 32] = [
    0x08, 0x99, 0xb7, 0x67, 0xea, 0x94, 0x0f, 0x98, 0xfc, 0xdc, 0x54, 0xf8, 0x20, 0x67, 0xfd, 0x07,
    0xbf, 0x95, 0xf9, 0x21, 0x05, 0xb6, 0x3a, 0x6d, 0x38, 0xa0, 0xc5, 0xa4, 0x0b, 0x26, 0x2f, 0x17,
];

/// Two independent 6-face dice (12 identity ciphertexts).
pub const SHUFFLE_INITIAL_DECK_HASH_2_DICE_6: [u8; 32] = [
    0x1c, 0xe8, 0x5f, 0x8f, 0xa2, 0x1d, 0xfb, 0x7d, 0xf4, 0xb8, 0xba, 0x50, 0xf7, 0x55, 0x15, 0xb0,
    0x34, 0xb7, 0x23, 0x4a, 0xda, 0xd8, 0x66, 0x2c, 0xf1, 0xba, 0xfe, 0xcc, 0x2a, 0x4b, 0x34, 0x50,
];

/// 80-ball keno identity shoe.
pub const SHUFFLE_INITIAL_DECK_HASH_80: [u8; 32] = [
    0x2a, 0xfc, 0xe9, 0x20, 0x59, 0xf3, 0x78, 0xe0, 0x94, 0xd5, 0xed, 0x88, 0xcc, 0xef, 0x08, 0xa9,
    0x06, 0xe2, 0x3a, 0x05, 0x89, 0x96, 0x61, 0x69, 0x1b, 0x2c, 0x1c, 0xcf, 0xe3, 0x77, 0x74, 0x38,
];

/// 3 × 22-stop slot identity strips.
pub const SHUFFLE_INITIAL_DECK_HASH_3_REEL_22: [u8; 32] = [
    0x07, 0xe2, 0xce, 0xc7, 0x3c, 0x9c, 0x46, 0x6a, 0x59, 0xe0, 0x23, 0x68, 0x59, 0x0e, 0x84, 0xe5,
    0x90, 0xe4, 0x2d, 0x8c, 0xcd, 0x42, 0xae, 0x28, 0x8a, 0xdf, 0x95, 0x77, 0xb7, 0xcb, 0x45, 0x01,
];

/// 75-ball bingo identity shoe.
pub const SHUFFLE_INITIAL_DECK_HASH_75: [u8; 32] = [
    0x10, 0xf6, 0x33, 0xef, 0x4d, 0xbd, 0x77, 0x4f, 0xa2, 0x97, 0xda, 0xa8, 0xfc, 0x99, 0x4c, 0x15,
    0x41, 0x00, 0xd2, 0xa3, 0x9a, 0x0f, 0x8b, 0xe0, 0x33, 0x31, 0xe3, 0x79, 0x7d, 0x6c, 0x2e, 0xe9,
];

/// 90-ball bingo identity shoe.
pub const SHUFFLE_INITIAL_DECK_HASH_90: [u8; 32] = [
    0x0b, 0x1a, 0xbd, 0x4b, 0x3b, 0xa9, 0xd2, 0x39, 0xa0, 0xf8, 0xd0, 0x7e, 0x99, 0xba, 0xb1, 0xd6,
    0x06, 0xbc, 0x1c, 0x90, 0x17, 0x05, 0xa0, 0x22, 0x61, 0xac, 0xec, 0x90, 0xbf, 0x18, 0x26, 0xb1,
];

/// 5 × 22-stop slot identity strips.
pub const SHUFFLE_INITIAL_DECK_HASH_5_REEL_22: [u8; 32] = [
    0x15, 0x01, 0x85, 0x36, 0xe3, 0xf7, 0x8e, 0xb1, 0x62, 0x69, 0x7a, 0x02, 0x0e, 0x12, 0xa6, 0x11,
    0xf0, 0x38, 0x5c, 0xfc, 0x43, 0xe8, 0x68, 0xd0, 0xc7, 0x3b, 0xce, 0xa9, 0x9b, 0x5e, 0x65, 0xb9,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poker_config_forces_single_deck() {
        let c = GameConfig::new(GameKind::Poker, 6, 0).unwrap();
        assert_eq!(c.shoe_decks, 1);
        assert_eq!(shuffle_circuit_id(&c), Some("shuffle_1_deck_52_main"));
        assert_eq!(n_public_shuffle(&c), 3);
        assert_eq!(deck_fields(&c), 208);
    }

    #[test]
    fn multi_deck_initial_hash_follows_shoe() {
        for kind in [GameKind::Baccarat, GameKind::Blackjack, GameKind::War] {
            let one = GameConfig::new(kind, 1, 0).unwrap();
            let six = GameConfig::new(kind, 6, 0).unwrap();
            let eight = GameConfig::new(kind, 8, 0).unwrap();
            assert_eq!(
                shuffle_initial_deck_hash(&one),
                Some(crate::SHUFFLE_INITIAL_DECK_HASH)
            );
            assert_eq!(shuffle_initial_deck_hash(&six), Some(SHUFFLE_INITIAL_DECK_HASH_6));
            assert_eq!(shuffle_initial_deck_hash(&eight), Some(SHUFFLE_INITIAL_DECK_HASH_8));
        }
        assert_ne!(SHUFFLE_INITIAL_DECK_HASH_6, crate::SHUFFLE_INITIAL_DECK_HASH);
        assert_ne!(SHUFFLE_INITIAL_DECK_HASH_8, SHUFFLE_INITIAL_DECK_HASH_6);
    }

    #[test]
    fn shoe_sizes_select_shuffle() {
        let c6 = GameConfig::new(GameKind::War, 6, 0).unwrap();
        assert_eq!(shuffle_circuit_id(&c6), Some("shuffle_6_deck_52_main"));
        assert_eq!(n_public_shuffle(&c6), 3);
        let c8 = GameConfig::new(GameKind::Blackjack, 8, 0).unwrap();
        assert_eq!(shuffle_circuit_id(&c8), Some("shuffle_8_deck_52_main"));
        assert_eq!(n_public_shuffle(&c8), 3);
    }

    #[test]
    fn roulette_variant() {
        let c = GameConfig::new(GameKind::Roulette, 0, 37).unwrap();
        assert_eq!(shuffle_circuit_id(&c), Some("shuffle_1_deck_37_main"));
        assert_eq!(n_public_shuffle(&c), 3);
        assert_eq!(n_public_share(&c), 2);
        assert_eq!(reveal_card_count(&c), 1);
        assert_eq!(showdown_coeff_count(&c), 2);
        assert_eq!(
            share_circuit_id(&c),
            Some("roulette_share_hashout_main")
        );
    }

    #[test]
    fn per_game_card_and_coeff_counts() {
        let poker = GameConfig::new(GameKind::Poker, 1, 0).unwrap();
        assert_eq!(showdown_card_count(&poker), 25);
        assert_eq!(showdown_coeff_count(&poker), 2);
        let bac = GameConfig::new(GameKind::Baccarat, 1, 0).unwrap();
        assert_eq!(showdown_card_count(&bac), 6);
        assert_eq!(showdown_coeff_count(&bac), 2);
        let war = GameConfig::new(GameKind::War, 6, 0).unwrap();
        assert_eq!(showdown_card_count(&war), 4);
        let bj = GameConfig::new(GameKind::Blackjack, 6, 0).unwrap();
        assert_eq!(showdown_card_count(&bj), 24);
        assert_eq!(blackjack_share_chunks_for_seats(2), 2);
        assert_eq!(blackjack_share_card_count(2), 32);
        assert_eq!(blackjack_share_chunks_for_seats(4), 4);
        assert_eq!(blackjack_share_chunks_for_seats(8), 8);
        assert_eq!(blackjack_share_chunks_for_seats(1), 2);
    }

    #[test]
    fn rejects_bad_combos() {
        assert!(GameConfig::new(GameKind::Roulette, 0, 0).is_none());
        assert!(GameConfig::new(GameKind::Baccarat, 2, 0).is_none());
        assert!(GameConfig::new(GameKind::Poker, 1, 37).is_none());
        assert!(GameConfig::new(GameKind::Slots, 0, 4).is_none());
        assert!(GameConfig::new(GameKind::Craps, 0, 37).is_none());
        assert!(GameConfig::new(GameKind::Bingo, 0, 80).is_none());
    }

    #[test]
    fn craps_keno_slots_config() {
        let craps = GameConfig::new(GameKind::Craps, 0, 0).unwrap();
        assert_eq!(shuffle_circuit_id(&craps), Some("shuffle_2_dice_6_main"));
        assert_eq!(shuffle_caller_public_inputs(&craps), 49);
        assert_eq!(n_public_shuffle(&craps), 3);
        assert_eq!(showdown_card_count(&craps), 2);
        let mut idx = [0u16; MAX_SHARE_DEAL_INDICES];
        assert_eq!(share_deal_card_indices(&craps, &mut idx), Some(2));
        assert_eq!(&idx[..2], &[0, 6]);
        assert_eq!(showdown_coeff_count(&craps), 2);
        assert_eq!(share_circuit_id(&craps), Some("craps_share_hashout_main"));

        let keno = GameConfig::new(GameKind::Keno, 0, 0).unwrap();
        assert_eq!(shuffle_circuit_id(&keno), Some("shuffle_1_deck_80_main"));
        assert_eq!(n_public_shuffle(&keno), 3);
        assert_eq!(showdown_card_count(&keno), 20);
        assert_eq!(showdown_coeff_count(&keno), 2);

        assert!(GameKind::Slots.needs_house_seat());
        assert!(GameKind::Craps.needs_house_seat());
        assert!(GameKind::Baccarat.needs_house_seat());
        assert!(GameKind::War.needs_house_seat());
        assert!(!GameKind::Poker.needs_house_seat());
        assert_eq!(GameKind::Slots.max_players(), 2);
        assert_eq!(GameKind::Blackjack.max_players(), 8);
        assert_eq!(GameKind::Poker.max_players(), 10);
        assert_eq!(GameKind::Baccarat.max_players(), 12);
        assert_eq!(GameKind::Bingo.max_players(), 12);
        assert_eq!(GameKind::Baccarat.house_seat(), Some(11));
        assert_eq!(GameKind::Blackjack.house_seat(), Some(7));
        assert_eq!(GameKind::Slots.house_seat(), Some(1));
        assert_eq!(GameKind::Poker.house_seat(), None);
        assert_eq!(GameKind::Bingo.house_seat(), None);
        assert_eq!(max_players_for_reveal_cards(25), 10);
        assert_eq!(max_players_for_reveal_cards(24), 8);
        assert_eq!(max_players_for_reveal_cards(3), 2);
        assert_eq!(max_players_for_reveal_cards(5), 2);
        assert_eq!(max_players_for_reveal_cards(6), 12);
        assert_eq!(max_players_for_reveal_cards(75), 12);
        let s3 = GameConfig::new(GameKind::Slots, 0, 3).unwrap();
        assert_eq!(shuffle_circuit_id(&s3), Some("shuffle_3_reel_22_main"));
        assert_eq!(n_public_shuffle(&s3), 3);
        assert_eq!(n_public_share(&s3), 10);
        assert_eq!(showdown_card_count(&s3), 3);
        assert_eq!(share_deal_card_indices(&s3, &mut idx), Some(3));
        assert_eq!(&idx[..3], &[0, 22, 44]);
        let s5 = GameConfig::new(GameKind::Slots, 0, 5).unwrap();
        assert_eq!(n_public_shuffle(&s5), 3);
        assert_eq!(showdown_card_count(&s5), 5);
        assert_eq!(share_deal_card_indices(&s5, &mut idx), Some(5));
        assert_eq!(&idx[..5], &[0, 22, 44, 66, 88]);
    }

    #[test]
    fn bingo_config() {
        assert!(!GameKind::Bingo.needs_house_seat());
        let b75 = GameConfig::new(GameKind::Bingo, 0, 75).unwrap();
        assert_eq!(b75.shoe_decks, 0);
        assert_eq!(shuffle_circuit_id(&b75), Some("shuffle_1_deck_75_main"));
        assert_eq!(n_public_shuffle(&b75), 3);
        assert_eq!(showdown_card_count(&b75), 75);
        assert_eq!(showdown_coeff_count(&b75), 2);
        assert_eq!(share_circuit_id(&b75), Some("bingo_share_hashout_main"));
        assert_eq!(
            showdown_circuit_id(&b75),
            Some("bingo_showdown_75_hashout_main")
        );
        assert_eq!(bet_circuit_id(&b75), Some("bingo_card_75_main"));
        assert_eq!(n_public_bet(&b75), Some(BINGO_CARD_75_PUBLIC_INPUTS));
        assert_eq!(bingo_share_chunks(75), 15);
        assert_eq!(bingo_called_balls(1), 5);
        let mut idx = [0u16; MAX_SHARE_DEAL_INDICES];
        assert_eq!(share_deal_card_indices(&b75, &mut idx), Some(75));
        assert_eq!(idx[0], 0);
        assert_eq!(idx[74], 74);

        let b90 = GameConfig::new(GameKind::Bingo, 0, 90).unwrap();
        assert_eq!(shuffle_circuit_id(&b90), Some("shuffle_1_deck_90_main"));
        assert_eq!(n_public_shuffle(&b90), 3);
        assert_eq!(showdown_card_count(&b90), 90);
        assert_eq!(showdown_coeff_count(&b90), 2);
        assert_eq!(bingo_share_chunks(90), 18);
        assert_eq!(n_public_bet(&b90), Some(BINGO_CARD_90_PUBLIC_INPUTS));
        assert_eq!(shuffle_key_slots(&b90), 12);
    }
}
