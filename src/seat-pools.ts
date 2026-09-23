/**
 * Proportional stake and payout splitting for multi-seat player/dealer pools.
 * Used by blackjack, war, and baccarat when multiple seats share a side.
 */

export interface SeatStake {
  seatIndex: number;
  stake: bigint;
}

export interface SeatPoolConfig {
  /** Seat indices acting as the player side (betting against the dealer). */
  playerSeats: number[];
  /** Seat indices backing the dealer side (house bankroll). */
  dealerSeats: number[];
}

export type HeadToHeadOutcome = 0 | 1 | 2; // 0=player wins, 1=dealer wins, 2=tie

/** Scale full-table dealer bankroll requirement by active player count. */
export function scaledDealerBankroll(
  fullTableBankroll: bigint,
  activePlayerCount: number,
  maxPlayers: number,
): bigint {
  if (maxPlayers <= 0) throw new Error('maxPlayers must be positive');
  if (activePlayerCount < 0 || activePlayerCount > maxPlayers) {
    throw new Error(`activePlayerCount ${activePlayerCount} out of range 0..${maxPlayers}`);
  }
  if (activePlayerCount === 0) return 0n;
  return (fullTableBankroll * BigInt(activePlayerCount)) / BigInt(maxPlayers);
}

/** Split `total` across stakes proportionally; last seat absorbs rounding remainder. */
export function splitProportionally(total: bigint, stakes: SeatStake[]): Map<number, bigint> {
  if (stakes.length === 0) throw new Error('stakes must not be empty');
  const sum = stakes.reduce((acc, s) => acc + s.stake, 0n);
  if (sum <= 0n) throw new Error('total stake must be positive');

  const result = new Map<number, bigint>();
  let allocated = 0n;
  for (let i = 0; i < stakes.length; i++) {
    const { seatIndex, stake } = stakes[i]!;
    if (i === stakes.length - 1) {
      result.set(seatIndex, total - allocated);
    } else {
      const share = (total * stake) / sum;
      result.set(seatIndex, share);
      allocated += share;
    }
  }
  return result;
}

/** Per-seat required dealer contribution before scaling (equal split within dealer pool). */
export function dealerPoolContributions(
  fullTableBankroll: bigint,
  activePlayerCount: number,
  maxPlayers: number,
  dealerStakes: SeatStake[],
): Map<number, bigint> {
  const scaled = scaledDealerBankroll(fullTableBankroll, activePlayerCount, maxPlayers);
  return splitProportionally(scaled, dealerStakes);
}

/**
 * Settle a head-to-head hand (war/baccarat): 0=player wins, 1=dealer wins, 2=tie.
 * Each player seat posts `stake`; 1:1 payout on win. Dealer pool receives losses /
 * pays wins proportionally.
 */
export function settleHeadToHead(
  outcome: HeadToHeadOutcome,
  playerStakes: SeatStake[],
  dealerStakes: SeatStake[],
): Map<number, bigint> {
  if (playerStakes.length === 0) throw new Error('playerStakes must not be empty');
  if (dealerStakes.length === 0) throw new Error('dealerStakes must not be empty');

  const playerTotal = playerStakes.reduce((acc, s) => acc + s.stake, 0n);
  const nets = new Map<number, bigint>();
  for (const s of [...playerStakes, ...dealerStakes]) {
    nets.set(s.seatIndex, 0n);
  }

  if (outcome === 2) {
    return nets;
  }

  if (outcome === 0) {
    // Player side wins: each player gets +stake; dealer pool pays proportionally.
    for (const { seatIndex, stake } of playerStakes) {
      nets.set(seatIndex, (nets.get(seatIndex) ?? 0n) + stake);
    }
    const dealerPayout = splitProportionally(playerTotal, dealerStakes);
    for (const [seat, share] of dealerPayout) {
      nets.set(seat, (nets.get(seat) ?? 0n) - share);
    }
    return nets;
  }

  // Dealer wins: player seats lose stake; dealer pool gains proportionally.
  for (const { seatIndex, stake } of playerStakes) {
    nets.set(seatIndex, (nets.get(seatIndex) ?? 0n) - stake);
  }
  const dealerGain = splitProportionally(playerTotal, dealerStakes);
  for (const [seat, share] of dealerGain) {
    nets.set(seat, (nets.get(seat) ?? 0n) + share);
  }
  return nets;
}

/** Net chip delta for one blackjack hand vs dealer. */
export function blackjackHandNet(outcome: 0 | 1 | 2 | 3, stake: bigint): bigint {
  switch (outcome) {
    case 0:
      return -stake;
    case 1:
      return 0n;
    case 2:
      return stake;
    case 3:
      return (stake * 3n) / 2n;
    default:
      throw new Error(`Invalid blackjack outcome: ${outcome}`);
  }
}

/**
 * Settle a blackjack table: each active player seat may have multiple hands.
 * Dealer-side seats split aggregate dealer net proportionally by stake weight.
 * `fullTableBankroll` is the max dealer exposure at a full table; it scales down
 * when fewer than maxPlayers are active.
 */
export function settleBlackjackTable(
  outcomes: (0 | 1 | 2 | 3)[][],
  handStakes: Map<string, bigint>,
  dealerStakes: SeatStake[],
  activePlayerCount: number,
  maxPlayers: number,
  fullTableBankroll: bigint,
): Map<number, bigint> {
  if (dealerStakes.length === 0) throw new Error('dealerStakes must not be empty');

  let dealerNet = 0n;
  const nets = new Map<number, bigint>();
  for (const d of dealerStakes) nets.set(d.seatIndex, 0n);

  for (let p = 0; p < outcomes.length; p++) {
    const row = outcomes[p];
    if (!row) continue;
    for (let h = 0; h < row.length; h++) {
      const outcome = row[h]!;
      const stake = handStakes.get(`${p}:${h}`) ?? 0n;
      if (stake === 0n) continue;
      const playerNet = blackjackHandNet(outcome, stake);
      nets.set(p, (nets.get(p) ?? 0n) + playerNet);
      dealerNet -= playerNet;
    }
  }

  const maxDealerLoss = scaledDealerBankroll(
    fullTableBankroll,
    activePlayerCount,
    maxPlayers,
  );
  if (dealerNet < 0n && -dealerNet > maxDealerLoss) {
    throw new Error(
      `Dealer net loss ${-dealerNet} exceeds scaled bankroll ${maxDealerLoss}`,
    );
  }

  const dealerShares = splitProportionally(dealerNet, dealerStakes);
  for (const [seat, share] of dealerShares) {
    nets.set(seat, (nets.get(seat) ?? 0n) + share);
  }
  return nets;
}

/** Default head-to-head layout: seat 0 = player, seat 1 = dealer. */
export function defaultHeadToHeadPools(activeSeats: number): SeatPoolConfig {
  if (activeSeats < 2) {
    throw new Error('Need at least 2 active seats for head-to-head');
  }
  return { playerSeats: [0], dealerSeats: [1] };
}

/** Default blackjack: last active seat is dealer; others are players. */
export function defaultBlackjackPools(activeSeats: number, dealerSeat?: number): SeatPoolConfig {
  if (activeSeats < 2) throw new Error('Need at least 2 seats (1 player + dealer)');
  const resolvedDealer = dealerSeat ?? activeSeats - 1;
  const playerSeats: number[] = [];
  for (let i = 0; i < activeSeats; i++) {
    if (i !== resolvedDealer) playerSeats.push(i);
  }
  return { playerSeats, dealerSeats: [resolvedDealer] };
}
