import { holeCardIndices } from '@poker-src/backend/card-layout';
import type { BettingPhase, GameSnapshot } from '../backend/client';
import { Card } from './card';
import { avatarForPublicKey } from './smoking-punks';
import type { HandResultView } from './hand-result-view';
import { payoutSharesForPot } from './hand-result-view';
import type { CardView, PotView, SeatView, TableView } from './view-model';

const faceDownCard: CardView = { suit: '', unicode: '1F0A0', flipped: false };

function cardView(index: number, faceUp: boolean): CardView {
  if (!faceUp) {
    return faceDownCard;
  }
  const card = new Card(index);
  return {
    suit: card.suitName,
    unicode: card.unicode,
    flipped: true,
  };
}

/**
 * ZK / Solana hands store deal-layout indices (0..24); faces come only from
 * decryption (or e2e overrides). Never treat dealIndex as a card id.
 */
export function usesZkCardDecryption(state: GameSnapshot): boolean {
  if (state.e2eDealValues) {
    return false;
  }
  // War / Baccarat Complete publishes plaintext faces (0–51), not deal-layout
  // indices. Treating them as Solana ZK cards would keep the table face-down.
  if (
    (state.gameKind === 'war' || state.gameKind === 'baccarat')
    && (state.phase === 'Complete' || state.phase === 'Showdown')
    && state.handResult
    && !state.handResult.zkFinalDeck
  ) {
    return false;
  }
  if (state.backend === 'solana') {
    return true;
  }
  return Boolean(state.zkReveal || state.zkCrypto || state.handResult?.zkFinalDeck);
}

function buildCardViewForDealIndex(
  dealIndex: number,
  wantFaceUp: boolean,
  decryptedCards: ReadonlyMap<number, number> | undefined,
  usesDecryption: boolean,
): CardView {
  if (!wantFaceUp) {
    return faceDownCard;
  }
  const decrypted = decryptedCards?.get(dealIndex);
  if (usesDecryption) {
    if (decrypted === undefined) {
      return faceDownCard;
    }
    return cardView(decrypted, true);
  }
  return cardView(decrypted ?? dealIndex, true);
}

