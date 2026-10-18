/// <reference types="vitest/globals" />
import { describe, expect, it } from 'vitest';
import {
  appendHandEvents,
  createHandEvent,
  eventsFromSnapshotDiff,
  reduceHandEventLog,
  type HandEventLogEntry,
} from './event-log';
import type { GameSnapshot } from '../backend/client';

function baseSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    handNumber: 1,
    seats: [
      {
        seat: 0,
        name: 'A',
        publicKey: 'a',
        chips: '1000',
        bet: '0',
        folded: false,
        active: false,
      },
      {
        seat: 1,
        name: 'B',
        publicKey: 'b',
        chips: '1000',
        bet: '0',
        folded: false,
        active: false,
      },
    ],
    pots: [],
    playerIndexBySeat: { 0: 0, 1: 1 },
    actionOrder: [0, 1],
    ...overrides,
  };
}

describe('appendHandEvents', () => {
  it('drops consecutive identical lines and once-per-hand ZK/reveal repeats', () => {
    const start = createHandEvent('zk', 'Showdown prove starting (seat 1)', 1, 1_000);
    const again = createHandEvent('zk', 'Showdown prove starting (seat 1)', 1, 1_001);
    const reveal = createHandEvent('reveal', 'Revealed deal cards: 20, 21, 22', 1, 1_002);
    const revealAgain = createHandEvent('reveal', 'Revealed deal cards: 20, 21, 22', 1, 1_003);
    const check = createHandEvent('action', 'Seat 1 checked', 1, 1_004);
    const checkAgain = createHandEvent('action', 'Seat 1 checked', 1, 1_005);
    const log = appendHandEvents([], [start, again, reveal, revealAgain, check, checkAgain]);
    expect(log.map((e) => e.message)).toEqual([
      'Showdown prove starting (seat 1)',
      'Revealed deal cards: 20, 21, 22',
      'Seat 1 checked',
    ]);
  });

  it('still logs the same check on a later street after other lines', () => {
    const flopCheck = createHandEvent('action', 'Seat 1 checked', 1, 2_000);
    const turn = createHandEvent('phase', 'Flop → Turn', 1, 2_001);
    const turnCheck = createHandEvent('action', 'Seat 1 checked', 1, 2_002);
    const log = appendHandEvents([], [flopCheck, turn, turnCheck]);
    expect(log.map((e) => e.message)).toEqual([
      'Seat 1 checked',
      'Flop → Turn',
      'Seat 1 checked',
    ]);
  });
});

