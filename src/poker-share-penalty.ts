/**
 * Poker share-integrity stake and the unseal penalty.
 *
 * The stake is `POKER_SHARE_STAKE_BLINDS` small blinds, posted before a
 * player shares. It is slashed only when a receiving player unseals partials
 * that do not match the street hash published at share time. A cheater is
 * removed from the hand, their pot contribution is taken by the house, and
 * every other player's contribution is refunded. Each cheater is penalized
 * the same way.
 */

/** Posted before share. Slashed only at unseal, and only on a hash mismatch. */
export const POKER_SHARE_STAKE_BLINDS = 10n;

/**
 * After the first bad unseal, other players have this long to reveal the
 * same street and be checked. The hand ends when the window expires.
 */
export const POKER_UNSEAL_CHALLENGE_MS = 120_000;

export type UnsealChallenge = {
  street: number;
  openedAt: number;
  deadline: number;
  closed: boolean;
};

export function openUnsealChallenge(street: number, now: number): UnsealChallenge {
  if (!Number.isInteger(street) || street < 0 || street > 12) {
    throw new Error(`poker street ${street} is out of range`);
  }
  if (!Number.isFinite(now)) {
    throw new Error('unseal time is not a timestamp');
  }
  return {
    street,
    openedAt: now,
    deadline: now + POKER_UNSEAL_CHALLENGE_MS,
    closed: false,
  };
}

/** A reveal is accepted only before the deadline, and only while the hand is still open. */
export function unsealChallengeAccepts(challenge: UnsealChallenge, now: number): boolean {
  return !challenge.closed && now < challenge.deadline;
}

/**
 * End the hand at the deadline. End sooner when every player has already
 * revealed the challenged street, so nobody is still waiting to be checked.
 */
export function unsealChallengeShouldClose(
  challenge: UnsealChallenge,
  now: number,
  streetFullyRevealed: boolean,
): boolean {
  if (challenge.closed) return false;
  return streetFullyRevealed || now >= challenge.deadline;
}

/**
 * Collects every sharer caught while the window is open.
 * A reveal at or after the deadline does not add another cheater.
 */
export class UnsealChallengeWindow {
  #challenge: UnsealChallenge | undefined;
  #cheaters = new Set<number>();

  get challenge(): UnsealChallenge | undefined {
    return this.#challenge;
  }

  get cheaters(): number[] {
    return [...this.#cheaters].sort((a, b) => a - b);
  }

  get closed(): boolean {
    return this.#challenge?.closed ?? false;
  }

  recordMismatch(street: number, sharer: number, now: number): void {
    if (this.#challenge?.closed) {
      throw new Error('the unseal window has closed');
    }
    if (this.#challenge && now >= this.#challenge.deadline) {
      this.#challenge = { ...this.#challenge, closed: true };
      throw new Error('the unseal window has closed');
    }
    if (!this.#challenge) {
      this.#challenge = openUnsealChallenge(street, now);
    }
    this.#cheaters.add(sharer);
  }

  close(now: number, streetFullyRevealed: boolean): number[] {
    if (!this.#challenge) return [];
    if (!this.#challenge.closed) {
      if (!unsealChallengeShouldClose(this.#challenge, now, streetFullyRevealed)) {
        throw new Error('the unseal window is still open');
      }
      this.#challenge = { ...this.#challenge, closed: true };
    }
    return this.cheaters;
  }
}

export type ShareUnsealPenalty = {
  /** Sharers whose opened partials missed the published street hash. */
  kicked: number[];
  /** Cheaters' pot contributions, taken by the house. */
  houseFromPot: bigint;
  /** Slashed share stakes, taken by the house. */
  houseFromStake: bigint;
  /** Honest players receive their pot contribution back. */
  refunds: bigint[];
  slashedStake: bigint[];
  returnedStake: bigint[];
};

export function requiredShareStake(smallBlind: bigint): bigint {
  if (smallBlind <= 0n) {
    throw new Error('small blind must be positive');
  }
  return smallBlind * POKER_SHARE_STAKE_BLINDS;
}

/**
 * Settle a hand whose unseal proved one or more bad shares.
 * An empty cheater list is rejected so a fair hand cannot be refunded here.
 */
export function settleBadUnseal(args: {
  contributions: readonly bigint[];
  stakes: readonly bigint[];
  cheaters: readonly number[];
}): ShareUnsealPenalty {
  const { contributions, stakes } = args;
  if (contributions.length !== stakes.length) {
    throw new Error('each seat needs a pot contribution and a share stake');
  }
  const kicked = [...new Set(args.cheaters)].sort((a, b) => a - b);
  if (kicked.length === 0) {
    throw new Error('unseal slash requires a mismatched share');
  }
  for (const seat of kicked) {
    if (seat < 0 || seat >= contributions.length) {
      throw new Error(`cheater seat ${seat} is not in the hand`);
    }
  }

  const kickedSet = new Set(kicked);
  const refunds = contributions.map(() => 0n);
  const slashedStake = contributions.map(() => 0n);
  const returnedStake = contributions.map(() => 0n);
  let houseFromPot = 0n;
  let houseFromStake = 0n;

  for (let seat = 0; seat < contributions.length; seat++) {
    const contribution = contributions[seat]!;
    const stake = stakes[seat]!;
    if (contribution < 0n || stake < 0n) {
      throw new Error(`seat ${seat} has a negative balance`);
    }
    if (kickedSet.has(seat)) {
      houseFromPot += contribution;
      houseFromStake += stake;
      slashedStake[seat] = stake;
    } else {
      refunds[seat] = contribution;
      returnedStake[seat] = stake;
    }
  }

  return {
    kicked,
    houseFromPot,
    houseFromStake,
    refunds,
    slashedStake,
    returnedStake,
  };
}
