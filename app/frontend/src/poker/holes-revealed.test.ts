import { describe, expect, it } from 'vitest';
import { Card } from './card';
import {
  allHoleCardsRevealed,
  claimPreflopOpen,
  emptyHolesRevealed,
  localHolesFaceUp,
  mergeHolesRevealed,
  noteHolesRevealed,
  parseHolesRevealed,
} from './holes-revealed';
import type { CardView } from './view-model';

function face(id: number): CardView {
  const card = new Card(id);
  return { suit: card.suitName, unicode: card.unicode, flipped: true };
}

function back(): CardView {
  return { suit: '', unicode: '1F0A0', flipped: false };
}

describe('hole reveal before preflop', () => {
  it('treats two face-up hole cards as revealed', () => {
    expect(localHolesFaceUp([face(0), face(1)])).toBe(true);
    expect(localHolesFaceUp([face(0), back()])).toBe(false);
    expect(localHolesFaceUp([face(0)])).toBe(false);
  });

  it('opens preflop only after every seated player has revealed', () => {
    const noted = noteHolesRevealed(noteHolesRevealed(emptyHolesRevealed('g', 1), 0), 1);
    expect(allHoleCardsRevealed(noted, [0, 1])).toBe(true);
    expect(allHoleCardsRevealed(noteHolesRevealed(emptyHolesRevealed('g', 1), 0), [0, 1])).toBe(false);
  });

  it('keeps the first opener when both windows write', () => {
    const disk = claimPreflopOpen(noteHolesRevealed(emptyHolesRevealed('g', 2), 1), 1);
    const incoming = claimPreflopOpen(noteHolesRevealed(emptyHolesRevealed('g', 2), 0), 0);
    expect(mergeHolesRevealed(disk, incoming).opener).toBe(1);
    expect(mergeHolesRevealed(disk, incoming).seats).toEqual([0, 1]);
  });

  it('drops a record from another hand', () => {
    const raw = JSON.stringify({ gameId: 'old', handNumber: 1, seats: [0, 1], opener: 0 });
    expect(parseHolesRevealed(raw, 'new', 2)).toEqual(emptyHolesRevealed('new', 2));
  });
});
