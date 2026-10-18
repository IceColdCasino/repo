import type { GameSnapshot } from './game-api';
import { cardUnicode, FACE_DOWN_UNICODE } from './card-encoding';

export type ExpectedCardSlot = {
  faceUp: boolean;
  unicode: string;
};

export type ExpectedCardLayout = {
  shared: ExpectedCardSlot[];
  holes: Record<number, [ExpectedCardSlot, ExpectedCardSlot]>;
};

function revealedBoardCount(phase: string): number {
  switch (phase) {
    case 'lobby':
    case 'PreFlop':
      return 0;
    case 'Complete':
      return 5;
    case 'Flop':
      return 3;
    case 'Turn':
      return 4;
    case 'River':
    case 'Showdown':
      return 5;
    default:
      return 0;
  }
}

function isZkFaceDownPhase(phase: string): boolean {
  return phase === 'Register' || phase === 'Shuffle' || phase === 'Share';
}

function handInProgress(phase: string): boolean {
  return phase !== 'lobby' && phase !== 'Complete';
}

function shouldRenderTableCards(state: GameSnapshot): boolean {
  return handInProgress(state.phase)
    || (state.phase === 'Complete' && Boolean(state.handResult));
}

function dealCardValue(state: GameSnapshot, dealIndex: number): number {
  const mapped = state.e2eDealValues?.[dealIndex] ?? state.e2eDealValues?.[String(dealIndex)];
  if (mapped !== undefined) {
    return mapped;
  }
  return dealIndex;
}

function boardSlotFaceUp(slotIndex: number, state: GameSnapshot): boolean {
  if (isZkFaceDownPhase(state.phase)) {
    return false;
  }
  const deckIndex = state.boardCards?.[slotIndex];
  if (deckIndex === undefined) {
    return false;
  }
  if (state.zkReveal) {
    return state.zkReveal.revealedCardIndices.includes(deckIndex);
  }
  if (state.phase === 'Complete') {
    return true;
  }
  return slotIndex < revealedBoardCount(state.phase);
}

function ownHoleCardsVisible(state: GameSnapshot): boolean {
  if (!state.zkReveal?.shareComplete) {
    return false;
  }
  if (state.zkReveal.allPartialsPublic) {
    return true;
  }
  return state.zkReveal.holePartialsUnlocked === true;
}

function holeCardsFaceUp(
  seat: number,
  state: GameSnapshot,
  localSeat: number | null,
  zkShowdownPending: boolean,
): boolean {
  if (isZkFaceDownPhase(state.phase)) {
    return false;
  }

  const seatInfo = state.seats.find((entry) => entry.seat === seat);
  if (seatInfo?.folded) {
    return false;
  }

  if (state.phase === 'Complete' && state.handResult) {
    const seatHand = state.handResult.seatHands.find((entry) => entry.seat === seat);
    return Boolean(seatHand && !seatHand.folded);
  }

  if (state.phase === 'Showdown') {
    if (state.zkReveal?.allPartialsPublic) {
      return true;
    }
    if (zkShowdownPending) {
      return false;
    }
    return localSeat !== null && seat === localSeat;
  }

  if (state.zkReveal && !ownHoleCardsVisible(state)) {
    return false;
  }

  if (state.zkReveal?.shareComplete || state.zkCrypto) {
    return localSeat !== null && seat === localSeat;
  }

  return localSeat !== null && seat === localSeat;
}

function cardSlot(dealIndex: number, faceUp: boolean, state: GameSnapshot): ExpectedCardSlot {
  if (!faceUp) {
    return { faceUp: false, unicode: FACE_DOWN_UNICODE };
  }
  return { faceUp: true, unicode: cardUnicode(dealCardValue(state, dealIndex)) };
}

export function buildExpectedCardLayout(
  state: GameSnapshot,
  viewerSeat: number | null,
): ExpectedCardLayout {
  const shared: ExpectedCardSlot[] = [];
  const holes: Record<number, [ExpectedCardSlot, ExpectedCardSlot]> = {};

  if (!shouldRenderTableCards(state)) {
    return { shared, holes };
  }

  const zkShowdownPending = Boolean(
    state.zkShowdown?.requested
    && state.zkShowdown.submittedCount < state.zkShowdown.requiredCount,
  );

  const boardSlots = state.boardCards ?? Array.from({ length: 5 }, (_, slot) => slot);
  for (let slotIndex = 0; slotIndex < 5; slotIndex += 1) {
    const dealIndex = boardSlots[slotIndex]!;
    shared.push(cardSlot(dealIndex, boardSlotFaceUp(slotIndex, state), state));
  }

  if (state.holeCards) {
    for (const seat of state.seats) {
      const hole = state.holeCards[String(seat.seat)] ?? state.holeCards[seat.seat];
      if (!hole) {
        continue;
      }
      const faceUp = holeCardsFaceUp(seat.seat, state, viewerSeat, zkShowdownPending);
      holes[seat.seat] = [
        cardSlot(hole[0], faceUp, state),
        cardSlot(hole[1], faceUp, state),
      ];
    }
  }

  return { shared, holes };
}

export function formatExpectedLayout(
  state: GameSnapshot,
  viewerSeat: number | null,
): string {
  const layout = buildExpectedCardLayout(state, viewerSeat);
  const board = layout.shared
    .map((slot) => (slot.faceUp ? slot.unicode : 'down'))
    .join(', ');
  const holeLines = Object.entries(layout.holes)
    .map(([seat, cards]) => {
      const rendered = cards.map((slot) => (slot.faceUp ? slot.unicode : 'down')).join('/');
      return `seat ${seat}: ${rendered}`;
    })
    .join('; ');
  return `phase=${state.phase} viewer=${viewerSeat ?? 'none'}; board=[${board}]; holes={${holeLines}}`;
}
