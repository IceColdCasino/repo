import { HandEvaluator, handTypes, type EvaluatedHand } from '../hand-eval';
import { boardStartIndex, dealCardCount } from './card-layout';

const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURALS = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens',
  'Jacks', 'Queens', 'Kings', 'Aces'];

export interface PotResultSnapshot {
  potIndex: number;
  amount: string;
  winnerSeats: number[];
}

export interface SeatHandSnapshot {
  seat: number;
  playerIndex: number;
  name: string;
  folded: boolean;
  /** Deal-layout indices for ZK hands; card values 0–51 for plaintext hands. */
  holeCards: [number, number];
  handDescription?: string;
}

export interface HandResultSnapshot {
  handNumber: number;
  reason: 'fold' | 'showdown';
  potResults: PotResultSnapshot[];
  boardCards: number[];
  seatHands: SeatHandSnapshot[];
  actionOrder: number[];
  /** Lets clients decrypt hole/board values after the hand ends. */
  zkFinalDeck?: string[][];
  handNumPlayers?: number;
}

function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

function rankPlural(rank: number): string {
  return RANK_PLURALS[rank] ?? `${rankLabel(rank)}s`;
}

export function describeEvaluatedHand(hand: EvaluatedHand): string {
  const typeIndex = Number(hand[0] ?? 1);
  const typeName = handTypes[typeIndex - 1] ?? handTypes[0]!;
  switch (typeName) {
    case 'straightFlush':
      return 'Straight flush';
    case 'fourOfAKind':
      return `Four of a kind, ${rankPlural(Number(hand[1] ?? 0))}`;
    case 'fullHouse':
      return `Full house, ${rankPlural(Number(hand[1] ?? 0))} full of ${rankPlural(Number(hand[2] ?? 0))}`;
    case 'flush':
      return 'Flush';
    case 'straight':
      return 'Straight';
    case 'threeOfAKind':
      return `Three of a kind, ${rankPlural(Number(hand[1] ?? 0))}`;
    case 'twoPair':
      return `Two pair, ${rankPlural(Number(hand[1] ?? 0))} and ${rankPlural(Number(hand[2] ?? 0))}`;
    case 'onePair':
      return `Pair of ${rankPlural(Number(hand[1] ?? 0))}`;
    default:
      return `${rankLabel(Number(hand[1] ?? 0))} high`;
  }
}

export function describeSevenCardHand(cards: number[]): string {
  if (cards.length !== 7) {
    return 'Unknown hand';
  }
  return describeEvaluatedHand(new HandEvaluator().evaluateHand(cards.map((card) => BigInt(card))));
}

export function potResultsFromHandResult(result: HandResultSnapshot): PotResultSnapshot[] {
  return result.potResults;
}

function compareEvaluatedHands(handA: EvaluatedHand, handB: EvaluatedHand): number {
  for (let index = 0; index < 6; index += 1) {
    const left = Number(handA[index] ?? 0);
    const right = Number(handB[index] ?? 0);
    if (left > right) {
      return -1;
    }
    if (left < right) {
      return 1;
    }
  }
  return 0;
}

export function computePlaintextShowdownPotResults(
  handSeatOrder: number[],
  foldedMask: number,
  holeCards: Map<number, [number, number]>,
  boardCards: number[],
  pots: { amount: bigint }[],
): PotResultSnapshot[] {
  const evaluator = new HandEvaluator();
  const board = boardCards.slice(0, 5);
  const contenders: Array<{ seat: number; evaluated: EvaluatedHand }> = [];
  for (const [seatIndex, seat] of handSeatOrder.entries()) {
    if (foldedMask & (1 << seatIndex)) {
      continue;
    }
    const hole = holeCards.get(seat);
    if (!hole) {
      continue;
    }
    contenders.push({
      seat,
      evaluated: evaluator.evaluateHand([...hole, ...board].map((card) => BigInt(card))),
    });
  }
  if (contenders.length === 0) {
    return [];
  }
  let best = contenders[0]!;
  for (const contender of contenders.slice(1)) {
    if (compareEvaluatedHands(contender.evaluated, best.evaluated) < 0) {
      best = contender;
    }
  }
  const winners = contenders
    .filter((contender) => compareEvaluatedHands(contender.evaluated, best.evaluated) === 0)
    .map((contender) => contender.seat);

  const results: PotResultSnapshot[] = [];
  for (let potIndex = 0; potIndex < pots.length; potIndex += 1) {
    const amount = pots[potIndex]?.amount ?? 0n;
    if (amount <= 0n) {
      continue;
    }
    results.push({
      potIndex,
      amount: amount.toString(),
      winnerSeats: winners,
    });
  }
  return results;
}

