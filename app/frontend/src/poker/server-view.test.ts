import { describe, expect, it } from 'vitest';
import { openSeats, selectableSeats, snapshotFromServer, usesZkCardDecryption } from './server-view';
import { Card } from './card';
import type { GameSnapshot } from '../backend/client';

const emptyGame = (seats: GameSnapshot['seats'] = []): GameSnapshot => ({
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
});

function decryptedMap(entries: Record<number, number>): Map<number, number> {
  return new Map(Object.entries(entries).map(([dealIndex, value]) => [Number(dealIndex), value]));
}

describe('openSeats', () => {
  it('returns all ten seats when no game exists yet', () => {
    expect(selectableSeats(null)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('excludes occupied seats', () => {
    expect(
      openSeats(
        emptyGame([
          {
            seat: 2,
            name: 'Alice',
            publicKey: 'alice',
            chips: '0',
            bet: '0',
            folded: false,
            active: false,
          },
        ]),
      ),
    ).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('snapshotFromServer board and hole visibility', () => {
  it('hides community board during Register phase', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Register',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zk: {
        phase: 'Register',
        shuffleOrder: [1, 0],
        shuffleStep: 0,
        shuffleInputHash: null,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        registeredCount: 1,
        shuffledCount: 0,
        sharedCount: 0,
        requiredShares: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        cardsDealtFaceDown: false,
        currentDeck: null,
        shareDeck: null,
      },
    }, 0);

    expect(view.sharedCards).toHaveLength(0);
    expect(view.playerCards).toEqual({});
  });

  it('hides community board during Shuffle phase', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Shuffle',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zk: {
        phase: 'Shuffle',
        shuffleOrder: [1, 0],
        shuffleStep: 1,
        shuffleInputHash: null,
        currentShufflerIndex: 0,
        currentShufflerSeat: 0,
        registeredCount: 2,
        shuffledCount: 1,
        sharedCount: 0,
        requiredShares: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        cardsDealtFaceDown: false,
        currentDeck: null,
        shareDeck: null,
      },
    }, 0);

    expect(view.sharedCards).toHaveLength(0);
    expect(view.playerCards).toEqual({});
  });

  it('hides the board while shuffle has not finished, even if phase says PreFlop', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '20',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '20', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '10', folded: false, active: false },
      ],
      zk: {
        phase: 'Shuffle',
        shuffleOrder: [0, 1],
        shuffleStep: 0,
        shuffleInputHash: null,
        currentShufflerIndex: 0,
        currentShufflerSeat: 0,
        registeredCount: 2,
        shuffledCount: 0,
        sharedCount: 0,
        requiredShares: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        cardsDealtFaceDown: false,
        currentDeck: null,
        shareDeck: null,
      },
    }, 0);
    expect(view.sharedCards).toEqual([]);
    expect(view.playerCards).toEqual({});
  });

  it('shows five face-down board slots pre-flop during a ZK hand', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        entries: [],
      },
    }, 0);

    expect(view.sharedCards).toHaveLength(5);
    expect(view.sharedCards.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
  });

  it('shows own holes face up after pre-flop betting unlocks partials', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Flop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decryptedMap({ 0: 10, 1: 11, 20: 51, 21: 50, 22: 49 }));

    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[0]?.[0]).toMatchObject({
      flipped: true,
      suit: new Card(10).suitName,
      unicode: new Card(10).unicode,
    });
    expect(view.playerCards[0]?.[1]).toMatchObject({
      flipped: true,
      suit: new Card(11).suitName,
      unicode: new Card(11).unicode,
    });
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => card.unicode === '1F0A0' && card.suit === '')).toBe(true);
    expect(view.sharedCards.slice(0, 3).every((card) => card.flipped)).toBe(true);
    expect(view.sharedCards[0]).toMatchObject({
      flipped: true,
      suit: new Card(51).suitName,
      unicode: new Card(51).unicode,
    });
    expect(view.sharedCards[1]).toMatchObject({
      flipped: true,
      suit: new Card(50).suitName,
      unicode: new Card(50).unicode,
    });
    expect(view.sharedCards[2]).toMatchObject({
      flipped: true,
      suit: new Card(49).suitName,
      unicode: new Card(49).unicode,
    });
    expect(view.sharedCards.slice(3).every((card) => !card.flipped && card.unicode === '1F0A0')).toBe(true);
  });

  it('keeps ZK cards face down until decrypted values are available', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Flop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0);

    expect(view.sharedCards.slice(0, 3).every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => !card.flipped)).toBe(true);
  });

  it('Flop board face-up intent with empty revealedCardIndices still needs decrypt (no deal-index faces)', () => {
    const decrypted = decryptedMap({ 0: 10, 1: 11, 20: 51, 21: 50, 22: 49 });
    const view = snapshotFromServer({
      ...emptyGame([]),
      backend: 'solana',
      phase: 'Flop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decrypted);

    expect(view.sharedCards[0]).toMatchObject({
      flipped: true,
      unicode: new Card(51).unicode,
    });
    expect(view.sharedCards[1]).toMatchObject({
      flipped: true,
      unicode: new Card(50).unicode,
    });
    expect(view.sharedCards[2]).toMatchObject({
      flipped: true,
      unicode: new Card(49).unicode,
    });
    expect(view.sharedCards.slice(3).every((card) => !card.flipped)).toBe(true);
  });

  it('Turn/River board face-up uses decrypted faces for newly unlocked indices', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const turn = snapshotFromServer({
      ...emptyGame([]),
      backend: 'solana',
      phase: 'Turn',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23],
        newlyRevealed: [23],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decrypted);
    expect(turn.sharedCards.slice(0, 4).map((c) => c.unicode)).toEqual(
      [51, 50, 49, 48].map((v) => new Card(v).unicode),
    );
    expect(turn.sharedCards[4]?.flipped).toBe(false);

    const river = snapshotFromServer({
      ...emptyGame([]),
      backend: 'solana',
      phase: 'River',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [24],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decrypted);
    expect(river.sharedCards.map((c) => c.unicode)).toEqual(
      [51, 50, 49, 48, 47].map((v) => new Card(v).unicode),
    );
  });

  it('Complete on solana never paints deal-layout indices as faces without decrypt', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      backend: 'solana',
      phase: 'Complete',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      handResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '30', winnerSeats: [0] }],
        boardCards: [20, 21, 22, 23, 24],
        seatHands: [
          { seat: 0, playerIndex: 0, name: 'A', folded: false, holeCards: [0, 1] },
          { seat: 1, playerIndex: 1, name: 'B', folded: false, holeCards: [2, 3] },
        ],
        actionOrder: [0, 1],
      },
    }, 0, undefined, {
      handNumber: 1,
      reason: 'showdown',
      pots: [{
        potIndex: 0,
        amount: 30,
        winners: [{ seat: 0, name: 'A', wonAmount: 30 }],
      }],
      seats: [
        { seat: 0, name: 'A', folded: false, wonAmount: 30 },
        { seat: 1, name: 'B', folded: false, wonAmount: 0 },
      ],
    });

    expect(view.sharedCards).toHaveLength(0);
    expect(view.playerCards[0]).toBeUndefined();
    expect(view.playerCards[1]).toBeUndefined();
  });

  it('shows own holes face up during PreFlop once partials are unlocked', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      holesViewPending: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 1, decryptedMap({ 2: 12, 3: 13 }));

    expect(view.playerCards[1]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.[0]).toMatchObject({
      flipped: true,
      suit: new Card(12).suitName,
      unicode: new Card(12).unicode,
    });
    expect(view.playerCards[1]?.[1]).toMatchObject({
      flipped: true,
      suit: new Card(13).suitName,
      unicode: new Card(13).unicode,
    });
    expect(view.playerCards[0]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => card.unicode === '1F0A0' && card.suit === '')).toBe(true);
  });

  it('keeps own holes face down during PreFlop before partials unlock', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: 1,
      currentPlayerIndex: 1,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: true },
      ],
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: false,
        entries: [],
      },
    }, 1);

    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => !card.flipped)).toBe(true);
  });

  it('shows five face-down board and hole cards during Share phase', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Share',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zk: {
        phase: 'Share',
        shuffleOrder: [1, 0],
        shuffleStep: 2,
        shuffleInputHash: null,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        registeredCount: 2,
        shuffledCount: 2,
        sharedCount: 0,
        requiredShares: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        cardsDealtFaceDown: true,
        currentDeck: null,
        shareDeck: null,
      },
    }, 0);

    expect(view.sharedCards).toHaveLength(5);
    expect(view.sharedCards.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
  });

  it('synthesizes face-down hole backs after Shuffle when holeCards are absent (Solana)', () => {
    // Solana getGame enrichment often has board placeholders but no holeCards map.
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Share',
      dealerSeat: 0,
      smallBlindSeat: 1,
      bigBlindSeat: 0,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [1, 0],
      playerIndexBySeat: { 1: 0, 0: 1 },
      // no holeCards / boardCards — deal layout from playerIndexBySeat
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '5000', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '5000', bet: '0', folded: false, active: false },
      ],
      zk: {
        phase: 'Share',
        shuffleOrder: [0, 1],
        shuffleStep: 2,
        shuffleInputHash: null,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        registeredCount: 2,
        shuffledCount: 2,
        sharedCount: 0,
        requiredShares: 2,
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        cardsDealtFaceDown: true,
        currentDeck: null,
        shareDeck: null,
      },
    }, 0);

    expect(view.sharedCards).toHaveLength(5);
    expect(view.sharedCards.every((card) => !card.flipped && card.unicode === '1F0A0')).toBe(true);
    expect(view.playerCards[0]).toHaveLength(2);
    expect(view.playerCards[1]).toHaveLength(2);
    expect(view.playerCards[0]?.every((card) => !card.flipped && card.unicode === '1F0A0')).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped && card.unicode === '1F0A0')).toBe(true);
    // Empty / unused seats must not get hole slots
    expect(view.playerCards[2]).toBeUndefined();
  });

  it('keeps board face down during Share even when zkReveal would reveal slots', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Share',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '2',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '1', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '2', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        entries: [],
      },
    }, 0);

    expect(view.sharedCards.every((card) => !card.flipped)).toBe(true);
  });

  it('keeps placeholder board slots face down until deal-layout indices are present', () => {
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Flop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: 0,
      currentPlayerIndex: 0,
      bettingRoundOpen: true,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [-1, -1, -1, -1, -1],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: true },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    }, 0, decryptedMap({ 20: 51, 21: 50, 22: 49, 0: 10, 1: 11 }));

    // Street says flop is live, but -1 deal indices cannot resolve decrypted faces.
    expect(view.sharedCards.slice(0, 3).every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
  });

  it('keeps folded seats face down at showdown while revealing live holes', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: true, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
    }, 0, decrypted);

    expect(view.sharedCards.every((card) => card.flipped)).toBe(true);
    expect(view.sharedCards.map((card) => card.unicode)).toEqual(
      [51, 50, 49, 48, 47].map((value) => new Card(value).unicode),
    );
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[0]?.map((card) => card.unicode)).toEqual(
      [10, 11].map((value) => new Card(value).unicode),
    );
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => card.unicode === '1F0A0' && card.suit === '')).toBe(true);
  });

  it('keeps street-live board face up at Showdown when revealedCardIndices only lists holes', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const view = snapshotFromServer({
      ...emptyGame([]),
      backend: 'solana',
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [0, 1],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
    }, 0, decrypted);

    expect(view.sharedCards.every((card) => card.flipped)).toBe(true);
    expect(view.sharedCards.map((card) => card.unicode)).toEqual(
      [51, 50, 49, 48, 47].map((value) => new Card(value).unicode),
    );
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
  });

  it('faces up board cards as streets reveal and own holes at showdown', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
    }, 0, decrypted);

    expect(view.sharedCards.every((card) => card.flipped)).toBe(true);
    expect(view.sharedCards.map((card) => card.unicode)).toEqual(
      [51, 50, 49, 48, 47].map((value) => new Card(value).unicode),
    );
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[0]?.map((card) => card.unicode)).toEqual(
      [10, 11].map((value) => new Card(value).unicode),
    );
    expect(view.playerCards[1]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.map((card) => card.unicode)).toEqual(
      [12, 13].map((value) => new Card(value).unicode),
    );
  });

  it('shows own holes at showdown when partials are public even if proofs are pending', () => {
    const decrypted = decryptedMap({ 0: 10, 1: 11, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47 });
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    }, 0, decrypted);

    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
  });

  it('uses decrypted card values instead of deal layout indices', () => {
    const decrypted = new Map<number, number>([
      [20, 51],
      [21, 50],
      [0, 10],
      [1, 11],
    ]);
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
    }, 0, decrypted);

    expect(view.sharedCards[0]?.unicode).toBe(new Card(51).unicode);
    expect(view.sharedCards[1]?.unicode).toBe(new Card(50).unicode);
    expect(view.playerCards[0]?.[0]?.unicode).toBe(new Card(10).unicode);
    expect(view.playerCards[0]?.[1]?.unicode).toBe(new Card(11).unicode);
  });

  it('shows winner highlights during showdown proof generation from handResultView', () => {
    const decrypted = decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const handResultView = {
      handNumber: 1,
      reason: 'showdown' as const,
      pots: [{
        potIndex: 0,
        amount: 6,
        winners: [{
          seat: 0,
          name: 'A',
          handDescription: 'Pair of Aces',
          wonAmount: 6,
        }],
      }],
      seats: [
        { seat: 0, name: 'A', folded: false, wonAmount: 6, handDescription: 'Pair of Aces' },
        { seat: 1, name: 'B', folded: false, wonAmount: 0 },
      ],
    };
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Showdown',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ],
      pendingHandResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [],
        boardCards: [20, 21, 22, 23, 24],
        seatHands: [
          { seat: 0, playerIndex: 0, name: 'A', folded: false, holeCards: [0, 1] },
          { seat: 1, playerIndex: 1, name: 'B', folded: false, holeCards: [2, 3] },
        ],
        actionOrder: [0, 1],
        zkFinalDeck: [['1', '2', '3', '4']],
      },
      zkReveal: {
        revealedCardIndices: [20, 21, 22, 23, 24],
        newlyRevealed: [],
        allPartialsPublic: true,
        shareComplete: true,
        entries: [],
      },
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    }, 0, decrypted, handResultView);

    expect(view.seats.find((seat) => seat.seat === 0)?.winnerHighlight).toBe(true);
    expect(view.pots[0]?.winnerPayouts?.[0]?.amount).toBe(6);
    expect(view.sharedCards.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => card.flipped)).toBe(true);
  });

  it('keeps board and non-folded holes face up after hand completes', () => {
    const decrypted = decryptedMap({ 0: 10, 1: 11, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47 });
    const view = snapshotFromServer({
      ...emptyGame([]),
      phase: 'Complete',
      dealerSeat: 0,
      smallBlindSeat: -1,
      bigBlindSeat: -1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', playerIndex: 0, chips: '103', bet: '0', folded: false, active: false },
        { seat: 1, name: 'B', publicKey: 'b', playerIndex: 1, chips: '97', bet: '0', folded: true, active: false },
      ],
      pots: [{ amount: '3', lastBet: '0' }],
      handResult: {
        handNumber: 1,
        reason: 'fold',
        potResults: [{ potIndex: 0, amount: '3', winnerSeats: [0] }],
        boardCards: [20, 21, 22],
        seatHands: [
          { seat: 0, playerIndex: 0, name: 'A', folded: false, holeCards: [0, 1], handDescription: 'Won uncontested' },
          { seat: 1, playerIndex: 1, name: 'B', folded: true, holeCards: [2, 3] },
        ],
        actionOrder: [0, 1],
        zkFinalDeck: [['1', '2', '3', '4']],
      },
    }, 0, decrypted, {
      handNumber: 1,
      reason: 'fold',
      pots: [{
        potIndex: 0,
        amount: 3,
        winners: [{
          seat: 0,
          name: 'A',
          handDescription: 'Won uncontested',
          wonAmount: 3,
        }],
      }],
      seats: [
        { seat: 0, name: 'A', folded: false, wonAmount: 3, handDescription: 'Won uncontested' },
        { seat: 1, name: 'B', folded: true, wonAmount: 0 },
      ],
    });

    expect(view.handComplete).toBe(true);
    expect(view.sharedCards.slice(0, 3).every((card) => card.flipped)).toBe(true);
    expect(view.sharedCards.slice(3).every((card) => !card.flipped)).toBe(true);
    expect(view.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(view.playerCards[1]?.every((card) => !card.flipped)).toBe(true);
    expect(view.pots[0]?.winnerPayouts?.[0]?.amount).toBe(3);
    expect(view.seats.find((seat) => seat.seat === 0)?.winnerHighlight).toBe(true);
    expect(view.showDealer).toBe(true);
  });

  it('live Solana Complete without decrypt keeps backs (decrypt required for faces)', () => {
    // Mirrors the live bug screenshot: Complete / showdown, zkCrypto present,
    // hole+board deal indices present, but no decrypted map → blue backs.
    const liveComplete: GameSnapshot = {
      ...emptyGame([]),
      backend: 'solana',
      phase: 'Complete',
      dealerSeat: 0,
      smallBlindSeat: -1,
      bigBlindSeat: -1,
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      handNumber: 1,
      actionOrder: [0, 1],
      playerIndexBySeat: { 0: 0, 1: 1 },
      boardCards: [20, 21, 22, 23, 24],
      holeCards: { 0: [0, 1], 1: [2, 3] },
      seats: [
        { seat: 0, name: 'Seat 0', publicKey: 'a', playerIndex: 0, chips: '5020', bet: '0', folded: false, active: false },
        { seat: 1, name: 'Seat 1', publicKey: 'b', playerIndex: 1, chips: '4980', bet: '0', folded: false, active: false },
      ],
      pots: [{ amount: '30', lastBet: '0' }],
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
    };

    const withoutDecrypt = snapshotFromServer(liveComplete, 0, undefined, {
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
    expect(withoutDecrypt.sharedCards).toHaveLength(0);
    expect(withoutDecrypt.playerCards[0]).toBeUndefined();
    expect(withoutDecrypt.playerCards[1]).toBeUndefined();

    const decrypted = decryptedMap({
      0: 10, 1: 11, 2: 12, 3: 13, 20: 51, 21: 50, 22: 49, 23: 48, 24: 47,
    });
    const withDecrypt = snapshotFromServer(liveComplete, 0, decrypted, {
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
    expect(withDecrypt.sharedCards.every((card) => card.flipped)).toBe(true);
    expect(withDecrypt.sharedCards.map((card) => card.unicode)).toEqual(
      [51, 50, 49, 48, 47].map((value) => new Card(value).unicode),
    );
    expect(withDecrypt.playerCards[0]?.every((card) => card.flipped)).toBe(true);
    expect(withDecrypt.playerCards[1]?.every((card) => card.flipped)).toBe(true);
    expect(withDecrypt.playerCards[0]?.map((card) => card.unicode)).toEqual(
      [10, 11].map((value) => new Card(value).unicode),
    );
    expect(withDecrypt.playerCards[1]?.map((card) => card.unicode)).toEqual(
      [12, 13].map((value) => new Card(value).unicode),
    );
  });

  it('treats War / Baccarat Complete faces as plaintext, not Solana deal indices', () => {
    const warComplete: GameSnapshot = {
      ...emptyGame([
        { seat: 0, name: 'Player', publicKey: 'a', chips: '100', bet: '0', folded: false, active: false },
        { seat: 1, name: 'Dealer', publicKey: 'b', chips: '100', bet: '0', folded: false, active: false },
      ]),
      backend: 'solana',
      gameKind: 'war',
      phase: 'Complete',
      dealerSeat: 1,
      actionOrder: [0, 1],
      boardCards: [17, 21],
      holeCards: { 0: [4, 8] },
      handResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '200', winnerSeats: [0] }],
        boardCards: [17, 21],
        seatHands: [{
          seat: 0,
          playerIndex: 0,
          name: 'Player',
          folded: false,
          holeCards: [4, 8],
          handDescription: 'Player wins',
        }],
        actionOrder: [0, 1],
      },
    };
    expect(usesZkCardDecryption(warComplete)).toBe(false);
    const view = snapshotFromServer(warComplete, 0);
    expect(view.playerCards[0]?.map((card) => card.unicode)).toEqual(
      [4, 8].map((value) => new Card(value).unicode),
    );
    expect(view.sharedCards.slice(0, 2).map((card) => card.unicode)).toEqual(
      [17, 21].map((value) => new Card(value).unicode),
    );
  });
});
