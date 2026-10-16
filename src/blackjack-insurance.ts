/**
 * Blackjack insurance / even-money rules.
 *
 * Insurance is offered only after the initial deal when the dealer upcard is an
 * Ace, before the hole card is revealed to the player and before any further
 * hit/stand/split/double. Stake is at most half the main bet; pays 2:1 if the
 * dealer has a natural, otherwise the insurance stake is lost.
 */
import { cardToRank, rankToHardValue, computeHandValue } from './blackjack';

export interface InsuranceWindow {
  /** Dealer upcard is an Ace. */
  dealerUpIsAce: boolean;
  /** Player still on the initial two-card hand (pre hit/split/double). */
  playerCardCount: number;
  /** Hole card already revealed to the betting player. */
  holeRevealedToPlayer: boolean;
  /** Player has already acted beyond the initial deal (hit/split/stand/double). */
  playerHasActed: boolean;
}

export type InsuranceDecision =
  | { kind: 'decline' }
  | { kind: 'insurance'; stake: bigint }
  | { kind: 'evenMoney' };

/** True when the shoe card face is an Ace (rank 12). */
export function isAceCard(cardIndex: number): boolean {
  return rankToHardValue(cardToRank(cardIndex)).isAce;
}

/** Dealer offers insurance iff the face-up card is an Ace. */
export function dealerOffersInsurance(dealerUpcard: number): boolean {
  return isAceCard(dealerUpcard);
}

/**
 * Hard gate: insurance (or even money) may be bought only in the post-deal,
 * Ace-up, pre-hole, pre-action window.
 */
export function canBuyInsurance(window: InsuranceWindow): boolean {
  return (
    window.dealerUpIsAce
    && window.playerCardCount === 2
    && !window.holeRevealedToPlayer
    && !window.playerHasActed
  );
}

export function assertInsuranceAllowed(window: InsuranceWindow): void {
  if (!canBuyInsurance(window)) {
    throw new Error(
      'Insurance only allowed when dealer upcard is Ace, on the initial '
        + 'two-card hand, before hole reveal and before further actions',
    );
  }
}

/** Max insurance stake is half the main bet (integer division). */
export function insuranceStake(mainBet: bigint): bigint {
  if (mainBet <= 0n) throw new Error('mainBet must be positive');
  return mainBet / 2n;
}

/**
 * Net chip delta for an insurance side bet.
 * Dealer natural → +2×stake (2:1); otherwise −stake.
 */
export function insuranceNet(stake: bigint, dealerHasBlackjack: boolean): bigint {
  if (stake < 0n) throw new Error('insurance stake must be non-negative');
  if (stake === 0n) return 0n;
  return dealerHasBlackjack ? stake * 2n : -stake;
}

/** Even money is only meaningful when the player has a natural vs Ace up. */
export function canTakeEvenMoney(
  window: InsuranceWindow,
  playerCards: number[],
): boolean {
  if (!canBuyInsurance(window)) return false;
  return computeHandValue(playerCards, 2).isBlackjack === 1;
}

/**
 * Resolve a decision against the insurance window.
 * Throws if the player tries to buy outside the allowed window or with a bad stake.
 */
export function resolveInsuranceDecision(
  window: InsuranceWindow,
  decision: InsuranceDecision,
  mainBet: bigint,
  playerCards: number[],
): InsuranceDecision {
  if (decision.kind === 'decline') return decision;
  assertInsuranceAllowed(window);
  if (decision.kind === 'evenMoney') {
    if (!canTakeEvenMoney(window, playerCards)) {
      throw new Error('Even money requires a player natural vs dealer Ace');
    }
    return decision;
  }
  const max = insuranceStake(mainBet);
  if (decision.stake <= 0n || decision.stake > max) {
    throw new Error(`Insurance stake must be in (0, ${max}]`);
  }
  return decision;
}

/**
 * E2E / bot policy: take max insurance when offered (exercises the path).
 * Prefer even money when the player already has a natural.
 */
export function defaultInsuranceDecision(
  window: InsuranceWindow,
  mainBet: bigint,
  playerCards: number[],
): InsuranceDecision {
  if (!canBuyInsurance(window)) return { kind: 'decline' };
  if (canTakeEvenMoney(window, playerCards)) return { kind: 'evenMoney' };
  return { kind: 'insurance', stake: insuranceStake(mainBet) };
}
