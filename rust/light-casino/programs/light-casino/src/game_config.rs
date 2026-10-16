//! Game config mirrored from table state onto light-casino `GameState`.

use crate::prelude::*;
use shared_zk_ids::{
    deck_fields, n_public_action, n_public_bet, n_public_share, n_public_showdown, n_public_shuffle,
    shuffle_caller_public_inputs, GameConfig as SharedGameConfig, GameKind,
};

/// Validated config stored on `GameState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OnchainGameConfig {
    pub inner: SharedGameConfig,
}

impl OnchainGameConfig {
    pub fn from_raw(kind: u8, shoe_decks: u8, roulette_variant: u8) -> Result<Self> {
        let inner = SharedGameConfig::from_raw(kind, shoe_decks, roulette_variant)
            .ok_or(error!(crate::ErrorCode::InvalidGameConfig))?;
        Ok(Self { inner })
    }

    pub fn from_state(kind: u8, shoe_decks: u8, roulette_variant: u8) -> Result<Self> {
        Self::from_raw(kind, shoe_decks, roulette_variant)
    }

    pub fn kind(self) -> GameKind {
        self.inner.kind
    }

    pub fn shoe_decks(self) -> u8 {
        self.inner.shoe_decks
    }

    pub fn roulette_variant(self) -> u8 {
        self.inner.roulette_variant
    }

    pub fn deck_fields(self) -> usize {
        deck_fields(&self.inner)
    }

    pub fn shuffle_caller_public_inputs(self) -> usize {
        shuffle_caller_public_inputs(&self.inner)
    }

    pub fn n_public_shuffle(self) -> usize {
        n_public_shuffle(&self.inner)
    }

    pub fn n_public_share(self) -> usize {
        n_public_share(&self.inner)
    }

    pub fn n_public_showdown(self) -> usize {
        n_public_showdown(&self.inner)
    }

    pub fn n_public_action(self) -> usize {
        n_public_action(&self.inner)
    }

    pub fn n_public_bet(self) -> Option<usize> {
        n_public_bet(&self.inner)
    }

    pub fn is_roulette(self) -> bool {
        self.inner.kind.is_roulette()
    }

    pub fn shared(self) -> SharedGameConfig {
        self.inner
    }
}
