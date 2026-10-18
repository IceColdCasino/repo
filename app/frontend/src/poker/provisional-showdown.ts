import {
  computePlaintextShowdownPotResults,
  type HandResultSnapshot,
} from '@poker-src/backend/hand-result';
import type { GameSnapshot } from '../backend/client';

/** Build a provisional hand result during Showdown from decrypted card values. */
export function buildProvisionalShowdownResult(
  state: GameSnapshot,
  decryptedCards: ReadonlyMap<number, number>,
): HandResultSnapshot | null {
  if (state.phase !== 'Showdown' || !state.holeCards || !state.boardCards) {
    return null;
  }

  const holeCards = new Map<number, [number, number]>();
  for (const [seatKey, indices] of Object.entries(state.holeCards)) {
    const seat = Number(seatKey);
    const first = decryptedCards.get(indices[0]!);
    const second = decryptedCards.get(indices[1]!);
    if (first === undefined || second === undefined) {
      return null;
    }
    holeCards.set(seat, [first, second]);
  }

  const boardCards: number[] = [];
  for (const dealIndex of state.boardCards) {
    const value = decryptedCards.get(dealIndex);
    if (value === undefined) {
      return null;
    }
    boardCards.push(value);
  }

  const handSeatOrder = state.actionOrder ?? state.seats.map((seat) => seat.seat);
  let foldedMask = 0;
  for (const seatInfo of state.seats) {
    if (!seatInfo.folded || seatInfo.playerIndex === undefined) {
      continue;
    }
    foldedMask |= 1 << seatInfo.playerIndex;
  }

  const pots = state.pots.map((pot) => ({ amount: BigInt(pot.amount) }));
  const potResults = computePlaintextShowdownPotResults(
    handSeatOrder,
    foldedMask,
    holeCards,
    boardCards,
    pots,
  );

  const seatHands = handSeatOrder
    .map((seat) => {
      const hole = state.holeCards?.[seat];
      const seatInfo = state.seats.find((entry) => entry.seat === seat);
      if (!hole || !seatInfo) {
        return null;
      }
      const playerIndex = seatInfo.playerIndex ?? handSeatOrder.indexOf(seat);
      return {
        seat,
        playerIndex,
        name: seatInfo.name,
        folded: Boolean(seatInfo.folded),
        holeCards: hole as [number, number],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    handNumber: state.handNumber ?? 0,
    reason: 'showdown',
    potResults,
    boardCards: state.boardCards,
    seatHands,
    actionOrder: handSeatOrder,
    zkFinalDeck: state.zkCrypto?.finalDeck,
    handNumPlayers: state.zkCrypto?.handNumPlayers,
  };
}

export function winnerSeatsFromSnapshot(
  state: GameSnapshot,
  decryptedCards?: ReadonlyMap<number, number>,
): Set<number> {
  const seats = new Set<number>();
  if (decryptedCards) {
    const provisional = buildProvisionalShowdownResult(state, decryptedCards);
    if (provisional) {
      for (const pot of provisional.potResults) {
        for (const seat of pot.winnerSeats) {
          seats.add(seat);
        }
      }
      if (seats.size > 0) {
        return seats;
      }
    }
  }
  const pending = state.pendingHandResult;
  if (pending) {
    for (const pot of pending.potResults) {
      for (const seat of pot.winnerSeats) {
        seats.add(seat);
      }
    }
    if (seats.size > 0) {
      return seats;
    }
  }
  return seats;
}
