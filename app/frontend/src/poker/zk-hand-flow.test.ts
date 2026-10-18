import { describe, expect, it, vi } from 'vitest';
import type { GameSnapshot } from '../backend/client';
import {
  isMyShowdownTurn,
  isMyZkTurn,
  isShowdownAlreadySettledError,
  isShowdownRetryQuietlyError,
  maybeAdvanceZkHand,
  needsRegistration,
  resolveShowdownSubmitterSeat,
  shouldWarmShowdownZkey,
  syncShareSubmittedFromSnapshot,
  type ZkHandClient,
  type ZkHandFlowState,
} from './zk-hand-flow';

describe('shouldWarmShowdownZkey', () => {
  it('does not warm on PreFlop / Flop / Turn after share', () => {
    for (const phase of ['Register', 'Shuffle', 'Share', 'PreFlop', 'Flop', 'Turn', 'Showdown', 'Complete'] as const) {
      expect(shouldWarmShowdownZkey(phase)).toBe(false);
    }
  });

  it('allows River warm only', () => {
    expect(shouldWarmShowdownZkey('River')).toBe(true);
  });
});

function shareSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'local-table',
    backend: 'local',
    phase: 'Share',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '2',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    handNumber: 1,
    actionOrder: [0, 1],
    playerIndexBySeat: { 0: 0, 1: 1 },
    seats: [],
    pots: [],
    zk: {
      phase: 'Share',
      shuffleOrder: [1, 0],
      shuffleStep: 2,
      shuffleInputHash: null,
      currentShufflerIndex: null,
      currentShufflerSeat: null,
      registeredCount: 2,
      shuffledCount: 2,
      sharedCount: 1,
      requiredShares: 2,
      hasSharedPartial: [true, false],
      elGamalPublicKeys: [['1', '2'], ['3', '4']],
      cardsDealtFaceDown: true,
      currentDeck: null,
      shareDeck: null,
    },
    ...overrides,
  };
}

function flowState(shareSubmitted = false): ZkHandFlowState {
  return {
    flow: {} as ZkHandFlowState['flow'],
    player: {} as ZkHandFlowState['player'],
    game: {} as ZkHandFlowState['game'],
    handNumber: 1,
    registeredPublicKey: null,
    currentDeck: null,
    shareSubmitted,
    showdownSubmitted: false,
    inFlight: false,
  };
}

function showdownSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'local-table',
    backend: 'local',
    phase: 'Showdown',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    handNumber: 1,
    actionOrder: [0, 1],
    playerIndexBySeat: { 0: 0, 1: 1 },
    seats: [
      { seat: 0, name: 'A', publicKey: 'a', playerIndex: 0, chips: '100', bet: '0', folded: false, active: false },
      { seat: 1, name: 'B', publicKey: 'b', playerIndex: 1, chips: '100', bet: '0', folded: false, active: false },
    ],
    pots: [],
    zkShowdown: {
      requested: true,
      requiredCount: 1,
      eligibleSeats: [0],
      submitterSeat: 0,
      submittedCount: 0,
      submittedSeats: [],
      outputHash: null,
    },
    ...overrides,
  };
}

function registerSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    gameId: 'local-table',
    backend: 'solana',
    phase: 'Register',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: 0,
    bettingRoundOpen: false,
    handNumber: 1,
    actionOrder: [0, 1],
    playerIndexBySeat: { 0: 0, 1: 1 },
    seats: [],
    pots: [],
    zk: {
      phase: 'Register',
      shuffleOrder: [1, 0],
      shuffleStep: 0,
      shuffleInputHash: null,
      currentShufflerIndex: null,
      currentShufflerSeat: null,
      registeredCount: 0,
      shuffledCount: 0,
      sharedCount: 0,
      requiredShares: 2,
      hasSharedPartial: [false, false],
      elGamalPublicKeys: [null, null],
      cardsDealtFaceDown: false,
      currentDeck: null,
      shareDeck: null,
    },
    ...overrides,
  };
}

