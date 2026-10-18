import type { GameSnapshot } from '../backend/client';
import {
  allowsMultipleDealers,
  usesBlackjackLayout,
  usesRouletteLayout,
  usesVersusDealerCards,
  versusCardCounts,
  type UiGameKind,
} from './game-kind';
import type { CardView, TableView } from './view-model';

const FACE_DOWN: CardView = { suit: '', unicode: '1F0A0', flipped: false };

function faceDownIfNeeded(card: CardView | undefined, faceUp: boolean): CardView {
  if (!card) {
    return FACE_DOWN;
  }
  if (faceUp) {
    return { ...card, flipped: true };
  }
  return FACE_DOWN;
}

function dealerSeatsFor(view: TableView, kind: UiGameKind, snapshot: GameSnapshot | null): number[] {
  const fromSnapshot = snapshot?.dealerSeats?.filter((seat) => Number.isInteger(seat) && seat >= 0);
  if (fromSnapshot && fromSnapshot.length > 0) {
    return [...new Set(fromSnapshot)];
  }
  if (usesBlackjackLayout(kind)) {
    return view.dealerSeat >= 0 ? [view.dealerSeat] : [0];
  }
  if (view.dealerSeat >= 0) {
    return [view.dealerSeat];
  }
  return allowsMultipleDealers(kind) ? [0] : [];
}

function padCards(cards: CardView[], count: number): CardView[] {
  const next = cards.slice(0, count);
  while (next.length < count) {
    next.push(FACE_DOWN);
  }
  return next;
}

function bettingStillOpen(snapshot: GameSnapshot | null, view: TableView): boolean {
  if (snapshot?.bettingRoundOpen) {
    return true;
  }
  return view.phase !== 'Showdown' && view.phase !== 'Complete' && view.phase !== 'lobby';
}

/** Remap a poker-shaped table view into the selected game's card/dealer chrome. */
export function presentTableView(
  view: TableView,
  kind: UiGameKind,
  snapshot: Partial<GameSnapshot> | null = null,
): TableView {
  const dealerSeats = dealerSeatsFor(view, kind, snapshot);
  const showDealer = view.showDealer || dealerSeats.length > 0;

  if (usesRouletteLayout(kind)) {
    const result = view.sharedCards[0] ?? FACE_DOWN;
    return {
      ...view,
      gameKind: kind,
      dealerSeats,
      showDealer,
      sharedCards: view.phase === 'lobby' ? [] : [result],
      playerCards: {},
      dealerCards: [],
      versusPlayerCards: [],
      rouletteBets: snapshot?.rouletteBets ?? view.rouletteBets ?? [],
    };
  }

  if (usesVersusDealerCards(kind)) {
    const counts = versusCardCounts(kind);
    const firstSeatCards = Object.values(view.playerCards)[0] ?? [];
    const dealerSource = view.sharedCards.slice(0, counts.dealer);
    const playerSource = [...firstSeatCards, ...view.sharedCards.slice(counts.dealer)];
    const faceUp = view.phase !== 'lobby';
    const dealerCards = padCards(dealerSource, counts.dealer).map((card) => ({
      ...card,
      flipped: faceUp && card.flipped,
    }));
    const versusPlayerCards = padCards(playerSource, counts.player).map((card) => ({
      ...card,
      flipped: view.phase === 'Showdown' || view.phase === 'Complete' || card.flipped,
    }));
    return {
      ...view,
      gameKind: kind,
      dealerSeats,
      showDealer,
      sharedCards: [],
      playerCards: {},
      dealerCards: view.phase === 'lobby' ? [] : dealerCards,
      versusPlayerCards: view.phase === 'lobby' ? [] : versusPlayerCards,
      rouletteBets: [],
    };
  }

  if (usesBlackjackLayout(kind)) {
    const hideHole = bettingStillOpen(snapshot, view) && view.phase !== 'Complete';
    const rawDealer = view.sharedCards.length >= 2
      ? view.sharedCards.slice(0, 4)
      : [FACE_DOWN, FACE_DOWN];
    const dealerCards = rawDealer.map((card, index) =>
      faceDownIfNeeded(card, !(hideHole && index === 1) && view.phase !== 'lobby'),
    );
    const playerCards: TableView['playerCards'] = {};
    for (const [seatKey, cards] of Object.entries(view.playerCards)) {
      const seat = Number(seatKey);
      if (dealerSeats.includes(seat)) {
        continue;
      }
      playerCards[seat] = cards;
    }
    return {
      ...view,
      gameKind: kind,
      dealerSeats,
      showDealer,
      sharedCards: [],
      playerCards,
      dealerCards: view.phase === 'lobby' ? [] : dealerCards,
      versusPlayerCards: [],
      rouletteBets: [],
    };
  }

  return {
    ...view,
    gameKind: kind,
    dealerSeats: view.dealerSeat >= 0 ? [view.dealerSeat] : [],
    dealerCards: [],
    versusPlayerCards: [],
    rouletteBets: [],
  };
}
