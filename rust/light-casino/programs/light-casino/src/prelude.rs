//! Pinocchio stand-in for the Anchor types this program used to import.
//!
//! Instruction bytes, account discriminators, and custom error numbers stay on
//! the Anchor wire format so the casino program and the TypeScript client keep
//! working.

use borsh::{BorshDeserialize, BorshSerialize};
use core::marker::PhantomData;
pub use pinocchio::program_error::ProgramError;

/// System program id (`11111111111111111111111111111111`).
pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey([0u8; 32]);

/// Anchor built-in codes the account loader still returns.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProgramErrorCode {
    ConstraintMut = 2000,
    ConstraintSigner = 2002,
    ConstraintSeeds = 2006,
    AccountDiscriminatorMismatch = 3002,
    AccountDidNotDeserialize = 3003,
    AccountDidNotSerialize = 3004,
    AccountNotEnoughKeys = 3005,
    AccountOwnedByWrongProgram = 3007,
    InvalidProgramId = 3008,
}

#[derive(Debug)]
pub enum Error {
    Custom(u32),
    Program(ProgramError),
}

impl From<ProgramErrorCode> for Error {
    fn from(code: ProgramErrorCode) -> Self {
        Error::Custom(code as u32)
    }
}

impl From<ProgramError> for Error {
    fn from(err: ProgramError) -> Self {
        Error::Program(err)
    }
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        match err {
            Error::Custom(code) => ProgramError::Custom(code),
            Error::Program(err) => err,
        }
    }
}

pub type Result<T> = core::result::Result<T, Error>;

/// Host-only. On Solana a failed account write aborts; writable `.bss` is rejected by the loader.
#[cfg(not(target_os = "solana"))]
static mut ACCOUNT_WRITE_FAILED: bool = false;

pub fn take_account_write_failed() -> bool {
    #[cfg(target_os = "solana")]
    {
        false
    }
    #[cfg(not(target_os = "solana"))]
    unsafe {
        let failed = ACCOUNT_WRITE_FAILED;
        ACCOUNT_WRITE_FAILED = false;
        failed
    }
}

macro_rules! require {
    ($cond:expr, $err:expr) => {
        if !$cond {
            return Err($crate::Error::from($err));
        }
    };
}
pub(crate) use require;

macro_rules! require_keys_eq {
    ($left:expr, $right:expr) => {
        if $left != $right {
            return Err($crate::prelude::Error::Custom(2502));
        }
    };
    ($left:expr, $right:expr, $err:expr) => {
        if $left != $right {
            return Err($crate::Error::from($err));
        }
    };
}
pub(crate) use require_keys_eq;

macro_rules! err {
    ($err:expr) => {
        Err($crate::Error::from($err))
    };
}
pub(crate) use err;

macro_rules! error {
    ($err:expr) => {
        $crate::Error::from($err)
    };
}
pub(crate) use error;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Hash)]
pub struct Pubkey(pub [u8; 32]);

impl Pubkey {
    pub const fn new_from_array(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0
    }

    pub fn as_array(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn find_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
        #[cfg(target_os = "solana")]
        {
            let (address, bump) =
                pinocchio::pubkey::find_program_address(seeds, program_id.as_array());
            (Pubkey(address), bump)
        }
        #[cfg(not(target_os = "solana"))]
        {
            let (address, bump) = solana_sdk::pubkey::Pubkey::find_program_address(
                seeds,
                &solana_sdk::pubkey::Pubkey::new_from_array(program_id.0),
            );
            (Pubkey(address.to_bytes()), bump)
        }
    }

    pub fn from_str(value: &str) -> core::result::Result<Self, ()> {
        let mut bytes = [0u8; 32];
        for byte in value.bytes() {
            let digit = match byte {
                b'1'..=b'9' => byte - b'1',
                b'A'..=b'H' => byte - b'A' + 9,
                b'J'..=b'N' => byte - b'J' + 17,
                b'P'..=b'Z' => byte - b'P' + 22,
                b'a'..=b'k' => byte - b'a' + 33,
                b'm'..=b'z' => byte - b'm' + 44,
                _ => return Err(()),
            };
            let mut carry = digit as u32;
            for slot in bytes.iter_mut().rev() {
                carry += (*slot as u32) * 58;
                *slot = (carry & 0xff) as u8;
                carry >>= 8;
            }
            if carry != 0 {
                return Err(());
            }
        }
        Ok(Pubkey(bytes))
    }
}

