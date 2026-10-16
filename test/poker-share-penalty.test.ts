import { describe, expect, test } from 'bun:test';
import {
  POKER_SHARE_STAKE_BLINDS,
  POKER_UNSEAL_CHALLENGE_MS,
  requiredShareStake,
  settleBadUnseal,
  UnsealChallengeWindow,
} from '../src/poker-share-penalty';

const smallBlind = 10n;
const stake = requiredShareStake(smallBlind);

describe('poker unseal penalty', () => {
  test('the share stake is ten small blinds', () => {
    expect(POKER_SHARE_STAKE_BLINDS).toBe(10n);
    expect(stake).toBe(100n);
  });

  test('one cheater loses their pot and stake; the rest are refunded', () => {
    const penalty = settleBadUnseal({
      contributions: [20n, 40n, 60n],
      stakes: [stake, stake, stake],
      cheaters: [1],
    });

    expect(penalty.kicked).toEqual([1]);
    expect(penalty.houseFromPot).toBe(40n);
    expect(penalty.houseFromStake).toBe(stake);
    expect(penalty.refunds).toEqual([20n, 0n, 60n]);
    expect(penalty.returnedStake).toEqual([stake, 0n, stake]);
    expect(penalty.slashedStake[1]).toBe(stake);
  });

  test('every cheater is kicked and slashed', () => {
    const penalty = settleBadUnseal({
      contributions: [10n, 30n, 50n],
      stakes: [stake, stake, stake],
      cheaters: [0, 2],
    });

    expect(penalty.kicked).toEqual([0, 2]);
    expect(penalty.houseFromPot).toBe(60n);
    expect(penalty.houseFromStake).toBe(stake * 2n);
    expect(penalty.refunds).toEqual([0n, 30n, 0n]);
    expect(penalty.returnedStake[1]).toBe(stake);
    expect(penalty.slashedStake[0]).toBe(stake);
    expect(penalty.slashedStake[2]).toBe(stake);
  });

  test('a fair unseal cannot slash or refund the pot', () => {
    expect(() => settleBadUnseal({
      contributions: [10n, 20n],
      stakes: [stake, stake],
      cheaters: [],
    })).toThrow('unseal slash requires a mismatched share');
  });

  test('the first mismatch leaves two minutes for the other players', () => {
    const window = new UnsealChallengeWindow();
    const opened = 1_000;
    window.recordMismatch(10, 1, opened);

    const challenge = window.challenge;
    expect(challenge).toBeDefined();
    expect(challenge!.street).toBe(10);
    expect(challenge!.deadline - challenge!.openedAt).toBe(POKER_UNSEAL_CHALLENGE_MS);
    expect(challenge!.closed).toBe(false);
    expect(() => window.close(opened + 1_000, false)).toThrow('the unseal window is still open');
  });

  test('a second cheater is included when they reveal before the deadline', () => {
    const window = new UnsealChallengeWindow();
    const opened = 5_000;
    window.recordMismatch(3, 0, opened);
    window.recordMismatch(3, 2, opened + 30_000);

    expect(window.closed).toBe(false);
    expect(window.cheaters).toEqual([0, 2]);
    const penalty = settleBadUnseal({
      contributions: [10n, 30n, 50n],
      stakes: [stake, stake, stake],
      cheaters: window.cheaters,
    });
    expect(penalty.kicked).toEqual([0, 2]);
    expect(penalty.houseFromPot).toBe(60n);
    expect(penalty.houseFromStake).toBe(stake * 2n);
    expect(penalty.refunds).toEqual([0n, 30n, 0n]);
  });

  test('the hand ends at the deadline and a late reveal is not added', () => {
    const window = new UnsealChallengeWindow();
    const opened = 5_000;
    window.recordMismatch(3, 0, opened);
    expect(() => window.recordMismatch(3, 2, opened + POKER_UNSEAL_CHALLENGE_MS)).toThrow(
      'the unseal window has closed',
    );
    expect(window.closed).toBe(true);
    expect(window.cheaters).toEqual([0]);
    expect(window.close(opened + POKER_UNSEAL_CHALLENGE_MS, false)).toEqual([0]);
  });

  test('the hand ends once every player has revealed the challenged street', () => {
    const window = new UnsealChallengeWindow();
    const opened = 5_000;
    window.recordMismatch(11, 1, opened);
    window.recordMismatch(11, 0, opened + 2_000);
    expect(window.close(opened + 2_000, true)).toEqual([0, 1]);
    expect(window.closed).toBe(true);
  });
});
