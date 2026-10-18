import {
  computePlaintextShowdownPotResults,
  describeSevenCardHand,
  potResultsFromHandResult,
} from '@poker-src/backend/hand-result';
import type { HandResultSnapshot } from '../backend/client';
import { cardHtmlLabel } from './card';

export interface HandResultWinnerView {
  seat: number;
  name: string;
  handDescription?: string;
  cardsLabel?: string;
  wonAmount: number;
}

export interface HandResultPotView {
  potIndex: number;
  amount: number;
  winners: HandResultWinnerView[];
  /** e.g. "Seat 0 & Seat 1 split" when multiple winners. */
  splitLabel: string;
}

export interface HandResultSeatView {
  seat: number;
  name: string;
  folded: boolean;
  handDescription?: string;
  cardsLabel?: string;
  wonAmount: number;
}

export interface HandResultView {
  handNumber: number;
  reason: 'fold' | 'showdown';
  pots: HandResultPotView[];
  seats: HandResultSeatView[];
}

function splitPotAmount(amount: number, winnerCount: number): number[] {
  if (winnerCount <= 0) {
    return [];
  }
  const share = Math.floor(amount / winnerCount);
  let remainder = amount - share * winnerCount;
  const shares: number[] = [];
  for (let index = 0; index < winnerCount; index += 1) {
    let payout = share;
    if (remainder > 0) {
      payout += 1;
      remainder -= 1;
    }
    shares.push(payout);
  }
  return shares;
}

export function payoutSharesForPot(amount: number, winnerCount: number): number[] {
  return splitPotAmount(amount, winnerCount);
}

/** Human label for pot winners (ties → "Seat 0 & Seat 1 split"). */
export function formatPotWinnersLabel(
  winners: Array<{ seat: number; name?: string }>,
): string {
  if (winners.length === 0) {
    return 'no winners';
  }
  const names = winners.map((w) => w.name ?? `Seat ${w.seat}`);
  if (names.length === 1) {
    return names[0]!;
  }
  if (names.length === 2) {
    return `${names[0]} & ${names[1]} split`;
  }
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} split`;
}

function cardLabel(value: number): string {
  try {
    return cardHtmlLabel(value);
  } catch {
    return `#${value}`;
  }
}

function cardsLabel(holeValues: [number, number], boardValues: number[]): string {
  const board = boardValues.slice(0, 5).map(cardLabel).join(' ');
  return `${cardLabel(holeValues[0])} ${cardLabel(holeValues[1])} · board ${board}`;
}

function isPlaintextHand(result: HandResultSnapshot): boolean {
  return result.zkFinalDeck === undefined && result.handNumPlayers === undefined;
}

function resolveHoleValues(
  seatHand: HandResultSnapshot['seatHands'][number],
  decryptedCards?: ReadonlyMap<number, number>,
  plaintextHand?: boolean,
): [number, number] | null {
  if (plaintextHand) {
    return seatHand.holeCards;
  }
  if (!decryptedCards) {
    return null;
  }
  const first = decryptedCards.get(seatHand.holeCards[0]);
  const second = decryptedCards.get(seatHand.holeCards[1]);
  if (first === undefined || second === undefined) {
    return null;
  }
  return [first, second];
}

function resolveBoardValues(
  boardDealIndices: number[],
  decryptedCards?: ReadonlyMap<number, number>,
  plaintextHand?: boolean,
): number[] {
  if (plaintextHand) {
    return boardDealIndices;
  }
  if (!decryptedCards) {
    return [];
  }
  return boardDealIndices
    .map((dealIndex) => decryptedCards.get(dealIndex))
    .filter((value): value is number => value !== undefined);
}

function handDescriptionForSeat(
  seatHand: HandResultSnapshot['seatHands'][number],
  boardDealIndices: number[],
  decryptedCards?: ReadonlyMap<number, number>,
  plaintextHand?: boolean,
): string | undefined {
  if (seatHand.handDescription) {
    return seatHand.handDescription;
  }
  if (seatHand.folded) {
    return undefined;
  }
  const holeValues = resolveHoleValues(seatHand, decryptedCards, plaintextHand);
  const boardValues = resolveBoardValues(boardDealIndices, decryptedCards, plaintextHand);
  if (!holeValues || boardValues.length < 5) {
    return undefined;
  }
  return describeSevenCardHand([...holeValues, ...boardValues.slice(0, 5)]);
}

function winnerSeatKey(pots: Array<{ winnerSeats: number[] }>): string {
  return pots
    .map((pot) => [...pot.winnerSeats].sort((a, b) => a - b).join('+'))
    .join('|');
}

/**
 * Resolve pot winners for UI display.
 *
 * Pending result data remains authoritative until an authenticated settlement
 * is available. Decrypted faces may improve only the local display.
 */
