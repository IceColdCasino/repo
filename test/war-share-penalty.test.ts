import { describe, expect, test } from 'bun:test';
import {
  requiredWarShareStake,
  slashUnsharedPlayers,
  WAR_PLAYER_SHARE_MS,
  WAR_SHARE_STAKE_MULTIPLE,
} from '../src/war-share-penalty';

describe('war share slash', () => {
  test('the stake is ten times the wager', () => {
    expect(WAR_SHARE_STAKE_MULTIPLE).toBe(10n);
    expect(requiredWarShareStake(15n)).toBe(150n);
    expect(WAR_PLAYER_SHARE_MS).toBe(180_000);
  });

  test('a player who does not share after the casino is slashed', () => {
    const opened = 5_000;
    const penalty = slashUnsharedPlayers({
      casinoSeat: 1,
      casinoSharedAt: opened,
      now: opened + WAR_PLAYER_SHARE_MS,
      shared: [false, true],
      wagers: [25n, 100n],
      stakes: [250n, 1000n],
    });
    expect(penalty.slashed).toEqual([0]);
    expect(penalty.houseFromWager).toBe(25n);
    expect(penalty.houseFromStake).toBe(250n);
  });

  test('the slash waits until the share window closes', () => {
    expect(() => slashUnsharedPlayers({
      casinoSeat: 1,
      casinoSharedAt: 5_000,
      now: 5_000 + WAR_PLAYER_SHARE_MS - 1,
      shared: [false, true],
      wagers: [25n, 100n],
      stakes: [250n, 1000n],
    })).toThrow('players can still share');
  });

  test('every late player is slashed and the casino is not', () => {
    const penalty = slashUnsharedPlayers({
      casinoSeat: 2,
      casinoSharedAt: 0,
      now: WAR_PLAYER_SHARE_MS,
      shared: [false, false, true],
      wagers: [10n, 30n, 50n],
      stakes: [100n, 300n, 500n],
    });
    expect(penalty.slashed).toEqual([0, 1]);
    expect(penalty.houseFromWager).toBe(40n);
    expect(penalty.houseFromStake).toBe(400n);
  });

  test('a hand where every player shared is not slashed', () => {
    expect(() => slashUnsharedPlayers({
      casinoSeat: 1,
      casinoSharedAt: 0,
      now: WAR_PLAYER_SHARE_MS,
      shared: [true, true],
      wagers: [10n, 10n],
      stakes: [100n, 100n],
    })).toThrow('every player shared');
  });
});
