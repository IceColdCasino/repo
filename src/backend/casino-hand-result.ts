/**
 * Map War / Baccarat showdown plaintext (shoe indices) onto the poker-shaped
 * hand-result the macOS table view already renders (2 hole + board).
 */
import type { HandResultSnapshot } from './hand-result';

export type VersusCasinoKind = 'war' | 'baccarat';

export function faceIndex(card: number): number {
  return ((Math.trunc(card) % 52) + 52) % 52;
}

/** Player holes + dealer/board faces for `presentTableView` versus-dealer layout. */
export function casinoCardsForUi(
  kind: VersusCasinoKind,
  cards: Array<number | bigint>,
): { holeCards: [number, number]; boardCards: number[] } {
  const faces = cards.map((card) => faceIndex(Number(card)));
  if (kind === 'war') {
    return {
      holeCards: [faces[0] ?? 0, faces[2] ?? 0],
      boardCards: [faces[1] ?? 0, faces[3] ?? 0].filter((value) => Number.isInteger(value)),
    };
  }
  // Baccarat shoe: P1, P2, B1, B2, P3, B3. Board is banker 3, then player 3rd
  // so presentTableView can fill the 3+3 versus rows.
  return {
    holeCards: [faces[0] ?? 0, faces[1] ?? 0],
    boardCards: [faces[2] ?? 0, faces[3] ?? 0, faces[5] ?? 0, faces[4] ?? 0],
  };
}

/** 0 = player, 1 = dealer, 2 = tie — same as War/Baccarat evaluateOutcome. */
export function casinoWinnerSeats(winner: bigint | number, playerSeat: number): number[] {
  const value = typeof winner === 'bigint' ? winner : BigInt(winner);
  if (value === 1n) {
    return [];
  }
  return [playerSeat];
}

export function casinoOutcomeLabel(winner: bigint | number): string {
  const value = typeof winner === 'bigint' ? winner : BigInt(winner);
  if (value === 0n) return 'Player wins';
  if (value === 1n) return 'Dealer wins';
  return 'Tie';
}

export function buildCasinoHandResult(opts: {
  kind: VersusCasinoKind;
  winner: bigint | number;
  plaintextCards: Array<number | bigint>;
  playerSeat?: number;
  dealerSeat?: number;
  handNumber?: number;
  potAmount?: bigint;
}): HandResultSnapshot {
  const playerSeat = opts.playerSeat ?? 0;
  const dealerSeat = opts.dealerSeat ?? 1;
  const { holeCards, boardCards } = casinoCardsForUi(opts.kind, opts.plaintextCards);
  const winnerSeats = casinoWinnerSeats(opts.winner, playerSeat);
  const label = casinoOutcomeLabel(opts.winner);
  const potAmount = (opts.potAmount ?? 0n).toString();
  return {
    handNumber: opts.handNumber ?? 1,
    reason: 'showdown',
    potResults: potAmount === '0'
      ? []
      : [{ potIndex: 0, amount: potAmount, winnerSeats }],
    boardCards,
    seatHands: [
      {
        seat: playerSeat,
        playerIndex: 0,
        name: 'Player',
        folded: false,
        holeCards,
        handDescription: label,
      },
      {
        seat: dealerSeat,
        playerIndex: 1,
        name: 'Dealer',
        folded: false,
        holeCards: [boardCards[0] ?? 0, boardCards[1] ?? boardCards[0] ?? 0],
        handDescription: label,
      },
    ],
    actionOrder: [playerSeat, dealerSeat],
    handNumPlayers: 2,
  };
}