impl AsRef<[u8]> for Pubkey {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl BorshSerialize for Pubkey {
    fn serialize<W: borsh::maybestd::io::Write>(
        &self,
        writer: &mut W,
    ) -> borsh::maybestd::io::Result<()> {
        writer.write_all(&self.0)
    }
}

impl BorshDeserialize for Pubkey {
    fn deserialize_reader<R: borsh::maybestd::io::Read>(
        reader: &mut R,
    ) -> borsh::maybestd::io::Result<Self> {
        let mut bytes = [0u8; 32];
        reader.read_exact(&mut bytes)?;
        Ok(Pubkey(bytes))
    }
}

#[derive(Clone, Copy)]
pub struct AccountInfo<'a> {
    pub raw: &'a pinocchio::account_info::AccountInfo,
}

impl<'a> AccountInfo<'a> {
    pub fn new(raw: &'a pinocchio::account_info::AccountInfo) -> Self {
        Self { raw }
    }

    pub fn key(&self) -> Pubkey {
        Pubkey(*self.raw.key())
    }

    pub fn key_ptr(&self) -> &'a [u8; 32] {
        self.raw.key()
    }

    pub fn owner(&self) -> Pubkey {
        Pubkey(*self.raw.owner())
    }

    pub fn is_signer(&self) -> bool {
        self.raw.is_signer()
    }

    pub fn is_writable(&self) -> bool {
        self.raw.is_writable()
    }

    pub fn data_len(&self) -> usize {
        self.raw.data_len()
    }

    pub fn lamports(&self) -> u64 {
        self.raw.lamports()
    }

    pub fn try_borrow_mut_lamports(
        &self,
    ) -> Result<pinocchio::account_info::RefMut<'_, u64>> {
        self.raw.try_borrow_mut_lamports().map_err(Error::from)
    }

    pub fn try_borrow_data(&self) -> Result<pinocchio::account_info::Ref<'_, [u8]>> {
        self.raw.try_borrow_data().map_err(Error::from)
    }

    pub fn try_borrow_mut_data(&self) -> Result<pinocchio::account_info::RefMut<'_, [u8]>> {
        self.raw.try_borrow_mut_data().map_err(Error::from)
    }

    pub fn realloc(&self, new_len: usize, _zero_init: bool) -> Result<()> {
        self.raw.resize(new_len).map_err(Error::from)
    }

    pub fn assign(&self, owner: &Pubkey) {
        unsafe { self.raw.assign(owner.as_array()) }
    }
}

pub trait AccountData: BorshSerialize + BorshDeserialize + Default {
    const DISCRIMINATOR: [u8; 8];
}

pub struct Account<'info, T: AccountData> {
    info: AccountInfo<'info>,
    data: T,
    dirty: bool,
}

impl<'info, T: AccountData> Account<'info, T> {
    pub fn key(&self) -> Pubkey {
        self.info.key()
    }
}

impl<'info, T: AccountData> core::ops::Deref for Account<'info, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.data
    }
}

impl<'info, T: AccountData> core::ops::DerefMut for Account<'info, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.dirty = true;
        &mut self.data
    }
}

impl<'info, T: AccountData> Account<'info, T> {
    pub fn to_account_info(&self) -> AccountInfo<'info> {
        self.info
    }

    pub fn exit(&mut self, program_id: &Pubkey) -> Result<()> {
        require_keys_eq!(
            self.info.owner(),
            *program_id,
            ProgramErrorCode::AccountOwnedByWrongProgram
        );
        self.write()?;
        self.dirty = false;
        Ok(())
    }

    fn write(&self) -> Result<()> {
        let mut body = alloc_vec();
        self.data
            .serialize(&mut body)
            .map_err(|_| Error::from(ProgramErrorCode::AccountDidNotSerialize))?;
        let need = 8 + body.len();
        if self.info.data_len() < need {
            return err!(ProgramErrorCode::AccountDidNotSerialize);
        }
        let mut data = self.info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&T::DISCRIMINATOR);
        data[8..need].copy_from_slice(&body);
        Ok(())
    }
}

