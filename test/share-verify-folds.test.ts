import { describe, expect, test } from 'bun:test';
import {
  contiguousShareVerifyChunks,
  recipientMajorVerifyChunks,
} from '../src/chain/share-deck-staging';

describe('share verify folds', () => {
  test('keno 2p is twenty 4-limb jobs', () => {
    const chunks = contiguousShareVerifyChunks(2, 20);
    expect(chunks).toHaveLength(20);
    expect(chunks.every((c) => c.limbCount === 4)).toBe(true);
    expect(chunks[0]).toEqual({ startIndex: 0, limbCount: 4 });
    expect(chunks[19]).toEqual({ startIndex: 76, limbCount: 4 });
  });

  test('blackjack chunk is sixteen 4-limb jobs', () => {
    const chunks = contiguousShareVerifyChunks(2, 16);
    expect(chunks).toHaveLength(16);
    expect(chunks.every((c) => c.limbCount === 4)).toBe(true);
    expect(chunks[15]).toEqual({ startIndex: 60, limbCount: 4 });
  });

  test('baccarat is six 4-limb jobs', () => {
    expect(contiguousShareVerifyChunks(2, 6).map((c) => c.limbCount)).toEqual([
      4, 4, 4, 4, 4, 4,
    ]);
  });

  test('roulette and craps stay 4-limb jobs', () => {
    expect(contiguousShareVerifyChunks(2, 1).map((c) => c.limbCount)).toEqual([4]);
    expect(contiguousShareVerifyChunks(2, 2).map((c) => c.limbCount)).toEqual([4, 4]);
  });

  test('poker 2p is four hole jobs plus five community jobs', () => {
    expect(recipientMajorVerifyChunks(2).map((c) => [c.startIndex, c.limbCount])).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 4],
      [80, 4],
      [84, 4],
      [88, 4],
      [92, 4],
      [96, 4],
    ]);
  });
});
