use anchor_lang::prelude::*;

/// Dual-ledger policy (V7):
/// - Enc (`balance_ciphertext`) is the source of truth for chip authorization.
/// - `balance_u64` is a UI / public-input mirror updated only after a successful
///   Arcis callback (or on `#[cfg(testing)]` plaintext transfer helpers).
/// - Never authorize Enc money movement solely from `balance_u64`.

/// Plaintext mirror of Arcis `lock_table_buyin`: move `buy_in` room→table only when
/// room covers it; otherwise leave both unchanged (never mint table escrow).
pub fn apply_lock_table_buyin(room_balance: u64, table_balance: u64, buy_in: u64) -> (u64, u64) {
    if room_balance >= buy_in {
        (room_balance - buy_in, table_balance + buy_in)
    } else {
        (room_balance, table_balance)
    }
}

/// Apply a successful Enc credit onto the plaintext mirror.
pub fn mirror_credit(balance: u64, amount: u64) -> Option<u64> {
    if amount == 0 {
        return None;
    }
    balance.checked_add(amount)
}

/// Apply a successful Enc debit onto the plaintext mirror.
pub fn mirror_debit(balance: u64, amount: u64) -> Option<u64> {
    if amount == 0 {
        return None;
    }
    balance.checked_sub(amount)
}

/// SPL vault must cover the withdrawal about to leave the room.
pub fn vault_covers_withdraw(vault_amount: u64, withdraw: u64) -> bool {
    withdraw > 0 && vault_amount >= withdraw
}

/// One-time (accumulating) SPL→encrypted credit entitlement per player/room.
/// Created/accrued by `deposit_spl`; fully consumed by `request_credit_room_balance`.
#[account]
#[derive(InitSpace, Default)]
pub struct PendingDeposit {
    pub player: Pubkey,
    pub room_id: [u8; 32],
    pub amount: u64,
}

/// Accrue an SPL deposit into the pending credit entitlement.
pub fn accrue_pending_deposit(pending_amount: u64, deposit: u64) -> Option<u64> {
    if deposit == 0 {
        return None;
    }
    pending_amount.checked_add(deposit)
}

/// Consume pending deposit for encrypted credit.
/// Returns `Some(credit)` and leaves remaining 0; `None` if nothing pending or
/// caller amount does not match the pending entitlement (anti-mint).
pub fn consume_pending_deposit(pending_amount: u64, requested: u64) -> Option<u64> {
    if pending_amount == 0 || requested == 0 || requested != pending_amount {
        return None;
    }
    Some(pending_amount)
}

#[account]
#[derive(InitSpace)]
pub struct PlayerShieldedWallet {
    pub player: Pubkey,
    pub balance_ciphertext: [u8; 32],
    pub nonce: u128,
}

