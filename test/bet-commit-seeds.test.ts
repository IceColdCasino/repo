import { describe, expect, test } from 'bun:test';
import { LightProtocolStorageHelper } from '../src/chain/light-storage';

describe('bet commitment light address', () => {
  test('seeds are bet_commit, the game id, and the seat', () => {
    const gameId = new Uint8Array(32).fill(9);
    const seeds = LightProtocolStorageHelper.betCommitSeedParts(gameId, 4);
    expect(seeds.map((part) => Buffer.from(part).toString('hex'))).toEqual([
      Buffer.from('bet_commit').toString('hex'),
      Buffer.from(gameId).toString('hex'),
      '04',
    ]);
  });

  test('rejects a game id that is not 32 bytes', () => {
    expect(() =>
      LightProtocolStorageHelper.betCommitSeedParts(new Uint8Array(31), 0),
    ).toThrow(/32 bytes/);
  });
});