describe('needsRegistration', () => {
  it('allows every unregistered seat in parallel', () => {
    const snap = registerSnapshot();
    expect(needsRegistration(snap, 0)).toBe(true);
    expect(needsRegistration(snap, 1)).toBe(true);
  });

  it('skips seats that already have a key', () => {
    const snap = registerSnapshot({
      currentPlayerIndex: 1,
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
        hasSharedPartial: [false, false],
        elGamalPublicKeys: [['1', '2'], null],
        cardsDealtFaceDown: false,
        currentDeck: null,
        shareDeck: null,
      },
    });
    expect(needsRegistration(snap, 0)).toBe(false);
    expect(needsRegistration(snap, 1)).toBe(true);
  });

  it('isMyZkTurn allows Register before zk materials arrive', () => {
    const snap = registerSnapshot({ zk: undefined });
    expect(needsRegistration(snap, 0)).toBe(true);
    expect(isMyZkTurn(snap, 0)).toBe(true);
  });
});

describe('syncShareSubmittedFromSnapshot', () => {
  it('marks shareSubmitted when server already has partial', () => {
    const state = flowState(false);
    syncShareSubmittedFromSnapshot(state, shareSnapshot(), 0);
    expect(state.shareSubmitted).toBe(true);
  });

  it('clears shareSubmitted after leaving Share phase', () => {
    const state = flowState(true);
    syncShareSubmittedFromSnapshot(state, shareSnapshot({ phase: 'PreFlop', zk: undefined }), 0);
    expect(state.shareSubmitted).toBe(false);
  });
});

describe('resolveShowdownSubmitterSeat', () => {
  it('ignores server submitterSeat and uses pending pot results', () => {
    const snapshot = showdownSnapshot({
      pendingHandResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      },
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [],
        submitterSeat: 1,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    expect(resolveShowdownSubmitterSeat(snapshot)).toBe(0);
  });

  it('uses provisional result when server pending pot results are empty', () => {
    const provisionalResult = {
      handNumber: 1,
      reason: 'showdown' as const,
      potResults: [{ potIndex: 0, amount: '6', winnerSeats: [1] }],
      boardCards: [],
      seatHands: [],
      actionOrder: [0, 1],
    };
    const snapshot = showdownSnapshot({
      pendingHandResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      },
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    expect(resolveShowdownSubmitterSeat(snapshot, provisionalResult)).toBe(1);
  });
});

describe('isMyShowdownTurn', () => {
  it('returns true for the preferred winning submitter immediately', () => {
    const snapshot = showdownSnapshot({
      pendingHandResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      },
    });
    const state = flowState();
    state.showdownPreferenceUntil = Date.now() + 60_000;
    expect(isMyShowdownTurn(snapshot, 0, state)).toBe(true);
    expect(isMyShowdownTurn(snapshot, 1, state)).toBe(false);
  });

  it('never lets a known non-winner submit, even after the preference window expires', () => {
    const snapshot = showdownSnapshot({
      pendingHandResult: {
        handNumber: 1,
        reason: 'showdown',
        potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      },
    });
    const state = flowState();
    // Preference window long expired: the winner may still be proving on-device.
    // Only the projected winner (seat 0) may submit — seat 1 must keep waiting.
    state.showdownPreferenceUntil = Date.now() - 60_000;
    expect(isMyShowdownTurn(snapshot, 1, state)).toBe(false);
    expect(isMyShowdownTurn(snapshot, 0, state)).toBe(true);
  });

  it('uses the designated seat when no winner is determinable (avoids dual prove)', () => {
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0, 1],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const state = flowState();
    state.showdownPreferenceUntil = Date.now() + 60_000;
    expect(isMyShowdownTurn(snapshot, 0, state)).toBe(true);
    expect(isMyShowdownTurn(snapshot, 1, state)).toBe(false);
  });

  it('never lets the non-designated seat prove, even after the preference window', () => {
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0, 1],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const state = flowState();
    state.showdownPreferenceUntil = Date.now() - 1;
    expect(isMyShowdownTurn(snapshot, 1, state)).toBe(false);
    expect(isMyShowdownTurn(snapshot, 0, state)).toBe(true);
  });

  it('returns false after a proof is submitted', () => {
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: null,
        submittedCount: 1,
        submittedSeats: [0],
        outputHash: '123',
      },
    });
    expect(isMyShowdownTurn(snapshot, 0, flowState())).toBe(false);
    expect(isMyShowdownTurn(snapshot, 1, flowState())).toBe(false);
  });
});

