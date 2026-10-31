import { describe, expect, test } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import {
  ADD_CASINO_ADMIN,
  ADD_CASINO_DEALER,
  CREATE_CASINO,
  REMOVE_CASINO_ADMIN,
  REMOVE_CASINO_DEALER,
  addCasinoAdminInstruction,
  addCasinoDealerInstruction,
  casinoAdminPda,
  casinoDealerPda,
  casinoOperatorMetas,
  casinoPda,
  createCasinoInstruction,
  removeCasinoAdminInstruction,
  removeCasinoDealerInstruction,
} from '../src/chain/casino-factory';
import { CASINO_PROGRAM_ID } from '../src/testing/deploy';

const programId = new web3.PublicKey(CASINO_PROGRAM_ID);

describe('casino factory', () => {
  const casinoId = new Uint8Array(32).fill(4);
  const authority = web3.Keypair.generate().publicKey;
  const admin = web3.Keypair.generate().publicKey;
  const dealer = web3.Keypair.generate().publicKey;

  test('a casino, its admin, and its dealer are distinct accounts', () => {
    const casino = casinoPda(casinoId);
    const adminEntry = casinoAdminPda(casinoId, admin);
    const dealerEntry = casinoDealerPda(casinoId, 6, dealer);
    expect(casino.equals(adminEntry)).toBe(false);
    expect(adminEntry.equals(dealerEntry)).toBe(false);
    expect(casinoDealerPda(casinoId, 6, dealer).equals(casinoDealerPda(casinoId, 7, dealer))).toBe(false);
    expect(casinoPda(casinoId, programId).equals(casino)).toBe(true);
  });

  test('CAdmin creates the casino and delegates an admin', () => {
    const create = createCasinoInstruction(authority, casinoId);
    expect([...create.data.subarray(0, 8)]).toEqual([...CREATE_CASINO]);
    expect([...create.data.subarray(8)]).toEqual([...casinoId]);
    expect(create.keys.map((key) => key.pubkey.toBase58())).toEqual([
      authority.toBase58(),
      casinoPda(casinoId).toBase58(),
      web3.SystemProgram.programId.toBase58(),
    ]);

    const delegate = addCasinoAdminInstruction(authority, casinoId, admin);
    expect([...delegate.data.subarray(0, 8)]).toEqual([...ADD_CASINO_ADMIN]);
    expect(delegate.keys[2]!.pubkey.equals(admin)).toBe(true);
    expect(delegate.keys[3]!.pubkey.equals(casinoAdminPda(casinoId, admin))).toBe(true);

    const revoke = removeCasinoAdminInstruction(authority, casinoId, admin);
    expect([...revoke.data]).toEqual([...REMOVE_CASINO_ADMIN]);
    expect(revoke.keys).toHaveLength(2);
  });

  test('a delegated admin registers one dealer key per game', () => {
    const ix = addCasinoDealerInstruction(admin, casinoId, 6, dealer);
    expect([...ix.data.subarray(0, 8)]).toEqual([...ADD_CASINO_DEALER]);
    expect(ix.data[40]).toBe(6);
    expect(ix.keys[4]!.pubkey.equals(casinoDealerPda(casinoId, 6, dealer))).toBe(true);

    const remove = removeCasinoDealerInstruction(admin, casinoId, 6, dealer);
    expect([...remove.data]).toEqual([...REMOVE_CASINO_DEALER]);
    expect(casinoOperatorMetas(casinoId, admin)).toEqual([
      { pubkey: casinoPda(casinoId), isSigner: false, isWritable: false },
      { pubkey: casinoAdminPda(casinoId, admin), isSigner: false, isWritable: false },
    ]);
  });
});
