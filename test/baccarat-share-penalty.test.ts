import { describe, expect, test } from 'bun:test';
import { baccaratStreetCards, baccaratStreetName, BACCARAT_STREET_COUNT } from '../src/baccarat';
import {
  BACCARAT_SHARE_STAKE_MULTIPLE,
  BACCARAT_UNSEAL_CHALLENGE_MS,
  requiredBaccaratShareStake,
  settleBadBaccaratUnseal,
} from '../src/baccarat-share-penalty';
import { UnsealChallengeWindow } from '../src/poker-share-penalty';

describe('baccarat street stake', () => {
  test('four streets follow the draw', () => {
    expect(BACCARAT_STREET_COUNT).toBe(4);
    expect(baccaratStreetCards(0)).toEqual([0, 1]);
    expect(baccaratStreetCards(1)).toEqual([2, 3]);
    expect(baccaratStreetCards(2)).toEqual([4]);
    expect(baccaratStreetCards(3)).toEqual([5]);
    expect(baccaratStreetName(0)).toBe('player hand');
    expect(baccaratStreetName(3)).toBe('banker third');
  });

  test('the share stake is ten times the wager', () => {
    expect(BACCARAT_SHARE_STAKE_MULTIPLE).toBe(10n);
    expect(requiredBaccaratShareStake(5n)).toBe(50n);
    expect(BACCARAT_UNSEAL_CHALLENGE_MS).toBe(120_000);
  });

  test('a bad street slashes that seat and a second seat can still be caught', () => {
    const window = new UnsealChallengeWindow();
    const opened = 1_000;
    window.recordMismatch(0, 0, opened);
    window.recordMismatch(0, 1, opened + 10_000);
    const penalty = settleBadBaccaratUnseal({
      wagers: [20n, 20n],
      stakes: [200n, 200n],
      cheaters: window.cheaters,
    });
    expect(window.closed).toBe(false);
    expect(penalty.kicked).toEqual([0, 1]);
    expect(penalty.houseFromPot).toBe(40n);
    expect(penalty.houseFromStake).toBe(400n);
    expect(penalty.refunds).toEqual([0n, 0n]);
  });
});
