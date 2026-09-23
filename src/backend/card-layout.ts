/** 25-card mental-poker deal layout (max 10 players): SB=index 0, BB=index 1, … */

import { MAX_PLAYERS } from '../poker';

/** Share circuit always uses the 10-player slot layout (board at 20–24). */
export function boardStartIndex(_handNumPlayers?: number): number {
  return MAX_PLAYERS * 2;
}

export function dealCardCount(_handNumPlayers?: number): number {
  return MAX_PLAYERS * 2 + 5;
}

export function holeCardIndices(playerIndex: number): [number, number] {
  const base = playerIndex * 2;
  return [base, base + 1];
}

export function isHoleCard(cardIndex: number, handNumPlayers: number): boolean {
  return holePlayerIndexForCard(cardIndex, handNumPlayers) !== null;
}

export function isBoardCard(cardIndex: number, _handNumPlayers?: number): boolean {
  return cardIndex >= boardStartIndex() && cardIndex < dealCardCount();
}

export function isOwnHoleCard(cardIndex: number, playerIndex: number): boolean {
  const [first, second] = holeCardIndices(playerIndex);
  return cardIndex === first || cardIndex === second;
}

export function holePlayerIndexForCard(
  cardIndex: number,
  handNumPlayers: number,
): number | null {
  if (cardIndex >= boardStartIndex()) {
    return null;
  }
  const playerIndex = Math.floor(cardIndex / 2);
  if (playerIndex >= handNumPlayers) {
    return null;
  }
  const [first, second] = holeCardIndices(playerIndex);
  return cardIndex === first || cardIndex === second ? playerIndex : null;
}

export function flopIndices(_handNumPlayers?: number): [number, number, number] {
  const start = boardStartIndex();
  return [start, start + 1, start + 2];
}

export function turnIndex(_handNumPlayers?: number): number {
  return boardStartIndex() + 3;
}

export function riverIndex(_handNumPlayers?: number): number {
  return boardStartIndex() + 4;
}

export function allDealCardIndices(_handNumPlayers?: number): number[] {
  return Array.from({ length: dealCardCount() }, (_, index) => index);
}

/** Hole indices for seats 0..n-1 plus board 20–24 (fixed 10-seat layout). */
export function usedCardIndices(handNumPlayers: number): number[] {
  if (handNumPlayers < 2 || handNumPlayers > MAX_PLAYERS) {
    throw new Error(`handNumPlayers must be 2..${MAX_PLAYERS}, got ${handNumPlayers}`);
  }
  const holes = Array.from({ length: handNumPlayers * 2 }, (_, i) => i);
  const board = [20, 21, 22, 23, 24];
  return [...holes, ...board];
}

/**
 * Deal indices that may be publicized at showdown:
 * non-folded (or show-on-fold) holes + board. Mucked folded holes excluded.
 */
export function publicDealCardIndices(
  handNumPlayers: number,
  foldedMask = 0,
  showOnFoldMask = 0,
): number[] {
  if (handNumPlayers < 2 || handNumPlayers > MAX_PLAYERS) {
    throw new Error(`handNumPlayers must be 2..${MAX_PLAYERS}, got ${handNumPlayers}`);
  }
  const holes: number[] = [];
  for (let player = 0; player < handNumPlayers; player += 1) {
    const bit = 1 << player;
    const folded = (foldedMask & bit) !== 0;
    const shown = (showOnFoldMask & bit) !== 0;
    if (!folded || shown) {
      holes.push(player * 2, player * 2 + 1);
    }
  }
  return [...holes, 20, 21, 22, 23, 24];
}

/** Bitmask of used cards for the share circuit (unused hole slots cleared). */
export function shareCardMask(handNumPlayers?: number): bigint {
  if (handNumPlayers == null) {
    return (1n << BigInt(dealCardCount())) - 1n;
  }
  let mask = 0n;
  for (const idx of usedCardIndices(handNumPlayers)) {
    mask |= 1n << BigInt(idx);
  }
  return mask;
}

/** Board indices revealed when entering each betting street (after prior street ends). */
export function cardIndicesRevealedOnAdvance(
  fromPhase: 'PreFlop' | 'Flop' | 'Turn' | 'River',
  _handNumPlayers?: number,
): number[] {
  switch (fromPhase) {
    case 'PreFlop':
      return [...flopIndices()];
    case 'Flop':
      return [turnIndex()];
    case 'Turn':
      return [riverIndex()];
    case 'River':
      return [];
    default:
      return [];
  }
}

/**
 * Cumulative board deal indices face-up for a UI phase.
 * Flop → 20–22, Turn → +23, River/Showdown/Complete → +24.
 */
/**
 * Deal indices this viewer may decrypt for the current UI street.
 * Own holes after Share; board accumulates; all in-play holes at Showdown.
 */
export function visibleDealIndicesForViewerPhase(
  phase: string,
  viewerPlayerIndex: number,
  handNumPlayers: number,
): number[] {
  const own = [...holeCardIndices(viewerPlayerIndex)];
  if (phase === 'PreFlop' || phase === 'Evaluation') {
    return own;
  }
  if (phase === 'Flop' || phase === 'Turn' || phase === 'River') {
    return [...own, ...boardIndicesRevealedForUiPhase(phase)];
  }
  if (phase === 'Showdown' || phase === 'Complete') {
    return publicDealCardIndices(handNumPlayers);
  }
  return [];
}

export function boardIndicesRevealedForUiPhase(phase: string): number[] {
  switch (phase) {
    case 'Flop':
      return [...flopIndices()];
    case 'Turn':
      return [...flopIndices(), turnIndex()];
    case 'River':
    case 'Showdown':
    case 'Complete':
      return [...flopIndices(), turnIndex(), riverIndex()];
    default:
      return [];
  }
}

/** Same as boardIndicesRevealedForUiPhase, keyed by on-chain betting_phase (2=Flop…5=Showdown). */
export function boardIndicesRevealedForBettingPhase(bettingPhase: number): number[] {
  if (bettingPhase >= 4) {
    return [...flopIndices(), turnIndex(), riverIndex()];
  }
  if (bettingPhase === 3) {
    return [...flopIndices(), turnIndex()];
  }
  if (bettingPhase === 2) {
    return [...flopIndices()];
  }
  return [];
}

export function partialRowForRecipient(sharerIndex: number, recipientIndex: number): number {
  if (sharerIndex === recipientIndex) {
    throw new Error('Sharer and recipient must differ');
  }
  return recipientIndex > sharerIndex ? recipientIndex - 1 : recipientIndex;
}