function revealedBoardCount(phase: BettingPhase): number {
  switch (phase) {
    case 'lobby':
      return 0;
    case 'Complete':
      // Complete with a hand result forces face-up via resultsVisible; this is
      // the street fallback when zkReveal indices are missing.
      return 5;
    case 'PreFlop':
      return 0;
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

function isZkFaceDownPhase(phase: BettingPhase): boolean {
  return phase === 'Register' || phase === 'Shuffle' || phase === 'Share';
}

function handInProgress(phase: BettingPhase): boolean {
  return phase !== 'lobby' && phase !== 'Complete';
}

function shouldRenderTableCards(state: GameSnapshot): boolean {
  return handInProgress(state.phase)
    || (state.phase === 'Complete' && Boolean(state.handResult));
}

/** Community board + hole backs appear only after shuffle completes (Share+). */
function shouldRenderSharedCards(state: GameSnapshot): boolean {
  if (!shouldRenderTableCards(state)) {
    return false;
  }
  return state.phase !== 'Register' && state.phase !== 'Shuffle';
}

/** Same gate as the board: face-down holes once shuffle is done. */
function shouldRenderHoleCards(state: GameSnapshot): boolean {
  return shouldRenderSharedCards(state);
}

/**
 * Deal-layout indices for a seated player's holes.
 * Solana getGame often omits `holeCards` until decrypt — still show face-down backs.
 */
function holeDealIndicesForSeat(
  seat: number,
  state: GameSnapshot,
): [number, number] | null {
  const fromSnapshot = state.holeCards?.[seat];
  if (fromSnapshot) {
    return fromSnapshot;
  }
  const playerIndex = state.playerIndexBySeat?.[seat]
    ?? state.seats.find((entry) => entry.seat === seat)?.playerIndex
    ?? state.actionOrder?.indexOf(seat);
  if (playerIndex === undefined || playerIndex < 0) {
    return null;
  }
  return holeCardIndices(playerIndex);
}

function completeHoleCardsFaceUp(
  seat: number,
  handResultView: HandResultView | null | undefined,
  state?: GameSnapshot,
): boolean {
  const seatHand = handResultView?.seats.find((entry) => entry.seat === seat);
  if (seatHand) {
    return !seatHand.folded;
  }
  if (state?.phase === 'Complete' && state.handResult) {
    const fromResult = state.handResult.seatHands.find((entry) => entry.seat === seat);
    return fromResult ? !fromResult.folded : false;
  }
  return false;
}

function boardSlotFaceUp(slotIndex: number, state: GameSnapshot): boolean {
  if (isZkFaceDownPhase(state.phase)) {
    return false;
  }
  const streetRevealed = slotIndex < revealedBoardCount(state.phase);
  if (streetRevealed) {
    // Street unlock is the source of truth. A partial revealedCardIndices list
    // (holes-only PDA fetch at Showdown) must not flip the flop/turn/river back.
    return true;
  }
  const deckIndex = state.boardCards?.[slotIndex];
  if (state.zkReveal && deckIndex !== undefined && deckIndex >= 0) {
    return state.zkReveal.revealedCardIndices.includes(deckIndex);
  }
  return false;
}

function isPostShareBetting(state: GameSnapshot): boolean {
  if (isZkFaceDownPhase(state.phase)) {
    return false;
  }
  return Boolean(state.zkReveal?.shareComplete || state.zkCrypto);
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
  _zkShowdownPending: boolean,
): boolean {
  if (isZkFaceDownPhase(state.phase)) {
    return false;
  }

  const seatInfo = state.seats.find((s) => s.seat === seat);
  if (seatInfo?.folded) {
    return false;
  }

  if (state.phase === 'Showdown') {
    // Public partials → every non-folded seat; otherwise only the local player.
    if (state.zkReveal?.allPartialsPublic) {
      return true;
    }
    if (localSeat !== null && seat === localSeat) {
      return true;
    }
    return false;
  }

  if (state.zkReveal && !ownHoleCardsVisible(state)) {
    return false;
  }

  if (isPostShareBetting(state)) {
    return localSeat !== null && seat === localSeat;
  }

  return localSeat !== null && seat === localSeat;
}

export function snapshotFromServer(
  state: GameSnapshot | null,
  localSeat: number | null = null,
  decryptedCards?: ReadonlyMap<number, number>,
  handResultView?: HandResultView | null,
): TableView {
  if (!state) {
    return {
      phase: 'lobby',
      dealerSeat: -1,
      currentBet: 0,
      actionOrder: [],
      seats: [],
      pots: [],
      sharedCards: [],
      playerCards: {},
      showDealer: false,
    };
  }

  const handComplete = state.phase === 'Complete' && Boolean(state.handResult);
  const showdownResults = state.phase === 'Showdown' && Boolean(handResultView);
  const resultsVisible = handComplete || showdownResults;
  const resultView = handComplete
    ? (handResultView ?? null)
    : showdownResults
      ? (handResultView ?? null)
      : null;
  const wonBySeat = new Map<number, { amount: number; handDescription?: string }>();
  if (resultView) {
    for (const seat of resultView.seats) {
      if (seat.wonAmount > 0) {
        wonBySeat.set(seat.seat, {
          amount: seat.wonAmount,
          handDescription: seat.handDescription,
        });
      }
    }
  }

  const seats: SeatView[] = state.seats.map((seat) => {
    const winner = wonBySeat.get(seat.seat);
    return {
      seat: seat.seat,
      name: seat.name,
      publicKey: seat.publicKey,
      avatarId: seat.publicKey ? avatarForPublicKey(seat.publicKey) : undefined,
      playerIndex: seat.playerIndex,
      chips: Number(seat.chips),
      bet: Number(seat.bet),
      active: state.currentPlayerSeat !== null
        ? seat.seat === state.currentPlayerSeat
        : seat.active,
      folded: seat.folded,
      winnerHighlight: Boolean(winner),
      wonAmount: winner?.amount,
      handDescription: winner?.handDescription,
    };
  });

  const pots: PotView[] = resultsVisible && resultView
    ? resultView.pots.map((pot) => ({
        amount: pot.amount,
        lastBet: 0,
        winnerLabel: pot.splitLabel,
        winnerPayouts: pot.winners.map((winner, index) => ({
          seat: winner.seat,
          name: winner.name,
          amount: payoutSharesForPot(pot.amount, pot.winners.length)[index] ?? 0,
          handDescription: winner.handDescription,
        })),
      }))
    : state.pots.map((pot) => ({
        amount: Number(pot.amount),
        lastBet: Number(pot.lastBet),
      }));

  const renderingCards = shouldRenderTableCards(state);
  const usesDecryption = usesZkCardDecryption(state);
  const zkShowdownPending = Boolean(
    state.zkShowdown?.requested
    && state.zkShowdown.submittedCount < state.zkShowdown.requiredCount,
  );

  const sharedCards: CardView[] = shouldRenderSharedCards(state)
    ? (state.boardCards ?? Array.from({ length: 5 }, (_, slot) => slot))
        .slice(0, 5)
        .map((dealIndex, slotIndex) =>
          buildCardViewForDealIndex(
            dealIndex,
            resultsVisible ? true : boardSlotFaceUp(slotIndex, state),
            decryptedCards,
            usesDecryption,
          ),
        )
    : [];

  const playerCards: Record<number, [CardView, CardView]> = {};
  if (renderingCards && shouldRenderHoleCards(state)) {
    for (const seat of state.seats) {
      const hole = holeDealIndicesForSeat(seat.seat, state);
      if (!hole) {
        continue;
      }
      const wantFaceUp = resultsVisible
        ? completeHoleCardsFaceUp(seat.seat, resultView, state)
        : holeCardsFaceUp(seat.seat, state, localSeat, zkShowdownPending);
      playerCards[seat.seat] = [
        buildCardViewForDealIndex(hole[0], wantFaceUp, decryptedCards, usesDecryption),
        buildCardViewForDealIndex(hole[1], wantFaceUp, decryptedCards, usesDecryption),
      ];
    }
  }

  return {
    phase: state.phase,
    dealerSeat: state.dealerSeat,
    currentBet: Number(state.currentBet),
    handNumber: state.handNumber ?? resultView?.handNumber,
    actionOrder: state.actionOrder ?? [],
    seats,
    pots,
    sharedCards,
    playerCards,
    showDealer: renderingCards,
    handComplete,
  };
}

export function callAmountForSeat(state: GameSnapshot, seat: number): number {
  const seatInfo = state.seats.find((s) => s.seat === seat);
  if (!seatInfo) {
    return 0;
  }
  const currentBet = Number(state.currentBet);
  const playerBet = Number(seatInfo.bet);
  return Math.max(0, currentBet - playerBet);
}

export function openSeats(state: GameSnapshot | null, seatCount = 10): number[] {
  if (!state) {
    return Array.from({ length: seatCount }, (_, seat) => seat);
  }
  const taken = new Set(state.seats.map((seat) => seat.seat));
  return Array.from({ length: seatCount }, (_, seat) => seat).filter((seat) => !taken.has(seat));
}

/** Open seats for the seat picker (all rail seats when no game exists yet). */
export function selectableSeats(state: GameSnapshot | null, seatCount = 10): number[] {
  return openSeats(state, seatCount);
}
