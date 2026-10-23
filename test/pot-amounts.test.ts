import { describe, expect, test } from 'bun:test';
import {
  choosePotAmounts,
  decodeSyncedU64Field,
  snapshotPots,
} from '../src/chain/pot-amounts';

function leField(value: bigint): number[] {
  const out = Array.from({ length: 32 }, () => 0);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

describe('encrypted pot amounts', () => {
  test('decodes a little-endian synced field', () => {
    expect(decodeSyncedU64Field(leField(40n))).toBe(40n);
    expect(decodeSyncedU64Field(leField(0n))).toBe(0n);
  });

  test('rejects a real ciphertext', () => {
    const bytes = leField(40n);
    bytes[31] = 1;
    expect(decodeSyncedU64Field(bytes)).toBeNull();
  });

  test('prefers encrypted pots over the plaintext mirror', () => {
    const amounts = choosePotAmounts({
      encryptedFields: [leField(40n), leField(0n)],
      plaintextPots: [0n],
      playerTotals: [10n, 10n],
    });
    expect(amounts[0]).toBe(40n);
    expect(snapshotPots(amounts)).toEqual([{ amount: '40', lastBet: '0' }]);
  });

  test('keeps a later side pot index', () => {
    expect(snapshotPots([0n, 15n])).toEqual([
      { amount: '0', lastBet: '0' },
      { amount: '15', lastBet: '0' },
    ]);
  });

  test('falls back to committed totals when both pot slots are empty', () => {
    expect(choosePotAmounts({
      encryptedFields: [leField(0n)],
      plaintextPots: [0n],
      playerTotals: [20n, 20n],
    })).toEqual([40n]);
  });
});
