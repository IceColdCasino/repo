/**
 * Baccarat share stake. Same shape as poker: 10 times the seat's wager,
 * posted before share, slashed only when an unseal misses a street hash.
 * The unseal window is the poker window, so every bad share on that street
 * can be caught before the hand ends.
 */

import {
  POKER_SHARE_STAKE_BLINDS,
  POKER_UNSEAL_CHALLENGE_MS,
  requiredShareStake,
  settleBadUnseal,
  type ShareUnsealPenalty,
} from './poker-share-penalty';

export const BACCARAT_SHARE_STAKE_MULTIPLE = POKER_SHARE_STAKE_BLINDS;
export const BACCARAT_UNSEAL_CHALLENGE_MS = POKER_UNSEAL_CHALLENGE_MS;

export function requiredBaccaratShareStake(wager: bigint): bigint {
  return requiredShareStake(wager);
}

export function settleBadBaccaratUnseal(args: {
  wagers: readonly bigint[];
  stakes: readonly bigint[];
  cheaters: readonly number[];
}): ShareUnsealPenalty {
  return settleBadUnseal({
    contributions: args.wagers,
    stakes: args.stakes,
    cheaters: args.cheaters,
  });
}

export type { ShareUnsealPenalty };
