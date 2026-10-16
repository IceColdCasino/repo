//! Select Groth16 verifying keys from on-chain game config + proof phase.

use groth16_solana::groth16::Groth16Verifyingkey;
use shared_zk_ids::{
    action_circuit_id, bet_circuit_id, n_public_action, n_public_bet, n_public_share,
    n_public_showdown, n_public_shuffle, share_circuit_id, showdown_circuit_id, shuffle_circuit_id,
    GameConfig, REGISTER_PUBLIC_INPUTS,
};

use crate::verifying_keys;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VkPhase {
    Register,
    Shuffle,
    Share,
    Showdown,
    Action,
    Bet,
}

pub struct VkEntry {
    pub circuit_id: &'static str,
    pub nr_pubinputs: usize,
    pub vk: &'static Groth16Verifyingkey<'static>,
}

fn vk_by_id(id: &str) -> Option<&'static Groth16Verifyingkey<'static>> {
    Some(match id {
        "register_main" => &verifying_keys::register_main::VERIFYING_KEY,
        "shuffle_1_deck_52_main" => &verifying_keys::shuffle::shuffle_1_deck_52_main::VERIFYING_KEY,
        "shuffle_6_deck_52_main" => &verifying_keys::shuffle::shuffle_6_deck_52_main::VERIFYING_KEY,
        "shuffle_8_deck_52_main" => &verifying_keys::shuffle::shuffle_8_deck_52_main::VERIFYING_KEY,
        "shuffle_1_deck_37_main" => &verifying_keys::roulette::shuffle_1_deck_37_main::VERIFYING_KEY,
        "shuffle_1_deck_38_main" => &verifying_keys::roulette::shuffle_1_deck_38_main::VERIFYING_KEY,
        "poker_share_hashout_main" => &verifying_keys::poker::poker_share_hashout_main::VERIFYING_KEY,
        "poker_showdown_hashout_main" => {
            &verifying_keys::poker::poker_showdown_hashout_main::VERIFYING_KEY
        }
        "baccarat_share_hashout_main" => {
            &verifying_keys::baccarat::baccarat_share_hashout_main::VERIFYING_KEY
        }
        "baccarat_showdown_hashout_main" => {
            &verifying_keys::baccarat::baccarat_showdown_hashout_main::VERIFYING_KEY
        }
        "war_share_hashout_main" => &verifying_keys::war::war_share_hashout_main::VERIFYING_KEY,
        "war_showdown_hashout_main" => &verifying_keys::war::war_showdown_hashout_main::VERIFYING_KEY,
        "blackjack_share_hashout_main" => {
            &verifying_keys::blackjack::blackjack_share_hashout_main::VERIFYING_KEY
        }
        "blackjack_action_hashout_main" => {
            &verifying_keys::blackjack::blackjack_action_hashout_main::VERIFYING_KEY
        }
        "blackjack_showdown_hashout_main" => {
            &verifying_keys::blackjack::blackjack_showdown_hashout_main::VERIFYING_KEY
        }
        "roulette_share_hashout_main" => {
            &verifying_keys::roulette::roulette_share_hashout_main::VERIFYING_KEY
        }
        "roulette_bet_37_main" => &verifying_keys::roulette::roulette_bet_37_main::VERIFYING_KEY,
        "roulette_bet_38_main" => &verifying_keys::roulette::roulette_bet_38_main::VERIFYING_KEY,
        "roulette_showdown_37_hashout_main" => {
            &verifying_keys::roulette::roulette_showdown_37_hashout_main::VERIFYING_KEY
        }
        "roulette_showdown_38_hashout_main" => {
            &verifying_keys::roulette::roulette_showdown_38_hashout_main::VERIFYING_KEY
        }
        "shuffle_2_dice_6_main" => &verifying_keys::craps::shuffle_2_dice_6_main::VERIFYING_KEY,
        "shuffle_1_deck_80_main" => &verifying_keys::keno::shuffle_1_deck_80_main::VERIFYING_KEY,
        "shuffle_3_reel_22_main" => &verifying_keys::slots::shuffle_3_reel_22_main::VERIFYING_KEY,
        "shuffle_5_reel_22_main" => &verifying_keys::slots::shuffle_5_reel_22_main::VERIFYING_KEY,
        "craps_share_hashout_main" => &verifying_keys::craps::craps_share_hashout_main::VERIFYING_KEY,
        "craps_bet_main" => &verifying_keys::craps::craps_bet_main::VERIFYING_KEY,
        "craps_showdown_hashout_main" => {
            &verifying_keys::craps::craps_showdown_hashout_main::VERIFYING_KEY
        }
        "keno_share_hashout_main" => &verifying_keys::keno::keno_share_hashout_main::VERIFYING_KEY,
        "keno_bet_main" => &verifying_keys::keno::keno_bet_main::VERIFYING_KEY,
        "keno_showdown_hashout_main" => {
            &verifying_keys::keno::keno_showdown_hashout_main::VERIFYING_KEY
        }
        "slot_share_3_reel_hashout_main" => {
            &verifying_keys::slots::slot_share_3_reel_hashout_main::VERIFYING_KEY
        }
        "slot_share_5_reel_hashout_main" => {
            &verifying_keys::slots::slot_share_5_reel_hashout_main::VERIFYING_KEY
        }
        "slot_showdown_3_reel_hashout_main" => {
            &verifying_keys::slots::slot_showdown_3_reel_hashout_main::VERIFYING_KEY
        }
        "slot_showdown_5_reel_hashout_main" => {
            &verifying_keys::slots::slot_showdown_5_reel_hashout_main::VERIFYING_KEY
        }
        "shuffle_1_deck_75_main" => &verifying_keys::bingo::shuffle_1_deck_75_main::VERIFYING_KEY,
        "shuffle_1_deck_90_main" => &verifying_keys::bingo::shuffle_1_deck_90_main::VERIFYING_KEY,
        "bingo_share_hashout_main" => &verifying_keys::bingo::bingo_share_hashout_main::VERIFYING_KEY,
        "bingo_showdown_75_hashout_main" => {
            &verifying_keys::bingo::bingo_showdown_75_hashout_main::VERIFYING_KEY
        }
        "bingo_showdown_90_hashout_main" => {
            &verifying_keys::bingo::bingo_showdown_90_hashout_main::VERIFYING_KEY
        }
        "bingo_card_75_main" => &verifying_keys::bingo::bingo_card_75_main::VERIFYING_KEY,
        "bingo_card_90_main" => &verifying_keys::bingo::bingo_card_90_main::VERIFYING_KEY,
        _ => return None,
    })
}