#[account]
#[derive(InitSpace)]
pub struct RoomWallet {
    pub player: Pubkey,
    pub room_id: [u8; 32],
    pub balance_ciphertext: [u8; 32],
    pub nonce: u128,
    /// Bitmap: bit `table_id` set if seated at that table.
    pub active_tables: u64,
    /// Bitmap: bit `table_id` set if in active hand at that table.
    pub in_hand_tables: u64,
    /// Personal escrow stack (chips available to transfer into seat escrows).
    /// UI / validate_bet public-input mirror of `balance_ciphertext` — updated
    /// only after successful Enc callbacks (see dual-ledger policy).
    pub balance_u64: u64,
    /// In-flight Enc credit amount awaiting callback mirror apply (0 = idle).
    pub pending_mirror_credit: u64,
    /// X25519 owner public key that produced `balance_ciphertext` (zero = unset).
    pub encryption_pubkey: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct TableEscrow {
    pub player: Pubkey,
    pub room_id: [u8; 32],
    pub table_id: u64,
    pub balance_ciphertext: [u8; 32],
    pub nonce: u128,
    pub is_seated: bool,
    /// Seat escrow stack used for betting at this table.
    /// Locked while `RoomWallet.in_hand_tables` has this table's bit set —
    /// funds may only move into the pot (via `submit_bet` / validate_bet).
    /// Mirror of Enc seat balance — updated only after Enc lock/unlock callbacks.
    pub balance_u64: u64,
    /// In-flight buy-in awaiting Enc `lock_table_buyin` callback (0 = idle).
    pub pending_buy_in: u64,
    /// X25519 owner public key that produced `balance_ciphertext` (zero = unset).
    pub encryption_pubkey: [u8; 32],
}

#[derive(Debug)]
pub enum TableEscrowSitError {
    AlreadySeated,
    ChipsStillLocked,
}

/// Open a seat escrow for `sit_at_table`.
///
/// `leave_table` clears the table seat and leaves this account allocated, so a
/// later sit must reuse it. A live seat or a non-zero stack is refused so a
/// retry cannot wipe chips.
pub fn open_table_escrow(
    escrow: &mut TableEscrow,
    player: Pubkey,
    room_id: [u8; 32],
    table_id: u64,
) -> std::result::Result<(), TableEscrowSitError> {
    if escrow.is_seated {
        return Err(TableEscrowSitError::AlreadySeated);
    }
    if escrow.balance_u64 != 0 || escrow.pending_buy_in != 0 {
        return Err(TableEscrowSitError::ChipsStillLocked);
    }
    escrow.player = player;
    escrow.room_id = room_id;
    escrow.table_id = table_id;
    escrow.balance_ciphertext = [0u8; 32];
    escrow.nonce = 0;
    escrow.is_seated = true;
    escrow.balance_u64 = 0;
    escrow.pending_buy_in = 0;
    escrow.encryption_pubkey = [0u8; 32];
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct PlayerGameEscrow {
    pub game_id: [u8; 32],
    pub player_index: u8,
    pub balance_ciphertext: [u8; 32],
    pub current_bet_ciphertext: [u8; 32],
    pub nonce: u128,
    /// X25519 owner public key that produced escrow ciphertexts (zero = unset).
    pub encryption_pubkey: [u8; 32],
    /// Plaintext mirror of Enc hand stake (updated after Enc fund/net/return callbacks).
    pub balance_u64: u64,
    /// In-flight fund from table_escrow awaiting Enc callback (0 = idle).
    pub pending_fund: u64,
    /// In-flight net abs awaiting `apply_casino_player_net` callback.
    pub pending_net_abs: u64,
    /// 1 if pending net is a win credit; 0 if a debit.
    pub pending_net_won: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindKeyError {
    ZeroKey,
    Mismatch,
}

/// Persist the ciphertext owner key on first use; reject rotation afterwards.
pub fn bind_encryption_pubkey(
    stored: &mut [u8; 32],
    provided: &[u8; 32],
) -> std::result::Result<(), BindKeyError> {
    if *provided == [0u8; 32] {
        return Err(BindKeyError::ZeroKey);
    }
    if *stored == [0u8; 32] {
        *stored = *provided;
        return Ok(());
    }
    if stored == provided {
        Ok(())
    } else {
        Err(BindKeyError::Mismatch)
    }
}

#[cfg(test)]
mod encryption_pubkey_bind_tests {
    use super::{bind_encryption_pubkey, BindKeyError};

    #[test]
    fn first_key_is_stored() {
        let mut stored = [0u8; 32];
        let key = [7u8; 32];
        assert!(bind_encryption_pubkey(&mut stored, &key).is_ok());
        assert_eq!(stored, key);
    }

    #[test]
    fn matching_key_accepted() {
        let mut stored = [7u8; 32];
        assert!(bind_encryption_pubkey(&mut stored, &[7u8; 32]).is_ok());
    }

    #[test]
    fn rotation_rejected() {
        let mut stored = [7u8; 32];
        assert_eq!(
            bind_encryption_pubkey(&mut stored, &[8u8; 32]),
            Err(BindKeyError::Mismatch)
        );
        assert_eq!(stored, [7u8; 32]);
    }
}

#[cfg(test)]
mod lock_table_buyin_tests {
    use super::apply_lock_table_buyin;

    #[test]
    fn sufficient_room_moves_buy_in_to_table() {
        assert_eq!(apply_lock_table_buyin(100, 0, 40), (60, 40));
        assert_eq!(apply_lock_table_buyin(40, 5, 40), (0, 45));
    }

    #[test]
    fn insufficient_room_leaves_both_unchanged() {
        // Critical C2: must not mint table escrow when encrypted room < buy_in.
        assert_eq!(apply_lock_table_buyin(30, 10, 40), (30, 10));
        assert_eq!(apply_lock_table_buyin(0, 0, 1), (0, 0));
        assert_eq!(apply_lock_table_buyin(39, 100, 40), (39, 100));
    }
}

#[cfg(test)]
mod pending_deposit_tests {
    use super::{accrue_pending_deposit, consume_pending_deposit};

    #[test]
    fn credit_without_pending_is_rejected() {
        // Hypothesis A/C: caller-chosen amount with pending=0 must not mint.
        let credit = consume_pending_deposit(0, 500_000);
        assert!(credit.is_none());
    }

    #[test]
    fn credit_amount_must_match_pending_exactly() {
        // Hypothesis A: cannot request a different amount than deposited.
        assert!(consume_pending_deposit(100, 99).is_none());
        assert!(consume_pending_deposit(100, 101).is_none());
        let credit = consume_pending_deposit(100, 100);
        assert_eq!(credit, Some(100));
    }

    #[test]
    fn deposit_accrues_then_credit_consumes_all() {
        // Hypothesis B: deposit creates entitlement; credit drains it once.
        let pending = accrue_pending_deposit(0, 40).unwrap();
        let pending = accrue_pending_deposit(pending, 60).unwrap();
        assert_eq!(pending, 100);
        let credit = consume_pending_deposit(pending, 100).unwrap();
        assert_eq!(credit, 100);
        // Second credit with drained pending fails (no double-spend).
        assert!(consume_pending_deposit(0, 100).is_none());
    }

    #[test]
    fn zero_deposit_does_not_accrue() {
        assert!(accrue_pending_deposit(10, 0).is_none());
    }
}

#[cfg(test)]
mod dual_ledger_mirror_tests {
    use super::{
        apply_lock_table_buyin, mirror_credit, mirror_debit, vault_covers_withdraw,
    };

    #[test]
    fn mirrors_update_only_with_nonzero_deltas() {
        assert_eq!(mirror_credit(10, 5), Some(15));
        assert!(mirror_credit(10, 0).is_none());
        assert_eq!(mirror_debit(10, 3), Some(7));
        assert!(mirror_debit(10, 11).is_none());
        assert!(mirror_debit(10, 0).is_none());
        assert!(vault_covers_withdraw(100, 40));
        assert!(!vault_covers_withdraw(39, 40));
        assert!(!vault_covers_withdraw(100, 0));
        // Lock mirror matches Enc no-mint policy.
        assert_eq!(apply_lock_table_buyin(50, 0, 40), (10, 40));
        assert_eq!(apply_lock_table_buyin(30, 0, 40), (30, 0));
    }
}

#[cfg(test)]
mod open_table_escrow_tests {
    use anchor_lang::prelude::Pubkey;
    use super::{open_table_escrow, TableEscrow, TableEscrowSitError};

    fn escrow() -> TableEscrow {
        TableEscrow {
            player: Pubkey::default(),
            room_id: [0u8; 32],
            table_id: 0,
            balance_ciphertext: [0u8; 32],
            nonce: 0,
            is_seated: false,
            balance_u64: 0,
            pending_buy_in: 0,
            encryption_pubkey: [0u8; 32],
        }
    }

    #[test]
    fn fresh_escrow_opens() {
        let mut row = escrow();
        let player = Pubkey::new_unique();
        open_table_escrow(&mut row, player, [3u8; 32], 0).unwrap();
        assert!(row.is_seated);
        assert_eq!(row.player, player);
        assert_eq!(row.table_id, 0);
        assert_eq!(row.balance_u64, 0);
    }

    #[test]
    fn stood_up_escrow_can_sit_again() {
        let mut row = escrow();
        row.player = Pubkey::new_unique();
        row.room_id = [9u8; 32];
        row.table_id = 0;
        row.balance_ciphertext = [4u8; 32];
        row.nonce = 11;
        row.encryption_pubkey = [5u8; 32];
        let player = Pubkey::new_unique();
        open_table_escrow(&mut row, player, [3u8; 32], 0).unwrap();
        assert!(row.is_seated);
        assert_eq!(row.player, player);
        assert_eq!(row.room_id, [3u8; 32]);
        assert_eq!(row.balance_ciphertext, [0u8; 32]);
        assert_eq!(row.nonce, 0);
        assert_eq!(row.encryption_pubkey, [0u8; 32]);
    }

    #[test]
    fn seated_escrow_is_refused() {
        let mut row = escrow();
        row.is_seated = true;
        row.balance_u64 = 1000;
        let err = open_table_escrow(&mut row, Pubkey::new_unique(), [1u8; 32], 0).unwrap_err();
        assert!(matches!(err, TableEscrowSitError::AlreadySeated));
        assert_eq!(row.balance_u64, 1000);
    }

    #[test]
    fn leftover_chips_are_refused() {
        let mut row = escrow();
        row.balance_u64 = 40;
        let err = open_table_escrow(&mut row, Pubkey::new_unique(), [1u8; 32], 0).unwrap_err();
        assert!(matches!(err, TableEscrowSitError::ChipsStillLocked));
        assert_eq!(row.balance_u64, 40);
        assert!(!row.is_seated);
    }
}
