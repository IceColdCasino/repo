import { describe, expect, test } from 'bun:test';
import { GameKind } from '../src/game-config';
import type { Ciphertext } from '../src/zk-casino';
import { SHUFFLE_LANE_FEE_PER_TX, shuffleLanePlan } from '../src/chain/rent-vault';
import { shuffleCallerInputs } from '../src/chain/shuffle-account';
import { pokerStreetFieldGroups, shareStreetChunkCount } from '../src/share-street-fields';
import {
  POKER_RESHUFFLE_AND_SHARE_LAMPORTS,
  POKER_UNSEAL_CHALLENGE_MS,
  PROTOCOL_SHARE_PENALTY_LAMPORTS,
  requiredShareStake,
  settleBadUnseal,
  UnsealChallengeWindow,
} from '../src/poker-share-penalty';

const reshuffle = 100n;
const protocolPenalty = 10n;
const stake = 2n * reshuffle + protocolPenalty;

describe('poker unseal penalty', () => {
  test('the share stake is sol for every other player plus the protocol penalty', () => {
    const card = [0n, 0n, 0n, 0n] as Ciphertext;
    const grid = Array.from({ length: 9 }, () => Array.from({ length: 25 }, () => card));
    const shareChunks = shareStreetChunkCount(pokerStreetFieldGroups(grid));
    const shuffleFee = shuffleLanePlan(shuffleCallerInputs(GameKind.Poker, 1, 0)).fee;
    expect(POKER_RESHUFFLE_AND_SHARE_LAMPORTS).toBe(
      BigInt(shuffleFee + shareChunks * SHUFFLE_LANE_FEE_PER_TX),
    );
    expect(PROTOCOL_SHARE_PENALTY_LAMPORTS).toBe(100_000_000n);
    expect(requiredShareStake(2)).toBe(
      POKER_RESHUFFLE_AND_SHARE_LAMPORTS + PROTOCOL_SHARE_PENALTY_LAMPORTS,
    );
    expect(requiredShareStake(10)).toBe(
      9n * POKER_RESHUFFLE_AND_SHARE_LAMPORTS + PROTOCOL_SHARE_PENALTY_LAMPORTS,
    );
    expect(() => requiredShareStake(1)).toThrow('share stake needs 2 to 10 players');
  });

  test('one cheater pays the other players to reshuffle and share', () => {
    const penalty = settleBadUnseal({
      contributions: [20n, 40n, 60n],
      stakes: [stake, stake, stake],
      cheaters: [1],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });

    expect(penalty.kicked).toEqual([1]);
    expect(penalty.houseFromPot).toBe(40n);
    expect(penalty.houseFromStake).toBe(0n);
    expect(penalty.protocolLamports).toBe(0n);
    expect(penalty.paidToPlayers).toEqual([315n, 0n, 315n]);
    expect(penalty.playerFromCheater).toEqual([stake]);
    expect(penalty.refunds).toEqual([20n, 0n, 60n]);
    expect(penalty.returnedStake).toEqual([stake, 0n, stake]);
    expect(penalty.slashedStake[1]).toBe(stake);
  });

  test('a later cheater funds the protocol reshuffle and both are slashed', () => {
    const penalty = settleBadUnseal({
      contributions: [10n, 30n, 50n],
      stakes: [stake, stake, stake],
      cheaters: [0, 2],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });

    expect(penalty.kicked).toEqual([0, 2]);
    expect(penalty.houseFromPot).toBe(60n);
    expect(penalty.protocolLamports).toBe(300n);
    expect(penalty.paidToPlayers).toEqual([0n, 330n, 0n]);
    expect(penalty.playerFromCheater).toEqual([110n, 10n]);
    expect(penalty.refunds).toEqual([0n, 30n, 0n]);
    expect(penalty.returnedStake[1]).toBe(stake);
    expect(penalty.slashedStake[0]).toBe(stake);
    expect(penalty.slashedStake[2]).toBe(stake);
  });

  test('the first player caught is the one whose reshuffle fee stays with the table', () => {
    const penalty = settleBadUnseal({
      contributions: [10n, 30n, 50n],
      stakes: [stake, stake, stake],
      cheaters: [2, 0],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });

    expect(penalty.kicked).toEqual([2, 0]);
    expect(penalty.playerFromCheater).toEqual([110n, 10n]);
    expect(penalty.protocolLamports).toBe(300n);
  });

  test('when everyone cheats the protocol takes the whole slash', () => {
    const penalty = settleBadUnseal({
      contributions: [10n, 30n, 50n],
      stakes: [stake, stake, stake],
      cheaters: [1, 0, 2],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });

    expect(penalty.kicked).toEqual([1, 0, 2]);
    expect(penalty.protocolLamports).toBe(stake * 3n);
    expect(penalty.paidToPlayers).toEqual([0n, 0n, 0n]);
    expect(penalty.playerFromCheater).toEqual([0n, 0n, 0n]);
    expect(penalty.houseFromPot).toBe(90n);
    expect(penalty.refunds).toEqual([0n, 0n, 0n]);
  });

  test('an odd protocol penalty leaves the extra lamport with the lowest remaining seat', () => {
    const four = 3n * reshuffle + protocolPenalty;
    const penalty = settleBadUnseal({
      contributions: [1n, 1n, 1n, 1n],
      stakes: [four, four, four, four],
      cheaters: [3],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });

    expect(penalty.protocolLamports).toBe(0n);
    expect(penalty.paidToPlayers).toEqual([
      four + reshuffle + 4n,
      four + reshuffle + 3n,
      four + reshuffle + 3n,
      0n,
    ]);
  });

  test('a fair unseal cannot slash or refund the pot', () => {
    expect(() => settleBadUnseal({
      contributions: [10n, 20n],
      stakes: [reshuffle + protocolPenalty, reshuffle + protocolPenalty],
      cheaters: [],
      reshuffleAndShare: reshuffle,
      protocolPenalty,
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
      reshuffleAndShare: reshuffle,
      protocolPenalty,
    });
    expect(penalty.kicked).toEqual([0, 2]);
    expect(penalty.protocolLamports).toBe(300n);
    expect(penalty.paidToPlayers[1]).toBe(330n);
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
    expect(window.close(opened + 2_000, true)).toEqual([1, 0]);
    expect(window.closed).toBe(true);
  });
});