describe('eventsFromSnapshotDiff', () => {
  it('logs hand start and phase entry from first non-lobby snapshot', () => {
    const next = baseSnapshot({
      phase: 'Register',
      zk: {
        elGamalPublicKeys: [[null, null], [null, null]],
        registeredCount: 0,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
        shuffleOrder: [],
        shuffleStep: 0,
        shuffleInputHash: null,
        phase: 'Register',
        cardsDealtFaceDown: false,
        currentDeck: null,
      },
    });
    const { clear, events } = eventsFromSnapshotDiff(null, next, 1_000);
    expect(clear).toBe(false);
    expect(events.map((e) => e.message)).toEqual([
      'Hand 1 started',
      'Phase: Register',
    ]);
  });

  it('logs phase transitions and ZK milestones', () => {
    const register = baseSnapshot({
      phase: 'Register',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 1,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [false, false],
        shuffleOrder: [],
        shuffleStep: 0,
        shuffleInputHash: null,
        phase: 'Register',
        cardsDealtFaceDown: false,
        currentDeck: null,
      },
    });
    const shuffle = {
      ...register,
      phase: 'Shuffle' as const,
      zk: {
        ...register.zk!,
        registeredCount: 2,
        shuffledCount: 1,
        currentShufflerIndex: 1,
        currentShufflerSeat: 1,
        phase: 'Shuffle' as const,
      },
    };
    const { events } = eventsFromSnapshotDiff(register, shuffle, 2_000);
    const messages = events.map((e) => e.message);
    expect(messages).toContain('Register → Shuffle');
    expect(messages).toContain('Seat 1 registered (2/2)');
    expect(messages).toContain('Seat 0 shuffled (1/2)');
  });

  it('logs each seat share finalize on Share→PreFlop (parallel share)', () => {
    const shareOne = baseSnapshot({
      phase: 'Share',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 2,
        sharedCount: 1,
        requiredShares: 2,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [true, false],
        shuffleOrder: [0, 1],
        shuffleStep: 2,
        shuffleInputHash: null,
        phase: 'Share',
        cardsDealtFaceDown: true,
        currentDeck: null,
        shareRequested: true,
        shareComplete: false,
        registerRequested: false,
        shuffleRequested: false,
        dealCardCount: 25,
      },
    });
    const preflopBoth = baseSnapshot({
      phase: 'PreFlop',
      holesViewPending: true,
      zk: {
        ...shareOne.zk!,
        sharedCount: 2,
        hasSharedPartial: [true, true],
        shareRequested: false,
        shareComplete: true,
      },
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    const messages = eventsFromSnapshotDiff(shareOne, preflopBoth, 4_000).events.map((e) => e.message);
    expect(messages).toContain('Share → PreFlop');
    expect(messages).toContain('Seat 1 shared partials (2/2)');
    expect(messages).toContain('Share complete (2/2) — share finalized');
    expect(messages.some((m) => m.includes('on-chain finalized'))).toBe(false);
  });

  it('synthesizes completing share events when PreFlop drops zk', () => {
    const shareOne = baseSnapshot({
      phase: 'Share',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 2,
        sharedCount: 1,
        requiredShares: 2,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
        hasSharedPartial: [true, false],
        shuffleOrder: [0, 1],
        shuffleStep: 2,
        shuffleInputHash: null,
        phase: 'Share',
        cardsDealtFaceDown: true,
        currentDeck: null,
        shareRequested: true,
        shareComplete: false,
        registerRequested: false,
        shuffleRequested: false,
        dealCardCount: 25,
      },
    });
    const preflopNoZk = baseSnapshot({
      phase: 'PreFlop',
      holesViewPending: true,
      zkReveal: {
        revealedCardIndices: [],
        newlyRevealed: [],
        allPartialsPublic: false,
        shareComplete: true,
        holePartialsUnlocked: true,
        entries: [],
      },
    });
    const messages = eventsFromSnapshotDiff(shareOne, preflopNoZk, 4_100).events.map((e) => e.message);
    expect(messages).toContain('Seat 1 shared partials (2/2)');
    expect(messages).toContain('Share complete (2/2) — share finalized');
  });

  it('never logs mid-hand backward phase lines like Shuffle → Register', () => {
    const shuffle = baseSnapshot({
      phase: 'Shuffle',
      zk: {
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        registeredCount: 2,
        shuffledCount: 0,
        sharedCount: 0,
        currentShufflerIndex: 0,
        currentShufflerSeat: 0,
        hasSharedPartial: [false, false],
        shuffleOrder: [0, 1],
        shuffleStep: 0,
        shuffleInputHash: null,
        phase: 'Shuffle',
        cardsDealtFaceDown: false,
        currentDeck: null,
      },
    });
    const rolledBack = {
      ...shuffle,
      phase: 'Register' as const,
      zk: {
        ...shuffle.zk!,
        registeredCount: 1,
        phase: 'Register' as const,
        currentShufflerIndex: null,
        currentShufflerSeat: null,
      },
    };
    const messages = eventsFromSnapshotDiff(shuffle, rolledBack, 2_500).events.map((e) => e.message);
    expect(messages.some((m) => m.includes('Shuffle → Register'))).toBe(false);
    expect(messages.some((m) => m.startsWith('Register →') || m.startsWith('Phase:'))).toBe(false);
  });

  it('logs fold / call / raise / check from seat diffs', () => {
    const pre = baseSnapshot({
      phase: 'PreFlop',
      currentBet: '20',
      currentPlayerSeat: 0,
      bettingRoundOpen: true,
      seats: [
        {
          seat: 0,
          name: 'A',
          publicKey: 'a',
          chips: '980',
          bet: '0',
          folded: false,
          active: true,
        },
        {
          seat: 1,
          name: 'B',
          publicKey: 'b',
          chips: '980',
          bet: '20',
          folded: false,
          active: false,
        },
      ],
    });
    const afterCall = {
      ...pre,
      currentPlayerSeat: 1,
      seats: [
        { ...pre.seats[0], bet: '20', chips: '960', active: false },
        { ...pre.seats[1], active: true },
      ],
    };
    expect(eventsFromSnapshotDiff(pre, afterCall, 3_000).events.map((e) => e.message))
      .toContain('Seat 0 called 20');

    const afterRaise = {
      ...afterCall,
      currentBet: '60',
      currentPlayerSeat: 0,
      seats: [
        { ...afterCall.seats[0], active: true },
        { ...afterCall.seats[1], bet: '60', chips: '940', active: false },
      ],
    };
    expect(eventsFromSnapshotDiff(afterCall, afterRaise, 3_001).events.map((e) => e.message))
      .toContain('Seat 1 raised to 60');

    const afterFold = {
      ...afterRaise,
      currentPlayerSeat: 1,
      seats: [
        { ...afterRaise.seats[0], folded: true, active: false },
        { ...afterRaise.seats[1], active: true },
      ],
    };
    expect(eventsFromSnapshotDiff(afterRaise, afterFold, 3_002).events.map((e) => e.message))
      .toContain('Seat 0 folded');

    const checkPrev = baseSnapshot({
      phase: 'Flop',
      currentBet: '0',
      currentPlayerSeat: 1,
      bettingRoundOpen: true,
      seats: [
        {
          seat: 0,
          name: 'A',
          publicKey: 'a',
          chips: '1000',
          bet: '0',
          folded: false,
          active: false,
        },
        {
          seat: 1,
          name: 'B',
          publicKey: 'b',
          chips: '1000',
          bet: '0',
          folded: false,
          active: true,
        },
      ],
    });
    const checkNext = {
      ...checkPrev,
      currentPlayerSeat: 0,
      seats: [
        { ...checkPrev.seats[0], active: true },
        { ...checkPrev.seats[1], active: false },
      ],
    };
    expect(eventsFromSnapshotDiff(checkPrev, checkNext, 3_003).events.map((e) => e.message))
      .toContain('Seat 1 checked');
  });

  it('logs showdown requested even when zk materials are dropped', () => {
    const river = baseSnapshot({ phase: 'River' });
    const showdown = baseSnapshot({
      phase: 'Showdown',
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0, 1],
        submitterSeat: null,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const messages = eventsFromSnapshotDiff(river, showdown, 8_000).events.map((e) => e.message);
    expect(messages).toContain('River → Showdown');
    expect(messages).toContain('Showdown requested — awaiting proof');
  });

  it('clears log on new hand via reduceHandEventLog', () => {
    let log: HandEventLogEntry[] = [];
    let prev: GameSnapshot | null = null;
    const hand1 = baseSnapshot({ phase: 'Register', handNumber: 1 });
    ({ log, prev } = reduceHandEventLog(log, prev, hand1, 4_000));
    expect(log.some((e) => e.message === 'Hand 1 started')).toBe(true);

    const hand1Complete = baseSnapshot({
      phase: 'Complete',
      handNumber: 1,
      handResult: {
        handNumber: 1,
        reason: 'fold',
        potResults: [{ potIndex: 0, amount: '40', winnerSeats: [1] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      },
    });
    ({ log, prev } = reduceHandEventLog(log, prev, hand1Complete, 4_001));
    expect(log.some((e) => e.message.includes('Hand complete'))).toBe(true);
    expect(log.some((e) => e.message.includes('Seat 1 wins 40'))).toBe(true);
    const lenAfterHand1 = log.length;

    // Split pots from winnerMasks (both bits) even if potResults listed one seat.
    const splitLog = eventsFromSnapshotDiff(null, baseSnapshot({
      phase: 'Complete',
      handNumber: 9,
      handResult: {
        handNumber: 9,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '40', winnerSeats: [0] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
        winnerMasks: ['3', '0', '0', '0', '0', '0', '0', '0', '0'],
      },
    }), 5_000).events;
    expect(splitLog.some((e) => e.message.includes('Seat 0 & Seat 1 split 40'))).toBe(true);

    const hand2 = baseSnapshot({ phase: 'Register', handNumber: 2 });
    ({ log, prev } = reduceHandEventLog(log, prev, hand2, 4_002));
    expect(log.some((e) => e.message === 'Hand 1 started')).toBe(false);
    expect(log.some((e) => e.message === 'Hand 2 started')).toBe(true);
    expect(log.length).toBeLessThan(lenAfterHand1);
    expect(prev.handNumber).toBe(2);
  });
});
