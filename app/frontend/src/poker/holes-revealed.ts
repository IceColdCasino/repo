import { isFaceUpCard } from './decrypt-to-faces';
import type { CardView } from './view-model';

export const HOLES_REVEALED_KEY = 'holes-revealed';

export type HolesRevealedRecord = {
  gameId: string;
  handNumber: number;
  seats: number[];
  /** Seat that sends open_preflop once every hole card is face up. */
  opener: number | null;
};

export function emptyHolesRevealed(gameId: string, handNumber: number): HolesRevealedRecord {
  return { gameId, handNumber, seats: [], opener: null };
}

export function parseHolesRevealed(
  raw: string | null | undefined,
  gameId: string,
  handNumber: number,
): HolesRevealedRecord {
  if (!raw) return emptyHolesRevealed(gameId, handNumber);
  try {
    const parsed = JSON.parse(raw) as Partial<HolesRevealedRecord>;
    if (parsed.gameId !== gameId || parsed.handNumber !== handNumber) {
      return emptyHolesRevealed(gameId, handNumber);
    }
    const seats = Array.isArray(parsed.seats)
      ? parsed.seats.filter((seat) => Number.isInteger(seat) && seat >= 0)
      : [];
    const opener = Number.isInteger(parsed.opener) ? Number(parsed.opener) : null;
    return {
      gameId,
      handNumber,
      seats: [...new Set(seats)].sort((a, b) => a - b),
      opener,
    };
  } catch {
    return emptyHolesRevealed(gameId, handNumber);
  }
}

export function localHolesFaceUp(cards: CardView[] | undefined): boolean {
  return Boolean(cards && cards.length >= 2 && cards.every((card) => isFaceUpCard(card)));
}

export function noteHolesRevealed(record: HolesRevealedRecord, seat: number): HolesRevealedRecord {
  if (record.seats.includes(seat)) return record;
  return {
    ...record,
    seats: [...record.seats, seat].sort((a, b) => a - b),
  };
}

export function allHoleCardsRevealed(record: HolesRevealedRecord, seatsInHand: number[]): boolean {
  if (seatsInHand.length < 2) return false;
  return seatsInHand.every((seat) => record.seats.includes(seat));
}

/** First writer keeps the opener so only one window calls open_preflop. */
export function mergeHolesRevealed(
  disk: HolesRevealedRecord,
  incoming: HolesRevealedRecord,
): HolesRevealedRecord {
  if (disk.gameId !== incoming.gameId || disk.handNumber !== incoming.handNumber) {
    return incoming;
  }
  return {
    gameId: incoming.gameId,
    handNumber: incoming.handNumber,
    seats: [...new Set([...disk.seats, ...incoming.seats])].sort((a, b) => a - b),
    opener: disk.opener ?? incoming.opener,
  };
}

export function claimPreflopOpen(record: HolesRevealedRecord, seat: number): HolesRevealedRecord {
  if (record.opener !== null) return record;
  return { ...record, opener: seat };
}
