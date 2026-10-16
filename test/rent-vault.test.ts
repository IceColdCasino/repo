import { describe, expect, test } from 'bun:test';
import { web3 } from '@coral-xyz/anchor';
import { LIGHT_CASINO_PROGRAM_ID } from '../src/testing/deploy';
import {
  DEPOSIT_RENT_VAULT,
  INIT_RENT_VAULT,
  RECAPTURE_RENT_VAULT,
  REIMBURSE_RENT_VAULT,
  RENT_VAULT_DISCRIMINATOR,
  RENT_VAULT_FLOAT,
  SETTLE_RENT_VAULT,
  clusterRentLamportsPerByte,
  vaultKeepLamports,
  CLOSE_PLAYER_STATE,
  CLOSE_SEAT_RENT,
  CLOSE_SHARE_RECEIPT,
  DRAW_RENT_VAULT,
  SIT_OUT,
  casinoRentAuthority,
  leadingVaultMeta,
  rememberRentVault,
  rentVaultFor,
  rentVaultPda,
  computationFloat,
  rentVaultFloat,
  shuffleLaneFloat,
  shuffleLanePlan,
} from '../src/chain/rent-vault';
import { KENO_REVEAL_IN_FLIGHT } from '../src/arcium/heap';
import { GameKind } from '../src/game-config';
import { EIGHT_DECK_CALLER_INPUTS, shuffleCallerInputs } from '../src/chain/shuffle-account';
import { RENT_LAMPORTS_PER_BYTE } from '../src/chain/fund-sol';

describe('rent vault', () => {
  test('discriminator and float match the on-chain layout', () => {
    expect([...RENT_VAULT_DISCRIMINATOR]).toEqual([43, 81, 226, 94, 234, 69, 162, 61]);
    expect([...INIT_RENT_VAULT]).toEqual([128, 44, 115, 145, 179, 116, 35, 71]);
    expect([...DEPOSIT_RENT_VAULT]).toEqual([82, 227, 109, 211, 164, 252, 29, 19]);
    expect([...SETTLE_RENT_VAULT]).toEqual([50, 42, 236, 195, 212, 4, 16, 118]);
    expect([...REIMBURSE_RENT_VAULT]).toEqual([115, 164, 214, 71, 94, 163, 207, 118]);
    expect([...RECAPTURE_RENT_VAULT]).toEqual([87, 110, 182, 107, 70, 130, 84, 241]);
    expect([...DRAW_RENT_VAULT]).toEqual([26, 179, 25, 154, 195, 181, 188, 146]);
    expect([...SIT_OUT]).toEqual([38, 153, 223, 30, 115, 79, 247, 171]);
    expect([...CLOSE_SEAT_RENT]).toEqual([173, 187, 32, 191, 86, 91, 119, 166]);
    expect([...CLOSE_PLAYER_STATE]).toEqual([107, 168, 253, 249, 125, 169, 108, 96]);
    expect([...CLOSE_SHARE_RECEIPT]).toEqual([85, 194, 8, 44, 250, 213, 244, 39]);
    expect(shuffleLanePlan().slots).toBe(105);
    expect(shuffleLanePlan().perLane).toBe(1);
    expect(shuffleLaneFloat()).toBe(417_635_400);
    expect(computationFloat()).toBe(64_000_000);
    expect(computationFloat(20)).toBe(160_000_000);
    expect(RENT_VAULT_FLOAT).toBe(878_548_880 + computationFloat());
    const funded = 501_021_080;
    const eight = vaultKeepLamports();
    expect(eight).toBe(1_021_080 + RENT_VAULT_FLOAT);
    expect(funded).toBeLessThan(eight);
    expect(vaultKeepLamports(209)).toBeLessThan(eight);
    const kenoCaller = shuffleCallerInputs(GameKind.Keno, 0, 0);
    const kenoEight = rentVaultFloat(kenoCaller);
    const kenoDraw = rentVaultFloat(kenoCaller, RENT_LAMPORTS_PER_BYTE, KENO_REVEAL_IN_FLIGHT);
    expect(kenoDraw - kenoEight).toBe(computationFloat(KENO_REVEAL_IN_FLIGHT) - computationFloat());
  });

  test('a lower rent rate shrinks the keep by the same ratio, except the fixed lane fee', () => {
    const eight = vaultKeepLamports();
    const cheaper = vaultKeepLamports(EIGHT_DECK_CALLER_INPUTS, RENT_LAMPORTS_PER_BYTE / 2);
    const fixed = shuffleLanePlan().fee + computationFloat();
    expect((eight - fixed) % 2).toBe(0);
    expect(eight - cheaper).toBe((eight - fixed) / 2);
  });

  test('the cluster rent rate is the gap between an empty account and a one-byte account', async () => {
    const connection = {
      getMinimumBalanceForRentExemption(dataLength: number) {
        return Promise.resolve(4_000 * (dataLength + 128));
      },
    };
    expect(await clusterRentLamportsPerByte(connection)).toBe(4_000);
  });

  test('a rent sysvar that is not a flat per-byte charge is rejected', async () => {
    const connection = {
      getMinimumBalanceForRentExemption(dataLength: number) {
        return Promise.resolve(dataLength === 0 ? 100 : 200);
      },
    };
    await expect(clusterRentLamportsPerByte(connection)).rejects.toThrow(/flat per-byte/);
  });

  test('the vault is one account per player in a room', () => {
    const roomId = new Uint8Array(32).fill(7);
    const player = web3.Keypair.generate().publicKey;
    const other = web3.Keypair.generate().publicKey;
    const vault = rentVaultPda(roomId, player);
    expect(rentVaultPda(roomId, player).equals(vault)).toBe(true);
    expect(rentVaultPda(roomId, other).equals(vault)).toBe(false);
    rememberRentVault(player, vault);
    expect(rentVaultFor(player)?.equals(vault)).toBe(true);
    expect(leadingVaultMeta(player)).toEqual([
      { pubkey: vault, isSigner: false, isWritable: true },
    ]);
    expect(leadingVaultMeta(other)).toEqual([]);
    const casino = new web3.PublicKey(LIGHT_CASINO_PROGRAM_ID);
    expect(casinoRentAuthority(casino).equals(casino)).toBe(false);
  });
});
