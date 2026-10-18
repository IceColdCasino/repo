import { Card } from './card';
import type { Game } from './game';
import type { Player } from './player';
import type { Table } from './table';

export type CardView = {
  suit: string;
  unicode: string;
  flipped: boolean;
};

export type SeatView = {
  seat: number;
  name: string;
  publicKey?: string;
  avatarId?: number;
  playerIndex?: number;
  chips: number;
  bet: number;
  active: boolean;
  folded?: boolean;
  /** Highlight seat as a pot winner after the hand completes. */
  winnerHighlight?: boolean;
  wonAmount?: number;
  handDescription?: string;
};

export type PotView = {
  amount: number;
  lastBet: number;
  /** Present when the hand is complete: winner names for this pot. */
  winnerLabel?: string;
  /** Per-winner payout from this pot. */
  winnerPayouts?: Array<{ seat: number; name: string; amount: number; handDescription?: string }>;
};

export type RouletteBetView = {
  type: number;
  modifier: number;
  seat: number;
  amount?: string;
};

export type TableView = {
  phase: string;
  dealerSeat: number;
  dealerSeats?: number[];
  currentBet: number;
  handNumber?: number;
  actionOrder: number[];
  seats: SeatView[];
  pots: PotView[];
  sharedCards: CardView[];
  playerCards: Record<number, CardView[]>;
  dealerCards?: CardView[];
  versusPlayerCards?: CardView[];
  rouletteBets?: RouletteBetView[];
  gameKind?: import('./game-kind').UiGameKind;
  showDealer: boolean;
  handComplete?: boolean;
};

const sharedCardIds = ['flop0', 'flop1', 'flop2', 'turn', 'river'] as const;
const faceDownCard: CardView = { suit: '', unicode: '1F0A0', flipped: false };

function cardView(index: number | undefined, flipped: boolean): CardView {
  if (index === undefined) {
    return faceDownCard;
  }

  const card = new Card(index);
  return {
    suit: card.suitName,
    unicode: card.unicode,
    flipped,
  };
}

function seatBet(game: Game | null, seat: number, player: Player): number {
  if (!game) {
    return 0;
  }

  return game.potManager.betForPlayer(player);
}

export function snapshotTable(table: Table, game: Game | null = null): TableView {
  const seats: SeatView[] = [];

  for (let seat = 0; seat < table.maxPlayers; seat += 1) {
    const playerKey = table.seats.get(seat);
    if (!playerKey) {
      continue;
    }

    const player = table.playerMap.get(playerKey);
    if (!player) {
      continue;
    }

    seats.push({
      seat,
      name: player.name,
      chips: player.chips,
      bet: seatBet(game, seat, player),
      active: game ? game.actionActiveSeats.has(seat) : false,
    });
  }

  const pots = game
    ? game.potManager.pots.map((pot) => ({
        amount: pot.amount,
        lastBet: pot.lastBetAmount,
      }))
    : [];

  const sharedCards = sharedCardIds.map((_, index) => {
    if (!game || game.phase === 'lobby') {
      return null;
    }

    const hand = game.hand;
    const sharedIndexes = [
      ...hand.flopCards,
      ...hand.turnCards,
      ...hand.riverCards,
    ];
    if (sharedIndexes.length <= index) {
      return null;
    }
    return cardView(sharedIndexes[index], true);
  }).filter((card): card is CardView => card !== null);

  const playerCards: Record<number, [CardView, CardView]> = {};

  if (game) {
    for (const [seat, playerKey] of table.seats.entries()) {
      const seatIndex = [...table.sortedSeats].indexOf(seat);
      if (seatIndex < 0) {
        continue;
      }

      const cards = game.hand.playerCards[seatIndex] ?? [];
      playerCards[seat] = [
        cardView(cards[0], false),
        cardView(cards[1], false),
      ];
    }
  }

  return {
    phase: game?.phase ?? 'lobby',
    dealerSeat: game?.dealerSeat ?? table.currentDealer,
    currentBet: game?.currentBet ?? 0,
    actionOrder: [],
    seats,
    pots,
    sharedCards,
    playerCards,
    showDealer: game !== null && game.phase !== 'lobby',
  };
}