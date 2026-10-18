import { describe, expect, it } from 'vitest';
import { buildHandResultView } from './hand-result-view';
import type { HandResultSnapshot } from '../backend/client';

const sampleResult: HandResultSnapshot = {
  handNumber: 3,
  reason: 'showdown',
  potResults: [{
    potIndex: 0,
    amount: '6',
    winnerSeats: [0],
  }],
  boardCards: [10, 11, 12, 13, 14],
  seatHands: [
    {
      seat: 0,
      playerIndex: 0,
      name: 'Alice',
      folded: false,
      holeCards: [0, 1],
      handDescription: 'Pair of Aces',
    },
    {
      seat: 1,
      playerIndex: 1,
      name: 'Bob',
      folded: false,
      holeCards: [2, 3],
      handDescription: 'Pair of Kings',
    },
  ],
  actionOrder: [0, 1],
};

describe('buildHandResultView', () => {
  it('shows pot winners and hand descriptions', () => {
    const view = buildHandResultView(sampleResult);
    expect(view.handNumber).toBe(3);
    expect(view.pots[0]?.amount).toBe(6);
    expect(view.pots[0]?.winners[0]?.name).toBe('Alice');
    expect(view.pots[0]?.winners[0]?.handDescription).toBe('Pair of Aces');
    expect(view.seats.find((seat) => seat.seat === 0)?.wonAmount).toBe(6);
  });

  it('shows all authenticated winners when pot is split', () => {
    const split: HandResultSnapshot = {
      ...sampleResult,
      potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0, 1] }],
    };
    const view = buildHandResultView(split);
    expect(view.pots[0]?.winners.map((w) => w.seat)).toEqual([0, 1]);
    expect(view.pots[0]?.splitLabel).toBe('Alice & Bob split');
    expect(view.pots[0]?.winners[0]?.wonAmount).toBe(3);
    expect(view.pots[0]?.winners[1]?.wonAmount).toBe(3);
  });

  it('uses authenticated winner seats with SB-first action order', () => {
    const sbFirst: HandResultSnapshot = {
      handNumber: 1,
      reason: 'showdown',
      potResults: [{ potIndex: 0, amount: '40', winnerSeats: [0] }],
      boardCards: [20, 21, 22, 23, 24],
      seatHands: [
        {
          seat: 1,
          playerIndex: 0,
          name: 'Seat 1',
          folded: false,
          holeCards: [0, 1],
        },
        {
          seat: 0,
          playerIndex: 1,
          name: 'Seat 0',
          folded: false,
          holeCards: [2, 3],
        },
      ],
      actionOrder: [1, 0],
      handNumPlayers: 2,
    };
    const view = buildHandResultView(sbFirst);
    expect(view.pots[0]?.winners.map((w) => w.seat)).toEqual([0]);
    expect(view.seats.find((s) => s.seat === 0)?.wonAmount).toBe(40);
    expect(view.seats.find((s) => s.seat === 1)?.wonAmount).toBe(0);
  });

  it('reconciles stale pending winners with decrypted Pair of Sevens vs Fours', () => {
    // Board: 4♥ 3♥ Q♠ 7♣ 5♣ ; seat0 K♥ 7♦ (pair 7s) ; seat1 2♣ 4♦ (pair 4s)
    const A = (rank: number, suit: number) => suit * 13 + rank;
    const fourH = A(2, 1), threeH = A(1, 1), queenS = A(10, 0);
    const sevenC = A(5, 3), fiveC = A(3, 3), sevenD = A(5, 2);
    const kingH = A(11, 1), twoC = A(0, 3), fourD = A(2, 2);

    const softWrong: HandResultSnapshot = {
      handNumber: 1,
      reason: 'showdown',
      potResults: [{ potIndex: 0, amount: '40', winnerSeats: [1] }],
      boardCards: [20, 21, 22, 23, 24],
      seatHands: [
        {
          seat: 1,
          playerIndex: 0,
          name: 'Seat 1',
          folded: false,
          holeCards: [0, 1],
        },
        {
          seat: 0,
          playerIndex: 1,
          name: 'Seat 0',
          folded: false,
          holeCards: [2, 3],
        },
      ],
      actionOrder: [1, 0],
      handNumPlayers: 2,
      zkFinalDeck: [],
    };
    const decrypted = new Map<number, number>([
      [0, twoC],
      [1, fourD],
      [2, kingH],
      [3, sevenD],
      [20, fourH],
      [21, threeH],
      [22, queenS],
      [23, sevenC],
      [24, fiveC],
    ]);
    const view = buildHandResultView(softWrong, decrypted);
    expect(view.pots[0]?.winners.map((w) => w.seat)).toEqual([0]);
    expect(view.pots[0]?.winners[0]?.handDescription).toBe('Pair of Sevens');
    expect(view.seats.find((s) => s.seat === 0)?.wonAmount).toBe(40);
    expect(view.seats.find((s) => s.seat === 1)?.wonAmount).toBe(0);
  });

  it('uses HTML suit entities in winner card labels', () => {
    const view = buildHandResultView(sampleResult);
    const label = view.pots[0]?.winners[0]?.cardsLabel;
    expect(label).toContain('&spades;');
    expect(label).toContain('&hearts;');
    expect(label).not.toMatch(/[^&]spade[^s]/);
  });

  it('does not render ZK deal indices as plaintext cards when decrypt material is missing', () => {
    const zkResult: HandResultSnapshot = {
      ...sampleResult,
      boardCards: [20, 21, 22, 23, 24],
      handNumPlayers: 2,
      zkFinalDeck: undefined,
      seatHands: sampleResult.seatHands.map((seat) => ({
        ...seat,
        handDescription: undefined,
      })),
    };

    const view = buildHandResultView(zkResult);

    expect(view.pots[0]?.winners[0]?.cardsLabel).toBeUndefined();
    expect(view.seats[0]?.cardsLabel).toBeUndefined();
    expect(view.seats[0]?.handDescription).toBeUndefined();
  });
});
