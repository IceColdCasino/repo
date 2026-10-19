/**
 * Poker share-integrity stake and the unseal penalty.
 *
 * The stake is SOL, posted before a player shares. It is not a blind.
 * Each player posts the signature fees for every other player to reshuffle
 * and share, plus the protocol's flat penalty. The rent float is funded
 * again with the hand and is not part of the stake. It is slashed only when a receiving
 * player unseals partials that do not match the street hash published at
 * share time.
 *
 * The first cheater's reshuffle lamports pay the players who still have to
 * redo the shuffle and the share. That cheater's protocol penalty is split
 * across those same players. A later cheater is slashed the same amount, and
 * their reshuffle lamports go to the protocol. Their protocol penalty still
 * goes to the remaining players. When every player cheated, the whole slash
 * goes to the protocol. Cheater pot chips are taken by the house. Honest pot
 * chips are refunded.
 */

/**
 * Signature fees for one player to reshuffle a 1-deck shoe and share again.
 * Fourteen shuffle chunks and seventy-five share uploads, at 10,000 lamports
 * each (one signature plus a retry). Rent is left out.
 */
export const POKER_RESHUFFLE_AND_SHARE_LAMPORTS = 890_000n;

/** Flat lamports added to every share slash. The protocol sets this. */
export const PROTOCOL_SHARE_PENALTY_LAMPORTS = 100_000_000n;

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
 * Collects every sharer caught while the window is open, in the order they
 * were caught. A reveal at or after the deadline does not add another cheater.
 */
export class UnsealChallengeWindow {
  #challenge: UnsealChallenge | undefined;
  #cheaters: number[] = [];

  get challenge(): UnsealChallenge | undefined {
    return this.#challenge;
  }

  get cheaters(): number[] {
    return [...this.#cheaters];
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
    if (!this.#cheaters.includes(sharer)) this.#cheaters.push(sharer);
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
  /** Sharers whose opened partials missed the published street hash, in the order caught. */
  kicked: number[];
  /** Cheaters' pot contributions, taken by the house. */
  houseFromPot: bigint;
  /**
   * Slashed share stake kept by the house. Poker is zero: the SOL stake is
   * paid to the remaining players and the protocol.
   */
  houseFromStake: bigint;
  /** SOL credited to the protocol treasury. */
  protocolLamports: bigint;
  /** SOL each seat receives, including a returned stake. */
  paidToPlayers: bigint[];
  /** Of each kicked seat's slash, the lamports paid to the remaining players. */
  playerFromCheater: bigint[];
  /** Honest players receive their pot contribution back. */
  refunds: bigint[];
  slashedStake: bigint[];
  returnedStake: bigint[];
};

/** SOL posted before share. One reshuffle-and-share for every other player, plus the protocol penalty. */
export function requiredShareStake(playerCount: number): bigint {
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 10) {
    throw new Error(`share stake needs 2 to 10 players, got ${playerCount}`);
  }
  return BigInt(playerCount - 1) * POKER_RESHUFFLE_AND_SHARE_LAMPORTS
    + PROTOCOL_SHARE_PENALTY_LAMPORTS;
}

function splitAcross(targets: bigint[], seats: readonly number[], total: bigint): void {
  if (seats.length === 0 || total === 0n) return;
  const width = BigInt(seats.length);
  const each = total / width;
  let remainder = total % width;
  const ordered = [...seats].sort((a, b) => a - b);
  for (const seat of ordered) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    targets[seat] = (targets[seat] ?? 0n) + each + extra;
  }
}

/**
 * Settle a hand whose unseal proved one or more bad shares.
 * `cheaters` is the order they were caught. An empty list is rejected so a
 * fair hand cannot be refunded here.
 */
export function settleBadUnseal(args: {
  contributions: readonly bigint[];
  stakes: readonly bigint[];
  cheaters: readonly number[];
  reshuffleAndShare?: bigint;
  protocolPenalty?: bigint;
}): ShareUnsealPenalty {
  const { contributions, stakes } = args;
  if (contributions.length !== stakes.length) {
    throw new Error('each seat needs a pot contribution and a share stake');
  }
  const playerCount = contributions.length;
  if (playerCount < 2 || playerCount > 10) {
    throw new Error(`share stake needs 2 to 10 players, got ${playerCount}`);
  }
  const reshuffle = args.reshuffleAndShare ?? POKER_RESHUFFLE_AND_SHARE_LAMPORTS;
  const protocolPenalty = args.protocolPenalty ?? PROTOCOL_SHARE_PENALTY_LAMPORTS;
  if (reshuffle < 0n || protocolPenalty < 0n) {
    throw new Error('share penalty amounts must be non-negative');
  }
  const required = BigInt(playerCount - 1) * reshuffle + protocolPenalty;

  const kicked: number[] = [];
  const seen = new Set<number>();
  for (const seat of args.cheaters) {
    if (seen.has(seat)) continue;
    if (seat < 0 || seat >= playerCount) {
      throw new Error(`cheater seat ${seat} is not in the hand`);
    }
    seen.add(seat);
    kicked.push(seat);
  }
  if (kicked.length === 0) {
    throw new Error('unseal slash requires a mismatched share');
  }

  const refunds = contributions.map(() => 0n);
  const slashedStake = contributions.map(() => 0n);
  const returnedStake = contributions.map(() => 0n);
  const paidToPlayers = contributions.map(() => 0n);
  const honest: number[] = [];
  let houseFromPot = 0n;

  for (let seat = 0; seat < playerCount; seat++) {
    const contribution = contributions[seat]!;
    const stake = stakes[seat]!;
    if (contribution < 0n || stake < 0n) {
      throw new Error(`seat ${seat} has a negative balance`);
    }
    if (stake !== required) {
      throw new Error(`seat ${seat} share stake must be ${required}`);
    }
    if (seen.has(seat)) {
      houseFromPot += contribution;
      slashedStake[seat] = stake;
    } else {
      refunds[seat] = contribution;
      returnedStake[seat] = stake;
      paidToPlayers[seat] = stake;
      honest.push(seat);
    }
  }

  let protocolLamports = 0n;
  const playerFromCheater = kicked.map(() => 0n);
  if (honest.length === 0) {
    for (const seat of kicked) protocolLamports += stakes[seat]!;
  } else {
    kicked.forEach((seat, index) => {
      const toPlayers = index === 0
        ? BigInt(honest.length) * reshuffle + protocolPenalty
        : protocolPenalty;
      playerFromCheater[index] = toPlayers;
      protocolLamports += stakes[seat]! - toPlayers;
      if (index === 0) {
        for (const other of honest) paidToPlayers[other] = (paidToPlayers[other] ?? 0n) + reshuffle;
      }
      splitAcross(paidToPlayers, honest, protocolPenalty);
    });
  }

  return {
    kicked,
    houseFromPot,
    houseFromStake: 0n,
    protocolLamports,
    paidToPlayers,
    playerFromCheater,
    refunds,
    slashedStake,
    returnedStake,
  };
}
