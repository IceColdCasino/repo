import type { CardView, TableView } from './view-model';

export const FACE_DOWN_UNICODE = '1F0A0';

/** True when a rendered card shows a real face (not the blue back). */
export function isFaceUpCard(card: CardView | undefined | null): boolean {
  return Boolean(card?.flipped && card.unicode && card.unicode !== FACE_DOWN_UNICODE);
}

/**
 * Complete/Showdown ZK hands need decrypt values for board + non-folded holes.
 * Returns false when backs are still showing despite a decrypt attempt.
 */
export function tableShowsDecryptedFaces(
  view: TableView,
  opts?: { requireBoard?: boolean; holeSeats?: number[] },
): boolean {
  const requireBoard = opts?.requireBoard !== false;
  if (requireBoard) {
    if (view.sharedCards.length < 5) {
      return false;
    }
    if (!view.sharedCards.every((card) => isFaceUpCard(card))) {
      return false;
    }
  }
  const seats = opts?.holeSeats ?? Object.keys(view.playerCards).map(Number);
  for (const seat of seats) {
    const holes = view.playerCards[seat];
    if (!holes) {
      return false;
    }
    if (!holes.every((card) => isFaceUpCard(card))) {
      return false;
    }
  }
  return true;
}
