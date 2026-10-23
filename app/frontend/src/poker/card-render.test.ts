/// <reference types="vitest/globals" />
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PlayerCards from '../PlayerCards.svelte';
import SharedCards from '../SharedCards.svelte';
import { Card } from './card';
import { snapshotFromServer } from './server-view';
import type { GameSnapshot } from '../backend/client';
import type { CardView } from './view-model';

const FACE_DOWN = '1F0A0';

function decryptedMap(entries: Record<number, number>): Map<number, number> {
  return new Map(Object.entries(entries).map(([dealIndex, value]) => [Number(dealIndex), value]));
}

function emptyGame(seats: GameSnapshot['seats'] = []): GameSnapshot {
  return {
    gameId: 'g1',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats,
    pots: [],
  };
}

function renderSvg(component: typeof SharedCards | typeof PlayerCards, props: Record<string, unknown>) {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.appendChild(host);
  return render(component, {
    target: host,
    props,
  });
}

function cardAttrs(testId: string): { faceUp: boolean; unicode: string | null; suitClass: string } {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  expect(el).toBeTruthy();
  return {
    faceUp: el!.getAttribute('data-face-up') === 'true',
    unicode: el!.getAttribute('data-card-unicode'),
    suitClass: el!.getAttribute('class') ?? '',
  };
}

describe('card component DOM render', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('renders shared street cards face-up with card identities (not blank backs)', () => {
    const view = snapshotFromServer({
      ...emptyGame([
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ]),
      phase: 'Flop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decryptedMap({ 0: 10, 1: 11, 20: 51, 21: 50, 22: 49 }));

    renderSvg(SharedCards, { cards: view.sharedCards });

    const expected = [51, 50, 49].map((value) => new Card(value));
    for (let index = 0; index < 3; index += 1) {
      const attrs = cardAttrs(`shared-card-${index}`);
      expect(attrs.faceUp).toBe(true);
      expect(attrs.unicode).toBe(expected[index]!.unicode);
      expect(attrs.unicode).not.toBe(FACE_DOWN);
      expect(attrs.suitClass).toContain(expected[index]!.suitName);
      expect(attrs.suitClass).toContain('flipped');
    }
    for (let index = 3; index < 5; index += 1) {
      const attrs = cardAttrs(`shared-card-${index}`);
      expect(attrs.faceUp).toBe(false);
      expect(attrs.unicode).toBe(FACE_DOWN);
      expect(attrs.suitClass).not.toContain('flipped');
    }
  });

  it('renders local holes face-up and folded opponent holes face-down at showdown', () => {
    const view = snapshotFromServer({
      ...emptyGame([
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: true, active: false },
      ]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
    }, 0, decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    }));

    renderSvg(PlayerCards, { cardsBySeat: view.playerCards });

    const live0 = cardAttrs('hole-card-0-0');
    const live1 = cardAttrs('hole-card-0-1');
    expect(live0.faceUp).toBe(true);
    expect(live1.faceUp).toBe(true);
    expect(live0.unicode).toBe(new Card(10).unicode);
    expect(live1.unicode).toBe(new Card(11).unicode);
    expect(live0.suitClass).toContain(new Card(10).suitName);
    expect(live1.suitClass).toContain('flipped');

    const folded0 = cardAttrs('hole-card-1-0');
    const folded1 = cardAttrs('hole-card-1-1');
    expect(folded0.faceUp).toBe(false);
    expect(folded1.faceUp).toBe(false);
    expect(folded0.unicode).toBe(FACE_DOWN);
    expect(folded1.unicode).toBe(FACE_DOWN);
    expect(folded0.suitClass).not.toContain('flipped');
  });

  it('renders Complete showdown faces when decrypt map is present (live Solana shape)', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const view = snapshotFromServer({
      ...emptyGame([
        { seat: 0, name: 'Seat 0', publicKey: 'a', playerIndex: 0, chips: '5020', bet: '0', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', playerIndex: 1, chips: '4980', bet: '0', folded: false, active: false },
      ]),
      backend: 'solana',
      phase: 'Complete',
      dealerSeat: 0,
      handNumber: 1,
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      zkCrypto: {
        handNumPlayers: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        finalDeck: Array.from({ length: 25 }, () => ['1', '2', '3', '4']),
        dealCardCount: 25,
      },
      zkReveal: {
        revealedCardIndices: [0, 1, 2, 3, 20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
      handResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '30', winnerSeats: [0] }],
        boardCards: [20, 21, 22, 23, 24],
        seatHands: [
          { seat: 0, playerIndex: 0, name: 'Seat 0', folded: false, holeCards: [0, 1] },
          { seat: 1, playerIndex: 1, name: 'Seat 1', folded: false, holeCards: [2, 3] },
        ],
        actionOrder: [0, 1],
        zkFinalDeck: Array.from({ length: 25 }, () => ['1', '2', '3', '4']),
        handNumPlayers: 2,
      },
    }, 0, decrypted, {
      handNumber: 1,
      reason: 'showdown',
      pots: [{
        potIndex: 0,
        amount: 30,
        winners: [{ seat: 0, name: 'Seat 0', wonAmount: 30 }],
      }],
      seats: [
        { seat: 0, name: 'Seat 0', folded: false, wonAmount: 30 },
        { seat: 1, name: 'Seat 1', folded: false, wonAmount: 0 },
      ],
    });

    renderSvg(SharedCards, { cards: view.sharedCards });
    renderSvg(PlayerCards, { cardsBySeat: view.playerCards });

    for (let index = 0; index < 5; index += 1) {
      expect(cardAttrs(`shared-card-${index}`).faceUp).toBe(true);
      expect(cardAttrs(`shared-card-${index}`).unicode).not.toBe(FACE_DOWN);
    }
    expect(cardAttrs('hole-card-0-0').faceUp).toBe(true);
    expect(cardAttrs('hole-card-0-1').faceUp).toBe(true);
    expect(cardAttrs('hole-card-1-0').faceUp).toBe(true);
    expect(cardAttrs('hole-card-1-1').faceUp).toBe(true);
    expect(cardAttrs('hole-card-0-0').unicode).toBe(new Card(10).unicode);
    expect(cardAttrs('hole-card-1-0').unicode).toBe(new Card(12).unicode);
  });

  it('draws the card-back glyph and gradient on face-down slots', () => {
    const down: CardView = { suit: '', unicode: FACE_DOWN, flipped: false };
    const up: CardView = {
      suit: new Card(0).suitName,
      unicode: new Card(0).unicode,
      flipped: true,
    };
    renderSvg(SharedCards, { cards: [up, down, down, down, down] });

    expect(cardAttrs('shared-card-0')).toMatchObject({
      faceUp: true,
      unicode: new Card(0).unicode,
    });
    expect(cardAttrs('shared-card-1')).toMatchObject({
      faceUp: false,
      unicode: FACE_DOWN,
    });
    expect(document.querySelector('[data-testid="shared-card-1"] text')?.textContent).toBe('\u{1F0A0}');
    expect(document.querySelector('[data-testid="shared-card-1"] rect')?.getAttribute('fill')).toBe('url(#card-bg-gradient)');
    expect(document.querySelector('[data-testid="shared-card-0"] text')?.textContent).toBe(String.fromCodePoint(parseInt(new Card(0).unicode, 16)));
  });
});