impl<'info, T: AccountData> Drop for Account<'info, T> {
    fn drop(&mut self) {
        if self.dirty && self.write().is_err() {
            #[cfg(target_os = "solana")]
            unsafe {
                let msg = b"account write failed";
                pinocchio::syscalls::sol_panic_(msg.as_ptr(), msg.len() as u64, line!() as u64, 1);
            }
            #[cfg(not(target_os = "solana"))]
            unsafe {
                ACCOUNT_WRITE_FAILED = true;
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct Signer<'info>(pub AccountInfo<'info>);

impl<'info> Signer<'info> {
    pub fn key(&self) -> Pubkey {
        self.0.key()
    }

    pub fn to_account_info(&self) -> AccountInfo<'info> {
        self.0
    }
}

impl<'info> AsRef<AccountInfo<'info>> for Signer<'info> {
    fn as_ref(&self) -> &AccountInfo<'info> {
        &self.0
    }
}

impl<'info> core::ops::Deref for Signer<'info> {
    type Target = AccountInfo<'info>;
    fn deref(&self) -> &AccountInfo<'info> {
        &self.0
    }
}

#[derive(Clone, Copy)]
pub struct UncheckedAccount<'info>(pub AccountInfo<'info>);

impl<'info> UncheckedAccount<'info> {
    pub fn to_account_info(&self) -> AccountInfo<'info> {
        self.0
    }
}

impl<'info> core::ops::Deref for UncheckedAccount<'info> {
    type Target = AccountInfo<'info>;
    fn deref(&self) -> &AccountInfo<'info> {
        &self.0
    }
}

pub struct System;

pub struct Program<'info, T> {
    info: AccountInfo<'info>,
    _marker: PhantomData<T>,
}

impl<'info, T> Program<'info, T> {
    pub fn to_account_info(&self) -> AccountInfo<'info> {
        self.info
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Bumps {
    pub cpi_authority: Option<u8>,
}

pub struct Context<'info, T> {
    pub program_id: Pubkey,
    pub accounts: T,
    pub remaining_accounts: Vec<AccountInfo<'info>>,
    pub bumps: Bumps,
}

pub struct IxCursor<'a, 'b> {
    accounts: &'b [AccountInfo<'a>],
    index: usize,
    pub bumps: Bumps,
    program_id: Pubkey,
}

