import { describe, expect, it, vi } from 'vitest';
import type { GameSnapshot } from '../backend/client';
import {
  E2E_VISUAL_SHOWDOWN_PROOF,
  maybeAdvanceZkHand,
  type ZkHandClient,
  type ZkHandFlowState,
} from './zk-hand-flow-auto';

function flowState(): ZkHandFlowState {
  return {
    flow: {} as ZkHandFlowState['flow'],
    player: {} as ZkHandFlowState['player'],
    game: {} as ZkHandFlowState['game'],
    handNumber: 1,
    registeredPublicKey: null,
    currentDeck: null,
    shareSubmitted: false,
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

describe('zk-hand-flow-auto visual showdown', () => {
  it('submits a dummy proof without Groth16 when e2eDealValues are set', async () => {
    const snapshot = showdownSnapshot({
      e2eDealValues: { 0: 12, 1: 25, 20: 3, 21: 16, 22: 29, 23: 42, 24: 7 },
    });
    const nextSnapshot = { ...snapshot, phase: 'Complete' as const };
    const submitShowdown = vi.fn(async () => nextSnapshot);
    const showdownProve = vi.fn();
    const client = {
      getGame: vi.fn(),
      registerHandKey: vi.fn(),
      submitShuffle: vi.fn(),
      submitShare: vi.fn(),
      getShowdownMaterials: vi.fn(),
      submitShowdown,
    } satisfies ZkHandClient;

    const state = flowState();
    state.player = {
      preloadShowdown: vi.fn(),
      showdownProve,
    } as unknown as ZkHandFlowState['player'];

    const result = await maybeAdvanceZkHand(client, 'local-table', snapshot, 0, state);
    expect(result).toBe(nextSnapshot);
    expect(showdownProve).not.toHaveBeenCalled();
    expect(submitShowdown).toHaveBeenCalledOnce();
    expect(submitShowdown.mock.calls[0]?.[2]).toEqual(E2E_VISUAL_SHOWDOWN_PROOF);
    expect(state.showdownSubmitted).toBe(true);
  });
});