pub fn register_vk() -> VkEntry {
    VkEntry {
        circuit_id: "register_main",
        nr_pubinputs: REGISTER_PUBLIC_INPUTS,
        vk: &verifying_keys::register_main::VERIFYING_KEY,
    }
}

pub fn lookup(config: &GameConfig, phase: VkPhase) -> Option<VkEntry> {
    let (circuit_id, nr_pubinputs) = match phase {
        VkPhase::Register => return Some(register_vk()),
        VkPhase::Shuffle => (shuffle_circuit_id(config)?, n_public_shuffle(config)),
        VkPhase::Share => (share_circuit_id(config)?, n_public_share(config)),
        VkPhase::Showdown => (showdown_circuit_id(config)?, n_public_showdown(config)),
        VkPhase::Action => (action_circuit_id(config)?, n_public_action(config)),
        VkPhase::Bet => (bet_circuit_id(config)?, n_public_bet(config)?),
    };
    let vk = vk_by_id(circuit_id)?;
    Some(VkEntry {
        circuit_id,
        nr_pubinputs,
        vk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared_zk_ids::{n_public_share, share_circuit_id, GameConfig, GameKind};

    #[test]
    fn poker_defaults() {
        let c = GameConfig::new(GameKind::Poker, 1, 0).unwrap();
        let sh = lookup(&c, VkPhase::Shuffle).unwrap();
        assert_eq!(sh.circuit_id, "shuffle_1_deck_52_main");
        assert_eq!(sh.nr_pubinputs, 3);
        assert_eq!(
            lookup(&c, VkPhase::Share).unwrap().circuit_id,
            "poker_share_hashout_main"
        );
    }

    #[test]
    fn shoe_and_roulette() {
        let c6 = GameConfig::new(GameKind::Baccarat, 6, 0).unwrap();
        assert_eq!(
            lookup(&c6, VkPhase::Shuffle).unwrap().nr_pubinputs,
            3
        );
        let r = GameConfig::new(GameKind::Roulette, 0, 37).unwrap();
        assert_eq!(share_circuit_id(&r), Some("roulette_share_hashout_main"));
        assert_eq!(n_public_share(&r), 2);
        if let Some(share) = lookup(&r, VkPhase::Share) {
            assert_eq!(share.nr_pubinputs, 2);
            assert_eq!(share.circuit_id, "roulette_share_hashout_main");
        }
        let bj = GameConfig::new(GameKind::Blackjack, 8, 0).unwrap();
        assert_eq!(
            lookup(&bj, VkPhase::Action).unwrap().circuit_id,
            "blackjack_action_hashout_main"
        );
        let craps = GameConfig::new(GameKind::Craps, 0, 0).unwrap();
        assert_eq!(
            lookup(&craps, VkPhase::Share).unwrap().circuit_id,
            "craps_share_hashout_main"
        );
        assert_eq!(
            lookup(&craps, VkPhase::Bet).unwrap().circuit_id,
            "craps_bet_main"
        );
        let keno = GameConfig::new(GameKind::Keno, 0, 0).unwrap();
        assert_eq!(lookup(&keno, VkPhase::Bet).unwrap().nr_pubinputs, 161);
        let slots = GameConfig::new(GameKind::Slots, 0, 3).unwrap();
        assert_eq!(lookup(&slots, VkPhase::Share).unwrap().nr_pubinputs, 10);
        let bingo = GameConfig::new(GameKind::Bingo, 0, 75).unwrap();
        assert_eq!(
            lookup(&bingo, VkPhase::Bet).unwrap().circuit_id,
            "bingo_card_75_main"
        );
        assert_eq!(lookup(&bingo, VkPhase::Bet).unwrap().nr_pubinputs, 101);
        assert_eq!(
            lookup(&bingo, VkPhase::Shuffle).unwrap().circuit_id,
            "shuffle_1_deck_75_main"
        );
    }
}
