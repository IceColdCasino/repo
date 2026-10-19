//! A room session key is authorized by a whitelisted owner and stays valid
//! until that owner closes it. It does not expire per hand. The owner may sit
//! at many tables. At each table, only one of that owner's session keys is seated.

use anchor_lang::prelude::*;

use crate::room::MAX_TABLES_PER_ROOM;
use crate::ErrorCode;

#[account]
#[derive(InitSpace)]
pub struct RoomSessionKey {
    pub room_id: [u8; 32],
    pub owner: Pubkey,
    pub session: Pubkey,
    /// Bit `table_id` is set while this key is seated there.
    pub active_tables: u64,
}

/// Tables this owner already occupies, across every session key.
#[account]
#[derive(InitSpace)]
pub struct RoomSessionLock {
    pub room_id: [u8; 32],
    pub owner: Pubkey,
    /// Bit `table_id` is set while any of the owner's session keys is seated there.
    pub occupied_tables: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    AlreadyPlaying,
    NotThisTable,
    BadKey,
    BadTable,
}

pub fn init_session(
    session: &mut RoomSessionKey,
    lock: &mut RoomSessionLock,
    room_id: [u8; 32],
    owner: Pubkey,
    session_key: Pubkey,
) -> std::result::Result<(), SessionError> {
    if owner == Pubkey::default() || session_key == Pubkey::default() {
        return Err(SessionError::BadKey);
    }
    session.room_id = room_id;
    session.owner = owner;
    session.session = session_key;
    session.active_tables = 0;
    if lock.owner == Pubkey::default() {
        lock.room_id = room_id;
        lock.owner = owner;
        lock.occupied_tables = 0;
        return Ok(());
    }
    if lock.owner != owner || lock.room_id != room_id {
        return Err(SessionError::BadKey);
    }
    Ok(())
}

fn table_bit(table_id: u64) -> std::result::Result<u64, SessionError> {
    if table_id >= MAX_TABLES_PER_ROOM {
        return Err(SessionError::BadTable);
    }
    Ok(1u64 << table_id)
}

/// Seat this session at `table_id`. The same owner may occupy other tables.
/// A second session key of that owner at this table is rejected.
pub fn begin_play(
    session: &mut RoomSessionKey,
    lock: &mut RoomSessionLock,
    table_id: u64,
) -> std::result::Result<(), SessionError> {
    let bit = table_bit(table_id)?;
    if lock.owner != session.owner || lock.room_id != session.room_id {
        return Err(SessionError::BadKey);
    }
    if session.active_tables & bit != 0 || lock.occupied_tables & bit != 0 {
        return Err(SessionError::AlreadyPlaying);
    }
    session.active_tables |= bit;
    lock.occupied_tables |= bit;
    Ok(())
}

pub fn end_play(
    session: &mut RoomSessionKey,
    lock: &mut RoomSessionLock,
    table_id: u64,
) -> std::result::Result<(), SessionError> {
    let bit = table_bit(table_id)?;
    if session.active_tables & bit == 0 || lock.occupied_tables & bit == 0 {
        return Err(SessionError::NotThisTable);
    }
    session.active_tables &= !bit;
    lock.occupied_tables &= !bit;
    Ok(())
}

pub fn map_session_error(err: SessionError) -> Error {
    match err {
        SessionError::AlreadyPlaying => error!(ErrorCode::SessionAlreadyPlaying),
        SessionError::NotThisTable => error!(ErrorCode::SessionNotPlaying),
        SessionError::BadKey => error!(ErrorCode::InvalidSessionKey),
        SessionError::BadTable => error!(ErrorCode::InvalidTableId),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(owner: Pubkey, session_key: Pubkey) -> (RoomSessionKey, RoomSessionLock) {
        let mut session = RoomSessionKey {
            room_id: [1u8; 32],
            owner: Pubkey::default(),
            session: Pubkey::default(),
            active_tables: 0,
        };
        let mut lock = RoomSessionLock {
            room_id: [0u8; 32],
            owner: Pubkey::default(),
            occupied_tables: 0,
        };
        init_session(&mut session, &mut lock, [1u8; 32], owner, session_key).unwrap();
        (session, lock)
    }

    fn empty_session(owner: Pubkey, session_key: Pubkey) -> RoomSessionKey {
        RoomSessionKey {
            room_id: [1u8; 32],
            owner,
            session: session_key,
            active_tables: 0,
        }
    }

    #[test]
    fn one_session_key_can_sit_at_several_tables() {
        let owner = Pubkey::new_unique();
        let (mut session, mut lock) = fresh(owner, owner);
        begin_play(&mut session, &mut lock, 3).unwrap();
        begin_play(&mut session, &mut lock, 4).unwrap();
        assert_eq!(session.active_tables, (1u64 << 3) | (1u64 << 4));
        assert_eq!(lock.occupied_tables, session.active_tables);
        assert_eq!(
            begin_play(&mut session, &mut lock, 3),
            Err(SessionError::AlreadyPlaying)
        );
    }

    #[test]
    fn a_second_session_key_can_sit_at_another_table() {
        let owner = Pubkey::new_unique();
        let (mut first, mut lock) = fresh(owner, owner);
        begin_play(&mut first, &mut lock, 1).unwrap();

        let other = Pubkey::new_unique();
        let mut second = empty_session(owner, other);
        begin_play(&mut second, &mut lock, 2).unwrap();
        assert_eq!(second.active_tables, 1u64 << 2);
        assert_eq!(
            begin_play(&mut second, &mut lock, 1),
            Err(SessionError::AlreadyPlaying)
        );
        assert_eq!(second.active_tables, 1u64 << 2);
    }

    #[test]
    fn leaving_frees_that_table_for_another_session_key() {
        let owner = Pubkey::new_unique();
        let (mut first, mut lock) = fresh(owner, owner);
        begin_play(&mut first, &mut lock, 1).unwrap();
        begin_play(&mut first, &mut lock, 6).unwrap();
        end_play(&mut first, &mut lock, 1).unwrap();
        assert_eq!(first.active_tables, 1u64 << 6);
        assert_eq!(lock.occupied_tables, 1u64 << 6);

        let other = Pubkey::new_unique();
        let mut second = empty_session(owner, other);
        begin_play(&mut second, &mut lock, 1).unwrap();
        assert_eq!(lock.occupied_tables, (1u64 << 6) | (1u64 << 1));
    }

    #[test]
    fn account_len_matches_the_rent_budget() {
        assert_eq!(8 + RoomSessionKey::INIT_SPACE, 112);
        assert_eq!(8 + RoomSessionLock::INIT_SPACE, 80);
    }

    #[test]
    fn end_play_rejects_the_wrong_table() {
        let owner = Pubkey::new_unique();
        let (mut session, mut lock) = fresh(owner, owner);
        begin_play(&mut session, &mut lock, 2).unwrap();
        assert_eq!(end_play(&mut session, &mut lock, 3), Err(SessionError::NotThisTable));
        assert_eq!(session.active_tables, 1u64 << 2);
    }
}
