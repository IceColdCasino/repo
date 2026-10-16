import { describe, expect, test } from 'bun:test';
import { LEGACY_TX_BYTES, senderLogsTxSize } from '../src/chain/onchain-game-lifecycle';

describe('transaction size log', () => {
  test('a bingo showdown row that fits is logged by the sender only', () => {
    // The suite printed "[tx-size] tx:hash_bingo_showdown_row ... 591 bytes" twice.
    expect(senderLogsTxSize(591)).toBe(true);
    expect(591).toBeLessThanOrEqual(LEGACY_TX_BYTES);
  });

  test('an oversized keno showdown is logged before the lookup table path', () => {
    expect(senderLogsTxSize(1442)).toBe(false);
    expect(senderLogsTxSize(LEGACY_TX_BYTES)).toBe(true);
    expect(senderLogsTxSize(LEGACY_TX_BYTES + 1)).toBe(false);
  });
});
