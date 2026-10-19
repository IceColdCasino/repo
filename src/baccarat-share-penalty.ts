/**
 * Baccarat share stake. Ten times the seat's wager, posted before share,
 * slashed only when an unseal misses a street hash. The unseal window is the
 * poker window, so every bad share on that street can be caught before the
 * hand ends. A slashed baccarat stake is chips and stays with the house.
 */

import {
  POKER_UNSEAL_CHALLENGE_MS,
  type ShareUnsealPenalty,
} from './poker-share-penalty';

export const BACCARAT_SHARE_STAKE_MULTIPLE = 10n;
export const BACCARAT_UNSEAL_CHALLENGE_MS = POKER_UNSEAL_CHALLENGE_MS;

export function requiredBaccaratShareStake(wager: bigint): bigint {
  if (wager <= 0n) throw new Error('wager must be positive');
  return wager * BACCARAT_SHARE_STAKE_MULTIPLE;
}

export function settleBadBaccaratUnseal(args: {
  wagers: readonly bigint[];
  stakes: readonly bigint[];
  cheaters: readonly number[];
}): ShareUnsealPenalty {
  const { wagers, stakes } = args;
  if (wagers.length !== stakes.length) {
    throw new Error('each seat needs a pot contribution and a share stake');
  }
  const kicked: number[] = [];
  const seen = new Set<number>();
  for (const seat of args.cheaters) {
    if (seen.has(seat)) continue;
    if (seat < 0 || seat >= wagers.length) {
      throw new Error(`cheater seat ${seat} is not in the hand`);
    }
    seen.add(seat);
    kicked.push(seat);
  }
  if (kicked.length === 0) {
    throw new Error('unseal slash requires a mismatched share');
  }

  const refunds = wagers.map(() => 0n);
  const slashedStake = wagers.map(() => 0n);
  const returnedStake = wagers.map(() => 0n);
  const paidToPlayers = wagers.map(() => 0n);
  let houseFromPot = 0n;
  let houseFromStake = 0n;
  for (let seat = 0; seat < wagers.length; seat++) {
    const wager = wagers[seat]!;
    const stake = stakes[seat]!;
    if (wager < 0n || stake < 0n) throw new Error(`seat ${seat} has a negative balance`);
    if (seen.has(seat)) {
      houseFromPot += wager;
      houseFromStake += stake;
      slashedStake[seat] = stake;
    } else {
      refunds[seat] = wager;
      returnedStake[seat] = stake;
      paidToPlayers[seat] = stake;
    }
  }

  return {
    kicked,
    houseFromPot,
    houseFromStake,
    protocolLamports: 0n,
    paidToPlayers,
    playerFromCheater: kicked.map(() => 0n),
    refunds,
    slashedStake,
    returnedStake,
  };
}

export type { ShareUnsealPenalty };
