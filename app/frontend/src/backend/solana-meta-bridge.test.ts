import { describe, expect, it } from 'vitest';
import { mergeSharedHandMetaJson } from './solana-meta-bridge';

describe('mergeSharedHandMetaJson', () => {
  it('OR-merges registeredMask bits from parallel seats', () => {
    const seat0 = JSON.stringify({
      gameIdHex: 'abc',
      numPlayers: 2,
      registeredMask: 1,
      shuffledMask: 0,
      sharedMask: 0,
      elGamalPublicKeys: [['1', '2'], null],
    });
    const seat1 = JSON.stringify({
      gameIdHex: 'abc',
      numPlayers: 2,
      registeredMask: 2,
      shuffledMask: 0,
      sharedMask: 0,
      elGamalPublicKeys: [null, ['3', '4']],
    });
    const merged = JSON.parse(mergeSharedHandMetaJson(seat0, seat1)) as {
      registeredMask: number;
      elGamalPublicKeys: Array<[string, string] | null>;
    };
    expect(merged.registeredMask).toBe(3);
    expect(merged.elGamalPublicKeys[0]).toEqual(['1', '2']);
    expect(merged.elGamalPublicKeys[1]).toEqual(['3', '4']);
  });

  it('prefers incoming when gameIdHex differs', () => {
    const oldHand = JSON.stringify({ gameIdHex: 'old', registeredMask: 3 });
    const newHand = JSON.stringify({ gameIdHex: 'new', registeredMask: 0 });
    const merged = JSON.parse(mergeSharedHandMetaJson(oldHand, newHand)) as {
      gameIdHex: string;
      registeredMask: number;
    };
    expect(merged.gameIdHex).toBe('new');
    expect(merged.registeredMask).toBe(0);
  });
});