export function winnerSeatsFromPotResults(potResults: PotResultSnapshot[]): number[] {
  const seats = new Set<number>();
  for (const pot of potResults) {
    for (const seat of pot.winnerSeats) {
      seats.add(seat);
    }
  }
  return [...seats];
}

export function resolveCardValuesForEvaluation(
  holeCards: Map<number, [number, number]>,
  boardDealIndices: number[],
  options: {
    usedPlaintextHand?: boolean;
    e2eDealValues?: Record<number, number>;
  } = {},
): { holeCards: Map<number, [number, number]>; boardCards: number[] } | null {
  if (options.usedPlaintextHand) {
    return { holeCards: new Map(holeCards), boardCards: [...boardDealIndices] };
  }
  if (!options.e2eDealValues) {
    return null;
  }
  const resolvedHoles = new Map<number, [number, number]>();
  for (const [seat, [first, second]] of holeCards) {
    const a = options.e2eDealValues[first];
    const b = options.e2eDealValues[second];
    if (a === undefined || b === undefined) {
      return null;
    }
    resolvedHoles.set(seat, [a, b]);
  }
  const boardCards: number[] = [];
  for (const dealIndex of boardDealIndices) {
    const value = options.e2eDealValues[dealIndex];
    if (value === undefined) {
      return null;
    }
    boardCards.push(value);
  }
  return { holeCards: resolvedHoles, boardCards };
}

export interface BuildHandResultInput {
  handNumber: number;
  reason: 'fold' | 'showdown';
  handNumPlayers: number;
  handSeatOrder: number[];
  foldedMask: number;
  holeCards: Map<number, [number, number]>;
  boardCards: number[];
  pots: { amount: bigint }[];
  seatNames: Map<number, string>;
  usedPlaintextHand: boolean;
  zkFinalDeck?: string[][];
}

/**
 * The player still in the hand when everyone else has folded.
 * An all-in runout leaves every player unfolded, so it is not a fold win.
 */
export function uncontestedWinnerIndex(foldedMask: number, numPlayers: number): number | null {
  if (numPlayers < 2 || foldedMask === 0) return null;
  let winner: number | null = null;
  for (let player = 0; player < numPlayers; player += 1) {
    if ((foldedMask & (1 << player)) !== 0) continue;
    if (winner !== null) return null;
    winner = player;
  }
  return winner;
}

export function buildHandResult(input: BuildHandResultInput): HandResultSnapshot {
  const {
    handNumber,
    reason,
    handNumPlayers,
    handSeatOrder,
    foldedMask,
    holeCards,
    boardCards,
    pots,
    seatNames,
    usedPlaintextHand,
    zkFinalDeck,
  } = input;

  let potResults: PotResultSnapshot[] = [];
  if (reason === 'showdown' && usedPlaintextHand) {
    potResults = computePlaintextShowdownPotResults(
      handSeatOrder,
      foldedMask,
      holeCards,
      boardCards,
      pots,
    );
  } else if (reason === 'fold') {
    const activeSeats = handSeatOrder.filter((_seat, playerIndex) =>
      (foldedMask & (1 << playerIndex)) === 0,
    );
    const total = pots.reduce((sum, pot) => sum + pot.amount, 0n);
    if (activeSeats.length === 1 && total > 0n) {
      potResults = [{
        potIndex: 0,
        amount: total.toString(),
        winnerSeats: [activeSeats[0]!],
      }];
    }
  }

  const board = reason === 'fold'
    ? [...boardCards]
    : usedPlaintextHand
      ? [...boardCards]
      : boardCards.length > 0
        ? [...boardCards]
        : Array.from({ length: 5 }, (_, index) => boardStartIndex() + index);

  const seatHands: SeatHandSnapshot[] = [];
  for (const seat of handSeatOrder) {
    const hole = holeCards.get(seat);
    if (!hole) {
      continue;
    }
    const playerIndex = handSeatOrder.indexOf(seat);
    const folded = Boolean(foldedMask & (1 << playerIndex));
    const entry: SeatHandSnapshot = {
      seat,
      playerIndex,
      name: seatNames.get(seat) ?? `Seat ${seat}`,
      folded,
      holeCards: hole,
    };
    if (usedPlaintextHand && !folded) {
      entry.handDescription = describeSevenCardHand([...hole, ...board.slice(0, 5)]);
    }
    seatHands.push(entry);
  }

  return {
    handNumber,
    reason,
    potResults,
    boardCards: board,
    seatHands,
    actionOrder: [...handSeatOrder],
    zkFinalDeck: usedPlaintextHand ? undefined : zkFinalDeck,
    handNumPlayers: usedPlaintextHand ? undefined : handNumPlayers,
  };
}