impl<'a, 'b> IxCursor<'a, 'b> {
    pub fn new(accounts: &'b [AccountInfo<'a>], program_id: Pubkey) -> Self {
        Self {
            accounts,
            index: 0,
            bumps: Bumps::default(),
            program_id,
        }
    }

    fn take(&mut self) -> Result<AccountInfo<'a>> {
        if self.index >= self.accounts.len() {
            return err!(ProgramErrorCode::AccountNotEnoughKeys);
        }
        let account = self.accounts[self.index];
        self.index += 1;
        Ok(account)
    }

    pub fn signer(&mut self, writable: bool) -> Result<Signer<'a>> {
        let info = self.take()?;
        if !info.is_signer() {
            return err!(ProgramErrorCode::ConstraintSigner);
        }
        if writable && !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        Ok(Signer(info))
    }

    pub fn system(&mut self) -> Result<Program<'a, System>> {
        let info = self.take()?;
        require_keys_eq!(info.key(), SYSTEM_PROGRAM_ID, ProgramErrorCode::InvalidProgramId);
        Ok(Program {
            info,
            _marker: PhantomData,
        })
    }

    pub fn optional_load<T: AccountData>(
        &mut self,
        writable: bool,
    ) -> Result<Option<Account<'a, T>>> {
        if self.index >= self.accounts.len() {
            return Ok(None);
        }
        if self.accounts[self.index].key() == self.program_id {
            self.index += 1;
            return Ok(None);
        }
        Ok(Some(self.load::<T>(writable)?))
    }

    pub fn load<T: AccountData>(&mut self, writable: bool) -> Result<Account<'a, T>> {
        let info = self.take()?;
        if writable && !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        require_keys_eq!(
            info.owner(),
            self.program_id,
            ProgramErrorCode::AccountOwnedByWrongProgram
        );
        let borrowed = info.try_borrow_data()?;
        if borrowed.len() < 8 || borrowed[..8] != T::DISCRIMINATOR {
            return err!(ProgramErrorCode::AccountDiscriminatorMismatch);
        }
        let data = T::deserialize(&mut &borrowed[8..])
            .map_err(|_| Error::from(ProgramErrorCode::AccountDidNotDeserialize))?;
        drop(borrowed);
        Ok(Account {
            info,
            data,
            dirty: writable,
        })
    }

    pub fn unchecked(&mut self, writable: bool) -> Result<UncheckedAccount<'a>> {
        let info = self.take()?;
        if writable && !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        Ok(UncheckedAccount(info))
    }

    pub fn optional(&mut self, writable: bool) -> Result<Option<UncheckedAccount<'a>>> {
        if self.index >= self.accounts.len() {
            return Ok(None);
        }
        let info = self.accounts[self.index];
        if info.key() == self.program_id {
            self.index += 1;
            return Ok(None);
        }
        self.index += 1;
        if writable && !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        Ok(Some(UncheckedAccount(info)))
    }

    pub fn check_seeds(
        &mut self,
        info: &AccountInfo<'a>,
        seeds: &[&[u8]],
        cpi_authority: bool,
    ) -> Result<()> {
        let (expected, bump) = Pubkey::find_program_address(seeds, &self.program_id);
        require_keys_eq!(info.key(), expected, ProgramErrorCode::ConstraintSeeds);
        if cpi_authority {
            self.bumps.cpi_authority = Some(bump);
        }
        Ok(())
    }

    pub fn init<T: AccountData>(
        &mut self,
        payer: &AccountInfo<'a>,
        space: usize,
        seeds: &[&[u8]],
        cpi_authority: bool,
    ) -> Result<Account<'a, T>> {
        let info = self.create_pda(payer, space, seeds, cpi_authority)?;
        Ok(Account {
            info,
            data: T::default(),
            dirty: true,
        })
    }

    pub fn init_unchecked(
        &mut self,
        payer: &AccountInfo<'a>,
        space: usize,
        seeds: &[&[u8]],
        cpi_authority: bool,
    ) -> Result<UncheckedAccount<'a>> {
        Ok(UncheckedAccount(self.create_pda(
            payer,
            space,
            seeds,
            cpi_authority,
        )?))
    }

    /// Create `space` bytes, or return the account when that write already landed.
    pub fn open_or_init(
        &mut self,
        payer: &AccountInfo<'a>,
        space: usize,
        seeds: &[&[u8]],
    ) -> Result<UncheckedAccount<'a>> {
        let info = self.take()?;
        if !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        let (expected, bump) = Pubkey::find_program_address(seeds, &self.program_id);
        require_keys_eq!(info.key(), expected, ProgramErrorCode::ConstraintSeeds);
        if info.data_len() == 0 {
            require_keys_eq!(
                info.owner(),
                SYSTEM_PROGRAM_ID,
                ProgramErrorCode::AccountOwnedByWrongProgram
            );
            let needed = minimum_balance(space)?;
            let have = info.lamports();
            if have == 0 {
                system_create_account(payer, &info, needed, space as u64, &self.program_id, seeds, bump)?;
            } else {
                if needed > have {
                    system_transfer(payer, &info, needed - have)?;
                }
                system_allocate(&info, space as u64, seeds, bump)?;
                system_assign(&info, &self.program_id, seeds, bump)?;
            }
        } else {
            require_keys_eq!(
                info.owner(),
                self.program_id,
                ProgramErrorCode::AccountOwnedByWrongProgram
            );
            if info.data_len() < space {
                return Err(ProgramError::InvalidAccountData.into());
            }
        }
        Ok(UncheckedAccount(info))
    }

    fn create_pda(
        &mut self,
        payer: &AccountInfo<'a>,
        space: usize,
        seeds: &[&[u8]],
        cpi_authority: bool,
    ) -> Result<AccountInfo<'a>> {
        let info = self.take()?;
        if !info.is_writable() {
            return err!(ProgramErrorCode::ConstraintMut);
        }
        let (expected, bump) = Pubkey::find_program_address(seeds, &self.program_id);
        require_keys_eq!(info.key(), expected, ProgramErrorCode::ConstraintSeeds);
        if cpi_authority {
            self.bumps.cpi_authority = Some(bump);
        }
        if info.data_len() != 0 {
            return Err(ProgramError::AccountAlreadyInitialized.into());
        }
        require_keys_eq!(
            info.owner(),
            SYSTEM_PROGRAM_ID,
            ProgramErrorCode::AccountOwnedByWrongProgram
        );
        let needed = minimum_balance(space)?;
        let have = info.lamports();
        if have == 0 {
            system_create_account(payer, &info, needed, space as u64, &self.program_id, seeds, bump)?;
        } else {
            if needed > have {
                system_transfer(payer, &info, needed - have)?;
            }
            system_allocate(&info, space as u64, seeds, bump)?;
            system_assign(&info, &self.program_id, seeds, bump)?;
        }
        Ok(info)
    }

    pub fn rest(&mut self) -> Vec<AccountInfo<'a>> {
        let rest = self.accounts[self.index..].to_vec();
        self.index = self.accounts.len();
        rest
    }
}

