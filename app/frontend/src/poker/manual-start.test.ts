import { describe, expect, it } from 'vitest';
import { canBeginHand, tableReadyToStart, type ManualSeat } from './manual-start';
import { hasSitChips, MIN_SIT_CHIPS } from '@poker-src/chain/sit-minimum';

const seats: ManualSeat[] = [
  { seat: 0, publicKey: 'wallet-a', chips: '0' },
  { seat: 1, publicKey: 'wallet-b', chips: '0' },
];

describe('manual start', () => {
  it('starts once more than one player is seated', () => {
    expect(tableReadyToStart([{ seat: 0, publicKey: 'a' }])).toBe(false);
    expect(tableReadyToStart(seats)).toBe(true);
    expect(canBeginHand('wallet-a', seats)).toBe(true);
    expect(canBeginHand('wallet-c', seats)).toBe(false);
  });

  it('requires the minimum personal balance before sitting', () => {
    expect(hasSitChips(MIN_SIT_CHIPS - 1n)).toBe(false);
    expect(hasSitChips(MIN_SIT_CHIPS)).toBe(true);
  });
});