describe('maybeAdvanceZkHand during Showdown', () => {
  it('submits proof when provisional result makes it the local seat turn', async () => {
    const provisionalResult = {
      handNumber: 1,
      reason: 'showdown' as const,
      potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
      boardCards: [],
      seatHands: [],
      actionOrder: [0, 1],
    };
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [],
        submitterSeat: null,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const ciphertext = ['1', '2', '3', '4'];
    const materials = {
      playerIndex: 0,
      potMasks: ['1'],
      finalDeck: Array.from({ length: 25 }, () => ciphertext),
      ciphertextPartials: Array.from({ length: 25 }, () =>
        Array.from({ length: 10 }, () => ciphertext),
      ),
      elGamalPublicKeys: [['1', '2'], ['3', '4']],
      sealedCoefficients: ['11', '22'],
    };
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => materials),
      submitShowdown,
    } satisfies ZkHandClient;

    const state = flowState();
    state.player = {
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      showdownProve: vi.fn(async () => ({
        proof: {},
        publicSignals: [],
        winnerMasks: [0n],
      })),
    } as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(
      client,
      'local-table',
      snapshot,
      0,
      state,
      provisionalResult,
    );

    expect(result).toBe(nextSnapshot);
    expect(submitShowdown).toHaveBeenCalledOnce();
  });

  it('does not let e2eShowdownSeat override the projected winner', async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?nativeE2e=1&e2eShowdownSeat=1' },
      },
    });
    try {
      const provisionalResult = {
        handNumber: 1,
        reason: 'showdown' as const,
        potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      };
      const snapshot = showdownSnapshot({
        pendingHandResult: provisionalResult,
        zkShowdown: {
          requested: true,
          requiredCount: 1,
          eligibleSeats: [0, 1],
          submitterSeat: 1,
          submittedCount: 0,
          submittedSeats: [],
          outputHash: null,
        },
      });
      const state = flowState();
      state.showdownPreferenceUntil = Date.now() - 1;

      expect(isMyShowdownTurn(snapshot, 0, state, provisionalResult)).toBe(true);
      expect(isMyShowdownTurn(snapshot, 1, state, provisionalResult)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it('allows explicit e2eShowdownSeat winner to submit when eligible', async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { search: '?nativeE2e=1&e2eShowdownSeat=1' },
      },
    });
    try {
      const provisionalResult = {
        handNumber: 1,
        reason: 'showdown' as const,
        potResults: [{ potIndex: 0, amount: '6', winnerSeats: [1] }],
        boardCards: [],
        seatHands: [],
        actionOrder: [0, 1],
      };
      const snapshot = showdownSnapshot({
        pendingHandResult: provisionalResult,
        zkShowdown: {
          requested: true,
          requiredCount: 1,
          eligibleSeats: [0, 1],
          submitterSeat: 0,
          submittedCount: 0,
          submittedSeats: [],
          outputHash: null,
        },
      });
      const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
      const submitShowdown = vi.fn(async () => nextSnapshot);
      const ciphertext = ['1', '2', '3', '4'];
      const materials = {
        playerIndex: 1,
        potMasks: ['1'],
        finalDeck: Array.from({ length: 25 }, () => ciphertext),
        ciphertextPartials: Array.from({ length: 25 }, () =>
          Array.from({ length: 10 }, () => ciphertext),
        ),
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        sealedCoefficients: ['11', '22'],
      };
      const client = {
        getGame: vi.fn(),
        registerHandKey: vi.fn(),
        submitShuffle: vi.fn(),
        submitShare: vi.fn(),
        getShowdownMaterials: vi.fn(async () => materials),
        submitShowdown,
      } satisfies ZkHandClient;

      const state = flowState();
      state.player = {
        setSealedCoefficients: vi.fn(),
        preloadShowdown: vi.fn(),
        showdownProve: vi.fn(async () => ({
          proof: {},
          publicSignals: [],
          winnerMasks: [1n],
        })),
      } as ZkHandFlowState['player'];

      const result = await maybeAdvanceZkHand(
        client,
        'local-table',
        snapshot,
        1,
        state,
        provisionalResult,
      );

      expect(result).toBe(nextSnapshot);
      expect(submitShowdown).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it('does not submit for a non-preferred seat before the preference window expires', async () => {
    const provisionalResult = {
      handNumber: 1,
      reason: 'showdown' as const,
      potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
      boardCards: [],
      seatHands: [],
      actionOrder: [0, 1],
    };
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [],
        submitterSeat: null,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(),
      submitShowdown: vi.fn(),
    } satisfies ZkHandClient;

    const state = flowState();
    state.showdownPreferenceUntil = Date.now() + 60_000;

    const result = await maybeAdvanceZkHand(
      client,
      'local-table',
      snapshot,
      1,
      state,
      provisionalResult,
    );
    expect(result).toBeNull();
    expect(client.submitShowdown).not.toHaveBeenCalled();
  });

  it('does NOT submit for a known non-winner even after the preference window expires', async () => {
    // seat 0 is the projected winner; seat 1 must never submit (winner may still
    // be proving on-device past the fallback window).
    const provisionalResult = {
      handNumber: 1,
      reason: 'showdown' as const,
      potResults: [{ potIndex: 0, amount: '6', winnerSeats: [0] }],
      boardCards: [],
      seatHands: [],
      actionOrder: [0, 1],
    };
    const snapshot = showdownSnapshot({
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
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(),
      submitShowdown: vi.fn(),
    } satisfies ZkHandClient;

    const state = flowState();
    state.showdownPreferenceUntil = Date.now() - 1;

    const result = await maybeAdvanceZkHand(
      client,
      'local-table',
      snapshot,
      1,
      state,
      provisionalResult,
    );
    expect(result).toBeNull();
    expect(client.submitShowdown).not.toHaveBeenCalled();
  });

  it('submits proof for the designated seat when no winner is determinable', async () => {
    const snapshot = showdownSnapshot({
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
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const ciphertext = ['1', '2', '3', '4'];
    const materials = {
      playerIndex: 0,
      potMasks: ['1'],
      finalDeck: Array.from({ length: 25 }, () => ciphertext),
      ciphertextPartials: Array.from({ length: 25 }, () =>
        Array.from({ length: 10 }, () => ciphertext),
      ),
      elGamalPublicKeys: [['1', '2'], ['3', '4']],
      sealedCoefficients: ['11', '22'],
    };
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => materials),
      submitShowdown,
    } satisfies ZkHandClient;

    const state = flowState();
    state.showdownPreferenceUntil = Date.now() + 60_000;
    state.player = {
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      previewShowdownWinnerMasks: vi.fn(() => [0n]),
      showdownProve: vi.fn(async () => ({
        proof: {},
        publicSignals: [],
        winnerMasks: [0n],
      })),
    } as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(
      client,
      'local-table',
      snapshot,
      0,
      state,
    );
    expect(result).toBe(nextSnapshot);
    expect(submitShowdown).toHaveBeenCalledOnce();
  });

  it('proves showdown even when e2eDealValues are present (visual skip lives in zk-hand-flow-auto)', async () => {
    const snapshot = showdownSnapshot({
      e2eDealValues: { 0: 12, 1: 25, 20: 3, 21: 16, 22: 29, 23: 42, 24: 7 },
    });
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const showdownProve = vi.fn(async () => ({
      proof: { pi_a: ['11'] },
      publicSignals: [],
      winnerMasks: [0n],
    }));
    const ciphertext = ['1', '2', '3', '4'];
    const client = {
      getGame: vi.fn(async () => snapshot),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => ({
        playerIndex: 0,
        potMasks: ['1'],
        finalDeck: Array.from({ length: 25 }, () => ciphertext),
        ciphertextPartials: Array.from({ length: 25 }, () =>
          Array.from({ length: 10 }, () => ciphertext),
        ),
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
        sealedCoefficients: ['11', '22'],
      })),
      submitShowdown,
    } satisfies ZkHandClient;

    const state = flowState();
    state.player = {
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      showdownProve,
    } as unknown as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(client, 'local-table', snapshot, 0, state);
    expect(result).toBe(nextSnapshot);
    expect(showdownProve).toHaveBeenCalledOnce();
    expect(submitShowdown.mock.calls[0]?.[2]).toEqual({ pi_a: ['11'] });
  });

  it('submits proof at showdown even when pending pot results are empty', async () => {
    const snapshot = showdownSnapshot({
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const ciphertext = ['1', '2', '3', '4'];
    const materials = {
      playerIndex: 0,
      potMasks: ['1'],
      finalDeck: Array.from({ length: 25 }, () => ciphertext),
      ciphertextPartials: Array.from({ length: 25 }, () =>
        Array.from({ length: 10 }, () => ciphertext),
      ),
      elGamalPublicKeys: [['1', '2'], ['3', '4']],
      sealedCoefficients: ['11', '22'],
    };
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => materials),
      submitShowdown,
    } satisfies ZkHandClient;

    const state = flowState();
    state.showdownPreferenceUntil = Date.now() - 1;
    state.player = {
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      previewShowdownWinnerMasks: vi.fn(() => [1n]),
      showdownProve: vi.fn(async () => ({
        proof: {},
        publicSignals: [],
        winnerMasks: [0n],
      })),
    } as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(client, 'local-table', snapshot, 0, state);
    expect(result).toBe(nextSnapshot);
    expect(submitShowdown).toHaveBeenCalledOnce();
  });

  it('Solana showdown runs real Groth16 prove with Arcis-sealed coefficients', async () => {
    const provisionalResult = {
      handNumber: 1,
      reason: 'showdown' as const,
      potResults: [{ potIndex: 0, amount: '40', winnerSeats: [0] }],
      boardCards: [],
      seatHands: [],
      actionOrder: [0, 1],
    };
    const snapshot = showdownSnapshot({
      backend: 'solana',
      pendingHandResult: provisionalResult,
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0, 1],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const nextSnapshot = {
      ...snapshot,
      phase: 'Showdown' as const,
      zkShowdown: {
        ...snapshot.zkShowdown!,
        submittedCount: 1,
        submittedSeats: [0],
      },
    };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const ciphertext = ['1', '2', '3', '4'];
    const materials = {
      playerIndex: 0,
      potMasks: ['3'],
      finalDeck: Array.from({ length: 25 }, () => ciphertext),
      ciphertextPartials: Array.from({ length: 25 }, () =>
        Array.from({ length: 10 }, () => ciphertext),
      ),
      elGamalPublicKeys: [['1', '2'], ['3', '4']],
      sealedCoefficients: ['11', '22'],
    };
    const client = {
      getGame: vi.fn(async () => snapshot),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => materials),
      submitShowdown,
    } satisfies ZkHandClient;

    const realProof = {
      protocol: 'groth16',
      curve: 'bn128',
      pi_a: ['11', '22', '1'],
      pi_b: [[['1', '0'], ['0', '1']], [['1', '0'], ['0', '1']]],
      pi_c: ['33', '44', '1'],
    };
    const state = flowState();
    state.player = {
      ensureNativeCircuitsForPhase: vi.fn(async () => undefined),
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      showdownProve: vi.fn(async () => ({
        proof: realProof,
        publicSignals: ['99', '88'],
        winnerMasks: [1n],
      })),
      publicKey: [1n, 2n],
      elGamalPrivateKey: 7n,
    } as unknown as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(
      client,
      'solana-table',
      snapshot,
      0,
      state,
      provisionalResult,
    );
    expect(result).toBe(nextSnapshot);
    expect(state.player.setSealedCoefficients).toHaveBeenCalledWith([11n, 22n]);
    expect(state.player.showdownProve).toHaveBeenCalledOnce();
    expect(submitShowdown).toHaveBeenCalledOnce();
    const proof = submitShowdown.mock.calls[0]?.[2] as { pi_a?: string[] };
    expect(proof?.pi_a?.[0]).toBe('11');
    expect(proof?.pi_a?.[0]).not.toBe('0');
    expect(state.showdownSubmitted).toBe(true);
  });

  it('refuses showdown prove when the host has not sealed coefficients', async () => {
    const snapshot = showdownSnapshot({
      backend: 'solana',
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const ciphertext = ['1', '2', '3', '4'];
    const client = {
      getGame: vi.fn(async () => snapshot),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(async () => ({
        playerIndex: 0,
        potMasks: ['1'],
        finalDeck: Array.from({ length: 25 }, () => ciphertext),
        ciphertextPartials: Array.from({ length: 25 }, () =>
          Array.from({ length: 10 }, () => ciphertext),
        ),
        elGamalPublicKeys: [['1', '2'], ['3', '4']],
      })),
      submitShowdown: vi.fn(),
    } satisfies ZkHandClient;
    const state = flowState();
    state.player = {
      ensureNativeCircuitsForPhase: vi.fn(async () => undefined),
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      showdownProve: vi.fn(),
    } as unknown as ZkHandFlowState['player'];

    await expect(maybeAdvanceZkHand(client, 'solana-table', snapshot, 0, state))
      .rejects.toThrow(/must come from the host/);
    expect(state.player.showdownProve).not.toHaveBeenCalled();
  });

  it('waits for on-chain showdown material before proving', async () => {
    const snapshot = showdownSnapshot({
      backend: 'solana',
      zkShowdown: {
        requested: true,
        requiredCount: 1,
        eligibleSeats: [0],
        submitterSeat: 0,
        submittedCount: 0,
        submittedSeats: [],
        outputHash: null,
      },
    });
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const ciphertext = ['1', '2', '3', '4'];
    const pending = {
      playerIndex: 0,
      potMasks: ['1'],
      finalDeck: Array.from({ length: 25 }, () => ciphertext),
      ciphertextPartials: Array.from({ length: 25 }, () =>
        Array.from({ length: 10 }, () => ciphertext),
      ),
      elGamalPublicKeys: [['1', '2'], ['3', '4']] as Array<[string, string]>,
      sealedCoefficients: ['11', '22'],
      materialComplete: false,
    };
    const ready = { ...pending, materialComplete: true };
    const getShowdownMaterials = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(ready);
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const client = {
      getGame: vi.fn(async () => snapshot),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials,
      submitShowdown,
    } satisfies ZkHandClient;
    const showdownProve = vi.fn(async () => ({
      proof: {},
      publicSignals: ['1'],
      winnerMasks: [1n],
    }));
    const state = flowState();
    state.player = {
      ensureNativeCircuitsForPhase: vi.fn(async () => undefined),
      setSealedCoefficients: vi.fn(),
      preloadShowdown: vi.fn(),
      showdownProve,
    } as unknown as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(client, 'solana-table', snapshot, 0, state);
    expect(result).toBe(nextSnapshot);
    expect(getShowdownMaterials).toHaveBeenCalledTimes(2);
    expect(showdownProve).toHaveBeenCalledOnce();
    expect(submitShowdown).toHaveBeenCalledOnce();
  });
});

describe('showdown submit error classification', () => {
  it('treats settlement timeout and already-finalized as accepted', () => {
    expect(isShowdownAlreadySettledError(
      'Timed out waiting for all-seat settlement callback',
    )).toBe(true);
    expect(isShowdownAlreadySettledError('showdown already finalized')).toBe(true);
  });

  it('retries material / simulation races without treating them as settled', () => {
    expect(isShowdownRetryQuietlyError('ShowdownMaterialsNotVerified')).toBe(true);
    expect(isShowdownRetryQuietlyError(
      'Transaction simulation failed: Error processing Instruction 2: invalid program argument.',
    )).toBe(true);
    expect(isShowdownAlreadySettledError('ShowdownMaterialsNotVerified')).toBe(false);
  });
});

describe('isMyZkTurn during Share', () => {
  it('returns false when shareSubmitted or server partial already exists', () => {
    const snapshot = shareSnapshot();
    expect(isMyZkTurn(snapshot, 0, flowState(true))).toBe(false);
    expect(isMyZkTurn(snapshot, 0, flowState(false))).toBe(false);
    expect(isMyZkTurn(snapshot, 1, flowState(false))).toBe(true);
  });
});