pub fn minimum_balance(data_len: usize) -> Result<u64> {
    #[cfg(target_os = "solana")]
    {
        let mut bytes = [0u8; pinocchio::sysvars::rent::Rent::LEN];
        let status = unsafe { pinocchio::syscalls::sol_get_rent_sysvar(bytes.as_mut_ptr()) };
        if status != 0 {
            return Err(ProgramError::InvalidAccountData.into());
        }
        let rent = pinocchio::sysvars::rent::Rent::from_bytes(&bytes)?;
        Ok(rent.minimum_balance(data_len))
    }
    #[cfg(not(target_os = "solana"))]
    {
        Ok((128u64 + data_len as u64).saturating_mul(3480).saturating_mul(2))
    }
}

fn system_invoke(
    data: &[u8],
    metas: &[pinocchio::instruction::AccountMeta],
    infos: &[&pinocchio::account_info::AccountInfo],
    signers: &[pinocchio::instruction::Signer],
) -> Result<()> {
    let instruction = pinocchio::instruction::Instruction {
        program_id: &SYSTEM_PROGRAM_ID.0,
        accounts: metas,
        data,
    };
    pinocchio::cpi::slice_invoke_signed(&instruction, infos, signers).map_err(Error::from)
}

fn pda_signer<'a>(
    seeds: &'a [&'a [u8]],
    bump: &'a [u8; 1],
    buf: &'a mut Vec<pinocchio::instruction::Seed<'a>>,
) -> pinocchio::instruction::Signer<'a, 'a> {
    buf.clear();
    for seed in seeds {
        buf.push(pinocchio::instruction::Seed::from(*seed));
    }
    buf.push(pinocchio::instruction::Seed::from(bump));
    pinocchio::instruction::Signer::from(buf.as_slice())
}

fn system_create_account(
    payer: &AccountInfo,
    account: &AccountInfo,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
    seeds: &[&[u8]],
    bump: u8,
) -> Result<()> {
    let mut data = [0u8; 52];
    data[0..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner.as_array());
    let metas = [
        pinocchio::instruction::AccountMeta::writable_signer(payer.key_ptr()),
        pinocchio::instruction::AccountMeta::writable_signer(account.key_ptr()),
    ];
    let bump_bytes = [bump];
    let mut seed_buf = Vec::new();
    let signer = pda_signer(seeds, &bump_bytes, &mut seed_buf);
    system_invoke(&data, &metas, &[payer.raw, account.raw], &[signer])
}

pub(crate) fn system_transfer(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> Result<()> {
    let mut data = [0u8; 12];
    data[0..4].copy_from_slice(&2u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    let metas = [
        pinocchio::instruction::AccountMeta::writable_signer(from.key_ptr()),
        pinocchio::instruction::AccountMeta::writable(to.key_ptr()),
    ];
    system_invoke(&data, &metas, &[from.raw, to.raw], &[])
}

fn system_allocate(account: &AccountInfo, space: u64, seeds: &[&[u8]], bump: u8) -> Result<()> {
    let mut data = [0u8; 12];
    data[0..4].copy_from_slice(&8u32.to_le_bytes());
    data[4..12].copy_from_slice(&space.to_le_bytes());
    let metas = [pinocchio::instruction::AccountMeta::writable_signer(
        account.key_ptr(),
    )];
    let bump_bytes = [bump];
    let mut seed_buf = Vec::new();
    let signer = pda_signer(seeds, &bump_bytes, &mut seed_buf);
    system_invoke(&data, &metas, &[account.raw], &[signer])
}

fn system_assign(account: &AccountInfo, owner: &Pubkey, seeds: &[&[u8]], bump: u8) -> Result<()> {
    let mut data = [0u8; 36];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(owner.as_array());
    let metas = [pinocchio::instruction::AccountMeta::writable_signer(
        account.key_ptr(),
    )];
    let bump_bytes = [bump];
    let mut seed_buf = Vec::new();
    let signer = pda_signer(seeds, &bump_bytes, &mut seed_buf);
    system_invoke(&data, &metas, &[account.raw], &[signer])
}

pub fn transfer(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> Result<()> {
    system_transfer(from, to, lamports)
}

fn alloc_vec<T>() -> Vec<T> {
    Vec::new()
}
