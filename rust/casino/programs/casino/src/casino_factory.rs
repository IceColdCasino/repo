//! Casino factory.
//!
//! CAdmin creates a `Casino` account bound to this program and light-casino.
//! That account is the tenant allowed to use the protocol. CAdmin then
//! delegates `CasinoAdmin` keys. Those keys create rooms and tables for the
//! casino and register one dealer key per game kind.

use anchor_lang::prelude::*;
use shared_zk_ids::{GameKind, LIGHT_CASINO_PROGRAM_ID};
use std::str::FromStr;

use crate::room::Room;
use crate::whitelist::WHITELIST_ADMIN;
use crate::ErrorCode;

pub const CASINO_SEED: &[u8] = b"casino";
pub const CASINO_ADMIN_SEED: &[u8] = b"casino_admin";
pub const CASINO_DEALER_SEED: &[u8] = b"casino_dealer";

#[account]
#[derive(InitSpace)]
pub struct Casino {
    pub casino_id: [u8; 32],
    /// This deployment. CPI into room and table instructions stays on this program.
    pub casino_program: Pubkey,
    /// Proof program this tenant may use.
    pub light_casino_program: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CasinoAdmin {
    pub casino_id: [u8; 32],
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CasinoDealer {
    pub casino_id: [u8; 32],
    pub game_kind: u8,
    pub dealer: Pubkey,
    pub bump: u8,
}

pub fn light_casino_program() -> Pubkey {
    Pubkey::from_str(LIGHT_CASINO_PROGRAM_ID).expect("light-casino program id")
}

pub fn require_protocol_casino(casino: &Casino) -> Result<()> {
    require_keys_eq!(
        casino.casino_program,
        crate::ID,
        ErrorCode::UnauthorizedCpiCaller
    );
    require_keys_eq!(
        casino.light_casino_program,
        light_casino_program(),
        ErrorCode::UnauthorizedCpiCaller
    );
    Ok(())
}

fn load_owned<T: AccountDeserialize>(info: &AccountInfo, err: ErrorCode) -> Result<T> {
    require_keys_eq!(*info.owner, crate::ID, err);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    T::try_deserialize(&mut slice).map_err(|_| error!(err))
}

fn require_casino_account(info: &AccountInfo) -> Result<Casino> {
    let casino: Casino = load_owned(info, ErrorCode::InvalidCasino)?;
    let (expected, _) =
        Pubkey::find_program_address(&[CASINO_SEED, &casino.casino_id], &crate::ID);
    require_keys_eq!(info.key(), expected, ErrorCode::InvalidCasino);
    require_protocol_casino(&casino)?;
    Ok(casino)
}

/// Signer is a delegated admin of the casino in `remaining[0]`.
/// `remaining[1]` is that admin's `CasinoAdmin` PDA.
pub fn require_casino_operator(signer: &Pubkey, remaining: &[AccountInfo]) -> Result<Pubkey> {
    require!(remaining.len() >= 2, ErrorCode::NotCasinoAdmin);
    let casino = require_casino_account(&remaining[0])?;
    let (expected, _) = Pubkey::find_program_address(
        &[CASINO_ADMIN_SEED, &casino.casino_id, signer.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(remaining[1].key(), expected, ErrorCode::NotCasinoAdmin);
    let admin: CasinoAdmin = load_owned(&remaining[1], ErrorCode::NotCasinoAdmin)?;
    require!(admin.casino_id == casino.casino_id, ErrorCode::NotCasinoAdmin);
    require_keys_eq!(admin.admin, *signer, ErrorCode::NotCasinoAdmin);
    Ok(remaining[0].key())
}

/// Authority stored on a new room.
/// CAdmin with no extra accounts keeps a legacy room.
/// CAdmin may also pass a Casino account and open the room under that tenant.
/// A delegated admin passes the Casino account and their CasinoAdmin PDA.
pub fn bind_room_authority(signer: &Pubkey, remaining: &[AccountInfo]) -> Result<Pubkey> {
    if *signer == WHITELIST_ADMIN && remaining.is_empty() {
        return Ok(WHITELIST_ADMIN);
    }
    if *signer == WHITELIST_ADMIN && remaining.len() == 1 {
        let _ = require_casino_account(&remaining[0])?;
        return Ok(remaining[0].key());
    }
    require_casino_operator(signer, remaining)
}

/// CAdmin may administer any room. A delegated admin may administer rooms
/// whose `authority` is their casino.
pub fn authorize_room_operator(
    signer: &Pubkey,
    room_authority: &Pubkey,
    remaining: &[AccountInfo],
) -> Result<()> {
    if *signer == WHITELIST_ADMIN {
        return Ok(());
    }
    let casino = require_casino_operator(signer, remaining)?;
    require_keys_eq!(casino, *room_authority, ErrorCode::NotCasinoAdmin);
    Ok(())
}

/// `remove_from_whitelist` has no room account. A delegated admin passes
/// `[room, casino, casino_admin]`.
pub fn authorize_whitelist_removal(
    signer: &Pubkey,
    entry_room_id: &[u8; 32],
    remaining: &[AccountInfo],
) -> Result<()> {
    if *signer == WHITELIST_ADMIN && remaining.is_empty() {
        return Ok(());
    }
    require!(remaining.len() >= 3, ErrorCode::NotCasinoAdmin);
    let room: Room = load_owned(&remaining[0], ErrorCode::NotCasinoAdmin)?;
    require!(room.room_id == *entry_room_id, ErrorCode::NotCasinoAdmin);
    let (expected, _) = Pubkey::find_program_address(&[b"room", entry_room_id], &crate::ID);
    require_keys_eq!(remaining[0].key(), expected, ErrorCode::NotCasinoAdmin);
    authorize_room_operator(signer, &room.authority, &remaining[1..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;

    struct OwnedAccount {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
    }

    impl OwnedAccount {
        fn serialized(key: Pubkey, owner: Pubkey, value: &impl AccountSerialize) -> Self {
            let mut data = Vec::new();
            value.try_serialize(&mut data).unwrap();
            Self {
                key,
                owner,
                lamports: 1_000_000,
                data,
            }
        }

        fn info(&mut self) -> AccountInfo<'_> {
            AccountInfo::new(
                &self.key,
                false,
                true,
                &mut self.lamports,
                &mut self.data,
                &self.owner,
                false,
            )
        }
    }

    struct Tenant {
        casino_id: [u8; 32],
        casino_key: Pubkey,
        admin: Pubkey,
        admin_key: Pubkey,
    }

    impl Tenant {
        fn new(casino_id: [u8; 32], admin: Pubkey) -> Self {
            let (casino_key, _) =
                Pubkey::find_program_address(&[CASINO_SEED, &casino_id], &crate::ID);
            let (admin_key, _) = Pubkey::find_program_address(
                &[CASINO_ADMIN_SEED, &casino_id, admin.as_ref()],
                &crate::ID,
            );
            Self {
                casino_id,
                casino_key,
                admin,
                admin_key,
            }
        }

        fn casino(&self) -> Casino {
            Casino {
                casino_id: self.casino_id,
                casino_program: crate::ID,
                light_casino_program: light_casino_program(),
                bump: 0,
            }
        }

        fn admin_entry(&self) -> CasinoAdmin {
            CasinoAdmin {
                casino_id: self.casino_id,
                admin: self.admin,
                bump: 0,
            }
        }

        fn accounts(&self) -> (OwnedAccount, OwnedAccount) {
            (
                OwnedAccount::serialized(self.casino_key, crate::ID, &self.casino()),
                OwnedAccount::serialized(self.admin_key, crate::ID, &self.admin_entry()),
            )
        }
    }

    fn reject(result: Result<impl std::fmt::Debug>, marker: &str) {
        let text = result.expect_err("expected rejection").to_string();
        assert!(text.contains(marker), "expected {marker} in {text}");
    }

    #[test]
    fn dealer_registration_accepts_each_game_kind() {
        for kind in 0..=8 {
            assert!(GameKind::from_u8(kind).is_some());
        }
        assert!(GameKind::from_u8(9).is_none());
    }

    #[test]
    fn casino_account_is_bound_to_both_protocol_programs() {
        let casino = Casino {
            casino_id: [1u8; 32],
            casino_program: crate::ID,
            light_casino_program: light_casino_program(),
            bump: 0,
        };
        assert!(require_protocol_casino(&casino).is_ok());
        let mut other = casino;
        other.casino_program = Pubkey::new_unique();
        assert!(require_protocol_casino(&other).is_err());
        other.casino_program = crate::ID;
        other.light_casino_program = Pubkey::new_unique();
        assert!(require_protocol_casino(&other).is_err());
    }

    #[test]
    fn only_the_delegated_admin_can_operate_the_casino() {
        let tenant = Tenant::new([4u8; 32], Pubkey::new_unique());
        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        assert_eq!(
            require_casino_operator(&tenant.admin, &infos).unwrap(),
            tenant.casino_key
        );

        let stranger = Pubkey::new_unique();
        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(require_casino_operator(&stranger, &infos), "NotCasinoAdmin");

        let (mut casino_acc, _) = tenant.accounts();
        let infos = [casino_acc.info()];
        reject(require_casino_operator(&tenant.admin, &infos), "NotCasinoAdmin");
    }

    #[test]
    fn an_admin_of_one_casino_cannot_operate_another() {
        let first = Tenant::new([1u8; 32], Pubkey::new_unique());
        let second = Tenant::new([2u8; 32], Pubkey::new_unique());
        let (mut other_casino, mut own_admin) = (
            OwnedAccount::serialized(second.casino_key, crate::ID, &second.casino()),
            OwnedAccount::serialized(first.admin_key, crate::ID, &first.admin_entry()),
        );
        let infos = [other_casino.info(), own_admin.info()];
        reject(require_casino_operator(&first.admin, &infos), "NotCasinoAdmin");
    }

    #[test]
    fn a_casino_admin_record_for_the_wrong_tenant_is_rejected() {
        let tenant = Tenant::new([5u8; 32], Pubkey::new_unique());
        let mut entry = tenant.admin_entry();
        entry.casino_id = [9u8; 32];
        let (mut casino_acc, mut admin_acc) = (
            OwnedAccount::serialized(tenant.casino_key, crate::ID, &tenant.casino()),
            OwnedAccount::serialized(tenant.admin_key, crate::ID, &entry),
        );
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(require_casino_operator(&tenant.admin, &infos), "NotCasinoAdmin");
    }

    #[test]
    fn only_a_delegated_admin_can_register_a_dealer_or_open_a_room() {
        let tenant = Tenant::new([6u8; 32], Pubkey::new_unique());
        let stranger = Pubkey::new_unique();

        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        assert_eq!(
            bind_room_authority(&tenant.admin, &infos).unwrap(),
            tenant.casino_key
        );

        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(bind_room_authority(&stranger, &infos), "NotCasinoAdmin");

        reject(bind_room_authority(&stranger, &[]), "NotCasinoAdmin");

        assert_eq!(bind_room_authority(&WHITELIST_ADMIN, &[]).unwrap(), WHITELIST_ADMIN);
        let (mut casino_acc, _) = tenant.accounts();
        let infos = [casino_acc.info()];
        assert_eq!(
            bind_room_authority(&WHITELIST_ADMIN, &infos).unwrap(),
            tenant.casino_key
        );
    }

    #[test]
    fn only_the_owning_admin_can_create_tables_and_whitelist_players() {
        let tenant = Tenant::new([7u8; 32], Pubkey::new_unique());
        let other = Tenant::new([8u8; 32], Pubkey::new_unique());
        let stranger = Pubkey::new_unique();

        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        authorize_room_operator(&tenant.admin, &tenant.casino_key, &infos).unwrap();

        authorize_room_operator(&WHITELIST_ADMIN, &tenant.casino_key, &[]).unwrap();

        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(
            authorize_room_operator(&stranger, &tenant.casino_key, &infos),
            "NotCasinoAdmin",
        );

        let (mut casino_acc, mut admin_acc) = other.accounts();
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(
            authorize_room_operator(&other.admin, &tenant.casino_key, &infos),
            "NotCasinoAdmin",
        );
    }

    #[test]
    fn only_the_owning_admin_can_remove_a_player_whitelist_entry() {
        let tenant = Tenant::new([3u8; 32], Pubkey::new_unique());
        let room_id = [11u8; 32];
        let (room_key, _) = Pubkey::find_program_address(&[b"room", &room_id], &crate::ID);
        let room = Room {
            room_id,
            authority: tenant.casino_key,
            mint: Pubkey::default(),
            vault: Pubkey::default(),
            table_count: 0,
            small_blind_default: 0,
            rake_bps: 0,
            house: Pubkey::default(),
        };

        let mut room_acc = OwnedAccount::serialized(room_key, crate::ID, &room);
        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [room_acc.info(), casino_acc.info(), admin_acc.info()];
        authorize_whitelist_removal(&tenant.admin, &room_id, &infos).unwrap();

        authorize_whitelist_removal(&WHITELIST_ADMIN, &room_id, &[]).unwrap();

        let stranger = Pubkey::new_unique();
        let mut room_acc = OwnedAccount::serialized(room_key, crate::ID, &room);
        let (mut casino_acc, mut admin_acc) = tenant.accounts();
        let infos = [room_acc.info(), casino_acc.info(), admin_acc.info()];
        reject(
            authorize_whitelist_removal(&stranger, &room_id, &infos),
            "NotCasinoAdmin",
        );

        let other = Tenant::new([12u8; 32], Pubkey::new_unique());
        let mut room_acc = OwnedAccount::serialized(room_key, crate::ID, &room);
        let (mut casino_acc, mut admin_acc) = other.accounts();
        let infos = [room_acc.info(), casino_acc.info(), admin_acc.info()];
        reject(
            authorize_whitelist_removal(&other.admin, &room_id, &infos),
            "NotCasinoAdmin",
        );

        reject(
            authorize_whitelist_removal(&stranger, &room_id, &[]),
            "NotCasinoAdmin",
        );
    }

    #[test]
    fn a_casino_account_that_is_not_this_programs_tenant_cannot_authorize_anyone() {
        let tenant = Tenant::new([14u8; 32], Pubkey::new_unique());
        let mut casino = tenant.casino();
        casino.light_casino_program = Pubkey::new_unique();
        let (mut casino_acc, mut admin_acc) = (
            OwnedAccount::serialized(tenant.casino_key, crate::ID, &casino),
            OwnedAccount::serialized(tenant.admin_key, crate::ID, &tenant.admin_entry()),
        );
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(
            require_casino_operator(&tenant.admin, &infos),
            "UnauthorizedCpiCaller",
        );

        let (mut casino_acc, mut admin_acc) = (
            OwnedAccount::serialized(tenant.casino_key, Pubkey::new_unique(), &tenant.casino()),
            OwnedAccount::serialized(tenant.admin_key, crate::ID, &tenant.admin_entry()),
        );
        let infos = [casino_acc.info(), admin_acc.info()];
        reject(require_casino_operator(&tenant.admin, &infos), "InvalidCasino");
    }
}