export function resolveHandResultWinners(
  result: HandResultSnapshot,
  decryptedCards?: ReadonlyMap<number, number>,
): HandResultSnapshot {
  const fromMasks = potResultsFromHandResult(result);
  const plaintextHand = isPlaintextHand(result);
  if (!decryptedCards || decryptedCards.size === 0 || plaintextHand) {
    return fromMasks === result.potResults
      ? result
      : { ...result, potResults: fromMasks };
  }

  const handSeatOrder = result.actionOrder.length > 0
    ? result.actionOrder
    : result.seatHands.map((s) => s.seat);

  const holeCards = new Map<number, [number, number]>();
  let foldedMask = 0;
  for (const seatHand of result.seatHands) {
    const first = decryptedCards.get(seatHand.holeCards[0]);
    const second = decryptedCards.get(seatHand.holeCards[1]);
    if (first === undefined || second === undefined) {
      return { ...result, potResults: fromMasks };
    }
    holeCards.set(seatHand.seat, [first, second]);
    if (seatHand.folded) {
      const playerIndex = seatHand.playerIndex ?? handSeatOrder.indexOf(seatHand.seat);
      if (playerIndex >= 0) {
        foldedMask |= 1 << playerIndex;
      }
    }
  }

  const boardValues: number[] = [];
  for (const dealIndex of result.boardCards.slice(0, 5)) {
    const value = decryptedCards.get(dealIndex);
    if (value === undefined) {
      return { ...result, potResults: fromMasks };
    }
    boardValues.push(value);
  }

  const amountSource = (fromMasks.length > 0 ? fromMasks : result.potResults)
    .map((pot) => ({ amount: BigInt(pot.amount) }));
  if (amountSource.length === 0) {
    return { ...result, potResults: fromMasks };
  }

  const fromCards = computePlaintextShowdownPotResults(
    handSeatOrder,
    foldedMask,
    holeCards,
    boardValues,
    amountSource,
  );
  if (fromCards.length === 0) {
    return { ...result, potResults: fromMasks };
  }

  if (fromMasks.length > 0 && winnerSeatKey(fromMasks) === winnerSeatKey(fromCards)) {
    return { ...result, potResults: fromMasks };
  }

  return {
    ...result,
    potResults: fromCards,
  };
}

export function buildHandResultView(
  result: HandResultSnapshot,
  decryptedCards?: ReadonlyMap<number, number>,
): HandResultView {
  const plaintextHand = isPlaintextHand(result);
  const resolved = resolveHandResultWinners(result, decryptedCards);
  const potResults = resolved.potResults;

  const wonBySeat = new Map<number, number>();
  for (const pot of potResults) {
    const shares = splitPotAmount(Number(pot.amount), pot.winnerSeats.length);
    for (let i = 0; i < pot.winnerSeats.length; i += 1) {
      const seat = pot.winnerSeats[i]!;
      wonBySeat.set(seat, (wonBySeat.get(seat) ?? 0) + (shares[i] ?? 0));
    }
  }

  const seatLookup = new Map(result.seatHands.map((seat) => [seat.seat, seat]));

  const pots: HandResultPotView[] = potResults.map((pot) => {
    const winners = pot.winnerSeats.map((seat, winnerIndex) => {
      const seatHand = seatLookup.get(seat);
      const holeValues = seatHand
        ? resolveHoleValues(seatHand, decryptedCards, plaintextHand)
        : null;
      const boardValues = resolveBoardValues(result.boardCards, decryptedCards, plaintextHand);
      const shares = splitPotAmount(Number(pot.amount), pot.winnerSeats.length);
      return {
        seat,
        name: seatHand?.name ?? `Seat ${seat}`,
        handDescription: seatHand
          ? handDescriptionForSeat(seatHand, result.boardCards, decryptedCards, plaintextHand)
          : result.reason === 'fold' ? 'Won uncontested' : undefined,
        cardsLabel: holeValues && boardValues.length >= 5
          ? cardsLabel(holeValues, boardValues)
          : undefined,
        wonAmount: shares[winnerIndex] ?? 0,
      };
    });
    return {
      potIndex: pot.potIndex,
      amount: Number(pot.amount),
      winners,
      splitLabel: formatPotWinnersLabel(winners),
    };
  });

  const seats: HandResultSeatView[] = result.seatHands.map((seatHand) => {
    const holeValues = resolveHoleValues(seatHand, decryptedCards, plaintextHand);
    const boardValues = resolveBoardValues(result.boardCards, decryptedCards, plaintextHand);
    return {
      seat: seatHand.seat,
      name: seatHand.name,
      folded: seatHand.folded,
      handDescription: handDescriptionForSeat(
        seatHand,
        result.boardCards,
        decryptedCards,
        plaintextHand,
      ),
      cardsLabel: holeValues && boardValues.length >= 5
        ? cardsLabel(holeValues, boardValues)
        : undefined,
      wonAmount: wonBySeat.get(seatHand.seat) ?? 0,
    };
  });

  return {
    handNumber: result.handNumber,
    reason: result.reason,
    pots,
    seats,
  };
}
