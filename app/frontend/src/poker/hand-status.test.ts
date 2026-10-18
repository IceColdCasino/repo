/// <reference types="vitest/globals" />
import { describe, expect, it } from 'vitest';
import {
  displayHandLifecycleStatus,
  formatBettingPhaseStatus,
  formatHandLifecycleBusyStatus,
  formatHandLifecycleStatus,
  formatHandStatus,
  isHandLifecycleComplete,
} from './hand-status';
import type { GameSnapshot } from '../backend/client';

function baseSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'local-table',
    backend: 'local',
    phase: 'PreFlop',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '2',
    currentPlayerSeat: 0,
    currentPlayerIndex: 0,
    bettingRoundOpen: true,
    handNumber: 1,
    seats: [],
    pots: [],
    ...overrides,
  };
}

describe('formatHandLifecycleStatus', () => {
  it('shows registration progress during registration', () => {
    const snapshot = baseSnapshot({
      phase: 'Register',
      zk: {
        elGamalPublicKeys: [[null, null], [null, null]],
        registeredCount: 1,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 1: Registering: 1/2 players registered');
  });

  it('shows phase 1 complete when all players registered', () => {
    const snapshot = baseSnapshot({
      phase: 'Register',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 1: Registering complete');
  });

  it('shows phase 3 complete plus the live street during betting', () => {
    const snapshot = baseSnapshot({ phase: 'Flop' });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 3: Dealing complete · Flop');
    expect(formatHandLifecycleStatus(baseSnapshot({ phase: 'River' })))
      .toBe('Phase 3: Dealing complete · River');
  });

  it('shows phase 2 shuffler seat while shuffle is in progress', () => {
    const snapshot = baseSnapshot({
      phase: 'Shuffle',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: 1,
        currentShufflerSeat: 1,
        hasSharedPartial: [false, false],
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 2: Shuffling: seat 1 shuffling (0/2 done)');
  });

  it('shows phase 3 parallel share status', () => {
    const snapshot = baseSnapshot({
      phase: 'Share',
      playerIndexBySeat: { '0': 1, '1': 0 },
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 2,
        sharedCount: 0,
        requiredShares: 2,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe(
      'Phase 3: Dealing: seats 0 + 1 proving in parallel (0/2 submitted)',
    );
  });

  it('shows phase 4 in progress during showdown', () => {
    const snapshot = baseSnapshot({
      phase: 'Showdown',
      zkShowdown: {
        requested: true,
        submittedCount: 0,
        requiredCount: 1,
        submittedSeats: [],
        eligibleSeats: [],
        submitterSeat: null,
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 4: Showdown: awaiting proof (0/1)');
  });

  it('shows phase 4 complete after showdown proof', () => {
    const snapshot = baseSnapshot({
      phase: 'Showdown',
      zkShowdown: {
        requested: true,
        submittedCount: 1,
        requiredCount: 1,
        submittedSeats: [0],
        eligibleSeats: [0],
        submitterSeat: 0,
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 4: Showdown complete');
  });

  it('shows phase 4 complete when hand phase is Complete', () => {
    const snapshot = baseSnapshot({
      phase: 'Complete',
      handResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ amount: '100', winnerSeats: [0] }],
        boardCards: [20, 21, 22, 23, 24],
        seatHands: [],
        actionOrder: [0, 1],
        zkFinalDeck: [],
        handNumPlayers: 2,
      },
    });
    expect(formatHandLifecycleStatus(snapshot)).toBe('Phase 4: Showdown complete');
    expect(isHandLifecycleComplete(snapshot)).toBe(true);
  });
});

describe('displayHandLifecycleStatus', () => {
  it('prefers complete lifecycle text over busy proof text after phase 4 finishes', () => {
    const snapshot = baseSnapshot({
      phase: 'Showdown',
      zkShowdown: {
        requested: true,
        submittedCount: 1,
        requiredCount: 1,
        submittedSeats: [0],
        eligibleSeats: [0],
        submitterSeat: 0,
      },
    });
    expect(displayHandLifecycleStatus(snapshot, true)).toBe('Phase 4: Showdown complete');
  });

  it('shows busy proof text while phase 4 is still in progress', () => {
    const snapshot = baseSnapshot({
      phase: 'Showdown',
      zkShowdown: {
        requested: true,
        submittedCount: 0,
        requiredCount: 1,
        submittedSeats: [],
        eligibleSeats: [],
        submitterSeat: null,
      },
    });
    expect(displayHandLifecycleStatus(snapshot, true)).toBe('Phase 4: Showdown: generating proof…');
  });
});

describe('formatHandLifecycleBusyStatus', () => {
  it('shows generating proof for the active phase while busy', () => {
    const snapshot = baseSnapshot({ phase: 'Share' });
    expect(formatHandLifecycleBusyStatus(snapshot)).toBe('Phase 3: Dealing: generating proof…');
  });

  it('shows registration progress while registering', () => {
    const snapshot = baseSnapshot({
      phase: 'Register',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 1,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
      },
    });
    expect(formatHandLifecycleBusyStatus(snapshot)).toBe(
      'Phase 1: Registering: generating proof (1/2 registered)…',
    );
  });
});

describe('formatHandStatus after share', () => {
  it('shows viewing hole cards while betting is still closed', () => {
    const snapshot = baseSnapshot({
      bettingRoundOpen: false,
      holesViewPending: true,
      seats: [
        { seat: 0, name: 'A', publicKey: 'a', playerIndex: 0, chips: '100', bet: '1', folded: false, active: false },
      ],
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    expect(formatHandStatus(snapshot, 0, 2)).toBe(
      'PreFlop · betting closed · share complete · viewing hole cards… · 2 partials cached',
    );
  });

  it('shows PreFlop betting status once betting opens', () => {
    const snapshot = baseSnapshot({
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    expect(formatHandStatus(snapshot, 0, 2)).toBe(
      'PreFlop · betting open · your turn · share complete · 2 partials cached',
    );
  });

  it('shows waiting seat when not your turn', () => {
    const snapshot = baseSnapshot({
      currentPlayerSeat: 1,
      bettingRoundOpen: true,
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    expect(formatHandStatus(snapshot, 0, 2)).toContain('seat 1 to act');
  });

  it('shows betting closed when round finished', () => {
    const snapshot = baseSnapshot({
      bettingRoundOpen: false,
      zkReveal: {
        revealedCardIndices: [20, 21, 22],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        entries: [],
      },
    });
    expect(formatBettingPhaseStatus(snapshot, 0, 5)).toBe(
      'PreFlop · betting closed · share complete · board revealed: 20, 21, 22 · 5 partials cached',
    );
  });
});
