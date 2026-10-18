import { describe, expect, it } from 'vitest';
import {
  isUiGameKind,
  seatCountForGame,
  usesBlackjackLayout,
  usesRouletteLayout,
  usesTwelveSeatRail,
  usesVersusDealerCards,
  versusCardCounts,
} from './game-kind';

describe('UI game kind', () => {
  it('gives War / Baccarat / Roulette 12 seats and Blackjack 8', () => {
    expect(seatCountForGame('poker')).toBe(10);
    expect(seatCountForGame('blackjack')).toBe(8);
    expect(seatCountForGame('war')).toBe(12);
    expect(seatCountForGame('baccarat')).toBe(12);
    expect(seatCountForGame('roulette')).toBe(12);
  });

  it('accepts the same ids the backend / Arcium factory use', () => {
    for (const kind of ['poker', 'blackjack', 'war', 'baccarat', 'roulette'] as const) {
      expect(isUiGameKind(kind)).toBe(true);
    }
  });

  it('classifies card layouts', () => {
    expect(usesTwelveSeatRail('war')).toBe(true);
    expect(usesVersusDealerCards('baccarat')).toBe(true);
    expect(usesBlackjackLayout('blackjack')).toBe(true);
    expect(usesRouletteLayout('roulette')).toBe(true);
    expect(usesVersusDealerCards('poker')).toBe(false);
    expect(versusCardCounts('war')).toEqual({ player: 2, dealer: 2 });
    expect(versusCardCounts('baccarat')).toEqual({ player: 3, dealer: 3 });
  });
});