export function dealIndicesForHand(handNumPlayers: number): number[] {
  return Array.from({ length: dealCardCount(handNumPlayers) }, (_, index) => index);
}

export function payoutShares(amount: bigint, winnerCount: number): bigint[] {
  if (winnerCount <= 0) {
    return [];
  }
  const share = amount / BigInt(winnerCount);
  let remainder = amount - share * BigInt(winnerCount);
  const shares: bigint[] = [];
  for (let index = 0; index < winnerCount; index += 1) {
    let payout = share;
    if (remainder > 0n) {
      payout += 1n;
      remainder -= 1n;
    }
    shares.push(payout);
  }
  return shares;
}

export function winningsBySeatFromPotResults(potResults: PotResultSnapshot[]): Map<number, bigint> {
  const winnings = new Map<number, bigint>();
  for (const pot of potResults) {
    const amount = BigInt(pot.amount);
    if (amount <= 0n || pot.winnerSeats.length === 0) {
      continue;
    }
    const shares = payoutShares(amount, pot.winnerSeats.length);
    for (let index = 0; index < pot.winnerSeats.length; index += 1) {
      const seat = pot.winnerSeats[index]!;
      const payout = shares[index] ?? 0n;
      winnings.set(seat, (winnings.get(seat) ?? 0n) + payout);
    }
  }
  return winnings;
}

/** Prefer the winner who earns the most; tie-break by earliest seat in hand action order (SB first). */
export function preferredShowdownSubmitterSeat(
  potResults: PotResultSnapshot[],
  actionOrder: number[],
  excludedSeats: ReadonlySet<number> = new Set(),
): number | null {
  const winnings = winningsBySeatFromPotResults(potResults);
  let candidates = [...winnings.entries()].filter(
    ([seat, amount]) => amount > 0n && !excludedSeats.has(seat),
  );
  if (candidates.length === 0) {
    const ranked = new Map<number, bigint>();
    for (const pot of potResults) {
      for (const seat of pot.winnerSeats) {
        if (!excludedSeats.has(seat)) {
          ranked.set(seat, 1n);
        }
      }
    }
    candidates = [...ranked.entries()];
  }
  if (candidates.length === 0) {
    return null;
  }
  const orderIndex = new Map(actionOrder.map((seat, index) => [seat, index]));
  candidates.sort((left, right) => {
    if (left[1] !== right[1]) {
      return left[1] > right[1] ? -1 : 1;
    }
    const leftOrder = orderIndex.get(left[0]) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderIndex.get(right[0]) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
  return candidates[0]![0];
}

/** Map showdown winner-mask bits (playerIndex) onto seated pot payouts. */
export function potResultsFromWinnerMasks(
  masks: ReadonlyArray<bigint | string>,
  handNumPlayers: number,
  handSeatOrder: number[],
  pots: { amount: bigint }[],
): PotResultSnapshot[] {
  return pots.flatMap((pot, potIndex) => {
    if (pot.amount <= 0n) {
      return [];
    }
    const mask = BigInt(masks[potIndex] ?? 0n);
    const winnerSeats = handSeatOrder.filter((_seat, playerIndex) =>
      playerIndex < handNumPlayers && Boolean(mask & (1n << BigInt(playerIndex))),
    );
    return winnerSeats.length > 0
      ? [{ potIndex, amount: pot.amount.toString(), winnerSeats }]
      : [];
  });
}

export function distributePotResults(
  potResults: PotResultSnapshot[],
  seats: Map<number, { chips: bigint }>,
): void {
  for (const pot of potResults) {
    const amount = BigInt(pot.amount);
    if (amount <= 0n || pot.winnerSeats.length === 0) {
      continue;
    }
    const shares = payoutShares(amount, pot.winnerSeats.length);
    for (let index = 0; index < pot.winnerSeats.length; index += 1) {
      const seat = pot.winnerSeats[index]!;
      const payout = shares[index] ?? 0n;
      const player = seats.get(seat);
      if (player && payout > 0n) {
        player.chips += payout;
      }
    }
  }
}
