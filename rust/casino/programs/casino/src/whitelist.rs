use anchor_lang::prelude::*;

use crate::ErrorCode;

pub const WHITELIST_SEED: &[u8] = b"whitelist";

/// House operator. Signs room create and whitelist add/remove.
/// Independent of the Arcis MXE authority.
pub const WHITELIST_ADMIN: Pubkey = pubkey!("CAdmin6xuLQFoANbHQWUpRmfBq9Su3gWeFCtELBh7oc3");

#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    pub room_id: [u8; 32],
    pub player: Pubkey,
}

pub fn verify_admin(admin: &Pubkey) -> Result<()> {
    require!(*admin == WHITELIST_ADMIN, ErrorCode::NotWhitelistAdmin);
    Ok(())
}

pub fn verify_whitelisted(entry: &WhitelistEntry, room_id: &[u8; 32], player: &Pubkey) -> Result<()> {
    require!(entry.room_id == *room_id, ErrorCode::NotWhitelisted);
    require!(entry.player == *player, ErrorCode::NotWhitelisted);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_admin_accepts_hardcoded_key() {
        assert!(verify_admin(&WHITELIST_ADMIN).is_ok());
    }

    #[test]
    fn verify_admin_rejects_other_signer() {
        assert!(verify_admin(&Pubkey::new_unique()).is_err());
    }

    #[test]
    fn verify_whitelisted_accepts_matching_entry() {
        let room_id = [7u8; 32];
        let player = Pubkey::new_unique();
        let entry = WhitelistEntry { room_id, player };
        assert!(verify_whitelisted(&entry, &room_id, &player).is_ok());
    }

    #[test]
    fn verify_whitelisted_rejects_wrong_player() {
        let room_id = [7u8; 32];
        let entry = WhitelistEntry { room_id, player: Pubkey::new_unique() };
        assert!(verify_whitelisted(&entry, &room_id, &Pubkey::new_unique()).is_err());
    }
}
