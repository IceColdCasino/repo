import { describe, expect, it } from 'vitest';
import { presentTableView } from './table-view-adapt';
import type { TableView } from './view-model';

const face = (unicode: string, flipped = true) => ({ suit: 'spades', unicode, flipped });

function baseView(overrides: Partial<TableView> = {}): TableView {
  return {
    phase: 'PreFlop',
    dealerSeat: 0,
    currentBet: 20,
    actionOrder: [0, 1],
    seats: [],
    pots: [],
    sharedCards: [face('1F0A1'), face('1F0A2'), face('1F0A3')],
    playerCards: {
      1: [face('1F0AB'), face('1F0AC')],
    },
    showDealer: true,
    ...overrides,
  };
}

describe('presentTableView', () => {
  it('keeps poker board and hole cards', () => {
    const view = presentTableView(baseView(), 'poker');
    expect(view.sharedCards).toHaveLength(3);
    expect(view.playerCards[1]).toHaveLength(2);
    expect(view.dealerSeats).toEqual([0]);
  });

  it('puts War cards at dealer-top and player-bottom (2+2), not at seats', () => {
    const view = presentTableView(baseView(), 'war');
    expect(view.playerCards).toEqual({});
    expect(view.dealerCards).toHaveLength(2);
    expect(view.versusPlayerCards).toHaveLength(2);
  });

  it('puts Baccarat cards at banker-top and player-bottom (3+3)', () => {
    const view = presentTableView(baseView({
      sharedCards: [face('1F0A1'), face('1F0A2'), face('1F0A3'), face('1F0A4')],
      playerCards: { 1: [face('1F0AB'), face('1F0AC')] },
    }), 'baccarat');
    expect(view.playerCards).toEqual({});
    expect(view.dealerCards).toHaveLength(3);
    expect(view.versusPlayerCards).toHaveLength(3);
    expect(view.versusPlayerCards?.[2]?.unicode).toBe('1F0A4');
  });

  it('hides the blackjack hole card while betting is open', () => {
    const view = presentTableView(baseView(), 'blackjack', {
      bettingRoundOpen: true,
    });
    expect(view.dealerCards?.[0]?.flipped).toBe(true);
    expect(view.dealerCards?.[1]?.flipped).toBe(false);
    expect(view.dealerCards?.[1]?.unicode).toBe('1F0A0');
    expect(view.playerCards[1]).toBeDefined();
    expect(view.playerCards[0]).toBeUndefined();
  });

  it('shows a single roulette result and no hole cards', () => {
    const view = presentTableView(baseView({
      rouletteBets: [{ type: 0, modifier: 17, seat: 2, amount: '10' }],
    }), 'roulette');
    expect(view.sharedCards).toHaveLength(1);
    expect(view.playerCards).toEqual({});
    expect(view.rouletteBets?.[0]?.modifier).toBe(17);
  });

  it('renders every listed dealer seat', () => {
    const view = presentTableView(baseView(), 'baccarat', {
      dealerSeats: [0, 3, 7],
    });
    expect(view.dealerSeats).toEqual([0, 3, 7]);
  });
});
