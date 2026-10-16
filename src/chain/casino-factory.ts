/**
 * Casino factory. CAdmin creates a tenant bound to the casino and light-casino
 * programs, then delegates admins. Those admins open rooms and tables and
 * register a dealer key per game.
 */
import { createHash } from 'node:crypto';
import { web3 } from '@coral-xyz/anchor';
import { CASINO_PROGRAM_ID } from '../testing/deploy';

const PROGRAM_ID = new web3.PublicKey(CASINO_PROGRAM_ID);

export const CASINO_SEED = Buffer.from('casino');
export const CASINO_ADMIN_SEED = Buffer.from('casino_admin');
export const CASINO_DEALER_SEED = Buffer.from('casino_dealer');

export const CREATE_CASINO = sighash('create_casino');
export const ADD_CASINO_ADMIN = sighash('add_casino_admin');
export const REMOVE_CASINO_ADMIN = sighash('remove_casino_admin');
export const ADD_CASINO_DEALER = sighash('add_casino_dealer');
export const REMOVE_CASINO_DEALER = sighash('remove_casino_dealer');

function sighash(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

export function casinoPda(
  casinoId: Uint8Array,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [CASINO_SEED, Buffer.from(casinoId)],
    programId,
  )[0];
}

export function casinoAdminPda(
  casinoId: Uint8Array,
  admin: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [CASINO_ADMIN_SEED, Buffer.from(casinoId), admin.toBuffer()],
    programId,
  )[0];
}

export function casinoDealerPda(
  casinoId: Uint8Array,
  gameKind: number,
  dealer: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [CASINO_DEALER_SEED, Buffer.from(casinoId), Buffer.from([gameKind]), dealer.toBuffer()],
    programId,
  )[0];
}

/** Remaining accounts a delegated admin passes to room, table, and player-whitelist instructions. */
export function casinoOperatorMetas(
  casinoId: Uint8Array,
  admin: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.AccountMeta[] {
  return [
    { pubkey: casinoPda(casinoId, programId), isSigner: false, isWritable: false },
    { pubkey: casinoAdminPda(casinoId, admin, programId), isSigner: false, isWritable: false },
  ];
}

export function createCasinoInstruction(
  authority: web3.PublicKey,
  casinoId: Uint8Array,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: casinoPda(casinoId, programId), isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CREATE_CASINO, Buffer.from(casinoId)]),
  });
}

export function addCasinoAdminInstruction(
  authority: web3.PublicKey,
  casinoId: Uint8Array,
  admin: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: casinoPda(casinoId, programId), isSigner: false, isWritable: false },
      { pubkey: admin, isSigner: false, isWritable: false },
      { pubkey: casinoAdminPda(casinoId, admin, programId), isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ADD_CASINO_ADMIN, Buffer.from(casinoId)]),
  });
}

export function removeCasinoAdminInstruction(
  authority: web3.PublicKey,
  casinoId: Uint8Array,
  admin: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: casinoAdminPda(casinoId, admin, programId), isSigner: false, isWritable: true },
    ],
    data: REMOVE_CASINO_ADMIN,
  });
}

export function addCasinoDealerInstruction(
  admin: web3.PublicKey,
  casinoId: Uint8Array,
  gameKind: number,
  dealer: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.TransactionInstruction {
  const data = Buffer.alloc(8 + 32 + 1);
  ADD_CASINO_DEALER.copy(data, 0);
  data.set(casinoId, 8);
  data[40] = gameKind;
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: casinoPda(casinoId, programId), isSigner: false, isWritable: false },
      { pubkey: casinoAdminPda(casinoId, admin, programId), isSigner: false, isWritable: false },
      { pubkey: dealer, isSigner: false, isWritable: false },
      { pubkey: casinoDealerPda(casinoId, gameKind, dealer, programId), isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function removeCasinoDealerInstruction(
  admin: web3.PublicKey,
  casinoId: Uint8Array,
  gameKind: number,
  dealer: web3.PublicKey,
  programId: web3.PublicKey = PROGRAM_ID,
): web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: casinoPda(casinoId, programId), isSigner: false, isWritable: false },
      { pubkey: casinoAdminPda(casinoId, admin, programId), isSigner: false, isWritable: false },
      { pubkey: casinoDealerPda(casinoId, gameKind, dealer, programId), isSigner: false, isWritable: true },
    ],
    data: REMOVE_CASINO_DEALER,
  });
}
